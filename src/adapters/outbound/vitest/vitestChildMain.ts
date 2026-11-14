#!/usr/bin/env node
/**
 * Forked Vitest scoring child (ADR-015).
 * Own VitestTestRunner + RAM Map; never loads NAPI or worker-thread isolation.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  MutantRunRequest,
  RelatedRunResult,
  TestRunnerPort,
} from "../../../application/ports/outbound/TestRunnerPort.js";
import { toAbsolutePath } from "../../../domain/mutant.js";
import {
  isChildMutantRequest,
  type ChildMutantRequest,
  type ChildMutantResponse,
} from "./ipc.js";
import { VitestTestRunner } from "./VitestTestRunner.js";

export interface ChildRunnerPort {
  startSession(overlay: { buffers: Map<string, string | null> }): Promise<unknown>;
  setBuffer(file: ReturnType<typeof toAbsolutePath>, source: string | null): void;
  invalidateFile(file: ReturnType<typeof toAbsolutePath>): void;
  runRelated(mutant: MutantRunRequest): Promise<RelatedRunResult>;
  close(): Promise<void>;
}

/**
 * Handle one IPC request against an already-started runner (own overlay Map).
 */
export async function handleChildMutantRequest(
  runner: ChildRunnerPort,
  request: ChildMutantRequest,
): Promise<ChildMutantResponse> {
  const file = toAbsolutePath(request.file);
  runner.setBuffer(file, request.mutatedSource);
  runner.invalidateFile(file);

  try {
    const result = await runner.runRelated({
      file,
      mutatedSource: request.mutatedSource,
      relatedSpecs: request.relatedSpecs,
    });
    return toWireResponse(request.mutantId, result);
  } catch (error) {
    return {
      mutantId: request.mutantId,
      status: "ERROR",
      message: error instanceof Error ? error.message : String(error),
      rssBytes: process.memoryUsage().rss,
    };
  } finally {
    runner.setBuffer(file, null);
    runner.invalidateFile(file);
  }
}

export function toWireResponse(
  mutantId: string,
  result: RelatedRunResult,
): ChildMutantResponse {
  const rssBytes = process.memoryUsage().rss;
  switch (result.kind) {
    case "failed":
      return {
        mutantId,
        status: "KILLED",
        killedBy: result.failingTestId,
        rssBytes,
      };
    case "passed":
      return { mutantId, status: "SURVIVED", rssBytes };
    case "timeout":
      return { mutantId, status: "TIMEOUT", rssBytes };
    case "error":
      return {
        mutantId,
        status: "ERROR",
        message: result.message,
        rssBytes,
      };
  }
}

export function attachChildIpcListener(
  runner: ChildRunnerPort,
  send: (message: ChildMutantResponse) => void = (message) => {
    process.send?.(message);
  },
): void {
  process.on("message", (raw: unknown) => {
    void (async () => {
      if (!isChildMutantRequest(raw)) {
        return;
      }
      const response = await handleChildMutantRequest(runner, raw);
      send(response);
    })();
  });
}

async function bootChild(): Promise<void> {
  const cwd = process.cwd();
  const runner: TestRunnerPort = new VitestTestRunner({ cwd });
  await runner.startSession({ buffers: new Map() });
  attachChildIpcListener(runner);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry == null) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    const base = path.basename(entry);
    return base === "vitestChildMain.js" || base === "vitestChildMain.ts";
  }
}

if (isDirectRun()) {
  void bootChild().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(2);
  });
}
