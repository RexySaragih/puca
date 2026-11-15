import type { AbsolutePath } from "../../../domain/mutant.js";

/**
 * Discover package roots declared by pnpm/npm/yarn workspace manifests,
 * filtered by a micromatch glob (ADR-036).
 */
export interface WorkspaceDiscoveryPort {
  /**
   * Resolve absolute package roots under `cwd` matching `workspaceGlob`.
   * Zero matches → throw EmptyWorkspaceMatchError (CLI maps to exit 2).
   */
  discoverPackageRoots(
    cwd: string,
    workspaceGlob: string,
  ): Promise<readonly AbsolutePath[]>;
}
