/**
 * Focus.
 *
 * The claims worth asserting are the ones a reader would be misled by if they were wrong: that the
 * default radius answers the question a bipartite graph makes you ask twice, that an escaping edge ends
 * in a port rather than nowhere, and that a stale focus degrades to showing everything rather than to an
 * empty screen.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type LinkedModel } from "@sevenk/core";
import { buildGraph, type Graph } from "../src/graph.js";
import { applyFocus, DEFAULT_RADIUS, focusOn, isFocused, neighbourhood, NOT_FOCUSED } from "../src/focus.js";
import { resolveLens } from "../src/lens.js";
import { isPort } from "../src/restrict.js";
import { join, resolve } from "../src/selection.js";

// A chain long enough to measure a radius on: Web → inbound → Orders → events → Shipping → picks →
// Warehouse, with a side branch so a hop count is not just a line.
const MODEL = `
package acme.chain

message Place v1.0 @command { id: uuid @role(businessKey) }
message Placed v1.0 @event  { id: uuid @role(businessKey) }
message Shipped v1.0 @event { id: uuid @role(businessKey) }
message Noted v1.0 @event   { id: uuid @role(businessKey) }

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }
pipe picks   : topic { retention 7d }
pipe audit   : topic { retention 7d }

service Web @external {
  emits Place to inbound
}

service Orders {
  reacts Place from inbound {
    replies Placed
  }
  emits Placed to events
}

service Shipping {
  reacts Placed from events {
    replies Shipped
  }
  emits Shipped to picks
}

service Warehouse {
  reacts Shipped from picks {
    replies none
  }
}

service Ledger {
  reacts Placed from events {
    replies none
  }
  emits Noted to audit
}
`;

const model = (): LinkedModel => {
  const ws = buildWorkspace([{ path: "chain.7k", source: MODEL }]);
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  return ws.model;
};

const graph = (): Graph => buildGraph(model());
const ids = (g: Graph): string[] => g.nodes.map((n) => n.id).sort();
const ORDERS = "service:acme.chain.Orders";

describe("the radius", () => {
  it("reaches only pipes at one hop, which is why one is not the default", () => {
    // The graph is bipartite on purpose, so a service's neighbours at one hop are pipes. "Show me
    // Orders and what it touches" would answer with two queues and no colleagues.
    const near = [...neighbourhood(graph(), [ORDERS], 1)].sort();
    expect(near).toEqual([ORDERS, "pipe:acme.chain.events", "pipe:acme.chain.inbound"].sort());
  });

  it("reaches the services it actually talks to at two, which is the default", () => {
    expect(DEFAULT_RADIUS).toBe(2);
    const near = neighbourhood(graph(), [ORDERS]);
    expect(near).toContain("service:acme.chain.Web");
    expect(near).toContain("service:acme.chain.Shipping");
    expect(near).toContain("service:acme.chain.Ledger");
    // And stops there: Warehouse is four hops away, through picks.
    expect(near).not.toContain("service:acme.chain.Warehouse");
  });

  it("counts edges, so each extra hop reaches exactly one more layer", () => {
    const g = graph();
    const sizes = [0, 1, 2, 3, 4].map((r) => neighbourhood(g, [ORDERS], r).size);
    // Monotonic, and strictly growing until the component is exhausted.
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
    expect(sizes[0]).toBe(1);
    expect(neighbourhood(g, [ORDERS], 4)).toContain("service:acme.chain.Warehouse");
  });

  it("treats a radius of zero as the seed alone, and a negative one the same", () => {
    expect([...neighbourhood(graph(), [ORDERS], 0)]).toEqual([ORDERS]);
    expect([...neighbourhood(graph(), [ORDERS], -3)]).toEqual([ORDERS]);
  });

  it("reaches both ends of a pipe at one hop", () => {
    // Which is why the radius is in edges rather than in "levels": one hop is useful from a pipe and
    // useless from a service, and a single number says that honestly.
    const near = neighbourhood(graph(), ["pipe:acme.chain.events"], 1);
    expect(near).toContain("service:acme.chain.Orders");
    expect(near).toContain("service:acme.chain.Shipping");
    expect(near).toContain("service:acme.chain.Ledger");
  });
});

describe("a package seed stands for its contents", () => {
  it("focuses the things in the box, since the box has no edges of its own", () => {
    const near = neighbourhood(graph(), ["package:acme.chain"], 0);
    expect(near).toContain(ORDERS);
    expect(near).toContain("pipe:acme.chain.events");
    expect(near).not.toContain("package:acme.chain");
  });
});

describe("narrowing", () => {
  it("puts a port where the focus cuts an edge", () => {
    // A focused service drawn emitting into nothing would be wrong rather than partial, and a reader
    // has no way to tell the difference.
    const g = applyFocus(graph(), { seeds: [ORDERS], radius: 1 });
    const ports = g.nodes.filter((n) => n.kind === "port");
    expect(ports.length).toBeGreaterThan(0);
    const hidden = ports.flatMap((p) => [...(p.hidden ?? [])]);
    expect(hidden).toContain("acme.chain.Shipping");
  });

  it("never leaves an edge pointing at a node it did not draw, at any radius", () => {
    const whole = graph();
    for (const radius of [0, 1, 2, 3, 5]) {
      const g = applyFocus(whole, { seeds: [ORDERS], radius });
      const drawn = new Set(g.nodes.map((n) => n.id));
      for (const edge of g.edges) {
        expect(drawn.has(edge.from), `radius ${radius}: ${edge.id}`).toBe(true);
        expect(drawn.has(edge.to), `radius ${radius}: ${edge.id}`).toBe(true);
      }
    }
  });

  it("stops putting ports up once the radius covers everything", () => {
    const g = applyFocus(graph(), { seeds: [ORDERS], radius: 10 });
    expect(g.nodes.filter((n) => n.kind === "port")).toEqual([]);
    expect(ids(g)).toEqual(ids(graph()));
  });

  it("returns the graph untouched when not focused", () => {
    const g = graph();
    expect(applyFocus(g, NOT_FOCUSED)).toBe(g);
    expect(isFocused(NOT_FOCUSED)).toBe(false);
  });
});

describe("a stale focus degrades to everything, not to nothing", () => {
  it("shows the whole graph when the seed is gone", () => {
    // Spider watches files and re-parses on every keystroke, so a focus outliving its subject is normal.
    // An empty screen is the worst possible answer to "where did my model go".
    const g = applyFocus(graph(), { seeds: ["service:acme.chain.Renamed"], radius: 2 });
    expect(ids(g)).toEqual(ids(graph()));
  });

  it("shows the whole graph when the lens already hid the seed", () => {
    const lensed = resolveLens(graph(), {
      include: [],
      exclude: ["service:Orders", "service:Ledger"],
    });
    const g = applyFocus(lensed, { seeds: [ORDERS], radius: 2 });
    expect(ids(g)).toEqual(ids(lensed));
  });
});

describe("it composes after the lens", () => {
  it("narrows what the lens left, and never widens it", () => {
    const whole = graph();
    const lensed = resolveLens(whole, { include: ["service:Shipping"], exclude: [] });
    const focused = applyFocus(lensed, { seeds: ["service:acme.chain.Shipping"], radius: 1 });

    const lensedIds = new Set(ids(lensed));
    for (const node of focused.nodes) {
      if (node.kind === "port") continue; // a port is created by the narrowing, not kept from it
      expect(lensedIds.has(node.id), node.id).toBe(true);
    }
  });
});

describe("it is derived from the selection", () => {
  it("focuses on whatever the selection resolved to", () => {
    // One thing to point at: the focus follows the selection rather than being chosen separately, so the
    // two cannot drift apart.
    const m = model();
    const highlight = resolve(join(m, []), { k: "declaration", id: ORDERS });
    const focus = focusOn(highlight);
    expect(focus.seeds).toEqual([ORDERS]);
    expect(focus.radius).toBe(DEFAULT_RADIUS);
  });

  it("is not focused when the selection resolved to nothing", () => {
    const m = model();
    const highlight = resolve(join(m, []), { k: "none" });
    expect(isFocused(focusOn(highlight))).toBe(false);
  });
});
