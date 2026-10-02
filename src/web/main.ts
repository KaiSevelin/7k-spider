/**
 * The browser entry point.
 *
 * Everything the language means is computed here, in the page, by `@sevenk/core` — the same lexer,
 * parser, linker and analyses `7k check` runs. Core has no `node:` imports and `buildWorkspace` takes
 * sources as strings, so the server's whole job is to hand over the files and say when they change.
 *
 * That is why there is no IR wire format. Spider's view of a model is not a copy of the checker's
 * that could drift from it; it is the checker's.
 */

import { buildWorkspace, hasErrors, type Diagnostic, type LinkedModel } from "@sevenk/core";
import { buildGraph, type Graph, type GraphOptions } from "../graph.js";
import { renderGraph, type Rendered } from "../render.js";
import { join, resolve, type Selection, type SelectionId } from "../selection.js";
import { nodeFor } from "../render.js";

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

let model: LinkedModel | undefined;
let graph: Graph | undefined;
let view: Rendered | undefined;
let selection: Selection = { k: "none" };

const optionsFromForm = (): GraphOptions => ({
  packages: el<HTMLInputElement>("packages").checked,
  ports: el<HTMLInputElement>("ports").checked,
  deadLetters: el<HTMLInputElement>("dead").checked,
});

/** The sidebar: what the model says about one node, which is the first question a click asks. */
function describe(id: SelectionId | undefined): void {
  if (id === undefined || graph === undefined) {
    sidebar.classList.remove("open");
    sidebar.replaceChildren();
    return;
  }

  const node = nodeFor(graph, id);
  const rows: [string, string][] = [];

  if (node === undefined) {
    const edge = graph.edges.find((e) => e.id === id);
    if (edge === undefined) {
      sidebar.classList.remove("open");
      return;
    }
    rows.push(["kind", edge.direction]);
    rows.push(["messages", edge.messages.join("\n")]);
    if (edge.subscription !== undefined) rows.push(["subscription", edge.subscription]);
  } else {
    rows.push(["kind", node.kind]);
    rows.push(["name", node.qname]);
    if (node.pipeKind !== undefined) rows.push(["pipe", node.pipeKind]);
    if (node.delivery !== undefined) rows.push(["delivery", node.delivery]);
    if (node.boundary === true) rows.push(["boundary", "crosses the system boundary"]);
    if (node.labels.length > 0) rows.push(["labels", node.labels.join(", ")]);
  }

  const heading = document.createElement("h2");
  heading.textContent = node?.qname ?? id;
  const list = document.createElement("dl");
  for (const [key, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
  sidebar.replaceChildren(heading, list);
  sidebar.classList.add("open");
}

function select(id: SelectionId | undefined): void {
  selection = id === undefined ? { k: "none" } : { k: "declaration", id };
  if (model !== undefined && view !== undefined) {
    // One resolver for every view, even while there is only one of them — the sequence and the
    // timeline will render the same `Highlight` rather than computing their own (increment 3).
    view.highlight(resolve(join(model, []), selection));
  }
  describe(id);
}

/** Diagnostics are shown, never swallowed: a warning is usually the interesting part of a model. */
function report(diagnostics: readonly Diagnostic[], unresolved: readonly string[]): void {
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");

  const lines = [
    ...errors.map((d) => `error  ${d.code}: ${d.message}`),
    ...unresolved.map((u) => `unresolved  ${u}`),
    ...warnings.map((d) => `warning  ${d.code}: ${d.message}`),
  ];

  problems.textContent = lines.join("\n");
  problems.classList.toggle("open", lines.length > 0);
}

function draw(sources: Sources): void {
  const ws = buildWorkspace(sources.files.map((f) => ({ path: f.path, source: f.source })));
  model = ws.model;
  graph = buildGraph(ws.model, optionsFromForm());

  const counts = [
    `${graph.nodes.filter((n) => n.kind === "service" || n.kind === "port").length} services`,
    `${graph.nodes.filter((n) => n.kind === "pipe").length} pipes`,
    `${graph.edges.length} edges`,
    `${sources.files.length} files`,
  ];
  status.textContent = counts.join(" · ");
  status.classList.toggle("bad", hasErrors(ws.diagnostics));
  report(ws.diagnostics, graph.unresolved);

  if (view === undefined) view = renderGraph(el("graph"), graph, { onSelect: select });
  else view.update(graph);

  // A selection is an identity, so it survives this rebuild (`docs/design.md` 2.3) — which is the
  // whole reason it is an id and not a reference into the model that was just thrown away.
  if (selection.k !== "none") select(selection.k === "declaration" ? selection.id : undefined);
}

async function load(): Promise<void> {
  const response = await fetch("/sources.json");
  if (!response.ok) {
    status.textContent = `could not read the model: ${response.status}`;
    status.classList.add("bad");
    return;
  }
  draw((await response.json()) as Sources);
}

for (const id of ["packages", "ports", "dead"]) {
  el<HTMLInputElement>(id).addEventListener("change", () => {
    void load();
  });
}

void load();

// The server watches the files and says when one changed. Re-reading and redrawing is cheap, and the
// layout is deterministic, so an unchanged part of the model lands back where it was.
const events = new EventSource("/events");
events.addEventListener("changed", () => {
  void load();
});
