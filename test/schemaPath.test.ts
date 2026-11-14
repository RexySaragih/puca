import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  MUTATION_REPORT_SCHEMA_EXPORT,
  mutationReportSchemaPath,
} from "../src/schemaPath.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

describe("mutation report schema helper", () => {
  describe("when consumers resolve puca/schema/mutation-report.json", () => {
    it("should point at a draft-07 mutation-testing-report-schema document", async () => {
      const schemaPath = mutationReportSchemaPath();
      expect(MUTATION_REPORT_SCHEMA_EXPORT).toBe(
        "puca/schema/mutation-report.json",
      );
      expect(schemaPath).toBe(
        path.join(repoRoot, "schema/mutation-report.json"),
      );

      const raw = JSON.parse(await fs.readFile(schemaPath, "utf8")) as {
        title?: string;
        required?: string[];
      };
      expect(raw.title).toBe("MutationTestResult");
      expect(raw.required).toEqual(["schemaVersion", "thresholds", "files"]);

      const pkg = require("../package.json") as {
        exports?: Record<string, unknown>;
        peerDependencies?: Record<string, string>;
        peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      };
      expect(pkg.exports?.["./schema/mutation-report.json"]).toBe(
        "./schema/mutation-report.json",
      );
      expect(pkg.peerDependencies?.vitest).toBe(">=4.0.0");
      expect(pkg.peerDependenciesMeta?.vitest?.optional).toBe(true);

      const ajv = new Ajv({ strict: false });
      expect(() => ajv.compile(raw)).not.toThrow();
    });
  });
});
