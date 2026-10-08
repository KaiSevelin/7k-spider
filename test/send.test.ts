/**
 * Sending a message to code that is actually running.
 *
 * This is the thing Spider could not do. It could draw a model, compose a body against a message's
 * own declaration, and then write a `publish` step into a file — and "send it" meant going to a
 * terminal. The gap was never a mechanism: the sandbox's engine has taken a `live` map all along, and
 * three things satisfy it. What was missing was somewhere to write down which service is which, and
 * something to join the two up.
 *
 * So: `.7k/hosts.json` says where your code runs, `POST /run` builds a one-step scenario and runs it
 * with those hosts live, and what comes back is a trace — which is what Spider already knows how to
 * draw.
 *
 * **The host here is a module rather than a process**, deliberately, because this is a test of the
 * wiring and a `dotnet build` in it would be testing .NET. The process form is proven end to end in
 * the C# provider's own `npm run devhost`, which spawns a real `dotnet` and drives it through the
 * same `startHosts` this uses.
 *
 * Needs no browser: the route is the subject, and the page is a thin caller of it.
 */

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Browser, Page } from "playwright-core";
import { serve, type Serving } from "../src/serve.js";

const MODEL = `package demo

message Work v1.0 @command {
  jobId: uuid @role(businessKey)
  size:  int { range 1..100 }
}

message Done v1.0 @event {
  jobId: uuid @role(businessKey)
}

message Refused v1.0 @event {
  jobId: uuid @role(businessKey)
}

pipe inbound : queue {
  delivery at-least-once
  retention 7d
}

service Till @external {
  emits Work to inbound
}

service Desk {
  emits Done    to inbound
  emits Refused to inbound

  reacts Work from inbound {
    replies Done | Refused
  }
}
`;

/**
 * A handler, as a module host.
 *
 * It branches on the body, so a reply arriving proves the body arrived — rather than proving that
 * something answered, which a handler returning one constant would also do.
 */
const HANDLER = `export const deskDevHost = (message) => {
  console.log("handling " + message.envelope.type);
  return Number(message.body.size) > 50
    ? { reply: "Refused", body: { jobId: message.body.jobId } }
    : { reply: "Done", body: { jobId: message.body.jobId } };
};
`;

const JOB = "11111111-1111-1111-1111-111111111111";

let at: string | undefined;
let serving: Serving | undefined;

beforeAll(async () => {
  at = await mkdtemp(join(tmpdir(), "spider-send-"));
  await writeFile(join(at, "demo.7k"), MODEL, "utf-8");
  await mkdir(join(at, ".7k"), { recursive: true });
  await writeFile(join(at, ".7k", "desk.mjs"), HANDLER, "utf-8");
  await writeFile(
    join(at, ".7k", "hosts.json"),
    JSON.stringify({ "demo.Desk": { module: "./desk.mjs", export: "deskDevHost" } }, null, 2),
    "utf-8",
  );
  serving = await serve({ paths: [at], port: 0, watch: false });
}, 120_000);

afterAll(async () => {
  await serving?.close().catch(() => undefined);
  if (at !== undefined) await rm(at, { recursive: true, force: true }).catch(() => undefined);
});

/** `serving.url` carries a trailing slash, which the rest of these tests strip the same way. */
const at_ = (path: string): string => `${serving!.url.slice(0, -1)}${path}`;

/** Posts as the page does, including the header `fromOurOwnPage` checks. */
async function send(body: unknown): Promise<{ status: number; outcome: Record<string, unknown> }> {
  const response = await fetch(at_("/run"), {
    method: "POST",
    headers: { "content-type": "application/json", origin: serving!.url.slice(0, -1) },
    body: JSON.stringify(body),
  });
  return { status: response.status, outcome: (await response.json()) as Record<string, unknown> };
}

const kinds = (outcome: Record<string, unknown>): string[] =>
  (outcome.trace as { kind: string; message?: string }[]).map((e) =>
    e.message === undefined ? e.kind : `${e.kind} ${e.message}`,
  );

describe("sending a composed message", () => {
  it("reaches a live handler and comes back as a trace", async () => {
    const { status, outcome } = await send({
      message: "demo.Work",
      as: "Till",
      body: { jobId: JOB, size: 10 },
    });

    expect(status).toBe(200);
    expect(outcome.problems, JSON.stringify(outcome.problems)).toEqual([]);
    expect(outcome.unstarted).toEqual([]);
    // Said rather than implied: the page can tell you which services were real.
    expect(outcome.ran).toEqual(["demo.Desk"]);

    const seen = kinds(outcome);
    expect(seen).toContain("published demo.Work");
    expect(seen).toContain("delivered demo.Work");
    expect(seen).toContain("published demo.Done");

    // What the handler printed, which is where a `console.log` in your code lands.
    expect((outcome.said as string[]).join(" ")).toBe("");
  }, 60_000);

  /** The other arm, so the reply proves the body arrived rather than that something answered. */
  it("carries the body, which the handler's own branch proves", async () => {
    const { outcome } = await send({
      message: "demo.Work",
      as: "Till",
      body: { jobId: JOB, size: 90 },
    });
    const seen = kinds(outcome);
    expect(seen).toContain("published demo.Refused");
    expect(seen).not.toContain("published demo.Done");
  }, 60_000);

  /**
   * A body the model refuses never leaves. The composer checks it too, so this is the second line of
   * the same defence — and it is the one that holds when the body came from somewhere else.
   */
  it("refuses a body the contract refuses, and says which field", async () => {
    const { outcome } = await send({
      message: "demo.Work",
      as: "Till",
      body: { jobId: JOB, size: 900 },
    });
    expect(outcome.status).toBe("fail");
    expect((outcome.problems as string[]).join(" ")).toMatch(/size/);
    expect(kinds(outcome)).not.toContain("published demo.Work");
  }, 60_000);

  it("refuses a message the model does not declare, before running anything", async () => {
    const { outcome } = await send({ message: "demo.Nope", as: "Till", body: {} });
    expect(outcome.status).toBe("refused");
    expect((outcome.problems as string[]).join(" ")).toContain("Nope");
  }, 60_000);

  /**
   * Everything not named by `hosts.json` is mocked, which is what makes a send useful before anything
   * is implemented — and what `30-scenarios.md` section 4 means by liveness not being part of the
   * claim.
   */
  it("mocks what has no host, rather than refusing to run", async () => {
    const { outcome } = await send({
      message: "demo.Work",
      as: "Till",
      body: { jobId: JOB, size: 10 },
      live: [],
    });
    expect(outcome.ran).toEqual([]);
    expect(outcome.problems).toEqual([]);
    // Still delivered, and still answered — by a mock, which is the default fidelity.
    expect(kinds(outcome)).toContain("delivered demo.Work");
  }, 60_000);

  it("names a host it could not start and runs the rest anyway", async () => {
    await writeFile(
      join(at!, ".7k", "hosts.json"),
      JSON.stringify({ "demo.Desk": { module: "./not-here.mjs" } }),
      "utf-8",
    );
    try {
      const { outcome } = await send({
        message: "demo.Work",
        as: "Till",
        body: { jobId: JOB, size: 10 },
      });
      expect((outcome.unstarted as string[]).join(" ")).toContain("demo.Desk");
      expect(outcome.ran).toEqual([]);
      // The run happened regardless, which is the trade: a scenario that still says something beats
      // one that says nothing because a project would not build.
      expect(kinds(outcome)).toContain("delivered demo.Work");
    } finally {
      await writeFile(
        join(at!, ".7k", "hosts.json"),
        JSON.stringify({ "demo.Desk": { module: "./desk.mjs", export: "deskDevHost" } }),
        "utf-8",
      );
    }
  }, 60_000);

  /** It starts processes. A page on this machine that is not Spider's own must not be able to. */
  it("will not run for a page that is not Spider's own", async () => {
    const response = await fetch(at_("/run"), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ message: "demo.Work", as: "Till", body: { jobId: JOB, size: 1 } }),
    });
    expect(response.status).toBe(403);
  }, 60_000);
});

/**
 * And the button, which is the whole point.
 *
 * The route is tested above. This is the gesture: open the composer, fill in a body against the
 * message's own declaration, press send, and watch a timeline appear for a run that reached code in
 * another file. It is the demo's second half in one test.
 */
describe("the send button", () => {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let ready = false;

  beforeAll(async () => {
    try {
      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ channel: "msedge" });
    } catch {
      return;
    }
    page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await page.goto(serving!.url);
    await page.waitForSelector("#graph");
    ready = true;
  }, 180_000);

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  });

  /**
   * What a reader sees when the server cannot answer.
   *
   * `bin` runs a compiled `dist/`, so a Spider left running from before this route existed answers
   * 404 with the word `not found` — and parsing that as JSON reported `Unexpected token 'o'`, which
   * says nothing about what went wrong and sends the reader to look at their payload. The first
   * person to try sending hit exactly this.
   */
  it("says a server without the route is old, rather than failing to parse its answer", async () => {
    if (!ready || page === undefined) return;
    if (await page.locator("#compose").isHidden()) await page.click("#toggleCompose");
    await page.waitForSelector("#compose:not([hidden])");
    await page.selectOption("#composeWhat", "message:demo.Work");
    await page.waitForTimeout(300);
    await page.fill("#composeForm [data-path='jobId'] input", JOB);
    await page.fill("#composeForm [data-path='size'] input", "10");
    await page.waitForTimeout(400);

    // Answering as an older Spider would, which is the one case that cannot be arranged for real.
    await page.evaluate(() => {
      const real = window.fetch;
      (window as unknown as { __realFetch?: typeof fetch }).__realFetch = real;
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/run")
          ? new Response("not found", { status: 404, headers: { "content-type": "text/plain" } })
          : real(input, init)) as typeof fetch;
    });

    try {
      await page.locator("#composeSend").click();
      await page.waitForTimeout(800);
      const said = (await page.locator("#composeState").textContent()) ?? "";
      expect(said).toContain("older than this page");
      expect(said).not.toContain("JSON");
    } finally {
      await page.evaluate(() => {
        const real = (window as unknown as { __realFetch?: typeof fetch }).__realFetch;
        if (real !== undefined) window.fetch = real;
      });
    }
  }, 180_000);

  /**
   * A pipe is where you point to ask what travels here, and then to send one. Before this, getting
   * from a pipe on the drawing to a body going onto it meant finding the name again in a dropdown of
   * every message in the model.
   */
  it("opens the composer on a message the pipe under the pointer carries", async () => {
    if (!ready || page === undefined) return;
    await page.evaluate(() => {
      const panel = document.getElementById("compose");
      if (panel !== null) panel.hidden = true;
    });

    const where = await page.evaluate(() => {
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
      const el = cy?.getElementById("pipe:demo.inbound");
      if (cy === undefined || el === undefined || el.length === 0) return undefined;
      cy.center(el);
      const box = el.renderedBoundingBox();
      return { x: (box.x1 + box.x2) / 2, y: (box.y1 + box.y2) / 2 };
    });
    expect(where, "the pipe is not drawn").toBeDefined();

    const graph = await page.locator("#graph").boundingBox();
    await page.mouse.click(graph!.x + where!.x, graph!.y + where!.y, { button: "right" });
    await page.waitForSelector("#menu:not([hidden])");

    // Everything the pipe carries, which here is the command in and both replies out.
    const rows = await page.locator("#menu button").allTextContents();
    expect(rows.join(" | ")).toContain("compose Work");
    expect(rows.join(" | ")).toContain("compose Done");

    await page.locator("#menu button", { hasText: "compose Work" }).first().click();
    await page.waitForSelector("#compose:not([hidden])");
    expect(await page.locator("#composeWhat").inputValue()).toBe("message:demo.Work");
  }, 180_000);

  it("sends what the composer built, and the timeline fills with the run", async () => {
    if (!ready || page === undefined) return;
    await writeFile(
      join(at!, ".7k", "hosts.json"),
      JSON.stringify({ "demo.Desk": { module: "./desk.mjs", export: "deskDevHost" } }),
      "utf-8",
    );

    if (await page.locator("#compose").isHidden()) await page.click("#toggleCompose");
    await page.waitForSelector("#compose:not([hidden])");
    await page.selectOption("#composeWhat", "message:demo.Work");
    await page.waitForTimeout(300);

    // The form is derived from the declaration, so each field carries the path it writes to.
    await page.fill("#composeForm [data-path='jobId'] input", JOB);
    await page.fill("#composeForm [data-path='size'] input", "10");
    await page.waitForTimeout(400);

    const send = page.locator("#composeSend");
    expect(await send.isDisabled()).toBe(false);
    await send.click();
    await page.waitForTimeout(2_000);

    // What ran is said rather than implied, because a green run on a mock reads the same as a green
    // run on your code unless something says which it was.
    expect(await page.locator("#composeState").textContent()).toContain("Desk");

    // And the trace is in the player, which is what every other view reads.
    expect(await page.locator("#timeline").isVisible()).toBe(true);
    const events = await page.evaluate(() => document.querySelectorAll("#timeline .tick").length);
    expect(events).toBeGreaterThan(0);
  }, 180_000);
});
