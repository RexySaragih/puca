import path from "node:path";
import { describe, expect, it } from "vitest";
import { FakeMutatorEngine } from "../src/adapters/outbound/memory/FakeMutatorEngine.js";
import { FakeTestRunner } from "../src/adapters/outbound/memory/FakeTestRunner.js";
import { InMemoryFiles } from "../src/adapters/outbound/memory/InMemoryFiles.js";
import { InMemorySourceLocator } from "../src/adapters/outbound/memory/InMemorySourceLocator.js";
import { RecordingReport } from "../src/adapters/outbound/memory/RecordingReport.js";
import { normalizeGraphPath } from "../src/adapters/outbound/vitest/reverseMap.js";
import { RunMutationSessionUseCase } from "../src/application/use-cases/RunMutationSessionUseCase.js";
import {
  toAbsolutePath,
  type AbsolutePath,
  type Site,
} from "../src/domain/mutant.js";

const cwd = path.resolve("/tmp/puca-baseline-reverse-map");

function abs(...parts: string[]): AbsolutePath {
  return toAbsolutePath(path.resolve(cwd, ...parts));
}

function siteFor(
  file: AbsolutePath,
  startOffset: number,
  mutatorName: string,
  replacement: string,
): Site {
  const relpath = path.relative(cwd, file).replace(/\\/g, "/");
  return {
    id: `${relpath}:${startOffset}:${mutatorName}:${replacement}`,
    file,
    startOffset,
    endOffset: startOffset + 1,
    line: 1,
    column: startOffset + 1,
    mutatorName,
    original: "+",
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

describe("Baseline reverse map and setup graph", () => {
  describe("when FakeTestRunner baseline fails (AC1)", () => {
    it("should exit 2 with Vitest output and never call runRelated", async () => {
      // Given
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const source = abs("src/calc.ts");
      const spec = abs("test/calc.test.ts");
      sourceLocator.setCandidates([source]);
      files.seed(source, "export const add = (a: number, b: number) => a + b;\n");
      mutator.setSites(source, [siteFor(source, 48, "Arithmetic", "-")]);
      testRunner.setAllSpecs([spec]);
      testRunner.setStaticImports({ [spec]: [source] });
      testRunner.baselineResult = {
        ok: false,
        output: "FAIL  test/calc.test.ts > add\nAssertionError: expected 3 to be 4",
      };

      // When
      const result = await useCase.execute({ cwd });

      // Then
      expect(result.exitCode).toBe(2);
      expect(result.message).toContain("AssertionError");
      expect(result.message).toContain("test/calc.test.ts");
      expect(result.statuses).toEqual([]);
      expect(testRunner.runRelatedCalls).toHaveLength(0);
      expect(testRunner.closed).toBe(true);
    });
  });

  describe("when a source has empty related specs (AC2)", () => {
    it("should mark sites NoCoverage and not call runRelated for that file", async () => {
      // Given
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const uncovered = abs("src/uncovered.ts");
      const covered = abs("src/covered.ts");
      const spec = abs("test/covered.test.ts");
      sourceLocator.setCandidates([uncovered, covered]);
      files.seed(uncovered, "export const x = 1;\n");
      files.seed(covered, "export const y = 2;\n");
      const uncoveredSite = siteFor(uncovered, 17, "Literal", "0");
      const coveredSite = siteFor(covered, 17, "Literal", "0");
      mutator.setSites(uncovered, [uncoveredSite]);
      mutator.setSites(covered, [coveredSite]);
      testRunner.setAllSpecs([spec]);
      testRunner.setStaticImports({ [spec]: [covered] });
      testRunner.baselineResult = { ok: true };

      // When
      const result = await useCase.execute({ cwd });

      // Then — uncovered stays NoCoverage; covered enters the mutant loop
      expect(result.exitCode).toBe(1);
      expect(result.statuses).toEqual([
        { site: uncoveredSite, status: "NoCoverage" },
        { site: coveredSite, status: "Survived" },
      ]);
      expect(
        testRunner.runRelatedCalls.filter((call) => call.file === uncovered),
      ).toHaveLength(0);
      expect(
        testRunner.runRelatedCalls.filter((call) => call.file === covered),
      ).toHaveLength(1);
    });
  });

  describe("when a file is only imported from setupFiles (AC3)", () => {
    it("should relate it to the target spec set (not NoCoverage)", async () => {
      // Given
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const setupHelper = abs("src/setup-helper.ts");
      const specA = abs("test/a.test.ts");
      const specB = abs("test/b.test.ts");
      sourceLocator.setCandidates([setupHelper]);
      files.seed(setupHelper, "export const boot = true;\n");
      const site = siteFor(setupHelper, 20, "BooleanLiteral", "false");
      mutator.setSites(setupHelper, [site]);
      testRunner.setAllSpecs([specA, specB]);
      testRunner.setStaticImports(new Map());
      testRunner.setSetupModules([setupHelper]);
      testRunner.baselineResult = { ok: true };

      // When
      const result = await useCase.execute({ cwd });

      // Then — related via setup attachment → scored (not NoCoverage)
      expect(result.exitCode).toBe(1);
      expect(result.statuses).toEqual([{ site, status: "Survived" }]);
      expect(testRunner.runRelatedCalls).toHaveLength(1);

      const map = await testRunner.buildReverseMap([setupHelper]);
      const related = map.relatedBySource.get(normalizeGraphPath(setupHelper));
      expect([...(related ?? [])].sort()).toEqual(
        [normalizeGraphPath(specA), normalizeGraphPath(specB)].sort(),
      );
    });
  });

  describe("when linkage is dynamic-import-only (AC4)", () => {
    it("should map the source to NoCoverage", async () => {
      // Given — static graph omits the dynamic edge; source not in setup/global
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const dynamicOnly = abs("src/lazy.ts");
      const spec = abs("test/lazy.test.ts");
      sourceLocator.setCandidates([dynamicOnly]);
      files.seed(dynamicOnly, "export const lazy = 1;\n");
      const site = siteFor(dynamicOnly, 19, "Literal", "0");
      mutator.setSites(dynamicOnly, [site]);
      testRunner.setAllSpecs([spec]);
      // Spec exists but static imports empty (dynamic import() invisible)
      testRunner.setStaticImports({ [spec]: [] });
      testRunner.baselineResult = { ok: true };

      // When
      const result = await useCase.execute({ cwd });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.statuses).toEqual([{ site, status: "NoCoverage" }]);
      expect(testRunner.runRelatedCalls).toHaveLength(0);
    });
  });

  describe("when a candidate is only reachable from globalSetup", () => {
    it("should respawn once after a green baseline", async () => {
      // Given
      const { useCase, mutator, testRunner, files, sourceLocator } =
        createHarness();
      const globalHelper = abs("src/global-helper.ts");
      const spec = abs("test/a.test.ts");
      sourceLocator.setCandidates([globalHelper]);
      files.seed(globalHelper, "export const g = 1;\n");
      mutator.setSites(globalHelper, [
        siteFor(globalHelper, 15, "Literal", "0"),
      ]);
      testRunner.setAllSpecs([spec]);
      testRunner.setGlobalSetupModules([globalHelper]);
      testRunner.baselineResult = { ok: true };

      // When
      const result = await useCase.execute({ cwd });

      // Then — one globalSetup respawn, then the mutant is scored
      expect(result.exitCode).toBe(1);
      expect(result.statuses).toEqual([
        {
          site: siteFor(globalHelper, 15, "Literal", "0"),
          status: "Survived",
        },
      ]);
      expect(testRunner.respawnCount).toBe(1);
      expect(testRunner.runRelatedCalls).toHaveLength(1);
    });
  });
});
