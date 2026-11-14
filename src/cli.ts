#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./adapters/inbound/cli/parseArgs.js";
import { createRuntime } from "./composition/createRuntime.js";
import type { CreateRuntimeOptions } from "./composition/createRuntime.js";
import type { Runtime } from "./composition/createRuntime.js";

const EXIT_REFUSE = 2;

export interface RunCliOptions {
  readonly argv?: readonly string[];
  readonly cwd?: string;
  /** Override composition (tests inject fakes). Default: createRuntime({ cwd }). */
  readonly runtime?: Runtime;
  readonly createRuntimeOptions?: CreateRuntimeOptions;
}

/**
 * Parse flags, run the mutation session, return the process exit code (ADR-011).
 * Refuse / parse errors → stderr + exit 2. Terminal/JSON reporting is via ReportPort.
 */
export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const cwd = options.cwd ?? process.cwd();

  let parsed;
  try {
    parsed = parseArgs(options.argv ?? process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return EXIT_REFUSE;
  }

  const runtime =
    options.runtime ??
    createRuntime({
      cwd,
      ...options.createRuntimeOptions,
    });

  const result = await runtime.runMutationSession.execute({
    cwd,
    mutateGlob: parsed.mutateGlob,
    jsonPath: parsed.jsonPath,
    timeoutMs: parsed.timeoutMs,
    includeUntracked: parsed.includeUntracked,
    verbose: parsed.verbose,
  });

  return result.exitCode;
}

async function main(): Promise<void> {
  try {
    const code = await runCli();
    process.exit(code);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(EXIT_REFUSE);
  }
}

/** True when this file is the process entry (incl. npm bin symlink → dist/cli.js). */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry == null) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    const base = path.basename(entry);
    return base === "cli.js" || base === "cli.ts" || base === "puca";
  }
}

if (isDirectRun()) {
  void main();
}
