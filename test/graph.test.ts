/**
 * The graph's tests.
 *
 * Every claim in the module's own comment is asserted here, because a comment that says "bipartite"
 * is a claim about behaviour and this project has learned what unexecuted claims are worth.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type LinkedModel } from "@sevenk/core";
import { buildGraph, nodeIds, type Graph } from "../src/graph.js";

const MODEL = `
package acme.shop

message PlaceOrder v1.0 @command { id: uuid @role(businessKey) }
message OrderPlaced v1.0 @event  { id: uuid @role(businessKey) }
message Audit v1.0 @event        { id: uuid @role(businessKey) }

pipe inbound  : queue { retention 7d }
pipe events   : topic { retention 7d }
pipe telemetry : topic {
  delivery at-most-once
  dlq      none
}

// Marks where the system ends: drawn as a port, not as a service.
service WebApp @external {
  emits PlaceOrder to inbound
}

service OrderService {
  reacts PlaceOrder from inbound {
    replies OrderPlaced
  }
  emits OrderPlaced to events
  emits Audit       to events
}

// Two subscriptions of one service on one pipe, which the as-clause exists to tell apart.
service Reporting {
  reacts OrderPlaced from events as Orders {
    replies none
  }
  reacts Audit from events as Audits {
    replies none
  }
}
`;

/** A declared outer package, so nesting has something real to nest in. */
const OUTER = `
package acme

pipe audit : topic { retention 7d }
`;

/** Two levels of implied package: `acme.a` is never declared. */
const DEEP = `
package acme.a.b

message Ping v1.0 @event { id: uuid @role(businessKey) }

pipe pings : topic { retention 7d }
`;

const model = (source = MODEL): LinkedModel => {
  const ws = buildWorkspace([{ path: "shop.7k", source }]);
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  return ws.model;
};

const graph = (over = {}): Graph => buildGraph(model(), over);
const kindOf = (g: Graph, id: string): string | undefined => g.nodes.find((n) => n.id === id)?.kind;
const edge = (g: Graph, id: string) => g.edges.find((e) => e.id === id);

describe("it is bipartite", () => {
  it("draws no edge between two services", () => {
    // The model never says "A calls B", so a graph that did would assert a coupling the language
    // deliberately does not have.
    const g = graph();
    for (const e of g.edges) {
      const from = kindOf(g, e.from);
      const to = kindOf(g, e.to);
      expect([from, to].filter((k) => k === "pipe" || k === "dead-letter")).toHaveLength(1);
    }
  });

  it("makes a message an edge label, not a node", () => {
    const g = graph();
    expect(g.nodes.map((n) => n.kind)).not.toContain("message");
    expect(edge(g, "service:acme.shop.OrderService -> pipe:acme.shop.events")?.messages).toEqual([
      "acme.shop.OrderPlaced",
      "acme.shop.Audit",
    ]);
  });

  it("points an emit at a pipe and a react away from one", () => {
    const g = graph();
    const emits = edge(g, "service:acme.shop.OrderService -> pipe:acme.shop.events")!;
    expect(emits.direction).toBe("emits");
    expect(emits.to).toBe("pipe:acme.shop.events");

    const reacts = g.edges.find((e) => e.subscription === "Orders")!;
    expect(reacts.direction).toBe("reacts");
    expect(reacts.from).toBe("pipe:acme.shop.events");
    expect(reacts.to).toBe("service:acme.shop.Reporting");
  });
});

describe("edges collapse, but only where collapsing loses nothing", () => {
  it("carries several messages on one edge rather than drawing parallel edges", () => {
    // One service emitting two messages to one pipe is one relationship.
    const g = graph();
    const between = g.edges.filter(
      (e) => e.from === "service:acme.shop.OrderService" && e.to === "pipe:acme.shop.events",
    );
    expect(between).toHaveLength(1);
    expect(between[0]!.messages).toHaveLength(2);
  });

  it("keeps two named subscriptions of one service on one pipe apart", () => {
    // `as Orders` and `as Audits` exist to distinguish them; collapsing would throw that away.
    const g = graph();
    const subs = g.edges
      .filter((e) => e.to === "service:acme.shop.Reporting")
      .map((e) => e.subscription);
    expect(subs.sort()).toEqual(["Audits", "Orders"]);
  });

  it("gives every edge a unique id, disambiguating only where it must", () => {
    const g = graph();
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
    // The unambiguous edge keeps `layout.json`'s spelling, with no suffix.
    expect(g.edges.map((e) => e.id)).toContain(
      "service:acme.shop.OrderService -> pipe:acme.shop.events",
    );
    // The ambiguous pair carries the subscription name.
    expect(g.edges.map((e) => e.id)).toContain(
      "pipe:acme.shop.events -> service:acme.shop.Reporting#Orders",
    );
  });
});

describe("nodes", () => {
  it("uses the selection id form, so a click needs no translation", () => {
    expect(nodeIds(graph())).toEqual(
      expect.arrayContaining([
        "package:acme.shop",
        "pipe:acme.shop.inbound",
        "service:acme.shop.OrderService",
      ]),
    );
  });

  it("draws an external service as a port", () => {
    // 7K describes no behaviour for an `@external` service, so drawing it like one it has analysed
    // would overstate what is known.
    expect(kindOf(graph(), "service:acme.shop.WebApp")).toBe("port");
    expect(kindOf(buildGraph(model(), { ports: false }), "service:acme.shop.WebApp")).toBe("service");
  });

  it("marks the boundary pipes, and only those", () => {
    const g = graph();
    const boundary = g.nodes.filter((n) => n.boundary === true).map((n) => n.id);
    // `WebApp @external` publishes to `inbound` and nothing external touches the others.
    expect(boundary).toEqual(["pipe:acme.shop.inbound"]);
  });

  it("carries a pipe's kind, which is what its shape shows", () => {
    const g = graph();
    expect(g.nodes.find((n) => n.id === "pipe:acme.shop.inbound")?.pipeKind).toBe("queue");
    expect(g.nodes.find((n) => n.id === "pipe:acme.shop.events")?.pipeKind).toBe("topic");
  });

  it("nests packages so an outer one collapses as a whole", () => {
    const ws = buildWorkspace([
      { path: "a.7k", source: MODEL },
      {
        path: "b.7k",
        source: `package acme\n\npipe audit : topic { retention 7d }\n\nservice Keeper {\n  reacts shop.Audit from audit {\n    replies none\n  }\n}\n\nimport acme.shop\n`,
      },
    ]);
    const g = buildGraph(ws.model);
    expect(g.nodes.find((n) => n.id === "package:acme.shop")?.parent).toBe("package:acme");
    expect(g.nodes.find((n) => n.id === "package:acme")?.parent).toBeUndefined();
  });

  it("puts every node in its package when packages are on, and none when they are off", () => {
    for (const node of graph().nodes) {
      if (node.kind === "package") continue;
      expect(node.parent, node.id).toBe("package:acme.shop");
    }
    const flat = buildGraph(model(), { packages: false });
    expect(flat.nodes.filter((n) => n.kind === "package")).toEqual([]);
    expect(flat.nodes.every((n) => n.parent === undefined)).toBe(true);
  });

  it("draws no box for a package nothing declared", () => {
    // `acme.shop` implies `acme` in the model, but an implied package is a naming prefix rather than
    // an ownership boundary, and a box around it would claim an owner nobody wrote.
    expect(nodeIds(graph())).not.toContain("package:acme");
    expect(nodeIds(graph())).toContain("package:acme.shop");
  });

  it("skips an implied package when nesting, rather than inventing a level", () => {
    // `package acme.a.b` is declared; `acme.a` is only implied by its name. So `acme.a.b` nests
    // directly inside `acme`, and the level nobody wrote is simply not there.
    const ws = buildWorkspace([
      { path: "outer.7k", source: OUTER },
      { path: "deep.7k", source: DEEP },
    ]);
    const g = buildGraph(ws.model);

    expect(nodeIds(g)).not.toContain("package:acme.a");
    expect(g.nodes.find((n) => n.id === "pipe:acme.a.b.pings")?.parent).toBe("package:acme.a.b");
    expect(g.nodes.find((n) => n.id === "package:acme.a.b")?.parent).toBe("package:acme");
    // Labelled relative to the box it is in, which is what makes skipping a level readable.
    expect(g.nodes.find((n) => n.id === "package:acme.a.b")?.label).toBe("a.b");
  });

  it("labels a nested package relative to the box it sits in", () => {
    const ws = buildWorkspace([
      { path: "outer.7k", source: OUTER },
      { path: "inner.7k", source: MODEL },
    ]);
    const g = buildGraph(ws.model);
    expect(g.nodes.find((n) => n.id === "package:acme.shop")?.label).toBe("shop");
    expect(g.nodes.find((n) => n.id === "package:acme")?.label).toBe("acme");
  });

  it("leaves out a package with nothing in it", () => {
    // Declared but empty: an empty box suggests something is missing from the picture rather than
    // from the package.
    const ws = buildWorkspace([
      { path: "a.7k", source: MODEL },
      { path: "empty.7k", source: "package acme.empty\n" },
    ]);
    expect(nodeIds(buildGraph(ws.model))).not.toContain("package:acme.empty");
  });
});

describe("dead letters", () => {
  it("are left out unless asked for", () => {
    expect(nodeIds(graph())).not.toContain("pipe:acme.shop.inbound.dead");
  });

  it("appear for a pipe that has one, and not for `dlq none`", () => {
    const g = buildGraph(model(), { deadLetters: true });
    expect(nodeIds(g)).toContain("pipe:acme.shop.inbound.dead");
    expect(nodeIds(g)).toContain("pipe:acme.shop.events.dead");
    // `telemetry` declares `dlq none`: lossy, with nothing to dead-letter into.
    expect(nodeIds(g)).not.toContain("pipe:acme.shop.telemetry.dead");
  });
});

describe("a half-written model is normal", () => {
  it("reports an unresolved message and still draws the edge", () => {
    // D20. A graph that vanished while you were typing would be useless at the moment you need it.
    const ws = buildWorkspace([
      {
        path: "half.7k",
        source: MODEL.replace("emits Audit       to events", "emits Nonexistent to events"),
      },
    ]);
    const g = buildGraph(ws.model);
    const e = g.edges.find((x) => x.from === "service:acme.shop.OrderService" && x.to === "pipe:acme.shop.events")!;
    expect(e.incomplete).toBe(true);
    // Shown as the author typed it, which is more use to them than a gap.
    expect(e.messages).toContain("Nonexistent");
    expect(g.unresolved.join(" ")).toContain("Nonexistent");
  });

  it("reports an unresolved pipe and draws no edge to nowhere", () => {
    const ws = buildWorkspace([
      { path: "half.7k", source: MODEL.replace("emits Audit       to events", "emits Audit to nowhere") },
    ]);
    const g = buildGraph(ws.model);
    expect(g.unresolved.join(" ")).toContain("nowhere");
    expect(g.edges.every((e) => nodeIds(g).includes(e.from) && nodeIds(g).includes(e.to))).toBe(true);
  });

  it("never emits an edge whose ends are not both nodes", () => {
    const ids = new Set(nodeIds(graph()));
    for (const e of graph().edges) {
      expect(ids.has(e.from), e.id).toBe(true);
      expect(ids.has(e.to), e.id).toBe(true);
    }
  });
});

describe("it is deterministic", () => {
  it("builds the same graph twice, in the same order", () => {
    // What a stable layout rests on. D25 makes stability matter more than optimality, and a layout
    // seeded by iteration order over a hash map would be neither.
    const a = buildGraph(model(), { deadLetters: true });
    const b = buildGraph(model(), { deadLetters: true });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("orders nodes and messages by declaration", () => {
    const g = graph();
    expect(g.nodes.filter((n) => n.kind === "pipe").map((n) => n.label)).toEqual([
      "inbound",
      "events",
      "telemetry",
    ]);
    expect(edge(g, "service:acme.shop.OrderService -> pipe:acme.shop.events")?.messages).toEqual([
      "acme.shop.OrderPlaced",
      "acme.shop.Audit",
    ]);
  });
});
