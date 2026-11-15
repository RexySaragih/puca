import { fork, type ChildProcess } from "node:child_process";
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
  type JestRunCliResult,
  type ProjectJest,
  resolveJestTestTimeoutMs,
  resolveProjectJest,
} from "./resolveProjectJest.js";
import { scanJestRelated } from "./scanJestRelated.js";

const SESSION_ID = "jest-session";
const DEFAULT_TEST_TIMEOUT_MS = 5000;
const CHILD_WALL_MS = 120_000;

const here = path.dirname(fileURLToPath(import.meta.url));
const TRANSFORMER_PATH = path.join(here, "pucaJestTransformer.cjs");
const CHILD_MAIN_PATH = path.join(here, "jestChildMain.cjs");

export interface JestTestRunnerOptions {
  /** Workspace root used to resolve jest and as Jest root. */
  readonly cwd?: string;
  /** Override resolver (tests). */
  readonly resolveJest?: (cwd: string) => ProjectJest;
  /** Override child entry (tests). */
  readonly childMainPath?: string;
}

/**
 * Production TestRunnerPort for `--runner jest` (ADR-037).
 * Single-worker only: RAM overlay via Jest transformer in an **isolated child**
 * per invoke (R5-Jest). In-process runCLI reused transformed modules after
 * baseline, so mutants incorrectly Survived — child isolation fixes that.
 * Never writes mutant sources to disk.
 */
export class JestTestRunner implements TestRunnerPort {
  private overlay: RunnerOverlay | null = null;
  private relatedBySource: Map<string, readonly string[]> | null = null;
  private allSpecs: readonly string[] = [];
  private testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS;
  private sessionActive = false;
  private activeChild: ChildProcess | null = null;
  private readonly cwd: string;
  private readonly resolveJest: (cwd: string) => ProjectJest;
  private readonly childMainPath: string;

  constructor(options: JestTestRunnerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.resolveJest = options.resolveJest ?? resolveProjectJest;
    this.childMainPath = options.childMainPath ?? CHILD_MAIN_PATH;
  }

  async startSession(overlay: RunnerOverlay): Promise<RunnerSession> {
    await this.close();
    this.overlay = overlay;
    this.relatedBySource = null;
    this.allSpecs = [];

    // Resolve early so missing jest fails closed before scoring.
    this.resolveJest(this.cwd);
    this.testTimeoutMs =
      (await resolveJestTestTimeoutMs(this.cwd)) ?? DEFAULT_TEST_TIMEOUT_MS;
    this.sessionActive = true;

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
    if (!this.sessionActive) {
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
  }

  invalidateFile(_file: AbsolutePath): void {
    // Child process isolation — no parent-side module graph to invalidate.
  }

  getTestTimeoutMs(): number {
    return this.testTimeoutMs;
  }

  async runRelated(mutant: MutantRunRequest): Promise<RelatedRunResult> {
    if (!this.sessionActive) {
      throw new Error("JestTestRunner.runRelated requires an active session");
    }
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
    this.sessionActive = false;
    this.relatedBySource = null;
    this.allSpecs = [];
    this.killActiveChild();
  }

  private killActiveChild(): void {
    const child = this.activeChild;
    if (child == null) {
      return;
    }
    this.activeChild = null;
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }

  /** Clear RAM buffer for a file (tests / leak proofs). */
  clearBuffer(file: AbsolutePath): void {
    if (this.overlay == null) {
      throw new Error("JestTestRunner.clearBuffer requires an active session");
    }
    clearRamBuffer(this.overlay.buffers, file);
  }

  private async invokeJest(
    specs: readonly string[],
  ): Promise<JestRunCliResult> {
    const uniqueSpecs = [...new Set(specs.map((s) => normalizeModulePath(s)))];
    const buffers = serializeBuffers(this.overlay?.buffers);

    return new Promise((resolve, reject) => {
      this.killActiveChild();
      const child: ChildProcess = fork(this.childMainPath, [], {
        cwd: this.cwd,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { ...process.env, FORCE_COLOR: "0" },
      });
      this.activeChild = child;
      let settled = false;

      const settle = (fn: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (this.activeChild === child) {
          this.activeChild = null;
        }
        fn();
      };

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() => reject(new Error("Jest child timed out")));
      }, CHILD_WALL_MS);

      child.on("error", (error) => {
        settle(() => reject(error));
      });

      child.on("message", (msg: unknown) => {
        const payload = msg as {
          type?: string;
          ok?: boolean;
          results?: JestRunCliResult["results"];
          error?: string;
        };
        if (payload.type !== "result") {
          return;
        }
        if (payload.ok === true && payload.results != null) {
          const results = payload.results;
          settle(() => resolve({ results }));
        } else {
          settle(() =>
            reject(new Error(payload.error ?? "Jest child failed")),
          );
        }
      });

      child.on("exit", (code, signal) => {
        if (settled) {
          return;
        }
        settle(() =>
          reject(
            new Error(
              `Jest child exited before result (code=${String(code)}, signal=${String(signal)})`,
            ),
          ),
        );
      });

      child.send({
        type: "run",
        cwd: this.cwd,
        specs: uniqueSpecs,
        buffers,
        testTimeoutMs: this.testTimeoutMs,
        transformerPath: TRANSFORMER_PATH,
      });
    });
  }
}

function serializeBuffers(
  buffers: Map<string, string | null> | undefined,
): Array<[string, string | null]> {
  if (buffers == null) {
    return [];
  }
  const out: Array<[string, string | null]> = [];
  for (const [file, source] of buffers) {
    out.push([file, source]);
  }
  return out;
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
