/**
 * Adding a step to a saga, from the saga view.
 *
 * The claim is not that text appears. It is that the step **checks out**: `addStep` reads the outcomes
 * off whatever handles the message, so a step written this way cannot be the `unhandled-outcome` a
 * hand-written one so easily is. So the test adds one to the parcel example and asks the page whether
 * the model still has no problems.
 *
 * The message list is the other half. A saga's `send` is routed by its host service's `emits` (D62), so
 * only what routes is offered — `parcel.lockers.OpenDoor` is a real message that a real service emits,
 * and it is deliberately not on the list, because the saga's host is not that service.
 *
 * Needs a browser. Skipped rather than failed without one.
 */

import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { serve, type Serving } from "../src/serve.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".scratch", "add-step");

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;
let ready = false;

/** The example, copied so a test can write to it, without its scenarios. */
const reset = async (): Promise<void> => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(join(root, "examples"), dir, {
    recursive: true,
    filter: (from) => !from.endsWith(".scenario.7k") && !from.endsWith(".ndjson"),
  });
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

/** A fresh page on a fresh copy, so no test inherits another's edit. */
const openSaga = async (): Promise<Page> => {
  const p = page!;
  await reset();
  await p.goto(serving!.url);
  await p.waitForSelector("#graph canvas");
  await p.waitForSelector("#toggleSaga:not([hidden])");
  await p.click("#toggleSaga");
  await p.waitForSelector("#saga:not([hidden])");
  return p;
};

const fill = async (p: Page, name: string, message: string, timeout?: string): Promise<void> => {
  await p.click("#addStep");
  await p.waitForSelector("#addForm");
  await p.locator("#addForm input").first().fill(name);
  await p.locator("#addForm select").selectOption({ label: message });
  if (timeout !== undefined) await p.locator("#addForm input").nth(1).fill(timeout);
  await p.waitForTimeout(250);
};

describe("adding a step", () => {
  it("offers only what the saga's host already emits", async () => {
    if (!ready) return;
    const p = await openSaga();
    await p.click("#addStep");
    await p.waitForSelector("#addForm");
    const offered = await p.locator("#addForm select option").allTextContents();

    expect(offered).toContain("parcel.delivery.ReserveCompartment");
    expect(offered).toContain("parcel.notify.VerifyRecipient");
    // A real message, emitted by a real service — just not by this saga's host.
    expect(offered).not.toContain("parcel.lockers.OpenDoor");
  }, 60_000);

  it("writes the outcomes the model already declares", async () => {
    if (!ready) return;
    const p = await openSaga();
    await fill(p, "recheck", "parcel.delivery.ReserveCompartment", "45s");
    const preview = (await p.locator("#proposeBody pre").first().textContent()) ?? "";

    expect(preview).toContain("step recheck {");
    expect(preview).toContain("send ReserveCompartment");
    // `CompartmentService` replies with exactly these two, so exactly these two are written.
    expect(preview).toContain("on CompartmentReserved");
    expect(preview).toContain("on CompartmentFull");
    expect(preview).toContain('on timeout 45s reject "recheck timed out"');
  }, 60_000);

  it("writes nothing until the preview is accepted", async () => {
    if (!ready) return;
    const p = await openSaga();
    const before = await readFile(join(dir, "delivery.7k"), "utf-8");
    await fill(p, "recheck", "parcel.delivery.ReserveCompartment", "45s");
    expect(await readFile(join(dir, "delivery.7k"), "utf-8")).toBe(before);
  }, 60_000);

  /** The property the whole operation exists for. */
  it("leaves the model checking out after it is applied", async () => {
    if (!ready) return;
    const p = await openSaga();
    await fill(p, "recheck", "parcel.delivery.ReserveCompartment", "45s");
    await p.click("#proposeApply");
    await p.waitForTimeout(1400);

    expect(await readFile(join(dir, "delivery.7k"), "utf-8")).toContain("step recheck {");
    expect((await p.locator("#problemsCount").textContent())?.trim()).toBe("no problems");
  }, 60_000);

  it("asks for a name before it offers anything", async () => {
    if (!ready) return;
    const p = await openSaga();
    await p.click("#addStep");
    await p.waitForSelector("#addForm");
    expect(await p.locator("#proposeBody .why").textContent()).toContain("type a name");
    expect(await p.locator("#proposeApply").isHidden()).toBe(true);
  }, 60_000);

  it("refuses a step name the saga already has", async () => {
    if (!ready) return;
    const p = await openSaga();
    await fill(p, "reserve", "parcel.delivery.ReserveCompartment", "30s");
    expect(await p.locator("#proposeBody .why").textContent()).toContain("already has a step");
    expect(await p.locator("#proposeApply").isHidden()).toBe(true);
  }, 60_000);
});

/**
 * The dialog that decides whether anything is written had no `z-index`, so every drawer — all of them
 * at 4 — painted over it. It was unreachable from the saga view, and had been from the data and
 * compose views for as long as a connection could be proposed with one open.
 */
describe("the proposal is reachable", () => {
  it("sits above the drawer that opened it", async () => {
    if (!ready) return;
    const p = await openSaga();
    await fill(p, "recheck", "parcel.delivery.ReserveCompartment", "45s");

    const onTop = await p.evaluate(() => {
      const button = document.getElementById("proposeApply")!;
      const box = button.getBoundingClientRect();
      const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return at === null ? "nothing" : (at.closest("#propose") === null ? "covered" : "propose");
    });
    expect(onTop).toBe("propose");
  }, 60_000);
});
