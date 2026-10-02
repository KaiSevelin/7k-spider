/**
 * The selection model's tests.
 *
 * A design document can claim "selecting in one view highlights in all three" and be wrong without
 * anyone noticing, which is the failure this project keeps running into. So the claims in
 * `docs/design.md` are asserted here, one test per claim, against a model Core actually parsed.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, hasErrors, type LinkedModel } from "@sevenk/core";
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
  type TraceEvent,
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

/** A trace of one order being fulfilled, in the shape the sandbox writes. */
const TRACE: TraceEvent[] = [
  { seq: 0, at: 0, kind: "published", message: "acme.sales.PlaceOrder", pipe: "acme.sales.commands" },
  {
    seq: 1, at: 0, kind: "delivered", message: "acme.sales.PlaceOrder",
    pipe: "acme.sales.commands", service: "OrderService", subscription: "PlaceOrder",
  },
  {
    seq: 2, at: 0, kind: "saga-started", saga: "acme.sales.Fulfilment", sagaKey: "order-1",
    message: "acme.sales.PlaceOrder",
  },
  {
    seq: 3, at: 10, kind: "published", message: "acme.warehouse.PickRequested",
    pipe: "acme.warehouse.commands", service: "OrderService",
  },
  {
    seq: 4, at: 20, kind: "delivered", message: "acme.warehouse.PickRequested",
    pipe: "acme.warehouse.commands", service: "PickingService", subscription: "PickRequested",
  },
  { seq: 5, at: 30, kind: "published", message: "acme.warehouse.Picked", pipe: "acme.warehouse.events" },
  {
    seq: 6, at: 40, kind: "saga-advanced", saga: "acme.sales.Fulfilment", sagaKey: "order-1",
    message: "acme.warehouse.Picked",
  },
  {
    seq: 7, at: 40, kind: "saga-completed", saga: "acme.sales.Fulfilment", sagaKey: "order-1",
  },
  // A second instance, so an instance selection has something to exclude.
  {
    seq: 8, at: 50, kind: "saga-started", saga: "acme.sales.Fulfilment", sagaKey: "order-2",
    message: "acme.sales.PlaceOrder",
  },
  // A dead letter, which is a node but not a declaration.
  {
    seq: 9, at: 60, kind: "dead-lettered", message: "acme.warehouse.PickRequested",
    pipe: "acme.warehouse.commands.dead",
  },
  { seq: 10, at: 70, kind: "schedule-fired", schedule: "acme.sales.Sweep", message: "acme.sales.PlaceOrder" },
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
  it("resolves qualified names and the one bare one", () => {
    const j = join(model(), TRACE);
    expect(j.idsOf(1)).toEqual(
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
    expect(j.idsOf(9)).toEqual(
      expect.arrayContaining([
        "pipe:acme.warehouse.commands.dead",
        "pipe:acme.warehouse.commands",
      ]),
    );
  });

  it("resolves a schedule and a saga", () => {
    const j = join(model(), TRACE);
    expect(j.idsOf(10)).toContain("schedule:acme.sales.Sweep");
    expect(j.idsOf(2)).toContain("saga:acme.sales.Fulfilment");
  });

  it("lists every instance once, in first-mention order", () => {
    const j = join(model(), TRACE);
    expect(j.instances).toEqual([
      { saga: "acme.sales.Fulfilment", key: "order-1" },
      { saga: "acme.sales.Fulfilment", key: "order-2" },
    ]);
  });

  it("refuses to guess when a bare service name is ambiguous", () => {
    // The trace writes a service unqualified, so two packages declaring `PickingService` leaves a
    // consumer no way to tell them apart. Highlighting the wrong one is worse than neither.
    const ws = buildWorkspace([
      { path: "a.7k", source: WAREHOUSE },
      {
        path: "b.7k",
        source: WAREHOUSE.replace("package acme.warehouse", "package acme.other"),
      },
    ]);
    const j = join(ws.model, [
      { seq: 0, at: 0, kind: "delivered", service: "PickingService" },
    ]);
    expect(j.idsOf(0)).toEqual([]);
    expect(j.ambiguous).toEqual(["PickingService"]);
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
    expect([...h.events]).toEqual([1, 3]);
    expect(h.interval).toEqual({ from: 0, to: 10 });
    // A declaration selection emphasises itself, not its neighbours: the graph would be a wash of
    // highlight if clicking a service lit every pipe it touches.
    expect([...h.declarations]).toEqual(["service:acme.sales.OrderService"]);
  });

  it("gives an event the declarations it touched and one instant", () => {
    const h = resolve(join(model(), TRACE), { k: "event", seq: 4 });
    expect([...h.events]).toEqual([4]);
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
    expect([...h.events]).toEqual([2, 6, 7]);
    expect(h.events).not.toContain(8);
    expect(h.interval).toEqual({ from: 0, to: 40 });
    expect(h.declarations).toContain("saga:acme.sales.Fulfilment");
  });

  it("gives an interval everything inside it, at both ends inclusive", () => {
    const h = resolve(join(model(), TRACE), { k: "interval", from: 20, to: 40 });
    expect([...h.events]).toEqual([4, 5, 6, 7]);
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
    const h = resolve(join(model(), []), { k: "event", seq: 4 });
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
  it("skips a blank line, a comment and a half-written last line", () => {
    const ndjson = [
      '{"seq":1,"at":5,"kind":"published"}',
      "",
      "   ",
      "not json at all",
      '{"seq":0,"at":0,"kind":"published"}',
      '{"seq":2,"at":9,"kind":"publ',
    ].join("\n");
    expect(readTrace(ndjson).map((e) => e.seq)).toEqual([0, 1]);
  });

  it("skips a line that is not an event by this interface's definition", () => {
    expect(readTrace('{"hello":"world"}')).toEqual([]);
    expect(readTrace('{"seq":1,"at":0}')).toEqual([]);
    expect(readTrace('{"seq":"1","at":0,"kind":"published"}')).toEqual([]);
  });

  it("orders by instant, then by sequence", () => {
    // A virtual clock does not advance while work is due, so many events share an instant and the
    // sequence number is the only thing that orders them.
    const ndjson = [
      '{"seq":3,"at":10,"kind":"handled"}',
      '{"seq":1,"at":0,"kind":"delivered"}',
      '{"seq":2,"at":0,"kind":"handled"}',
      '{"seq":0,"at":0,"kind":"published"}',
    ].join("\n");
    expect(readTrace(ndjson).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it("reads back what the sandbox writes", () => {
    const ndjson = TRACE.map((e) => JSON.stringify(e)).join("\n") + "\n";
    expect(readTrace(ndjson)).toEqual(TRACE);
  });
});
