import type {
  MutationSessionInput,
  RunMutationSession,
} from "./ports/inbound/RunMutationSession.js";
import type { WorkspaceDiscoveryPort } from "./ports/outbound/WorkspaceDiscoveryPort.js";
import type { AbsolutePath, SessionResult } from "../domain/mutant.js";

const EXIT_OK = 0;
const EXIT_SURVIVED = 1;
const EXIT_REFUSE = 2;

/**
 * Run one mutation session per discovered package cwd (ADR-036).
 * Sequential only; process exit is worst-of 2 > 1 > 0.
 */
export type PackageSessionRunner = (
  packageRoot: AbsolutePath,
  input: MutationSessionInput,
) => Promise<SessionResult>;

export interface WorkspaceTargetResolverDeps {
  readonly discovery: WorkspaceDiscoveryPort;
  readonly runPackageSession: PackageSessionRunner;
}

export class WorkspaceTargetResolver implements RunMutationSession {
  constructor(private readonly deps: WorkspaceTargetResolverDeps) {}

  async execute(input: MutationSessionInput): Promise<SessionResult> {
    const workspaceGlob = input.workspaceGlob;
    if (workspaceGlob === undefined || workspaceGlob.trim() === "") {
      throw new Error("WorkspaceTargetResolver requires a non-empty workspaceGlob");
    }

    const packageRoots = await this.deps.discovery.discoverPackageRoots(
      input.cwd,
      workspaceGlob,
    );

    let worstExit = EXIT_OK;
    const statuses: SessionResult["statuses"][number][] = [];
    const messages: string[] = [];

    for (const packageRoot of packageRoots) {
      const result = await this.deps.runPackageSession(packageRoot, {
        ...input,
        cwd: packageRoot,
        workspaceGlob: undefined,
      });
      statuses.push(...result.statuses);
      worstExit = worstOfExit(worstExit, result.exitCode);
      if (result.message !== undefined && result.message.length > 0) {
        messages.push(`[${packageRoot}] ${result.message}`);
      }
    }

    return {
      statuses,
      exitCode: worstExit,
      ...(messages.length > 0 ? { message: messages.join("\n") } : {}),
    };
  }
}

/** Severity order for workspace aggregation: refuse (2) > survived (1) > ok (0). */
export function worstOfExit(left: number, right: number): number {
  if (left === EXIT_REFUSE || right === EXIT_REFUSE) {
    return EXIT_REFUSE;
  }
  if (left === EXIT_SURVIVED || right === EXIT_SURVIVED) {
    return EXIT_SURVIVED;
  }
  return EXIT_OK;
}
