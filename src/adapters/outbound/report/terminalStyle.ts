import type { Mutant } from "../../../domain/mutant.js";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const SECTION_RULE_WIDTH = 28;

/**
 * Color when the destination stream is a TTY and NO_COLOR is unset.
 * FORCE_COLOR (any non-empty value other than "0") forces color on.
 */
export function shouldUseColor(
  stream: NodeJS.WritableStream,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR != null) {
    return false;
  }
  if (env.FORCE_COLOR != null && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") {
    return true;
  }
  const tty = stream as NodeJS.WriteStream;
  return typeof tty.isTTY === "boolean" && tty.isTTY;
}

/** Plain status token used in reports (`KILLED`, `SURVIVED`, …). */
export function statusLabel(status: Mutant["status"]): string {
  switch (status) {
    case "Killed":
      return "KILLED";
    case "Survived":
      return "SURVIVED";
    case "Timeout":
      return "TIMEOUT";
    case "RuntimeError":
      return "ERROR";
    case "NoCoverage":
      return "NO_COVERAGE";
  }
}

/** Status word with optional ANSI color for TTY terminals. */
export function coloredStatusLabel(
  status: Mutant["status"],
  colorEnabled: boolean,
): string {
  const label = statusLabel(status);
  if (!colorEnabled) {
    return label;
  }
  return `${statusAnsi(status)}${label}${RESET}`;
}

/**
 * Scan-friendly section rule, e.g. `── Summary ────────────────`.
 * Always plain text (no color) so CI logs stay copy-pasteable.
 */
export function sectionHeading(title: string): string {
  const head = `── ${title} `;
  const pad = Math.max(2, SECTION_RULE_WIDTH - head.length);
  return `${head}${"─".repeat(pad)}`;
}

function statusAnsi(status: Mutant["status"]): string {
  switch (status) {
    case "Killed":
      return GREEN;
    case "Survived":
      return RED;
    case "Timeout":
      return YELLOW;
    case "RuntimeError":
      return RED;
    case "NoCoverage":
      return DIM;
  }
}
