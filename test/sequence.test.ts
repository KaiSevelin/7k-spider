/**
 * The sequence layout.
 *
 * The claim worth testing is the one that made the design verbose: that pipes are lifelines rather than
 * the middles of arrows, which keeps the diagram from inventing causality and from hiding the waiting.
 */

import { describe, expect, it } from "vitest";
import type { TraceEvent } from "@sevenk/core";
import { layoutSequence, sayGap } from "../src/sequence.js";

const RUN = "Seq#1";
const ev = (seq: number, at: number, over: Partial<TraceEvent>): TraceEvent =>
  ({ run: RUN, seq, at, kind: "published", ...over }) as TraceEvent;

const PIPE = "acme.shop.commands";
const ORDERS = "acme.shop.Orders";
const TICKETS = "acme.shop.Tickets";

/** One publish, two competing deliveries, and a long wait before the second. */
const TRACE: TraceEvent[] = [
  ev(0, 0, { kind: "published", message: "acme.shop.Reserve", pipe: PIPE, service: ORDERS }),
  ev(1, 10, {
    kind: "delivered", message: "acme.shop.Reserve", pipe: PIPE, service: TICKETS,
    subscription: "Tickets", attempt: 1,
  }),
  ev(2, 20, {
    kind: "failed", message: "acme.shop.Reserve", pipe: PIPE, service: TICKETS,
    subscription: "Tickets", attempt: 1, reason: "failed",
  }),
  // A thirty-second wait in the queue, which is the thing a sequence diagram is here to show.
  ev(3, 30_020, {
    kind: "delivered", message: "acme.shop.Reserve", pipe: PIPE, service: TICKETS,
    subscription: "Tickets", attempt: 2,
  }),
  ev(4, 30_030, {
    kind: "handled", message: "acme.shop.Reserve", pipe: PIPE, service: TICKETS,
    subscription: "Tickets",
  }),
  ev(5, 30_040, { kind: "saga-started", saga: "acme.shop.Checkout", sagaKey: "ORD-1" }),
  ev(6, 30_050, { kind: "advanced", detail: "30s" }),
];

const laid = (): ReturnType<typeof layoutSequence> => layoutSequence(TRACE);

describe("pipes are lifelines", () => {
  it("gives the pipe a lane of its own", () => {
    const lanes = laid().lanes;
    expect(lanes.map((l) => l.id)).toContain(`pipe:${PIPE}`);
    expect(lanes.find((l) => l.id === `pipe:${PIPE}`)?.kind).toBe("pipe");
  });

  it("draws two arrows per hop rather than one service to another", () => {
    // Joining a publish to a delivery would assert a causality the trace does not state, and a competing
    // consumer on a queue makes it false.
    const rows = laid().rows;
    const lanes = laid().lanes;
    const kindOf = (i: number | undefined): string | undefined =>
      i === undefined ? undefined : lanes[i]!.kind;

    for (const row of rows) {
      if (row.from === undefined || row.to === undefined) continue;
      // Exactly one end of every arrow is the pipe.
      expect([kindOf(row.from), kindOf(row.to)].filter((k) => k === "pipe")).toHaveLength(1);
    }
  });

  it("points a publish at the pipe and a delivery away from it", () => {
    const { lanes, rows } = laid();
    const pipe = lanes.findIndex((l) => l.kind === "pipe");
    expect(rows[0]!.to).toBe(pipe);
    expect(rows[1]!.from).toBe(pipe);
  });

  it("makes the wait a visible distance on the pipe's lifeline", () => {
    // The publish arrives at the pipe and the second delivery leaves it thirty seconds later. With the
    // queue drawn as the middle of an arrow, that interval has nowhere to be.
    const rows = laid();
    const arrive = rows.rows[0]!;
    const leave = rows.rows[3]!;
    expect(leave.y).toBeGreaterThan(arrive.y);
    expect(leave.gapBefore).toBe(true);
    expect(leave.gapMs).toBe(30_000);
  });
});

describe("lanes", () => {
  it("appear in the order the trace first mentions them", () => {
    // Which is what gives a sequence diagram its diagonal and keeps crossings down.
    expect(laid().lanes.map((l) => l.label)).toEqual([
      "Orders",
      "commands",
      "Tickets",
      "Checkout",
    ]);
  });

  it("uses the selection id, so clicking a lane selects what the graph would", () => {
    expect(laid().lanes.map((l) => l.id)).toEqual([
      "service:acme.shop.Orders",
      "pipe:acme.shop.commands",
      "service:acme.shop.Tickets",
      "saga:acme.shop.Checkout",
    ]);
  });

  it("folds a dead letter into the pipe it belongs to", () => {
    // A lifeline of its own would be a participant that only ever receives, and the graph draws it as an
    // annotation of its pipe for the same reason.
    const { lanes } = layoutSequence([
      ev(0, 0, { kind: "published", message: "acme.shop.Reserve", pipe: PIPE, service: ORDERS }),
      ev(1, 5, {
        kind: "dead-lettered", message: "acme.shop.Reserve", pipe: `${PIPE}.dead`,
        service: TICKETS, subscription: "Tickets", reason: "exhausted",
      }),
    ]);
    expect(lanes.filter((l) => l.kind === "pipe")).toHaveLength(1);
    expect(lanes.find((l) => l.kind === "pipe")!.qname).toBe(PIPE);
  });

  it("gives a saga its own lane", () => {
    const saga = laid().lanes.find((l) => l.kind === "saga")!;
    expect(saga.id).toBe("saga:acme.shop.Checkout");
  });
});

describe("rows", () => {
  it("carries the event identity a highlight uses", () => {
    // `(run, seq)`, not `seq`: a file holds several runs.
    expect(laid().rows[0]!.key).toBe(`${RUN}\u00000`);
  });

  it("is one row per event, in trace order", () => {
    expect(laid().rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("marks a gap instead of leaving a proportional hole", () => {
    // The same decision as the transport: most of a trace happens at a handful of instants, and a
    // proportional timeline would push everything else off the screen.
    const gaps = laid().rows.filter((r) => r.gapBefore);
    expect(gaps.map((r) => r.seq)).toEqual([3]);
  });

  it("leaves room for the divider, so a gap takes vertical space", () => {
    const rows = laid().rows;
    const normal = rows[2]!.y - rows[1]!.y;
    const across = rows[3]!.y - rows[2]!.y;
    expect(across).toBeGreaterThan(normal);
  });

  it("puts an event with no pipe on its own participant's lifeline", () => {
    // A saga step happened *to* a participant without travelling anywhere.
    const sagaRow = laid().rows.find((r) => r.kind === "saga-started")!;
    expect(sagaRow.from).toBeUndefined();
    expect(sagaRow.to).toBeUndefined();
    expect(laid().lanes[sagaRow.on!]!.kind).toBe("saga");
  });

  it("gives the clock moving no participant at all", () => {
    const advanced = laid().rows.find((r) => r.kind === "advanced")!;
    expect(advanced.from).toBeUndefined();
    expect(advanced.to).toBeUndefined();
    expect(advanced.on).toBeUndefined();
  });

  it("marks a failure", () => {
    expect(laid().rows.find((r) => r.kind === "failed")!.bad).toBe(true);
    expect(laid().rows.find((r) => r.kind === "handled")!.bad).toBe(false);
  });

  it("notes a reason and an attempt, and not on an ordinary delivery", () => {
    expect(laid().rows.find((r) => r.kind === "failed")!.note).toContain("failed");
    expect(laid().rows[3]!.note).toContain("attempt 2");
    // A first attempt is not worth saying.
    expect(laid().rows[1]!.note).toBeUndefined();
  });

  it("labels a row with the message, falling back to the kind", () => {
    expect(laid().rows[0]!.label).toBe("Reserve");
    expect(laid().rows.find((r) => r.kind === "advanced")!.label).toBe("advanced");
  });

  it("handles a publish by the scenario itself, which has no sender", () => {
    const { rows } = layoutSequence([ev(0, 0, { kind: "published", message: "acme.shop.Reserve", pipe: PIPE })]);
    expect(rows[0]!.from).toBeUndefined();
    expect(rows[0]!.to).toBe(0);
  });
});

describe("the canvas", () => {
  it("is wide enough for its lanes and tall enough for its rows", () => {
    const { width, height, lanes, rows } = laid();
    expect(width).toBeGreaterThan(lanes[lanes.length - 1]!.x);
    expect(height).toBeGreaterThan(rows[rows.length - 1]!.y);
  });

  it("is laid out identically twice", () => {
    expect(JSON.stringify(layoutSequence(TRACE))).toBe(JSON.stringify(layoutSequence(TRACE)));
  });

  it("copes with an empty trace", () => {
    const empty = layoutSequence([]);
    expect(empty.lanes).toEqual([]);
    expect(empty.rows).toEqual([]);
    expect(empty.width).toBeGreaterThan(0);
  });
});

describe("saying how long a wait was", () => {
  it("scales to what a reader can hold", () => {
    // A queue's whole character is how long things sit in it, and "2592000000ms" says nothing.
    expect(sayGap(400)).toBe("400ms");
    expect(sayGap(1500)).toBe("1.5s");
    expect(sayGap(45_000)).toBe("45s");
    expect(sayGap(600_000)).toBe("10m");
    expect(sayGap(7_200_000)).toBe("2.0h");
    expect(sayGap(30 * 86_400_000)).toBe("30.0d");
  });
});
