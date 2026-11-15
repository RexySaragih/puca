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
  collectImportGraph,
  type VitestGraphHost,
} from "./collectImportGraph.js";
import {
  clearRamBuffer,
  normalizeModulePath,
  pucaRamPlugin,
  setRamBuffer,
} from "./pucaRamPlugin.js";
import {
  buildReverseMap,
  type SpecImportGraph,
} from "./reverseMap.js";
import {
  type CreateVitestFn,
  PucaRefuseError,
  type ProjectVitest,
  resolveProjectVitest,
} from "./resolveProjectVitest.js";

const SESSION_ID = "vitest-session";
const DEFAULT_TEST_TIMEOUT_MS = 5000;

/** createVitest options locked by AC4 / ADR-004 (+ bail for first failure). */
export const VITEST_SESSION_INLINE_OPTIONS = {
  watch: false,
  fileParallelism: false,
  maxWorkers: 1,
  isolate: true,
  coverage: { enabled: false },
  bail: 1,
  /** Empty reporters avoid ctx.logger crashes under programmatic createVitest. */
  reporters: [] as string[],
  /**
   * Disk module cache would serve pre-mutant transforms and skip the RAM plugin.
   * Keep false so invalidateFile + overlay stay coherent (R1 / SC-118).
   */
  fsModuleCache: false,
} as const;

export interface VitestTestModuleLike {
  ok(): boolean;
  readonly moduleId?: string;
  children: {
    allTests(state?: string): Iterable<{ fullName: string; result(): { state: string } }>;
  };
}

export interface VitestRunResultLike {
  readonly testModules: readonly VitestTestModuleLike[];
  readonly unhandledErrors: readonly unknown[];
}

export interface VitestLike extends VitestGraphHost {
  readonly config?: {
    readonly browser?: { readonly enabled?: boolean } | boolean;
    readonly testTimeout?: number;
    readonly globalSetup?: readonly string[] | string;
  };
  invalidateFile?(filepath: string): void;
  runTestFiles?(
    filepaths: string[],
    allTestsRun?: boolean,
  ): Promise<VitestRunResultLike>;
  runTestSpecifications?(
    specifications: readonly unknown[],
    allTestsRun?: boolean,
  ): Promise<VitestRunResultLike>;
  /** Abort an in-flight run so hung workers do not block close/respawn. */
  cancelCurrentRun?(reason?: string): Promise<void>;
  close(): Promise<void>;
}

const CLOSE_CANCEL_MS = 2000;
const CLOSE_WAIT_MS = 5000;

export type CreateVitestFactory = CreateVitestFn;

export interface VitestTestRunnerOptions {
  /** Workspace root used to resolve vitest/node and as Vitest `root`. */
  readonly cwd?: string;
  /** Override resolver (tests). */
  readonly resolveVitest?: (cwd: string) => Promise<ProjectVitest>;
  /**
   * Injectable createVitest (tests / AC4).
   * When set, skips loading createVitest from the resolved module
   * (resolve still runs unless resolveVitest is also stubbed).
   */
  readonly createVitest?: CreateVitestFactory;
}

function isBrowserModeEnabled(vitest: VitestLike): boolean {
  const browser = vitest.config?.browser;
  if (browser === true) {
    return true;
  }
  if (browser != null && typeof browser === "object") {
    return browser.enabled === true;
  }
  return false;
}

/**
 * Production TestRunnerPort: Vitest session with RAM overlay plugin.
 * Sequential mutant scoring uses setBuffer → invalidateFile → runRelated.
 */
export class VitestTestRunner implements TestRunnerPort {
  private overlay: RunnerOverlay | null = null;
  private vitest: VitestLike | null = null;
  private importGraph: SpecImportGraph | null = null;
  private readonly cwd: string;
  private readonly resolveVitest: (cwd: string) => Promise<ProjectVitest>;
  private readonly createVitestOverride: CreateVitestFactory | undefined;

  constructor(options: VitestTestRunnerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.resolveVitest = options.resolveVitest ?? resolveProjectVitest;
    this.createVitestOverride = options.createVitest;
  }

  /**
   * Hook for collected SSR edges (tests / until live Vitest walk is complete).
   * Pure inversion always goes through `buildReverseMap`.
   */
  setImportGraph(graph: SpecImportGraph): void {
    this.importGraph = graph;
  }

  async startSession(overlay: RunnerOverlay): Promise<RunnerSession> {
    await this.close();
    this.overlay = overlay;
    this.importGraph = null;

    const project = await this.resolveVitest(this.cwd);
    const createVitest = this.createVitestOverride ?? project.createVitest;

    const plugin = pucaRamPlugin(overlay.buffers);
    const inlineOptions = {
      ...VITEST_SESSION_INLINE_OPTIONS,
      root: this.cwd,
    };
    const viteOverrides = {
      plugins: [plugin],
    };

    const instance = (await createVitest(
      "test",
      inlineOptions,
      viteOverrides,
    )) as VitestLike;

    this.vitest = instance;

    if (isBrowserModeEnabled(instance)) {
      await this.close();
      throw new PucaRefuseError(
        "Vitest Browser Mode (browser.enabled) is not supported by Púca",
      );
    }

    return { id: SESSION_ID };
  }

  async buildReverseMap(
    candidates: readonly AbsolutePath[],
  ): Promise<ReverseMapResult> {
    if (this.vitest == null) {
      throw new Error("VitestTestRunner.buildReverseMap requires an active session");
    }

    if (this.importGraph == null) {
      this.importGraph = await collectImportGraph(this.vitest);
    }

    const built = buildReverseMap(this.importGraph, candidates);
    return {
      relatedBySource: built.relatedBySource,
      globalSetupOnly: built.globalSetupOnly,
    };
  }

  async baseline(specs: readonly string[]): Promise<BaselineResult> {
    if (this.vitest == null || this.vitest.runTestFiles == null) {
      throw new Error("VitestTestRunner.baseline requires an active session");
    }
    if (specs.length === 0) {
      return { ok: true };
    }

    try {
      const result = await this.vitest.runTestFiles([...specs]);
      if (result.unhandledErrors.length > 0) {
        return {
          ok: false,
          output: formatUnhandledErrors(result.unhandledErrors),
        };
      }
      const failures = collectFailureLines(result);
      if (failures.length > 0) {
        return { ok: false, output: failures.join("\n") };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      };
    }
  }

  setBuffer(file: AbsolutePath, source: string | null): void {
    if (this.overlay == null) {
      throw new Error("VitestTestRunner.setBuffer requires an active session");
    }
    setRamBuffer(this.overlay.buffers, file, source);
  }

  invalidateFile(file: AbsolutePath): void {
    if (this.vitest == null) {
      throw new Error("VitestTestRunner.invalidateFile requires an active session");
    }
    this.vitest.invalidateFile?.(file);
  }

  getTestTimeoutMs(): number {
    return this.vitest?.config?.testTimeout ?? DEFAULT_TEST_TIMEOUT_MS;
  }

  async runRelated(mutant: MutantRunRequest): Promise<RelatedRunResult> {
    if (this.vitest == null || this.vitest.runTestFiles == null) {
      throw new Error("VitestTestRunner.runRelated requires an active session");
    }
    try {
      const result = await this.vitest.runTestFiles([...mutant.relatedSpecs]);
      // Vitest accumulates prior testModules on the session; only classify
      // modules from this relatedSpecs run (stale failures would mis-attribute killedBy).
      return classifyVitestRun(result, mutant.relatedSpecs);
    } catch (error) {
      return {
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async respawn(): Promise<RunnerSession> {
    if (this.overlay == null) {
      throw new Error("VitestTestRunner.respawn requires an active overlay");
    }
    return this.startSession(this.overlay);
  }

  async close(): Promise<void> {
    const current = this.vitest;
    this.vitest = null;
    this.importGraph = null;
    if (current != null) {
      await forceCloseVitest(current);
    }
  }

  /** Clear RAM buffer for a file (used by tests / leak proofs). */
  clearBuffer(file: AbsolutePath): void {
    if (this.overlay == null) {
      throw new Error("VitestTestRunner.clearBuffer requires an active session");
    }
    clearRamBuffer(this.overlay.buffers, file);
  }

  /**
   * Vitest `globalSetup` from the active session (ADR-017 / pool refuse).
   * Prefers root project config; falls back to top-level vitest.config.
   */
  peekGlobalSetup(): unknown {
    if (this.vitest == null) {
      return undefined;
    }
    try {
      const project = this.vitest.getRootProject();
      if (project?.config?.globalSetup != null) {
        return project.config.globalSetup;
      }
    } catch {
      // getRootProject may throw if session is mid-close.
    }
    return this.vitest.config?.globalSetup;
  }
}

function classifyVitestRun(
  result: VitestRunResultLike,
  relatedSpecs?: readonly string[],
): RelatedRunResult {
  if (result.unhandledErrors.length > 0) {
    const first = result.unhandledErrors[0];
    return {
      kind: "error",
      message: first instanceof Error ? first.message : String(first),
    };
  }

  const related =
    relatedSpecs != null
      ? new Set(relatedSpecs.map((spec) => normalizeModulePath(spec)))
      : null;

  for (const mod of result.testModules) {
    if (mod.ok()) {
      continue;
    }
    if (related != null) {
      const moduleId =
        mod.moduleId != null ? normalizeModulePath(mod.moduleId) : "";
      // R4-M1: empty moduleId on a failure is ambiguous — treat as kill, not skip
      // (skipping would mis-attribute Survived). Named modules outside relatedSpecs
      // are ignored so stale prior-run modules on the keep-alive session do not leak.
      if (moduleId.length > 0 && !related.has(moduleId)) {
        continue;
      }
    }
    for (const test of mod.children.allTests("failed")) {
      return {
        kind: "failed",
        failingTestId: test.fullName,
      };
    }
    return { kind: "failed" };
  }

  return { kind: "passed" };
}

function collectFailureLines(result: VitestRunResultLike): string[] {
  const lines: string[] = [];
  for (const mod of result.testModules) {
    if (mod.ok()) {
      continue;
    }
    const fileLabel = mod.moduleId ?? "unknown";
    for (const test of mod.children.allTests("failed")) {
      lines.push(`FAIL  ${fileLabel} > ${test.fullName}`);
    }
    if (lines.length === 0) {
      lines.push(`FAIL  ${fileLabel}`);
    }
  }
  return lines;
}

function formatUnhandledErrors(errors: readonly unknown[]): string {
  return errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .join("\n");
}

/**
 * Cancel hung workers, then close. Vitest's first pool.cancel is graceful
 * (`force: false`) and will not SIGKILL a `while (true)` mutant; a second
 * cancel sets force and tears the fork down (SC-109 Timeout → respawn).
 */
async function forceCloseVitest(vitest: VitestLike): Promise<void> {
  try {
    await forceCancelHungWorkers(vitest);
  } catch {
    // Cancel best-effort; proceed to close.
  }
  try {
    await raceMs(vitest.close(), CLOSE_WAIT_MS);
  } catch {
    // Abandoned instance — next startSession creates a fresh Vitest.
  }
}

interface VitestPoolLike {
  cancel(): Promise<void>;
}

async function forceCancelHungWorkers(vitest: VitestLike): Promise<void> {
  const pool = (vitest as { pool?: VitestPoolLike }).pool;
  if (pool != null && typeof pool.cancel === "function") {
    // First call marks cancelling; second call force-stops active workers.
    void pool.cancel().catch(() => undefined);
    await raceMs(pool.cancel(), CLOSE_CANCEL_MS);
    return;
  }
  if (vitest.cancelCurrentRun != null) {
    void vitest.cancelCurrentRun("puca-timeout").catch(() => undefined);
    await raceMs(vitest.cancelCurrentRun("puca-timeout"), CLOSE_CANCEL_MS);
  }
}

function raceMs(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(ms)}ms`));
    }, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
