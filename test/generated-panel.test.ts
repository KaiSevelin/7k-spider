/**
 * The generated-code drawer, in a real browser, driven the way a reader drives it.
 *
 * All of this is behaviour a DOM either has or does not: a card shut shows no code, its header
 * toggles it, one control does every card at once, and the panel hides and comes back with its
 * contents intact. A source scan cannot see any of that, and a test that builds the markup itself
 * would be checking its own fixture — the point is that the page's own script wires it up.
 *
 * So the panel is filled by right-clicking the graph and picking `generate everything` out of the
 * menu, which is the only route a reader has to it.
 *
 * Needs a browser and the four provider repositories. Skipped rather than failed without either, so
 * a fresh clone still has a green suite.
 *
 * Assertions go through the locator rather than `expect(locator).toBeVisible()`: that matcher belongs
 * to Playwright's own `expect`, and this file uses vitest's, which reports it as an invalid property
 * rather than as a failing check.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { serve, type Serving } from "../src/serve.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const haveProviders = (() => {
  const from = createRequire(join(root, "7k.local"));
  try {
    for (const n of ["csharp", "sqlserver", "bicep", "node"]) from.resolve(`@sevenk/${n}`);
    return true;
  } catch {
    return false;
  }
})();

let browser: Browser | undefined;
let serving: Serving | undefined;
let page: Page | undefined;

/** True once there is a browser, a server and a filled panel to ask questions of. */
let ready = false;

/** Right-click the graph and pick the menu item that generates everything. */
const fill = async (p: Page): Promise<void> => {
  const box = await p.locator("#graph").boundingBox();
  if (box === null) throw new Error("no graph to right-click");
  // A corner, so the click lands on the background and the scope is the whole system.
  await p.mouse.click(box.x + 12, box.y + 12, { button: "right" });
  await p.waitForSelector("#menu:not([hidden])");
  await p.getByText("generate everything", { exact: true }).click();
  await p.waitForSelector("#preview:not([hidden])");
  await p.waitForSelector("#previewDocs .doc");
};

beforeAll(async () => {
  if (!haveProviders) return;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({ channel: "msedge" });
  } catch {
    return; // no Edge here
  }
  serving = await serve({ paths: [join(root, "examples")], port: 0, watch: false });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(serving.url);
  await page.waitForSelector("#graph");
  await fill(page);
  ready = true;
}, 180_000);

afterAll(async () => {
  await page?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await serving?.close().catch(() => undefined);
});

/** Shuts everything, so each test starts from the state the panel opens in. */
const reset = async (p: Page): Promise<void> => {
  await p.evaluate(() => {
    document.getElementById("preview")!.hidden = false;
    for (const card of document.querySelectorAll("#previewDocs .doc")) card.classList.remove("open");
  });
};

const cards = (p: Page) => p.locator("#previewDocs .doc").filter({ has: p.locator("pre") });

describe.skipIf(!haveProviders)("the generated-code drawer", () => {
  it("fills from the menu, with a card per file", async () => {
    if (!ready || page === undefined) return;
    expect(await cards(page).count()).toBeGreaterThan(20);
  });

  /**
   * Flush right and filling the graph region, which is what `#data` and the other drawers do.
   *
   * Measured against `#graph` rather than the window: the panel is positioned inside that region, so
   * it starts below the header and the filter row and stops above the timeline. An assertion against
   * the viewport's own top said 0 and got 82, which was the test being wrong rather than the panel.
   */
  it("is a drawer against the right edge, so the graph stays beside it", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const box = await page.locator("#preview").boundingBox();
    const area = await page.locator("#graph").boundingBox();
    const size = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(area).not.toBeNull();
    expect(Math.round(box!.x + box!.width)).toBe(size.width);
    expect(Math.round(box!.y)).toBe(Math.round(area!.y));
    expect(Math.round(box!.height)).toBe(Math.round(area!.height));
    // Narrower than the window, so what the code came from is still on screen behind it.
    expect(box!.width).toBeLessThan(size.width * 0.6);
  });

  it("shows no code at all until a header is clicked", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    expect(await page.locator("#previewDocs .doc pre:visible").count()).toBe(0);
    // The headers are all there, which is the list the panel is for.
    expect(await page.locator("#previewDocs .doc > header .path:visible").count()).toBeGreaterThan(20);
  });

  /**
   * The cards are as tall as their contents, and the list scrolls.
   *
   * Three tests in this file spent a long time failing on a 30s click timeout, which read as
   * flakiness and was a real fault: `#previewDocs` is a column flex container, an item's
   * `flex-shrink` is 1 by default, and seventy-four cards in a 740px panel were each compressed to
   * **two pixels** rather than the list scrolling — shrinking absorbs the overflow before
   * `overflow: auto` ever sees it. Every header still painted at its full height, outside the card
   * that `overflow: hidden` was clipping, so a click on one landed on the list behind it.
   *
   * Asserted as the property rather than as a pixel count: a card is at least as tall as the header
   * it contains, and a list of seventy-four of them has more to scroll than it can show. Either is
   * false the moment anything squeezes them again.
   */
  it("gives every card its full height, and scrolls instead of squeezing them", async () => {
    if (!ready || page === undefined) return;
    await reset(page);

    const facts = await page.evaluate(() => {
      const list = document.getElementById("previewDocs")!;
      const docs = [...document.querySelectorAll("#previewDocs .doc")];
      const short = docs.filter((doc) => {
        const header = doc.querySelector("header");
        if (header === null) return false;
        return doc.getBoundingClientRect().height < header.getBoundingClientRect().height;
      });
      return {
        docs: docs.length,
        clipped: short.length,
        scrolls: list.scrollHeight > list.clientHeight,
      };
    });

    expect(facts.docs).toBeGreaterThan(20);
    expect(facts.clipped, "cards shorter than their own headers").toBe(0);
    expect(facts.scrolls, "the list fits every card, which it cannot").toBe(true);
  }, 90_000);

  it("opens and shuts one file when its header is clicked", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const first = cards(page).first();
    await first.locator("header").click();
    expect(await first.locator("pre").isVisible()).toBe(true);
    expect(await page.locator("#previewDocs .doc pre:visible").count()).toBe(1);

    await first.locator("header").click();
    expect(await first.locator("pre").isHidden()).toBe(true);
    expect(await page.locator("#previewDocs .doc pre:visible").count()).toBe(0);
  });

  it("opens every file from the one control at the top, and shuts them again", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const total = await cards(page).count();

    await page.locator("#previewAll").click();
    expect(await page.locator("#previewDocs .doc pre:visible").count()).toBe(total);
    // The control says what it will do next, not what it did.
    expect(await page.locator("#previewAll").getAttribute("title")).toContain("shut every file");

    await page.locator("#previewAll").click();
    expect(await page.locator("#previewDocs .doc pre:visible").count()).toBe(0);
    expect(await page.locator("#previewAll").getAttribute("title")).toContain("open every file");
  });

  /** Copy and dismiss were required to be reachable whether or not the code is showing. */
  it("keeps copy and dismiss reachable in both states", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const header = cards(page).first().locator("header");
    expect(await header.locator("button.icon:visible").count()).toBeGreaterThanOrEqual(2);
    await header.click();
    expect(await header.locator("button.icon:visible").count()).toBeGreaterThanOrEqual(2);
  });

  /** A button in the header is its own control, not a click on the card. */
  it("does not open the card when a header button is used", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const first = cards(page).first();
    await first.locator("header button.icon").first().click();
    expect(await first.locator("pre").isHidden()).toBe(true);
  });

  it("hides on Escape and comes back from the header, with its contents", async () => {
    if (!ready || page === undefined) return;
    await reset(page);
    const before = await cards(page).count();

    await page.locator("#graph").click({ position: { x: 12, y: 12 } });
    await page.keyboard.press("Escape");
    expect(await page.locator("#preview").isHidden()).toBe(true);

    expect(await page.locator("#toggleGenerated").isVisible()).toBe(true);
    await page.locator("#toggleGenerated").click();
    expect(await page.locator("#preview").isVisible()).toBe(true);
    expect(await cards(page).count()).toBe(before);
  });
});

describe.skipIf(!haveProviders)("what the menu offers", () => {
  /**
   * A throwaway model, inside the repository.
   *
   * It has to be inside it: a provider is resolved by walking up from the model's own directory, so a
   * fixture in the system temp directory sees no `node_modules`, registers nothing, and would have the
   * menu empty for a reason that has nothing to do with what is being tested. `.scratch/` is already
   * gitignored.
   */
  const fixture = async (files: Readonly<Record<string, string>>): Promise<string> => {
    await mkdir(join(root, ".scratch"), { recursive: true });
    const dir = await mkdtemp(join(root, ".scratch", "menu-"));
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), text, "utf-8");
    }
    return dir;
  };

  /** Right-clicks the graph background and hands back the menu's rows. */
  const rowsOf = async (p: Page) => {
    const box = await p.locator("#graph").boundingBox();
    if (box === null) throw new Error("no graph to right-click");
    await p.mouse.click(box.x + 12, box.y + 12, { button: "right" });
    await p.waitForSelector("#menu:not([hidden])");
    return p.locator("#menu button");
  };

  it("offers every provider as a live choice when the model checks out", async () => {
    if (!ready || page === undefined) return;
    await page.keyboard.press("Escape");
    const rows = await rowsOf(page);
    // Four providers plus `generate everything`.
    expect(await rows.count()).toBe(5);
    expect(await rows.locator("[disabled]").count()).toBe(0);
    for (let i = 0; i < 5; i++) expect(await rows.nth(i).isDisabled()).toBe(false);
    await page.keyboard.press("Escape");
  });

  /**
   * A model with an error cannot produce anything: the run refuses it before a provider is asked.
   * So the rows are listed \u2014 which targets the model has is still worth knowing \u2014 and greyed.
   */
  it("greys every choice, with the reason, when the model does not check out", async () => {
    if (!ready || browser === undefined) return;

    // `Nope` is declared nowhere, which is an `unresolved-reference` error.
    const dir = await fixture({
      "broken.7k": [
        "package broken",
        "",
        "message Ask v1.0 @command { id: uuid @role(businessKey); what: Nope }",
        "",
        "pipe inbound : queue { }",
        "",
        "service Desk {",
        "  reacts Ask from inbound { replies none }",
        "}",
        "",
      ].join("\n"),
      ".7k/build.json": JSON.stringify(
        {
          out: "generated",
          providers: ["@sevenk/csharp", "@sevenk/node"],
          emit: [
            { provider: "csharp", out: "csharp", options: { namespace: "Broken" } },
            { provider: "node", out: "ts" },
          ],
        },
        null,
        2,
      ),
    });

    const other = await serve({ paths: [dir], port: 0, watch: false });
    const broken = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await broken.goto(other.url);
      await broken.waitForSelector("#graph");
      // The page has to have heard about the diagnostics before the menu can know.
      await broken.waitForFunction(
        () => (document.getElementById("problemsCount")?.textContent ?? "").length > 0,
      );

      const rows = await rowsOf(broken);
      expect(await rows.count()).toBe(3); // two providers, plus `generate everything`
      for (let i = 0; i < 3; i++) {
        expect(await rows.nth(i).isDisabled()).toBe(true);
        expect(await rows.nth(i).locator("i").textContent()).toBe("the model does not check out");
      }
    } finally {
      await broken.close().catch(() => undefined);
      await other.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * Only the whole-system case is driven from here.
   *
   * A right click on one *node* cannot be: the graph is drawn by Cytoscape into a canvas, so a pipe is
   * not an element to aim at. Which providers go grey for a pipe is checked where the answer actually
   * comes from — against each provider's declared kinds, in `demo-providers.test.ts`.
   */
  it("leaves every provider live for the whole system", async () => {
    if (!ready || page === undefined) return;
    await page.keyboard.press("Escape");
    const box = await page.locator("#graph").boundingBox();
    await page.mouse.click(box!.x + 12, box!.y + 12, { button: "right" });
    await page.waitForSelector("#menu:not([hidden])");
    expect(await page.locator("#menu button[disabled]").count()).toBe(0);
    await page.keyboard.press("Escape");
  });

  /**
   * A stub leaves its card's right edge for the exit rail, and in a parallel stage the sibling card
   * is directly in its path. Painted after the cards it crossed their rows at almost exactly their
   * baselines, so a step's text came out struck through by a neighbour's rail. The card boxes are
   * opaque, so the fix is order: the rail goes under them, like the spine.
   */
  it("draws the exit rail under the cards it passes", async () => {
    if (!ready || browser === undefined) return;
    const p = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    try {
      await p.goto(serving!.url);
      await p.waitForSelector("#graph");
      await p.waitForSelector("#toggleSaga:not([hidden])");
      await p.click("#toggleSaga");
      await p.waitForSelector("#sagaCanvas svg .exits");

      const order = await p.evaluate(() => {
        const svg = document.querySelector("#sagaCanvas svg")!;
        const kids = [...svg.children];
        return {
          exits: kids.findIndex((k) => k.classList.contains("exits")),
          firstStage: kids.findIndex((k) => k.classList.contains("stage")),
        };
      });
      expect(order.exits).toBeGreaterThanOrEqual(0);
      expect(order.firstStage).toBeGreaterThanOrEqual(0);
      expect(order.exits).toBeLessThan(order.firstStage);
    } finally {
      await p.close().catch(() => undefined);
    }
  }, 60_000);

  it("says so plainly when a model registers no providers at all", async () => {
    if (!ready || browser === undefined) return;

    const dir = await fixture({
      "bare.7k": [
        "package bare",
        "",
        "message Ask v1.0 @command { id: uuid @role(businessKey) }",
        "",
        "pipe inbound : queue { }",
        "",
        "service Desk {",
        "  reacts Ask from inbound { replies none }",
        "}",
        "",
      ].join("\n"),
    });

    const other = await serve({ paths: [dir], port: 0, watch: false });
    const bare = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await bare.goto(other.url);
      await bare.waitForSelector("#graph");
      const box = await bare.locator("#graph").boundingBox();
      await bare.mouse.click(box!.x + 12, box!.y + 12, { button: "right" });
      await bare.waitForSelector("#menu:not([hidden])");
      expect(await bare.locator("#menu button").count()).toBe(0);
      expect(await bare.locator("#menu > i").textContent()).toContain("no providers registered");
    } finally {
      await bare.close().catch(() => undefined);
      await other.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
