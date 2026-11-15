import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveJestTestTimeoutMs } from "../src/adapters/outbound/jest/resolveProjectJest.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const jestLoopNodeModules = path.resolve(
  here,
  "../fixtures/jest-loop/node_modules",
);

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir != null) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-jest-timeout-"));
  tempDirs.push(dir);
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "tmp-jest-timeout", private: true }),
    "utf8",
  );
  await fs.symlink(jestLoopNodeModules, path.join(dir, "node_modules"), "dir");
  return dir;
}

describe("resolveJestTestTimeoutMs (R4-L4 / R4-H1)", () => {
  describe("when package.json jest.testTimeout is set", () => {
    it("should return that integer", async () => {
      // Given
      const cwd = await makeTempProject();
      await fs.writeFile(
        path.join(cwd, "package.json"),
        JSON.stringify({
          name: "tmp",
          private: true,
          jest: { testTimeout: 3333 },
        }),
        "utf8",
      );

      // When / Then
      expect(await resolveJestTestTimeoutMs(cwd)).toBe(3333);
    });
  });

  describe("when jest.config.json sets testTimeout", () => {
    it("should return that integer", async () => {
      // Given
      const cwd = await makeTempProject();
      await fs.writeFile(
        path.join(cwd, "jest.config.json"),
        JSON.stringify({ testTimeout: 2222, testEnvironment: "node" }),
        "utf8",
      );

      // When / Then
      expect(await resolveJestTestTimeoutMs(cwd)).toBe(2222);
    });
  });

  describe("when jest.config.js sets testTimeout via project jest-config", () => {
    it("should return that integer without adding jest-config to puca deps", async () => {
      // Given — only JS config (no package.json jest block / no .json)
      const cwd = await makeTempProject();
      await fs.writeFile(
        path.join(cwd, "jest.config.js"),
        'module.exports = { testTimeout: 4321, testEnvironment: "node" };\n',
        "utf8",
      );

      // When
      const timeout = await resolveJestTestTimeoutMs(cwd);

      // Then
      expect(timeout).toBe(4321);
    });
  });

  describe("when no timeout is configured", () => {
    it("should return undefined so the runner uses its default", async () => {
      // Given — package.json only (no jest.config.*)
      const cwd = await makeTempProject();

      // When / Then
      expect(await resolveJestTestTimeoutMs(cwd)).toBeUndefined();
    });
  });
});
