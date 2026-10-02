/**
 * Drawing the sequence diagram.
 *
 * SVG and plain DOM, with no library, because the whole thing is a grid of lines and labels whose
 * coordinates `layoutSequence` has already worked out. A graph needed Cytoscape for layout and hit
 * testing; this needs neither.
 *
 * Host-agnostic like the graph renderer: it takes a container and a trace and hands back a handle. The
 * same code will run in a VS Code webview.
 */

import type { TraceEvent } from "@sevenk/core";
import { layoutSequence, sayGap, type Row, type Sequence } from "./sequence.js";
import type { Highlight, SelectionId } from "./selection.js";

const NS = "http://www.w3.org/2000/svg";

export interface SequenceOptions {
  /** Called with an event's `(run, seq)` key when a row is clicked. */
  readonly onEvent?: (key: string) => void;
  /** Called with a lane's selection id when its heading is clicked. */
  readonly onLane?: (id: SelectionId) => void;
}

export interface SequenceView {
  /** Replaces the trace being drawn. */
  update(trace: readonly TraceEvent[]): void;
  /** Emphasises the events a highlight names, and dims the rest. */
  highlight(h: Highlight | undefined): void;
  /** Marks the row playback has reached, and scrolls it into view. */
  cursor(key: string | undefined): void;
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

export function renderSequence(
  container: HTMLElement,
  trace: readonly TraceEvent[],
  options: SequenceOptions = {},
): SequenceView {
  let laid: Sequence = layoutSequence(trace);
  const rowNodes = new Map<string, SVGGElement>();
  let svg = el("svg");

  const draw = (): void => {
    rowNodes.clear();
    container.replaceChildren();

    svg = el("svg", {
      width: laid.width,
      height: laid.height,
      viewBox: `0 0 ${laid.width} ${laid.height}`,
      class: "sequence",
    });

    // Lifelines first, so everything else sits on top of them.
    for (const lane of laid.lanes) {
      svg.append(
        el("line", {
          x1: lane.x,
          y1: 34,
          x2: lane.x,
          y2: laid.height,
          class: `lifeline lifeline-${lane.kind}`,
        }),
      );

      const heading = el("text", { x: lane.x, y: 20, class: `lane lane-${lane.kind}` });
      heading.textContent = lane.label;
      // The qualified name on hover, because two packages may have a `commands`.
      const title = el("title");
      title.textContent = `${lane.kind} ${lane.qname}`;
      heading.append(title);
      if (options.onLane !== undefined) {
        const onLane = options.onLane;
        heading.classList.add("clickable");
        heading.addEventListener("click", () => onLane(lane.id));
      }
      svg.append(heading);
    }

    for (const row of laid.rows) {
      const group = el("g", { class: `row${row.bad ? " bad" : ""}`, "data-key": row.key });

      // A gap divider, with how long the wait actually was — the queue's whole character.
      if (row.gapBefore) {
        const y = row.y - 13;
        group.append(el("line", { x1: 8, y1: y, x2: laid.width - 8, y2: y, class: "gap" }));
        const label = el("text", { x: laid.width - 10, y: y - 3, class: "gapLabel" });
        label.textContent = row.gapMs === undefined ? "" : `+${sayGap(row.gapMs)}`;
        group.append(label);
      }

      // A band across the whole width, so a row is clickable anywhere rather than only on its arrow.
      group.append(
        el("rect", { x: 0, y: row.y - 11, width: laid.width, height: 22, class: "band" }),
      );

      if (row.from !== undefined && row.to !== undefined) {
        const from = laid.lanes[row.from]!.x;
        const to = laid.lanes[row.to]!.x;
        const dir = to > from ? 1 : -1;
        group.append(
          el("line", { x1: from, y1: row.y, x2: to - dir * 5, y2: row.y, class: "arrow" }),
        );
        // A head drawn as a path rather than a marker, so it inherits the row's colour.
        group.append(
          el("path", {
            d: `M ${to} ${row.y} L ${to - dir * 7} ${row.y - 4} L ${to - dir * 7} ${row.y + 4} Z`,
            class: "head",
          }),
        );
        const label = el("text", {
          x: (from + to) / 2,
          y: row.y - 4,
          class: "label",
          "text-anchor": "middle",
        });
        label.textContent = row.label;
        group.append(label);
      } else if (row.on !== undefined) {
        // It happened to a participant without travelling: a mark on its lifeline.
        const x = laid.lanes[row.on]!.x;
        group.append(el("circle", { cx: x, cy: row.y, r: 4, class: "mark" }));
        const label = el("text", { x: x + 9, y: row.y + 4, class: "label" });
        label.textContent = row.label;
        group.append(label);
      } else {
        // No participant at all — the clock moving. A faint rule across the diagram.
        group.append(
          el("line", { x1: 8, y1: row.y, x2: laid.width - 8, y2: row.y, class: "clock" }),
        );
        const label = el("text", { x: 10, y: row.y - 4, class: "label dim" });
        label.textContent = row.label;
        group.append(label);
      }

      if (row.note !== undefined) {
        const note = el("text", {
          x: laid.width - 10,
          y: row.y + 4,
          class: "note",
          "text-anchor": "end",
        });
        note.textContent = row.note;
        group.append(note);
      }

      if (options.onEvent !== undefined) {
        const onEvent = options.onEvent;
        group.classList.add("clickable");
        group.addEventListener("click", () => onEvent(row.key));
      }

      rowNodes.set(row.key, group);
      svg.append(group);
    }

    container.append(svg);
  };

  draw();

  const highlight = (h: Highlight | undefined): void => {
    const wanted = h?.events;
    const any = wanted !== undefined && wanted.size > 0;
    for (const [key, node] of rowNodes) {
      node.classList.toggle("emphasised", any && wanted.has(key));
      node.classList.toggle("dimmed", any && !wanted.has(key));
    }
  };

  return {
    update(next) {
      laid = layoutSequence(next);
      draw();
    },
    highlight,
    cursor(key) {
      for (const [k, node] of rowNodes) node.classList.toggle("current", k === key);
      if (key === undefined) return;
      const node = rowNodes.get(key);
      // `nearest`, so following a replay does not yank the view when the row is already visible.
      node?.scrollIntoView({ block: "nearest" });
    },
    destroy() {
      container.replaceChildren();
      rowNodes.clear();
    },
  };
}

/** Exposed so a test can assert the layout a view would draw without a DOM. */
export { layoutSequence, type Row };
