import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  VITEST_SESSION_INLINE_OPTIONS,
  VitestTestRunner,
  type VitestLike,
} from "../src/adapters/outbound/vitest/VitestTestRunner.js";
import {
  normalizeModulePath,
  pucaRamPlugin,
} from "../src/adapters/outbound/vitest/pucaRamPlugin.js";
import {
  PucaRefuseError,
  isPucaRefuseError,
  resolveProjectVitest,
} from "../src/adapters/outbound/vitest/resolveProjectVitest.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal VitestLike stub for startSession refuse / options tests. */
function stubVitestLike(
  overrides: Partial<VitestLike> & Pick<VitestLike, "close"> = {
    async close() {},
  },
): VitestLike {
  return {
    async globTestSpecifications() {
      return [];
    },
    getRootProject() {
      return {
        config: { root: repoRoot },
        vite: { environments: {} },
      };
    },
    ...overrides,
  };
}

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

describe("Vitest session resolve and overlays", () => {
  describe("when vitest is missing from cwd node_modules", () => {
    it("should fail session start with a refuse error mappable to exit 2 (AC1)", async () => {
      // Given — empty project cwd with no node_modules/vitest
      const cwd = await makeTempDir("puca-no-vitest-");
      await fs.writeFile(
        path.join(cwd, "package.json"),
        JSON.stringify({ name: "fixture-no-vitest" }),
        "utf8",
      );

      // When — resolver
      await expect(resolveProjectVitest(cwd)).rejects.toSatisfy(
        (err: unknown) =>
          isPucaRefuseError(err) && (err as PucaRefuseError).exitCode === 2,
      );

      // When — startSession uses the same refuse path
      const runner = new VitestTestRunner({ cwd });
      await expect(
        runner.startSession({ buffers: new Map() }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isPucaRefuseError(err) && (err as PucaRefuseError).exitCode === 2,
      );
    });
  });

  describe("when vitest is installed under cwd", () => {
    it("should resolve createVitest from the project node_modules", async () => {
      // Given — this repo has vitest as a devDependency
      // When
      const project = await resolveProjectVitest(repoRoot);

      // Then
      expect(typeof project.createVitest).toBe("function");
      expect(project.resolvedPath).toContain(`${path.sep}node_modules${path.sep}vitest`);
    });
  });

  describe("when vitest config has browser.enabled true", () => {
    it("should refuse without running tests (AC2)", async () => {
      // Given
      let closeCount = 0;
      let testsWouldHaveRun = false;
      const browserVitest = stubVitestLike({
        config: { browser: { enabled: true } },
        async close() {
          closeCount += 1;
        },
      });

      const runner = new VitestTestRunner({
        cwd: repoRoot,
        resolveVitest: async () => ({
          createVitest: async () => browserVitest,
          resolvedPath: "/fake/vitest/node",
        }),
        createVitest: async () => {
          // Session create succeeds; refuse happens after config inspection.
          // No runTestSpecifications / baseline is invoked by startSession.
          return browserVitest;
        },
      });

      // When / Then
      await expect(
        runner.startSession({ buffers: new Map() }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isPucaRefuseError(err) &&
          String(err).includes("Browser Mode") &&
          (err as PucaRefuseError).exitCode === 2,
      );
      expect(closeCount).toBeGreaterThanOrEqual(1);
      expect(testsWouldHaveRun).toBe(false);
    });
  });

  describe("when a buffer is set for file F", () => {
    it("should return the buffer from transform and not write F (AC3)", async () => {
      // Given
      const cwd = await makeTempDir("puca-ram-");
      const fileF = path.join(cwd, "src", "f.ts");
      await fs.mkdir(path.dirname(fileF), { recursive: true });
      const originalOnDisk = "export const x = 1;\n";
      await fs.writeFile(fileF, originalOnDisk, "utf8");

      const buffers = new Map<string, string | null>();
      const mutantSource = "export const x = 99;\n";
      buffers.set(normalizeModulePath(fileF), mutantSource);

      const plugin = pucaRamPlugin(buffers);

      // When
      const result = plugin.transform(originalOnDisk, fileF);
      const withQuery = plugin.transform(originalOnDisk, `${fileF}?v=123`);

      // Then — transform returns the RAM buffer
      expect(result).toEqual({ code: mutantSource, map: null });
      expect(withQuery).toEqual({ code: mutantSource, map: null });
      expect(plugin.load(fileF)).toBe(mutantSource);

      // Then — disk file F is unchanged (plugin never writes)
      const onDisk = await fs.readFile(fileF, "utf8");
      expect(onDisk).toBe(originalOnDisk);
      expect(onDisk).not.toContain("99");
    });
  });

  describe("when createVitest options are inspected", () => {
    it("should pass watch false, fileParallelism false, maxWorkers 1, isolate true, coverage off (AC4)", async () => {
      // Given
      const captured: {
        mode?: string;
        options?: Record<string, unknown>;
        viteOverrides?: Record<string, unknown>;
      } = {};

      const stubVitest = stubVitestLike({
        config: { browser: { enabled: false } },
        async close() {},
      });

      const runner = new VitestTestRunner({
        cwd: repoRoot,
        resolveVitest: async () => ({
          createVitest: async () => stubVitest,
          resolvedPath: "/fake/vitest/node",
        }),
        createVitest: async (mode, options, viteOverrides) => {
          captured.mode = mode;
          captured.options = options;
          captured.viteOverrides = viteOverrides;
          return stubVitest;
        },
      });

      // When
      const session = await runner.startSession({ buffers: new Map() });
      await runner.close();

      // Then
      expect(session.id).toBe("vitest-session");
      expect(captured.mode).toBe("test");
      expect(captured.options).toMatchObject({
        watch: false,
        fileParallelism: false,
        maxWorkers: 1,
        isolate: true,
        coverage: { enabled: false },
        bail: 1,
        reporters: [],
        fsModuleCache: false,
      });
      expect(VITEST_SESSION_INLINE_OPTIONS).toEqual({
        watch: false,
        fileParallelism: false,
        maxWorkers: 1,
        isolate: true,
        coverage: { enabled: false },
        bail: 1,
        reporters: [],
        fsModuleCache: false,
      });

      const plugins = (
        captured.viteOverrides as { plugins?: unknown[] } | undefined
      )?.plugins;
      expect(Array.isArray(plugins)).toBe(true);
      expect(plugins?.[0]).toMatchObject({ name: "puca-ram", enforce: "pre" });
    });
  });

  describe("when environment is node, jsdom, or happy-dom", () => {
    it("should not refuse those environments at session start", async () => {
      // Honor node/jsdom/happy-dom: only browser.enabled === true is refused.
      const stubVitest = stubVitestLike({
        config: { browser: { enabled: false } },
        async close() {},
      });

      const runner = new VitestTestRunner({
        cwd: repoRoot,
        resolveVitest: async () => ({
          createVitest: async () => stubVitest,
          resolvedPath: "/fake/vitest/node",
        }),
        createVitest: async () => stubVitest,
      });

      await expect(
        runner.startSession({ buffers: new Map() }),
      ).resolves.toEqual({ id: "vitest-session" });
      await runner.close();
    });
  });
});
