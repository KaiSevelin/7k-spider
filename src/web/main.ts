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

import { buildWorkspace, hasErrors, type Diagnostic, type LinkedModel } from "@sevenk/core";
import { buildGraph, type Graph, type GraphOptions } from "../graph.js";
import {
  applyFocus,
  DEFAULT_RADIUS,
  isFocused,
  NOT_FOCUSED,
  type Focus,
} from "../focus.js";
import { EVERYTHING, isPort, parseViews, resolveLens, type Lens, type Views } from "../lens.js";
import { nodeFor, renderGraph, type Rendered } from "../render.js";
import { buildIndex, search, type Entry, type Hit } from "../search.js";
import { join, resolve, type Selection, type SelectionId } from "../selection.js";

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
const problems = el<HTMLPreElement>("problems");
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
/** Transient, and never written anywhere: that is what makes it safe to be aggressive. */
let focus: Focus = NOT_FOCUSED;
/** Over the model, not the graph: a message is a label rather than a node, and people search for one. */
let index: readonly Entry[] = [];
let hits: readonly Hit[] = [];
let cursor = 0;

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
  // A port is not a declaration, so it cannot be a `declaration` selection — but it is worth opening
  // the sidebar for, because what it hides is the only thing it has to say.
  selection = id === undefined || isPort(id) ? { k: "none" } : { k: "declaration", id };
  if (model !== undefined && view !== undefined) {
    // One resolver for every view, even while there is only one of them: the sequence and the timeline
    // will render the same `Highlight` rather than computing their own.
    view.highlight(resolve(join(model, []), selection));
  }
  describe(id);
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

/** Diagnostics are shown, never swallowed: a warning is usually the interesting part of a model. */
function report(diagnostics: readonly Diagnostic[], unresolved: readonly string[]): void {
  const lines = [
    ...diagnostics.filter((d) => d.severity === "error").map((d) => `error  ${d.code}: ${d.message}`),
    ...unresolved.map((u) => `unresolved  ${u}`),
    ...lensProblems.map((p) => `views.json  ${p}`),
    ...diagnostics.filter((d) => d.severity === "warning").map((d) => `warning  ${d.code}: ${d.message}`),
  ];
  problems.textContent = lines.join("\n");
  problems.classList.toggle("open", lines.length > 0);
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
    view = renderGraph(el("graph"), graph, { onSelect: select, onFocus: focusOnId });
  } else view.update(graph);

  // A selection is an identity, so it survives this rebuild (`docs/design.md` 2.3) — which is the whole
  // reason it is an id and not a reference into a model that was just thrown away.
  if (selection.k === "declaration") select(selection.id);
}

function draw(sources: Sources): void {
  const ws = buildWorkspace(sources.files.map((f) => ({ path: f.path, source: f.source })));
  model = ws.model;
  index = buildIndex(ws.model);
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
  const [sourcesResponse, viewsResponse] = await Promise.all([
    fetch("/sources.json"),
    fetch("/views.json"),
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

  draw((await sourcesResponse.json()) as Sources);
}

lensPicker.addEventListener("change", redraw);
el("find").addEventListener("click", openPalette);
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
    if (isFocused(focus)) toggleFocus();
    else select(undefined);
    return;
  }
  if (e.key === "f" || e.key === "F") toggleFocus();
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
