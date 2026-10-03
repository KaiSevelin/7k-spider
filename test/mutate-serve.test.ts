/**
 * Writing an edited model.
 *
 * The page computes the mutation with Core; the server owns the filesystem. Which leaves the server one
 * decision, and it is the one worth testing: **is this still the file the edit was computed against?**
 *
 * `20-ir.md` 7.1 settles the rest — Spider holds no unsaved buffer and a watcher reloads on external
 * change — so the only conflict left is a file edited between the page reading it and the page writing
 * it. The honest answer is to refuse, and refuse *all* of it.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyAll,
  buildWorkspace,
  connectEmit,
  isPossible,
  type Editable,
} from "@sevenk/core";
import { serve, type Serving } from "../src/serve.js";

const SALES = `package acme.sales

import acme.tickets

message OrderPlaced v1.0 @event {
  orderId: uuid @role(businessKey)
}

pipe events : topic {
  retention 7d
}

service OrderService {
  emits OrderPlaced to events
}
`;

const TICKETS = `package acme.tickets

message ReserveSeats v1.0 @command {
  orderId: uuid @role(businessKey)
}

pipe commands : queue {
  retention 7d
}

service TicketService {
  reacts ReserveSeats from commands {
    replies none
  }
}
`;

let dir: string;
let serving: Serving;
let salesPath: string;
let ticketsPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "spider-mutate-"));
  salesPath = join(dir, "sales.7k");
  ticketsPath = join(dir, "tickets.7k");
  await writeFile(salesPath, SALES, "utf-8");
  await writeFile(ticketsPath, TICKETS, "utf-8");
  serving = await serve({ paths: [dir], port: 0, watch: false });
});

afterAll(async () => {
  await serving.close();
});

const at = (path: string): string => `${serving.url.slice(0, -1)}${path}`;

const reset = async (): Promise<void> => {
  await writeFile(salesPath, SALES, "utf-8");
  await writeFile(ticketsPath, TICKETS, "utf-8");
};

/** What the page does: read the sources, compute a mutation, apply it locally, send before and after. */
async function proposeConnect(): Promise<Record<string, { before: string; after: string }>> {
  const files = {
    [salesPath]: await readFile(salesPath, "utf-8"),
    [ticketsPath]: await readFile(ticketsPath, "utf-8"),
  };
  const ws = buildWorkspace(Object.entries(files).map(([path, source]) => ({ path, source })));
  const editable: Editable = { model: ws.model, trees: ws.trees, sources: files };

  const mutation = connectEmit(editable, {
    service: "OrderService",
    message: "acme.tickets.ReserveSeats",
    pipe: "acme.tickets.commands",
  });
  expect(isPossible(mutation)).toBe(true);

  const after = applyAll(files, mutation.edits);
  const out: Record<string, { before: string; after: string }> = {};
  for (const file of new Set(mutation.edits.map((e) => e.file))) {
    out[file] = { before: files[file]!, after: after[file]! };
  }
  return out;
}

const put = async (files: unknown): Promise<Response> =>
  fetch(at("/mutate"), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files }),
  });

describe("writing an edit", () => {
  it("writes it, and the model then says so", async () => {
    await reset();
    const response = await put(await proposeConnect());
    expect(response.status).toBe(200);
    expect(((await response.json()) as { wrote: string[] }).wrote).toHaveLength(1);

    const written = await readFile(salesPath, "utf-8");
    expect(written).toContain("emits tickets.ReserveSeats to tickets.commands");

    // The point of the whole exercise: the edited file is a model, and it checks out.
    const ws = buildWorkspace([
      { path: salesPath, source: written },
      { path: ticketsPath, source: await readFile(ticketsPath, "utf-8") },
    ]);
    expect(ws.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("leaves every byte outside the edit alone", async () => {
    await reset();
    await put(await proposeConnect());
    const written = await readFile(salesPath, "utf-8");
    // The original, with exactly one line inserted.
    expect(written.replace("  emits tickets.ReserveSeats to tickets.commands\n", "")).toBe(SALES);
  });

  it("does not touch a file the edit did not name", async () => {
    await reset();
    await put(await proposeConnect());
    expect(await readFile(ticketsPath, "utf-8")).toBe(TICKETS);
  });
});

describe("refusing", () => {
  it("refuses when the file changed since it was read", async () => {
    await reset();
    const proposal = await proposeConnect();

    // Somebody edits the file in their editor between the page reading it and the page writing it.
    await writeFile(salesPath, `${SALES}\n// touched by somebody else\n`, "utf-8");

    const response = await put(proposal);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { problem: string }).problem).toContain("changed since it was read");

    // And the other edit was not applied either.
    expect(await readFile(salesPath, "utf-8")).toContain("touched by somebody else");
    expect(await readFile(salesPath, "utf-8")).not.toContain("tickets.ReserveSeats");
  });

  it("refuses all of it when one file changed, because half a mutation is worse than none", async () => {
    await reset();
    const before = { sales: await readFile(salesPath, "utf-8"), tickets: await readFile(ticketsPath, "utf-8") };

    // A two-file write, of which the second file is stale.
    const response = await put({
      [salesPath]: { before: before.sales, after: `${before.sales}\n// one\n` },
      [ticketsPath]: { before: `${before.tickets}// not what is on disk\n`, after: "whatever" },
    });
    expect(response.status).toBe(409);

    expect(await readFile(salesPath, "utf-8")).toBe(before.sales);
    expect(await readFile(ticketsPath, "utf-8")).toBe(before.tickets);
  });

  it("refuses a file outside the workspace", async () => {
    // A write path that would touch anything else is a write path somebody eventually points somewhere
    // unfortunate.
    const elsewhere = join(dir, "..", "escaped.7k");
    const response = await put({ [elsewhere]: { before: "", after: "gone" } });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { problem: string }).problem).toContain("not part of this workspace");
  });

  it("refuses a body that is not a write", async () => {
    expect(
      (await fetch(at("/mutate"), { method: "PUT", body: "{" })).status,
    ).toBe(409);
    expect((await put({})).status).toBe(409);
  });

  it("refuses a half-specified file", async () => {
    await reset();
    const response = await put({ [salesPath]: { after: "only the result" } });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { problem: string }).problem).toContain("prior and the new text");
  });
});

describe("round-tripping through the server", () => {
  it("connects, then disconnects, back to byte-identical text", async () => {
    await reset();
    await put(await proposeConnect());
    const connected = await readFile(salesPath, "utf-8");
    expect(connected).not.toBe(SALES);

    const files = { [salesPath]: connected, [ticketsPath]: TICKETS };
    const ws = buildWorkspace(Object.entries(files).map(([path, source]) => ({ path, source })));
    const { disconnectEmit } = await import("@sevenk/core");
    const mutation = disconnectEmit(
      { model: ws.model, trees: ws.trees, sources: files },
      { service: "OrderService", message: "acme.tickets.ReserveSeats", pipe: "acme.tickets.commands" },
    );
    const after = applyAll(files, mutation.edits);

    const response = await put({
      [salesPath]: { before: connected, after: after[salesPath]! },
    });
    expect(response.status).toBe(200);
    expect(await readFile(salesPath, "utf-8")).toBe(SALES);
  });
});
