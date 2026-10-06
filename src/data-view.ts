/**
 * Drawing the Data layer.
 *
 * Its own canvas, deliberately: the graph is bipartite and that rule is load-bearing, so messages and
 * records cannot become nodes on it. This is the fourth drawing of the same model, beside the sequence
 * and the saga.
 *
 * Cytoscape again rather than SVG by hand, because the problem is the same one the graph already solved
 * — boxes, labels, a layered layout that does not move when you are not looking — and a second layout
 * engine would be a second set of bugs. The stylesheet is the graph's own palette resolved the same way,
 * so the two views look like one tool.
 */

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
import elk from "cytoscape-elk";
import type { DataGraph, DataNode } from "./data.js";
import { resolveStyle } from "./render.js";
import type { Highlight, SelectionId } from "./selection.js";

let registered = false;
function register(): void {
  if (registered) return;
  cytoscape.use(elk);
  registered = true;
}

export interface DataViewOptions {
  /** Called with a declaration's id when one is clicked, so the graph lights up with it. */
  readonly onSelect?: (id: SelectionId) => void;
  /** Called on a double tap, which is how you walk the data model one declaration at a time. */
  readonly onFocus?: (id: SelectionId) => void;
  /**
   * Called on a right click, with what it was on and what is marked here.
   *
   * The same shape the graph reports, so one menu serves both canvases. This is the view where it
   * earns its place: these are the declarations a code provider actually writes files for.
   */
  readonly onContext?: (
    at: { readonly id?: SelectionId; readonly marked: readonly SelectionId[] },
    at_page: { readonly x: number; readonly y: number },
  ) => void;
}

export interface DataView {
  update(data: DataGraph): void;
  /** Emphasises what a highlight names and dims the rest, exactly as the graph does. */
  highlight(h: Highlight | undefined): void;
  retheme(): void;
  destroy(): void;
}

/**
 * The layout.
 *
 * `DOWN`, so composition reads top to bottom: a message above the records it holds, above the values
 * they hold. Deterministic for the same reason the graph's is (D25) — a picture that reshuffles when the
 * model changes is the named failure.
 */
const LAYOUT: Record<string, unknown> = {
  name: "elk",
  animate: false,
  fit: true,
  padding: 20,
  elk: {
    algorithm: "layered",
    "elk.direction": "DOWN",
    "elk.layered.spacing.nodeNodeBetweenLayers": 52,
    "elk.spacing.nodeNode": 28,
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  },
};

/**
 * A node's shape says what kind of declaration it is, as the graph's shapes say what kind of pipe.
 *
 * A message is the thing that travels, so it keeps the graph's round rectangle. A record is structure,
 * so it is square. A value is a leaf and is drawn smallest.
 */
const STYLE: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      label: "data(label)",
      "font-family": "var(--mono)",
      "font-size": 11,
      color: "var(--ink)",
      "text-valign": "center",
      "text-halign": "center",
      "text-wrap": "wrap",
      "border-width": 1.5,
      "border-color": "var(--line)",
      "background-color": "var(--surface)",
      width: "label",
      height: "label",
      padding: "8px",
      shape: "round-rectangle",
    },
  },
  {
    // The three intents are the one thing about a message worth seeing before opening it.
    selector: "node.message",
    style: { "background-color": "var(--service)", "border-color": "var(--service-line)" },
  },
  { selector: "node.record", style: { shape: "rectangle", "background-color": "var(--pipe)", "border-color": "var(--pipe-line)" } },
  {
    // An envelope is on every message in its package, so it is drawn as the different thing it is.
    selector: "node.envelope",
    style: { shape: "round-tag", "background-color": "var(--pipe)", "border-color": "var(--pipe-line)" },
  },
  { selector: "node.value", style: { shape: "round-rectangle", padding: "5px", "font-size": 10, "background-color": "var(--bg)" } },
  { selector: "node.enum", style: { shape: "hexagon", "background-color": "var(--bg)" } },
  {
    selector: "node.package",
    style: {
      label: "data(label)",
      "text-valign": "top",
      "text-halign": "center",
      "text-margin-y": -4,
      "font-size": 10,
      color: "var(--ink-dim)",
      "background-color": "var(--package)",
      "background-opacity": 0.5,
      "border-color": "var(--line)",
      "border-style": "dashed",
      padding: "14px",
    },
  },
  { selector: 'node[pii = "yes"]', style: { "border-color": "var(--boundary)", "border-width": 2.5 } },
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      width: 1.2,
      "line-color": "var(--line)",
      "target-arrow-color": "var(--line)",
      "target-arrow-shape": "triangle",
      "arrow-scale": 0.8,
      "font-family": "var(--mono)",
      "font-size": 9,
      color: "var(--ink-dim)",
      "text-background-color": "var(--bg)",
      "text-background-opacity": 0.85,
      "text-background-padding": "2px",
      "text-rotation": "autorotate",
    },
  },
  // An `include` splices a record into another, which is a stronger relation than holding a field of it.
  { selector: 'edge[kind = "include"]', style: { width: 2, "line-style": "solid" } },
  { selector: 'edge[kind = "envelope"]', style: { "line-style": "dotted" } },
  // A field's name is shown only when it is the emphasised one: forty labelled edges is a hairball.
  { selector: "edge.emphasised", style: { label: "data(label)", "line-color": "var(--accent)", "target-arrow-color": "var(--accent)", width: 2.2 } },
  { selector: ".dimmed", style: { opacity: 0.2 } },
  // Marking looks the same here as on the graph, because it is the same gesture for the same purpose.
  {
    selector: "node.marked",
    style: { "border-color": "var(--accent)", "border-width": 3, "border-style": "dashed", "z-index": 9 },
  },
  { selector: ".emphasised", style: { "border-color": "var(--accent)", "border-width": 3, "z-index": 10 } },
];

/**
 * What a node says on the canvas.
 *
 * The version, and what an `upcast` lifts into it — the one fact in the language with no picture
 * anywhere else, and the one a consumer on `accepts v1.x` most needs.
 */
const labelOf = (n: DataNode): string => {
  const version = n.version === undefined ? "" : ` ${n.version}`;
  const lifted = n.upcasts.length === 0 ? "" : `
← ${n.upcasts.join(", ")}`;
  return `${n.label}${version}${lifted}`;
};

const elementsOf = (data: DataGraph): ElementDefinition[] => [
  ...data.nodes.map((n: DataNode) => ({
    data: {
      id: n.id,
      label: labelOf(n),
      qname: n.qname,
      pii: n.labels.includes("pii") ? "yes" : "no",
      ...(n.parent === undefined ? {} : { parent: n.parent }),
    },
    classes: n.kind,
  })),
  ...data.edges.map((e) => ({
    data: { id: e.id, source: e.from, target: e.to, label: e.label, kind: e.kind },
  })),
];

export function renderData(
  container: HTMLElement,
  data: DataGraph,
  options: DataViewOptions = {},
): DataView {
  register();

  const cy: Core = cytoscape({
    container,
    elements: elementsOf(data),
    style: resolveStyle(STYLE, palette(container)),
    wheelSensitivity: 0.2,
    autoungrabify: true,
  });

  const relayout = (): void => {
    cy.layout(LAYOUT as unknown as cytoscape.LayoutOptions).run();
    // The panel is a flex column, so the canvas has no final height until the browser has laid it
    // out. Fitting in the same tick fits to the wrong box.
    requestAnimationFrame(() => {
      cy.resize();
      cy.fit(undefined, 20);
    });
  };
  relayout();

  /** The multi-selection, kept per canvas: marking here is about these declarations. */
  const marked = new Set<SelectionId>();
  const remark = (): void => {
    cy.batch(() => {
      cy.nodes().removeClass("marked");
      for (const id of marked) cy.getElementById(id).addClass("marked");
    });
  };

  const pointer = (e: unknown): { x: number; y: number } => {
    const native = (e as { originalEvent?: MouseEvent }).originalEvent;
    return { x: native?.clientX ?? 0, y: native?.clientY ?? 0 };
  };

  if (options.onSelect !== undefined) {
    const onSelect = options.onSelect;
    cy.on("tap", "node", (e) => {
      // Marking is the modified click, so an ordinary one still selects.
      const native = (e as unknown as { originalEvent?: MouseEvent }).originalEvent;
      if (native?.ctrlKey === true || native?.metaKey === true || native?.shiftKey === true) {
        const id = e.target.id() as SelectionId;
        if (marked.has(id)) marked.delete(id);
        else marked.add(id);
        remark();
        return;
      }
      onSelect(e.target.id() as SelectionId);
    });
  }

  if (options.onContext !== undefined) {
    const onContext = options.onContext;
    container.addEventListener("contextmenu", (e) => e.preventDefault());
    cy.on("cxttap", "node", (e) =>
      onContext({ id: e.target.id() as SelectionId, marked: [...marked] }, pointer(e)),
    );
    cy.on("cxttap", (e) => {
      if (e.target !== cy) return;
      onContext({ marked: [...marked] }, pointer(e));
    });
  }
  if (options.onFocus !== undefined) {
    const onFocus = options.onFocus;
    cy.on("dbltap", "node", (e) => onFocus(e.target.id() as SelectionId));
  }

  return {
    update(next) {
      cy.batch(() => {
        cy.elements().remove();
        cy.add(elementsOf(next));
      });
      for (const id of [...marked]) if (cy.getElementById(id).empty()) marked.delete(id);
      remark();
      relayout();
    },

    highlight(h) {
      cy.batch(() => {
        cy.elements().removeClass("dimmed emphasised");
        if (h === undefined || h.declarations.size === 0) return;

        const wanted = cy.collection();
        for (const id of h.declarations) {
          const node = cy.getElementById(id);
          if (node.nonempty()) wanted.merge(node);
        }
        if (wanted.empty()) return;

        // The edges between what is wanted come along, which is what makes "where does this go" legible
        // rather than a set of lit boxes with nothing between them.
        wanted.addClass("emphasised");
        wanted.connectedEdges().addClass("emphasised");
      });
    },

    retheme() {
      cy.style(resolveStyle(STYLE, palette(container)) as never);
    },

    destroy: () => cy.destroy(),
  };
}

/** The page's palette, read off the container — the same trick the graph uses. */
const palette =
  (el: Element) =>
  (name: string): string | undefined => {
    const value = getComputedStyle(el).getPropertyValue(name).trim();
    return value === "" ? undefined : value;
  };
