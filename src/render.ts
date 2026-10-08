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
import { DEFAULT_LAYOUT, withLayout } from "./layouts.js";
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
  /**
   * Called on a right click, with what it was on and what is currently marked.
   *
   * `id` is the node under the pointer, absent on the background. `marked` is the multi-selection, which
   * is a different thing from Spider's single selection on purpose: the selection drives the sidebar and
   * the sequence, and changing it to mean "several" would have changed every view that reads it. Marking
   * is additive, visible, and means only "these ones, for the next thing I do".
   */
  readonly onContext?: (
    at: {
      readonly id?: SelectionId;
      /**
       * The edge under the pointer, where no node was.
       *
       * A connection is a declaration too — an `emits` or a `reacts` clause — and the only thing on
       * the drawing that stands for one. Without this there was no way to point at one, so the
       * disconnect operations Core has had all along were unreachable, and the refusal `removePipe`
       * used to give told you to use a menu row that did not exist.
       */
      readonly edge?: string;
      readonly marked: readonly SelectionId[];
    },
    /** Where the pointer was, in client coordinates. The host decides what that means on its page. */
    at_page: { readonly x: number; readonly y: number },
  ) => void;
  /**
   * Called when a line is dragged from one node and dropped on another.
   *
   * A second way to say what clicking one node and then the other already says, and the host decides
   * what it means — which end is which is the host's question, because the model is bipartite and the
   * direction follows from the kinds (`connect-ui.ts`).
   *
   * Both ways stay, deliberately. `connect-ui.ts` chose click-then-click because it works on a touch
   * screen and from the keyboard, and a drag does neither; that argument is still true, so this is an
   * addition rather than a replacement.
   */
  readonly onConnect?: (from: SelectionId, to: SelectionId) => void;
  /** Which of `LAYOUTS` to start on. A canvas keeps its own, because they are different pictures. */
  readonly layout?: string;
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
  /** Re-reads the palette and restyles, for when the host's colour scheme changes under us. */
  retheme(): void;
  /** Lays it out again under one of `LAYOUTS`, keeping whatever `layout.json` pinned. */
  relayout(id: string): void;
  /**
   * Whether a plain drag draws a connection rather than moving a node.
   *
   * Holding shift always does, with no mode to be in; this is what the `n` key arms, so the discoverable
   * route and the quick one are the same gesture.
   */
  /**
   * Arms or disarms connecting, and shows where a click can land.
   *
   * `from` is the end already chosen, when there is one: before it, both a service and a pipe are
   * legal; after it, only the other kind is, because the graph is bipartite (section 3.1). Working
   * that out here keeps it in one place — the same `roleOf` the click handler uses decides it.
   */
  setConnecting(on: boolean, from?: SelectionId, canReach?: (id: SelectionId) => boolean): void;
  /** The multi-selection, in the order it was built. */
  marked(): readonly SelectionId[];
  /** Replaces it. Anything the graph does not draw is dropped, so a stale id cannot linger. */
  setMarked(ids: readonly SelectionId[]): void;
  destroy(): void;
}

/**
 * Resolves the `var(--x)` in the stylesheet to the literal values Cytoscape can actually parse.
 *
 * Cytoscape has its own style language and no part of CSS behind it, so `var(--service)` reaches its
 * colour parser as that string, fails to parse, and is dropped with a warning — leaving the element on
 * Cytoscape's *own* defaults, which are a grey box with a black border and a black label on a black
 * label background. The page then looks nothing like the palette beside it, and nothing says so except
 * the console.
 *
 * Resolving against an element rather than against a hard-coded table is what keeps this host-agnostic
 * (D92): the variables are inherited, so a VS Code webview that defines the same names gets the same
 * drawing with no second palette to keep in step.
 *
 * A name the host does not define is left out rather than resolved to an empty string, so Cytoscape
 * falls back to its default for that one property instead of rejecting the rule.
 */
export function resolveStyle(
  style: cytoscape.StylesheetJson,
  look: (name: string) => string | undefined,
): cytoscape.StylesheetJson {
  const resolved: cytoscape.StylesheetJson = [];
  for (const rule of style) {
    // A stylesheet block may carry its properties under `css` instead; ours do not, and one that does
    // is passed through rather than guessed at.
    if (!("style" in rule)) {
      resolved.push(rule);
      continue;
    }
    const out: Record<string, unknown> = {};
    for (const [prop, value] of Object.entries(rule.style as Record<string, unknown>)) {
      if (typeof value !== "string" || !value.includes("var(")) {
        out[prop] = value;
        continue;
      }
      let missing = false;
      const text = value.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_whole, name: string) => {
        const found = look(name);
        if (found === undefined || found === "") missing = true;
        return found ?? "";
      });
      if (!missing) out[prop] = text;
    }
    resolved.push({ ...rule, style: out } as cytoscape.StylesheetJson[number]);
  }
  return resolved;
}

/** The palette as the page sees it, read off whatever element the graph is drawn into. */
/**
 * The edge under a point, or nothing.
 *
 * Cytoscape draws to a canvas and exposes no hit test for one, and an edge's bounding box is a
 * diagonal rectangle that answers "yes" across most of the drawing — so this measures distance to the
 * line itself. Three rendered points approximate it: the two endpoints and the midpoint, which is
 * where a bezier's bulge is, so a curved edge is matched along its curve rather than along the chord.
 *
 * The threshold is in rendered pixels, so it is the same reach at every zoom — which is what a person
 * means by "near enough to click", rather than a distance in model space that gets harder to hit the
 * further you zoom out.
 */
const NEAR = 10;

function edgeNear(cy: Core, x: number, y: number): string | undefined {
  const toSegment = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    // A degenerate segment is a point, which is still a thing to be near.
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  let best: { id: string; distance: number } | undefined;
  for (const edge of cy.edges()) {
    const from = edge.renderedSourceEndpoint();
    const to = edge.renderedTargetEndpoint();
    const mid = edge.renderedMidpoint();
    const distance = Math.min(
      toSegment(x, y, from.x, from.y, mid.x, mid.y),
      toSegment(x, y, mid.x, mid.y, to.x, to.y),
    );
    if (distance > NEAR) continue;
    if (best === undefined || distance < best.distance) best = { id: edge.id(), distance };
  }
  return best?.id;
}

const paletteOf =
  (el: Element) =>
  (name: string): string | undefined => {
    const value = getComputedStyle(el).getPropertyValue(name).trim();
    return value === "" ? undefined : value;
  };

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
      // `@adapter`: a service whose job is to stop a foreign vocabulary. Data rather than a node kind,
      // because an adapter *is* a service everywhere else — it connects, it routes, it generates — and
      // a kind of its own would have to be taught to every place that asks whether something is one.
      adapter: n.annotations.includes("adapter") ? "yes" : "no",
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
    /**
     * An `@adapter`: a service that exists to keep somebody else's vocabulary out.
     *
     * Drawn in the boundary colour the package bands use, because that is what it is — the edge of a
     * domain, standing where the `@external` service it translates for is on the other side. A double
     * border rather than a different shape: it is still a service, and a shape of its own would say
     * the graph has a fourth kind of thing in it.
     *
     * After `node.service` so it wins, and keyed on data because the class is still `service`.
     */
    selector: 'node[adapter = "yes"]',
    style: {
      "border-color": "var(--boundary)",
      "border-width": 3,
      "border-style": "double",
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
      // No label by default. The messages are the bulk of the ink on any real model — a dozen edges
      // around one pipe, each carrying several — and they are also wanted one edge at a time rather
      // than all at once. So hovering shows them, and the canvas draws them only where a selection has
      // already said which edge is the interesting one.
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
      // Small: it marks a message, and a dot that reads as a node is a dot that competes with them.
      width: 8,
      height: 8,
      label: "",
      "background-color": "var(--accent)",
      "border-width": 0,
      "z-index": 30,
      events: "no",
    },
  },
  { selector: "node.marker.bad", style: { "background-color": "var(--warn)" } },

  {
    // Marking is shown as a dashed accent outline: present enough to count them at a glance, and
    // distinct from `.emphasised`, which means something else entirely.
    selector: "node.marked",
    style: {
      "border-color": "var(--accent)",
      "border-width": 3,
      "border-style": "dashed",
      "z-index": 9,
    },
  },

  // What a click would do while a connection is being made.
  //
  // Drawn as the absence of the usual drawing rather than as a new colour: `notATarget` dims what a
  // click cannot reach, which leaves the targets at full strength without inventing a fourth meaning
  // for an accent outline. Crosshair over nothing was the whole affordance before, which told a
  // reader that something was armed and nothing about where to aim it.
  { selector: ".notATarget", style: { opacity: 0.18 } },
  {
    // The end already chosen. Solid rather than `.marked`'s dashes, because it is one thing rather
    // than a set, and it has to read differently from the targets it is waiting for.
    selector: "node.connectFrom",
    style: { "border-color": "var(--accent)", "border-width": 4, "z-index": 11 },
  },

  // Dimming is a class on everything else rather than a style on the selection, so that an empty
  // highlight leaves the graph at full strength instead of dimming all of it.
  { selector: ".dimmed", style: { opacity: 0.22 } },
  {
    selector: ".emphasised",
    style: { "border-color": "var(--accent)", "border-width": 3, "z-index": 10 },
  },
  {
    // A selected edge says what it carries without being hovered: the reader already named it, and
    // having to hover the thing you just clicked is a poor answer.
    selector: "edge.emphasised",
    style: {
      "line-color": "var(--accent)",
      "target-arrow-color": "var(--accent)",
      width: 2.4,
      label: "data(label)",
      color: "var(--ink)",
    },
  },
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
    style: resolveStyle(STYLE, paletteOf(container)),
    // Draggable only when the host can persist where it lands: a drag that silently reverts on the next
    // keystroke is worse than one that was never offered.
    autoungrabify: options.onMoved === undefined,
    wheelSensitivity: 0.2,
  });

  /**
   * What a hovered edge carries.
   *
   * Lives beside the canvas rather than being handed to the host through a callback: placing it needs
   * Cytoscape's *rendered* coordinates, and a host that had to be told about those would be coupled to
   * the drawing library this file exists to keep to itself (D92). It is styled by class, so a host that
   * wants it to look different still can.
   */
  const tip = document.createElement("div");
  tip.className = "graphTip";
  tip.hidden = true;
  container.appendChild(tip);

  const describe = (edge: cytoscape.EdgeSingular): HTMLElement[] => {
    const messages = (edge.data("messages") as readonly string[] | undefined) ?? [];
    // `emits` points at a pipe and `reacts` away from one, so which end is the pipe depends on which.
    const emits = edge.data("direction") === "emits";
    const pipe = (emits ? edge.target() : edge.source()).data("label") as string;

    const head = document.createElement("b");
    head.textContent = emits ? `emits to ${pipe}` : `reacts from ${pipe}`;

    const list = document.createElement("ul");
    for (const message of messages) {
      const item = document.createElement("li");
      item.textContent = message;
      list.append(item);
    }

    const notes: HTMLElement[] = [];
    const note = (text: string): void => {
      const line = document.createElement("i");
      line.textContent = text;
      notes.push(line);
    };
    const subscription = edge.data("subscription") as string | undefined;
    if (subscription !== undefined) note(`subscription ${subscription}`);
    if (edge.data("bestEffort") === "yes") note("best-effort: may never be published");
    if (edge.data("incomplete") === "yes") note("declared where nothing reads it");

    return [head, list, ...notes];
  };

  const hideTip = (): void => {
    tip.hidden = true;
  };

  const showTip = (edge: cytoscape.EdgeSingular): void => {
    tip.replaceChildren(...describe(edge));
    const at = edge.renderedMidpoint();
    tip.style.left = `${at.x}px`;
    tip.style.top = `${at.y}px`;
    tip.hidden = false;
  };

  // ---- dragging a connection ------------------------------------------------
  //
  // No extension: the one Cytoscape has for edge handles brings its own interaction model and its own
  // opinions about what a node looks like. All this needs is a line that follows the pointer, and a
  // line is cheaper to draw than a dependency is to keep.
  //
  // The band is an SVG over the canvas rather than a temporary element in the graph, because a real
  // element would be laid out, highlighted, counted and saved like everything else, and every one of
  // those would have to learn to ignore it.
  let connecting = false;
  let dragFrom: SelectionId | undefined;

  const band = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  band.setAttribute("class", "connectBand");
  band.style.position = "absolute";
  band.style.inset = "0";
  band.style.pointerEvents = "none";
  band.style.display = "none";
  const bandLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  band.append(bandLine);
  container.append(band);

  const endDrag = (): void => {
    dragFrom = undefined;
    band.style.display = "none";
    // Only when the host let them move in the first place.
    if (options.onMoved !== undefined) cy.nodes().grabify();
  };

  if (options.onConnect !== undefined) {
    const onConnect = options.onConnect;

    cy.on("mousedown", "node", (e) => {
      const native = e.originalEvent as MouseEvent | undefined;
      const wanted = connecting || native?.shiftKey === true;
      if (!wanted || native?.button !== 0) return;

      // A node that cannot be dragged away cannot also be dragged from, so the grab is taken off for
      // the duration rather than fought with afterwards.
      cy.nodes().ungrabify();
      dragFrom = e.target.id() as SelectionId;
      const at = e.target.renderedPosition() as { x: number; y: number };
      bandLine.setAttribute("x1", String(at.x));
      bandLine.setAttribute("y1", String(at.y));
      bandLine.setAttribute("x2", String(at.x));
      bandLine.setAttribute("y2", String(at.y));
      band.style.display = "";
    });

    cy.on("mousemove", (e) => {
      if (dragFrom === undefined) return;
      const at = e.renderedPosition as { x: number; y: number };
      bandLine.setAttribute("x2", String(at.x));
      bandLine.setAttribute("y2", String(at.y));
    });

    cy.on("mouseup", (e) => {
      const from = dragFrom;
      if (from === undefined) return;
      const onNode = e.target !== cy && typeof e.target.isNode === "function" && e.target.isNode();
      const to = onNode ? (e.target.id() as SelectionId) : undefined;
      endDrag();
      // Dropped on itself or on the background: nothing was asked for, so nothing is said.
      if (to !== undefined && to !== from) onConnect(from, to);
    });

    // Let go outside the canvas and the band would otherwise follow the pointer around forever.
    container.addEventListener("mouseleave", endDrag);
    window.addEventListener("mouseup", () => {
      if (dragFrom !== undefined) endDrag();
    });
  }

  cy.on("mouseover", "edge", (e) => showTip(e.target as cytoscape.EdgeSingular));
  cy.on("mouseout", "edge", hideTip);
  // Anything that moves the drawing under the pointer invalidates where this was put. Hidden rather
  // than followed, because a tooltip chasing a pan is harder to read than one that waits to be asked
  // again.
  cy.on("pan zoom drag", hideTip);

  let saved: Readonly<Record<SelectionId, Point>> = options.saved ?? {};

  /**
   * Lays the graph out, then places whatever the file saved.
   *
   * The merge is `layout.json`'s rule, not a preference: a saved node goes exactly where it was saved and
   * an unsaved one takes its auto position, nudged only to clear a saved one. So adding a service cannot
   * move a saved one (`20-ir.md` 6.2).
   */
  let chosen = options.layout ?? DEFAULT_LAYOUT;

  const relayout = (): void => {
    const layout = cy.layout(withLayout(LAYOUT, chosen) as unknown as cytoscape.LayoutOptions);
    // Saved positions are placed after, whichever algorithm ran — a node somebody dragged is where
    // they put it, and changing the layout is a question about everything they did *not* place.
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

  /**
   * The multi-selection.
   *
   * Ctrl, Cmd or Shift and a click adds or removes. Deliberately separate from `onSelect`: one thing
   * being *selected* is what the sidebar and the sequence diagram read, and a second concept is cheaper
   * than teaching all of them to mean "possibly several".
   */
  const marked = new Set<SelectionId>();

  const remark = (): void => {
    cy.batch(() => {
      cy.nodes().removeClass("marked");
      for (const id of marked) cy.getElementById(id).addClass("marked");
    });
  };

  const toggleMark = (id: SelectionId): void => {
    if (marked.has(id)) marked.delete(id);
    else marked.add(id);
    remark();
  };

  /** Where a Cytoscape event happened on the page, which is what a menu needs. */
  const pointer = (e: unknown): { x: number; y: number } => {
    const native = (e as { originalEvent?: MouseEvent }).originalEvent;
    return { x: native?.clientX ?? 0, y: native?.clientY ?? 0 };
  };

  // A right click is not a selection: it asks about something without changing what is selected, which
  // is what lets "generate for these three" work without the sidebar jumping somewhere else.
  if (options.onContext !== undefined) {
    const onContext = options.onContext;

    // Driven from the native `contextmenu` rather than from Cytoscape's `cxttap`.
    //
    // `cxttap` is a *tap*: it fires only when the press and the release land on the same spot, so a
    // pixel of travel between them — a trackpad, a heavy hand — is classified as a drag and the menu
    // never opens. Nothing says so, which is exactly the "sometimes right-clicking does nothing" that
    // is impossible to reproduce on purpose. A right click always opens the menu now.
    //
    // The cost is finding the node ourselves, which is `renderedBoundingBox` over the nodes and the
    // smallest box that contains the pointer: smallest, so a service inside a package compound wins
    // over the package that contains it, which is what was clicked.
    container.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const box = container.getBoundingClientRect();
      const x = e.clientX - box.left;
      const y = e.clientY - box.top;

      // Smallest first, and leaves before parents. Three things can be under one pointer here: a
      // node, a line, and the package box both of them are drawn inside. A leaf wins outright — an
      // edge ends inside the box it points at, and what somebody means by clicking a box is the box.
      // A *parent* does not, because a package box covers most of the drawing and every line inside
      // it would otherwise be unreachable; so a line close enough to click beats it, and the package
      // is what is left when neither is there.
      let leaf: { id: SelectionId; area: number } | undefined;
      let parent: { id: SelectionId; area: number } | undefined;
      for (const node of cy.nodes()) {
        const b = node.renderedBoundingBox();
        if (x < b.x1 || x > b.x2 || y < b.y1 || y > b.y2) continue;
        const found = { id: node.id() as SelectionId, area: (b.x2 - b.x1) * (b.y2 - b.y1) };
        const into = node.isParent() ? parent : leaf;
        if (into === undefined || found.area < into.area) {
          if (node.isParent()) parent = found;
          else leaf = found;
        }
      }

      const where = { x: e.clientX, y: e.clientY };
      if (leaf !== undefined) {
        onContext({ id: leaf.id, marked: [...marked] }, where);
        return;
      }
      const edge = edgeNear(cy, x, y);
      if (edge !== undefined) {
        onContext({ edge, marked: [...marked] }, where);
        return;
      }
      onContext(parent === undefined ? { marked: [...marked] } : { id: parent.id, marked: [...marked] }, where);
    });
  }

  if (options.onSelect !== undefined) {
    const onSelect = options.onSelect;
    cy.on("tap", "node, edge", (e) => {
      // Marking is the modified click, so an ordinary one still means what it always did.
      const native = (e as unknown as { originalEvent?: MouseEvent }).originalEvent;
      if (native?.ctrlKey === true || native?.metaKey === true || native?.shiftKey === true) {
        if (e.target.isNode() === true) toggleMark(e.target.id() as SelectionId);
        return;
      }
      onSelect(e.target.id() as SelectionId);
    });
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
    retheme() {
      cy.style(resolveStyle(STYLE, paletteOf(container)) as never);
    },
    relayout(id) {
      chosen = id;
      relayout();
    },
    setConnecting(on, from, canReach) {
      connecting = on;
      if (!on) endDrag();

      cy.elements().removeClass("notATarget connectFrom");
      if (!on || canReach === undefined) return;

      for (const node of cy.nodes()) {
        const id = node.id() as SelectionId;
        if (id === from) node.addClass("connectFrom");
        else if (!canReach(id)) node.addClass("notATarget");
      }
      // An edge between two things that are both out of reach is out of reach too, so it dims with
      // them rather than staying bright over a dimmed graph.
      for (const edge of cy.edges()) {
        const ends = [edge.source().id(), edge.target().id()] as SelectionId[];
        if (ends.every((id) => id !== from && !canReach(id))) edge.addClass("notATarget");
      }
    },
    marked: () => [...marked],
    setMarked(ids) {
      marked.clear();
      for (const id of ids) if (cy.getElementById(id).nonempty()) marked.add(id);
      remark();
    },
    update(next) {
      // Nothing in flight survives a redraw: a marker left behind would be a message that never arrived.
      clearSends();
      // Kept in place rather than rebuilt, so the viewport survives a keystroke. The layout re-runs,
      // which is deterministic, so an unchanged part of the model lands where it was.
      const pan = cy.pan();
      const zoom = cy.zoom();
      const wasMarked = [...marked];
      cy.batch(() => {
        cy.elements().remove();
        cy.add(elementsOf(next));
      });
      const layout = cy.layout({
        ...withLayout(LAYOUT, chosen),
        fit: false,
      } as unknown as cytoscape.LayoutOptions);
      layout.on("layoutstop", () => place());
      layout.run();
      cy.pan(pan);
      cy.zoom(zoom);
      // A mark is about a declaration, and a declaration survives a redraw. Anything the new graph no
      // longer draws is dropped rather than kept as an id nobody can see.
      marked.clear();
      for (const id of wasMarked) if (cy.getElementById(id).nonempty()) marked.add(id);
      remark();
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
    destroy: () => {
      tip.remove();
      cy.destroy();
    },
  };
}

/** The node a renderer would draw for an id, for a test or a sidebar. */
export const nodeFor = (graph: Graph, id: SelectionId): GraphNode | undefined =>
  graph.nodes.find((n) => n.id === id);

export type { NodeSingular };

/**
 * A row of the legend: one thing the drawing can show, and what it means.
 *
 * Data rather than a drawn picture, because the drawing is done by the *same* stylesheet the graph
 * uses. A legend that restated the shapes in its own markup would be a second opinion about what a
 * topic looks like, and the two would drift the first time one of them changed.
 */
export interface LegendRow {
  /** What this row means, in the reader's words. */
  readonly what: string;
  /** The classes the graph would give it, so the swatch is styled by the rules the canvas uses. */
  readonly classes?: string;
  /** Data the `[attr = "yes"]` rules select on. */
  readonly data?: Readonly<Record<string, string>>;
  /** Set where the row shows a line style rather than a shape. */
  readonly edge?: { readonly classes?: string; readonly data?: Readonly<Record<string, string>> };
}

export const LEGEND: readonly LegendRow[] = [
  { what: "a service", classes: "service" },
  {
    what: "a service outside this model: @external, so 7K describes none of its behaviour",
    classes: "external",
  },
  {
    what: "an adapter: @adapter, a service that translates, and where a foreign vocabulary stops",
    classes: "service",
    data: { adapter: "yes" },
  },
  { what: "a queue: consumers compete, and each message goes to one of them", classes: "pipe kind-queue" },
  { what: "a topic: every subscriber gets its own copy", classes: "pipe kind-topic" },
  { what: "a stream: a log that can be read again from the start", classes: "pipe kind-stream" },
  {
    what: "a port: everything outside the view that connects here, gathered into one stub",
    classes: "port",
  },
  { what: "a dead letter: a pipe's implicit companion, where its failures go", classes: "dead-letter" },
  { what: "a package", classes: "package" },
  { what: "at the system boundary", classes: "pipe kind-queue", data: { boundary: "yes" } },
  {
    what: "at-most-once: a message that was sent may still be lost",
    classes: "pipe kind-queue",
    data: { lossy: "yes" },
  },
  {
    what: "a name that does not resolve, which is normal while a model is half-written",
    classes: "service",
    data: { incomplete: "yes" },
  },
  { what: "a message flows this way", edge: {} },
  { what: "best-effort: the message may never be published at all", edge: { data: { bestEffort: "yes" } } },
  { what: "an edge naming something that does not resolve", edge: { data: { incomplete: "yes" } } },
];

/** How far apart the rows sit. Fixed, because a legend is a column and not a graph. */
const LEGEND_ROW = 34;
/** Half the swatch's width: a shape row and a line row then span the same place. */
const LEGEND_HALF = 23;

/**
 * What the legend adds to the graph's own stylesheet.
 *
 * Only geometry and where the text goes. Every colour, shape and border still comes from the rules
 * above, which is the whole point: the swatch is not a picture *of* a topic, it is a topic.
 */
const LEGEND_STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node.legendItem",
    style: {
      width: LEGEND_HALF * 2,
      height: 24,
      padding: "0px",
      label: "data(label)",
      "text-halign": "right",
      "text-valign": "center",
      "text-margin-x": 10,
      "font-size": 11,
      color: "var(--ink)",
      "text-wrap": "wrap",
      "text-max-width": "300px",
    },
  },
  {
    // The far end of a line row: carries the explanation and draws nothing of its own.
    selector: "node.legendText",
    style: {
      width: 1,
      height: 1,
      padding: "0px",
      "background-opacity": 0,
      "border-width": 0,
      label: "data(label)",
      "text-halign": "right",
      "text-valign": "center",
      "text-margin-x": 10,
      "font-size": 11,
      color: "var(--ink)",
      "text-wrap": "wrap",
      "text-max-width": "300px",
    },
  },
  {
    selector: "node.legendEnd",
    style: {
      width: 1,
      height: 1,
      padding: "0px",
      "background-opacity": 0,
      "border-width": 0,
      label: "",
    },
  },
];

/** The legend's elements, one row per entry, at fixed positions. */
export const legendElements = (): ElementDefinition[] => {
  const out: ElementDefinition[] = [];
  LEGEND.forEach((row, i) => {
    const y = i * LEGEND_ROW;
    if (row.edge === undefined) {
      out.push({
        data: { id: `legend${i}`, label: row.what, ...row.data },
        position: { x: 0, y },
        classes: `${row.classes ?? ""} legendItem`.trim(),
      });
      return;
    }
    out.push({ data: { id: `legend${i}from` }, position: { x: -LEGEND_HALF, y }, classes: "legendEnd" });
    out.push({
      data: { id: `legend${i}to`, label: row.what },
      position: { x: LEGEND_HALF, y },
      classes: "legendText",
    });
    out.push({
      data: { id: `legend${i}edge`, source: `legend${i}from`, target: `legend${i}to`, ...row.edge.data },
      ...(row.edge.classes === undefined ? {} : { classes: row.edge.classes }),
    });
  });
  return out;
};

/**
 * Draws the legend into an element.
 *
 * A second Cytoscape instance rather than markup, so every swatch is drawn by the rules the graph is
 * drawn by. Nothing here can be dragged, panned or zoomed: it is a key, not a view.
 */
export function renderLegend(container: HTMLElement): { destroy(): void } {
  register();
  const cy = cytoscape({
    container,
    elements: legendElements(),
    style: resolveStyle([...STYLE, ...LEGEND_STYLE], paletteOf(container)),
    layout: { name: "preset" },
    userZoomingEnabled: false,
    userPanningEnabled: false,
    boxSelectionEnabled: false,
    autoungrabify: true,
    autolock: true,
  });
  cy.fit(undefined, 10);
  return { destroy: () => cy.destroy() };
}
