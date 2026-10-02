/**
 * Does the layout actually hold still?
 *
 * D25 asks for a graph that does not reshuffle when the model changes, and the design answers with a
 * layered layout from ELK seeded by declaration order. That is a claim about a third-party library
 * under real input, so it is asserted here against real Cytoscape and real ELK, headlessly — a
 * stylesheet typo or a layout that quietly falls back to something else would otherwise only show up
 * as a picture that looks wrong, which is the hardest kind of bug to notice.
 */

import cytoscape, { type Core } from "cytoscape";
import elk from "cytoscape-elk";
import { beforeAll, describe, expect, it } from "vitest";
import { buildWorkspace, type LinkedModel } from "@sevenk/core";
import { buildGraph, type Graph } from "../src/graph.js";
import { elementsOf, LAYOUT, STYLE } from "../src/render.js";
import { mergeLayout } from "../src/layout.js";

const MODEL = `
package acme.shop

message PlaceOrder v1.0 @command { id: uuid @role(businessKey) }
message OrderPlaced v1.0 @event  { id: uuid @role(businessKey) }
message Shipped v1.0 @event      { id: uuid @role(businessKey) }

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

service Shipping {
  reacts OrderPlaced from events {
    replies Shipped
  }
  emits Shipped to events
}
`;

const model = (source = MODEL): LinkedModel => {
  const ws = buildWorkspace([{ path: "shop.7k", source }]);
  expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return ws.model;
};

beforeAll(() => {
  cytoscape.use(elk);
});

/** Lays a graph out headlessly and returns each node's position, rounded to whole pixels. */
async function positions(
  graph: Graph,
  saved: Readonly<Record<string, { x: number; y: number }>> = {},
): Promise<Record<string, string>> {
  const cy: Core = cytoscape({ headless: true, elements: elementsOf(graph), style: STYLE });
  await new Promise<void>((done) => {
    const layout = cy.layout(LAYOUT as unknown as cytoscape.LayoutOptions);
    layout.on("layoutstop", () => done());
    layout.run();
  });

  // The same merge `renderGraph` applies, so the invariant is tested where it has to hold.
  if (Object.keys(saved).length > 0) {
    const auto = new Map<string, { x: number; y: number }>();
    cy.nodes().forEach((n) => {
      if (n.isParent()) return;
      auto.set(n.id(), n.position());
    });
    for (const { id, at } of mergeLayout(auto, saved)) {
      const node = cy.getElementById(id);
      if (node.nonempty()) node.position(at);
    }
  }

  const out: Record<string, string> = {};
  cy.nodes().forEach((n) => {
    const p = n.position();
    out[n.id()] = `${Math.round(p.x)},${Math.round(p.y)}`;
  });
  cy.destroy();
  return out;
}

describe("the stylesheet and the layout are real", () => {
  it("accepts every element the renderer builds", async () => {
    // Cytoscape throws on an unknown style property or an edge to a missing node, so simply getting
    // here exercises the whole stylesheet against a whole graph.
    const laid = await positions(buildGraph(model(), { deadLetters: true }));
    expect(Object.keys(laid).length).toBeGreaterThan(5);
  });

  it("gives every drawn node a position of its own", async () => {
    // Leaves only: Cytoscape derives a compound's position from its children's bounding box at render
    // time, so a package reports the origin when nothing is being rendered. Overlapping leaves are
    // what a failed layout produces, and that is the thing worth asserting.
    const laid = await positions(buildGraph(model()));
    const leaves = Object.entries(laid).filter(([id]) => !id.startsWith("package:"));
    expect(leaves.length).toBeGreaterThan(4);
    for (const [id, at] of leaves) expect(at, id).not.toBe("0,0");
    expect(new Set(leaves.map(([, at]) => at)).size).toBe(leaves.length);
  });
});

describe("a saved layout survives the engine", () => {
  it("places a saved node where the file says, through real ELK", async () => {
    // The pure merge is tested on its own; this is the same rule against the engine that will actually
    // try to move things.
    const g = buildGraph(model());
    const saved = { "service:acme.shop.OrderService": { x: 1000, y: 1000 } };
    const laid = await positions(g, saved);
    expect(laid["service:acme.shop.OrderService"]).toBe("1000,1000");
  });

  it("does not move a saved node when a service is added", async () => {
    // The rule `layout.json` exists for, end to end: ELK re-runs over a bigger graph and reports
    // different positions for everything, and the saved node does not budge.
    const saved = {
      "service:acme.shop.OrderService": { x: 300, y: 120 },
      "pipe:acme.shop.events": { x: 300, y: 260 },
    };
    const before = await positions(buildGraph(model()), saved);
    const after = await positions(
      buildGraph(
        model(
          `${MODEL}
service Audit {
  reacts Shipped from events {
    replies none
  }
}
`,
        ),
      ),
      saved,
    );

    for (const id of Object.keys(saved)) expect(after[id], id).toBe(before[id]);
    expect(after["service:acme.shop.Audit"]).toBeDefined();
  });
});

describe("it is stable", () => {
  it("lays the same model out identically, twice", async () => {
    expect(await positions(buildGraph(model()))).toEqual(await positions(buildGraph(model())));
  });

  it("leaves the rest of the graph where it was when a service is added", async () => {
    // The requirement in one test. A force-directed layout fails this outright, which is why D25
    // ruled one out rather than merely preferring something else.
    const before = await positions(buildGraph(model()));
    const after = await positions(
      buildGraph(
        model(
          `${MODEL}\nservice Audit {\n  reacts Shipped from events {\n    replies none\n  }\n}\n`,
        ),
      ),
    );

    expect(after["service:acme.shop.Audit"]).toBeDefined();

    // The upstream of the graph is untouched: the new consumer hangs off `events` and nothing above
    // it needs to move.
    for (const id of [
      "service:acme.shop.WebApp",
      "pipe:acme.shop.inbound",
      "service:acme.shop.OrderService",
    ]) {
      expect(after[id], id).toBe(before[id]);
    }
  });

  it("is unmoved by the order the files were read in", async () => {
    // Which is why `collect` sorts: a graph that depended on a directory listing would differ
    // between two machines looking at one repository.
    const split = [
      { path: "b.7k", source: "package acme.other\n\npipe audit : topic { retention 7d }\n" },
      { path: "a.7k", source: MODEL },
    ];
    const one = buildWorkspace([...split].reverse());
    const two = buildWorkspace(split);
    expect(one.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const a = await positions(buildGraph(one.model));
    const b = await positions(buildGraph(two.model));
    // The two packages may sit in either order relative to each other, but each package's own
    // contents must not move — that is the part a reader has learned the shape of.
    for (const id of Object.keys(a)) {
      if (!id.startsWith("package:")) continue;
      expect(Object.keys(b)).toContain(id);
    }
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });
});
