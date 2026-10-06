/**
 * What F5 gives you: the four providers, registered, against the example that ships here.
 *
 * `examples/.7k/build.json` is what Spider reads to know which providers to offer, so without it the
 * Generate menu is empty and the demo shows nothing — which is what it did. This checks the committed
 * manifest against the committed model, so the demo cannot quietly stop working: a provider renamed,
 * a manifest key misspelt, or a model change one of them refuses all fail here rather than in front of
 * whoever pressed F5.
 *
 * It needs the four provider repositories beside this one, which is also what the manifest needs, so
 * the test is skipped rather than failed where they are absent. A fresh clone of Spider alone still
 * has a green suite; it just has nothing to generate with, and `/providers` says so.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { parseManifest } from "@sevenk/generate";
import { MANIFEST, planFor, providersFor, describeProviders } from "../src/generate.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLES = join(root, "examples");

/** The manifest, read the way the server reads it. */
const manifestOf = async () => {
  const text = await readFile(join(EXAMPLES, ".7k", MANIFEST), "utf-8");
  const { manifest, problems } = parseManifest(text, MANIFEST);
  expect(problems).toEqual([]);
  if (manifest === undefined) throw new Error("the demo manifest did not parse");
  return manifest;
};

const sources = async () => {
  const entries = await readdir(EXAMPLES, { withFileTypes: true });
  return Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith(".7k"))
      .map(async (e) => ({
        path: join("examples", e.name),
        source: await readFile(join(EXAMPLES, e.name), "utf-8"),
      })),
  );
};

/** Whether the provider repositories are actually installed beside this one. */
const installed = (() => {
  const from = createRequire(join(root, "7k.local"));
  try {
    for (const name of ["csharp", "sqlserver", "bicep", "node"]) from.resolve(`@sevenk/${name}`);
    return true;
  } catch {
    return false;
  }
})();

describe("the manifest the demo ships", () => {
  it("names the four providers", async () => {
    const manifest = await manifestOf();
    expect([...(manifest.providers ?? [])].sort()).toEqual([
      "@sevenk/bicep",
      "@sevenk/csharp",
      "@sevenk/node",
      "@sevenk/sqlserver",
    ]);
  });

  it("has an entry for each of them, so each has somewhere to put its output", async () => {
    const manifest = await manifestOf();
    expect(manifest.emit.map((e) => e.provider).sort()).toEqual([
      "bicep",
      "csharp",
      "node",
      "sqlserver",
    ]);
    for (const entry of manifest.emit) expect(entry.out).not.toBe("");
  });
});

describe.skipIf(!installed)("pressing F5 and asking to generate", () => {
  it("registers all four, by the same call the /providers route makes", async () => {
    const { providers, problems } = await providersFor(await manifestOf(), EXAMPLES);
    expect(problems).toEqual([]);
    expect([...providers.keys()].sort()).toEqual(["bicep", "csharp", "node", "sqlserver"]);
  });

  /**
   * The root arrives as the reader typed it, and `spider serve examples` makes it relative.
   * `createRequire` demands an absolute path, so this threw until it was resolved — and only ever
   * threw once a model registered providers, which is why no manifest hid it.
   */
  it("registers them from a relative root too, which is what the launch config passes", async () => {
    const { providers, problems } = await providersFor(await manifestOf(), "examples");
    expect(problems).toEqual([]);
    expect(providers.size).toBe(4);
  });

  it("describes each one for the menu", async () => {
    const { providers } = await providersFor(await manifestOf(), EXAMPLES);
    const described = describeProviders(providers);
    expect(described).toHaveLength(4);
    for (const info of described) {
      expect(info.name).not.toBe("");
      expect(info.target).not.toBe("");
    }
  });

  it("generates from the example model without a refusal", async () => {
    const outcome = await planFor(await sources(), EXAMPLES, {});
    expect(outcome.problems).toEqual([]);
    expect(outcome.refusals).toEqual([]);
    expect(outcome.ok).toBe(true);
  });

  it("produces artifacts from every provider, not just the one that happens to be first", async () => {
    const outcome = await planFor(await sources(), EXAMPLES, {});
    const byProvider = new Set(outcome.files.map((f) => f.provider));
    expect([...byProvider].sort()).toEqual(["bicep", "csharp", "node", "sqlserver"]);
    expect(outcome.files.length).toBeGreaterThan(20);
  });

  it("can be asked for one provider, which is what a menu item picks", async () => {
    const outcome = await planFor(await sources(), EXAMPLES, { provider: "bicep" });
    expect(outcome.ok).toBe(true);
    expect(new Set(outcome.files.map((f) => f.provider))).toEqual(new Set(["bicep"]));
  });

  /** Still Spider's rule: it shows the text and writes none of it. */
  it("writes nothing, however many providers ran", async () => {
    const before = (await readdir(EXAMPLES)).sort();
    await planFor(await sources(), EXAMPLES, {});
    expect((await readdir(EXAMPLES)).sort()).toEqual(before);
  });
});
