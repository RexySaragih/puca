import type { AbsolutePath } from "../../../domain/mutant.js";

/**
 * Unexported seam (ADR-010): not part of the published CLI API.
 * Prod: VitestTestRunner; mem: FakeTestRunner.
 */

export interface RunnerOverlay {
  readonly buffers: Map<string, string | null>;
}

export interface RunnerSession {
  readonly id: string;
}

export interface BaselineResult {
  readonly ok: boolean;
  readonly output?: string;
}

export interface RelatedRunResult {
  readonly kind: "passed" | "failed" | "timeout" | "error";
  readonly failingTestId?: string;
  readonly message?: string;
}

export interface MutantRunRequest {
  readonly file: AbsolutePath;
  readonly mutatedSource: string;
  readonly relatedSpecs: readonly string[];
  /** site.id — required for pool IPC (N>=2). */
  readonly mutantId?: string;
}

/** Source → related specs; globalSetup-only set for a one-shot respawn. */
export interface ReverseMapResult {
  readonly relatedBySource: ReadonlyMap<string, readonly string[]>;
  readonly globalSetupOnly: ReadonlySet<string>;
}

export interface TestRunnerPort {
  startSession(overlay: RunnerOverlay): Promise<RunnerSession>;
  /**
   * After startSession: invert the import graph for candidate sources.
   * Pure inversion lives in adapters/outbound/vitest/reverseMap.ts.
   */
  buildReverseMap(
    candidates: readonly AbsolutePath[],
  ): Promise<ReverseMapResult>;
  baseline(specs: readonly string[]): Promise<BaselineResult>;
  /** Replace (or clear with null) the active RAM overlay for one source file. */
  setBuffer(file: AbsolutePath, source: string | null): void;
  /** Invalidate Vite module graph for file (importers included when Vitest). */
  invalidateFile(file: AbsolutePath): void;
  /**
   * Vitest `testTimeout` from the loaded session config.
   * Used for default outer timer: max(testTimeout + 2000, 7000).
   */
  getTestTimeoutMs(): number;
  /**
   * Apply the resolved outer mutant timer (CLI `--timeout` or default).
   * Pool runners must honor this for IPC hang kills; sequential runners
   * may no-op (use case races with the same value).
   */
  configureOuterTimeoutMs?(timeoutMs: number): void;
  runRelated(mutant: MutantRunRequest): Promise<RelatedRunResult>;
  /**
   * Abort an in-flight related run so a hang does not outlive the outer timer.
   * Sequential timeout path calls this before respawn.
   */
  cancelCurrentRun?(): Promise<void>;
  respawn(): Promise<RunnerSession>;
  close(): Promise<void>;
  /**
   * Pool path (N>=2): timeout kills + RSS recycles for `--verbose`.
   * Phase 1 / Fake runners omit or return 0.
   */
  readonly recycleCount?: number;
}
