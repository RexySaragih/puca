import path from "node:path";
import type { Mutant, MutantStatus } from "../../../domain/mutant.js";

export interface FileSummaryRow {
  readonly file: string;
  readonly total: number;
  readonly killed: number;
  readonly survived: number;
  readonly timeout: number;
  readonly noCoverage: number;
  readonly error: number;
  /** Informational Kill% token (`75%` or `-`); never drives exit codes. */
  readonly killPercent: string;
}

/**
 * Aggregate mutant statuses into a File Summary table (UX-004 / ADR-030).
 * Rows are cwd-relative POSIX paths, sorted ascending; Kill% is presentation-only.
 */
export function formatFileSummaryTable(
  statuses: readonly Mutant[],
  cwd: string,
): string {
  const rows = aggregateFileSummaryRows(statuses, cwd);
  if (rows.length === 0) {
    return "";
  }

  const header = [
    "File",
    "Total",
    "Killed",
    "Survived",
    "Timeout",
    "NoCov",
    "Error",
    "Kill%",
  ];
  const body = rows.map((row) => [
    row.file,
    String(row.total),
    String(row.killed),
    String(row.survived),
    String(row.timeout),
    String(row.noCoverage),
    String(row.error),
    row.killPercent,
  ]);
  const widths = header.map((label, index) => {
    let max = label.length;
    for (const cells of body) {
      max = Math.max(max, cells[index]!.length);
    }
    return max;
  });

  const lines = [
    "",
    "── File Summary ──",
    formatAlignedRow(header, widths, false),
    ...body.map((cells) => formatAlignedRow(cells, widths, true)),
  ];
  return lines.join("\n");
}

export function aggregateFileSummaryRows(
  statuses: readonly Mutant[],
  cwd: string,
): FileSummaryRow[] {
  const byFile = new Map<
    string,
    {
      total: number;
      killed: number;
      survived: number;
      timeout: number;
      noCoverage: number;
      error: number;
    }
  >();

  for (const mutant of statuses) {
    const file = relativePath(cwd, mutant.site.file);
    let bucket = byFile.get(file);
    if (bucket == null) {
      bucket = {
        total: 0,
        killed: 0,
        survived: 0,
        timeout: 0,
        noCoverage: 0,
        error: 0,
      };
      byFile.set(file, bucket);
    }
    bucket.total += 1;
    bumpStatus(bucket, mutant.status);
  }

  const rows: FileSummaryRow[] = [...byFile.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([file, counts]) => ({
      file,
      total: counts.total,
      killed: counts.killed,
      survived: counts.survived,
      timeout: counts.timeout,
      noCoverage: counts.noCoverage,
      error: counts.error,
      killPercent: formatKillPercent(counts.killed, counts.survived),
    }));

  return rows;
}

export function formatKillPercent(killed: number, survived: number): string {
  const denom = killed + survived;
  if (denom === 0) {
    return "-";
  }
  return `${String(Math.round((100 * killed) / denom))}%`;
}

function bumpStatus(
  bucket: {
    killed: number;
    survived: number;
    timeout: number;
    noCoverage: number;
    error: number;
  },
  status: MutantStatus,
): void {
  switch (status) {
    case "Killed":
      bucket.killed += 1;
      break;
    case "Survived":
      bucket.survived += 1;
      break;
    case "Timeout":
      bucket.timeout += 1;
      break;
    case "NoCoverage":
      bucket.noCoverage += 1;
      break;
    case "RuntimeError":
      bucket.error += 1;
      break;
  }
}

function relativePath(cwd: string, file: string): string {
  return path.relative(cwd, file).replace(/\\/g, "/") || file;
}

function formatAlignedRow(
  cells: readonly string[],
  widths: readonly number[],
  numericRight: boolean,
): string {
  return cells
    .map((cell, index) => {
      const width = widths[index]!;
      // File column left-aligned; numeric columns right-aligned for scanability.
      if (index === 0 || !numericRight) {
        return cell.padEnd(width, " ");
      }
      return cell.padStart(width, " ");
    })
    .join("  ");
}
