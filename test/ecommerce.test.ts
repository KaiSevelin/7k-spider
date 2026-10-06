/**
 * The shop workspace, checked.
 *
 * The third example exists to carry what the other two had no honest use for, so the tests that matter
 * are the ones that assert those things are still there: a `stream`, a payment pipe that deduplicates
 * in the transport, a dead-letter pipe with a name, money that is `decimal`, and a versioned message
 * with an upcast somebody actually accepts.
 *
 * A sample whose distinguishing feature quietly disappears is worse than no sample, because the README
 * beside it goes on describing something that is not there.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspace, flowOf, readTrace, validateTrace, type LinkedModel } from "@sevenk/core";
import { buildGraph } from "../src/graph.js";
import { parseViews, resolveLens } from "../src/lens.js";
import { runsOf } from "../src/play.js";
import { narrate } from "../src/narrate.js";
import { parseMarkdown } from "../src/markdown.js";
import { PIPE_SHAPE } from "../src/render.js";

const SAMPLE = join(import.meta.dirname, "..", "samples", "ecommerce");

const files = (): { path: string; source: string }[] =>
  readdirSync(SAMPLE, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".7k"))
    .map((e) => ({ path: join(SAMPLE, e.name), source: readFileSync(join(SAMPLE, e.name), "utf-8") }));

const model = (): LinkedModel => buildWorkspace(files()).model;

const pipe = (m: LinkedModel, pkg: string, name: string) => {
  const found = m.decls.find((d) => d.kind === "pipe" && d.id.pkg === pkg && d.id.name === name);
  return found?.kind === "pipe" ? found : undefined;
};

describe("the shop workspace", () => {
  it("checks out, with nothing to warn about", () => {
    const ws = buildWorkspace(files());
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(ws.diagnostics.filter((d) => d.severity === "warning").map((d) => d.code)).toEqual([]);
  });

  it("is the four packages it says it is", () => {
    expect([...new Set(model().decls.map((d) => d.id.pkg))].sort()).toEqual([
      "shop.catalog",
      "shop.common",
      "shop.orders",
      "shop.payments",
    ]);
  });

  it("has the only `stream` in any of the samples, which is what the barrel is for", () => {
    const movements = pipe(model(), "shop.catalog", "movements");
    expect(movements?.pipeKind).toBe("stream");
    expect(PIPE_SHAPE.stream).toBe("barrel");

    // And it is the only one, which is the claim the README makes about it.
    const streams = model().decls.filter((d) => d.kind === "pipe" && d.pipeKind === "stream");
    expect(streams).toHaveLength(1);
  });

  it("deduplicates payments in the transport as well as in the handler", () => {
    // Two nets, deliberately. The handler's `once per orderRef` is the first and is not replaced by
    // this; see the comment in payments.7k.
    const commands = pipe(model(), "shop.payments", "commands");
    expect(commands?.delivery).toBe("effectively-once");

    const authorise = model()
      .decls.find((d) => d.kind === "service" && d.id.name === "PaymentService");
    const react = authorise?.kind === "service" ? authorise.reacts[0] : undefined;
    expect(react?.dedupe).toEqual({ by: "orderRef" });
  });

  it("sends hopeless payments to a dead-letter pipe with a name", () => {
    // `undefined` would be the implicit `<pipe>.dead` and `null` would be `dlq none`; a Ref is the
    // declared pipe, which is the whole point of this one.
    const commands = pipe(model(), "shop.payments", "commands");
    expect(commands?.dlq?.text).toBe("failed");
    // And that pipe ends the line, rather than having a dead letter of its own.
    expect(pipe(model(), "shop.payments", "failed")?.dlq).toBeNull();
  });

  it("keeps money exact, and the currency with the amount", () => {
    const money = model().decls.find((d) => d.kind === "record" && d.id.name === "Money");
    const amount = money?.kind === "record" ? money.fields.find((f) => f.name === "amount") : undefined;
    // `float` here would be a rounding bug with a spec behind it (`01-kernel.md` 1).
    expect(JSON.stringify(amount?.type)).toContain("decimal");
    expect(money?.kind === "record" ? money.fields.map((f) => f.name) : []).toEqual([
      "amount",
      "currency",
    ]);
  });

  it("has a versioned message with an upcast somebody accepts", () => {
    // An upcast nobody admits an old version to is dead code: `accepts v1.x` on the consumer is what
    // makes it run at all.
    const upcast = model().decls.find((d) => d.kind === "upcast");
    expect(upcast?.kind === "upcast" ? upcast.message.text : undefined).toBe("OrderPlaced");

    const reporting = model().decls.find((d) => d.kind === "service" && d.id.name === "Reporting");
    const placed =
      reporting?.kind === "service"
        ? reporting.reacts.find((r) => r.message.text === "OrderPlaced")
        : undefined;
    expect(placed?.accepts).toBeDefined();
  });

  it("keeps personal data out of the shelf and the card network", () => {
    // Declared on three values in `shop.common`. An address belongs to the order and to the instruction
    // to ship it, and to nothing that counts stock or moves money.
    const reached = flowOf(model(), "pii");
    expect(reached.filter((d) => d.kind === "value").map((d) => d.id.name).sort()).toEqual([
      "EmailAddress",
      "PersonName",
      "PostalAddress",
    ]);
    expect(reached.some((d) => d.id.pkg === "shop.catalog")).toBe(false);
    expect(reached.some((d) => d.id.pkg === "shop.payments")).toBe(false);
  });

  it("has a saga whose stage holds two things that both have to be given back", () => {
    const saga = model().decls.find((d) => d.kind === "saga");
    expect(saga?.id.name).toBe("Fulfilment");
    expect(model().decls.some((d) => d.kind === "schedule")).toBe(true);
  });
});

describe("its committed trace", () => {
  const trace = (): ReturnType<typeof readTrace> =>
    readTrace(readFileSync(join(SAMPLE, "fulfilment.ndjson"), "utf-8"));

  it("is well formed, so a stale one fails rather than misleads", () => {
    const { events, problems } = trace();
    expect(problems).toEqual([]);
    expect(validateTrace(events)).toEqual([]);
    expect(events.length).toBeGreaterThan(100);
  });

  it("holds one run per scenario", () => {
    expect(
      runsOf(trace().events)
        .map((r) => r.run.replace(/#\d+$/, ""))
        .sort(),
    ).toEqual([
      "CardDeclined",
      "CatalogueNeverAnswers",
      "NothingShipped",
      "OrderShipsSameDay",
      "OutOfStock",
      "PlaceWithoutScope",
      "SweepRunsNightly",
    ]);
  });

  it("captions every event in it", () => {
    for (const event of trace().events) {
      const { text } = narrate(event);
      expect(text, `${event.run}#${event.seq} ${event.kind}`).not.toContain("undefined");
      expect(text.trim(), `${event.run}#${event.seq} ${event.kind}`).not.toBe("");
    }
  });
});

describe("its lenses and its prose", () => {
  const views = () => {
    const { views, problems } = parseViews(readFileSync(join(SAMPLE, ".7k", "views.json"), "utf-8"));
    expect(problems).toEqual([]);
    return views;
  };

  it("are the five the sample advertises", () => {
    expect(Object.keys(views()).sort()).toEqual([
      "Fulfilment",
      "Ledger",
      "Money",
      "Perimeter",
      "PiiFlow",
    ]);
  });

  it("all select something, because a lens that draws nothing is a broken saved filter", () => {
    const whole = buildGraph(model());
    for (const [name, lens] of Object.entries(views())) {
      const drawn = resolveLens(whole, lens);
      expect(drawn.nodes.filter((n) => n.kind !== "package" && n.kind !== "port").length, name)
        .toBeGreaterThan(0);
    }
  });

  it("has a README the `about` panel can draw", () => {
    const blocks = parseMarkdown(readFileSync(join(SAMPLE, "README.md"), "utf-8"));
    expect(blocks.filter((b) => b.k === "heading").length).toBeGreaterThan(4);
    expect(blocks.some((b) => b.k === "table")).toBe(true);
    expect(blocks.some((b) => b.k === "code")).toBe(true);
  });
});
