/**
 * The README reader.
 *
 * It renders a file somebody else wrote, so the tests that matter are about what it refuses to do with
 * one as much as what it draws.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseMarkdown, parseSpans, type Block } from "../src/markdown.js";

const kinds = (blocks: readonly Block[]): string[] => blocks.map((b) => b.k);

describe("blocks", () => {
  it("reads the shapes a README is made of", () => {
    const blocks = parseMarkdown(
      [
        "# Title",
        "",
        "A paragraph that",
        "wraps across lines.",
        "",
        "## Section",
        "",
        "- one",
        "- two",
        "",
        "```7k",
        "package p",
        "```",
        "",
        "> a quote",
        "",
        "---",
      ].join("\n"),
    );
    expect(kinds(blocks)).toEqual(["heading", "para", "heading", "list", "code", "quote", "rule"]);
    expect(blocks[1]).toEqual({ k: "para", spans: [{ k: "text", text: "A paragraph that wraps across lines." }] });
    expect(blocks[4]).toEqual({ k: "code", text: "package p", lang: "7k" });
  });

  it("reads a pipe table, which is most of what a model's README explains itself with", () => {
    const blocks = parseMarkdown(["| Package | What it owns |", "|---|---|", "| `a` | the hardware |"].join("\n"));
    expect(blocks).toHaveLength(1);
    const table = blocks[0] as Extract<Block, { k: "table" }>;
    expect(table.k).toBe("table");
    expect(table.head).toHaveLength(2);
    expect(table.rows[0]?.[0]).toEqual([{ k: "code", text: "a" }]);
  });

  it("does not mistake a table's divider for a rule", () => {
    // `|---|---|` and `---` are both dashes on a line, and reading the first as a thematic break would
    // split every table in the file into three.
    expect(kinds(parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |"))).toEqual(["table"]);
  });

  it("keeps a wrapped bullet with the bullet it belongs to", () => {
    const blocks = parseMarkdown("- one that\n  continues here\n- two");
    const list = blocks[0] as Extract<Block, { k: "list" }>;
    expect(list.items).toHaveLength(2);
    expect(list.items[0]).toEqual([{ k: "text", text: "one that continues here" }]);
  });
});

describe("inline", () => {
  it("reads code, emphasis and links", () => {
    expect(parseSpans("a `b` **c** *d*")).toEqual([
      { k: "text", text: "a " },
      { k: "code", text: "b" },
      { k: "text", text: " " },
      { k: "strong", text: "c" },
      { k: "text", text: " " },
      { k: "em", text: "d" },
    ]);
    expect(parseSpans("[docs](https://example.com)")).toEqual([
      { k: "link", text: "docs", href: "https://example.com" },
    ]);
  });

  it("takes a code span whole, so a document about syntax does not rewrite itself", () => {
    expect(parseSpans("`**not bold**`")).toEqual([{ k: "code", text: "**not bold**" }]);
  });

  it("strips a link whose scheme is not one of the safe ones, and keeps its words", () => {
    // A README is a file somebody else may have written, and the renderer puts its href on an anchor.
    expect(parseSpans("[click](javascript:boom)")).toEqual([{ k: "text", text: "click" }]);
    expect(parseSpans("[mail](mailto:a@b.c)")).toEqual([{ k: "link", text: "mail", href: "mailto:a@b.c" }]);
  });

  it("treats raw HTML as the text it was written as", () => {
    // Nothing here produces markup, so there is nothing for a tag to become.
    const spans = parseSpans("<img src=x onerror=boom>");
    expect(spans).toEqual([{ k: "text", text: "<img src=x onerror=boom>" }]);
  });
});

describe("the example's own README", () => {
  it("reads end to end, with its headings and tables intact", () => {
    // The one file this feature exists to show. If it ever stops parsing, the demo's `about` panel is
    // the thing that breaks, and nothing else would say so.
    const text = readFileSync(join(import.meta.dirname, "..", "examples", "README.md"), "utf-8");
    const blocks = parseMarkdown(text);
    expect(blocks.filter((b) => b.k === "heading").length).toBeGreaterThan(5);
    expect(blocks.some((b) => b.k === "table")).toBe(true);
    expect(blocks.some((b) => b.k === "code")).toBe(true);
    // Nothing swallowed: every line of prose is in some block.
    expect(blocks.filter((b) => b.k === "para").length).toBeGreaterThan(10);
  });
});
