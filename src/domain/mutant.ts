/**
 * Core mutation-session domain types.
 * Inner hexagon: no Node / Vitest / NAPI imports.
 */

export type AbsolutePath = string & { readonly __brand: "AbsolutePath" };

export function toAbsolutePath(value: string): AbsolutePath {
  return value as AbsolutePath;
}

/** Schema-aligned mutant outcome statuses (ERROR maps to RuntimeError). */
export type MutantStatus =
  | "Killed"
  | "Survived"
  | "Timeout"
  | "NoCoverage"
  | "RuntimeError";

/** Lazy mutation site discovered in source (byte offsets into original UTF-8). */
export interface Site {
  readonly id: string;
  readonly file: AbsolutePath;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly line: number;
  readonly column: number;
  readonly mutatorName: string;
  readonly original: string;
  readonly replacement: string;
}

export interface Mutant {
  readonly site: Site;
  readonly status: MutantStatus;
  readonly killedBy?: string;
}

export interface SessionResult {
  readonly statuses: readonly Mutant[];
  readonly exitCode: number;
  /** Idle / refuse diagnostic for terminal or stderr (CLI maps this). */
  readonly message?: string;
  /** --verbose footer (histogram, disable count, respawns). */
  readonly verboseFooter?: string;
}
