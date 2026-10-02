/**
 * The sequence diagram: what followed what.
 *
 * Laid out as a pure function of a trace, so the hard decisions can be tested rather than looked at.
 *
 * ### Pipes are lifelines, not arrows
 *
 * A conventional sequence diagram would draw one arrow per hop, service to service, labelled with the
 * message. That would be both easier to read and a lie in two directions.
 *
 * It would **invent causality**. One `published` and three `delivered` events are four facts; joining them
 * into three service-to-service arrows asserts that this publish caused those deliveries, which the trace
 * does not say and a competing consumer on a queue makes false. A delivery whose publish is in a different
 * run would have to be drawn as coming from nowhere, or dropped.
 *
 * And it would **hide the waiting**. A message sitting in a queue for thirty seconds is the single most
 * interesting thing a message-driven system does, and it is exactly what vanishes when the queue is drawn
 * as the middle of an arrow. With the pipe as a lifeline, the wait is a visible vertical distance between
 * the publish arrow arriving and the delivery arrow leaving.
 *
 * So: two arrows per hop, and the queue is a participant. More verbose, and it shows the thing you came to
 * see.
 *
 * ### Rows are event-paced; gaps are marked
 *
 * The same decision as the transport (`docs/design.md` 5.1). A row per event, because virtual time
 * clusters — most of a trace happens at a handful of instants — and a real gap in the clock gets a marked
 * divider rather than a proportional hole that would push everything else off the screen.
 */

import type { TraceEvent } from "@sevenk/core";
import { isBadEvent } from "./graph.js";
import type { SelectionId } from "./selection.js";

/** A participant: a column. */
export interface Lane {
  /** The selection id, so clicking a lane selects the same thing the graph would. */
  readonly id: SelectionId;
  readonly label: string;
  readonly qname: string;
  readonly kind: "service" | "pipe" | "saga" | "schedule";
  readonly x: number;
}

/** One event: a row. */
export interface Row {
  /** `(run, seq)` — the event's identity, which is what a highlight carries. */
  readonly key: string;
  readonly seq: number;
  readonly at: number;
  readonly kind: string;
  readonly y: number;
  /** The lane an arrow leaves, where there is one. */
  readonly from?: number;
  /** The lane it arrives at. */
  readonly to?: number;
  /** A lane the event belongs to without travelling: a saga step, a schedule firing. */
  readonly on?: number;
  readonly label: string;
  /** Prose for the row's right-hand margin: a reason, a step name. */
  readonly note?: string;
  readonly bad: boolean;
  /** True when a real gap in the clock precedes this row, which is drawn as a divider. */
  readonly gapBefore: boolean;
  /** How long the gap was, in virtual milliseconds. */
  readonly gapMs?: number;
}

export interface Sequence {
  readonly lanes: readonly Lane[];
  readonly rows: readonly Row[];
  readonly width: number;
  readonly height: number;
}

export interface SequenceOptions {
  readonly laneWidth?: number;
  readonly rowHeight?: number;
  /** Space for the lane headings. */
  readonly headerHeight?: number;
  /** Extra space where a gap divider goes. */
  readonly gapHeight?: number;
  readonly margin?: number;
  /** The virtual gap that counts as time having passed. Matches the transport's default. */
  readonly gapMs?: number;
}

const DEFAULTS = {
  laneWidth: 148,
  rowHeight: 26,
  headerHeight: 44,
  gapHeight: 22,
  margin: 16,
  gapMs: 1000,
};

/** Kinds that move a message onto a pipe; everything else with a pipe is taking one off. */
const OUTBOUND = new Set(["published", "schedule-fired", "saga-compensating"]);

const bare = (qname: string): string => qname.slice(qname.lastIndexOf(".") + 1);

/**
 * Lays a trace out as lanes and rows.
 *
 * Lanes appear in the order the trace first mentions them, which is what gives a sequence diagram its
 * diagonal and keeps crossings down. Deterministic either way, since a trace is fixed.
 */
export function layoutSequence(
  trace: readonly TraceEvent[],
  options: SequenceOptions = {},
): Sequence {
  const o = { ...DEFAULTS, ...options };

  const lanes: Lane[] = [];
  const byId = new Map<SelectionId, number>();

  const lane = (
    kind: Lane["kind"],
    qname: string | undefined,
  ): number | undefined => {
    if (qname === undefined) return undefined;
    // A dead letter belongs to the pipe it is the companion of: the graph draws it that way too, and a
    // lifeline of its own would be a participant that only ever receives.
    const name = kind === "pipe" && qname.endsWith(".dead") ? qname.slice(0, -5) : qname;
    const id = `${kind}:${name}`;
    const already = byId.get(id);
    if (already !== undefined) return already;

    const at = lanes.length;
    byId.set(id, at);
    lanes.push({
      id,
      label: bare(name),
      qname: name,
      kind,
      x: o.margin + at * o.laneWidth + o.laneWidth / 2,
    });
    return at;
  };

  const rows: Row[] = [];
  let y = o.headerHeight;
  let prior: TraceEvent | undefined;

  for (const event of trace) {
    const gapBefore = prior !== undefined && event.at - prior.at >= o.gapMs;
    const gapMs = prior === undefined ? 0 : event.at - prior.at;
    if (gapBefore) y += o.gapHeight;

    // Lanes are created in the order the event names them, so a publish puts the sender left of the pipe.
    const outbound = OUTBOUND.has(event.kind);
    const serviceLane = lane("service", event.service);
    const sagaLane = lane("saga", event.saga);
    const scheduleLane = lane("schedule", event.schedule);
    const pipeLane = lane("pipe", event.pipe);

    // Where an arrow starts: whichever of the three non-pipe participants the event names.
    const actor = serviceLane ?? scheduleLane ?? sagaLane;

    let from: number | undefined;
    let to: number | undefined;
    let on: number | undefined;

    if (pipeLane !== undefined && actor !== undefined) {
      from = outbound ? actor : pipeLane;
      to = outbound ? pipeLane : actor;
    } else if (pipeLane !== undefined) {
      // A publish by the scenario itself has no sender in the model, so the arrow has only an end.
      to = outbound ? pipeLane : undefined;
      on = outbound ? undefined : pipeLane;
      if (to === undefined && on === undefined) on = pipeLane;
    } else if (actor !== undefined) {
      // A saga step or a schedule occurrence: it happened *to* a participant without travelling.
      on = actor;
    }

    rows.push({
      key: `${event.run}\u0000${event.seq}`,
      seq: event.seq,
      at: event.at,
      kind: event.kind,
      y,
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
      ...(on === undefined ? {} : { on }),
      label: event.message === undefined ? event.kind : bare(event.message),
      ...(noteFor(event) === undefined ? {} : { note: noteFor(event)! }),
      bad: isBadEvent(event.kind),
      gapBefore,
      ...(gapBefore ? { gapMs } : {}),
    });

    y += o.rowHeight;
    prior = event;
  }

  return {
    lanes,
    rows,
    width: o.margin * 2 + Math.max(1, lanes.length) * o.laneWidth,
    height: y + o.margin,
  };
}

/**
 * The right-hand note for a row.
 *
 * The reason, which is a stable code a scenario can match on, over the detail, which is prose. An attempt
 * number matters on a retry and nowhere else.
 */
function noteFor(event: TraceEvent): string | undefined {
  const parts: string[] = [];
  if (event.kind !== "published" && event.kind !== "delivered" && event.reason !== undefined) {
    parts.push(event.reason);
  }
  if (event.attempt !== undefined && event.attempt > 1) parts.push(`attempt ${event.attempt}`);
  if (event.sagaKey !== undefined) parts.push(`"${event.sagaKey}"`);
  if (parts.length === 0 && event.kind !== "published" && event.kind !== "delivered") {
    parts.push(event.kind);
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

/** How long a wait was, in words. A queue's whole character is how long things sit in it. */
export function sayGap(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}
