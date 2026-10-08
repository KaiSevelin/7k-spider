/**
 * Sending a message, which means running a scenario.
 *
 * Spider could compose a body and could not do anything with it but write a `publish` step into a
 * file. The gap was never a mechanism — the sandbox's engine takes a `live` map and `hosts.json` says
 * what goes in it — it was that nothing joined the two up, so "send this" meant "go to a terminal".
 *
 * **A send is a one-step scenario.** Not a special path: the same `publish` the composer already
 * writes, run rather than saved. That matters because it means what you see when you send is what you
 * get when you commit the scenario and CI runs it, rather than two code paths that agree until they
 * do not. The scenario text is built here and handed to Core's own parser, so a body Spider would
 * write and a body Spider sends are checked by the same thing.
 *
 * **It produces a trace, and Spider is already a trace viewer.** The sequence diagram, the timeline,
 * the scrubber and the highlight-in-every-view all render one. So this returns what `--trace` would
 * have put in a file, and the page feeds it to the player it already has.
 *
 * **The sandbox is imported here and not in the bundle.** The page posts and receives a trace; it
 * learns nothing about how a scenario runs. That is the same line `serve.ts` already keeps for the
 * filesystem, and it is what lets the page be hosted somewhere that has neither.
 */

import { join } from "node:path";
import { buildWorkspace, readJsonBody, type Diagnostic } from "@sevenk/core";
import {
  HOSTS,
  readHosts,
  runScenario,
  startHosts,
  type TraceEvent,
} from "@sevenk/sandbox";

export interface RunRequest {
  /** The message to publish, qualified. */
  readonly message: string;
  /** Its body: a value, or the canonical text the composer produced. See `literal`. */
  readonly body: Readonly<Record<string, unknown>> | string;
  /** The service to publish as. Its `emits` decides which pipe the message lands on. */
  readonly as?: string;
  readonly envelope?: Readonly<Record<string, unknown>>;
  readonly claims?: Readonly<Record<string, unknown>>;
  /**
   * How long to let the virtual clock run afterwards.
   *
   * It is virtual, so this costs nothing and a generous default is the right one: a saga with a
   * `timeout 30s` says nothing in a run that stopped at one second. No wall-clock time passes while
   * a breakpoint is held either, which is the property that makes debugging through this work at all.
   */
  readonly advanceMs?: number;
  /** Services to run for real. Anything not named here, and anything unstartable, is mocked. */
  readonly live?: readonly string[];
  readonly seed?: number;
}

export interface RunOutcome {
  readonly status: "pass" | "fail" | "unsupported" | "refused";
  readonly trace: readonly TraceEvent[];
  /** Problems with the request rather than with the system: an unknown message, a bad body. */
  readonly problems: readonly string[];
  /** Hosts that were asked for and could not be started. The run went ahead without them. */
  readonly unstarted: readonly string[];
  /** Which services actually ran for real, so the page can say so rather than imply it. */
  readonly ran: readonly string[];
  /** Anything the child processes wrote to their own output, which is where a `print` lands. */
  readonly said: readonly string[];
}

const refused = (...problems: string[]): RunOutcome => ({
  status: "refused",
  trace: [],
  problems,
  unstarted: [],
  ran: [],
  said: [],
});

/**
 * A body as the text a scenario would carry.
 *
 * A value is encoded, since canonical JSON is a subset of what the body grammar takes. Text is
 * *verified* and passed through — `readJsonBody` runs the real lexer and the real body parser, so
 * what is accepted here is exactly what a file would accept, and a body that would not parse is
 * reported against the request rather than becoming a scenario that does not compile.
 *
 * Text matters because the composer has text: `canonical` is the string it would write into a
 * scenario, and a 7K body is not quite JSON — a key may be bare, `$auto` is a directive lexed as an
 * identifier, and a duration is a literal of its own. Re-encoding would lose all three.
 */
function literal(
  value: Readonly<Record<string, unknown>> | string | undefined,
): string | { readonly problem: string } {
  if (value === undefined) return "{}";
  if (typeof value !== "string") return JSON.stringify(value);
  const read = readJsonBody(value);
  return "problem" in read ? { problem: `the body does not parse: ${read.problem}` } : value;
}

/**
 * Builds the scenario, starts what is live, runs it, and gives back the trace.
 *
 * `files` is the model as the page has it, which is the same text every other route is computed
 * against — so a send runs against what is on screen rather than against a re-read of the disk that
 * may have moved on.
 */
export async function runOnce(
  files: readonly { readonly path: string; readonly source: string }[],
  root: string,
  request: RunRequest,
): Promise<RunOutcome> {
  const at = request.message.lastIndexOf(".");
  if (at < 0) return refused(`\`${request.message}\` is not a qualified name`);
  const pkg = request.message.slice(0, at);

  const body = literal(request.body);
  if (typeof body !== "string") return refused(body.problem);

  const step = [
    `  at 0s publish ${request.message}${request.as === undefined ? "" : ` as ${request.as}`}`,
    ...(request.claims === undefined ? [] : [`    with claims ${JSON.stringify(request.claims)}`]),
    ...(request.envelope === undefined ? [] : [`    with envelope ${JSON.stringify(request.envelope)}`]),
    // Indented line by line, so a multi-line body from the composer still reads as this step's.
    `    ${body.split("\n").join("\n    ")}`,
    `  advance ${Math.max(1, Math.round((request.advanceMs ?? 60_000) / 1000))}s`,
  ].join("\n");

  // Named so it is recognisable in a trace and in an error, and distinct from anything on disk.
  const file = {
    path: "spider.send.7k",
    source: `scenarios for ${pkg}\n\nscenario Send {\n  seed ${request.seed ?? 1}\n${step}\n}\n`,
  };

  const workspace = buildWorkspace([...files, file]);
  const broken = workspace.diagnostics.filter(
    (d: Diagnostic) => d.severity === "error" && d.span.file === file.path,
  );
  if (broken.length > 0) {
    // Only this file's errors. A model with its own errors is still worth sending into — that is the
    // half-drawn state the language is explicit about — and a run refused because something
    // unrelated does not resolve would be refusing the case this exists for.
    return refused(...broken.map((d) => d.message));
  }

  const parsed = workspace.scenarios.find((s) => s.file === file.path);
  const scenario = parsed?.scenarios[0];
  if (parsed === undefined || scenario === undefined) {
    return refused("the step did not parse into a scenario");
  }

  const said: string[] = [];
  const hosts = await readHosts(join(root, ".7k", HOSTS));
  const wanted = request.live ?? [...hosts.hosts.keys()];
  const started = await startHosts(hosts, wanted, { log: (line) => said.push(line.trimEnd()) });

  try {
    const result = await runScenario(workspace.model, parsed, scenario, { live: started.live });
    return {
      status: result.status,
      trace: result.trace.all(),
      problems: [...hosts.problems, ...result.errors],
      unstarted: started.problems,
      ran: [...started.live.keys()],
      said,
    };
  } finally {
    await started.close();
  }
}
