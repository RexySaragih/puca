import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const cliJs = path.resolve(repoRoot, "dist/cli.js");

describe("bin.puca argv realpath", () => {
  let tempDir: string;

  beforeAll(async () => {
    await fs.access(cliJs);
  });

  afterEach(async () => {
    if (tempDir != null) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("when invoked through a node_modules/.bin symlink", () => {
    it("should still run the CLI entry (unknown-flag refuse) instead of importing silently", async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-bin-"));
      const binDir = path.join(tempDir, "node_modules", ".bin");
      await fs.mkdir(binDir, { recursive: true });
      const symlink = path.join(binDir, "puca");
      await fs.symlink(cliJs, symlink);

      const run = await spawnArgv(process.execPath, [symlink, "--not-a-real-flag"]);

      expect(run.exitCode).toBe(2);
      expect(run.stderr).toMatch(/Unknown argument: --not-a-real-flag/);
      expect(run.stdout).toBe("");
    });
  });
});

function spawnArgv(
  command: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command, [...args], {
      cwd: repoRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
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
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}
