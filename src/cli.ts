#!/usr/bin/env node

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./adapters/inbound/cli/parseArgs.js";
import { NodeWorkspaceDiscovery } from "./adapters/outbound/workspace/NodeWorkspaceDiscovery.js";
import { WorkspaceTargetResolver } from "./application/WorkspaceTargetResolver.js";
import type { PackageSessionRunner } from "./application/WorkspaceTargetResolver.js";
import type { WorkspaceDiscoveryPort } from "./application/ports/outbound/WorkspaceDiscoveryPort.js";
import type { MutationSessionInput } from "./application/ports/inbound/RunMutationSession.js";
import { EmptyWorkspaceMatchError } from "./domain/targetingErrors.js";
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
  /** Override workspace discovery (tests). Default: NodeWorkspaceDiscovery. */
  readonly workspaceDiscovery?: WorkspaceDiscoveryPort;
  /** Override per-package session runner (tests). */
  readonly runPackageSession?: PackageSessionRunner;
}

/**
 * Parse flags, run the mutation session, return the process exit code (ADR-011).
 * Refuse / parse errors → stderr + exit 2. Terminal/JSON reporting is via ReportPort.
 * With --workspace: sequential per-package sessions; exit worst-of 2>1>0 (ADR-036).
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

  const workers = resolveEffectiveWorkers(parsed.runner, parsed.workers);

  const sessionInput: MutationSessionInput = {
    cwd,
    mutateGlob: parsed.mutateGlob,
    jsonPath: parsed.jsonPath,
    timeoutMs: parsed.timeoutMs,
    includeUntracked: parsed.includeUntracked,
    verbose: parsed.verbose,
    workers,
    breakOnScore: parsed.breakOnScore,
    failOnNoCoverage: parsed.failOnNoCoverage,
    sarifPath: parsed.sarifPath,
    htmlPath: parsed.htmlPath,
    cache: parsed.cache,
    workspaceGlob: parsed.workspaceGlob,
    runner: parsed.runner,
  };

  if (parsed.workspaceGlob !== undefined) {
    return runWorkspaceCli(sessionInput, workers, options, parsed.runner);
  }

  const runtime =
    options.runtime ??
    createRuntime({
      cwd,
      workers,
      runner: parsed.runner,
      ...options.createRuntimeOptions,
    });

  const result = await runtime.runMutationSession.execute(sessionInput);
  return result.exitCode;
}

/** ADR-037 / REQ-2003: Jest is single-worker; notice + force 1 when N>1. */
function resolveEffectiveWorkers(
  runner: "vitest" | "jest",
  requested: number,
): number {
  if (runner === "jest" && requested > 1) {
    process.stderr.write(
      `Púca: Jest runner is single-worker only; forcing --workers 1 (requested ${String(requested)}).\n`,
    );
    return 1;
  }
  return requested;
}

async function runWorkspaceCli(
  sessionInput: MutationSessionInput,
  workers: number,
  options: RunCliOptions,
  runner: "vitest" | "jest" = "vitest",
): Promise<number> {
  const discovery =
    options.workspaceDiscovery ?? new NodeWorkspaceDiscovery();
  const runPackageSession: PackageSessionRunner =
    options.runPackageSession ??
    (async (packageRoot, input) => {
      const runtime = createRuntime({
        cwd: packageRoot,
        workers,
        runner,
        ...options.createRuntimeOptions,
      });
      return runtime.runMutationSession.execute(input);
    });

  const resolver = new WorkspaceTargetResolver({
    discovery,
    runPackageSession,
  });

  try {
    const result = await resolver.execute(sessionInput);
    // R4-M3: aggregate footer — per-package terminal/JSON already used each package cwd.
    if (result.message != null && result.message.length > 0) {
      process.stderr.write(`${result.message}\n`);
    }
    return result.exitCode;
  } catch (error) {
    if (error instanceof EmptyWorkspaceMatchError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_REFUSE;
    }
    throw error;
  }
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
