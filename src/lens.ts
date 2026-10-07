/**
 * Lenses: `views.json`, resolved.
 *
 * A view is "a named lens over the model — a saved filter on the diagram" (`20-ir.md` 6.1). It is
 * presentation rather than language: it feeds no analysis and changes only what is drawn.
 *
 * A lens **hides**, and that is what distinguishes it from the other two operations Spider has. A
 * selection *emphasises* one thing and dims the rest. A focus *hides* transiently, derived from the
 * selection. A lens hides *durably*, because someone saved it. Three verbs, three mechanisms, and
 * conflating any two of them is how a filter becomes something you cannot switch off.
 *
 * The hard part is not the filtering. It is that **a view closes over its edges**, so a lens that
 * simply dropped what it did not match would show a service with no visible reason for the messages
 * leaving it — a picture that is wrong rather than merely partial.
 */

import { isAncestorPackage } from "@sevenk/core";
import { marksOfNode, type Graph, type GraphNode } from "./graph.js";
import { restrict } from "./restrict.js";
import type { SelectionId } from "./selection.js";

// Re-exported so a caller narrowing the graph does not have to know which module shapes the result.
export { isPort, portId } from "./restrict.js";

export interface Lens {
  /** Selectors to union. Empty means everything, which is the lens you get before choosing one. */
  readonly include: readonly string[];
  /** Selectors to subtract afterwards. An exclude cannot be undone by an include. */
  readonly exclude: readonly string[];
  /**
   * How far the lens reaches past what its selectors named.
   *
   * `"edges"`, the default, is what section 4.2 describes: the view closes over its edges, so including
   * a service brings in the pipes it emits to and reacts from. That is right for a lens somebody wrote
   * by naming the things they wanted — `Handover` names two packages and wants the locker pipes they
   * touch, drawn as pipes.
   *
   * `"none"` keeps the selectors' own answer and stands a port wherever an edge leaves it. That is
   * what a *perimeter* view of one subsystem is, and closing over the edges gets it wrong in a way
   * that is easy to miss: the neighbours' pipes come in whole, their package boxes come with them, and
   * the ports end up one hop further out than the boundary the reader asked about.
   */
  readonly closure?: "edges" | "none";
}

/** `views.json`: lenses by name. */
export type Views = Readonly<Record<string, Lens>>;

/** The lens that hides nothing. */
export const EVERYTHING: Lens = { include: [], exclude: [] };

export const isEverything = (lens: Lens): boolean =>
  lens.include.length === 0 && lens.exclude.length === 0;

// ---- selectors --------------------------------------------------------------

const SELECTOR_KINDS = new Set(["package", "service", "pipe", "label"]);

interface Selector {
  readonly kind: "package" | "service" | "pipe" | "label";
  readonly name: string;
}

/** Splits `package:acme.retail.sales`. Returns nothing for anything else. */
export function parseSelector(text: string): Selector | undefined {
  const at = text.indexOf(":");
  if (at <= 0) return undefined;
  const kind = text.slice(0, at);
  const name = text.slice(at + 1);
  if (!SELECTOR_KINDS.has(kind) || name === "") return undefined;
  return { kind: kind as Selector["kind"], name };
}

const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The bare name of a qualified one. */
const bare = (qname: string): string => qname.slice(qname.lastIndexOf(".") + 1);

/**
 * Whether a selector names this node.
 *
 * A name may be written qualified or bare, because `views.json`'s own examples do both —
 * `package:acme.retail.sales` beside `service:KioskBridge`. Matched case-insensitively, since
 * references resolve that way (D40) and a lens that cared about case would be a trap.
 */
function matches(selector: Selector, node: GraphNode): boolean {
  const named = (): boolean => eq(selector.name, node.qname) || eq(selector.name, bare(node.qname));

  switch (selector.kind) {
    case "label":
      // Labels and annotations share one `@name` namespace (D95), which is what makes the
      // specification's own `label:external` perimeter lens mean something.
      for (const mark of marksOfNode(node)) if (eq(mark, selector.name)) return true;
      return false;

    case "service":
      return (node.kind === "service" || node.kind === "external") && named();

    case "pipe":
      // A dead letter is addressed by its own qualified name, which `views.json` already does:
      // `pipe:acme.retail.ticketing.commands.dead`.
      return (node.kind === "pipe" || node.kind === "dead-letter") && named();

    case "package": {
      if (node.kind === "package") {
        return eq(selector.name, node.qname) || isAncestorPackage(selector.name, node.qname);
      }
      // Everything the package owns, and everything its descendants own.
      //
      // Descendants included deliberately: `acme.retail` owns no declarations of its own in the
      // examples — it is implied by its children — so a `package:acme.retail` lens that stopped at
      // direct members would select nothing at all. A reader naming a parent means that whole area.
      const owner = node.qname.slice(0, node.qname.lastIndexOf("."));
      return eq(selector.name, owner) || isAncestorPackage(selector.name, owner);
    }
  }
}

// ---- reading views.json ----------------------------------------------------

export interface ViewsResult {
  readonly views: Views;
  /** What was ignored, and why. Reported rather than thrown: a sidecar is optional and hand-edited. */
  readonly problems: readonly string[];
}

/**
 * Reads `views.json`.
 *
 * Tolerant, like every sidecar reader: the file is optional, deletable and hand-edited, and "deleting
 * this file loses saved lenses and nothing else". A malformed entry is dropped with a reason rather
 * than taking the others down with it.
 */
export function parseViews(text: string): ViewsResult {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { views: {}, problems: [`not JSON: ${cause instanceof Error ? cause.message : ""}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { views: {}, problems: ["not a JSON object"] };
  }

  const views: Record<string, Lens> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // `_comment` is how the examples annotate a sidecar, so an underscored key is a note, not a lens.
    if (name.startsWith("_")) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`\`${name}\` is not a lens`);
      continue;
    }

    const entry = value as { include?: unknown; exclude?: unknown };
    const list = (what: unknown, which: string): string[] => {
      if (what === undefined) return [];
      if (!Array.isArray(what) || what.some((x) => typeof x !== "string")) {
        problems.push(`\`${name}\`.${which} is not a list of selectors`);
        return [];
      }
      const out: string[] = [];
      for (const selector of what as string[]) {
        if (parseSelector(selector) === undefined) {
          problems.push(`\`${name}\`: \`${selector}\` is not a selector`);
          continue;
        }
        out.push(selector);
      }
      return out;
    };

    const closure = (value as { closure?: unknown }).closure;
    if (closure !== undefined && closure !== "edges" && closure !== "none") {
      problems.push(`\`${name}\`.closure is \`edges\` or \`none\``);
    }

    views[name] = {
      include: list(entry.include, "include"),
      exclude: list(entry.exclude, "exclude"),
      ...(closure === "none" || closure === "edges" ? { closure } : {}),
    };
  }

  return { views, problems };
}

// ---- resolution ------------------------------------------------------------

/**
 * Applies a lens to a graph.
 *
 * Four steps, in the order section 6.1 states: resolve the includes, close over the edges, subtract
 * the excludes, then stand a port where an edge still leaves.
 */
export function resolveLens(graph: Graph, lens: Lens): Graph {
  if (isEverything(lens)) return graph;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const include = lens.include.map(parseSelector).filter((s): s is Selector => s !== undefined);
  const exclude = lens.exclude.map(parseSelector).filter((s): s is Selector => s !== undefined);

  const hit = (selectors: readonly Selector[], node: GraphNode): boolean =>
    selectors.some((s) => matches(s, node));

  // 1. The includes. An empty include list means everything, so a lens can be exclude-only.
  const inside = new Set<SelectionId>(
    graph.nodes
      .filter((n) => n.kind !== "package" && (include.length === 0 || hit(include, n)))
      .map((n) => n.id),
  );

  // 2. Closure, **one step**.
  //
  // "A view closes over its edges ... including a service brings in the pipes it emits to and reacts
  // from; including a pipe brings in both ends." One step, not iterated: closing transitively would
  // walk the whole connected component and the lens would select everything, which is plainly not
  // what a saved filter is for.
  // `closure: "none"` skips it entirely, which is what makes a perimeter view of one subsystem
  // possible: every edge that leaves becomes a port in step 4 instead of dragging its far end in.
  if (lens.closure !== "none") {
    const base = [...inside];
    for (const edge of graph.edges) {
      const fromIn = inside.has(edge.from);
      const toIn = inside.has(edge.to);
      if (fromIn === toIn) continue;
      const outer = fromIn ? edge.to : edge.from;
      const innerIsBase = base.includes(fromIn ? edge.from : edge.to);
      if (innerIsBase) inside.add(outer);
    }
  }

  // 3. The excludes, which an include cannot undo.
  for (const node of graph.nodes) {
    if (hit(exclude, node)) inside.delete(node.id);
  }

  // 4. A port where an edge still leaves — the same narrowing a focus does, so it is the same code
  // (`restrict`). Two implementations of "what does a narrowed graph look like" would eventually
  // disagree, and nobody would think to look for a disagreement between the lens and the focus.
  return restrict(graph, inside);
}
