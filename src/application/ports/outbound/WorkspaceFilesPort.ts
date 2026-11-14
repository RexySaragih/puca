/**
 * Workspace file access constrained to cwd.
 * Prod: NodeWorkspaceFiles; mem: InMemoryFiles.
 * When isUnderCwd is false, readUtf8 must refuse without reading.
 */
export interface WorkspaceFilesPort {
  readUtf8(absolutePath: string): Promise<string>;
  exists(absolutePath: string): Promise<boolean>;
  isUnderCwd(absolutePath: string): boolean;
}
