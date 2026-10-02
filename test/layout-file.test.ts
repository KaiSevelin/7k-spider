/**
 * `layout.json`, and the rule the whole design turns on.
 *
 * "A missing node falls back to auto-layout for that node, not for the view." Which means the thing worth
 * asserting is a negative: **adding a node must not move a saved one.** That is the difference between a
 * graph you learn the shape of and one you stop trusting.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace } from "@sevenk/core";
import { buildGraph } from "../src/graph.js";
import {
  EMPTY_VIEW,
  WHOLE_MODEL,
  hasSaved,
  mergeLayout,
  parseLayout,
  viewOf,
  withPositions,
  writeLayout,
  type Point,
} from "../src/layout.js";

const SAVED = {
  "service:acme.shop.OrderService": { x: 80, y: 40 },
  "pipe:acme.shop.events": { x: 80, y: 200 },
};

const auto = (entries: Record<string, Point>): Map<string, Point> => new Map(Object.entries(entries));

describe("a saved position is kept exactly", () => {
  it("places a saved node where the file says, not where the engine did", () => {
    const placed = mergeLayout(
      auto({ "service:acme.shop.OrderService": { x: 999, y: 999 } }),
      SAVED,
    );
    const it0 = placed.find((p) => p.id === "service:acme.shop.OrderService")!;
    expect(it0.at).toEqual({ x: 80, y: 40 });
    expect(it0.fixed).toBe(true);
  });

  it("ignores a saved entry for something no longer drawn", () => {
    // A deleted service leaves a stale entry, and the file is optional and deletable: tolerance rather
    // than repair.
    const placed = mergeLayout(auto({ "pipe:acme.shop.events": { x: 1, y: 1 } }), SAVED);
    expect(placed.map((p) => p.id)).toEqual(["pipe:acme.shop.events"]);
  });
});

describe("adding a node does not move a saved one", () => {
  it("holds for every saved node, which is the rule the design turns on", () => {
    const before = mergeLayout(
      auto({
        "service:acme.shop.OrderService": { x: 10, y: 10 },
        "pipe:acme.shop.events": { x: 10, y: 120 },
      }),
      SAVED,
    );

    // The engine re-runs and reports entirely different positions, as it would once a node is added.
    const after = mergeLayout(
      auto({
        "service:acme.shop.OrderService": { x: 500, y: 500 },
        "pipe:acme.shop.events": { x: 500, y: 620 },
        "service:acme.shop.NewOne": { x: 620, y: 700 },
      }),
      SAVED,
    );

    for (const saved of Object.keys(SAVED)) {
      expect(after.find((p) => p.id === saved)!.at).toEqual(
        before.find((p) => p.id === saved)!.at,
      );
    }
    expect(after.find((p) => p.id === "service:acme.shop.NewOne")).toBeDefined();
  });

  it("nudges the new node rather than the saved one when they collide", () => {
    // The obvious implementation — lay out, then move the saved nodes — leaves the new one on top of a
    // saved one, and "leave the rest alone" quietly stops being true.
    const placed = mergeLayout(
      auto({
        "service:acme.shop.OrderService": { x: 0, y: 0 },
        "service:acme.shop.NewOne": { x: 80, y: 40 },
      }),
      SAVED,
    );
    const saved = placed.find((p) => p.id === "service:acme.shop.OrderService")!;
    const added = placed.find((p) => p.id === "service:acme.shop.NewOne")!;
    expect(saved.at).toEqual({ x: 80, y: 40 });
    expect(added.at).not.toEqual(saved.at);
    expect(Math.abs(added.at.y - saved.at.y)).toBeGreaterThanOrEqual(56);
  });

  it("nudges the same way every time", () => {
    const once = mergeLayout(auto({ a: { x: 80, y: 40 }, b: { x: 80, y: 40 } }), SAVED);
    const twice = mergeLayout(auto({ b: { x: 80, y: 40 }, a: { x: 80, y: 40 } }), SAVED);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it("gives up nudging rather than looping in a crowded corner", () => {
    const crowded: Record<string, Point> = {};
    for (let i = 0; i < 40; i++) crowded[`n${i}`] = { x: 0, y: 0 };
    const placed = mergeLayout(auto(crowded), { s: { x: 0, y: 0 } });
    expect(placed).toHaveLength(40);
  });
});

describe("reading", () => {
  it("reads the format the specification shows", () => {
    const { layout, problems } = parseLayout(
      JSON.stringify({
        "*": {
          collapsed: ["package:acme.retail.ticketing"],
          nodes: { "service:acme.retail.sales.OrderService": { x: 120, y: 40 } },
          edges: {
            "service:acme.retail.sales.OrderService -> pipe:acme.retail.sales.events": {
              waypoints: [{ x: 150, y: 120 }],
            },
          },
        },
      }),
    );
    expect(problems).toEqual([]);
    const view = layout["*"]!;
    expect(view.collapsed).toEqual(["package:acme.retail.ticketing"]);
    expect(view.nodes["service:acme.retail.sales.OrderService"]).toEqual({ x: 120, y: 40 });
    expect(view.edges["service:acme.retail.sales.OrderService -> pipe:acme.retail.sales.events"]
      ?.waypoints).toEqual([{ x: 150, y: 120 }]);
  });

  it("rounds a coordinate, because this file is reviewed", () => {
    const { layout } = parseLayout(JSON.stringify({ "*": { nodes: { a: { x: 12.7, y: -3.2 } } } }));
    expect(layout["*"]!.nodes["a"]).toEqual({ x: 13, y: -3 });
  });

  it("reports a bad point and keeps the rest of the view", () => {
    const { layout, problems } = parseLayout(
      JSON.stringify({ "*": { nodes: { a: { x: 1, y: 2 }, b: "nope", c: { x: 3 } } } }),
    );
    expect(Object.keys(layout["*"]!.nodes)).toEqual(["a"]);
    expect(problems).toHaveLength(2);
  });

  it("survives a file that is not a layout at all", () => {
    expect(parseLayout("{").layout).toEqual({});
    expect(parseLayout("[]").problems[0]).toContain("not a JSON object");
    expect(parseLayout(JSON.stringify({ "*": 7 })).problems[0]).toContain("not a view layout");
  });

  it("treats an underscored key as a note", () => {
    const { layout } = parseLayout(JSON.stringify({ _comment: "a note", "*": { nodes: {} } }));
    expect(Object.keys(layout)).toEqual(["*"]);
  });

  it("falls back from a lens to the whole model, and then to nothing", () => {
    const { layout } = parseLayout(JSON.stringify({ "*": { nodes: SAVED } }));
    expect(viewOf(layout, "WebFlow").nodes).toEqual(SAVED);
    expect(viewOf({}, "WebFlow")).toBe(EMPTY_VIEW);
  });
});

describe("writing", () => {
  it("keeps what it did not change", () => {
    const { layout } = parseLayout(
      JSON.stringify({ "*": { collapsed: ["package:acme"], nodes: SAVED, edges: {} } }),
    );
    const next = withPositions(layout, WHOLE_MODEL, { "service:acme.shop.OrderService": { x: 7, y: 9 } });
    expect(next["*"]!.nodes["service:acme.shop.OrderService"]).toEqual({ x: 7, y: 9 });
    expect(next["*"]!.nodes["pipe:acme.shop.events"]).toEqual({ x: 80, y: 200 });
    expect(next["*"]!.collapsed).toEqual(["package:acme"]);
  });

  it("keeps a stale entry rather than pruning it", () => {
    // Shared with a half-renamed model and another branch's file: silently dropping the position of
    // something temporarily unresolved would lose work for a reason the author cannot see.
    const { layout } = parseLayout(JSON.stringify({ "*": { nodes: { "service:acme.Gone": { x: 1, y: 1 } } } }));
    const next = withPositions(layout, WHOLE_MODEL, { "service:acme.Here": { x: 2, y: 2 } });
    expect(Object.keys(next["*"]!.nodes).sort()).toEqual(["service:acme.Gone", "service:acme.Here"]);
  });

  it("rounds on the way out", () => {
    const next = withPositions({}, WHOLE_MODEL, { a: { x: 1.6, y: 2.4 } });
    expect(next["*"]!.nodes["a"]).toEqual({ x: 2, y: 2 });
  });

  it("sorts its keys, so two people dragging produce a diff of what they changed", () => {
    const text = writeLayout({
      WebFlow: { collapsed: [], nodes: { b: { x: 1, y: 1 }, a: { x: 2, y: 2 } }, edges: {} },
      "*": { collapsed: [], nodes: { z: { x: 3, y: 3 } }, edges: {} },
    });
    expect(text.indexOf('"*"')).toBeLessThan(text.indexOf('"WebFlow"'));
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
  });

  it("round-trips", () => {
    const layout = withPositions({}, WHOLE_MODEL, SAVED);
    const { layout: back, problems } = parseLayout(writeLayout(layout));
    expect(problems).toEqual([]);
    expect(back["*"]!.nodes).toEqual(SAVED);
  });

  it("writes no empty collapsed or edges, so an untouched file stays small", () => {
    const text = writeLayout({ "*": { collapsed: [], nodes: { a: { x: 1, y: 1 } }, edges: {} } });
    expect(text).not.toContain("collapsed");
    expect(text).not.toContain("edges");
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("whether a graph has anything saved", () => {
  it("answers for the nodes actually drawn", () => {
    const ws = buildWorkspace([
      {
        path: "shop.7k",
        source: `package acme.shop

message M v1.0 @event { id: uuid @role(businessKey) }

pipe events : topic { retention 7d }

service OrderService {
  emits M to events
}
`,
      },
    ]);
    const graph = buildGraph(ws.model);
    expect(hasSaved({ ...EMPTY_VIEW, nodes: SAVED }, graph)).toBe(true);
    expect(hasSaved(EMPTY_VIEW, graph)).toBe(false);
    expect(hasSaved({ ...EMPTY_VIEW, nodes: { "service:other.Thing": { x: 0, y: 0 } } }, graph)).toBe(
      false,
    );
  });
});
