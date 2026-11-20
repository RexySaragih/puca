import type { AbsolutePath, Site } from "../../domain/mutant.js";
import type { MutatorEnginePort } from "../ports/outbound/MutatorEnginePort.js";
import type { ReportPort } from "../ports/outbound/ReportPort.js";
import type {
  SourceCandidate,
  SourceLocatorPort,
} from "../ports/outbound/SourceLocatorPort.js";
import { siteOverlapsRanges } from "../ports/outbound/SourceLocatorPort.js";
import type { ReverseMapResult } from "../ports/outbound/TestRunnerPort.js";
import type { WorkspaceFilesPort } from "../ports/outbound/WorkspaceFilesPort.js";

export interface DiscoverDeps {
  readonly mutator: MutatorEnginePort;
  readonly sourceLocator: SourceLocatorPort;
  readonly files: WorkspaceFilesPort;
  readonly report: ReportPort;
}

export interface DiscoveredFile {
  readonly file: AbsolutePath;
  readonly originalSource: string;
  readonly sites: readonly Site[];
  readonly related: readonly string[];
  readonly disabledByDirective: number;
  readonly skippedByHeuristic: number;
}

export interface DiscoverSummary {
  readonly histogramLine: string;
  readonly disabledByDirective: number;
  readonly skippedByHeuristic: number;
}

export async function discoverCandidateSites(
  deps: DiscoverDeps,
  candidates: readonly SourceCandidate[],
  reverse: ReverseMapResult,
  cwd: string,
): Promise<DiscoveredFile[]> {
  const discovered: DiscoveredFile[] = [];
  for (const candidate of candidates) {
    const file = candidate.file;
    const rel = relativeToCwd(cwd, file);
    try {
      if (!(await deps.files.exists(file))) {
        deps.report.writeNotice?.(`Skipping ${rel}: file not found.`);
        continue;
      }
      const source = await deps.files.readUtf8(file);
      const found = await deps.mutator.discover(file, source);
      const related = lookupRelated(reverse, file);
      for (const warning of found.warnings) {
        deps.report.writeNotice?.(warning);
      }
      const sites = found.sites.filter((site) =>
        siteOverlapsRanges(site.line, candidate.lineRanges),
      );
      discovered.push({
        file,
        originalSource: source,
        sites,
        related,
        disabledByDirective: found.disabledByDirective,
        skippedByHeuristic: found.skippedByHeuristic,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.report.writeNotice?.(`Skipping ${rel}: ${detail}`);
    }
  }
  return discovered;
}

export function emitUntrackedNotice(deps: DiscoverDeps): void {
  const skipped = deps.sourceLocator.untrackedSkipped ?? 0;
  if (skipped <= 0) {
    return;
  }
  const noun = skipped === 1 ? "file" : "files";
  deps.report.writeNotice?.(
    `ℹ ${String(skipped)} untracked ${noun} skipped. Pass --include-untracked or --mutate <glob> to target them.`,
  );
}

export function emitSelectedFiles(
  deps: DiscoverDeps,
  cwd: string,
  candidates: readonly SourceCandidate[],
): void {
  deps.report.writeNotice?.(`Selected files (${String(candidates.length)}):`);
  for (const candidate of candidates) {
    const rel = relativeToCwd(cwd, candidate.file);
    if (candidate.lineRanges == null) {
      deps.report.writeNotice?.(`  ${rel}`);
      continue;
    }
    const windows = candidate.lineRanges
      .map((range) => `${String(range.start)}-${String(range.end)}`)
      .join(",");
    deps.report.writeNotice?.(`  ${rel} [${windows}]`);
  }
}

export function emitDiscoverDiagnostics(
  deps: DiscoverDeps,
  discovered: readonly DiscoveredFile[],
): void {
  const summary = summarizeDiscover(discovered);
  deps.report.writeNotice?.(`Mutators: ${summary.histogramLine}`);
  deps.report.writeNotice?.(formatSuppressionSummary(summary));
}

export function summarizeDiscover(
  discovered: readonly DiscoveredFile[],
): DiscoverSummary {
  const histogram = new Map<string, number>();
  let disabledByDirective = 0;
  let skippedByHeuristic = 0;
  for (const entry of discovered) {
    disabledByDirective += entry.disabledByDirective;
    skippedByHeuristic += entry.skippedByHeuristic;
    for (const site of entry.sites) {
      histogram.set(site.mutatorName, (histogram.get(site.mutatorName) ?? 0) + 1);
    }
  }
  const histogramLine =
    [...histogram.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => `${name}: ${String(count)}`)
      .join(", ") || "(none)";
  return { histogramLine, disabledByDirective, skippedByHeuristic };
}

export function formatSuppressionSummary(summary: DiscoverSummary): string {
  return (
    `Suppression summary: ${String(summary.disabledByDirective)} skipped via comment directives, ` +
    `${String(summary.skippedByHeuristic)} skipped via auto-heuristics.`
  );
}

export function buildDisabledByFile(
  discovered: readonly DiscoveredFile[],
  cwd: string,
): Record<string, number> | undefined {
  const map: Record<string, number> = {};
  let sessionTotal = 0;
  for (const entry of discovered) {
    const total = entry.disabledByDirective + entry.skippedByHeuristic;
    if (total <= 0) {
      continue;
    }
    const rel = relativeToCwd(cwd, entry.file);
    map[rel] = (map[rel] ?? 0) + total;
    sessionTotal += total;
  }
  return sessionTotal > 0 ? map : undefined;
}

export function formatVerboseFooter(
  discovered: readonly DiscoveredFile[],
  respawnCount: number,
  workers: number,
  recycleCount: number,
): string {
  const summary = summarizeDiscover(discovered);
  const lines = [
    `Mutators: ${summary.histogramLine}`,
    formatSuppressionSummary(summary),
  ];
  if (workers >= 2) {
    lines.push(`Worker recycles (timeout+RSS): ${String(recycleCount)}`);
  } else {
    lines.push(`Vitest respawns: ${String(respawnCount)}`);
  }
  return lines.join("\n");
}

export function lookupRelated(
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

export function pathsEqual(a: string, b: string): boolean {
  return a === b || a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
}

export function relativeToCwd(cwd: string, file: string): string {
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedFile = file.replace(/\\/g, "/");
  if (normalizedFile.startsWith(`${normalizedCwd}/`)) {
    return normalizedFile.slice(normalizedCwd.length + 1);
  }
  return file;
}

export function collectBaselineSpecs(
  discovered: readonly DiscoveredFile[],
): string[] {
  const specs = new Set<string>();
  for (const entry of discovered) {
    for (const spec of entry.related) {
      specs.add(spec);
    }
  }
  return [...specs];
}

export function shouldRespawnForGlobalSetup(
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

export function countAllSites(discovered: readonly DiscoveredFile[]): number {
  let total = 0;
  for (const entry of discovered) {
    total += entry.sites.length;
  }
  return total;
}
