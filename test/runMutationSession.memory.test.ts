import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CACHE_ENGINE_VERSION,
  CACHE_SCHEMA_VERSION,
  FileHashCache,
} from "../src/adapters/outbound/cache/FileHashCache.js";
import { FakeMutatorEngine } from "../src/adapters/outbound/memory/FakeMutatorEngine.js";
import { FakeTestRunner } from "../src/adapters/outbound/memory/FakeTestRunner.js";
import { InMemoryFiles } from "../src/adapters/outbound/memory/InMemoryFiles.js";
import { InMemorySourceLocator } from "../src/adapters/outbound/memory/InMemorySourceLocator.js";
import { RecordingReport } from "../src/adapters/outbound/memory/RecordingReport.js";
import { RunMutationSessionUseCase } from "../src/application/use-cases/RunMutationSessionUseCase.js";
import { createRuntime } from "../src/composition/createRuntime.js";
import {
  toAbsolutePath,
  type AbsolutePath,
  type Site,
} from "../src/domain/mutant.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir != null) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-cache-"));
  tempDirs.push(dir);
  return dir;
}

function abs(cwd: string, ...parts: string[]): AbsolutePath {
  return toAbsolutePath(path.resolve(cwd, ...parts));
}

function siteFor(
  file: AbsolutePath,
  cwd: string,
  startOffset: number,
  mutatorName: string,
  original: string,
  replacement: string,
): Site {
  const relpath = path.relative(cwd, file).replace(/\\/g, "/");
  return {
    id: `${relpath}:${startOffset}:${mutatorName}:${replacement}`,
    file,
    startOffset,
    endOffset: startOffset + original.length,
    line: 1,
    column: startOffset + 1,
    mutatorName,
    original,
    replacement,
  };
}

function createCacheHarness(cwd: string): {
  useCase: RunMutationSessionUseCase;
  mutator: FakeMutatorEngine;
  testRunner: FakeTestRunner;
  files: InMemoryFiles;
  sourceLocator: InMemorySourceLocator;
  cache: FileHashCache;
  cachePath: string;
} {
  const mutator = new FakeMutatorEngine();
  const testRunner = new FakeTestRunner();
  const files = new InMemoryFiles(cwd);
  const sourceLocator = new InMemorySourceLocator();
  const report = new RecordingReport();
  const cache = new FileHashCache(cwd);
  const useCase = new RunMutationSessionUseCase({
    mutator,
    testRunner,
    sourceLocator,
    files,
    report,
    cache,
  });
  return {
    useCase,
    mutator,
    testRunner,
    files,
    sourceLocator,
    cache,
    cachePath: path.join(cwd, ".puca", "cache.json"),
  };
}

async function seedCoveredMutant(options: {
  cwd: string;
  files: InMemoryFiles;
  mutator: FakeMutatorEngine;
  testRunner: FakeTestRunner;
  sourceLocator: InMemorySourceLocator;
  site: Site;
}): Promise<{ source: AbsolutePath; spec: AbsolutePath }> {
  const source = options.site.file;
  const spec = abs(options.cwd, "test/foo.test.ts");
  const sourceText = "export const add = (a: number, b: number) => a + b;\n";
  const specText = "import { add } from '../src/foo.ts';\n";
  options.sourceLocator.setCandidates([source]);
  options.files.seed(source, sourceText);
  options.files.seed(spec, specText);
  options.mutator.setSites(source, [options.site]);
  options.testRunner.setAllSpecs([spec]);
  options.testRunner.setStaticImports({ [spec]: [source] });
  options.testRunner.baselineResult = { ok: true };
  options.testRunner.relatedResult = {
    kind: "failed",
    failingTestId: "test/foo.test.ts > add",
  };
  return { source, spec };
}

describe("RunMutationSession (memory adapters)", () => {
  describe("when source locator returns no candidates", () => {
    it("should return exitCode 0 without loading vitest as a product dependency", async () => {
      // Given
      const runtime = createRuntime({ useFakes: true, cwd: repoRoot });
      expect(runtime.sourceLocator).toBeInstanceOf(InMemorySourceLocator);
      (runtime.sourceLocator as InMemorySourceLocator).setCandidates([]);

      // When
      const result = await runtime.runMutationSession.execute({ cwd: repoRoot });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.statuses).toEqual([]);

      // Product path must not pull vitest into domain/application resolution.
      // Vitest here is only the test runner (this file), not a use-case import.
      const domainPkg = path.join(repoRoot, "src/domain/mutant.ts");
      const appUseCase = path.join(
        repoRoot,
        "src/application/use-cases/RunMutationSessionUseCase.ts",
      );
      for (const file of [domainPkg, appUseCase]) {
        const source = await fs.readFile(file, "utf8");
        expect(source).not.toMatch(/from ['"]vitest['"]/);
        expect(source).not.toMatch(/from ['"]vite['"]/);
      }

      // Ensure resolve of the composition fake path does not require the vitest package
      // as a runtime dependency of the inbound port (devDependency-only is fine).
      const pkg = require("../package.json") as {
        dependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.vitest).toBeUndefined();
    });
  });

  describe("when CLI public entry is inspected", () => {
    it("should not re-export TestRunnerPort (unexported seam)", async () => {
      // Given
      const cliSource = await fs.readFile(
        path.join(repoRoot, "src/cli.ts"),
        "utf8",
      );

      // Then — CLI remains a process entry, not a barrel that leaks TestRunnerPort
      expect(cliSource).not.toMatch(/TestRunnerPort/);
      expect(cliSource).not.toMatch(/\bexport\s+\{/);
      expect(cliSource).not.toMatch(/\bexport\s+\*/);
    });
  });

  describe("opt-in mutant status cache (SC-342 / Wave B)", () => {
    describe("when two identical runs use --cache (AC1)", () => {
      it("should reuse unchanged site statuses without re-invoking the test runner", async () => {
        // Given
        const cwd = await makeTempCwd();
        const harness = createCacheHarness(cwd);
        const source = abs(cwd, "src/foo.ts");
        const site = siteFor(source, cwd, 48, "Arithmetic", "+", "-");
        await seedCoveredMutant({ ...harness, cwd, site });

        // When — first run populates cache
        const first = await harness.useCase.execute({ cwd, cache: true });
        const firstCalls = harness.testRunner.runRelatedCalls.length;

        // When — second identical run
        const second = await harness.useCase.execute({ cwd, cache: true });

        // Then
        expect(first.exitCode).toBe(0);
        expect(first.statuses).toEqual([
          {
            site,
            status: "Killed",
            killedBy: "test/foo.test.ts > add",
          },
        ]);
        expect(firstCalls).toBe(1);
        expect(second.exitCode).toBe(0);
        expect(second.statuses).toEqual(first.statuses);
        expect(harness.testRunner.runRelatedCalls).toHaveLength(0);
      });
    });

    describe("when one cache entry is invalid among good entries (R4-M4)", () => {
      it("should keep valid entries and skip the bad one", async () => {
        // Given
        const cwd = await makeTempCwd();
        const cache = new FileHashCache(cwd);
        const goodKey = "abc123";
        await fs.mkdir(path.join(cwd, ".puca"), { recursive: true });
        await fs.writeFile(
          path.join(cwd, ".puca", "cache.json"),
          JSON.stringify({
            schemaVersion: CACHE_SCHEMA_VERSION,
            engineVersion: CACHE_ENGINE_VERSION,
            entries: {
              [goodKey]: {
                status: "Killed",
                schemaVersion: CACHE_SCHEMA_VERSION,
                killedBy: "t",
              },
              bad: {
                status: "Survived",
                schemaVersion: 999,
              },
            },
          }),
          "utf8",
        );

        // When
        await cache.load();

        // Then
        expect(cache.get(goodKey)?.status).toBe("Killed");
        expect(cache.get("bad")).toBeUndefined();
      });
    });

    describe("when cache is corrupt or contains mutatedSource (AC2)", () => {
      it("should fail open and continue scoring without exit 2", async () => {
        // Given — truncated JSON
        const cwd = await makeTempCwd();
        const harness = createCacheHarness(cwd);
        const source = abs(cwd, "src/foo.ts");
        const site = siteFor(source, cwd, 48, "Arithmetic", "+", "-");
        await seedCoveredMutant({ ...harness, cwd, site });
        await fs.mkdir(path.dirname(harness.cachePath), { recursive: true });
        await fs.writeFile(harness.cachePath, '{"schemaVersion":1,"entri', "utf8");

        // When
        const truncated = await harness.useCase.execute({ cwd, cache: true });

        // Then
        expect(truncated.exitCode).toBe(0);
        expect(truncated.statuses[0]?.status).toBe("Killed");
        expect(harness.testRunner.runRelatedCalls).toHaveLength(1);

        // Given — mutatedSource payload
        await fs.writeFile(
          harness.cachePath,
          JSON.stringify({
            schemaVersion: CACHE_SCHEMA_VERSION,
            engineVersion: CACHE_ENGINE_VERSION,
            entries: {
              bad: {
                status: "Survived",
                schemaVersion: CACHE_SCHEMA_VERSION,
                mutatedSource: "export const add = () => 0;",
              },
            },
          }),
          "utf8",
        );

        // When
        const poisoned = await harness.useCase.execute({ cwd, cache: true });

        // Then — wiped and re-scored (not exit 2)
        expect(poisoned.exitCode).toBe(0);
        expect(poisoned.statuses[0]?.status).toBe("Killed");
        expect(harness.testRunner.runRelatedCalls).toHaveLength(1);
      });
    });

    describe("when .puca/cache.json is written after a cached run (AC3)", () => {
      it("should store status metadata without mutatedSource fields", async () => {
        // Given
        const cwd = await makeTempCwd();
        const harness = createCacheHarness(cwd);
        const source = abs(cwd, "src/foo.ts");
        const site = siteFor(source, cwd, 48, "Arithmetic", "+", "-");
        await seedCoveredMutant({ ...harness, cwd, site });

        // When
        await harness.useCase.execute({ cwd, cache: true });
        const raw = await fs.readFile(harness.cachePath, "utf8");
        const doc = JSON.parse(raw) as {
          schemaVersion: number;
          engineVersion: string;
          entries: Record<
            string,
            { status: string; killedBy?: string; schemaVersion: number }
          >;
        };

        // Then
        expect(doc.schemaVersion).toBe(CACHE_SCHEMA_VERSION);
        expect(doc.engineVersion).toBe(CACHE_ENGINE_VERSION);
        expect(Object.keys(doc.entries).length).toBeGreaterThan(0);
        expect(raw).not.toMatch(/mutatedSource/);
        for (const entry of Object.values(doc.entries)) {
          expect(entry).toHaveProperty("status");
          expect(entry).toHaveProperty("schemaVersion");
          expect(entry).not.toHaveProperty("mutatedSource");
        }
      });
    });

    describe("when --cache is omitted (AC4)", () => {
      it("should score without requiring a .puca/cache.json write", async () => {
        // Given
        const cwd = await makeTempCwd();
        const harness = createCacheHarness(cwd);
        const source = abs(cwd, "src/foo.ts");
        const site = siteFor(source, cwd, 48, "Arithmetic", "+", "-");
        await seedCoveredMutant({ ...harness, cwd, site });

        // When
        const result = await harness.useCase.execute({ cwd });

        // Then
        expect(result.exitCode).toBe(0);
        expect(result.statuses[0]?.status).toBe("Killed");
        expect(harness.testRunner.runRelatedCalls).toHaveLength(1);
        await expect(fs.access(harness.cachePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    });

    describe("when source changes but site identity is unchanged", () => {
      it("should miss cache and re-score", async () => {
        // Given
        const cwd = await makeTempCwd();
        const harness = createCacheHarness(cwd);
        const source = abs(cwd, "src/foo.ts");
        const site = siteFor(source, cwd, 48, "Arithmetic", "+", "-");
        await seedCoveredMutant({ ...harness, cwd, site });

        await harness.useCase.execute({ cwd, cache: true });
        expect(harness.testRunner.runRelatedCalls).toHaveLength(1);

        // Same offsets/mutator; different source body (comment prepended).
        const changed =
          "// edited\nexport const add = (a: number, b: number) => a + b;\n";
        const shifted = siteFor(source, cwd, 57, "Arithmetic", "+", "-");
        harness.files.seed(source, changed);
        harness.mutator.setSites(source, [shifted]);

        // When — site id changed with offset; also verify content in key via same site
        // after restoring offsets into the new string at the + operator.
        const plusAt = changed.indexOf("+");
        const sameSpanSite = siteFor(
          source,
          cwd,
          plusAt,
          "Arithmetic",
          "+",
          "-",
        );
        harness.mutator.setSites(source, [sameSpanSite]);

        const second = await harness.useCase.execute({ cwd, cache: true });

        // Then — must re-invoke runner (sourceContents in cache key)
        expect(second.exitCode).toBe(0);
        expect(harness.testRunner.runRelatedCalls).toHaveLength(1);
        expect(second.statuses[0]?.status).toBe("Killed");
      });
    });
  });
});
