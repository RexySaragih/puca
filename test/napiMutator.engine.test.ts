import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindingCandidatePaths,
  formatMissingBindingMessage,
  hostPlatformAbi,
  loadPucaBinding,
  NapiMutatorEngine,
  utf8ByteSlice,
} from "../src/adapters/outbound/napi/NapiMutatorEngine.js";
import { toAbsolutePath } from "../src/domain/mutant.js";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir != null) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("NapiMutatorEngine", () => {
  describe("when the host addon is built", () => {
    it("should load the .node on the host platform (AC2)", () => {
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

      expect(found, `expected addon among ${candidates.join(", ")}`).toBeDefined();
      const binding = loadPucaBinding(repoRoot);
      expect(typeof binding.discover).toBe("function");
      expect(typeof binding.apply).toBe("function");
    });
  });

  describe("when only the crates path .node exists (AC3)", () => {
    it("should load the crates file when package-root .node is absent", async () => {
      const abi = hostPlatformAbi();
      const cratesSource = path.join(
        repoRoot,
        "crates",
        "puca-binding",
        `puca-binding.${abi}.node`,
      );
      await fs.access(cratesSource);

      const tmp = await makeTempDir("puca-crates-only-");
      await fs.writeFile(
        path.join(tmp, "package.json"),
        JSON.stringify({ name: "puca-crates-only", type: "module" }),
        "utf8",
      );
      await fs.mkdir(path.join(tmp, "crates", "puca-binding"), {
        recursive: true,
      });
      await fs.copyFile(
        cratesSource,
        path.join(tmp, "crates", "puca-binding", `puca-binding.${abi}.node`),
      );

      const binding = loadPucaBinding(tmp);
      expect(typeof binding.discover).toBe("function");
      expect(typeof binding.apply).toBe("function");
    });
  });

  describe("when puca-<abi> is installed under the same root (AC4)", () => {
    it("should load via createRequire(root/package.json)", async () => {
      const abi = hostPlatformAbi();
      const tmp = await makeTempDir("puca-optional-stub-");
      await fs.writeFile(
        path.join(tmp, "package.json"),
        JSON.stringify({ name: "puca-optional-host", type: "module" }),
        "utf8",
      );
      const stubDir = path.join(tmp, "node_modules", `puca-${abi}`);
      await fs.mkdir(stubDir, { recursive: true });
      await fs.writeFile(
        path.join(stubDir, "package.json"),
        JSON.stringify({
          name: `puca-${abi}`,
          version: "0.0.0-test",
          main: "index.js",
        }),
        "utf8",
      );
      const stubMarker = `stub-from-${path.basename(tmp)}`;
      await fs.writeFile(
        path.join(stubDir, "index.js"),
        `module.exports = { discover() { return ${JSON.stringify(stubMarker)}; }, apply() { return ${JSON.stringify(stubMarker)}; } };\n`,
        "utf8",
      );

      const binding = loadPucaBinding(tmp);
      expect(binding.discover("x.ts", "a + b")).toBe(stubMarker);
      expect(binding.apply("a + b", {} as never)).toBe(stubMarker);
    });
  });

  describe("when no .node and no puca-<abi> (AC1)", () => {
    it("should throw UX-003 including abi, package name, and npm run build", async () => {
      const abi = hostPlatformAbi();
      const tmp = await makeTempDir("puca-missing-napi-");
      await fs.writeFile(
        path.join(tmp, "package.json"),
        JSON.stringify({ name: "puca-missing", type: "module" }),
        "utf8",
      );

      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("process.exit must not be called");
      }) as never);

      expect(() => loadPucaBinding(tmp)).toThrow(formatMissingBindingMessage(abi));
      expect(() => loadPucaBinding(tmp)).toThrow(new RegExp(`puca-${abi}`));
      expect(() => loadPucaBinding(tmp)).toThrow(/npm run build/);
      expect(exitSpy).not.toHaveBeenCalled();
      exitSpy.mockRestore();
    });
  });

  describe("when root has no package.json (AC7)", () => {
    it("should throw UX-003 without falling back to import.meta.url", async () => {
      const abi = hostPlatformAbi();
      const tmp = await makeTempDir("puca-no-pkgjson-");

      expect(() => loadPucaBinding(tmp)).toThrow(formatMissingBindingMessage(abi));
    });
  });

  describe("when source contains a + b", () => {
    it("should discover then apply an arithmetic replacement without writing a path", async () => {
      const engine = new NapiMutatorEngine(loadPucaBinding(repoRoot));
      const source = "export const v = a + b;\n";
      const file = toAbsolutePath(path.join(repoRoot, "snippet.ts"));

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

      expect(mutated).toContain("a - b");
      expect(mutated).not.toContain("a + b");
      expect(source).toContain("a + b");
      expect(plusToMinus!.id).toBe(
        `${file}:${plusToMinus!.startOffset}:ArithmeticOperator:-`,
      );

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

  describe("when NapiMutatorEngine.ts is scanned (AC6)", () => {
    it("should omit worker_threads and process.exit and musl branches", async () => {
      const source = await fs.readFile(
        path.join(repoRoot, "src/adapters/outbound/napi/NapiMutatorEngine.ts"),
        "utf8",
      );
      expect(source).not.toMatch(/\bworker_threads\b/);
      expect(source).not.toMatch(/process\.exit/);
      expect(source).not.toMatch(/\bmusl\b/);
      expect(hostPlatformAbi()).not.toMatch(/musl/);
    });
  });
});
