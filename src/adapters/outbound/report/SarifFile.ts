import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ReportPort } from "../../../application/ports/outbound/ReportPort.js";
import type { Mutant, SessionResult } from "../../../domain/mutant.js";

const SARIF_VERSION = "2.1.0";
const SARIF_SCHEMA =
  "https://json.schemastore.org/sarif-2.1.0.json";
const TOOL_NAME = "puca";
const RULE_ID = "survived-mutant";

export interface SarifLog {
  readonly $schema: string;
  readonly version: string;
  readonly runs: readonly SarifRun[];
}

interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: string;
      readonly version?: string;
      readonly rules: readonly [
        {
          readonly id: string;
          readonly shortDescription: { readonly text: string };
        },
      ];
    };
  };
  readonly results: readonly SarifResult[];
}

interface SarifResult {
  readonly ruleId: string;
  readonly level: "error";
  readonly message: { readonly text: string };
  readonly locations: readonly [
    {
      readonly physicalLocation: {
        readonly artifactLocation: { readonly uri: string };
        readonly region: {
          readonly startLine: number;
          readonly startColumn: number;
        };
      };
    },
  ];
}

/**
 * Writes Survived-only SARIF 2.1.0 for `--sarif <path>` (ADR-033).
 */
export class SarifFile implements ReportPort {
  constructor(private readonly cwd: string = process.cwd()) {}

  async writeTerminal(_result: SessionResult): Promise<void> {
    // Terminal output is owned by StdioReport in the composite.
  }

  async writeSarif(pathToWrite: string, result: SessionResult): Promise<void> {
    const doc = this.buildDocument(result);
    const resolved = path.resolve(this.cwd, pathToWrite);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  }

  buildDocument(result: SessionResult): SarifLog {
    const survived = result.statuses.filter(
      (mutant) => mutant.status === "Survived",
    );
    return {
      $schema: SARIF_SCHEMA,
      version: SARIF_VERSION,
      runs: [
        {
          tool: {
            driver: {
              name: TOOL_NAME,
              version: resolvePackageVersion(),
              rules: [
                {
                  id: RULE_ID,
                  shortDescription: {
                    text: "Mutation survived related Vitest specs",
                  },
                },
              ],
            },
          },
          results: survived.map((mutant) => toSarifResult(mutant)),
        },
      ],
    };
  }
}

function toSarifResult(mutant: Mutant): SarifResult {
  const site = mutant.site;
  const uri = pathToFileUri(site.file);
  return {
    ruleId: RULE_ID,
    level: "error",
    message: {
      text: `${site.mutatorName}: ${site.original} → ${site.replacement} (${site.id})`,
    },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri },
          region: {
            startLine: site.line,
            startColumn: site.column,
          },
        },
      },
    ],
  };
}

function pathToFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

function resolvePackageVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      try {
        const pkg = require(path.join(dir, "package.json")) as {
          version?: string;
        };
        if (typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        // Walk toward repo root from dist/adapters/...
      }
      dir = path.dirname(dir);
    }
  } catch {
    return undefined;
  }
  return undefined;
}
