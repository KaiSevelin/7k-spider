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
import { EVERYTHING, isPort, parseViews, resolveLens, type Lens, type Views } from "../lens.js";
import { nodeFor, renderGraph, type Rendered } from "../render.js";
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

let model: LinkedModel | undefined;
/** The whole graph, before any lens. Kept so a lens change needs no re-parse. */
let whole: Graph | undefined;
/** What is drawn: the whole graph through the current lens. */
let graph: Graph | undefined;
let view: Rendered | undefined;
let selection: Selection = { k: "none" };
let views: Views = {};
let lensProblems: readonly string[] = [];

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
  if (node === undefined && edge === undefined) {
    sidebar.classList.remove("open");
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
  graph = resolveLens(whole, currentLens());

  const counts = [
    `${graph.nodes.filter((n) => n.kind === "service" || n.kind === "external").length} services`,
    `${graph.nodes.filter((n) => n.kind === "pipe").length} pipes`,
    `${graph.edges.length} edges`,
  ];
  const hidden = whole.nodes.length - graph.nodes.length;
  if (hidden > 0) counts.push(`${hidden} hidden`);
  status.textContent = counts.join(" · ");

  if (view === undefined) view = renderGraph(el("graph"), graph, { onSelect: select });
  else view.update(graph);

  // A selection is an identity, so it survives this rebuild (`docs/design.md` 2.3) — which is the whole
  // reason it is an id and not a reference into a model that was just thrown away.
  if (selection.k === "declaration") select(selection.id);
}

function draw(sources: Sources): void {
  const ws = buildWorkspace(sources.files.map((f) => ({ path: f.path, source: f.source })));
  model = ws.model;
  whole = buildGraph(ws.model, optionsFromForm());
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
for (const id of ["packages", "dead"]) {
  el<HTMLInputElement>(id).addEventListener("change", () => {
    void load();
  });
}

// Escape clears, because a selection that can only be replaced is a selection you are stuck in.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") select(undefined);
});

void load();

// The server watches the files and says when one changed. Re-reading and redrawing is cheap, and the
// layout is deterministic, so an unchanged part of the model lands back where it was.
const events = new EventSource("/events");
events.addEventListener("changed", () => {
  void load();
});
