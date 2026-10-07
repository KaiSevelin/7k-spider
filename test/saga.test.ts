/**
 * The saga view's layout.
 *
 * Geometry is asserted only where it carries meaning — that a stage's cards share a band, that the
 * band after a parallel stage starts below both of them — because pinning every pixel makes a layout
 * untunable. Everything else asserted here is about what the view *says*: the rows it draws, and the
 * two silences it refuses to leave out.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type LinkedModel, type SagaIr, type TraceEvent } from "@sevenk/core";
import {
  hostOf,
  layoutSaga,
  progressOf,
  sagaById,
  sagasOf,
  sayDuration,
  sendableFrom,
  type SagaDiagram,
  type StepCard,
} from "../src/saga.js";
import { sayGap } from "../src/sequence.js";

const MODEL = `
package acme.shop

envelope Meta {
  correlationId: uuid @role(correlation)
  causationId:   uuid @derive(inbound.id) @role(causation)
}

envelopes Meta

value Ref : string { length 1..16 }

message Place   v1.0 @command { id: Ref @role(businessKey) total: int { range 1..1000 } }
message Taken   v1.0 @event   { id: Ref @role(businessKey) }

message Hold    v1.0 @command { id: Ref @role(businessKey) }
message Held    v1.0 @event   { id: Ref @role(businessKey) holdRef: uuid }
message Short   v1.0 @event   { id: Ref @role(businessKey) }
message Release v1.0 @command { id: Ref @role(businessKey) }

message Auth    v1.0 @command { id: Ref @role(businessKey) amount: int { range 1..1000 } }
message Authed  v1.0 @event   { id: Ref @role(businessKey) authRef: uuid }
message Void    v1.0 @command { id: Ref @role(businessKey) }

message Ship    v1.0 @command { id: Ref @role(businessKey) }
message Shipped v1.0 @event   { id: Ref @role(businessKey) }

message Won  v1.0 @event { id: Ref @role(businessKey) }
message Lost v1.0 @event { id: Ref @role(businessKey) why: string { length 1..60 } }

pipe q : queue
pipe e : topic

service Caller @external {
  emits Place to q
}

service Host {
  emits Hold to q
  emits Release to q
  emits Auth to q
  emits Void to q
  emits Ship to q
  emits Taken to e
  emits Won to e
  emits Lost to e

  reacts Place   from q { replies Taken }
  reacts Held    from e { replies none }
  reacts Short   from e { replies none }
  reacts Authed  from e { replies none }
  reacts Shipped from e { replies none }
}

service Warehouse {
  emits Held to e
  emits Short to e

  reacts Hold    from q { replies Held | Short }
  reacts Release from q { replies none }
}

service Cards {
  emits Authed to e

  reacts Auth from q { replies Authed }
  reacts Void from q { replies none }
}

service Shipping {
  emits Shipped to e

  reacts Ship from q { replies Shipped }
}

service Observer {
  reacts Taken from e { replies none }
  reacts Won   from e { replies none }
  reacts Lost  from e { replies none }
}

saga Checkout v1.0 {
  start on Place keyed by id {
    total = message.total
  }

  state {
    total:   int { range 1..1000 }
    holdRef: uuid
    authRef: uuid
  }

  parallel {
    step hold {
      send Hold
      on Held { holdRef = message.holdRef }
      on Short reject "out of stock"
      on timeout 5s reject "the warehouse did not answer"
      undo with Release
    }

    step authorise {
      send Auth { amount = state.total }
      on Authed { authRef = message.authRef }
      on timeout 30s abandon
      undo none
    }
  }

  step ship {
    send Ship
    on Shipped
    on timeout 2m reject "no courier"
  }

  on deadline 24h abandon

  on complete send Won
  on reject   send Lost { why = terminal.reason }
}
`;

const model = (source = MODEL): LinkedModel => {
  const ws = buildWorkspace([{ path: "shop.7k", source }]);
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  return ws.model;
};

const only = (m: LinkedModel): SagaIr => {
  const saga = sagasOf(m)[0];
  if (saga === undefined) throw new Error("no saga");
  return saga;
};

const diagram = (source = MODEL): SagaDiagram => {
  const m = model(source);
  return layoutSaga(m, only(m));
};

/** The step card of a given name, wherever it sits. */
const card = (d: SagaDiagram, name: string) =>
  d.stages.flatMap((s) => s.steps).find((c) => c.name === name);

/**
 * `card`, where a missing one is the test's own mistake rather than a case to skip.
 *
 * Thrown, because reading zero rows off a card that is not there would pass.
 */
const cardOf = (d: SagaDiagram, name: string): StepCard => {
  const found = card(d, name);
  if (found === undefined) throw new Error(`no step card named \`${name}\``);
  return found;
};

const labels = (d: SagaDiagram, name: string): string[] =>
  (card(d, name)?.outcomes ?? []).map((o) => o.label);

describe("the saga itself", () => {
  it("carries the id every other view selects it by", () => {
    const d = diagram();
    expect(d.id).toBe("saga:acme.shop.Checkout");
    expect(d.label).toBe("Checkout");
    expect(d.version).toBe("1.0");
  });

  it("draws the start message, its key and what it seeds", () => {
    const d = diagram();
    expect(d.start?.message.label).toBe("Place");
    expect(d.start?.message.id).toBe("message:acme.shop.Place");
    expect(d.start?.keyedBy).toBe("id");
    expect(d.start?.seeds).toEqual(["total"]);
  });

  it("lists state by name, leaving the types to the Contract view", () => {
    expect(diagram().state).toEqual(["total", "holdRef", "authRef"]);
  });

  it("keeps the deadline, which bounds every stage at once", () => {
    expect(diagram().deadlineMs).toBe(86_400_000);
  });

  it("is findable by the id a selection carries", () => {
    const m = model();
    expect(sagaById(m, "saga:acme.shop.Checkout")?.id.name).toBe("Checkout");
    expect(sagaById(m, "saga:acme.shop.Nope")).toBeUndefined();
  });
});

describe("stages", () => {
  it("groups a parallel block into one stage and marks it", () => {
    const d = diagram();
    expect(d.stages.map((s) => s.steps.map((c) => c.name))).toEqual([
      ["hold", "authorise"],
      ["ship"],
    ]);
    expect(d.stages.map((s) => s.parallel)).toEqual([true, false]);
  });

  it("puts a stage's cards side by side at the same height", () => {
    const [first] = diagram().stages;
    const [hold, authorise] = first!.steps;
    expect(hold!.y).toBe(authorise!.y);
    expect(hold!.height).toBe(authorise!.height);
    expect(authorise!.x).toBeGreaterThan(hold!.x);
  });

  it("starts the next band below the whole of the one before it", () => {
    // The property a parallel stage threatens: the band after it must clear the *tallest* card, not
    // the last one declared.
    const d = diagram();
    const [first, second] = d.stages;
    const bottom = Math.max(...first!.steps.map((c) => c.y + c.height));
    expect(second!.y).toBeGreaterThan(bottom);
  });

  it("widens the diagram to hold the widest stage", () => {
    const d = diagram();
    const widest = Math.max(...d.stages.flatMap((s) => s.steps).map((c) => c.x + c.width));
    expect(d.width).toBeGreaterThan(widest);
    // And the exit rail is inside it, to the right of every card.
    expect(d.exitX).toBeGreaterThan(widest);
    expect(d.exitX).toBeLessThan(d.width);
  });

  it("runs the spine left of every card", () => {
    const d = diagram();
    for (const c of d.stages.flatMap((s) => s.steps)) expect(d.spineX).toBeLessThan(c.x);
  });
});

describe("a step card", () => {
  it("names what it sends and counts what it carries", () => {
    const d = diagram();
    expect(card(d, "hold")?.send?.label).toBe("Hold");
    expect(card(d, "hold")?.carries).toBe(0);
    // `send Auth { amount = state.total }` writes one field a name match could not reach.
    expect(card(d, "authorise")?.carries).toBe(1);
  });

  it("reads each outcome as the author wrote it", () => {
    expect(labels(diagram(), "hold")).toEqual([
      "on Held → holdRef",
      "on Short → reject “out of stock”",
      "on timeout 5s → reject “the warehouse did not answer”",
    ]);
  });

  it("distinguishes the three actions", () => {
    const d = diagram();
    expect(card(d, "hold")?.outcomes.map((o) => o.kind)).toEqual([
      "continue",
      "reject",
      "reject",
    ]);
    expect(card(d, "authorise")?.outcomes.map((o) => o.kind)).toEqual(["continue", "abandon"]);
  });

  it("puts outcome rows in order, down the card", () => {
    const rows = card(diagram(), "hold")!.outcomes;
    for (const [i, row] of rows.entries()) {
      if (i > 0) expect(row.y).toBeGreaterThan(rows[i - 1]!.y);
    }
    expect(rows.at(-1)!.y).toBeLessThan(card(diagram(), "hold")!.y + card(diagram(), "hold")!.height);
  });

  it("gives the timeout row a duration and no message", () => {
    const row = card(diagram(), "ship")!.outcomes.at(-1)!;
    expect(row.afterMs).toBe(120_000);
    expect(row.message).toBeUndefined();
    expect(row.label).toBe("on timeout 2m → reject “no courier”");
  });

  it("carries a selection id on every message it names", () => {
    const d = diagram();
    expect(card(d, "hold")?.outcomes[0]?.message?.id).toBe("message:acme.shop.Held");
  });
});

describe("the silences", () => {
  it("tells a deliberate `undo none` from a missing one", () => {
    const d = diagram();
    expect(card(d, "hold")?.undo).toEqual({
      k: "with",
      // As written, kept beside the resolved message so a reference that resolves to nothing is still
      // drawn as the inverse somebody declared rather than as one nobody did.
      text: "Release",
      message: { qname: "acme.shop.Release", label: "Release", id: "message:acme.shop.Release" },
      carries: 0,
    });
    expect(card(d, "authorise")?.undo).toEqual({ k: "none" });
    // `ship` is the last step, so declaring nothing is not a warning — but the card still says so,
    // because "this cannot be unwound" is what a reader is looking for either way.
    expect(card(d, "ship")?.undo).toEqual({ k: "absent" });
  });

  /**
   * A fourth case the three states have to keep apart.
   *
   * An inverse whose message does not resolve is a declared inverse that is broken, which is neither
   * `none` nor `absent`. Reporting it as absent said nobody had declared one — the one thing that was
   * certainly false — and it is what the view then offered to fill in for you.
   */
  it("keeps a broken inverse a `with`, not an absence", () => {
    // Built without the usual no-errors check, because an unresolved reference *is* an error — which
    // is the state this is about: the model is broken, and the view must say which way.
    const broken = buildWorkspace([
      { path: "shop.7k", source: MODEL.replace("undo with Release", "undo with Nowhere") },
    ]);
    const d = layoutSaga(broken.model, only(broken.model));
    const undo = card(d, "hold")?.undo;
    expect(undo?.k).toBe("with");
    expect(undo?.k === "with" && undo.text).toBe("Nowhere");
    expect(undo?.k === "with" && undo.message).toBeUndefined();
  });

  it("marks a step with no timeout of its own", () => {
    const source = MODEL.replace("    on timeout 2m reject \"no courier\"\n", "");
    const d = diagram(source);
    expect(card(d, "ship")?.unbounded).toBe(true);
    expect(card(d, "hold")?.unbounded).toBe(false);
    // And it reserves the row anyway, so the card does not silently lose a line.
    expect(card(d, "ship")?.height).toBe(card(diagram(), "ship")?.height);
  });

  it("draws all three terminals, including the one nothing announces", () => {
    const d = diagram();
    expect(d.terminals.map((t) => [t.on, t.message?.label])).toEqual([
      ["complete", "Won"],
      ["reject", "Lost"],
      // Declared `on deadline 24h abandon`, so the saga can abandon — and says nothing when it does.
      ["abandon", undefined],
    ]);
  });

  it("puts the terminal band below the last stage", () => {
    const d = diagram();
    const last = d.stages.at(-1)!;
    expect(d.terminalBand.y).toBeGreaterThanOrEqual(last.y + last.height);
    expect(d.height).toBeGreaterThan(d.terminalBand.y + d.terminalBand.height);
  });
});

describe("a declared duration", () => {
  it("reads back in the unit it was written in", () => {
    // `sayGap` is for a measured wait and renders a day as `1.0d`; an author who wrote `24h` should
    // not have to recognise their own timeout.
    expect(sayDuration(86_400_000)).toBe("1d");
    expect(sayDuration(3_600_000)).toBe("1h");
    expect(sayDuration(120_000)).toBe("2m");
    expect(sayDuration(5000)).toBe("5s");
    expect(sayDuration(250)).toBe("250ms");
  });

  it("prefers an exact unit over a tidier rounded one", () => {
    // 90 seconds is not a whole number of minutes, so it stays in seconds. `sayGap` would round it
    // to `2m`, which is a different timeout from the one declared.
    expect(sayDuration(90_000)).toBe("90s");
    expect(sayGap(90_000)).toBe("2m");
  });

  it("falls back to the measured form when no unit divides at all", () => {
    expect(sayDuration(1500)).toBe("1.5s");
  });
});

describe("an instance's progress", () => {
  const ev = (seq: number, kind: string, step?: string, key = "O-1"): TraceEvent =>
    ({
      run: "S#1",
      seq,
      at: seq * 10,
      kind,
      saga: "acme.shop.Checkout",
      sagaKey: key,
      // `step` is data. The prose in `detail` is deliberately *wrong* here, so a reader of it would
      // fail these tests — which is the point: `30-scenarios.md` 7.4 says never to match on it.
      detail: "prose a consumer must not read",
      ...(step === undefined ? {} : { step }),
    }) as TraceEvent;

  const progress = (events: readonly TraceEvent[], key = "O-1") =>
    progressOf(only(model()), events, key);

  it("is nothing at all for a key the trace never mentions", () => {
    expect(progress([ev(0, "saga-started")], "O-9")).toBeUndefined();
  });

  it("waits in the branches of a stage that has not joined", () => {
    // `authorise` replied first. `hold` is still outstanding, and the stage has not advanced.
    const p = progress([ev(0, "saga-started"), ev(1, "saga-advanced", "authorise")]);
    expect(p?.completed).toEqual(["authorise"]);
    expect(p?.waiting).toEqual(["hold"]);
    expect(p?.terminal).toBeUndefined();
  });

  it("moves to the next stage once every branch has joined", () => {
    const p = progress([
      ev(0, "saga-started"),
      ev(1, "saga-advanced", "authorise"),
      ev(2, "saga-advanced", "hold"),
    ]);
    expect(p?.completed).toEqual(["authorise", "hold"]);
    expect(p?.waiting).toEqual(["ship"]);
  });

  it("does not count the step an instance ended in as completed", () => {
    // The rule, and the bug it exists for. `saga-advanced` fired for `hold` because its *action*
    // ran — and the action was `reject`. Reading that as success would draw a `Release` that was
    // never sent, because a step that did not complete is not compensated.
    const p = progress([
      ev(0, "saga-started"),
      ev(1, "saga-advanced", "hold"),
      ev(2, "saga-rejected", "hold"),
    ]);
    expect(p?.completed).toEqual([]);
    expect(p?.endedIn).toBe("hold");
    expect(p?.terminal).toBe("reject");
  });

  it("keeps the steps that completed before the one it ended in", () => {
    const p = progress([
      ev(0, "saga-started"),
      ev(1, "saga-advanced", "authorise"),
      ev(2, "saga-advanced", "hold"),
      ev(3, "saga-advanced", "ship"),
      ev(4, "saga-rejected", "ship"),
    ]);
    expect(p?.completed).toEqual(["authorise", "hold"]);
    expect(p?.endedIn).toBe("ship");
  });

  it("counts everything that advanced when a deadline ended it", () => {
    // A terminal with no `step`: nothing failed, the clock ran out. So both branches completed, and
    // both will be unwound.
    const p = progress([
      ev(0, "saga-started"),
      ev(1, "saga-advanced", "authorise"),
      ev(2, "saga-advanced", "hold"),
      ev(3, "saga-abandoned"),
    ]);
    expect(p?.completed).toEqual(["authorise", "hold"]);
    expect(p?.endedIn).toBeUndefined();
    expect(p?.terminal).toBe("abandon");
  });

  it("waits nowhere once it has terminated", () => {
    const p = progress([
      ev(0, "saga-started"),
      ev(1, "saga-advanced", "authorise"),
      ev(2, "saga-rejected", "hold"),
    ]);
    expect(p?.terminal).toBe("reject");
    expect(p?.waiting).toEqual([]);
  });

  it("records the unwinding in the order it happened", () => {
    const p = progress([
      ev(0, "saga-started"),
      ev(1, "saga-advanced", "authorise"),
      ev(2, "saga-advanced", "hold"),
      ev(3, "saga-advanced", "ship"),
      ev(4, "saga-rejected", "ship"),
      ev(5, "saga-irreversible", "authorise"),
      ev(6, "saga-compensating", "hold"),
    ]);
    // `authorise` declared `undo none`, so it is part of the unwinding without sending anything.
    expect(p?.compensated).toEqual(["authorise", "hold"]);
    // And the invariant the example asserts over a real trace: nothing is unwound that did not
    // complete.
    for (const name of p!.compensated) expect(p!.completed).toContain(name);
  });

  it("names the step that timed out", () => {
    const p = progress([ev(0, "saga-started"), ev(1, "saga-timeout", "hold")]);
    expect(p?.timedOut).toEqual(["hold"]);
  });

  it("ignores another instance's events", () => {
    const p = progress([
      ev(0, "saga-started"),
      ev(1, "saga-advanced", "hold", "O-2"),
      ev(2, "saga-advanced", "authorise"),
    ]);
    expect(p?.completed).toEqual(["authorise"]);
    expect(p?.waiting).toEqual(["hold"]);
  });
});

describe("a saga the checker would complain about", () => {
  it("still draws, because a view that needs a clean model is no use while fixing one", () => {
    // No steps at all: the one case where there is nothing between the start and the terminals.
    const source = MODEL.replace(/  parallel \{[\s\S]*?\n  \}\n\n  step ship \{[\s\S]*?\n  \}\n/, "");
    const ws = buildWorkspace([{ path: "shop.7k", source }]);
    const saga = sagasOf(ws.model)[0]!;
    const d = layoutSaga(ws.model, saga);
    expect(d.stages).toEqual([]);
    expect(d.start?.message.label).toBe("Place");
    expect(d.terminals).toHaveLength(3);
    expect(d.height).toBeGreaterThan(0);
  });
});

/**
 * Rows, and the one thing a diagram may never do.
 *
 * Geometry is asserted sparingly in this file, on the grounds that pinning every pixel makes a layout
 * untunable. This is the exception, because it is not a pixel — it is whether two things are legible
 * at all. The `send` row and the first outcome were drawn on the same baseline in every card that had
 * both, which came out as two lines of text on top of each other, and nothing here noticed because
 * nothing here asked.
 *
 * It happened because the view did this one row's arithmetic itself while every other coordinate came
 * from `layoutSaga`, and the two disagreed by exactly one row height. So the assertion is on the
 * layout, where the answer now lives.
 */
describe("every row has a line to itself", () => {
  /** Every baseline the view will draw text on, in one card, in the order it draws them. */
  const rowsIn = (d: SagaDiagram, name: string): { y: number; what: string }[] => {
    const c = cardOf(d, name);
    const rows: { y: number; what: string }[] = [];
    if (c.sendY !== undefined) rows.push({ y: c.sendY, what: `send ${c.send?.label ?? ""}` });
    for (const o of c.outcomes) rows.push({ y: o.y, what: o.label });
    // The two the view positions from the bottom of the card.
    const footY = c.y + c.height - 13;
    if (c.undo.k !== "absent") rows.push({ y: footY, what: "undo" });
    if (c.unbounded) rows.push({ y: footY - 19, what: "no timeout" });
    return rows.sort((a, b) => a.y - b.y);
  };

  const names = (d: SagaDiagram): string[] => d.stages.flatMap((s) => s.steps.map((c) => c.name));

  it("gives the send and the first outcome different baselines", () => {
    const d = diagram();
    for (const name of names(d)) {
      const c = cardOf(d, name);
      if (c.sendY === undefined || c.outcomes.length === 0) continue;
      expect(c.sendY, `${name}: send and first outcome collide`).not.toBe(c.outcomes[0]!.y);
      expect(c.outcomes[0]!.y).toBeGreaterThan(c.sendY);
    }
  });

  it("never puts two rows of any kind on one baseline", () => {
    const d = diagram();
    for (const name of names(d)) {
      const ys = rowsIn(d, name).map((r) => r.y);
      expect(new Set(ys).size, `${name}: ${ys.join(", ")}`).toBe(ys.length);
    }
  });

  it("leaves a readable gap between every pair of rows", () => {
    const d = diagram();
    for (const name of names(d)) {
      const rows = rowsIn(d, name);
      for (let i = 1; i < rows.length; i++) {
        const gap = rows[i]!.y - rows[i - 1]!.y;
        expect(gap, `${name}: \`${rows[i - 1]!.what}\` to \`${rows[i]!.what}\``).toBeGreaterThanOrEqual(14);
      }
    }
  });

  it("starts the first row clear of the card's own name", () => {
    const d = diagram();
    for (const name of names(d)) {
      const c = cardOf(d, name);
      const first = rowsIn(d, name)[0];
      if (first === undefined) continue;
      // The view draws the name at `card.y + 17`.
      expect(first.y - (c.y + 17), `${name}`).toBeGreaterThanOrEqual(14);
    }
  });

  it("keeps every row inside the card that holds it", () => {
    const d = diagram();
    for (const name of names(d)) {
      const c = cardOf(d, name);
      for (const row of rowsIn(d, name)) {
        expect(row.y, `${name}: \`${row.what}\` above the card`).toBeGreaterThan(c.y);
        expect(row.y, `${name}: \`${row.what}\` below the card`).toBeLessThan(c.y + c.height);
      }
    }
  });
});


/**
 * Which service runs a saga, and therefore what a step of it can send.
 *
 * 7K declares no host: a saga is run by the service that reacts to its start message, in its own
 * package. It matters because a saga's `send` is routed by that service's `emits` (D62), so the
 * messages a step can send are the ones the host already emits — anything else writes a step that
 * parses and then has nowhere to go.
 */
describe("a saga's host", () => {
  it("is the service that reacts to the start message", () => {
    const m = model();
    const host = hostOf(m, only(m));
    expect(host).toBeDefined();
    expect(host?.reacts.some((r) => m.resolve(r.message) !== undefined)).toBe(true);
  });

  it("offers what that service emits, and nothing else", () => {
    const m = model();
    const sendable = sendableFrom(m, only(m));
    const host = hostOf(m, only(m));
    const emitted = new Set(
      (host?.emits ?? []).map((e) => m.resolve(e.message)).filter((id) => id !== undefined),
    );
    expect(sendable.length).toBe(emitted.size);
    expect(sendable).toEqual([...sendable].sort());
  });

  it("offers nothing when there is no host to send from", () => {
    const m = model();
    const saga = only(m);
    // A saga whose package holds no service reacting to its start has nothing routable.
    const orphan = { ...saga, id: { ...saga.id, pkg: "nowhere" } };
    expect(sendableFrom(m, orphan)).toEqual([]);
    expect(hostOf(m, orphan)).toBeUndefined();
  });
});
