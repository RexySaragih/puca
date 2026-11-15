export interface ParsedCliArgs {
  readonly mutateGlob?: string;
  readonly jsonPath?: string;
  readonly timeoutMs?: number;
  readonly includeUntracked: boolean;
  readonly verbose: boolean;
  /** Parallel scoring workers. Omit → 1 (Phase 1 in-process path). */
  readonly workers: number;
  /** Opt-in CI score gate (1..100). Unset when flag omitted. */
  readonly breakOnScore?: number;
  /** Opt-in: exit 1 when any NoCoverage mutant exists. */
  readonly failOnNoCoverage: boolean;
  /** Opt-in SARIF output path. Unset when flag omitted. */
  readonly sarifPath?: string;
}

/**
 * Parse `puca` flags from argv (without node/script). cwd is always process.cwd() at the CLI.
 * Flags: --mutate, --json, --timeout, --include-untracked, --verbose, --workers,
 * --break-on-score, --fail-on-no-coverage, --sarif.
 */
export function parseArgs(argv: readonly string[]): ParsedCliArgs {
  let mutateGlob: string | undefined;
  let jsonPath: string | undefined;
  let timeoutMs: number | undefined;
  let includeUntracked = false;
  let verbose = false;
  let workers = 1;
  let breakOnScore: number | undefined;
  let failOnNoCoverage = false;
  let sarifPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      break;
    }

    if (token === "--mutate") {
      mutateGlob = requireValue(argv, i, "--mutate");
      i += 1;
      continue;
    }
    if (token === "--json") {
      jsonPath = requireValue(argv, i, "--json");
      i += 1;
      continue;
    }
    if (token === "--timeout") {
      const raw = requireValue(argv, i, "--timeout");
      timeoutMs = parseTimeoutMs(raw);
      i += 1;
      continue;
    }
    if (token === "--workers") {
      const raw = requireValue(argv, i, "--workers");
      workers = parseWorkers(raw);
      i += 1;
      continue;
    }
    if (token === "--break-on-score") {
      const raw = requireOptionalValue(argv, i, "--break-on-score");
      breakOnScore = parseBreakOnScore(raw);
      i += 1;
      continue;
    }
    if (token === "--sarif") {
      const raw = requireOptionalValue(argv, i, "--sarif");
      sarifPath = parseSarifPath(raw);
      i += 1;
      continue;
    }
    if (token === "--fail-on-no-coverage") {
      failOnNoCoverage = true;
      continue;
    }
    if (token === "--include-untracked") {
      includeUntracked = true;
      continue;
    }
    if (token === "--verbose") {
      verbose = true;
      continue;
    }
    if (token.startsWith("--mutate=")) {
      mutateGlob = token.slice("--mutate=".length);
      continue;
    }
    if (token.startsWith("--json=")) {
      jsonPath = token.slice("--json=".length);
      continue;
    }
    if (token.startsWith("--timeout=")) {
      timeoutMs = parseTimeoutMs(token.slice("--timeout=".length));
      continue;
    }
    if (token.startsWith("--workers=")) {
      workers = parseWorkers(token.slice("--workers=".length));
      continue;
    }
    if (token.startsWith("--break-on-score=")) {
      breakOnScore = parseBreakOnScore(token.slice("--break-on-score=".length));
      continue;
    }
    if (token.startsWith("--sarif=")) {
      sarifPath = parseSarifPath(token.slice("--sarif=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return {
    mutateGlob,
    jsonPath,
    timeoutMs,
    includeUntracked,
    verbose,
    workers,
    breakOnScore,
    failOnNoCoverage,
    sarifPath,
  };
}

function requireValue(
  argv: readonly string[],
  flagIndex: number,
  flag: string,
): string {
  const value = argv[flagIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

/** Like requireValue but returns "" when missing so gate flags can emit UX-005 diagnostics. */
function requireOptionalValue(
  argv: readonly string[],
  flagIndex: number,
  _flag: string,
): string {
  const value = argv[flagIndex + 1];
  if (value === undefined || value.startsWith("--")) {
    return "";
  }
  return value;
}

function parseTimeoutMs(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`Invalid --timeout value: ${raw}`);
  }
  return parsed;
}

/** Integer >= 1. Missing/0/float/non-numeric → refuse (mentions --workers). */
export function parseWorkers(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --workers value: ${raw}`);
  }
  return parsed;
}

/** Integer 1..100 inclusive (REQ-1402 / UX-005). */
export function parseBreakOnScore(raw: string): number {
  const parsed = Number(raw);
  if (
    raw.trim() === "" ||
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > 100
  ) {
    const received = raw.trim() === "" ? "" : raw;
    throw new Error(
      `Error: Invalid value for --break-on-score. Expected integer between 1 and 100, received '${received}'.`,
    );
  }
  return parsed;
}

/** Non-empty path (REQ-1403 / UX-005). */
export function parseSarifPath(raw: string): string {
  if (raw.trim() === "") {
    throw new Error(
      "Error: Invalid value for --sarif. Expected a valid file path, received empty or missing argument.",
    );
  }
  return raw;
}
