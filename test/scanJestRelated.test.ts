import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RELATED_IMPORT_HOP_CAP,
  scanJestRelated,
} from "../src/adapters/outbound/jest/scanJestRelated.js";
import { normalizeModulePath } from "../src/adapters/outbound/vitest/pucaRamPlugin.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir != null) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeCwd(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-jest-scan-"));
  tempDirs.push(dir);
  return dir;
}

async function write(
  cwd: string,
  relative: string,
  contents: string,
): Promise<string> {
  const full = path.join(cwd, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents, "utf8");
  return normalizeModulePath(full);
}

describe("Jest related-map static scan", () => {
  it("should honor package.json testMatch instead of hardcoded dirs", async () => {
    const cwd = await makeCwd();
    await write(
      cwd,
      "package.json",
      JSON.stringify({
        name: "scan-match",
        jest: { testMatch: ["**/specs/**/*.spec.js"] },
      }),
    );
    const source = await write(cwd, "lib/math.js", "export const n = 1;\n");
    const matched = await write(
      cwd,
      "specs/math.spec.js",
      "const { n } = require('../lib/math');\n",
    );
    await write(
      cwd,
      "test/math.test.js",
      "const { n } = require('../lib/math');\n",
    );

    const scanned = await scanJestRelated(cwd, [source]);
    expect(scanned.allSpecs).toEqual([matched]);
    expect(scanned.relatedBySource.get(source)).toEqual([matched]);
  });

  it("should resolve tsconfig paths aliases across re-export hops", async () => {
    const cwd = await makeCwd();
    await write(cwd, "package.json", JSON.stringify({ name: "scan-alias" }));
    await write(
      cwd,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@lib/*": ["src/lib/*"] },
        },
      }),
    );
    const leaf = await write(cwd, "src/lib/leaf.js", "export const v = 1;\n");
    await write(
      cwd,
      "src/lib/barrel.js",
      "export { v } from './leaf.js';\n",
    );
    const spec = await write(
      cwd,
      "test/leaf.test.js",
      "import { v } from '@lib/barrel';\n",
    );

    const scanned = await scanJestRelated(cwd, [leaf]);
    expect(RELATED_IMPORT_HOP_CAP).toBe(8);
    expect(scanned.relatedBySource.get(leaf)).toEqual([spec]);
  });
});
