import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NodeWorkspaceDiscovery,
  parsePnpmPackagesList,
} from "../src/adapters/outbound/workspace/NodeWorkspaceDiscovery.js";
import { EmptyWorkspaceMatchError } from "../src/domain/targetingErrors.js";

describe("Workspace package discovery", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        fs.rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  describe("when package.json declares workspaces array", () => {
    it("should return matching package roots filtered by glob", async () => {
      const root = await makeTempWorkspace({
        packageJson: {
          workspaces: ["packages/*"],
        },
        packages: ["packages/a", "packages/b", "packages/c"],
      });

      const discovery = new NodeWorkspaceDiscovery();
      const roots = await discovery.discoverPackageRoots(root, "packages/{a,b}");
      const relative = roots.map((absolute) =>
        path.relative(root, absolute).replaceAll("\\", "/"),
      );

      expect(relative).toEqual(["packages/a", "packages/b"]);
    });
  });

  describe("when package.json declares workspaces.packages", () => {
    it("should discover yarn-style object members", async () => {
      const root = await makeTempWorkspace({
        packageJson: {
          workspaces: { packages: ["apps/*"] },
        },
        packages: ["apps/web"],
      });

      const discovery = new NodeWorkspaceDiscovery();
      const roots = await discovery.discoverPackageRoots(root, "apps/*");
      expect(path.relative(root, roots[0]!).replaceAll("\\", "/")).toBe(
        "apps/web",
      );
    });
  });

  describe("when pnpm-workspace.yaml declares packages", () => {
    it("should discover pnpm members", async () => {
      const root = await makeTempWorkspace({
        pnpmYaml: "packages:\n  - 'libs/*'\n",
        packages: ["libs/core"],
      });

      const discovery = new NodeWorkspaceDiscovery();
      const roots = await discovery.discoverPackageRoots(root, "libs/*");
      expect(path.relative(root, roots[0]!).replaceAll("\\", "/")).toBe(
        "libs/core",
      );
    });
  });

  describe("when no members match the glob", () => {
    it("should throw EmptyWorkspaceMatchError naming --workspace", async () => {
      const root = await makeTempWorkspace({
        packageJson: { workspaces: ["packages/*"] },
        packages: ["packages/a"],
      });

      const discovery = new NodeWorkspaceDiscovery();
      await expect(
        discovery.discoverPackageRoots(root, "packages/zzz"),
      ).rejects.toBeInstanceOf(EmptyWorkspaceMatchError);
      await expect(
        discovery.discoverPackageRoots(root, "packages/zzz"),
      ).rejects.toThrow(/--workspace/);
    });
  });

  describe("parsePnpmPackagesList", () => {
    it("should parse list and inline array forms", () => {
      expect(
        parsePnpmPackagesList("packages:\n  - packages/*\n  - 'apps/**'\n"),
      ).toEqual(["packages/*", "apps/**"]);
      expect(parsePnpmPackagesList('packages: ["a/*", "b/*"]\n')).toEqual([
        "a/*",
        "b/*",
      ]);
    });
  });

  async function makeTempWorkspace(options: {
    readonly packageJson?: unknown;
    readonly pnpmYaml?: string;
    readonly packages: readonly string[];
  }): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "puca-ws-"));
    tempDirs.push(root);
    if (options.packageJson !== undefined) {
      await fs.writeFile(
        path.join(root, "package.json"),
        `${JSON.stringify(options.packageJson, null, 2)}\n`,
        "utf8",
      );
    }
    if (options.pnpmYaml !== undefined) {
      await fs.writeFile(
        path.join(root, "pnpm-workspace.yaml"),
        options.pnpmYaml,
        "utf8",
      );
    }
    for (const relative of options.packages) {
      const dir = path.join(root, relative);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "package.json"),
        `${JSON.stringify({ name: relative.replaceAll("/", "-"), private: true })}\n`,
        "utf8",
      );
    }
    return root;
  }
});
