/**
 * Saying what a trace event was, in a sentence.
 *
 * The graph shows a dot moving along an edge, which says *that* something travelled and nothing about
 * what it was or how it went. A reader watching a replay needs the second part, and the alternative to
 * putting it in words is making them read the trace — which is the thing the replay exists to avoid.
 *
 * Pure, and over one event. It takes no model and no graph on purpose: a trace names everything it
 * needs, so a sentence that needed the model could not be written for a trace of a model that has since
 * changed — which is exactly when a replay is most worth reading.
 *
 * `detail` is prose for a human (`20-ir.md`), so it is shown as written and never matched on.
 */

import { type TraceEvent, type TraceKind } from "@sevenk/core";
import { isBadEvent } from "./graph.js";

export interface Narration {
  /** What happened, as a sentence. */
  readonly text: string;
  /** True for a failure, so a caller can say so without deriving it a second time. */
  readonly bad: boolean;
}

/**
 * The last segment of a qualified name.
 *
 * The package is already the box the thing sits in, and `parcel.delivery.CompartmentReserved` in a
 * sentence reads as punctuation rather than as a name.
 */
const bare = (qname: string | undefined): string =>
  qname === undefined ? "something" : qname.slice(qname.lastIndexOf(".") + 1);

/** `<pipe>.dead` is a name, not a path, so its bare form has to keep both halves. */
const barePipe = (qname: string | undefined): string => {
  if (qname === undefined) return "a pipe";
  if (!qname.endsWith(".dead")) return bare(qname);
  return `${bare(qname.slice(0, -".dead".length))}.dead`;
};

const because = (e: TraceEvent): string => (e.reason === undefined ? "" : ` — ${e.reason}`);
const attempt = (e: TraceEvent): string =>
  e.attempt === undefined || e.attempt <= 1 ? "" : ` (attempt ${e.attempt})`;
const saying = (e: TraceEvent): string => (e.detail === undefined ? "" : ` — ${e.detail}`);
const onStep = (e: TraceEvent): string => (e.step === undefined ? "" : ` at ${e.step}`);

/**
 * One phrasing per kind.
 *
 * A total `Record` rather than a `switch`: a kind added to the trace format then fails to compile here
 * until somebody says what it means, which is the only way a narration stays complete.
 */
const SAY: Readonly<Record<TraceKind, (e: TraceEvent) => string>> = {
  published: (e) =>
    e.service === undefined
      ? `${bare(e.message)} published to ${barePipe(e.pipe)}`
      : `${bare(e.service)} published ${bare(e.message)} to ${barePipe(e.pipe)}`,
  delivered: (e) => `${barePipe(e.pipe)} delivered ${bare(e.message)} to ${bare(e.service)}${attempt(e)}`,
  filtered: (e) => `${bare(e.service)} filtered out ${bare(e.message)}${because(e)}`,
  deduplicated: (e) => `${bare(e.service)} had already handled ${bare(e.message)}${because(e)}`,
  handled: (e) => `${bare(e.service)} handled ${bare(e.message)}`,
  rejected: (e) => `${bare(e.service)} rejected ${bare(e.message)}${because(e)}`,
  failed: (e) => `${bare(e.service)} failed on ${bare(e.message)}${because(e)}${attempt(e)}`,
  retrying: (e) => `redelivering ${bare(e.message)} to ${bare(e.service)}${attempt(e)}`,
  "dead-lettered": (e) => `${bare(e.message)} went to ${barePipe(e.pipe)}${because(e)}`,
  dropped: (e) => `${bare(e.message)} was dropped by ${barePipe(e.pipe)}${because(e)}`,
  // The emit was declared `best-effort`, so nothing was published and nothing is coming.
  unpublished: (e) => `${bare(e.service)} never published ${bare(e.message)}${saying(e)}`,
  upcast: (e) => `${bare(e.message)} was translated for ${bare(e.service)}${saying(e)}`,
  advanced: (e) => `the clock moved on${saying(e)}`,

  "saga-started": (e) => `${bare(e.saga)} started`,
  "saga-redundant-start": (e) => `${bare(e.saga)} was already running, so ${bare(e.message)} started nothing`,
  "saga-advanced": (e) => `${bare(e.saga)} took ${bare(e.message)}${onStep(e)}`,
  "saga-timeout": (e) => `${bare(e.saga)} waited too long${onStep(e)}`,
  "saga-completed": (e) => `${bare(e.saga)} completed`,
  "saga-rejected": (e) => `${bare(e.saga)} rejected${saying(e)}`,
  "saga-abandoned": (e) => `${bare(e.saga)} was abandoned${saying(e)}`,
  "saga-compensating": (e) => `${bare(e.saga)} is undoing${onStep(e)}, with ${bare(e.message)}`,
  "saga-irreversible": (e) => `${bare(e.saga)} cannot undo${onStep(e)}`,

  "schedule-fired": (e) => `${bare(e.schedule)} fired ${bare(e.message)}`,
  "schedule-overrun": (e) => `${bare(e.schedule)} overran${saying(e)}`,
  "schedule-missed": (e) => `${bare(e.schedule)} missed an occurrence${saying(e)}`,
};

/** What this event was, in words. */
export function narrate(event: TraceEvent): Narration {
  const say = SAY[event.kind];
  return {
    // An unknown kind cannot reach here through the type, but a trace is a file somebody else wrote.
    text: say === undefined ? event.kind : say(event),
    bad: isBadEvent(event.kind),
  };
}
