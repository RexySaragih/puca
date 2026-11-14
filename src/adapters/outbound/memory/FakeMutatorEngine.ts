import type {
  DiscoverResult,
  MutatorEnginePort,
} from "../../../application/ports/outbound/MutatorEnginePort.js";
import type { AbsolutePath, Site } from "../../../domain/mutant.js";

/**
 * In-memory mutator for behavioral tests. Configurable site map per file.
 */
export class FakeMutatorEngine implements MutatorEnginePort {
  private readonly sitesByFile = new Map<string, readonly Site[]>();
  private disabledCount = 0;

  setSites(file: AbsolutePath, sites: readonly Site[]): void {
    this.sitesByFile.set(file, sites);
  }

  setDisabledCount(count: number): void {
    this.disabledCount = count;
  }

  async discover(file: AbsolutePath, _source: string): Promise<DiscoverResult> {
    return {
      sites: this.sitesByFile.get(file) ?? [],
      disabledCount: this.disabledCount,
    };
  }

  async apply(source: string, site: Site): Promise<string> {
    const before = source.slice(0, site.startOffset);
    const after = source.slice(site.endOffset);
    return `${before}${site.replacement}${after}`;
  }
}
