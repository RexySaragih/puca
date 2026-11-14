import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeWorkspaceFiles } from "../src/adapters/outbound/fs/NodeWorkspaceFiles.js";

describe("NodeWorkspaceFiles", () => {
  let tempDir: string;
  let files: NodeWorkspaceFiles;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-ws-"));
    files = new NodeWorkspaceFiles(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("when a UTF-8 file exists under cwd", () => {
    it("should report exists true and readUtf8 matching disk", async () => {
      // Given
      const target = path.join(tempDir, "sample.txt");
      const contents = "púca café — UTF-8 ✓";
      await fs.writeFile(target, contents, "utf8");

      // When / Then
      expect(files.isUnderCwd(target)).toBe(true);
      expect(await files.exists(target)).toBe(true);
      expect(await files.readUtf8(target)).toBe(contents);
    });
  });

  describe("when a resolved path lies outside cwd", () => {
    it("should return isUnderCwd false and refuse readUtf8 without reading", async () => {
      // Given — sibling directory outside the workspace cwd
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-out-"));
      const outsideFile = path.join(outsideDir, "secret.txt");
      await fs.writeFile(outsideFile, "should-not-be-read", "utf8");

      try {
        // When / Then
        expect(files.isUnderCwd(outsideFile)).toBe(false);
        expect(await files.exists(outsideFile)).toBe(false);
        await expect(files.readUtf8(outsideFile)).rejects.toThrow(
          /outside cwd/i,
        );

        // Traversal via .. from inside cwd must also refuse
        const traversal = path.join(tempDir, "..", path.basename(outsideDir), "secret.txt");
        const resolvedOutside = path.resolve(traversal);
        expect(resolvedOutside).toBe(path.resolve(outsideFile));
        expect(files.isUnderCwd(traversal)).toBe(false);
        await expect(files.readUtf8(traversal)).rejects.toThrow(/outside cwd/i);
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });
});
