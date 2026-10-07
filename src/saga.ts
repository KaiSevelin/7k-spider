/**
 * The saga view: what a process is declared to do.
 *
 * Laid out as a pure function of the model, for the same reason the sequence diagram is
 * (`sequence.ts`): the decisions worth arguing about should be assertable in a test rather than
 * inspected by eye.
 *
 * The Process layer was a third of the language with no picture at all. The graph draws topology —
 * services, pipes, messages — and explicitly draws **no edge** for a saga event, so a saga appeared in
 * Spider only as a name in search and a lane in the sequence view. Everything needed to draw one was
 * already in the IR.
 *
 * ### Bands, not a flowchart
 *
 * The obvious drawing is boxes and arrows: a node per step, an arrow per outcome. That would look like
 * BPMN and would be a lie about the language, because it invites the reader to look for branching that
 * 7K cannot express. A saga is a **sequence of stages**, each a set of steps that run at once, and the
 * only real structure is stage order and concurrency within a stage. Bands make exactly that visible
 * and nothing else.
 *
 * ### The spine is in the gutter, and steps hang off it
 *
 * Cards are left-aligned at a fixed width and the saga's own line runs down a left gutter, with a short
 * stub to each card. The alternative — centring each stage's cards and forking the line — has to solve
 * a layout problem at every stage boundary, and the fork is the part that drifts when a model changes.
 * With the spine in the gutter, a stage holding two steps is two stubs off one segment, which is both
 * stable and a fair picture of "these share a stage".
 *
 * ### Outcomes are rows; only exits get arrows
 *
 * A step has one row per `on` clause. Drawing each as an arrow would produce a hairball in which most
 * arrows go to one of two places, so a `continue` is the spine carrying on and a `reject` or `abandon`
 * is a stub to an exit rail that runs down to the terminal band. The rail is what makes "every way out
 * of this process" countable.
 *
 * ### The silences are drawn
 *
 * A card says **no inverse** where there is no `undo`, and **no timeout** where there is none. Those are
 * the two most consequential silences in the layer — one is `uncompensated`, the other `unbounded-step`
 * or `saga-liveness` — and a picture that drew only what the author wrote would hide precisely the two
 * things worth seeing. A deliberate `undo none` reads differently from an absent one, because the
 * language distinguishes them and so should the view.
 *
 * ### What it leaves to other views
 *
 * State is drawn as field **names** only. The types belong to the Contract layer, and a saga view that
 * grew into a type browser would be two views in one. Clicking a name is how you get to the other one.
 */

import {
  qualify,
  type AssignIr,
  type AwaitIr,
  type LinkedModel,
  type Ref,
  type SagaIr,
  type SendIr,
  type ServiceIr,
  type StepIr,
  type Terminal,
  type TraceEvent,
} from "@sevenk/core";
import { idOf, type SelectionId } from "./selection.js";
import { sayGap } from "./sequence.js";

/** A message named in the diagram, with the id that selects it in every other view. */
export interface MessageRef {
  readonly qname: string;
  readonly label: string;
  readonly id: SelectionId;
}

/** What one `on` clause does. `timeout` is a trigger, not an action, so it is carried separately. */
export type OutcomeKind = "continue" | "reject" | "abandon";

/** One row inside a step card: an `on` clause and what it does. */
export interface Outcome {
  readonly kind: OutcomeKind;
  /** The message awaited. Absent on the timeout row, which is triggered by the clock. */
  readonly message?: MessageRef;
  /** Present only on the timeout row. */
  readonly afterMs?: number;
  /** Overrides correlating on the awaited message's own business key. */
  readonly keyedBy?: string;
  /** The reason a `reject` carries, which is what a terminal `send` can read back. */
  readonly reason?: string;
  /** State paths this outcome writes, as written. */
  readonly assigns: readonly string[];
  /** What the row reads, assembled once here so the renderer does no formatting. */
  readonly label: string;
  readonly y: number;
}

/**
 * A step's inverse.
 *
 * Three states, because the language has three and they mean different things: a message, a deliberate
 * `undo none`, and nothing at all.
 */
export type Undo =
  | { readonly k: "with"; readonly message: MessageRef; readonly carries: number }
  | { readonly k: "none" }
  | { readonly k: "absent" };

export interface StepCard {
  readonly name: string;
  readonly stage: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly send?: MessageRef;
  /**
   * The baseline the `send` row sits on.
   *
   * Here rather than worked out while drawing, like every other coordinate: the view had its own
   * arithmetic for this one row, it disagreed with the arithmetic here by exactly one row height, and
   * the send and the first outcome were drawn on top of each other in every card that had both.
   */
  readonly sendY?: number;
  /** How many fields the `send` block writes, which is what a badge on the card counts. */
  readonly carries: number;
  readonly outcomes: readonly Outcome[];
  readonly undo: Undo;
  /** No `timeout` of its own: bounded only by the saga's deadline, or by nothing. */
  readonly unbounded: boolean;
}

export interface Stage {
  readonly index: number;
  readonly y: number;
  readonly height: number;
  readonly steps: readonly StepCard[];
  /** More than one step: the renderer draws a concurrency bracket and the word. */
  readonly parallel: boolean;
}

export interface Band {
  readonly y: number;
  readonly height: number;
}

export interface Start extends Band {
  readonly message: MessageRef;
  /** The field identifying one instance. Absent means the message's own `@role(businessKey)`. */
  readonly keyedBy?: string;
  /** State paths the start block seeds. */
  readonly seeds: readonly string[];
}

export interface TerminalRow {
  readonly on: Terminal;
  /** A terminal with no `send` is reachable and announces nothing, which is worth seeing. */
  readonly message?: MessageRef;
  readonly y: number;
}

export interface SagaDiagram {
  readonly qname: string;
  readonly label: string;
  readonly id: SelectionId;
  readonly version?: string;
  /** Absent only in a model the checker would reject; the view still draws what there is. */
  readonly start?: Start;
  readonly state: readonly string[];
  readonly stages: readonly Stage[];
  readonly terminals: readonly TerminalRow[];
  readonly terminalBand: Band;
  readonly deadlineMs?: number;
  /** Where the saga's own line runs. */
  readonly spineX: number;
  /** Where `reject` and `abandon` stubs run down to the terminal band. */
  readonly exitX: number;
  readonly width: number;
  readonly height: number;
}

export interface SagaOptions {
  readonly cardWidth?: number;
  readonly cardGap?: number;
  readonly rowHeight?: number;
  /** The left gutter holding the spine and the stage labels. */
  readonly gutter?: number;
  /** The right gutter holding the exit rail. */
  readonly exitGutter?: number;
  readonly margin?: number;
  readonly bandGap?: number;
}

const DEFAULTS = {
  cardWidth: 248,
  cardGap: 20,
  rowHeight: 19,
  gutter: 84,
  exitGutter: 56,
  margin: 16,
  bandGap: 26,
};

const bare = (qname: string): string => qname.slice(qname.lastIndexOf(".") + 1);

/**
 * A declared duration, in the units it was most likely written in.
 *
 * `sayGap` is for a measured wait and renders 24 hours as `1.0d`; an author who wrote `24h` should read
 * `24h` back. So the largest unit that divides exactly wins, and anything that divides nothing falls
 * back to the measured form.
 */
export function sayDuration(ms: number): string {
  for (const [unit, size] of [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ] as const) {
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return sayGap(ms);
}

/** The message a reference points at, or nothing when it does not resolve. */
const messageRef = (model: LinkedModel, ref: Ref): MessageRef | undefined => {
  const decl = model.declFor(ref);
  if (decl?.kind !== "message") return undefined;
  const qname = qualify(decl.id);
  return { qname, label: bare(qname), id: idOf(decl) };
};

const pathOf = (a: AssignIr): string => a.target.join(".");

const sendOf = (
  model: LinkedModel,
  send: SendIr | undefined,
): { message?: MessageRef; carries: number } => {
  if (send === undefined) return { carries: 0 };
  const message = messageRef(model, send.message);
  return { ...(message === undefined ? {} : { message }), carries: send.assigns.length };
};

const undoOf = (model: LinkedModel, step: StepIr): Undo => {
  if (step.undo === undefined) return { k: "absent" };
  if (step.undo === null) return { k: "none" };
  const message = messageRef(model, step.undo.message);
  return message === undefined
    ? { k: "absent" }
    : { k: "with", message, carries: step.undo.assigns.length };
};

/** The row an `on <Message>` clause becomes. */
const awaitOutcome = (model: LinkedModel, awaited: AwaitIr, y: number): Outcome => {
  const message = messageRef(model, awaited.message);
  const name = message?.label ?? awaited.message.text;
  const action = awaited.action;

  const assigns = action.a === "continue" ? action.assigns.map(pathOf) : [];
  const tail =
    action.a === "reject"
      ? ` → reject${action.reason === undefined ? "" : ` “${action.reason}”`}`
      : action.a === "abandon"
        ? " → abandon"
        : assigns.length === 0
          ? ""
          : ` → ${assigns.join(", ")}`;

  return {
    kind: action.a,
    ...(message === undefined ? {} : { message }),
    ...(awaited.keyedBy === undefined ? {} : { keyedBy: awaited.keyedBy }),
    ...(action.a === "reject" && action.reason !== undefined ? { reason: action.reason } : {}),
    assigns,
    label: `on ${name}${tail}`,
    y,
  };
};

/** The row an `on timeout <d>` clause becomes, which has no message of its own. */
const timeoutOutcome = (step: StepIr, y: number): Outcome | undefined => {
  if (step.timeout === undefined) return undefined;
  const action = step.timeout.action;
  const assigns = action.a === "continue" ? action.assigns.map(pathOf) : [];
  const tail =
    action.a === "reject"
      ? ` → reject${action.reason === undefined ? "" : ` “${action.reason}”`}`
      : action.a === "abandon"
        ? " → abandon"
        : assigns.length === 0
          ? ""
          : ` → ${assigns.join(", ")}`;

  return {
    kind: action.a,
    afterMs: step.timeout.afterMs,
    assigns,
    label: `on timeout ${sayDuration(step.timeout.afterMs)}${tail}`,
    y,
  };
};

/**
 * Lays a saga out.
 *
 * Deterministic throughout: stages in order, steps in declaration order within a stage, rows in the
 * order the author wrote them. A view that reordered anything would make a model look changed when it
 * had only been reread.
 */
export function layoutSaga(
  model: LinkedModel,
  saga: SagaIr,
  options: SagaOptions = {},
): SagaDiagram {
  const o = { ...DEFAULTS, ...options };
  const qname = qualify(saga.id);

  const contentX = o.margin + o.gutter;
  const spineX = o.margin + Math.round(o.gutter / 2);

  let y = o.margin;

  // ---- the start band ------------------------------------------------------
  const startMessage = saga.start === undefined ? undefined : messageRef(model, saga.start.message);
  let start: Start | undefined;
  if (saga.start !== undefined && startMessage !== undefined) {
    const height = o.rowHeight * 2 + 14;
    start = {
      message: startMessage,
      ...(saga.start.keyedBy === undefined ? {} : { keyedBy: saga.start.keyedBy }),
      seeds: saga.start.assigns.map(pathOf),
      y,
      height,
    };
    y += height + o.bandGap;
  }

  // ---- the stages ---------------------------------------------------------
  // Grouped by `StepIr.stage` and walked in numeric order. Stage numbers are dense (a `parallel` block
  // that contributes no step consumes none), so the keys are 0..n and sorting them is enough.
  const byStage = new Map<number, StepIr[]>();
  for (const step of saga.steps) {
    byStage.set(step.stage, [...(byStage.get(step.stage) ?? []), step]);
  }

  const stages: Stage[] = [];
  let widest = 0;

  for (const index of [...byStage.keys()].sort((a, b) => a - b)) {
    const inStage = byStage.get(index)!;
    const cards: StepCard[] = [];

    // Every card in a stage takes the height of the tallest, so the band reads as one thing.
    //
    // The timeout and undo rows are counted whether or not they were declared, because an absent one
    // is drawn as "no timeout" or "no inverse" rather than omitted — see the note at the top about
    // drawing the silences.
    const rowsOf = (step: StepIr): number =>
      (step.send === undefined ? 0 : 1) + step.awaits.length + 1 + 1;
    const rows = Math.max(...inStage.map(rowsOf));
    const height = 22 + rows * o.rowHeight + 10;

    for (const [i, step] of inStage.entries()) {
      const x = contentX + i * (o.cardWidth + o.cardGap);
      const { message: send, carries } = sendOf(model, step.send);

      // 22 is the header the card's name sits in, so the first row of content starts one row below
      // it. Everything after takes the next row, the `send` included — it is a row like any other and
      // numbering it separately is what let the two disagree.
      let rowY = y + 22 + o.rowHeight;
      const sendY = step.send === undefined ? undefined : rowY;
      if (step.send !== undefined) rowY += o.rowHeight;

      const outcomes: Outcome[] = [];
      for (const awaited of step.awaits) {
        outcomes.push(awaitOutcome(model, awaited, rowY));
        rowY += o.rowHeight;
      }
      const onTimeout = timeoutOutcome(step, rowY);
      if (onTimeout !== undefined) outcomes.push(onTimeout);

      cards.push({
        name: step.name,
        stage: index,
        x,
        y,
        width: o.cardWidth,
        height,
        ...(send === undefined ? {} : { send }),
        ...(sendY === undefined ? {} : { sendY }),
        carries,
        outcomes,
        undo: undoOf(model, step),
        unbounded: step.timeout === undefined,
      });
      widest = Math.max(widest, x + o.cardWidth);
    }

    stages.push({ index, y, height, steps: cards, parallel: cards.length > 1 });
    y += height + o.bandGap;
  }

  // ---- the terminal band --------------------------------------------------
  // All three terminals, not only the ones with a `send`. A saga that can abandon and says nothing
  // when it does is a reachable silence, and the view's job is to show it.
  const declared = new Map(saga.terminals.map((t) => [t.on, t.send]));
  const terminals: TerminalRow[] = [];
  let ty = y + 22;
  for (const on of ["complete", "reject", "abandon"] as const) {
    const send = declared.get(on);
    const message = send === undefined ? undefined : messageRef(model, send.message);
    terminals.push({ on, ...(message === undefined ? {} : { message }), y: ty });
    ty += o.rowHeight;
  }
  const terminalBand: Band = { y, height: 22 + 3 * o.rowHeight + 10 };
  y += terminalBand.height;

  const width = Math.max(widest, contentX + o.cardWidth) + o.exitGutter + o.margin;

  return {
    qname,
    label: bare(qname),
    id: idOf(saga),
    ...(saga.version === undefined ? {} : { version: saga.version }),
    ...(start === undefined ? {} : { start }),
    state: saga.state.map((f) => f.name),
    stages,
    terminals,
    terminalBand,
    ...(saga.deadlineMs === undefined ? {} : { deadlineMs: saga.deadlineMs }),
    spineX,
    exitX: width - o.margin - Math.round(o.exitGutter / 2),
    width,
    height: y + o.margin,
  };
}

/**
 * Where one instance of a saga got to, read off a trace.
 *
 * The saga view draws a declaration; this is what lets it draw a *run* on top of one, so the same
 * picture answers "what is this process" and "where did order ORD-1041 stop". Both are questions about
 * the same diagram, which is the argument for reading progress here rather than building a second view.
 */
export interface Progress {
  readonly saga: string;
  readonly key: string;
  /** Steps that completed, in the order they completed — which for a stage is not declaration order. */
  readonly completed: readonly string[];
  /** Steps of the current stage that are still being awaited. Empty once the instance has terminated. */
  readonly waiting: readonly string[];
  /** Steps that timed out, which is how a branch fails without a reply. */
  readonly timedOut: readonly string[];
  /** Steps whose inverse was sent, in the order the unwinding sent them. */
  readonly compensated: readonly string[];
  readonly terminal?: Terminal;
  /**
   * The step whose action ended the instance, where one did.
   *
   * Absent when a deadline ended it, which is the difference between "this step failed" and "the
   * clock ran out while it was waiting" — and the reason `completed` is decidable at all.
   */
  readonly endedIn?: string;
}

const TERMINAL_OF: Record<string, Terminal> = {
  "saga-completed": "complete",
  "saga-rejected": "reject",
  "saga-abandoned": "abandon",
};

/**
 * Reads one instance's progress out of a trace.
 *
 * **A `saga-advanced` does not mean a step succeeded.** It means the step's action ran, and one of the
 * actions is `reject` — so the events alone do not say what completed. `30-scenarios.md` 7.4 states the
 * rule that settles it: a step completed if `saga-advanced` named it and it is not the step named on
 * the terminal event. A terminal names a step when a step's action ended the instance and names none
 * when a deadline did.
 *
 * Getting this wrong is not cosmetic. "Which steps completed" is "which steps will be compensated", so
 * a view that read `saga-advanced` as success would draw a refund that never happened — which is what
 * the first version of this function did, until the example's own trace contradicted it.
 *
 * Step names are read from `step`, never parsed out of `detail`: that field is prose for a reader, and
 * a consumer matching on it breaks the moment the wording improves.
 */
export function progressOf(
  saga: SagaIr,
  trace: readonly TraceEvent[],
  key: string,
): Progress | undefined {
  const qname = qualify(saga.id);
  const mine = trace.filter((e) => e.saga === qname && e.sagaKey === key);
  if (mine.length === 0) return undefined;

  const advanced: string[] = [];
  const timedOut: string[] = [];
  const compensated: string[] = [];
  let terminal: Terminal | undefined;
  /** The step whose action ended the instance. Absent when a deadline did. */
  let endedIn: string | undefined;

  for (const event of mine) {
    const step = event.step;
    if (event.kind === "saga-advanced") {
      if (step !== undefined) advanced.push(step);
    } else if (event.kind === "saga-compensating") {
      if (step !== undefined) compensated.push(step);
    } else if (event.kind === "saga-irreversible") {
      // `undo none`, reached: the step was unwound past, deliberately without an inverse. It belongs
      // in the unwinding story even though no message was sent.
      if (step !== undefined) compensated.push(step);
    } else if (event.kind === "saga-timeout") {
      if (step !== undefined) timedOut.push(step);
    } else {
      const reached = TERMINAL_OF[event.kind];
      if (reached !== undefined) {
        terminal = reached;
        endedIn = step;
      }
    }
  }

  // The rule. `endedIn` is removed rather than filtered out everywhere, because a step may legitimately
  // advance, complete, and then be the one a *later* retry of the same saga ended in — and within one
  // instance a step's action runs at most once.
  const completed = advanced.filter((name) => name !== endedIn);

  const done = new Set(completed);
  let waiting: string[] = [];
  if (terminal === undefined) {
    const stages = [...new Set(saga.steps.map((s) => s.stage))].sort((a, b) => a - b);
    for (const stage of stages) {
      const inStage = saga.steps.filter((s) => s.stage === stage);
      if (inStage.every((s) => done.has(s.name))) continue;
      waiting = inStage.filter((s) => !done.has(s.name)).map((s) => s.name);
      break;
    }
  }

  return {
    saga: qname,
    key,
    completed,
    waiting,
    timedOut,
    compensated,
    ...(terminal === undefined ? {} : { terminal }),
    ...(endedIn === undefined ? {} : { endedIn }),
  };
}

/**
 * The service a saga runs in.
 *
 * 7K declares no host: a saga is run by the service that reacts to its start message, in the saga's
 * own package. Nothing says so in one place, so it is worked out here rather than in each caller.
 *
 * It matters for one practical reason. A saga's `send` is routed by that service's `emits` — routing
 * stays in one table (D62) — so the messages a step *can* send are the ones the host already emits.
 * Anything else would be a step that writes, checks out as text, and then has nowhere to go.
 */
export function hostOf(model: LinkedModel, saga: SagaIr): ServiceIr | undefined {
  const start = saga.start === undefined ? undefined : model.resolve(saga.start.message);
  if (start === undefined) return undefined;
  const wanted = qualify(start);

  return model.decls.find((d): d is ServiceIr => {
    if (d.kind !== "service" || d.external || d.id.pkg !== saga.id.pkg) return false;
    return d.reacts.some((react) => {
      const message = model.resolve(react.message);
      return message !== undefined && qualify(message) === wanted;
    });
  });
}

/**
 * What a step of this saga could send, qualified.
 *
 * Only what routes, which is the whole list: offering a message the host does not emit would offer a
 * step that cannot be delivered. An empty answer is a real state and worth saying out loud — it means
 * the host emits nothing yet, and the fix is a connection, which is a drag away.
 */
export function sendableFrom(model: LinkedModel, saga: SagaIr): readonly string[] {
  const host = hostOf(model, saga);
  if (host === undefined) return [];
  const out = new Set<string>();
  for (const emit of host.emits) {
    const message = model.resolve(emit.message);
    if (message !== undefined) out.add(qualify(message));
  }
  return [...out].sort();
}

/** Every saga in the model, in declaration order, which is what a view offers to open. */
export function sagasOf(model: LinkedModel): readonly SagaIr[] {
  return model.decls.filter((d): d is SagaIr => d.kind === "saga");
}

/** The saga a selection id names, if it names one. */
export function sagaById(model: LinkedModel, id: SelectionId): SagaIr | undefined {
  return sagasOf(model).find((s) => idOf(s) === id);
}
