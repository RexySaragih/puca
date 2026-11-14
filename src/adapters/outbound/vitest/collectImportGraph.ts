import path from "node:path";
import type { SpecImportGraph } from "./reverseMap.js";
import { normalizeModulePath } from "./pucaRamPlugin.js";

/** Minimal Vite environment surface used for SSR import walking. */
export interface ViteEnvironmentLike {
  readonly name?: string;
  transformRequest?(url: string): Promise<{ code?: string; deps?: string[] } | null>;
  readonly moduleGraph: {
    getModuleById(id: string): ViteModuleNodeLike | undefined;
    getModulesByFile(file: string): Set<ViteModuleNodeLike> | undefined;
  };
}

export interface ViteModuleNodeLike {
  readonly id: string | null;
  readonly file: string | null;
  readonly url?: string;
  readonly importedModules: Set<ViteModuleNodeLike>;
}

export interface VitestProjectLike {
  readonly config: {
    readonly root: string;
    readonly setupFiles?: readonly string[];
    readonly globalSetup?: readonly string[] | string;
  };
  readonly vite: {
    readonly environments: Record<string, ViteEnvironmentLike>;
  };
}

export interface VitestSpecLike {
  readonly moduleId: string;
}

/**
 * Vitest session surface needed to collect a SpecImportGraph.
 * Intentionally narrow — only what collectImportGraph reads.
 */
export interface VitestGraphHost {
  globTestSpecifications(filters?: string[]): Promise<readonly VitestSpecLike[]>;
  getRootProject(): VitestProjectLike;
  readonly projects?: readonly VitestProjectLike[];
}

const NODE_MODULES_SEGMENT = `${path.sep}node_modules${path.sep}`;

/**
 * Collect static SSR-style imports for every globbed spec, plus setup/globalSetup
 * reachable modules (ADR-005 / §6.3).
 */
export async function collectImportGraph(
  vitest: VitestGraphHost,
): Promise<SpecImportGraph> {
  const specs = await vitest.globTestSpecifications();
  const allSpecs = specs.map((spec) => normalizeModulePath(spec.moduleId));
  const project = vitest.getRootProject();
  const env = resolveWalkEnvironment(project);

  const importsBySpec = new Map<string, readonly string[]>();
  for (const spec of specs) {
    const specPath = normalizeModulePath(spec.moduleId);
    const imports = await collectReachableModules(env, project.config.root, specPath);
    importsBySpec.set(specPath, imports);
  }

  const setupFiles = (project.config.setupFiles ?? []).map(normalizeModulePath);
  const globalSetupFiles = normalizeGlobalSetup(project.config.globalSetup);

  const setupModules = await collectRootsReachable(
    env,
    project.config.root,
    setupFiles,
  );
  const globalSetupModules = await collectRootsReachable(
    env,
    project.config.root,
    globalSetupFiles,
  );

  return {
    importsBySpec,
    setupModules,
    globalSetupModules,
    allSpecs,
  };
}

function resolveWalkEnvironment(project: VitestProjectLike): ViteEnvironmentLike {
  const envs = project.vite.environments;
  return envs.ssr ?? envs.__vitest__ ?? Object.values(envs)[0]!;
}

function normalizeGlobalSetup(
  globalSetup: readonly string[] | string | undefined,
): string[] {
  if (globalSetup == null) {
    return [];
  }
  if (typeof globalSetup === "string") {
    return [normalizeModulePath(globalSetup)];
  }
  return globalSetup.map(normalizeModulePath);
}

async function collectRootsReachable(
  env: ViteEnvironmentLike,
  root: string,
  roots: readonly string[],
): Promise<string[]> {
  const all = new Set<string>();
  for (const rootFile of roots) {
    const reachable = await collectReachableModules(env, root, rootFile);
    all.add(normalizeModulePath(rootFile));
    for (const mod of reachable) {
      all.add(mod);
    }
  }
  return [...all].sort();
}

/**
 * Transform each node (populates Vite importedModules + transform deps), then
 * walk static imports and `export { x } from` / `export * from` re-export edges.
 */
async function collectReachableModules(
  env: ViteEnvironmentLike,
  root: string,
  entry: string,
): Promise<string[]> {
  const entryNorm = normalizeModulePath(entry);
  const visited = new Set<string>([entryNorm]);
  const imports: string[] = [];
  const queue: string[] = [entryNorm];

  while (queue.length > 0) {
    const current = queue.pop()!;
    const depsFromTransform = await transformDeps(env, root, current);
    const node = findModuleNode(env, current);
    const children = new Set<string>();

    if (node != null) {
      for (const imported of node.importedModules) {
        const file = moduleFilePath(imported);
        if (file != null) {
          children.add(file);
        }
      }
    }
    for (const dep of depsFromTransform) {
      const file = resolveDepToFile(root, dep);
      if (file != null) {
        children.add(file);
      }
    }

    for (const file of children) {
      if (!isLocalSourceFile(file) || visited.has(file)) {
        continue;
      }
      visited.add(file);
      imports.push(file);
      queue.push(file);
    }
  }

  return imports.sort();
}

async function transformDeps(
  env: ViteEnvironmentLike,
  root: string,
  filePath: string,
): Promise<readonly string[]> {
  if (env.transformRequest == null) {
    return [];
  }
  const result = await requestTransform(env, root, filePath);
  return result?.deps ?? [];
}

async function requestTransform(
  env: ViteEnvironmentLike,
  root: string,
  filePath: string,
): Promise<{ code?: string; deps?: string[] } | null> {
  if (env.transformRequest == null) {
    return null;
  }
  const absoluteUrl = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(root, filePath);
  const rootRelative = `/${path.relative(root, absoluteUrl).split(path.sep).join("/")}`;
  try {
    return await env.transformRequest(absoluteUrl);
  } catch {
    try {
      return await env.transformRequest(rootRelative);
    } catch {
      return null;
    }
  }
}

function resolveDepToFile(root: string, dep: string): string | null {
  const cleaned = stripViteId(dep);
  if (cleaned.length === 0 || cleaned.includes("\0")) {
    return null;
  }
  if (path.isAbsolute(cleaned)) {
    return normalizeModulePath(cleaned);
  }
  if (cleaned.startsWith("/")) {
    return normalizeModulePath(path.join(root, cleaned.slice(1)));
  }
  return normalizeModulePath(path.resolve(root, cleaned));
}

function stripViteId(id: string): string {
  const withoutQuery = id.split("?")[0] ?? id;
  return withoutQuery.split("#")[0] ?? withoutQuery;
}

function findModuleNode(
  env: ViteEnvironmentLike,
  fileOrId: string,
): ViteModuleNodeLike | undefined {
  const byId = env.moduleGraph.getModuleById(fileOrId);
  if (byId != null) {
    return byId;
  }
  const byFile = env.moduleGraph.getModulesByFile(fileOrId);
  if (byFile != null && byFile.size > 0) {
    return [...byFile][0];
  }
  const normalized = normalizeModulePath(fileOrId);
  const byNorm = env.moduleGraph.getModulesByFile(normalized);
  if (byNorm != null && byNorm.size > 0) {
    return [...byNorm][0];
  }
  return undefined;
}

function moduleFilePath(node: ViteModuleNodeLike): string | null {
  if (node.file != null && node.file.length > 0) {
    return normalizeModulePath(node.file);
  }
  if (node.id != null && node.id.length > 0 && !node.id.includes("\0")) {
    const cleaned = node.id.split("?")[0] ?? node.id;
    if (path.isAbsolute(cleaned)) {
      return normalizeModulePath(cleaned);
    }
  }
  return null;
}

function isLocalSourceFile(filePath: string): boolean {
  if (filePath.includes(NODE_MODULES_SEGMENT)) {
    return false;
  }
  if (filePath.includes("/node_modules/") || filePath.includes("\\node_modules\\")) {
    return false;
  }
  return /\.(tsx?|jsx?|mts|cts)$/.test(filePath);
}
