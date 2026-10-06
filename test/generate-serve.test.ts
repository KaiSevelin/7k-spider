/**
 * Generating from the page, and not writing from it.
 *
 * Spider plans and shows; `7k generate` writes. That is not a taste: a write route on a long-lived
 * local server is reachable by any page you have open, because binding to loopback keeps other
 * *machines* out and does nothing about other *pages on this machine*. CORS does not help either — it
 * governs reading the response, not causing the side effect, so the write lands whether or not the
 * attacker sees the answer, and a `content-type` of `text/plain` avoids the preflight that would
 * otherwise have stopped it.
 *
 * So three things are tested here. That generation still works from the page, because that is the
 * point of having providers in Spider at all. That nothing in the generate path writes, by scanning
 * the source as well as the routes — a route can be deleted and added back, and a test that only
 * checks for a 404 would pass against a differently-named one. And that the routes which legitimately
 * do write refuse a request that did not come from Spider's own page.
 */

import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type Serving } from "../src/serve.js";

const MODEL = `package shop

message PlaceOrder v1.0 @command {
  orderId: uuid @role(businessKey)
  note:    string { length 1..40; normalize trim }
}

pipe inbound : queue { delivery at-least-once }

service Desk {
  reacts PlaceOrder from inbound { replies none }
}
`;

/**
 * A provider written here rather than imported.
 *
 * The point is the route and the page, not any real target — and a fixture provider that declares a
 * loss is the only way to check that a loss reaches the page, which until now nothing could, because
 * `plan` dropped them.
 */
const PROVIDER = `export const spy = {
  name: "spy",
  target: "a test",
  layouts: ["single"],
  // Required of a provider now: the kinds it emits for, so a host can tell what it would do with a
  // selection without asking it to do it. This one only ever makes a file from a message.
  emits: ["message"],
  options: [],
  generate(request) {
    return {
      artifacts: [
        {
          path: "out.txt",
          content: "one\\ntwo\\nthree\\nfour\\nfive\\n",
          from: request.selected.filter((d) => d.kind === "message").map((d) => "shop." + d.id.name),
          losses: [
            {
              construct: "normalize",
              at: "PlaceOrder.note",
              fidelity: "none",
              detail: "a transform is not a predicate, so an unnormalised value is accepted here",
            },
          ],
        },
      ],
      refusals: [],
    };
  },
};
export default spy;
`;

const MANIFEST = JSON.stringify(
  {
    out: "generated",
    providers: ["./spy.mjs"],
    emit: [{ provider: "spy", out: "spy", layout: "single" }],
  },
  null,
  2,
);

let dir: string;
let serving: Serving;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "spider-generate-"));
  await writeFile(join(dir, "shop.7k"), MODEL, "utf-8");
  await writeFile(join(dir, "spy.mjs"), PROVIDER, "utf-8");
  await mkdir(join(dir, ".7k"), { recursive: true });
  await writeFile(join(dir, ".7k", "build.json"), MANIFEST, "utf-8");
  serving = await serve({ paths: [dir], port: 0, watch: false });
});

afterAll(async () => {
  await serving.close();
});

const at = (path: string): string => `${serving.url.slice(0, -1)}${path}`;

const plan = async (): Promise<{
  ok: boolean;
  files: { path: string; content: string; losses: { construct: string; detail: string }[]; from: string[]; freshness: string }[];
  drift: Record<string, number>;
  refusals: unknown[];
  problems: string[];
}> => {
  const res = await fetch(at("/generate"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ only: [] }),
  });
  expect(res.status).toBe(200);
  return res.json() as never;
};

describe("generating from the page", () => {
  it("still works, which is the point of registering a provider in Spider", () => {
    // Removing the write route must not take the feature with it.
    return plan().then((outcome) => {
      expect(outcome.problems).toEqual([]);
      expect(outcome.files.map((f) => f.path)).toEqual(["spy/out.txt"]);
      expect(outcome.files[0]!.content).toContain("one");
    });
  });

  it("resolves a provider from the model and not from wherever Spider lives", async () => {
    // A workspace brings its own providers. Until this used `createRequire`, a bare specifier
    // resolved against Spider's own `node_modules`, so a provider a model registered was not found.
    const outcome = await plan();
    expect(outcome.problems).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it("says how each file compares with what is on disk", async () => {
    // Read-only drift, which is more use than a write button: it is the same thing a reviewer wants.
    const outcome = await plan();
    expect(outcome.files[0]!.freshness).toBe("new");
    expect(outcome.drift["new"]).toBe(1);
  });

  it("carries the losses through to the page", async () => {
    // Every provider declares what the model states that its artifact cannot hold, and `plan` used
    // to drop them — so nothing downstream could ever show one.
    const outcome = await plan();
    expect(outcome.files[0]!.losses).toHaveLength(1);
    expect(outcome.files[0]!.losses[0]!.construct).toBe("normalize");
    expect(outcome.files[0]!.losses[0]!.detail).toContain("not a predicate");
  });

  it("carries the provenance, so a file can light up what it came from", async () => {
    const outcome = await plan();
    expect(outcome.files[0]!.from).toContain("shop.PlaceOrder");
  });
});

describe("and not writing from it", () => {
  it("has no route that writes generated code", async () => {
    const res = await fetch(at("/generate/write"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ only: [] }),
    });
    expect(res.status).toBe(404);
  });

  it("wrote nothing while planning", async () => {
    await plan();
    // The manifest says `generated`, and a plan that touched the disk would have created it.
    const entries = await readdir(dir);
    expect(entries).not.toContain("generated");
  });

  it("holds no filesystem write in the generate path at all", async () => {
    // A route can be deleted and added back under another name, and a test that only checked for a
    // 404 would pass against it. This checks the capability rather than the spelling.
    const source = await readFile(resolve(dirname(new URL(import.meta.url).pathname.slice(1)), "..", "src", "generate.ts"), "utf-8");
    expect(source).not.toMatch(/\bwriteFile\b/);
    expect(source).not.toMatch(/\bmkdir\b/);
    expect(source).not.toMatch(/\brm\b|\bunlink\b|\bappendFile\b/);
  });
});

describe("the routes that do write", () => {
  // Saving a layout and editing a model are Spider's job, so those routes stay — and have to ask
  // where the request came from.
  const layout = JSON.stringify({ version: 1, positions: {} });

  it("takes a request from Spider's own page", async () => {
    const res = await fetch(at("/layout.json"), {
      method: "PUT",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: layout,
    });
    expect(res.status).toBe(204);
  });

  it("takes one from a tool, which needed no permission from Spider anyway", async () => {
    // `curl` sends neither header, and something already running as this user could write the file
    // directly. Refusing it would protect nothing and break the obvious thing.
    const res = await fetch(at("/layout.json"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: layout,
    });
    expect(res.status).toBe(204);
  });

  it("refuses one a browser says came from elsewhere", async () => {
    const res = await fetch(at("/layout.json"), {
      method: "PUT",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: layout,
    });
    expect(res.status).toBe(403);
  });

  it("refuses one whose origin is not this server", async () => {
    // The shape of the attack: a page you have open, posting `text/plain` to avoid the preflight.
    const res = await fetch(at("/layout.json"), {
      method: "PUT",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: layout,
    });
    expect(res.status).toBe(403);
  });

  it("guards the model editor the same way", async () => {
    const res = await fetch(at("/mutate"), {
      method: "PUT",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("guards opening another model, which changes what Spider is showing", async () => {
    const res = await fetch(at("/open"), {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example" },
      body: JSON.stringify({ path: dir }),
    });
    expect(res.status).toBe(403);
  });
});
