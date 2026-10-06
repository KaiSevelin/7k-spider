/**
 * The replay's captions.
 *
 * The point of these tests is completeness and honesty: every kind a trace may carry must say
 * something, and nothing it says may be a stray `undefined` where a field was absent.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRACE_KINDS, readTrace, type TraceEvent, type TraceKind } from "@sevenk/core";
import { narrate } from "../src/narrate.js";

const base = (kind: TraceKind, rest: Partial<TraceEvent> = {}): TraceEvent =>
  ({ run: "R#1", seq: 0, at: 0, kind, ...rest }) as TraceEvent;

describe("narrating one event", () => {
  it("says something for every kind a trace may carry", () => {
    // `SAY` is a total record, so a new kind fails to compile rather than reaching here — this catches
    // the other half: a phrasing that is present but empty.
    for (const kind of TRACE_KINDS) {
      const { text } = narrate(base(kind));
      expect(text.trim(), kind).not.toBe("");
    }
  });

  it("never prints `undefined`, however little the event carries", () => {
    // Every field but `run`, `seq`, `at` and `kind` is optional, and a trace is a file somebody else
    // wrote. A caption reading "undefined handled undefined" would be worse than no caption.
    for (const kind of TRACE_KINDS) {
      const { text } = narrate(base(kind));
      expect(text, kind).not.toContain("undefined");
    }
  });

  it("names things by their bare name, because the package is already the box they sit in", () => {
    const { text } = narrate(
      base("handled", { service: "parcel.delivery.DeliveryService", message: "parcel.delivery.DropParcel" }),
    );
    expect(text).toBe("DeliveryService handled DropParcel");
  });

  it("keeps a dead letter's `.dead`, which is part of the name rather than a path", () => {
    const { text } = narrate(
      base("dead-lettered", { message: "p.M", pipe: "parcel.delivery.inbound.dead", reason: "exhausted" }),
    );
    expect(text).toBe("M went to inbound.dead — exhausted");
  });

  it("says who published when the trace knows, and does not invent one when it does not", () => {
    // A message a scenario published itself has no originating service (`30-scenarios.md` 7.6).
    expect(narrate(base("published", { message: "p.M", pipe: "p.in", service: "p.S" })).text).toBe(
      "S published M to in",
    );
    expect(narrate(base("published", { message: "p.M", pipe: "p.in" })).text).toBe("M published to in");
  });

  it("mentions an attempt only when there has been more than one", () => {
    const once = narrate(base("delivered", { message: "p.M", pipe: "p.in", service: "p.S", attempt: 1 }));
    const again = narrate(base("delivered", { message: "p.M", pipe: "p.in", service: "p.S", attempt: 3 }));
    expect(once.text).toBe("in delivered M to S");
    expect(again.text).toBe("in delivered M to S (attempt 3)");
  });

  it("marks a failure as one", () => {
    expect(narrate(base("handled")).bad).toBe(false);
    expect(narrate(base("dead-lettered")).bad).toBe(true);
    expect(narrate(base("saga-rejected")).bad).toBe(true);
  });
});

describe("narrating the example's own trace", () => {
  it("captions every event in it", () => {
    // The committed trace is the one anybody pressing play will actually see, so it is the one that
    // matters: every line of it has to produce a sentence with something in it.
    const path = join(import.meta.dirname, "..", "examples", "handover.ndjson");
    const { events } = readTrace(readFileSync(path, "utf-8"));
    expect(events.length).toBeGreaterThan(100);
    for (const event of events) {
      const { text } = narrate(event);
      expect(text, `${event.run}#${event.seq} ${event.kind}`).not.toContain("undefined");
      expect(text.trim(), `${event.run}#${event.seq} ${event.kind}`).not.toBe("");
    }
  });
});
