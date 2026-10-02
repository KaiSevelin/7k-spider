/**
 * The 7K examples, through their own lenses.
 *
 * The unit tests use small models where I chose the shape. This one uses the real examples and the real
 * `.7k/views.json`, which is where a lens meets a model nobody designed for it — and where the invariant
 * that matters is easy to state and easy to break: **every edge must land on a node that is drawn.**
 *
 * Skipped rather than failed when the 7K repository is not beside this one, since the dependency is a
 * sibling checkout and not something npm installs.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspace, type LinkedModel } from "@sevenk/core";
import { buildGraph, type Graph } from "../src/graph.js";
import { EVERYTHING, parseViews, resolveLens, type Lens } from "../src/lens.js";

const EXAMPLES = resolvePath(import.meta.dirname, "..", "..", "7K", "examples");
const present = existsSync(EXAMPLES);

const model = (): LinkedModel => {
  const files = readdirSync(EXAMPLES, { withFileTypes: true })
    // A file, because the sidecar directory is also called `.7k`.
    .filter((e) => e.isFile() && e.name.endsWith(".7k"))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ path: join(EXAMPLES, name), source: readFileSync(join(EXAMPLES, name), "utf-8") }));

  const ws = buildWorkspace(files);
  expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return ws.model;
};

const lenses = (): Record<string, Lens> => {
  const { views, problems } = parseViews(
    readFileSync(join(EXAMPLES, ".7k", "views.json"), "utf-8"),
  );
  // The checked-in sidecar is a published example of the format. If it does not parse cleanly, either
  // it or the reader is wrong, and either way somebody should hear about it.
  expect(problems).toEqual([]);
  return views;
};

describe.skipIf(!present)("the 7K examples", () => {
  it("has a views.json whose every lens resolves", () => {
    expect(Object.keys(lenses()).sort()).toEqual([
      "Perimeter",
      "PiiFlow",
      "TicketingOps",
      "WebFlow",
    ]);
  });

  it("never leaves an edge pointing at a node it did not draw", () => {
    // The whole invariant. A lens that dropped a node and kept its edge would render a graph that is
    // wrong rather than partial, and that is the one thing a lens must not do.
    const whole = buildGraph(model(), { deadLetters: true });
    for (const [name, lens] of [["everything", EVERYTHING] as const, ...Object.entries(lenses())]) {
      const g: Graph = resolveLens(whole, lens);
      const drawn = new Set(g.nodes.map((n) => n.id));
      for (const edge of g.edges) {
        expect(drawn.has(edge.from), `${name}: ${edge.id}`).toBe(true);
        expect(drawn.has(edge.to), `${name}: ${edge.id}`).toBe(true);
      }
      expect(new Set(g.edges.map((e) => e.id)).size, `${name}: duplicate edge id`).toBe(
        g.edges.length,
      );
      expect(new Set(g.nodes.map((n) => n.id)).size, `${name}: duplicate node id`).toBe(
        g.nodes.length,
      );
    }
  });

  it("puts a port wherever a lens cuts an edge, and nowhere else", () => {
    const whole = buildGraph(model());
    for (const [name, lens] of Object.entries(lenses())) {
      const g = resolveLens(whole, lens);
      const drawn = new Set(g.nodes.filter((n) => n.kind !== "port").map((n) => n.id));

      // Every edge of the whole graph with exactly one end drawn is represented by a port edge.
      const cut = whole.edges.filter((e) => drawn.has(e.from) !== drawn.has(e.to));
      const ports = g.nodes.filter((n) => n.kind === "port");
      expect(ports.length > 0, `${name}: ${cut.length} cut edges`).toBe(cut.length > 0);

      // And a port never stands for nothing.
      for (const port of ports) expect(port.hidden?.length ?? 0, `${name}: ${port.id}`).toBeGreaterThan(0);
    }
  });

  it("keeps WebFlow's excluded producer behind a port, as 6.1 describes", () => {
    // The specification's own worked case: `WebFlow` excludes `KioskBridge`, which emits to pipes that
    // are in the view. Dropping those edges would show a pipe with traffic from nowhere.
    const g = resolveLens(buildGraph(model()), lenses()["WebFlow"]!);
    const hidden = g.nodes.filter((n) => n.kind === "port").flatMap((n) => [...(n.hidden ?? [])]);
    expect(hidden).toContain("acme.retail.sales.KioskBridge");
    expect(g.nodes.map((n) => n.id)).not.toContain("service:acme.retail.sales.KioskBridge");
  });

  it("resolves PiiFlow to the pipes a label actually reaches", () => {
    // Which only works because labels propagate: `@pii` is declared on fields, and the lens has to
    // reach the pipe carrying the message carrying the record carrying the field.
    const g = resolveLens(buildGraph(model()), lenses()["PiiFlow"]!);
    const pipes = g.nodes.filter((n) => n.kind === "pipe");
    expect(pipes.length).toBeGreaterThan(0);
    for (const pipe of pipes) expect(pipe.labels, pipe.id).toContain("pii");
  });

  it("resolves Perimeter to the outside world, with everything internal aggregated away", () => {
    // `label:external` selects only `@external` services — which works at all only because labels and
    // annotations share one namespace (D95) — and closure brings in the pipes they touch. Every
    // internal service then sits behind a port, which is exactly what a perimeter view is.
    const g = resolveLens(buildGraph(model()), lenses()["Perimeter"]!);
    expect(g.nodes.filter((n) => n.kind === "external").length).toBeGreaterThan(0);
    expect(g.nodes.filter((n) => n.kind === "service")).toEqual([]);
    expect(g.nodes.filter((n) => n.kind === "port").length).toBeGreaterThan(0);
  });
});
