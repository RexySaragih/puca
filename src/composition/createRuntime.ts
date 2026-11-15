import { FileHashCache } from "../adapters/outbound/cache/FileHashCache.js";
import {
  FakeMutatorEngine,
  FakeTestRunner,
  InMemoryFiles,
  InMemorySourceLocator,
  RecordingReport,
} from "../adapters/outbound/memory/index.js";
import { NodeWorkspaceFiles } from "../adapters/outbound/fs/NodeWorkspaceFiles.js";
import { GitDiffLocator } from "../adapters/outbound/git/GitDiffLocator.js";
import { JestTestRunner } from "../adapters/outbound/jest/JestTestRunner.js";
import { NapiMutatorEngine } from "../adapters/outbound/napi/NapiMutatorEngine.js";
import { CompositeReport } from "../adapters/outbound/report/CompositeReport.js";
import { HtmlFile } from "../adapters/outbound/report/HtmlFile.js";
import { SarifFile } from "../adapters/outbound/report/SarifFile.js";
import { SchemaJsonFile } from "../adapters/outbound/report/SchemaJsonFile.js";
import { StdioReport } from "../adapters/outbound/report/StdioReport.js";
import { PooledVitestTestRunner } from "../adapters/outbound/vitest/PooledVitestTestRunner.js";
import { VitestTestRunner } from "../adapters/outbound/vitest/VitestTestRunner.js";
import type { RunMutationSession } from "../application/ports/inbound/RunMutationSession.js";
import type { CachePort } from "../application/ports/outbound/CachePort.js";
import type { MutatorEnginePort } from "../application/ports/outbound/MutatorEnginePort.js";
import type { ReportPort } from "../application/ports/outbound/ReportPort.js";
import type { SourceLocatorPort } from "../application/ports/outbound/SourceLocatorPort.js";
import type { TestRunnerPort } from "../application/ports/outbound/TestRunnerPort.js";
import type { WorkspaceFilesPort } from "../application/ports/outbound/WorkspaceFilesPort.js";
import { RunMutationSessionUseCase } from "../application/use-cases/RunMutationSessionUseCase.js";

export interface CreateRuntimeOptions {
  readonly useFakes?: boolean;
  /** Workspace root for file / locator adapters (defaults to process.cwd()). */
  readonly cwd?: string;
  /**
   * Parallel workers (ADR-016). Default 1 → VitestTestRunner.
   * N>=2 → PooledVitestTestRunner (vitest only).
   * Jest (ADR-037) always forces workers=1.
   */
  readonly workers?: number;
  /** Test runner: vitest (default) | jest (Wave D / ADR-037). */
  readonly runner?: "vitest" | "jest";
}

export interface Runtime {
  readonly runMutationSession: RunMutationSession;
  readonly files: WorkspaceFilesPort;
  readonly mutator: MutatorEnginePort;
  readonly testRunner: TestRunnerPort;
  readonly sourceLocator: SourceLocatorPort;
  readonly report: ReportPort;
  readonly cache: CachePort;
}

/**
 * Composition root: the only place prod vs memory adapters are chosen.
 * `useFakes: true` → createTestRuntime() (all-memory adapters).
 * Default / false → NodeWorkspaceFiles, GitDiffLocator, NapiMutatorEngine,
 * VitestTestRunner (workers===1) or PooledVitestTestRunner (workers>=2),
 * or JestTestRunner when runner==="jest" (always single-worker),
 * StdioReport + SchemaJsonFile + SarifFile + HtmlFile.
 */
export function createRuntime(options: CreateRuntimeOptions = {}): Runtime {
  if (options.useFakes === true) {
    return createTestRuntime(options.cwd ?? process.cwd());
  }
  const runner = options.runner ?? "vitest";
  // ADR-037: Jest has no pool — soft-force workers=1 at composition.
  const workers = runner === "jest" ? 1 : (options.workers ?? 1);
  return createProductionRuntime(
    options.cwd ?? process.cwd(),
    workers,
    runner,
  );
}

export function createTestRuntime(cwd: string = process.cwd()): Runtime {
  const mutator = new FakeMutatorEngine();
  const testRunner = new FakeTestRunner();
  const sourceLocator = new InMemorySourceLocator();
  const files = new InMemoryFiles(cwd);
  const report = new RecordingReport();
  const cache = new FileHashCache(cwd);

  const runMutationSession = new RunMutationSessionUseCase({
    mutator,
    testRunner,
    sourceLocator,
    files,
    report,
    cache,
  });

  return {
    runMutationSession,
    files,
    mutator,
    testRunner,
    sourceLocator,
    report,
    cache,
  };
}

function createProductionRuntime(
  cwd: string,
  workers: number,
  runner: "vitest" | "jest",
): Runtime {
  const files = new NodeWorkspaceFiles(cwd);
  const sourceLocator = new GitDiffLocator(files);
  const mutator = new NapiMutatorEngine();
  const testRunner: TestRunnerPort = selectTestRunner(cwd, workers, runner);
  const stdio = new StdioReport({ cwd });
  const schemaJson = new SchemaJsonFile(files, cwd);
  const sarifFile = new SarifFile(cwd);
  const htmlFile = new HtmlFile(cwd);
  const report = new CompositeReport(stdio, schemaJson, sarifFile, htmlFile);
  const cache = new FileHashCache(cwd);

  const runMutationSession = new RunMutationSessionUseCase({
    mutator,
    testRunner,
    sourceLocator,
    files,
    report,
    cache,
  });

  return {
    runMutationSession,
    files,
    mutator,
    testRunner,
    sourceLocator,
    report,
    cache,
  };
}

function selectTestRunner(
  cwd: string,
  workers: number,
  runner: "vitest" | "jest",
): TestRunnerPort {
  if (runner === "jest") {
    return new JestTestRunner({ cwd });
  }
  // ADR-016: N=1 in-process; N>=2 fork pool (ADR-013).
  if (workers >= 2) {
    return new PooledVitestTestRunner({ cwd, workers });
  }
  return new VitestTestRunner({ cwd });
}
