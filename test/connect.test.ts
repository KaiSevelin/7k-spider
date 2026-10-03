/**
 * Connecting by clicking, and why the bipartite rule makes the gesture simple.
 *
 * A connection is one of exactly two things, and which one follows from which end you started at. So
 * there is nothing to choose and nothing to get wrong — except connecting two things that cannot be
 * connected, which is worth a sentence rather than a shrug.
 */

import { describe, expect, it } from "vitest";
import { buildWorkspace } from "@sevenk/core";
import { buildGraph, type Graph } from "../src/graph.js";
import { candidates, pairFor, roleOf } from "../src/web/connect-ui.js";

const MODEL = `
package acme.shop

message PlaceOrder v1.0 @command { id: uuid @role(businessKey) }
message OrderPlaced v1.0 @event  { id: uuid @role(businessKey) }
message Audit v1.0 @event        { id: uuid @role(businessKey) }

pipe inbound : queue { retention 7d }
pipe events  : topic { retention 7d }

service WebApp @external {
  emits PlaceOrder to inbound
}

service OrderService {
  reacts PlaceOrder from inbound {
    replies OrderPlaced
  }
  emits OrderPlaced to events
}

service Reporting {
  emits Audit to events
}
`;

const graph = (opts = {}): Graph => {
  const ws = buildWorkspace([{ path: "shop.7k", source: MODEL }]);
  expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return buildGraph(ws.model, opts);
};

const node = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)!;

describe("which nodes can take part", () => {
  it("a service and a pipe can", () => {
    const g = graph();
    expect(roleOf(node(g, "service:acme.shop.OrderService"))).toBe("service");
    expect(roleOf(node(g, "pipe:acme.shop.events"))).toBe("pipe");
  });

  it("an external service can, because it is still an end of a message", () => {
    expect(roleOf(node(graph(), "service:acme.shop.WebApp"))).toBe("service");
  });

  it("a package cannot", () => {
    expect(roleOf(node(graph(), "package:acme.shop"))).toBeUndefined();
  });

  it("a dead letter cannot, because the runtime writes it rather than a service", () => {
    const g = graph({ deadLetters: true });
    expect(roleOf(node(g, "pipe:acme.shop.inbound.dead"))).toBeUndefined();
  });
});

describe("the direction follows from which end you clicked first", () => {
  it("service then pipe is an emits", () => {
    const answer = pairFor(graph(), "service:acme.shop.Reporting", "pipe:acme.shop.inbound");
    expect(answer).toEqual({
      pair: {
        service: "service:acme.shop.Reporting",
        pipe: "pipe:acme.shop.inbound",
        direction: "emits",
      },
    });
  });

  it("pipe then service is a reacts", () => {
    const answer = pairFor(graph(), "pipe:acme.shop.events", "service:acme.shop.WebApp");
    expect(answer).toEqual({
      pair: {
        service: "service:acme.shop.WebApp",
        pipe: "pipe:acme.shop.events",
        direction: "reacts",
      },
    });
  });
});

describe("what cannot be connected, and why", () => {
  it("says why two services cannot be", () => {
    // The thing a reader is most likely to try, so it is worth a sentence rather than a shrug.
    const answer = pairFor(graph(), "service:acme.shop.OrderService", "service:acme.shop.Reporting");
    expect("problem" in answer && answer.problem).toContain("goes through a pipe");
  });

  it("says why two pipes cannot be", () => {
    const answer = pairFor(graph(), "pipe:acme.shop.inbound", "pipe:acme.shop.events");
    expect("problem" in answer && answer.problem).toContain("something has to read one");
  });

  it("refuses a thing to itself", () => {
    const id = "service:acme.shop.OrderService";
    expect("problem" in pairFor(graph(), id, id)).toBe(true);
  });

  it("names the kind that cannot take part", () => {
    const answer = pairFor(graph(), "package:acme.shop", "pipe:acme.shop.events");
    expect("problem" in answer && answer.problem).toContain("package");
  });

  it("refuses something not on the graph at all", () => {
    expect("problem" in pairFor(graph(), "service:acme.shop.Gone", "pipe:acme.shop.events")).toBe(true);
  });
});

describe("which messages to offer", () => {
  it("puts the ones already on the pipe first", () => {
    // Joining existing traffic is the common case, and naming a message nothing else carries is how a
    // pipe ends up carrying one of everything.
    const g = graph();
    const pair = { service: "service:acme.shop.WebApp", pipe: "pipe:acme.shop.events", direction: "emits" } as const;
    const offered = candidates(g, pair);

    const first = offered.findIndex((c) => !c.onPipe);
    const lastOnPipe = offered.map((c) => c.onPipe).lastIndexOf(true);
    expect(lastOnPipe).toBeLessThan(first === -1 ? offered.length : first);

    expect(offered.filter((c) => c.onPipe).map((c) => c.label).sort()).toEqual([
      "acme.shop.Audit",
      "acme.shop.OrderPlaced",
    ]);
  });

  it("offers every message the graph knows about, not only the pipe's", () => {
    // A new connection may carry something this pipe has never carried.
    const offered = candidates(graph(), {
      service: "service:acme.shop.Reporting",
      pipe: "pipe:acme.shop.inbound",
      direction: "emits",
    });
    expect(offered.map((c) => c.label)).toContain("acme.shop.OrderPlaced");
  });

  it("offers each message once", () => {
    const offered = candidates(graph(), {
      service: "service:acme.shop.Reporting",
      pipe: "pipe:acme.shop.events",
      direction: "emits",
    });
    expect(new Set(offered.map((c) => c.id)).size).toBe(offered.length);
  });

  it("is in the same order every time", () => {
    const pair = {
      service: "service:acme.shop.Reporting",
      pipe: "pipe:acme.shop.events",
      direction: "emits",
    } as const;
    expect(candidates(graph(), pair)).toEqual(candidates(graph(), pair));
  });
});
