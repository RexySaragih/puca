import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { InMemorySourceLocator } from "../src/adapters/outbound/memory/InMemorySourceLocator.js";
import { createRuntime } from "../src/composition/createRuntime.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

describe("RunMutationSession (memory adapters)", () => {
  describe("when source locator returns no candidates", () => {
    it("should return exitCode 0 without loading vitest as a product dependency", async () => {
      // Given
      const runtime = createRuntime({ useFakes: true, cwd: repoRoot });
      expect(runtime.sourceLocator).toBeInstanceOf(InMemorySourceLocator);
      (runtime.sourceLocator as InMemorySourceLocator).setCandidates([]);

      // When
      const result = await runtime.runMutationSession.execute({ cwd: repoRoot });

      // Then
      expect(result.exitCode).toBe(0);
      expect(result.statuses).toEqual([]);

      // Product path must not pull vitest into domain/application resolution.
      // Vitest here is only the test runner (this file), not a use-case import.
      const domainPkg = path.join(repoRoot, "src/domain/mutant.ts");
      const appUseCase = path.join(
        repoRoot,
        "src/application/use-cases/RunMutationSessionUseCase.ts",
      );
      for (const file of [domainPkg, appUseCase]) {
        const source = await import("node:fs/promises").then((fs) =>
          fs.readFile(file, "utf8"),
        );
        expect(source).not.toMatch(/from ['"]vitest['"]/);
        expect(source).not.toMatch(/from ['"]vite['"]/);
      }

      // Ensure resolve of the composition fake path does not require the vitest package
      // as a runtime dependency of the inbound port (devDependency-only is fine).
      const pkg = require("../package.json") as {
        dependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.vitest).toBeUndefined();
    });
  });

  describe("when CLI public entry is inspected", () => {
    it("should not re-export TestRunnerPort (unexported seam)", async () => {
      // Given
      const fs = await import("node:fs/promises");
      const cliSource = await fs.readFile(
        path.join(repoRoot, "src/cli.ts"),
        "utf8",
      );

      // Then — CLI remains a process entry, not a barrel that leaks TestRunnerPort
      expect(cliSource).not.toMatch(/TestRunnerPort/);
      expect(cliSource).not.toMatch(/\bexport\s+\{/);
      expect(cliSource).not.toMatch(/\bexport\s+\*/);
    });
  });
});
