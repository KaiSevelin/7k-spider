/**
 * The flip: the same model as text.
 *
 * Two claims worth checking, and the first is the one that would be quietly wrong. The text is
 * coloured by walking Core's own lexer, so what reads as a keyword here is what the checker calls a
 * keyword — but a highlighter that drops a byte is a highlighter that lies about the file, and a
 * missing space or an eaten comment is invisible to the eye and obvious to a comparison. So every
 * file's rendered text is compared with the file.
 *
 * The second is that it is a flip rather than a second window: one selection, so a declaration picked
 * anywhere is the declaration marked here, and clicking one here is the same as clicking a node.
 *
 * Needs a browser. Skipped rather than failed without one.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { serve, type Serving } from "../src/serve.js";
import { shortNames } from "../src/web/code-ui.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;
let ready = false;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ channel: "msedge" });
  } catch {
    return;
  }
  serving = await serve({ paths: [join(root, "examples")], port: 0, watch: false });
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(serving.url);
  await page.waitForSelector("#graph");
  ready = true;
}, 180_000);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await serving?.close().catch(() => undefined);
});

const flipToCode = async (p: Page): Promise<void> => {
  if (await p.locator("#code").isHidden()) await p.click("#toggleCode");
  await p.waitForSelector("#code:not([hidden])");
  await p.waitForSelector("#code .decl");
};

describe("shortNames", () => {
  it("takes off the directory every path shares", () => {
    expect(shortNames(["/a/b/one.7k", "/a/b/two.7k"])).toEqual(["one.7k", "two.7k"]);
  });

  it("keeps what tells them apart", () => {
    expect(shortNames(["/a/b/one.7k", "/a/c/two.7k"])).toEqual(["b/one.7k", "c/two.7k"]);
  });

  it("leaves a lone path with a name", () => {
    expect(shortNames(["/a/b/only.7k"])).toEqual(["only.7k"]);
  });

  it("handles the other slash", () => {
    expect(shortNames(["C:\\x\\y\\one.7k", "C:\\x\\y\\two.7k"])).toEqual(["one.7k", "two.7k"]);
  });
});

describe("flipping to the text", () => {
  it("replaces the graph rather than sitting beside it", async () => {
    if (!ready || page === undefined) return;
    await flipToCode(page);
    expect(await page.locator("#graph").isHidden()).toBe(true);
    expect(await page.locator("#code").isHidden()).toBe(false);
  }, 60_000);

  it("flips back", async () => {
    if (!ready || page === undefined) return;
    await flipToCode(page);
    await page.keyboard.press("t");
    expect(await page.locator("#code").isHidden()).toBe(true);
    expect(await page.locator("#graph").isHidden()).toBe(false);
  }, 60_000);

  it("shows every file of the model", async () => {
    if (!ready || page === undefined) return;
    await flipToCode(page);
    const files = await page.evaluate(async () => (await (await fetch("/sources.json")).json()).files.length);
    expect(await page.locator("#code .codeFile").count()).toBe(files);
  }, 60_000);

  /**
   * The one that matters. Colouring is a walk over tokens and their leading trivia, which between them
   * cover every byte; if that is wrong anywhere, the view is showing a file nobody has.
   */
  it("renders every file byte for byte", async () => {
    if (!ready || page === undefined) return;
    await flipToCode(page);
    const compared = await page.evaluate(async () => {
      const body = (await (await fetch("/sources.json")).json()) as {
        files: { path: string; source: string }[];
      };
      const heads = [...document.querySelectorAll("#code .codeFile > header")];
      return body.files.map((f) => {
        const head = heads.find((h) => (h as HTMLElement).title === f.path);
        const pre = head?.nextElementSibling;
        return { path: f.path, same: pre?.textContent === f.source };
      });
    });
    expect(compared.length).toBeGreaterThan(0);
    expect(compared.filter((c) => !c.same)).toEqual([]);
  }, 60_000);

  it("colours by the lexer, so keywords and comments are marked", async () => {
    if (!ready || page === undefined) return;
    await flipToCode(page);
    expect(await page.locator("#code .k").count()).toBeGreaterThan(50);
    expect(await page.locator("#code .c").count()).toBeGreaterThan(5);
    expect(await page.locator("#code .s").count()).toBeGreaterThan(5);
  }, 60_000);

  it("shortens the file headings and keeps the whole path on hover", async () => {
    if (!ready || page === undefined) return;
    await flipToCode(page);
    const head = page.locator("#code .codeFile > header").first();
    const shown = (await head.textContent()) ?? "";
    const full = (await head.getAttribute("title")) ?? "";
    expect(shown).not.toBe("");
    expect(shown.length).toBeLessThan(full.length);
    expect(full).toContain(shown.split("/").at(-1)!);
  }, 60_000);
});

describe("one selection, both sides", () => {
  it("marks the declaration that was selected before the flip", async () => {
    if (!ready || page === undefined) return;
    // Pick something through the palette, which works whichever side is showing.
    await page.keyboard.press("Control+k");
    await page.waitForSelector("#palette:not([hidden])");
    await page.keyboard.type("Recipient", { delay: 10 });
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);

    await flipToCode(page);
    const marked = page.locator("#code .decl.on");
    expect(await marked.count()).toBe(1);
    expect(await marked.getAttribute("data-id")).toContain("Recipient");
  }, 60_000);

  it("selects when a declaration in the text is clicked", async () => {
    if (!ready || page === undefined) return;
    await flipToCode(page);
    const target = page.locator('#code .decl[data-id*="DropParcel"]').first();
    if ((await target.count()) === 0) return;
    await target.click({ position: { x: 4, y: 4 } });
    await page.waitForTimeout(200);
    const marked = page.locator("#code .decl.on");
    expect(await marked.getAttribute("data-id")).toContain("DropParcel");
  }, 60_000);
});
