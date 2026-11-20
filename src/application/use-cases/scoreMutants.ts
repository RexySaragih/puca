import type { AbsolutePath, Mutant, MutantStatus, Site } from "../../domain/mutant.js";
import type { CachePort } from "../ports/outbound/CachePort.js";
import type { MutatorEnginePort } from "../ports/outbound/MutatorEnginePort.js";
import type { ReportPort } from "../ports/outbound/ReportPort.js";
import type {
  RelatedRunResult,
  TestRunnerPort,
} from "../ports/outbound/TestRunnerPort.js";
import type { WorkspaceFilesPort } from "../ports/outbound/WorkspaceFilesPort.js";
import type { DiscoveredFile } from "./discoverSession.js";
import { countAllSites } from "./discoverSession.js";

export interface ScoreDeps {
  readonly mutator: MutatorEnginePort;
  readonly testRunner: TestRunnerPort;
  readonly files: WorkspaceFilesPort;
  readonly report: ReportPort;
}

const OUTER_TIMER_PADDING_MS = 2000;
const OUTER_TIMER_FLOOR_MS = 7000;
/** Adapter stamps the on-disk schema; satisfies CachedMutantStatus at the port. */
const CACHE_ENTRY_SCHEMA_PLACEHOLDER = 0;

export async function scoreDiscovered(
  deps: ScoreDeps,
  discovered: readonly DiscoveredFile[],
  outerTimeoutMs: number,
  workers: number,
  cache: CachePort | undefined,
  respawn: () => Promise<void>,
): Promise<Mutant[]> {
  const total = countAllSites(discovered);
  deps.report.writeSessionStart?.({
    fileCount: discovered.length,
    mutantCount: total,
    timeoutMs: outerTimeoutMs,
  });

  if (workers >= 2) {
    return scoreDiscoveredConcurrent(deps, discovered, total, workers, cache);
  }
  return scoreDiscoveredSequential(
    deps,
    discovered,
    total,
    outerTimeoutMs,
    cache,
    respawn,
  );
}

async function scoreDiscoveredSequential(
  deps: ScoreDeps,
  discovered: readonly DiscoveredFile[],
  total: number,
  outerTimeoutMs: number,
  cache: CachePort | undefined,
  respawn: () => Promise<void>,
): Promise<Mutant[]> {
  const statuses: Mutant[] = [];
  const counts = emptyBuckets();

  for (const entry of discovered) {
    for (const site of entry.sites) {
      const scored = await scoreSiteWithCache(
        deps,
        site,
        entry.related,
        entry.originalSource,
        cache,
        async () => {
          if (entry.related.length === 0) {
            return { site, status: "NoCoverage" };
          }
          return scoreOneMutantInProcess(
            deps,
            entry.file,
            entry.originalSource,
            site,
            entry.related,
            outerTimeoutMs,
            respawn,
          );
        },
      );
      pushScored(deps, statuses, counts, total, scored);
    }
  }
  return statuses;
}

/**
 * N>=2: promise pool — parent apply + runRelated only (child owns overlay).
 * No setBuffer / invalidateFile / respawn in the parent use case.
 */
async function scoreDiscoveredConcurrent(
  deps: ScoreDeps,
  discovered: readonly DiscoveredFile[],
  total: number,
  workers: number,
  cache: CachePort | undefined,
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
    const scored = await scoreSiteWithCache(
      deps,
      job.site,
      job.related,
      job.originalSource,
      cache,
      async () => {
        if (job.related.length === 0) {
          return { site: job.site, status: "NoCoverage" };
        }
        return scoreOneMutantPooled(
          deps,
          job.file,
          job.originalSource,
          job.site,
          job.related,
        );
      },
    );
    statuses[job.slot] = scored;
    bumpBucket(counts, scored.status);
    nextIndex += 1;
    deps.report.writeMutantResult?.(scored, {
      index: nextIndex,
      total,
      counts: { ...counts },
    });
  };

  await runPromisePool(jobs, workers, runJob);
  return statuses;
}

async function scoreSiteWithCache(
  deps: ScoreDeps,
  site: Site,
  related: readonly string[],
  originalSource: string,
  cache: CachePort | undefined,
  scoreMiss: () => Promise<Mutant>,
): Promise<Mutant> {
  if (cache == null) {
    return scoreMiss();
  }

  const relatedContents = await readRelatedContents(deps, related);
  const key = cache.keyFor({
    file: site.file,
    startOffset: site.startOffset,
    endOffset: site.endOffset,
    mutatorName: site.mutatorName,
    replacement: site.replacement,
    sourceContents: originalSource,
    relatedContents,
  });

  const hit = cache.get(key);
  if (hit != null) {
    return {
      site,
      status: hit.status,
      ...(hit.killedBy != null ? { killedBy: hit.killedBy } : {}),
    };
  }

  const scored = await scoreMiss();
  cache.set(key, {
    status: scored.status,
    ...(scored.killedBy != null ? { killedBy: scored.killedBy } : {}),
    schemaVersion: CACHE_ENTRY_SCHEMA_PLACEHOLDER,
  });
  return scored;
}

async function readRelatedContents(
  deps: ScoreDeps,
  related: readonly string[],
): Promise<string> {
  if (related.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const spec of related) {
    try {
      parts.push(await deps.files.readUtf8(spec));
    } catch {
      parts.push("");
    }
  }
  return parts.join("\0");
}

function pushScored(
  deps: ScoreDeps,
  statuses: Mutant[],
  counts: BucketState,
  total: number,
  scored: Mutant,
): void {
  bumpBucket(counts, scored.status);
  statuses.push(scored);
  deps.report.writeMutantResult?.(scored, {
    index: statuses.length,
    total,
    counts: { ...counts },
  });
}

async function scoreOneMutantInProcess(
  deps: ScoreDeps,
  file: AbsolutePath,
  originalSource: string,
  site: Site,
  relatedSpecs: readonly string[],
  outerTimeoutMs: number,
  respawn: () => Promise<void>,
): Promise<Mutant> {
  let mutatedSource: string;
  try {
    mutatedSource = await deps.mutator.apply(originalSource, site);
  } catch {
    return { site, status: "RuntimeError" };
  }

  deps.testRunner.setBuffer(file, mutatedSource);
  deps.testRunner.invalidateFile(file);

  try {
    const raced = await raceWithTimeout(
      deps.testRunner.runRelated({
        file,
        mutatedSource,
        relatedSpecs,
        mutantId: site.id,
      }),
      outerTimeoutMs,
    );

    if (raced.timedOut) {
      await deps.testRunner.cancelCurrentRun?.();
      await respawn();
      return { site, status: "Timeout" };
    }

    return await classifyOrRespawn(deps, site, raced.value, respawn);
  } catch {
    return { site, status: "RuntimeError" };
  } finally {
    deps.testRunner.setBuffer(file, null);
    deps.testRunner.invalidateFile(file);
  }
}

async function scoreOneMutantPooled(
  deps: ScoreDeps,
  file: AbsolutePath,
  originalSource: string,
  site: Site,
  relatedSpecs: readonly string[],
): Promise<Mutant> {
  let mutatedSource: string;
  try {
    mutatedSource = await deps.mutator.apply(originalSource, site);
  } catch {
    return { site, status: "RuntimeError" };
  }

  try {
    const result = await deps.testRunner.runRelated({
      file,
      mutatedSource,
      relatedSpecs,
      mutantId: site.id,
    });
    return classifyRelatedResult(site, result);
  } catch {
    return { site, status: "RuntimeError" };
  }
}

async function classifyOrRespawn(
  deps: ScoreDeps,
  site: Site,
  result: RelatedRunResult,
  respawn: () => Promise<void>,
): Promise<Mutant> {
  if (result.kind === "timeout") {
    await deps.testRunner.cancelCurrentRun?.();
    await respawn();
    return { site, status: "Timeout" };
  }
  return classifyRelatedResult(site, result);
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

export function resolveOuterTimeoutMs(
  overrideMs: number | undefined,
  testTimeoutMs: number,
): number {
  if (overrideMs != null) {
    return overrideMs;
  }
  return Math.max(testTimeoutMs + OUTER_TIMER_PADDING_MS, OUTER_TIMER_FLOOR_MS);
}
