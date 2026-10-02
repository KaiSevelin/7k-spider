/**
 * The selection model: the contract between the three views.
 *
 * D25 says "graph (space), sequence (interaction), timeline (time); selecting in one highlights in
 * all three" and stops there — which leaves the hardest part unsaid, because the three views show
 * different kinds of thing. The graph shows declarations, the sequence shows trace events, the
 * timeline shows instants. "Selecting in one highlights in all three" only means something once
 * there is a mapping between the three, and that mapping is this file.
 *
 * It rests on one observation: **the trace is the join.** A trace event names its message, its pipe
 * and its service, plus a saga and an instance key where it has them, plus a sequence number and an
 * instant. That is already enough to resolve an event to the declarations it touched and to a point
 * in time, so the views link without anything being invented to correlate them.
 *
 * Four properties the design turns on.
 *
 * **You select one thing; many things light up.** A selection is singular, a highlight is a set.
 * That is what makes "click a service, see everything it did" work with no multi-select UI.
 *
 * **Resolution happens once, not once per view.** Three views each computing their own highlight
 * would eventually disagree, and a disagreement between two views of one selection is the kind of
 * bug nobody can describe out loud. There is one `resolve`; each view renders what it is handed.
 *
 * **A selection is an identity, never a reference.** Spider watches files and re-parses on every
 * keystroke, so a selection has to survive the model object it pointed into being discarded. It is
 * a string id, an event key, an instance key — never a `Decl`.
 *
 * **The id form is the one the sidecars already use.** `service:acme.retail.sales.OrderService` is
 * how `layout.json` keys a position and how `views.json` writes a selector (`20-ir.md` 6.1, 6.2),
 * so one id form spans selection, layout and lenses. The alternative, Core's `symbolKey`, is
 * case-folded and NUL-separated: correct as a lookup key, unusable in a URL fragment or a JSON key,
 * and a second id form to keep in step with the first.
 *
 * **The trace format is Core's, not this file's.** `TraceEvent`, `readTrace` and `eventKey` come from
 * `@sevenk/core`, which is where section 7 of `30-scenarios.md` is defined. This file held a
 * hand-written copy until the specification was written, because the format existed only as a type in
 * the sandbox — the one producer a consumer is told not to read (D93).
 */

import {
  eventKey,
  qualify,
  readTrace,
  symbolKey,
  type Decl,
  type DeclKind,
  type LinkedModel,
  type PackageIr,
  type TraceEvent,
} from "@sevenk/core";

export { readTrace, type TraceEvent } from "@sevenk/core";

/** Epoch milliseconds on the clock, as a trace records them. */
export type Instant = number;

/** `service:acme.retail.sales.OrderService` — a selector, as the sidecars spell it. */
export type SelectionId = string;

/** An event's identity: `(run, seq)` as one string, from Core's `eventKey`. */
export type EventKey = string;

export { eventKey } from "@sevenk/core";

/** A saga instance: not a declaration, so not addressable as one. */
export interface InstanceRef {
  /** Qualified, as the trace writes it. */
  readonly saga: string;
  readonly key: string;
}

/**
 * What is selectable.
 *
 * Four kinds, because there are four questions a reader asks of a system that has run: *what is
 * this thing*, *what happened here*, *where did this one instance get to*, and *what was going on
 * then*.
 */
export type Selection =
  /** A service, pipe, message, saga, schedule, package — anything the graph draws. */
  | { readonly k: "declaration"; readonly id: SelectionId }
  /**
   * One trace event, by its identity: `(run, seq)`, never `seq` alone.
   *
   * `seq` restarts at 0 for each run, so a file holding two runs has two events numbered 0
   * (`30-scenarios.md` 7.2). Keying on `seq` would silently merge them.
   */
  | { readonly k: "event"; readonly run: string; readonly seq: number }
  /** One saga instance, which spans many events and one stretch of time. */
  | { readonly k: "instance"; readonly saga: string; readonly key: string }
  /** A stretch of the virtual clock, inclusive at both ends. */
  | { readonly k: "interval"; readonly from: Instant; readonly to: Instant }
  | { readonly k: "none" };

export const NOTHING: Selection = { k: "none" };

/** A span of the clock. */
export interface Interval {
  readonly from: Instant;
  readonly to: Instant;
}

/**
 * What lights up. Every view renders this and only this.
 *
 * The graph emphasises `declarations` and dims the rest; the sequence scrolls to and marks
 * `events`; the timeline brackets `interval` and ticks the events inside it.
 */
export interface Highlight {
  readonly declarations: ReadonlySet<SelectionId>;
  /** Event identities, as `eventKey` produces them. */
  readonly events: ReadonlySet<EventKey>;
  /** The stretch of clock the selection covers. Absent when it covers no time at all. */
  readonly interval?: Interval;
}

const EMPTY: Highlight = { declarations: new Set(), events: new Set() };

// ---- identity ---------------------------------------------------------------

/** `service:acme.retail.sales.OrderService`. */
export const idOf = (decl: Decl): SelectionId => `${decl.id.kind}:${qualify(decl.id)}`;

/** A package's own id. Packages live outside `model.decls`, so they get their own constructor. */
export const packageId = (pkg: PackageIr | string): SelectionId =>
  `package:${typeof pkg === "string" ? pkg : pkg.name}`;

/**
 * A pipe's dead-letter companion.
 *
 * Not a declaration — it is implied by the pipe that has one — but it is a node on the graph and
 * `views.json` already addresses it (`pipe:acme.retail.ticketing.commands.dead`), so it is
 * selectable. Selecting it also highlights the pipe it belongs to, because a reader who clicks a
 * dead letter means "show me that queue".
 */
export const deadLetterId = (pipe: Decl | string): SelectionId =>
  `pipe:${typeof pipe === "string" ? pipe : qualify(pipe.id)}.dead`;

export interface ParsedId {
  readonly kind: DeclKind;
  /** Qualified, except for a `views.json` selector written bare. */
  readonly name: string;
}

const KINDS = new Set<string>([
  "label", "value", "enum", "record", "envelope", "message", "upcast",
  "pipe", "service", "saga", "schedule", "package",
]);

/** Splits an id at its first colon. Returns nothing for a string that is not one. */
export function parseId(id: SelectionId): ParsedId | undefined {
  const at = id.indexOf(":");
  if (at <= 0) return undefined;
  const kind = id.slice(0, at);
  const name = id.slice(at + 1);
  if (!KINDS.has(kind) || name === "") return undefined;
  return { kind: kind as DeclKind, name };
}

const splitQName = (qname: string): { pkg: string; name: string } => {
  const at = qname.lastIndexOf(".");
  return at < 0 ? { pkg: "", name: qname } : { pkg: qname.slice(0, at), name: qname.slice(at + 1) };
};

/** The declaration an id names, or nothing — a stale id after a rename resolves to nothing. */
export function declById(model: LinkedModel, id: SelectionId): Decl | undefined {
  const parsed = parseId(id);
  if (parsed === undefined || parsed.kind === "package") return undefined;
  const { pkg, name } = splitQName(parsed.name);
  const found = model.symbols.get(symbolKey(pkg, name));
  return found?.id.kind === parsed.kind ? found : undefined;
}

// ---- the join ---------------------------------------------------------------

/**
 * A model and a trace, indexed against each other.
 *
 * Built once per (model, trace) rather than per selection, because `resolve` runs on every click
 * and hover: a linear scan of the trace per name per event is the difference between a graph that
 * responds and one that stutters on a trace of any size.
 *
 * A re-parse builds a new join and selections carry over untouched, which is the point of making
 * them identities.
 */
export interface Join {
  readonly model: LinkedModel;
  readonly trace: readonly TraceEvent[];
  /** The declarations an event touched. */
  idsOf(event: EventKey): readonly SelectionId[];
  /** The events a declaration took part in, in trace order. */
  eventsOf(id: SelectionId): readonly EventKey[];
  /** Every instance the trace mentions, in the order it first mentions them. */
  readonly instances: readonly InstanceRef[];
  /** The whole trace's span, absent for an empty trace. */
  readonly extent?: Interval;
  /**
   * Bare service names in the trace that match more than one declaration, and so were not
   * resolved to any. A real possibility, because the trace writes a service unqualified while two
   * packages may each declare one of that name.
   */
  readonly ambiguous: readonly string[];
}

export function join(model: LinkedModel, trace: readonly TraceEvent[] = []): Join {
  // Qualified name -> id, for the fields the trace qualifies.
  const byQName = new Map<string, SelectionId>();
  for (const decl of model.decls) byQName.set(qualify(decl.id), idOf(decl));
  for (const pkg of model.packages.values()) byQName.set(pkg.name, packageId(pkg));

  // Bare service name -> ids, for the one field it does not.
  const byService = new Map<string, SelectionId[]>();
  for (const decl of model.decls) {
    if (decl.id.kind !== "service") continue;
    const list = byService.get(decl.id.name) ?? [];
    list.push(idOf(decl));
    byService.set(decl.id.name, list);
  }

  const ambiguous = new Set<string>();
  const forward = new Map<EventKey, SelectionId[]>();
  const reverse = new Map<SelectionId, EventKey[]>();
  const instances: InstanceRef[] = [];
  const seenInstance = new Set<string>();

  for (const event of trace) {
    const ids: SelectionId[] = [];
    const add = (id: SelectionId | undefined): void => {
      if (id !== undefined && !ids.includes(id)) ids.push(id);
    };

    for (const name of [event.message, event.saga, event.schedule]) {
      if (name !== undefined) add(byQName.get(name));
    }

    if (event.pipe !== undefined) {
      add(byQName.get(event.pipe));
      // A dead letter is its own node and also lights up the pipe it belongs to.
      if (event.pipe.endsWith(".dead")) {
        const parent = event.pipe.slice(0, -".dead".length);
        if (byQName.has(parent)) {
          add(deadLetterId(parent));
          add(byQName.get(parent));
        }
      }
    }

    if (event.service !== undefined) {
      const qualified = byQName.get(event.service);
      if (qualified !== undefined) add(qualified);
      else {
        // A bare name means a producer that does not follow section 7.6 — a converter from another
        // format, most likely. One match resolves it. Several resolve to none: lighting up the wrong
        // service is worse than lighting up neither, and picking the first would hide the collision
        // for good.
        const candidates = byService.get(event.service) ?? [];
        if (candidates.length === 1) add(candidates[0]);
        else if (candidates.length > 1) ambiguous.add(event.service);
      }
    }

    const key = eventKey(event);
    forward.set(key, ids);
    for (const id of ids) {
      const list = reverse.get(id) ?? [];
      list.push(key);
      reverse.set(id, list);
    }

    if (event.saga !== undefined && event.sagaKey !== undefined) {
      const key = `${event.saga}\u0000${event.sagaKey}`;
      if (!seenInstance.has(key)) {
        seenInstance.add(key);
        instances.push({ saga: event.saga, key: event.sagaKey });
      }
    }
  }

  const times = trace.map((e) => e.at);

  return {
    model,
    trace,
    idsOf: (event) => forward.get(event) ?? [],
    eventsOf: (id) => reverse.get(id) ?? [],
    instances,
    ...(times.length === 0
      ? {}
      : { extent: { from: Math.min(...times), to: Math.max(...times) } }),
    ambiguous: [...ambiguous],
  };
}

// ---- resolution -------------------------------------------------------------

const spanOf = (j: Join, keys: readonly EventKey[]): Interval | undefined => {
  const wanted = new Set(keys);
  const times: Instant[] = [];
  for (const event of j.trace) if (wanted.has(eventKey(event))) times.push(event.at);
  if (times.length === 0) return undefined;
  return { from: Math.min(...times), to: Math.max(...times) };
};

const highlight = (
  declarations: Iterable<SelectionId>,
  events: readonly EventKey[],
  interval: Interval | undefined,
): Highlight => ({
  declarations: new Set(declarations),
  events: new Set(events),
  ...(interval === undefined ? {} : { interval }),
});

/**
 * Resolves a selection into what every view should emphasise.
 *
 * The trace may be empty — the graph is worth drawing before anything has run, and the first
 * increment has no trace at all — and then `events` is empty and the graph is the only view with
 * something to show. A degradation, not a special case.
 *
 * A selection that resolves to nothing yields an empty highlight rather than an error: a stale id
 * after a rename, a `seq` from a trace that has since been replaced. Views dim everything, which is
 * the honest rendering of "that is no longer here".
 */
export function resolve(j: Join, selection: Selection): Highlight {
  switch (selection.k) {
    case "none":
      return EMPTY;

    case "declaration": {
      // Selecting a declaration selects what it did — the whole point of linking the views.
      const events = j.eventsOf(selection.id);
      return highlight([selection.id], events, spanOf(j, events));
    }

    case "event": {
      const event = j.trace.find((e) => e.run === selection.run && e.seq === selection.seq);
      if (event === undefined) return EMPTY;
      const key = eventKey(event);
      return highlight(j.idsOf(key), [key], { from: event.at, to: event.at });
    }

    case "instance": {
      // An instance is not a declaration, so it is its own selection kind — but its events name
      // its saga and the pipes and services it drove, and those are what a reader wants lit.
      const events = j.trace
        .filter((e) => e.saga === selection.saga && e.sagaKey === selection.key)
        .map(eventKey);
      const declarations = events.flatMap((key) => [...j.idsOf(key)]);
      return highlight(declarations, events, spanOf(j, events));
    }

    case "interval": {
      const { from, to } = selection;
      const events = j.trace.filter((e) => e.at >= from && e.at <= to).map(eventKey);
      return highlight(
        events.flatMap((key) => [...j.idsOf(key)]),
        events,
        { from, to },
      );
    }
  }
}

/** Whether a view should draw this node emphasised. An empty highlight emphasises nothing. */
export const emphasises = (h: Highlight, id: SelectionId): boolean => h.declarations.has(id);

/** Whether anything at all is selected, which is what tells a view to dim its background. */
export const isActive = (h: Highlight): boolean =>
  h.declarations.size > 0 || h.events.size > 0 || h.interval !== undefined;
