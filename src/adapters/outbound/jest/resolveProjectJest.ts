import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { PucaRefuseError } from "../vitest/resolveProjectVitest.js";

/** Minimal surface Púca needs from the project’s `jest` package. */
export interface JestRunCliResult {
  readonly results: {
    readonly success: boolean;
    readonly numFailedTests: number;
    readonly numPassedTests: number;
    readonly numPendingTests: number;
    readonly numTotalTests: number;
    readonly testResults: readonly {
      readonly testFilePath: string;
      readonly testResults: readonly {
        readonly fullName: string;
        readonly status: string;
        readonly failureMessages: readonly string[];
      }[];
      readonly failureMessage?: string | null;
    }[];
  };
}

export type JestRunCli = (
  argv: Record<string, unknown>,
  projects: string[],
) => Promise<JestRunCliResult>;

export interface ProjectJest {
  readonly runCLI: JestRunCli;
  readonly resolvedPath: string;
}

/**
 * Resolve `jest` from the *user project's* cwd node_modules
 * (not from Púca's own package). Missing → refuse (exit 2).
 */
export function resolveProjectJest(cwd: string): ProjectJest {
  const requireFromCwd = createRequire(path.join(cwd, "package.json"));
  let resolvedPath: string;
  try {
    resolvedPath = requireFromCwd.resolve("jest");
  } catch {
    throw new PucaRefuseError(
      `Jest not found under ${path.join(cwd, "node_modules")}. Install jest in the project to run Púca with --runner jest.`,
    );
  }

  const mod = requireFromCwd(resolvedPath) as {
    runCLI?: JestRunCli;
  };

  if (typeof mod.runCLI !== "function") {
    throw new PucaRefuseError(
      `Resolved jest at ${resolvedPath} is missing runCLI`,
    );
  }

  return { runCLI: mod.runCLI, resolvedPath };
}

/**
 * Read project Jest `testTimeout` (R4-L4 / R4-H1).
 * Order: package.json `jest` → jest.config.json → optional `jest-config` from
 * the project cwd (supports jest.config.js/ts/mjs when Jest is installed).
 * Missing / unreadable → undefined (caller uses default).
 */
export async function resolveJestTestTimeoutMs(
  cwd: string,
): Promise<number | undefined> {
  const fromPackage = readTimeoutFromPackageJson(cwd);
  if (fromPackage != null) {
    return fromPackage;
  }
  const fromJson = readTimeoutFromJestConfigJson(cwd);
  if (fromJson != null) {
    return fromJson;
  }
  return readTimeoutViaProjectJestConfig(cwd);
}

function readTimeoutFromPackageJson(cwd: string): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { jest?: { testTimeout?: unknown } };
    return asPositiveInt(pkg.jest?.testTimeout);
  } catch {
    return undefined;
  }
}

function readTimeoutFromJestConfigJson(cwd: string): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(cwd, "jest.config.json"), "utf8");
    const cfg = JSON.parse(raw) as { testTimeout?: unknown };
    return asPositiveInt(cfg.testTimeout);
  } catch {
    return undefined;
  }
}

/**
 * Use the consumer project's `jest-config` (transitive via jest) to load
 * jest.config.js / .ts / .mjs. Never a Púca dependency — fail soft if absent.
 */
async function readTimeoutViaProjectJestConfig(
  cwd: string,
): Promise<number | undefined> {
  try {
    const requireFromCwd = createRequire(path.join(cwd, "package.json"));
    const mod = requireFromCwd("jest-config") as {
      readConfig?: (
        argv: Record<string, unknown>,
        packageRootOrConfig: string,
      ) => Promise<{
        globalConfig?: { testTimeout?: unknown };
        projectConfig?: { testTimeout?: unknown };
      }>;
    };
    if (typeof mod.readConfig !== "function") {
      return undefined;
    }
    const result = await mod.readConfig({}, cwd);
    // Jest 29 puts testTimeout on globalConfig (not projectConfig).
    return (
      asPositiveInt(result.globalConfig?.testTimeout) ??
      asPositiveInt(result.projectConfig?.testTimeout)
    );
  } catch {
    return undefined;
  }
}

function asPositiveInt(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    return undefined;
  }
  return value;
}

export { PucaRefuseError };
