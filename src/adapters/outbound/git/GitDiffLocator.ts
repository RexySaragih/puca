import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import micromatch from "micromatch";
import type { SourceLocatorPort } from "../../../application/ports/outbound/SourceLocatorPort.js";
import type { WorkspaceFilesPort } from "../../../application/ports/outbound/WorkspaceFilesPort.js";
import { isHardExcluded } from "../../../domain/excludes.js";
import { toAbsolutePath, type AbsolutePath } from "../../../domain/mutant.js";
import {
  EmptyMutateMatchError,
  NotAGitRepositoryError,
} from "../../../domain/targetingErrors.js";

/** Eligible mutate/git sources: TS (default Vitest path) and JS (Jest fixtures). */
const SOURCE_EXT = /\.([cm]?[jt]sx?)$/;
const SKIP_WALK_DIRS = new Set(["node_modules", "dist"]);

export type GitSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Prod SourceLocatorPort: git dirty `.ts`/`.tsx`/`.js` under cwd, or --mutate glob.
 * Untracked files are ignored unless includeUntracked. Hard excludes are never returned.
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
  ): Promise<readonly AbsolutePath[]> {
    this.untrackedSkipped = 0;
    if (mutateGlob !== undefined && mutateGlob.length > 0) {
      return this.candidatesFromMutateGlob(cwd, mutateGlob);
    }
    return this.candidatesFromGitDiff(cwd, includeUntracked === true);
  }

  private async candidatesFromMutateGlob(
    cwd: string,
    mutateGlob: string,
  ): Promise<readonly AbsolutePath[]> {
    const relativeSourceFiles = await listRelativeSourceFiles(cwd);
    const matched = micromatch(relativeSourceFiles, mutateGlob);
    const eligible = this.filterEligible(cwd, matched);

    if (eligible.length === 0) {
      throw new EmptyMutateMatchError(mutateGlob);
    }
    return eligible;
  }

  private async candidatesFromGitDiff(
    cwd: string,
    includeUntracked: boolean,
  ): Promise<readonly AbsolutePath[]> {
    const dirty = parseGitPathLines(
      await this.runGit(cwd, ["diff", "--name-only", "HEAD"]),
    );
    const untracked = parseGitPathLines(
      await this.runGit(cwd, ["ls-files", "--others", "--exclude-standard"]),
    );
    const untrackedEligible = this.filterEligible(cwd, untracked);

    if (includeUntracked) {
      return this.filterEligible(cwd, uniquePaths([...dirty, ...untracked]));
    }

    this.untrackedSkipped = untrackedEligible.length;
    return this.filterEligible(cwd, dirty);
  }

  private filterEligible(
    cwd: string,
    relativePaths: readonly string[],
  ): AbsolutePath[] {
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
        reject(error);
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

        reject(
          new Error(
            `git ${args.join(" ")} failed (exit ${String(code)}): ${stderr.trim()}`,
          ),
        );
      });
    });
  }
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
