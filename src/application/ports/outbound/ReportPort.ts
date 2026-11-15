import type { Mutant, SessionResult } from "../../../domain/mutant.js";

/**
 * Terminal and optional JSON report writers.
 * Prod: StdioReport + SchemaJsonFile; mem: RecordingReport.
 */
export interface ReportPort {
  writeTerminal(result: SessionResult): Promise<void>;
  /** Build/write mutation-testing-report-schema JSON when `--json` is set. */
  writeJson?(path: string, result: SessionResult): Promise<void>;
  /** Write Survived-only SARIF 2.1.0 when `--sarif` is set (ADR-033). */
  writeSarif?(path: string, result: SessionResult): Promise<void>;
  /** Immediate stderr line (untracked notice, --verbose). */
  writeNotice?(line: string): void;
  /** Banner before the mutant loop (file/mutant counts). */
  writeSessionStart?(info: SessionStartInfo): void;
  /** Stream one mutant result as soon as it is scored (realtime UX). */
  writeMutantResult?(mutant: Mutant, progress: MutantProgress): void;
}

export interface SessionStartInfo {
  readonly fileCount: number;
  readonly mutantCount: number;
  readonly timeoutMs: number;
}

export interface MutantProgress {
  /** 1-based index of this mutant among all scored sites (incl. NoCoverage). */
  readonly index: number;
  readonly total: number;
  readonly counts: BucketCounts;
}

export interface BucketCounts {
  readonly killed: number;
  readonly survived: number;
  readonly timeout: number;
  readonly error: number;
  readonly noCoverage: number;
}
