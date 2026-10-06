/**
 * Replaying a trace: the timeline as a transport rather than a passive axis.
 *
 * **Virtual time is not wall time.** A scenario runs on a clock where `advance 30d` is instant and many
 * events share one instant, because the runtime drains everything due now before moving. So mapping
 * virtual milliseconds onto wall milliseconds does not work at either end: a thirty-day advance would
 * stall the animation for a simulated month, and a burst of nine events at one instant would all fire in
 * the same frame and read as one.
 *
 * Playback is therefore **event-paced**: one beat per event, at a rate you choose. A real gap in the clock
 * earns **one extra beat** and a mark — compressed rather than ignored, so the passage of time is visible
 * without being waited out. The timeline draws the gaps at their true size; the transport does not.
 *
 * This is not in tension with D25's "nothing animates on a relayout". Layout does not move. Messages do.
 */

import type { TraceEvent } from "@sevenk/core";

/** One step of playback. */
export interface Beat {
  /** Index into the trace. */
  readonly index: number;
  /** How long to wait *before* showing it. */
  readonly delayMs: number;
  /** True when a real gap in the clock preceded this event. */
  readonly gap: boolean;
}

export interface PlanOptions {
  /** Wall milliseconds per event. */
  readonly beatMs?: number;
  /**
   * The virtual gap, in milliseconds, that counts as time having passed.
   *
   * A second: below that, events are part of the same burst of work — a publish, a delivery, a handler
   * returning — and spacing them out would invent a pause the runtime did not have.
   */
  readonly gapMs?: number;
}

/**
 * Wall milliseconds per event.
 *
 * Paced for reading rather than for getting to the end: each beat carries a dot crossing an edge and
 * a sentence to read, and 420ms was enough for neither. The speed picker still goes faster, and a
 * reader who wants the whole run at once has `8x`.
 */
export const DEFAULT_BEAT_MS = 700;
export const DEFAULT_GAP_MS = 1000;

/**
 * The schedule for a trace: pure, so the pacing can be tested without waiting for it.
 */
export function plan(trace: readonly TraceEvent[], options: PlanOptions = {}): Beat[] {
  const beatMs = Math.max(1, options.beatMs ?? DEFAULT_BEAT_MS);
  const gapMs = options.gapMs ?? DEFAULT_GAP_MS;

  return trace.map((event, index) => {
    const prior = index === 0 ? undefined : trace[index - 1];
    // A gap is measured in virtual time and paid for in exactly one extra beat, however large it was.
    const gap = prior !== undefined && event.at - prior.at >= gapMs;
    return { index, delayMs: gap ? beatMs * 2 : beatMs, gap };
  });
}

export interface PlayerOptions extends PlanOptions {
  /** Called for each event as it is reached, including when seeking. */
  readonly onEvent: (event: TraceEvent, beat: Beat) => void;
  /** Called whenever playing, paused or position changes, so a transport can redraw itself. */
  readonly onChange?: () => void;
  /** Schedules the next beat. Injected so a test can drive playback without real time. */
  readonly timer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface Player {
  readonly playing: boolean;
  /** The index of the last event shown, or -1 before the start. */
  readonly at: number;
  readonly length: number;
  readonly beats: readonly Beat[];
  play(): void;
  pause(): void;
  toggle(): void;
  /** Shows the event at `index` and stops there. -1 rewinds to before the start. */
  seek(index: number): void;
  /** Shows the next event without starting playback. */
  step(by?: number): void;
  setSpeed(multiplier: number): void;
  dispose(): void;
}

/**
 * A transport over a trace.
 *
 * Stops at the end rather than looping: a trace is a recording of something that happened once, and
 * looping would suggest otherwise.
 */
export function createPlayer(trace: readonly TraceEvent[], options: PlayerOptions): Player {
  const timer = options.timer ?? ((run, ms) => setTimeout(run, ms));
  const clear = options.clearTimer ?? ((handle) => clearTimeout(handle as never));

  let beats = plan(trace, options);
  let speed = 1;
  let at = -1;
  let playing = false;
  let handle: unknown;

  const changed = (): void => options.onChange?.();

  const show = (index: number): void => {
    const event = trace[index];
    const beat = beats[index];
    if (event === undefined || beat === undefined) return;
    at = index;
    options.onEvent(event, beat);
  };

  const stop = (): void => {
    if (handle !== undefined) clear(handle);
    handle = undefined;
    playing = false;
  };

  const tick = (): void => {
    const next = at + 1;
    if (next >= trace.length) {
      stop();
      changed();
      return;
    }
    show(next);
    changed();
    if (playing) schedule();
  };

  const schedule = (): void => {
    const next = at + 1;
    const beat = beats[next];
    if (beat === undefined) {
      stop();
      changed();
      return;
    }
    handle = timer(tick, beat.delayMs / speed);
  };

  return {
    get playing() {
      return playing;
    },
    get at() {
      return at;
    },
    get length() {
      return trace.length;
    },
    get beats() {
      return beats;
    },
    play() {
      if (playing || trace.length === 0) return;
      // Playing from the end starts again, because the alternative is a button that does nothing.
      if (at >= trace.length - 1) at = -1;
      playing = true;
      changed();
      schedule();
    },
    pause() {
      stop();
      changed();
    },
    toggle() {
      if (playing) this.pause();
      else this.play();
    },
    seek(index) {
      stop();
      const clamped = Math.max(-1, Math.min(trace.length - 1, index));
      if (clamped === -1) at = -1;
      else show(clamped);
      changed();
    },
    step(by = 1) {
      this.seek(at + by);
    },
    setSpeed(multiplier) {
      speed = Math.max(0.1, Math.min(16, multiplier));
      // Re-planned rather than scaled in place, so `beatMs` stays the one place the pacing is defined.
      beats = plan(trace, options);
      changed();
    },
    dispose: stop,
  };
}

export interface Run {
  readonly run: string;
  readonly events: readonly TraceEvent[];
}

/**
 * The runs a trace file holds, in the order they appear.
 *
 * A file routinely holds more than one: the sandbox's own `trace --ndjson` across several scenarios
 * produces one run each, which is why an event's identity is `(run, seq)` rather than `seq`
 * (`30-scenarios.md` 7.2).
 *
 * They cannot be played as one sequence. Each run starts its clock where it likes, so a timeline drawn
 * across all of them would overlay run two on top of run one and put most of the events in the first
 * fraction of the track — the measurement that forced this: seven runs, and 27 of 59 events inside the
 * first 1%. A trace is a bug report, and you read one of those at a time.
 */
export function runsOf(trace: readonly TraceEvent[]): Run[] {
  const out: Run[] = [];
  for (const event of trace) {
    const last = out[out.length - 1];
    if (last !== undefined && last.run === event.run) (last.events as TraceEvent[]).push(event);
    else out.push({ run: event.run, events: [event] });
  }
  return out;
}

/**
 * Where an event belongs on a timeline drawn in **virtual** time.
 *
 * The transport compresses gaps; the timeline must not, or a thirty-day wait and a millisecond would look
 * the same and the one thing a timeline is for would be lost.
 */
export function positions(trace: readonly TraceEvent[]): number[] {
  if (trace.length === 0) return [];
  const from = trace[0]!.at;
  const to = trace[trace.length - 1]!.at;
  const span = to - from;
  // Everything at one instant spreads evenly instead of stacking invisibly in one place.
  if (span === 0) return trace.map((_, i) => (trace.length === 1 ? 0 : i / (trace.length - 1)));
  return trace.map((e) => (e.at - from) / span);
}
