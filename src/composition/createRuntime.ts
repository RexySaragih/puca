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
import { SchemaJsonFile } from "../adapters/outbound/report/SchemaJsonFile.js";
import { StdioReport } from "../adapters/outbound/report/StdioReport.js";
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
 * VitestTestRunner, StdioReport + SchemaJsonFile.
 */
export function createRuntime(options: CreateRuntimeOptions = {}): Runtime {
  if (options.useFakes === true) {
    return createTestRuntime(options.cwd ?? process.cwd());
  }
  return createProductionRuntime(options.cwd ?? process.cwd());
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

function createProductionRuntime(cwd: string): Runtime {
  const files = new NodeWorkspaceFiles(cwd);
  const sourceLocator = new GitDiffLocator(files);
  const mutator = new NapiMutatorEngine();
  const testRunner = new VitestTestRunner({ cwd });
  const stdio = new StdioReport({ cwd });
  const schemaJson = new SchemaJsonFile(files, cwd);
  const report = new CompositeReport(stdio, schemaJson);

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
