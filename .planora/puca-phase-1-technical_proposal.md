# Technical Proposal: Púca (`puca`)
## Next-Generation In-Memory Mutation Testing Engine for TypeScript & ESM

---

### 1. Brand Identity & Mythic Origin

* **Name:** **Púca** (CLI Command: `puca` | Package: `@puca/cli`)
* **Mythic Origin:** Derived from Celtic folklore—the *Púca* (or *Pooka*) is a legendary shapeshifting entity known for subtly altering its form to create chaos, testing the awareness and resilience of mortals.
* **Architectural Alignment:**
  * **In-Memory Shapeshifting:** Púca dynamically mutates target AST representations directly inside V8 process memory without ever writing mutated source files to disk.
  * **Minimal CLI Footprint:** A clean, 4-letter binary (`npx puca`) built for sub-second local dev iterations and continuous integration pipelines.

---

### 2. Executive Summary & Architecture

Existing mutation testing tools for JavaScript/TypeScript (such as StrykerJS) were architected around disk-based file sandboxing (`.stryker-tmp`) and process-level re-allocation. Púca replaces this paradigm with a **pure in-memory ESM loader hook architecture** paired with a **native Rust AST mutation engine**.

```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                                   PÚCA CLI PROCESS                                    │
│                                                                                       │
│  ┌────────────────────────┐      ┌─────────────────────────┐      ┌────────────────┐  │
│  │ Rust AST Engine (Oxc)  │ ──►  │ V8 Coverage Mapper      │ ──►  │ Orchestrator   │  │
│  │ (Microsecond Mutants) │      │ (Function ➔ Test Graph) │      │ & Cache Engine │  │
│  └────────────────────────┘      └─────────────────────────┘      └───────┬────────┘  │
└──────────────────────────────────────────────┬────────────────────────────────────────┘
                                               │ IPC / Worker Messaging
                                               ▼
┌───────────────────────────────────────────────────────────────────────────────────────┐
│                              WARM ESM WORKER THREAD POOL                              │
│                                                                                       │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐  │
│  │ Node.js Custom Module Customization Hook (node:module register)                 │  │
│  │                                                                                 │  │
│  │ [Import Request] ──► Intercept ──► [Match Active Mutant Hash]                   │  │
│  │                                          │                                      │  │
│  │                    ┌─────────────────────┴──────────────────────┐               │  │
│  │                    ▼                                            ▼               │  │
│  │         (Active Mutant Found)                       (No Active Mutant)          │  │
│  │         Inject Mutated TS Buffer                    Load Original File Buffer   │  │
│  │         From RAM (0ms Disk I/O)                     From Disk/Cache             │  │
│  └──────────────────────────┬──────────────────────────────────────────────────────┘  │
│                             │                                                         │
│                             ▼                                                         │
│              Target Test Runner Adapter (Vitest / node:test / Jest)                   │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 3. Core Features & System Innovations

1. **Zero-Disk In-Memory ESM Loader Hook:** Uses Node.js module customization hooks (`node:module` `register()`) to intercept module resolution on the fly. Mutated code is served straight from V8 memory buffers.
2. **Native Rust AST Mutator (`napi-rs`):** Leverages `oxc_parser` and `oxc_semantic` to parse TypeScript into ASTs, apply mutations, and serialize modified code in microsecond bursts.
3. **V8 Coverage-Guided Test Mapping:** Executes a single baseline coverage pass (`node:inspector`) prior to mutation runs to map mutated functions strictly to covering unit tests:
   $$\text{Mutated Function } F_i \implies \text{Set of Covering Tests } \{T_1, T_2, \dots, T_k\}$$
4. **Persistent Warm Worker Thread Pool:** Spawns isolation workers once inside `node:worker_threads`. Swaps out mutated function byte-streams in memory without tearing down V8 environments.
5. **AST Function-Level Incremental Caching:** Hashes code at the function-AST level combined with the hash of covering unit tests to pull cached metrics across runs.
6. **Compiler IR Normalization:** Runs a static Control-Flow Graph (CFG) normalization pass over generated ASTs prior to test execution, discarding syntactically shifted but semantically identical mutants.

---

### 4. Architectural Comparison: Púca vs. StrykerJS

| Dimensional Feature | StrykerJS | Púca (`puca`) |
| :--- | :--- | :--- |
| **Primary Execution Path** | Disk sandboxes (`.stryker-tmp`) or static mutation switching (`mutant schemata`). | Pure in-memory module loader hooks (`node:module`). Zero disk I/O. |
| **AST Parser & Mutator** | Babel AST / TypeScript Compiler API (JS runtime overhead). | Native Rust (`oxc_parser`) via NAPI bindings (~50× faster parsing/mutation). |
| **Test Execution Engine** | Spawns fresh Node process pools per batch or relies on legacy Babel hooks. | Persistent warm `worker_threads` with dynamic in-memory ESM code injection. |
| **Coverage Analysis** | Broad file/test level mapping. Runs large test subsets. | Fine-grained function AST range-to-test mapping via V8 `node:inspector`. |
| **Equivalent Mutant Strategy**| Manual annotations (`// Stryker disable`) or ignoring static mutants. | Automatic compiler IR normalization + static AST equivalence pruning pass. |
| **Target Ecosystem** | Wide legacy compatibility (CommonJS, Jest, Mocha, Karma). | Optimized for modern ESM-first environments (Vitest, Native `node:test`), Jest via Adapter. |
| **Latency Target per Mutant**| $\approx 50\text{ms} - 500\text{ms}$ per mutant. | **$L < 5\text{ms}$** per mutant (targeted test subset execution). |

---

### 5. The Runner Adapter Specification

To avoid hardcoding test runner logic into the core mutation engine, Púca decouples test runners via an abstract **Runner Adapter Pattern**. The core engine remains 100% test-runner agnostic, delegating setup, coverage collection, and test execution to dedicated adapters.

```
                  ┌──────────────────────────────────┐
                  │    Púca Core Engine (Rust)       │
                  │  (AST Mutator & In-Memory Hook)  │
                  └────────────────┬─────────────────┘
                                   │
                     ┌─────────────┴─────────────┐
                     ▼                           ▼
          [ Vitest Adapter (Phase 1) ]  [ Node:Test Adapter (Phase 1) ]
                     │                           │
                     └─────────────┬─────────────┘
                                   │ (Phase 3)
                                   ▼
                       [ Jest Adapter (Phase 3) ]
```

#### A. Core Adapter TypeScript Interface

```typescript
export interface FunctionCoverageRange {
  filePath: string;
  startOffset: number;
  endOffset: number;
  coveringTestIds: string[];
}

export interface TestResult {
  testId: string;
  passed: boolean;
  durationMs: number;
  error?: {
    message: string;
    stack?: string;
  };
}

export interface MutantRunResult {
  mutantId: string;
  status: 'KILLED' | 'SURVIVED' | 'TIMEOUT' | 'ERROR';
  failedTestId?: string;
  durationMs: number;
}

export interface TestRunnerAdapter {
  name: string;
  
  /**
   * Initializes baseline coverage pass to build Function -> Test ID mapping graph.
   */
  getCoverageMap(targetFiles: string[]): Promise<Map<string, FunctionCoverageRange[]>>;

  /**
   * Executes a specific subset of tests against an active in-memory mutant hash.
   */
  runTestSubset(
    testIds: string[], 
    activeMutantHash: string, 
    timeoutMs: number
  ): Promise<MutantRunResult>;

  /**
   * Disposes warm worker threads or test runner resources.
   */
  teardown(): Promise<void>;
}
```

#### B. Adapter Implementation Breakdown

1. **`VitestAdapter` (Phase 1 Target):**
   * Leverages Vitest's programmatic API (`startVitest()`) and custom Vite transform plugins.
   * Directly feeds in-memory transformed AST buffers into Vite’s SSR/Module Graph pipeline.
   * Extracts per-test V8 coverage using Vitest's native `coverage.all` V8 provider.
2. **`NodeTestAdapter` (Phase 1 Target):**
   * Uses native Node.js `node:test` runner combined with standard `node:module` `register()` ESM hooks.
   * Utilizes `node:inspector` session bindings to capture raw V8 script coverage ranges.
3. **`JestAdapter` (Phase 3 Deferred Target):**
   * Interfaces with `jest-runner` and custom `jest-environment` overrides to handle Jest's virtual VM contexts (`vm.runInContext`).
   * Bridges CommonJS module caching quirks with Púca's ESM loader memory specifiers.

---

### 6. Detailed System Design & In-Memory Execution Engine

#### A. In-Memory State Hygiene & ESM Cache Busting
Because workers remain warm across hundreds of mutant iterations, standard Node module CJS cache clearing (`delete require.cache[...]`) is insufficient for ESM. ESM modules are immutable once bound in V8 graph memory. Púca solves this by attaching unique cache-busting memory specifier query hashes (e.g., `import './service.ts?puca_mutant=8f31a'`) or utilizing worker-thread virtual memory boundaries to re-link modules dynamically without restarting the worker thread process.

#### B. TypeScript Type Validity Verification
Applying mutations to raw ASTs can break TypeScript typing (e.g., mutating a string to a number in a strictly typed parameter). Rather than running slow full `tsc` type checks across the entire project, Púca uses Rust-level static type inference checks on the targeted scope to prune type-invalid mutants upfront.

#### C. Concurrency & Memory Allocation Controls
Parallelizing worker threads across logical CPU cores can saturate host RAM if each worker loads heavy framework contexts. Púca enforces strict RSS memory caps per worker thread, recycling any thread whose heap allocation breaches target thresholds.

---

### 7. Edge Cases, Failure Modes & Mitigations

```
                               ┌─────────────────────────┐
                               │  MUTANT EXECUTION FLOW  │
                               └────────────┬────────────┘
                                            │
               ┌────────────────────────────┼────────────────────────────┐
               ▼                            ▼                            ▼
      [ Infinite Loop ]            [ Global State Leak ]        [ Static Module Scope ]
               │                            │                            │
               ▼                            ▼                            ▼
   CPU Starvation / Timeout      Flaky Cross-Test Pollute      Fails Hot-Reload Invalidation
               │                            │                            │
               ▼                            ▼                            ▼
     Hard Worker SIGKILL         Forced Worker Recycling       Fallback Worker Re-Bootstrap
   Mark Mutant as "Killed"      Re-run Baseline Isolation       Mark as "Static Mutant"
```

1. **Infinite Loops & CPU Starvation:**
   * *Scenario:* A mutant converts `for (let i=0; i < len; i++)` to `for (let i=0; i < len; i--)`.
   * *Mitigation:* Each test runner invocation is wrapped in a hard V8 worker `setTimeout` guard (e.g., 2,000ms max or 2× baseline test time). Upon timeout, the worker process is terminated via `worker.terminate()`, a fresh worker is spawned, and the mutant is marked as **Killed (Timeout)**.
2. **Global State & Singleton Contention:**
   * *Scenario:* Tests mutate global singletons (`process.env`, global stores, database connections). Subsequent warm mutant runs experience state bleeding.
   * *Mitigation:* Púca tracks baseline test execution determinism. If a mutant run fails tests that are *unrelated* to the mutated coverage map, Púca flags the worker state as dirty, recycles the worker thread, and re-executes the mutant in a clean sandbox.
3. **Static Top-Level Code Execution (Module Initialization):**
   * *Scenario:* Code executing at top-level module evaluation runs once when the module is imported.
   * *Mitigation:* Static mutants cannot be safely swapped in a warm ESM environment without re-evaluating the module graph. Púca isolates top-level static mutants into a dedicated "Cold Path" pipeline, executing them in isolated transient worker threads.
4. **Dynamic Imports & Non-Analyzable Code (`eval`, `new Function`):**
   * *Scenario:* Code relies on dynamic string evaluation or non-standard bundler virtual aliases (`virtual:my-module`).
   * *Mitigation:* The ESM loader hook falls back to raw pass-through for unknown specifiers and flags dynamic string imports for manual inspection, emitting a warning metric in the build report.

---

### 8. Implementation Roadmap & Milestones

#### Phase 1: Core Engine & ESM Invalidation (Vitest & Native ESM First)
* [ ] **M1.1 — Rust Parser Engine (`oxc` integration):** Build `puca-core` crate to parse TS files, traverse ASTs, and generate core mutations (Arithmetic, Comparison, Boolean).
* [ ] **M1.2 — NAPI-RS Bindings:** Expose Rust mutator to Node.js as `@puca/core`.
* [ ] **M1.3 — ESM Loader Hook:** Implement Node `node:module` `register()` hook to intercept imports and serve mutated memory buffers.
* [ ] **M1.4 — Runner Adapter Architecture:** Implement `TestRunnerAdapter` interface with baseline drivers for **Vitest** (`VitestAdapter`) and **`node:test`** (`NodeTestAdapter`).

#### Phase 2: Coverage Mapping & Worker Pool Optimization
* [ ] **M2.1 — V8 Coverage Inspector:** Integrate `node:inspector` during baseline runs to map `Mutant(File, Range) ➔ Array<CoveringTestID>`.
* [ ] **M2.2 — Warm Worker Pool:** Architect persistent `worker_threads` with automatic memory recycling and SIGKILL execution timeouts.
* [ ] **M2.3 — AST Equivalence Pruner:** Implement Rust-level CFG AST normalizer to drop semantically identical mutants statically.

#### Phase 3: Legacy Ecosystem & Jest Compatibility
* [ ] **M3.1 — Jest Adapter Driver (`JestAdapter`):** Build dedicated adapter for Jest VM contexts and legacy CommonJS module isolation.
* [ ] **M3.2 — Incremental AST Cache:** Implement function-level AST hashing to store and re-use mutation outcomes across local runs and CI commits.
* [ ] **M3.3 — CI Gating & Terminal UI:** Release GitHub Action integration and rich terminal reporting (`--break-on-score 80`).

---

### 9. Benchmarks & Success Metrics

1. **Execution Performance:** Achieve a **10× to 20× speedup** compared to StrykerJS when evaluated on identical TypeScript repositories under Vitest.
2. **Zero Disk Overhead:** 0 bytes written to disk during mutant execution cycles.
3. **Determinism Rate:** 100% reproducible mutation scores across consecutive identical test runs on clean git commits.