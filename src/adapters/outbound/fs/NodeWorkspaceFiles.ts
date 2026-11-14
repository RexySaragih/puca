import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFilesPort } from "../../../application/ports/outbound/WorkspaceFilesPort.js";

/**
 * Production workspace files via node:fs/promises + path.
 * Paths that resolve outside cwd are refused by readUtf8.
 */
export class NodeWorkspaceFiles implements WorkspaceFilesPort {
  constructor(private readonly cwd: string = process.cwd()) {}

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
    try {
      await fs.access(path.resolve(absolutePath));
      return true;
    } catch {
      return false;
    }
  }

  async readUtf8(absolutePath: string): Promise<string> {
    if (!this.isUnderCwd(absolutePath)) {
      throw new Error(`Refusing to read path outside cwd: ${absolutePath}`);
    }
    return fs.readFile(path.resolve(absolutePath), "utf8");
  }
}
