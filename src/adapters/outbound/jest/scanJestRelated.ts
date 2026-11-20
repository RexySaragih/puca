import fs from "node:fs/promises";
import path from "node:path";
import micromatch from "micromatch";
import { normalizeModulePath } from "../vitest/pucaRamPlugin.js";
import { resolveJestSpecDiscovery } from "./resolveProjectJest.js";

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const IMPORT_RE =
  /(?:require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const SKIP_WALK_DIRS = new Set(["node_modules", "dist", ".git", ".puca"]);
const RELATED_IMPORT_HOP_CAP = 8;
const FALLBACK_TEST_ROOTS = ["test", "tests", "__tests__", "src"];

/**
 * Lightweight static scan: map source files → specs that import them.
 * Prefer this over a full Jest dependency graph (lean Wave D).
 */
export async function scanJestRelated(
  cwd: string,
  candidates: readonly string[],
): Promise<{
  readonly relatedBySource: Map<string, readonly string[]>;
  readonly allSpecs: readonly string[];
}> {
  const allSpecs = await collectTestFiles(cwd);
  const relatedBySource = new Map<string, string[]>();
  const candidateNorms = candidates.map((c) => normalizeModulePath(c));
  const aliases = await loadTsPathAliases(cwd);

  for (const norm of candidateNorms) {
    relatedBySource.set(norm, []);
  }

  for (const spec of allSpecs) {
    const content = await fs.readFile(spec, "utf8");
    const imported = await resolveImportedPathsDeep(
      spec,
      content,
      RELATED_IMPORT_HOP_CAP,
      aliases,
    );
    for (const candidate of candidateNorms) {
      if (!imported.has(candidate)) {
        continue;
      }
      const list = relatedBySource.get(candidate);
      if (list != null && !list.includes(spec)) {
        list.push(spec);
      }
    }
  }

  for (const [key, specs] of relatedBySource) {
    relatedBySource.set(
      key,
      [...specs].sort((a, b) => a.localeCompare(b)),
    );
  }

  return { relatedBySource, allSpecs };
}

export { RELATED_IMPORT_HOP_CAP };

async function collectTestFiles(cwd: string): Promise<string[]> {
  const discovery = await resolveJestSpecDiscovery(cwd);
  if (discovery != null) {
    return collectSpecsFromDiscovery(cwd, discovery);
  }
  return collectTestFilesFallback(cwd);
}

async function collectSpecsFromDiscovery(
  cwd: string,
  discovery: {
    readonly testMatch?: readonly string[];
    readonly testRegex?: readonly string[];
  },
): Promise<string[]> {
  const found: string[] = [];
  await walkAllFiles(cwd, cwd, (full, relative) => {
    if (matchesJestDiscovery(relative, discovery)) {
      found.push(normalizeModulePath(full));
    }
  });
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}

function matchesJestDiscovery(
  relative: string,
  discovery: {
    readonly testMatch?: readonly string[];
    readonly testRegex?: readonly string[];
  },
): boolean {
  const posix = relative.replaceAll("\\", "/");
  if (discovery.testMatch != null) {
    return micromatch.isMatch(posix, [...discovery.testMatch], {
      dot: true,
    });
  }
  if (discovery.testRegex != null) {
    return discovery.testRegex.some((pattern) => {
      try {
        return new RegExp(pattern).test(posix);
      } catch {
        return false;
      }
    });
  }
  return false;
}

async function collectTestFilesFallback(cwd: string): Promise<string[]> {
  const found: string[] = [];
  for (const root of FALLBACK_TEST_ROOTS) {
    await walkTests(path.join(cwd, root), found);
  }
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
        found.push(normalizeModulePath(path.join(cwd, entry.name)));
      }
    }
  } catch {
    // cwd unreadable — ignore
  }
  return [...new Set(found)].sort((a, b) => a.localeCompare(b));
}

async function walkTests(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_WALK_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkTests(full, out);
      continue;
    }
    if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      out.push(normalizeModulePath(full));
    }
  }
}

async function walkAllFiles(
  cwd: string,
  dir: string,
  visit: (full: string, relative: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_WALK_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAllFiles(cwd, full, visit);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    visit(full, path.relative(cwd, full));
  }
}

interface PathAliasConfig {
  readonly baseUrl: string;
  readonly paths: readonly {
    readonly pattern: string;
    readonly targets: readonly string[];
  }[];
}

async function loadTsPathAliases(cwd: string): Promise<PathAliasConfig | undefined> {
  try {
    const raw = await fs.readFile(path.join(cwd, "tsconfig.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      compilerOptions?: { baseUrl?: unknown; paths?: unknown };
    };
    const compiler = parsed.compilerOptions;
    if (compiler == null) {
      return undefined;
    }
    const baseUrlRaw =
      typeof compiler.baseUrl === "string" ? compiler.baseUrl : ".";
    const baseUrl = path.resolve(cwd, baseUrlRaw);
    const paths: { pattern: string; targets: string[] }[] = [];
    if (compiler.paths != null && typeof compiler.paths === "object") {
      for (const [pattern, targets] of Object.entries(
        compiler.paths as Record<string, unknown>,
      )) {
        if (!Array.isArray(targets)) {
          continue;
        }
        const mapped = targets.filter(
          (entry): entry is string => typeof entry === "string",
        );
        if (mapped.length > 0) {
          paths.push({ pattern, targets: mapped });
        }
      }
    }
    return { baseUrl, paths };
  } catch {
    return undefined;
  }
}

function resolveImportedPaths(
  fromFile: string,
  content: string,
  aliases: PathAliasConfig | undefined,
): Set<string> {
  const resolved = new Set<string>();
  const dir = path.dirname(fromFile);
  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(content)) != null) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec == null) {
      continue;
    }
    for (const absolute of resolveSpecifier(dir, spec, aliases)) {
      resolved.add(normalizeModulePath(absolute));
    }
  }
  return resolved;
}

function resolveSpecifier(
  fromDir: string,
  spec: string,
  aliases: PathAliasConfig | undefined,
): string[] {
  if (spec.startsWith(".")) {
    return expandJsExtensions(path.resolve(fromDir, spec));
  }
  if (aliases == null) {
    return [];
  }
  const aliased = resolvePathAlias(spec, aliases);
  if (aliased.length > 0) {
    return aliased;
  }
  return expandJsExtensions(path.resolve(aliases.baseUrl, spec));
}

function resolvePathAlias(spec: string, aliases: PathAliasConfig): string[] {
  const resolved: string[] = [];
  for (const alias of aliases.paths) {
    const captured = matchStarPattern(alias.pattern, spec);
    if (captured == null) {
      continue;
    }
    for (const target of alias.targets) {
      const mapped = target.includes("*")
        ? target.replace("*", captured)
        : target;
      resolved.push(
        ...expandJsExtensions(path.resolve(aliases.baseUrl, mapped)),
      );
    }
  }
  return resolved;
}

function matchStarPattern(pattern: string, spec: string): string | undefined {
  if (!pattern.includes("*")) {
    return spec === pattern ? "" : undefined;
  }
  const star = pattern.indexOf("*");
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) {
    return undefined;
  }
  return spec.slice(prefix.length, spec.length - suffix.length);
}

/**
 * Resolve imports, then follow up to `maxDepth` re-export hops
 * (e.g. test → catalog/index.js → inventory.js).
 */
async function resolveImportedPathsDeep(
  fromFile: string,
  content: string,
  maxDepth: number,
  aliases: PathAliasConfig | undefined,
): Promise<Set<string>> {
  const resolved = resolveImportedPaths(fromFile, content, aliases);
  if (maxDepth <= 0) {
    return resolved;
  }
  const queue = [...resolved];
  const seen = new Set(resolved);
  let depth = 0;
  let layerSize = queue.length;
  while (queue.length > 0 && depth < maxDepth) {
    const next = queue.shift()!;
    layerSize -= 1;
    let body: string;
    try {
      body = await fs.readFile(next, "utf8");
    } catch {
      if (layerSize === 0) {
        depth += 1;
        layerSize = queue.length;
      }
      continue;
    }
    for (const child of resolveImportedPaths(next, body, aliases)) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      resolved.add(child);
      queue.push(child);
    }
    if (layerSize === 0) {
      depth += 1;
      layerSize = queue.length;
    }
  }
  return resolved;
}

function expandJsExtensions(absolute: string): string[] {
  const ext = path.extname(absolute);
  if (ext !== "") {
    return [absolute];
  }
  return [
    absolute,
    `${absolute}.js`,
    `${absolute}.cjs`,
    `${absolute}.mjs`,
    `${absolute}.ts`,
    `${absolute}.tsx`,
    `${absolute}.jsx`,
    path.join(absolute, "index.js"),
    path.join(absolute, "index.ts"),
  ];
}
