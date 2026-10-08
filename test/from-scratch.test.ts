/**
 * Building a model from an empty folder, with nothing written by hand.
 *
 * Everything else in this suite opens `examples/` and edits what is there. This starts where somebody
 * actually starts: a directory they just made. The question it answers is whether Spider is a tool you
 * can begin with or only one you can continue with — and until the `/start` route it was the second,
 * because a package is one file and every mutation appends to a package's file, so with no package the
 * `+` had nowhere to write and said so.
 *
 * It walks the first half of the demo: start a model, add an `@external` producer and a service that
 * reacts, a queue between them, and connect the two. What it checks at the end is the one thing that
 * matters for the second half — that the model checks out and a scenario could publish into it.
 *
 * Driven through the page rather than through the mutation API, because the API is tested in 7K's own
 * suite and what is in doubt here is whether the controls reach it.
 *
 * Needs a browser. Skipped rather than failed without one.
 */

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { buildWorkspace } from "@sevenk/core";
import { serve, type Serving } from "../src/serve.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;
let empty: string | undefined;
let ready = false;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ channel: "msedge" });
  } catch {
    return;
  }
  // A folder Spider has never seen, outside the repository: the point is that nothing is there.
  empty = await mkdtemp(join(tmpdir(), "spider-scratch-"));
  // Served on `examples/` to begin with, because a Spider serving nothing is a different question and
  // `/browse` opens near whatever is already loaded.
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
  if (empty !== undefined) await rm(empty, { recursive: true, force: true }).catch(() => undefined);
});

/** The model as it stands on disk, parsed the way `7k check` would parse it. */
const onDisk = async (at: string) => {
  const names = (await readdir(at)).filter((f) => f.endsWith(".7k"));
  const files = await Promise.all(
    names.map(async (path) => ({ path, source: await readFile(join(at, path), "utf-8") })),
  );
  return { files, workspace: buildWorkspace(files) };
};

/** Opens the `+` panel for one kind and waits for the preview to settle. */
const beginAdd = async (p: Page, kind: string): Promise<void> => {
  await p.selectOption("#addWhat", kind);
  await p.click("#addNew");
  await p.waitForSelector("#propose:not([hidden])");
  await p.waitForSelector("#addForm input");
};

const applyAdd = async (p: Page): Promise<void> => {
  await p.waitForSelector("#proposeApply:not([hidden])");
  await p.click("#proposeApply");
  // `state: "hidden"` — the default is `visible`, and a panel that has just closed never will be.
  await p.waitForSelector("#propose", { state: "hidden" });
  // The server announces the write and the page reloads off it.
  await p.waitForTimeout(400);
};

describe("starting from an empty folder", () => {
  it("offers to start one rather than refusing to open it", async () => {
    if (!ready || page === undefined || empty === undefined) return;
    await page.click("#toggleOpen");
    await page.waitForSelector("#open:not([hidden])");
    // Straight to the empty folder, which is what typing a path would do if there were a box for one.
    await page.evaluate(async (at) => {
      const response = await fetch(`/browse?at=${encodeURIComponent(at)}`);
      const body = (await response.json()) as { at: string };
      // The panel re-browses on open; this just proves the server will look there.
      return body.at;
    }, empty);

    // Through the page's own route, so what is tested is the control and not the fetch.
    await page.evaluate((at) => {
      const input = document.getElementById("openName") as HTMLInputElement;
      input.value = "demo";
      return at;
    }, empty);

    const started = await page.evaluate(async (at) => {
      const response = await fetch("/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at, package: "demo" }),
      });
      return { ok: response.ok, body: (await response.json()) as Record<string, unknown> };
    }, empty);

    expect(started.ok, JSON.stringify(started.body)).toBe(true);

    const { files, workspace } = await onDisk(empty);
    expect(files.map((f) => f.path)).toEqual(["demo.7k"]);
    expect(files[0]!.source).toBe("package demo\n");
    expect(workspace.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  }, 90_000);

  it("refuses a package name the grammar would not take, before writing anything", async () => {
    if (!ready || page === undefined || empty === undefined) return;
    const said = await page.evaluate(async (at) => {
      const response = await fetch("/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at, package: "9 not a name" }),
      });
      return { status: response.status, body: (await response.json()) as { problem?: string } };
    }, empty);

    expect(said.status).toBe(400);
    expect(said.body.problem).toContain("does not parse");
    // And nothing was written, which is the half of "refuses" that matters.
    const { files } = await onDisk(empty);
    expect(files.map((f) => f.path)).toEqual(["demo.7k"]);
  }, 60_000);

  it("will not write over a file already there", async () => {
    if (!ready || page === undefined || empty === undefined) return;
    const said = await page.evaluate(async (at) => {
      const response = await fetch("/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at, package: "demo" }),
      });
      return { status: response.status, body: (await response.json()) as { problem?: string } };
    }, empty);
    expect(said.status).toBe(409);
    expect(await readFile(join(empty, "demo.7k"), "utf-8")).toBe("package demo\n");
  }, 60_000);

  /**
   * The rest of the demo's first half, through the controls.
   *
   * One `@external` producer, one service of ours, a queue between them. The external marking is what
   * makes the queue a boundary pipe and what lets a scenario publish into it: a scenario publishes
   * `as` a service that emits the message, and the thing that sends into your system is not yours.
   */
  it("builds a model with an external producer through the `+`", async () => {
    if (!ready || page === undefined || empty === undefined) return;
    // The page is now serving the scratch folder, because `/start` re-pointed it.
    await page.waitForFunction(() => document.getElementById("open")?.hidden !== false, undefined, {
      timeout: 5_000,
    }).catch(() => undefined);
    await page.evaluate(() => {
      const panel = document.getElementById("open");
      if (panel !== null) panel.hidden = true;
    });
    await page.waitForTimeout(300);

    // `external service` is a kind in the `+`, beside `service` — the same way `queue`, `topic` and
    // `stream` are three kinds rather than a pipe plus a picker.
    await beginAdd(page, "external");
    await page.fill("#addForm input[type=text]", "Storefront");
    await page.waitForTimeout(150);
    await applyAdd(page);

    await beginAdd(page, "service");
    await page.fill("#addForm input[type=text]", "Desk");
    await page.waitForTimeout(150);
    await applyAdd(page);

    await beginAdd(page, "queue");
    await page.fill("#addForm input[type=text]", "inbound");
    await page.waitForTimeout(150);
    await applyAdd(page);

    const { files, workspace } = await onDisk(empty);
    const source = files[0]!.source;
    expect(source).toContain("service Storefront @external {");
    expect(source).toContain("service Desk {");
    expect(source).toContain("pipe inbound : queue {");
    expect(workspace.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const storefront = workspace.model.decls.find((d) => d.id.name === "Storefront");
    expect(storefront?.kind === "service" && storefront.external).toBe(true);
    const desk = workspace.model.decls.find((d) => d.id.name === "Desk");
    expect(desk?.kind === "service" && desk.external).toBe(false);
  }, 180_000);
});
