/**
 * Focus: show this, and what it touches.
 *
 * The third of Spider's three narrowing verbs, and the one that exists for scale. A **lens** hides
 * durably because someone saved it; a **selection** emphasises one thing and dims the rest; a **focus**
 * hides transiently, derived from what is selected. Dimming reads fine at twenty-four nodes and becomes
 * noise you cannot switch off at two hundred.
 *
 * It composes *after* the lens: a focus narrows what the lens left, never the other way round. And it is
 * transient by construction — nothing writes it anywhere — which is what makes it safe to be aggressive.
 * A hidden thing you cannot get back is a different and much worse feature.
 *
 * ### Why the default radius is two
 *
 * Because the graph is bipartite on purpose. A service's neighbours at one hop are **pipes**, which
 * answers nothing: "show me OrderService and what it touches" means the services it actually talks to,
 * and those are two hops away through the pipe that decouples them. One hop from a *pipe* does reach
 * both ends, so an odd radius is useful there and useless from a service.
 *
 * Two is therefore the radius that answers the question a reader is asking, from either end. It is also
 * why the radius is adjustable rather than fixed: three hops is "and what they talk to", which is the
 * next question, and nothing about the model tells us when to stop.
 */

import type { Graph } from "./graph.js";
import { contentsOf, restrict } from "./restrict.js";
import type { Highlight, SelectionId } from "./selection.js";

/** How far a focus reaches, in edges. */
export const DEFAULT_RADIUS = 2;

export interface Focus {
  /** What it is focused on. Empty means not focused. */
  readonly seeds: readonly SelectionId[];
  readonly radius: number;
}

export const NOT_FOCUSED: Focus = { seeds: [], radius: DEFAULT_RADIUS };

export const isFocused = (focus: Focus): boolean => focus.seeds.length > 0;

/**
 * The nodes within `radius` edges of the seeds.
 *
 * A package seed stands for its contents: focusing a package means focusing the things in it, since the
 * box itself has no edges of its own.
 */
export function neighbourhood(
  graph: Graph,
  seeds: readonly SelectionId[],
  radius: number = DEFAULT_RADIUS,
): Set<SelectionId> {
  const expanded: SelectionId[] = [];
  for (const seed of seeds) {
    const node = graph.nodes.find((n) => n.id === seed);
    if (node === undefined) continue;
    if (node.kind === "package") expanded.push(...contentsOf(graph, seed));
    else expanded.push(seed);
  }

  const reached = new Set<SelectionId>(expanded);
  // Breadth-first, so `radius` counts edges rather than however the edge list happens to be ordered.
  let frontier = [...reached];
  for (let hop = 0; hop < Math.max(0, radius) && frontier.length > 0; hop++) {
    const next: SelectionId[] = [];
    for (const edge of graph.edges) {
      const fromIn = reached.has(edge.from);
      const toIn = reached.has(edge.to);
      if (fromIn === toIn) continue;
      const outer = fromIn ? edge.to : edge.from;
      // Only grow from the current frontier, or one pass would walk the whole component.
      if (!frontier.includes(fromIn ? edge.from : edge.to)) continue;
      if (!reached.has(outer)) next.push(outer);
    }
    for (const id of next) reached.add(id);
    frontier = next;
  }

  return reached;
}

/**
 * Narrows a graph to a focus, with a port wherever that cuts an edge.
 *
 * The same `restrict` a lens uses, because a narrowed graph should look the same however it was
 * narrowed — and because an edge leaving the focus has to end somewhere visible, or a focused service
 * would be drawn emitting into nothing.
 */
export function applyFocus(graph: Graph, focus: Focus): Graph {
  if (!isFocused(focus)) return graph;
  const inside = neighbourhood(graph, focus.seeds, focus.radius);
  // A focus on something that is no longer there — a renamed service, a node the lens hid — leaves the
  // graph alone rather than emptying it. An empty screen is the worst possible answer to "where did my
  // model go", and a stale focus is a normal consequence of editing files Spider is watching.
  if (inside.size === 0) return graph;
  return restrict(graph, inside);
}

/**
 * The focus a highlight implies.
 *
 * Derived from the selection rather than chosen separately, so there is one thing to point at and the
 * two cannot drift apart. A selection that resolves to nothing cannot be focused on.
 */
export const focusOn = (highlight: Highlight, radius: number = DEFAULT_RADIUS): Focus => ({
  seeds: [...highlight.declarations],
  radius,
});
