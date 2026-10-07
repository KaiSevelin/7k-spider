/**
 * Adding to a scenario from the `+` dropdown.
 *
 * A scenario file is a sibling specification and not part of the language, and it is edited from the
 * same control as everything else, because for somebody reading a model the line between "the system"
 * and "what I claim about the system" is not where the toolbar should be.
 *
 * What is asserted here is the part the UI owns: that the right flow opens, that the lists offer what
 * the operation accepts and nothing else, and that applying writes the file. What each operation
 * *writes* is Core's, and `7K/packages/core/test/mutate.test.ts` holds the four properties for it.
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
const dir = join(root, ".scratch", "scenario-add");
const model = join(dir, "shop.7k");
const scenarios = join(dir, "shop.scenario.7k");

/**
 * `Placed` has one sender and one pipe, so both derivations have a single answer. `Reorder` has two
 * senders, and `Audited` two pipes, so both ask.
 */
const MODEL = `package shop

message Place   v1.0 @command { orderId: uuid @role(businessKey) }
message Reorder v1.0 @command { orderId: uuid @role(businessKey) }
message Placed  v1.0 @event   { orderId: uuid @role(businessKey) }
message Audited v1.0 @event   { orderId: uuid @role(businessKey) }

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }
pipe audit   : topic { retention 7d }

service Storefront @external {
  emits Place   to inbound
  emits Reorder to inbound
}

service Kiosk @external {
  emits Reorder to inbound
}

service Desk {
  reacts Place   from inbound { replies Placed }
  reacts Reorder from inbound { replies Placed }
  emits  Placed  to events
  emits  Audited to events
  emits  Audited to audit
}

service Ledger {
  reacts Placed from events { replies none }
}
`;

const SCENARIOS = `scenarios for shop

mockset Base {
  mock Desk {
    on Place reply Placed
  }
}

scenario Baseline {
  seed 1
  use  Base

  at 0s publish Place as Storefront
  advance 1s
}
`;

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;
let ready = false;

const reset = async (): Promise<void> => {
  await mkdir(dir, { recursive: true });
  await writeFile(model, MODEL, "utf-8");
  await writeFile(scenarios, SCENARIOS, "utf-8");
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

/** A fresh load, with the files back as they started. */
const open = async (): Promise<Page> => {
  const p = page!;
  await reset();
  await p.goto(serving!.url);
  await p.waitForSelector("#graph canvas");
  return p;
};

/** Picks a kind in the dropdown and opens its panel. */
const start = async (p: Page, kind: string): Promise<void> => {
  await p.selectOption("#addWhat", kind);
  await p.click("#addNew");
  await p.waitForSelector("#addForm");
};

const preview = async (p: Page): Promise<string> =>
  (await p.locator("#proposeBody pre").first().textContent()) ?? "";

/** The options of the nth select in the form. */
const options = (p: Page, nth: number): Promise<string[]> =>
  p.locator(`#addForm select >> nth=${nth}`).locator("option").allTextContents();

describe("the dropdown", () => {
  it("offers the scenario kinds, grouped", async () => {
    if (!ready) return;
    const p = await open();
    const kinds = await p.locator("#addWhat option").evaluateAll((os) =>
      os.map((o) => (o as HTMLOptionElement).value),
    );
    expect(kinds).toContain("scenario");
    expect(kinds).toContain("publish");
    expect(kinds).toContain("expect");
    expect(kinds).toContain("advance");
  });

  it("greys a scenario kind when there is no scenario file, and says why", async () => {
    if (!ready) return;
    const p = page!;
    await reset();
    await rm(scenarios);
    await p.goto(serving!.url);
    await p.waitForSelector("#graph canvas");

    const blocked = await p
      .locator('#addWhat option[value="publish"]')
      .evaluate((o) => ({
        disabled: (o as HTMLOptionElement).disabled,
        title: (o as HTMLOptionElement).title,
      }));
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toContain("no scenario");

    // And a model kind is still offered, since the model is fine.
    expect(
      await p.locator('#addWhat option[value="service"]').evaluate((o) => (o as HTMLOptionElement).disabled),
    ).toBe(false);
  }, 90_000);
});

describe("adding a publish", () => {
  it("offers only the messages something emits", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "publish");
    const offered = await options(p, 1);
    expect(offered).toContain("shop.Place");
    expect(offered).toContain("shop.Reorder");
    // `Placed` is emitted by `Desk`, so it is offered too — publishing an event as its producer is
    // how a scenario stands a downstream service up on its own.
    expect(offered).toContain("shop.Placed");
  }, 90_000);

  it("derives the sender, and the point on the clock, without asking", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "publish");
    await p.selectOption("#addForm select >> nth=1", "shop.Place");
    // `Place` has one sender, so the picker has nothing to choose and says which it took.
    expect(await p.locator("#addForm select >> nth=2").isDisabled()).toBe(true);
    // `Baseline` published at 0s and then advanced a second.
    expect(await preview(p)).toContain("at 1s publish Place as Storefront");
  }, 90_000);

  it("asks which sender when the model names two", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "publish");
    await p.selectOption("#addForm select >> nth=1", "shop.Reorder");
    const senders = await options(p, 2);
    expect(senders.sort()).toEqual(["shop.Kiosk", "shop.Storefront"]);
    expect(await p.locator("#addForm select >> nth=2").isDisabled()).toBe(false);
    expect(await preview(p)).toContain("publish Reorder as");
  }, 90_000);

  it("writes it, and says the body is still wanted", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "publish");
    await p.selectOption("#addForm select >> nth=1", "shop.Place");
    expect(await p.locator("#proposeBody .why").textContent()).toContain("unchecked");

    await p.click("#proposeApply");
    await p.waitForTimeout(1300);
    const after = await readFile(scenarios, "utf-8");
    expect(after).toContain("at 1s publish Place as Storefront");
    // Inside `Baseline`, after the step that was there.
    expect(after.indexOf("at 1s publish")).toBeGreaterThan(after.indexOf("advance 1s"));
  }, 90_000);
});

describe("adding an expectation", () => {
  it("offers only the messages something carries, and derives the pipe", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "expect");
    await p.selectOption("#addForm select >> nth=1", "shop.Placed");
    expect(await preview(p)).toContain("expect Placed on events");
  }, 90_000);

  it("asks which pipe when the message travels on two", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "expect");
    await p.selectOption("#addForm select >> nth=1", "shop.Audited");
    const pipes = await options(p, 2);
    expect(pipes.sort()).toEqual(["shop.audit", "shop.events"]);
  }, 90_000);

  it("opens every pipe once the assertion is negated (D109)", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "expect");
    await p.selectOption("#addForm select >> nth=1", "shop.Placed");
    expect(await options(p, 2)).toEqual(["shop.events"]);

    await p.check("#expectNone");
    await p.selectOption("#addForm select >> nth=1", "shop.Placed");
    // `no Placed on inbound` is a guard, not a tautology: it catches an implementation that sent it.
    expect((await options(p, 2)).sort()).toEqual(["shop.audit", "shop.events", "shop.inbound"]);
    await p.selectOption("#addForm select >> nth=2", "shop.inbound");
    expect(await preview(p)).toContain("expect no Placed on inbound");
  }, 90_000);

  it("writes it", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "expect");
    await p.selectOption("#addForm select >> nth=1", "shop.Placed");
    await p.click("#proposeApply");
    await p.waitForTimeout(1300);
    expect(await readFile(scenarios, "utf-8")).toContain("expect Placed on events");
  }, 90_000);
});

describe("adding an advance, and a scenario", () => {
  it("offers nothing until a duration is given, then writes it", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "advance");
    expect(await p.locator("#proposeApply").isHidden()).toBe(true);

    await p.locator("#addForm input").fill("45s");
    await p.waitForTimeout(250);
    expect(await preview(p)).toContain("advance 45s");

    await p.click("#proposeApply");
    await p.waitForTimeout(1300);
    expect(await readFile(scenarios, "utf-8")).toContain("advance 45s");
  }, 90_000);

  it("adds a scenario with a seed and the mockset it is told to inherit", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "scenario");
    await p.locator("#addForm input").fill("Probe");
    await p.waitForTimeout(250);
    await p.selectOption("#addForm select >> nth=1", "Base");
    await p.waitForTimeout(250);

    const shown = await preview(p);
    expect(shown).toContain("scenario Probe {");
    expect(shown).toContain("seed 1");
    expect(shown).toContain("use Base");

    await p.click("#proposeApply");
    await p.waitForTimeout(1300);
    const after = await readFile(scenarios, "utf-8");
    expect(after).toContain("scenario Probe {");
    // Appended, so what was there is untouched.
    expect(after.startsWith(SCENARIOS.trimEnd())).toBe(true);
  }, 90_000);

  it("refuses a name the file already has", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "scenario");
    await p.locator("#addForm input").fill("baseline");
    await p.waitForTimeout(250);
    expect(await p.locator("#proposeBody .why").textContent()).toContain("already declares");
    expect(await p.locator("#proposeApply").isHidden()).toBe(true);
  }, 90_000);

  it("writes nothing until the preview is accepted", async () => {
    if (!ready) return;
    const p = await open();
    await start(p, "expect");
    await p.selectOption("#addForm select >> nth=1", "shop.Placed");
    expect(await readFile(scenarios, "utf-8")).toBe(SCENARIOS);
  }, 90_000);
});
