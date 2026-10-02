/**
 * The composer.
 *
 * The claim that makes it worth building: the form is **derived**, so a value facet nobody anticipated
 * gets a working input with its own validation, having told the composer nothing (D24). And the claim
 * that makes it trustworthy: validation is Core's, so the composer is exactly as strict as `7k check`.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type Decl, type LinkedModel } from "@sevenk/core";
import { blank, check, composable, formOf, labelOf, parseForms } from "../src/compose.js";

const MODEL = `
package acme

// A facet the composer has never heard of: it should still get a text box that checks the pattern.
value PostCode : string { pattern /^[0-9]{3} [0-9]{2}$/; example "114 51" }
value Line     : string { length 1..40; normalize trim, collapseSpace }
value Blurb    : string { length 0..2000 }

enum Channel { Web, Kiosk, Phone }

record Money {
  amount:   decimal(12,2) { range 0.. }
  currency: string { length 3..3 }
}

record Address {
  street:   Line
  postCode: PostCode
}

message Order v1.0 @command {
  orderId:  uuid @role(businessKey)
  channel:  Channel
  shipTo:   Address
  total:    Money
  lines:    [Money] { size 1..20 }
  tags:     map<string, string>
  blurb:    Blurb?
  express:  bool

  invariant total.currency == lines[].currency
}
`;

const model = (): LinkedModel => {
  const ws = buildWorkspace([{ path: "m.7k", source: MODEL }]);
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  return ws.model;
};

const declOf = (m: LinkedModel, name: string): Decl =>
  m.decls.find((d) => d.id.name === name) ?? expect.fail(`no ${name}`);

// One workspace per form. A `Decl` from a different `buildWorkspace` resolves against nothing, because a
// reference is keyed by object identity — which is a sharp edge worth knowing rather than working around.
const form = (name = "Order") => {
  const m = model();
  return formOf(m, declOf(m, name));
};
const field = (name: string) => form().fields.find((f) => f.name === name)!;

/** A model and one of its declarations, together, since the two only mean anything as a pair. */
const pair = (name: string): [LinkedModel, Decl] => {
  const m = model();
  return [m, declOf(m, name)];
};

describe("the form is derived from types and constraints", () => {
  it("gives a widget to every field without being told", () => {
    expect(field("orderId").widget).toBe("uuid");
    expect(field("channel").widget).toBe("select");
    expect(field("shipTo").widget).toBe("group");
    expect(field("total").widget).toBe("group");
    expect(field("lines").widget).toBe("list");
    expect(field("tags").widget).toBe("dictionary");
    expect(field("express").widget).toBe("checkbox");
  });

  it("works for a facet it has never heard of", () => {
    // The whole of D24: declare a value with a pattern and an example, and the composer offers an input
    // that checks it, having been told nothing about post codes.
    const post = form("Address").fields.find((f) => f.name === "postCode")!;
    expect(post.widget).toBe("text");
    expect(post.hint).toContain("a pattern");
    expect(post.placeholder).toBe("114 51");
  });

  it("offers an enum's members in declared order", () => {
    expect(field("channel").options).toEqual(["Web", "Kiosk", "Phone"]);
  });

  it("gives a long string a textarea, which is the only place a constraint changes the input's kind", () => {
    // A 2000-character field in a one-line box is a form nobody can fill in.
    expect(field("blurb").widget).toBe("textarea");
    expect(form("Address").fields.find((f) => f.name === "street")!.widget).toBe("text");
  });

  it("knows which field identifies the work", () => {
    expect(field("orderId").key).toBe(true);
    expect(field("channel").key).toBeUndefined();
  });

  it("marks an optional field optional", () => {
    expect(field("blurb").optional).toBe(true);
    expect(field("total").optional).toBe(false);
  });

  it("says what the bounds are, in a line a reader can act on", () => {
    expect(field("lines").hint).toContain("size 1..20");
    const street = form("Address").fields.find((f) => f.name === "street")!;
    expect(street.hint).toContain("length 1..40");
    expect(street.hint).toContain("normalized: trim, collapseSpace");
  });

  it("nests a record's own fields, and a list's item where the item is one", () => {
    expect(field("shipTo").fields?.map((f) => f.name)).toEqual(["street", "postCode"]);
    expect(field("lines").fields?.map((f) => f.name)).toEqual(["amount", "currency"]);
  });

  it("paths a nested field so a value can be put back where it came from", () => {
    expect(field("shipTo").fields?.map((f) => f.path)).toEqual(["shipTo.street", "shipTo.postCode"]);
  });

  it("labels a field without being given a label", () => {
    expect(labelOf("postCode")).toBe("Post code");
    expect(labelOf("orderId")).toBe("Order id");
    expect(labelOf("total")).toBe("Total");
    expect(field("shipTo").label).toBe("Ship to");
  });
});

describe("validation is Core's, so the composer is as strict as the checker", () => {
  const GOOD = {
    orderId: "0193f2c1-8a44-7c3e-9b21-6f0e2d5a1c77",
    channel: "Web",
    shipTo: { street: "Main Street 1", postCode: "114 51" },
    total: { amount: "19.99", currency: "SEK" },
    lines: [{ amount: "19.99", currency: "SEK" }],
    tags: {},
    express: false,
  };

  it("accepts a payload the model admits, and offers its canonical JSON", () => {
    const result = check(...pair("Order"), GOOD);
    expect(result.problems).toEqual([]);
    expect(result.canonical).toBeDefined();
    expect(JSON.parse(result.canonical!)).toMatchObject({ channel: "Web" });
  });

  it("reports a pattern a projection could express, by path", () => {
    const result = check(...pair("Order"), {
      ...GOOD,
      shipTo: { street: "Main Street 1", postCode: "nope" },
    });
    expect(result.problems.map((p) => p.path).join(" ")).toContain("postCode");
  });

  it("reports an invariant a projection could not express", () => {
    // Which is the whole reason this validates against Core and not against a generated JSON Schema: the
    // projection is lossy by design, so a composer built on one would accept this.
    const result = check(...pair("Order"), {
      ...GOOD,
      lines: [{ amount: "19.99", currency: "EUR" }],
    });
    expect(result.problems.map((p) => p.message).join(" ")).toContain("invariant");
    expect(result.canonical).toBeUndefined();
  });

  it("withholds canonical JSON while the payload is invalid", () => {
    // Canonical JSON of something that is not a legal payload would be a confident artifact about
    // something nobody agreed on.
    const result = check(...pair("Order"), { ...GOOD, channel: "Carrier" });
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.canonical).toBeUndefined();
  });

  it("normalizes before validating, because a declared normalization is part of the contract", () => {
    // `normalize trim` means a value with spaces around it *is* the trimmed value, so validating first
    // would reject a payload the contract accepts.
    const result = check(...pair("Order"), {
      ...GOOD,
      shipTo: { street: "   Main    Street 1   ", postCode: "114 51" },
    });
    expect(result.problems).toEqual([]);
    expect((result.normalized as { shipTo: { street: string } }).shipTo.street).toBe("Main Street 1");
  });
});

describe("an empty payload", () => {
  it("has every required field present and blank, and no optional one", () => {
    const empty = blank(form().fields);
    expect(Object.keys(empty).sort()).toEqual(
      ["channel", "express", "lines", "orderId", "shipTo", "tags", "total"].sort(),
    );
    expect(empty["blurb"]).toBeUndefined();
  });

  it("invents nothing", () => {
    // A composer that filled a form with plausible values is one you stop reading. Generation belongs to
    // a runtime with a seed.
    const empty = blank(form().fields);
    expect(empty["orderId"]).toBe("");
    expect(empty["lines"]).toEqual([]);
    expect(empty["express"]).toBe(false);
    expect(empty["shipTo"]).toEqual({ street: "", postCode: "" });
    // Except an enum, where the first member is the only honest blank: there is no empty enum value.
    expect(empty["channel"]).toBe("Web");
  });
});

describe("what can be composed", () => {
  it("offers messages first, since that is what travels", () => {
    const kinds = composable(model()).map((d) => d.id.kind);
    expect(kinds[0]).toBe("message");
    expect(new Set(kinds)).toEqual(new Set(["message", "record"]));
  });
});

describe("forms.json", () => {
  it("overrides a label, an order and a widget", () => {
    const { forms, problems } = parseForms(
      JSON.stringify({
        "record:acme.Address": {
          order: ["postCode", "street"],
          fields: { postCode: { label: "Zip" }, street: { widget: "textarea" } },
        },
      }),
    );
    expect(problems).toEqual([]);
    const f = (([m, d]) => formOf(m, d, forms))(pair("Address"));
    expect(f.fields.map((x) => x.name)).toEqual(["postCode", "street"]);
    expect(f.fields[0]!.label).toBe("Zip");
    expect(f.fields[1]!.widget).toBe("textarea");
  });

  it("applies a partial order, leaving the rest in declaration order", () => {
    // So adding a field does not require editing the sidecar to keep it from disappearing.
    const { forms } = parseForms(JSON.stringify({ "message:acme.Order": { order: ["total"] } }));
    const names = (([m, d]) => formOf(m, d, forms))(pair("Order")).fields.map((f) => f.name);
    expect(names[0]).toBe("total");
    expect(names.slice(1, 3)).toEqual(["orderId", "channel"]);
  });

  it("ignores a widget it does not recognise, rather than breaking the form", () => {
    // A widget name is advisory, which keeps the sidecar from becoming a UI API every tool must implement.
    const { forms } = parseForms(
      JSON.stringify({ "record:acme.Address": { fields: { street: { widget: "hologram" } } } }),
    );
    const f = (([m, d]) => formOf(m, d, forms))(pair("Address"));
    expect(f.fields.find((x) => x.name === "street")!.widget).toBe("text");
  });

  it("refuses a validation hint, which is the rule worth enforcing rather than documenting", () => {
    // `20-ir.md` 6.3: no validation hints, ever. Constraints belong to the model, and a second copy here
    // is a second source of truth that drifts.
    const { problems } = parseForms(
      JSON.stringify({ "record:acme.Address": { fields: {}, pattern: "^x$", required: ["street"] } }),
    );
    expect(problems.join(" ")).toContain("carries no validation");
    expect(problems.filter((p) => p.includes("carries no validation"))).toHaveLength(2);
  });

  it("survives a file that is not a form file at all", () => {
    expect(parseForms("{").forms).toEqual({});
    expect(parseForms("[]").problems[0]).toContain("not a JSON object");
    expect(parseForms(JSON.stringify({ "record:acme.Address": 7 })).problems[0]).toContain(
      "not a set of hints",
    );
  });

  it("treats an underscored key as a note", () => {
    const { forms } = parseForms(JSON.stringify({ _comment: "a note", "record:acme.Address": {} }));
    expect(Object.keys(forms)).toEqual(["record:acme.Address"]);
  });
});

describe("a half-written model is normal", () => {
  it("renders a field whose type did not resolve, rather than nothing", () => {
    const ws = buildWorkspace([
      {
        path: "half.7k",
        source: MODEL.replace("street:   Line", "street:   Nonexistent"),
      },
    ]);
    const f = formOf(ws.model, ws.model.decls.find((d) => d.id.name === "Address")!);
    const street = f.fields.find((x) => x.name === "street")!;
    expect(street.widget).toBe("unknown");
    // Still listed, still named: a form that vanished while you typed would be useless.
    expect(f.fields.map((x) => x.name)).toEqual(["street", "postCode"]);
  });
});
