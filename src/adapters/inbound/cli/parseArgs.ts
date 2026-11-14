export interface ParsedCliArgs {
  readonly mutateGlob?: string;
  readonly jsonPath?: string;
  readonly timeoutMs?: number;
  readonly includeUntracked: boolean;
  readonly verbose: boolean;
}

/**
 * Parse `puca` flags from argv (without node/script). cwd is always process.cwd() at the CLI.
 * Flags: --mutate <glob>, --json <path>, --timeout <ms>, --include-untracked, --verbose.
 */
export function parseArgs(argv: readonly string[]): ParsedCliArgs {
  let mutateGlob: string | undefined;
  let jsonPath: string | undefined;
  let timeoutMs: number | undefined;
  let includeUntracked = false;
  let verbose = false;

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

    throw new Error(`Unknown argument: ${token}`);
  }

  return { mutateGlob, jsonPath, timeoutMs, includeUntracked, verbose };
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

function parseTimeoutMs(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(`Invalid --timeout value: ${raw}`);
  }
  return parsed;
}
