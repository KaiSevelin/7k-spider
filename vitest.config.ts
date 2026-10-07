import { defineConfig } from "vitest/config";

/**
 * One test file at a time.
 *
 * Most of this suite drives a real browser against a real server, and each such file starts its own
 * Chromium, its own HTTP listener and — because `serve` bundles the page in memory — its own esbuild
 * context. Run in parallel that is a handful of browsers and a handful of bundlers at once, and what
 * breaks is not a test: esbuild's shared service dies with "the service is no longer running", which
 * then fails every file that was waiting on it. The symptom names nothing that is wrong with the code.
 *
 * So the integration tests are serial. It costs wall-clock time — about a minute for the whole suite —
 * and buys a suite whose failures mean something. `testTimeout` is raised to match, since a file now
 * waits its turn as well as doing its work.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
