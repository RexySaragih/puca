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
  private disabledByDirective = 0;
  private skippedByHeuristic = 0;
  private warnings: readonly string[] = [];
  discoverErrorFor: AbsolutePath | undefined;
  discoverError: Error | undefined;

  setSites(file: AbsolutePath, sites: readonly Site[]): void {
    this.sitesByFile.set(file, sites);
  }

  setDisabledByDirective(count: number): void {
    this.disabledByDirective = count;
  }

  setSkippedByHeuristic(count: number): void {
    this.skippedByHeuristic = count;
  }

  setWarnings(warnings: readonly string[]): void {
    this.warnings = warnings;
  }

  async discover(file: AbsolutePath, _source: string): Promise<DiscoverResult> {
    if (this.discoverError != null && this.discoverErrorFor === file) {
      throw this.discoverError;
    }
    if (this.discoverError != null && this.discoverErrorFor == null) {
      throw this.discoverError;
    }
    return {
      sites: this.sitesByFile.get(file) ?? [],
      disabledByDirective: this.disabledByDirective,
      skippedByHeuristic: this.skippedByHeuristic,
      warnings: this.warnings,
    };
  }

  async apply(source: string, site: Site): Promise<string> {
    const before = source.slice(0, site.startOffset);
    const after = source.slice(site.endOffset);
    return `${before}${site.replacement}${after}`;
  }
}
