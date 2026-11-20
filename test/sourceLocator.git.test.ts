import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitDiffLocator } from "../src/adapters/outbound/git/GitDiffLocator.js";
import { NodeWorkspaceFiles } from "../src/adapters/outbound/fs/NodeWorkspaceFiles.js";
import { GitCommandFailedError } from "../src/domain/targetingErrors.js";
import {
  FakeMutatorEngine,
  FakeTestRunner,
  RecordingReport,
} from "../src/adapters/outbound/memory/index.js";
import { RunMutationSessionUseCase } from "../src/application/use-cases/RunMutationSessionUseCase.js";
import { NOT_A_GIT_REPOSITORY_MESSAGE } from "../src/domain/targetingErrors.js";

async function runGit(
  cwd: string,
  args: string[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, shell: false });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
    });
  });
}

async function initGitRepo(cwd: string): Promise<void> {
  await runGit(cwd, ["init"]);
  await runGit(cwd, ["config", "user.email", "puca@test.local"]);
  await runGit(cwd, ["config", "user.name", "Puca Test"]);
  await runGit(cwd, ["commit", "--allow-empty", "-m", "init"]);
}

function createSession(
  locator: GitDiffLocator,
  cwd?: string,
): {
  useCase: RunMutationSessionUseCase;
  report: RecordingReport;
} {
  const report = new RecordingReport();
  const useCase = new RunMutationSessionUseCase({
    mutator: new FakeMutatorEngine(),
    testRunner: new FakeTestRunner(),
    sourceLocator: locator,
    files: new NodeWorkspaceFiles(cwd),
    report,
  });
  return { useCase, report };
}

describe("Git dirty / --mutate source locating", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-git-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("when a temp git repo has dirty source and test files (AC1)", () => {
    it("should return only the non-excluded dirty .ts file", async () => {
      // Given
      await initGitRepo(tempDir);
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/a.ts"), "export const a = 1;\n");
      await fs.writeFile(
        path.join(tempDir, "src/a.test.ts"),
        "import { a } from './a.js';\n",
      );
      await runGit(tempDir, ["add", "src/a.ts", "src/a.test.ts"]);

      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);

      // When
      const candidates = await locator.candidateFiles(tempDir);

      // Then
      expect(candidates.map((c) => c.file)).toEqual([
        path.resolve(tempDir, "src/a.ts"),
      ]);
    });
  });

  describe("when --mutate glob is provided (AC2)", () => {
    it("should not call git and should return matching non-excluded files", async () => {
      // Given
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/a.ts"), "export const a = 1;\n");
      await fs.writeFile(
        path.join(tempDir, "src/a.test.ts"),
        "import { a } from './a.js';\n",
      );

      const spawnImpl = vi.fn(() => {
        throw new Error("git must not be called when --mutate is set");
      });
      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files, spawnImpl);

      // When
      const candidates = await locator.candidateFiles(tempDir, "**/a.ts");

      // Then
      expect(spawnImpl).not.toHaveBeenCalled();
      expect(candidates.map((c) => c.file)).toEqual([
        path.resolve(tempDir, "src/a.ts"),
      ]);
    });
  });

  describe("when the git tree is clean (AC3)", () => {
    it("should exit 0 with No files to mutate and 0 mutants", async () => {
      // Given
      await initGitRepo(tempDir);
      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);
      const { useCase, report } = createSession(locator);

      // When
      const result = await useCase.execute({ cwd: tempDir });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.message).toBe("No files to mutate");
      expect(result.statuses).toEqual([]);
      expect(report.terminalResults).toHaveLength(1);
      expect(report.terminalResults[0]?.message).toContain("No files to mutate");
      expect(report.terminalResults[0]?.statuses).toHaveLength(0);
    });
  });

  describe("when --mutate matches nothing after excludes (AC4)", () => {
    it("should exit 2 with a refuse-to-score diagnostic", async () => {
      // Given — only an excluded test file matches the glob shape
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "src/a.test.ts"),
        "export {};\n",
      );

      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);
      const { useCase, report } = createSession(locator);

      // When
      const result = await useCase.execute({
        cwd: tempDir,
        mutateGlob: "**/*.ts",
      });

      // Then
      expect(result.exitCode).toBe(2);
      expect(result.message).toMatch(/Refused to score/i);
      expect(result.message).toMatch(/--mutate/i);
      expect(report.terminalResults[0]?.exitCode).toBe(2);
      expect(report.terminalResults[0]?.message).toMatch(/Refused to score/i);
    });
  });

  describe("when cwd is not a git repository and --mutate is absent (AC5)", () => {
    it("should exit 2 with the exact not-a-git-repository stderr message", async () => {
      // Given — tempDir has no .git
      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);
      const { useCase, report } = createSession(locator);

      // When
      const result = await useCase.execute({ cwd: tempDir });

      // Then
      expect(result.exitCode).toBe(2);
      expect(result.message).toBe(NOT_A_GIT_REPOSITORY_MESSAGE);
      expect(report.terminalResults[0]?.message).toBe(
        NOT_A_GIT_REPOSITORY_MESSAGE,
      );
    });
  });

  describe("when --include-untracked is set on a git repo", () => {
    it("should include untracked .ts files that default targeting skips", async () => {
      // Given — committed tree is clean; new module is untracked
      await initGitRepo(tempDir);
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "src/fresh.ts"),
        "export const fresh = 1;\n",
      );
      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);

      // When
      const withoutFlag = await locator.candidateFiles(tempDir);
      const withFlag = await locator.candidateFiles(tempDir, undefined, true);

      // Then
      expect(withoutFlag).toEqual([]);
      expect(withFlag.map((c) => c.file)).toEqual([
        path.resolve(tempDir, "src/fresh.ts"),
      ]);
      expect(withFlag[0]?.lineRanges).toBeUndefined();
    });

    it("should print a skip notice when default targeting ignores untracked files", async () => {
      await initGitRepo(tempDir);
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "src/fresh.ts"),
        "export const fresh = 1;\n",
      );
      await fs.writeFile(
        path.join(tempDir, "src/other.ts"),
        "export const other = 2;\n",
      );
      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);
      const { useCase, report } = createSession(locator);

      const result = await useCase.execute({ cwd: tempDir });

      expect(result.exitCode).toBe(0);
      expect(report.notices).toContain(
        "ℹ 2 untracked files skipped. Pass --include-untracked or --mutate <glob> to target them.",
      );
    });

    it("should not print the skip notice when --include-untracked is set", async () => {
      await initGitRepo(tempDir);
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "src/fresh.ts"),
        "export const fresh = 1;\n",
      );
      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);
      const { useCase, report } = createSession(locator, tempDir);

      await useCase.execute({ cwd: tempDir, includeUntracked: true });

      expect(report.notices.some((line) => line.includes("untracked"))).toBe(
        false,
      );
    });

    it("should still skip gitignored untracked files and hard excludes", async () => {
      // Given
      await initGitRepo(tempDir);
      await fs.writeFile(path.join(tempDir, ".gitignore"), "ignored.ts\n");
      await fs.writeFile(
        path.join(tempDir, "ignored.ts"),
        "export const ignored = 1;\n",
      );
      await fs.writeFile(
        path.join(tempDir, "scratch.test.ts"),
        "export {};\n",
      );
      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);

      // When
      const candidates = await locator.candidateFiles(tempDir, undefined, true);

      // Then
      expect(candidates).toEqual([]);
    });
  });

  describe("when git is spawned (AC6)", () => {
    it("should pass shell: false", async () => {
      // Given
      await initGitRepo(tempDir);
      const spawnCalls: SpawnOptions[] = [];
      const spawnImpl = (
        command: string,
        args: readonly string[],
        options: SpawnOptions,
      ): ChildProcess => {
        spawnCalls.push(options);
        return spawn(command, args as string[], options);
      };
      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files, spawnImpl);

      // When
      await locator.candidateFiles(tempDir);

      // Then
      expect(spawnCalls.length).toBeGreaterThan(0);
      for (const options of spawnCalls) {
        expect(options.shell).toBe(false);
      }
    });

    it("should map non-128 git failures to GitCommandFailedError (R4-M5)", async () => {
      // Given — git exits 1 (e.g. lock / index error), not "not a repo"
      const spawnImpl = (
        _command: string,
        _args: readonly string[],
        _options: SpawnOptions,
      ): ChildProcess => {
        const child = new EventEmitter() as ChildProcess;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        child.stdout = stdout;
        child.stderr = stderr;
        queueMicrotask(() => {
          stderr.write("fatal: index.lock exists\n");
          stdout.end();
          stderr.end();
          child.emit("close", 1);
        });
        return child;
      };
      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files, spawnImpl);

      // When / Then
      await expect(locator.candidateFiles(tempDir)).rejects.toBeInstanceOf(
        GitCommandFailedError,
      );
      await expect(locator.candidateFiles(tempDir)).rejects.toThrow(
        /Pass --mutate/,
      );
    });

    it("should record shell false on a mocked spawn without invoking git", async () => {
      // Given
      const spawnCalls: SpawnOptions[] = [];
      const spawnArgLists: string[][] = [];
      const spawnImpl = (
        _command: string,
        args: readonly string[],
        options: SpawnOptions,
      ): ChildProcess => {
        spawnCalls.push(options);
        spawnArgLists.push([...args]);
        const child = new EventEmitter() as ChildProcess;
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        child.stdout = stdout;
        child.stderr = stderr;
        queueMicrotask(() => {
          stdout.end();
          stderr.end();
          child.emit("close", 0);
        });
        return child;
      };

      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files, spawnImpl);

      // When
      await locator.candidateFiles(tempDir);

      // Then
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0]?.shell).toBe(false);
      expect(spawnCalls[1]?.shell).toBe(false);
      expect(spawnArgLists).toEqual([
        ["diff", "-U0", "HEAD"],
        ["ls-files", "--others", "--exclude-standard"],
      ]);
    });
  });

  describe("when default git targeting has a one-line hunk (SC-505)", () => {
    it("should attach lineRanges for the dirty line only", async () => {
      await initGitRepo(tempDir);
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "src/calc.ts"),
        "export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n",
      );
      await runGit(tempDir, ["add", "src/calc.ts"]);
      await runGit(tempDir, ["commit", "-m", "base"]);
      await fs.writeFile(
        path.join(tempDir, "src/calc.ts"),
        "export function add(a: number, b: number): number {\n  return a - b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n",
      );

      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);
      const candidates = await locator.candidateFiles(tempDir);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.file).toBe(path.resolve(tempDir, "src/calc.ts"));
      expect(candidates[0]?.lineRanges).toEqual([{ start: 2, end: 2 }]);
    });

    it("should omit lineRanges when --full-file is set", async () => {
      await initGitRepo(tempDir);
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/a.ts"), "export const a = 1;\n");
      await runGit(tempDir, ["add", "src/a.ts"]);
      await runGit(tempDir, ["commit", "-m", "base"]);
      await fs.writeFile(path.join(tempDir, "src/a.ts"), "export const a = 2;\n");

      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);
      const candidates = await locator.candidateFiles(
        tempDir,
        undefined,
        false,
        true,
      );

      expect(candidates.map((c) => c.file)).toEqual([
        path.resolve(tempDir, "src/a.ts"),
      ]);
      expect(candidates[0]?.lineRanges).toBeUndefined();
    });

    it("should skip deleted dirty files via exists (SC-502)", async () => {
      await initGitRepo(tempDir);
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "src/gone.ts"), "export const g = 1;\n");
      await runGit(tempDir, ["add", "src/gone.ts"]);
      await runGit(tempDir, ["commit", "-m", "base"]);
      await fs.rm(path.join(tempDir, "src/gone.ts"));

      const files = new NodeWorkspaceFiles(tempDir);
      const locator = new GitDiffLocator(files);
      const candidates = await locator.candidateFiles(tempDir);
      expect(candidates).toEqual([]);
    });
  });
});
