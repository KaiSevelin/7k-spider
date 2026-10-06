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
  addPipe,
  addService,
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
import { nodeFor, renderGraph, renderLegend, type Rendered } from "../render.js";
import { createPlayer, positions, runsOf, type Player, type Run } from "../play.js";
import { narrate } from "../narrate.js";
import { buildData, type DataOptions } from "../data.js";
import { renderData, type DataView } from "../data-view.js";
import { parseMarkdown } from "../markdown.js";
import { renderMarkdown } from "./markdown-ui.js";
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
import { refreshProblems, renderForm } from "./compose-ui.js";
import { renderCode, type CodeView } from "./code-ui.js";
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
import {
  idOf,
  join,
  readTrace,
  resolve,
  type Selection,
  type SelectionId,
  type TraceEvent,
} from "../selection.js";

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
/** Refusals and manifest faults from the last generation. Cleared by the next one, never by a redraw. */
let generateProblems: readonly string[] = [];
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
/**
 * Opens or closes the legend.
 *
 * Built on first open rather than at startup, because it is a second Cytoscape instance and most
 * sessions never ask for it — and because Cytoscape measures its container when it is created, so the
 * panel has to be showing before there is anything to measure.
 */
let legend: { destroy(): void } | undefined;

function toggleLegend(force?: boolean): void {
  const panel = el("legend");
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  if (!open) {
    legend?.destroy();
    legend = undefined;
    return;
  }
  legend ??= renderLegend(el("legendCanvas"));
}

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
  dataView?.highlight(highlight);
  // Scoped to the selection, so selecting elsewhere re-centres it rather than leaving a stale picture.
  if (!el("data").hidden) showData();
  // And the text marks and scrolls to the same declaration, which is what makes the flip a flip.
  showCodeSelection();
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
/**
 * The caption under the replay: what this event was, in words.
 *
 * A dot crossing an edge says that something travelled and nothing about what it was or how it went,
 * and the alternative to saying so is making the reader read the trace — which is what the replay is
 * for. Text rather than markup from `narrate`, so a trace someone else wrote cannot inject anything.
 */
function caption(event: TraceEvent | undefined): void {
  const box = el("narrative");
  if (event === undefined) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const { text, bad } = narrate(event);
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = event.kind;
  const said = document.createElement("span");
  said.textContent = text;
  box.replaceChildren(kind, said);
  box.classList.toggle("bad", bad);
  box.hidden = false;
}

function showEvent(event: TraceEvent): void {
  if (graph === undefined || model === undefined || view === undefined) return;

  const edge = edgeForEvent(graph, event);
  if (edge !== undefined) {
    view.send({
      edge: edge.id,
      durationMs: 520,
      ...(isBadEvent(event.kind) ? { bad: true } : {}),
    });
  }

  caption(event);

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
  caption(undefined);
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
  if (!el("data").hidden) showData();
}

// ---- what this model is ----------------------------------------------------

/**
 * The README beside the model, drawn in a drawer.
 *
 * Read with the rest of the model rather than on demand, because the button that opens it has to know
 * whether there is anything to open. A model with no prose beside it simply has no button, which is a
 * truer answer than a panel that turns out to be empty.
 */
function showReadme(found: { path: string; text: string } | undefined): void {
  const button = el("toggleAbout");
  button.hidden = found === undefined;
  if (found === undefined) {
    toggleAbout(false);
    el("aboutBody").replaceChildren();
    return;
  }
  el("aboutWhere").textContent = found.path;
  renderMarkdown(parseMarkdown(found.text), el("aboutBody"));
}

function toggleAbout(force?: boolean): void {
  const panel = el("about");
  const open = force ?? panel.hidden;
  // Nothing to show is nothing to open, however the request arrived.
  panel.hidden = !open || el("toggleAbout").hidden;
}

// ---- the data layer --------------------------------------------------------

/**
 * The fourth view.
 *
 * Its own canvas, because the graph is bipartite and that rule is load-bearing — a message is an edge
 * label there, never a node. What makes this worth having rather than a separate application is the
 * selection: click a record here and the pipes carrying it light up in the graph, because both views
 * resolve through the same `resolve` the sequence and saga already use.
 *
 * Scoped to the selection by default. The whole type graph of a real model is a hairball, and the
 * useful question is almost always "what is in this one, and what holds it".
 */
let dataView: DataView | undefined;

const dataDepth = (): number => Number(el<HTMLSelectElement>("dataDepth").value);

/** The kinds this view draws, which is the Contract layer and nothing else. */
const DATA_KINDS: ReadonlySet<string> = new Set(["message", "record", "value", "enum", "envelope"]);

/**
 * What the panel is looking around.
 *
 * The selection when it is one of these, and otherwise whatever the picker says. There has to be a
 * second answer, because without one this view fell back to drawing *everything* — which `data.ts`
 * opens by calling the fastest way to make it useless, and which is what it did every time somebody
 * opened the panel before clicking anything.
 */
function dataSubject(): SelectionId | undefined {
  if (selection.k === "declaration" && DATA_KINDS.has(selection.id.slice(0, selection.id.indexOf(":")))) {
    return selection.id;
  }
  const picked = el<HTMLSelectElement>("dataSubject").value;
  return picked === "" ? undefined : (picked as SelectionId);
}

/** Every declaration this view can be centred on, so the picker is the model's own list. */
function fillDataSubjects(): void {
  const picker = el<HTMLSelectElement>("dataSubject");
  const was = picker.value;
  picker.replaceChildren();
  if (model === undefined) return;

  const subjects = model.decls
    .filter((d) => DATA_KINDS.has(d.kind))
    .map((d) => ({ id: idOf(d), label: qualify(d.id), kind: d.kind }))
    .sort((a, b) => a.label.localeCompare(b.label));

  for (const s of subjects) {
    const option = document.createElement("option");
    option.value = s.id;
    option.textContent = `${s.label}`;
    option.title = `${s.kind} ${s.label}`;
    picker.append(option);
  }
  // Keep what was chosen if it survived the reload; otherwise start somewhere real rather than on an
  // empty panel, because a message and what it holds is what this view is for.
  picker.value = subjects.some((s) => s.id === was) ? was : (subjects[0]?.id ?? "");
}

function dataOptions(): DataOptions {
  const depth = dataDepth();
  // `0` means everything, which stays available and is deliberately not the default.
  if (depth === 0) return {};
  const around = dataSubject();
  return around === undefined ? {} : { around, depth };
}

function showData(): void {
  if (model === undefined || el("data").hidden) return;

  const built = buildData(model, dataOptions());
  // Named from the data graph, not the topology one: the graph draws no messages, so asking it for a
  // message label gets an id back.
  let scope = "everything";
  const around = dataDepth() === 0 ? undefined : dataSubject();
  if (around !== undefined) {
    scope = `around ${built.nodes.find((n) => n.id === around)?.label ?? around}`;
    // The picker follows the selection, so the two never say different things about one panel.
    const picker = el<HTMLSelectElement>("dataSubject");
    if (picker.value !== around) picker.value = around;
  }
  el("dataScope").textContent = scope;
  el("dataHidden").textContent = built.hidden === 0 ? "" : `${built.hidden} hidden`;

  if (dataView === undefined) {
    dataView = renderData(el("dataCanvas"), built, {
      onSelect: (id) => select(id),
      // A double tap re-centres the neighbourhood, which is how you walk a data model one hop at a time.
      onFocus: (id) => select(id),
      // The same menu as the graph's. This is the canvas where it pays off: a code provider writes
      // files for messages, records and values, which the graph does not draw.
      onContext: (at, where) => openMenu(at, where),
    });
  } else {
    dataView.update(built);
  }
  // The same `resolve` every other view uses, so what lights up here is what lights up there.
  dataView.highlight(resolve(join(model, trace), selection));
}

/** The text's own highlight, which is the selection like everything else. */
function showCodeSelection(): void {
  if (!showingCode()) return;
  codeView?.show(selection.k === "declaration" ? selection.id : undefined);
}

function toggleData(force?: boolean): void {
  const panel = el("data");
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  if (!open) {
    dataView?.destroy();
    dataView = undefined;
    return;
  }
  toggleSequence(false);
  toggleSaga(false);
  showData();
}

// ---- opening another model -------------------------------------------------

/**
 * Browsing for a model and opening it.
 *
 * The server does the reading and the re-pointing; this only asks. That is what keeps everything else
 * working across an open — the watcher, `layout.json`, `/mutate` — because none of them ever learn that
 * the model changed, only that the files did.
 */
let browsingAt: string | undefined;

async function browseTo(at?: string): Promise<void> {
  const state = el("openState");
  const list = el("openList");
  const where = el("openAt");
  const here = el<HTMLButtonElement>("openHere");

  state.textContent = "";
  state.classList.remove("bad");

  const response = await fetch(at === undefined ? "/browse" : `/browse?at=${encodeURIComponent(at)}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { problem?: string };
    state.textContent = body.problem ?? `could not read that: ${response.status}`;
    state.classList.add("bad");
    return;
  }

  const body = (await response.json()) as {
    at: string;
    parent?: string;
    here: { models: number; capped: boolean };
    entries: { name: string; path: string; models: number; capped: boolean }[];
  };
  browsingAt = body.at;
  where.textContent = body.at;

  const count = (n: number, capped: boolean): string =>
    n === 0 ? (capped ? "none found yet" : "") : `${n}${capped ? "+" : ""} .7k`;

  const rows: HTMLElement[] = [];
  const row = (label: string, note: string, go: () => void, dim: boolean): void => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("empty", dim);
    const name = document.createElement("span");
    name.textContent = label;
    const tally = document.createElement("span");
    tally.className = "count";
    tally.textContent = note;
    button.append(name, tally);
    button.addEventListener("click", go);
    item.append(button);
    rows.push(item);
  };

  if (body.parent !== undefined) row("..", "", () => void browseTo(body.parent), true);
  for (const entry of body.entries) {
    row(`${entry.name}/`, count(entry.models, entry.capped), () => void browseTo(entry.path), entry.models === 0);
  }
  list.replaceChildren(...rows);

  here.textContent = body.here.models === 0 ? "no models here" : `open this folder (${body.here.models})`;
  here.disabled = body.here.models === 0;
}

async function openHere(): Promise<void> {
  if (browsingAt === undefined) return;
  const state = el("openState");
  state.textContent = "opening…";
  state.classList.remove("bad");

  const response = await fetch("/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: [browsingAt] }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { problem?: string };
    state.textContent = body.problem ?? `could not open that: ${response.status}`;
    state.classList.add("bad");
    return;
  }
  // The server announces the change and the page reloads off that, exactly as for a file changing on
  // disk — so there is nothing to do here but get out of the way.
  toggleOpen(false);
}

function toggleOpen(force?: boolean): void {
  const panel = el("open");
  const open = force ?? panel.hidden;
  panel.hidden = !open;
  if (!open) return;
  // Always re-browsed: the disk may have moved on since this was last looked at.
  void browseTo(browsingAt);
}

// ---- generating ------------------------------------------------------------

/**
 * The right-click menu.
 *
 * Three gestures, which is the whole feature: the background means the system, a node means that node,
 * and a node that is one of several marked means all of them. Marking is Ctrl, Cmd or Shift and a click,
 * and it is deliberately not the same thing as selecting — the selection drives the sidebar and the
 * sequence, and teaching those to mean "possibly several" would have changed every view that reads it.
 */
interface ProviderInfo {
  readonly name: string;
  readonly target: string;
  readonly layouts: readonly string[];
  /** The declaration kinds it emits for, as the provider itself declares them. */
  readonly emits: readonly string[];
}

let providers: readonly ProviderInfo[] = [];

async function loadProviders(): Promise<void> {
  const response = await fetch("/providers");
  if (!response.ok) return;
  const body = (await response.json()) as { providers: ProviderInfo[]; problems: string[] };
  providers = body.providers;
  if (body.problems.length > 0) {
    generateProblems = body.problems;
    report(lastDiagnostics, graph?.unresolved ?? []);
  }
}

function closeMenu(): void {
  el("menu").hidden = true;
}

/** What a menu item will generate, and how to say it in a heading. */
/**
 * A declaration's qualified name from its selection id.
 *
 * The graph knows it for what the graph draws, which is services and pipes. For a message or a record
 * it does not, and the id is `message:shop.orders.PlaceOrder` rather than a qualified name — so
 * falling back to it whole would send `any:message:shop.orders.PlaceOrder` to the run, which matches
 * nothing and would make every generation from the data view silently empty.
 */
function qnameOf(id: SelectionId): string {
  const drawn = whole === undefined ? undefined : nodeFor(whole, id)?.qname;
  if (drawn !== undefined) return drawn;
  const at = id.indexOf(":");
  return at < 0 ? id : id.slice(at + 1);
}

function scopeOf(at: { id?: SelectionId; marked: readonly SelectionId[] }): {
  only: string[];
  label: string;
} {
  const qname = qnameOf;

  if (at.id !== undefined && at.marked.length > 1 && at.marked.includes(at.id)) {
    return { only: at.marked.map(qname), label: `${at.marked.length} marked` };
  }
  if (at.id !== undefined) return { only: [qname(at.id)], label: qname(at.id) };
  return { only: [], label: "the whole system" };
}

function openMenu(
  at: { id?: SelectionId; marked: readonly SelectionId[] },
  where: { x: number; y: number },
): void {
  const menu = el("menu");
  const { only, label } = scopeOf(at);

  const heading = document.createElement("header");
  heading.textContent = label;
  const rows: HTMLElement[] = [heading];

  if (providers.length === 0) {
    const empty = document.createElement("i");
    // A model with no `.7k/build.json` is a model nobody has asked to generate yet, which is a state
    // rather than a fault.
    empty.textContent = "no providers registered in .7k/build.json";
    rows.push(empty);
  }

  // Why nothing can be generated, if nothing can. The providers are still listed when there is one:
  // which targets a model has is worth knowing even when none of them can run just now, and a row
  // that says why is better than a row that looks ready and then does nothing.
  const blocked = cannotGenerate();

  // What is selected, by kind, so a provider that emits for none of it can say so. Empty for the
  // whole system, which no provider can be excluded from.
  const chosen = kindsOf(at);

  const why = (provider: ProviderInfo): string | undefined =>
    blocked ?? (emitsForAny(provider, chosen) ? undefined : `nothing to generate from ${sayKinds(chosen)}`);

  for (const provider of providers) {
    rows.push(
      item(
        `generate ${provider.name}`,
        provider.target,
        () => void generate(only, label, provider.name),
        why(provider),
      ),
    );
  }
  if (providers.length > 1) {
    // Live while *any* provider would produce something, because that is what it does.
    const none = providers.every((p) => why(p) !== undefined);
    rows.push(
      item(
        "generate everything",
        "every provider in the manifest",
        () => void generate(only, label),
        none ? (blocked ?? `nothing to generate from ${sayKinds(chosen)}`) : undefined,
      ),
    );
  }

  menu.replaceChildren(...rows);
  menu.hidden = false;
  // Placed after it is shown, because clamping it to the window needs its size.
  const box = menu.getBoundingClientRect();
  // `#menu` is positioned within `main`, and `where` is on the page, so the two have to be reconciled.
  const main = (el("graph").parentElement ?? el("graph")).getBoundingClientRect();
  const x = where.x - main.left;
  const y = where.y - main.top;
  menu.style.left = `${Math.max(0, Math.min(x, main.width - box.width - 8))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, main.height - box.height - 8))}px`;
}

/**
 * Why generating would produce nothing, or `undefined` when it would not.
 *
 * Only what is known here for certain. A model with an error is refused by the run itself — `planFor`
 * answers "the model does not check out, so nothing was generated" before a provider is asked — so
 * offering it as a live choice is offering something that cannot happen.
 *
 * What this deliberately does *not* try to know is whether a particular provider emits anything for a
 * particular selection. Only the provider knows that, finding out costs a whole plan, and a menu that
 * went away to ask would either be slow or grey a row after the pointer was already on it. That case
 * stays where it is: the run says `nothing to generate — no provider emits for it`, after the fact and
 * in one line.
 */
/**
 * The kinds of declaration a right click has in hand.
 *
 * Empty means the whole system, which is not the same as nothing: every provider emits for something
 * somewhere in a model, so there is nothing to exclude.
 */
function kindsOf(at: { id?: SelectionId; marked: readonly SelectionId[] }): Set<string> {
  const ids =
    at.id !== undefined && at.marked.length > 1 && at.marked.includes(at.id)
      ? at.marked
      : at.id === undefined
        ? []
        : [at.id];

  const kinds = new Set<string>();
  for (const id of ids) {
    const found = model?.decls.find((d) => qualify(d.id) === qnameOf(id));
    // The id carries its own kind for anything the graph did not draw, which is the data view's rows.
    if (found !== undefined) kinds.add(found.kind);
    else {
      const at2 = id.indexOf(":");
      if (at2 > 0) kinds.add(id.slice(0, at2));
    }
  }
  return kinds;
}

/** Whether a provider emits for anything in hand. The whole system always counts. */
const emitsForAny = (provider: ProviderInfo, kinds: ReadonlySet<string>): boolean =>
  kinds.size === 0 || [...kinds].some((k) => provider.emits.includes(k));

const sayKinds = (kinds: ReadonlySet<string>): string => {
  const all = [...kinds].sort();
  if (all.length === 0) return "this";
  if (all.length === 1) return `a ${all[0]!}`;
  if (all.length === 2) return `a ${all[0]!} and a ${all[1]!}`;
  return `${all.slice(0, -1).join(", ")} and ${all.at(-1)!}`;
};

function cannotGenerate(): string | undefined {
  if (lastDiagnostics.some((d) => d.severity === "error")) return "the model does not check out";
  return undefined;
}

function item(label: string, hint: string, go: () => void, blocked?: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  const name = document.createElement("span");
  name.textContent = label;
  const note = document.createElement("i");
  // The reason replaces the hint rather than joining it: the hint says what the row would do, and
  // what it would do is no longer the thing worth reading.
  note.textContent = blocked ?? hint;
  button.append(name, note);
  if (blocked !== undefined) {
    button.disabled = true;
    return button;
  }
  button.addEventListener("click", () => {
    closeMenu();
    go();
  });
  return button;
}

/**
 * Plans and shows. There is no third step.
 *
 * `plan` touches no disk, which is the whole of what Spider does with a provider: the generated text
 * is something to read here and to write with `7k generate`, where the atomicity and the drift check
 * already live.
 */
async function generate(only: readonly string[], label: string, provider?: string): Promise<void> {
  status.textContent = `generating ${label}…`;
  const planned = await fetch("/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ only, ...(provider === undefined ? {} : { provider }) }),
  });
  const outcome = (await planned.json()) as Outcome;

  generateProblems = [
    ...outcome.problems,
    ...outcome.refusals.map((r) => `${r.provider} refused ${r.at}: ${r.declared} — ${r.because}`),
  ];
  report(lastDiagnostics, graph?.unresolved ?? []);

  if (outcome.files.length === 0 && outcome.refusals.length === 0 && outcome.problems.length === 0) {
    // A plan that succeeded and produced nothing is not a failure: no registered provider writes
    // anything for what was asked. Saying so is better than opening an empty preview.
    status.classList.remove("bad");
    status.textContent = `${label}: nothing to generate — no provider emits for it`;
    return;
  }

  status.classList.remove("bad");
  status.textContent = `${label}: ${outcome.files.length} file${outcome.files.length === 1 ? "" : "s"} to review`;
  openPreview(label, outcome);
}

/**
 * What a run would produce, as documents to read.
 *
 * **Spider shows generated code and never writes it.** `plan` is a pure function of the model, the
 * names and the options, so stopping at the plan costs nothing — and the alternative cost something
 * real: a write route on a long-lived local server is reachable by any page you have open, because
 * binding to loopback keeps other *machines* out and nothing else. `7k generate` is the writer, where
 * the atomicity, the drift check and `--check` already live.
 *
 * So this is the reading. One card per file, clamped to three rows until it is opened, and a header
 * carrying what the CLI prints and then throws away: the language, when it was generated, and — the
 * part nobody could see until now — the **losses**. Every provider declares what the model states that
 * its artifact cannot carry, and `plan` used to drop them. Beside the code is where they mean
 * something.
 */
interface Loss {
  readonly construct: string;
  readonly at: string;
  readonly fidelity: string;
  readonly detail: string;
}

interface Planned {
  readonly path: string;
  readonly content: string;
  readonly provider: string;
  readonly draft: boolean;
  /** The declarations it came from, qualified — provenance the provider reported. */
  readonly from: readonly string[];
  /** What the model states that this artifact does not carry. */
  readonly losses: readonly Loss[];
  /** How it compares with what is already on disk. */
  readonly freshness: "new" | "same" | "changed";
}

interface Refusal {
  readonly provider: string;
  readonly at: string;
  readonly declared: string;
  readonly because: string;
}

interface Outcome {
  readonly ok: boolean;
  readonly files: readonly Planned[];
  readonly drift: Readonly<Record<"new" | "same" | "changed", number>>;
  readonly refusals: readonly Refusal[];
  readonly problems: readonly string[];
}

function closePreview(): void {
  el("preview").hidden = true;
}

/**
 * What a file is written in, by its extension.
 *
 * The provider's own `target` says "C# 12 / .NET 8", which is right for the provider and wrong for the
 * README it also emits. The extension is what the file is.
 */
const LANGUAGES: Readonly<Record<string, string>> = {
  cs: "C#",
  sql: "T-SQL",
  bicep: "Bicep",
  bicepparam: "Bicep parameters",
  json: "JSON",
  ps1: "PowerShell",
  sh: "Shell",
  md: "Markdown",
  yaml: "YAML",
  yml: "YAML",
  ts: "TypeScript",
  tf: "Terraform",
  "7k": "7K",
};

export const languageOf = (path: string): string => {
  const at = path.lastIndexOf(".");
  const extension = at < 0 ? "" : path.slice(at + 1).toLowerCase();
  return LANGUAGES[extension] ?? (extension === "" ? "text" : extension);
};

const clock = (at: Date): string =>
  [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");

/**
 * An icon that is there only when it has something to say.
 *
 * Which makes its absence information: a card with no warning triangle has no losses, and that is
 * worth being able to see at a glance across a list of thirty files.
 */
function iconFor(
  into: HTMLElement,
  card: HTMLElement,
  label: string,
  title: string,
  tone: "loss" | "bad",
  detail: string,
): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon ${tone}`;
  button.textContent = label;
  button.title = title;

  const block = document.createElement("p");
  block.className = "detail";
  block.textContent = detail;
  block.hidden = true;

  button.addEventListener("click", (event) => {
    // Without this the click would also reach the card and toggle the code open.
    event.stopPropagation();
    block.hidden = !block.hidden;
    button.classList.toggle("on", !block.hidden);
  });

  into.append(button);
  card.append(block);
}

const sayLoss = (loss: Loss): string =>
  `${loss.construct} — ${loss.at} (${loss.fidelity})\n    ${loss.detail}`;

const sayRefusal = (refusal: Refusal): string =>
  `${refusal.provider} refused ${refusal.at}\n    ${refusal.declared}\n    ${refusal.because}`;

/** A plain icon with no detail of its own: copy, dismiss. */
function actionFor(
  into: HTMLElement,
  label: string,
  title: string,
  run: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon";
  button.textContent = label;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    run();
  });
  into.append(button);
  return button;
}

/** One file, as a card: a header of facts and icons, and the code under it. */
function documentCard(file: Planned, at: Date, refusals: readonly Refusal[]): HTMLElement {
  const card = document.createElement("li");
  card.className = "doc";
  card.classList.add(file.freshness);
  card.classList.toggle("draft", file.draft);

  const header = document.createElement("header");

  // Shut by default, and shut means the header alone: see `.doc pre` in `index.html`.
  const twisty = document.createElement("span");
  twisty.className = "twisty";
  twisty.setAttribute("aria-hidden", "true");
  header.append(twisty);

  const path = document.createElement("span");
  path.className = "path";
  path.textContent = file.path;
  path.title = file.path;
  header.append(path);

  const about = document.createElement("span");
  about.className = "about";
  // What it is, who made it, and when — the facts the CLI prints once and throws away.
  about.textContent = `${languageOf(file.path)} · ${file.provider} · ${clock(at)}`;
  header.append(about);

  if (file.freshness !== "new") {
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = file.freshness === "changed" ? "changed" : "unchanged";
    mark.title =
      file.freshness === "changed"
        ? "what is on disk differs from this"
        : "what is on disk is already this";
    header.append(mark);
  }

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  header.append(spacer);

  if (file.losses.length > 0) {
    iconFor(
      header,
      card,
      `⚠ ${file.losses.length}`,
      `${file.losses.length} thing${file.losses.length === 1 ? "" : "s"} the model states that this file does not carry`,
      "loss",
      file.losses.map(sayLoss).join("\n\n"),
    );
  }

  // A draft exists only because something was refused, so the refusal belongs on it.
  const mine = file.draft ? refusals.filter((r) => file.from.includes(r.at)) : [];
  if (mine.length > 0) {
    iconFor(
      header,
      card,
      `⨯ ${mine.length}`,
      "this file exists only to carry a refusal, and would not be written outside a draft",
      "bad",
      mine.map(sayRefusal).join("\n\n"),
    );
  }

  actionFor(header, "⧉", "copy this to the clipboard", () => {
    void navigator.clipboard.writeText(file.content).then(
      () => {
        status.classList.remove("bad");
        status.textContent = `copied ${file.path}`;
      },
      () => {
        status.classList.add("bad");
        status.textContent = `could not copy ${file.path}`;
      },
    );
  });

  // Dismiss, not delete: nothing here is on disk, so there is nothing to remove but the card. Saying
  // "dismiss" in the tooltip matters — a bin beside generated code reads like it deletes a file.
  actionFor(header, "🗑", "dismiss this from the list — nothing on disk is touched", () => {
    card.remove();
    const left = el("previewDocs").children.length;
    el("previewWhat").textContent = `${left} file${left === 1 ? "" : "s"} to review`;
  });

  card.append(header);

  const code = document.createElement("pre");
  code.textContent = file.content;
  card.append(code);

  // The whole header toggles, which is the only affordance a list of twenty needs and is where the
  // hand already is. Every button in it stops the click, so copy, dismiss and the issue icons do
  // their own thing without the card opening underneath them.
  //
  // Opening also selects what the file came from, which lights those declarations up in every other
  // view at once — the whole reason this is a panel in Spider and not a file browser somewhere else.
  header.addEventListener("click", () => {
    const open = card.classList.toggle("open");
    sayAllState();
    if (!open) return;
    const first = file.from[0];
    if (first === undefined) return;
    const found = model?.decls.find((d) => qualify(d.id) === first);
    if (found !== undefined) select(idOf(found));
  });

  return card;
}

/**
 * The run's own troubles, which belong to no file.
 *
 * A manifest that does not parse and a provider that refused outright produced nothing to attach a
 * header to, and putting them in a card of their own is better than a footer nobody reads.
 */
function runCard(outcome: Outcome): HTMLElement | undefined {
  const orphaned = outcome.refusals.filter(
    (r) => !outcome.files.some((f) => f.draft && f.from.includes(r.at)),
  );
  if (orphaned.length === 0 && outcome.problems.length === 0) return undefined;

  const card = document.createElement("li");
  card.className = "doc";

  const header = document.createElement("header");
  const path = document.createElement("span");
  path.className = "path";
  path.textContent = "the run";
  header.append(path);

  const about = document.createElement("span");
  about.className = "about";
  about.textContent = "nothing was produced for these";
  header.append(about);

  const spacer = document.createElement("span");
  spacer.className = "spacer";
  header.append(spacer);

  if (outcome.problems.length > 0) {
    iconFor(
      header,
      card,
      `✖ ${outcome.problems.length}`,
      "problems with the run itself — a manifest, a provider, a selector",
      "bad",
      outcome.problems.join("\n"),
    );
  }

  if (orphaned.length > 0) {
    iconFor(
      header,
      card,
      `⨯ ${orphaned.length}`,
      "a provider refused, so nothing was produced for it",
      "bad",
      orphaned.map(sayRefusal).join("\n\n"),
    );
  }

  card.append(header);
  return card;
}

/**
 * The cards that have something to open.
 *
 * The run's own card is a `.doc` with no `pre` — a manifest that would not parse has no code to
 * show — so it is not something "open everything" has an opinion about.
 */
const openable = (): HTMLElement[] =>
  [...el("previewDocs").querySelectorAll<HTMLElement>(".doc")].filter(
    (c) => c.querySelector("pre") !== null,
  );

const allOpen = (): boolean => {
  const cards = openable();
  return cards.length > 0 && cards.every((c) => c.classList.contains("open"));
};

/** Open or shut every file at once. */
function setAllOpen(open: boolean): void {
  for (const card of openable()) card.classList.toggle("open", open);
  sayAllState();
}

/**
 * Do whatever the list is not already doing.
 *
 * Read from the cards rather than kept as a flag, because a card dismissed, a second run, or one
 * header clicked since would each make a flag a lie.
 */
const flipAll = (): void => setAllOpen(!allOpen());

/** The button says what it will do next, not what it did. */
function sayAllState(): void {
  const button = el("previewAll") as HTMLButtonElement;
  button.hidden = openable().length === 0;
  const open = allOpen();
  button.textContent = open ? "\u25BE\u25BE" : "\u25B8\u25B8";
  button.title = open ? "shut every file (e)" : "open every file (e)";
  button.classList.toggle("on", open);
}

function openPreview(label: string, outcome: Outcome): void {
  const at = new Date();

  el("previewWhat").textContent = `${label} — ${outcome.files.length} file${
    outcome.files.length === 1 ? "" : "s"
  }`;

  const run = runCard(outcome);
  el("previewDocs").replaceChildren(
    ...(run === undefined ? [] : [run]),
    ...outcome.files.map((file) => documentCard(file, at, outcome.refusals)),
  );

  const drift = [
    outcome.drift.changed > 0 ? `${outcome.drift.changed} changed` : undefined,
    outcome.drift.new > 0 ? `${outcome.drift.new} not on disk` : undefined,
    outcome.drift.same > 0 ? `${outcome.drift.same} already current` : undefined,
  ].filter((p) => p !== undefined);
  el("previewState").textContent = drift.join(" · ");

  sayAllState();
  // There is a way back now, because the panel hides rather than being dismissed.
  el("toggleGenerated").hidden = false;
  el("preview").hidden = false;
}

/** The drawer, shown or hidden, with whatever was last generated still in it. */
function toggleGenerated(): void {
  const panel = el("preview");
  if (panel.hidden && el("previewDocs").children.length === 0) return;
  panel.hidden = !panel.hidden;
}


// ---- the flip --------------------------------------------------------------

/**
 * The same model, as text.
 *
 * A flip rather than a second window or a split: a graph answers "what talks to what" and a file
 * answers "what exactly does it say", and those two questions alternate while you read. The selection
 * is one thing across both, so flipping lands you on what you were already looking at, and clicking a
 * declaration in the text selects it for the graph you are about to flip back to.
 */
let codeView: CodeView | undefined;
// `codeFiles`, not `sources`: there is already a `sources` here holding the same text in the shape the
// mutation API wants, and the note beside it records what shadowing it cost last time.
let codeFiles: readonly { readonly path: string; readonly source: string }[] = [];

const showingCode = (): boolean => !el("code").hidden;

function buildCode(): void {
  if (model === undefined) return;
  codeView?.destroy();
  codeView = renderCode(el("code"), model, codeFiles, { onSelect: (id) => select(id) });
  codeView.show(selection.k === "declaration" ? selection.id : undefined);
}

function toggleCode(force?: boolean): void {
  const open = force ?? el("code").hidden;
  if (open && model === undefined) return;
  el("code").hidden = !open;
  el("graph").hidden = open;
  el("toggleCode").classList.toggle("on", open);
  if (open) {
    // Built on the way in rather than kept in step while hidden: a model reload replaces every file,
    // and re-colouring text nobody is looking at is work for nothing.
    buildCode();
  }
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
function recheck(structural = false): void {
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

  // Only when the shape changed. Typing re-marks what is wrong in the nodes already on the page, so
  // the input under the cursor is the same element afterwards and keeps both the focus and the caret.
  const render = { problems: byPath, onChange: recheck };
  if (structural) renderForm(el("composeForm"), composing, payload, render);
  else refreshProblems(el("composeForm"), render);
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
  // Structural: there is no form on the page yet to repaint.
  recheck(true);
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
    // The nodes were left in place when the drawer was shut, so this only re-marks them.
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
  view?.setConnecting(armed);
  if (armed) {
    status.textContent = "click a service, then a pipe, or drag between them — either order";
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
  proposeBody.replaceChildren();
  showMutation(mutation, proposeBody);
}

/**
 * What a mutation would write, as the preview `20-ir.md` section 7 asks for.
 *
 * Shared by connecting and adding, and appended to whatever is already in the container rather than
 * replacing it — the add flow keeps a form above this, and rebuilding that on every keystroke is the
 * bug this page already had once, in the composer.
 */
function showMutation(mutation: Mutation, into: HTMLElement): void {
  if (mutation.edits.length === 0) {
    const why = document.createElement("div");
    why.className = "why";
    why.textContent = mutation.diagnostics.map((d) => d.message).join("\n") || "nothing to do";
    into.append(why);
    proposeState.textContent = "";
    proposeApply.hidden = true;
    proposal = undefined;
    return;
  }

  const applied = applyAll(sources, mutation.edits);
  proposal = previewOf(mutation, sources, applied);

  for (const show of proposal.shows) {
    const where2 = document.createElement("div");
    where2.className = "where";
    where2.textContent = `${show.removing ? "removing from" : "adding to"} ${show.file.replace(/\\/g, "/").split("/").pop() ?? show.file}`;
    const pre = document.createElement("pre");
    if (show.removing) pre.classList.add("removing");
    pre.textContent = show.text;
    into.append(where2, pre);
  }

  // A diagnostic that is not an error does not stop the write; it is said anyway, because an edit that
  // needs an import is still an edit somebody should know about.
  const errors = mutation.diagnostics.filter((d) => d.severity === "error");
  if (mutation.diagnostics.length > 0) {
    const why = document.createElement("div");
    why.className = "why";
    why.textContent = mutation.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n");
    into.append(why);
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


// ---- adding ----------------------------------------------------------------

/**
 * Adding a declaration, previewed like every other edit.
 *
 * The four kinds Core can already write: a service, and a pipe in each of its three shapes. Nothing
 * here is new machinery — `addService` and `addPipe` have been in `@sevenk/core` all along, with the
 * package check, the case-folded name clash (D40) and the append already decided there. What was
 * missing was a way to ask for one.
 *
 * **The form is built once and the preview is replaced.** Rebuilding the whole panel as you type is
 * exactly what made the composer unusable: it replaces the input under the cursor, focus falls back to
 * the page, and the next letter is read as a shortcut. So the name box and the package picker are made
 * here, and only the text below them is redrawn.
 */
function startAdd(): void {
  const kind = el<HTMLSelectElement>("addWhat").value;
  const where = editable();
  if (where === undefined || model === undefined) {
    status.classList.add("bad");
    status.textContent = "no model to add to";
    return;
  }

  const packages = [...model.packages.values()]
    .filter((p) => p.declared && p.file !== undefined)
    .map((p) => p.name)
    .sort();
  if (packages.length === 0) {
    status.classList.add("bad");
    status.textContent = "no package with a file to add to";
    return;
  }

  proposeWhat.textContent = `add a ${kind}`;

  const form = document.createElement("div");
  form.id = "addForm";

  const name = document.createElement("input");
  name.type = "text";
  // A pipe's name is a plain lowercase identifier and everything else is PascalCase (`10-grammar.md`),
  // so the placeholder says which this one wants rather than leaving it to be guessed.
  name.placeholder = kind === "service" ? "Name" : "name";
  name.autocomplete = "off";

  const pkg = document.createElement("select");
  for (const option of packages) {
    const node = document.createElement("option");
    node.value = option;
    node.textContent = option;
    pkg.append(node);
  }
  // The package of whatever is selected, when that is a sensible guess, because adding a pipe usually
  // means adding it beside the thing you were just looking at.
  const at = selection;
  const near =
    at.k === "declaration" ? model.decls.find((d) => idOf(d) === at.id)?.id.pkg : undefined;
  if (near !== undefined && packages.includes(near)) pkg.value = near;

  form.append(name, pkg);

  const preview = document.createElement("div");

  const redraw = (): void => {
    preview.replaceChildren();
    const typed = name.value.trim();
    name.classList.remove("bad");
    if (typed === "") {
      const why = document.createElement("div");
      why.className = "why";
      why.textContent = `type a name for the ${kind}`;
      preview.append(why);
      proposeState.textContent = "";
      proposeApply.hidden = true;
      proposal = undefined;
      return;
    }
    const mutation =
      kind === "service"
        ? addService(where, { pkg: pkg.value, name: typed })
        : addPipe(where, { pkg: pkg.value, name: typed, kind: kind as "queue" | "topic" | "stream" });

    proposeWhat.textContent = mutation.describe;
    showMutation(mutation, preview);
    name.classList.toggle("bad", mutation.edits.length === 0);
  };

  name.addEventListener("input", redraw);
  pkg.addEventListener("change", redraw);

  proposeBody.replaceChildren(form, preview);
  redraw();
  propose.hidden = false;
  name.focus();
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
    ...generateProblems.map((p) => `generate  ${p}`),
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
  if (generateProblems.length > 0) counts.push(`${generateProblems.length} generating`);
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
      /**
       * A line dragged from one node to another, which means what clicking the two in order means.
       *
       * Shift-drag always, and a plain drag once `n` has armed it — so the discoverable route and the
       * quick one end in the same place. Which end is the service and which the pipe is still decided
       * by their kinds and not by the direction of the drag: the model is bipartite, so a connection is
       * one of exactly two things, and dragging backwards says the same thing as dragging forwards.
       */
      onConnect: (from, to) => {
        connectingFrom = from;
        proposeConnection(to);
      },
      onSelect: select,
      onFocus: focusOnId,
      onMoved: (positions) => void remember(positions),
      onContext: (at, where) => openMenu(at, where),
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
  codeFiles = read.files;
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
  const [sourcesResponse, viewsResponse, traceResponse, formsResponse, layoutResponse, readmeResponse] =
    await Promise.all([
    fetch("/sources.json"),
    fetch("/views.json"),
    fetch("/trace.ndjson"),
    fetch("/forms.json"),
    fetch("/layout.json"),
    fetch("/readme.json"),
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

  // 204 means there is no README beside this model, which is a state and not a failure.
  showReadme(
    readmeResponse.status === 200
      ? ((await readmeResponse.json()) as { path: string; text: string })
      : undefined,
  );

  if (formsResponse.ok) {
    const parsed = parseForms(await formsResponse.text());
    forms = parsed.forms;
    formProblems = parsed.problems;
  }

  fillRuns();
  draw((await sourcesResponse.json()) as Sources);
  fillComposable();
  fillDataSubjects();
  if (showingCode()) buildCode();
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
document.addEventListener("click", (e) => {
  if (!el("menu").hidden && !el("menu").contains(e.target as Node)) closeMenu();
});
void loadProviders();
el("previewClose").addEventListener("click", () => closePreview());
el("previewAll").addEventListener("click", () => flipAll());
el("addNew").addEventListener("click", () => startAdd());
el("toggleCode").addEventListener("click", () => toggleCode());
el("toggleGenerated").addEventListener("click", () => toggleGenerated());
el("toggleData").addEventListener("click", () => toggleData());
el("dataClose").addEventListener("click", () => toggleData(false));
el("dataDepth").addEventListener("change", () => showData());
el("dataSubject").addEventListener("change", () => showData());
el("toggleAbout").addEventListener("click", () => toggleAbout());
el("aboutClose").addEventListener("click", () => toggleAbout(false));
el("toggleOpen").addEventListener("click", () => toggleOpen());
el("openClose").addEventListener("click", () => toggleOpen(false));
el("openHere").addEventListener("click", () => void openHere());
el("toggleLegend").addEventListener("click", () => toggleLegend());
el("legendClose").addEventListener("click", () => toggleLegend(false));
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

/**
 * Whether a key belongs to what has focus rather than to the page.
 *
 * Asked by capability rather than by listing the tags that happen to exist today: the last version
 * named `input` and `select`, the composer grew a `textarea`, and every one-letter shortcut fired
 * while somebody was typing into it. `isContentEditable` is in here for the same reason, before
 * anything in this page becomes one.
 */
const typingInto = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

document.addEventListener("keydown", (e) => {
  // Ctrl-K reaches the palette from anywhere, including from inside the palette, where it closes it.
  if (e.key === "k" && (e.ctrlKey || e.metaKey)) {
    if (palette.hidden) openPalette();
    else closePalette();
    e.preventDefault();
    return;
  }

  // Everything below is a single letter, so anything that takes typing must swallow it first. A
  // `textarea` was missing from this list, which is why typing a message body in the composer played
  // the trace on a space, opened the data view on a `d`, and shut the composer on a `c`.
  if (typingInto(e.target)) return;

  // `/` as well, because it costs nothing and half the world's tools use it.
  if (e.key === "/") {
    openPalette();
    e.preventDefault();
    return;
  }

  // Escape undoes the most recent narrowing first: the focus, then the selection. A single key that
  // cleared both would make it impossible to keep a focus while looking at something inside it.
  if (e.key === "Escape" && !el("menu").hidden) {
    closeMenu();
    return;
  }
  if (e.key === "Escape" && !el("preview").hidden) {
    closePreview();
    return;
  }
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
    if (!el("data").hidden) {
      toggleData(false);
      return;
    }
    if (!el("about").hidden) {
      toggleAbout(false);
      return;
    }
    if (!el("open").hidden) {
      toggleOpen(false);
      return;
    }
    if (!el("legend").hidden) {
      toggleLegend(false);
      return;
    }
    if (isFocused(focus)) toggleFocus();
    else select(undefined);
    return;
  }
  if (e.key === "?") toggleLegend();
  if (e.key === "o" || e.key === "O") toggleOpen();
  if (e.key === "a" || e.key === "A") toggleAbout();
  if (e.key === "d" || e.key === "D") toggleData();
  if (e.key === "f" || e.key === "F") toggleFocus();
  if ((e.key === "s" || e.key === "S") && !el("toggleSequence").hidden) toggleSequence();
  if ((e.key === "g" || e.key === "G") && !el("toggleSaga").hidden) toggleSaga();
  if (e.key === "c" || e.key === "C") toggleCompose();
  if (e.key === "t" || e.key === "T") toggleCode();
  if ((e.key === "v" || e.key === "V") && !el("toggleGenerated").hidden) toggleGenerated();
  // Only while the drawer is open: `e` is a letter, and a letter that does something invisible is
  // worse than no shortcut.
  if ((e.key === "e" || e.key === "E") && !el("preview").hidden) flipAll();
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
// The drawing's colours are the page's own, resolved out of CSS once at render time because Cytoscape
// cannot read a custom property itself. So a scheme the reader switches *after* the graph was drawn
// has to be handed back in, or the canvas keeps the old palette while everything around it changes.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  view?.retheme();
  // Rebuilt rather than restyled: it is small, and nothing in it is worth keeping across a repaint.
  if (legend !== undefined) {
    legend.destroy();
    legend = renderLegend(el("legendCanvas"));
  }
});

const events = new EventSource("/events");
events.addEventListener("changed", () => {
  void load();
});
