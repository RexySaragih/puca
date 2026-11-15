import type { MutantStatus } from "../../../domain/mutant.js";

/**
 * Opt-in mutant status cache (ADR-035). Metadata only — never mutated source.
 */
export interface CachePort {
  /** Load from disk (fail-open on corrupt). */
  load(): Promise<void>;
  /** Persist entries after a scoring session. */
  flush(): Promise<void>;
  get(key: string): CachedMutantStatus | undefined;
  set(key: string, entry: CachedMutantStatus): void;
  /**
   * Composite key: engineVersion ⊕ site identity ⊕ source ⊕ related test contents.
   */
  keyFor(input: CacheKeyInput): string;
}

export interface CacheKeyInput {
  readonly file: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly mutatorName: string;
  readonly replacement: string;
  /** Original source under mutation — prevents stale hits after edits. */
  readonly sourceContents: string;
  /** Concatenated related-spec file contents (order-stable). */
  readonly relatedContents: string;
}

export interface CachedMutantStatus {
  readonly status: MutantStatus;
  readonly killedBy?: string;
  /** Schema marker — entries with mutatedSource are rejected on load. */
  readonly schemaVersion: number;
}
