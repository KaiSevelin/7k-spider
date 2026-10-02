/**
 * Narrowing a graph to a set of nodes, honestly.
 *
 * Two different things narrow the graph — a **lens**, which hides durably because someone saved it, and
 * a **focus**, which hides transiently because of what is selected — and both face the same problem:
 * an edge with one end inside and one end outside.
 *
 * Dropping it is not an option. A pipe whose producer has been hidden would be drawn with traffic
 * arriving from nowhere, and a service whose pipe has been hidden would be drawn emitting into nothing.
 * Those pictures are not *partial*; they are *wrong*, and a reader has no way to tell. So an escaping
 * edge ends in a **port**: a stub that says "something out there connects here", which is what
 * `20-ir.md` 6.1 means by a boundary port.
 *
 * This lives in its own module because writing it twice is how the two would come to disagree about what
 * a narrowed graph looks like, and a disagreement between the lens and the focus is one nobody would
 * think to look for.
 */

import type { Graph, GraphEdge, GraphNode } from "./graph.js";
import type { SelectionId } from "./selection.js";

const PORT_PREFIX = "port:";

/** `port:pipe:acme.shop.events:in` — a stub, and deliberately not a declaration id. */
export const portId = (anchor: SelectionId, direction: "in" | "out"): SelectionId =>
  `${PORT_PREFIX}${anchor}:${direction}`;

export const isPort = (id: SelectionId): boolean => id.startsWith(PORT_PREFIX);

/**
 * Keeps only the nodes in `inside`, standing a port wherever that cuts an edge.
 *
 * `inside` names ordinary nodes; packages follow from their contents, because an empty box suggests
 * something is missing from the picture rather than from the package.
 */
export function restrict(graph: Graph, inside: ReadonlySet<SelectionId>): Graph {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const edges: GraphEdge[] = [];
  const ports = new Map<
    SelectionId,
    { node: GraphNode; messages: Set<string>; hidden: Set<string> }
  >();

  for (const edge of graph.edges) {
    const fromIn = inside.has(edge.from);
    const toIn = inside.has(edge.to);

    if (fromIn && toIn) {
      edges.push(edge);
      continue;
    }
    if (!fromIn && !toIn) continue;

    const anchorId = fromIn ? edge.from : edge.to;
    const outsideId = fromIn ? edge.to : edge.from;
    // From the anchor's point of view: an edge pointing at it comes in, one leaving it goes out.
    const direction = fromIn ? "out" : "in";
    const anchor = byId.get(anchorId);
    if (anchor === undefined) continue;

    const id = portId(anchorId, direction);
    let port = ports.get(id);
    if (port === undefined) {
      port = {
        node: {
          id,
          kind: "port",
          label: "",
          qname: id,
          // Beside the node it hangs off, so the stub reads as belonging to it.
          ...(anchor.parent === undefined ? {} : { parent: anchor.parent }),
          labels: [],
          annotations: [],
        },
        messages: new Set(),
        hidden: new Set(),
      };
      ports.set(id, port);
    }
    for (const m of edge.messages) port.messages.add(m);
    port.hidden.add(byId.get(outsideId)?.qname ?? outsideId);

    edges.push({
      id: `${direction === "out" ? anchorId : id} -> ${direction === "out" ? id : anchorId}`,
      from: direction === "out" ? anchorId : id,
      to: direction === "out" ? id : anchorId,
      messages: [...edge.messages],
      messageIds: edge.messageIds,
      direction: edge.direction,
      ...(edge.incomplete === true ? { incomplete: true } : {}),
    });
  }

  // One edge per port, carrying the union. Several escaping edges in one direction are one fact about
  // the view — "something out there connects here" — and a curve per hidden counterparty would be the
  // unreadable picture the aggregation exists to avoid.
  const merged = new Map<string, GraphEdge>();
  for (const edge of edges) {
    const prior = merged.get(edge.id);
    merged.set(
      edge.id,
      prior === undefined
        ? edge
        : { ...prior, messages: [...new Set([...prior.messages, ...edge.messages])] },
    );
  }

  const nodes: GraphNode[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "package" && inside.has(node.id)) nodes.push(node);
  }
  for (const { node, hidden } of ports.values()) {
    const names = [...hidden].sort();
    nodes.push({
      ...node,
      // Counted rather than named: the point of a port is that what is behind it is out of view, and a
      // single name would read as a node that is in the view after all. The names are in the sidebar.
      label: names.length === 1 ? "1 outside" : `${names.length} outside`,
      hidden: names,
    });
  }

  const occupied = new Set<SelectionId>();
  for (const node of nodes) {
    let parent = node.parent;
    while (parent !== undefined) {
      occupied.add(parent);
      parent = graph.nodes.find((n) => n.id === parent)?.parent;
    }
  }
  const packages = graph.nodes.filter((n) => n.kind === "package" && occupied.has(n.id));

  return { nodes: [...packages, ...nodes], edges: [...merged.values()], unresolved: graph.unresolved };
}

/** Every node a package contains, directly or through a nested one. */
export function contentsOf(graph: Graph, packageId: SelectionId): SelectionId[] {
  const out: SelectionId[] = [];
  const stack = [packageId];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    for (const node of graph.nodes) {
      if (node.parent !== parent) continue;
      if (node.kind === "package") stack.push(node.id);
      else out.push(node.id);
    }
  }
  return out;
}
