/**
 * Choosing how a drawing is laid out.
 *
 * There are four pictures of one model and they are not the same shape. A topology is bipartite and
 * reads down the page; a message and the thirty values it reaches is a fan, and a fan laid out in
 * layers is a row of boxes with a bundle of lines under it, which is a picture of nothing. So the
 * algorithm is a reader's question, and these check it is a question they can answer.
 *
 * **The load-bearing one is `every layout draws something`.** The list is offered per canvas and both
 * canvases draw compound nodes — a package is a parent box — and not every ELK algorithm handles a
 * hierarchy. An option that silently stacks every node on one point, or puts one at `NaN`, is worse
 * than not offering it, and neither shows up in a screenshot of a graph nobody chose that layout for.
 *
 * Positions are asked of Cytoscape through `_cyreg`, which is how the rest of these tests reach a
 * drawing: it renders to a canvas, so there is nothing to query in the DOM.
 *
 * Needs a browser. Skipped rather than failed without one.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { LAYOUTS } from "../src/layouts.js";
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

/** Every leaf node's position on one canvas, keyed by id. Parents follow their children. */
const positions = (p: Page, host: string): Promise<Record<string, { x: number; y: number }>> =>
  p.evaluate((id) => {
    const container = document.getElementById(id) as unknown as {
      _cyreg?: {
        cy?: {
          nodes: () => {
            length: number;
            [i: number]: {
              id: () => string;
              isParent: () => boolean;
              position: () => { x: number; y: number };
            };
          };
        };
      };
    };
    const cy = container?._cyreg?.cy;
    const out: Record<string, { x: number; y: number }> = {};
    if (cy === undefined) return out;
    const nodes = cy.nodes();
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      if (node.isParent()) continue;
      const at = node.position();
      out[node.id()] = { x: at.x, y: at.y };
    }
    return out;
  }, host);

const openData = async (p: Page): Promise<void> => {
  if (await p.locator("#data").isHidden()) await p.click("#toggleData");
  await p.waitForSelector("#data:not([hidden])");
  await p.waitForSelector("#dataCanvas canvas");
};

describe("the layout picker", () => {
  it("offers the same list on both canvases", async () => {
    if (!ready || page === undefined) return;
    await openData(page);
    const names = LAYOUTS.map((l) => l.label);
    expect(await page.locator("#layout option").allTextContents()).toEqual(names);
    expect(await page.locator("#dataLayout option").allTextContents()).toEqual(names);
  }, 60_000);

  it("starts both on the layered one, which is what the drawings were designed around", async () => {
    if (!ready || page === undefined) return;
    await openData(page);
    expect(await page.locator("#layout").inputValue()).toBe("down");
    expect(await page.locator("#dataLayout").inputValue()).toBe("down");
  }, 60_000);

  /**
   * Every option, on the canvas with the most to go wrong.
   *
   * Not "it changed" — a layout that put everything at the origin would change it too. What is
   * asserted is that the result is a drawing: finite coordinates, and nodes in more than one place.
   */
  it("draws something under every layout it offers", async () => {
    if (!ready || page === undefined) return;
    await openData(page);

    for (const choice of LAYOUTS) {
      await page.selectOption("#dataLayout", choice.id);
      await page.waitForTimeout(400);
      const at = await positions(page, "dataCanvas");
      const ids = Object.keys(at);
      expect(ids.length, `${choice.id} drew nothing`).toBeGreaterThan(1);

      for (const id of ids) {
        expect(Number.isFinite(at[id]!.x), `${choice.id} put ${id} at a non-finite x`).toBe(true);
        expect(Number.isFinite(at[id]!.y), `${choice.id} put ${id} at a non-finite y`).toBe(true);
      }

      // More than one distinct point, so an algorithm that collapsed the graph onto one spot is a
      // failure here rather than a picture somebody has to interpret.
      const distinct = new Set(ids.map((id) => `${Math.round(at[id]!.x)},${Math.round(at[id]!.y)}`));
      expect(distinct.size, `${choice.id} stacked every node on one point`).toBeGreaterThan(1);
    }

    await page.selectOption("#dataLayout", "down");
    await page.waitForTimeout(300);
  }, 180_000);

  it("actually moves the graph when the graph's own picker changes", async () => {
    if (!ready || page === undefined) return;
    const before = await positions(page, "graph");
    await page.selectOption("#layout", "right");
    await page.waitForTimeout(600);
    const after = await positions(page, "graph");

    const shared = Object.keys(before).filter((id) => id in after);
    expect(shared.length).toBeGreaterThan(2);
    expect(shared.some((id) => before[id]!.x !== after[id]!.x || before[id]!.y !== after[id]!.y)).toBe(
      true,
    );

    await page.selectOption("#layout", "down");
    await page.waitForTimeout(600);
  }, 90_000);

  /** Two drawings, two answers. Sharing one picker would mean one of them is always wrong. */
  it("keeps the two canvases independent", async () => {
    if (!ready || page === undefined) return;
    await openData(page);
    await page.selectOption("#dataLayout", "tree");
    await page.waitForTimeout(400);
    expect(await page.locator("#layout").inputValue()).toBe("down");
    expect(await page.locator("#dataLayout").inputValue()).toBe("tree");

    await page.selectOption("#dataLayout", "down");
    await page.waitForTimeout(300);
  }, 60_000);

  /**
   * D25 says the same model gives the same picture. A reader choosing a layout is not that rule
   * breaking — it is them asking — but choosing one twice had better still give one answer, which is
   * what the pinned seed on `stress` is for.
   */
  it("gives the same picture twice for the same choice", async () => {
    if (!ready || page === undefined) return;
    await openData(page);
    await page.selectOption("#dataLayout", "stress");
    await page.waitForTimeout(500);
    const first = await positions(page, "dataCanvas");

    await page.selectOption("#dataLayout", "down");
    await page.waitForTimeout(400);
    await page.selectOption("#dataLayout", "stress");
    await page.waitForTimeout(500);
    const second = await positions(page, "dataCanvas");

    const round = (at: Record<string, { x: number; y: number }>): Record<string, string> =>
      Object.fromEntries(
        Object.entries(at).map(([id, p]) => [id, `${Math.round(p.x)},${Math.round(p.y)}`]),
      );
    expect(round(second)).toEqual(round(first));

    await page.selectOption("#dataLayout", "down");
    await page.waitForTimeout(300);
  }, 90_000);
});
