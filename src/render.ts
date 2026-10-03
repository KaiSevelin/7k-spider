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
import { mergeLayout, type Point } from "./layout.js";
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
  /**
   * Called on a double tap: the drill-in gesture, which is what people already try on a graph.
   *
   * Separate from `onSelect` rather than inferred from two clicks, so a host that wants selection
   * without focus — a webview panel, say — simply does not pass it.
   */
  readonly onFocus?: (id: SelectionId) => void;
  /**
   * Called when a node is dropped, with where it landed.
   *
   * Passing it is what makes the graph draggable at all: a host that cannot persist a position should not
   * let one be moved, because a drag that silently reverts is worse than one that never happened.
   */
  readonly onMoved?: (positions: Readonly<Record<SelectionId, Point>>) => void;
  /** Positions from `layout.json`. A node that has one is placed there and does not move. */
  readonly saved?: Readonly<Record<SelectionId, Point>>;
}

/** What a message looks like going past. */
export interface Send {
  /** The edge to animate along. */
  readonly edge: SelectionId;
  /** Wall milliseconds for the trip. */
  readonly durationMs: number;
  /** True for a failure, a rejection, a dead letter — the events worth watching for. */
  readonly bad?: boolean;
}

export interface Rendered {
  readonly cy: Core;
  /** Emphasises what a selection resolved to, and dims everything else. */
  highlight(h: Highlight | undefined): void;
  /** Replaces the graph in place, keeping the viewport. */
  update(graph: Graph): void;
  /** Animates one message along one edge. Does nothing if that edge is not drawn. */
  send(send: Send): void;
  /** Removes anything still in flight, for a seek or a redraw. */
  clearSends(): void;
  /** Replaces the saved positions, re-placing what they name. */
  setSaved(saved: Readonly<Record<SelectionId, Point>>): void;
  /** Every node's position now, which is what a `layout.json` write is made of. */
  positions(): Readonly<Record<SelectionId, Point>>;
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
      // Carried so a message selection can find its edges: a message is a label, not a node, so there
      // is no element with its id to look up.
      messageIds: e.messageIds,
      direction: e.direction,
      bestEffort: e.bestEffort === true ? "yes" : "no",
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
    selector: "node.external",
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
    // A port stands for what is out of view. Small, open-sided and unlabelled by name, so it reads as
    // an edge going somewhere rather than as a thing in its own right.
    selector: "node.port",
    style: {
      "background-color": "var(--bg)",
      "border-color": "var(--line)",
      "border-style": "dashed",
      "border-width": 1,
      shape: "round-tag",
      color: "var(--ink-dim)",
      "font-size": 10,
      padding: "4px",
    },
  },
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
  {
    // A publication that may never happen. Dotted rather than dashed, because the pipe uses dashed for
    // its own lossiness and the two are different: one loses a message that was sent, the other never
    // sends it.
    selector: 'edge[bestEffort = "yes"]',
    style: { "line-style": "dotted", width: 1 },
  },
  // ---- a message going past -------------------------------------------------
  //
  // The edge itself pulses, so the path is legible even when the dot is between two nodes, and a dot
  // travels along it, so the direction is. Together they read as traffic; either alone reads as a
  // flicker.
  {
    selector: "edge.sending",
    style: {
      "line-color": "var(--accent)",
      "target-arrow-color": "var(--accent)",
      width: 3,
      "line-style": "dashed",
      "line-dash-pattern": [6, 4],
      "z-index": 20,
    },
  },
  {
    // A failure has to read differently from a success, or the interesting events are the ones you
    // cannot see. These are the events worth watching a trace for.
    selector: "edge.sending-bad",
    style: { "line-color": "var(--warn)", "target-arrow-color": "var(--warn)" },
  },
  {
    selector: "node.marker",
    style: {
      shape: "ellipse",
      width: 11,
      height: 11,
      label: "",
      "background-color": "var(--accent)",
      "border-width": 0,
      "z-index": 30,
      events: "no",
    },
  },
  { selector: "node.marker.bad", style: { "background-color": "var(--warn)" } },

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
    // Draggable only when the host can persist where it lands: a drag that silently reverts on the next
    // keystroke is worse than one that was never offered.
    autoungrabify: options.onMoved === undefined,
    wheelSensitivity: 0.2,
  });

  let saved: Readonly<Record<SelectionId, Point>> = options.saved ?? {};

  /**
   * Lays the graph out, then places whatever the file saved.
   *
   * The merge is `layout.json`'s rule, not a preference: a saved node goes exactly where it was saved and
   * an unsaved one takes its auto position, nudged only to clear a saved one. So adding a service cannot
   * move a saved one (`20-ir.md` 6.2).
   */
  const relayout = (): void => {
    const layout = cy.layout(LAYOUT as unknown as cytoscape.LayoutOptions);
    layout.on("layoutstop", () => place());
    layout.run();
  };

  const place = (): void => {
    if (Object.keys(saved).length === 0) return;
    const auto = new Map<SelectionId, Point>();
    cy.nodes().forEach((n) => {
      if (n.hasClass("marker") || n.isParent()) return;
      auto.set(n.id(), n.position());
    });

    cy.batch(() => {
      for (const { id, at } of mergeLayout(auto, saved)) {
        const node = cy.getElementById(id);
        if (node.nonempty()) node.position(at);
      }
    });
  };

  relayout();

  if (options.onMoved !== undefined) {
    const onMoved = options.onMoved;
    // `dragfree` rather than `drag`: one write when the node is dropped, not one per frame.
    cy.on("dragfree", "node", (e) => {
      const node = e.target as NodeSingular;
      const at = node.position();
      onMoved({ [node.id() as SelectionId]: { x: Math.round(at.x), y: Math.round(at.y) } });
    });
  }

  if (options.onSelect !== undefined) {
    const onSelect = options.onSelect;
    cy.on("tap", "node, edge", (e) => onSelect(e.target.id() as SelectionId));
    cy.on("tap", (e) => {
      if (e.target === cy) onSelect(undefined);
    });
  }

  if (options.onFocus !== undefined) {
    const onFocus = options.onFocus;
    cy.on("dbltap", "node", (e) => onFocus(e.target.id() as SelectionId));
  }

  // Markers are transient nodes. They are excluded from the highlight and removed before any update, so
  // nothing that is merely in flight can be selected, dimmed, or left behind by a redraw.
  let markerSeq = 0;
  const inFlight = new Set<string>();

  const clearSends = (): void => {
    cy.batch(() => {
      for (const id of inFlight) cy.getElementById(id).remove();
      inFlight.clear();
      cy.edges().removeClass("sending sending-bad");
    });
  };

  const send = ({ edge: edgeId, durationMs, bad }: Send): void => {
    const edge = cy.getElementById(edgeId);
    if (edge.empty() || !edge.isEdge()) return;

    const source = edge.source();
    const target = edge.target();
    if (source.empty() || target.empty()) return;

    edge.addClass(bad === true ? "sending sending-bad" : "sending");

    const id = `marker:${markerSeq++}`;
    const from = source.position();
    const to = target.position();
    // The point the curve actually passes through at its midpoint. Interpolating straight from source to
    // target would send the dot off a bezier and read as broken; the control point is off-curve, so it is
    // the wrong waypoint. `midpoint()` is on it.
    let via: { x: number; y: number };
    try {
      via = edge.midpoint();
      if (!Number.isFinite(via.x) || !Number.isFinite(via.y)) throw new Error("no midpoint");
    } catch {
      via = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    }

    cy.add({ group: "nodes", data: { id }, position: { ...from }, classes: bad === true ? "marker bad" : "marker" });
    inFlight.add(id);

    const marker = cy.getElementById(id);
    const half = Math.max(30, durationMs / 2);
    const finish = (): void => {
      marker.remove();
      inFlight.delete(id);
      edge.removeClass("sending sending-bad");
    };

    // Two linear segments through the midpoint, which tracks a simple bezier closely enough that the dot
    // stays on the line. Linear rather than eased, because a message in flight is not accelerating.
    marker.animate(
      { position: via },
      {
        duration: half,
        easing: "linear",
        complete: () => {
          if (!inFlight.has(id)) return;
          marker.animate({ position: { ...to } }, { duration: half, easing: "linear", complete: finish });
        },
      },
    );
  };

  const highlight = (h: Highlight | undefined): void => {
    cy.batch(() => {
      cy.elements().removeClass("dimmed emphasised");
      if (h === undefined || h.declarations.size === 0) return;

      const wanted = cy.collection();
      for (const id of h.declarations) {
        const el = cy.getElementById(id);
        if (el.nonempty()) wanted.merge(el);
      }

      // A message is an edge label rather than a node, so selecting one emphasises the edges carrying
      // it. The selection model always said a message type was selectable; until search, nothing ever
      // selected one, and this silently did nothing.
      const carrying = cy
        .edges()
        .filter((e) => {
          const ids = e.data("messageIds") as readonly string[] | undefined;
          return ids !== undefined && ids.some((id) => h.declarations.has(id));
        });
      wanted.merge(carrying);

      if (wanted.empty()) return;

      // A node's edges and its package come along, because a service lit up inside a dimmed box
      // reads as an error rather than as a selection.
      const context = wanted
        .union(wanted.connectedEdges())
        .union(wanted.ancestors())
        .union(wanted.connectedEdges().connectedNodes());

      cy.elements().difference(context).not(".marker").addClass("dimmed");
      wanted.addClass("emphasised");
    });
  };

  return {
    cy,
    highlight,
    send,
    clearSends,
    update(next) {
      // Nothing in flight survives a redraw: a marker left behind would be a message that never arrived.
      clearSends();
      // Kept in place rather than rebuilt, so the viewport survives a keystroke. The layout re-runs,
      // which is deterministic, so an unchanged part of the model lands where it was.
      const pan = cy.pan();
      const zoom = cy.zoom();
      cy.batch(() => {
        cy.elements().remove();
        cy.add(elementsOf(next));
      });
      const layout = cy.layout({ ...LAYOUT, fit: false } as unknown as cytoscape.LayoutOptions);
      layout.on("layoutstop", () => place());
      layout.run();
      cy.pan(pan);
      cy.zoom(zoom);
    },
    setSaved(next) {
      saved = next;
      place();
    },
    positions() {
      const out: Record<SelectionId, Point> = {};
      cy.nodes().forEach((n) => {
        if (n.hasClass("marker") || n.isParent()) return;
        const at = n.position();
        out[n.id()] = { x: Math.round(at.x), y: Math.round(at.y) };
      });
      return out;
    },
    destroy: () => cy.destroy(),
  };
}

/** The node a renderer would draw for an id, for a test or a sidebar. */
export const nodeFor = (graph: Graph, id: SelectionId): GraphNode | undefined =>
  graph.nodes.find((n) => n.id === id);

export type { NodeSingular };
