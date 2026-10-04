/**
 * Drawing the saga view.
 *
 * SVG and plain DOM with no library, for the reason the sequence view gives: `layoutSaga` has already
 * decided every coordinate, so this file has no layout problem left to solve. Host-agnostic, so the
 * same code runs in a VS Code webview.
 *
 * ### Two pictures, one diagram
 *
 * The declaration is drawn once. A trace, when there is one, is drawn **on top of** it: a card the
 * instance completed, the branches it is waiting in, the inverses that ran. The alternative — a
 * separate "instance view" — would have produced two drawings of the same saga that could disagree,
 * and the question "where did this order stop" is a question about the declared process.
 *
 * ### Long labels are truncated, never wrapped
 *
 * SVG text does not wrap, and measuring to wrap it would mean laying out text here, which is the one
 * thing `layoutSaga` was written to avoid. So a row that does not fit is cut with an ellipsis and
 * carries its full text as a tooltip. The budget assumes the monospace face the stylesheet sets; being
 * a few characters out costs an ellipsis, not a broken diagram.
 */

import type { LinkedModel, SagaIr } from "@sevenk/core";
import { layoutSaga, type Outcome, type Progress, type SagaDiagram, type StepCard } from "./saga.js";
import { sayDuration } from "./saga.js";
import type { Highlight, SelectionId } from "./selection.js";

const NS = "http://www.w3.org/2000/svg";

/** Roughly the advance of the 11px monospace face the stylesheet sets. */
const CHAR = 6.7;

export interface SagaViewOptions {
  /** Called with a declaration's selection id when a name in the diagram is clicked. */
  readonly onSelect?: (id: SelectionId) => void;
}

export interface SagaView {
  /** Replaces the saga being drawn. `undefined` empties the view. */
  update(saga: SagaIr | undefined): void;
  /** Emphasises the declarations a highlight names, and dims the rest. */
  highlight(h: Highlight | undefined): void;
  /** Draws one instance's progress over the declaration, or clears it. */
  progress(p: Progress | undefined): void;
  destroy(): void;
}

const el = <K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
};

/** Text, cut to a pixel budget, with the whole of it on hover when it had to be cut. */
const text = (
  content: string,
  attrs: Record<string, string | number>,
  budget?: number,
): SVGTextElement => {
  const node = el("text", attrs);
  const fits = budget === undefined ? content.length : Math.floor(budget / CHAR);
  node.textContent = content.length > fits ? `${content.slice(0, Math.max(1, fits - 1))}…` : content;
  if (node.textContent !== content) {
    const title = el("title");
    title.textContent = content;
    node.append(title);
  }
  return node;
};

export function renderSaga(
  container: HTMLElement,
  model: LinkedModel,
  saga: SagaIr | undefined,
  options: SagaViewOptions = {},
): SagaView {
  let laid: SagaDiagram | undefined = saga === undefined ? undefined : layoutSaga(model, saga);
  /** Every element that stands for a declaration, so a highlight is one sweep. */
  const byId = new Map<SelectionId, SVGElement[]>();
  /** Card groups by step name, for progress. */
  const cards = new Map<string, SVGGElement>();
  const terminalRows = new Map<string, SVGGElement>();

  const selectable = (node: SVGElement, id: SelectionId): void => {
    byId.set(id, [...(byId.get(id) ?? []), node]);
    node.setAttribute("data-id", id);
    const onSelect = options.onSelect;
    if (onSelect === undefined) return;
    node.classList.add("clickable");
    node.addEventListener("click", (e) => {
      // A message inside a card must not also select the card's own saga.
      e.stopPropagation();
      onSelect(id);
    });
  };

  const drawOutcome = (group: SVGGElement, card: StepCard, o: Outcome): void => {
    const row = el("g", { class: `outcome outcome-${o.kind}` });
    const label = text(o.label, { x: card.x + 10, y: o.y, class: "row-label" }, card.width - 28);
    row.append(label);
    if (o.message !== undefined) selectable(label, o.message.id);

    // A glyph in the right margin, so the ways out of a step are countable without reading.
    const glyph = o.kind === "continue" ? "↓" : o.kind === "reject" ? "✕" : "⊘";
    row.append(text(glyph, { x: card.x + card.width - 9, y: o.y, class: "glyph", "text-anchor": "end" }));
    group.append(row);
  };

  const drawCard = (parent: SVGGElement, d: SagaDiagram, card: StepCard): void => {
    const group = el("g", { class: "card", "data-step": card.name });
    group.append(
      el("rect", {
        x: card.x,
        y: card.y,
        width: card.width,
        height: card.height,
        rx: 6,
        class: "card-box",
      }),
    );

    // The stub tying the card to the saga's own line. Two stubs off one segment is what a stage with
    // two steps looks like.
    group.append(
      el("line", {
        x1: d.spineX,
        y1: card.y + 14,
        x2: card.x,
        y2: card.y + 14,
        class: "stub",
      }),
    );

    group.append(text(card.name, { x: card.x + 10, y: card.y + 17, class: "card-name" }, card.width - 80));

    let y = card.y + 22;
    if (card.send !== undefined) {
      y += 19;
      const carries = card.carries === 0 ? "" : `  +${card.carries}`;
      const label = text(
        `send ${card.send.label}${carries}`,
        { x: card.x + 10, y, class: "send" },
        card.width - 28,
      );
      group.append(label);
      selectable(label, card.send.id);
    }

    for (const o of card.outcomes) drawOutcome(group, card, o);

    // The two silences, drawn rather than omitted.
    const footY = card.y + card.height - 13;
    if (card.unbounded) {
      group.append(text("no timeout", { x: card.x + 10, y: footY - 19, class: "silence" }));
    }
    if (card.undo.k === "with") {
      const label = text(
        `undo with ${card.undo.message.label}`,
        { x: card.x + 10, y: footY, class: "undo" },
        card.width - 28,
      );
      group.append(label);
      selectable(label, card.undo.message.id);
    } else {
      group.append(
        text(card.undo.k === "none" ? "undo none" : "no inverse", {
          x: card.x + 10,
          y: footY,
          class: `undo undo-${card.undo.k}`,
        }),
      );
    }

    cards.set(card.name, group);
    parent.append(group);
  };

  const draw = (): void => {
    byId.clear();
    cards.clear();
    terminalRows.clear();
    container.replaceChildren();
    if (laid === undefined) return;
    const d = laid;

    const svg = el("svg", {
      width: d.width,
      height: d.height,
      viewBox: `0 0 ${d.width} ${d.height}`,
      class: "saga",
    });

    // ---- the spine, first, so everything sits on it -----------------------
    // The spine runs from whatever is above the first stage down to the terminal band.
    const top =
      d.start === undefined ? (d.stages[0]?.y ?? d.terminalBand.y) : d.start.y + d.start.height;
    svg.append(
      el("line", { x1: d.spineX, y1: top, x2: d.spineX, y2: d.terminalBand.y, class: "spine" }),
    );

    // ---- the start band ---------------------------------------------------
    if (d.start !== undefined) {
      const band = el("g", { class: "band band-start" });
      band.append(
        el("rect", {
          x: d.spineX - 8,
          y: d.start.y,
          width: d.width - d.spineX - 8,
          height: d.start.height,
          rx: 6,
          class: "band-box",
        }),
      );
      const keyed = d.start.keyedBy === undefined ? "" : ` keyed by ${d.start.keyedBy}`;
      const label = text(`start on ${d.start.message.label}${keyed}`, {
        x: d.spineX + 4,
        y: d.start.y + 20,
        class: "band-title",
      });
      band.append(label);
      selectable(label, d.start.message.id);

      const seeds =
        d.start.seeds.length === 0
          ? "seeds nothing"
          : `seeds ${d.start.seeds.join(", ")}`;
      band.append(text(seeds, { x: d.spineX + 4, y: d.start.y + 37, class: "band-note" }));
      svg.append(band);
    }

    // ---- the stages -------------------------------------------------------
    for (const stage of d.stages) {
      const group = el("g", { class: `stage${stage.parallel ? " stage-parallel" : ""}` });

      // The stage's number in the gutter, and the word for a stage that holds more than one step,
      // because "these two run at once" is the one thing a reader must not have to infer.
      group.append(
        text(String(stage.index + 1), {
          x: d.spineX - 10,
          y: stage.y + 18,
          class: "stage-index",
          "text-anchor": "end",
        }),
      );
      if (stage.parallel) {
        group.append(
          text("parallel", {
            x: d.spineX - 10,
            y: stage.y + 34,
            class: "stage-word",
            "text-anchor": "end",
          }),
        );
        // A bracket spanning the branches, so the grouping survives a narrow window.
        const first = stage.steps[0]!;
        const last = stage.steps.at(-1)!;
        group.append(
          el("path", {
            d: `M ${first.x} ${stage.y - 6} H ${last.x + last.width} `,
            class: "bracket",
          }),
        );
      }

      for (const card of stage.steps) drawCard(group, d, card);
      svg.append(group);
    }

    // ---- the exit rail ----------------------------------------------------
    // One line for every way out that is not completion, running down to the terminal band. Drawn
    // only when there is an exit, so a saga that cannot fail does not grow a rail for nothing.
    const exits = d.stages
      .flatMap((s) => s.steps)
      .flatMap((c) => c.outcomes.filter((o) => o.kind !== "continue").map((o) => ({ c, o })));
    if (exits.length > 0) {
      const rail = el("g", { class: "exits" });
      const firstY = Math.min(...exits.map((e) => e.o.y));
      rail.append(
        el("line", { x1: d.exitX, y1: firstY - 4, x2: d.exitX, y2: d.terminalBand.y, class: "rail" }),
      );
      for (const { c, o } of exits) {
        rail.append(
          el("line", {
            x1: c.x + c.width,
            y1: o.y - 4,
            x2: d.exitX,
            y2: o.y - 4,
            class: `rail-stub rail-${o.kind}`,
          }),
        );
      }
      svg.append(rail);
    }

    // ---- the terminal band ------------------------------------------------
    const band = el("g", { class: "band band-terminal" });
    band.append(
      el("rect", {
        x: d.spineX - 8,
        y: d.terminalBand.y,
        width: d.width - d.spineX - 8,
        height: d.terminalBand.height,
        rx: 6,
        class: "band-box",
      }),
    );
    const deadline =
      d.deadlineMs === undefined ? "no deadline" : `deadline ${sayDuration(d.deadlineMs)} → abandon`;
    band.append(text(deadline, { x: d.spineX + 4, y: d.terminalBand.y + 16, class: "band-note" }));

    for (const t of d.terminals) {
      const row = el("g", { class: `terminal terminal-${t.on}`, "data-terminal": t.on });
      if (t.message === undefined) {
        row.append(
          text(`on ${t.on} — announces nothing`, {
            x: d.spineX + 4,
            y: t.y + 16,
            class: "terminal-silent",
          }),
        );
      } else {
        const label = text(`on ${t.on} send ${t.message.label}`, {
          x: d.spineX + 4,
          y: t.y + 16,
          class: "terminal-label",
        });
        row.append(label);
        selectable(label, t.message.id);
      }
      terminalRows.set(t.on, row);
      band.append(row);
    }
    svg.append(band);

    // Clicking the background selects the saga itself, which is how you get back out of a message.
    const onSelect = options.onSelect;
    if (onSelect !== undefined) {
      svg.addEventListener("click", () => onSelect(d.id));
    }

    container.append(svg);
  };

  draw();

  const highlight = (h: Highlight | undefined): void => {
    const wanted = h?.declarations;
    const any = wanted !== undefined && wanted.size > 0;
    for (const [id, nodes] of byId) {
      for (const node of nodes) {
        node.classList.toggle("emphasised", any && wanted.has(id));
        node.classList.toggle("dimmed", any && !wanted.has(id));
      }
    }
  };

  const progress = (p: Progress | undefined): void => {
    const done = new Set(p?.completed ?? []);
    const waiting = new Set(p?.waiting ?? []);
    const timedOut = new Set(p?.timedOut ?? []);
    const compensated = new Set(p?.compensated ?? []);

    for (const [name, node] of cards) {
      node.classList.toggle("completed", done.has(name));
      node.classList.toggle("waiting", waiting.has(name));
      node.classList.toggle("timed-out", timedOut.has(name));
      node.classList.toggle("compensated", compensated.has(name));
    }
    for (const [on, node] of terminalRows) {
      node.classList.toggle("reached", p?.terminal === on);
    }
    container.firstElementChild?.classList.toggle("has-progress", p !== undefined);
  };

  return {
    update(next) {
      laid = next === undefined ? undefined : layoutSaga(model, next);
      draw();
    },
    highlight,
    progress,
    destroy() {
      container.replaceChildren();
      byId.clear();
      cards.clear();
      terminalRows.clear();
      laid = undefined;
    },
  };
}

/** Exposed so a test can assert the layout a view would draw without a DOM. */
export { layoutSaga, type SagaDiagram };
