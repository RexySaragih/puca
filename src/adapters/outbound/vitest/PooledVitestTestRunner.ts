import { type ChildProcess, fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BaselineResult,
  MutantRunRequest,
  RelatedRunResult,
  ReverseMapResult,
  RunnerOverlay,
  RunnerSession,
  TestRunnerPort,
} from "../../../application/ports/outbound/TestRunnerPort.js";
import type { AbsolutePath } from "../../../domain/mutant.js";
import { PucaRefuseError } from "./resolveProjectVitest.js";
import {
  CHILD_FORK_OPTIONS,
  WORKER_RSS_CAP_BYTES,
  isChildMutantResponse,
  type ChildMutantRequest,
  type ChildMutantResponse,
} from "./ipc.js";
import { VitestTestRunner } from "./VitestTestRunner.js";

const POOL_SESSION_ID = "pooled-vitest-session";

export type ForkChildFn = (
  modulePath: string,
  cwd: string,
) => ChildProcess;

export interface PooledVitestTestRunnerOptions {
  readonly cwd?: string;
  readonly workers: number;
  readonly childModulePath?: string;
  readonly forkChild?: ForkChildFn;
  /** Injectable coordinator (tests). */
  readonly createCoordinator?: () => TestRunnerPort;
  /** Outer timer for IPC (tests override via getTestTimeoutMs still from coordinator). */
  readonly outerTimeoutMs?: number;
}

interface ChildSlot {
  process: ChildProcess;
  busy: boolean;
  stderr: string;
  stdout: string;
}

/**
 * N>=2 TestRunnerPort: coordinator map+baseline, then fork pool for scoring (ADR-013/014).
 */
export class PooledVitestTestRunner implements TestRunnerPort {
  readonly workers: number;
  private readonly cwd: string;
  private readonly childModulePath: string;
  private readonly forkChild: ForkChildFn;
  private readonly createCoordinator: () => TestRunnerPort;

  private coordinator: TestRunnerPort | null = null;
  private children: ChildSlot[] = [];
  private waitQueue: Array<() => void> = [];
  private closed = false;
  private outerTimeoutMs = 7000;
  /** Project Vitest testTimeout captured from the coordinator before it closes. */
  private projectTestTimeoutMs: number | null = null;
  private _recycleCount = 0;

  constructor(options: PooledVitestTestRunnerOptions) {
    if (options.workers < 2) {
      throw new Error("PooledVitestTestRunner requires workers >= 2");
    }
    this.workers = options.workers;
    this.cwd = options.cwd ?? process.cwd();
    this.childModulePath =
      options.childModulePath ?? defaultChildModulePath();
    this.forkChild = options.forkChild ?? defaultFork;
    this.createCoordinator =
      options.createCoordinator ??
      (() => new VitestTestRunner({ cwd: this.cwd }));
    if (options.outerTimeoutMs != null) {
      this.outerTimeoutMs = options.outerTimeoutMs;
    }
  }

  get recycleCount(): number {
    return this._recycleCount;
  }

  async startSession(overlay: RunnerOverlay): Promise<RunnerSession> {
    this.closed = false;
    this.coordinator = this.createCoordinator();
    await this.coordinator.startSession(overlay);
    return { id: POOL_SESSION_ID };
  }

  async buildReverseMap(
    candidates: readonly AbsolutePath[],
  ): Promise<ReverseMapResult> {
    const coordinator = this.requireCoordinator();
    await this.refuseIfGlobalSetup(coordinator);
    return coordinator.buildReverseMap(candidates);
  }

  async baseline(specs: readonly string[]): Promise<BaselineResult> {
    const coordinator = this.requireCoordinator();
    await this.refuseIfGlobalSetup(coordinator);
    const result = await coordinator.baseline(specs);
    if (!result.ok) {
      await this.closeCoordinatorOnly();
      return result;
    }
    // Capture project testTimeout before ADR-014 closes the coordinator.
    this.projectTestTimeoutMs = coordinator.getTestTimeoutMs();
    // ADR-014: close coordinator, then spawn N scoring children.
    await this.closeCoordinatorOnly();
    this.spawnPool();
    return result;
  }

  setBuffer(_file: AbsolutePath, _source: string | null): void {
    // Parent does not own overlays for N>=2 (injection is in-child).
  }

  invalidateFile(_file: AbsolutePath): void {
    // no-op on parent for N>=2
  }

  getTestTimeoutMs(): number {
    return this.projectTestTimeoutMs ?? this.outerTimeoutMs;
  }

  configureOuterTimeoutMs(timeoutMs: number): void {
    this.outerTimeoutMs = timeoutMs;
  }

  async runRelated(mutant: MutantRunRequest): Promise<RelatedRunResult> {
    if (this.children.length === 0) {
      throw new Error("PooledVitestTestRunner.runRelated requires a live child pool");
    }
    const slot = await this.acquireFreeChild();
    const mutantId = mutant.mutantId ?? `${mutant.file}:unknown`;
    const request: ChildMutantRequest = {
      mutantId,
      file: mutant.file,
      mutatedSource: mutant.mutatedSource,
      relatedSpecs: [...mutant.relatedSpecs],
    };

    try {
      return await this.sendAndWait(slot, request);
    } finally {
      slot.busy = false;
      this.releaseWaiters();
    }
  }

  async respawn(): Promise<RunnerSession> {
    // Pool path: use case must not call respawn (REQ-718). No-op session id.
    return { id: POOL_SESSION_ID };
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.closeCoordinatorOnly();
    await this.killAllChildren();
  }

  private requireCoordinator(): TestRunnerPort {
    if (this.coordinator == null) {
      throw new Error("PooledVitestTestRunner requires an active coordinator session");
    }
    return this.coordinator;
  }

  private async refuseIfGlobalSetup(coordinator: TestRunnerPort): Promise<void> {
    const maybe = coordinator as TestRunnerPort & {
      peekGlobalSetup?: () => unknown;
      hasGlobalSetup?: () => boolean | Promise<boolean>;
    };
    let hasSetup = false;
    if (typeof maybe.peekGlobalSetup === "function") {
      hasSetup = isNonEmptyGlobalSetup(maybe.peekGlobalSetup());
    } else if (typeof maybe.hasGlobalSetup === "function") {
      hasSetup = await maybe.hasGlobalSetup();
    }
    if (!hasSetup) {
      return;
    }
    await this.closeCoordinatorOnly();
    throw new PucaRefuseError(
      "Vitest globalSetup is incompatible with --workers >= 2. Pass --workers 1.",
    );
  }

  /** Live scoring children (tests / diagnostics). */
  getChildCount(): number {
    return this.children.filter((slot) => !slot.process.killed).length;
  }

  private async closeCoordinatorOnly(): Promise<void> {
    const coordinator = this.coordinator;
    this.coordinator = null;
    if (coordinator != null) {
      await coordinator.close();
    }
  }

  private spawnPool(): void {
    for (let i = 0; i < this.workers; i += 1) {
      this.children.push(this.spawnOneChild());
    }
  }

  private spawnOneChild(): ChildSlot {
    const child = this.forkChild(this.childModulePath, this.cwd);
    const slot: ChildSlot = {
      process: child,
      busy: false,
      stderr: "",
      stdout: "",
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      slot.stderr += chunk;
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      slot.stdout += chunk;
    });
    return slot;
  }

  private async acquireFreeChild(): Promise<ChildSlot> {
    for (;;) {
      if (this.closed) {
        throw new Error("PooledVitestTestRunner is closed");
      }
      const free = this.children.find((slot) => !slot.busy && !slot.process.killed);
      if (free != null) {
        free.busy = true;
        return free;
      }
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }
  }

  private releaseWaiters(): void {
    const waiters = this.waitQueue.splice(0, this.waitQueue.length);
    for (const wake of waiters) {
      wake();
    }
  }

  private sendAndWait(
    slot: ChildSlot,
    request: ChildMutantRequest,
  ): Promise<RelatedRunResult> {
    return new Promise<RelatedRunResult>((resolve) => {
      let settled = false;
      const child = slot.process;

      const cleanup = (): void => {
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("disconnect", onExit);
        clearTimeout(timer);
      };

      const finish = (result: RelatedRunResult, recycle: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (recycle) {
          this.replaceChild(slot);
        }
        resolve(result);
      };

      const onMessage = (raw: unknown): void => {
        if (!isChildMutantResponse(raw)) {
          return;
        }
        if (raw.mutantId !== request.mutantId) {
          return;
        }
        const mapped = mapWireToRelated(raw);
        const overRss =
          typeof raw.rssBytes === "number" &&
          raw.rssBytes > WORKER_RSS_CAP_BYTES;
        if (overRss) {
          this._recycleCount += 1;
        }
        finish(mapped, overRss);
      };

      const onExit = (): void => {
        finish(
          {
            kind: "error",
            message: slot.stderr.trim() || "Vitest worker exited unexpectedly",
          },
          true,
        );
        this._recycleCount += 1;
      };

      const timer = setTimeout(() => {
        // finish() removes exit listeners before replaceChild kills, so an
        // intentional timeout is never misclassified as a crash RuntimeError.
        this._recycleCount += 1;
        finish({ kind: "timeout" }, true);
      }, this.outerTimeoutMs);

      child.on("message", onMessage);
      child.on("exit", onExit);
      child.on("disconnect", onExit);

      const ok = child.send(request as ChildMutantRequest);
      if (ok === false) {
        finish(
          {
            kind: "error",
            message: slot.stderr.trim() || "Failed to send IPC to Vitest worker",
          },
          true,
        );
        this._recycleCount += 1;
      }
    });
  }

  private replaceChild(slot: ChildSlot): void {
    try {
      if (!slot.process.killed) {
        slot.process.kill();
      }
    } catch {
      /* ignore */
    }
    const index = this.children.indexOf(slot);
    const replacement = this.spawnOneChild();
    if (index >= 0) {
      this.children[index] = replacement;
    } else {
      this.children.push(replacement);
    }
    this.releaseWaiters();
  }

  private async killAllChildren(): Promise<void> {
    const living = this.children;
    this.children = [];
    for (const slot of living) {
      try {
        slot.process.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

function mapWireToRelated(response: ChildMutantResponse): RelatedRunResult {
  switch (response.status) {
    case "KILLED":
      return { kind: "failed", failingTestId: response.killedBy };
    case "SURVIVED":
      return { kind: "passed" };
    case "TIMEOUT":
      // Parent timer is source of truth; late child TIMEOUT ignored when already settled.
      return { kind: "timeout" };
    case "ERROR":
      return { kind: "error", message: response.message };
  }
}

function isNonEmptyGlobalSetup(value: unknown): boolean {
  if (value == null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function defaultChildModulePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Compiled entry next to this module under dist/, or ts source in tests via override.
  return path.join(here, "vitestChildMain.js");
}

function defaultFork(modulePath: string, cwd: string): ChildProcess {
  return fork(modulePath, [], {
    ...CHILD_FORK_OPTIONS,
    cwd,
  });
}
