/**
 * The data panel, and the one state it had no answer for.
 *
 * `data.ts` opens by saying the whole type graph at once "is a hairball and would be the fastest way
 * to make this view useless", and that the default is therefore a neighbourhood. The panel honoured
 * that only while something was selected: opened before clicking anything, it fell through to drawing
 * every declaration and every edge between them, which is exactly the picture that file set out to
 * avoid.
 *
 * So the panel has a subject of its own now, and these check that it always has one — that the view is
 * bounded on opening, that the subject and the selection never disagree, and that "everything" is
 * still reachable, because the point was never that it is forbidden.
 *
 * Needs a browser. Skipped rather than failed without one.
 */

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
    return;
  }
  serving = await serve({ paths: [join(root, "examples")], port: 0, watch: false });
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
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
  if (await p.locator("#data").isHidden()) await p.click("#toggleData");
  await p.waitForSelector("#data:not([hidden])");
  await p.waitForSelector("#dataCanvas canvas");
};

/** How many nodes the drawing holds, asked of the view rather than counted off the canvas. */
const drawn = async (p: Page): Promise<number> =>
  p.evaluate(() => {
    // The scope line names the subject; the hidden count is what the view left out.
    const hidden = document.getElementById("dataHidden")?.textContent ?? "";
    const match = /(\d+) hidden/.exec(hidden);
    return match === null ? 0 : Number(match[1]);
  });

describe("the data panel on opening", () => {
  it("has a subject without anything being selected", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    expect(await page.locator("#dataSubject").inputValue()).not.toBe("");
  }, 60_000);

  it("offers every data declaration in the model to centre on", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    // Messages, records, values, enums and envelopes — not services or pipes, which are the other view.
    expect(await page.locator("#dataSubject option").count()).toBeGreaterThan(20);
  }, 60_000);

  it("draws a neighbourhood rather than everything", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    expect(await page.locator("#dataScope").textContent()).toMatch(/^around /);
    // Something was held back, which is the whole claim: this is not the whole graph.
    expect(await drawn(page)).toBeGreaterThan(0);
  }, 60_000);

  it("redraws around whatever the picker is moved to", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    const options = await page.locator("#dataSubject option").allTextContents();
    const other = options.find((o) => o.includes("Recipient")) ?? options[2]!;
    await page.selectOption("#dataSubject", { label: other });
    await page.waitForTimeout(250);
    const scope = await page.locator("#dataScope").textContent();
    expect(scope).toMatch(/^around /);
    expect(other).toContain((scope ?? "").replace("around ", "").trim());
  }, 60_000);

  /** Bounded by default was the point; forbidden was not. */
  it("still draws everything when asked to", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    await page.selectOption("#dataDepth", "0");
    await page.waitForTimeout(250);
    expect(await page.locator("#dataScope").textContent()).toBe("everything");
    expect(await page.locator("#dataHidden").textContent()).toBe("");
    await page.selectOption("#dataDepth", "2");
    await page.waitForTimeout(250);
  }, 60_000);

  /**
   * Through the palette, which is a real way to select a declaration the graph does not draw — it
   * draws services and pipes, and a record is neither.
   */
  it("follows the selection when one is made", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    // Somewhere else first, so this cannot pass because an earlier test left it there.
    const away = await page.evaluate(() => {
      const picker = document.getElementById("dataSubject") as HTMLSelectElement;
      const option = [...picker.options].find((o) => !o.value.includes("Recipient"));
      return option?.value ?? "";
    });
    await page.selectOption("#dataSubject", away);
    await page.waitForTimeout(150);
    const before = await page.locator("#dataSubject").inputValue();
    expect(before).toBe(away);

    await page.keyboard.press("Control+k");
    await page.waitForSelector("#palette:not([hidden])");
    await page.keyboard.type("Recipient", { delay: 10 });
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    const after = await page.locator("#dataSubject").inputValue();
    expect(after).not.toBe("");
    // The picker and the scope line are one panel and must not say different things.
    const scope = (await page.locator("#dataScope").textContent()) ?? "";
    expect(scope).toMatch(/^around /);
    const bare = after.slice(after.lastIndexOf(".") + 1);
    expect(scope.replace("around ", "").trim()).toBe(bare);
    expect(after).not.toBe(before);
    expect(after).toContain("Recipient");
  }, 60_000);
});
