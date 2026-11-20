import type { SessionResult } from "../../domain/mutant.js";
import {
  EmptyMutateMatchError,
  NO_FILES_TO_MUTATE_MESSAGE,
  GitCommandFailedError,
  NotAGitRepositoryError,
} from "../../domain/targetingErrors.js";
import {
  countsFromStatuses,
  evaluateQualityGates,
} from "../evaluateQualityGates.js";
import type {
  MutationSessionInput,
  RunMutationSession,
} from "../ports/inbound/RunMutationSession.js";
import type { CachePort } from "../ports/outbound/CachePort.js";
import type { MutatorEnginePort } from "../ports/outbound/MutatorEnginePort.js";
import type { ReportPort } from "../ports/outbound/ReportPort.js";
import type {
  SourceCandidate,
  SourceLocatorPort,
} from "../ports/outbound/SourceLocatorPort.js";
import type { TestRunnerPort } from "../ports/outbound/TestRunnerPort.js";
import type { WorkspaceFilesPort } from "../ports/outbound/WorkspaceFilesPort.js";
import {
  buildDisabledByFile,
  collectBaselineSpecs,
  discoverCandidateSites,
  emitDiscoverDiagnostics,
  emitSelectedFiles,
  emitUntrackedNotice,
  formatVerboseFooter,
  shouldRespawnForGlobalSetup,
} from "./discoverSession.js";
import { resolveOuterTimeoutMs, scoreDiscovered } from "./scoreMutants.js";

export interface RunMutationSessionDeps {
  readonly mutator: MutatorEnginePort;
  readonly testRunner: TestRunnerPort;
  readonly sourceLocator: SourceLocatorPort;
  readonly files: WorkspaceFilesPort;
  readonly report: ReportPort;
  /** Opt-in mutant status cache (`--cache`). */
  readonly cache?: CachePort;
}

const EXIT_OK = 0;
const EXIT_REFUSE = 2;

const BASELINE_FAILED_FALLBACK = "Baseline failed";

/**
 * Locate candidates → reverse map → baseline gate → NoCoverage / sequential mutant loop.
 */
export class RunMutationSessionUseCase implements RunMutationSession {
  private respawns = 0;

  constructor(private readonly deps: RunMutationSessionDeps) {}

  async execute(input: MutationSessionInput): Promise<SessionResult> {
    this.respawns = 0;
    let candidates;
    try {
      candidates = await this.deps.sourceLocator.candidateFiles(
        input.cwd,
        input.mutateGlob,
        input.includeUntracked === true,
        input.fullFile === true,
      );
    } catch (error) {
      return this.reportRefuse(error, input.jsonPath);
    }

    emitUntrackedNotice(this.deps);
    if (input.verbose === true) {
      emitSelectedFiles(this.deps, input.cwd, candidates);
    }

    if (candidates.length === 0) {
      return this.reportResult(
        {
          statuses: [],
          exitCode: EXIT_OK,
          message: NO_FILES_TO_MUTATE_MESSAGE,
        },
        artifactPaths(input),
      );
    }

    await this.deps.testRunner.startSession({ buffers: new Map() });
    try {
      if (input.runner === "jest") {
        this.deps.report.writeNotice?.("related-map: static-scan");
      }
      return await this.runAfterSession(candidates, input);
    } catch (error) {
      if (isRunnerRefuse(error)) {
        return this.reportResult(
          {
            statuses: [],
            exitCode: EXIT_REFUSE,
            message: error.message,
          },
          artifactPaths(input),
        );
      }
      throw error;
    } finally {
      await this.deps.testRunner.close();
    }
  }

  private async runAfterSession(
    candidates: readonly SourceCandidate[],
    input: MutationSessionInput,
  ): Promise<SessionResult> {
    const workers = input.workers ?? 1;
    const files = candidates.map((candidate) => candidate.file);
    const reverse = await this.deps.testRunner.buildReverseMap(files);

    const discovered = await discoverCandidateSites(
      this.deps,
      candidates,
      reverse,
      input.cwd,
    );
    if (input.verbose === true) {
      emitDiscoverDiagnostics(this.deps, discovered);
    }

    if (discovered.length === 0) {
      if (input.mutateGlob != null && candidates.length > 0) {
        return this.reportResult(
          {
            statuses: [],
            exitCode: EXIT_REFUSE,
            message:
              "Refused to score: all --mutate matches failed to read or parse.",
          },
          artifactPaths(input),
        );
      }
      return this.reportResult(
        {
          statuses: [],
          exitCode: EXIT_OK,
          message: NO_FILES_TO_MUTATE_MESSAGE,
        },
        artifactPaths(input),
      );
    }

    const baselineSpecs = collectBaselineSpecs(discovered);

    const baseline = await this.deps.testRunner.baseline(baselineSpecs);
    if (!baseline.ok) {
      return this.reportResult(
        {
          statuses: [],
          exitCode: EXIT_REFUSE,
          message: baseline.output ?? BASELINE_FAILED_FALLBACK,
        },
        artifactPaths(input),
      );
    }

    if (workers < 2 && shouldRespawnForGlobalSetup(files, reverse)) {
      await this.respawnRunner();
    }

    const outerTimeoutMs = resolveOuterTimeoutMs(
      input.timeoutMs,
      this.deps.testRunner.getTestTimeoutMs(),
    );
    this.deps.testRunner.configureOuterTimeoutMs?.(outerTimeoutMs);

    const cache =
      input.cache === true && this.deps.cache != null ? this.deps.cache : undefined;
    if (cache != null) {
      await cache.load();
    }

    const statuses = await scoreDiscovered(
      this.deps,
      discovered,
      outerTimeoutMs,
      workers,
      cache,
      () => this.respawnRunner(),
    );

    if (cache != null) {
      await cache.flush();
    }

    const counts = countsFromStatuses(statuses);
    if (counts.noCoverage >= 1 && input.failOnNoCoverage !== true) {
      const noun = counts.noCoverage === 1 ? "mutant" : "mutants";
      this.deps.report.writeNotice?.(
        `ℹ ${String(counts.noCoverage)} NoCoverage ${noun}. Pass --fail-on-no-coverage to fail the run.`,
      );
    }

    return this.reportResult(
      {
        statuses,
        exitCode: evaluateQualityGates(counts, {
          breakOnScore: input.breakOnScore,
          failOnNoCoverage: input.failOnNoCoverage,
        }),
        verboseFooter:
          input.verbose === true
            ? formatVerboseFooter(
                discovered,
                this.respawns,
                workers,
                this.deps.testRunner.recycleCount ?? 0,
              )
            : undefined,
        disabledByFile: buildDisabledByFile(discovered, input.cwd),
      },
      artifactPaths(input),
    );
  }

  private async respawnRunner(): Promise<void> {
    this.respawns += 1;
    await this.deps.testRunner.respawn();
  }

  private async reportRefuse(
    error: unknown,
    jsonPath?: string,
  ): Promise<SessionResult> {
    if (
      error instanceof NotAGitRepositoryError ||
      error instanceof GitCommandFailedError ||
      error instanceof EmptyMutateMatchError
    ) {
      return this.reportResult(
        {
          statuses: [],
          exitCode: EXIT_REFUSE,
          message: error.message,
        },
        { jsonPath },
      );
    }
    throw error;
  }

  private async reportResult(
    result: SessionResult,
    artifacts: ReportArtifacts = {},
  ): Promise<SessionResult> {
    await this.deps.report.writeTerminal(result);
    if (artifacts.jsonPath != null && this.deps.report.writeJson) {
      await this.deps.report.writeJson(artifacts.jsonPath, result);
    }
    if (artifacts.sarifPath != null && this.deps.report.writeSarif) {
      await this.deps.report.writeSarif(artifacts.sarifPath, result);
    }
    if (artifacts.htmlPath != null && this.deps.report.writeHtml) {
      await this.deps.report.writeHtml(artifacts.htmlPath, result);
    }
    return result;
  }
}

interface ReportArtifacts {
  readonly jsonPath?: string;
  readonly sarifPath?: string;
  readonly htmlPath?: string;
}

function artifactPaths(input: MutationSessionInput): ReportArtifacts {
  return {
    jsonPath: input.jsonPath,
    sarifPath: input.sarifPath,
    htmlPath: input.htmlPath,
  };
}

/** Duck-type adapter refuse (exit 2) without importing adapter modules. */
function isRunnerRefuse(error: unknown): error is Error {
  return (
    error instanceof Error &&
    "exitCode" in error &&
    (error as { exitCode: unknown }).exitCode === 2
  );
}

export { resolveOuterTimeoutMs };
export type { DiscoveredFile } from "./discoverSession.js";
