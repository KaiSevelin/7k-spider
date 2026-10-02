/**
 * `layout.json`: where things are drawn, and the one rule that matters.
 *
 * > **A missing node falls back to auto-layout for that node, not for the view.** Adding a service places
 * > the new one and leaves everything else where it was. The alternative — re-running layout for the
 * > whole view whenever anything changes — is the graph that reshuffles on every model change and stops
 * > being trusted. (`20-ir.md` 6.2, and D25 before it.)
 *
 * That sentence is the whole design. It rules out the obvious implementation, which is to run the layout
 * and then move the saved nodes: that leaves every unsaved node positioned as though the saved ones were
 * somewhere else, so adding one service shuffles the picture anyway, just less obviously.
 *
 * So the merge is the other way round. Saved nodes are placed exactly where they were saved and are then
 * **fixed**; unsaved nodes take their auto-layout position and are moved only as far as they must be to
 * stop overlapping something fixed. Adding a service cannot move a saved one, by construction rather
 * than by care.
 *
 * Pure, and therefore testable: the invariant is worth asserting rather than hoping for.
 */

import type { Graph } from "./graph.js";
import type { SelectionId } from "./selection.js";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface ViewLayout {
  /** Selectors of packages drawn collapsed. A list, because collapse is sparse. */
  readonly collapsed: readonly SelectionId[];
  readonly nodes: Readonly<Record<SelectionId, Point>>;
  readonly edges: Readonly<Record<string, { readonly waypoints: readonly Point[] }>>;
}

/** Keyed by view name, with `*` for the whole model drawn through no lens. */
export type Layout = Readonly<Record<string, ViewLayout>>;

export const WHOLE_MODEL = "*";

export const EMPTY_VIEW: ViewLayout = { collapsed: [], nodes: {}, edges: {} };

// ---- reading ---------------------------------------------------------------

/** Coordinates are integers: sub-pixel drift on every drag is diff noise in a reviewed file. */
const asPoint = (value: unknown): Point | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { x, y } = value as { x?: unknown; y?: unknown };
  if (typeof x !== "number" || typeof y !== "number") return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: Math.round(x), y: Math.round(y) };
};

/**
 * Reads `layout.json`.
 *
 * **An unknown key is ignored, never an error.** A deleted service leaves a stale entry, and the file is
 * optional and deletable, so tolerance is the rule rather than repair. Problems are reported for a reader
 * who wants them, not raised at one who does not.
 */
export function parseLayout(text: string): { layout: Layout; problems: string[] } {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    return { layout: {}, problems: [`not JSON: ${cause instanceof Error ? cause.message : ""}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { layout: {}, problems: ["not a JSON object"] };
  }

  const layout: Record<string, ViewLayout> = {};
  for (const [view, value] of Object.entries(raw as Record<string, unknown>)) {
    if (view.startsWith("_")) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`\`${view}\` is not a view layout`);
      continue;
    }
    const entry = value as { collapsed?: unknown; nodes?: unknown; edges?: unknown };

    const nodes: Record<SelectionId, Point> = {};
    if (typeof entry.nodes === "object" && entry.nodes !== null) {
      for (const [id, at] of Object.entries(entry.nodes as Record<string, unknown>)) {
        const point = asPoint(at);
        if (point === undefined) {
          problems.push(`\`${view}\`.nodes.${id} is not a point`);
          continue;
        }
        nodes[id] = point;
      }
    }

    const edges: Record<string, { waypoints: readonly Point[] }> = {};
    if (typeof entry.edges === "object" && entry.edges !== null) {
      for (const [id, at] of Object.entries(entry.edges as Record<string, unknown>)) {
        const list = (at as { waypoints?: unknown })?.waypoints;
        if (!Array.isArray(list)) continue;
        const waypoints = list.map(asPoint).filter((p): p is Point => p !== undefined);
        if (waypoints.length > 0) edges[id] = { waypoints };
      }
    }

    layout[view] = {
      collapsed: Array.isArray(entry.collapsed)
        ? (entry.collapsed as unknown[]).filter((x): x is string => typeof x === "string")
        : [],
      nodes,
      edges,
    };
  }

  return { layout, problems };
}

/** The layout for a view, falling back to the whole-model one and then to nothing saved at all. */
export const viewOf = (layout: Layout, view: string): ViewLayout =>
  layout[view] ?? layout[WHOLE_MODEL] ?? EMPTY_VIEW;

// ---- merging ---------------------------------------------------------------

/** How close two nodes may sit before one is nudged clear of the other. */
const CLEARANCE = 56;

export interface Placed {
  readonly id: SelectionId;
  readonly at: Point;
  /** True when the position came from the file, and so must not move. */
  readonly fixed: boolean;
}

/**
 * Merges saved positions with auto-laid-out ones.
 *
 * `auto` is what the layout engine produced for every node. `saved` is what the file holds. The result
 * places every saved node exactly where it was saved, and every other node at its auto position unless
 * that lands it on top of a fixed one — in which case it is pushed clear, deterministically, and the
 * fixed node does not move.
 *
 * The property worth stating: **no saved node's position depends on which other nodes exist.** That is
 * what makes "adding a service leaves the rest alone" true by construction.
 */
export function mergeLayout(
  auto: ReadonlyMap<SelectionId, Point>,
  saved: Readonly<Record<SelectionId, Point>>,
): Placed[] {
  const out: Placed[] = [];
  const fixed: Point[] = [];

  // Saved first, in the order the file lists them, so the fixed set is deterministic.
  for (const [id, at] of Object.entries(saved)) {
    if (!auto.has(id)) continue; // a stale entry for something no longer drawn
    out.push({ id, at, fixed: true });
    fixed.push(at);
  }

  const free = [...auto.keys()]
    .filter((id) => saved[id] === undefined)
    // Sorted so a nudge is the same every time, whatever order the engine reported them in.
    .sort();

  for (const id of free) {
    let at = auto.get(id)!;
    // Nudged along one axis at a time, away from whatever it collided with. Bounded, so a crowded
    // corner cannot loop.
    for (let tries = 0; tries < 24; tries++) {
      const hit = fixed.find(
        (p) => Math.abs(p.x - at.x) < CLEARANCE && Math.abs(p.y - at.y) < CLEARANCE,
      );
      if (hit === undefined) break;
      at = { x: at.x, y: at.y + CLEARANCE };
    }
    out.push({ id, at: { x: Math.round(at.x), y: Math.round(at.y) }, fixed: false });
    fixed.push(at);
  }

  return out;
}

// ---- writing ---------------------------------------------------------------

/**
 * Updates one view's node positions, keeping everything else in the file.
 *
 * A stale entry is **kept**, not pruned. The file is shared with a `layout.json` from another branch and
 * a model that is half-renamed, and silently dropping the position of something that is temporarily
 * unresolved would lose work for a reason the author cannot see.
 */
export function withPositions(
  layout: Layout,
  view: string,
  positions: Readonly<Record<SelectionId, Point>>,
): Layout {
  const current = layout[view] ?? EMPTY_VIEW;
  const nodes: Record<SelectionId, Point> = { ...current.nodes };
  for (const [id, at] of Object.entries(positions)) {
    nodes[id] = { x: Math.round(at.x), y: Math.round(at.y) };
  }
  return { ...layout, [view]: { ...current, nodes } };
}

/**
 * Serialises a layout for writing.
 *
 * Keys sorted, so two people dragging different nodes produce a diff of the lines they changed rather
 * than a reordering of the whole file. This is a file that gets reviewed.
 */
export function writeLayout(layout: Layout): string {
  const views = Object.keys(layout).sort();
  const out: Record<string, unknown> = {};
  for (const view of views) {
    const entry = layout[view]!;
    const nodes: Record<string, Point> = {};
    for (const id of Object.keys(entry.nodes).sort()) nodes[id] = entry.nodes[id]!;
    const edges: Record<string, unknown> = {};
    for (const id of Object.keys(entry.edges).sort()) edges[id] = entry.edges[id]!;

    out[view] = {
      ...(entry.collapsed.length > 0 ? { collapsed: [...entry.collapsed].sort() } : {}),
      nodes,
      ...(Object.keys(edges).length > 0 ? { edges } : {}),
    };
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** Whether a graph has anything saved for it at all, which is what decides between merge and plain layout. */
export const hasSaved = (view: ViewLayout, graph: Graph): boolean =>
  graph.nodes.some((n) => view.nodes[n.id] !== undefined);
