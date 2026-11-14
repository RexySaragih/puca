import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import schemaJson from "mutation-testing-report-schema/mutation-testing-report-schema.json" with { type: "json" };
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/adapters/inbound/cli/parseArgs.js";
import { FakeMutatorEngine } from "../src/adapters/outbound/memory/FakeMutatorEngine.js";
import { FakeTestRunner } from "../src/adapters/outbound/memory/FakeTestRunner.js";
import { InMemoryFiles } from "../src/adapters/outbound/memory/InMemoryFiles.js";
import { InMemorySourceLocator } from "../src/adapters/outbound/memory/InMemorySourceLocator.js";
import { SchemaJsonFile } from "../src/adapters/outbound/report/SchemaJsonFile.js";
import { StdioReport } from "../src/adapters/outbound/report/StdioReport.js";
import { RunMutationSessionUseCase } from "../src/application/use-cases/RunMutationSessionUseCase.js";
import {
  toAbsolutePath,
  type AbsolutePath,
  type Mutant,
  type SessionResult,
  type Site,
} from "../src/domain/mutant.js";
import { NO_FILES_TO_MUTATE_MESSAGE } from "../src/domain/targetingErrors.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function captureStream(): { stream: Writable; text: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buf += String(chunk);
      callback();
    },
  });
  return {
    stream,
    text: () => buf,
  };
}

function siteFor(
  cwd: string,
  file: AbsolutePath,
  startOffset: number,
  mutatorName: string,
  original: string,
  replacement: string,
  line = 1,
): Site {
  const relpath = path.relative(cwd, file).replace(/\\/g, "/");
  return {
    id: `${relpath}:${startOffset}:${mutatorName}:${replacement}`,
    file,
    startOffset,
    endOffset: startOffset + original.length,
    line,
    column: startOffset + 1,
    mutatorName,
    original,
    replacement,
  };
}

describe("CLI terminal report and exit codes", () => {
  describe("parseArgs", () => {
    it("should parse --mutate, --json, and --timeout", () => {
      expect(
        parseArgs([
          "--mutate",
          "src/**/*.ts",
          "--json",
          "out.json",
          "--timeout",
          "9000",
        ]),
      ).toEqual({
        mutateGlob: "src/**/*.ts",
        jsonPath: "out.json",
        timeoutMs: 9000,
        includeUntracked: false,
        verbose: false,
      });
    });

    it("should parse --include-untracked", () => {
      expect(parseArgs(["--include-untracked"])).toEqual({
        mutateGlob: undefined,
        jsonPath: undefined,
        timeoutMs: undefined,
        includeUntracked: true,
        verbose: false,
      });
    });

    it("should parse --verbose", () => {
      expect(parseArgs(["--verbose"])).toEqual({
        mutateGlob: undefined,
        jsonPath: undefined,
        timeoutMs: undefined,
        includeUntracked: false,
        verbose: true,
      });
    });
  });

  describe("when one Survived and zero Error (AC1)", () => {
    it("should print status + mutator + file:line:col with original/replacement lines, five-bucket summary, exitCode 1", async () => {
      // Given
      const cwd = "/tmp/puca-cli-ac1";
      const file = toAbsolutePath(path.join(cwd, "src/foo.ts"));
      const site = siteFor(cwd, file, 10, "Arithmetic", "+", "-");
      const result: SessionResult = {
        statuses: [{ site, status: "Survived" }],
        exitCode: 1,
      };
      const out = captureStream();
      const err = captureStream();
      const report = new StdioReport({
        cwd,
        stdout: out.stream,
        stderr: err.stream,
      });

      // When
      await report.writeTerminal(result);

      // Then
      const text = out.text();
      expect(text).toContain("SURVIVED  Arithmetic  src/foo.ts:1:11");
      expect(text).toContain("- +");
      expect(text).toContain("+ -");
      expect(text).toContain("── Summary ──");
      expect(text).toMatch(/Killed: 0/);
      expect(text).toMatch(/Survived: 1/);
      expect(text).toMatch(/Timeout: 0/);
      expect(text).toMatch(/Error: 0/);
      expect(text).toMatch(/No Coverage: 0/);
      expect(result.exitCode).toBe(1);
      expect(err.text()).toBe("");
    });

    it("should truncate long originals on token boundaries, not mid-token", async () => {
      const cwd = "/tmp/puca-cli-trunc";
      const file = toAbsolutePath(path.join(cwd, "src/foo.ts"));
      const original = `${"token ".repeat(13)}labeled() { return med(); }`;
      const site = siteFor(cwd, file, 10, "BlockStatement", original, "true");
      const out = captureStream();
      const report = new StdioReport({ cwd, stdout: out.stream });

      await report.writeTerminal({
        statuses: [{ site, status: "Survived" }],
        exitCode: 1,
      });

      const text = out.text();
      expect(text).toContain("src/foo.ts:1:11");
      expect(text).toContain("- ");
      expect(text).toContain("+ true");
      expect(text).not.toMatch(/led\) \{\}/);
      expect(text).not.toMatch(/la…/);
      expect(text).toMatch(/token…/);
    });
  });

  describe("when only Killed/Timeout/NoCoverage (AC2)", () => {
    it("should exitCode 0 and print no Killed per-mutant diff blocks", async () => {
      // Given
      const cwd = "/tmp/puca-cli-ac2";
      const file = toAbsolutePath(path.join(cwd, "src/bar.ts"));
      const statuses: Mutant[] = [
        {
          site: siteFor(cwd, file, 1, "Arithmetic", "+", "-"),
          status: "Killed",
          killedBy: "t1",
        },
        {
          site: siteFor(cwd, file, 5, "Conditional", "true", "false"),
          status: "Timeout",
        },
        {
          site: siteFor(cwd, file, 9, "Literal", "0", "1"),
          status: "NoCoverage",
        },
      ];
      const result: SessionResult = { statuses, exitCode: 0 };
      const out = captureStream();
      const report = new StdioReport({ cwd, stdout: out.stream });

      // When
      await report.writeTerminal(result);

      // Then
      const text = out.text();
      expect(text).not.toMatch(/src\/bar\.ts:1:2\n- \+\n\+ -/);
      expect(text).toContain("TIMEOUT  Conditional  src/bar.ts:1:6");
      expect(text).toContain("- true");
      expect(text).toContain("+ false");
      expect(text).not.toMatch(/- 0/);
      expect(text).toMatch(/Killed: 1/);
      expect(text).toMatch(/Survived: 0/);
      expect(text).toMatch(/Timeout: 1/);
      expect(text).toMatch(/Error: 0/);
      expect(text).toMatch(/No Coverage: 1/);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("realtime mutant streaming", () => {
    it("should print a session banner and stream Survived as soon as scored", () => {
      const cwd = "/tmp/puca-cli-live";
      const file = toAbsolutePath(path.join(cwd, "src/live.ts"));
      const out = captureStream();
      const err = captureStream();
      const report = new StdioReport({
        cwd,
        stdout: out.stream,
        stderr: err.stream,
      });

      report.writeSessionStart({
        fileCount: 2,
        mutantCount: 3,
        timeoutMs: 4000,
      });
      report.writeMutantResult(
        {
          site: siteFor(cwd, file, 4, "ArithmeticOperator", "+", "-"),
          status: "Killed",
          killedBy: "adds",
        },
        {
          index: 1,
          total: 3,
          counts: {
            killed: 1,
            survived: 0,
            timeout: 0,
            error: 0,
            noCoverage: 0,
          },
        },
      );
      report.writeMutantResult(
        {
          site: siteFor(cwd, file, 8, "LogicalOperator", "&&", "||"),
          status: "Survived",
        },
        {
          index: 2,
          total: 3,
          counts: {
            killed: 1,
            survived: 1,
            timeout: 0,
            error: 0,
            noCoverage: 0,
          },
        },
      );

      expect(err.text()).toContain(
        "Scoring 3 mutants across 2 files (timeout 4000ms)…",
      );
      expect(err.text()).toContain("[1/3] KILLED  ArithmeticOperator");
      expect(err.text()).toContain("K:1 S:0");
      expect(out.text()).toContain(
        "[2/3] SURVIVED  LogicalOperator  src/live.ts:1:9",
      );
      expect(out.text()).toContain("- &&");
      expect(out.text()).toContain("+ ||");
    });

    it("should not re-print streamed detail lines in the final summary", async () => {
      const cwd = "/tmp/puca-cli-live-summary";
      const file = toAbsolutePath(path.join(cwd, "src/live.ts"));
      const site = siteFor(cwd, file, 8, "LogicalOperator", "&&", "||");
      const out = captureStream();
      const report = new StdioReport({ cwd, stdout: out.stream });

      report.writeMutantResult(
        { site, status: "Survived" },
        {
          index: 1,
          total: 1,
          counts: {
            killed: 0,
            survived: 1,
            timeout: 0,
            error: 0,
            noCoverage: 0,
          },
        },
      );
      await report.writeTerminal({
        statuses: [{ site, status: "Survived" }],
        exitCode: 1,
      });

      const survivedBlocks = out.text().split("SURVIVED").length - 1;
      expect(survivedBlocks).toBe(1);
      expect(out.text()).toContain("── Summary ──");
      expect(out.text()).toMatch(/Survived: 1/);
    });
  });

  describe("when ≥1 Error even with Survived (AC3)", () => {
    it("should exitCode 2", async () => {
      // Given
      const cwd = "/tmp/puca-cli-ac3";
      const file = toAbsolutePath(path.join(cwd, "src/baz.ts"));
      const result: SessionResult = {
        statuses: [
          {
            site: siteFor(cwd, file, 1, "Arithmetic", "+", "-"),
            status: "Survived",
          },
          {
            site: siteFor(cwd, file, 4, "Arithmetic", "-", "+"),
            status: "RuntimeError",
          },
        ],
        exitCode: 2,
      };
      const out = captureStream();
      const report = new StdioReport({ cwd, stdout: out.stream });

      // When
      await report.writeTerminal(result);

      // Then
      expect(out.text()).toContain("src/baz.ts:1:2");
      expect(out.text()).toContain("- +");
      expect(out.text()).toContain("+ -");
      expect(out.text()).toContain("- -");
      expect(out.text()).toContain("+ +");
      expect(out.text()).toMatch(/Error: 1/);
      expect(out.text()).toMatch(/Survived: 1/);
      expect(result.exitCode).toBe(2);
    });
  });

  describe("when A6 idle message is set", () => {
    it("should print No files to mutate with zeroed summary", async () => {
      const result: SessionResult = {
        statuses: [],
        exitCode: 0,
        message: NO_FILES_TO_MUTATE_MESSAGE,
      };
      const out = captureStream();
      const report = new StdioReport({
        cwd: "/tmp",
        stdout: out.stream,
      });

      await report.writeTerminal(result);

      expect(out.text()).toContain(NO_FILES_TO_MUTATE_MESSAGE);
      expect(out.text()).toMatch(/Killed: 0/);
      expect(out.text()).toMatch(/No Coverage: 0/);
    });
  });

  describe("when --json is requested (AC4)", () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-json-"));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("should write a document that validates against mutation-testing-report-schema", async () => {
      // Given
      const sourceFile = toAbsolutePath(path.join(tempDir, "src/add.ts"));
      const sourceText = "export const add = (a: number, b: number) => a + b;\n";
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(sourceFile, sourceText, "utf8");

      const files = new InMemoryFiles(tempDir);
      files.seed(sourceFile, sourceText);
      const schema = new SchemaJsonFile(files, tempDir);
      const site = siteFor(tempDir, sourceFile, 48, "Arithmetic", "+", "-");
      const result: SessionResult = {
        statuses: [
          { site, status: "Survived" },
          {
            site: siteFor(tempDir, sourceFile, 48, "Arithmetic", "+", "*"),
            status: "Killed",
            killedBy: "t",
          },
          {
            site: siteFor(tempDir, sourceFile, 10, "Literal", "0", "1"),
            status: "Timeout",
          },
          {
            site: siteFor(tempDir, sourceFile, 12, "Literal", "1", "0"),
            status: "NoCoverage",
          },
          {
            site: siteFor(tempDir, sourceFile, 14, "Block", "{}", "{;}"),
            status: "RuntimeError",
          },
        ],
        exitCode: 2,
      };
      const jsonPath = path.join(tempDir, "report.json");

      // When
      await schema.writeJson(jsonPath, result);
      const raw = JSON.parse(await fs.readFile(jsonPath, "utf8")) as {
        schemaVersion: string;
        thresholds: { high: number; low: number };
        framework: { name: string };
        files: Record<
          string,
          {
            language: string;
            source: string;
            mutants: Array<{ status: string }>;
          }
        >;
      };

      // Then
      const ajv = new Ajv({ strict: false });
      const validate = ajv.compile(schemaJson);
      expect(validate(raw)).toBe(true);
      if (validate.errors) {
        expect(validate.errors).toEqual([]);
      }

      expect(raw.schemaVersion).toBe("2");
      expect(raw.thresholds).toEqual({ high: 80, low: 60 });
      expect(raw.framework.name).toBe("Púca");
      expect(raw.files["src/add.ts"]?.language).toBe("typescript");
      expect(raw.files["src/add.ts"]?.source).toBe(sourceText);

      const statuses = raw.files["src/add.ts"]!.mutants.map((m) => m.status);
      expect(statuses).toEqual([
        "Survived",
        "Killed",
        "Timeout",
        "NoCoverage",
        "RuntimeError",
      ]);
    });

    it("should write JSON through the use case when jsonPath is set", async () => {
      const source = toAbsolutePath(path.join(tempDir, "src/x.ts"));
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      const sourceText = "export const x = 1;\n";
      await fs.writeFile(source, sourceText, "utf8");

      const files = new InMemoryFiles(tempDir);
      files.seed(source, sourceText);
      const sourceLocator = new InMemorySourceLocator();
      sourceLocator.setCandidates([]);
      const schema = new SchemaJsonFile(files, tempDir);
      const stdio = new StdioReport({
        cwd: tempDir,
        stdout: captureStream().stream,
        stderr: captureStream().stream,
      });
      const useCase = new RunMutationSessionUseCase({
        mutator: new FakeMutatorEngine(),
        testRunner: new FakeTestRunner(),
        sourceLocator,
        files,
        report: {
          writeTerminal: (r) => stdio.writeTerminal(r),
          writeJson: (p, r) => schema.writeJson(p, r),
        },
      });

      const jsonPath = path.join(tempDir, "idle.json");
      const result = await useCase.execute({
        cwd: tempDir,
        jsonPath,
      });

      expect(result.exitCode).toBe(0);
      const doc = JSON.parse(await fs.readFile(jsonPath, "utf8")) as {
        files: Record<string, unknown>;
        schemaVersion: string;
      };
      expect(doc.schemaVersion).toBe("2");
      expect(doc.files).toEqual({});
    });
  });
});

describe("exit code priority (Survived + Error)", () => {
  it("should prefer Error (2) over Survived (1) via use case scoring", async () => {
    const cwd = path.join(repoRoot, "tmp-exit-priority");
    const source = toAbsolutePath(path.join(cwd, "src/a.ts"));
    const files = new InMemoryFiles(cwd);
    const mutator = new FakeMutatorEngine();
    const testRunner = new FakeTestRunner();
    const sourceLocator = new InMemorySourceLocator();
    const report = new StdioReport({
      cwd,
      stdout: captureStream().stream,
      stderr: captureStream().stream,
    });

    const siteOk = siteFor(cwd, source, 1, "Arithmetic", "+", "-");
    const siteBad = siteFor(cwd, source, 4, "Arithmetic", "-", "+");
    sourceLocator.setCandidates([source]);
    files.seed(source, "a+b-c");
    mutator.setSites(source, [siteOk, siteBad]);
    const spec = toAbsolutePath(path.join(cwd, "test/a.test.ts"));
    testRunner.setAllSpecs([spec]);
    testRunner.setStaticImports({ [spec]: [source] });
    testRunner.baselineResult = { ok: true };
    testRunner.queueRelatedBehaviors(
      { kind: "passed" },
      { kind: "error", message: "boom" },
    );

    const useCase = new RunMutationSessionUseCase({
      mutator,
      testRunner,
      sourceLocator,
      files,
      report,
    });

    const result = await useCase.execute({ cwd });
    expect(result.exitCode).toBe(2);
    expect(result.statuses.map((s) => s.status)).toEqual([
      "Survived",
      "RuntimeError",
    ]);
  });
});
