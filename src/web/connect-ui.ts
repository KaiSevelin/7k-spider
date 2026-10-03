/**
 * Connecting two nodes by clicking them.
 *
 * Not a drag. Cytoscape has no edge-drawing of its own and the extension for it brings an interaction
 * model with it, but the deeper reason is that **the model is bipartite**, so a connection is one of
 * exactly two things — `emits` from a service to a pipe, `reacts` from a pipe to a service — and which
 * one it is follows from which end you start at. Click the source, click the target, and the direction is
 * already decided. That also works on a touch screen and from the keyboard, which a drag does not.
 *
 * The flow is deliberately four steps rather than one, because `20-ir.md` section 7 says a caller gets
 * "the resulting text edits plus diagnostics, so a caller can **preview** before applying". An editor
 * that wrote a file the instant two nodes were clicked would be one you stop clicking in.
 */

import type { Mutation, TextEdit } from "@sevenk/core";
import type { Graph, GraphNode } from "../graph.js";
import type { SelectionId } from "../selection.js";

export type Role = "service" | "pipe";

/** Which role a node can play in a connection, or nothing when it cannot play one. */
export function roleOf(node: GraphNode): Role | undefined {
  if (node.kind === "service" || node.kind === "external") return "service";
  if (node.kind === "pipe") return "pipe";
  // A dead letter is written to by the runtime, not by a service; a port stands for what is out of view;
  // a package is not a participant.
  return undefined;
}

export interface Pair {
  readonly service: SelectionId;
  readonly pipe: SelectionId;
  /** `emits` when the service was clicked first, `reacts` when the pipe was. */
  readonly direction: "emits" | "reacts";
}

/**
 * Whether two nodes can be connected, and which way round.
 *
 * Returns a reason rather than nothing when they cannot, because "you cannot connect two services" is
 * worth saying once and is the thing a reader is most likely to try.
 */
export function pairFor(
  graph: Graph,
  from: SelectionId,
  to: SelectionId,
): { pair: Pair } | { problem: string } {
  const a = graph.nodes.find((n) => n.id === from);
  const b = graph.nodes.find((n) => n.id === to);
  if (a === undefined || b === undefined) return { problem: "one of those is not on the graph" };
  if (a.id === b.id) return { problem: "a thing cannot be connected to itself" };

  const roleA = roleOf(a);
  const roleB = roleOf(b);
  if (roleA === undefined || roleB === undefined) {
    const which = roleA === undefined ? a : b;
    return { problem: `a ${which.kind} is not something a message travels to or from` };
  }

  if (roleA === roleB) {
    return {
      problem:
        roleA === "service"
          ? "two services cannot be connected: a message goes through a pipe, which is the point"
          : "two pipes cannot be connected: something has to read one and write the other",
    };
  }

  return roleA === "service"
    ? { pair: { service: a.id, pipe: b.id, direction: "emits" } }
    : { pair: { service: b.id, pipe: a.id, direction: "reacts" } };
}

/**
 * The messages worth offering for a connection, best first.
 *
 * Those already on the pipe come first, because joining existing traffic is the common case and naming a
 * message nothing else carries is how a pipe ends up carrying one of everything.
 */
export function candidates(graph: Graph, pair: Pair): { id: SelectionId; label: string; onPipe: boolean }[] {
  const onPipe = new Set<SelectionId>();
  for (const edge of graph.edges) {
    if (edge.from !== pair.pipe && edge.to !== pair.pipe) continue;
    for (const id of edge.messageIds) onPipe.add(id);
  }

  const seen = new Set<SelectionId>();
  const out: { id: SelectionId; label: string; onPipe: boolean }[] = [];
  for (const edge of graph.edges) {
    for (const [i, id] of edge.messageIds.entries()) {
      if (seen.has(id)) continue;
      seen.add(id);
      const qname = edge.messages[i] ?? id;
      out.push({ id, label: qname, onPipe: onPipe.has(id) });
    }
  }

  return out.sort(
    (a, b) => Number(b.onPipe) - Number(a.onPipe) || (a.label < b.label ? -1 : 1),
  );
}

// ---- what a preview looks like ----------------------------------------------

export interface Preview {
  readonly mutation: Mutation;
  /** The files as they will be, keyed by path, for the write. */
  readonly files: Readonly<Record<string, { readonly before: string; readonly after: string }>>;
  /** The inserted or removed text, for showing what will happen. */
  readonly shows: readonly { readonly file: string; readonly text: string; readonly removing: boolean }[];
}

/** What a mutation's edits will look like, in a form a panel can render. */
export function previewOf(
  mutation: Mutation,
  sources: Readonly<Record<string, string>>,
  applied: Readonly<Record<string, string>>,
): Preview {
  const files: Record<string, { before: string; after: string }> = {};
  for (const file of new Set(mutation.edits.map((e: TextEdit) => e.file))) {
    const before = sources[file];
    const after = applied[file];
    if (before === undefined || after === undefined) continue;
    files[file] = { before, after };
  }

  const shows = mutation.edits.map((edit: TextEdit) => ({
    file: edit.file,
    // An insertion shows what arrives; a removal shows what goes.
    text: edit.text === "" ? (sources[edit.file]?.slice(edit.start, edit.end) ?? "") : edit.text,
    removing: edit.text === "",
  }));

  return { mutation, files, shows };
}
