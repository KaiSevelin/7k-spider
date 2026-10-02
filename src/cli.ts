/**
 * `spider` — the command that opens the graph.
 *
 * Small on purpose. The command's only decisions are which files to read and which port to listen on;
 * everything about the model happens in the page (`docs/design.md` 1).
 */

import { serve } from "./serve.js";

const HELP = `7k Spider — three views over a 7K model and a trace of it running.

  spider serve <paths...>        serve the graph at http://127.0.0.1:7007

Options
  --trace <file>                 replay this NDJSON trace over the graph
  --port <n>                     listen on this port instead (0 picks a free one)
  --host <addr>                  bind to this address instead of 127.0.0.1
  --no-watch                     do not redraw when a file changes
  --help

A path may be a file or a directory; a directory is searched for \`.7k\` files, skipping
dotted directories and node_modules.

With a trace, the graph animates what happened. The sequence diagram is increment 3.
`;

interface Parsed {
  readonly command: "serve" | "help";
  readonly paths: readonly string[];
  readonly port?: number;
  readonly host?: string;
  readonly trace?: string;
  readonly watch: boolean;
}

/** Flags that take a value, so the value is never mistaken for a path. */
const VALUED = new Set(["--port", "--host", "--trace"]);

export function parse(argv: readonly string[]): Parsed {
  let command: Parsed["command"] = "help";
  const paths: string[] = [];
  let port: number | undefined;
  let host: string | undefined;
  let trace: string | undefined;
  let watch = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "serve") {
      command = "serve";
      continue;
    }
    if (arg === "--help" || arg === "-h") return { command: "help", paths: [], watch };
    if (arg === "--no-watch") {
      watch = false;
      continue;
    }
    if (VALUED.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--port") {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
          throw new Error(`\`${value}\` is not a port`);
        }
        port = parsed;
      } else if (arg === "--trace") trace = value;
      else host = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`unknown option \`${arg}\``);
    paths.push(arg);
  }

  return {
    command,
    paths,
    ...(port === undefined ? {} : { port }),
    ...(host === undefined ? {} : { host }),
    ...(trace === undefined ? {} : { trace }),
    watch,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 2;
  }

  if (parsed.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (parsed.paths.length === 0) {
    process.stderr.write("nothing to serve: give a file or a directory\n");
    return 2;
  }

  const serving = await serve({
    paths: parsed.paths,
    ...(parsed.port === undefined ? {} : { port: parsed.port }),
    ...(parsed.host === undefined ? {} : { host: parsed.host }),
    ...(parsed.trace === undefined ? {} : { trace: parsed.trace }),
    watch: parsed.watch,
  });

  const files = await serving.files();
  if (files.length === 0) {
    // Said plainly rather than serving an empty graph, which looks like a bug in Spider.
    process.stderr.write(`no \`.7k\` files under ${parsed.paths.join(", ")}\n`);
    await serving.close();
    return 1;
  }

  const what = [
    `${files.length} files`,
    serving.trace === undefined ? undefined : "a trace",
    parsed.watch ? "watching" : undefined,
  ].filter((x) => x !== undefined);
  process.stdout.write(`7k Spider  ${serving.url}\n${what.join(", ")}\n`);

  const stop = (): void => {
    void serving.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Resolves only when the server closes, which is what keeps the command in the foreground.
  return new Promise<number>(() => {});
}

// Run only when invoked as a command, so importing this file for a test starts no server.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (cause: unknown) => {
      process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
      process.exit(1);
    },
  );
}
