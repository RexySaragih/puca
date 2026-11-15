import path from "node:path";
import type {
  BucketCounts,
  MutantProgress,
  ReportPort,
  SessionStartInfo,
} from "../../../application/ports/outbound/ReportPort.js";
import type { Mutant, SessionResult } from "../../../domain/mutant.js";
import { formatFileSummaryTable } from "./formatFileSummaryTable.js";
import { formatMutationLineDiff } from "./formatMutationContext.js";
import { SourceTextCache } from "./sourceTextCache.js";
import {
  coloredStatusLabel,
  sectionHeading,
  shouldUseColor,
} from "./terminalStyle.js";

const DETAIL_STATUSES = new Set(["Survived", "Timeout", "RuntimeError"]);

export interface StdioReportOptions {
  readonly cwd?: string;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  /** Override process.env for color decisions (tests). */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Terminal reporter: realtime mutant lines + five-bucket summary.
 * Survived/Timeout/Error get status + mutator + line-context diff;
 * Killed/NoCoverage stay compact (with a short before→after hint).
 * Status words are colored only when the destination stream is a TTY
 * and NO_COLOR is unset.
 */
export class StdioReport implements ReportPort {
  private readonly cwd: string;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sources = new SourceTextCache();
  private streamedMutants = false;
  private progressDirty = false;

  constructor(options: StdioReportOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.env = options.env ?? process.env;
  }

  writeNotice(line: string): void {
    this.clearProgressLine();
    this.stderr.write(`${line}\n`);
  }

  writeSessionStart(info: SessionStartInfo): void {
    this.clearProgressLine();
    const files = info.fileCount === 1 ? "file" : "files";
    const mutants = info.mutantCount === 1 ? "mutant" : "mutants";
    this.stderr.write(
      `Scoring ${String(info.mutantCount)} ${mutants} across ${String(info.fileCount)} ${files} (timeout ${String(info.timeoutMs)}ms)…\n`,
    );
  }

  writeMutantResult(mutant: Mutant, progress: MutantProgress): void {
    this.streamedMutants = true;
    this.clearProgressLine();

    if (DETAIL_STATUSES.has(mutant.status)) {
      const color = shouldUseColor(this.stdout, this.env);
      this.stdout.write(
        `${formatDetailBlock(mutant, this.cwd, this.sources, color, progress)}\n`,
      );
      return;
    }

    // Compact live progress for Killed / NoCoverage so the run feels alive
    // without flooding Survived-style diff blocks.
    const color = shouldUseColor(this.stderr, this.env);
    const line = formatCompactProgress(
      mutant,
      this.cwd,
      this.sources,
      progress,
      color,
    );
    if (this.isStderrTty()) {
      this.stderr.write(`\r${line}`);
      this.progressDirty = true;
    } else {
      this.stderr.write(`${line}\n`);
    }
  }

  async writeTerminal(result: SessionResult): Promise<void> {
    this.clearProgressLine();

    if (result.message != null && result.message.length > 0) {
      const stream = result.exitCode === 2 ? this.stderr : this.stdout;
      stream.write(`${result.message}\n`);
    }

    const color = shouldUseColor(this.stdout, this.env);

    // Detail lines already streamed live; only dump them when writeTerminal
    // is used alone (tests / idle refuse paths with statuses).
    if (!this.streamedMutants) {
      for (const mutant of result.statuses) {
        if (!DETAIL_STATUSES.has(mutant.status)) {
          continue;
        }
        this.stdout.write(
          `${formatDetailBlock(mutant, this.cwd, this.sources, color)}\n`,
        );
      }
    }

    this.stdout.write(`${formatSummary(result.statuses)}\n`);
    // ADR-030 / SC-325: File Summary only when scored statuses exist.
    if (result.statuses.length >= 1) {
      this.stdout.write(`${formatFileSummaryTable(result.statuses, this.cwd)}\n`);
    }
    if (result.verboseFooter != null && result.verboseFooter.length > 0) {
      this.stderr.write(`${result.verboseFooter}\n`);
    }
    this.streamedMutants = false;
  }

  private isStderrTty(): boolean {
    const stream = this.stderr as NodeJS.WriteStream;
    return typeof stream.isTTY === "boolean" && stream.isTTY;
  }

  private clearProgressLine(): void {
    if (!this.progressDirty) {
      return;
    }
    if (this.isStderrTty()) {
      this.stderr.write("\r\x1b[2K");
    }
    this.progressDirty = false;
  }
}

function formatDetailBlock(
  mutant: Mutant,
  cwd: string,
  sources: SourceTextCache,
  colorEnabled: boolean,
  progress?: MutantProgress,
): string {
  const rel = relativePath(cwd, mutant.site.file);
  const diff = formatMutationLineDiff(sources.get(mutant.site.file), mutant.site);
  const status = coloredStatusLabel(mutant.status, colorEnabled);
  const head = progress != null
    ? `[${String(progress.index)}/${String(progress.total)}] ${status}  ${mutant.site.mutatorName}  ${rel}:${String(mutant.site.line)}:${String(mutant.site.column)}`
    : `${status}  ${mutant.site.mutatorName}  ${rel}:${String(mutant.site.line)}:${String(mutant.site.column)}`;
  return `${head}\n- ${diff.before}\n+ ${diff.after}`;
}

function formatCompactProgress(
  mutant: Mutant,
  cwd: string,
  sources: SourceTextCache,
  progress: MutantProgress,
  colorEnabled: boolean,
): string {
  const rel = relativePath(cwd, mutant.site.file);
  const status = coloredStatusLabel(mutant.status, colorEnabled);
  const buckets = formatBucketShort(progress.counts);
  const loc = `${rel}:${String(mutant.site.line)}:${String(mutant.site.column)}`;
  const diff = formatMutationLineDiff(sources.get(mutant.site.file), mutant.site);
  const hint = compactHint(diff.before, diff.after);
  return `[${String(progress.index)}/${String(progress.total)}] ${status}  ${mutant.site.mutatorName}  ${loc}  ${hint}  ${buckets}`;
}

function compactHint(before: string, after: string): string {
  const max = 36;
  const a = before.length > max ? `${before.slice(0, max)}…` : before;
  const b = after.length > max ? `${after.slice(0, max)}…` : after;
  return `${a} → ${b}`;
}

function formatBucketShort(counts: BucketCounts): string {
  return `K:${String(counts.killed)} S:${String(counts.survived)} T:${String(counts.timeout)} E:${String(counts.error)} NC:${String(counts.noCoverage)}`;
}

function relativePath(cwd: string, file: string): string {
  return path.relative(cwd, file).replace(/\\/g, "/") || file;
}

function formatSummary(statuses: readonly Mutant[]): string {
  const counts = emptyCounts();
  for (const mutant of statuses) {
    bumpCount(counts, mutant.status);
  }

  return [
    "",
    sectionHeading("Summary"),
    `Killed: ${counts.killed}`,
    `Survived: ${counts.survived}`,
    `Timeout: ${counts.timeout}`,
    `Error: ${counts.error}`,
    `No Coverage: ${counts.noCoverage}`,
  ].join("\n");
}

function emptyCounts(): {
  killed: number;
  survived: number;
  timeout: number;
  error: number;
  noCoverage: number;
} {
  return { killed: 0, survived: 0, timeout: 0, error: 0, noCoverage: 0 };
}

function bumpCount(
  counts: {
    killed: number;
    survived: number;
    timeout: number;
    error: number;
    noCoverage: number;
  },
  status: Mutant["status"],
): void {
  switch (status) {
    case "Killed":
      counts.killed += 1;
      break;
    case "Survived":
      counts.survived += 1;
      break;
    case "Timeout":
      counts.timeout += 1;
      break;
    case "RuntimeError":
      counts.error += 1;
      break;
    case "NoCoverage":
      counts.noCoverage += 1;
      break;
  }
}
