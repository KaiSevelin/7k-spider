/**
 * The browser entry point.
 *
 * Everything the language means is computed here, in the page, by `@sevenk/core` — the same lexer,
 * parser, linker and analyses `7k check` runs. Core has no `node:` imports and `buildWorkspace` takes
 * sources as strings, so the server's whole job is to hand over the files and say when they change.
 *
 * That is why there is no IR wire format. Spider's view of a model is not a copy of the checker's that
 * could drift from it; it is the checker's.
 *
 * Three operations, kept apart on purpose (`docs/design.md` 4):
 *
 * - a **lens** hides durably, because someone saved it in `views.json`;
 * - a **selection** emphasises one thing and dims the rest;
 * - a **focus** hides transiently, derived from the selection.
 *
 * Conflating any two of them is how a filter becomes something you cannot switch off.
 */

import {
  applyAll,
  buildWorkspace,
  connectEmit,
  connectReact,
  hasErrors,
  isPossible,
  lineColOf,
  qualify,
  type CstNode,
  type Diagnostic,
  type Editable,
  type LinkedModel,
  type Mutation,
  type SagaIr,
} from "@sevenk/core";
import { edgeForEvent, isBadEvent, buildGraph, type Graph, type GraphOptions } from "../graph.js";
import {
  applyFocus,
  DEFAULT_RADIUS,
  isFocused,
  NOT_FOCUSED,
  type Focus,
} from "../focus.js";
import { EVERYTHING, isPort, parseViews, resolveLens, type Lens, type Views } from "../lens.js";
import { nodeFor, renderGraph, type Rendered } from "../render.js";
import { createPlayer, positions, runsOf, type Player, type Run } from "../play.js";
import { buildIndex, search, type Entry, type Hit } from "../search.js";
import { renderSequence, type SequenceView } from "../sequence-view.js";
import { progressOf, sagaById, sagasOf } from "../saga.js";
import { renderSaga, type SagaView } from "../saga-view.js";
import {
  blank,
  check,
  composable,
  formOf,
  parseForms,
  type Form,
  type Forms,
} from "../compose.js";
import { renderForm } from "./compose-ui.js";
import { candidates, pairFor, previewOf, roleOf, type Pair, type Preview } from "./connect-ui.js";
import {
  parseLayout,
  viewOf,
  WHOLE_MODEL,
  withPositions,
  writeLayout,
  type Layout,
  type Point,
} from "../layout.js";
import { join, readTrace, resolve, type Selection, type SelectionId, type TraceEvent } from "../selection.js";

interface Sources {
  readonly files: readonly { readonly path: string; readonly source: string }[];
}

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no #${id} in the page`);
  return found as T;
};

const status = el("status");
const sidebar = el("sidebar");
const problems = el("problems");
const problemsText = el<HTMLPreElement>("problemsText");
const problemsCount = el("problemsCount");
const timeline = el("timeline");
const track = el("track");
const playhead = el("playhead");
const position = el("position");
const sequencePanel = el("sequence");
const sagaPanel = el("saga");
const sagaCanvas = el("sagaCanvas");
const sagaWhich = el<HTMLSelectElement>("sagaWhich");
const sagaState = el("sagaState");
const composePanel = el("compose");
const composeWhat = el<HTMLSelectElement>("composeWhat");
const composeState = el("composeState");
const composeOut = el<HTMLPreElement>("composeOut");
const propose = el("propose");
const proposeWhat = el("proposeWhat");
const proposeBody = el("proposeBody");
const proposeState = el("proposeState");
const proposeApply = el<HTMLButtonElement>("proposeApply");
const lensPicker = el<HTMLSelectElement>("lens");
const focusChip = el("focus");
const focusName = el("focusName");
const focusHops = el("focusHops");
const palette = el("palette");
const paletteInput = el<HTMLInputElement>("paletteInput");
const paletteList = el("paletteList");

let model: LinkedModel | undefined;
/** The whole graph, before any lens. Kept so a lens change needs no re-parse. */
let whole: Graph | undefined;
/** What is drawn: the whole graph through the current lens. */
let graph: Graph | undefined;
let view: Rendered | undefined;
let selection: Selection = { k: "none" };
let views: Views = {};
let lensProblems: readonly string[] = [];
let traceProblems: readonly string[] = [];
/** Transient, and never written anywhere: that is what makes it safe to be aggressive. */
let focus: Focus = NOT_FOCUSED;
/** Over the model, not the graph: a message is a label rather than a node, and people search for one. */
let index: readonly Entry[] = [];
let hits: readonly Hit[] = [];
let cursor = 0;
/** What the sources said, kept so a diagnostic can be shown with its line and column. */
let sourceOf = new Map<string, string>();
/** Errors open the panel once, by themselves. A warning count never does. */
let announcedErrors = false;
/** Kept so a problem found later — a failed layout write — can be reported beside the rest. */
let lastDiagnostics: readonly Diagnostic[] = [];
/** The sources as read, and the trees they parsed to: what a mutation is computed against. */
let sources: Readonly<Record<string, string>> = {};
let trees: ReadonlyMap<string, CstNode> = new Map();
/** Where a connection is being made from, while one is. */
let connectingFrom: SelectionId | undefined;
let proposal: Preview | undefined;
/** The trace, if one was given. Optional by design: the graph is worth drawing before anything has run. */
/** Every run the file holds. A file routinely holds several, and they cannot be played as one. */
let runs: readonly Run[] = [];
/** The run being replayed. */
let trace: readonly TraceEvent[] = [];
let player: Player | undefined;
let sequence: SequenceView | undefined;
let sagaView: SagaView | undefined;
/** The saga the drawer is showing. The drawer draws one at a time; the picker chooses which. */
let openSaga: SagaIr | undefined;
let layout: Layout = {};
let layoutProblems: readonly string[] = [];
let forms: Forms = {};
let formProblems: readonly string[] = [];
/** The form being filled in, and the payload being built. Reset when the declaration changes. */
let composing: Form | undefined;
let payload: Record<string, import("@sevenk/core").JsonValue> = {};

const EVERYTHING_LABEL = "everything";

const optionsFromForm = (): GraphOptions => ({
  packages: el<HTMLInputElement>("packages").checked,
  deadLetters: el<HTMLInputElement>("dead").checked,
});

const currentLens = (): Lens => views[lensPicker.value] ?? EVERYTHING;

/** A row that selects something else: the second hop of a two-hop question. */
function row(label: string, id: SelectionId | undefined): HTMLElement {
  const li = document.createElement("li");
  if (id === undefined) {
    li.textContent = label;
    return li;
  }
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", () => select(id));
  li.append(button);
  return li;
}

function section(heading: string, rows: readonly HTMLElement[]): HTMLElement[] {
  if (rows.length === 0) return [];
  const h = document.createElement("h3");
  h.textContent = heading;
  const ul = document.createElement("ul");
  ul.append(...rows);
  return [h, ul];
}

const bare = (qname: string): string => qname.slice(qname.lastIndexOf(".") + 1);

/**
 * The sidebar: what the model says, and where you can go from here.
 *
 * A navigator rather than a property dump. The graph is bipartite — "what talks to OrderService" is
 * deliberately a two-hop question — so this is where the second hop should be a click rather than a
 * visual hunt.
 */
function describe(id: SelectionId | undefined): void {
  if (id === undefined || graph === undefined) {
    sidebar.classList.remove("open");
    sidebar.replaceChildren();
    return;
  }

  const node = nodeFor(graph, id);
  const edge = graph.edges.find((e) => e.id === id);

  // A declaration the graph does not draw — a message, which is an edge label; a record or a value,
  // which the graph has no place for at all. Search can reach these, so the sidebar has to answer for
  // them rather than silently closing.
  if (node === undefined && edge === undefined) {
    const entry = index.find((candidate) => candidate.id === id);
    if (entry === undefined) {
      sidebar.classList.remove("open");
      return;
    }

    const heading = document.createElement("h2");
    heading.textContent = entry.qname;

    const facts = document.createElement("dl");
    const dt = document.createElement("dt");
    dt.textContent = "kind";
    const dd = document.createElement("dd");
    dd.textContent = entry.kind;
    facts.append(dt, dd);

    // For a message, the edges carrying it are the useful thing, and they are where you can go next.
    const carrying = graph.edges.filter((e) => e.messageIds.includes(id));
    const parts =
      carrying.length > 0
        ? section(
            "carried on",
            carrying.map((e) =>
              row(
                `${bare(nodeFor(graph!, e.from)?.qname ?? e.from)} → ${bare(nodeFor(graph!, e.to)?.qname ?? e.to)}`,
                e.direction === "emits" ? e.to : e.from,
              ),
            ),
          )
        : section("not drawn", [
            row(
              entry.kind === "message"
                ? "nothing in view carries it"
                : "the graph draws services and pipes",
              undefined,
            ),
          ]);

    sidebar.replaceChildren(heading, facts, ...parts);
    sidebar.classList.add("open");
    return;
  }

  const heading = document.createElement("h2");
  heading.textContent = node === undefined ? (edge!.subscription ?? edge!.direction) : node.qname;

  const facts: [string, string][] = [];
  const parts: HTMLElement[] = [];

  if (edge !== undefined) {
    facts.push(["kind", edge.direction]);
    if (edge.subscription !== undefined) facts.push(["subscription", edge.subscription]);
    parts.push(
      ...section(
        "messages",
        edge.messages.map((m, i) => row(m, edge.messageIds[i])),
      ),
    );
  } else if (node !== undefined && node.kind === "port") {
    // A port's whole content is what it is standing in for. Naming it here, rather than on the node,
    // is what lets the node stay an aggregate without the names being lost.
    facts.push(["kind", "outside the lens"]);
    parts.push(...section("hidden", (node.hidden ?? []).map((h) => row(h, undefined))));
  } else if (node !== undefined) {
    facts.push(["kind", node.kind]);
    if (node.pipeKind !== undefined) facts.push(["pipe", node.pipeKind]);
    if (node.delivery !== undefined) facts.push(["delivery", node.delivery]);
    if (node.boundary === true) facts.push(["boundary", "crosses the system boundary"]);
    if (node.labels.length > 0) facts.push(["labels", node.labels.join(", ")]);
    if (node.annotations.length > 0) facts.push(["annotations", node.annotations.join(", ")]);

    const out = graph.edges.filter((e) => e.from === id);
    const into = graph.edges.filter((e) => e.to === id);
    const other = (e: { from: SelectionId; to: SelectionId }): SelectionId =>
      e.from === id ? e.to : e.from;

    if (node.kind === "service" || node.kind === "external") {
      parts.push(
        ...section(
          "emits",
          out.map((e) => row(`${e.messages.map(bare).join(", ")} → ${bare(nodeFor(graph!, other(e))?.qname ?? other(e))}`, other(e))),
        ),
        ...section(
          "reacts",
          into.map((e) => row(`${e.messages.map(bare).join(", ")} ← ${bare(nodeFor(graph!, other(e))?.qname ?? other(e))}`, other(e))),
        ),
      );
    } else {
      parts.push(
        ...section(
          "producers",
          into.map((e) => row(bare(nodeFor(graph!, other(e))?.qname ?? other(e)), other(e))),
        ),
        ...section(
          "consumers",
          out.map((e) => row(bare(nodeFor(graph!, other(e))?.qname ?? other(e)), other(e))),
        ),
      );
    }
  }

  const list = document.createElement("dl");
  for (const [key, value] of facts) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }

  sidebar.replaceChildren(heading, list, ...parts);
  sidebar.classList.add("open");
}

function select(id: SelectionId | undefined): void {
  // While a connection is being made, a click is the gesture rather than a selection.
  if (connecting() && id !== undefined && graph !== undefined) {
    const node = nodeFor(graph, id);
    if (node !== undefined && roleOf(node) !== undefined) {
      if (connectingFrom === undefined) {
        connectingFrom = id;
        status.textContent = `from ${node.label} — now click the other end`;
        return;
      }
      proposeConnection(id);
      return;
    }
  }

  // A port is not a declaration, so it cannot be a `declaration` selection — but it is worth opening
  // the sidebar for, because what it hides is the only thing it has to say.
  selection = id === undefined || isPort(id) ? { k: "none" } : { k: "declaration", id };
  applyHighlight();
  describe(id);

  // A saga is the one declaration with a picture of its own, and nothing in the graph draws it — so
  // selecting one opens the view that does. This is the only way most people will find it.
  const asSaga = model === undefined || id === undefined ? undefined : sagaById(model, id);
  if (asSaga !== undefined) {
    showSaga(asSaga);
    toggleSaga(true);
  }
}

/** Focuses on one node. A port stands for what is already out of view, so it is not a thing to focus. */
function focusOnId(id: SelectionId): void {
  if (isPort(id)) return;
  focus = { seeds: [id], radius: focus.radius };
  select(id);
  redraw();
}

/** Toggles the focus on whatever is selected. */
function toggleFocus(): void {
  if (isFocused(focus)) {
    focus = { seeds: [], radius: focus.radius };
    redraw();
    return;
  }
  if (selection.k === "declaration") focusOnId(selection.id);
}

function setRadius(by: number): void {
  if (!isFocused(focus)) return;
  // One hop is useful from a pipe and useless from a service, so one is the floor rather than zero:
  // a focus showing a single node with ports on every side answers nothing.
  focus = { ...focus, radius: Math.min(8, Math.max(1, focus.radius + by)) };
  redraw();
}

// ---- replay ----------------------------------------------------------------

/** Draws the track: one tick per event, in **virtual** time, with the gaps at their true size. */
function drawTrack(): void {
  const at = positions(trace);
  const beats = player?.beats ?? [];
  const shown = player?.at ?? -1;

  track.replaceChildren(playhead);
  at.forEach((fraction, i) => {
    const tick = document.createElement("div");
    tick.className = "tick";
    if (beats[i]?.gap === true) tick.classList.add("gap");
    if (i <= shown) tick.classList.add("done");
    tick.style.left = `${(fraction * 100).toFixed(3)}%`;
    track.append(tick);
  });

  playhead.style.left = `${((at[Math.max(0, shown)] ?? 0) * 100).toFixed(3)}%`;
  playhead.hidden = shown < 0;
}


// ---- the saga view ---------------------------------------------------------

/**
 * Fills the saga picker, and hides the whole affordance when the model declares no saga.
 *
 * A button that opens an empty drawer is worse than no button: it reads as something being broken
 * rather than as something not being there.
 */
function fillSagas(): void {
  const sagas = model === undefined ? [] : sagasOf(model);
  const chosen = sagaWhich.value;
  sagaWhich.replaceChildren();
  for (const saga of sagas) {
    const option = document.createElement("option");
    option.value = qualify(saga.id);
    option.textContent = saga.id.name;
    sagaWhich.append(option);
  }
  el("toggleSaga").hidden = sagas.length === 0;
  if (sagas.length === 0) {
    openSaga = undefined;
    sagaView?.destroy();
    sagaView = undefined;
    toggleSaga(false);
    return;
  }

  // A reload keeps the saga you were reading, unless it has gone.
  const keep = sagas.find((x) => qualify(x.id) === chosen) ?? sagas[0]!;
  sagaWhich.value = qualify(keep.id);
  if (openSaga !== undefined || !sagaPanel.hidden) showSaga(keep);
}

/** Draws one saga, creating the view on first use. */
function showSaga(saga: SagaIr): void {
  if (model === undefined) return;
  openSaga = saga;
  sagaWhich.value = qualify(saga.id);

  if (sagaView === undefined) {
    sagaView = renderSaga(sagaCanvas, model, saga, {
      // Clicking a message in the diagram selects it everywhere else, which is the whole of what
      // "three views that agree" means here (`docs/design.md` 2.2).
      onSelect: (id) => select(id),
    });
  } else {
    sagaView.update(saga);
  }
  applyHighlight();
  refreshSagaProgress();
}

/**
 * The instance of a saga the view is currently about.
 *
 * An explicit `instance` selection wins. Otherwise it is the most recent instance of this saga at or
 * before the playhead — "the one you are looking at" — found by walking back rather than forward,
 * because a trace holding several instances should follow the replay rather than pin the first.
 */
function instanceKey(saga: SagaIr): string | undefined {
  const qname = qualify(saga.id);
  if (selection.k === "instance" && selection.saga === qname) return selection.key;

  const upto = player === undefined ? trace.length : player.at + 1;
  for (let i = upto - 1; i >= 0; i--) {
    const event = trace[i]!;
    if (event.saga === qname && event.sagaKey !== undefined) return event.sagaKey;
  }
  return undefined;
}

/**
 * Draws one instance's progress over the declaration, as far as the playhead has got.
 *
 * Sliced at the playhead rather than reading the whole trace, so scrubbing the transport fills the
 * saga in stage by stage. With no trace, or before playback has reached this saga, the diagram is the
 * declaration and says so — a picture that implied a run nobody had played would be the one dishonest
 * thing this view could do.
 */
function refreshSagaProgress(): void {
  if (sagaView === undefined || openSaga === undefined) return;

  const key = trace.length === 0 ? undefined : instanceKey(openSaga);
  const upto = player === undefined ? trace : trace.slice(0, player.at + 1);
  const progress = key === undefined ? undefined : progressOf(openSaga, upto, key);

  sagaView.progress(progress);
  if (progress === undefined) {
    sagaState.textContent = "declaration";
    return;
  }
  const where =
    progress.terminal ?? (progress.waiting.length === 0 ? "started" : progress.waiting.join(" + "));
  sagaState.textContent = `${progress.key} · ${where}`;
}

/** Opens or closes the saga drawer. One drawer at a time, as with the other two. */
function toggleSaga(force?: boolean): void {
  const open = force ?? sagaPanel.hidden;
  sagaPanel.hidden = !open;
  document.body.classList.toggle("saga-open", open);
  if (!open) return;

  toggleSequence(false);
  toggleCompose(false);
  // Opening with nothing chosen shows whichever saga the picker is on, or the selected one.
  const wanted =
    (model !== undefined && selection.k === "declaration" ? sagaById(model, selection.id) : undefined) ??
    openSaga ??
    (model === undefined ? undefined : sagasOf(model)[0]);
  if (wanted !== undefined) showSaga(wanted);
}

/**
 * Opens or closes the sequence drawer.
 *
 * A drawer rather than a pane, because the graph is the view you keep and the sequence is the one you open
 * when a trace is the question (`docs/design.md` 6.1). The graph is not re-laid out, so nothing moves
 * underneath — only the viewport is squeezed.
 */
function toggleSequence(force?: boolean): void {
  const open = force ?? sequencePanel.hidden;
  sequencePanel.hidden = !open;
  document.body.classList.toggle("sequence-open", open);
  if (open) {
    toggleCompose(false);
    toggleSaga(false);
    sequence?.update(trace);
    applyHighlight();
    sequence?.cursor(cursorKey());
  }
}

/** The `(run, seq)` of the event playback has reached, if any. */
function cursorKey(): string | undefined {
  const at = player?.at ?? -1;
  const event = at >= 0 ? trace[at] : undefined;
  return event === undefined ? undefined : `${event.run}\u0000${event.seq}`;
}

/**
 * Pushes the current selection to every view.
 *
 * One `resolve`, and each view renders what it is handed — which is the whole of what D25's "selecting in
 * one highlights in all three" turned out to mean, and why there was never a second resolver to keep in
 * step (`docs/design.md` 2.2).
 */
function applyHighlight(): void {
  if (model === undefined) return;
  const highlight = resolve(join(model, trace), selection);
  view?.highlight(highlight);
  sequence?.highlight(highlight);
  sagaView?.highlight(highlight);
}

function refreshTransport(): void {
  if (player === undefined) return;
  el("playPause").textContent = player.playing ? "\u23F8" : "\u25B6";
  const shown = player.at;
  const event = shown >= 0 ? trace[shown] : undefined;
  position.textContent =
    event === undefined
      ? `0 / ${trace.length}`
      : `${shown + 1} / ${trace.length}  ${event.kind}`;
  drawTrack();
  sequence?.cursor(cursorKey());
  refreshSagaProgress();
}

/**
 * Shows one trace event: the message going along its edge, and the declarations it touched lit up.
 *
 * An event with no edge — a saga step, a schedule firing, the clock moving — still highlights what it
 * touched. There is simply nothing travelling, which is the truth about it.
 */
function showEvent(event: TraceEvent): void {
  if (graph === undefined || model === undefined || view === undefined) return;

  const edge = edgeForEvent(graph, event);
  if (edge !== undefined) {
    view.send({
      edge: edge.id,
      durationMs: 360,
      ...(isBadEvent(event.kind) ? { bad: true } : {}),
    });
  }

  // The same `resolve` every view uses, so what lights up during a replay is what would light up if you
  // had clicked the thing yourself — in the graph and in the sequence at once.
  selection = { k: "event", run: event.run, seq: event.seq };
  applyHighlight();
}

function fillRuns(): void {
  const picker = el<HTMLSelectElement>("run");
  // Hidden for a single run, because a picker with one option is furniture.
  picker.hidden = runs.length < 2;
  if (picker.hidden) return;

  const chosen = picker.value;
  picker.replaceChildren();
  for (const { run, events } of runs) {
    const option = document.createElement("option");
    option.value = run;
    option.textContent = `${run}  (${events.length})`;
    picker.append(option);
  }
  picker.value = runs.some((r) => r.run === chosen) ? chosen : (runs[0]?.run ?? "");
}

function selectRun(name?: string): void {
  const wanted = name ?? el<HTMLSelectElement>("run").value;
  trace = runs.find((r) => r.run === wanted)?.events ?? runs[0]?.events ?? [];
  makePlayer();
}

function makePlayer(): void {
  player?.dispose();
  view?.clearSends();
  if (trace.length === 0) {
    player = undefined;
    sequence?.destroy();
    sequence = undefined;
    timeline.hidden = true;
    el("toggleSequence").hidden = true;
    toggleSequence(false);
    // The saga drawer stays: a declaration is worth reading before anything has run. It just has no
    // run to draw over it any more.
    refreshSagaProgress();
    return;
  }
  player = createPlayer(trace, { onEvent: showEvent, onChange: refreshTransport });
  timeline.hidden = false;
  el("toggleSequence").hidden = false;

  sequence?.destroy();
  sequence = renderSequence(sequencePanel, trace, {
    // Clicking a row selects that event, which highlights it in the graph as well — the linkage is just
    // one selection resolved once.
    onEvent: (key) => {
      const at = trace.findIndex((e) => `${e.run}\u0000${e.seq}` === key);
      if (at >= 0) player?.seek(at);
    },
    // And a lane heading selects the service or pipe it names, which is the graph's own currency.
    onLane: (id) => select(id),
  });
  if (!sequencePanel.hidden) sequence.update(trace);

  refreshTransport();
  refreshSagaProgress();
}

// ---- compose ---------------------------------------------------------------

function fillComposable(): void {
  if (model === undefined) return;
  const chosen = composeWhat.value;
  composeWhat.replaceChildren();
  for (const decl of composable(model)) {
    const option = document.createElement("option");
    option.value = `${decl.id.kind}:${decl.id.pkg}.${decl.id.name}`;
    option.textContent = `${decl.id.kind} ${decl.id.name}`;
    composeWhat.append(option);
  }
  composeWhat.value = [...composeWhat.options].some((o) => o.value === chosen)
    ? chosen
    : (composeWhat.options[0]?.value ?? "");
}

/** Validates what has been typed and redraws the form, so every problem sits beside its own field. */
function recheck(): void {
  if (model === undefined || composing === undefined) return;

  const decl = model.decls.find(
    (d) => `${d.id.kind}:${d.id.pkg}.${d.id.name}` === composing!.id,
  );
  if (decl === undefined) return;

  const result = check(model, decl, payload);

  const byPath = new Map<string, string[]>();
  for (const problem of result.problems) {
    const at = problem.path === "(root)" ? "" : problem.path;
    byPath.set(at, [...(byPath.get(at) ?? []), problem.message]);
  }

  composeState.textContent =
    result.problems.length === 0
      ? "valid"
      : `${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}`;
  composeState.classList.toggle("good", result.problems.length === 0);
  composeState.classList.toggle("bad", result.problems.length > 0);

  // Canonical JSON only when it is valid, and whatever is wrong at the root otherwise — an invariant
  // reports against the record it is declared on, which is not any one field.
  composeOut.textContent =
    result.canonical ?? (byPath.get("")?.join("\n") ?? "fill in the fields above");

  renderForm(el("composeForm"), composing, payload, { problems: byPath, onChange: recheck });
}

function startComposing(): void {
  if (model === undefined) return;
  const decl = model.decls.find(
    (d) => `${d.id.kind}:${d.id.pkg}.${d.id.name}` === composeWhat.value,
  );
  if (decl === undefined) return;
  composing = formOf(model, decl, forms);
  // Blank, not invented: a form filled with plausible values is one you stop reading.
  payload = blank(composing.fields);
  recheck();
}

function toggleCompose(force?: boolean): void {
  const open = force ?? composePanel.hidden;
  composePanel.hidden = !open;
  document.body.classList.toggle("compose-open", open);
  if (open) {
    // One drawer at a time: they all take the right-hand edge, and two would overlay each other.
    toggleSequence(false);
    toggleSaga(false);
    if (composing === undefined) startComposing();
    else recheck();
  }
}

// ---- connecting ------------------------------------------------------------

const editable = (): Editable | undefined =>
  model === undefined ? undefined : { model, trees, sources };

function armConnect(on?: boolean): void {
  const armed = on ?? connectingFrom === undefined;
  connectingFrom = undefined;
  document.body.classList.toggle("connecting", armed);
  el("connect").classList.toggle("armed", armed);
  if (armed) {
    status.textContent = "click a service, then a pipe — or a pipe, then a service";
  } else {
    redraw();
  }
}

const connecting = (): boolean => document.body.classList.contains("connecting");

/** The second click: works out the direction, then asks which message. */
function proposeConnection(to: SelectionId): void {
  if (graph === undefined || connectingFrom === undefined) return;
  const answer = pairFor(graph, connectingFrom, to);
  if ("problem" in answer) {
    // Said rather than shrugged at: two services is the thing a reader is most likely to try.
    status.textContent = answer.problem;
    status.classList.add("bad");
    connectingFrom = undefined;
    return;
  }
  status.classList.remove("bad");
  askWhichMessage(answer.pair);
}

function askWhichMessage(pair: Pair): void {
  if (graph === undefined) return;
  armConnect(false);

  const service = nodeFor(graph, pair.service)?.label ?? pair.service;
  const pipe = nodeFor(graph, pair.pipe)?.label ?? pair.pipe;
  proposeWhat.textContent =
    pair.direction === "emits" ? `${service} emits … to ${pipe}` : `${service} reacts … from ${pipe}`;

  const list = document.createElement("ul");
  for (const option of candidates(graph, pair)) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    if (option.onPipe) {
      const mark = document.createElement("span");
      mark.className = "onPipe";
      mark.textContent = "already on this pipe";
      button.append(mark);
    }
    button.addEventListener("click", () => buildProposal(pair, option.label));
    li.append(button);
    list.append(li);
  }

  const heading = document.createElement("div");
  heading.className = "where";
  heading.textContent = "which message?";
  proposeBody.replaceChildren(heading, list);
  proposeState.textContent = "";
  proposeApply.hidden = true;
  propose.hidden = false;
}

/** The preview. Nothing is written until this is accepted (`20-ir.md` 7). */
function buildProposal(pair: Pair, message: string): void {
  const where = editable();
  if (where === undefined || graph === undefined) return;

  const service = nodeFor(graph, pair.service)?.qname ?? pair.service;
  const pipe = nodeFor(graph, pair.pipe)?.qname ?? pair.pipe;
  const what = { service, message, pipe };
  const mutation: Mutation =
    pair.direction === "emits" ? connectEmit(where, what) : connectReact(where, what);

  proposeWhat.textContent = mutation.describe;

  if (mutation.edits.length === 0) {
    proposeBody.replaceChildren();
    const why = document.createElement("div");
    why.className = "why";
    why.textContent = mutation.diagnostics.map((d) => d.message).join("\n") || "nothing to do";
    proposeBody.append(why);
    proposeState.textContent = "";
    proposeApply.hidden = true;
    proposal = undefined;
    return;
  }

  const applied = applyAll(sources, mutation.edits);
  proposal = previewOf(mutation, sources, applied);

  proposeBody.replaceChildren();
  for (const show of proposal.shows) {
    const where2 = document.createElement("div");
    where2.className = "where";
    where2.textContent = `${show.removing ? "removing from" : "adding to"} ${show.file.replace(/\\/g, "/").split("/").pop() ?? show.file}`;
    const pre = document.createElement("pre");
    if (show.removing) pre.classList.add("removing");
    pre.textContent = show.text;
    proposeBody.append(where2, pre);
  }

  // A diagnostic that is not an error does not stop the write; it is said anyway, because an edit that
  // needs an import is still an edit somebody should know about.
  const errors = mutation.diagnostics.filter((d) => d.severity === "error");
  if (mutation.diagnostics.length > 0) {
    const why = document.createElement("div");
    why.className = "why";
    why.textContent = mutation.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n");
    proposeBody.append(why);
  }

  proposeState.textContent = isPossible(mutation) ? "" : "this cannot be written as it stands";
  proposeState.classList.toggle("bad", errors.length > 0);
  proposeApply.hidden = false;
  proposeApply.disabled = errors.length > 0;
  propose.hidden = false;
}

function closeProposal(): void {
  propose.hidden = true;
  proposal = undefined;
  connectingFrom = undefined;
}

/**
 * Writes it.
 *
 * The server refuses if a file changed since it was read, which is the only conflict left once Spider
 * holds no unsaved buffer (`20-ir.md` 7.1). A refusal is reported and the page reloads, so what is on
 * screen is what is on disk.
 */
async function applyProposal(): Promise<void> {
  if (proposal === undefined) return;
  const sending = proposal;
  closeProposal();

  try {
    const response = await fetch("/mutate", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: sending.files }),
    });
    if (!response.ok) {
      const body = (await response.json()) as { problem?: string };
      layoutProblems = [body.problem ?? `could not write: ${response.status}`];
    } else {
      layoutProblems = [];
    }
  } catch (cause) {
    layoutProblems = [`could not write: ${cause instanceof Error ? cause.message : ""}`];
  }

  // Either way: what is on screen should be what is on disk.
  await load();
}

// ---- search ----------------------------------------------------------------

const KIND_LABEL: Readonly<Record<string, string>> = {
  service: "service",
  pipe: "pipe",
  package: "package",
  message: "message",
  record: "record",
  envelope: "envelope",
  enum: "enum",
  value: "value",
  label: "label",
  saga: "saga",
  schedule: "schedule",
  upcast: "upcast",
};

function renderHits(): void {
  paletteList.replaceChildren();

  if (hits.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = paletteInput.value.trim() === "" ? "type a name, or a kind" : "nothing matches";
    paletteList.append(li);
    return;
  }

  hits.forEach((hit, i) => {
    const li = document.createElement("li");
    li.setAttribute("aria-selected", String(i === cursor));

    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = KIND_LABEL[hit.kind] ?? hit.kind;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = hit.name;

    const where = document.createElement("span");
    where.className = "where";
    where.textContent = hit.qname.slice(0, Math.max(0, hit.qname.length - hit.name.length - 1));

    li.append(kind, name, where);

    if (!hit.drawn) {
      const mark = document.createElement("span");
      mark.className = "hiddenMark";
      // Said rather than hidden: a result you cannot click to is still worth finding, and finding out
      // why you cannot is the point.
      mark.textContent = "not drawn";
      li.append(mark);
    }

    li.addEventListener("click", () => choose(i));
    paletteList.append(li);
  });

  paletteList.children[cursor]?.scrollIntoView({ block: "nearest" });
}

function refreshHits(): void {
  const drawn = new Set((graph?.nodes ?? []).map((n) => n.id));
  // Edges carry messages, which are not nodes — so a message counts as drawn when something carries it.
  for (const edge of graph?.edges ?? []) for (const id of edge.messageIds) drawn.add(id);
  hits = search(index, paletteInput.value, { drawn });
  cursor = 0;
  renderHits();
}

function openPalette(): void {
  palette.hidden = false;
  paletteInput.value = "";
  refreshHits();
  paletteInput.focus();
}

function closePalette(): void {
  palette.hidden = true;
  paletteInput.blur();
}

/** Takes the result under the cursor. */
function choose(at: number = cursor): void {
  const hit = hits[at];
  if (hit === undefined) return;
  closePalette();

  // A focus is transient and derived, so going somewhere else clears it rather than fighting it. The
  // lens is left alone: someone chose it, and silently discarding it would be worse than a dead end the
  // sidebar can explain.
  if (isFocused(focus)) {
    focus = { seeds: [], radius: focus.radius };
    redraw();
  }
  select(hit.id);
}

/** `sales.7k:38:3` — where a diagnostic is, which is most of what makes one actionable. */
function whereIs(d: Diagnostic): string {
  const source = sourceOf.get(d.span.file);
  const name = d.span.file.replace(/\\/g, "/").split("/").pop() ?? d.span.file;
  if (source === undefined) return name;
  const { line, col } = lineColOf(source, d.span.start);
  return `${name}:${line}:${col}`;
}

// ---- layout ----------------------------------------------------------------

/** Which view's positions are being used: the lens, or the whole model through no lens. */
const layoutView = (): string => (lensPicker.value === "" ? WHOLE_MODEL : lensPicker.value);

/**
 * Remembers where a node was dropped.
 *
 * The whole file is sent, because the page holds the whole file: it read it, changed some positions and
 * kept everything else — which is the only way a stale entry survives a drag (`20-ir.md` 6.2).
 *
 * A failed write is **said**, not swallowed. A drag that silently does not persist is worse than one that
 * was never offered.
 */
async function remember(positions: Readonly<Record<SelectionId, Point>>): Promise<void> {
  layout = withPositions(layout, layoutView(), positions);
  view?.setSaved(viewOf(layout, layoutView()).nodes);
  try {
    const response = await fetch("/layout.json", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: writeLayout(layout),
    });
    if (!response.ok) {
      layoutProblems = [`could not save the layout: ${response.status}`];
      report(lastDiagnostics, graph?.unresolved ?? []);
    } else if (layoutProblems.length > 0) {
      layoutProblems = [];
      report(lastDiagnostics, graph?.unresolved ?? []);
    }
  } catch (cause) {
    layoutProblems = [`could not save the layout: ${cause instanceof Error ? cause.message : ""}`];
    report(lastDiagnostics, graph?.unresolved ?? []);
  }
}

/**
 * Diagnostics are shown, never swallowed: a warning is usually the interesting part of a model.
 *
 * But shown as a **count** you cannot miss, with a panel you open. Six warnings on a clean model used to
 * mean the panel floated over the graph permanently, which trains you to ignore it — and a warning you
 * have learned to ignore is worse than one you have to click for.
 */
function report(diagnostics: readonly Diagnostic[], unresolved: readonly string[]): void {
  lastDiagnostics = diagnostics;
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  const lines = [
    ...errors.map((d) => `error    ${whereIs(d)}  ${d.code}: ${d.message}`),
    ...unresolved.map((u) => `unresolved  ${u}`),
    ...lensProblems.map((p) => `views.json  ${p}`),
    ...traceProblems.map((p) => `trace  ${p}`),
    ...formProblems.map((p) => `forms.json  ${p}`),
    ...layoutProblems.map((p) => `layout  ${p}`),
    ...warnings.map((d) => `warning  ${whereIs(d)}  ${d.code}: ${d.message}`),
  ];
  problemsText.textContent = lines.join("\n");

  const counts: string[] = [];
  if (errors.length > 0) counts.push(`${errors.length} error${errors.length === 1 ? "" : "s"}`);
  if (unresolved.length > 0) counts.push(`${unresolved.length} unresolved`);
  if (lensProblems.length > 0) counts.push(`${lensProblems.length} in views.json`);
  if (traceProblems.length > 0) counts.push(`${traceProblems.length} in the trace`);
  if (formProblems.length > 0) counts.push(`${formProblems.length} in forms.json`);
  if (layoutProblems.length > 0) counts.push(`${layoutProblems.length} saving the layout`);
  if (warnings.length > 0) counts.push(`${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);

  // "no problems" rather than nothing, for the same reason an empty loss profile is still written out in
  // a projected schema: an absence is a claim, and a reader should be able to tell it from a check that
  // never ran.
  problemsCount.textContent = counts.length === 0 ? "no problems" : counts.join(" · ");
  problemsCount.classList.toggle("errors", errors.length > 0);
  problemsCount.classList.toggle("clean", counts.length === 0);

  if (counts.length === 0) problems.classList.remove("open");

  // An error means names did not resolve, which is worth interrupting for — once. Re-announcing on every
  // keystroke while you are halfway through typing a name would be the opposite of helpful.
  if (errors.length > 0 && !announcedErrors) {
    problems.classList.add("open");
    announcedErrors = true;
  } else if (errors.length === 0) {
    announcedErrors = false;
  }
}

/** Re-applies the lens to the graph already built. No re-parse: a lens changes only what is drawn. */
function redraw(): void {
  if (whole === undefined) return;
  // Lens first, focus second: a focus narrows what the lens left, never the other way round.
  const lensed = resolveLens(whole, currentLens());
  graph = applyFocus(lensed, focus);

  focusChip.hidden = !isFocused(focus);
  if (isFocused(focus)) {
    const seed = focus.seeds[0] ?? "";
    focusName.textContent =
      (nodeFor(lensed, seed)?.qname ?? seed.slice(seed.indexOf(":") + 1)) +
      (focus.seeds.length > 1 ? ` +${focus.seeds.length - 1}` : "");
    focusHops.textContent = String(focus.radius);
  }

  const counts = [
    `${graph.nodes.filter((n) => n.kind === "service" || n.kind === "external").length} services`,
    `${graph.nodes.filter((n) => n.kind === "pipe").length} pipes`,
    `${graph.edges.length} edges`,
  ];
  const hidden = whole.nodes.length - graph.nodes.length;
  if (hidden > 0) counts.push(`${hidden} hidden`);
  status.textContent = counts.join(" · ");

  if (view === undefined) {
    view = renderGraph(el("graph"), graph, {
      onSelect: select,
      onFocus: focusOnId,
      onMoved: (positions) => void remember(positions),
      saved: viewOf(layout, layoutView()).nodes,
    });
  } else {
    view.setSaved(viewOf(layout, layoutView()).nodes);
    view.update(graph);
  }

  // A selection is an identity, so it survives this rebuild (`docs/design.md` 2.3) — which is the whole
  // reason it is an id and not a reference into a model that was just thrown away.
  if (selection.k === "declaration") select(selection.id);
}

function draw(read: Sources): void {
  sourceOf = new Map(read.files.map((f) => [f.path, f.source]));
  // The text a mutation is computed against. Named distinctly from the parameter, because shadowing it
  // left `sources` empty and every mutation would have been computed against nothing.
  sources = Object.fromEntries(read.files.map((f) => [f.path, f.source]));
  // Kept as the mutation API wants them: the text a mutation is computed against, and the trees it finds
  // its insertion points in.
  const ws = buildWorkspace(read.files.map((f) => ({ path: f.path, source: f.source })));
  trees = ws.trees;
  model = ws.model;
  index = buildIndex(ws.model);
  fillSagas();
  whole = buildGraph(ws.model, optionsFromForm());
  // The focus is an id too, so it survives this rebuild — and `applyFocus` shows everything rather
  // than nothing if the thing it names has gone.
  status.classList.toggle("bad", hasErrors(ws.diagnostics));
  redraw();
  report(ws.diagnostics, graph?.unresolved ?? []);
}

function fillLenses(): void {
  const chosen = lensPicker.value;
  lensPicker.replaceChildren();
  for (const name of [EVERYTHING_LABEL, ...Object.keys(views)]) {
    const option = document.createElement("option");
    option.value = name === EVERYTHING_LABEL ? "" : name;
    option.textContent = name;
    lensPicker.append(option);
  }
  // A saved lens that has since been deleted falls back to everything rather than to nothing.
  lensPicker.value = chosen in views ? chosen : "";
}

async function load(): Promise<void> {
  const [sourcesResponse, viewsResponse, traceResponse, formsResponse, layoutResponse] =
    await Promise.all([
    fetch("/sources.json"),
    fetch("/views.json"),
    fetch("/trace.ndjson"),
    fetch("/forms.json"),
    fetch("/layout.json"),
    ]);

  if (!sourcesResponse.ok) {
    status.textContent = `could not read the model: ${sourcesResponse.status}`;
    status.classList.add("bad");
    return;
  }

  if (viewsResponse.ok) {
    const body = (await viewsResponse.json()) as { views: unknown; problems: string[] };
    const parsed = parseViews(JSON.stringify(body.views));
    views = parsed.views;
    lensProblems = [...body.problems, ...parsed.problems];
    fillLenses();
  }

  // 204 means there is no trace, which is a state and not a failure.
  if (traceResponse.status === 200) {
    const { events, problems } = readTrace(await traceResponse.text());
    runs = runsOf(events);
    traceProblems = problems.map((p) => `line ${p.line ?? "?"}: ${p.message}`);
  } else {
    runs = [];
    traceProblems = [];
  }

  if (layoutResponse.ok) {
    const parsed = parseLayout(await layoutResponse.text());
    layout = parsed.layout;
    // A problem in the file is reported; it is never a reason to refuse to draw. The file is optional and
    // "deleting it loses saved positions and nothing else".
    layoutProblems = parsed.problems;
  }

  if (formsResponse.ok) {
    const parsed = parseForms(await formsResponse.text());
    forms = parsed.forms;
    formProblems = parsed.problems;
  }

  fillRuns();
  draw((await sourcesResponse.json()) as Sources);
  fillComposable();
  // A re-parse rebuilds the form against the new model, keeping whatever has been typed: the payload is
  // data, and only the declaration it is checked against changed.
  if (composing !== undefined) startComposing();
  selectRun();
}

lensPicker.addEventListener("change", redraw);
el("find").addEventListener("click", openPalette);
problemsCount.addEventListener("click", () => {
  if (problemsText.textContent !== "") problems.classList.toggle("open");
});
el("problemsClose").addEventListener("click", () => problems.classList.remove("open"));
paletteInput.addEventListener("input", refreshHits);
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
    cursor = Math.min(hits.length - 1, cursor + 1);
    renderHits();
    e.preventDefault();
  } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
    cursor = Math.max(0, cursor - 1);
    renderHits();
    e.preventDefault();
  } else if (e.key === "Enter") {
    choose();
    e.preventDefault();
  } else if (e.key === "Escape") {
    closePalette();
    e.preventDefault();
  }
});

el("toggleSequence").addEventListener("click", () => toggleSequence());
el("toggleSaga").addEventListener("click", () => toggleSaga());
el("sagaClose").addEventListener("click", () => toggleSaga(false));
sagaWhich.addEventListener("change", () => {
  const wanted = model === undefined ? undefined : sagasOf(model).find((x) => qualify(x.id) === sagaWhich.value);
  if (wanted !== undefined) showSaga(wanted);
});
el("toggleCompose").addEventListener("click", () => toggleCompose());
el("connect").addEventListener("click", () => armConnect());
el("proposeClose").addEventListener("click", closeProposal);
proposeApply.addEventListener("click", () => void applyProposal());
el("composeClose").addEventListener("click", () => toggleCompose(false));
composeWhat.addEventListener("change", startComposing);
el("run").addEventListener("change", () => selectRun());
el("playPause").addEventListener("click", () => player?.toggle());
el("stepOn").addEventListener("click", () => player?.step(1));
el("stepBack").addEventListener("click", () => player?.step(-1));
el<HTMLSelectElement>("speed").addEventListener("change", (e) => {
  player?.setSpeed(Number((e.target as HTMLSelectElement).value));
});
track.addEventListener("click", (e) => {
  if (player === undefined || trace.length === 0) return;
  const box = track.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
  // Seeking by *virtual* time, because that is what the track draws. Seeking by index would make a click
  // land somewhere other than where it was aimed.
  const at = positions(trace);
  let nearest = 0;
  for (let i = 1; i < at.length; i++) {
    if (Math.abs(at[i]! - fraction) < Math.abs(at[nearest]! - fraction)) nearest = i;
  }
  player.seek(nearest);
});

el("focusClear").addEventListener("click", toggleFocus);
el("focusIn").addEventListener("click", () => setRadius(1));
el("focusOut").addEventListener("click", () => setRadius(-1));
for (const id of ["packages", "dead"]) {
  el<HTMLInputElement>(id).addEventListener("change", () => {
    void load();
  });
}

document.addEventListener("keydown", (e) => {
  // Ctrl-K reaches the palette from anywhere, including from inside the palette, where it closes it.
  if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
    if (palette.hidden) openPalette();
    else closePalette();
    e.preventDefault();
    return;
  }

  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;

  // `/` as well, because it costs nothing and half the world's tools use it.
  if (e.key === "/") {
    openPalette();
    e.preventDefault();
    return;
  }

  // Escape undoes the most recent narrowing first: the focus, then the selection. A single key that
  // cleared both would make it impossible to keep a focus while looking at something inside it.
  if (e.key === "Escape") {
    // The most recent thing first, as everywhere else: a proposal, then a half-made connection, then the
    // focus, then the selection.
    if (!propose.hidden) {
      closeProposal();
      return;
    }
    if (connecting()) {
      armConnect(false);
      return;
    }
    if (isFocused(focus)) toggleFocus();
    else select(undefined);
    return;
  }
  if (e.key === "f" || e.key === "F") toggleFocus();
  if ((e.key === "s" || e.key === "S") && !el("toggleSequence").hidden) toggleSequence();
  if ((e.key === "g" || e.key === "G") && !el("toggleSaga").hidden) toggleSaga();
  if (e.key === "c" || e.key === "C") toggleCompose();
  if (e.key === "n" || e.key === "N") armConnect();
  if (e.key === " ") {
    player?.toggle();
    e.preventDefault();
  }
  if (e.key === "ArrowRight") player?.step(1);
  if (e.key === "ArrowLeft") player?.step(-1);
  if (e.key === "+" || e.key === "=") setRadius(1);
  if (e.key === "-" || e.key === "_") setRadius(-1);
});

void load();

// The server watches the files and says when one changed. Re-reading and redrawing is cheap, and the
// layout is deterministic, so an unchanged part of the model lands back where it was.
const events = new EventSource("/events");
events.addEventListener("changed", () => {
  void load();
});
