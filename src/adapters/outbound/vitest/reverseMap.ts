import { normalizeModulePath } from "./pucaRamPlugin.js";

/**
 * Static SSR-style import graph collected from Vitest (or a Fake equivalent).
 * Dynamic `import()` edges are intentionally omitted → NoCoverage (accepted).
 */
export interface SpecImportGraph {
  /** Spec path → statically imported module paths (transitive flatten OK). */
  readonly importsBySpec: ReadonlyMap<string, readonly string[]>;
  /** Modules reachable from setupFiles. */
  readonly setupModules: readonly string[];
  /** Modules reachable from globalSetup. */
  readonly globalSetupModules: readonly string[];
  /** All globbed test specifications for the session. */
  readonly allSpecs: readonly string[];
}

export interface BuiltReverseMap {
  /** source file → related spec paths */
  readonly relatedBySource: Map<string, string[]>;
  /** Candidates only reachable via globalSetup (respawn once before scoring). */
  readonly globalSetupOnly: Set<string>;
}

/** Alias kept for tests / FakeTestRunner; same realpath normalization as the RAM plugin. */
export function normalizeGraphPath(filePath: string): string {
  return normalizeModulePath(filePath);
}

/**
 * Invert static imports and attach setupFiles / globalSetup modules to the
 * current target spec set (ADR-005 / §6.3).
 */
export function buildReverseMap(
  graph: SpecImportGraph,
  candidates: readonly string[],
): BuiltReverseMap {
  const staticRelated = invertStaticImports(graph.importsBySpec);
  const setupSet = toNormalizedSet(graph.setupModules);
  const globalSet = toNormalizedSet(graph.globalSetupModules);
  const allSpecsNorm = graph.allSpecs.map(normalizeGraphPath);
  const candidateNorms = candidates.map(normalizeGraphPath);

  const targetSpecs = resolveTargetSpecs(
    candidateNorms,
    staticRelated,
    setupSet,
    globalSet,
    allSpecsNorm,
  );

  const relatedBySource = new Map<string, string[]>();
  for (const [source, specs] of staticRelated) {
    relatedBySource.set(source, [...specs].sort());
  }

  attachSetupGraphs(relatedBySource, setupSet, globalSet, targetSpecs);

  const globalSetupOnly = new Set<string>();
  for (const candidate of candidateNorms) {
    if (globalSet.has(candidate) && !staticRelated.has(candidate)) {
      globalSetupOnly.add(candidate);
    }
  }

  return { relatedBySource, globalSetupOnly };
}

function invertStaticImports(
  importsBySpec: ReadonlyMap<string, readonly string[]>,
): Map<string, Set<string>> {
  const inverted = new Map<string, Set<string>>();
  for (const [spec, imports] of importsBySpec) {
    const specNorm = normalizeGraphPath(spec);
    for (const mod of imports) {
      const modNorm = normalizeGraphPath(mod);
      let specs = inverted.get(modNorm);
      if (specs == null) {
        specs = new Set();
        inverted.set(modNorm, specs);
      }
      specs.add(specNorm);
    }
  }
  return inverted;
}

/**
 * Target set = union of static related specs for candidates.
 * If a setup-only / globalSetup-only file is itself a candidate → allSpecs.
 */
function resolveTargetSpecs(
  candidates: readonly string[],
  staticRelated: Map<string, Set<string>>,
  setupSet: Set<string>,
  globalSet: Set<string>,
  allSpecs: readonly string[],
): string[] {
  const target = new Set<string>();
  let setupOnlyCandidate = false;

  for (const candidate of candidates) {
    const related = staticRelated.get(candidate);
    if (related != null && related.size > 0) {
      for (const spec of related) {
        target.add(spec);
      }
      continue;
    }
    if (setupSet.has(candidate) || globalSet.has(candidate)) {
      setupOnlyCandidate = true;
    }
  }

  if (setupOnlyCandidate) {
    return [...allSpecs];
  }
  return [...target];
}

function attachSetupGraphs(
  relatedBySource: Map<string, string[]>,
  setupSet: Set<string>,
  globalSet: Set<string>,
  targetSpecs: readonly string[],
): void {
  if (targetSpecs.length === 0) {
    return;
  }
  const sortedTargets = [...targetSpecs].sort();
  for (const mod of new Set([...setupSet, ...globalSet])) {
    const merged = new Set(relatedBySource.get(mod) ?? []);
    for (const spec of sortedTargets) {
      merged.add(spec);
    }
    relatedBySource.set(mod, [...merged].sort());
  }
}

function toNormalizedSet(paths: readonly string[]): Set<string> {
  return new Set(paths.map(normalizeGraphPath));
}
