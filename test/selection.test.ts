/**
 * The selection model's tests.
 *
 * A design document can claim "selecting in one view highlights in all three" and be wrong without
 * anyone noticing, which is the failure this project keeps running into. So the claims in
 * `docs/design.md` are asserted here, one test per claim, against a model Core actually parsed.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, hasErrors, type LinkedModel } from "@sevenk/core";
import { eventKey, writeTrace, type TraceEvent } from "@sevenk/core";
import {
  declById,
  deadLetterId,
  idOf,
  isActive,
  join,
  packageId,
  parseId,
  readTrace,
  resolve,
  type Selection,
} from "../src/selection.js";

// A small but complete model: two packages, two services, two pipes with a dead letter, a saga and
// a schedule. Self-contained on purpose — a test that reads the sibling repository's examples would
// fail for reasons that have nothing to do with selection.
const WAREHOUSE = `
package acme.warehouse

message PickRequested v1.0 @command {
  orderId: uuid @role(businessKey)
}

message Picked v1.0 @event {
  orderId: uuid @role(businessKey)
}

pipe commands : queue {
  retention 7d
}

service PickingService {
  reacts PickRequested from commands {
    replies Picked
  }
  emits Picked to events
}

pipe events : topic {
  retention 7d
}
`;

const SALES = `
package acme.sales

import acme.warehouse

message PlaceOrder v1.0 @command {
  orderId: uuid @role(businessKey)
}

message OrderDone v1.0 @event {
  orderId: uuid @role(businessKey)
}

pipe commands : queue {
  retention 7d
}

service OrderService {
  reacts PlaceOrder from commands {
    replies none
  }
  emits warehouse.PickRequested to warehouse.commands
  reacts warehouse.Picked from warehouse.events {
    replies none
  }
  emits OrderDone to warehouse.events
}

saga Fulfilment v1.0 {
  start on PlaceOrder keyed by orderId {
  }

  step pick {
    send warehouse.PickRequested
    on warehouse.Picked
    on timeout 30s reject "picking timed out"
    undo none
  }
}

schedule Sweep {
  every "0 2 * * *" in "Europe/Stockholm"
  send PlaceOrder { orderId = occurrence.date }
  onMissed once
}
`;

function model(): LinkedModel {
  const ws = buildWorkspace([
    { path: "warehouse.7k", source: WAREHOUSE },
    { path: "sales.7k", source: SALES },
  ]);
  // A half-written model is normal (D20), but a test built on one proves nothing about linking, so
  // this asserts the fixture parses and resolves before anything else runs.
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  expect(hasErrors(ws.diagnostics)).toBe(false);
  return ws.model;
}

/** A trace of one order being fulfilled, in the shape a conforming runtime writes. */
const RUN = "Fulfils#42";
const ev = (e: Omit<TraceEvent, "run">): TraceEvent => ({ run: RUN, ...e });
const K = (seq: number, run = RUN): string => eventKey({ run, seq });

const TRACE: TraceEvent[] = [
  ev({ seq: 0, at: 0, kind: "published", message: "acme.sales.PlaceOrder", pipe: "acme.sales.commands" }),
  ev({
    seq: 1, at: 0, kind: "delivered", message: "acme.sales.PlaceOrder",
    pipe: "acme.sales.commands", service: "acme.sales.OrderService", subscription: "OrderService",
  }),
  ev({
    seq: 2, at: 0, kind: "saga-started", saga: "acme.sales.Fulfilment", sagaKey: "order-1",
    message: "acme.sales.PlaceOrder",
  }),
  ev({
    seq: 3, at: 10, kind: "published", message: "acme.warehouse.PickRequested",
    pipe: "acme.warehouse.commands", service: "acme.sales.OrderService",
  }),
  ev({
    seq: 4, at: 20, kind: "delivered", message: "acme.warehouse.PickRequested",
    pipe: "acme.warehouse.commands", service: "acme.warehouse.PickingService",
    subscription: "PickingService",
  }),
  ev({ seq: 5, at: 30, kind: "published", message: "acme.warehouse.Picked", pipe: "acme.warehouse.events" }),
  ev({
    seq: 6, at: 40, kind: "saga-advanced", saga: "acme.sales.Fulfilment", sagaKey: "order-1",
    message: "acme.warehouse.Picked",
  }),
  ev({ seq: 7, at: 40, kind: "saga-completed", saga: "acme.sales.Fulfilment", sagaKey: "order-1" }),
  // A second instance, so an instance selection has something to exclude.
  ev({
    seq: 8, at: 50, kind: "saga-started", saga: "acme.sales.Fulfilment", sagaKey: "order-2",
    message: "acme.sales.PlaceOrder",
  }),
  // A dead letter, which is a node but not a declaration.
  ev({
    seq: 9, at: 60, kind: "dead-lettered", message: "acme.warehouse.PickRequested",
    pipe: "acme.warehouse.commands.dead",
  }),
  ev({ seq: 10, at: 70, kind: "schedule-fired", schedule: "acme.sales.Sweep", message: "acme.sales.PlaceOrder" }),
];

describe("identity", () => {
  it("spells an id the way the sidecars spell a selector", () => {
    const m = model();
    const service = m.decls.find((d) => d.id.kind === "service" && d.id.name === "OrderService")!;
    expect(idOf(service)).toBe("service:acme.sales.OrderService");
    expect(packageId("acme.sales")).toBe("package:acme.sales");
    expect(deadLetterId("acme.warehouse.commands")).toBe("pipe:acme.warehouse.commands.dead");
  });

  it("round-trips every declaration in the model", () => {
    const m = model();
    for (const decl of m.decls) {
      const back = declById(m, idOf(decl));
      expect(back, idOf(decl)).toBeDefined();
      expect(back!.id.name).toBe(decl.id.name);
      expect(back!.id.kind).toBe(decl.id.kind);
    }
  });

  it("resolves nothing for a stale id, rather than throwing", () => {
    const m = model();
    expect(declById(m, "service:acme.sales.Renamed")).toBeUndefined();
    expect(declById(m, "service:acme.sales.OrderService".toUpperCase())).toBeUndefined();
    expect(declById(m, "nonsense")).toBeUndefined();
    expect(parseId("nonsense")).toBeUndefined();
    expect(parseId(":leading")).toBeUndefined();
    expect(parseId("service:")).toBeUndefined();
  });

  it("will not confuse a pipe and a service of the same name", () => {
    // `symbolKey` shares one namespace per package across kinds (D40), so a lookup that ignored the
    // kind would answer the wrong declaration here.
    const m = model();
    expect(declById(m, "pipe:acme.sales.commands")?.id.kind).toBe("pipe");
    expect(declById(m, "service:acme.sales.commands")).toBeUndefined();
  });
});

describe("the trace is the join", () => {
  it("resolves the qualified names the format requires", () => {
    const j = join(model(), TRACE);
    expect(j.idsOf(K(1))).toEqual(
      expect.arrayContaining([
        "message:acme.sales.PlaceOrder",
        "pipe:acme.sales.commands",
        "service:acme.sales.OrderService",
      ]),
    );
    expect(j.ambiguous).toEqual([]);
  });

  it("lights a dead letter and the pipe it belongs to", () => {
    const j = join(model(), TRACE);
    expect(j.idsOf(K(9))).toEqual(
      expect.arrayContaining([
        "pipe:acme.warehouse.commands.dead",
        "pipe:acme.warehouse.commands",
      ]),
    );
  });

  it("resolves a schedule and a saga", () => {
    const j = join(model(), TRACE);
    expect(j.idsOf(K(10))).toContain("schedule:acme.sales.Sweep");
    expect(j.idsOf(K(2))).toContain("saga:acme.sales.Fulfilment");
  });

  it("lists every instance once, in first-mention order", () => {
    const j = join(model(), TRACE);
    expect(j.instances).toEqual([
      { saga: "acme.sales.Fulfilment", key: "order-1" },
      { saga: "acme.sales.Fulfilment", key: "order-2" },
    ]);
  });

  it("refuses to guess when a producer writes a bare service name", () => {
    // Section 7.6 requires a qualified service, so this is a non-conforming producer — a converter
    // from another format, most likely. A bare name is resolved only when exactly one declaration
    // matches: with two packages declaring `PickingService`, highlighting the wrong one is worse
    // than highlighting neither, and picking the first would hide the collision for good.
    const ws = buildWorkspace([
      { path: "a.7k", source: WAREHOUSE },
      {
        path: "b.7k",
        source: WAREHOUSE.replace("package acme.warehouse", "package acme.other"),
      },
    ]);
    const j = join(ws.model, [ev({ seq: 0, at: 0, kind: "delivered", service: "PickingService" })]);
    expect(j.idsOf(K(0))).toEqual([]);
    expect(j.ambiguous).toEqual(["PickingService"]);
  });

  it("resolves a bare service name when only one declaration matches", () => {
    const j = join(model(), [
      ev({ seq: 0, at: 0, kind: "delivered", service: "PickingService" }),
    ]);
    expect(j.idsOf(K(0))).toEqual(["service:acme.warehouse.PickingService"]);
    expect(j.ambiguous).toEqual([]);
  });

  it("reports the trace's extent, and nothing for an empty trace", () => {
    expect(join(model(), TRACE).extent).toEqual({ from: 0, to: 70 });
    expect(join(model()).extent).toBeUndefined();
  });
});

describe("selecting one thing highlights a set", () => {
  it("gives a declaration everything it did and the span it did it in", () => {
    const h = resolve(join(model(), TRACE), {
      k: "declaration",
      id: "service:acme.sales.OrderService",
    });
    expect([...h.events]).toEqual([K(1), K(3)]);
    expect(h.interval).toEqual({ from: 0, to: 10 });
    // A declaration selection emphasises itself, not its neighbours: the graph would be a wash of
    // highlight if clicking a service lit every pipe it touches.
    expect([...h.declarations]).toEqual(["service:acme.sales.OrderService"]);
  });

  it("gives an event the declarations it touched and one instant", () => {
    const h = resolve(join(model(), TRACE), { k: "event", run: RUN, seq: 4 });
    expect([...h.events]).toEqual([K(4)]);
    expect(h.interval).toEqual({ from: 20, to: 20 });
    expect(h.declarations).toContain("service:acme.warehouse.PickingService");
    expect(h.declarations).toContain("message:acme.warehouse.PickRequested");
  });

  it("gives an instance its own events and no other instance's", () => {
    const h = resolve(join(model(), TRACE), {
      k: "instance",
      saga: "acme.sales.Fulfilment",
      key: "order-1",
    });
    expect([...h.events]).toEqual([K(2), K(6), K(7)]);
    expect(h.events).not.toContain(K(8));
    expect(h.interval).toEqual({ from: 0, to: 40 });
    expect(h.declarations).toContain("saga:acme.sales.Fulfilment");
  });

  it("gives an interval everything inside it, at both ends inclusive", () => {
    const h = resolve(join(model(), TRACE), { k: "interval", from: 20, to: 40 });
    expect([...h.events]).toEqual([K(4), K(5), K(6), K(7)]);
    expect(h.interval).toEqual({ from: 20, to: 40 });
  });

  it("highlights nothing for no selection", () => {
    const h = resolve(join(model(), TRACE), { k: "none" });
    expect(isActive(h)).toBe(false);
    expect(h.interval).toBeUndefined();
  });
});

describe("a selection outlives the model it was made against", () => {
  it("survives a re-parse", () => {
    // What makes a selection an identity rather than a reference: Spider re-parses on every
    // keystroke, and the selection has to mean the same thing against the new model object.
    const selection: Selection = { k: "declaration", id: "service:acme.sales.OrderService" };
    const first = resolve(join(model(), TRACE), selection);
    const second = resolve(join(model(), TRACE), selection);
    expect([...second.declarations]).toEqual([...first.declarations]);
    expect([...second.events]).toEqual([...first.events]);
  });

  it("survives the thing it names being deleted", () => {
    const ws = buildWorkspace([{ path: "warehouse.7k", source: WAREHOUSE }]);
    const h = resolve(join(ws.model, []), {
      k: "declaration",
      id: "service:acme.sales.OrderService",
    });
    // Nothing resolves, so nothing lights up — but the id is still emphasised, because a view that
    // forgot the selection on a transient parse failure would lose it on every keystroke.
    expect([...h.events]).toEqual([]);
    expect(h.interval).toBeUndefined();
  });

  it("drops an event that is no longer in the trace", () => {
    const h = resolve(join(model(), []), { k: "event", run: RUN, seq: 4 });
    expect(isActive(h)).toBe(false);
  });
});

describe("the graph is useful before anything has run", () => {
  it("resolves a declaration with no trace at all", () => {
    const m = model();
    const j = join(m);
    for (const decl of m.decls) {
      const h = resolve(j, { k: "declaration", id: idOf(decl) });
      expect([...h.declarations]).toEqual([idOf(decl)]);
      expect(h.events.size).toBe(0);
      expect(h.interval).toBeUndefined();
    }
  });
});

describe("reading a trace file", () => {
  it("uses Core's reader, so the format has one definition", () => {
    // Core owns the format (`30-scenarios.md` 7.8) and tests the reader; what matters here is that
    // Spider reads a real trace back into the events it joins against.
    const { events, problems } = readTrace(
      writeTrace(TRACE),
    );
    expect(problems).toEqual([]);
    expect(events).toEqual(TRACE);
    expect(resolve(join(model(), events), { k: "event", run: RUN, seq: 4 }).declarations).toContain(
      "service:acme.warehouse.PickingService",
    );
  });
});
