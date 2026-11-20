import type { SessionResult } from "../../../domain/mutant.js";

export interface MutationSessionInput {
  readonly cwd: string;
  readonly mutateGlob?: string;
  readonly jsonPath?: string;
  readonly timeoutMs?: number;
  /** Git-dirty default only. Ignored when mutateGlob is set (--mutate already walks the tree). */
  readonly includeUntracked?: boolean;
  readonly verbose?: boolean;
  /**
   * Parallel scoring workers. Default 1 = Phase 1 in-process VitestTestRunner.
   * N>=2 uses PooledVitestTestRunner (po_2a0301).
   */
  readonly workers?: number;
  /** Opt-in CI score gate (1..100). Unset when `--break-on-score` omitted. */
  readonly breakOnScore?: number;
  /** Opt-in: exit 1 when any NoCoverage mutant exists. */
  readonly failOnNoCoverage?: boolean;
  /** Opt-in SARIF output path (`--sarif`). */
  readonly sarifPath?: string;
  /** Opt-in HTML report path (`--html`). */
  readonly htmlPath?: string;
  /** Opt-in persistent cache (`--cache`). */
  readonly cache?: boolean;
  /** Opt-in workspace package glob (`--workspace`). */
  readonly workspaceGlob?: string;
  /** Test runner selection (`--runner`). Default vitest. */
  readonly runner?: "vitest" | "jest";
  /** Score all sites in dirty files (skip git hunk filter). */
  readonly fullFile?: boolean;
}

/**
 * Inbound port: CLI and behavioral test drivers both call this.
 */
export interface RunMutationSession {
  execute(input: MutationSessionInput): Promise<SessionResult>;
}
