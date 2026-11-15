import type {
  AbsolutePath,
  Mutant,
  MutantStatus,
  SessionResult,
  Site,
} from "../../domain/mutant.js";
import {
  EmptyMutateMatchError,
  NO_FILES_TO_MUTATE_MESSAGE,
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
import type { MutatorEnginePort } from "../ports/outbound/MutatorEnginePort.js";
import type { ReportPort } from "../ports/outbound/ReportPort.js";
import type { SourceLocatorPort } from "../ports/outbound/SourceLocatorPort.js";
import type {
  RelatedRunResult,
  ReverseMapResult,
  TestRunnerPort,
} from "../ports/outbound/TestRunnerPort.js";
import type { WorkspaceFilesPort } from "../ports/outbound/WorkspaceFilesPort.js";

export interface RunMutationSessionDeps {
  readonly mutator: MutatorEnginePort;
  readonly testRunner: TestRunnerPort;
  readonly sourceLocator: SourceLocatorPort;
  readonly files: WorkspaceFilesPort;
  readonly report: ReportPort;
}

const EXIT_OK = 0;
const EXIT_REFUSE = 2;

const OUTER_TIMER_PADDING_MS = 2000;
const OUTER_TIMER_FLOOR_MS = 7000;

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
      );
    } catch (error) {
      return this.reportRefuse(error, input.jsonPath);
    }

    this.emitUntrackedNotice();
    if (input.verbose === true) {
      this.emitSelectedFiles(input.cwd, candidates);
    }

    if (candidates.length === 0) {
      return this.reportResult(
        {
          statuses: [],
          exitCode: EXIT_OK,
          message: NO_FILES_TO_MUTATE_MESSAGE,
        },
        input.jsonPath,
      );
    }

    await this.deps.testRunner.startSession({ buffers: new Map() });
    try {
      return await this.runAfterSession(candidates, input);
    } catch (error) {
      if (isRunnerRefuse(error)) {
        return this.reportResult(
          {
            statuses: [],
            exitCode: EXIT_REFUSE,
            message: error.message,
          },
          input.jsonPath,
        );
      }
      throw error;
    } finally {
      await this.deps.testRunner.close();
    }
  }

  private async runAfterSession(
    candidates: readonly AbsolutePath[],
    input: MutationSessionInput,
  ): Promise<SessionResult> {
    const workers = input.workers ?? 1;
    const reverse = await this.deps.testRunner.buildReverseMap(candidates);

    const discovered = await this.discoverCandidateSites(candidates, reverse);
    if (input.verbose === true) {
      this.emitDiscoverDiagnostics(discovered);
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
        input.jsonPath,
      );
    }

    // N>=2: pool adapter refuses globalSetup (ADR-017). N=1 keeps one-shot respawn.
    if (workers < 2 && shouldRespawnForGlobalSetup(candidates, reverse)) {
      await this.respawnRunner();
    }

    const outerTimeoutMs = resolveOuterTimeoutMs(
      input.timeoutMs,
      this.deps.testRunner.getTestTimeoutMs(),
    );

    const statuses = await this.scoreDiscovered(
      discovered,
      outerTimeoutMs,
      workers,
    );
    return this.reportResult(
      {
        statuses,
        exitCode: evaluateQualityGates(countsFromStatuses(statuses), {
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
      },
      input.jsonPath,
      input.sarifPath,
    );
  }

  private async scoreDiscovered(
    discovered: readonly DiscoveredFile[],
    outerTimeoutMs: number,
    workers: number,
  ): Promise<Mutant[]> {
    const total = countAllSites(discovered);
    this.deps.report.writeSessionStart?.({
      fileCount: discovered.length,
      mutantCount: total,
      timeoutMs: outerTimeoutMs,
    });

    if (workers >= 2) {
      return this.scoreDiscoveredConcurrent(discovered, total, workers);
    }
    return this.scoreDiscoveredSequential(discovered, total, outerTimeoutMs);
  }

  private async scoreDiscoveredSequential(
    discovered: readonly DiscoveredFile[],
    total: number,
    outerTimeoutMs: number,
  ): Promise<Mutant[]> {
    const statuses: Mutant[] = [];
    const counts = emptyBuckets();

    for (const entry of discovered) {
      if (entry.related.length === 0) {
        for (const site of entry.sites) {
          this.pushScored(
            statuses,
            counts,
            total,
            { site, status: "NoCoverage" },
          );
        }
        continue;
      }
      for (const site of entry.sites) {
        const scored = await this.scoreOneMutantInProcess(
          entry.file,
          entry.originalSource,
          site,
          entry.related,
          outerTimeoutMs,
        );
        this.pushScored(statuses, counts, total, scored);
      }
    }
    return statuses;
  }

  /**
   * N>=2: promise pool — parent apply + runRelated only (child owns overlay).
   * No setBuffer / invalidateFile / respawn in the parent use case.
   */
  private async scoreDiscoveredConcurrent(
    discovered: readonly DiscoveredFile[],
    total: number,
    workers: number,
  ): Promise<Mutant[]> {
    const statuses: Mutant[] = new Array(total);
    const counts = emptyBuckets();
    let nextIndex = 0;

    type Job = {
      readonly slot: number;
      readonly file: AbsolutePath;
      readonly originalSource: string;
      readonly site: Site;
      readonly related: readonly string[];
    };

    const jobs: Job[] = [];
    let slot = 0;
    for (const entry of discovered) {
      for (const site of entry.sites) {
        jobs.push({
          slot,
          file: entry.file,
          originalSource: entry.originalSource,
          site,
          related: entry.related,
        });
        slot += 1;
      }
    }

    const runJob = async (job: Job): Promise<void> => {
      let scored: Mutant;
      if (job.related.length === 0) {
        scored = { site: job.site, status: "NoCoverage" };
      } else {
        scored = await this.scoreOneMutantPooled(
          job.file,
          job.originalSource,
          job.site,
          job.related,
        );
      }
      statuses[job.slot] = scored;
      bumpBucket(counts, scored.status);
      // Progress index is completion order for streaming UX.
      nextIndex += 1;
      this.deps.report.writeMutantResult?.(scored, {
        index: nextIndex,
        total,
        counts: { ...counts },
      });
    };

    await runPromisePool(jobs, workers, runJob);
    return statuses;
  }

  private pushScored(
    statuses: Mutant[],
    counts: BucketState,
    total: number,
    scored: Mutant,
  ): void {
    bumpBucket(counts, scored.status);
    statuses.push(scored);
    this.deps.report.writeMutantResult?.(scored, {
      index: statuses.length,
      total,
      counts: { ...counts },
    });
  }

  private async scoreOneMutantInProcess(
    file: AbsolutePath,
    originalSource: string,
    site: Site,
    relatedSpecs: readonly string[],
    outerTimeoutMs: number,
  ): Promise<Mutant> {
    let mutatedSource: string;
    try {
      mutatedSource = await this.deps.mutator.apply(originalSource, site);
    } catch {
      return { site, status: "RuntimeError" };
    }

    this.deps.testRunner.setBuffer(file, mutatedSource);
    this.deps.testRunner.invalidateFile(file);

    try {
      const raced = await raceWithTimeout(
        this.deps.testRunner.runRelated({
          file,
          mutatedSource,
          relatedSpecs,
          mutantId: site.id,
        }),
        outerTimeoutMs,
      );

      if (raced.timedOut) {
        await this.respawnRunner();
        return { site, status: "Timeout" };
      }

      return await this.classifyOrRespawn(site, raced.value);
    } catch {
      return { site, status: "RuntimeError" };
    } finally {
      this.deps.testRunner.setBuffer(file, null);
      this.deps.testRunner.invalidateFile(file);
    }
  }

  private async scoreOneMutantPooled(
    file: AbsolutePath,
    originalSource: string,
    site: Site,
    relatedSpecs: readonly string[],
  ): Promise<Mutant> {
    let mutatedSource: string;
    try {
      mutatedSource = await this.deps.mutator.apply(originalSource, site);
    } catch {
      return { site, status: "RuntimeError" };
    }

    try {
      const result = await this.deps.testRunner.runRelated({
        file,
        mutatedSource,
        relatedSpecs,
        mutantId: site.id,
      });
      // Pool adapter owns timeout/respawn — use case never respawns for N>=2.
      return classifyRelatedResult(site, result);
    } catch {
      return { site, status: "RuntimeError" };
    }
  }

  private async classifyOrRespawn(
    site: Site,
    result: RelatedRunResult,
  ): Promise<Mutant> {
    if (result.kind === "timeout") {
      await this.respawnRunner();
      return { site, status: "Timeout" };
    }
    return classifyRelatedResult(site, result);
  }

  private async discoverCandidateSites(
    candidates: readonly AbsolutePath[],
    reverse: ReverseMapResult,
  ): Promise<DiscoveredFile[]> {
    const discovered: DiscoveredFile[] = [];
    for (const file of candidates) {
      const source = await this.deps.files.readUtf8(file);
      const found = await this.deps.mutator.discover(file, source);
      const related = lookupRelated(reverse, file);
      discovered.push({
        file,
        originalSource: source,
        sites: found.sites,
        related,
        disabledCount: found.disabledCount,
      });
    }
    return discovered;
  }

  private async respawnRunner(): Promise<void> {
    this.respawns += 1;
    await this.deps.testRunner.respawn();
  }

  private emitUntrackedNotice(): void {
    const skipped = this.deps.sourceLocator.untrackedSkipped ?? 0;
    if (skipped <= 0) {
      return;
    }
    const noun = skipped === 1 ? "file" : "files";
    this.deps.report.writeNotice?.(
      `ℹ ${String(skipped)} untracked ${noun} skipped. Pass --include-untracked or --mutate <glob> to target them.`,
    );
  }

  private emitSelectedFiles(
    cwd: string,
    candidates: readonly AbsolutePath[],
  ): void {
    this.deps.report.writeNotice?.(`Selected files (${String(candidates.length)}):`);
    for (const file of candidates) {
      this.deps.report.writeNotice?.(`  ${relativeToCwd(cwd, file)}`);
    }
  }

  private emitDiscoverDiagnostics(discovered: readonly DiscoveredFile[]): void {
    const { histogramLine, disabledCount } = summarizeDiscover(discovered);
    this.deps.report.writeNotice?.(`Mutators: ${histogramLine}`);
    this.deps.report.writeNotice?.(
      `Disable-comment sites omitted: ${String(disabledCount)}`,
    );
  }

  private async reportRefuse(
    error: unknown,
    jsonPath?: string,
  ): Promise<SessionResult> {
    if (error instanceof NotAGitRepositoryError) {
      return this.reportResult(
        {
          statuses: [],
          exitCode: EXIT_REFUSE,
          message: error.message,
        },
        jsonPath,
      );
    }
    if (error instanceof EmptyMutateMatchError) {
      return this.reportResult(
        {
          statuses: [],
          exitCode: EXIT_REFUSE,
          message: error.message,
        },
        jsonPath,
      );
    }
    throw error;
  }

  private async reportResult(
    result: SessionResult,
    jsonPath?: string,
    sarifPath?: string,
  ): Promise<SessionResult> {
    await this.deps.report.writeTerminal(result);
    if (jsonPath != null && this.deps.report.writeJson) {
      await this.deps.report.writeJson(jsonPath, result);
    }
    if (sarifPath != null && this.deps.report.writeSarif) {
      await this.deps.report.writeSarif(sarifPath, result);
    }
    return result;
  }
}

interface DiscoveredFile {
  readonly file: AbsolutePath;
  readonly originalSource: string;
  readonly sites: readonly Site[];
  readonly related: readonly string[];
  readonly disabledCount: number;
}

function summarizeDiscover(discovered: readonly DiscoveredFile[]): {
  histogramLine: string;
  disabledCount: number;
} {
  const histogram = new Map<string, number>();
  let disabledCount = 0;
  for (const entry of discovered) {
    disabledCount += entry.disabledCount;
    for (const site of entry.sites) {
      histogram.set(site.mutatorName, (histogram.get(site.mutatorName) ?? 0) + 1);
    }
  }
  const histogramLine =
    [...histogram.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${name}: ${String(count)}`)
      .join(", ") || "(none)";
  return { histogramLine, disabledCount };
}

function formatVerboseFooter(
  discovered: readonly DiscoveredFile[],
  respawnCount: number,
  workers: number,
  recycleCount: number,
): string {
  const { histogramLine, disabledCount } = summarizeDiscover(discovered);
  const lines = [
    `Mutators: ${histogramLine}`,
    `Disable-comment sites omitted: ${String(disabledCount)}`,
  ];
  if (workers >= 2) {
    lines.push(`Worker recycles (timeout+RSS): ${String(recycleCount)}`);
  } else {
    lines.push(`Vitest respawns: ${String(respawnCount)}`);
  }
  return lines.join("\n");
}

type BucketState = {
  killed: number;
  survived: number;
  timeout: number;
  error: number;
  noCoverage: number;
};

function emptyBuckets(): BucketState {
  return {
    killed: 0,
    survived: 0,
    timeout: 0,
    error: 0,
    noCoverage: 0,
  };
}

async function runPromisePool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const limit = Math.max(1, concurrency);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function lookupRelated(
  reverse: ReverseMapResult,
  file: AbsolutePath,
): readonly string[] {
  const direct = reverse.relatedBySource.get(file);
  if (direct != null) {
    return direct;
  }
  for (const [source, specs] of reverse.relatedBySource) {
    if (pathsEqual(source, file)) {
      return specs;
    }
  }
  return [];
}

function pathsEqual(a: string, b: string): boolean {
  return a === b || a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

function relativeToCwd(cwd: string, file: string): string {
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedFile = file.replace(/\\/g, "/");
  if (normalizedFile.startsWith(`${normalizedCwd}/`)) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return file;
}

function collectBaselineSpecs(discovered: readonly DiscoveredFile[]): string[] {
  const specs = new Set<string>();
  for (const entry of discovered) {
    for (const spec of entry.related) {
      specs.add(spec);
    }
  }
  return [...specs];
}

function shouldRespawnForGlobalSetup(
  candidates: readonly AbsolutePath[],
  reverse: ReverseMapResult,
): boolean {
  for (const file of candidates) {
    if (reverse.globalSetupOnly.has(file)) {
      return true;
    }
    for (const marked of reverse.globalSetupOnly) {
      if (pathsEqual(marked, file)) {
        return true;
      }
    }
  }
  return false;
}

export function resolveOuterTimeoutMs(
  overrideMs: number | undefined,
  testTimeoutMs: number,
): number {
  if (overrideMs != null) {
    return overrideMs;
  }
  return Math.max(testTimeoutMs + OUTER_TIMER_PADDING_MS, OUTER_TIMER_FLOOR_MS);
}

function countAllSites(discovered: readonly DiscoveredFile[]): number {
  let total = 0;
  for (const entry of discovered) {
    total += entry.sites.length;
  }
  return total;
}

function bumpBucket(
  counts: {
    killed: number;
    survived: number;
    timeout: number;
    error: number;
    noCoverage: number;
  },
  status: MutantStatus,
): void {
  switch (status) {
    case "Killed":
      counts.killed += 1;
      break;
    case "Survived":
      counts.survived += 1;
      break;
    case "Timeout":
      counts.timeout += 1;
      break;
    case "RuntimeError":
      counts.error += 1;
      break;
    case "NoCoverage":
      counts.noCoverage += 1;
      break;
  }
}

function classifyRelatedResult(site: Site, result: RelatedRunResult): Mutant {
  switch (result.kind) {
    case "failed":
      return {
        site,
        status: "Killed" satisfies MutantStatus,
        killedBy: result.failingTestId,
      };
    case "passed":
      return { site, status: "Survived" };
    case "timeout":
      return { site, status: "Timeout" };
    case "error":
      return { site, status: "RuntimeError" };
  }
}

/** Duck-type adapter refuse (exit 2) without importing adapter modules. */
function isRunnerRefuse(error: unknown): error is Error {
  return (
    error instanceof Error &&
    "exitCode" in error &&
    (error as { exitCode: unknown }).exitCode === 2
  );
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer != null) {
      clearTimeout(timer);
    }
  }
}
