import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearRamBuffer,
  lookupRamBuffer,
  normalizeModulePath,
  pucaRamPlugin,
  setRamBuffer,
} from "../src/adapters/outbound/vitest/pucaRamPlugin.js";
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

const cwd = path.resolve("/tmp/puca-ram-plugin-leak");

function abs(...parts: string[]): AbsolutePath {
  return toAbsolutePath(path.resolve(cwd, ...parts));
}

describe("puca RAM plugin leak proof (AC5 / R1)", () => {
  describe("when mutant 2 is applied from original after mutant 1", () => {
    it("should return exactly mutant 2 source with zero residual mutant 1 text", () => {
      // Given
      const file = path.resolve(cwd, "src/foo.ts");
      const original =
        "export const add = (a: number, b: number) => a + b;\n" +
        "export const subtract = (a: number, b: number) => a - b;\n";
      const mutant1Marker = "MUTANT_ONE_REPLACEMENT";
      const mutant2Marker = "MUTANT_TWO_REPLACEMENT";
      const mutant1 = original.replace("a + b", mutant1Marker);
      const mutant2 = original.replace("a - b", mutant2Marker);

      const buffers = new Map<string, string | null>();
      const plugin = pucaRamPlugin(buffers);
      const moduleCache = new Map<string, string>();

      const invalidateFile = (filepath: string): void => {
        moduleCache.delete(normalizeModulePath(filepath));
      };

      const ssrLoadModule = (filepath: string): string => {
        const key = normalizeModulePath(filepath);
        const cached = moduleCache.get(key);
        if (cached != null) {
          return cached;
        }
        const loaded =
          lookupRamBuffer(buffers, filepath) ??
          plugin.transform(original, filepath)?.code ??
          original;
        moduleCache.set(key, loaded);
        return loaded;
      };

      // When — mutant 1
      setRamBuffer(buffers, file, mutant1);
      invalidateFile(file);
      expect(ssrLoadModule(file)).toBe(mutant1);

      // Clear + invalidate after mutant 1 (use-case finally)
      clearRamBuffer(buffers, file);
      invalidateFile(file);
      expect(ssrLoadModule(file)).toBe(original);

      // Mutant 2 applied from ORIGINAL bytes (never from mutant 1)
      setRamBuffer(buffers, file, mutant2);
      invalidateFile(file);
      const loadedMutant2 = ssrLoadModule(file);

      // Then
      expect(loadedMutant2).toBe(mutant2);
      expect(loadedMutant2).not.toContain(mutant1Marker);
      expect(plugin.transform(original, file)).toEqual({
        code: mutant2,
        map: null,
      });
      expect(plugin.load(file)).toBe(mutant2);
    });
  });

  describe("when the use case scores two mutants on the same file", () => {
    it("should apply each mutant from original and leave no mutant-1 text in mutant-2 source", async () => {
      // Given
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

      const source = abs("src/foo.ts");
      const spec = abs("test/foo.test.ts");
      const original =
        "export const add = (a: number, b: number) => a + b;\n" +
        "export const subtract = (a: number, b: number) => a - b;\n";
      const plusOffset = original.indexOf("+");
      const minusOffset = original.indexOf("-");
      const site1: Site = {
        id: "src/foo.ts:plus",
        file: source,
        startOffset: plusOffset,
        endOffset: plusOffset + 1,
        line: 1,
        column: plusOffset + 1,
        mutatorName: "Arithmetic",
        original: "+",
        replacement: "MUTANT1",
      };
      const site2: Site = {
        id: "src/foo.ts:minus",
        file: source,
        startOffset: minusOffset,
        endOffset: minusOffset + 1,
        line: 2,
        column: minusOffset + 1,
        mutatorName: "Arithmetic",
        original: "-",
        replacement: "MUTANT2",
      };

      sourceLocator.setCandidates([source]);
      files.seed(source, original);
      mutator.setSites(source, [site1, site2]);
      testRunner.setAllSpecs([spec]);
      testRunner.setStaticImports({ [spec]: [source] });
      testRunner.baselineResult = { ok: true };
      testRunner.relatedResult = { kind: "passed" };

      // When
      const result = await useCase.execute({ cwd });

      // Then
      expect(result.statuses).toHaveLength(2);
      expect(testRunner.runRelatedCalls).toHaveLength(2);

      const first = testRunner.runRelatedCalls[0]!;
      const second = testRunner.runRelatedCalls[1]!;

      expect(first.mutatedSource).toContain("MUTANT1");
      expect(first.mutatedSource).toContain("a - b");
      expect(first.mutatedSource).not.toContain("MUTANT2");

      expect(second.mutatedSource).toContain("MUTANT2");
      expect(second.mutatedSource).toContain("a + b");
      expect(second.mutatedSource).not.toContain("MUTANT1");

      expect(testRunner.getBuffer(source)).toBeNull();
      expect(testRunner.invalidateCalls.length).toBeGreaterThanOrEqual(4);
    });
  });
});
