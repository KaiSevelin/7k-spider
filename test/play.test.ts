/**
 * Replay: the pacing, and which edge an event travels along.
 *
 * Both are pure, which is the point of them being separate from the drawing. The animation itself is
 * checked by watching it; that a thirty-day gap does not stall it for a simulated month is checked here.
 */

import { describe, expect, it, vi } from "vitest";
import { buildWorkspace, writeTrace, type TraceEvent } from "@sevenk/core";
import { buildGraph, edgeForEvent, isBadEvent, type Graph } from "../src/graph.js";
import { resolveLens } from "../src/lens.js";
import { createPlayer, DEFAULT_BEAT_MS, plan, positions, runsOf } from "../src/play.js";
import { readTrace } from "../src/selection.js";

const MODEL = `
package acme.shop

message Place v1.0 @command { id: uuid @role(businessKey) }
message Placed v1.0 @event  { id: uuid @role(businessKey) }

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }

service Web @external {
  emits Place to inbound
}

service Orders {
  reacts Place from inbound {
    replies Placed
  }
  emits Placed to events
}

service Ledger {
  reacts Placed from events {
    replies none
  }
}
`;

const graph = (): Graph => {
  const ws = buildWorkspace([{ path: "shop.7k", source: MODEL }]);
  expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return buildGraph(ws.model);
};

const RUN = "Replay#1";
const ev = (seq: number, at: number, over: Partial<TraceEvent>): TraceEvent =>
  ({ run: RUN, seq, at, kind: "published", ...over }) as TraceEvent;

const TRACE: TraceEvent[] = [
  ev(0, 0, { kind: "published", message: "acme.shop.Place", pipe: "acme.shop.inbound", service: "acme.shop.Web" }),
  ev(1, 0, {
    kind: "delivered", message: "acme.shop.Place", pipe: "acme.shop.inbound",
    service: "acme.shop.Orders", subscription: "Orders",
  }),
  ev(2, 50, {
    kind: "failed", message: "acme.shop.Place", pipe: "acme.shop.inbound",
    service: "acme.shop.Orders", subscription: "Orders", reason: "failed",
  }),
  // A thirty-day advance. Event-paced playback must not wait for it.
  ev(3, 50 + 30 * 24 * 3600 * 1000, {
    kind: "published", message: "acme.shop.Placed", pipe: "acme.shop.events", service: "acme.shop.Orders",
  }),
  ev(4, 50 + 30 * 24 * 3600 * 1000, {
    kind: "dead-lettered", message: "acme.shop.Place", pipe: "acme.shop.inbound.dead",
    service: "acme.shop.Orders", subscription: "Orders", reason: "exhausted",
  }),
  ev(5, 50 + 30 * 24 * 3600 * 1000, { kind: "saga-started", saga: "acme.shop.Flow", sagaKey: "k" }),
];

describe("pacing", () => {
  it("gives every event one beat, whatever the clock did", () => {
    // The whole reason playback is event-paced: a linear virtual-to-wall mapping would stall for a month.
    const beats = plan(TRACE);
    expect(beats).toHaveLength(TRACE.length);
    const total = beats.reduce((a, b) => a + b.delayMs, 0);
    // Six events, one of them after a thirty-day gap: seven beats, not thirty days.
    expect(total).toBe(DEFAULT_BEAT_MS * 7);
  });

  it("charges a gap exactly one extra beat, however large it was", () => {
    const beats = plan(TRACE);
    expect(beats[3]!.gap).toBe(true);
    expect(beats[3]!.delayMs).toBe(DEFAULT_BEAT_MS * 2);

    // Ten times the gap costs the same, because the point is to mark it rather than to measure it.
    const longer = plan([TRACE[0]!, { ...TRACE[3]!, at: TRACE[3]!.at * 10 }]);
    expect(longer[1]!.delayMs).toBe(DEFAULT_BEAT_MS * 2);
  });

  it("does not call a burst at one instant a gap", () => {
    // A publish, a delivery and a handler returning are one piece of work, and spacing them out would
    // invent a pause the runtime did not have.
    const beats = plan(TRACE);
    expect(beats[1]!.gap).toBe(false);
    expect(beats[2]!.gap).toBe(false);
  });

  it("respects a beat of its own", () => {
    expect(plan(TRACE, { beatMs: 10 })[0]!.delayMs).toBe(10);
    // Never zero, or playback would be a single frame.
    expect(plan(TRACE, { beatMs: 0 })[0]!.delayMs).toBe(1);
  });
});

describe("the transport", () => {
  const driven = (): { player: ReturnType<typeof createPlayer>; seen: number[] } => {
    const seen: number[] = [];
    // A timer that fires at once, so the whole trace runs without waiting for it.
    const player = createPlayer(TRACE, {
      onEvent: (e) => seen.push(e.seq),
      timer: (run) => {
        run();
        return 0;
      },
      clearTimer: () => {},
    });
    return { player, seen };
  };

  it("plays every event once, in order, and stops at the end", () => {
    const { player, seen } = driven();
    player.play();
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    expect(player.playing).toBe(false);
    expect(player.at).toBe(TRACE.length - 1);
  });

  it("does not loop, because a trace recorded something that happened once", () => {
    const { player, seen } = driven();
    player.play();
    const after = seen.length;
    // Playing from the end starts again rather than doing nothing — a button that does nothing is worse.
    player.play();
    expect(seen.length).toBe(after * 2);
  });

  it("steps and seeks without playing", () => {
    const { player, seen } = driven();
    player.step();
    expect(seen).toEqual([0]);
    player.seek(3);
    expect(seen).toEqual([0, 3]);
    expect(player.playing).toBe(false);
  });

  it("clamps a seek, and rewinds to before the start", () => {
    const { player } = driven();
    player.seek(99);
    expect(player.at).toBe(TRACE.length - 1);
    player.seek(-5);
    expect(player.at).toBe(-1);
  });

  it("reports changes, so a transport can redraw itself", () => {
    const onChange = vi.fn();
    const player = createPlayer(TRACE, { onEvent: () => {}, onChange, timer: () => 0, clearTimer: () => {} });
    player.play();
    player.pause();
    expect(onChange).toHaveBeenCalled();
  });

  it("does nothing at all for an empty trace", () => {
    const player = createPlayer([], { onEvent: () => expect.fail("nothing to show") });
    player.play();
    expect(player.playing).toBe(false);
    expect(player.length).toBe(0);
  });
});

describe("the timeline is drawn in virtual time", () => {
  it("puts a thirty-day gap at its true size", () => {
    // The transport compresses gaps; the timeline must not, or a month and a millisecond look the same and
    // the one thing a timeline is for is lost.
    const at = positions(TRACE);
    expect(at[0]).toBe(0);
    expect(at[at.length - 1]).toBe(1);
    // Everything before the advance sits at the very start.
    expect(at[2]!).toBeLessThan(0.0001);
  });

  it("spreads events that share one instant instead of stacking them invisibly", () => {
    const same = TRACE.slice(0, 2).map((e) => ({ ...e, at: 7 }));
    expect(positions(same)).toEqual([0, 1]);
    expect(positions([])).toEqual([]);
    expect(positions([TRACE[0]!])).toEqual([0]);
  });
});

describe("which edge an event travelled along", () => {
  it("sends a publish from the service to the pipe", () => {
    const edge = edgeForEvent(graph(), TRACE[0]!)!;
    expect(edge.from).toBe("service:acme.shop.Web");
    expect(edge.to).toBe("pipe:acme.shop.inbound");
  });

  it("sends a delivery from the pipe to the service", () => {
    const edge = edgeForEvent(graph(), TRACE[1]!)!;
    expect(edge.from).toBe("pipe:acme.shop.inbound");
    expect(edge.to).toBe("service:acme.shop.Orders");
  });

  it("sends a dead letter along the delivery it died on", () => {
    // The `.dead` companion is drawn as an annotation of its pipe, without edges, so the event belongs to
    // the edge it was travelling when it failed — which is also the thing a reader wants to see.
    const edge = edgeForEvent(graph(), TRACE[4]!)!;
    expect(edge.from).toBe("pipe:acme.shop.inbound");
    expect(edge.to).toBe("service:acme.shop.Orders");
    expect(isBadEvent(TRACE[4]!.kind)).toBe(true);
  });

  it("has no edge for a saga event, and says so", () => {
    // Rather than forcing it onto some nearby edge, which would be a message that never travelled.
    expect(edgeForEvent(graph(), TRACE[5]!)).toBeUndefined();
  });

  it("has no edge for a publish by the scenario itself", () => {
    // `published` with no service: nothing in the model sent it.
    expect(
      edgeForEvent(graph(), { kind: "published", pipe: "acme.shop.inbound" }),
    ).toBeUndefined();
  });

  it("marks a failure differently from a success", () => {
    expect(isBadEvent("handled")).toBe(false);
    expect(isBadEvent("published")).toBe(false);
    expect(isBadEvent("rejected")).toBe(true);
    expect(isBadEvent("saga-compensating")).toBe(true);
  });

  it("animates to a port when the counterparty is out of view", () => {
    // The message really did go out of view, and saying so beats a message that silently does not appear.
    const lensed = resolveLens(graph(), { include: ["pipe:acme.shop.inbound"], exclude: ["service:Orders"] });
    const edge = edgeForEvent(lensed, TRACE[1]!)!;
    expect(edge.from).toBe("pipe:acme.shop.inbound");
    expect(edge.to.startsWith("port:")).toBe(true);
  });
});

describe("a file may hold several runs", () => {
  it("splits them, because they cannot be played as one", () => {
    // Each run starts its clock where it likes, so a timeline across all of them would overlay run two on
    // run one. Measured on a real sandbox trace: seven runs, and 27 of 59 events inside the first 1% of
    // the track.
    const second = TRACE.slice(0, 3).map((e) => ({ ...e, run: "Replay#2" }));
    const split = runsOf([...TRACE, ...second]);
    expect(split.map((r) => r.run)).toEqual(["Replay#1", "Replay#2"]);
    expect(split[0]!.events).toHaveLength(TRACE.length);
    expect(split[1]!.events).toHaveLength(3);
  });

  it("keeps a single run as one", () => {
    expect(runsOf(TRACE)).toHaveLength(1);
    expect(runsOf([])).toEqual([]);
  });

  it("gives each run its own full track, rather than a slice of a shared one", () => {
    const second = TRACE.slice(0, 3).map((e) => ({ ...e, run: "Replay#2", at: e.at + 500 }));
    for (const run of runsOf([...TRACE, ...second])) {
      const at = positions(run.events);
      expect(at[0]).toBe(0);
      expect(at[at.length - 1]).toBe(1);
    }
  });
});

describe("a trace round-trips into the player", () => {
  it("reads what a runtime writes and plays it", () => {
    const { events, problems } = readTrace(writeTrace(TRACE));
    expect(problems).toEqual([]);
    const seen: number[] = [];
    const player = createPlayer(events, {
      onEvent: (e) => seen.push(e.seq),
      timer: (run) => {
        run();
        return 0;
      },
      clearTimer: () => {},
    });
    player.play();
    expect(seen).toEqual(TRACE.map((e) => e.seq));
  });
});
