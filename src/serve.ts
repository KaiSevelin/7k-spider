/**
 * The local web app's server.
 *
 * Deliberately thin. It reads `.7k` files, hands them over as text, bundles the page, and says when a
 * file changed. It does not parse, link or analyse anything — the page does all of that with
 * `@sevenk/core`, so there is no second opinion about what a model means and no IR wire format to
 * keep in step (`docs/design.md` 1).
 *
 * A VS Code webview replaces this file and nothing else (D92): the renderer and everything under it
 * already know nothing about their host.
 */

import { build, type BuildContext, context } from "esbuild";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, watch, type Dirent, type FSWatcher } from "node:fs";
import { dirname, extname, join as joinPath, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "@sevenk/generate";
import {
  MANIFEST,
  describeProviders,
  planFor,
  providersFor,
  type PlanRequest,
} from "./generate.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Where the page's own sources live.
 *
 * `tsc` emits JavaScript and nothing else, so `index.html` and the browser's TypeScript never
 * reach `dist/`. Reading them out of `src/` rather than copying them in is also what keeps the
 * built command and `tsx src/cli.ts` serving the *same* page: esbuild takes the TypeScript either
 * way, so there is no second bundle to keep in step.
 */
const WEB = existsSync(joinPath(HERE, "web", "index.html"))
  ? joinPath(HERE, "web")
  : joinPath(HERE, "..", "src", "web");

export interface ServeOptions {
  /** Files and directories to read `.7k` sources from. */
  readonly paths: readonly string[];
  /**
   * An NDJSON trace to replay over the graph.
   *
   * Optional, and separate from `paths`, because a trace is not a source: the graph is worth drawing
   * before anything has run, and a model and a recording of it running are different inputs.
   */
  readonly trace?: string;
  readonly port?: number;
  readonly host?: string;
  /** Rebuild and notify the page when a source changes. On by default. */
  readonly watch?: boolean;
}

export interface Serving {
  readonly url: string;
  readonly port: number;
  /** The trace file being served, if any. */
  readonly trace?: string;
  /** The source files currently being served. */
  files(): Promise<readonly { path: string; source: string }[]>;
  close(): Promise<void>;
}

/**
 * Every `.7k` file under a path, sorted.
 *
 * Sorted because the order files are read in reaches the layout: `buildGraph` keeps declaration
 * order, so a directory listing that varied by filesystem would move the picture around between
 * machines. Scenario files are included — they are 7K sources, and a workspace holds both.
 */
export async function collect(paths: readonly string[]): Promise<string[]> {
  const found = new Set<string>();

  const walk = async (path: string): Promise<void> => {
    const info = await stat(path);
    if (info.isFile()) {
      if (extname(path) === ".7k") found.add(resolvePath(path));
      return;
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      // Nothing generated or vendored: a `.7k` file under node_modules is somebody else's model.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await walk(joinPath(path, entry.name));
    }
  };

  for (const path of paths) await walk(path);
  return [...found].sort();
}

/** The names a model's own prose may be under, in the order they are preferred. */
const README = ["README.md", "readme.md", "README.markdown"];

/**
 * The README beside a model, if it wrote one.
 *
 * Looked up per served root and the first one wins, the same rule `sidecarPath` uses: a workspace has
 * one introduction, and "which file wins" should not be a question anybody has to answer.
 *
 * `collect` only ever returns `.7k`, so this file is invisible to everything else Spider does — which
 * is the point. It is prose about the system, not part of it.
 */
async function readmeOf(paths: readonly string[]): Promise<{ path: string; text: string } | undefined> {
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    const root = info.isFile() ? dirname(path) : path;
    for (const name of README) {
      const at = joinPath(root, name);
      const text = await readFile(at, "utf-8").catch(() => undefined);
      if (text !== undefined) return { path: at, text };
    }
  }
  return undefined;
}

/**
 * Reads `.7k/views.json` beside the model.
 *
 * The sidecar lives in a dotted directory, which `collect` deliberately skips when looking for models —
 * a `.7k` file under `.7k/` would be tooling state, not a declaration. So it is looked up explicitly.
 *
 * Merged across roots, first one winning a name clash, and absent is not an error: "deleting this file
 * loses saved lenses and nothing else" (`20-ir.md` 6.1).
 */
/** What the page sends: for each file, the text it read and the text it wants written. */
interface SourceWrite {
  readonly files: Readonly<Record<string, { readonly before: string; readonly after: string }>>;
}

/**
 * Writes edited sources, refusing if any of them changed underneath.
 *
 * **The page computes the mutation; the server owns the filesystem.** Core's mutation API lives in the
 * page, which has the model, the trees and the sources, so the semantics of "what does adding an `emits`
 * do" stay in one place (7k D98) and this stays a file writer.
 *
 * Which leaves one thing for the server to decide, and it is the one that matters: **whether the file is
 * still the file the edit was computed against.** `20-ir.md` 7.1 says Spider holds no unsaved buffer and
 * a watcher reloads on external change — so the conflict that remains is a file edited between the page
 * reading it and the page writing it, and the honest answer to that is to refuse and let the reload
 * happen.
 *
 * All or nothing: a mutation may touch several files, and half of a rename is worse than none of it.
 */
async function writeSources(
  paths: readonly string[],
  body: string,
): Promise<{ ok: true; wrote: string[] } | { ok: false; problem: string }> {
  let parsed: SourceWrite;
  try {
    parsed = JSON.parse(body) as SourceWrite;
  } catch (cause) {
    return { ok: false, problem: `not JSON: ${cause instanceof Error ? cause.message : ""}` };
  }
  if (typeof parsed.files !== "object" || parsed.files === null) {
    return { ok: false, problem: "no files to write" };
  }

  const allowed = new Set(await collect(paths));
  const entries = Object.entries(parsed.files);
  if (entries.length === 0) return { ok: false, problem: "no files to write" };

  // Checked before anything is written, so a refusal leaves the workspace exactly as it was.
  for (const [file, { before, after }] of entries) {
    const path = resolvePath(file);
    if (!allowed.has(path)) {
      // Only files this server is already serving: a write path that would touch anything else is a
      // write path somebody will eventually point somewhere unfortunate.
      return { ok: false, problem: `${file} is not part of this workspace` };
    }
    if (typeof before !== "string" || typeof after !== "string") {
      return { ok: false, problem: `${file}: both the prior and the new text are needed` };
    }
    const disk = await readFile(path, "utf-8");
    if (disk !== before) {
      return {
        ok: false,
        problem: `${file} changed since it was read, so the edit was computed against something else`,
      };
    }
  }

  const wrote: string[] = [];
  for (const [file, { after }] of entries) {
    await writeFile(resolvePath(file), after, "utf-8");
    wrote.push(file);
  }
  return { ok: true, wrote };
}

/**
 * The directory a model's sidecars and its generated output belong to.
 *
 * The first path's root, the same rule `sidecarPath` uses: a workspace has one `.7k/`, and "which one
 * wins" should not be a question anybody has to answer.
 */
const rootOf = (paths: readonly string[]): string => {
  const first = paths[0];
  if (first === undefined) return process.cwd();
  return extname(first) === "" ? first : dirname(first);
};

/**
 * The addresses that mean "this machine and nothing else".
 *
 * `/browse` and `/open` are gated on binding to one of these. See `onlyThisMachine` in `serve`.
 */
const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Whether a mutating request came from Spider's own page.
 *
 * Binding to loopback keeps other *machines* out and does nothing about other *pages on this one*. A
 * site you have open can `fetch` a local server, and CORS does not help: it governs reading the
 * response, not causing the side effect — so a POST lands and the write happens whether or not the
 * attacker ever sees the answer. A `content-type` of `text/plain` avoids the preflight that would
 * otherwise have stopped it.
 *
 * So every route that writes asks where the request came from. A browser sends `Sec-Fetch-Site` on
 * everything and `Origin` on every cross-origin POST; a tool like `curl` or a test sends neither, and
 * is allowed, because something already running on this machine as this user needs no permission from
 * Spider to write a file it could write directly.
 */
function fromOurOwnPage(req: IncomingMessage, port: number): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string") return site === "same-origin" || site === "none";

  const origin = req.headers.origin;
  if (origin === undefined || origin === "null") return true;

  try {
    const url = new URL(origin);
    return LOOPBACK.has(url.hostname) && url.port === String(port);
  } catch {
    return false;
  }
}

/** How much of a directory tree `/browse` will read to answer "are there models in here?". */
const BROWSE_BUDGET = 800;

/**
 * How many `.7k` files are under a directory, counted cheaply.
 *
 * Bounded rather than exhaustive: a listing of a dozen directories should answer at once, and the
 * question it is really answering is "is there a model in here" — for which an approximate count and a
 * note that it stopped looking is a better answer than an exact one that took a second to produce. The
 * same things are skipped as `collect` skips, so the count cannot promise files the server would not
 * then serve.
 */
async function countModels(root: string): Promise<{ models: number; capped: boolean }> {
  let models = 0;
  let seen = 0;

  const walk = async (at: string, depth: number): Promise<void> => {
    if (seen >= BROWSE_BUDGET || depth > 6) return;
    let entries: Dirent[];
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      // Unreadable is not an error here: a directory you cannot open simply holds no models you could
      // have served either.
      return;
    }
    for (const entry of entries) {
      if (seen >= BROWSE_BUDGET) return;
      seen += 1;
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) await walk(joinPath(at, entry.name), depth + 1);
      else if (extname(entry.name) === ".7k") models += 1;
    }
  };

  await walk(root, 0);
  return { models, capped: seen >= BROWSE_BUDGET };
}

/**
 * Where a sidecar is written.
 *
 * The first path's root, because a workspace has one `.7k/` and writing into several would make
 * "which file wins" a question nobody should have to answer.
 */
async function sidecarPath(paths: readonly string[], name: string): Promise<string | undefined> {
  const first = paths[0];
  if (first === undefined) return undefined;
  const info = await stat(first).catch(() => undefined);
  if (info === undefined) return undefined;
  return joinPath(info.isFile() ? dirname(first) : first, ".7k", name);
}

/** Reads one sidecar out of `.7k/`, merged across roots. Absent is `{}`, not an error. */
export async function readSidecar(
  paths: readonly string[],
  name: string,
): Promise<string> {
  const merged: Record<string, unknown> = {};
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    const root = info.isFile() ? dirname(path) : path;
    let text: string;
    try {
      text = await readFile(joinPath(root, ".7k", name), "utf-8");
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (!(k in merged)) merged[k] = v;
        }
      }
    } catch {
      // Handed over as it is, so the page reports the parse failure rather than the server hiding it.
      return text;
    }
  }
  return JSON.stringify(merged);
}

export async function readViews(
  paths: readonly string[],
): Promise<{ text: string; problems: readonly string[] }> {
  const merged: Record<string, unknown> = {};
  const problems: string[] = [];

  for (const path of paths) {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    const root = info.isFile() ? dirname(path) : path;
    const file = joinPath(root, ".7k", "views.json");
    let text: string;
    try {
      text = await readFile(file, "utf-8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      problems.push(`${file}: not JSON: ${cause instanceof Error ? cause.message : ""}`);
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      problems.push(`${file}: not a JSON object`);
      continue;
    }
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (name in merged) {
        problems.push(`${file}: \`${name}\` is already defined by an earlier path`);
        continue;
      }
      merged[name] = value;
    }
  }

  return { text: JSON.stringify(merged), problems };
}

/** Reads a request body as text. Small by construction: a layout file is positions. */
const read = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** Where Spider listens unless told otherwise. Exported because a test has to occupy it to prove the walk. */
export const DEFAULT_PORT = 7007;

/** How many ports above the default to try before giving up. */
const PORT_ATTEMPTS = 8;

/**
 * Binds the server, returning the port it got.
 *
 * `server.listen` reports failure through an `error` event, not through its callback. Waiting on the
 * callback alone leaves that event unhandled, and an unhandled `error` on a `Server` ends the process
 * with a stack trace out of `node:net` — which reads as Spider being broken rather than as Spider
 * already running. So the event is what this waits on.
 */
async function listen(
  server: Server,
  from: number,
  host: string,
  extra: number,
): Promise<number> {
  for (let port = from; ; port++) {
    try {
      await new Promise<void>((done, fail) => {
        const onError = (cause: Error): void => {
          server.removeListener("listening", onListening);
          fail(cause);
        };
        const onListening = (): void => {
          server.removeListener("error", onError);
          done();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return port;
    } catch (cause) {
      const code = (cause as { code?: string }).code;
      if (code !== "EADDRINUSE") {
        throw new Error(
          `cannot listen on ${host}:${port}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      if (port >= from + extra) {
        throw new Error(
          extra === 0
            ? `port ${port} is already in use — is Spider already running there?`
            : `ports ${from} to ${port} are all in use — is Spider already running? ` +
              "Stop it, or pass `--port <n>`",
        );
      }
    }
  }
}

export async function serve(options: ServeOptions): Promise<Serving> {
  // Both change when a different model is opened, so neither is a constant. Every closure below reads
  // them rather than a copy, which is what makes `/open` take effect without rebuilding the server.
  let paths = options.paths.map((p) => resolvePath(p));
  let tracePath = options.trace === undefined ? undefined : resolvePath(options.trace);
  const wantWatch = options.watch !== false;
  const host = options.host ?? "127.0.0.1";
  /**
   * Whether this server will read the disk on the page's say-so.
   *
   * `/browse` and `/open` let whoever has the page enumerate and read directories this process can
   * reach. That is exactly what a local tool is for, and exactly what a tool bound to a routable
   * address must not offer — `--host 0.0.0.0` turns a developer's convenience into a file server.
   */
  const onlyThisMachine = LOOPBACK.has(host);

  const entry = joinPath(WEB, "main.ts");
  const page = joinPath(WEB, "index.html");

  // One bundle, built in memory. `context` rather than `build` so a source change rebuilds without
  // paying startup again.
  const ctx: BuildContext = await context({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    target: "es2022",
    sourcemap: "inline",
    write: false,
    logLevel: "silent",
    // The page is the platform here, so a `node:` import would be a bug rather than something to
    // shim. Core has none; this makes that a build error if it ever gains one.
    platform: "browser",
  });

  let bundle = "";
  let buildError: string | undefined;

  const rebuild = async (): Promise<void> => {
    try {
      const result = await ctx.rebuild();
      bundle = result.outputFiles?.[0]?.text ?? "";
      buildError = undefined;
    } catch (cause) {
      buildError = cause instanceof Error ? cause.message : String(cause);
    }
  };
  await rebuild();

  /**
   * When Spider last wrote a sidecar itself.
   *
   * The loop this closes: the page drags a node, PUTs `layout.json`, the watcher sees the write and tells
   * the page to reload, the page re-reads the layout it just sent. Harmless once and maddening while
   * dragging, so a change within a moment of our own write is not announced.
   */
  // Known only once the server is listening, and needed by the guard on every write route.
  let boundPort = 0;
  let wrote = 0;

  const listeners = new Set<ServerResponse>();
  const announce = (): void => {
    for (const res of listeners) res.write("event: changed\ndata: 1\n\n");
  };

  const files = async (): Promise<readonly { path: string; source: string }[]> => {
    const found = await collect(paths);
    return Promise.all(
      found.map(async (path) => ({ path, source: await readFile(path, "utf-8") })),
    );
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": open\n\n");
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return;
    }

    if (url.pathname === "/trace.ndjson") {
      if (tracePath === undefined) {
        // 204 rather than 404: there is no trace *and that is fine*. The graph is the first increment and
        // has never needed one, so a missing trace is a state rather than a failure.
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      const text = await readFile(tracePath, "utf-8");
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      res.end(text);
      return;
    }

    if (url.pathname === "/mutate" && req.method === "PUT") {
      // Loopback keeps other machines out; this keeps other pages on this one out. See
      // `fromOurOwnPage`.
      if (!fromOurOwnPage(req, boundPort)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("not from Spider's own page");
        return;
      }

      const outcome = await writeSources(paths, await read(req));
      if (outcome.ok) {
        // Our own write, so the watcher does not announce it: the page reloads itself, because it is
        // the one that knows the edit succeeded.
        wrote = Date.now();
        res.writeHead(200, { "content-type": MIME[".json"]! });
        res.end(JSON.stringify({ wrote: outcome.wrote }));
      } else {
        res.writeHead(409, { "content-type": MIME[".json"]! });
        res.end(JSON.stringify({ problem: outcome.problem }));
      }
      return;
    }

    if (url.pathname === "/layout.json") {
      if (req.method === "PUT") {
      // Loopback keeps other machines out; this keeps other pages on this one out. See
      // `fromOurOwnPage`.
      if (!fromOurOwnPage(req, boundPort)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("not from Spider's own page");
        return;
      }

        const target = await sidecarPath(paths, "layout.json");
        if (target === undefined) {
          res.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
          res.end("nowhere to write a layout");
          return;
        }
        const body = await read(req);
        // Written whole, because the page holds the whole file: it read it, changed some positions and
        // kept everything else, which is the only way a stale entry survives (`20-ir.md` 6.2).
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, body, "utf-8");
        // Remembered so the watcher does not announce Spider's own write back to the page that made it.
        wrote = Date.now();
        res.writeHead(204);
        res.end();
        return;
      }

      const text = await readSidecar(paths, "layout.json");
      res.writeHead(200, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
      res.end(text);
      return;
    }

    if (url.pathname === "/forms.json") {
      // Per-developer and gitignored, unlike views.json, so an absent file is the normal case — and it
      // changes nothing, because every key in it is an override (`20-ir.md` 6.3).
      const text = await readSidecar(paths, "forms.json");
      res.writeHead(200, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
      res.end(text);
      return;
    }

    if (url.pathname === "/views.json") {
      const { text, problems } = await readViews(paths);
      res.writeHead(200, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
      // The problems travel with the file, so a malformed sidecar is reported in the page rather than
      // only in the terminal nobody is looking at.
      res.end(JSON.stringify({ views: JSON.parse(text), problems }));
      return;
    }

    if (url.pathname === "/browse" || url.pathname === "/open") {
      if (!onlyThisMachine) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end(`this Spider is bound to ${host}, so it will not read the disk on a page's say-so`);
        return;
      }
    }

    if (url.pathname === "/browse") {
      // Where the current model lives, so the picker opens somewhere recognisable rather than at a root.
      const first = paths[0];
      const fallback =
        first === undefined ? process.cwd() : ((await stat(first).catch(() => undefined))?.isFile() ?? false) ? dirname(first) : first;
      const at = resolvePath(url.searchParams.get("at") ?? fallback);

      let entries: Dirent[];
      try {
        entries = await readdir(at, { withFileTypes: true });
      } catch (cause) {
        res.writeHead(404, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
        res.end(JSON.stringify({ problem: cause instanceof Error ? cause.message : String(cause) }));
        return;
      }

      const dirs = entries
        .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
        .sort((a, b) => a.name.localeCompare(b.name));
      const listed = [];
      for (const dir of dirs) {
        const path = joinPath(at, dir.name);
        listed.push({ name: dir.name, path, ...(await countModels(path)) });
      }

      const up = dirname(at);
      res.writeHead(200, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
      res.end(
        JSON.stringify({
          at,
          // A filesystem root is its own parent, which is how the picker knows to stop offering `..`.
          ...(up === at ? {} : { parent: up }),
          here: await countModels(at),
          entries: listed,
        }),
      );
      return;
    }

    if (url.pathname === "/open" && req.method === "POST") {
      // Loopback keeps other machines out; this keeps other pages on this one out. See
      // `fromOurOwnPage`.
      if (!fromOurOwnPage(req, boundPort)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("not from Spider's own page");
        return;
      }

      let wanted: readonly string[];
      try {
        const body = JSON.parse(await read(req)) as { paths?: unknown };
        if (!Array.isArray(body.paths) || body.paths.some((p) => typeof p !== "string" || p === "")) {
          throw new Error("`paths` must be a non-empty list of strings");
        }
        if (body.paths.length === 0) throw new Error("`paths` must name at least one place");
        wanted = body.paths as readonly string[];
      } catch (cause) {
        res.writeHead(400, { "content-type": MIME[".json"]! });
        res.end(JSON.stringify({ problem: cause instanceof Error ? cause.message : String(cause) }));
        return;
      }

      const resolved = wanted.map((p) => resolvePath(p));
      const found = await collect(resolved).catch(() => [] as string[]);
      if (found.length === 0) {
        // Refused rather than opened empty: a graph of nothing looks like a broken Spider, and the
        // model that *was* open is a better thing to still be looking at.
        res.writeHead(409, { "content-type": MIME[".json"]! });
        res.end(JSON.stringify({ problem: `no \`.7k\` files under ${resolved.join(", ")}` }));
        return;
      }

      paths = resolved;
      // A trace records one model running. Kept across an open it would resolve against names the new
      // model does not have, and a timeline of events that belong to nothing is worse than none.
      tracePath = undefined;
      await rewatch();

      res.writeHead(200, { "content-type": MIME[".json"]! });
      res.end(JSON.stringify({ paths: resolved, files: found.length }));
      // The page reloads itself off this, exactly as it does for a file changing on disk.
      announce();
      process.stderr.write(`opened ${resolved.join(", ")} (${found.length} files)\n`);
      return;
    }

    if (url.pathname === "/readme.json") {
      const found = await readmeOf(paths);
      if (found === undefined) {
        // 204 rather than 404, for the same reason a missing trace is: a model with no prose beside it
        // is a model, not a fault.
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
      res.end(JSON.stringify(found));
      return;
    }

    if (url.pathname === "/providers") {
      const text = await readFile(joinPath(rootOf(paths), ".7k", MANIFEST), "utf-8").catch(() => undefined);
      const manifest = text === undefined ? undefined : parseManifest(text, MANIFEST).manifest;
      const { providers, problems } = await providersFor(manifest, rootOf(paths));
      res.writeHead(200, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
      res.end(JSON.stringify({ providers: describeProviders(providers), problems }));
      return;
    }

    if (url.pathname === "/generate" && req.method === "POST") {
      const asked = JSON.parse(await read(req)) as PlanRequest;
      const outcome = await planFor(await files(), rootOf(paths), asked);
      res.writeHead(200, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
      res.end(JSON.stringify(outcome));
      return;
    }

    if (url.pathname === "/sources.json") {
      const body = JSON.stringify({ files: await files() });
      res.writeHead(200, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
      res.end(body);
      return;
    }

    if (url.pathname === "/bundle.js") {
      if (buildError !== undefined) {
        // Shown in the page rather than only in the terminal, because the page is where you are
        // looking when it breaks.
        res.writeHead(200, { "content-type": MIME[".js"]! });
        res.end(`document.body.textContent = ${JSON.stringify(`build failed:\n\n${buildError}`)};`);
        return;
      }
      res.writeHead(200, { "content-type": MIME[".js"]!, "cache-control": "no-store" });
      res.end(bundle);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // Read before the headers go out, as every route above does. Once a status line has been sent, a
      // failed read can no longer be reported as one and the catch below is left with nothing to say.
      const text = await readFile(page, "utf-8");
      res.writeHead(200, { "content-type": MIME[".html"]!, "cache-control": "no-store" });
      res.end(text);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      const what = `${req.method ?? "?"} ${req.url ?? "?"}`;
      // A handler that fails *after* its headers have gone out cannot be given a 500: `writeHead`
      // throws, and a throw in here is an unhandled rejection, which ends the process. That is the
      // worst failure this server has — one bad request and every later one is refused, which reads
      // as Spider never having started rather than as one route being broken. The request itself is
      // past saving, so it is cut off and the reason is printed; the server stays up.
      if (res.headersSent) {
        process.stderr.write(`${what} failed after responding: ${reason}\n`);
        res.destroy();
        return;
      }
      process.stderr.write(`${what} failed: ${reason}\n`);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(reason);
    });
  });

  // Coalesced, because an editor's save is several events and a redraw per event would thrash.
  let pending: NodeJS.Timeout | undefined;
  const changed = (): void => {
    if (pending !== undefined) clearTimeout(pending);
    pending = setTimeout(() => {
      // Our own write, coming back around. Announcing it would make the page reload the positions it
      // had just sent, mid-drag.
      if (Date.now() - wrote < 400) return;
      void rebuild().then(announce);
    }, 60);
  };

  /** Watchers over the model being served. Replaced wholesale when a different model is opened. */
  let modelWatchers: FSWatcher[] = [];
  /** Watchers over Spider's own sources, which outlive any model. */
  const ownWatchers: FSWatcher[] = [];

  const rewatch = async (): Promise<void> => {
    for (const w of modelWatchers) w.close();
    modelWatchers = [];
    if (!wantWatch) return;

    // Watching the directories rather than the files, so a new `.7k` file shows up too.
    const roots = new Set<string>();
    for (const path of paths) {
      const info = await stat(path).catch(() => undefined);
      if (info === undefined) continue;
      roots.add(info.isFile() ? dirname(path) : path);
    }
    for (const root of roots) {
      try {
        modelWatchers.push(watch(root, { recursive: true }, changed));
      } catch {
        // Recursive watching is not available everywhere. The page still works; it just will not
        // refresh by itself, which is better than refusing to start.
        modelWatchers.push(watch(root, changed));
      }
    }
    // The trace, so re-running a scenario shows up without a reload.
    if (tracePath !== undefined) {
      try {
        modelWatchers.push(watch(tracePath, changed));
      } catch {
        /* a trace that is not there yet is not an error */
      }
    }
  };

  await rewatch();

  if (wantWatch) {
    // The renderer's own sources, so editing Spider refreshes the page it is drawing.
    try {
      ownWatchers.push(watch(dirname(WEB), { recursive: true }, changed));
    } catch {
      /* optional */
    }
  }

  const wanted = options.port ?? DEFAULT_PORT;
  // A port explicitly asked for is a requirement; the default is a preference. Pressing F5 twice is
  // the commonest way to arrive here, and walking up is what makes the second one work.
  const walk = options.port === undefined ? PORT_ATTEMPTS : 0;
  const bound = await listen(server, wanted, host, walk);
  if (bound !== wanted) {
    process.stderr.write(`port ${wanted} was in use, so this one is on ${bound}\n`);
  }

  const actual = (server.address() as { port: number } | null)?.port ?? bound;
  boundPort = actual;

  return {
    url: `http://${host}:${actual}/`,
    port: actual,
    ...(tracePath === undefined ? {} : { trace: tracePath }),
    files,
    async close() {
      for (const w of [...modelWatchers, ...ownWatchers]) w.close();
      for (const res of listeners) res.end();
      listeners.clear();
      await ctx.dispose();
      await new Promise<void>((done, fail) =>
        server.close((cause) => (cause === undefined || cause === null ? done() : fail(cause))),
      );
    },
  };
}

/** Builds the page's bundle to a directory, for a host that cannot run a server. */
export async function bundleTo(outDir: string): Promise<void> {
  await build({
    entryPoints: [joinPath(WEB, "main.ts")],
    bundle: true,
    format: "iife",
    target: "es2022",
    outfile: joinPath(outDir, "bundle.js"),
    platform: "browser",
    minify: true,
  });
}
