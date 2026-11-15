# Technical Proposal: Púca Phase 2 (`puca`)

## Scaling to Multi-Core Warm Workers, AST Range Coverage & Incremental Caching

---

### 1. Phase 2 Executive Summary & Vision

Phase 1 successfully established Púca's foundational architecture: zero-sandbox in-memory code injection via Vitest/Vite transform cache invalidation, a native Rust Oxc mutator, and baseline correctness on a single worker thread.

**Phase 2 transforms Púca from a functional local loop into an ultra-fast, multi-core performance engine.** While Phase 1 proved *how to mutate and run safely*, Phase 2 focuses on:
1. **Parallelizing test execution** across warm worker thread pools without ESM state leakage.
2. **Precision targeting** via V8 AST line/column range mapping (resolving Phase 1 barrel file over-inclusion).
3. **Eliminating redundant execution** with a persistent function-level AST dual-hash cache (`.puca/cache.json`).
4. **Zero-dependency publishing** via cross-compiled NAPI-RS prebuild binaries (`optionalDependencies`).

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    PÚCA PHASE 2 ARCHITECTURE                                    │
│                                                                                                 │
│  ┌────────────────────────┐   ┌──────────────────────────────┐   ┌───────────────────────────┐  │
│  │  Incremental AST Cache │   │ V8 AST Range Coverage Mapper │   │ Native NAPI Rust Engine   │  │
│  │  (.puca/cache.json)    │   │ (Line/Col Offset Graph)      │   │ (Oxc Parser + Mutators)   │  │
│  └───────────┬────────────┘   └──────────────┬───────────────┘   └─────────────┬─────────────┘  │
└──────────────│───────────────────────────────│─────────────────────────────────│────────────────┘
               │ Cache Hit                     │ Target Test IDs                 │ Mutated Bytecode
               ▼                               ▼                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                            WARM WORKER THREAD POOL MANAGER (IPC)                                │
│                                                                                                 │
│   ┌─────────────────────────┐   ┌─────────────────────────┐   ┌─────────────────────────┐   │
│   │ Worker 1 (V8 Thread)    │   │ Worker 2 (V8 Thread)    │   │ Worker N (V8 Thread)    │   │
│   │ - RSS Cap Guard         │   │ - RSS Cap Guard         │   │ - RSS Cap Guard         │   │
│   │ - Vitest Runner Session │   │ - Vitest Runner Session │   │ - Vitest Runner Session │   │
│   └─────────────────────────┘   └─────────────────────────┘   └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

### 2. Core Pillars & System Innovations

#### Pillar 1: Warm Worker Thread Pool & Parallel Execution
* **Multi-Core Dispatch:** Scale execution from `maxWorkers: 1` to full CPU core saturation using a managed pool of `node:worker_threads`.
* **State Hygiene & RSS Memory Caps:** Enforce strict memory thresholds (e.g., 500 MB RSS cap per worker). Workers that exceed memory bounds or exhibit dirty state are transparently recycled between mutant batches.
* **Atomic Thread Termination:** Replace process-level restarts for infinite-loop timeouts (`while (true)`) with instant `worker.terminate()` execution, followed by spawning a fresh warm thread.

#### Pillar 2: Surgical V8 AST Range Coverage Mapping
* **Offset-Level Precision:** Upgrade from Phase 1 module-level reverse graph mapping to exact line-and-column AST range mapping using `node:inspector` V8 coverage data:

  $$
  \text{Mutant}(F_i, \text{Line}, \text{Col}) \implies \text{Set of Exact Covering Test IDs } \{T_1, T_2\}
  $$

* **Barrel Re-Export Tracing:** Recursively resolve Vite SSR module graph re-export nodes (`export * from ...` and `export { x } from ...`) to eliminate false `NoCoverage` reports on leaf modules re-exported through index barrels (resolving Phase 1 finding F2).

#### Pillar 3: Incremental Function-AST Dual-Hash Cache
* **Persistent Cache (`.puca/cache.json`):** Skip executing tests for functions and unit assertions that have not changed since the previous run.
* **Dual-Hash Formula:**

  $$
  \text{CacheKey} = \text{Hash}(\text{Function AST Node}) \oplus \text{Hash}(\text{Covering Test AST Nodes})
  $$

* If both the target function's AST representation and the ASTs of its covering test specifications remain unchanged, the cached result (`KILLED` or `SURVIVED`) is retrieved instantly without invoking Vitest.

#### Pillar 4: Zero-Rust Native Prebuild Matrix
* **`napi-rs` Cross-Compilation:** Publish platform-native prebuilt binaries to npm so end-users can run `npx puca` instantly without requiring `rustc` or build tools.
* **Target Platforms:**
  * `@puca/binding-darwin-arm64`
  * `@puca/binding-darwin-x64`
  * `@puca/binding-linux-x64-gnu`
  * `@puca/binding-win32-x64`

#### Pillar 5: Interactive Terminal UI & Diagnostic Polish
* **Live Dashboard:** Render real-time throughput metrics ($\text{mutants}/\text{sec}$), active worker thread status, elapsed wall-clock time, and worker respawn counts.
* **Syntax-Highlighted Diff Viewer:** Display clean, token-aware diff previews (`- original` / `+ replacement`) with exact `file:line:col` coordinates for `SURVIVED`, `TIMEOUT`, and `ERROR` mutants (resolving Phase 1 finding F3).
* **CLI Flags:**
  * `--include-untracked`: Include uncommitted/untracked `.ts`/`.tsx` files alongside git-dirty targets (resolving Phase 1 finding F4).
  * `--verbose`: Print selected candidate file lists, mutator operator histograms, and disabled line counts (resolving Phase 1 finding F5).

---

### 3. Comparison: Phase 1 vs. Phase 2

| Dimension | Phase 1 (Foundation) | Phase 2 (Scale & DX) |
| :--- | :--- | :--- |
| **Worker Threads** | Single-threaded (`maxWorkers: 1`) sequential | Parallel multi-core pool (`node:worker_threads`) |
| **Coverage Mapping** | Module-level reverse dependency graph | Surgical V8 line/column AST range-to-test mapping |
| **Barrel Files** | Leaf re-exports required direct test import | Recursive export-from graph traversal |
| **Caching Layer** | None (full execution per dirty target) | Persistent function-level dual-hash AST cache |
| **Distribution** | Source-build (`npm run build` with `rustc`) | Zero-dependency npm install via `optionalDependencies` |
| **Targeting** | `git diff HEAD` (untracked files skipped) | `git diff HEAD` + optional `--include-untracked` |
| **Terminal Output** | Line streaming (`SURVIVED` lines) | Interactive live dashboard + syntax diff viewer |
| **Mutator Correctness**| Ternary mutated whole expression | Predicate-only ternary condition mutation |

---

### 4. System Architecture & Component Interactions

```
1. CLI Invocation (`puca`)
   │
   ├──► 2. Target File Resolver (git diff HEAD + optional --include-untracked)
   │
   ├──► 3. Rust Mutator Engine (Oxc AST site discovery + Predicate-only Ternary rules)
   │
   ├──► 4. Incremental Cache Lookup (.puca/cache.json)
   │      ├── (Cache Hit)  ──► Restore Killed/Survived metrics (0ms)
   │      └── (Cache Miss) ──► Forward to Worker Pool
   │
   └──► 5. Parallel Warm Worker Pool
          │
          ├── Worker 1 ──► [V8 Range Coverage Map] ──► Run Target Test Subset ──► Return Status
          ├── Worker 2 ──► [V8 Range Coverage Map] ──► Run Target Test Subset ──► Return Status
          └── Worker N ──► [V8 Range Coverage Map] ──► Run Target Test Subset ──► Return Status
```

---

### 5. Benchmark Bake-Off Specification vs. StrykerJS

Phase 2 introduces formal, automated performance bake-off benchmarks against StrykerJS (`@stryker-mutator/vitest-runner`) evaluated on standard TypeScript open-source codebases (e.g., `zod`, `date-fns`).

#### Benchmark Requirements (NFRs)
1. **Wall-Clock Speedup Target:**

   $$
   \text{Speedup} = \frac{T_{\text{StrykerJS}}}{T_{\text{Púca}}} \ge 10\times
   $$

2. **Memory Footprint:** Peak RSS memory usage across all parallel workers must remain below 1.5 GB.
3. **Determinism:** 100% identical score output and status classifications across 10 consecutive executions on a clean git commit.

---

### 6. Phase 2 Roadmap & Implementation Milestones

#### Milestone M2.1: Multi-Threaded Warm Worker Pool
* [ ] Implement IPC worker thread pool manager (`worker_threads`).
* [ ] Add RSS heap memory monitoring and auto-recycling per worker.
* [ ] Implement atomic thread termination (`worker.terminate()`) for mutant execution timeouts.

#### Milestone M2.2: V8 Range Coverage & Barrel Graph Resolution
* [ ] Capture exact V8 line and column offset coverage via `node:inspector`.
* [ ] Build recursive Vite SSR module graph parser to walk `export * from` and `export { x } from` re-export edges.

#### Milestone M2.3: Incremental AST Dual-Hash Cache
* [ ] Implement AST function node hashing and test specification AST hashing in Rust/TS.
* [ ] Build local disk cache layer (`.puca/cache.json`) with auto-invalidation.

#### Milestone M2.4: NAPI Cross-Compilation & Packaging
* [ ] Set up GitHub Actions CI workflow for cross-compiling `@puca/binding-*` native addons across macOS, Linux, and Windows.
* [ ] Configure `package.json` `optionalDependencies` publishing matrix for the `puca` package.

#### Milestone M2.5: Terminal UX & Operator Diagnostics
* [ ] Build live terminal dashboard showing $\text{mutants}/\text{sec}$, worker thread statuses, and progress bars.
* [ ] Implement token-aware syntax diff viewer with exact `file:line:col` formatting.
* [ ] Add `--include-untracked` and `--verbose` (operator histogram) CLI options.

#### Milestone M2.6: StrykerJS Benchmark Suite
* [ ] Build automated performance benchmarking harness comparing `puca` vs. `@stryker-mutator/vitest-runner`.
* [ ] Publish benchmark reports verifying wall-clock speedups and memory metrics.