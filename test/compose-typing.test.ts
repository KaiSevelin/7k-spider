/**
 * Typing into the composer, in a real browser.
 *
 * Two faults met here, and only the second explains what it felt like. The page's one-letter
 * shortcuts skipped `input` and `select` but not `textarea`, so a message body could fire them. And
 * the form rebuilt itself on every keystroke to re-run validation, which replaced the very input
 * being typed into: focus fell back to the page, so the *first* letter landed in the field and every
 * letter after it was read as a shortcut. Typing `a dog` opened the About panel and the data view and
 * left `a` in the box.
 *
 * So what is checked is a sentence going in whole, nothing else happening while it does, and
 * validation still being live — the reason the rebuild was there at all.
 */

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { serve, type Serving } from "../src/serve.js";

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
    return; // no Edge here
  }
  serving = await serve({ paths: [join(root, "examples")], port: 0, watch: false });
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto(serving.url);
  await page.waitForSelector("#graph");
  ready = true;
}, 180_000);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await serving?.close().catch(() => undefined);
});

const open = async (p: Page): Promise<void> => {
  if (await p.locator("#compose").isHidden()) await p.click("#toggleCompose");
  await p.waitForSelector("#compose:not([hidden])");
  await p.waitForSelector("#composeForm .f");
};

/** Which panels are showing, so a stray shortcut has nowhere to hide. */
const panels = async (p: Page): Promise<Record<string, boolean>> => {
  const out: Record<string, boolean> = {};
  for (const id of ["data", "about", "legend", "saga", "open", "palette", "preview", "sequence"]) {
    out[id] = !(await p.locator(`#${id}`).isHidden());
  }
  return out;
};

describe("typing a message", () => {
  it("puts the whole sentence in the field", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    const field = page.locator("#composeForm input[type=text]").first();
    await field.click();
    await field.fill("");
    // Every letter here is also a shortcut: d, a, c, s, g, o, f, v, e, and the spaces.
    await field.type("a dog, a cat and 3 doves", { delay: 5 });
    expect(await field.inputValue()).toBe("a dog, a cat and 3 doves");
  }, 60_000);

  it("opens nothing while you type", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    const before = await panels(page);
    const field = page.locator("#composeForm input[type=text]").first();
    await field.click();
    await field.fill("");
    await field.type("deface a logo", { delay: 5 });
    expect(await panels(page)).toEqual(before);
  }, 60_000);

  it("leaves the composer open, which `c` would have shut", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    const field = page.locator("#composeForm input[type=text]").first();
    await field.click();
    await field.type("cccc", { delay: 5 });
    expect(await page.locator("#compose").isHidden()).toBe(false);
  }, 60_000);

  it("keeps the focus on the field it started in", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    const field = page.locator("#composeForm input[type=text]").first();
    await field.click();
    await field.fill("");
    await field.type("still here", { delay: 5 });
    const focused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? "");
    expect(focused).toBe("input");
  }, 60_000);

  /**
   * The rebuild existed to keep validation live, so losing it would be the wrong fix.
   *
   * Driven by emptying a required field rather than by typing something malformed: which message the
   * composer opens on is whatever sorts first, and what counts as malformed depends on its type. An
   * empty required field is wrong under every type there is.
   */
  it("still marks a field wrong as you type, and unmarks it", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    const field = page.locator("#composeForm input[type=text]").first();
    const wrap = page.locator("#composeForm .f").first();

    await field.click();
    await field.fill("");
    await page.waitForTimeout(80);
    expect(await wrap.getAttribute("class")).toContain("invalid");
    expect(await wrap.locator(":scope > .bad").count()).toBeGreaterThan(0);

    await field.type("P-4711", { delay: 5 });
    await page.waitForTimeout(80);
    expect(await wrap.getAttribute("class")).not.toContain("invalid");
    expect(await wrap.locator(":scope > .bad").count()).toBe(0);
  }, 60_000);

  it("says how many problems there are while you type", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    const field = page.locator("#composeForm input[type=text]").first();
    await field.click();
    await field.fill("");
    await field.type("x", { delay: 5 });
    await page.waitForTimeout(80);
    expect(await page.locator("#composeState").textContent()).toMatch(/problem|valid/);
  }, 60_000);
});
