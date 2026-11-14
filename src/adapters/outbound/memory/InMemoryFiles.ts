import path from "node:path";
import type { WorkspaceFilesPort } from "../../../application/ports/outbound/WorkspaceFilesPort.js";

/**
 * In-memory workspace files with cwd containment checks.
 */
export class InMemoryFiles implements WorkspaceFilesPort {
  private readonly store = new Map<string, string>();

  constructor(private readonly cwd: string) {}

  seed(absolutePath: string, contents: string): void {
    this.store.set(path.resolve(absolutePath), contents);
  }

  isUnderCwd(absolutePath: string): boolean {
    const resolved = path.resolve(absolutePath);
    const root = path.resolve(this.cwd);
    const relative = path.relative(root, resolved);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  async exists(absolutePath: string): Promise<boolean> {
    if (!this.isUnderCwd(absolutePath)) {
      return false;
    }
    return this.store.has(path.resolve(absolutePath));
  }

  async readUtf8(absolutePath: string): Promise<string> {
    if (!this.isUnderCwd(absolutePath)) {
      throw new Error(`Refusing to read path outside cwd: ${absolutePath}`);
    }
    const resolved = path.resolve(absolutePath);
    const contents = this.store.get(resolved);
    if (contents === undefined) {
      throw new Error(`File not found: ${resolved}`);
    }
    return contents;
  }
}
