import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import micromatch from "micromatch";
import type {
  LineRange,
  SourceCandidate,
  SourceLocatorPort,
} from "../../../application/ports/outbound/SourceLocatorPort.js";
import type { WorkspaceFilesPort } from "../../../application/ports/outbound/WorkspaceFilesPort.js";
import { isHardExcluded } from "../../../domain/excludes.js";
import { toAbsolutePath, type AbsolutePath } from "../../../domain/mutant.js";
import {
  EmptyMutateMatchError,
  GitCommandFailedError,
  NotAGitRepositoryError,
} from "../../../domain/targetingErrors.js";

/** Eligible mutate/git sources: TS (default Vitest path) and JS (Jest fixtures). */
const SOURCE_EXT = /\.([cm]?[jt]sx?)$/;
const SKIP_WALK_DIRS = new Set(["node_modules", "dist"]);
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const DIFF_NEW_FILE = /^\+\+\+ b\/(.+)$/;

export type GitSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Prod SourceLocatorPort: git dirty TS/JS sources under cwd, or --mutate glob.
 * Default git mode attaches new-side hunk lineRanges from `git diff -U0 HEAD`.
 */
export class GitDiffLocator implements SourceLocatorPort {
  untrackedSkipped = 0;

  constructor(
    private readonly files: WorkspaceFilesPort,
    private readonly spawnImpl: GitSpawn = spawn,
  ) {}

  async candidateFiles(
    cwd: string,
    mutateGlob?: string,
    includeUntracked?: boolean,
    fullFile?: boolean,
  ): Promise<readonly SourceCandidate[]> {
    this.untrackedSkipped = 0;
    if (mutateGlob !== undefined) {
      if (mutateGlob.trim() === "") {
        throw new EmptyMutateMatchError(mutateGlob);
      }
      return this.candidatesFromMutateGlob(cwd, mutateGlob);
    }
    return this.candidatesFromGitDiff(
      cwd,
      includeUntracked === true,
      fullFile === true,
    );
  }

  private async candidatesFromMutateGlob(
    cwd: string,
    mutateGlob: string,
  ): Promise<readonly SourceCandidate[]> {
    const relativeSourceFiles = await listRelativeSourceFiles(cwd);
    const matched = micromatch(relativeSourceFiles, mutateGlob);
    const eligible = await this.filterEligible(cwd, matched);

    if (eligible.length === 0) {
      throw new EmptyMutateMatchError(mutateGlob);
    }
    return eligible.map((file) => ({ file }));
  }

  private async candidatesFromGitDiff(
    cwd: string,
    includeUntracked: boolean,
    fullFile: boolean,
  ): Promise<readonly SourceCandidate[]> {
    const diffStdout = await this.runGit(cwd, ["diff", "-U0", "HEAD"]);
    const hunksByFile = parseUnifiedDiffHunks(diffStdout);
    const dirty = [...hunksByFile.keys()];
    const untracked = parseGitPathLines(
      await this.runGit(cwd, ["ls-files", "--others", "--exclude-standard"]),
    );
    const untrackedEligible = await this.filterEligible(cwd, untracked);
    const untrackedSet = new Set(
      untrackedEligible.map((file) => pathRelative(cwd, file)),
    );

    if (!includeUntracked) {
      this.untrackedSkipped = untrackedEligible.length;
    }

    const relativePaths = includeUntracked
      ? uniquePaths([...dirty, ...untracked])
      : dirty;

    const eligible = await this.filterEligible(cwd, relativePaths);
    const candidates: SourceCandidate[] = [];

    for (const file of eligible) {
      const relative = pathRelative(cwd, file);
      const isUntrackedOnly =
        includeUntracked && untrackedSet.has(relative) && !hunksByFile.has(relative);

      if (fullFile || isUntrackedOnly) {
        candidates.push({ file });
        continue;
      }

      const ranges = hunksByFile.get(relative);
      if (ranges == null || ranges.length === 0) {
        continue;
      }
      candidates.push({ file, lineRanges: ranges });
    }

    return candidates;
  }

  private async filterEligible(
    cwd: string,
    relativePaths: readonly string[],
  ): Promise<AbsolutePath[]> {
    const eligible: AbsolutePath[] = [];

    for (const relativePath of relativePaths) {
      const normalized = relativePath.replaceAll("\\", "/");
      if (!SOURCE_EXT.test(normalized)) {
        continue;
      }
      if (isHardExcluded(normalized)) {
        continue;
      }

      const absolutePath = path.resolve(cwd, relativePath);
      if (!this.files.isUnderCwd(absolutePath)) {
        continue;
      }
      if (!(await this.files.exists(absolutePath))) {
        continue;
      }
      eligible.push(toAbsolutePath(absolutePath));
    }

    return eligible;
  }

  private runGit(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl("git", args, {
        cwd,
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        const detail =
          error instanceof Error ? error.message : String(error);
        reject(new GitCommandFailedError(detail));
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve(stdout);
          return;
        }

        const combined = `${stderr}\n${stdout}`;
        if (code === 128 || /not a git repository/i.test(combined)) {
          reject(new NotAGitRepositoryError());
          return;
        }

        const detail =
          stderr.trim().length > 0
            ? `git ${args.join(" ")} failed (exit ${String(code)}): ${stderr.trim()}`
            : `git ${args.join(" ")} failed (exit ${String(code)})`;
        reject(new GitCommandFailedError(detail));
      });
    });
  }
}

/** Parse `git diff -U0` into posix-relative paths → merged 1-based new-side ranges. */
export function parseUnifiedDiffHunks(
  stdout: string,
): Map<string, LineRange[]> {
  const byFile = new Map<string, LineRange[]>();
  let current: string | undefined;

  for (const rawLine of stdout.split("\n")) {
    const gitMatch = DIFF_GIT.exec(rawLine);
    if (gitMatch?.[2] != null) {
      current = stripDiffPath(gitMatch[2]);
      if (!byFile.has(current)) {
        byFile.set(current, []);
      }
      continue;
    }
    const plusMatch = DIFF_NEW_FILE.exec(rawLine);
    if (plusMatch?.[1] != null) {
      current = stripDiffPath(plusMatch[1]);
      if (!byFile.has(current)) {
        byFile.set(current, []);
      }
      continue;
    }
    if (current == null) {
      continue;
    }
    const hunk = HUNK_HEADER.exec(rawLine);
    if (hunk?.[1] == null) {
      continue;
    }
    const start = Number(hunk[1]);
    const count = hunk[2] == null ? 1 : Number(hunk[2]);
    if (!Number.isInteger(start) || start < 1 || count <= 0) {
      continue;
    }
    const ranges = byFile.get(current);
    if (ranges == null) {
      continue;
    }
    ranges.push({ start, end: start + count - 1 });
  }

  for (const [file, ranges] of byFile) {
    byFile.set(file, mergeLineRanges(ranges));
  }
  return byFile;
}

function stripDiffPath(raw: string): string {
  const unquoted = raw.replace(/^"/, "").replace(/"$/, "");
  return unquoted.replaceAll("\\", "/");
}

function mergeLineRanges(ranges: readonly LineRange[]): LineRange[] {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: LineRange[] = [];
  let current = sorted[0]!;
  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i]!;
    if (next.start <= current.end + 1) {
      current = {
        start: current.start,
        end: Math.max(current.end, next.end),
      };
      continue;
    }
    merged.push(current);
    current = next;
  }
  merged.push(current);
  return merged;
}

function parseGitPathLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((entry) => entry.replaceAll("\\", "/")))];
}

function pathRelative(cwd: string, file: string): string {
  return path.relative(cwd, file).replaceAll("\\", "/");
}

async function listRelativeSourceFiles(cwd: string): Promise<string[]> {
  const root = path.resolve(cwd);
  const results: string[] = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_WALK_DIRS.has(entry.name)) {
          continue;
        }
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXT.test(entry.name)) {
        continue;
      }
      results.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }

  await walk(root);
  return results;
}
