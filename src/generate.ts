/**
 * Generating code from the model Spider is looking at.
 *
 * Spider is a tool for looking at a model and exercising it, so generating from it is the same gesture
 * as everything else here: point at something and ask. The difference is that this one writes files
 * somebody will compile, so it is the one place where "looks right" is not enough.
 *
 * **Everything runs on the server.** Providers are Node modules and the page is a browser bundle, so the
 * page asks and this answers — exactly as `/mutate` already does for source edits. That also keeps the
 * one risky capability (loading third-party code) on one side of the wire.
 *
 * **Planning and writing are different requests.** `plan` returns the files without touching the disk,
 * which is what lets the page show what it would write before it writes anything. The CLI, a test and
 * Spider's preview are the same call.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";
import {
  compare,
  loadProviders,
  parseManifest,
  plan,
  type Freshness,
  type Manifest,
  type Provider,
  type RunResult,
} from "@sevenk/generate";
import { buildWorkspace, hasErrors, type LinkedModel } from "@sevenk/core";

/** Where a model's build manifest lives, beside its lenses. */
export const MANIFEST = "build.json";

export interface Sources {
  readonly path: string;
  readonly source: string;
}

/** What the page needs to offer a menu: who is registered, and what each one lets you adjust. */
export interface ProviderInfo {
  readonly name: string;
  readonly target: string;
  readonly layouts: readonly string[];
  readonly options: readonly unknown[];
}

export const describeProviders = (providers: ReadonlyMap<string, Provider>): ProviderInfo[] =>
  [...providers.values()]
    .map((p) => ({ name: p.name, target: p.target, layouts: p.layouts, options: p.options }))
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Loads the providers a manifest names.
 *
 * Resolved against the **model's** directory rather than Spider's, so a workspace brings its own
 * providers and two models open in turn do not have to agree about versions.
 */
export async function providersFor(
  manifest: Manifest | undefined,
  root: string,
): Promise<{ providers: Map<string, Provider>; problems: readonly string[] }> {
  const names = manifest?.providers ?? [];
  if (names.length === 0) return { providers: new Map(), problems: [] };

  // Resolved from the **model's** directory and not from wherever Spider is installed, which is the
  // rule `7k generate` already holds: a workspace brings its own providers, and two models opened in
  // turn need not agree about versions. Until this used `createRequire`, a bare specifier resolved
  // against Spider's own `node_modules` — so a provider a model registered was not found at all, and
  // the comment that used to sit here claimed otherwise.
  // `resolvePath` rather than `joinPath`, because `createRequire` demands an absolute path and the
  // root arrives as the reader typed it — `spider serve examples` makes it relative, and that threw
  // rather than resolving. It only ever threw once a model registered providers at all, so a model
  // without a manifest hid it.
  const requireFrom = createRequire(resolvePath(root, "7k.local"));
  const { providers, problems } = await loadProviders(names, async (specifier) => {
    const from = specifier.startsWith(".")
      ? resolvePath(root, specifier)
      : requireFrom.resolve(specifier);
    return import(pathToFileURL(from).href);
  });

  return { providers, problems: problems.map((p) => `${p.module}: ${p.problem}`) };
}

export interface PlanRequest {
  /** Qualified declaration names to emit. Empty means the whole system. */
  readonly only?: readonly string[];
  /** Write what can be written, with the gaps carried in the artifacts. */
  readonly draft?: boolean;
  /** Restrict the run to one entry, which is what a menu item picks. */
  readonly provider?: string;
}

const NOTHING: Readonly<Record<Freshness, number>> = { new: 0, same: 0, changed: 0 };

export interface PlanOutcome {
  readonly ok: boolean;
  readonly files: readonly {
    path: string;
    content: string;
    provider: string;
    draft: boolean;
    from: readonly string[];
    freshness: Freshness;
  }[];
  /** How many of each, so a caller can say "3 differ" without counting. */
  readonly drift: Readonly<Record<Freshness, number>>;
  readonly refusals: readonly { provider: string; at: string; declared: string; because: string }[];
  readonly problems: readonly string[];
}

/**
 * Plans a run over the model Spider has open.
 *
 * `only` arrives as a list of qualified names rather than a selector, because the page's own gesture is a
 * set of nodes. A selector would be a second way of saying the same thing and would lose the distinction
 * between "these three" and "everything matching a pattern that currently happens to be these three".
 */
export async function planFor(
  files: readonly Sources[],
  root: string,
  request: PlanRequest,
): Promise<PlanOutcome> {
  const workspace = buildWorkspace(files.map((f) => ({ path: f.path, source: f.source })));
  if (hasErrors(workspace.diagnostics)) {
    // The same rule `7k project` already holds: generation presupposes a model that checks.
    return {
      ok: false,
      files: [],
      drift: NOTHING,
      refusals: [],
      problems: ["the model does not check out, so nothing was generated"],
    };
  }

  const text = await readFile(joinPath(root, ".7k", MANIFEST), "utf-8").catch(() => undefined);
  if (text === undefined) {
    return {
      ok: false,
      files: [],
      drift: NOTHING,
      refusals: [],
      problems: [`no \`.7k/${MANIFEST}\` beside this model, so no providers are registered`],
    };
  }

  const { manifest, problems: manifestProblems } = parseManifest(text, MANIFEST);
  if (manifest === undefined) {
    return {
      ok: false,
      files: [],
      drift: NOTHING,
      refusals: [],
      problems: manifestProblems.map((p) => `${p.at}: ${p.problem}`),
    };
  }

  const { providers, problems: loadProblems } = await providersFor(manifest, root);

  const result = plan(workspace.model as LinkedModel, narrow(manifest, request), {
    providers,
    ...(request.draft === true ? { draft: true } : {}),
  });

  // Compared against what is there, which is what turns a preview into a diff worth reading.
  const base = resolvePath(root, manifest.out);
  const drift = await compare(result.files, (path) =>
    readFile(resolvePath(base, path), "utf-8").catch(() => undefined),
  );
  const compared = drift.files.map((one) => ({ ...one.file, freshness: one.freshness }));

  return {
    ok: result.ok && loadProblems.length === 0,
    files: compared,
    drift: drift.counts,
    refusals: result.refusals.map((r) => ({
      provider: r.provider,
      at: r.refusal.at,
      declared: r.refusal.declared,
      because: r.refusal.because,
    })),
    problems: [...loadProblems, ...result.problems.map((p) => `${p.at}: ${p.problem}`)],
  };
};

/**
 * The manifest, narrowed to what was asked for.
 *
 * A right click on three nodes is not a new manifest, it is the committed one with its selection
 * replaced — so the options, rules and names a workspace agreed on still apply. Anything else would make
 * "generate this one" produce different code from "generate everything", which is the one thing a
 * generator must never do.
 */
function narrow(manifest: Manifest, request: PlanRequest): Manifest {
  const entries = manifest.emit.filter(
    (e) => request.provider === undefined || e.provider === request.provider,
  );

  if (request.only === undefined || request.only.length === 0) {
    return { ...manifest, emit: entries };
  }

  // `any:` matches a qualified name whatever kind it is, which is what a set of clicked nodes is.
  const only = request.only.map((qname) => `any:${qname}`);
  return {
    ...manifest,
    emit: entries.flatMap((entry) => only.map((selector) => ({ ...entry, only: selector }))),
  };
}

export type { RunResult };
