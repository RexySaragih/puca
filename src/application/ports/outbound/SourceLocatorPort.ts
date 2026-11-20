import type { AbsolutePath } from "../../../domain/mutant.js";

/** 1-based inclusive line window in the current file (git new-side hunk). */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/**
 * One mutate candidate. `lineRanges` omitted means the whole file
 * (`--mutate`, `--full-file`, untracked). Empty ranges must not be stored;
 * the locator omits the file instead.
 */
export interface SourceCandidate {
  readonly file: AbsolutePath;
  readonly lineRanges?: readonly LineRange[];
}

/**
 * Resolves candidate source files under cwd.
 * Prod: GitDiffLocator; mem: InMemorySourceLocator.
 */
export interface SourceLocatorPort {
  candidateFiles(
    cwd: string,
    mutateGlob?: string,
    includeUntracked?: boolean,
    fullFile?: boolean,
  ): Promise<readonly SourceCandidate[]>;
  /**
   * Eligible untracked `.ts`/`.tsx` files omitted by default git targeting.
   * Reset on each candidateFiles call. 0 when --include-untracked or --mutate.
   */
  untrackedSkipped?: number;
}

export function siteOverlapsRanges(
  line: number,
  ranges: readonly LineRange[] | undefined,
): boolean {
  if (ranges == null) {
    return true;
  }
  return ranges.some((range) => line >= range.start && line <= range.end);
}
