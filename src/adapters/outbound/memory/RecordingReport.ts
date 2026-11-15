import type {
  MutantProgress,
  ReportPort,
  SessionStartInfo,
} from "../../../application/ports/outbound/ReportPort.js";
import type { Mutant, SessionResult } from "../../../domain/mutant.js";

/**
 * Captures terminal / JSON report calls for assertions.
 */
export class RecordingReport implements ReportPort {
  readonly terminalResults: SessionResult[] = [];
  readonly jsonWrites: Array<{ path: string; schemaDoc: unknown }> = [];
  readonly sarifWrites: Array<{ path: string; result: SessionResult }> = [];
  readonly htmlWrites: Array<{ path: string; result: SessionResult }> = [];
  readonly notices: string[] = [];
  readonly sessionStarts: SessionStartInfo[] = [];
  readonly mutantResults: Array<{ mutant: Mutant; progress: MutantProgress }> =
    [];

  writeNotice(line: string): void {
    this.notices.push(line);
  }

  writeSessionStart(info: SessionStartInfo): void {
    this.sessionStarts.push(info);
  }

  writeMutantResult(mutant: Mutant, progress: MutantProgress): void {
    this.mutantResults.push({ mutant, progress });
  }

  async writeTerminal(result: SessionResult): Promise<void> {
    this.terminalResults.push(result);
  }

  async writeJson(path: string, result: SessionResult): Promise<void> {
    this.jsonWrites.push({ path, schemaDoc: result });
  }

  async writeSarif(path: string, result: SessionResult): Promise<void> {
    this.sarifWrites.push({ path, result });
  }

  async writeHtml(path: string, result: SessionResult): Promise<void> {
    this.htmlWrites.push({ path, result });
  }
}
