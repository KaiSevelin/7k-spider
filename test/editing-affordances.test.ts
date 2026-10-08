/**
 * The four things the editor did not say, and one it could not do.
 *
 * Each of these was reported as a bug rather than found by a test, which is the useful part: they are
 * all cases where the page did something defensible and told the reader nothing, so the reader
 * concluded it had failed.
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
const dir = join(root, ".scratch", "affordances");
const file = join(dir, "shop.7k");
const views = join(dir, ".7k", "views.json");

/** Two packages that talk to each other, so a one-package lens has a boundary to draw. */
const MODEL = `package shop

message Place v1.0 @command { orderId: uuid @role(businessKey) }
message Placed v1.0 @event  { orderId: uuid @role(businessKey) }

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }

service Desk {
  reacts Place from inbound { replies Placed }
  emits  Placed to events
}

// Nothing talks to this one, which is what makes it removable.
service Spare {
}
`;

const OTHER = `package warehouse

import shop

pipe picks : queue { retention 7d }

service Picking {
  reacts shop.Placed from shop.events { replies none }
}
`;

const VIEWS = `{
  "Perimeter": { "include": ["label:external"] }
}
`;

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;
let ready = false;

const reset = async (): Promise<void> => {
  await mkdir(join(dir, ".7k"), { recursive: true });
  await writeFile(file, MODEL, "utf-8");
  await writeFile(join(dir, "warehouse.7k"), OTHER, "utf-8");
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

/** The ids the graph is drawing, read from the renderer rather than from a screenshot. */
const drawn = (p: Page): Promise<string[]> =>
  p.evaluate(() => {
    const host = document.getElementById("graph") as unknown as {
      _cyreg?: { cy?: { nodes: () => { id: () => string }[] } };
    };
    const cy = host?._cyreg?.cy;
    return cy === undefined ? [] : [...cy.nodes()].map((n) => n.id());
  });

/** The classes Cytoscape has on one node, which is where the connect affordance lives. */
const classesOf = (p: Page, id: string): Promise<string[]> =>
  p.evaluate((wanted) => {
    const host = document.getElementById("graph") as unknown as {
      _cyreg?: { cy?: { getElementById: (id: string) => { classes: () => string[] } } };
    };
    return host?._cyreg?.cy?.getElementById(wanted).classes() ?? [];
  }, id);

describe("a one-package lens", () => {
  it("draws that package and stands a port where anything leaves it", async () => {
    if (!ready) return;
    const p = await open();
    await p.selectOption("#lens", "pkg:shop");
    await p.waitForTimeout(400);

    const ids = await drawn(p);
    expect(ids).toContain("service:shop.Desk");
    expect(ids).toContain("package:shop");
    // The boundary is the package, so nothing of the warehouse's is drawn — not its service, not its
    // pipes, and not its package box.
    expect(ids.filter((id) => id.includes("warehouse"))).toEqual([]);
    expect(ids.some((id) => id.startsWith("port:"))).toBe(true);
  }, 90_000);
});

describe("the lens picker", () => {
  it("separates its own row from the reader's names and the derived ones", async () => {
    if (!ready) return;
    const p = await open();
    // Spider's own row is marked as chrome rather than sitting among the names as a third convention.
    expect(await p.locator("#lens option[value='']").textContent()).toContain("everything");
    const groups = await p.locator("#lens optgroup").evaluateAll((gs) =>
      gs.map((g) => (g as HTMLOptGroupElement).label),
    );
    expect(groups.some((g) => g.includes("views.json"))).toBe(true);
    expect(groups).toContain("one package");
    // And a saved name is shown exactly as it was written.
    expect(await p.locator("#lens option[value='Perimeter']").textContent()).toBe("Perimeter");
  }, 90_000);
});

describe("adding while a lens is on", () => {
  it("says what was written, and that the lens is why it is not drawn", async () => {
    if (!ready) return;
    const p = await open();
    await p.selectOption("#lens", "Perimeter");
    await p.waitForTimeout(400);

    await p.selectOption("#addWhat", "service");
    await p.click("#addNew");
    await p.waitForSelector("#addForm input");
    await p.locator("#addForm input").fill("Later");
    await p.waitForTimeout(250);
    await p.click("#proposeApply");
    await p.waitForTimeout(1500);

    expect(await readFile(file, "utf-8")).toContain("service Later");
    const said = (await p.locator("#status").textContent()) ?? "";
    expect(said).toContain("add service Later to shop");
    expect(said).toContain("Perimeter");
  }, 90_000);

  it("just says what was written when it is on screen", async () => {
    if (!ready) return;
    const p = await open();
    await p.selectOption("#addWhat", "service");
    await p.click("#addNew");
    await p.waitForSelector("#addForm input");
    await p.locator("#addForm input").fill("Later");
    await p.waitForTimeout(250);
    await p.click("#proposeApply");
    await p.waitForTimeout(1500);

    const said = (await p.locator("#status").textContent()) ?? "";
    expect(said).toContain("add service Later to shop");
    expect(said).not.toContain("not drawn");
  }, 90_000);
});

describe("the context menu", () => {
  /** A right click at the centre of a node, by its rendered position. */
  const rightClickOn = async (p: Page, id: string): Promise<void> => {
    const at = await p.evaluate((wanted) => {
      const host = document.getElementById("graph") as unknown as {
        _cyreg?: {
          cy?: {
            getElementById: (id: string) => {
              renderedBoundingBox: () => { x1: number; x2: number; y1: number; y2: number };
            };
          };
        };
      };
      const box = host?._cyreg?.cy?.getElementById(wanted).renderedBoundingBox();
      return box === undefined || box.x2 - box.x1 === 0
        ? undefined
        : { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
    }, id);
    expect(at, `${id} is not drawn`).toBeDefined();
    const graph = await p.locator("#graph").boundingBox();
    await p.mouse.click(graph!.x + at!.x, graph!.y + at!.y, { button: "right" });
  };

  it("opens on a right click, and offers to remove what was clicked", async () => {
    if (!ready) return;
    const p = await open();
    await rightClickOn(p, "service:shop.Spare");
    await p.waitForSelector("#menu:not([hidden])");
    const rows = await p.locator("#menu button").allTextContents();
    expect(rows.join(" | ")).toContain("remove service Spare");
  }, 90_000);

  /**
   * It used to grey this row and name the clauses in the way, which was a refusal dressed as advice:
   * the message said to disconnect them first and there was no row that could. A pipe wired to
   * anything was undeletable here.
   *
   * Now the row offers it and says what it will cost, and the preview says it again with the names.
   * The state it leaves is one the language describes rather than one it forbids — a half-drawn model
   * parses (D20), and the unresolved reference is reported once at its own span.
   */
  it("offers the removal of a pipe something still uses, and says it will cost something", async () => {
    if (!ready) return;
    const p = await open();
    await rightClickOn(p, "pipe:shop.inbound");
    await p.waitForSelector("#menu:not([hidden])");
    const row = p.locator("#menu button", { hasText: "remove pipe inbound" });
    expect(await row.isDisabled()).toBe(false);
    expect(await row.textContent()).toContain("still names it");
  }, 90_000);

  it("previews a removal rather than doing it, and then does it", async () => {
    if (!ready) return;
    const p = await open();
    await rightClickOn(p, "service:shop.Spare");
    await p.waitForSelector("#menu:not([hidden])");
    await p.locator("#menu button", { hasText: "remove service Spare" }).click();
    await p.waitForSelector("#propose:not([hidden])");

    // Nothing written yet.
    expect(await readFile(file, "utf-8")).toBe(MODEL);
    expect(await p.locator("#proposeBody pre").first().textContent()).toContain("service Spare");

    await p.click("#proposeApply");
    await p.waitForTimeout(1500);
    const after = await readFile(file, "utf-8");
    expect(after).not.toContain("service Spare");
    // The comment above it went too, rather than coming to explain whatever follows.
    expect(after).not.toContain("Nothing talks to this one");
  }, 90_000);
});

describe("connecting", () => {
  it("dims what a click cannot reach, and narrows it once one end is chosen", async () => {
    if (!ready) return;
    const p = await open();
    await p.click("#connect");
    await p.waitForTimeout(300);

    // Before an end is chosen: a service and a pipe are both legal, a package box is not.
    expect(await classesOf(p, "service:shop.Desk")).not.toContain("notATarget");
    expect(await classesOf(p, "pipe:shop.inbound")).not.toContain("notATarget");
    expect(await classesOf(p, "package:shop")).toContain("notATarget");

    // Choose the service. The graph is bipartite, so only pipes are left.
    await p.evaluate(() => {
      const host = document.getElementById("graph") as unknown as {
        _cyreg?: { cy?: { getElementById: (id: string) => { emit: (e: string) => void } } };
      };
      host?._cyreg?.cy?.getElementById("service:shop.Desk").emit("tap");
    });
    await p.waitForTimeout(300);
    expect(await classesOf(p, "service:shop.Desk")).toContain("connectFrom");
    expect(await classesOf(p, "service:shop.Spare")).toContain("notATarget");
    expect(await classesOf(p, "pipe:shop.inbound")).not.toContain("notATarget");
    expect(await p.locator("#status").textContent()).toContain("a pipe");
  }, 90_000);
});
