/**
 * The graph: who talks to whom.
 *
 * A pure function of a model. No layout, no rendering, no DOM — those come later and depend on this,
 * not the other way round, because the graph is the part worth testing and a renderer is the part
 * worth looking at.
 *
 * **It is bipartite: services and pipes, never service to service.** A message is an edge *label*,
 * not a node. That mirrors the model exactly — a service declares `emits M to p` and
 * `reacts M from p`, and nothing in 7K says "service A calls service B" — so a graph with an A→B
 * edge would be asserting a coupling the model deliberately does not have. Loose coupling is the
 * thing being described; drawing it away in the first picture would be an odd way to start.
 *
 * Two consequences worth stating, because they look like omissions:
 *
 * A reader who wants "what talks to OrderService" gets it by following two edges rather than one.
 * That is the honest answer: the two services are coupled to a *pipe*, and either can be replaced
 * without the other knowing.
 *
 * Several messages between one service and one pipe collapse into **one edge carrying several
 * labels**, rather than parallel edges. A service emitting six messages to one pipe is one
 * relationship, and six parallel curves would say otherwise while also being unreadable.
 */

import {
  boundaryPipes,
  pipesOf,
  propagatedLabels,
  qualify,
  servicesOf,
  symbolKey,
  type Decl,
  type LinkedModel,
  type PipeIr,
  type Ref,
  type ServiceIr,
} from "@sevenk/core";
import { deadLetterId, idOf, packageId, type SelectionId } from "./selection.js";

export type NodeKind =
  | "service"
  | "pipe"
  /** A pipe's implicit `<pipe>.dead` companion. Not a declaration. */
  | "dead-letter"
  /** A compound node holding a package's own nodes. */
  | "package"
  /**
   * An `@external` service: where the system ends.
   *
   * Its own kind rather than a service, because 7K describes no behaviour for one — no `replies`, no
   * retry policy, nothing a checker can reason about — so drawing it identically to a service it has
   * analysed would overstate what is known.
   */
  | "external"
  /**
   * A stub standing for everything outside the view that connects here.
   *
   * What `20-ir.md` 6.1 means by a boundary port: "an edge leaving the view renders as a boundary
   * port, the same aggregation used for a collapsed package". Not a declaration, and not an
   * `@external` service — those are two different ideas that the one word has to stop covering.
   */
  | "port";

export interface GraphNode {
  /** The same id a selection uses, so a click needs no translation. */
  readonly id: SelectionId;
  readonly kind: NodeKind;
  /** What to draw in the node. Bare, because the package is the enclosing compound node. */
  readonly label: string;
  /** The qualified name, for a tooltip and for matching a trace. */
  readonly qname: string;
  /** The compound node this sits inside, if any. */
  readonly parent?: SelectionId;
  /**
   * Labels that reach this declaration, declared **and propagated** (`01-kernel.md` 6).
   *
   * Propagated rather than declared, because that is the useful fact: a reader wants to know this
   * pipe is PII-bearing, not that some record three hops away said so.
   */
  readonly labels: readonly string[];
  /** Annotations, which a `label:` selector also matches — they share one `@name` namespace (D95). */
  readonly annotations: readonly string[];
  /** True when this pipe is at the system boundary (`03-topology.md` 1.6). Derived, never declared. */
  readonly boundary?: boolean;
  /** A pipe's kind, which is what its shape shows. */
  readonly pipeKind?: PipeIr["pipeKind"];
  /**
   * A pipe's delivery guarantee.
   *
   * Drawn, not hidden behind a tooltip: an `at-most-once` pipe may lose a message, so nothing may
   * depend on it for progress (`03-topology.md` 1.4). That is the sort of thing a reader should see
   * without asking.
   */
  readonly delivery?: PipeIr["delivery"];
  /** Set when something the node refers to did not resolve, so the view can show it as incomplete. */
  readonly incomplete?: boolean;
  /** A port only: the qualified names outside the view that it stands for. */
  readonly hidden?: readonly string[];
}

export interface GraphEdge {
  readonly id: string;
  readonly from: SelectionId;
  readonly to: SelectionId;
  /** The messages this edge carries, qualified, in declaration order. */
  readonly messages: readonly string[];
  /** Selection ids for those messages, so selecting a message type highlights its edges. */
  readonly messageIds: readonly SelectionId[];
  /** `emits` points at a pipe; `reacts` points away from one. */
  readonly direction: "emits" | "reacts";
  /** The subscription's name, where the edge is a `reacts` with one. */
  readonly subscription?: string;
  readonly incomplete?: boolean;
}

export interface Graph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** Things the model did not say, which the view shows rather than hides (D20). */
  readonly unresolved: readonly string[];
}

export interface GraphOptions {
  /**
   * Draw packages as compound nodes containing their services and pipes.
   *
   * On by default: a package is "the namespace, the ownership boundary and the unit of contract at
   * once" (`03-topology.md`), so it is the structure a reader is looking for first.
   */
  readonly packages?: boolean;
  /**
   * Include a pipe's dead-letter companion as a node.
   *
   * Off by default: most of the time it is noise, and it is the kind of thing a reader turns on when
   * they are looking at a failure. A pipe with `dlq none` never gets one.
   */
  readonly deadLetters?: boolean;
}

/** `pipe:acme.sales.events` for a pipe, and so on — the sidecars' selector form. */
const nodeId = idOf;

/** The key a `LinkedModel` indexes a reference's target by, or nothing if it did not resolve. */
const keyOfRef = (model: LinkedModel, ref: Ref): string | undefined => {
  const id = model.resolve(ref);
  return id === undefined ? undefined : symbolKey(id.pkg, id.name);
};

/**
 * Builds the graph.
 *
 * Deterministic: every list is in declaration order, which is what seeds a layered layout and keeps
 * it stable. D25 makes stability matter more than optimality, and a layout seeded by iteration order
 * over a hash map would be neither.
 */
export function buildGraph(model: LinkedModel, options: GraphOptions = {}): Graph {
  const wantPackages = options.packages !== false;
  const wantDeadLetters = options.deadLetters === true;

  const nodes: GraphNode[] = [];
  const unresolved: string[] = [];

  // Computed once for the model: a lens asks about every node, so this is the cheapest place to ask.
  const labels = propagatedLabels(model);
  const marks = (decl: Decl): { labels: string[]; annotations: string[] } => ({
    labels: [...(labels.get(symbolKey(decl.id.pkg, decl.id.name)) ?? [])].sort(),
    annotations: [...decl.annotations],
  });
  const seen = new Set<SelectionId>();

  const push = (node: GraphNode): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    nodes.push(node);
  };

  /**
   * The box a declaration sits in.
   *
   * Its own package when that is declared, and otherwise the nearest declared ancestor — a
   * declaration in an undeclared package still belongs somewhere, and floating it outside every box
   * would read as "this is not in a package" rather than "this package was never declared".
   */
  const parentOf = (pkg: string): SelectionId | undefined => {
    if (!wantPackages || pkg === "") return undefined;
    if (isDeclared.has(pkg)) return packageId(pkg);
    const outer = enclosing(pkg);
    return outer === undefined ? undefined : packageId(outer);
  };

  // ---- packages ------------------------------------------------------------
  // First, so a compound node exists before anything claims it as a parent. A package whose own
  // parent is another package nests, which is what makes `acme.retail` collapsible as a whole.
  // Only a **declared** package gets a box. `acme.retail.sales` implies `acme` and `acme.retail` in
  // the model, but an implied package is a naming prefix rather than "the namespace, the ownership
  // boundary and the unit of contract" (`03-topology.md`), and drawing one claims an owner that
  // nobody wrote. `PackageIr.declared` exists for exactly this distinction.
  const declaredPackages = [...model.packages.values()].filter((p) => p.declared);
  const isDeclared = new Set(declaredPackages.map((p) => p.name));

  /** The nearest declared ancestor of a dotted name, so nesting skips the prefixes. */
  const enclosing = (name: string): string | undefined => {
    let at = name.lastIndexOf(".");
    while (at > 0) {
      const outer = name.slice(0, at);
      if (isDeclared.has(outer)) return outer;
      at = name.lastIndexOf(".", at - 1);
    }
    return undefined;
  };

  if (wantPackages) {
    for (const pkg of declaredPackages) {
      const outer = enclosing(pkg.name);
      push({
        id: packageId(pkg),
        kind: "package",
        // Shown relative to the box it sits in, so a nested package is not a wall of prefix.
        label: outer === undefined ? pkg.name : pkg.name.slice(outer.length + 1),
        qname: pkg.name,
        ...(outer === undefined ? {} : { parent: packageId(outer) }),
        // A package declares neither, and nothing propagates into one: it owns declarations rather
        // than containing data.
        labels: [],
        annotations: [],
      });
    }
  }

  // ---- pipes ---------------------------------------------------------------
  const atBoundary = boundaryPipes(model);

  for (const pipe of pipesOf(model)) {
    const key = symbolKey(pipe.id.pkg, pipe.id.name);
    push({
      id: nodeId(pipe),
      kind: "pipe",
      label: pipe.id.name,
      qname: qualify(pipe.id),
      ...(parentOf(pipe.id.pkg) === undefined ? {} : { parent: parentOf(pipe.id.pkg)! }),
      ...marks(pipe),
      ...(atBoundary.has(key) ? { boundary: true } : {}),
      pipeKind: pipe.pipeKind,
      delivery: pipe.delivery,
    });

    // `dlq: undefined` means the implicit companion, `null` means `dlq none`, and a Ref means a
    // named one — which is a pipe in its own right and already drawn.
    if (wantDeadLetters && pipe.dlq === undefined) {
      push({
        id: deadLetterId(pipe),
        kind: "dead-letter",
        label: `${pipe.id.name}.dead`,
        qname: `${qualify(pipe.id)}.dead`,
        ...(parentOf(pipe.id.pkg) === undefined ? {} : { parent: parentOf(pipe.id.pkg)! }),
        // A dead letter carries whatever its pipe carries, so it inherits the same marks.
        ...marks(pipe),
      });
    }
  }

  // ---- services and ports --------------------------------------------------
  for (const service of servicesOf(model)) {
    push({
      id: nodeId(service),
      kind: service.external ? "external" : "service",
      label: service.id.name,
      qname: qualify(service.id),
      ...(parentOf(service.id.pkg) === undefined ? {} : { parent: parentOf(service.id.pkg)! }),
      ...marks(service),
    });
  }

  // ---- edges ---------------------------------------------------------------
  // Grouped by (service, pipe, direction, subscription), because several messages between one
  // service and one pipe are one relationship. A `reacts` keeps its subscription out of the grouping
  // so that two subscriptions of one service on one pipe stay two edges — `as <name>` exists to
  // distinguish them, and collapsing them would throw that away.
  interface Group {
    readonly from: SelectionId;
    readonly to: SelectionId;
    readonly direction: "emits" | "reacts";
    readonly subscription?: string;
    readonly messages: string[];
    readonly messageIds: SelectionId[];
    incomplete: boolean;
  }
  const groups = new Map<string, Group>();

  const edgeFor = (
    service: ServiceIr,
    pipeRef: Ref,
    messageRef: Ref,
    direction: "emits" | "reacts",
    subscription?: string,
  ): void => {
    const pipeKey = keyOfRef(model, pipeRef);
    const pipe = pipeKey === undefined ? undefined : model.symbols.get(pipeKey);

    if (pipe === undefined || pipe.kind !== "pipe") {
      unresolved.push(
        `${qualify(service.id)} ${direction} to \`${pipeRef.text}\`, which does not resolve to a pipe`,
      );
      return;
    }

    const pipeNode = nodeId(pipe);
    const serviceNode = nodeId(service);
    const key = [serviceNode, pipeNode, direction, subscription ?? ""].join("|");

    let group = groups.get(key);
    if (group === undefined) {
      group = {
        from: direction === "emits" ? serviceNode : pipeNode,
        to: direction === "emits" ? pipeNode : serviceNode,
        direction,
        ...(subscription === undefined ? {} : { subscription }),
        messages: [],
        messageIds: [],
        incomplete: false,
      };
      groups.set(key, group);
    }

    const message = model.declFor(messageRef);
    if (message === undefined) {
      group.incomplete = true;
      // Shown as written, because a half-written model is normal and the name the author typed is
      // more useful to them than a gap.
      if (!group.messages.includes(messageRef.text)) group.messages.push(messageRef.text);
      unresolved.push(
        `${qualify(service.id)} ${direction} \`${messageRef.text}\`, which does not resolve`,
      );
      return;
    }

    const qname = qualify(message.id);
    if (!group.messages.includes(qname)) {
      group.messages.push(qname);
      group.messageIds.push(nodeId(message));
    }
  };

  for (const service of servicesOf(model)) {
    for (const emit of service.emits) edgeFor(service, emit.pipe, emit.message, "emits");
    for (const react of service.reacts) {
      edgeFor(service, react.pipe, react.message, "reacts", react.subscription);
    }
  }

  // `from -> to` is the shape `layout.json` keys an edge by (`20-ir.md` 6.2), so it is the id — but
  // two subscriptions of one service on one pipe share it, and `as <name>` exists precisely to tell
  // those apart. The name disambiguates, and only where it has to, so the common edge keeps the
  // layout file's spelling.
  const grouped = [...groups.values()];
  const pairCount = new Map<string, number>();
  for (const g of grouped) {
    const pair = `${g.from} -> ${g.to}`;
    pairCount.set(pair, (pairCount.get(pair) ?? 0) + 1);
  }

  const edges: GraphEdge[] = grouped.map((g) => {
    const pair = `${g.from} -> ${g.to}`;
    const ambiguous = (pairCount.get(pair) ?? 0) > 1;
    return {
      id: ambiguous && g.subscription !== undefined ? `${pair}#${g.subscription}` : pair,
      from: g.from,
      to: g.to,
      messages: g.messages,
      messageIds: g.messageIds,
      direction: g.direction,
      ...(g.subscription === undefined ? {} : { subscription: g.subscription }),
      ...(g.incomplete ? { incomplete: true } : {}),
    };
  });

  // A package with nothing in it is a heading with no content: it survives in the model, because it
  // was declared, but drawing an empty box would suggest something is missing from the picture
  // rather than from the package.
  const occupied = new Set<SelectionId>();
  for (const node of nodes) {
    let parent = node.parent;
    while (parent !== undefined) {
      occupied.add(parent);
      parent = nodes.find((n) => n.id === parent)?.parent;
    }
  }

  return {
    nodes: nodes.filter((n) => n.kind !== "package" || occupied.has(n.id)),
    edges,
    unresolved,
  };
}

/**
 * Everything a `label:` selector could match on a node: its propagated labels and its annotations.
 *
 * One set, because labels and annotations share the `@name` namespace (D95).
 */
export const marksOfNode = (node: GraphNode): ReadonlySet<string> =>
  new Set([...node.labels, ...node.annotations]);

// ---- trace events on the graph ----------------------------------------------

/** Kinds that move a message *onto* a pipe. Everything else with a pipe is taking one off. */
const OUTBOUND = new Set(["published", "schedule-fired", "saga-compensating"]);

/**
 * Kinds worth seeing differently.
 *
 * These are the events a trace is usually opened for, and a failure that animates identically to a
 * success is a failure you will not notice.
 */
const BAD = new Set([
  "rejected",
  "failed",
  "dead-lettered",
  "dropped",
  "filtered",
  "deduplicated",
  "saga-timeout",
  "saga-rejected",
  "saga-abandoned",
  "saga-compensating",
]);

export const isBadEvent = (kind: string): boolean => BAD.has(kind);

/**
 * The edge a trace event travelled along, if the graph draws one.
 *
 * A trace names a message, a pipe and a service (`30-scenarios.md` 7.6, all qualified); the graph's edges
 * are exactly those pairs, so this is a lookup rather than a guess.
 *
 * Three things it has to cope with:
 *
 * A **dead letter** names the `<pipe>.dead` companion, and the graph draws that node without edges — it
 * annotates its pipe rather than participating. So a dead-lettered event animates along the delivery edge
 * it died on, marked bad, which is both truthful and the thing a reader wants to see.
 *
 * A **port**, when the counterparty is outside the current lens or focus. The message really did go out of
 * view, and animating to the port says so; the alternative is a message that silently does not appear.
 *
 * **No edge at all**, for a saga or schedule event, or a publish by the scenario itself. Those are
 * returned as undefined rather than forced onto some nearby edge.
 */
export function edgeForEvent(
  graph: Graph,
  event: {
    readonly kind: string;
    readonly pipe?: string;
    readonly service?: string;
    readonly subscription?: string;
  },
): GraphEdge | undefined {
  if (event.pipe === undefined) return undefined;

  // A dead letter is drawn as an annotation of its pipe, so the event belongs to the pipe it came from.
  const pipeName = event.pipe.endsWith(".dead")
    ? event.pipe.slice(0, -".dead".length)
    : event.pipe;

  const pipeNode = graph.nodes.find((n) => n.kind === "pipe" && n.qname === pipeName);
  if (pipeNode === undefined) return undefined;

  const outbound = OUTBOUND.has(event.kind);

  if (event.service !== undefined) {
    const serviceNode = graph.nodes.find(
      (n) => (n.kind === "service" || n.kind === "external") && n.qname === event.service,
    );
    if (serviceNode !== undefined) {
      const from = outbound ? serviceNode.id : pipeNode.id;
      const to = outbound ? pipeNode.id : serviceNode.id;
      const candidates = graph.edges.filter((e) => e.from === from && e.to === to);
      if (candidates.length > 0) {
        // `as <name>` can give one service two subscriptions on one pipe, and then only the name tells
        // them apart.
        return (
          candidates.find((e) => e.subscription === event.subscription) ?? candidates[0]
        );
      }
    }
  }

  // The counterparty is out of view, so the message went through a port. Honest, and the only
  // alternative is a message that does not appear at all.
  return graph.edges.find((e) =>
    outbound ? e.to === pipeNode.id && isPortId(e.from) : e.from === pipeNode.id && isPortId(e.to),
  );
}

/** Local, to keep `graph.ts` from depending on the narrowing it is an input to. */
const isPortId = (id: string): boolean => id.startsWith("port:");

/** Every node id in a graph, which is what a layout file is checked against. */
export const nodeIds = (graph: Graph): SelectionId[] => graph.nodes.map((n) => n.id);
