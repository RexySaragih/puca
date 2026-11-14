import type { AbsolutePath, Site } from "../../../domain/mutant.js";

export interface DiscoverResult {
  readonly sites: readonly Site[];
  readonly disabledCount: number;
}

/**
 * Discovers mutation sites and lazily applies a single site to original source.
 * Prod: NapiMutatorEngine; mem: FakeMutatorEngine.
 */
export interface MutatorEnginePort {
  discover(file: AbsolutePath, source: string): Promise<DiscoverResult>;
  apply(source: string, site: Site): Promise<string>;
}
