/**
 * Writing `layout.json`, which is the first thing Spider writes anywhere.
 *
 * Deliberately the first: a layout file is per-developer, gitignored and deletable, and "deleting this
 * file loses saved positions and nothing else" — so the whole write path gets exercised where a mistake
 * costs nothing. The thing most likely to misbehave is not the write but the **loop** it creates: a drag
 * writes, the watcher sees the write, the page reloads the positions it had just sent.
 */

import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type Serving } from "../src/serve.js";
import { parseLayout, writeLayout, WHOLE_MODEL, withPositions } from "../src/layout.js";

const MODEL = `
package acme.shop

message M v1.0 @event { id: uuid @role(businessKey) }

pipe events : topic { retention 7d }

service OrderService {
  emits M to events
}
`;

let dir: string;
let serving: Serving;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "spider-layout-"));
  await writeFile(join(dir, "shop.7k"), MODEL, "utf-8");
  // Watching on, because the loop only exists when the watcher does.
  serving = await serve({ paths: [dir], port: 0, watch: true });
});

afterAll(async () => {
  await serving.close();
});

const at = (path: string): string => `${serving.url.slice(0, -1)}${path}`;

describe("reading", () => {
  it("answers an empty layout when there is no file", async () => {
    // The normal case: the file is optional and per-developer.
    const body = (await (await fetch(at("/layout.json"))).json()) as unknown;
    expect(body).toEqual({});
  });

  it("reads one that is there", async () => {
    await mkdir(join(dir, ".7k"), { recursive: true });
    await writeFile(
      join(dir, ".7k", "layout.json"),
      writeLayout(withPositions({}, WHOLE_MODEL, { "service:acme.shop.OrderService": { x: 12, y: 34 } })),
      "utf-8",
    );
    const text = await (await fetch(at("/layout.json"))).text();
    const { layout, problems } = parseLayout(text);
    expect(problems).toEqual([]);
    expect(layout["*"]!.nodes["service:acme.shop.OrderService"]).toEqual({ x: 12, y: 34 });
  });
});

describe("writing", () => {
  it("writes into `.7k/`, creating it if it is not there", async () => {
    const layout = withPositions({}, WHOLE_MODEL, { "pipe:acme.shop.events": { x: 7, y: 8 } });
    const response = await fetch(at("/layout.json"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: writeLayout(layout),
    });
    expect(response.status).toBe(204);

    const written = await readFile(join(dir, ".7k", "layout.json"), "utf-8");
    expect(parseLayout(written).layout["*"]!.nodes["pipe:acme.shop.events"]).toEqual({ x: 7, y: 8 });
  });

  it("writes the file the page sent, whole", async () => {
    // Which is how a stale entry survives: the page read the file, changed some positions and kept
    // everything else. A server that merged would have to decide what to drop.
    const layout = withPositions({}, WHOLE_MODEL, {
      "service:acme.shop.OrderService": { x: 1, y: 2 },
      "service:acme.shop.LongGone": { x: 3, y: 4 },
    });
    await fetch(at("/layout.json"), { method: "PUT", body: writeLayout(layout) });

    const back = parseLayout(await readFile(join(dir, ".7k", "layout.json"), "utf-8")).layout;
    expect(Object.keys(back["*"]!.nodes).sort()).toEqual([
      "service:acme.shop.LongGone",
      "service:acme.shop.OrderService",
    ]);
  });

  it("round-trips through the server unchanged", async () => {
    const layout = withPositions({}, WHOLE_MODEL, { a: { x: 5, y: 6 }, b: { x: 7, y: 8 } });
    const text = writeLayout(layout);
    await fetch(at("/layout.json"), { method: "PUT", body: text });
    expect(await (await fetch(at("/layout.json"))).text()).toBe(JSON.stringify(JSON.parse(text)));
  });
});

describe("the loop a write creates", () => {
  it("does not announce Spider's own write back to the page that made it", async () => {
    // The loop: drag, PUT, the watcher fires, the page reloads the positions it just sent. Harmless once
    // and maddening while dragging.
    const seen: string[] = [];
    const events = await fetch(at("/events"), { headers: { accept: "text/event-stream" } });
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();

    const pump = (async () => {
      for (let i = 0; i < 40; i++) {
        const { value, done } = await reader.read();
        if (done) return;
        const text = decoder.decode(value);
        if (text.includes("event: changed")) seen.push(text);
      }
    })();

    await fetch(at("/layout.json"), {
      method: "PUT",
      body: writeLayout(withPositions({}, WHOLE_MODEL, { z: { x: 1, y: 1 } })),
    });
    // Longer than the watcher's own debounce, so a notification would have arrived by now.
    await new Promise((done) => setTimeout(done, 500));

    expect(seen).toEqual([]);

    await reader.cancel();
    await pump;
  });

  it("still announces a change somebody else made", async () => {
    // The suppression is a moment wide, not a mode: editing a model file must still reload the page.
    const seen: string[] = [];
    const events = await fetch(at("/events"), { headers: { accept: "text/event-stream" } });
    const reader = events.body!.getReader();
    const decoder = new TextDecoder();

    const pump = (async () => {
      for (let i = 0; i < 40; i++) {
        const { value, done } = await reader.read();
        if (done) return;
        if (decoder.decode(value).includes("event: changed")) seen.push("changed");
      }
    })();

    // Well clear of the last write's window.
    await new Promise((done) => setTimeout(done, 600));
    await writeFile(join(dir, "shop.7k"), `${MODEL}\n// touched\n`, "utf-8");

    // Waited for rather than slept through. The chain is a filesystem event, a 60ms debounce, a
    // rebuild that re-reads every file, and then the announcement — which on a machine running the
    // rest of this suite's browsers alongside is comfortably longer than any fixed sleep somebody
    // picks. A deadline keeps this a test of whether the announcement happens rather than a race
    // against how fast it happens; it was the one test in this repository that flaked.
    const until = Date.now() + 20_000;
    while (seen.length === 0 && Date.now() < until) {
      await new Promise((done) => setTimeout(done, 50));
    }

    expect(seen.length).toBeGreaterThan(0);

    await reader.cancel();
    await pump;
  });
});
