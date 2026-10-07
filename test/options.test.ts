/**
 * Changing what the generator does, from the page.
 *
 * Before this the answer was "edit `.7k/build.json` by hand, then reload" — and the provider contract
 * had been carrying the answer all along: every provider declares what it lets you adjust, with a type,
 * a default and a one-line description. Spider received that list and ignored it, typed `unknown[]`.
 *
 * Against the real C# provider rather than a stub, because the point is that the controls come from
 * whatever a provider happens to declare. A stub would be a second list of options, which is the thing
 * this exists to avoid.
 *
 * Needs a browser and the C# provider. Skipped rather than failed without either.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { serve, type Serving } from "../src/serve.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, ".scratch", "options");
const manifest = join(dir, ".7k", "build.json");

const MODEL = `package shop

message Place v1.0 @command { orderId: uuid @role(businessKey) }
message Placed v1.0 @event  { orderId: uuid @role(businessKey) }

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }

service Desk {
  reacts Place from inbound { replies Placed }
  emits  Placed to events
}
`;

/** Two entries for one provider, so "which entry" has to be a real question. */
const BUILD = `{
  "_comment": "Kept, because changing an option must not discard it.",
  "out": "generated",
  "providers": ["@sevenk/csharp"],
  "emit": [
    {
      "provider": "csharp",
      "out": "csharp",
      "layout": "per-declaration",
      "options": { "namespace": "Shop" }
    },
    {
      "provider": "csharp",
      "out": "csharp-alias",
      "layout": "single",
      "options": { "namespace": "Shop", "valueTypes": "alias" }
    }
  ]
}
`;

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;
let ready = false;

const reset = async (): Promise<void> => {
  await mkdir(join(dir, ".7k"), { recursive: true });
  await writeFile(join(dir, "shop.7k"), MODEL, "utf-8");
  await writeFile(manifest, BUILD, "utf-8");
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
  await p.click("#toggleOptions");
  await p.waitForSelector("#options .row.option");
  return p;
};

const row = (p: Page, name: string) => p.locator(`#options .row.option[data-option="${name}"]`);

const read = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(manifest, "utf-8")) as Record<string, unknown>;

describe("the options panel", () => {
  it("lists what the provider declares, and nothing it does not", async () => {
    if (!ready) return;
    const p = await open();
    const names = await p
      .locator("#options .row.option")
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset["option"] ?? ""));
    // Declared by the C# provider, so the panel knowing them is the whole point.
    expect(names).toContain("namespace");
    expect(names).toContain("messageType");
    expect(names).toContain("devHost");
    expect(names).toContain("asyncSuffix");
    // Not an option: `layout` is the entry's, and is shown as a fact rather than a control.
    expect(names).not.toContain("layout");
  }, 120_000);

  it("derives each control from the spec's type", async () => {
    if (!ready) return;
    const p = await open();
    // boolean, enum, string — a checkbox, a picker, a field.
    expect(await row(p, "devHost").locator("input[type=checkbox]").count()).toBe(1);
    expect(await row(p, "messageType").locator("select").count()).toBe(1);
    expect(await row(p, "namespace").locator("input[type=text]").count()).toBe(1);
    // And the enum offers exactly the values it declares.
    expect(await row(p, "messageType").locator("option").allTextContents()).toEqual([
      "record",
      "positional",
      "class",
    ]);
  }, 120_000);

  it("says whether anybody chose a value, or it is just the default", async () => {
    if (!ready) return;
    const p = await open();
    // A row showing `record` says nothing about whether somebody picked it.
    expect(await row(p, "namespace").locator("i").textContent()).toBe("set");
    expect(await row(p, "messageType").locator("i").textContent()).toBe("default");
  }, 120_000);

  it("shows the effective value, set or defaulted", async () => {
    if (!ready) return;
    const p = await open();
    expect(await row(p, "namespace").locator("input").inputValue()).toBe("Shop");
    expect(await row(p, "messageType").locator("select").inputValue()).toBe("record");
    // `devHost` defaults on, which is a decision worth being able to see.
    expect(await row(p, "devHost").locator("input").isChecked()).toBe(true);
  }, 120_000);

  it("switches between entries, which may be the same provider twice", async () => {
    if (!ready) return;
    const p = await open();
    expect(await p.locator("#optionsWhich option").allTextContents()).toEqual([
      "csharp → csharp",
      "csharp → csharp-alias",
    ]);

    await p.selectOption("#optionsWhich", "1");
    await p.waitForTimeout(300);
    // The second entry sets `valueTypes`, and the first does not.
    expect(await row(p, "valueTypes").locator("i").textContent()).toBe("set");
    expect(await row(p, "valueTypes").locator("select").inputValue()).toBe("alias");
  }, 120_000);
});

describe("changing one", () => {
  it("previews it before writing anything", async () => {
    if (!ready) return;
    const p = await open();
    await row(p, "messageType").locator("select").selectOption("positional");
    await p.waitForSelector("#propose:not([hidden])");

    expect(await p.locator("#proposeWhat").textContent()).toContain("messageType");
    expect(await readFile(manifest, "utf-8")).toBe(BUILD);
  }, 120_000);

  it("writes it into the entry, keeping every key it is not about", async () => {
    if (!ready) return;
    const p = await open();
    await row(p, "messageType").locator("select").selectOption("positional");
    await p.waitForSelector("#propose:not([hidden])");
    await p.click("#proposeApply");
    await p.waitForTimeout(1800);

    const after = await read();
    const emit = after["emit"] as Record<string, Record<string, unknown>>[];
    expect(emit[0]!["options"]).toEqual({ namespace: "Shop", messageType: "positional" });
    // The other entry is untouched, and so is the comment.
    expect(emit[1]!["options"]).toEqual({ namespace: "Shop", valueTypes: "alias" });
    expect(after["_comment"]).toContain("must not discard it");
    expect(after["out"]).toBe("generated");
  }, 120_000);

  it("removes it rather than writing the default back", async () => {
    if (!ready) return;
    const p = await open();
    // `valueTypes` is set to `alias` on the second entry; putting it back to `wrapper` is not a
    // decision worth recording, so the manifest should stop mentioning it.
    await p.selectOption("#optionsWhich", "1");
    await p.waitForTimeout(300);
    await row(p, "valueTypes").locator("select").selectOption("wrapper");
    await p.waitForSelector("#propose:not([hidden])");
    expect(await p.locator("#proposeWhat").textContent()).toContain("back to the default");

    await p.click("#proposeApply");
    await p.waitForTimeout(1800);
    const emit = (await read())["emit"] as Record<string, Record<string, unknown>>[];
    expect(emit[1]!["options"]).toEqual({ namespace: "Shop" });
  }, 120_000);

  it("can be taken back, like every other edit", async () => {
    if (!ready) return;
    const p = await open();
    await row(p, "devHost").locator("input").uncheck();
    await p.waitForSelector("#propose:not([hidden])");
    await p.click("#proposeApply");
    await p.waitForTimeout(1800);
    expect(await readFile(manifest, "utf-8")).not.toBe(BUILD);

    await p.click("#undo");
    await p.waitForTimeout(1800);
    expect(await readFile(manifest, "utf-8")).toBe(BUILD);
  }, 120_000);

  it("shows the new value afterwards, without a page reload", async () => {
    if (!ready) return;
    const p = await open();
    await row(p, "messageType").locator("select").selectOption("class");
    await p.waitForSelector("#propose:not([hidden])");
    await p.click("#proposeApply");
    await p.waitForTimeout(1800);

    // `loadProviders` used to run once at startup, which is why a manifest edit needed a reload.
    expect(await row(p, "messageType").locator("i").textContent()).toBe("set");
    expect(await row(p, "messageType").locator("select").inputValue()).toBe("class");
  }, 120_000);

  it("reaches the generated code, which is the point of changing it", async () => {
    if (!ready) return;
    const p = await open();
    await row(p, "devHost").locator("input").uncheck();
    await p.waitForSelector("#propose:not([hidden])");
    await p.click("#proposeApply");
    await p.waitForTimeout(1800);

    const planned = await p.evaluate(async () => {
      const response = await fetch("/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ only: [] }),
      });
      return (await response.json()) as { files: { path: string }[] };
    });
    expect(planned.files.map((f) => f.path).some((f) => f.includes("DevHost"))).toBe(false);
  }, 120_000);
});
