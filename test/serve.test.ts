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
import { createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PORT, collect, serve, type Serving } from "../src/serve.js";
import { parse } from "../src/cli.js";
import { LAYOUT, LEGEND, PIPE_SHAPE, STYLE, legendElements, resolveStyle } from "../src/render.js";

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

describe("a port already in use", () => {
  /**
   * Pressing F5 twice is the commonest way to arrive here, and `server.listen` reports the failure
   * through an `error` event rather than its callback — so waiting on the callback alone ended the
   * process with a stack trace out of `node:net`, which reads as Spider being broken rather than as
   * Spider already running.
   */
  it("walks up to the next free one when no port was asked for", async () => {
    // The walk only applies to the default, so the test has to occupy that exact port — which is the
    // one thing the rest of this suite avoids, since a fixed port fights a running Spider. Hence the
    // blocker and the skip: if something already holds it, there is nothing here left to prove.
    const blocker = createServer();
    const held = await new Promise<boolean>((done) => {
      blocker.once("error", () => done(false));
      blocker.once("listening", () => done(true));
      blocker.listen(DEFAULT_PORT, "127.0.0.1");
    });
    if (!held) return;

    try {
      const second = await serve({ paths: [dir], watch: false });
      try {
        expect(second.port).toBeGreaterThan(DEFAULT_PORT);
        expect(second.url).toContain(String(second.port));
        // And it is a working server, not merely a bound socket.
        expect((await fetch(`${second.url}sources.json`)).status).toBe(200);
      } finally {
        await second.close();
      }
    } finally {
      await new Promise<void>((done) => blocker.close(() => done()));
    }
  });

  it("refuses, readably, when the port was asked for by name", async () => {
    // Explicit is a requirement rather than a preference: silently serving somewhere else would make
    // a reverse proxy or a bookmark point at nothing.
    const first = await serve({ paths: [dir], watch: false, port: 0 });
    try {
      await expect(serve({ paths: [dir], watch: false, port: first.port })).rejects.toThrow(
        /already in use/,
      );
    } finally {
      await first.close();
    }
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

describe("a route that throws", () => {
  let serving: Serving;

  beforeAll(async () => {
    // A trace that is not there. `/trace.ndjson` reads it per request, so the read fails inside the
    // handler rather than at startup, which is the only way to get at the wrapper around it.
    serving = await serve({
      paths: [dir],
      trace: join(dir, "never-written.ndjson"),
      port: 0,
      watch: false,
    });
  });

  afterAll(async () => {
    await serving.close();
  });

  it("answers 500 and leaves the server standing", async () => {
    // The failure this exists to prevent: the handler throws, the wrapper tries to say 500 on a
    // response it can no longer write headers to, and *that* throw is an unhandled rejection — which
    // ends the process. Every later request is then refused, so the browser the launch configuration
    // had just opened reports that the site cannot be reached, as though Spider had never started.
    const base = serving.url.slice(0, -1);

    const failed = await fetch(`${base}/trace.ndjson`);
    expect(failed.status).toBe(500);
    expect(await failed.text()).toContain("never-written.ndjson");

    expect((await fetch(`${base}/sources.json`)).status).toBe(200);
  });
});

describe("the palette", () => {
  const used = [
    ...new Set([...JSON.stringify(STYLE).matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!)),
  ];

  it("names only variables the page actually defines", async () => {
    // Cytoscape has no CSS behind its stylesheet, so a name the page does not define is dropped and the
    // element falls back to Cytoscape's own grey box, black border and black label — with nothing but a
    // console warning to say so. A typo here is invisible until somebody looks at the drawing and finds
    // it has no colour in it at all, which is exactly how this went unnoticed.
    const page = await readFile(new URL("../src/web/index.html", import.meta.url), "utf-8");
    expect(used.length).toBeGreaterThan(5);
    for (const name of used) expect(page, name).toContain(`${name}:`);
  });

  it("leaves nothing for Cytoscape to reject", () => {
    expect(JSON.stringify(resolveStyle(STYLE, () => "#123456"))).not.toContain("var(");
  });

  it("drops what the host cannot resolve, rather than blanking it", () => {
    // An empty string is not a colour either, and Cytoscape rejects the property just the same. Leaving
    // it out lets Cytoscape's own default stand, which is at least a colour.
    const blocks = resolveStyle(STYLE, () => undefined) as unknown as {
      selector: string;
      style: Record<string, unknown>;
    }[];

    // Every property this rule has is a colour, so nothing of it should survive.
    expect(blocks.find((b) => b.selector === "node.service")?.style).toEqual({});
    // While the ones that were never variables are untouched.
    expect(blocks.find((b) => b.selector === "node.kind-queue")?.style).toEqual({ shape: "rectangle" });

    for (const block of blocks) {
      for (const [prop, value] of Object.entries(block.style)) {
        // `label: ""` is deliberate on the marker, which carries no text.
        if (prop === "label") continue;
        expect(value, `${block.selector} { ${prop} }`).not.toBe("");
      }
    }
  });
});

describe("the legend", () => {
  // Every class the stylesheet actually styles. A row naming one it does not would draw a plain box and
  // say "a topic" beside it, which is worse than having no legend.
  const styled = new Set([...JSON.stringify(STYLE).matchAll(/node\.([\w-]+)/g)].map((m) => m[1]!));

  it("draws its swatches with classes the stylesheet styles", () => {
    for (const row of LEGEND) {
      for (const cls of (row.classes ?? "").split(" ").filter((c) => c !== "")) {
        expect(styled.has(cls), `"${row.what}" uses .${cls}`).toBe(true);
      }
    }
  });

  /**
   * The same guarantee for the rows that select on data rather than on a class.
   *
   * `boundary`, `lossy` and `adapter` are drawn by `[attr = "yes"]` rules, so a row setting one the
   * stylesheet has no rule for would draw a plain box with a confident sentence beside it — which is
   * the failure the test above exists to prevent, on the other half of the mechanism.
   */
  it("draws its swatches with data the stylesheet selects on", () => {
    const keyed = new Set(
      [...JSON.stringify(STYLE).matchAll(/\[(\w+)\s*=/g)].map((m) => m[1]!),
    );
    for (const row of LEGEND) {
      for (const key of Object.keys(row.data ?? {})) {
        expect(keyed.has(key), `"${row.what}" selects on [${key}]`).toBe(true);
      }
    }
  });

  /** `@adapter` is a boundary, and the graph is where boundaries are read. */
  it("explains an adapter, drawn as the service it still is", () => {
    const row = LEGEND.find((r) => r.what.includes("@adapter"));
    expect(row, "no legend row for an adapter").toBeDefined();
    expect(row?.classes).toContain("service");
    expect(row?.data).toEqual({ adapter: "yes" });
  });

  it("has a row for every kind of pipe", () => {
    // A new pipe kind is a new shape on the canvas, and a shape with nothing to look it up by is the
    // thing a legend exists to prevent.
    const classes = LEGEND.map((r) => r.classes ?? "").join(" ");
    for (const kind of Object.keys(PIPE_SHAPE)) expect(classes, kind).toContain(`kind-${kind}`);
  });

  it("says something about every row", () => {
    for (const row of LEGEND) expect(row.what.trim(), JSON.stringify(row)).not.toBe("");
  });

  it("builds well-formed elements, with both ends of every line present", () => {
    const elements = legendElements();
    const ids = elements.map((e) => (e.data as { id: string }).id);
    expect(new Set(ids).size, "ids are unique").toBe(ids.length);

    const nodes = new Set(
      elements.filter((e) => (e.data as { source?: string }).source === undefined).map((e) => (e.data as { id: string }).id),
    );
    for (const e of elements) {
      const { source, target } = e.data as { source?: string; target?: string };
      if (source === undefined) continue;
      expect(nodes.has(source), `source ${source}`).toBe(true);
      expect(nodes.has(target!), `target ${target!}`).toBe(true);
    }
  });
});

describe("opening another model", () => {
  let serving: Serving;
  let other: string;

  beforeAll(async () => {
    other = await mkdtemp(join(tmpdir(), "spider-other-"));
    await writeFile(join(other, "other.7k"), "package other.shop\n", "utf-8");
    await mkdir(join(other, "empty"), { recursive: true });
    serving = await serve({ paths: [dir], port: 0, watch: false });
  });

  afterAll(async () => {
    await serving.close();
  });

  const base = (): string => serving.url.slice(0, -1);

  it("browses from the model it is already serving, so the picker opens somewhere recognisable", async () => {
    const body = (await (await fetch(`${base()}/browse`)).json()) as {
      at: string;
      here: { models: number };
      entries: { name: string; models: number }[];
    };
    expect(body.at).toBe(dir);
    expect(body.here.models).toBe(2);
    // `nested` holds one; `node_modules` and the dotted `.7k` directory are not offered at all, because
    // `collect` would not read them either.
    expect(body.entries.map((e) => e.name)).toEqual(["nested"]);
    expect(body.entries[0]?.models).toBe(1);
  });

  it("stops offering `..` at a filesystem root", async () => {
    let at = dir;
    for (let i = 0; i < 20; i++) {
      const body = (await (await fetch(`${base()}/browse?at=${encodeURIComponent(at)}`)).json()) as {
        at: string;
        parent?: string;
      };
      if (body.parent === undefined) return;
      at = body.parent;
    }
    throw new Error("a root was never reached");
  });

  it("says so rather than throwing when the place is not there", async () => {
    const response = await fetch(`${base()}/browse?at=${encodeURIComponent(join(dir, "nowhere"))}`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { problem?: string }).problem).toBeTruthy();
  });

  const open = async (paths: unknown): Promise<Response> =>
    fetch(`${base()}/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths }),
    });

  it("refuses a place with no model in it, and keeps serving the one that was open", async () => {
    // Opening empty would draw a graph of nothing, which looks like a broken Spider. The model that was
    // already open is the better thing to still be looking at.
    const response = await open([join(other, "empty")]);
    expect(response.status).toBe(409);
    const after = (await (await fetch(`${base()}/sources.json`)).json()) as { files: unknown[] };
    expect(after.files).toHaveLength(2);
  });

  it("refuses a body that names nothing", async () => {
    expect((await open([])).status).toBe(400);
    expect((await open("somewhere")).status).toBe(400);
  });

  it("serves the new model afterwards", async () => {
    const response = await open([other]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ paths: [other], files: 1 });

    const after = (await (await fetch(`${base()}/sources.json`)).json()) as {
      files: { path: string; source: string }[];
    };
    expect(after.files).toHaveLength(1);
    expect(after.files[0]?.source).toContain("package other.shop");
  });
});

describe("a Spider bound to a routable address", () => {
  let serving: Serving;

  beforeAll(async () => {
    serving = await serve({ paths: [dir], port: 0, host: "0.0.0.0", watch: false });
  });

  afterAll(async () => {
    await serving.close();
  });

  it("will not read the disk on a page's say-so", async () => {
    // `--host 0.0.0.0` turns a developer's convenience into a file server for the network, so the two
    // routes that reach outside the served model are the two that are refused.
    const at = `http://127.0.0.1:${serving.port}`;
    expect((await fetch(`${at}/browse`)).status).toBe(403);
    expect(
      (
        await fetch(`${at}/open`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ paths: [dir] }),
        })
      ).status,
    ).toBe(403);
    // While everything about the model it was told to serve still works.
    expect((await fetch(`${at}/sources.json`)).status).toBe(200);
  });
});
