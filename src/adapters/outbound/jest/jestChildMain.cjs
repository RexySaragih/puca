"use strict";

/**
 * Isolated Jest scoring child (R5-Jest).
 * Parent sends one `{ type: "run", ... }` message; child runs runCLI once and exits.
 * Isolation avoids Jest reusing transformed modules from a prior baseline/mutant
 * in the same process (in-process runCLI left mutants Survived incorrectly).
 */

const { createRequire } = require("node:module");
const path = require("node:path");

function normalizeModulePath(id) {
  const fs = require("node:fs");
  const resolved = path.normalize(path.resolve(id));
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

async function main() {
  const msg = await waitForRun();
  const requireFromCwd = createRequire(path.join(msg.cwd, "package.json"));
  let runCLI;
  try {
    const jest = requireFromCwd("jest");
    runCLI = jest.runCLI;
  } catch (error) {
    process.send?.({
      type: "result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(2);
    return;
  }

  const buffers = new Map();
  for (const [file, source] of msg.buffers) {
    buffers.set(normalizeModulePath(file), source);
  }
  globalThis.__PUCA_JEST_BUFFERS__ = buffers;

  try {
    const result = await runCLI(
      {
        _: msg.specs,
        $0: "jest",
        runInBand: true,
        maxWorkers: 1,
        cache: false,
        coverage: false,
        watch: false,
        watchAll: false,
        notify: false,
        passWithNoTests: true,
        silent: true,
        verbose: false,
        testTimeout: msg.testTimeoutMs,
        config: JSON.stringify({
          rootDir: msg.cwd,
          maxWorkers: 1,
          transform: {
            "^.+\\.[cm]?[jt]sx?$": msg.transformerPath,
          },
        }),
      },
      [msg.cwd],
    );

    process.send?.({
      type: "result",
      ok: true,
      results: {
        success: result.results.success,
        numFailedTests: result.results.numFailedTests,
        numPassedTests: result.results.numPassedTests,
        numPendingTests: result.results.numPendingTests,
        numTotalTests: result.results.numTotalTests,
        testResults: result.results.testResults.map((suite) => ({
          testFilePath: suite.testFilePath,
          testResults: suite.testResults.map((test) => ({
            fullName: test.fullName,
            status: test.status,
            failureMessages: test.failureMessages ?? [],
          })),
          failureMessage: suite.failureMessage ?? null,
        })),
      },
    });
    process.exit(0);
  } catch (error) {
    process.send?.({
      type: "result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

function waitForRun() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("jestChildMain timed out waiting for run message"));
    }, 60_000);
    process.on("message", (msg) => {
      if (msg && msg.type === "run") {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
}

main().catch((error) => {
  process.send?.({
    type: "result",
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
