import type {
  MutantProgress,
  ReportPort,
  SessionStartInfo,
} from "../../../application/ports/outbound/ReportPort.js";
import type { Mutant, SessionResult } from "../../../domain/mutant.js";
import type { SarifFile } from "./SarifFile.js";
import type { SchemaJsonFile } from "./SchemaJsonFile.js";
import type { StdioReport } from "./StdioReport.js";

/**
 * Prod ReportPort: StdioReport for UX-001 + SchemaJsonFile for --json + SarifFile for --sarif.
 */
export class CompositeReport implements ReportPort {
  constructor(
    readonly stdio: StdioReport,
    readonly schemaJson: SchemaJsonFile,
    readonly sarifFile: SarifFile,
  ) {}

  writeNotice(line: string): void {
    this.stdio.writeNotice(line);
  }

  writeSessionStart(info: SessionStartInfo): void {
    this.stdio.writeSessionStart(info);
  }

  writeMutantResult(mutant: Mutant, progress: MutantProgress): void {
    this.stdio.writeMutantResult(mutant, progress);
  }

  async writeTerminal(result: SessionResult): Promise<void> {
    await this.stdio.writeTerminal(result);
  }

  async writeJson(path: string, result: SessionResult): Promise<void> {
    await this.schemaJson.writeJson(path, result);
  }

  async writeSarif(path: string, result: SessionResult): Promise<void> {
    await this.sarifFile.writeSarif(path, result);
  }
}
