/**
 * What a saga announces when it ends, and when it gives up — filled from the band that draws neither.
 *
 * The terminal band draws all three terminals whether or not they were declared, and `no deadline`
 * where there is none, for the same reason the step cards draw their silences: a saga that can abandon
 * and tells nobody is exactly what a reader is looking for. So three gaps and a fourth are already on
 * screen, and this checks that each is where its edit starts.
 *
 * Its own model rather than the parcel example, which declares all four and so has nothing to fill.
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
const dir = join(root, ".scratch", "saga-terminals");
const file = join(dir, "shop.7k");

/** A saga that checks out and declares no deadline and no terminals. */
const MODEL = `package shop

message PlaceOrder v1.0 @command { orderId: uuid @role(businessKey) }
message Reserve    v1.0 @command { orderId: uuid @role(businessKey) }
message Reserved   v1.0 @event   { orderId: uuid @role(businessKey) }
message Done       v1.0 @event   { orderId: uuid @role(businessKey) }

pipe inbound  : queue { retention 7d }
pipe commands : queue { retention 7d }
pipe events   : topic { retention 7d }

service Desk {
  reacts PlaceOrder from inbound { replies none }
  emits Reserve to commands
  emits Done    to events
}

service Store {
  reacts Reserve from commands { replies Reserved }
  emits Reserved to events
}

saga Checkout v1.0 {
  start on PlaceOrder

  step hold {
    send Reserve

    on Reserved
    on timeout 30s reject "slow"
  }
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
  page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  ready = true;
}, 180_000);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await serving?.close().catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const openSaga = async (): Promise<Page> => {
  const p = page!;
  await reset();
  await p.goto(serving!.url);
  await p.waitForSelector("#graph canvas");
  await p.waitForSelector("#toggleSaga:not([hidden])");
  await p.click("#toggleSaga");
  await p.waitForSelector("#saga svg");
  return p;
};

const DEADLINE = "#sagaCanvas .band-note.silence";
const COMPLETE = "#sagaCanvas .terminal-complete .terminal-silent";

describe("the terminal band's gaps", () => {
  it("draws all three terminals even though none is declared", async () => {
    if (!ready) return;
    const p = await openSaga();
    expect(await p.locator("#sagaCanvas .terminal-silent").count()).toBe(3);
    expect(await p.locator(COMPLETE).textContent()).toContain("announces nothing");
  }, 90_000);

  it("draws the missing deadline, and offers it", async () => {
    if (!ready) return;
    const p = await openSaga();
    expect(await p.locator(DEADLINE).textContent()).toBe("no deadline");
    expect((await p.locator(DEADLINE).getAttribute("class")) ?? "").toContain("clickable");
  }, 90_000);

  it("writes a deadline from the row that said there was none", async () => {
    if (!ready) return;
    const p = await openSaga();
    await p.locator(DEADLINE).click();
    await p.waitForSelector("#addForm input");
    // Nothing is offered until a duration is given: there is no sensible default.
    expect(await p.locator("#proposeApply").isHidden()).toBe(true);

    await p.locator("#addForm input").fill("24h");
    await p.waitForTimeout(250);
    expect(await p.locator("#proposeBody pre").first().textContent()).toContain(
      "on deadline 24h abandon",
    );

    await p.click("#proposeApply");
    await p.waitForTimeout(1300);
    expect(await readFile(file, "utf-8")).toContain("on deadline 24h abandon");
  }, 90_000);

  it("writes a terminal from the row that said it announces nothing", async () => {
    if (!ready) return;
    const p = await openSaga();
    await p.locator(COMPLETE).click();
    await p.waitForSelector("#addForm select");
    expect(await p.locator("#proposeBody pre").first().textContent()).toContain(
      "on complete send Done",
    );

    await p.click("#proposeApply");
    await p.waitForTimeout(1300);
    const after = await readFile(file, "utf-8");
    expect(after).toContain("on complete send Done");
    // Inside the saga, after its step.
    expect(after.indexOf("on complete")).toBeGreaterThan(after.indexOf("step hold"));
  }, 90_000);

  it("offers only what the saga's host can send", async () => {
    if (!ready) return;
    const p = await openSaga();
    await p.locator(COMPLETE).click();
    await p.waitForSelector("#addForm select");
    const offered = await p.locator("#addForm select option").allTextContents();
    expect(offered).toContain("shop.Done");
    // `Store` emits this one, and `Store` is not the host.
    expect(offered).not.toContain("shop.Reserved");
  }, 90_000);

  it("stops offering one once it is declared", async () => {
    if (!ready) return;
    const p = await openSaga();
    await p.locator(COMPLETE).click();
    await p.waitForSelector("#addForm select");
    await p.click("#proposeApply");
    await p.waitForTimeout(1300);

    expect(await p.locator("#sagaCanvas .terminal-silent").count()).toBe(2);
    expect(await p.locator(COMPLETE).count()).toBe(0);
  }, 90_000);

  it("writes nothing until the preview is accepted", async () => {
    if (!ready) return;
    const p = await openSaga();
    await p.locator(COMPLETE).click();
    await p.waitForSelector("#addForm select");
    expect(await readFile(file, "utf-8")).toBe(MODEL);
  }, 90_000);
});
