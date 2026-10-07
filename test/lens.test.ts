/**
 * Lenses.
 *
 * The interesting cases are not the filtering. They are closure — a view that dropped what it did not
 * match would show a service with no visible reason for the messages leaving it — and the port that
 * stands where an edge still escapes. Both are `20-ir.md` 6.1's own rules, and the examples' own
 * `WebFlow` lens is the case that needs them.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type LinkedModel } from "@sevenk/core";
import { buildGraph, type Graph } from "../src/graph.js";
import {
  EVERYTHING,
  isEverything,
  isPort,
  parseSelector,
  parseViews,
  portId,
  resolveLens,
  type Lens,
} from "../src/lens.js";

const MODEL = `
package acme.shop

label pii

record Buyer {
  email: string @pii
}

message PlaceOrder v1.0 @command {
  id:    uuid @role(businessKey)
  buyer: Buyer
}
message OrderPlaced v1.0 @event { id: uuid @role(businessKey) }
message Audit v1.0 @event       { id: uuid @role(businessKey) }

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }

service WebApp @external {
  emits PlaceOrder to inbound
}

service OrderService {
  reacts PlaceOrder from inbound {
    replies OrderPlaced
  }
  emits OrderPlaced to events
}

service Reporting {
  reacts OrderPlaced from events {
    replies none
  }
  emits Audit to events
}
`;

const WAREHOUSE = `
package acme.warehouse

import acme.shop

message Picked v1.0 @event { id: uuid @role(businessKey) }

pipe picks : topic { retention 7d }

service Picking {
  reacts shop.OrderPlaced from shop.events {
    replies none
  }
  emits Picked to picks
}
`;

const model = (...sources: string[]): LinkedModel => {
  const ws = buildWorkspace(
    (sources.length === 0 ? [MODEL, WAREHOUSE] : sources).map((source, i) => ({
      path: `m${i}.7k`,
      source,
    })),
  );
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  return ws.model;
};

const lensed = (lens: Lens, m: LinkedModel = model()): Graph =>
  resolveLens(buildGraph(m), lens);
const ids = (g: Graph): string[] => g.nodes.map((n) => n.id).sort();

describe("selectors", () => {
  it("splits at the first colon, and only for the four forms", () => {
    expect(parseSelector("package:acme.shop")).toEqual({ kind: "package", name: "acme.shop" });
    expect(parseSelector("pipe:acme.shop.events.dead")).toEqual({
      kind: "pipe",
      name: "acme.shop.events.dead",
    });
    expect(parseSelector("node:x")).toBeUndefined();
    expect(parseSelector("label:")).toBeUndefined();
    expect(parseSelector("nocolon")).toBeUndefined();
  });

  it("names a thing qualified or bare, because views.json does both", () => {
    // Its own examples: `package:acme.retail.sales` beside `service:KioskBridge`.
    expect(ids(lensed({ include: ["service:acme.shop.OrderService"], exclude: [] }))).toContain(
      "service:acme.shop.OrderService",
    );
    expect(ids(lensed({ include: ["service:OrderService"], exclude: [] }))).toContain(
      "service:acme.shop.OrderService",
    );
  });

  it("ignores case, since references resolve that way", () => {
    expect(ids(lensed({ include: ["service:orderservice"], exclude: [] }))).toContain(
      "service:acme.shop.OrderService",
    );
  });
});

describe("package selectors reach descendants", () => {
  it("selects a whole area from a parent package name", () => {
    // `acme` owns no declarations of its own, so a lens that stopped at direct members would select
    // nothing at all — which is a trap rather than a rule.
    const g = lensed({ include: ["package:acme"], exclude: [] });
    expect(ids(g)).toContain("service:acme.shop.OrderService");
    expect(ids(g)).toContain("service:acme.warehouse.Picking");
  });

  it("selects one package without its sibling", () => {
    const g = lensed({ include: ["package:acme.warehouse"], exclude: [] });
    expect(ids(g)).toContain("service:acme.warehouse.Picking");
    expect(ids(g)).not.toContain("service:acme.shop.Reporting");
  });
});

describe("a label selector spans labels and annotations", () => {
  it("matches a propagated label, not only a declared one", () => {
    // `@pii` is on a field of Buyer; it reaches PlaceOrder and then `inbound`. A lens on `label:pii`
    // that saw only declared labels would select the record and miss the pipe, which is backwards.
    const g = lensed({ include: ["label:pii"], exclude: [] });
    expect(ids(g)).toContain("pipe:acme.shop.inbound");
  });

  it("matches an annotation, so the specification's own perimeter lens works", () => {
    // `views.json` ships `"Perimeter": { "include": ["label:external"] }`, and `label external` is an
    // error to declare — so this only means anything because the two share one namespace (D95).
    const g = lensed({ include: ["label:external"], exclude: [] });
    expect(ids(g)).toContain("service:acme.shop.WebApp");
  });
});

describe("a view closes over its edges", () => {
  it("brings in the pipes a service touches", () => {
    // "including a service brings in the pipes it emits to and reacts from".
    const g = lensed({ include: ["service:OrderService"], exclude: [] });
    expect(ids(g)).toContain("pipe:acme.shop.inbound");
    expect(ids(g)).toContain("pipe:acme.shop.events");
  });

  it("brings in both ends of a pipe", () => {
    const g = lensed({ include: ["pipe:acme.shop.events"], exclude: [] });
    expect(ids(g)).toContain("service:acme.shop.OrderService");
    expect(ids(g)).toContain("service:acme.shop.Reporting");
  });

  it("closes one step, not transitively", () => {
    // Iterating would walk the whole connected component, and the lens would select everything —
    // plainly not what a saved filter is for. `OrderService` pulls in `events`; `events` does not then
    // pull in the warehouse that also reads it.
    const g = lensed({ include: ["service:OrderService"], exclude: [] });
    expect(ids(g)).not.toContain("service:acme.warehouse.Picking");
    expect(ids(g)).not.toContain("pipe:acme.warehouse.picks");
  });

  it("keeps a package box only where something still sits in it", () => {
    const g = lensed({ include: ["service:acme.warehouse.Picking"], exclude: [] });
    expect(ids(g)).toContain("package:acme.warehouse");
    // `acme.shop` survives, because closure pulled `shop.events` in.
    expect(ids(g)).toContain("package:acme.shop");
  });
});

describe("excludes", () => {
  it("subtract after the includes, and cannot be undone by one", () => {
    const g = lensed({
      include: ["package:acme.shop", "service:acme.shop.Reporting"],
      exclude: ["service:Reporting"],
    });
    expect(ids(g)).not.toContain("service:acme.shop.Reporting");
    expect(ids(g)).toContain("service:acme.shop.OrderService");
  });

  it("work without an include, so a lens can be subtractive only", () => {
    const g = lensed({ include: [], exclude: ["package:acme.warehouse"] });
    expect(ids(g)).toContain("service:acme.shop.OrderService");
    expect(ids(g)).not.toContain("service:acme.warehouse.Picking");
  });
});

describe("a port stands where an edge leaves", () => {
  it("appears for an excluded producer, which is the examples' own WebFlow case", () => {
    // `WebFlow` includes two packages and excludes `KioskBridge`, which emits to an included pipe.
    // Dropping that edge silently would show a pipe with traffic from nowhere.
    const g = lensed({ include: ["package:acme.shop"], exclude: ["service:WebApp"] });
    const port = portId("pipe:acme.shop.inbound", "in");
    expect(ids(g)).toContain(port);
    expect(isPort(port)).toBe(true);

    const node = g.nodes.find((n) => n.id === port)!;
    expect(node.kind).toBe("port");
    expect(node.hidden).toEqual(["acme.shop.WebApp"]);
    // Counted, not named: a name would read as a node that is in the view after all.
    expect(node.label).toBe("1 outside");
  });

  it("points into the view for a producer and out of it for a consumer", () => {
    // The warehouse is excluded as well as WebApp: left in, `Picking` arrives by closure and nothing
    // escapes outward at all, which is the right behaviour and the wrong test.
    const g = lensed({
      include: ["package:acme.shop"],
      exclude: ["service:WebApp", "package:acme.warehouse"],
    });

    // `WebApp` produces into `inbound`, so its port points *into* the view.
    const into = g.edges.find((e) => isPort(e.from))!;
    expect(into.to).toBe("pipe:acme.shop.inbound");
    expect(into.from).toBe(portId("pipe:acme.shop.inbound", "in"));

    // The warehouse consumes `shop.events` from outside, so that port points *out*.
    const outOf = g.edges.find((e) => isPort(e.to))!;
    expect(outOf.from).toBe("pipe:acme.shop.events");
    expect(outOf.to).toBe(portId("pipe:acme.shop.events", "out"));
    expect(g.nodes.find((n) => n.id === outOf.to)?.hidden).toEqual(["acme.warehouse.Picking"]);
  });

  it("aggregates several hidden counterparties into one port", () => {
    // One curve per hidden thing is the unreadable picture the aggregation exists to avoid. Both
    // `OrderService` and `Reporting` publish to `events` from outside the view, and they share a
    // single inbound port rather than getting one each.
    const g = lensed({
      include: ["pipe:acme.shop.events"],
      exclude: ["service:OrderService", "service:Reporting"],
    });

    const inbound = g.nodes.find((n) => n.id === portId("pipe:acme.shop.events", "in"))!;
    expect(inbound.hidden).toEqual(["acme.shop.OrderService", "acme.shop.Reporting"]);
    expect(inbound.label).toBe("2 outside");

    // And exactly one edge carries them, with both messages on it.
    const edges = g.edges.filter((e) => e.from === inbound.id);
    expect(edges).toHaveLength(1);
    expect([...edges[0]!.messages].sort()).toEqual(["acme.shop.Audit", "acme.shop.OrderPlaced"]);
  });

  it("gives a node brought in by closure its own port for what it still touches", () => {
    // `Picking` arrives because it reads `shop.events`, and it emits to `warehouse.picks`, which did
    // not. That edge escapes, so it gets a port — the alternative is a service that emits into
    // nothing visible, which is the picture a lens must not produce.
    const g = lensed({
      include: ["pipe:acme.shop.events"],
      exclude: ["service:OrderService", "service:Reporting"],
    });
    const port = g.nodes.find((n) => n.id === portId("service:acme.warehouse.Picking", "out"))!;
    expect(port).toBeDefined();
    expect(port.hidden).toEqual(["acme.warehouse.picks"]);
  });

  it("carries the messages that cross, so the edge still says what it is", () => {
    const g = lensed({ include: ["package:acme.shop"], exclude: ["service:WebApp"] });
    const edge = g.edges.find((e) => isPort(e.from))!;
    expect(edge.messages).toEqual(["acme.shop.PlaceOrder"]);
  });

  it("never leaves an edge pointing at a node that is not there", () => {
    for (const lens of [
      { include: ["service:OrderService"], exclude: [] },
      { include: ["package:acme.shop"], exclude: ["service:WebApp"] },
      { include: ["label:pii"], exclude: [] },
      { include: [], exclude: ["package:acme.warehouse"] },
      { include: ["pipe:acme.shop.events"], exclude: ["service:OrderService"] },
    ]) {
      const g = lensed(lens);
      const present = new Set(g.nodes.map((n) => n.id));
      for (const e of g.edges) {
        expect(present.has(e.from), `${JSON.stringify(lens)} ${e.id}`).toBe(true);
        expect(present.has(e.to), `${JSON.stringify(lens)} ${e.id}`).toBe(true);
      }
      expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
    }
  });
});

describe("the lens that hides nothing", () => {
  it("returns the graph unchanged", () => {
    const g = buildGraph(model());
    expect(resolveLens(g, EVERYTHING)).toBe(g);
    expect(isEverything(EVERYTHING)).toBe(true);
    expect(isEverything({ include: [], exclude: ["service:X"] })).toBe(false);
  });
});

describe("reading views.json", () => {
  it("reads the examples' own file", () => {
    const { views, problems } = parseViews(
      JSON.stringify({
        _comment: "a note, not a lens",
        WebFlow: {
          include: ["package:acme.retail.sales", "package:acme.retail.ticketing"],
          exclude: ["service:KioskBridge"],
        },
        PiiFlow: { include: ["label:pii"] },
        Perimeter: { include: ["label:external"] },
      }),
    );
    expect(problems).toEqual([]);
    expect(Object.keys(views)).toEqual(["WebFlow", "PiiFlow", "Perimeter"]);
    expect(views["WebFlow"]!.exclude).toEqual(["service:KioskBridge"]);
    // An absent `exclude` is an empty one, not a missing field to branch on.
    expect(views["PiiFlow"]!.exclude).toEqual([]);
  });

  it("drops a bad entry with a reason rather than taking the others down", () => {
    const { views, problems } = parseViews(
      JSON.stringify({
        Good: { include: ["package:acme"] },
        Bad: "not a lens",
        Partly: { include: ["package:acme", "nonsense:x"] },
        Wrong: { include: 7 },
      }),
    );
    expect(Object.keys(views).sort()).toEqual(["Good", "Partly", "Wrong"]);
    expect(views["Partly"]!.include).toEqual(["package:acme"]);
    expect(problems.join(" ")).toContain("`Bad` is not a lens");
    expect(problems.join(" ")).toContain("`nonsense:x` is not a selector");
    expect(problems.join(" ")).toContain("`Wrong`.include is not a list");
  });

  it("survives a file that is not JSON at all", () => {
    expect(parseViews("{").views).toEqual({});
    expect(parseViews("{").problems[0]).toContain("not JSON");
    expect(parseViews("[]").problems[0]).toContain("not a JSON object");
  });
});

/**
 * `closure: "none"` — a perimeter view of one subsystem.
 *
 * The default closes over the edges, which is right for a lens somebody wrote by naming what they
 * wanted. It is wrong for "show me this package", and wrong in a way that is easy to miss: the
 * neighbours' pipes come in whole, their package boxes come with them, and the ports end up one hop
 * further out than the boundary that was asked about. Which is what the `one package` rows in Spider's
 * lens picker were doing.
 */
describe("a view that does not close over its edges", () => {
  it("keeps what the selectors named and nothing else", () => {
    const g = lensed({ include: ["package:acme.shop"], exclude: [], closure: "none" });
    expect(ids(g)).toContain("service:acme.shop.OrderService");
    expect(ids(g)).not.toContain("pipe:acme.warehouse.picks");
    expect(ids(g)).not.toContain("service:acme.warehouse.Picking");
    // And no box for a package with nothing of its own left in view.
    expect(ids(g)).not.toContain("package:acme.warehouse");
  });

  it("stands a port where the closing version brought a node in whole", () => {
    const closed = lensed({ include: ["package:acme.shop"], exclude: [] });
    const open = lensed({ include: ["package:acme.shop"], exclude: [], closure: "none" });
    // The same boundary, reported two ways: as foreign nodes, or as ports on the near side of it.
    const foreign = (of: readonly string[]): string[] => of.filter((id) => id.includes("acme.warehouse"));
    expect(foreign(ids(closed)).length).toBeGreaterThan(0);
    expect(foreign(ids(open))).toEqual([]);
    expect(ids(open).filter(isPort).length).toBeGreaterThan(0);
  });

  it("is read from views.json, and anything else is a problem rather than a default", () => {
    const good = parseViews('{ "Only": { "include": ["package:acme.shop"], "closure": "none" } }');
    expect(good.problems).toEqual([]);
    expect(good.views["Only"]?.closure).toBe("none");

    const bad = parseViews('{ "Only": { "include": [], "closure": "sideways" } }');
    expect(bad.problems.join(" ")).toContain("closure");
  });

  it("defaults to closing, so every lens written before this one is unchanged", () => {
    const g = lensed({ include: ["service:OrderService"], exclude: [] });
    expect(ids(g)).toContain("pipe:acme.shop.events");
    expect(parseViews('{ "A": { "include": [] } }').views["A"]?.closure).toBeUndefined();
  });
});
