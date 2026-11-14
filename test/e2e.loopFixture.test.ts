import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
/**
 * AC1 cwd: fixtures/loop — product resolves vitest from this cwd's node_modules
 * (symlinked to the repo root node_modules in beforeAll).
 */
const fixtureCwd = path.resolve(repoRoot, "fixtures/loop");
/** Larger independent-module fixture so N=4 wall-clock can beat sequential (SC-202). */
const parallelFixtureCwd = path.resolve(repoRoot, "fixtures/loop-parallel");
const cliJs = path.resolve(repoRoot, "dist/cli.js");
const oraclePath = path.resolve(fixtureCwd, "oracle.statuses.json");

const MUTATE_GLOB = "src/**/*.ts";
const OUTER_TIMEOUT_MS = 4000;
const PARALLEL_TIMEOUT_MS = 5000;
const SPAWN_WALL_MS = 60_000;
const PARALLEL_SPAWN_WALL_MS = 180_000;

interface OracleStatus {
  readonly file: string;
  readonly mutatorName: string;
  readonly original: string;
  readonly replacement: string;
  readonly status: string;
  readonly killedBy?: string;
}

interface OracleDocument {
  readonly exitCode: number;
  readonly statuses: readonly OracleStatus[];
}

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly report: SchemaReport | null;
  readonly elapsedMs: number;
}

interface SchemaReport {
  readonly files: Record<
    string,
    {
      readonly mutants: readonly {
        readonly id: string;
        readonly mutatorName: string;
        readonly replacement: string;
        readonly status: string;
        readonly killedBy?: readonly string[];
      }[];
    }
  >;
}

describe("Loop fixture E2E and no-sandbox proof", () => {
  let oracle: OracleDocument;

  beforeAll(async () => {
    await fs.access(cliJs);
    oracle = JSON.parse(await fs.readFile(oraclePath, "utf8")) as OracleDocument;

    for (const cwd of [fixtureCwd, parallelFixtureCwd]) {
      const fixtureModules = path.join(cwd, "node_modules");
      try {
        await fs.access(path.join(fixtureModules, "vitest"));
      } catch {
        await fs.symlink(
          path.join(repoRoot, "node_modules"),
          fixtureModules,
          "dir",
        );
      }
    }
  });

  afterAll(async () => {
    // Leave fixtures/loop/node_modules symlink for local `puca` runs.
  });

  describe("when puca --mutate runs against fixtures/loop (AC1)", () => {
    it("should match checked-in oracle statuses and §8 exit code", async () => {
      // Given / When — cwd documented: fixtures/loop
      const jsonOut = path.join(os.tmpdir(), `puca-loop-${String(process.pid)}.json`);
      const run = await spawnPuca(fixtureCwd, [
        "--mutate",
        MUTATE_GLOB,
        "--timeout",
        String(OUTER_TIMEOUT_MS),
        "--json",
        jsonOut,
      ]);

      // Then
      expect(run.exitCode, run.stderr || run.stdout).toBe(oracle.exitCode);
      const actual = statusesFromReport(run.report, fixtureCwd);
      expect(sortStatuses(actual)).toEqual(sortStatuses(oracle.statuses));

      // Disable-comment: skipped.ts must contribute no sites
      expect(actual.every((entry) => entry.file !== "src/skipped.ts")).toBe(true);

      await fs.rm(jsonOut, { force: true });
    }, SPAWN_WALL_MS);
  });

  describe("when the workspace is scanned after the run (AC2)", () => {
    it("should find no .puca-tmp, .stryker-tmp, or mutated copies of fixture src", async () => {
      // Given — a completed mutate run
      const jsonOut = path.join(os.tmpdir(), `puca-loop-scan-${String(process.pid)}.json`);
      await spawnPuca(fixtureCwd, [
        "--mutate",
        MUTATE_GLOB,
        "--timeout",
        String(OUTER_TIMEOUT_MS),
        "--json",
        jsonOut,
      ]);

      // When
      const hits = await walkForbiddenArtifacts(repoRoot, fixtureCwd);

      // Then
      expect(hits).toEqual([]);
      await fs.rm(jsonOut, { force: true });
    }, SPAWN_WALL_MS);
  });

  describe("when two cold runs execute on the fixture (AC3)", () => {
    it("should produce equal statuses sorted by site id", async () => {
      const firstJson = path.join(os.tmpdir(), `puca-loop-a-${String(process.pid)}.json`);
      const secondJson = path.join(os.tmpdir(), `puca-loop-b-${String(process.pid)}.json`);

      const first = await spawnPuca(fixtureCwd, [
        "--mutate",
        MUTATE_GLOB,
        "--timeout",
        String(OUTER_TIMEOUT_MS),
        "--json",
        firstJson,
      ]);
      const second = await spawnPuca(fixtureCwd, [
        "--mutate",
        MUTATE_GLOB,
        "--timeout",
        String(OUTER_TIMEOUT_MS),
        "--json",
        secondJson,
      ]);

      const a = sortBySiteId(first.report);
      const b = sortBySiteId(second.report);
      expect(a).toEqual(b);
      expect(first.exitCode).toBe(second.exitCode);

      await fs.rm(firstJson, { force: true });
      await fs.rm(secondJson, { force: true });
    }, SPAWN_WALL_MS * 2);
  });

  describe("when the NAPI addon is missing (AC4 / SC-310)", () => {
    it("should exit 2 with UX-003 without sharing the repo node_modules", async () => {
      // Given — isolated package root (R16: do not symlink repo node_modules)
      const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "puca-no-napi-"));
      const rootPkg = JSON.parse(
        await fs.readFile(path.join(repoRoot, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
      };
      await fs.writeFile(
        path.join(emptyRoot, "package.json"),
        JSON.stringify(
          {
            name: "puca-no-napi",
            type: "module",
            dependencies: rootPkg.dependencies ?? {},
          },
          null,
          2,
        ),
        "utf8",
      );
      await fs.cp(path.join(repoRoot, "dist"), path.join(emptyRoot, "dist"), {
        recursive: true,
      });
      await fs.cp(path.join(repoRoot, "schema"), path.join(emptyRoot, "schema"), {
        recursive: true,
      });
      await spawnNpmInstall(emptyRoot);

      const fixtureCopy = path.join(emptyRoot, "fixtures-loop");
      await fs.cp(fixtureCwd, fixtureCopy, {
        recursive: true,
        filter: (src) => !src.includes(`${path.sep}node_modules`),
      });
      await spawnNpmInstall(fixtureCopy);

      // When — CLI loads from emptyRoot/dist (no .node, no puca-<abi>)
      const run = await spawnNode(
        emptyRoot,
        [path.join(emptyRoot, "dist", "cli.js"), "--mutate", "src/**/*.ts"],
        { cwd: fixtureCopy },
      );

      // Then
      expect(run.exitCode).toBe(2);
      expect(run.stderr + run.stdout).toMatch(/Native Púca addon is missing for/);
      expect(run.stderr + run.stdout).toMatch(/puca-/);
      expect(run.stderr + run.stdout).toMatch(/npm run build/);

      await fs.rm(emptyRoot, { recursive: true, force: true });
    }, SPAWN_WALL_MS);
  });

  describe("when subtract mutants run after add mutants (AC5)", () => {
    it("should kill the subtract mutant via the subtracts test (no add-mutant leak)", async () => {
      const jsonOut = path.join(os.tmpdir(), `puca-loop-leak-${String(process.pid)}.json`);
      const run = await spawnPuca(fixtureCwd, [
        "--mutate",
        MUTATE_GLOB,
        "--timeout",
        String(OUTER_TIMEOUT_MS),
        "--json",
        jsonOut,
      ]);

      const subtract = statusesFromReport(run.report, fixtureCwd).find(
        (entry) =>
          entry.file === "src/calc.ts" &&
          entry.original === "-" &&
          entry.replacement === "+",
      );

      // Leak of the add mutant would fail `calc > adds` first (bail:1).
      expect(subtract?.status).toBe("Killed");
      expect(subtract?.killedBy).toBe("calc > subtracts");

      await fs.rm(jsonOut, { force: true });
    }, SPAWN_WALL_MS);
  });

  describe("when --workers 1 runs against fixtures/loop (Phase 2 AC1)", () => {
    it("should match the Phase 1 oracle sorted by site.id", async () => {
      const jsonOut = path.join(
        os.tmpdir(),
        `puca-loop-w1-${String(process.pid)}.json`,
      );
      const run = await spawnPuca(fixtureCwd, [
        "--workers",
        "1",
        "--mutate",
        MUTATE_GLOB,
        "--timeout",
        String(OUTER_TIMEOUT_MS),
        "--json",
        jsonOut,
      ]);

      expect(run.exitCode, run.stderr || run.stdout).toBe(oracle.exitCode);
      const actual = statusesFromReport(run.report, fixtureCwd);
      expect(sortStatuses(actual)).toEqual(sortStatuses(oracle.statuses));
      expect(sortBySiteId(run.report)).toEqual(sortBySiteId(run.report));

      await fs.rm(jsonOut, { force: true });
    }, SPAWN_WALL_MS);
  });

  describe("when --workers 4 runs against fixtures/loop-parallel (Phase 2 AC2/AC3)", () => {
    it("should match workers 1 statuses and finish no slower, without sandbox artifacts", async () => {
      const jsonW1 = path.join(
        os.tmpdir(),
        `puca-loop-par-w1-${String(process.pid)}.json`,
      );
      const jsonW4 = path.join(
        os.tmpdir(),
        `puca-loop-par-w4-${String(process.pid)}.json`,
      );

      const workers1 = await spawnPuca(
        parallelFixtureCwd,
        [
          "--workers",
          "1",
          "--mutate",
          MUTATE_GLOB,
          "--timeout",
          String(PARALLEL_TIMEOUT_MS),
          "--json",
          jsonW1,
        ],
        PARALLEL_SPAWN_WALL_MS,
      );
      const workers4 = await spawnPuca(
        parallelFixtureCwd,
        [
          "--workers",
          "4",
          "--mutate",
          MUTATE_GLOB,
          "--timeout",
          String(PARALLEL_TIMEOUT_MS),
          "--json",
          jsonW4,
        ],
        PARALLEL_SPAWN_WALL_MS,
      );

      expect(workers4.exitCode, workers4.stderr || workers4.stdout).toBe(
        workers1.exitCode,
      );
      expect(sortBySiteId(workers4.report)).toEqual(sortBySiteId(workers1.report));
      expect(
        workers4.elapsedMs,
        `w4=${String(workers4.elapsedMs)}ms w1=${String(workers1.elapsedMs)}ms`,
      ).toBeLessThanOrEqual(workers1.elapsedMs);

      const hits = await walkForbiddenArtifacts(repoRoot, parallelFixtureCwd);
      expect(hits).toEqual([]);

      await fs.rm(jsonW1, { force: true });
      await fs.rm(jsonW4, { force: true });
    }, PARALLEL_SPAWN_WALL_MS * 2);
  });
});

async function spawnNpmInstall(cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "npm",
      ["install", "--ignore-scripts", "--no-fund", "--no-audit"],
      {
        cwd,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
      reject(new Error(`npm install failed in ${cwd}: ${stderr}`));
    });
  });
}

async function spawnPuca(
  cwd: string,
  args: readonly string[],
  wallMs: number = SPAWN_WALL_MS,
): Promise<RunResult> {
  return spawnNode(cwd, [cliJs, ...args], { cwd, wallMs });
}

async function spawnNode(
  _unusedCwd: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly wallMs?: number },
): Promise<RunResult> {
  const wallMs = options.wallMs ?? SPAWN_WALL_MS;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(process.execPath, [...args], {
      cwd: options.cwd,
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

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`puca spawn exceeded ${String(wallMs)}ms\n${stderr}\n${stdout}`));
    }, wallMs);

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
            report = JSON.parse(await fs.readFile(jsonPath, "utf8")) as SchemaReport;
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
        elapsedMs: Date.now() - started,
      });
    });
  });
}

function statusesFromReport(
  report: SchemaReport | null,
  _cwd: string,
): OracleStatus[] {
  if (report == null) {
    return [];
  }
  const out: OracleStatus[] = [];
  for (const [file, entry] of Object.entries(report.files)) {
    for (const mutant of entry.mutants) {
      const killedBy =
        mutant.killedBy != null && mutant.killedBy.length > 0
          ? mutant.killedBy[0]
          : undefined;
      out.push({
        file,
        mutatorName: mutant.mutatorName,
        original: guessOriginal(file, mutant.replacement),
        replacement: mutant.replacement,
        status: mutant.status,
        ...(killedBy != null ? { killedBy } : {}),
      });
    }
  }
  return out;
}

function guessOriginal(file: string, replacement: string): string {
  if (file.endsWith("calc.ts") && replacement === "-") {
    return "+";
  }
  if (file.endsWith("calc.ts") && replacement === "+") {
    return "-";
  }
  if (file.endsWith("hang.ts") && replacement === "true") {
    return "enabled";
  }
  if (file.endsWith("hang.ts") && replacement === "false") {
    return "enabled";
  }
  if (file.endsWith("uncovered.ts") && replacement === "/") {
    return "*";
  }
  return "?";
}

function sortStatuses(statuses: readonly OracleStatus[]): OracleStatus[] {
  return [...statuses].sort((a, b) => {
    const keyA = `${a.file}|${a.mutatorName}|${a.original}|${a.replacement}`;
    const keyB = `${b.file}|${b.mutatorName}|${b.original}|${b.replacement}`;
    return keyA.localeCompare(keyB);
  });
}

function sortBySiteId(report: SchemaReport | null): string[] {
  if (report == null) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of Object.values(report.files)) {
    for (const mutant of entry.mutants) {
      const killed = mutant.killedBy?.[0] ?? "";
      ids.push(`${mutant.id}|${mutant.status}|${killed}`);
    }
  }
  return ids.sort();
}

async function walkForbiddenArtifacts(
  repoRoot: string,
  fixtureCwd: string,
): Promise<string[]> {
  const hits: string[] = [];
  const originalSources = new Map<string, string>();
  const srcDir = path.join(fixtureCwd, "src");
  const srcEntries = await fs.readdir(srcDir);
  for (const name of srcEntries) {
    if (!name.endsWith(".ts")) {
      continue;
    }
    const file = path.join(srcDir, name);
    originalSources.set(file, await fs.readFile(file, "utf8"));
  }

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "target") {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === ".puca-tmp" ||
          entry.name === ".stryker-tmp" ||
          entry.name === ".puca"
        ) {
          hits.push(full);
          continue;
        }
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name === "cache.json" && dir.endsWith(`${path.sep}.puca`)) {
        hits.push(full);
        continue;
      }
      // Mutated copies of fixture src would differ from the pristine originals.
      for (const [originalPath, original] of originalSources) {
        if (full === originalPath) {
          const current = await fs.readFile(full, "utf8");
          if (current !== original) {
            hits.push(`mutated-in-place:${full}`);
          }
        }
      }
    }
  }

  await walk(repoRoot);
  return hits;
}
