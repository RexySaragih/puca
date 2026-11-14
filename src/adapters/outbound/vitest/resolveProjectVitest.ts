import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Refuse errors map to CLI exit 2 (SC-114 / ADR-011).
 * Thrown when Vitest cannot be resolved or Browser Mode is enabled.
 */
export class PucaRefuseError extends Error {
  readonly exitCode = 2 as const;

  constructor(message: string) {
    super(message);
    this.name = "PucaRefuseError";
  }
}

export function isPucaRefuseError(error: unknown): error is PucaRefuseError {
  return error instanceof PucaRefuseError;
}

/** Minimal surface Púca needs from `vitest/node` (createVitest). */
export type CreateVitestFn = (
  mode: "test" | "benchmark",
  options: Record<string, unknown>,
  viteOverrides?: Record<string, unknown>,
) => Promise<unknown>;

export interface ProjectVitest {
  readonly createVitest: CreateVitestFn;
  readonly resolvedPath: string;
}

/**
 * Resolve `vitest/node` from the *user project's* cwd node_modules
 * (not from Púca's own package). Missing → refuse (exit 2).
 */
export async function resolveProjectVitest(cwd: string): Promise<ProjectVitest> {
  const requireFromCwd = createRequire(path.join(cwd, "package.json"));
  let resolvedPath: string;
  try {
    resolvedPath = requireFromCwd.resolve("vitest/node");
  } catch {
    throw new PucaRefuseError(
      `Vitest not found under ${path.join(cwd, "node_modules")}. Install vitest in the project to run Púca.`,
    );
  }

  const mod = (await import(pathToFileURL(resolvedPath).href)) as {
    createVitest?: CreateVitestFn;
  };

  if (typeof mod.createVitest !== "function") {
    throw new PucaRefuseError(
      `Resolved vitest/node at ${resolvedPath} is missing createVitest`,
    );
  }

  return { createVitest: mod.createVitest, resolvedPath };
}
