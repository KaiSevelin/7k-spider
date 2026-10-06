/**
 * Regenerates the committed traces, one per example workspace.
 *
 * A script rather than a shell pipeline, for three reasons: the sandbox CLI prints diagnostics on the
 * same stream as the trace, so the NDJSON has to be filtered out of it; redirection is not portable
 * between a task on Windows and one anywhere else; and a generator that does not check what it wrote is
 * how a stale fixture gets committed.
 *
 * The sandbox is a sibling checkout rather than a dependency, so its absence is a clear message and not
 * a stack trace.
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTrace, validateTrace } from "@sevenk/core";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const sandbox = resolve(root, "..", "7k-sandbox");

/** Every workspace with scenarios worth replaying. One entry per committed trace. */
const TRACES = [
  {
    scenario: join(root, "examples", "handover.scenario.7k"),
    out: join(root, "examples", "handover.ndjson"),
    label: "examples/handover.ndjson",
  },
  {
    scenario: join(root, "samples", "ticketing", "resolution.scenario.7k"),
    out: join(root, "samples", "ticketing", "resolution.ndjson"),
    label: "samples/ticketing/resolution.ndjson",
  },
  {
    scenario: join(root, "samples", "ecommerce", "fulfilment.scenario.7k"),
    out: join(root, "samples", "ecommerce", "fulfilment.ndjson"),
    label: "samples/ecommerce/fulfilment.ndjson",
  },
] as const;

if (!existsSync(join(sandbox, "src", "cli.ts"))) {
  process.stderr.write(
    `no sandbox at ${sandbox}\n` +
      "The traces are committed, so the demos work without one. To regenerate them, check out\n" +
      "https://github.com/KaiSevelin/7k-sandbox beside this repository.\n",
  );
  process.exit(1);
}

const run = async (scenario: string): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((done) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(sandbox, "src", "cli.ts"), "trace", scenario, "--ndjson"],
      { cwd: sandbox, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

let failed = false;

for (const { scenario, out, label } of TRACES) {
  const { code, stdout, stderr } = await run(scenario);

  // The CLI prints the model's own diagnostics alongside the trace, so the NDJSON is the lines that are
  // NDJSON. Everything else is for a person.
  const lines = stdout.split("\n").filter((l) => l.startsWith("{"));

  if (lines.length === 0) {
    process.stderr.write(`${label}: no trace came out (exit ${code})\n${stdout}${stderr}`);
    failed = true;
    continue;
  }

  const text = `${lines.join("\n")}\n`;

  // Checked before it is written: a generator that does not validate its own output is how a stale or
  // malformed fixture gets committed and believed.
  const { events, problems } = readTrace(text);
  const invalid = validateTrace(events);
  if (problems.length > 0 || invalid.length > 0) {
    for (const p of problems) process.stderr.write(`  line ${p.line ?? "?"}: ${p.message}\n`);
    for (const p of invalid) process.stderr.write(`  ${p.message}\n`);
    process.stderr.write(`${label}: does not satisfy the trace format, so it was not written\n`);
    failed = true;
    continue;
  }

  writeFileSync(out, text, "utf-8");
  const runs = new Set(events.map((e) => e.run));
  process.stdout.write(`${label}: ${events.length} events, ${runs.size} runs, 0 problems\n`);
}

if (failed) process.exit(1);
