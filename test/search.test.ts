/**
 * Search.
 *
 * Two claims carry the weight. That it searches the **model** and not the graph, because a message is an
 * edge label and `OrderPlaced` is exactly the sort of name people remember. And that the ranking is
 * **total and deterministic**, because a palette whose order shifts under the cursor is one you have to
 * read rather than aim at.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace, type LinkedModel } from "@sevenk/core";
import { buildGraph } from "../src/graph.js";
import { buildIndex, parseQuery, search, type Entry } from "../src/search.js";

const MODEL = `
package acme.shop

label pii

value Email : string { length 3..254 }

record Buyer {
  email: Email @pii
}

message PlaceOrder v1.0 @command {
  id:    uuid @role(businessKey)
  buyer: Buyer
}
message OrderPlaced v1.0 @event { id: uuid @role(businessKey) }
message OrderShipped v1.0 @event { id: uuid @role(businessKey) }

pipe inbound  : queue { retention 7d }
pipe outbound : topic { retention 7d }

service OrderService {
  reacts PlaceOrder from inbound {
    replies OrderPlaced
  }
  emits OrderPlaced to outbound
}

service OrderReporting {
  reacts OrderPlaced from outbound {
    replies none
  }
}
`;

const OTHER = `
package acme.other

import acme.shop

pipe onward : topic { retention 7d }

service Relay {
  reacts shop.OrderPlaced from shop.outbound {
    replies none
  }
  emits shop.OrderShipped to onward
}
`;

const model = (): LinkedModel => {
  const ws = buildWorkspace([
    { path: "shop.7k", source: MODEL },
    { path: "other.7k", source: OTHER },
  ]);
  expect(
    ws.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}: ${d.message}`),
  ).toEqual([]);
  return ws.model;
};

const index = (): Entry[] => buildIndex(model());
const found = (q: string, limit = 20): string[] =>
  search(index(), q, { limit }).map((h) => `${h.kind}:${h.name}`);

describe("it indexes the model, not the graph", () => {
  it("finds a message, which the graph draws as an edge label", () => {
    // The whole reason this searches the model: `OrderPlaced` is a name people remember, and there is
    // no node with it.
    expect(found("OrderPlaced")[0]).toBe("message:OrderPlaced");
  });

  it("finds a record and a value, which the graph has no place for at all", () => {
    expect(found("Buyer")).toContain("record:Buyer");
    expect(found("Email")).toContain("value:Email");
  });

  it("finds a declared package and not an implied one", () => {
    const names = found("acme");
    expect(names).toContain("package:shop");
    expect(names).toContain("package:other");
    // `acme` is implied by its children; nobody wrote it, so nobody can search for it.
    expect(names).not.toContain("package:acme");
  });

  it("is deterministic, down to the order of the index", () => {
    expect(buildIndex(model())).toEqual(buildIndex(model()));
    expect(found("order")).toEqual(found("order"));
  });
});

describe("ranking", () => {
  it("puts an exact name first", () => {
    expect(found("orderservice")[0]).toBe("service:OrderService");
  });

  it("prefers a prefix to a substring", () => {
    const names = found("order");
    // `OrderService`, `OrderPlaced`, `OrderShipped`, `OrderReporting` start with it; `PlaceOrder` only
    // contains it.
    expect(names.indexOf("message:PlaceOrder")).toBeGreaterThan(names.indexOf("service:OrderService"));
  });

  it("prefers what the graph draws at equal match quality", () => {
    // A reader searching in a graph tool is usually trying to get somewhere on the graph.
    const names = found("o");
    expect(names.indexOf("service:OrderService")).toBeLessThan(names.indexOf("record:Buyer"));
  });

  it("matches a loose subsequence, but not on a single character", () => {
    // `ordsvc` should find `OrderService`; `o` as a subsequence would match nearly everything and bury
    // the real answers at the moment you have typed the least.
    expect(found("ordsrv")).toContain("service:OrderService");

    // For one character, every hit contains it literally — in the name or in the package path. Nothing
    // is reached by subsequence alone, which is the tier that would otherwise match almost everything.
    for (const hit of search(index(), "o")) {
      expect(hit.qname.toLowerCase(), hit.qname).toContain("o");
    }
    // `Buyer` has no `o` in its own name, so it is here only through `acme.shop` — and it ranks below
    // everything whose name matches.
    const single = search(index(), "o").map((h) => h.name);
    expect(single.indexOf("Buyer")).toBeGreaterThan(single.indexOf("OrderService"));
  });

  it("starts a subsequence at a word, so a stray run of letters is not a match", () => {
    // `pii` matched `ShippingService` before this rule: p from Shi(pp)ing, then i, then i. A true
    // subsequence, and a useless result — the whole tail of the list was noise like that.
    const hits = search(index(), "obr").map((h) => h.name);
    expect(hits).not.toContain("OrderService");

    // And the matches the tier exists for still work, from either word.
    expect(found("ordsrv")).toContain("service:OrderService");
    expect(found("osrv")).toContain("service:OrderService");
  });

  it("matches in the package path, below matching the name", () => {
    const names = found("shop");
    expect(names).toContain("package:shop");
    // `acme.shop.OrderService` contains "shop" only in its path.
    expect(names.indexOf("package:shop")).toBeLessThan(names.indexOf("service:OrderService"));
  });

  it("breaks a tie the same way every time", () => {
    // Shorter name first, then alphabetical: both totals, so no two results can swap places.
    const hits = search(index(), "order");
    for (let i = 1; i < hits.length; i++) {
      const a = hits[i - 1]!;
      const b = hits[i]!;
      if (a.score !== b.score) continue;
      if (a.drawn !== b.drawn) continue;
      if (a.name.length !== b.name.length) {
        expect(a.name.length).toBeLessThan(b.name.length);
      } else {
        expect(a.qname <= b.qname).toBe(true);
      }
    }
  });

  it("honours a limit", () => {
    expect(found("order", 2)).toHaveLength(2);
  });
});

describe("a query may name a kind", () => {
  it("splits a kind from the text", () => {
    expect(parseQuery("pipe commands")).toEqual({ text: "commands", kind: "pipe" });
    expect(parseQuery("service:order")).toEqual({ text: "order", kind: "service" });
    // Plural, because that is what people type.
    expect(parseQuery("pipes inbound")).toEqual({ text: "inbound", kind: "pipe" });
  });

  it("leaves an ordinary query alone", () => {
    expect(parseQuery("OrderPlaced")).toEqual({ text: "OrderPlaced" });
    // `relay` is not a kind, so this is a two-word search rather than a filtered one.
    expect(parseQuery("relay thing").kind).toBeUndefined();
  });

  it("filters rather than ranks", () => {
    const names = found("pipe order");
    expect(names).toEqual([]);
    expect(found("message order").every((n) => n.startsWith("message:"))).toBe(true);
  });

  it("lists a whole kind when the text is empty", () => {
    // `pipes` on its own is a real question: "what pipes are there".
    const names = found("pipes");
    expect(names.sort()).toEqual(["pipe:inbound", "pipe:onward", "pipe:outbound"]);
  });

  it("returns nothing for an empty query, rather than everything", () => {
    // A palette that opens full of arbitrary results teaches you to ignore it.
    expect(found("")).toEqual([]);
    expect(found("   ")).toEqual([]);
  });
});

describe("what is drawn", () => {
  it("marks a result the graph does not show", () => {
    const m = model();
    const graph = buildGraph(m);
    const drawn = new Set(graph.nodes.map((n) => n.id));
    for (const edge of graph.edges) for (const id of edge.messageIds) drawn.add(id);

    const hits = search(buildIndex(m), "Buyer", { drawn });
    expect(hits[0]!.name).toBe("Buyer");
    // A record is never a node and never an edge label, so it is findable and not reachable.
    expect(hits[0]!.drawn).toBe(false);

    const message = search(buildIndex(m), "OrderPlaced", { drawn })[0]!;
    expect(message.drawn).toBe(true);
  });

  it("prefers a drawn result to a hidden one at equal score", () => {
    const m = model();
    const hits = search(buildIndex(m), "order", { drawn: new Set(["message:acme.shop.OrderPlaced"]) });
    const drawnAt = hits.findIndex((h) => h.drawn);
    const hiddenAt = hits.findIndex((h) => !h.drawn);
    if (drawnAt >= 0 && hiddenAt >= 0) {
      const sameScore = hits[drawnAt]!.score === hits[hiddenAt]!.score;
      if (sameScore) expect(drawnAt).toBeLessThan(hiddenAt);
    }
    expect(hits.some((h) => h.drawn)).toBe(true);
  });

  it("treats everything as drawn when nothing says otherwise", () => {
    expect(search(index(), "Buyer").every((h) => h.drawn)).toBe(true);
  });
});
