import { createRequire } from "node:module";
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

export { PucaRefuseError };
