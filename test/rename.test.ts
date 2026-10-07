/**
 * Renaming from the graph.
 *
 * The part Spider owns is the one D98 said matters: a rename reaches `layout.json` and `views.json` in
 * the same request as the model files, or it silently discards every saved position and every lens
 * entry that named the old name. So the sidecars are what this asserts. What a rename *writes* is
 * Core's, and `7K/packages/core/test/mutate.test.ts` holds it.
 *
 * Needs a browser. Skipped rather than failed without one.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { serve, type Serving } from "../src/serve.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".scratch", "rename");
const file = join(dir, "shop.7k");
const scenarios = join(dir, "shop.scenario.7k");
const layout = join(dir, ".7k", "layout.json");
const views = join(dir, ".7k", "views.json");

const MODEL = `package shop

message Place v1.0 @command { orderId: uuid @role(businessKey) }
message Placed v1.0 @event  { orderId: uuid @role(businessKey) }

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }

service Storefront @external {
  emits Place to inbound
}

service Desk {
  reacts Place from inbound { replies Placed }
  emits  Placed to events
}
`;

const SCENARIOS = `scenarios for shop

scenario Baseline {
  seed 1
  at 0s publish Place as Storefront
  advance 1s
  expect Placed on events
}
`;

const LAYOUT = `{
  "_comment": "Kept, because a rename must not discard it.",
  "*": {
    "collapsed": ["package:other"],
    "nodes": {
      "service:shop.Desk": { "x": 80, "y": 40 },
      "pipe:shop.events": { "x": 320, "y": 40 }
    }
  }
}
`;

const VIEWS = `{
  "Front": { "include": ["service:Desk"] },
  "Other": { "include": ["label:pii"] }
}
`;

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;
let ready = false;

const reset = async (): Promise<void> => {
  await mkdir(join(dir, ".7k"), { recursive: true });
  await writeFile(file, MODEL, "utf-8");
  await writeFile(scenarios, SCENARIOS, "utf-8");
  await writeFile(layout, LAYOUT, "utf-8");
  await writeFile(views, VIEWS, "utf-8");
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
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  ready = true;
}, 180_000);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await serving?.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const open = async (): Promise<Page> => {
  const p = page!;
  await reset();
  await p.goto(serving!.url);
  await p.waitForSelector("#graph canvas");
  return p;
};

/**
 * Right-clicks a node by its drawn position, which is the only way in to the menu.
 *
 * Centred first, because a saved position is honoured literally and nothing re-fits the graph after
 * reading one — so a pinned node can sit outside the viewport, where a pointer cannot reach it. That is
 * what a person does too: pan to it, or find it through the palette. It cost an hour to work out from a
 * click that silently did nothing, which is its own small argument for a `fit` the page can offer.
 */
const rightClickOn = async (p: Page, id: string): Promise<void> => {
  const at = await p.evaluate((wanted) => {
    const host = document.getElementById("graph") as unknown as {
      _cyreg?: {
        cy?: {
          center: (el: unknown) => void;
          getElementById: (id: string) => {
            length: number;
            renderedBoundingBox: () => { x1: number; x2: number; y1: number; y2: number };
          };
        };
      };
    };
    const cy = host?._cyreg?.cy;
    const el = cy?.getElementById(wanted);
    if (cy === undefined || el === undefined || el.length === 0) return undefined;
    cy.center(el);
    const box = el.renderedBoundingBox();
    return box.x2 - box.x1 === 0
      ? undefined
      : { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
  }, id);
  expect(at, `${id} is not drawn`).toBeDefined();
  const graph = await p.locator("#graph").boundingBox();
  await p.mouse.click(graph!.x + at!.x, graph!.y + at!.y, { button: "right" });
};

const renameTo = async (p: Page, id: string, to: string): Promise<void> => {
  await rightClickOn(p, id);
  await p.waitForSelector("#menu:not([hidden])");
  await p.locator("#menu button", { hasText: "rename" }).first().click();
  await p.waitForSelector("#addForm input");
  await p.locator("#addForm input").fill(to);
  await p.waitForTimeout(300);
};

describe("renaming a service", () => {
  it("says how many files it will touch before it touches any", async () => {
    if (!ready) return;
    const p = await open();
    await renameTo(p, "service:shop.Desk", "Counter");
    // Model, scenario-less in this case, layout and views: the number is what says it found them.
    expect(await p.locator("#proposeWhat").textContent()).toMatch(/\d+ edits in \d+ files/);
    expect(await readFile(file, "utf-8")).toBe(MODEL);
  }, 90_000);

  it("carries the saved position and the lens entry with it", async () => {
    if (!ready) return;
    const p = await open();
    await renameTo(p, "service:shop.Desk", "Counter");
    await p.click("#proposeApply");
    await p.waitForTimeout(1800);

    expect(await readFile(file, "utf-8")).toContain("service Counter {");
    expect(await readFile(layout, "utf-8")).toContain('"service:shop.Counter"');
    expect(await readFile(views, "utf-8")).toContain('"service:Counter"');
    // And what was not about it is untouched, byte for byte in the parts that matter.
    expect(await readFile(layout, "utf-8")).toContain("Kept, because a rename must not discard it.");
    expect(await readFile(layout, "utf-8")).toContain('"collapsed": ["package:other"]');
    expect(await readFile(views, "utf-8")).toContain('"label:pii"');
  }, 90_000);

  it("is one write, so the model and the sidecars cannot disagree", async () => {
    if (!ready) return;
    const p = await open();
    await renameTo(p, "service:shop.Storefront", "Shopfront");
    await p.click("#proposeApply");
    await p.waitForTimeout(1800);

    // The scenario publishes `as Storefront`, so all three had to move together.
    expect(await readFile(file, "utf-8")).toContain("service Shopfront @external");
    expect(await readFile(scenarios, "utf-8")).toContain("publish Place as Shopfront");
    expect(await readFile(file, "utf-8")).not.toContain("Storefront");
    expect(await readFile(scenarios, "utf-8")).not.toContain("Storefront");
  }, 90_000);

  it("can be taken back in one go", async () => {
    if (!ready) return;
    const p = await open();
    await renameTo(p, "service:shop.Desk", "Counter");
    await p.click("#proposeApply");
    await p.waitForTimeout(1800);

    await p.click("#undo");
    await p.waitForTimeout(1800);
    // Every file, including the sidecars, because the undo entry holds the same set the write did.
    expect(await readFile(file, "utf-8")).toBe(MODEL);
    expect(await readFile(layout, "utf-8")).toBe(LAYOUT);
    expect(await readFile(views, "utf-8")).toBe(VIEWS);
  }, 90_000);
});

describe("renaming a pipe", () => {
  it("moves its key too", async () => {
    if (!ready) return;
    const p = await open();
    await renameTo(p, "pipe:shop.events", "published");
    await p.click("#proposeApply");
    await p.waitForTimeout(1800);

    expect(await readFile(file, "utf-8")).toContain("pipe published");
    expect(await readFile(scenarios, "utf-8")).toContain("expect Placed on published");
    expect(await readFile(layout, "utf-8")).toContain('"pipe:shop.published"');
  }, 90_000);
});

describe("what the form will not accept", () => {
  it("refuses a name the package already has", async () => {
    if (!ready) return;
    const p = await open();
    await renameTo(p, "pipe:shop.events", "inbound");
    expect(await p.locator("#proposeBody .why").textContent()).toContain("already declares");
    expect(await p.locator("#proposeApply").isHidden()).toBe(true);
  }, 90_000);

  it("offers nothing for the name it already has", async () => {
    if (!ready) return;
    const p = await open();
    await renameTo(p, "pipe:shop.events", "events");
    expect(await p.locator("#proposeBody .why").textContent()).toContain("already has");
    expect(await p.locator("#proposeApply").isHidden()).toBe(true);
  }, 90_000);

  it("names every file it will touch, which is what there is to check before accepting", async () => {
    if (!ready) return;
    const p = await open();
    // `Desk` is the one with a saved position and a lens entry; the scenario names `Storefront` and
    // `events` instead, which the earlier tests cover.
    await renameTo(p, "service:shop.Desk", "Counter");
    const joined = (await p.locator("#proposeBody .where").allTextContents()).join(" | ");
    expect(joined).toContain("shop.7k");
    // The half D98 said matters, listed rather than implied.
    expect(joined).toContain("layout.json");
    expect(joined).toContain("views.json");
  }, 90_000);
});
