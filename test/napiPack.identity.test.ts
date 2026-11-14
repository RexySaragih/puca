import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLATFORM_STUBS = [
  {
    abi: "darwin-arm64",
    name: "puca-darwin-arm64",
    main: "puca-binding.darwin-arm64.node",
    os: ["darwin"],
    cpu: ["arm64"],
    libc: undefined as string[] | undefined,
  },
  {
    abi: "darwin-x64",
    name: "puca-darwin-x64",
    main: "puca-binding.darwin-x64.node",
    os: ["darwin"],
    cpu: ["x64"],
    libc: undefined,
  },
  {
    abi: "linux-x64-gnu",
    name: "puca-linux-x64-gnu",
    main: "puca-binding.linux-x64-gnu.node",
    os: ["linux"],
    cpu: ["x64"],
    libc: ["glibc"],
  },
  {
    abi: "win32-x64-msvc",
    name: "puca-win32-x64-msvc",
    main: "puca-binding.win32-x64-msvc.node",
    os: ["win32"],
    cpu: ["x64"],
    libc: undefined,
  },
] as const;

describe("Packed tarball identity", () => {
  let packDir: string | undefined;
  let rootTarball: string | undefined;

  beforeAll(async () => {
    // dist/ must exist for npm pack to include the JS CLI (CI runs build first).
    await fs.access(path.join(repoRoot, "dist", "cli.js"));
  });

  afterEach(async () => {
    if (packDir != null) {
      await fs.rm(packDir, { recursive: true, force: true });
      packDir = undefined;
      rootTarball = undefined;
    }
  });

  describe("when npm pack runs on the root package (AC1 / SC-305)", () => {
    it("should include schema/ and omit every .node file", async () => {
      packDir = await fs.mkdtemp(path.join(os.tmpdir(), "puca-pack-root-"));
      const { stdout } = await execFileAsync(
        "npm",
        ["pack", "--pack-destination", packDir, "--json"],
        { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 },
      );
      const parsed = JSON.parse(stdout.trim()) as Array<{ filename: string }>;
      expect(parsed.length).toBeGreaterThanOrEqual(1);
      rootTarball = path.join(packDir, parsed[0]!.filename);
      expect(rootTarball).toMatch(/puca-0\.2\.0\.tgz$/);

      const { stdout: listing } = await execFileAsync("tar", ["tzf", rootTarball]);
      const entries = listing
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      expect(entries.some((entry) => entry.includes("schema/mutation-report.json"))).toBe(
        true,
      );
      expect(entries.filter((entry) => entry.endsWith(".node"))).toEqual([]);
    }, 60_000);
  });

  describe("when platform stub manifests are read (AC2 / SC-306)", () => {
    it("should lock abi filenames, os/cpu, and linux glibc", async () => {
      for (const stub of PLATFORM_STUBS) {
        const raw = JSON.parse(
          await fs.readFile(
            path.join(repoRoot, "npm", stub.abi, "package.json"),
            "utf8",
          ),
        ) as {
          name: string;
          version: string;
          main: string;
          files: string[];
          os: string[];
          cpu: string[];
          libc?: string[];
        };
        expect(raw.name).toBe(stub.name);
        expect(raw.version).toBe("0.2.0");
        expect(raw.main).toBe(stub.main);
        expect(raw.files).toEqual([stub.main]);
        expect(raw.os).toEqual(stub.os);
        expect(raw.cpu).toEqual(stub.cpu);
        if (stub.libc != null) {
          expect(raw.libc).toEqual(stub.libc);
        } else {
          expect(raw.libc).toBeUndefined();
        }
      }
    });
  });
});
