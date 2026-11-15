import fs from "node:fs/promises";
import path from "node:path";
import micromatch from "micromatch";
import type { WorkspaceDiscoveryPort } from "../../../application/ports/outbound/WorkspaceDiscoveryPort.js";
import { EmptyWorkspaceMatchError } from "../../../domain/targetingErrors.js";
import { toAbsolutePath, type AbsolutePath } from "../../../domain/mutant.js";

const SKIP_WALK_DIRS = new Set(["node_modules", "dist", ".git", ".puca"]);

/**
 * Prod WorkspaceDiscoveryPort: pnpm-workspace.yaml and/or package.json workspaces.
 * Members are directories with package.json matching declared patterns, then filtered
 * by the --workspace micromatch glob (relative to cwd).
 */
export class NodeWorkspaceDiscovery implements WorkspaceDiscoveryPort {
  async discoverPackageRoots(
    cwd: string,
    workspaceGlob: string,
  ): Promise<readonly AbsolutePath[]> {
    const root = path.resolve(cwd);
    const patterns = await collectWorkspacePatterns(root);
    const members = await expandMembers(root, patterns);
    const relativeMembers = members.map((absolute) =>
      path.relative(root, absolute).replaceAll("\\", "/"),
    );
    const matched = micromatch(relativeMembers, workspaceGlob);
    const roots = matched
      .map((relative) => toAbsolutePath(path.resolve(root, relative)))
      .sort((a, b) => a.localeCompare(b));

    if (roots.length === 0) {
      throw new EmptyWorkspaceMatchError(workspaceGlob);
    }
    return roots;
  }
}

async function collectWorkspacePatterns(root: string): Promise<string[]> {
  const fromPnpm = await readPnpmWorkspacePatterns(root);
  const fromPackageJson = await readPackageJsonWorkspacePatterns(root);
  return unique([...fromPnpm, ...fromPackageJson]);
}

async function readPnpmWorkspacePatterns(root: string): Promise<string[]> {
  const filePath = path.join(root, "pnpm-workspace.yaml");
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return parsePnpmPackagesList(raw);
}

/**
 * Minimal parser for `packages:` list items in pnpm-workspace.yaml.
 * Avoids a YAML dependency for the constrained workspace manifest shape.
 */
export function parsePnpmPackagesList(raw: string): string[] {
  const patterns: string[] = [];
  let inPackages = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    if (/^packages\s*:/.test(trimmed)) {
      inPackages = true;
      const inline = trimmed.slice(trimmed.indexOf(":") + 1).trim();
      if (inline.startsWith("[") && inline.endsWith("]")) {
        patterns.push(...parseInlineYamlArray(inline));
        inPackages = false;
      }
      continue;
    }
    if (!inPackages) {
      continue;
    }
    if (/^[A-Za-z_][\w-]*\s*:/.test(trimmed)) {
      inPackages = false;
      continue;
    }
    const listMatch = trimmed.match(/^-\s+(.+)$/);
    if (listMatch?.[1] !== undefined) {
      patterns.push(stripQuotes(listMatch[1].trim()));
    }
  }
  return patterns.filter((pattern) => pattern.length > 0);
}

function parseInlineYamlArray(inline: string): string[] {
  const inner = inline.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }
  return inner.split(",").map((part) => stripQuotes(part.trim()));
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function readPackageJsonWorkspacePatterns(
  root: string,
): Promise<string[]> {
  const filePath = path.join(root, "package.json");
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") {
    return [];
  }
  const workspaces = (parsed as { workspaces?: unknown }).workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry): entry is string => typeof entry === "string");
  }
  if (
    workspaces !== null &&
    typeof workspaces === "object" &&
    Array.isArray((workspaces as { packages?: unknown }).packages)
  ) {
    return ((workspaces as { packages: unknown[] }).packages).filter(
      (entry): entry is string => typeof entry === "string",
    );
  }
  return [];
}

async function expandMembers(
  root: string,
  patterns: readonly string[],
): Promise<string[]> {
  if (patterns.length === 0) {
    return [];
  }
  const candidates = await listPackageDirectories(root);
  const relative = candidates.map((absolute) =>
    path.relative(root, absolute).replaceAll("\\", "/"),
  );
  const matched = micromatch(relative, [...patterns]);
  return matched.map((rel) => path.resolve(root, rel));
}

async function listPackageDirectories(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (SKIP_WALK_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const absolute = path.join(dir, entry.name);
      if (await hasPackageJson(absolute)) {
        found.push(absolute);
      }
      await walk(absolute);
    }
  }

  await walk(root);
  return found;
}

async function hasPackageJson(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "package.json"));
    return true;
  } catch {
    return false;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
