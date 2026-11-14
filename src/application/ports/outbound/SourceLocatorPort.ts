import type { AbsolutePath } from "../../../domain/mutant.js";

/**
 * Resolves candidate source files under cwd.
 * Prod: GitDiffLocator; mem: InMemorySourceLocator.
 */
export interface SourceLocatorPort {
  candidateFiles(
    cwd: string,
    mutateGlob?: string,
    includeUntracked?: boolean,
  ): Promise<readonly AbsolutePath[]>;
  /**
   * Eligible untracked `.ts`/`.tsx` files omitted by default git targeting.
   * Reset on each candidateFiles call. 0 when --include-untracked or --mutate.
   */
  untrackedSkipped?: number;
}
