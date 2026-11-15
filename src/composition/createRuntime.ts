import {
  FakeMutatorEngine,
  FakeTestRunner,
  InMemoryFiles,
  InMemorySourceLocator,
  RecordingReport,
} from "../adapters/outbound/memory/index.js";
import { NodeWorkspaceFiles } from "../adapters/outbound/fs/NodeWorkspaceFiles.js";
import { GitDiffLocator } from "../adapters/outbound/git/GitDiffLocator.js";
import { NapiMutatorEngine } from "../adapters/outbound/napi/NapiMutatorEngine.js";
import { CompositeReport } from "../adapters/outbound/report/CompositeReport.js";
import { SarifFile } from "../adapters/outbound/report/SarifFile.js";
import { SchemaJsonFile } from "../adapters/outbound/report/SchemaJsonFile.js";
import { StdioReport } from "../adapters/outbound/report/StdioReport.js";
import { PooledVitestTestRunner } from "../adapters/outbound/vitest/PooledVitestTestRunner.js";
import { VitestTestRunner } from "../adapters/outbound/vitest/VitestTestRunner.js";
import type { RunMutationSession } from "../application/ports/inbound/RunMutationSession.js";
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
   * N>=2 → PooledVitestTestRunner.
   */
  readonly workers?: number;
}

export interface Runtime {
  readonly runMutationSession: RunMutationSession;
  readonly files: WorkspaceFilesPort;
  readonly mutator: MutatorEnginePort;
  readonly testRunner: TestRunnerPort;
  readonly sourceLocator: SourceLocatorPort;
  readonly report: ReportPort;
}

/**
 * Composition root: the only place prod vs memory adapters are chosen.
 * `useFakes: true` → createTestRuntime() (all-memory adapters).
 * Default / false → NodeWorkspaceFiles, GitDiffLocator, NapiMutatorEngine,
 * VitestTestRunner (workers===1) or PooledVitestTestRunner (workers>=2),
 * StdioReport + SchemaJsonFile + SarifFile.
 */
export function createRuntime(options: CreateRuntimeOptions = {}): Runtime {
  if (options.useFakes === true) {
    return createTestRuntime(options.cwd ?? process.cwd());
  }
  const workers = options.workers ?? 1;
  return createProductionRuntime(options.cwd ?? process.cwd(), workers);
}

export function createTestRuntime(cwd: string = process.cwd()): Runtime {
  const mutator = new FakeMutatorEngine();
  const testRunner = new FakeTestRunner();
  const sourceLocator = new InMemorySourceLocator();
  const files = new InMemoryFiles(cwd);
  const report = new RecordingReport();

  const runMutationSession = new RunMutationSessionUseCase({
    mutator,
    testRunner,
    sourceLocator,
    files,
    report,
  });

  return {
    runMutationSession,
    files,
    mutator,
    testRunner,
    sourceLocator,
    report,
  };
}

function createProductionRuntime(cwd: string, workers: number): Runtime {
  const files = new NodeWorkspaceFiles(cwd);
  const sourceLocator = new GitDiffLocator(files);
  const mutator = new NapiMutatorEngine();
  // ADR-016: N=1 in-process; N>=2 fork pool (ADR-013).
  const testRunner: TestRunnerPort =
    workers >= 2
      ? new PooledVitestTestRunner({ cwd, workers })
      : new VitestTestRunner({ cwd });
  const stdio = new StdioReport({ cwd });
  const schemaJson = new SchemaJsonFile(files, cwd);
  const sarifFile = new SarifFile(cwd);
  const report = new CompositeReport(stdio, schemaJson, sarifFile);

  const runMutationSession = new RunMutationSessionUseCase({
    mutator,
    testRunner,
    sourceLocator,
    files,
    report,
  });

  return {
    runMutationSession,
    files,
    mutator,
    testRunner,
    sourceLocator,
    report,
  };
}
