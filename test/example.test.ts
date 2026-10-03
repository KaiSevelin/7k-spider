/**
 * The example workspace, checked.
 *
 * It exists to be looked at, which is exactly why it needs tests: a demo that quietly stops checking out
 * is worse than no demo, because the first thing anyone does with it is believe it.
 *
 * This asserts what the example *claims* — that it has a boundary, PII that propagates, a lossy pipe, a
 * saga, a schedule, and five lenses that all resolve — rather than re-testing the machinery those use.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boundaryPipes,
  buildWorkspace,
  flowOf,
  readTrace,
  symbolKey,
  validateTrace,
  type LinkedModel,
} from "@sevenk/core";
import { buildGraph } from "../src/graph.js";
import { parseViews, resolveLens } from "../src/lens.js";
import { runsOf } from "../src/play.js";
import { edgeForEvent } from "../src/graph.js";

const EXAMPLES = join(import.meta.dirname, "..", "examples");

const model = (): LinkedModel => {
  const files = readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".7k"))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ path: join(EXAMPLES, name), source: readFileSync(join(EXAMPLES, name), "utf-8") }));

  const ws = buildWorkspace(files);
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  return ws.model;
};

const named = (m: LinkedModel, name: string) =>
  m.decls.find((d) => d.id.name === name) ?? expect.fail(`no ${name}`);

describe("it checks out", () => {
  it("has no errors, across five files and four packages", () => {
    const m = model();
    expect([...m.packages.values()].filter((p) => p.declared).map((p) => p.name).sort()).toEqual([
      "parcel.common",
      "parcel.delivery",
      "parcel.lockers",
      "parcel.notify",
    ]);
  });

  it("reports exactly the two warnings it means to", () => {
    // Both are genuine and both are the point: two hops are choreographed, with nothing in the model
    // naming what drives them. An example with no warnings would teach less than one that explains its
    // own.
    const files = readdirSync(EXAMPLES, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".7k"))
      .map((e) => ({
        path: join(EXAMPLES, e.name),
        source: readFileSync(join(EXAMPLES, e.name), "utf-8"),
      }));
    const ws = buildWorkspace(files);
    const warnings = ws.diagnostics.filter((d) => d.severity === "warning");
    expect(warnings.map((d) => d.code).sort()).toEqual(["unexplained-emit", "unexplained-emit"]);
  });
});

describe("it contains what it says it contains", () => {
  it("a boundary, derived from four @external services", () => {
    const m = model();
    const external = m.decls.filter((d) => d.kind === "service" && d.external);
    expect(external.map((d) => d.id.name).sort()).toEqual([
      "CourierApp",
      "DoorController",
      "RecipientApp",
      "SmsGateway",
    ]);
    expect(boundaryPipes(m).size).toBeGreaterThan(0);
  });

  it("PII that propagates from a value to the pipes carrying it", () => {
    // Declared on two values in `parcel.common` and nowhere else. If it does not reach a pipe, the
    // PiiFlow lens selects nothing and the example's main claim is empty.
    const m = model();
    const reached = flowOf(m, "pii");
    expect(reached.filter((d) => d.kind === "value").map((d) => d.id.name).sort()).toEqual([
      "PersonName",
      "PhoneNumber",
    ]);
    expect(reached.some((d) => d.kind === "pipe")).toBe(true);
    expect(reached.some((d) => d.kind === "message")).toBe(true);
  });

  it("a best-effort publication beside a lossy pipe, which are different axes", () => {
    // The pipe may lose a reading that was sent; the publication means one may never be sent at all. Both
    // are honest for a door sensor, and drawing them together is the clearest way to show they differ.
    const m = model();
    const controller = m.decls.find((d) => d.id.name === "DoorController");
    expect(controller?.kind).toBe("service");
    if (controller?.kind !== "service") return;
    const sensed = controller.emits.find((e) => e.message.text.endsWith("DoorSensed"))!;
    expect(sensed.publication).toBe("best-effort");

    // And nothing waits for it, which is why `lossy-publish` says nothing.
    const g = buildGraph(m);
    const edge = g.edges.find((e) => e.bestEffort === true);
    expect(edge?.to).toBe("pipe:parcel.lockers.telemetry");
  });

  it("a lossy pipe that nothing depends on for progress", () => {
    const m = model();
    const telemetry = named(m, "telemetry");
    expect(telemetry.kind).toBe("pipe");
    if (telemetry.kind !== "pipe") return;
    expect(telemetry.delivery).toBe("at-most-once");
    // `dlq none`: lossy, non-durable, nothing to dead-letter into.
    expect(telemetry.dlq).toBeNull();
  });

  it("a saga with a deadline, and a schedule with a timezone", () => {
    const m = model();
    const saga = named(m, "Handover");
    expect(saga.kind).toBe("saga");
    if (saga.kind !== "saga") return;
    expect(saga.steps.length).toBeGreaterThan(0);
    // A week, which is deliberately longer than the step timeout: a parcel stuck for a week is a
    // different problem from one nobody collected.
    expect(saga.deadlineMs).toBe(168 * 3600 * 1000);

    const schedule = named(m, "NightlySweep");
    expect(schedule.kind).toBe("schedule");
  });

  it("a cross-field invariant, which a JSON Schema projection could not express", () => {
    const m = model();
    const reserved = named(m, "CompartmentReserved");
    // Narrowed by kind rather than cast: a `Decl` is a union, and asserting a shape onto it is how a
    // test comes to believe something the type never said.
    expect(reserved.kind).toBe("message");
    if (reserved.kind !== "message") return;
    expect(reserved.invariants).toHaveLength(1);
  });
});

describe("the graph it draws", () => {
  it("is bipartite, with every edge landing on a drawn node", () => {
    const g = buildGraph(model(), { deadLetters: true });
    const drawn = new Set(g.nodes.map((n) => n.id));
    for (const edge of g.edges) {
      expect(drawn.has(edge.from), edge.id).toBe(true);
      expect(drawn.has(edge.to), edge.id).toBe(true);
    }
    expect(g.unresolved).toEqual([]);
  });
});

describe("its lenses", () => {
  const views = () => {
    const { views, problems } = parseViews(
      readFileSync(join(EXAMPLES, ".7k", "views.json"), "utf-8"),
    );
    expect(problems).toEqual([]);
    return views;
  };

  it("are the five the example advertises", () => {
    expect(Object.keys(views()).sort()).toEqual([
      "Estate",
      "Handover",
      "Lossy",
      "Perimeter",
      "PiiFlow",
    ]);
  });

  it("each select something, and never leave a dangling edge", () => {
    // A lens that selects nothing is a lens nobody will use twice.
    const whole = buildGraph(model());
    for (const [name, lens] of Object.entries(views())) {
      const g = resolveLens(whole, lens);
      expect(g.nodes.filter((n) => n.kind !== "package" && n.kind !== "port").length, name)
        .toBeGreaterThan(0);

      const drawn = new Set(g.nodes.map((n) => n.id));
      for (const edge of g.edges) {
        expect(drawn.has(edge.from), `${name}: ${edge.id}`).toBe(true);
        expect(drawn.has(edge.to), `${name}: ${edge.id}`).toBe(true);
      }
    }
  });

  it("PiiFlow selects only PII-bearing pipes", () => {
    const g = resolveLens(buildGraph(model()), views()["PiiFlow"]!);
    const pipes = g.nodes.filter((n) => n.kind === "pipe");
    expect(pipes.length).toBeGreaterThan(0);
    for (const pipe of pipes) expect(pipe.labels, pipe.id).toContain("pii");
  });

  it("Perimeter selects the outside world and aggregates the rest away", () => {
    const g = resolveLens(buildGraph(model()), views()["Perimeter"]!);
    expect(g.nodes.filter((n) => n.kind === "external").length).toBe(4);
    expect(g.nodes.filter((n) => n.kind === "service")).toEqual([]);
    expect(g.nodes.filter((n) => n.kind === "port").length).toBeGreaterThan(0);
  });
});

describe("the trace that ships with it", () => {
  const trace = () => {
    const { events, problems } = readTrace(
      readFileSync(join(EXAMPLES, "handover.ndjson"), "utf-8"),
    );
    expect(problems).toEqual([]);
    return events;
  };

  it("is valid by every rule section 7 states", () => {
    expect(validateTrace(trace()).map((p) => p.message)).toEqual([]);
  });

  it("holds one run per scenario", () => {
    expect(runsOf(trace()).map((r) => r.run.replace(/#.*/, "")).sort()).toEqual([
      "DropWithoutScope",
      "HandoverSucceeds",
      "LockerFull",
      "LockerNeverAnswers",
      "NobodyCollects",
      "SweepRunsEachNight",
    ]);
  });

  it("has a run with a multi-day gap, which is what the timeline is for", () => {
    const spans = runsOf(trace()).map(
      (r) => r.events[r.events.length - 1]!.at - r.events[0]!.at,
    );
    expect(Math.max(...spans)).toBeGreaterThan(48 * 3600 * 1000);
  });

  it("animates along an edge for most of its events", () => {
    // The ones that do not are the clock moving and the saga's own steps, which travelled nowhere.
    const g = buildGraph(model());
    const events = trace();
    const withEdge = events.filter((e) => edgeForEvent(g, e) !== undefined);
    expect(withEdge.length / events.length).toBeGreaterThan(0.5);
  });
});
