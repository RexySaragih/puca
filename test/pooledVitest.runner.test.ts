import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  PooledVitestTestRunner,
  type ForkChildFn,
} from "../src/adapters/outbound/vitest/PooledVitestTestRunner.js";
import {
  WORKER_RSS_CAP_BYTES,
  type ChildMutantRequest,
  type ChildMutantResponse,
} from "../src/adapters/outbound/vitest/ipc.js";
import type {
  BaselineResult,
  MutantRunRequest,
  RelatedRunResult,
  ReverseMapResult,
  RunnerOverlay,
  RunnerSession,
  TestRunnerPort,
} from "../src/application/ports/outbound/TestRunnerPort.js";
import { toAbsolutePath } from "../src/domain/mutant.js";
import { isPucaRefuseError } from "../src/adapters/outbound/vitest/resolveProjectVitest.js";

class MockStream extends EventEmitter {
  setEncoding(_encoding: BufferEncoding): this {
    return this;
  }
}

class MockChild extends EventEmitter {
  killed = false;
  pid: number;
  stderr = new MockStream();
  stdout = new MockStream();
  private sendImpl: (message: unknown) => boolean;

  constructor(
    pid: number,
    sendImpl?: (message: unknown, child: MockChild) => boolean,
  ) {
    super();
    this.pid = pid;
    this.sendImpl =
      sendImpl != null
        ? (message) => sendImpl(message, this)
        : () => true;
  }

  send(message: unknown): boolean {
    return this.sendImpl(message);
  }

  kill(): boolean {
    if (this.killed) {
      return true;
    }
    this.killed = true;
    this.emit("exit", 1);
    return true;
  }

  asChildProcess(): ChildProcess {
    return this as unknown as ChildProcess;
  }
}

function createFakeCoordinator(options?: {
  readonly globalSetup?: unknown;
  readonly baseline?: BaselineResult;
}): TestRunnerPort & { closed: boolean; peekGlobalSetup: () => unknown } {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    peekGlobalSetup: () => options?.globalSetup,
    async startSession(_overlay: RunnerOverlay): Promise<RunnerSession> {
      closed = false;
      return { id: "coord" };
    },
    async buildReverseMap(
      _candidates: readonly string[],
    ): Promise<ReverseMapResult> {
      return {
        relatedBySource: new Map(),
        globalSetupOnly: new Set(),
      };
    },
    async baseline(_specs: readonly string[]): Promise<BaselineResult> {
      return options?.baseline ?? { ok: true };
    },
    setBuffer(): void {},
    invalidateFile(): void {},
    getTestTimeoutMs(): number {
      return 50;
    },
    async runRelated(_mutant: MutantRunRequest): Promise<RelatedRunResult> {
      throw new Error("coordinator must not score");
    },
    async respawn(): Promise<RunnerSession> {
      return { id: "coord" };
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}

describe("PooledVitestTestRunner", () => {
  describe("when baseline is green (AC1)", () => {
    it("should close the coordinator and leave exactly N live children", async () => {
      const children: MockChild[] = [];
      let nextPid = 1000;
      const forkChild: ForkChildFn = () => {
        const child = new MockChild(nextPid);
        nextPid += 1;
        children.push(child);
        return child.asChildProcess();
      };
      const coordinator = createFakeCoordinator();
      const pool = new PooledVitestTestRunner({
        workers: 2,
        forkChild,
        createCoordinator: () => coordinator,
        outerTimeoutMs: 200,
      });

      await pool.startSession({ buffers: new Map() });
      await pool.buildReverseMap([]);
      const baseline = await pool.baseline([]);

      expect(baseline.ok).toBe(true);
      expect(coordinator.closed).toBe(true);
      expect(pool.getChildCount()).toBe(2);
      expect(children).toHaveLength(2);

      await pool.close();
    });
  });

  describe("when vitest has globalSetup (AC2)", () => {
    it("should refuse before forking scoring children", async () => {
      const forkChild = vi.fn(() => {
        throw new Error("must not fork");
      });
      const coordinator = createFakeCoordinator({
        globalSetup: ["./setup-global.ts"],
      });
      const pool = new PooledVitestTestRunner({
        workers: 2,
        forkChild,
        createCoordinator: () => coordinator,
      });

      await pool.startSession({ buffers: new Map() });
      await expect(pool.buildReverseMap([])).rejects.toSatisfy(
        (error: unknown) =>
          isPucaRefuseError(error) &&
          error.message.includes("--workers 1"),
      );
      expect(forkChild).not.toHaveBeenCalled();
      expect(pool.getChildCount()).toBe(0);
      expect(coordinator.closed).toBe(true);

      await pool.close();
    });
  });

  describe("when a child exceeds the outer timer (AC3)", () => {
    it("should return timeout, replace that child, and let a sibling finish", async () => {
      const live: MockChild[] = [];
      let nextPid = 2000;
      const forkChild: ForkChildFn = () => {
        const child = new MockChild(nextPid, (message, self) => {
          const req = message as ChildMutantRequest;
          if (req.mutantId === "hang") {
            // Never respond — parent timer kills.
            return true;
          }
          queueMicrotask(() => {
            const response: ChildMutantResponse = {
              mutantId: req.mutantId,
              status: "SURVIVED",
              rssBytes: 1024,
            };
            self.emit("message", response);
          });
          return true;
        });
        nextPid += 1;
        live.push(child);
        return child.asChildProcess();
      };

      const pool = new PooledVitestTestRunner({
        workers: 2,
        forkChild,
        createCoordinator: () => createFakeCoordinator(),
        outerTimeoutMs: 40,
      });

      await pool.startSession({ buffers: new Map() });
      await pool.baseline([]);
      const hangPid = live[0]!.pid;
      const siblingPid = live[1]!.pid;

      const hang = pool.runRelated({
        file: toAbsolutePath("/tmp/a.ts"),
        mutatedSource: "a",
        relatedSpecs: ["t.ts"],
        mutantId: "hang",
      });
      const ok = pool.runRelated({
        file: toAbsolutePath("/tmp/b.ts"),
        mutatedSource: "b",
        relatedSpecs: ["t.ts"],
        mutantId: "ok",
      });

      const [hangResult, okResult] = await Promise.all([hang, ok]);
      expect(hangResult).toEqual({ kind: "timeout" });
      expect(okResult).toEqual({ kind: "passed" });
      expect(live.find((c) => c.pid === hangPid)?.killed).toBe(true);
      expect(live.find((c) => c.pid === siblingPid)?.killed).toBe(false);
      expect(pool.getChildCount()).toBe(2);
      expect(pool.recycleCount).toBeGreaterThanOrEqual(1);

      await pool.close();
    });
  });

  describe("when rssBytes exceeds the cap on SURVIVED (AC4)", () => {
    it("should return passed and replace the child without Timeout", async () => {
      let nextPid = 3000;
      const forked: MockChild[] = [];
      const forkChild: ForkChildFn = () => {
        const child = new MockChild(nextPid, (message, self) => {
          const req = message as ChildMutantRequest;
          queueMicrotask(() => {
            self.emit("message", {
              mutantId: req.mutantId,
              status: "SURVIVED",
              rssBytes: WORKER_RSS_CAP_BYTES + 1,
            } satisfies ChildMutantResponse);
          });
          return true;
        });
        nextPid += 1;
        forked.push(child);
        return child.asChildProcess();
      };

      const pool = new PooledVitestTestRunner({
        workers: 2,
        forkChild,
        createCoordinator: () => createFakeCoordinator(),
        outerTimeoutMs: 200,
      });

      await pool.startSession({ buffers: new Map() });
      await pool.baseline([]);
      const firstPid = forked[0]!.pid;

      const result = await pool.runRelated({
        file: toAbsolutePath("/tmp/a.ts"),
        mutatedSource: "x",
        relatedSpecs: ["t.ts"],
        mutantId: "m1",
      });

      expect(result).toEqual({ kind: "passed" });
      expect(forked.find((c) => c.pid === firstPid)?.killed).toBe(true);
      expect(pool.getChildCount()).toBe(2);
      expect(pool.recycleCount).toBe(1);

      await pool.close();
    });
  });

  describe("when a child exits before responding (AC5)", () => {
    it("should return error with stderr and replace the child", async () => {
      let nextPid = 4000;
      const forkChild: ForkChildFn = () => {
        const child = new MockChild(nextPid, (_message, self) => {
          queueMicrotask(() => {
            self.stderr.emit("data", "boom-stderr\n");
            self.kill();
          });
          return true;
        });
        nextPid += 1;
        return child.asChildProcess();
      };

      const pool = new PooledVitestTestRunner({
        workers: 2,
        forkChild,
        createCoordinator: () => createFakeCoordinator(),
        outerTimeoutMs: 500,
      });

      await pool.startSession({ buffers: new Map() });
      await pool.baseline([]);

      const result = await pool.runRelated({
        file: toAbsolutePath("/tmp/a.ts"),
        mutatedSource: "x",
        relatedSpecs: ["t.ts"],
        mutantId: "crash",
      });

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.message).toContain("boom-stderr");
      }
      expect(pool.getChildCount()).toBe(2);
      expect(pool.recycleCount).toBeGreaterThanOrEqual(1);

      await pool.close();
    });
  });

  describe("when configureOuterTimeoutMs is called after baseline", () => {
    it("should use the configured timeout for IPC hang kills", async () => {
      const live: MockChild[] = [];
      let nextPid = 5000;
      const forkChild: ForkChildFn = () => {
        const child = new MockChild(nextPid, () => true);
        nextPid += 1;
        live.push(child);
        return child.asChildProcess();
      };

      const pool = new PooledVitestTestRunner({
        workers: 2,
        forkChild,
        createCoordinator: () => createFakeCoordinator(),
        outerTimeoutMs: 10_000,
      });

      await pool.startSession({ buffers: new Map() });
      await pool.baseline([]);
      pool.configureOuterTimeoutMs(40);

      const started = Date.now();
      const hang = await pool.runRelated({
        file: toAbsolutePath("/tmp/a.ts"),
        mutatedSource: "x",
        relatedSpecs: ["t.ts"],
        mutantId: "hang",
      });
      const elapsed = Date.now() - started;

      expect(hang.kind).toBe("timeout");
      expect(elapsed).toBeLessThan(2000);
      expect(pool.recycleCount).toBeGreaterThanOrEqual(1);

      await pool.close();
    });
  });
});
