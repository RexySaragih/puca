import type { ChildProcess, ForkOptions, Serializable } from "node:child_process";
import { fork } from "node:child_process";

/** IPC request: parent → child (REQ-703). */
export interface ChildMutantRequest {
  readonly mutantId: string;
  readonly file: string;
  readonly mutatedSource: string;
  readonly relatedSpecs: readonly string[];
}

/** IPC response statuses on the wire (uppercase). */
export type ChildWireStatus = "KILLED" | "SURVIVED" | "TIMEOUT" | "ERROR";

/** IPC response: child → parent (REQ-703). */
export interface ChildMutantResponse {
  readonly mutantId: string;
  readonly status: ChildWireStatus;
  readonly killedBy?: string;
  readonly message?: string;
  readonly rssBytes?: number;
}

/** RSS recycle threshold (ADR-018). */
export const WORKER_RSS_CAP_BYTES = 512 * 1024 * 1024;

/**
 * Fork options for scoring children (REQ-716 / ADR-015).
 * stdio: ignore / pipe / pipe / ipc — stdout/stderr are not the protocol.
 */
export const CHILD_FORK_OPTIONS: ForkOptions = {
  cwd: process.cwd(),
  serialization: "advanced",
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  execArgv: [],
};

export function isChildMutantRequest(value: unknown): value is ChildMutantRequest {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.mutantId === "string" &&
    typeof record.file === "string" &&
    typeof record.mutatedSource === "string" &&
    Array.isArray(record.relatedSpecs) &&
    record.relatedSpecs.every((entry) => typeof entry === "string")
  );
}

export function isChildMutantResponse(
  value: unknown,
): value is ChildMutantResponse {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  const statusOk =
    status === "KILLED" ||
    status === "SURVIVED" ||
    status === "TIMEOUT" ||
    status === "ERROR";
  return typeof record.mutantId === "string" && statusOk;
}

/**
 * Spawn a vitest child entry with the locked fork options.
 * `modulePath` should be the compiled `vitestChildMain.js` (or ts under tests).
 */
export function forkVitestChild(
  modulePath: string,
  cwd: string = process.cwd(),
): ChildProcess {
  return fork(modulePath, [], {
    ...CHILD_FORK_OPTIONS,
    cwd,
  });
}

/** Type-narrow helper for process.send payloads. */
export type ChildIpcMessage = ChildMutantRequest | ChildMutantResponse | Serializable;
