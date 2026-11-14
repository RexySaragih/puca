import type { SourceLocatorPort } from "../../../application/ports/outbound/SourceLocatorPort.js";
import type { AbsolutePath } from "../../../domain/mutant.js";

/**
 * Returns a preconfigured candidate list (default empty → idle exit 0).
 */
export class InMemorySourceLocator implements SourceLocatorPort {
  private candidates: readonly AbsolutePath[] = [];
  untrackedSkipped = 0;

  setCandidates(files: readonly AbsolutePath[]): void {
    this.candidates = files;
  }

  async candidateFiles(
    _cwd: string,
    _mutateGlob?: string,
    _includeUntracked?: boolean,
  ): Promise<readonly AbsolutePath[]> {
    return this.candidates;
  }
}
