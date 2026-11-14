import fs from "node:fs/promises";
import path from "node:path";
import type { ReportPort } from "../../../application/ports/outbound/ReportPort.js";
import type { WorkspaceFilesPort } from "../../../application/ports/outbound/WorkspaceFilesPort.js";
import type { Mutant, SessionResult, Site } from "../../../domain/mutant.js";

const SCHEMA_VERSION = "2";
const THRESHOLD_HIGH = 80;
const THRESHOLD_LOW = 60;
const FRAMEWORK_NAME = "Púca";
const LANGUAGE = "typescript";

export interface MutationTestingReportDocument {
  readonly schemaVersion: string;
  readonly thresholds: { readonly high: number; readonly low: number };
  readonly framework: { readonly name: string };
  readonly files: Record<
    string,
    {
      readonly language: string;
      readonly source: string;
      readonly mutants: readonly SchemaMutant[];
    }
  >;
}

interface SchemaMutant {
  readonly id: string;
  readonly mutatorName: string;
  readonly location: {
    readonly start: { readonly line: number; readonly column: number };
    readonly end: { readonly line: number; readonly column: number };
  };
  readonly replacement: string;
  readonly status:
    | "Killed"
    | "Survived"
    | "Timeout"
    | "NoCoverage"
    | "RuntimeError";
  /** Failing related test id(s) when status is Killed (schema: string[]). */
  readonly killedBy?: readonly string[];
}

/**
 * Writes mutation-testing-report-schema JSON for `--json <path>`.
 */
export class SchemaJsonFile implements ReportPort {
  constructor(
    private readonly files: WorkspaceFilesPort,
    private readonly cwd: string,
  ) {}

  async writeTerminal(_result: SessionResult): Promise<void> {
    // Terminal output is owned by StdioReport in the composite.
  }

  async writeJson(pathToWrite: string, result: SessionResult): Promise<void> {
    const doc = await this.buildDocument(result);
    const resolved = path.resolve(this.cwd, pathToWrite);
    await fs.writeFile(resolved, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }

  async buildDocument(
    result: SessionResult,
  ): Promise<MutationTestingReportDocument> {
    const byFile = new Map<string, Mutant[]>();

    for (const mutant of result.statuses) {
      const rel = toRelPath(this.cwd, mutant.site.file);
      const list = byFile.get(rel);
      if (list != null) {
        list.push(mutant);
      } else {
        byFile.set(rel, [mutant]);
      }
    }

    const files: MutationTestingReportDocument["files"] = {};
    for (const [rel, mutants] of byFile) {
      const absolute = mutants[0]!.site.file;
      const source = await this.files.readUtf8(absolute);
      files[rel] = {
        language: LANGUAGE,
        source,
        mutants: mutants.map((entry) => toSchemaMutant(entry)),
      };
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      thresholds: { high: THRESHOLD_HIGH, low: THRESHOLD_LOW },
      framework: { name: FRAMEWORK_NAME },
      files,
    };
  }
}

function toRelPath(cwd: string, absoluteFile: string): string {
  return path.relative(cwd, absoluteFile).replace(/\\/g, "/") || absoluteFile;
}

function toSchemaMutant(mutant: Mutant): SchemaMutant {
  return {
    id: mutant.site.id,
    mutatorName: mutant.site.mutatorName,
    location: locationFromSite(mutant.site),
    replacement: mutant.site.replacement,
    status: mutant.status,
    ...(mutant.killedBy != null && mutant.killedBy.length > 0
      ? { killedBy: [mutant.killedBy] }
      : {}),
  };
}

function locationFromSite(site: Site): SchemaMutant["location"] {
  const start = { line: site.line, column: site.column };
  const parts = site.original.split("\n");
  if (parts.length === 1) {
    return {
      start,
      end: { line: site.line, column: site.column + site.original.length },
    };
  }
  const last = parts[parts.length - 1] ?? "";
  return {
    start,
    end: {
      line: site.line + parts.length - 1,
      column: last.length + 1,
    },
  };
}
