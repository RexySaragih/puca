import path from "node:path";
import { fileURLToPath } from "node:url";

/** Package export consumers should import: `puca/schema/mutation-report.json`. */
export const MUTATION_REPORT_SCHEMA_EXPORT = "puca/schema/mutation-report.json";

/**
 * Absolute path of the mutation-testing-report-schema document shipped with Púca.
 * `--json` output validates against this file.
 */
export function mutationReportSchemaPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../schema/mutation-report.json",
  );
}
