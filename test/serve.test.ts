/**
 * The server, the command, and the two claims the page rests on.
 *
 * The drawing itself is checked by looking at it. What is checked here is everything around it that
 * fails silently: whether Core actually bundles for a browser, whether the page and its script agree
 * about the elements between them, and whether the layout is the deterministic one the design
 * promises rather than whatever a library defaults to.
 */

import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collect, serve, type Serving } from "../src/serve.js";
import { parse } from "../src/cli.js";
import { LAYOUT, PIPE_SHAPE } from "../src/render.js";

const MODEL = `
package acme.shop

message PlaceOrder v1.0 @command { id: uuid @role(businessKey) }

pipe inbound : queue { retention 7d }

service OrderService {
  reacts PlaceOrder from inbound {
    replies none
  }
}
`;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "spider-"));
  await writeFile(join(dir, "shop.7k"), MODEL, "utf-8");
  await writeFile(join(dir, "notes.md"), "not a model", "utf-8");
  await mkdir(join(dir, "nested"), { recursive: true });
  await writeFile(join(dir, "nested", "more.7k"), "package acme.other\n", "utf-8");
  // Both skipped: a model under node_modules is somebody else's, and a dotted directory is tooling.
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "node_modules", "pkg", "theirs.7k"), "package theirs\n", "utf-8");
  await mkdir(join(dir, ".7k"), { recursive: true });
  await writeFile(join(dir, ".7k", "cache.7k"), "package cached\n", "utf-8");
});

describe("collect", () => {
  it("finds every .7k file under a directory, and nothing else", async () => {
    const found = await collect([dir]);
    expect(found.map((f) => f.replace(dir, "").replace(/\\/g, "/"))).toEqual([
      "/nested/more.7k",
      "/shop.7k",
    ]);
  });

  it("sorts, because the read order reaches the layout", async () => {
    // `buildGraph` keeps declaration order, so a directory listing that varied by filesystem would
    // move the picture between machines.
    const found = await collect([dir]);
    expect(found).toEqual([...found].sort());
  });

  it("takes a file as readily as a directory", async () => {
    expect(await collect([join(dir, "shop.7k")])).toHaveLength(1);
  });

  it("does not return the same file twice when a path overlaps another", async () => {
    expect(await collect([dir, join(dir, "shop.7k")])).toHaveLength(2);
  });
});

describe("the command line", () => {
  it("reads a port without swallowing it as a path", () => {
    expect(parse(["serve", "examples", "--port", "9000"])).toMatchObject({
      command: "serve",
      paths: ["examples"],
      port: 9000,
    });
  });

  it("defaults to watching, and stops on request", () => {
    expect(parse(["serve", "x"]).watch).toBe(true);
    expect(parse(["serve", "x", "--no-watch"]).watch).toBe(false);
  });

  it("asks for help when given nothing", () => {
    expect(parse([]).command).toBe("help");
    expect(parse(["--help"]).command).toBe("help");
  });

  it("refuses an unknown option rather than reading it as a path", () => {
    expect(() => parse(["serve", "--nonsense"])).toThrow("--nonsense");
    expect(() => parse(["serve", "x", "--port"])).toThrow("needs a value");
    expect(() => parse(["serve", "x", "--port", "nope"])).toThrow("not a port");
  });
});

describe("the layout", () => {
  it("is layered and not a force, which is the whole of D25's stability requirement", () => {
    const elk = LAYOUT["elk"] as Record<string, string>;
    expect(LAYOUT["name"]).toBe("elk");
    expect(elk["algorithm"]).toBe("layered");
    expect(JSON.stringify(LAYOUT).toLowerCase()).not.toContain("force");
  });

  it("does not animate, because an animated reshuffle is a reshuffle you watched happen", () => {
    expect(LAYOUT["animate"]).toBe(false);
  });

  it("gives every pipe kind its own shape", () => {
    expect(new Set(Object.values(PIPE_SHAPE)).size).toBe(Object.keys(PIPE_SHAPE).length);
    expect(Object.keys(PIPE_SHAPE).sort()).toEqual(["queue", "stream", "topic"]);
  });
});

describe("serving", () => {
  let serving: Serving;

  beforeAll(async () => {
    // Port 0 picks a free one, so the tests do not fight a running Spider.
    serving = await serve({ paths: [dir], port: 0, watch: false });
  });

  afterAll(async () => {
    await serving.close();
  });

  const get = async (path: string): Promise<Response> => fetch(`${serving.url.slice(0, -1)}${path}`);

  it("hands over the sources as text, parsing nothing", async () => {
    const body = (await (await get("/sources.json")).json()) as {
      files: { path: string; source: string }[];
    };
    expect(body.files).toHaveLength(2);
    expect(body.files.map((f) => f.path.endsWith(".7k"))).toEqual([true, true]);
    expect(body.files.some((f) => f.source.includes("service OrderService"))).toBe(true);
  });

  it("bundles Core for a browser", async () => {
    // The claim that makes Spider's view the checker's rather than a copy of it: Core has no `node:`
    // imports, so it bundles for the page. esbuild runs with `platform: "browser"`, so this fails
    // the day that stops being true.
    const js = await (await get("/bundle.js")).text();
    expect(js.length).toBeGreaterThan(50_000);
    expect(js).not.toContain("build failed");
    expect(js.startsWith('"use strict";')).toBe(true);
  });

  it("serves the page, and a 404 for anything else", async () => {
    const page = await get("/");
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("7K Spider");
    expect((await get("/elsewhere")).status).toBe(404);
  });

  it("agrees with the page about the elements between them", async () => {
    // The bug this catches: renaming an id in the HTML, which breaks the page at runtime and nowhere
    // earlier. `main.ts` looks each of these up and throws if it is missing.
    const page = await (await get("/")).text();
    const main = await readFile(new URL("../src/web/main.ts", import.meta.url), "utf-8");
    // `[a-zA-Z]`, not `[a-z]`: a camelCase id would otherwise be skipped silently, which is precisely
    // the typo this test exists to catch.
    const wanted = [...main.matchAll(/el(?:<[^>]*>)?\("([a-zA-Z]+)"\)/g)].map((m) => m[1]!);
    expect(wanted.length).toBeGreaterThan(3);
    for (const id of new Set(wanted)) expect(page, id).toContain(`id="${id}"`);
  });

  it("tells the page when nothing is wrong, by serving no cache", async () => {
    // A cached `sources.json` would make the file watcher pointless.
    expect((await get("/sources.json")).headers.get("cache-control")).toBe("no-store");
    expect((await get("/bundle.js")).headers.get("cache-control")).toBe("no-store");
  });
});
