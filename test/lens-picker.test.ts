/**
 * A lens per package, which the model implies rather than somebody saving one.
 *
 * `views.json` holds lenses somebody wrote down, and the parcel example has five. But "show me just
 * this subsystem" is a question every model can be asked, because a package is the ownership boundary
 * — the thing that builds, versions and deploys as one — so making an author write an entry per
 * package to ask it is asking them to restate what the model already says.
 *
 * The property worth checking is not that the options exist but that choosing one *narrows*, and that
 * what crosses the boundary comes back as a port. A lens that simply dropped what it did not match
 * would draw a service with no visible reason for the messages leaving it, which `lens.ts` calls a
 * picture that is wrong rather than merely partial.
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
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(serving.url);
  await page.waitForSelector("#graph canvas");
  await page.waitForTimeout(700);
  ready = true;
}, 180_000);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await serving?.close().catch(() => undefined);
});

/** What the graph holds now, by node kind, out of Cytoscape's own registry. */
const drawn = async (p: Page): Promise<{ nodes: number; kinds: Record<string, number> }> =>
  p.evaluate(() => {
    const el = document.getElementById("graph") as unknown as {
      _cyreg?: { cy?: { nodes: () => { length: number; [Symbol.iterator]: () => Iterator<never> } } };
    };
    const cy = el?._cyreg?.cy;
    if (cy === undefined) return { nodes: 0, kinds: {} };
    const kinds: Record<string, number> = {};
    for (const node of cy.nodes() as unknown as { data: (k: string) => string }[]) {
      const kind = node.data("kind") ?? "?";
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    return { nodes: (cy.nodes() as unknown as { length: number }).length, kinds };
  });

const pick = async (p: Page, value: string): Promise<void> => {
  await p.selectOption("#lens", value);
  await p.waitForTimeout(700);
};

describe("the lens picker", () => {
  it("offers the saved views the model committed", async () => {
    if (!ready || page === undefined) return;
    const labels = await page.locator("#lens option").allTextContents();
    expect(labels).toContain("everything");
    expect(labels).toContain("Handover");
    expect(labels).toContain("PiiFlow");
  }, 60_000);

  it("offers one per declared package, without anybody writing them", async () => {
    if (!ready || page === undefined) return;
    const labels = await page.locator("#lens option").allTextContents();
    for (const pkg of ["parcel.common", "parcel.delivery", "parcel.lockers", "parcel.notify"]) {
      expect(labels).toContain(pkg);
    }
  }, 60_000);

  it("keeps them apart from the saved ones", async () => {
    if (!ready || page === undefined) return;
    expect(await page.locator("#lens optgroup").getAttribute("label")).toBe("one package");
  }, 60_000);

  it("narrows the graph to the subsystem", async () => {
    if (!ready || page === undefined) return;
    await pick(page, "");
    const all = await drawn(page);
    await pick(page, "pkg:parcel.notify");
    const one = await drawn(page);
    expect(one.nodes).toBeLessThan(all.nodes);
    expect(one.nodes).toBeGreaterThan(0);
  }, 60_000);

  /** The part that makes it a perimeter rather than a truncation. */
  it("brings what crosses the boundary back as ports", async () => {
    if (!ready || page === undefined) return;
    await pick(page, "");
    expect((await drawn(page)).kinds["port"] ?? 0).toBe(0);
    await pick(page, "pkg:parcel.notify");
    expect((await drawn(page)).kinds["port"] ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it("goes back to everything", async () => {
    if (!ready || page === undefined) return;
    await pick(page, "pkg:parcel.lockers");
    const one = await drawn(page);
    await pick(page, "");
    expect((await drawn(page)).nodes).toBeGreaterThan(one.nodes);
  }, 60_000);
});
