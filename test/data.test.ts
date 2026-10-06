/**
 * The Data layer, derived.
 *
 * The drawing is checked by looking at it. What is checked here is what the drawing is *of*: that the
 * four relations are distinguished, that a neighbourhood is a view of the same relation rather than a
 * different one, and that it reaches both ways — because "what breaks if I change this" is asked as
 * often as "what is in this".
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type LinkedModel } from "@sevenk/core";
import { buildData, isData, typeText } from "../src/data.js";

const SOURCE = `
package shop

label pii

@pii value EmailAddress : string { length 5..254 }
value Sku : string { length 1..24 }

enum Currency {
  Sek
  Eur
}

record Money {
  amount:   decimal(18,2)
  currency: Currency
}

record Customer {
  email: EmailAddress
}

record Line {
  sku:   Sku
  price: Money
}

envelope Trace {
  correlationId: uuid @role(correlation)
}

envelopes Trace

message PlaceOrder v1.1 @command {
  orderRef: uuid @role(businessKey)
  customer: Customer
  lines:    [Line]
  total:    Money
  note:     string? @since(1.1)
}

upcast PlaceOrder v1.0 to v1.1 {
  note = absent
}

pipe inbound : queue { carries PlaceOrder }

service Orders {
  reacts PlaceOrder from inbound { once per orderRef; replies none }
}
`;

const model = (): LinkedModel => buildWorkspace([{ path: "a.7k", source: SOURCE }]).model;

const ids = (g: ReturnType<typeof buildData>): string[] => g.nodes.map((n) => n.label).sort();
const edge = (g: ReturnType<typeof buildData>, from: string, to: string) =>
  g.edges.find((e) => e.from.endsWith(`.${from}`) && e.to.endsWith(`.${to}`));

describe("what belongs to the layer", () => {
  it("is the Data layer and nothing else", () => {
    // Pipes and services are the graph's picture; sagas and schedules are the saga view's.
    const built = buildData(model());
    expect(ids(built)).toContain("PlaceOrder");
    expect(ids(built)).toContain("Money");
    expect(ids(built)).not.toContain("inbound");
    expect(ids(built)).not.toContain("Orders");
  });

  it("agrees with `isData` about which kinds those are", () => {
    const kinds = new Set(model().decls.filter(isData).map((d) => d.kind));
    expect([...kinds].sort()).toEqual(["enum", "envelope", "message", "record", "value"]);
  });

  it("groups by package, as the graph does", () => {
    const built = buildData(model());
    const box = built.nodes.find((n) => n.kind === "package");
    expect(box?.label).toBe("shop");
    expect(built.nodes.find((n) => n.label === "Money")?.parent).toBe("package:shop");
  });
});

describe("the four relations", () => {
  const built = () => buildData(model());

  it("follows a field into what it holds, through a list", () => {
    // `lines: [Line]` is a reference inside a list, which a shallow walk would miss entirely.
    expect(edge(built(), "PlaceOrder", "Line")?.kind).toBe("field");
    expect(edge(built(), "PlaceOrder", "Line")?.label).toBe("lines");
    expect(edge(built(), "Line", "Money")?.kind).toBe("field");
  });

  it("reaches a value through the record holding it", () => {
    expect(edge(built(), "Customer", "EmailAddress")?.kind).toBe("field");
    expect(edge(built(), "Line", "Sku")?.kind).toBe("field");
  });

  it("draws the envelope every message in the package carries", () => {
    // D50: declared once and spliced into every message, which is a structural fact nothing else shows.
    expect(edge(built(), "PlaceOrder", "Trace")?.kind).toBe("envelope");
  });

  it("carries an upcast on the message it lifts into, rather than as an edge", () => {
    // 7K has one declaration per message carrying its current version, so there is no older node for
    // an edge to point at. The upcast is a fact about this declaration.
    const placed = built().nodes.find((n) => n.label === "PlaceOrder");
    expect(placed?.upcasts).toEqual(["1.0 → 1.1"]);
    expect(built().edges.some((e) => String(e.kind) === "upcast")).toBe(false);
  });
});

describe("what a node carries", () => {
  it("shows a message's intent and version without opening it", () => {
    const placed = buildData(model()).nodes.find((n) => n.label === "PlaceOrder");
    expect(placed?.intent).toBe("command");
    expect(placed?.version).toBe("1.1");
  });

  it("shows fields with their types as a reader would write them", () => {
    const line = buildData(model()).nodes.find((n) => n.label === "Line");
    expect(line?.fields.map((f) => `${f.name}: ${f.type}`)).toEqual(["sku: Sku", "price: Money"]);
    const placed = buildData(model()).nodes.find((n) => n.label === "PlaceOrder");
    expect(placed?.fields.find((f) => f.name === "lines")?.type).toBe("[Line]");
    expect(placed?.fields.find((f) => f.name === "note")?.optional).toBe(true);
  });

  it("shows an enum's members", () => {
    expect(buildData(model()).nodes.find((n) => n.label === "Currency")?.members).toEqual(["Sek", "Eur"]);
  });

  it("carries propagated labels, so `@pii` shows on everything holding it", () => {
    // Declared on one value. If it did not reach `Customer` and `PlaceOrder`, the one thing this view
    // makes visible that no other does would be missing.
    const built = buildData(model());
    const pii = built.nodes.filter((n) => n.labels.includes("pii")).map((n) => n.label).sort();
    expect(pii).toEqual(["Customer", "EmailAddress", "PlaceOrder"]);
  });
});

describe("a neighbourhood", () => {
  const around = (label: string, depth: number) => {
    const decl = model().decls.find((d) => d.id.name === label)!;
    return buildData(model(), { around: `${decl.kind}:shop.${label}`, depth });
  };

  it("is one hop of what a declaration holds", () => {
    const built = around("PlaceOrder", 1);
    expect(ids(built)).toContain("Customer");
    expect(ids(built)).toContain("Line");
    // Two hops away, so not yet.
    expect(ids(built)).not.toContain("Sku");
  });

  it("widens by hop", () => {
    expect(ids(around("PlaceOrder", 2))).toContain("Sku");
  });

  it("reaches both ways, because what holds this matters as much as what this holds", () => {
    // `Money` holds `Currency` and is held by `Line` and `PlaceOrder`. A one-way walk would answer
    // "what is in this" and never "what breaks if I change it".
    const built = around("Money", 1);
    expect(ids(built)).toContain("Currency");
    expect(ids(built)).toContain("Line");
    expect(ids(built)).toContain("PlaceOrder");
  });

  it("says how much it is not showing", () => {
    const built = around("Money", 1);
    expect(built.hidden).toBeGreaterThan(0);
    expect(buildData(model()).hidden).toBe(0);
  });

  it("drops the package boxes, which would outnumber what is in them", () => {
    expect(around("Money", 1).nodes.some((n) => n.kind === "package")).toBe(false);
  });

  it("is empty for something that is not in the layer", () => {
    expect(buildData(model(), { around: "pipe:shop.inbound", depth: 2 }).nodes).toEqual([]);
  });
});

describe("type text", () => {
  it("writes a type as the model wrote it", () => {
    const placed = buildData(model()).nodes.find((n) => n.label === "PlaceOrder");
    expect(placed?.fields.map((f) => f.type)).toContain("uuid");
    const money = buildData(model()).nodes.find((n) => n.label === "Money");
    // Precision and scale are part of the type, and a reader checking a contract needs to see them.
    expect(money?.fields[0]?.type).toBe("decimal(18,2)");
  });

  it("writes a map as one", () => {
    expect(
      typeText({
        t: "map",
        key: { t: "kernel", name: "string" },
        value: { t: "kernel", name: "int" },
      }),
    ).toBe("map<string, int>");
  });
});

describe("hubs, which are what make a type graph unreadable", () => {
  const around = (label: string, depth: number) => {
    const decl = model().decls.find((d) => d.id.name === label)!;
    return buildData(model(), { around: `${decl.kind}:shop.${label}`, depth });
  };

  it("shows an envelope but never walks through one", () => {
    // D50 puts an envelope on every message in its package, so walking through it would make every
    // message two hops from every other and the neighbourhood would be the whole model.
    const built = around("PlaceOrder", 2);
    expect(built.nodes.map((n) => n.label)).toContain("Trace");
    expect(built.edges.some((e) => e.kind === "envelope")).toBe(true);
  });

  it("does not reach everything that shares a value with the selection", () => {
    // One hop down to `Sku` and one back up would drag in every record holding a `Sku`. Downward
    // answers "what is in this"; upward answers "what holds this"; their composition answers nothing.
    const built = around("Customer", 2);
    expect(built.nodes.map((n) => n.label)).toContain("EmailAddress");
    expect(built.nodes.map((n) => n.label)).toContain("PlaceOrder");
    // `Line` holds `Sku`, not `EmailAddress`, and is nobody's business from here.
    expect(built.nodes.map((n) => n.label)).not.toContain("Line");
  });

  it("narrows, and says by how much", () => {
    // This fixture is small enough that two hops covers it; one hop is where narrowing shows.
    const built = around("PlaceOrder", 1);
    const all = buildData(model());
    expect(built.nodes.length).toBeLessThan(all.nodes.length);
    expect(built.hidden).toBeGreaterThan(0);
  });
});
