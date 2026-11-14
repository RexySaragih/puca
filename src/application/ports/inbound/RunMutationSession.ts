import type { SessionResult } from "../../../domain/mutant.js";

export interface MutationSessionInput {
  readonly cwd: string;
  readonly mutateGlob?: string;
  readonly jsonPath?: string;
  readonly timeoutMs?: number;
  /** Git-dirty default only. Ignored when mutateGlob is set (--mutate already walks the tree). */
  readonly includeUntracked?: boolean;
  readonly verbose?: boolean;
}

/**
 * Inbound port: CLI and behavioral test drivers both call this.
 */
export interface RunMutationSession {
  execute(input: MutationSessionInput): Promise<SessionResult>;
}
