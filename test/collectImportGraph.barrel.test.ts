import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectImportGraph,
  type ViteEnvironmentLike,
  type ViteModuleNodeLike,
  type VitestGraphHost,
  type VitestProjectLike,
} from "../src/adapters/outbound/vitest/collectImportGraph.js";
import { buildReverseMap } from "../src/adapters/outbound/vitest/reverseMap.js";
import { normalizeModulePath } from "../src/adapters/outbound/vitest/pucaRamPlugin.js";

const root = path.resolve("/tmp/puca-barrel-graph");

function abs(rel: string): string {
  return normalizeModulePath(path.join(root, rel));
}

/**
 * Vite-like graph: importedModules on a barrel stay empty until that file is
 * transformRequest'd (re-export edges are not visible from the spec transform alone).
 */
function createLazyReexportHost(): VitestGraphHost {
  const spec = abs("test/orderPreview.test.ts");
  const preview = abs("src/storefront/orderPreview.ts");
  const barrel = abs("src/catalog/index.ts");
  const inventory = abs("src/catalog/inventory.ts");

  const edges = new Map<string, string[]>([
    [spec, [preview]],
    [preview, [barrel]],
    [barrel, [inventory]],
    [inventory, []],
  ]);
  const transformed = new Set<string>();
  const nodes = new Map<string, ViteModuleNodeLike>();

  function nodeFor(file: string): ViteModuleNodeLike {
    const existing = nodes.get(file);
    if (existing != null) {
      return existing;
    }
    const created: ViteModuleNodeLike = {
      id: file,
      file,
      get importedModules() {
        if (!transformed.has(file)) {
          return new Set<ViteModuleNodeLike>();
        }
        return new Set((edges.get(file) ?? []).map((child) => nodeFor(child)));
      },
    };
    nodes.set(file, created);
    return created;
  }

  for (const file of edges.keys()) {
    nodeFor(file);
  }

  const env: ViteEnvironmentLike = {
    name: "ssr",
    async transformRequest(url: string) {
      const file = path.isAbsolute(url)
        ? normalizeModulePath(url)
        : abs(url.replace(/^\//, ""));
      transformed.add(file);
      const deps = (edges.get(file) ?? []).map(
        (child) => `/${path.relative(root, child).split(path.sep).join("/")}`,
      );
      return { deps };
    },
    moduleGraph: {
      getModuleById(id: string) {
        return nodes.get(normalizeModulePath(id));
      },
      getModulesByFile(file: string) {
        const node = nodes.get(normalizeModulePath(file));
        return node != null ? new Set([node]) : undefined;
      },
    },
  };

  const project: VitestProjectLike = {
    config: { root },
    vite: { environments: { ssr: env } },
  };

  return {
    globTestSpecifications: async () => [{ moduleId: spec }],
    getRootProject: () => project,
  };
}

describe("Reverse-map barrel re-exports", () => {
  describe("when a spec imports a barrel that re-exports a leaf", () => {
    it("should relate inventory.ts to orderPreview.test.ts without a direct test import", async () => {
      // Given — test → preview → catalog/index → inventory (re-export)
      const host = createLazyReexportHost();
      const spec = abs("test/orderPreview.test.ts");
      const inventory = abs("src/catalog/inventory.ts");

      // When
      const graph = await collectImportGraph(host);
      const reverse = buildReverseMap(graph, [inventory]);

      // Then
      const related = reverse.relatedBySource.get(inventory) ?? [];
      expect(related).toContain(spec);
      expect(graph.importsBySpec.get(spec)).toEqual(
        expect.arrayContaining([
          abs("src/storefront/orderPreview.ts"),
          abs("src/catalog/index.ts"),
          inventory,
        ]),
      );
    });
  });
});
