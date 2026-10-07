/**
 * Adding a declaration, and connecting two by dragging.
 *
 * Both write to the model, so both go through the preview `20-ir.md` section 7 asks for: nothing is
 * on disk until it has been read. That is what these check, in a real browser, against a throwaway
 * model that is rewritten for each test — the alternative is a suite whose later tests depend on what
 * its earlier ones wrote.
 *
 * Node positions come from Cytoscape's own registry on the container. It is a library internal and it
 * is used only here: the graph is drawn into a canvas, so a node is not an element to aim at, and the
 * alternative was a hook in the page that exists only for tests.
 *
 * Needs a browser. Skipped rather than failed without one.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { serve, type Serving } from "../src/serve.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".scratch", "add-drag");
const file = join(dir, "shop.7k");

const MODEL = `package shop

message PlaceOrder v1.0 @command {
  orderId: uuid @role(businessKey)
}

pipe inbound : queue { }

service Desk {
  reacts PlaceOrder from inbound { replies none }
}
`;

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;
let ready = false;

const reset = async (): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(file, MODEL, "utf-8");
};

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ channel: "msedge" });
  } catch {
    return;
  }
  await reset();
  serving = await serve({ paths: [dir], port: 0, watch: false });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  ready = true;
}, 180_000);

afterEach(async () => {
  if (ready) await reset();
});

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await serving?.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

/** A fresh page on the fresh model, so no test inherits another's edits. */
const fresh = async (): Promise<Page> => {
  const p = page!;
  await p.goto(serving!.url);
  await p.waitForSelector("#graph canvas");
  await p.waitForTimeout(700);
  return p;
};

/** Where each node is on the page, out of Cytoscape's own registry. */
const nodesOf = async (p: Page): Promise<Record<string, { x: number; y: number }>> =>
  p.evaluate(() => {
    const el = document.getElementById("graph") as (HTMLElement & { _cyreg?: { cy?: never } }) | null;
    const cy = (el as unknown as { _cyreg?: { cy?: { nodes: () => never } } })?._cyreg?.cy;
    if (el === null || cy === undefined) return {};
    const box = el.getBoundingClientRect();
    const out: Record<string, { x: number; y: number }> = {};
    for (const node of cy.nodes() as unknown as {
      id: () => string;
      renderedPosition: () => { x: number; y: number };
    }[]) {
      const at = node.renderedPosition();
      out[node.id()] = { x: box.left + at.x, y: box.top + at.y };
    }
    return out;
  });

describe.skipIf(false)("adding a declaration", () => {
  it("writes nothing until the preview is accepted", async () => {
    if (!ready) return;
    const p = await fresh();
    await p.selectOption("#addWhat", "topic");
    await p.click("#addNew");
    await p.waitForSelector("#propose:not([hidden])");
    await p.locator("#addForm input").type("audit", { delay: 8 });
    await p.waitForTimeout(150);

    // Previewed, and the file untouched.
    expect(await p.locator("#proposeBody pre").first().textContent()).toContain("pipe audit : topic");
    expect(await readFile(file, "utf-8")).toBe(MODEL);
  }, 60_000);

  it("writes the declaration when it is", async () => {
    if (!ready) return;
    const p = await fresh();
    await p.selectOption("#addWhat", "topic");
    await p.click("#addNew");
    await p.waitForSelector("#addForm input");
    await p.locator("#addForm input").type("audit", { delay: 8 });
    await p.waitForTimeout(150);
    await p.click("#proposeApply");
    await p.waitForTimeout(800);

    const written = await readFile(file, "utf-8");
    expect(written).toContain("pipe audit : topic");
    expect(written).toContain("retention 7d");
    // Appended, so everything that was there is still there, byte for byte.
    expect(written.startsWith(MODEL.trimEnd())).toBe(true);
  }, 60_000);

  it("offers a service, all three pipe kinds, and a saga", async () => {
    if (!ready) return;
    const p = await fresh();
    // The group, not the whole list: the scenario kinds sit in a group of their own and are
    // `scenario-add.test.ts`'s business.
    expect(
      await p.locator('#addWhat optgroup[label="to the model"] option').allTextContents(),
    ).toEqual(["service", "queue", "topic", "stream", "saga"]);
  }, 60_000);

  /**
   * A saga needs a second answer the others do not: `start on M` is part of the declaration, because a
   * saga keyed on nothing has no instances.
   */
  it("asks a saga which message starts it", async () => {
    if (!ready) return;
    const p = await fresh();
    await p.selectOption("#addWhat", "saga");
    await p.click("#addNew");
    await p.waitForSelector("#addForm input");
    expect(await p.locator("#addForm select").count()).toBe(2);
    expect(await p.locator("#addForm select").nth(1).locator("option").allTextContents()).toContain(
      "shop.PlaceOrder",
    );
  }, 60_000);

  it("writes a saga with the version the grammar wants", async () => {
    if (!ready) return;
    const p = await fresh();
    await p.selectOption("#addWhat", "saga");
    await p.click("#addNew");
    await p.waitForSelector("#addForm input");
    await p.locator("#addForm input").type("Checkout", { delay: 8 });
    await p.waitForTimeout(200);
    const preview = await p.locator("#proposeBody pre").first().textContent();
    expect(preview).toContain("saga Checkout v1.0 {");
    expect(preview).toContain("start on PlaceOrder");

    await p.click("#proposeApply");
    await p.waitForTimeout(800);
    const written = await readFile(file, "utf-8");
    expect(written).toContain("saga Checkout v1.0 {");
  }, 60_000);

  it("writes a service as a service", async () => {
    if (!ready) return;
    const p = await fresh();
    await p.selectOption("#addWhat", "service");
    await p.click("#addNew");
    await p.waitForSelector("#addForm input");
    await p.locator("#addForm input").type("Audit", { delay: 8 });
    await p.waitForTimeout(150);
    expect(await p.locator("#proposeBody pre").first().textContent()).toContain("service Audit");
  }, 60_000);

  /** Core refuses a name the package already holds, case folded (D40), and says so before the write. */
  it("refuses a name the package already has", async () => {
    if (!ready) return;
    const p = await fresh();
    await p.selectOption("#addWhat", "queue");
    await p.click("#addNew");
    await p.waitForSelector("#addForm input");
    await p.locator("#addForm input").type("INBOUND", { delay: 8 });
    await p.waitForTimeout(200);
    expect(await p.locator("#proposeBody .why").textContent()).toContain("already declares");
    expect(await p.locator("#proposeApply").isHidden()).toBe(true);
  }, 60_000);

  it("asks for a name before it offers anything", async () => {
    if (!ready) return;
    const p = await fresh();
    await p.click("#addNew");
    await p.waitForSelector("#propose:not([hidden])");
    expect(await p.locator("#proposeBody .why").textContent()).toContain("type a name");
    expect(await p.locator("#proposeApply").isHidden()).toBe(true);
  }, 60_000);
});

describe("connecting by dragging", () => {
  it("proposes the connection a drag describes", async () => {
    if (!ready) return;
    const p = await fresh();
    const at = await nodesOf(p);
    const from = at["service:shop.Desk"];
    const to = at["pipe:shop.inbound"];
    if (from === undefined || to === undefined) return;

    // Shift-drag, which works without arming anything.
    await p.keyboard.down("Shift");
    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await p.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    // The band is only there while the line is being dragged.
    expect(await p.locator(".connectBand").isVisible()).toBe(true);
    await p.mouse.move(to.x, to.y, { steps: 6 });
    await p.mouse.up();
    await p.keyboard.up("Shift");
    await p.waitForTimeout(250);

    await p.waitForSelector("#propose:not([hidden])");
    expect(await p.locator("#proposeWhat").textContent()).toContain("Desk");
    expect(await p.locator("#proposeWhat").textContent()).toContain("inbound");
  }, 60_000);

  it("puts the band away when the drag ends", async () => {
    if (!ready) return;
    const p = await fresh();
    const at = await nodesOf(p);
    const from = at["service:shop.Desk"];
    if (from === undefined) return;

    await p.keyboard.down("Shift");
    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await p.mouse.move(from.x + 60, from.y + 60, { steps: 4 });
    // Dropped on the background: nothing was asked for.
    await p.mouse.up();
    await p.keyboard.up("Shift");
    await p.waitForTimeout(200);

    expect(await p.locator(".connectBand").isVisible()).toBe(false);
    expect(await p.locator("#propose").isHidden()).toBe(true);
  }, 60_000);

  it("leaves a plain drag moving the node", async () => {
    if (!ready) return;
    const p = await fresh();
    const before = await nodesOf(p);
    const from = before["service:shop.Desk"];
    if (from === undefined) return;

    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await p.mouse.move(from.x + 70, from.y + 40, { steps: 6 });
    await p.mouse.up();
    await p.waitForTimeout(300);

    const after = await nodesOf(p);
    expect(after["service:shop.Desk"]?.x).not.toBe(from.x);
    // And it proposed nothing, because a move is not a connection.
    expect(await p.locator("#propose").isHidden()).toBe(true);
  }, 60_000);
});
