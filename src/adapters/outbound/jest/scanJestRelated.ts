import fs from "node:fs/promises";
import path from "node:path";
import { normalizeModulePath } from "../vitest/pucaRamPlugin.js";

const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const IMPORT_RE =
  /(?:require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

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

  for (const norm of candidateNorms) {
    relatedBySource.set(norm, []);
  }

  for (const spec of allSpecs) {
    const content = await fs.readFile(spec, "utf8");
    const imported = resolveImportedPaths(spec, content);
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

async function collectTestFiles(cwd: string): Promise<string[]> {
  const roots = ["test", "tests", "__tests__", "src"];
  const found: string[] = [];
  for (const root of roots) {
    await walkTests(path.join(cwd, root), found);
  }
  // Also pick up top-level *.test.js next to package.json (rare).
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
    if (entry.name === "node_modules" || entry.name === "dist") {
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

function resolveImportedPaths(
  fromFile: string,
  content: string,
): Set<string> {
  const resolved = new Set<string>();
  const dir = path.dirname(fromFile);
  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(content)) != null) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec == null || !spec.startsWith(".")) {
      continue;
    }
    const absolute = path.resolve(dir, spec);
    for (const withExt of expandJsExtensions(absolute)) {
      resolved.add(normalizeModulePath(withExt));
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
