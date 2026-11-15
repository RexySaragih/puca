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
import { RecordingReport } from "../src/adapters/outbound/memory/RecordingReport.js";
import { SarifFile } from "../src/adapters/outbound/report/SarifFile.js";
import { SchemaJsonFile } from "../src/adapters/outbound/report/SchemaJsonFile.js";
import { StdioReport } from "../src/adapters/outbound/report/StdioReport.js";
import type { ReportPort } from "../src/application/ports/outbound/ReportPort.js";
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

function captureStream(
  options: { isTTY?: boolean } = {},
): { stream: Writable; text: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buf += String(chunk);
      callback();
    },
  });
  if (options.isTTY === true) {
    (stream as NodeJS.WriteStream).isTTY = true;
  }
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
        workers: 1,
        breakOnScore: undefined,
        failOnNoCoverage: false,
        sarifPath: undefined,
        htmlPath: undefined,
        cache: false,
        workspaceGlob: undefined,
        runner: "vitest",
      });
    });

    it("should parse --include-untracked", () => {
      expect(parseArgs(["--include-untracked"])).toEqual({
        mutateGlob: undefined,
        jsonPath: undefined,
        timeoutMs: undefined,
        includeUntracked: true,
        verbose: false,
        workers: 1,
        breakOnScore: undefined,
        failOnNoCoverage: false,
        sarifPath: undefined,
        htmlPath: undefined,
        cache: false,
        workspaceGlob: undefined,
        runner: "vitest",
      });
    });

    it("should parse --verbose", () => {
      expect(parseArgs(["--verbose"])).toEqual({
        mutateGlob: undefined,
        jsonPath: undefined,
        timeoutMs: undefined,
        includeUntracked: false,
        verbose: true,
        workers: 1,
        breakOnScore: undefined,
        failOnNoCoverage: false,
        sarifPath: undefined,
        htmlPath: undefined,
        cache: false,
        workspaceGlob: undefined,
        runner: "vitest",
      });
    });

    it("should parse --workers 4 (AC1)", () => {
      expect(parseArgs(["--workers", "4"]).workers).toBe(4);
      expect(parseArgs(["--workers=4"]).workers).toBe(4);
    });

    it("should default workers to 1 when omitted (AC2)", () => {
      expect(parseArgs([]).workers).toBe(1);
    });

    it("should parse opt-in CI flags (REQ-1401 / REQ-1404)", () => {
      expect(
        parseArgs([
          "--break-on-score",
          "80",
          "--fail-on-no-coverage",
          "--sarif",
          "out.sarif",
        ]),
      ).toEqual({
        mutateGlob: undefined,
        jsonPath: undefined,
        timeoutMs: undefined,
        includeUntracked: false,
        verbose: false,
        workers: 1,
        breakOnScore: 80,
        failOnNoCoverage: true,
        sarifPath: "out.sarif",
        htmlPath: undefined,
        cache: false,
        workspaceGlob: undefined,
        runner: "vitest",
      });
      expect(parseArgs([]).breakOnScore).toBeUndefined();
      expect(parseArgs([]).failOnNoCoverage).toBe(false);
      expect(parseArgs([]).sarifPath).toBeUndefined();
      expect(parseArgs([]).htmlPath).toBeUndefined();
      expect(parseArgs([]).cache).toBe(false);
      expect(parseArgs([]).runner).toBe("vitest");
      expect(parseArgs(["--fail-on-no-coverage"]).failOnNoCoverage).toBe(true);
      expect(parseArgs(["--cache"]).cache).toBe(true);
      expect(parseArgs(["--html", "r.html"]).htmlPath).toBe("r.html");
      expect(parseArgs(["--runner", "jest"]).runner).toBe("jest");
    });

    it("should refuse unknown non-flags (SC-327)", () => {
      expect(() => parseArgs(["--mutate-template-expressions"])).toThrow(
        /Unknown argument/,
      );
      expect(() => parseArgs(["--file-summary"])).toThrow(/Unknown argument/);
      expect(() => parseArgs(["--report", "html"])).toThrow(/Unknown argument/);
      expect(() => parseArgs(["--mutate="])).toThrow(/Invalid value for --mutate/);
      expect(() => parseArgs(["--mutate", ""])).toThrow(
        /Invalid value for --mutate|Missing value for --mutate/,
      );
    });

    it("should refuse invalid --break-on-score (SC-331)", async () => {
      const { runCli } = await import("../src/cli.js");
      const cases: Array<{ argv: string[]; received: string }> = [
        { argv: ["--break-on-score", "80.5"], received: "80.5" },
        { argv: ["--break-on-score", "0"], received: "0" },
        { argv: ["--break-on-score", "101"], received: "101" },
        { argv: ["--break-on-score"], received: "" },
        { argv: ["--break-on-score="], received: "" },
      ];

      for (const { argv, received } of cases) {
        let stderr = "";
        const prevWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        }) as typeof process.stderr.write;
        try {
          const code = await runCli({ argv, cwd: repoRoot });
          expect(code, argv.join(" ")).toBe(2);
          expect(stderr, argv.join(" ")).toContain(
            `Error: Invalid value for --break-on-score. Expected integer between 1 and 100, received '${received}'.`,
          );
        } finally {
          process.stderr.write = prevWrite;
        }
      }
    });

    it("should refuse missing or empty --sarif path (SC-331 / REQ-1403)", async () => {
      const { runCli } = await import("../src/cli.js");
      const cases = [["--sarif"], ["--sarif="], ["--sarif", ""]];

      for (const argv of cases) {
        let stderr = "";
        const prevWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        }) as typeof process.stderr.write;
        try {
          const code = await runCli({ argv, cwd: repoRoot });
          expect(code, argv.join(" ")).toBe(2);
          expect(stderr, argv.join(" ")).toContain(
            "Error: Invalid value for --sarif. Expected a valid file path, received empty or missing argument.",
          );
        } finally {
          process.stderr.write = prevWrite;
        }
      }
    });

    it("should refuse invalid --workers (AC3)", async () => {
      const { runCli } = await import("../src/cli.js");
      const cases: Array<{ argv: string[]; match: RegExp }> = [
        { argv: ["--workers", "0"], match: /--workers/ },
        { argv: ["--workers", "1.5"], match: /--workers/ },
        { argv: ["--workers", "foo"], match: /--workers/ },
        { argv: ["--workers"], match: /--workers/ },
      ];

      for (const { argv, match } of cases) {
        let stderr = "";
        const prevWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((chunk: string | Uint8Array) => {
          stderr += String(chunk);
          return true;
        }) as typeof process.stderr.write;
        try {
          const code = await runCli({ argv, cwd: repoRoot });
          expect(code, argv.join(" ")).toBe(2);
          expect(stderr, argv.join(" ")).toMatch(match);
        } finally {
          process.stderr.write = prevWrite;
        }
      }
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
      const original = `${"token ".repeat(30)}labeled() { return med(); }`;
      const site = siteFor(cwd, file, 10, "BlockStatement", original, "true");
      const out = captureStream();
      const report = new StdioReport({ cwd, stdout: out.stream });

      await report.writeTerminal({
        statuses: [{ site, status: "Survived" }],
        exitCode: 1,
      });

      const text = out.text();
      expect(text).toContain("src/foo.ts:1:11");
      expect(text).toContain("+ true");
      // Long token originals are length-capped for the terminal.
      const minusLine = text.split("\n").find((line) => line.startsWith("- "));
      expect(minusLine).toBeDefined();
      expect(minusLine!.length).toBeLessThanOrEqual(2 + 120 + 1);
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

    it("should color status words on TTY when NO_COLOR is unset", async () => {
      const cwd = "/tmp/puca-cli-color";
      const file = toAbsolutePath(path.join(cwd, "src/color.ts"));
      const out = captureStream({ isTTY: true });
      const err = captureStream({ isTTY: true });
      const report = new StdioReport({
        cwd,
        stdout: out.stream,
        stderr: err.stream,
        env: {},
      });

      report.writeMutantResult(
        {
          site: siteFor(cwd, file, 4, "ArithmeticOperator", "+", "-"),
          status: "Killed",
          killedBy: "t1",
        },
        {
          index: 1,
          total: 2,
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
          total: 2,
          counts: {
            killed: 1,
            survived: 1,
            timeout: 0,
            error: 0,
            noCoverage: 0,
          },
        },
      );

      expect(err.text()).toMatch(/\x1b\[32mKILLED\x1b\[0m/);
      expect(out.text()).toMatch(/\x1b\[31mSURVIVED\x1b\[0m/);
    });

    it("should skip ANSI color when NO_COLOR is set on a TTY", async () => {
      const cwd = "/tmp/puca-cli-nocolor";
      const file = toAbsolutePath(path.join(cwd, "src/nocolor.ts"));
      const out = captureStream({ isTTY: true });
      const report = new StdioReport({
        cwd,
        stdout: out.stream,
        env: { NO_COLOR: "1" },
      });

      await report.writeTerminal({
        statuses: [
          {
            site: siteFor(cwd, file, 8, "LogicalOperator", "&&", "||"),
            status: "Survived",
          },
        ],
        exitCode: 1,
      });

      expect(out.text()).toContain("SURVIVED  LogicalOperator");
      expect(out.text()).not.toMatch(/\x1b\[/);
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
      expect(out.text()).not.toContain("── File Summary ──");
    });
  });

  describe("File Summary table (SC-324 / SC-325)", () => {
    it("should print Summary then File Summary with sorted paths and bucket counts", async () => {
      // Given — two files; sort order must be ascending by relative path
      const cwd = "/tmp/puca-file-summary";
      const fileB = toAbsolutePath(path.join(cwd, "src/b.ts"));
      const fileA = toAbsolutePath(path.join(cwd, "src/a.ts"));
      const statuses: Mutant[] = [
        {
          site: siteFor(cwd, fileB, 1, "ArithmeticOperator", "+", "-"),
          status: "Timeout",
        },
        {
          site: siteFor(cwd, fileB, 5, "BooleanLiteral", "true", "false"),
          status: "NoCoverage",
        },
        {
          site: siteFor(cwd, fileA, 1, "ArithmeticOperator", "+", "-"),
          status: "Killed",
          killedBy: "t",
        },
        {
          site: siteFor(cwd, fileA, 3, "ArithmeticOperator", "-", "+"),
          status: "Killed",
          killedBy: "t",
        },
        {
          site: siteFor(cwd, fileA, 5, "ArithmeticOperator", "*", "/"),
          status: "Killed",
          killedBy: "t",
        },
        {
          site: siteFor(cwd, fileA, 7, "EqualityOperator", "===", "!=="),
          status: "Survived",
        },
      ];
      const result: SessionResult = { statuses, exitCode: 1 };
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
      const summaryIdx = text.indexOf("── Summary ──");
      const fileSummaryIdx = text.indexOf("── File Summary ──");
      expect(summaryIdx).toBeGreaterThanOrEqual(0);
      expect(fileSummaryIdx).toBeGreaterThan(summaryIdx);
      expect(text).toContain("File");
      expect(text).toContain("Total");
      expect(text).toContain("Killed");
      expect(text).toContain("Survived");
      expect(text).toContain("Timeout");
      expect(text).toContain("NoCov");
      expect(text).toContain("Error");
      expect(text).toContain("Kill%");
      const table = text.slice(fileSummaryIdx);
      expect(table).toMatch(/src\/a\.ts\s+4\s+3\s+1\s+0\s+0\s+0\s+75%/);
      expect(table).toMatch(/src\/b\.ts\s+2\s+0\s+0\s+1\s+1\s+0\s+-/);
      const aIdx = table.indexOf("src/a.ts");
      const bIdx = table.indexOf("src/b.ts");
      expect(aIdx).toBeGreaterThan(-1);
      expect(bIdx).toBeGreaterThan(aIdx);
      expect(result.exitCode).toBe(1);
      expect(err.text()).toBe("");
    });

    it("should render Kill% as `-` when only NoCoverage mutants exist for a file", async () => {
      const cwd = "/tmp/puca-file-summary-nocov";
      const file = toAbsolutePath(path.join(cwd, "src/uncovered.ts"));
      const out = captureStream();
      const report = new StdioReport({ cwd, stdout: out.stream });

      await report.writeTerminal({
        statuses: [
          {
            site: siteFor(cwd, file, 1, "ArithmeticOperator", "+", "-"),
            status: "NoCoverage",
          },
          {
            site: siteFor(cwd, file, 4, "BooleanLiteral", "true", "false"),
            status: "NoCoverage",
          },
        ],
        exitCode: 0,
      });

      const text = out.text();
      expect(text).toContain("── File Summary ──");
      expect(text).toMatch(/src\/uncovered\.ts\s+2\s+0\s+0\s+0\s+2\s+0\s+-/);
    });

    it("should omit File Summary on idle empty statuses and pre-score refuse", async () => {
      const idleOut = captureStream();
      const refuseOut = captureStream();
      const refuseErr = captureStream();

      await new StdioReport({
        cwd: "/tmp",
        stdout: idleOut.stream,
      }).writeTerminal({
        statuses: [],
        exitCode: 0,
        message: NO_FILES_TO_MUTATE_MESSAGE,
      });

      await new StdioReport({
        cwd: "/tmp",
        stdout: refuseOut.stream,
        stderr: refuseErr.stream,
      }).writeTerminal({
        statuses: [],
        exitCode: 2,
        message: "Not a git repository. Pass --mutate <glob> to specify files.",
      });

      expect(idleOut.text()).not.toContain("── File Summary ──");
      expect(refuseOut.text()).not.toContain("── File Summary ──");
      expect(refuseErr.text()).not.toContain("── File Summary ──");
    });

    it("should keep verbose footer on stderr separate from File Summary stdout", async () => {
      const cwd = "/tmp/puca-file-summary-verbose";
      const file = toAbsolutePath(path.join(cwd, "src/a.ts"));
      const out = captureStream();
      const err = captureStream();
      const report = new StdioReport({
        cwd,
        stdout: out.stream,
        stderr: err.stream,
      });

      await report.writeTerminal({
        statuses: [
          {
            site: siteFor(cwd, file, 1, "ArithmeticOperator", "+", "-"),
            status: "Killed",
            killedBy: "t",
          },
        ],
        exitCode: 0,
        verboseFooter: "── Verbose ──\nrespawns: 0",
      });

      expect(out.text()).toContain("── File Summary ──");
      expect(out.text()).not.toContain("── Verbose ──");
      expect(err.text()).toContain("── Verbose ──");
      expect(err.text()).not.toContain("── File Summary ──");
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

      const mutants = raw.files["src/add.ts"]!.mutants as Array<{
        id: string;
        status: string;
      }>;
      const ids = mutants.map((m) => m.id);
      expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
      expect(mutants.map((m) => m.status)).toEqual(
        [...result.statuses]
          .sort((a, b) => a.site.id.localeCompare(b.site.id))
          .map((entry) => entry.status),
      );
    });

    it("should sort a file's mutants by site.id when inserted in reverse order (AC1)", async () => {
      const sourceFile = toAbsolutePath(path.join(tempDir, "src/sort.ts"));
      const sourceText = "export const n = 1;\n";
      await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
      await fs.writeFile(sourceFile, sourceText, "utf8");
      const files = new InMemoryFiles(tempDir);
      files.seed(sourceFile, sourceText);
      const schema = new SchemaJsonFile(files, tempDir);

      // Lexicographic ids: ":10:" < ":20:" (avoid ":5:" vs ":20:" digit trap).
      const later = siteFor(tempDir, sourceFile, 20, "Literal", "1", "0");
      const earlier = siteFor(tempDir, sourceFile, 10, "Literal", "0", "1");
      expect(earlier.id.localeCompare(later.id)).toBeLessThan(0);
      const result: SessionResult = {
        statuses: [
          { site: later, status: "Survived" },
          { site: earlier, status: "Killed", killedBy: "t" },
        ],
        exitCode: 1,
      };
      const jsonPath = path.join(tempDir, "sorted.json");

      await schema.writeJson(jsonPath, result);
      const raw = JSON.parse(await fs.readFile(jsonPath, "utf8")) as {
        files: Record<string, { mutants: Array<{ id: string; status: string }> }>;
      };
      const mutants = raw.files["src/sort.ts"]!.mutants;
      expect(mutants.map((m) => m.id)).toEqual([earlier.id, later.id]);
      expect(mutants.map((m) => m.status)).toEqual(["Killed", "Survived"]);
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

describe("verbose recycle footer on terminal (AC2)", () => {
  it("should print recycle footer on stderr while Survived lines stay on UX-001 stdout", async () => {
    const cwd = path.join(repoRoot, "tmp-verbose-recycle");
    const source = toAbsolutePath(path.join(cwd, "src/a.ts"));
    const site = siteFor(cwd, source, 1, "Arithmetic", "+", "-");
    const out = captureStream();
    const err = captureStream();
    const report = new StdioReport({
      cwd,
      stdout: out.stream,
      stderr: err.stream,
    });

    const result: SessionResult = {
      statuses: [{ site, status: "Survived" }],
      exitCode: 1,
      verboseFooter: "Worker recycles (timeout+RSS): 2",
    };

    report.writeMutantResult?.(result.statuses[0]!, {
      index: 1,
      total: 1,
      counts: {
        killed: 0,
        survived: 1,
        timeout: 0,
        error: 0,
        noCoverage: 0,
      },
    });
    await report.writeTerminal(result);

    expect(out.text()).toMatch(/Survived/);
    expect(err.text()).toContain("Worker recycles (timeout+RSS): 2");
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

describe("SARIF report (SC-336 / ADR-033)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-sarif-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should write Survived-only SARIF 2.1.0 with line/col when --sarif is set", async () => {
    const source = toAbsolutePath(path.join(tempDir, "src/a.ts"));
    const files = new InMemoryFiles(tempDir);
    const mutator = new FakeMutatorEngine();
    const testRunner = new FakeTestRunner();
    const sourceLocator = new InMemorySourceLocator();
    const recording = new RecordingReport();
    const sarif = new SarifFile(tempDir);
    const report: ReportPort = {
      writeTerminal: (r) => recording.writeTerminal(r),
      writeSarif: (p, r) => sarif.writeSarif(p, r),
    };

    const survived = siteFor(tempDir, source, 10, "ArithmeticOperator", "+", "-");
    const killed = siteFor(tempDir, source, 20, "BooleanLiteral", "true", "false");
    sourceLocator.setCandidates([source]);
    files.seed(source, "a+b; true;");
    mutator.setSites(source, [survived, killed]);
    const spec = toAbsolutePath(path.join(tempDir, "test/a.test.ts"));
    testRunner.setAllSpecs([spec]);
    testRunner.setStaticImports({ [spec]: [source] });
    testRunner.baselineResult = { ok: true };
    testRunner.queueRelatedBehaviors(
      { kind: "passed" },
      { kind: "failed", failingTestId: "t" },
    );

    const useCase = new RunMutationSessionUseCase({
      mutator,
      testRunner,
      sourceLocator,
      files,
      report,
    });
    const sarifPath = path.join(tempDir, "out.sarif");

    const result = await useCase.execute({ cwd: tempDir, sarifPath });

    expect(result.exitCode).toBe(1);
    const raw = JSON.parse(await fs.readFile(sarifPath, "utf8")) as {
      version: string;
      runs: Array<{
        tool: { driver: { name: string } };
        results: Array<{
          level: string;
          message: { text: string };
          locations: Array<{
            physicalLocation: {
              artifactLocation: { uri: string };
              region: { startLine: number; startColumn: number };
            };
          }>;
        }>;
      }>;
    };
    expect(raw.version).toBe("2.1.0");
    expect(raw.runs[0]?.tool.driver.name).toBe("puca");
    expect(raw.runs[0]?.results).toHaveLength(1);
    const only = raw.runs[0]!.results[0]!;
    expect(only.level).toBe("error");
    expect(only.message.text).toContain("ArithmeticOperator");
    expect(only.message.text).toContain("+ → -");
    expect(only.locations[0]!.physicalLocation.region.startLine).toBe(
      survived.line,
    );
    expect(only.locations[0]!.physicalLocation.region.startColumn).toBe(
      survived.column,
    );
    expect(only.locations[0]!.physicalLocation.artifactLocation.uri).toMatch(
      /^file:\/\//,
    );
  });

  it("should not write a SARIF file when --sarif is omitted", async () => {
    const source = toAbsolutePath(path.join(tempDir, "src/a.ts"));
    const files = new InMemoryFiles(tempDir);
    const mutator = new FakeMutatorEngine();
    const testRunner = new FakeTestRunner();
    const sourceLocator = new InMemorySourceLocator();
    const report = new RecordingReport();
    const site = siteFor(tempDir, source, 1, "Arithmetic", "+", "-");
    sourceLocator.setCandidates([source]);
    files.seed(source, "a+b");
    mutator.setSites(source, [site]);
    const spec = toAbsolutePath(path.join(tempDir, "test/a.test.ts"));
    testRunner.setAllSpecs([spec]);
    testRunner.setStaticImports({ [spec]: [source] });
    testRunner.baselineResult = { ok: true };
    testRunner.relatedResult = { kind: "passed" };

    const useCase = new RunMutationSessionUseCase({
      mutator,
      testRunner,
      sourceLocator,
      files,
      report,
    });

    await useCase.execute({ cwd: tempDir });

    expect(report.sarifWrites).toHaveLength(0);
    const entries = await fs.readdir(tempDir);
    expect(entries.some((name) => name.endsWith(".sarif"))).toBe(false);
  });

  it("should keep --json thresholds at 80/60 when --break-on-score is also set (REQ-1604)", async () => {
    const sourceFile = toAbsolutePath(path.join(tempDir, "src/add.ts"));
    const sourceText = "export const add = (a: number, b: number) => a + b;\n";
    await fs.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.writeFile(sourceFile, sourceText, "utf8");
    const files = new InMemoryFiles(tempDir);
    files.seed(sourceFile, sourceText);
    const schema = new SchemaJsonFile(files, tempDir);
    const site = siteFor(tempDir, sourceFile, 48, "Arithmetic", "+", "-");
    const jsonPath = path.join(tempDir, "report.json");

    await schema.writeJson(jsonPath, {
      statuses: [{ site, status: "Survived" }],
      exitCode: 1,
    });

    const raw = JSON.parse(await fs.readFile(jsonPath, "utf8")) as {
      thresholds: { high: number; low: number };
    };
    expect(raw.thresholds).toEqual({ high: 80, low: 60 });
  });

  it("should keep ReportPort surface additive with optional writeSarif (AC1)", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "src/application/ports/outbound/ReportPort.ts"),
      "utf8",
    );
    expect(source).toMatch(/writeSarif\?/);
    expect(source).toMatch(/writeHtml\?/);
    expect(source).toMatch(/writeTerminal/);
    expect(source).toMatch(/writeJson\?/);
    expect(source).toMatch(/writeNotice\?/);
    expect(source).toMatch(/writeSessionStart\?/);
    expect(source).toMatch(/writeMutantResult\?/);
  });
});

describe("HTML report (SC-341 / ADR-034)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-html-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should refuse missing or empty --html path (SC-345)", async () => {
    const { runCli } = await import("../src/cli.js");
    for (const argv of [["--html"], ["--html="], ["--html", ""]]) {
      let stderr = "";
      const prevWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      }) as typeof process.stderr.write;
      try {
        const code = await runCli({ argv, cwd: repoRoot });
        expect(code, argv.join(" ")).toBe(2);
        expect(stderr).toContain("--html");
      } finally {
        process.stderr.write = prevWrite;
      }
    }
  });

  it("should write a self-contained HTML file with filters and diffs", async () => {
    const source = toAbsolutePath(path.join(tempDir, "src/a.ts"));
    const files = new InMemoryFiles(tempDir);
    const mutator = new FakeMutatorEngine();
    const testRunner = new FakeTestRunner();
    const sourceLocator = new InMemorySourceLocator();
    const { HtmlFile } = await import(
      "../src/adapters/outbound/report/HtmlFile.js"
    );
    const html = new HtmlFile(tempDir);
    const recording = new RecordingReport();
    const report: ReportPort = {
      writeTerminal: (r) => recording.writeTerminal(r),
      writeHtml: (p, r) => html.writeHtml(p, r),
    };
    const site = siteFor(tempDir, source, 1, "ArithmeticOperator", "+", "-");
    sourceLocator.setCandidates([source]);
    files.seed(source, "a+b");
    mutator.setSites(source, [site]);
    const spec = toAbsolutePath(path.join(tempDir, "test/a.test.ts"));
    testRunner.setAllSpecs([spec]);
    testRunner.setStaticImports({ [spec]: [source] });
    testRunner.baselineResult = { ok: true };
    testRunner.relatedResult = { kind: "passed" };

    const useCase = new RunMutationSessionUseCase({
      mutator,
      testRunner,
      sourceLocator,
      files,
      report,
    });
    const htmlPath = path.join(tempDir, "report.html");
    await useCase.execute({ cwd: tempDir, htmlPath });

    const text = await fs.readFile(htmlPath, "utf8");
    expect(text).toContain("<style>");
    expect(text).toContain("<script>");
    expect(text).toContain("puca-session");
    expect(text).toContain("ArithmeticOperator");
    expect(text).toContain("Survived");
    expect(text).toContain('id="filters"');
    expect(text).toMatch(/class="diff"/);
    expect(text).not.toMatch(/https?:\/\/[^"'\s]+/);
    expect(text).not.toMatch(/@stryker-mutator\//);
  });

  it("should write html+json+sarif together while keeping terminal summary", async () => {
    const source = toAbsolutePath(path.join(tempDir, "src/a.ts"));
    const files = new InMemoryFiles(tempDir);
    files.seed(source, "a+b");
    const mutator = new FakeMutatorEngine();
    const testRunner = new FakeTestRunner();
    const sourceLocator = new InMemorySourceLocator();
    const { HtmlFile } = await import(
      "../src/adapters/outbound/report/HtmlFile.js"
    );
    const { SchemaJsonFile } = await import(
      "../src/adapters/outbound/report/SchemaJsonFile.js"
    );
    const { SarifFile } = await import(
      "../src/adapters/outbound/report/SarifFile.js"
    );
    const out = captureStream();
    const stdio = new StdioReport({ cwd: tempDir, stdout: out.stream });
    const report: ReportPort = {
      writeTerminal: (r) => stdio.writeTerminal(r),
      writeJson: (p, r) => new SchemaJsonFile(files, tempDir).writeJson(p, r),
      writeSarif: (p, r) => new SarifFile(tempDir).writeSarif(p, r),
      writeHtml: (p, r) => new HtmlFile(tempDir).writeHtml(p, r),
    };
    const site = siteFor(tempDir, source, 1, "ArithmeticOperator", "+", "-");
    sourceLocator.setCandidates([source]);
    mutator.setSites(source, [site]);
    const spec = toAbsolutePath(path.join(tempDir, "test/a.test.ts"));
    testRunner.setAllSpecs([spec]);
    testRunner.setStaticImports({ [spec]: [source] });
    testRunner.baselineResult = { ok: true };
    testRunner.relatedResult = { kind: "passed" };

    const useCase = new RunMutationSessionUseCase({
      mutator,
      testRunner,
      sourceLocator,
      files,
      report,
    });

    await useCase.execute({
      cwd: tempDir,
      htmlPath: path.join(tempDir, "r.html"),
      jsonPath: path.join(tempDir, "r.json"),
      sarifPath: path.join(tempDir, "r.sarif"),
    });

    await fs.access(path.join(tempDir, "r.html"));
    await fs.access(path.join(tempDir, "r.json"));
    await fs.access(path.join(tempDir, "r.sarif"));
    expect(out.text()).toContain("── Summary ──");
  });
});
