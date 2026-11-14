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
const EXIT_SURVIVED = 1;
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
    } finally {
      await this.deps.testRunner.close();
    }
  }

  private async runAfterSession(
    candidates: readonly AbsolutePath[],
    input: MutationSessionInput,
  ): Promise<SessionResult> {
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

    if (shouldRespawnForGlobalSetup(candidates, reverse)) {
      await this.respawnRunner();
    }

    const outerTimeoutMs = resolveOuterTimeoutMs(
      input.timeoutMs,
      this.deps.testRunner.getTestTimeoutMs(),
    );

    const statuses = await this.scoreDiscovered(
      discovered,
      outerTimeoutMs,
    );
    return this.reportResult(
      {
        statuses,
        exitCode: exitCodeForStatuses(statuses),
        verboseFooter:
          input.verbose === true
            ? formatVerboseFooter(discovered, this.respawns)
            : undefined,
      },
      input.jsonPath,
    );
  }

  private async scoreDiscovered(
    discovered: readonly DiscoveredFile[],
    outerTimeoutMs: number,
  ): Promise<Mutant[]> {
    const total = countAllSites(discovered);
    this.deps.report.writeSessionStart?.({
      fileCount: discovered.length,
      mutantCount: total,
      timeoutMs: outerTimeoutMs,
    });

    const statuses: Mutant[] = [];
    const counts = {
      killed: 0,
      survived: 0,
      timeout: 0,
      error: 0,
      noCoverage: 0,
    };

    for (const entry of discovered) {
      if (entry.related.length === 0) {
        for (const site of entry.sites) {
          const scored: Mutant = { site, status: "NoCoverage" };
          bumpBucket(counts, scored.status);
          statuses.push(scored);
          this.deps.report.writeMutantResult?.(scored, {
            index: statuses.length,
            total,
            counts: { ...counts },
          });
        }
        continue;
      }
      for (const site of entry.sites) {
        const scored = await this.scoreOneMutant(
          entry.file,
          entry.originalSource,
          site,
          entry.related,
          outerTimeoutMs,
        );
        bumpBucket(counts, scored.status);
        statuses.push(scored);
        this.deps.report.writeMutantResult?.(scored, {
          index: statuses.length,
          total,
          counts: { ...counts },
        });
      }
    }
    return statuses;
  }

  private async scoreOneMutant(
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
  ): Promise<SessionResult> {
    await this.deps.report.writeTerminal(result);
    if (jsonPath != null && this.deps.report.writeJson) {
      await this.deps.report.writeJson(jsonPath, result);
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
): string {
  const { histogramLine, disabledCount } = summarizeDiscover(discovered);
  return [
    `Mutators: ${histogramLine}`,
    `Disable-comment sites omitted: ${String(disabledCount)}`,
    `Vitest respawns: ${String(respawnCount)}`,
  ].join("\n");
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

function exitCodeForStatuses(statuses: readonly Mutant[]): number {
  if (statuses.some((entry) => entry.status === "RuntimeError")) {
    return EXIT_REFUSE;
  }
  if (statuses.some((entry) => entry.status === "Survived")) {
    return EXIT_SURVIVED;
  }
  return EXIT_OK;
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
