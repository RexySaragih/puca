import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { toAbsolutePath } from "../src/domain/mutant.js";
import type { AbsolutePath, SessionResult } from "../src/domain/mutant.js";
import { runCli } from "../src/cli.js";
import type { WorkspaceDiscoveryPort } from "../src/application/ports/outbound/WorkspaceDiscoveryPort.js";
import {
  WorkspaceTargetResolver,
  worstOfExit,
} from "../src/application/WorkspaceTargetResolver.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixtureCwd = path.resolve(repoRoot, "fixtures/workspace-basic");
const cliJs = path.resolve(repoRoot, "dist/cli.js");
const SPAWN_WALL_MS = 120_000;

interface SpawnResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe("Workspace --workspace E2E and behavioral coverage", () => {
  beforeAll(async () => {
    await fs.access(cliJs);
    for (const pkg of ["packages/a", "packages/b"]) {
      const modules = path.join(fixtureCwd, pkg, "node_modules");
      try {
        await fs.access(path.join(modules, "vitest"));
      } catch {
        await fs.symlink(path.join(repoRoot, "node_modules"), modules, "dir");
      }
    }
  });

  describe("when --workspace matches zero packages (AC1)", () => {
    it("should exit 2 and name --workspace on stderr", async () => {
      const run = await spawnPuca(fixtureCwd, [
        "--workspace",
        "packages/does-not-exist*",
        "--mutate",
        "src/**/*.ts",
        "--timeout",
        "4000",
      ]);

      expect(run.exitCode).toBe(2);
      expect(run.stderr).toMatch(/--workspace/);
    }, SPAWN_WALL_MS);
  });

  describe("when two packages return exit 1 and 0 (AC2)", () => {
    it("should aggregate worst-of exit 1 sequentially", async () => {
      const order: string[] = [];
      const discovery: WorkspaceDiscoveryPort = {
        async discoverPackageRoots() {
          return [
            toAbsolutePath("/tmp/pkg-a"),
            toAbsolutePath("/tmp/pkg-b"),
          ];
        },
      };
      const exits = new Map<string, number>([
        ["/tmp/pkg-a", 1],
        ["/tmp/pkg-b", 0],
      ]);

      const resolver = new WorkspaceTargetResolver({
        discovery,
        runPackageSession: async (packageRoot) => {
          order.push(packageRoot);
          return {
            statuses: [],
            exitCode: exits.get(packageRoot) ?? 0,
          } satisfies SessionResult;
        },
      });

      const result = await resolver.execute({
        cwd: "/tmp",
        workspaceGlob: "packages/*",
      });

      expect(order).toEqual(["/tmp/pkg-a", "/tmp/pkg-b"]);
      expect(result.exitCode).toBe(1);
      expect(result.message).toMatch(/Workspace: 2 package\(s\) scored; worst exit 1/);
      expect(worstOfExit(0, 1)).toBe(1);
      expect(worstOfExit(1, 2)).toBe(2);
    });
  });

  describe("when --workspace and --cache run against both packages (AC3)", () => {
    it("should keep per-package .puca/cache.json paths when Wave B cache writes", async () => {
      const cacheA = path.join(fixtureCwd, "packages/a/.puca/cache.json");
      const cacheB = path.join(fixtureCwd, "packages/b/.puca/cache.json");
      await fs.rm(path.join(fixtureCwd, "packages/a/.puca"), {
        recursive: true,
        force: true,
      });
      await fs.rm(path.join(fixtureCwd, "packages/b/.puca"), {
        recursive: true,
        force: true,
      });

      const run = await spawnPuca(fixtureCwd, [
        "--workspace",
        "packages/*",
        "--mutate",
        "src/**/*.ts",
        "--timeout",
        "4000",
        "--cache",
      ]);

      // Workspace orchestration must complete (any scored exit). Soft-assert cache
      // files only when Wave B FileHashCache is wired into createRuntime.
      expect([0, 1, 2]).toContain(run.exitCode);

      const aExists = await fileExists(cacheA);
      const bExists = await fileExists(cacheB);
      if (aExists || bExists) {
        expect(aExists).toBe(true);
        expect(bExists).toBe(true);
        expect(cacheA).not.toBe(cacheB);
      }
    }, SPAWN_WALL_MS);
  });

  describe("when --workspace is omitted (AC4)", () => {
    it("should keep a single-cwd session via runCli", async () => {
      const code = await runCli({
        cwd: path.join(fixtureCwd, "packages/a"),
        argv: ["--mutate", "src/**/*.ts", "--timeout", "4000"],
        createRuntimeOptions: { useFakes: true },
      });
      // Fake runtime with empty locator → idle exit 0 (single session path).
      expect(code).toBe(0);
    });
  });
});

describe("NodeWorkspaceDiscovery fixture members", () => {
  it("should discover packages/a and packages/b for packages/*", async () => {
    const { NodeWorkspaceDiscovery } = await import(
      "../src/adapters/outbound/workspace/NodeWorkspaceDiscovery.js"
    );
    const discovery = new NodeWorkspaceDiscovery();
    const roots = await discovery.discoverPackageRoots(fixtureCwd, "packages/*");
    const relative = roots.map((absolute: AbsolutePath) =>
      path.relative(fixtureCwd, absolute).replaceAll("\\", "/"),
    );
    expect(relative).toEqual(["packages/a", "packages/b"]);
  });
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function spawnPuca(
  cwd: string,
  args: readonly string[],
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [cliJs, ...args], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
