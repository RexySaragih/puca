import type {
  SourceCandidate,
  SourceLocatorPort,
} from "../../../application/ports/outbound/SourceLocatorPort.js";
import type { AbsolutePath } from "../../../domain/mutant.js";

/**
 * Returns a preconfigured candidate list (default empty → idle exit 0).
 */
export class InMemorySourceLocator implements SourceLocatorPort {
  private candidates: readonly SourceCandidate[] = [];
  untrackedSkipped = 0;

  setCandidates(files: readonly AbsolutePath[]): void {
    this.candidates = files.map((file) => ({ file }));
  }

  setCandidatesWithRanges(candidates: readonly SourceCandidate[]): void {
    this.candidates = candidates;
  }

  async candidateFiles(
    _cwd: string,
    _mutateGlob?: string,
    _includeUntracked?: boolean,
    _fullFile?: boolean,
  ): Promise<readonly SourceCandidate[]> {
    return this.candidates;
  }
}
