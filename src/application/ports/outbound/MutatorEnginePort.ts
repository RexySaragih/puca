import type { AbsolutePath, Site } from "../../../domain/mutant.js";

export interface DiscoverResult {
  readonly sites: readonly Site[];
  readonly disabledByDirective: number;
  readonly skippedByHeuristic: number;
  readonly warnings: readonly string[];
}

/**
 * Discovers mutation sites and lazily applies a single site to original source.
 * Prod: NapiMutatorEngine; mem: FakeMutatorEngine.
 */
export interface MutatorEnginePort {
  discover(file: AbsolutePath, source: string): Promise<DiscoverResult>;
  apply(source: string, site: Site): Promise<string>;
}
