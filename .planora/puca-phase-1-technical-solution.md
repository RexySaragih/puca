# Púca Phase 1 — In-Memory Vitest Mutation Loop

Document status: in-review
Planora board: `.planora/puca-phase-1-1794671137.planora.md`
Plan profile: greenfield
Product: Púca — local mutation-testing loop for ESM/Vitest
Package: `puca` (unscoped npm name; not published this cycle)
Binary / CLI: `puca`
ID namespace: REQ-1xx (repo/hexagon), REQ-2xx (Rust/NAPI mutator), REQ-3xx (targeting), REQ-4xx (Vitest session), REQ-5xx (mutant loop), REQ-6xx (CLI/report/exit); SC-*, NFR-*, ADR-*, UX-*
Companion board: `.planora/puca-phase-1-1794671137.planora.md`

This is an architecture specification (blueprint). It contains schemas, ports, ADRs, and measurable criteria. It does not contain product implementation source to execute as a build.

Grill lock (Q1–Q28, 2026-11-14): local Vitest loop; Phase 1 only; no sandbox copies; oxc via NAPI; Vite plugin injection; no `node:test` / `register()`; git-dirty default; keep-alive sequential related tests; source-first native build; core operator set; schema JSON; exit 0/1/2 as specified.
A6 lock (2026-11-14, confirmed): git-dirty empty → exit 0; empty `--mutate` → exit 2; not a git repo without `--mutate` → exit 2.

---

## 0. Plan envelope

Applicable domains: backend, data, api, integrations, security, operations

Domain inclusion justification:
- backend: CLI process, keep-alive Vitest session, native mutator, sequential mutant orchestration, timeout/respawn
- data: mutation sites, reverse test map, in-memory source buffers, schema JSON report lifecycle (no durable cache)
- api: CLI flags, unexported TestRunnerPort seam, NAPI discover/apply contract, mutation-testing-report-schema
- integrations: project-local Vitest, Git CLI, Oxc, napi-rs
- security: executing mutated user code; mutated source never written to disk; git without shell; plugin only swaps files in the active mutant set
- operations: Node `>=20.6`, pinned Rust toolchain, `npm run build` from source; no npm publish matrix this cycle

Omissions: `ui` — terminal output is a CLI contract (UX-001 under API), not a screen/page/component surface.

Problem: A developer on a TypeScript ESM/Vitest repo needs mutation feedback on the files they just changed, in seconds, without Stryker sandbox copies, Jest, or CI-gate product surface. Missing that loop is project failure.

Users:
- Application developers running `puca` in a Vitest repo before commit
- Púca maintainers building from source (`npm run build`) with a Rust toolchain

Scope: Phase 1 only. Source-first repo; Rust oxc mutator; NAPI bindings; hexagonal TypeScript orchestrator; git-dirty targeting; zero-config Vitest keep-alive with Vite RAM plugin; reverse import map; baseline gate; sequential mutant execution; timeout+respawn; terminal + schema JSON; fixture `fixtures/loop`; no sandbox copies.

Out of scope: `node:test` loader hooks; Jest; V8 coverage maps; warm worker pools; incremental disk cache; CFG/IR equivalence; Rust type pruning; Stryker wall-clock bake-off; HTML reporter; `@puca/*` npm scope; platform `optionalDependencies` prebuilds; `puca.config.ts`; Browser Mode; CJS; Vue/Svelte/Angular SFC; multi-project Vitest monorepos; mutating `.js`/`.mjs`; in-source `import.meta.vitest` tests.

Assumptions:
- A1: MIT license.
- A2: English CLI; flags only (`--mutate`, `--json`, `--timeout`, `--include-untracked`, `--verbose`); no config file. Default git targeting still ignores untracked (Q8); `--include-untracked` is opt-in. `--mutate` walks the tree (untracked included if they match).
- A3: Peer-style Vitest: resolve `vitest/node` from `process.cwd()/node_modules`. Documented floor `vitest >=4` (APIs: `createVitest`, `invalidateFile`, `runTestSpecifications`, `globTestSpecifications`).
- A4: Node engines `>=20.6.0`. Rust stable pinned in `rust-toolchain.toml`.
- A5: Fixture is `environment: 'node'`. Product honors user `node` | `jsdom` | `happy-dom`.
- A6 (locked): Targeting refuse vs idle is three cases, not one “empty list.”
  - Clean git tree, or default targeting with zero eligible files after hard excludes: print `No files to mutate`, five-bucket summary all zeros (0 mutants generated), exit 0. Standard local-dev “nothing to do.”
  - `--mutate <glob>` matches zero files after excludes: diagnostic on stderr, exit 2. Invalid target selector; refused to score.
  - Not a git repository and no `--mutate`: stderr exactly `Not a git repository. Pass --mutate <glob> to specify files.`, exit 2. Unable to determine target files; refused to score.
  - Files whose sites all disable-comment away still count as 0 mutants after a completed run: exit 0.
- A7: `--json` writes the only intentional disk artifact of a run. Mutated sources never touch disk.
- A8: Schema-required `thresholds` are `{ high: 80, low: 60 }` placeholders and do not affect exit codes.
- A9: Windows is best-effort, not a Phase 1 gate.
- A10: `+` on strings is still mutated; runtime throw inside a test is KILLED.
- A11: In-source Vitest tests are unsupported (no special case).
- A12: Clock and IDs are composition-root functions, not ports.

Success criteria (summary; full catalog in §9):
- SC-101: Oxc discovers the Phase 1 operator sites on fixture source.
- SC-102: NAPI applies one site and returns mutated source in RAM.
- SC-103: `puca` with no args mutates git-dirty `.ts`/`.tsx` vs HEAD.
- SC-104: `--mutate` overrides git; fixture uses `--mutate`.
- SC-105: Hard excludes never mutate.
- SC-106: Red baseline exits 2 with Vitest output.
- SC-107: Keep-alive inject + related tests classifies Killed vs Survived on the fixture.
- SC-108: Empty reverse map → NoCoverage, no test run.
- SC-109: Outer timeout → TIMEOUT, Vitest respawn, next mutant.
- SC-110: Terminal lines for Survived/Timeout/Error; five-bucket summary; exit 1 iff ≥1 Survived.
- SC-111: `--json` validates against mutation-testing-report-schema.
- SC-112: Disable comments omit sites.
- SC-113: Zero per-mutant sandbox directories.
- SC-114: Browser Mode / missing Vitest / missing NAPI / `--mutate` miss → exit 2.
- SC-115: Parse+site-discovery p95 <1ms on the fixture’s largest source file.
- SC-116: Not a git repo and no `--mutate` → exit 2 with the A6 stderr line.
- SC-117: Clean git-dirty targeting (zero eligible files) → exit 0, `No files to mutate`, 0 mutants generated.
- SC-118: Sequential mutants on one file do not leak: after mutant 1, mutant 2’s load/transform is exactly mutant 2’s source (R1).

Risks:
- R1: Vite `invalidateFile` misses a graph node → leaked mutant (false Survived/Killed). Mitigate: overlay `maxWorkers: 1` + `isolate: true`; clear plugin buffer then `invalidateFile` after every mutant; SC-118 plugin unit test + fixture E2E (`add` then `subtract`); ERROR on transform collision.
- R2: Vitest API drift across 4.x. Mitigate: resolve project Vitest; pin fixture Vitest; fail closed if `createVitest` missing.
- R3: Barrel files over-include related tests (accepted).
- R4: `globalSetup` invalidation may require respawn (specified).
- R5: ConditionalExpression `while (true)` hangs workers (timeout+respawn specified).
- R6: Native addon absent until `npm run build` (exit 2).

Architecture decisions (index; detail in §3):
- ADR-001: Hexagonal TypeScript orchestrator; Rust is MutatorEngine via NAPI; FakeMutatorEngine for tests.
- ADR-002: Offset mutation sites; lazy per-mutant serialize.
- ADR-003: Resolve `vitest/node` from cwd, never bundle Vitest.
- ADR-004: `createVitest` + `viteOverrides` prepend RAM plugin; user config loaded as-is.
- ADR-005: Reverse test map from baseline transforms; setupFiles/globalSetup attached to the target spec set.
- ADR-006: Source-first NAPI; no platform packages this cycle.
- ADR-007: `--json` is mutation-testing-report-schema.
- ADR-008: Git targeting via `git` subprocess (no shell).
- ADR-009: Forced Vitest overlay for the Púca session only.
- ADR-010: TestRunnerPort is an unexported seam; no `node:module.register()` code.
- ADR-011: Exit 0 / 1 / 2 as Q27 + A6 lock (empty git-dirty is 0, not 2).
- ADR-012: Oxc parser/codegen, not Babel/tsc/SWC.

Delivery strategy: Foundation (repo + hexagon + fakes) → Rust sites/operators/NAPI → targeting → Vitest session/plugin/baseline map → sequential loop/timeout → CLI/report/exit → fixture E2E + no-sandbox proof. Memory adapters before Vitest/Git/NAPI. One inbound use case driven by CLI and a test driver.

---

## 1. Clarify (Clear / Partial / Missing)

Clear: Product job, Phase 1 ship, load-bearing architecture, customer cut, operator set, git-dirty default, Vitest-only injection, keep-alive sequential related tests, timeout/respawn, statuses, JSON schema, disable comments, Vitest overlay, jsdom/happy-dom vs Browser Mode, setupFiles/globalSetup, CLI flags, Vitest resolve-from-cwd, exit codes, terminal lines.

Partial: Clean-tree vs Q27 “empty candidate list” — resolved by A6 (default targeting empty → 0; `--mutate` empty → 2).

Missing: none blocking. Windows notarization and npm publish are out of scope.

---

## 2. Hexagonal architecture (normative)

### 2.1 Dependency rule

```text
adapters → application (use cases + ports) → domain
domain imports nothing from node:*, vitest, vite, napi, oxc, child_process
puca-core (Rust) imports oxc only; it does not know Vitest or Git
```

Cockburn test: `RunMutationSession` runs under a test driver with FakeMutatorEngine, FakeTestRunner, InMemorySourceLocator, RecordingReportWriter — no Vitest, no git, no .node addon.

### 2.2 Inbound port (what the application can do)

```text
RunMutationSession
  input:  MutationSessionInput { cwd, mutateGlob?, jsonPath?, timeoutMs? }
  output: MutationSessionResult { statuses[], exitCode }
```

CLI and the behavioral test driver both call this port. No second inbound port in Phase 1.

### 2.3 Outbound ports (what the application needs) — prod + in-memory

```text
MutatorEnginePort     # discover(file, source) -> Site[]; apply(source, site) -> string
                      # prod: NapiMutatorEngine; mem: FakeMutatorEngine
TestRunnerPort        # unexported seam (ADR-010)
                      # startSession(overlay) -> Session
                      # baseline(specs) -> BaselineResult
                      # runRelated(mutant) -> RunResult
                      # respawn() -> Session
                      # close()
                      # prod: VitestTestRunner; mem: FakeTestRunner
SourceLocatorPort     # candidateFiles(cwd, mutateGlob?) -> AbsolutePath[]
                      # prod: GitDiffLocator; mem: InMemorySourceLocator
WorkspaceFilesPort    # readUtf8, exists, isUnderCwd (isUnderCwd false ⇒ readUtf8 refuses)
                      # prod: NodeWorkspaceFiles (node:fs/promises + path); mem: InMemoryFiles
ReportPort            # writeTerminal(result); writeJson?(path, schemaDoc)
                      # prod: StdioReport + SchemaJsonFile; mem: RecordingReport
```

Clock and mutant ids: functions injected at composition root (not ports).

TestRunnerPort remains in `application/ports/outbound` and is not part of the published CLI API. No Node ESM register adapter is written.

### 2.4 Driving adapters

```text
CLI (process.argv, cwd)  → RunMutationSession
Test driver              → RunMutationSession (same port)
```

### 2.5 Composition root

`src/composition/createRuntime.ts` is the only place prod vs memory adapters are chosen.

```text
createRuntime(options?: { useFakes?: boolean }): Runtime
  useFakes === true  → createTestRuntime()
                       FakeMutatorEngine, FakeTestRunner, InMemorySourceLocator,
                       InMemoryFiles, RecordingReport
  default / false    → NodeWorkspaceFiles, GitDiffLocator, NapiMutatorEngine,
                       VitestTestRunner, StdioReport + SchemaJsonFile
```

CLI calls `createRuntime()` (prod). Behavioral tests call `createRuntime({ useFakes: true })` or `createTestRuntime()` directly. Do not introduce a second set of adapter type names (`ExecGitAdapter`, `NapiOxcMutator`, `VitestRunnerAdapter`, `SchemaJsonReporter` are not in this spec).

### 2.6 Module layout

```text
puca/
├── package.json                 # name: puca, bin: { "puca": "dist/cli.js" }, engines.node >=20.6.0
├── tsconfig.json
├── rust-toolchain.toml
├── Cargo.toml                   # workspace: puca-core, puca-binding
├── crates/
│   ├── puca-core/               # parse, disable comments, sites, operators, apply
│   └── puca-binding/            # napi-rs; discover + apply
├── src/
│   ├── domain/                  # Mutant, Site, MutantStatus, SessionResult (TS)
│   ├── application/
│   │   ├── ports/inbound/RunMutationSession.ts
│   │   ├── ports/outbound/{MutatorEnginePort,TestRunnerPort,SourceLocatorPort,WorkspaceFilesPort,ReportPort}.ts
│   │   └── use-cases/RunMutationSessionUseCase.ts
│   ├── adapters/
│   │   ├── inbound/cli/
│   │   └── outbound/
│   │       ├── memory/
│   │       ├── fs/              # NodeWorkspaceFiles
│   │       ├── napi/
│   │       ├── git/
│   │       ├── vitest/
│   │       └── report/
│   └── composition/createRuntime.ts
├── fixtures/loop/
│   ├── src/                     # mutate targets
│   └── test/                    # vitest tests (hard-excluded)
└── test/                        # behavioral tests against inbound port
```

Import boundary: dependency-cruiser (or eslint-plugin-boundaries) forbids `src/domain` and `src/application` from importing `vitest`, `vite`, `node:child_process`, or the napi binding.

---

## 3. Architecture decisions (ADRs)

ADR-001: Hexagonal TS orchestrator + Rust mutator behind MutatorEnginePort — rationale: operator tests must not boot Vitest; Vitest tests must not reimplement oxc; alternatives: single TS Babel mutator (rejected: oxc is load-bearing), god-object CLI (rejected: untestable loop); consequences: composition root, dual adapters per outbound port; confidence: high.

ADR-002: Sites as `{ file, startOffset, endOffset, mutatorName, replacement }` with lazy apply — rationale: Q14 forbids serializing every mutant at discovery; alternatives: full-file codegen per site up front (fails budget), mutant schemata in source (rejected: not the Phase 1 injection model); consequences: apply is a second NAPI call per mutant; confidence: high.

ADR-003: Resolve `vitest/node` from `cwd/node_modules` — rationale: user’s Vite/Vitest/plugins must match; alternatives: bundle Vitest (version skew), depend on vitest in `puca` (duplicate copies); consequences: missing Vitest → exit 2; confidence: high.

ADR-004: Prepend RAM plugin via `viteOverrides` — rationale: Q18 zero-config; alternatives: user-registered plugin (setup tax), shadow config (breaks aliases); consequences: transform collisions → ERROR; confidence: high.

ADR-005: Reverse map from baseline SSR transforms; setup/global graphs attach to the current spec set — rationale: `getModuleSpecifications(sourceFile)` does not return tests; alternatives: filename heuristic (misses), full suite (violates Q1); consequences: barrel over-include; dynamic import → NoCoverage; confidence: high.

ADR-006: Source-first NAPI (`npm run build` needs rustc) — rationale: Q10; alternatives: optionalDependencies matrix (ops seam), postinstall compile (broken without rustc for consumers — not this cycle’s consumers); confidence: high.

ADR-007: mutation-testing-report-schema JSON — rationale: interchange without HTML; alternatives: private blob (throwaway); consequences: required thresholds fields as placeholders (A8); confidence: high.

ADR-008: `git diff --name-only HEAD` via `child_process.spawn` (`shell: false`) — rationale: matches Q8; alternatives: isomorphic-git (weight), jsdiff vs fs (not git index); consequences: git missing + no `--mutate` → exit 2; confidence: high.

ADR-009: Session overlay `watch:false`, `fileParallelism:false`, `maxWorkers:1`, `isolate:true`, coverage off — rationale: Q23 determinism; fallback to `pool:'forks'` only if fixture proves thread leaks (not a ticket unless E2E fails); confidence: high.

ADR-010: TestRunnerPort unexported; no `register()` implementation — rationale: Q7; consequences: node:test is a named future adapter, not Phase 1 files; confidence: high.

ADR-011: Exit 0 = completed, 0 Survived, 0 Error (including A6 clean git-dirty / 0 mutants); 1 = ≥1 Survived; 2 = refuse or ≥1 Error — rationale: Q27 plus A6 lock (2026-11-14): empty default targeting is idle (0), not refuse (2); empty `--mutate` and not-a-git-repo without `--mutate` are refuse; alternatives: treat every empty candidate list as exit 2 (rejected: trains pre-commit hooks to fail on a clean tree); confidence: high.

ADR-012: Oxc, not tsc/Babel/SWC — rationale: Q3 load-bearing native AST; confidence: high.

---

## 4. Rust mutator engine (`puca-core` + NAPI)

### 4.1 Parse

- `oxc_parser` with `SourceType` from filename (`.ts` vs `.tsx`).
- Invalid parse → no sites; caller marks file-level ERROR if the original file cannot parse (refuse that file, not the whole run unless it was the only file — still report ERROR mutants none; treat as ERROR on a synthetic site or abort file with ERROR count ≥1 → exit 2). Original file parse failure: exit 2 with diagnostic (cannot mutate unparseable source). Mutant apply that produces unparseable output is still injected; Vitest transform throw → ERROR.

REQ-201.

### 4.2 Site discovery

Walk the AST. For each operator match, record a `Site`:
- `id`: stable string `{relpath}:{startOffset}:{mutatorName}:{replacement}`
- `startOffset` / `endOffset` (UTF-8 byte offsets into original source)
- `line` / `column` 1-based from oxc span (schema location)
- `mutatorName`, `original`, `replacement`

Discovery does not stringify mutated files (Q14). NFR-101 / REQ-212: p95 <1ms for parse + walk + record on `fixtures/loop` largest `.ts` (document measured file). Apple Silicon or CI equivalent.

REQ-202, REQ-212, SC-115.

### 4.3 Disable comments (REQ-208, SC-112)

Line-oriented, UTF-8, `//` only (not `/* */`, not Stryker comments).

- `// puca-disable-next-line` — omit sites whose span starts on the next physical line.
- `// puca-disable` — omit sites whose span starts on any later line in that file.

Omitted sites are not mutants, not Ignored, not NoCoverage.

### 4.4 Operator set (REQ-203..207)

ArithmeticOperator (`+ - * / %`): `+`↔`-`, `-`↔`+`, `*`↔`/`, `/`↔`*`, `%`→`*`. Do not mutate unary `+`/`-`. Do not skip string `+` (no types).

EqualityOperator: `==`↔`!=`, `===`↔`!==`, `<`↔`<=` and `<`↔`>=`, `<=`↔`<` and `<=`↔`>`, `>`↔`>=` and `>`↔`<=`, `>=`↔`>` and `>=`↔`<`.

BooleanLiteral: `true`↔`false` (boolean keywords only, not `!` removal).

LogicalOperator: `&&`↔`||`.

ConditionalExpression: predicate of `if (...)`, `while (...)`, `do { } while (...)`, and ternary `cond ? a : b` each yields two sites: replace predicate with `true` and with `false`. Do not mutate `for (;;)` headers in Phase 1.

No StringLiteral, BlockStatement, Regex, optional chaining, JSX structure, assignment operators.

### 4.5 Lazy apply (REQ-209)

`apply(source, site)` splices `replacement` over `[startOffset, endOffset)` in the original string (byte offsets). Do not re-print the whole AST. If offsets are stale, return error → ERROR.

### 4.6 NAPI (REQ-211, SC-102)

```text
discover(filename: string, source: string) -> SiteDto[]
apply(source: string, site: SiteDto) -> string
```

Built by `npm run build` (napi-rs). Missing `.node` at runtime → exit 2.

---

## 5. Targeting (REQ-301..308, SC-103..105, SC-116, SC-117)

Default: `git diff --name-only HEAD` (staged + unstaged) from `cwd`, `shell: false`. Untracked ignored unless `--include-untracked` (`git ls-files --others --exclude-standard`). Keep paths under `cwd` after `path.resolve` (`WorkspaceFilesPort.isUnderCwd`). Filter to `.ts`/`.tsx`.

`--mutate <glob>`: micromatch (or equivalent) from `cwd`; git not consulted.

Hard excludes (non-overridable, even if glob/git hit):
`**/*.{test,spec}.{ts,tsx}`, `**/vitest.config.*`, `**/vite.config.*`, `**/*.d.ts`, `**/node_modules/**`, `**/dist/**`.

Excluded matches are skipped silently (optional debug count, not NoCoverage).

A6 targeting exits (locked):
- Git repo, default targeting, zero eligible files (clean tree or only excluded/test files dirty) → stdout/stderr `No files to mutate` plus five-bucket summary with 0 mutants generated → exit 0 (SC-117).
- `--mutate` matches zero remaining files after excludes → diagnostic on stderr (refused to score) → exit 2.
- Not a git repo and no `--mutate` → stderr exactly `Not a git repository. Pass --mutate <glob> to specify files.` → exit 2 (SC-116).

---

## 6. Vitest session (REQ-401..413)

### 6.1 Resolve and overlay

Load `vitest/node` from the project (createRequire / `import` from `path.join(cwd, 'node_modules/vitest/...')`). Unresolved → exit 2.

`createVitest('test', { watch: false, fileParallelism: false, maxWorkers: 1, isolate: true, coverage: { enabled: false } }, viteOverrides)`.

`viteOverrides.plugins` prepends `pucaRamPlugin`. User config still loads (aliases, setupFiles, environment).

If resolved config has `browser.enabled === true` → close, exit 2.

Honor `environment` `node` | `jsdom` | `happy-dom`. Unknown environment: still run (user’s Vitest problem) unless browser.

`--timeout` overrides outer timer; default `max(testTimeout + 2000, 7000)` with `testTimeout` from loaded config (Vitest default 5000 → 7000 floor).

REQ-401..405, SC-114.

### 6.2 RAM plugin (REQ-406, REQ-407)

Plugin holds `Map<normalizedPath, string | null>` active buffer. At most one path may have a non-null buffer (the active mutant’s file).

On `transform`/`load` for a path with a buffer, return that string (TS/TSX) and skip other work only for that module; do not capture unrelated files.

After each mutant: set the buffer to `null` (or delete the key), then `invalidateFile` again so the next load is original source. R1 / SC-118: a second mutant on the same file must not observe the first replacement in transform, `ssrLoadModule`, or related-test execution.

Never `writeFile` mutant source. JSON report is the only opt-in write.

Transform throw → that mutant ERROR.

### 6.3 Reverse map and baseline (REQ-408..413, SC-106, SC-108)

After session start:

1. `globTestSpecifications()`.
2. Run unmutated related discovery: for each test spec, collect imported module ids via Vite SSR module graph / `transformRequest` (same approach Vitest uses for `--related` dependency walking).
3. Invert to `Map<sourceFile, TestSpecification[]>`.
4. Attach every file in `setupFiles` and `globalSetup` import graphs to **all specs in the current target set** (union of specs related to candidate mutate files; if a setup-only file is itself a candidate, target set is all globbed specs).
5. Related specs for the candidate set: union of map entries. If a candidate source has empty map → all its sites NoCoverage, never run.
6. Baseline: `runTestSpecifications` on the union of specs needed for non-empty maps. Any failing test → print raw Vitest output, exit 2. Do not generate scores.

Dynamic `import()` not visible to the graph → NoCoverage (accepted).

Dirty `globalSetup` (or a file only reachable from it): `respawn()` once before those mutants (REQ-411).

---

## 7. Mutant loop (REQ-501..507, SC-107, SC-109, SC-118)

Sequential. For each site of each candidate file with a non-empty map:

1. `apply` original source → buffer (always from the original file bytes, never from the previous mutant).
2. Plugin set buffer for that file (replace, do not merge with a previous buffer).
3. `invalidateFile(file)` (importers included).
4. Start outer timer.
5. `runTestSpecifications(relatedSpecs)`.
6. Clear buffer; invalidate again.

Invariant (R1): after step 6, a transform/`ssrLoadModule` of that file returns original source. Mutant 2’s related tests must execute original `add()` if mutant 2 only changed `subtract()`.

Classification (mutually exclusive):
- KILLED: at least one related test failed (assertion or SUT throw). Record first failing test id in schema `killedBy`. Bail remaining tests when Vitest allows.
- SURVIVED: all related tests passed.
- TIMEOUT: Púca outer timer fired, or Vitest reported a timeout that required respawn. Abort, `close()`, `createVitest` again, restore overlay+plugin, mark TIMEOUT, do not retry that mutant.
- ERROR: transform throw, apply failure, Vitest crash before results. Print line. Completed run with ≥1 ERROR → exit 2.
- NO_COVERAGE: empty map; assigned without entering the loop.

Do not count TIMEOUT as Killed. Do not exit 1 on TIMEOUT.

---

## 8. CLI, terminal, JSON (REQ-601..610, UX-001)

Invocation: `puca` (no subcommand) relative to `process.cwd()`.

Flags: `--mutate <glob>`, `--json <path>`, `--timeout <ms>`, `--include-untracked`, `--verbose`.

Terminal (UX-001):
- One Survived / Timeout / Error block: `file:line:col` then `- original` / `+ replacement`
- No per-mutant KILLED or NO_COVERAGE lines
- Summary: `Killed`, `Survived`, `Timeout`, `Error`, `No Coverage`
- `--json` schema path: `puca/schema/mutation-report.json`

`--json <path>` writes mutation-testing-report-schema:
- `schemaVersion`: `"2"`
- `files[relpath].language`: `"typescript"`
- `files[relpath].source`: original source
- `mutants[]`: `id`, `mutatorName`, `location` (1-based, start inclusive, end exclusive), `replacement`, `status`
- Status map: Killed, Survived, Timeout, NoCoverage, RuntimeError (all ERROR), CompileError unused unless original parse fails (then no mutants; exit 2 before report)
- `thresholds`: A8
- `framework.name`: `"Púca"`
- Disable-omitted sites absent

Exit:
- 0: completed, 0 Survived, 0 Error (Killed/Timeout/NoCoverage only, or A6 idle: 0 mutants / `No files to mutate`)
- 1: completed, ≥1 Survived
- 2: refuse (baseline red, not a git repo without `--mutate`, Vitest unresolved, Browser Mode, NAPI missing, `--mutate` matched nothing, original parse fail) OR ≥1 Error

A6 stderr (exact, refuse): `Not a git repository. Pass --mutate <glob> to specify files.`
A6 idle (exit 0): `No files to mutate` plus zeroed five-bucket summary.

Priority if both Survived and Error: exit 2 (Error is refuse-to-trust-the-score). Document this: a mixed Survived+Error run is not a clean “tests missed bugs” signal.

---

## 9. Requirements & NFR catalog (stable IDs)

### Repo / hexagon
- REQ-101 Cargo workspace `puca-core` + `puca-binding`; rust-toolchain pin
- REQ-102 `package.json` name `puca`, bin `puca`, engines `>=20.6.0`
- REQ-103 Domain/application import boundary
- REQ-104 Inbound `RunMutationSession`
- REQ-105 Five outbound ports named in §2.3
- REQ-106 In-memory adapter per outbound port
- REQ-107 Composition root `createRuntime({ useFakes?: boolean })` wires CLI (prod) and test driver (fakes)
- REQ-108 Prod `NodeWorkspaceFiles`: `readUtf8`, `exists`, `isUnderCwd` via `node:fs/promises` + `path`; path traversal outside cwd refused
- ADR-001, ADR-006, ADR-010, ADR-012

### Mutator
- REQ-201..212 as §4
- SC-101, SC-102, SC-112, SC-115
- NFR-101 parse+sites p95 <1ms on named fixture file
- ADR-002

### Targeting
- REQ-301..308 as §5
- SC-103, SC-104, SC-105, SC-116, SC-117
- ADR-008, ADR-011 (A6)

### Vitest session
- REQ-401..413 as §6
- SC-106, SC-108, SC-114
- ADR-003, ADR-004, ADR-005, ADR-009

### Loop
- REQ-501..507 as §7
- SC-107, SC-109, SC-118
- NFR-103 two cold fixture runs → identical statuses
- NFR-102 zero sandbox dirs / zero mutant source writes

### CLI / report
- REQ-601..610 as §8
- SC-110, SC-111, SC-113
- UX-001
- ADR-007, ADR-011
- NFR-104 no HTML reporter shipped

---

## 10. Security trust boundaries

| Boundary | Trust | Controls |
|----------|-------|----------|
| User project source + tests | Untrusted code, intentionally executed | Never write mutants to disk; hard excludes; overlay isolate; `isUnderCwd` |
| `git` subprocess | Local git | `shell: false`; argv only |
| Project `node_modules/vitest` | User-installed | Resolve from cwd; do not download Vitest |
| NAPI `.node` | Built by maintainer | Missing addon fail closed (exit 2) |
| `--json` path | User-chosen write | Write only that path; no other reports |

Forbidden: `eval` of user source in the CLI process outside Vitest; `shell: true` git; sandbox temp trees; swapping buffers for files not in the active site.

---

## 11. Failure and retry policy (backend)

- Baseline fail: exit 2, no mutant loop.
- Outer timeout: respawn Vitest, TIMEOUT, continue (no retry of that mutant).
- Transform/plugin collision: ERROR, continue other mutants, final exit 2.
- Vitest crash: treat as ERROR, respawn, continue.
- No retry storms. One respawn per TIMEOUT/crash, then next mutant.

---

## 12. Operations

- Environments: local source build only.
- Config: CLI flags; Vitest config from cwd.
- Observability: stderr diagnostics for exit 2; terminal summary.
- Rollback: n/a (unpublished).
- Build: `npm run build` compiles TS + napi. `npm test` runs Rust tests + TS behavioral tests + fixture E2E.
- Publish/prebuilds: out of scope.

---

## 13. Test strategy (hexagonal)

- Rust: operator golden snippets; disable-comment fixtures; offset apply; parse bench on fixture file.
- Use-case: `RunMutationSession` + FakeMutatorEngine + FakeTestRunner — git-dirty selection, baseline exit 2, status taxonomy, exit codes, disable omissions, empty map NoCoverage.
- Adapter: GitDiffLocator with a temp git repo (A6 idle / empty `--mutate` / not-a-git-repo); NodeWorkspaceFiles path traversal; SchemaJsonFile AJV validate; Vitest resolver failure; RAM plugin leak (SC-118) via transform/`ssrLoadModule` after mutant 1 then mutant 2.
- E2E: `fixtures/loop` via `puca --mutate 'fixtures/loop/src/**/*.ts'` — known Killed/Survived; `while (true)` TIMEOUT; uncovered file NoCoverage; tmp-dir walker asserts no mutant sandbox; two cold runs match; sequential `add` then `subtract` leak proof (mutant 2’s tests see original `add`).

---

## 14. Open items

None blocking. A6 lock is confirmed (clean git-dirty → 0; empty `--mutate` → 2; not a git repo without `--mutate` → 2). Pool `forks` fallback is only if SC-118 leak-fails (fix in the Vitest adapter ticket, do not pre-build a second pool).

End of technical solution.
