import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BaselineResult,
  MutantRunRequest,
  RelatedRunResult,
  ReverseMapResult,
  RunnerOverlay,
  RunnerSession,
  TestRunnerPort,
} from "../../../application/ports/outbound/TestRunnerPort.js";
import type { AbsolutePath } from "../../../domain/mutant.js";
import {
  clearRamBuffer,
  normalizeModulePath,
  setRamBuffer,
} from "../vitest/pucaRamPlugin.js";
import {
  type JestRunCli,
  type JestRunCliResult,
  type ProjectJest,
  resolveProjectJest,
} from "./resolveProjectJest.js";
import { scanJestRelated } from "./scanJestRelated.js";

const SESSION_ID = "jest-session";
const DEFAULT_TEST_TIMEOUT_MS = 5000;

const TRANSFORMER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "pucaJestTransformer.cjs",
);

export interface JestTestRunnerOptions {
  /** Workspace root used to resolve jest and as Jest root. */
  readonly cwd?: string;
  /** Override resolver (tests). */
  readonly resolveJest?: (cwd: string) => ProjectJest;
}

/**
 * Production TestRunnerPort for `--runner jest` (ADR-037).
 * Single-worker only: RAM overlay via a Jest transformer + globalThis buffer map.
 * Never writes mutant sources to disk (no .puca-tmp / .stryker-tmp).
 */
export class JestTestRunner implements TestRunnerPort {
  private overlay: RunnerOverlay | null = null;
  private runCLI: JestRunCli | null = null;
  private relatedBySource: Map<string, readonly string[]> | null = null;
  private allSpecs: readonly string[] = [];
  private testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS;
  private readonly cwd: string;
  private readonly resolveJest: (cwd: string) => ProjectJest;

  constructor(options: JestTestRunnerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.resolveJest = options.resolveJest ?? resolveProjectJest;
  }

  async startSession(overlay: RunnerOverlay): Promise<RunnerSession> {
    await this.close();
    this.overlay = overlay;
    this.relatedBySource = null;
    this.allSpecs = [];

    const project = this.resolveJest(this.cwd);
    this.runCLI = project.runCLI;
    publishBuffers(overlay.buffers);

    return { id: SESSION_ID };
  }

  async buildReverseMap(
    candidates: readonly AbsolutePath[],
  ): Promise<ReverseMapResult> {
    if (this.overlay == null) {
      throw new Error("JestTestRunner.buildReverseMap requires an active session");
    }
    const scanned = await scanJestRelated(this.cwd, candidates);
    this.relatedBySource = scanned.relatedBySource;
    this.allSpecs = scanned.allSpecs;
    return {
      relatedBySource: scanned.relatedBySource,
      globalSetupOnly: new Set(),
    };
  }

  async baseline(specs: readonly string[]): Promise<BaselineResult> {
    if (this.runCLI == null) {
      throw new Error("JestTestRunner.baseline requires an active session");
    }
    if (specs.length === 0) {
      return { ok: true };
    }
    try {
      const result = await this.invokeJest(specs);
      if (result.results.success) {
        return { ok: true };
      }
      return {
        ok: false,
        output: formatJestFailures(result),
      };
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  setBuffer(file: AbsolutePath, source: string | null): void {
    if (this.overlay == null) {
      throw new Error("JestTestRunner.setBuffer requires an active session");
    }
    setRamBuffer(this.overlay.buffers, file, source);
    publishBuffers(this.overlay.buffers);
  }

  invalidateFile(_file: AbsolutePath): void {
    // Each runCLI is a fresh Jest process graph with cache:false;
    // transformer getCacheKey already keys on active buffer content.
  }

  getTestTimeoutMs(): number {
    return this.testTimeoutMs;
  }

  async runRelated(mutant: MutantRunRequest): Promise<RelatedRunResult> {
    if (this.runCLI == null) {
      throw new Error("JestTestRunner.runRelated requires an active session");
    }
    publishBuffers(this.overlay?.buffers);
    try {
      const result = await this.invokeJest(mutant.relatedSpecs);
      return classifyJestRun(result, mutant.relatedSpecs);
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async respawn(): Promise<RunnerSession> {
    if (this.overlay == null) {
      throw new Error("JestTestRunner.respawn requires an active overlay");
    }
    return this.startSession(this.overlay);
  }

  async close(): Promise<void> {
    this.runCLI = null;
    this.relatedBySource = null;
    this.allSpecs = [];
    clearPublishedBuffers();
  }

  /** Clear RAM buffer for a file (tests / leak proofs). */
  clearBuffer(file: AbsolutePath): void {
    if (this.overlay == null) {
      throw new Error("JestTestRunner.clearBuffer requires an active session");
    }
    clearRamBuffer(this.overlay.buffers, file);
    publishBuffers(this.overlay.buffers);
  }

  private async invokeJest(
    specs: readonly string[],
  ): Promise<JestRunCliResult> {
    if (this.runCLI == null) {
      throw new Error("JestTestRunner.invokeJest requires an active session");
    }
    const uniqueSpecs = [...new Set(specs.map((s) => normalizeModulePath(s)))];
    const argv: Record<string, unknown> = {
      _: uniqueSpecs,
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
      testTimeout: this.testTimeoutMs,
      // Inline config so the RAM transformer is always registered (no disk mutant).
      config: JSON.stringify({
        rootDir: this.cwd,
        maxWorkers: 1,
        transform: {
          "^.+\\.[cm]?[jt]sx?$": TRANSFORMER_PATH,
        },
      }),
    };

    return this.runCLI(argv, [this.cwd]);
  }
}

function publishBuffers(
  buffers: Map<string, string | null> | undefined,
): void {
  (
    globalThis as { __PUCA_JEST_BUFFERS__?: Map<string, string | null> }
  ).__PUCA_JEST_BUFFERS__ = buffers;
}

function clearPublishedBuffers(): void {
  delete (globalThis as { __PUCA_JEST_BUFFERS__?: Map<string, string | null> })
    .__PUCA_JEST_BUFFERS__;
}

function classifyJestRun(
  result: JestRunCliResult,
  relatedSpecs?: readonly string[],
): RelatedRunResult {
  const related =
    relatedSpecs != null
      ? new Set(relatedSpecs.map((spec) => normalizeModulePath(spec)))
      : null;

  for (const suite of result.results.testResults) {
    if (related != null) {
      const suitePath = normalizeModulePath(suite.testFilePath);
      if (!related.has(suitePath)) {
        continue;
      }
    }
    for (const test of suite.testResults) {
      if (test.status === "failed") {
        return {
          kind: "failed",
          failingTestId: test.fullName,
        };
      }
    }
  }

  if (!result.results.success && result.results.numFailedTests > 0) {
    return { kind: "failed" };
  }

  return { kind: "passed" };
}

function formatJestFailures(result: JestRunCliResult): string {
  const lines: string[] = [];
  for (const suite of result.results.testResults) {
    for (const test of suite.testResults) {
      if (test.status !== "failed") {
        continue;
      }
      lines.push(`FAIL  ${suite.testFilePath} > ${test.fullName}`);
    }
  }
  if (lines.length === 0 && result.results.numFailedTests > 0) {
    lines.push("FAIL  (jest baseline)");
  }
  return lines.join("\n");
}
