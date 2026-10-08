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
   * Selecting is not going anywhere.
   *
   * This panel used to re-centre on whatever was selected, so the gesture for pointing at something
   * and the gesture for replacing the drawing were the same one — and in a view that is already hard
   * to hold, a click that throws the picture away leaves nothing to compare the new one to. Driven
   * through the palette, which is a real way to select a declaration the graph does not draw: it
   * draws services and pipes, and a record is neither.
   */
  it("does not move when something else is selected", async () => {
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

    await page.keyboard.press("Control+k");
    await page.waitForSelector("#palette:not([hidden])");
    await page.keyboard.type("Recipient", { delay: 10 });
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);

    // Selected — the sidebar says so — and the panel is still where it was put.
    expect(await page.locator("#sidebar").isVisible()).toBe(true);
    expect(await page.locator("#dataSubject").inputValue()).toBe(away);
    const scope = (await page.locator("#dataScope").textContent()) ?? "";
    expect(scope.replace("around ", "").trim()).toBe(away.slice(away.lastIndexOf(".") + 1));
  }, 60_000);

  /** And the way that *is* meant to move it: right-click, and ask. */
  it("moves when the menu is asked to centre it", async () => {
    if (!ready || page === undefined) return;
    await open(page);
    const away = await page.evaluate(() => {
      const picker = document.getElementById("dataSubject") as HTMLSelectElement;
      const option = [...picker.options].find((o) => !o.value.includes("Recipient"));
      return option?.value ?? "";
    });
    await page.selectOption("#dataSubject", away);
    await page.waitForTimeout(200);

    // A node of the data canvas, asked of the view rather than guessed at: Cytoscape draws to a
    // canvas, so there is no element to right-click. Through `_cyreg`, which is how the other
    // browser tests reach the graph's own instance. Centred first, for the same reason they do.
    const at = await page.evaluate(() => {
      const host = document.getElementById("dataCanvas") as unknown as {
        _cyreg?: {
          cy?: {
            center: (el: unknown) => void;
            nodes: () => {
              length: number;
              [i: number]: {
                id: () => string;
                isParent: () => boolean;
                renderedBoundingBox: () => { x1: number; x2: number; y1: number; y2: number };
              };
            };
          };
        };
      };
      const cy = host?._cyreg?.cy;
      if (cy === undefined) return undefined;
      const nodes = cy.nodes();
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]!;
        const id = node.id();
        // A package box is a parent and not a declaration, so it has no `centre on` row.
        if (node.isParent() || !/^(record|value|enum|envelope):/.test(id)) continue;
        cy.center(node);
        const box = node.renderedBoundingBox();
        if (box.x2 - box.x1 === 0) continue;
        return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2, id };
      }
      return undefined;
    });
    expect(at, "no data node is drawn to right-click").toBeDefined();

    const canvas = await page.locator("#dataCanvas").boundingBox();
    await page.mouse.click(canvas!.x + at!.x, canvas!.y + at!.y, { button: "right" });
    await page.waitForSelector("#menu:not([hidden])");
    const row = page.locator("#menu button", { hasText: "centre the data view on" }).first();
    expect(await row.count()).toBe(1);
    await row.click();
    await page.waitForTimeout(300);

    expect(await page.locator("#dataSubject").inputValue()).toBe(at!.id);
  }, 60_000);
});
