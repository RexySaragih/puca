import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const fixtureCwd = path.resolve(repoRoot, "fixtures/jest-loop");
const cliJs = path.resolve(repoRoot, "dist/cli.js");

const MUTATE_GLOB = "src/**/*.js";
const OUTER_TIMEOUT_MS = 5000;
const SPAWN_WALL_MS = 120_000;

interface SchemaReport {
  readonly files: Record<
    string,
    {
      readonly mutants: readonly {
        readonly id: string;
        readonly status: string;
      }[];
    }
  >;
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly report: SchemaReport | null;
}

describe("Jest loop fixture E2E (SC-343)", () => {
  beforeAll(async () => {
    await fs.access(cliJs);
    await fs.access(path.join(fixtureCwd, "node_modules", "jest"));
  });

  describe("when --runner jest scores fixtures/jest-loop (AC2)", () => {
    it("should produce mutant statuses with no sandbox dirs", async () => {
      const jsonOut = path.join(
        os.tmpdir(),
        `puca-jest-loop-${String(process.pid)}.json`,
      );
      const run = await spawnPuca(fixtureCwd, [
        "--runner",
        "jest",
        "--mutate",
        MUTATE_GLOB,
        "--timeout",
        String(OUTER_TIMEOUT_MS),
        "--json",
        jsonOut,
      ]);

      expect(run.exitCode, run.stderr || run.stdout).not.toBe(2);
      expect(run.report, run.stderr || run.stdout).not.toBeNull();
      const statuses = statusesFromReport(run.report);
      expect(statuses.length).toBeGreaterThan(0);
      expect(statuses.some((s) => s === "Killed" || s === "Survived")).toBe(
        true,
      );

      const hits = await walkForbiddenSandboxDirs(fixtureCwd);
      expect(hits).toEqual([]);

      await fs.rm(jsonOut, { force: true });
    }, SPAWN_WALL_MS);
  });

  describe("when --runner jest --workers 4 (AC3 / REQ-2003)", () => {
    it("should print single-worker notice and force workers to 1", async () => {
      const jsonOut = path.join(
        os.tmpdir(),
        `puca-jest-workers-${String(process.pid)}.json`,
      );
      const run = await spawnPuca(fixtureCwd, [
        "--runner",
        "jest",
        "--workers",
        "4",
        "--mutate",
        MUTATE_GLOB,
        "--timeout",
        String(OUTER_TIMEOUT_MS),
        "--verbose",
        "--json",
        jsonOut,
      ]);

      expect(run.stderr).toMatch(/single-worker/i);
      expect(run.stderr).toMatch(/forcing --workers 1/i);
      expect(run.stderr).toMatch(/requested 4/i);
      // Verbose footer should not claim a multi-worker pool path.
      expect(run.stdout + run.stderr).not.toMatch(/workers=4/i);
      expect(run.exitCode, run.stderr || run.stdout).not.toBe(2);

      await fs.rm(jsonOut, { force: true });
    }, SPAWN_WALL_MS);
  });

  describe("when --runner jest in a cwd without jest (AC4)", () => {
    it("should exit 2 with a missing-jest diagnostic", async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "puca-no-jest-"));
      try {
        await fs.writeFile(
          path.join(tmp, "package.json"),
          JSON.stringify({ name: "no-jest", private: true }),
        );
        await fs.mkdir(path.join(tmp, "src"));
        await fs.writeFile(
          path.join(tmp, "src", "calc.js"),
          "module.exports.add = (a, b) => a + b;\n",
        );

        const run = await spawnPuca(tmp, [
          "--runner",
          "jest",
          "--mutate",
          "src/**/*.js",
          "--timeout",
          String(OUTER_TIMEOUT_MS),
        ]);

        expect(run.exitCode).toBe(2);
        expect(run.stderr + run.stdout).toMatch(/jest/i);
        expect(run.stderr + run.stdout).toMatch(/not found|install jest/i);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    }, SPAWN_WALL_MS);
  });

  describe("when --runner mocha or --runner without value (AC1)", () => {
    it("should exit 2 naming --runner", async () => {
      const mocha = await spawnPuca(fixtureCwd, ["--runner", "mocha"]);
      expect(mocha.exitCode).toBe(2);
      expect(mocha.stderr).toMatch(/--runner/);

      const missing = await spawnPuca(fixtureCwd, ["--runner"]);
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr).toMatch(/--runner/);
    }, 30_000);
  });
});

function statusesFromReport(report: SchemaReport | null): string[] {
  if (report == null) {
    return [];
  }
  const out: string[] = [];
  for (const entry of Object.values(report.files)) {
    for (const mutant of entry.mutants) {
      out.push(mutant.status);
    }
  }
  return out;
}

async function spawnPuca(
  cwd: string,
  args: readonly string[],
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliJs, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`spawn timed out: puca ${args.join(" ")}`));
    }, SPAWN_WALL_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      const jsonFlag = args.indexOf("--json");
      let report: SchemaReport | null = null;
      if (jsonFlag >= 0) {
        const jsonPath = args[jsonFlag + 1];
        if (jsonPath != null) {
          try {
            report = JSON.parse(
              await fs.readFile(jsonPath, "utf8"),
            ) as SchemaReport;
          } catch {
            report = null;
          }
        }
      }
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        report,
      });
    });
  });
}

async function walkForbiddenSandboxDirs(fixtureCwd: string): Promise<string[]> {
  const hits: string[] = [];
  const originalCalc = await fs.readFile(
    path.join(fixtureCwd, "src", "calc.js"),
    "utf8",
  );

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "target"
      ) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === ".puca-tmp" ||
          entry.name === ".stryker-tmp"
        ) {
          hits.push(full);
          continue;
        }
        await walk(full);
        continue;
      }
      if (
        entry.isFile() &&
        full === path.join(fixtureCwd, "src", "calc.js")
      ) {
        const current = await fs.readFile(full, "utf8");
        if (current !== originalCalc) {
          hits.push(`mutated-in-place:${full}`);
        }
      }
    }
  }

  await walk(fixtureCwd);
  return hits;
}
