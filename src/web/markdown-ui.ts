/**
 * Drawing parsed Markdown into the page.
 *
 * Nodes, never markup: every piece of text goes in through `textContent`, so a README is incapable of
 * putting anything into this page but words. That is the whole security model for a feature that reads
 * a file out of a directory somebody else may have written, and it costs nothing.
 */

import type { Block, Span } from "../markdown.js";

const inline = (spans: readonly Span[]): Node[] =>
  spans.map((span) => {
    switch (span.k) {
      case "code": {
        const el = document.createElement("code");
        el.textContent = span.text;
        return el;
      }
      case "strong": {
        const el = document.createElement("strong");
        el.textContent = span.text;
        return el;
      }
      case "em": {
        const el = document.createElement("em");
        el.textContent = span.text;
        return el;
      }
      case "link": {
        const el = document.createElement("a");
        el.textContent = span.text;
        el.href = span.href;
        // A README's links go outward, and losing the graph to follow one would be a poor trade.
        el.target = "_blank";
        el.rel = "noreferrer noopener";
        return el;
      }
      default:
        return document.createTextNode(span.text);
    }
  });

const cell = (tag: "th" | "td", spans: readonly Span[]): HTMLElement => {
  const el = document.createElement(tag);
  el.append(...inline(spans));
  return el;
};

/** Replaces `into`'s children with the document. */
export function renderMarkdown(blocks: readonly Block[], into: HTMLElement): void {
  const out: HTMLElement[] = [];

  for (const block of blocks) {
    switch (block.k) {
      case "heading": {
        // Clamped: a README's `#` is the document's title, and it sits inside a panel that already has
        // one, so starting at `h2` keeps the page's own outline intact.
        const el = document.createElement(`h${Math.min(6, block.level + 1)}`);
        el.append(...inline(block.spans));
        out.push(el);
        break;
      }
      case "para": {
        const el = document.createElement("p");
        el.append(...inline(block.spans));
        out.push(el);
        break;
      }
      case "quote": {
        const el = document.createElement("blockquote");
        el.append(...inline(block.spans));
        out.push(el);
        break;
      }
      case "code": {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = block.text;
        pre.append(code);
        out.push(pre);
        break;
      }
      case "list": {
        const el = document.createElement(block.ordered ? "ol" : "ul");
        for (const item of block.items) {
          const li = document.createElement("li");
          li.append(...inline(item));
          el.append(li);
        }
        out.push(el);
        break;
      }
      case "table": {
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const spans of block.head) headRow.append(cell("th", spans));
        head.append(headRow);
        const body = document.createElement("tbody");
        for (const row of block.rows) {
          const tr = document.createElement("tr");
          for (const spans of row) tr.append(cell("td", spans));
          body.append(tr);
        }
        table.append(head, body);
        out.push(table);
        break;
      }
      default:
        out.push(document.createElement("hr"));
    }
  }

  into.replaceChildren(...out);
}
