import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeWorkspaceFiles } from "../src/adapters/outbound/fs/NodeWorkspaceFiles.js";
import { GitDiffLocator } from "../src/adapters/outbound/git/GitDiffLocator.js";
import {
  FakeMutatorEngine,
  FakeTestRunner,
  InMemoryFiles,
  InMemorySourceLocator,
  RecordingReport,
} from "../src/adapters/outbound/memory/index.js";
import { NapiMutatorEngine } from "../src/adapters/outbound/napi/NapiMutatorEngine.js";
import { CompositeReport } from "../src/adapters/outbound/report/CompositeReport.js";
import { HtmlFile } from "../src/adapters/outbound/report/HtmlFile.js";
import { SarifFile } from "../src/adapters/outbound/report/SarifFile.js";
import { SchemaJsonFile } from "../src/adapters/outbound/report/SchemaJsonFile.js";
import { StdioReport } from "../src/adapters/outbound/report/StdioReport.js";
import { JestTestRunner } from "../src/adapters/outbound/jest/JestTestRunner.js";
import { PooledVitestTestRunner } from "../src/adapters/outbound/vitest/PooledVitestTestRunner.js";
import { VitestTestRunner } from "../src/adapters/outbound/vitest/VitestTestRunner.js";
import { createRuntime } from "../src/composition/createRuntime.js";


const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

describe("createRuntime wiring", () => {
  describe("when createRuntime() uses production adapters (AC5)", () => {
    it("should wire NodeWorkspaceFiles, GitDiffLocator, NapiMutatorEngine, VitestTestRunner, StdioReport+SchemaJsonFile", () => {
      // Given / When
      const runtime = createRuntime({ useFakes: false, cwd: repoRoot });

      // Then
      expect(runtime.files).toBeInstanceOf(NodeWorkspaceFiles);
      expect(runtime.sourceLocator).toBeInstanceOf(GitDiffLocator);
      expect(runtime.mutator).toBeInstanceOf(NapiMutatorEngine);
      expect(runtime.testRunner).toBeInstanceOf(VitestTestRunner);
      expect(runtime.report).toBeInstanceOf(CompositeReport);

      const report = runtime.report as CompositeReport;
      expect(report.stdio).toBeInstanceOf(StdioReport);
      expect(report.schemaJson).toBeInstanceOf(SchemaJsonFile);
      expect(report.sarifFile).toBeInstanceOf(SarifFile);
      expect(report.htmlFile).toBeInstanceOf(HtmlFile);

      expect(runtime.files).not.toBeInstanceOf(InMemoryFiles);
      expect(runtime.sourceLocator).not.toBeInstanceOf(InMemorySourceLocator);
      expect(runtime.mutator).not.toBeInstanceOf(FakeMutatorEngine);
      expect(runtime.testRunner).not.toBeInstanceOf(FakeTestRunner);
      expect(runtime.report).not.toBeInstanceOf(RecordingReport);
    });

    it("should also wire the same adapters for createRuntime() with no args defaults", () => {
      const previous = process.cwd();
      try {
        process.chdir(repoRoot);
        const runtime = createRuntime();
        expect(runtime.files).toBeInstanceOf(NodeWorkspaceFiles);
        expect(runtime.sourceLocator).toBeInstanceOf(GitDiffLocator);
        expect(runtime.mutator).toBeInstanceOf(NapiMutatorEngine);
        expect(runtime.testRunner).toBeInstanceOf(VitestTestRunner);
        expect(runtime.report).toBeInstanceOf(CompositeReport);
      } finally {
        process.chdir(previous);
      }
    });

    it("should wire VitestTestRunner when --workers is omitted (SC-212 / AC4)", () => {
      const runtime = createRuntime({ cwd: repoRoot });
      expect(runtime.testRunner).toBeInstanceOf(VitestTestRunner);
    });

    it("should wire PooledVitestTestRunner when workers is 4 (AC6)", () => {
      const pooled = createRuntime({
        useFakes: false,
        cwd: repoRoot,
        workers: 4,
      });
      expect(pooled.testRunner).toBeInstanceOf(PooledVitestTestRunner);
      expect((pooled.testRunner as PooledVitestTestRunner).workers).toBe(4);

      const sequential = createRuntime({
        useFakes: false,
        cwd: repoRoot,
        workers: 1,
      });
      expect(sequential.testRunner).toBeInstanceOf(VitestTestRunner);
      expect(sequential.testRunner).not.toBeInstanceOf(PooledVitestTestRunner);
    });

    it("should wire VitestTestRunner by default and JestTestRunner when runner is jest (AC5)", () => {
      const vitestDefault = createRuntime({ cwd: repoRoot });
      expect(vitestDefault.testRunner).toBeInstanceOf(VitestTestRunner);
      expect(vitestDefault.testRunner).not.toBeInstanceOf(JestTestRunner);

      const vitestExplicit = createRuntime({
        cwd: repoRoot,
        runner: "vitest",
      });
      expect(vitestExplicit.testRunner).toBeInstanceOf(VitestTestRunner);

      const jestRuntime = createRuntime({
        cwd: repoRoot,
        runner: "jest",
        workers: 4,
      });
      expect(jestRuntime.testRunner).toBeInstanceOf(JestTestRunner);
      expect(jestRuntime.testRunner).not.toBeInstanceOf(VitestTestRunner);
      expect(jestRuntime.testRunner).not.toBeInstanceOf(PooledVitestTestRunner);
    });
  });

  describe("when createRuntime({ useFakes: true }) runs a session (AC6)", () => {
    it("should not import vitest, load the NAPI addon, or spawn git", async () => {
      // Given — memory adapters only (no GitDiffLocator / NapiMutatorEngine / VitestTestRunner)
      const runtime = createRuntime({ useFakes: true, cwd: repoRoot });
      expect(runtime.files).toBeInstanceOf(InMemoryFiles);
      expect(runtime.sourceLocator).toBeInstanceOf(InMemorySourceLocator);
      expect(runtime.sourceLocator).not.toBeInstanceOf(GitDiffLocator);
      expect(runtime.mutator).toBeInstanceOf(FakeMutatorEngine);
      expect(runtime.mutator).not.toBeInstanceOf(NapiMutatorEngine);
      expect(runtime.testRunner).toBeInstanceOf(FakeTestRunner);
      expect(runtime.testRunner).not.toBeInstanceOf(VitestTestRunner);
      expect(runtime.report).toBeInstanceOf(RecordingReport);

      (runtime.sourceLocator as InMemorySourceLocator).setCandidates([]);

      // When — idle session completes without Vitest / NAPI / git
      const result = await runtime.runMutationSession.execute({ cwd: repoRoot });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.statuses).toEqual([]);

      const pkg = require("../package.json") as {
        dependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.vitest).toBeUndefined();

      const fs = await import("node:fs/promises");
      const fakeMutator = await fs.readFile(
        path.join(repoRoot, "src/adapters/outbound/memory/FakeMutatorEngine.ts"),
        "utf8",
      );
      const fakeRunner = await fs.readFile(
        path.join(repoRoot, "src/adapters/outbound/memory/FakeTestRunner.ts"),
        "utf8",
      );
      const inMemoryLocator = await fs.readFile(
        path.join(
          repoRoot,
          "src/adapters/outbound/memory/InMemorySourceLocator.ts",
        ),
        "utf8",
      );
      expect(fakeMutator).not.toMatch(/\.node|loadPucaBinding|puca-binding/);
      expect(fakeRunner).not.toMatch(/from ['"]vitest['"]|vitest\/node/);
      expect(inMemoryLocator).not.toMatch(/child_process|spawn\(/);
    });
  });
});
