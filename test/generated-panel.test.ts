/**
 * The generated-code drawer, in a real browser, driven the way a reader drives it.
 *
 * All of this is behaviour a DOM either has or does not: a card shut shows no code, its header
 * toggles it, one control does every card at once, and the panel hides and comes back with its
 * contents intact. A source scan cannot see any of that, and a test that builds the markup itself
 * would be checking its own fixture — the point is that the page's own script wires it up.
 *
 * So the panel is filled by right-clicking the graph and picking `generate everything` out of the
 * menu, which is the only route a reader has to it.
 *
 * Needs a browser and the four provider repositories. Skipped rather than failed without either, so
 * a fresh clone still has a green suite.
 *
 * Assertions go through the locator rather than `expect(locator).toBeVisible()`: that matcher belongs
 * to Playwright's own `expect`, and this file uses vitest's, which reports it as an invalid property
 * rather than as a failing check.
 */

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { serve, type Serving } from "../src/serve.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const haveProviders = (() => {
  const from = createRequire(join(root, "7k.local"));
  try {
    for (const n of ["csharp", "sqlserver", "bicep", "node"]) from.resolve(`@sevenk/${n}`);
    return true;
  } catch {
    return false;
  }
})();

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;

/** True once there is a browser, a server and a filled panel to ask questions of. */
let ready = false;

/** Right-click the graph and pick the menu item that generates everything. */
const fill = async (p: Page): Promise<void> => {
  const box = await p.locator("#graph").boundingBox();
  if (box === null) throw new Error("no graph to right-click");
  // A corner, so the click lands on the background and the scope is the whole system.
  await p.mouse.click(box.x + 12, box.y + 12, { button: "right" });
  await p.waitForSelector("#menu:not([hidden])");
  await p.getByText("generate everything", { exact: true }).click();
  await p.waitForSelector("#preview:not([hidden])");
  await p.waitForSelector("#previewDocs .doc");
};

beforeAll(async () => {
  if (!haveProviders) return;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ channel: "msedge" });
  } catch {
    return; // no Edge here
  }
  serving = await serve({ paths: [join(root, "examples")], port: 0, watch: false });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(serving.url);
  await page.waitForSelector("#graph");
  await fill(page);
  ready = true;
}, 180_000);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await serving?.close().catch(() => undefined);
});

/** Shuts everything, so each test starts from the state the panel opens in. */
const reset = async (p: Page): Promise<void> => {
  await p.evaluate(() => {
    document.getElementById("preview")!.hidden = false;
    for (const card of document.querySelectorAll("#previewDocs .doc")) card.classList.remove("open");
  });
};

const cards = (p: Page) => p.locator("#previewDocs .doc").filter({ has: p.locator("pre") });

describe.skipIf(!haveProviders)("the generated-code drawer", () => {
  it("fills from the menu, with a card per file", async () => {
    if (!ready || page === undefined) return;
    expect(await cards(page).count()).toBeGreaterThan(20);
  });

  /**
   * Flush right and filling the graph region, which is what `#data` and the other drawers do.
   *
   * Measured against `#graph` rather than the window: the panel is positioned inside that region, so
   * it starts below the header and the filter row and stops above the timeline. An assertion against
   * the viewport's own top said 0 and got 82, which was the test being wrong rather than the panel.
   */
  it("is a drawer against the right edge, so the graph stays beside it", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const box = await page.locator("#preview").boundingBox();
    const area = await page.locator("#graph").boundingBox();
    const size = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(area).not.toBeNull();
    expect(Math.round(box!.x + box!.width)).toBe(size.width);
    expect(Math.round(box!.y)).toBe(Math.round(area!.y));
    expect(Math.round(box!.height)).toBe(Math.round(area!.height));
    // Narrower than the window, so what the code came from is still on screen behind it.
    expect(box!.width).toBeLessThan(size.width * 0.6);
  });

  it("shows no code at all until a header is clicked", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    expect(await page.locator("#previewDocs .doc pre:visible").count()).toBe(0);
    // The headers are all there, which is the list the panel is for.
    expect(await page.locator("#previewDocs .doc > header .path:visible").count()).toBeGreaterThan(20);
  });

  it("opens and shuts one file when its header is clicked", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const first = cards(page).first();
    await first.locator("header").click();
    expect(await first.locator("pre").isVisible()).toBe(true);
    expect(await page.locator("#previewDocs .doc pre:visible").count()).toBe(1);

    await first.locator("header").click();
    expect(await first.locator("pre").isHidden()).toBe(true);
    expect(await page.locator("#previewDocs .doc pre:visible").count()).toBe(0);
  });

  it("opens every file from the one control at the top, and shuts them again", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const total = await cards(page).count();

    await page.locator("#previewAll").click();
    expect(await page.locator("#previewDocs .doc pre:visible").count()).toBe(total);
    // The control says what it will do next, not what it did.
    expect(await page.locator("#previewAll").getAttribute("title")).toContain("shut every file");

    await page.locator("#previewAll").click();
    expect(await page.locator("#previewDocs .doc pre:visible").count()).toBe(0);
    expect(await page.locator("#previewAll").getAttribute("title")).toContain("open every file");
  });

  /** Copy and dismiss were required to be reachable whether or not the code is showing. */
  it("keeps copy and dismiss reachable in both states", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const header = cards(page).first().locator("header");
    expect(await header.locator("button.icon:visible").count()).toBeGreaterThanOrEqual(2);
    await header.click();
    expect(await header.locator("button.icon:visible").count()).toBeGreaterThanOrEqual(2);
  });

  /** A button in the header is its own control, not a click on the card. */
  it("does not open the card when a header button is used", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const first = cards(page).first();
    await first.locator("header button.icon").first().click();
    expect(await first.locator("pre").isHidden()).toBe(true);
  });

  it("hides on Escape and comes back from the header, with its contents", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const before = await cards(page).count();

    await page.locator("#graph").click({ position: { x: 12, y: 12 } });
    await page.keyboard.press("Escape");
    expect(await page.locator("#preview").isHidden()).toBe(true);

    expect(await page.locator("#toggleGenerated").isVisible()).toBe(true);
    await page.locator("#toggleGenerated").click();
    expect(await page.locator("#preview").isVisible()).toBe(true);
    expect(await cards(page).count()).toBe(before);
  });
});
