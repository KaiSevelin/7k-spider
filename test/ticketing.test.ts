/**
 * The support desk workspace, checked.
 *
 * The second example exists for the same reason the first does — to be looked at — and so needs the
 * same guard: a demo that quietly stops checking out is worse than no demo, because the first thing
 * anyone does with it is believe it.
 *
 * This asserts what the sample *claims*: four packages, a boundary, PII that propagates and stops, a
 * lossy pipe, a saga with a parallel stage, a schedule, the `issues` clause it was written to show, and
 * five lenses that all resolve. The machinery those use is tested elsewhere.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boundaryPipes,
  buildWorkspace,
  flowOf,
  readTrace,
  validateTrace,
  type LinkedModel,
} from "@sevenk/core";
import { buildGraph } from "../src/graph.js";
import { parseViews, resolveLens } from "../src/lens.js";
import { runsOf } from "../src/play.js";
import { narrate } from "../src/narrate.js";
import { parseMarkdown } from "../src/markdown.js";

const SAMPLE = join(import.meta.dirname, "..", "samples", "ticketing");

const files = (): { path: string; source: string }[] =>
  readdirSync(SAMPLE, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".7k"))
    .map((e) => ({ path: join(SAMPLE, e.name), source: readFileSync(join(SAMPLE, e.name), "utf-8") }));

const model = (): LinkedModel => buildWorkspace(files()).model;

describe("the support desk workspace", () => {
  it("checks out, with nothing to warn about", () => {
    const ws = buildWorkspace(files());
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(ws.diagnostics.filter((d) => d.severity === "warning").map((d) => d.code)).toEqual([]);
  });

  it("is the four packages it says it is", () => {
    const packages = new Set(model().decls.map((d) => d.id.pkg));
    expect([...packages].sort()).toEqual([
      "support.common",
      "support.contact",
      "support.desk",
      "support.roster",
    ]);
  });

  it("has a boundary, which is what makes the Perimeter lens mean anything", () => {
    const external = model()
      .decls.filter((d) => d.kind === "service" && d.external)
      .map((d) => d.id.name)
      .sort();
    expect(external).toEqual(["AgentApp", "AgentConsole", "MailGateway", "Portal"]);
    expect(boundaryPipes(model()).size).toBeGreaterThan(0);
  });

  it("has PII that propagates from a value to the pipes carrying it, and no further", () => {
    // Declared on two values in `support.common` and nowhere else. The second half is the sample's
    // actual claim: an address reaches the contact package and the message that raises a ticket, and
    // the roster never sees one.
    const reached = flowOf(model(), "pii");
    expect(reached.filter((d) => d.kind === "value").map((d) => d.id.name).sort()).toEqual([
      "EmailAddress",
      "PersonName",
    ]);
    expect(reached.some((d) => d.kind === "pipe")).toBe(true);
    expect(reached.some((d) => d.id.pkg === "support.roster")).toBe(false);
  });

  it("has the lossy pipe nothing may depend on", () => {
    const presence = model().decls.find((d) => d.kind === "pipe" && d.id.name === "presence");
    expect(presence?.kind === "pipe" ? presence.delivery : undefined).toBe("at-most-once");
  });

  it("has a saga with a parallel stage, and a schedule", () => {
    const saga = model().decls.find((d) => d.kind === "saga");
    expect(saga?.id.name).toBe("Resolution");
    // `claim` and `greet` share a stage; `work` follows it because it reads what `claim` produced.
    expect(saga?.kind === "saga" ? saga.steps.map((s) => s.name) : []).toContain("work");
    expect(model().decls.some((d) => d.kind === "schedule")).toBe(true);
  });

  it("uses `issues` for the mail that goes out, which is what it was written to show", () => {
    // The clause D103 added. If this disappears the sample still checks out, and the README beside it
    // starts describing something that is not there.
    const contact = model().decls.find((d) => d.kind === "service" && d.id.name === "ContactService");
    const react = contact?.kind === "service" ? contact.reacts[0] : undefined;
    expect(react?.issues?.map((i) => i.text)).toEqual(["SendEmail"]);
  });
});

describe("its committed trace", () => {
  const trace = (): ReturnType<typeof readTrace> =>
    readTrace(readFileSync(join(SAMPLE, "resolution.ndjson"), "utf-8"));

  it("is well formed, so a stale one fails rather than misleads", () => {
    const { events, problems } = trace();
    expect(problems).toEqual([]);
    expect(validateTrace(events)).toEqual([]);
    expect(events.length).toBeGreaterThan(100);
  });

  it("holds one run per scenario", () => {
    const runs = runsOf(trace().events);
    expect(runs.map((r) => r.run.replace(/#\d+$/, "")).sort()).toEqual([
      "NoAgentFree",
      "NobodyResolves",
      "RaiseWithoutScope",
      "RequesterUnreachable",
      "RosterNeverAnswers",
      "SweepRunsHourly",
      "TicketResolvedQuickly",
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
      "Floor",
      "Lossy",
      "Perimeter",
      "PiiFlow",
      "Resolution",
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
