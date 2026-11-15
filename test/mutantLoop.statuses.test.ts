import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeMutatorEngine } from "../src/adapters/outbound/memory/FakeMutatorEngine.js";
import { FakeTestRunner } from "../src/adapters/outbound/memory/FakeTestRunner.js";
import { InMemoryFiles } from "../src/adapters/outbound/memory/InMemoryFiles.js";
import { InMemorySourceLocator } from "../src/adapters/outbound/memory/InMemorySourceLocator.js";
import { RecordingReport } from "../src/adapters/outbound/memory/RecordingReport.js";
import { RunMutationSessionUseCase } from "../src/application/use-cases/RunMutationSessionUseCase.js";
import {
  toAbsolutePath,
  type AbsolutePath,
  type Site,
} from "../src/domain/mutant.js";

const cwd = path.resolve("/tmp/puca-mutant-loop-statuses");

function abs(...parts: string[]): AbsolutePath {
  return toAbsolutePath(path.resolve(cwd, ...parts));
}

function siteFor(
  file: AbsolutePath,
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

function createHarness(): {
  useCase: RunMutationSessionUseCase;
  mutator: FakeMutatorEngine;
  testRunner: FakeTestRunner;
  files: InMemoryFiles;
  sourceLocator: InMemorySourceLocator;
  report: RecordingReport;
} {
  const mutator = new FakeMutatorEngine();
  const testRunner = new FakeTestRunner();
  const files = new InMemoryFiles(cwd);
  const sourceLocator = new InMemorySourceLocator();
  const report = new RecordingReport();
  const useCase = new RunMutationSessionUseCase({
    mutator,
    testRunner,
    sourceLocator,
    files,
    report,
  });
  return { useCase, mutator, testRunner, files, sourceLocator, report };
}

async function seedCoveredFile(options: {
  files: InMemoryFiles;
  mutator: FakeMutatorEngine;
  testRunner: FakeTestRunner;
  sourceLocator: InMemorySourceLocator;
  sites: readonly Site[];
  sourceFile?: AbsolutePath;
  sourceText?: string;
}): Promise<{ source: AbsolutePath; spec: AbsolutePath }> {
  const source = options.sourceFile ?? abs("src/foo.ts");
  const spec = abs("test/foo.test.ts");
  const sourceText =
    options.sourceText ??
    "export const add = (a: number, b: number) => a + b;\n";
  options.sourceLocator.setCandidates([source]);
  options.files.seed(source, sourceText);
  options.mutator.setSites(source, options.sites);
  options.testRunner.setAllSpecs([spec]);
  options.testRunner.setStaticImports({ [spec]: [source] });
  options.testRunner.baselineResult = { ok: true };
  return { source, spec };
}

describe("Sequential mutant loop statuses", () => {
  describe("when a related test fails (AC1)", () => {
    it("should mark the mutant Killed with killedBy and may skip remaining tests", async () => {
      // Given
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const site = siteFor(source, 48, "Arithmetic", "+", "-");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [site],
        sourceFile: source,
      });
      testRunner.relatedResult = {
        kind: "failed",
        failingTestId: "test/foo.test.ts > add",
      };

      // When
      const result = await useCase.execute({ cwd });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.statuses).toEqual([
        {
          site,
          status: "Killed",
          killedBy: "test/foo.test.ts > add",
        },
      ]);
      expect(testRunner.runRelatedCalls).toHaveLength(1);
      expect(testRunner.closed).toBe(true);
    });
  });

  describe("when all related tests pass (AC2)", () => {
    it("should mark the mutant Survived and exit 1", async () => {
      // Given
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const site = siteFor(source, 48, "Arithmetic", "+", "-");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [site],
        sourceFile: source,
      });
      testRunner.relatedResult = { kind: "passed" };

      // When
      const result = await useCase.execute({ cwd });

      // Then
      expect(result.exitCode).toBe(1);
      expect(result.statuses).toEqual([{ site, status: "Survived" }]);
      expect(testRunner.runRelatedCalls).toHaveLength(1);
    });
  });

  describe("when runRelated never completes before the outer timer (AC3)", () => {
    it("should mark Timeout, respawn, and still score the next mutant", async () => {
      // Given
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const sourceText =
        "export const add = (a: number, b: number) => a + b;\n";
      const siteHang = siteFor(source, 48, "Arithmetic", "+", "-");
      const sitePass = siteFor(source, 48, "Arithmetic", "+", "*");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [siteHang, sitePass],
        sourceFile: source,
        sourceText,
      });
      testRunner.queueRelatedBehaviors("hang", { kind: "passed" });

      // When — short --timeout override so the hang trips quickly
      const result = await useCase.execute({ cwd, timeoutMs: 40 });

      // Then
      expect(result.statuses).toEqual([
        { site: siteHang, status: "Timeout" },
        { site: sitePass, status: "Survived" },
      ]);
      expect(result.exitCode).toBe(1);
      expect(testRunner.respawnCount).toBe(1);
      expect(testRunner.runRelatedCalls).toHaveLength(2);
      expect(testRunner.runRelatedCalls[1]?.mutatedSource).toContain("*");
      expect(testRunner.runRelatedCalls[1]?.mutatedSource).not.toContain(
        "a - b",
      );
    });
  });

  describe("when transform/runRelated reports an error (AC4)", () => {
    it("should mark RuntimeError and exit 2", async () => {
      // Given
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const site = siteFor(source, 48, "Arithmetic", "+", "-");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [site],
        sourceFile: source,
      });
      testRunner.relatedResult = {
        kind: "error",
        message: "Transform failed: Unexpected token",
      };

      // When
      const result = await useCase.execute({ cwd });

      // Then
      expect(result.exitCode).toBe(2);
      expect(result.statuses).toEqual([{ site, status: "RuntimeError" }]);
    });
  });

  describe("when input.timeoutMs is set", () => {
    it("should override the default outer timer derived from testTimeout", async () => {
      // Given
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const site = siteFor(source, 48, "Arithmetic", "+", "-");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [site],
        sourceFile: source,
      });
      testRunner.testTimeoutMs = 5000;
      testRunner.queueRelatedBehaviors("hang");

      // When — override is far below max(5000+2000, 7000)
      const started = Date.now();
      const result = await useCase.execute({ cwd, timeoutMs: 30 });
      const elapsed = Date.now() - started;

      // Then
      expect(result.statuses).toEqual([{ site, status: "Timeout" }]);
      expect(elapsed).toBeLessThan(2000);
      expect(testRunner.respawnCount).toBe(1);
    });
  });

  describe("when --verbose is set", () => {
    it("should list selected files and print mutator, disable, and respawn diagnostics", async () => {
      const { useCase, mutator, testRunner, files, sourceLocator, report } =
        createHarness();
      const source = abs("src/foo.ts");
      const siteHang = siteFor(source, 48, "ArithmeticOperator", "+", "-");
      const siteEq = siteFor(source, 10, "EqualityOperator", "===", "!==");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [siteHang, siteEq],
        sourceFile: source,
      });
      mutator.setDisabledCount(3);
      testRunner.queueRelatedBehaviors("hang", { kind: "passed" });

      const result = await useCase.execute({
        cwd,
        verbose: true,
        timeoutMs: 40,
      });

      expect(report.notices[0]).toBe("Selected files (1):");
      expect(report.notices[1]).toBe("  src/foo.ts");
      expect(report.notices).toContain(
        "Mutators: ArithmeticOperator: 1, EqualityOperator: 1",
      );
      expect(report.notices).toContain("Disable-comment sites omitted: 3");
      expect(result.verboseFooter).toContain("ArithmeticOperator: 1");
      expect(result.verboseFooter).toContain("EqualityOperator: 1");
      expect(result.verboseFooter).toContain(
        "Disable-comment sites omitted: 3",
      );
      expect(result.verboseFooter).toContain("Vitest respawns: 1");
    });
  });

  describe("when apply throws", () => {
    it("should mark RuntimeError without calling runRelated", async () => {
      // Given
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const site = siteFor(source, 48, "Arithmetic", "+", "-");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [site],
        sourceFile: source,
      });
      const originalApply = mutator.apply.bind(mutator);
      mutator.apply = async () => {
        throw new Error("apply boom");
      };

      // When
      const result = await useCase.execute({ cwd });

      // Then
      expect(result.exitCode).toBe(2);
      expect(result.statuses).toEqual([{ site, status: "RuntimeError" }]);
      expect(testRunner.runRelatedCalls).toHaveLength(0);
      mutator.apply = originalApply;
    });
  });

  describe("opt-in quality gates (SC-332..335)", () => {
    it("should exit 1 when score is below --break-on-score (SC-332)", async () => {
      // Given — 3 Killed + 1 Survived → score 75; breakOnScore 80
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const sites = [
        siteFor(source, 10, "Arithmetic", "+", "-"),
        siteFor(source, 20, "Arithmetic", "-", "+"),
        siteFor(source, 30, "Arithmetic", "*", "/"),
        siteFor(source, 40, "Equality", "===", "!=="),
      ];
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites,
        sourceFile: source,
      });
      testRunner.queueRelatedBehaviors(
        { kind: "failed", failingTestId: "t1" },
        { kind: "failed", failingTestId: "t2" },
        { kind: "failed", failingTestId: "t3" },
        { kind: "passed" },
      );

      const result = await useCase.execute({ cwd, breakOnScore: 80 });

      expect(result.statuses.filter((m) => m.status === "Killed")).toHaveLength(
        3,
      );
      expect(result.statuses.filter((m) => m.status === "Survived")).toHaveLength(
        1,
      );
      expect(result.exitCode).toBe(1);
    });

    it("should not fail on score alone when Killed+Survived is 0 (SC-333)", async () => {
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const sites = [
        siteFor(source, 10, "Arithmetic", "+", "-"),
        siteFor(source, 20, "Boolean", "true", "false"),
      ];
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites,
        sourceFile: source,
      });
      testRunner.queueRelatedBehaviors("hang", { kind: "timeout" });

      const result = await useCase.execute({
        cwd,
        breakOnScore: 80,
        timeoutMs: 40,
      });

      expect(result.statuses.every((m) => m.status === "Timeout")).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("should exit 1 for --fail-on-no-coverage with NoCoverage and no Survived (SC-334)", async () => {
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const site = siteFor(source, 48, "Arithmetic", "+", "-");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [site],
        sourceFile: source,
      });
      testRunner.setAllSpecs([]);
      testRunner.setStaticImports({});

      const result = await useCase.execute({
        cwd,
        failOnNoCoverage: true,
      });

      expect(result.statuses).toEqual([{ site, status: "NoCoverage" }]);
      expect(result.exitCode).toBe(1);
    });

    it("should exit 1 for Survived even when score meets breakOnScore (SC-335)", async () => {
      // Given — 4 Killed + 1 Survived → score 80; breakOnScore 80; Survived still wins
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const sites = [
        siteFor(source, 10, "Arithmetic", "+", "-"),
        siteFor(source, 20, "Arithmetic", "-", "+"),
        siteFor(source, 30, "Arithmetic", "*", "/"),
        siteFor(source, 40, "Arithmetic", "/", "*"),
        siteFor(source, 50, "Equality", "===", "!=="),
      ];
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites,
        sourceFile: source,
      });
      testRunner.queueRelatedBehaviors(
        { kind: "failed", failingTestId: "t1" },
        { kind: "failed", failingTestId: "t2" },
        { kind: "failed", failingTestId: "t3" },
        { kind: "failed", failingTestId: "t4" },
        { kind: "passed" },
      );

      const result = await useCase.execute({ cwd, breakOnScore: 80 });

      expect(result.statuses.filter((m) => m.status === "Survived")).toHaveLength(
        1,
      );
      expect(result.exitCode).toBe(1);
    });

    it("should exit 2 for RuntimeError even when gates would also fail (SC-332)", async () => {
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const sites = [
        siteFor(source, 10, "Arithmetic", "+", "-"),
        siteFor(source, 20, "Arithmetic", "-", "+"),
      ];
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites,
        sourceFile: source,
      });
      testRunner.queueRelatedBehaviors(
        { kind: "error", message: "boom" },
        { kind: "passed" },
      );

      const result = await useCase.execute({
        cwd,
        breakOnScore: 100,
        failOnNoCoverage: true,
      });

      expect(result.statuses.some((m) => m.status === "RuntimeError")).toBe(
        true,
      );
      expect(result.exitCode).toBe(2);
    });
  });
});

describe("Concurrent mutant scoring (workers >= 2)", () => {
  describe("when workers is 1 and a hang occurs (AC1)", () => {
    it("should Timeout and respawn once (Phase 1 path)", async () => {
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const site = siteFor(source, 48, "Arithmetic", "+", "-");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [site],
        sourceFile: source,
      });
      testRunner.queueRelatedBehaviors("hang");

      const result = await useCase.execute({ cwd, workers: 1, timeoutMs: 40 });

      expect(result.statuses).toEqual([{ site, status: "Timeout" }]);
      expect(testRunner.respawnCount).toBe(1);
    });
  });

  describe("when workers is 2 with two covered sites (AC2)", () => {
    it("should overlap runRelated and never call setBuffer", async () => {
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const siteA = siteFor(source, 48, "Arithmetic", "+", "-");
      const siteB = siteFor(source, 48, "Arithmetic", "+", "*");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [siteA, siteB],
        sourceFile: source,
      });
      testRunner.relatedDelayMs = 40;
      testRunner.relatedResult = { kind: "passed" };

      const result = await useCase.execute({ cwd, workers: 2 });

      expect(result.statuses).toHaveLength(2);
      expect(testRunner.maxInFlightRelated).toBeGreaterThanOrEqual(2);
      expect(testRunner.setBufferCalls).toHaveLength(0);
      expect(testRunner.respawnCount).toBe(0);
    });
  });

  describe("when a file has no related specs (AC3)", () => {
    it("should mark NoCoverage without calling runRelated", async () => {
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/orphan.ts");
      const site = siteFor(source, 0, "Arithmetic", "+", "-");
      sourceLocator.setCandidates([source]);
      files.seed(source, "export const x = 1 + 2;\n");
      mutator.setSites(source, [site]);
      testRunner.setAllSpecs([]);
      testRunner.setStaticImports({});
      testRunner.baselineResult = { ok: true };

      const result = await useCase.execute({ cwd, workers: 2 });

      expect(result.statuses).toEqual([{ site, status: "NoCoverage" }]);
      expect(testRunner.runRelatedCalls).toHaveLength(0);
    });
  });

  describe("when workers is 2 and runRelated returns Timeout (AC4)", () => {
    it("should not call respawn", async () => {
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const site = siteFor(source, 48, "Arithmetic", "+", "-");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [site],
        sourceFile: source,
      });
      testRunner.relatedResult = { kind: "timeout" };

      const result = await useCase.execute({ cwd, workers: 2 });

      expect(result.statuses).toEqual([{ site, status: "Timeout" }]);
      expect(testRunner.respawnCount).toBe(0);
    });
  });

  describe("when verbose and workers >= 2", () => {
    it("should report worker recycle count instead of Vitest respawns", async () => {
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/foo.ts");
      const site = siteFor(source, 48, "ArithmeticOperator", "+", "-");
      await seedCoveredFile({
        files,
        mutator,
        testRunner,
        sourceLocator,
        sites: [site],
        sourceFile: source,
      });
      testRunner.recycleCount = 3;
      testRunner.relatedResult = { kind: "passed" };

      const result = await useCase.execute({
        cwd,
        workers: 2,
        verbose: true,
      });

      expect(result.verboseFooter).toContain(
        "Worker recycles (timeout+RSS): 3",
      );
      expect(result.verboseFooter).not.toContain("Vitest respawns");
    });
  });
});

