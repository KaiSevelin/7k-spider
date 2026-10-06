/**
 * The Data layer as a picture.
 *
 * Spider's graph is the Topology layer, and it is **bipartite on purpose**: a message is an edge label,
 * never a node, because a service-to-service edge would assert a coupling the model deliberately does
 * not have (`graph.ts`). That rule is load-bearing, so this is not more node kinds on that canvas. It is
 * a fourth drawing of the same model, in its own panel, the way the sequence and saga views are.
 *
 * **What it answers that nothing else can.** What is actually *in* `PlaceOrder` — the question you have
 * the moment you click an edge. What else reuses `Money`, and what breaks if it changes. Where `@pii`
 * reaches, as structure rather than as a filtered graph. What `upcast` supplies between two versions.
 * The Process layer got a picture when the saga view was written; this is the layer that still had none.
 *
 * **Depth, not everything.** The ecommerce sample has eleven pipes and forty data declarations, so the
 * whole type graph at once is a hairball and would be the fastest way to make this view useless. The
 * default is therefore a *neighbourhood*: one declaration and what it composes, a couple of hops out.
 * Showing everything stays possible and is not the default.
 *
 * Pure, and over the model alone. No DOM, no Cytoscape, no trace — those belong to the renderer, and
 * keeping them out is what makes this the part worth testing.
 */

import {
  propagatedLabels,
  qualify,
  symbolKey,
  type Decl,
  type FieldIr,
  type LinkedModel,
  type MessageIr,
  type RecordIr,
  type TypeIr,
  type UpcastIr,
  type ValueIr,
} from "@sevenk/core";
import { idOf, packageId, type SelectionId } from "./selection.js";

/** What a data node is. The kinds the Data layer actually has, plus the package that groups them. */
export type DataKind = "message" | "record" | "envelope" | "value" | "enum" | "package";

export interface DataNode {
  /** The same id the graph and the selection model use, so a click needs no translation. */
  readonly id: SelectionId;
  readonly kind: DataKind;
  /** Bare, because the package is the enclosing box. */
  readonly label: string;
  readonly qname: string;
  readonly parent?: SelectionId;
  /** Declared and propagated, so `@pii` on a value shows on everything carrying it. */
  readonly labels: readonly string[];
  /** A message's intent, which is the one thing about it worth seeing without opening it. */
  readonly intent?: "command" | "event" | "query";
  readonly version?: string;
  /** Fields, for the panel beside the drawing. Empty for a value or an enum. */
  readonly fields: readonly { readonly name: string; readonly type: string; readonly optional: boolean }[];
  /** An enum's members, for the same reason. */
  readonly members: readonly string[];
  /**
   * Versions an `upcast` lifts into this one, as `1.0 -> 1.1`.
   *
   * The one thing in the language with no picture anywhere else: what an old producer's message turns
   * into on the way in, and therefore what a consumer on `accepts v1.x` is really reading.
   */
  readonly upcasts: readonly string[];
}

/**
 * How one declaration reaches another.
 *
 * Three relations, and they are different enough that collapsing them would lose the point: `field` is
 * composition, `include` is a record spliced into another, and `envelope` is the fields every message
 * of a package carries (D50).
 *
 * An upcast is deliberately not one of them. 7K has a single declaration per message carrying its
 * current version, so there is no older node for an edge to point at — the upcast is a fact *about*
 * that declaration, and it is carried on the node.
 */
export type DataEdgeKind = "field" | "include" | "envelope";

export interface DataEdge {
  readonly id: string;
  readonly from: SelectionId;
  readonly to: SelectionId;
  readonly kind: DataEdgeKind;
  /** The field's name for a `field` edge, the version pair for an `upcast`. */
  readonly label: string;
}

export interface DataGraph {
  readonly nodes: readonly DataNode[];
  readonly edges: readonly DataEdge[];
  /** How many declarations the model has that this view is not showing. */
  readonly hidden: number;
}

export interface DataOptions {
  /**
   * Show only this declaration and what it reaches, `depth` hops out.
   *
   * Absent means everything, which is honest for a small model and unreadable for a real one.
   */
  readonly around?: SelectionId;
  /** Hops from `around`. Two is a message, its records, and their values. */
  readonly depth?: number;
  /** Include packages as boxes. Off for a neighbourhood, where the boxes outnumber what is in them. */
  readonly packages?: boolean;
}

const DATA_KINDS: ReadonlySet<string> = new Set(["message", "record", "envelope", "value", "enum"]);

/** Every declaration the Data layer owns. Pipes, services, sagas and schedules are another picture. */
export const isData = (decl: Decl): boolean => DATA_KINDS.has(decl.kind);

/** A type as a reader would write it: `[Line]`, `Money?`, `map<Sku, int>`. */
export function typeText(type: TypeIr): string {
  switch (type.t) {
    case "kernel":
      return type.precision === undefined
        ? type.name
        : `${type.name}(${type.precision},${type.scale ?? 0})`;
    case "ref":
      return type.ref.text;
    case "list":
      return `[${typeText(type.item)}]`;
    case "map":
      return `map<${typeText(type.key)}, ${typeText(type.value)}>`;
    default:
      return type.text;
  }
}

/** Every reference a type mentions, however deeply nested. */
function referencesIn(type: TypeIr, model: LinkedModel, out: Decl[]): void {
  switch (type.t) {
    case "ref": {
      const decl = model.declFor(type.ref);
      if (decl !== undefined) out.push(decl);
      return;
    }
    case "list":
      referencesIn(type.item, model, out);
      return;
    case "map":
      referencesIn(type.key, model, out);
      referencesIn(type.value, model, out);
      return;
    default:
  }
}

const fieldsOf = (decl: Decl): readonly FieldIr[] =>
  decl.kind === "message" || decl.kind === "record" || decl.kind === "envelope"
    ? (decl as MessageIr | RecordIr).fields
    : [];

function nodeOf(
  decl: Decl,
  labels: ReadonlyMap<string, ReadonlySet<string>>,
  upcasts: ReadonlyMap<string, readonly string[]>,
  withPackage: boolean,
): DataNode {
  const fields = fieldsOf(decl).map((f) => ({
    name: f.name,
    type: typeText(f.type),
    optional: f.optional,
  }));

  return {
    id: idOf(decl),
    kind: decl.kind as DataKind,
    label: decl.id.name,
    qname: qualify(decl.id),
    ...(withPackage && decl.id.pkg !== "" ? { parent: packageId(decl.id.pkg) } : {}),
    labels: [...(labels.get(symbolKey(decl.id.pkg, decl.id.name)) ?? [])].sort(),
    ...(decl.kind === "message" && decl.intent !== undefined ? { intent: decl.intent } : {}),
    ...("version" in decl && decl.version !== undefined ? { version: decl.version } : {}),
    fields,
    members: decl.kind === "enum" ? decl.members.map((m) => m.name) : [],
    upcasts: upcasts.get(qualify(decl.id)) ?? [],
  };
}

/** Every edge out of one declaration. */
function edgesFrom(decl: Decl, model: LinkedModel): DataEdge[] {
  const out: DataEdge[] = [];
  const from = idOf(decl);
  const seen = new Set<string>();

  const add = (to: Decl, kind: DataEdgeKind, label: string): void => {
    const id = `${from}\u0000${idOf(to)}\u0000${kind}\u0000${label}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, from, to: idOf(to), kind, label });
  };

  for (const field of fieldsOf(decl)) {
    const refs: Decl[] = [];
    referencesIn(field.type, model, refs);
    for (const ref of refs) add(ref, "field", field.name);
  }

  if (decl.kind === "record" || decl.kind === "envelope") {
    for (const include of (decl as RecordIr).includes) {
      const target = model.declFor(include);
      if (target !== undefined) add(target, "include", "include");
    }
  }

  // The envelopes a package declares reach every message in it (D50), which is a real structural fact
  // and one nothing else in Spider shows.
  if (decl.kind === "message") {
    const pkg = model.packages.get(decl.id.pkg);
    for (const ref of pkg?.envelopes ?? []) {
      const target = model.declFor(ref);
      if (target !== undefined) add(target, "envelope", "envelopes");
    }
  }

  return out;
}

/**
 * The data graph, optionally narrowed to a neighbourhood.
 *
 * Narrowing walks the relation in both directions: what `Money` composes *and* what composes `Money`,
 * because "what breaks if I change this" is the question as often as "what is in this".
 */
export function buildData(model: LinkedModel, options: DataOptions = {}): DataGraph {
  const data = model.decls.filter(isData);
  const withPackage = options.packages !== false && options.around === undefined;

  const labels = propagatedLabels(model);

  // Collected once: an upcast names the message it lifts into, so it reads as a fact on that node.
  const upcasts = new Map<string, string[]>();
  for (const decl of model.decls) {
    if (decl.kind !== "upcast") continue;
    const target = model.declFor((decl as UpcastIr).message);
    if (target === undefined) continue;
    const key = qualify(target.id);
    upcasts.set(key, [...(upcasts.get(key) ?? []), `${decl.from ?? "?"} → ${decl.to ?? "?"}`]);
  }

  const byId = new Map<SelectionId, Decl>();
  for (const decl of data) byId.set(idOf(decl), decl);

  // Edges are computed over everything, then filtered, so a neighbourhood is a view of one relation
  // rather than a different relation.
  const all: DataEdge[] = [];
  for (const decl of model.decls) {
    if (!isData(decl)) continue;
    for (const edge of edgesFrom(decl, model)) {
      if (byId.has(edge.from) && byId.has(edge.to)) all.push(edge);
    }
  }

  const keep = options.around === undefined ? new Set(byId.keys()) : near(options, all, byId);

  const nodes: DataNode[] = [];
  const packages = new Set<string>();
  for (const decl of data) {
    const id = idOf(decl);
    if (!keep.has(id)) continue;
    nodes.push(nodeOf(decl, labels, upcasts, withPackage));
    if (withPackage && decl.id.pkg !== "") packages.add(decl.id.pkg);
  }

  const boxes: DataNode[] = [...packages].sort().map((pkg) => ({
    id: packageId(pkg),
    kind: "package" as const,
    label: pkg,
    qname: pkg,
    labels: [],
    fields: [],
    members: [],
    upcasts: [],
  }));

  return {
    nodes: [...boxes, ...nodes],
    edges: all.filter((e) => keep.has(e.from) && keep.has(e.to)),
    hidden: data.length - nodes.length,
  };
}

/**
 * The neighbourhood of `around`: what it holds, and what holds it.
 *
 * **Two walks, and neither changes direction.** Following edges both ways in one walk sounds like the
 * generous thing and is useless on a real model: `OrderRef` is held by nearly every message, so one hop
 * down to it and one hop back up reaches the whole workspace. "Things that share a value with this" is
 * not a relationship anybody came here to look at.
 *
 * Downward answers "what is in this". Upward answers "what breaks if I change it". Both are worth
 * having; their composition is not.
 *
 * Envelope edges are included when both ends are in view but never walked through, for the same reason
 * written larger: an envelope is on every message in its package by construction (D50).
 */
function near(
  options: DataOptions,
  edges: readonly DataEdge[],
  byId: ReadonlyMap<SelectionId, Decl>,
): Set<SelectionId> {
  const keep = new Set<SelectionId>();
  if (options.around === undefined || !byId.has(options.around)) return keep;

  const depth = options.depth ?? 2;
  keep.add(options.around);

  const walk = (forwards: boolean): void => {
    let frontier = [options.around!];
    for (let hop = 0; hop < depth; hop++) {
      const next: SelectionId[] = [];
      for (const edge of edges) {
        const from = forwards ? edge.from : edge.to;
        const to = forwards ? edge.to : edge.from;
        if (!frontier.includes(from) || keep.has(to)) continue;
        keep.add(to);
        if (edge.kind !== "envelope") next.push(to);
      }
      if (next.length === 0) break;
      frontier = next;
    }
  };

  walk(true);
  walk(false);

  return keep;
}
