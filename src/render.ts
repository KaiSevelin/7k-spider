/**
 * Drawing the graph, with Cytoscape and a layout from ELK.
 *
 * Knows nothing about its host. It takes a container element and a `Graph` and hands back a handle,
 * so the same code runs in a page served by `spider serve` and in a VS Code webview later (D92).
 *
 * **Layout is deterministic and layered.** D25 makes stability matter more than optimality, which
 * rules out force-directed layout outright: a graph that reshuffles whenever the model changes is the
 * named failure, not a side effect. ELK's `layered` algorithm, fed nodes and edges in declaration
 * order, gives the same picture for the same model every time — which is why `buildGraph` is careful
 * about order and why the layout comes from ELK rather than from one of Cytoscape's own.
 *
 * Why Cytoscape at all, given it has no port concept and styles nodes rather than composing them:
 * both costs were accepted knowingly (D92), and neither touches what increment 1 needs, which is
 * boxes, labels and edges that do not move when you are not looking.
 */

import cytoscape, { type Core, type ElementDefinition, type NodeSingular } from "cytoscape";
import elk from "cytoscape-elk";
import type { Graph, GraphNode } from "./graph.js";
import type { Highlight, SelectionId } from "./selection.js";

let registered = false;

/** Cytoscape extensions register globally and throw on a second registration. */
function register(): void {
  if (registered) return;
  cytoscape.use(elk);
  registered = true;
}

export interface RenderOptions {
  /** Called with the id of whatever was clicked, or nothing when the background was. */
  readonly onSelect?: (id: SelectionId | undefined) => void;
}

export interface Rendered {
  readonly cy: Core;
  /** Emphasises what a selection resolved to, and dims everything else. */
  highlight(h: Highlight | undefined): void;
  /** Replaces the graph in place, keeping the viewport. */
  update(graph: Graph): void;
  destroy(): void;
}

/**
 * A pipe's shape says what kind it is.
 *
 * Shape rather than colour, because the distinction is structural — a queue competes, a topic fans
 * out, a stream is a log — and because colour is already carrying boundary and selection. Applied
 * through a class per kind rather than a `data(shape)` mapper, so the stylesheet stays typed.
 */
export const PIPE_SHAPE = {
  queue: "rectangle",
  topic: "hexagon",
  stream: "barrel",
} as const satisfies Record<NonNullable<GraphNode["pipeKind"]>, cytoscape.Css.NodeShape>;

export const elementsOf = (graph: Graph): ElementDefinition[] => [
  ...graph.nodes.map((n) => ({
    data: {
      id: n.id,
      label: n.label,
      qname: n.qname,
      kind: n.kind,
      ...(n.parent === undefined ? {} : { parent: n.parent }),
      boundary: n.boundary === true ? "yes" : "no",
      // A lossy pipe is drawn differently, because nothing may depend on it for progress.
      lossy: n.delivery === "at-most-once" ? "yes" : "no",
      incomplete: n.incomplete === true ? "yes" : "no",
    },
    // A pipe carries its kind as a second class, which is what picks its shape.
    classes: n.kind === "pipe" && n.pipeKind !== undefined ? `pipe kind-${n.pipeKind}` : n.kind,
  })),
  ...graph.edges.map((e) => ({
    data: {
      id: e.id,
      source: e.from,
      target: e.to,
      // One edge carries several messages, so the label is a list. Shown on one line per message,
      // because a run-on label is unreadable at any width.
      label: e.messages.map((m) => m.slice(m.lastIndexOf(".") + 1)).join("\n"),
      messages: e.messages,
      direction: e.direction,
      ...(e.subscription === undefined ? {} : { subscription: e.subscription }),
      incomplete: e.incomplete === true ? "yes" : "no",
    },
    classes: e.direction,
  })),
];

/** The ELK options. Separated so a test can assert the layout is a layered one and not a force. */
// Typed loosely on purpose: Cytoscape's `LayoutOptions` is a union of its built-in layouts, and an
// extension's options are not in it. The shape is asserted by a test instead.
export const LAYOUT: Record<string, unknown> = {
  name: "elk",
  // Nothing animates on a relayout. An animated reshuffle is a reshuffle you watched happen.
  animate: false,
  fit: true,
  padding: 24,
  elk: {
    algorithm: "layered",
    // Messages flow down the page, which is the direction a sequence diagram will read too.
    "elk.direction": "DOWN",
    "elk.layered.spacing.nodeNodeBetweenLayers": 64,
    "elk.spacing.nodeNode": 40,
    "elk.padding": "[top=32,left=24,bottom=24,right=24]",
    // Deterministic rather than cleverer: the same model must give the same picture, and a
    // crossing-minimisation pass that depends on a random seed would not.
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  },
} as const;

export const STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      "font-family": "var(--mono)",
      "font-size": 12,
      color: "var(--ink)",
      "text-valign": "center",
      "text-halign": "center",
      "border-width": 1.5,
      "border-color": "var(--line)",
      "background-color": "var(--surface)",
      width: "label",
      height: "label",
      padding: "10px",
      shape: "round-rectangle",
    },
  },
  {
    selector: "node.service",
    style: { "background-color": "var(--service)", "border-color": "var(--service-line)" },
  },
  {
    // An `@external` service marks where the system ends. Dashed, because 7K describes no behaviour
    // for it, and drawing it solid would claim otherwise.
    selector: "node.port",
    style: {
      "background-color": "var(--port)",
      "border-color": "var(--port-line)",
      "border-style": "dashed",
      shape: "round-tag",
    },
  },
  {
    selector: "node.pipe",
    style: { "background-color": "var(--pipe)", "border-color": "var(--pipe-line)" },
  },
  ...(Object.entries(PIPE_SHAPE) as [string, cytoscape.Css.NodeShape][]).map(([kind, shape]) => ({
    selector: `node.kind-${kind}`,
    style: { shape },
  })),
  {
    selector: "node.dead-letter",
    style: {
      "background-color": "var(--surface)",
      "border-color": "var(--line)",
      "border-style": "dotted",
      color: "var(--ink-dim)",
    },
  },
  {
    selector: "node.package",
    style: {
      label: "data(label)",
      "text-valign": "top",
      "text-halign": "center",
      "text-margin-y": -4,
      "font-size": 11,
      color: "var(--ink-dim)",
      "background-color": "var(--package)",
      "background-opacity": 0.5,
      "border-color": "var(--line)",
      "border-style": "dashed",
      shape: "round-rectangle",
      padding: "18px",
    },
  },
  { selector: 'node[boundary = "yes"]', style: { "border-width": 3, "border-color": "var(--boundary)" } },
  { selector: 'node[lossy = "yes"]', style: { "border-style": "dashed" } },
  { selector: 'node[incomplete = "yes"]', style: { "border-color": "var(--warn)", "border-style": "double" } },
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      width: 1.4,
      "line-color": "var(--line)",
      "target-arrow-color": "var(--line)",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.9,
      label: "data(label)",
      "font-family": "var(--mono)",
      "font-size": 10,
      color: "var(--ink-dim)",
      "text-wrap": "wrap",
      "text-background-color": "var(--bg)",
      "text-background-opacity": 0.85,
      "text-background-padding": "2px",
      "text-rotation": "autorotate",
    },
  },
  { selector: 'edge[incomplete = "yes"]', style: { "line-style": "dashed", "line-color": "var(--warn)" } },
  // Dimming is a class on everything else rather than a style on the selection, so that an empty
  // highlight leaves the graph at full strength instead of dimming all of it.
  { selector: ".dimmed", style: { opacity: 0.22 } },
  {
    selector: ".emphasised",
    style: { "border-color": "var(--accent)", "border-width": 3, "z-index": 10 },
  },
  { selector: "edge.emphasised", style: { "line-color": "var(--accent)", "target-arrow-color": "var(--accent)", width: 2.4 } },
];

export function renderGraph(
  container: HTMLElement,
  graph: Graph,
  options: RenderOptions = {},
): Rendered {
  register();

  const cy = cytoscape({
    container,
    elements: elementsOf(graph),
    style: STYLE,
    // Panning and zooming are fine; dragging a node is mutation, and that is increment 5.
    autoungrabify: true,
    wheelSensitivity: 0.2,
  });

  const relayout = (): void => {
    cy.layout(LAYOUT as unknown as cytoscape.LayoutOptions).run();
  };
  relayout();

  if (options.onSelect !== undefined) {
    const onSelect = options.onSelect;
    cy.on("tap", "node, edge", (e) => onSelect(e.target.id() as SelectionId));
    cy.on("tap", (e) => {
      if (e.target === cy) onSelect(undefined);
    });
  }

  const highlight = (h: Highlight | undefined): void => {
    cy.batch(() => {
      cy.elements().removeClass("dimmed emphasised");
      if (h === undefined || h.declarations.size === 0) return;

      const wanted = cy.collection();
      for (const id of h.declarations) {
        const el = cy.getElementById(id);
        if (el.nonempty()) wanted.merge(el);
      }
      if (wanted.empty()) return;

      // A node's edges and its package come along, because a service lit up inside a dimmed box
      // reads as an error rather than as a selection.
      const context = wanted
        .union(wanted.connectedEdges())
        .union(wanted.ancestors())
        .union(wanted.connectedEdges().connectedNodes());

      cy.elements().difference(context).addClass("dimmed");
      wanted.addClass("emphasised");
    });
  };

  return {
    cy,
    highlight,
    update(next) {
      // Kept in place rather than rebuilt, so the viewport survives a keystroke. The layout re-runs,
      // which is deterministic, so an unchanged part of the model lands where it was.
      const pan = cy.pan();
      const zoom = cy.zoom();
      cy.batch(() => {
        cy.elements().remove();
        cy.add(elementsOf(next));
      });
      cy.layout({ ...LAYOUT, fit: false } as unknown as cytoscape.LayoutOptions).run();
      cy.pan(pan);
      cy.zoom(zoom);
    },
    destroy: () => cy.destroy(),
  };
}

/** The node a renderer would draw for an id, for a test or a sidebar. */
export const nodeFor = (graph: Graph, id: SelectionId): GraphNode | undefined =>
  graph.nodes.find((n) => n.id === id);

export type { NodeSingular };
