import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bindingCandidatePaths,
  hostPlatformAbi,
  loadPucaBinding,
  NapiMutatorEngine,
  utf8ByteSlice,
} from "../src/adapters/outbound/napi/NapiMutatorEngine.js";
import { toAbsolutePath } from "../src/domain/mutant.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);

describe("NapiMutatorEngine", () => {
  describe("when the host addon is built", () => {
    it("should load the .node on the host platform", () => {
      // Given / When
      const abi = hostPlatformAbi();
      const candidates = bindingCandidatePaths(repoRoot, abi);
      const found = candidates.find((candidate) => {
        try {
          require("node:fs").accessSync(candidate);
          return true;
        } catch {
          return false;
        }
      });

      // Then — AC2
      expect(found, `expected addon among ${candidates.join(", ")}`).toBeDefined();
      const binding = loadPucaBinding(repoRoot);
      expect(typeof binding.discover).toBe("function");
      expect(typeof binding.apply).toBe("function");
      const loaded = require(found!) as Record<string, unknown>;
      expect(loaded.discover).toBeTypeOf("function");
      expect(loaded.apply).toBeTypeOf("function");
    });
  });

  describe("when source contains a + b", () => {
    it("should discover then apply an arithmetic replacement without writing a path", async () => {
      // Given
      const engine = new NapiMutatorEngine(loadPucaBinding(repoRoot));
      const source = "export const v = a + b;\n";
      const file = toAbsolutePath(path.join(repoRoot, "snippet.ts"));

      // When
      const found = await engine.discover(file, source);
      const sites = found.sites;
      const plusToMinus = sites.find(
        (site) =>
          site.mutatorName === "ArithmeticOperator" &&
          site.replacement === "-" &&
          site.original === "+",
      );
      expect(plusToMinus).toBeDefined();
      const mutated = await engine.apply(source, plusToMinus!);

      // Then — AC1
      expect(mutated).toContain("a - b");
      expect(mutated).not.toContain("a + b");
      expect(source).toContain("a + b");
      expect(plusToMinus!.id).toBe(
        `${file}:${plusToMinus!.startOffset}:ArithmeticOperator:-`,
      );

      const fs = await import("node:fs/promises");
      await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  describe("when source is toggleLabel's outer ternary", () => {
    it("should replace only the predicate, not the whole ConditionalExpression", async () => {
      const engine = new NapiMutatorEngine(loadPucaBinding(repoRoot));
      const source =
        'export function toggleLabel(on: boolean): string {\n  return on ? "on" : "off";\n}\n';
      const file = toAbsolutePath(path.join(repoRoot, "flagMatrix.ts"));

      const found = await engine.discover(file, source);
      const conditional = found.sites.filter(
        (site) => site.mutatorName === "ConditionalExpression",
      );

      expect(conditional).toHaveLength(2);
      expect(conditional.map((site) => site.replacement).sort()).toEqual([
        "false",
        "true",
      ]);
      for (const site of conditional) {
        expect(utf8ByteSlice(source, site.startOffset, site.endOffset)).toBe(
          "on",
        );
        expect(site.original).toBe("on");
        const applied = await engine.apply(source, site);
        expect(applied).toContain(`return ${site.replacement} ? "on" : "off"`);
        expect(applied).not.toContain(`return ${site.replacement};`);
      }
    });
  });

  describe("when source has a multi-byte UTF-8 character before a site", () => {
    it("should keep site.original aligned to UTF-8 byte offsets", async () => {
      const engine = new NapiMutatorEngine(loadPucaBinding(repoRoot));
      const source =
        "/** Hang — note em dash */\nexport function hang(enabled: boolean): void {\n  while (enabled) {}\n}\n";
      const file = toAbsolutePath(path.join(repoRoot, "hang-utf8.ts"));

      const found = await engine.discover(file, source);
      const hangSites = found.sites.filter(
        (site) =>
          site.mutatorName === "ConditionalExpression" &&
          site.line === 3,
      );

      expect(hangSites.length).toBeGreaterThanOrEqual(2);
      for (const site of hangSites) {
        expect(site.original).toBe("enabled");
        expect(
          utf8ByteSlice(source, site.startOffset, site.endOffset),
        ).toBe("enabled");
      }
    });
  });

  describe("when the native addon is missing", () => {
    it("should throw a clone/build error instead of a raw MODULE_NOT_FOUND", () => {
      expect(() => loadPucaBinding(path.join(repoRoot, "tmp-missing-napi"))).toThrow(
        /Native Púca addon \(\.node\) is missing after clone or install/,
      );
      expect(() => loadPucaBinding(path.join(repoRoot, "tmp-missing-napi"))).toThrow(
        /npm run build/,
      );
    });
  });
});
