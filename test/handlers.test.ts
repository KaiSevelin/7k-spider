/**
 * Where the code is, in the sidebar.
 *
 * The one thing about a service the model cannot answer and the generated code can: the model says it
 * reacts to `PlaceOrder`, and only the C# provider knows that is `HandlePlaceOrderAsync`. A debugger's
 * function breakpoint matches by name, so that symbol is what stands between "Spider knows the model"
 * and "Spider can stop your debugger on the handler".
 *
 * Needs a browser and the C# provider. Skipped rather than failed without either.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { serve, type Serving } from "../src/serve.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".scratch", "handlers");

const MODEL = `package shop

message Place v1.0 @command { orderId: uuid @role(businessKey) }
message Placed v1.0 @event  { orderId: uuid @role(businessKey) }

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }

service Desk {
  reacts Place from inbound { replies Placed }
  emits  Placed to events
}

service Ledger {
  reacts Placed from events { replies none }
}
`;

/** The csharp provider, which is what reports a handler symbol at all. */
const BUILD = `{
  "out": "generated",
  "providers": ["@sevenk/csharp"],
  "emit": [
    { "provider": "csharp", "out": "csharp", "layout": "per-declaration", "options": { "namespace": "Shop" } }
  ]
}
`;

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
  await mkdir(join(dir, ".7k"), { recursive: true });
  await writeFile(join(dir, "shop.7k"), MODEL, "utf-8");
  await writeFile(join(dir, ".7k", "build.json"), BUILD, "utf-8");
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

/** Selecting through the renderer, which is how a click reaches it. */
const pick = async (p: Page, id: string): Promise<void> => {
  await p.evaluate((wanted) => {
    const host = document.getElementById("graph") as unknown as {
      _cyreg?: { cy?: { getElementById: (id: string) => { emit: (e: string) => void } } };
    };
    host?._cyreg?.cy?.getElementById(wanted).emit("tap");
  }, id);
  await p.waitForTimeout(400);
};

describe("the handlers section", () => {
  it("is there for a service, naming the method a breakpoint would take", async () => {
    if (!ready) return;
    const p = page!;
    await p.goto(serving!.url);
    await p.waitForSelector("#graph canvas");
    await pick(p, "service:shop.Desk");

    // Fetched lazily on the first selection, so it may not be in the first paint.
    await p.waitForSelector("#sidebar .row.handler", { timeout: 30_000 });
    const rows = await p.locator("#sidebar .row.handler").allTextContents();
    expect(rows.join(" | ")).toContain("Place");
    expect(rows.join(" | ")).toContain("HandlePlaceAsync");
  }, 120_000);

  it("names the file the provider put it in, for whoever has to open it", async () => {
    if (!ready) return;
    const p = page!;
    await p.goto(serving!.url);
    await p.waitForSelector("#graph canvas");
    await pick(p, "service:shop.Ledger");
    await p.waitForSelector("#sidebar .row.handler", { timeout: 30_000 });

    const title = await p.locator("#sidebar .row.handler code").first().getAttribute("title");
    expect(title).toContain("csharp");
    expect(title).toContain("Ledger.cs");
  }, 120_000);

  it("offers the symbol rather than a link, since the debugger is not Spider's", async () => {
    if (!ready) return;
    const p = page!;
    await p.goto(serving!.url);
    await p.waitForSelector("#graph canvas");
    await pick(p, "service:shop.Desk");
    await p.waitForSelector("#sidebar .row.handler", { timeout: 30_000 });
    expect(await p.locator("#sidebar .row.handler .copy").first().textContent()).toBe("copy");
  }, 120_000);

  it("says nothing for a pipe, which no provider names a handler for", async () => {
    if (!ready) return;
    const p = page!;
    await p.goto(serving!.url);
    await p.waitForSelector("#graph canvas");
    await pick(p, "service:shop.Desk");
    await p.waitForSelector("#sidebar .row.handler", { timeout: 30_000 });
    await pick(p, "pipe:shop.inbound");
    expect(await p.locator("#sidebar .row.handler").count()).toBe(0);
  }, 120_000);
});
