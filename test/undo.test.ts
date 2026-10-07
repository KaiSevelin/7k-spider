/**
 * Taking an edit back.
 *
 * The thing worth testing is not that undo restores the text — a swapped `{ before, after }` could
 * hardly fail to. It is the two cases where it must *not*: when the file has moved on underneath the
 * entry, and when a new edit has made the redo branch an alternative future. The first is the one that
 * would corrupt a file, and it is guarded by the write endpoint's own compare-and-swap rather than by
 * anything here, which is the point.
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
const dir = join(root, ".scratch", "undo");
const file = join(dir, "shop.7k");

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

const open = async (): Promise<Page> => {
  const p = page!;
  await reset();
  await p.goto(serving!.url);
  await p.waitForSelector("#graph canvas");
  return p;
};

/** Adds a service through the `+`, and waits for the write to land. */
const addService = async (p: Page, name: string): Promise<void> => {
  await p.selectOption("#addWhat", "service");
  await p.click("#addNew");
  await p.waitForSelector("#addForm input");
  await p.locator("#addForm input").fill(name);
  await p.waitForTimeout(250);
  await p.click("#proposeApply");
  await p.waitForTimeout(1500);
};

const said = async (p: Page): Promise<string> => (await p.locator("#status").textContent()) ?? "";

describe("the two buttons", () => {
  it("are not there until there is something to do", async () => {
    if (!ready) return;
    const p = await open();
    expect(await p.locator("#undo").isHidden()).toBe(true);
    expect(await p.locator("#redo").isHidden()).toBe(true);

    await addService(p, "Later");
    expect(await p.locator("#undo").isHidden()).toBe(false);
    // Nothing has been taken back, so there is nothing to do again.
    expect(await p.locator("#redo").isHidden()).toBe(true);
  }, 90_000);

  it("say which edit they are about", async () => {
    if (!ready) return;
    const p = await open();
    await addService(p, "Later");
    expect(await p.locator("#undo").getAttribute("title")).toContain("add service Later to shop");
  }, 90_000);
});

describe("taking an add back", () => {
  it("restores the file byte for byte, and says so", async () => {
    if (!ready) return;
    const p = await open();
    await addService(p, "Later");
    expect(await readFile(file, "utf-8")).toContain("service Later");

    await p.click("#undo");
    await p.waitForTimeout(1500);
    expect(await readFile(file, "utf-8")).toBe(MODEL);
    expect(await said(p)).toContain("took back: add service Later to shop");
    // And now the other way round.
    expect(await p.locator("#undo").isHidden()).toBe(true);
    expect(await p.locator("#redo").isHidden()).toBe(false);
  }, 90_000);

  it("does it again on redo", async () => {
    if (!ready) return;
    const p = await open();
    await addService(p, "Later");
    const afterAdd = await readFile(file, "utf-8");

    await p.click("#undo");
    await p.waitForTimeout(1500);
    await p.click("#redo");
    await p.waitForTimeout(1500);

    expect(await readFile(file, "utf-8")).toBe(afterAdd);
    expect(await said(p)).toContain("did again:");
  }, 90_000);

  it("reaches the one before it", async () => {
    if (!ready) return;
    const p = await open();
    await addService(p, "First");
    await addService(p, "Second");

    await p.click("#undo");
    await p.waitForTimeout(1500);
    expect(await readFile(file, "utf-8")).toContain("service First");
    expect(await readFile(file, "utf-8")).not.toContain("service Second");

    await p.click("#undo");
    await p.waitForTimeout(1500);
    expect(await readFile(file, "utf-8")).toBe(MODEL);
    expect(await p.locator("#undo").isHidden()).toBe(true);
  }, 90_000);

  it("ends the redo branch when a new edit is made instead", async () => {
    if (!ready) return;
    const p = await open();
    await addService(p, "First");
    await p.click("#undo");
    await p.waitForTimeout(1500);
    expect(await p.locator("#redo").isHidden()).toBe(false);

    // What was redoable was an alternative future, and this is not it.
    await addService(p, "Other");
    expect(await p.locator("#redo").isHidden()).toBe(true);
    expect(await readFile(file, "utf-8")).toContain("service Other");
    expect(await readFile(file, "utf-8")).not.toContain("service First");
  }, 90_000);
});

describe("taking a removal back", () => {
  it("brings the declaration and its comment back", async () => {
    if (!ready) return;
    const p = await open();

    const at = await p.evaluate(() => {
      const host = document.getElementById("graph") as unknown as {
        _cyreg?: {
          cy?: {
            getElementById: (id: string) => {
              renderedBoundingBox: () => { x1: number; x2: number; y1: number; y2: number };
            };
          };
        };
      };
      const box = host?._cyreg?.cy?.getElementById("service:shop.Spare").renderedBoundingBox();
      return box === undefined ? undefined : { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
    });
    const graph = await p.locator("#graph").boundingBox();
    await p.mouse.click(graph!.x + at!.x, graph!.y + at!.y, { button: "right" });
    await p.waitForSelector("#menu:not([hidden])");
    await p.locator("#menu button", { hasText: "remove service Spare" }).click();
    await p.waitForSelector("#propose:not([hidden])");
    await p.click("#proposeApply");
    await p.waitForTimeout(1500);
    expect(await readFile(file, "utf-8")).not.toContain("service Spare");

    await p.click("#undo");
    await p.waitForTimeout(1500);
    // Byte for byte, which is the property that makes a destructive row safe to offer at all.
    expect(await readFile(file, "utf-8")).toBe(MODEL);
  }, 90_000);
});

describe("when the file has moved on underneath it", () => {
  it("refuses, says which file, and drops the history", async () => {
    if (!ready) return;
    const p = await open();
    await addService(p, "Later");

    // Somebody else edits the file. The server is serving with `watch: false`, so the page does not
    // know — which is exactly the state the compare-and-swap in `writeSources` exists for.
    await writeFile(file, `${await readFile(file, "utf-8")}\n// touched elsewhere\n`, "utf-8");

    await p.click("#undo");
    await p.waitForTimeout(1500);

    const message = await said(p);
    expect(message).toContain("shop.7k");
    expect(message).toContain("changed since");
    expect(message).toContain("history was dropped");
    // Nothing was written, and there is nothing left offering to.
    expect(await readFile(file, "utf-8")).toContain("// touched elsewhere");
    expect(await readFile(file, "utf-8")).toContain("service Later");
    expect(await p.locator("#undo").isHidden()).toBe(true);
    expect(await p.locator("#redo").isHidden()).toBe(true);
  }, 90_000);
});

describe("the keys", () => {
  it("ctrl-z takes back and ctrl-shift-z does again", async () => {
    if (!ready) return;
    const p = await open();
    await addService(p, "Later");

    await p.keyboard.press("Control+z");
    await p.waitForTimeout(1500);
    expect(await readFile(file, "utf-8")).toBe(MODEL);

    await p.keyboard.press("Control+Shift+z");
    await p.waitForTimeout(1500);
    expect(await readFile(file, "utf-8")).toContain("service Later");
  }, 90_000);

  it("leaves ctrl-z alone inside a field, where it is the field's own", async () => {
    if (!ready) return;
    const p = await open();
    await addService(p, "Later");

    await p.selectOption("#addWhat", "service");
    await p.click("#addNew");
    await p.waitForSelector("#addForm input");
    await p.locator("#addForm input").fill("Typing");
    await p.locator("#addForm input").press("Control+z");
    await p.waitForTimeout(600);

    // The add is still there: the key went to the input, not to the history.
    expect(await readFile(file, "utf-8")).toContain("service Later");
    expect(await p.locator("#propose").isHidden()).toBe(false);
  }, 90_000);
});
