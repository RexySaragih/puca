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
const cliJs = path.resolve(repoRoot, "dist/cli.js");
const oraclePath = path.resolve(fixtureCwd, "oracle.statuses.json");

const MUTATE_GLOB = "src/**/*.ts";
const OUTER_TIMEOUT_MS = 4000;
const SPAWN_WALL_MS = 60_000;

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

    const fixtureModules = path.join(fixtureCwd, "node_modules");
    try {
      await fs.access(path.join(fixtureModules, "vitest"));
    } catch {
      await fs.symlink(
        path.join(repoRoot, "node_modules"),
        fixtureModules,
        "dir",
      );
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

  describe("when the NAPI addon is missing (AC4)", () => {
    it("should exit 2", async () => {
      // Given — temp package root without any puca-binding*.node
      const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "puca-no-napi-"));
      await fs.writeFile(
        path.join(emptyRoot, "package.json"),
        JSON.stringify({ name: "puca-no-napi", type: "module" }),
        "utf8",
      );
      await fs.cp(path.join(repoRoot, "dist"), path.join(emptyRoot, "dist"), {
        recursive: true,
      });
      // Point fixture-like cwd with vitest available via symlink
      await fs.symlink(
        path.join(repoRoot, "node_modules"),
        path.join(emptyRoot, "node_modules"),
        "dir",
      );
      await fs.cp(fixtureCwd, path.join(emptyRoot, "fixtures-loop"), {
        recursive: true,
        filter: (src) => !src.includes(`${path.sep}node_modules`),
      });
      await fs.symlink(
        path.join(repoRoot, "node_modules"),
        path.join(emptyRoot, "fixtures-loop", "node_modules"),
        "dir",
      );

      // When — CLI loads NapiMutatorEngine from emptyRoot/dist (no .node beside it)
      const run = await spawnNode(
        emptyRoot,
        [path.join(emptyRoot, "dist", "cli.js"), "--mutate", "src/**/*.ts"],
        { cwd: path.join(emptyRoot, "fixtures-loop") },
      );

      // Then
      expect(run.exitCode).toBe(2);
      expect(run.stderr + run.stdout).toMatch(/puca-binding|native addon|not found/i);

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
});

async function spawnPuca(
  cwd: string,
  args: readonly string[],
): Promise<RunResult> {
  return spawnNode(cwd, [cliJs, ...args], { cwd });
}

async function spawnNode(
  _unusedCwd: string,
  args: readonly string[],
  options: { readonly cwd: string },
): Promise<RunResult> {
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
      reject(new Error(`puca spawn exceeded ${String(SPAWN_WALL_MS)}ms\n${stderr}\n${stdout}`));
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
  for (const name of ["calc.ts", "hang.ts", "uncovered.ts", "skipped.ts"]) {
    const file = path.join(fixtureCwd, "src", name);
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
        if (entry.name === ".puca-tmp" || entry.name === ".stryker-tmp") {
          hits.push(full);
          continue;
        }
        await walk(full);
        continue;
      }
      if (!entry.isFile()) {
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
