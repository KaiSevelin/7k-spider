/**
 * Taking things out, which until now you mostly could not.
 *
 * Spider offered two removals — a service, and a pipe nothing touched — and no way at all to take a
 * connection apart. The two gaps were one gap: `removePipe` refused while anything still emitted to
 * the pipe, and said the fix was "one drag or one menu row away", and there was no such row. A pipe
 * wired to anything was undeletable from the tool whose point is that you do not have to edit the
 * text by hand.
 *
 * Both ends moved. Core's `removeDecl` stopped refusing a cost the language tolerates — a half-drawn
 * model parses (D20) and an unresolved reference is reported once at its own span — and the drawing
 * learned to be pointed at: a line is a clause, and right-clicking one now reaches the disconnect
 * operations Core has had all along.
 *
 * What is checked here is what the drawing can be asked to do, end to end on disk. `mutate.test.ts`
 * in 7K checks what the operations decide.
 *
 * Needs a browser. Skipped rather than failed without one.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { buildWorkspace } from "@sevenk/core";
import { serve, type Serving } from "../src/serve.js";

const MODEL = `package demo

message Work v1.0 @command {
  jobId: uuid @role(businessKey)
}

message Done v1.0 @event {
  jobId: uuid @role(businessKey)
}

pipe inbound : queue {
  retention 7d
}

service Starter @external {
  emits Work to inbound
}

service Desk {
  emits Done to inbound

  reacts Work from inbound {
    replies Done
  }
}
`;

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;
let at: string | undefined;
let ready = false;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ channel: "msedge" });
  } catch {
    return;
  }
  at = await mkdtemp(join(tmpdir(), "spider-remove-"));
  await writeFile(join(at, "demo.7k"), MODEL, "utf-8");
  serving = await serve({ paths: [at], port: 0, watch: false });
  page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(serving.url);
  await page.waitForSelector("#graph");
  ready = true;
}, 180_000);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await serving?.close().catch(() => undefined);
  if (at !== undefined) await rm(at, { recursive: true, force: true }).catch(() => undefined);
});

/** Puts the file back, so each test starts from the same model however the last one left it. */
const reset = async (p: Page): Promise<void> => {
  await writeFile(join(at!, "demo.7k"), MODEL, "utf-8");
  await p.reload();
  await p.waitForSelector("#graph");
  await p.waitForTimeout(500);
};

const source = async (): Promise<string> => readFile(join(at!, "demo.7k"), "utf-8");

/** Right-clicks a node by its drawn position, centring first so it is inside the viewport. */
const rightClickNode = async (p: Page, id: string): Promise<void> => {
  const where = await p.evaluate((wanted) => {
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
    return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
  }, id);
  expect(where, `${id} is not drawn`).toBeDefined();
  const graph = await p.locator("#graph").boundingBox();
  await p.mouse.click(graph!.x + where!.x, graph!.y + where!.y, { button: "right" });
  await p.waitForSelector("#menu:not([hidden])");
};

/**
 * Right-clicks a line.
 *
 * On its midpoint, which is both the furthest point from either box — so a node cannot win the hit
 * test — and where a bezier actually is. Fitted first, because an edge whose ends are off-screen has
 * a midpoint that is too.
 */
const rightClickEdge = async (p: Page, from: string, to: string): Promise<void> => {
  const where = await p.evaluate(([a, b]) => {
    const host = document.getElementById("graph") as unknown as {
      _cyreg?: {
        cy?: {
          fit: (padding?: number) => void;
          edges: () => {
            length: number;
            [i: number]: {
              source: () => { id: () => string };
              target: () => { id: () => string };
              renderedMidpoint: () => { x: number; y: number };
            };
          };
        };
      };
    };
    const cy = host?._cyreg?.cy;
    if (cy === undefined) return undefined;
    cy.fit(30);
    const edges = cy.edges();
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i]!;
      if (edge.source().id() !== a || edge.target().id() !== b) continue;
      return edge.renderedMidpoint();
    }
    return undefined;
  }, [from, to]);
  expect(where, `no edge ${from} → ${to}`).toBeDefined();
  const graph = await p.locator("#graph").boundingBox();
  await p.mouse.click(graph!.x + where!.x, graph!.y + where!.y, { button: "right" });
  await p.waitForSelector("#menu:not([hidden])");
};

const apply = async (p: Page): Promise<void> => {
  await p.waitForSelector("#proposeApply:not([hidden])");
  await p.click("#proposeApply");
  await p.waitForSelector("#propose", { state: "hidden" });
  await p.waitForTimeout(500);
};

const errorsIn = (text: string): string[] =>
  buildWorkspace([{ path: "demo.7k", source: text }])
    .diagnostics.filter((d) => d.severity === "error")
    .map((d) => d.code);

describe("removing a declaration", () => {
  /**
   * The case that could not be done at all. `inbound` carries every message in this model, and the
   * old refusal named four clauses and stopped.
   */
  it("removes a pipe everything is wired to, and says what stops resolving", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    await rightClickNode(page, "pipe:demo.inbound");

    const row = page.locator("#menu button", { hasText: "remove pipe inbound" }).first();
    expect(await row.count()).toBe(1);
    expect(await row.isDisabled()).toBe(false);
    await row.click();

    // The preview says the cost before anything is written, which is what makes it askable.
    await page.waitForSelector("#propose:not([hidden])");
    const preview = (await page.locator("#proposeBody").textContent()) ?? "";
    expect(preview).toContain("stop resolving");
    await apply(page);

    const after = await source();
    expect(after).not.toContain("pipe inbound");
    // Still a model, and the clauses that named it are still there to be edited.
    expect(after).toContain("emits Work to inbound");
    expect(new Set(errorsIn(after))).toEqual(new Set(["unresolved-reference"]));
  }, 120_000);

  /**
   * And what the drawing does with it, which is the half a reader sees.
   *
   * The reference text is left as written on purpose — the name records what was meant, and is what
   * lets the pipe be put back or another renamed into its place. What becomes unknown is the
   * *resolution*, so the drawing must keep drawing: `20-ir.md` section 5 asks every analysis to
   * degrade rather than crash or spew false errors, and names this exact state, an edge dragged into
   * empty space. One unresolved reference, named, and a model still there to edit.
   */
  it("keeps drawing, and says what is now pointing at nothing", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    await rightClickNode(page, "pipe:demo.inbound");
    await page.locator("#menu button", { hasText: "remove pipe inbound" }).first().click();
    await apply(page);

    // Still a drawing, with the services that named the pipe still on it.
    const nodes = await page.evaluate(() => {
      const host = document.getElementById("graph") as unknown as {
        _cyreg?: { cy?: { nodes: () => { length: number; [i: number]: { id: () => string } } } };
      };
      const cy = host?._cyreg?.cy;
      if (cy === undefined) return [];
      const all = cy.nodes();
      return Array.from({ length: all.length }, (_, i) => all[i]!.id());
    });
    expect(nodes).toContain("service:demo.Desk");
    expect(nodes).not.toContain("pipe:demo.inbound");

    // And named, rather than silently drawn as nothing.
    const said = (await page.locator("#problemsText").textContent()) ?? "";
    expect(said).toMatch(/unresolved/);
    expect(said).toContain("inbound");
  }, 120_000);

  /** A message was addable from the composer and never removable. */
  it("removes a message, which had no removal at all", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    // Through the data canvas, which is the drawing that has messages on it.
    await page.click("#toggleData");
    await page.waitForSelector("#dataCanvas canvas");
    await page.selectOption("#dataSubject", "message:demo.Done");
    await page.waitForTimeout(500);

    const where = await page.evaluate(() => {
      const host = document.getElementById("dataCanvas") as unknown as {
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
      const el = cy?.getElementById("message:demo.Done");
      if (cy === undefined || el === undefined || el.length === 0) return undefined;
      cy.center(el);
      const box = el.renderedBoundingBox();
      return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
    });
    expect(where, "Done is not drawn on the data canvas").toBeDefined();

    const canvas = await page.locator("#dataCanvas").boundingBox();
    await page.mouse.click(canvas!.x + where!.x, canvas!.y + where!.y, { button: "right" });
    await page.waitForSelector("#menu:not([hidden])");

    const row = page.locator("#menu button", { hasText: "remove message Done" }).first();
    expect(await row.count()).toBe(1);
    await row.click();
    await apply(page);

    expect(await source()).not.toContain("message Done");
  }, 120_000);
});

describe("taking a connection apart", () => {
  /**
   * The row that did not exist. Core has had `disconnectEmit` and `disconnectReact` since the
   * connecting operations were written; nothing on the drawing could be pointed at to mean a clause.
   */
  it("offers one row per message on the line, and writes the clause out", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    await rightClickEdge(page, "service:demo.Desk", "pipe:demo.inbound");

    const row = page.locator("#menu button", { hasText: "remove emits Done to inbound" }).first();
    expect(await row.count()).toBe(1);
    await row.click();
    await apply(page);

    const after = await source();
    expect(after).not.toContain("emits Done to inbound");
    // Only that clause. The `reacts` on the same two nodes is a different line and stays.
    expect(after).toContain("reacts Work from inbound");

    // And what is left is a model mid-edit, which is now a state rather than a refusal: `Desk` still
    // declares `replies Done` and no longer emits it, so the checker says so and the tool lets you
    // get on with saying what should happen instead.
    expect(errorsIn(after)).toEqual(["reply-without-emit"]);
  }, 120_000);

  it("names the line in the menu heading rather than calling it the whole system", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    await rightClickEdge(page, "service:demo.Desk", "pipe:demo.inbound");
    const heading = (await page.locator("#menu header").textContent()) ?? "";
    expect(heading).toContain("Desk");
    expect(heading).toContain("inbound");
  }, 120_000);

  /**
   * A node wins wherever both are under the pointer. An edge ends inside the box it points at, so
   * without that rule the last few pixels of every box would open the wrong menu.
   */
  it("still opens the node's menu when a node is under the pointer", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    await rightClickNode(page, "service:demo.Desk");
    expect(await page.locator("#menu header").textContent()).toContain("Desk");
    expect(await page.locator("#menu button", { hasText: "remove service Desk" }).count()).toBe(1);
  }, 120_000);
});
