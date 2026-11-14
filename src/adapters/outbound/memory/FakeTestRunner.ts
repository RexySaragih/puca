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
import { buildReverseMap } from "../vitest/reverseMap.js";

const SESSION: RunnerSession = { id: "fake-session" };

/** Controllable related-run outcome; `"hang"` never settles (outer timer → Timeout). */
export type FakeRelatedBehavior = RelatedRunResult | "hang";

const DEFAULT_TEST_TIMEOUT_MS = 5000;

/**
 * Controllable test-runner seam for behavioral tests (no Vitest).
 * Configure static import edges + setup/global graphs; baselineResult drives the gate.
 */
export class FakeTestRunner implements TestRunnerPort {
  baselineResult: BaselineResult = { ok: true };
  relatedResult: RelatedRunResult = { kind: "passed" };
  readonly runRelatedCalls: MutantRunRequest[] = [];
  readonly invalidateCalls: string[] = [];
  readonly setBufferCalls: Array<{
    readonly file: AbsolutePath;
    readonly source: string | null;
  }> = [];
  respawnCount = 0;
  closed = false;
  testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS;
  recycleCount = 0;

  private importsBySpec = new Map<string, readonly string[]>();
  private setupModules: string[] = [];
  private globalSetupModules: string[] = [];
  private allSpecs: string[] = [];
  private buffers: Map<string, string | null> = new Map();
  private relatedBehaviorQueue: FakeRelatedBehavior[] = [];

  /** Spec → statically imported modules (dynamic-only edges omitted). */
  setStaticImports(
    importsBySpec: ReadonlyMap<string, readonly string[]> | Record<string, readonly string[]>,
  ): void {
    this.importsBySpec =
      importsBySpec instanceof Map
        ? new Map(importsBySpec)
        : new Map(Object.entries(importsBySpec));
  }

  setSetupModules(modules: readonly string[]): void {
    this.setupModules = [...modules];
  }

  setGlobalSetupModules(modules: readonly string[]): void {
    this.globalSetupModules = [...modules];
  }

  setAllSpecs(specs: readonly string[]): void {
    this.allSpecs = [...specs];
  }

  /** Queue per-call pass/fail/error/hang behaviors (FIFO). Exhausts → relatedResult. */
  queueRelatedBehaviors(...behaviors: FakeRelatedBehavior[]): void {
    this.relatedBehaviorQueue.push(...behaviors);
  }

  /** Active RAM buffer for a file after setBuffer (null if cleared / unset). */
  getBuffer(file: string): string | null | undefined {
    return this.buffers.get(normalizeModulePath(file));
  }

  async startSession(overlay: RunnerOverlay): Promise<RunnerSession> {
    this.closed = false;
    this.runRelatedCalls.length = 0;
    this.invalidateCalls.length = 0;
    this.setBufferCalls.length = 0;
    this.maxInFlightRelated = 0;
    this.inFlightRelated = 0;
    this.buffers = overlay.buffers;
    return SESSION;
  }

  async buildReverseMap(
    candidates: readonly AbsolutePath[],
  ): Promise<ReverseMapResult> {
    const built = buildReverseMap(
      {
        importsBySpec: this.importsBySpec,
        setupModules: this.setupModules,
        globalSetupModules: this.globalSetupModules,
        allSpecs: this.allSpecs,
      },
      candidates,
    );
    return {
      relatedBySource: built.relatedBySource,
      globalSetupOnly: built.globalSetupOnly,
    };
  }

  async baseline(_specs: readonly string[]): Promise<BaselineResult> {
    return this.baselineResult;
  }

  setBuffer(file: AbsolutePath, source: string | null): void {
    this.setBufferCalls.push({ file, source });
    setRamBuffer(this.buffers, file, source);
  }

  invalidateFile(file: AbsolutePath): void {
    this.invalidateCalls.push(file);
  }

  getTestTimeoutMs(): number {
    return this.testTimeoutMs;
  }

  /** Optional delay before resolving (tests concurrent overlap). */
  relatedDelayMs = 0;
  /** Peak overlapping runRelated calls observed. */
  maxInFlightRelated = 0;
  private inFlightRelated = 0;

  async runRelated(mutant: MutantRunRequest): Promise<RelatedRunResult> {
    this.runRelatedCalls.push(mutant);
    this.inFlightRelated += 1;
    this.maxInFlightRelated = Math.max(
      this.maxInFlightRelated,
      this.inFlightRelated,
    );
    try {
      if (this.relatedDelayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, this.relatedDelayMs);
        });
      }
      const next = this.relatedBehaviorQueue.shift();
      if (next === "hang") {
        return new Promise(() => {
          /* never settles — outer timer classifies Timeout */
        });
      }
      if (next != null) {
        return next;
      }
      return this.relatedResult;
    } finally {
      this.inFlightRelated -= 1;
    }
  }

  async respawn(): Promise<RunnerSession> {
    this.respawnCount += 1;
    return SESSION;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Test helper: clear buffer the same way the use case does after a mutant. */
  clearBuffer(file: AbsolutePath): void {
    clearRamBuffer(this.buffers, file);
  }
}
