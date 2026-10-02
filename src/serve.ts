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
import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { dirname, extname, join as joinPath, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ServeOptions {
  /** Files and directories to read `.7k` sources from. */
  readonly paths: readonly string[];
  readonly port?: number;
  readonly host?: string;
  /** Rebuild and notify the page when a source changes. On by default. */
  readonly watch?: boolean;
}

export interface Serving {
  readonly url: string;
  readonly port: number;
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

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

export async function serve(options: ServeOptions): Promise<Serving> {
  const paths = options.paths.map((p) => resolvePath(p));
  const wantWatch = options.watch !== false;

  const entry = joinPath(HERE, "web", "main.ts");
  const page = joinPath(HERE, "web", "index.html");

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
      res.writeHead(200, { "content-type": MIME[".html"]!, "cache-control": "no-store" });
      res.end(await readFile(page, "utf-8"));
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((cause: unknown) => {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(cause instanceof Error ? cause.message : String(cause));
    });
  });

  const watchers: FSWatcher[] = [];
  if (wantWatch) {
    // Watching the directories rather than the files, so a new `.7k` file shows up too. Coalesced,
    // because an editor's save is several events and a redraw per event would thrash.
    let pending: NodeJS.Timeout | undefined;
    const changed = (): void => {
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(() => {
        void rebuild().then(announce);
      }, 60);
    };

    const roots = new Set<string>();
    for (const path of paths) {
      const info = await stat(path);
      roots.add(info.isFile() ? dirname(path) : path);
    }
    for (const root of roots) {
      try {
        watchers.push(watch(root, { recursive: true }, changed));
      } catch {
        // Recursive watching is not available everywhere. The page still works; it just will not
        // refresh by itself, which is better than refusing to start.
        watchers.push(watch(root, changed));
      }
    }
    // The renderer's own sources, so editing Spider refreshes the page it is drawing.
    try {
      watchers.push(watch(HERE, { recursive: true }, changed));
    } catch {
      /* optional */
    }
  }

  const port = options.port ?? 7007;
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((done) => server.listen(port, host, done));

  const actual = (server.address() as { port: number } | null)?.port ?? port;

  return {
    url: `http://${host}:${actual}/`,
    port: actual,
    files,
    async close() {
      for (const w of watchers) w.close();
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
    entryPoints: [joinPath(HERE, "web", "main.ts")],
    bundle: true,
    format: "iife",
    target: "es2022",
    outfile: joinPath(outDir, "bundle.js"),
    platform: "browser",
    minify: true,
  });
}
