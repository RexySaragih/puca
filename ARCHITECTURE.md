# Púca — Architecture

Phase 1 architecture for the in-memory Vitest mutation loop. Normative detail and REQ/SC/ADR catalogs: `.planora/puca-phase-1-technical-solution.md`.

---

## Big picture

```mermaid
flowchart LR
  Drivers["CLI / test driver"] --> UC["RunMutationSessionUseCase<br/>(application)"]
  UC --> Domain["domain<br/>Site · Mutant · SessionResult"]
  UC --> Ports["Outbound ports"]
  Ports --> Mutator["NapiMutatorEngine<br/>puca-core via NAPI"]
  Ports --> Runner["VitestTestRunner<br/>+ RAM plugin"]
  Ports --> Locator["GitDiffLocator"]
  Ports --> Files["NodeWorkspaceFiles"]
  Ports --> Report["StdioReport + SchemaJsonFile"]
```

- **TypeScript** owns orchestration (hexagonal).
- **Rust (`puca-core`)** owns parse + site discovery + lazy apply (oxc).
- **napi-rs (`puca-binding`)** exposes `discover` / `apply` to Node.
- **Vitest** is resolved from the **user project** `cwd`, never bundled.

---

## Dependency rule

```mermaid
flowchart BT
  Domain["domain"]
  Application["application<br/>(ports + use cases)"]
  Adapters["adapters"]
  Adapters --> Application --> Domain
```

- `domain` imports nothing from `node:*`, `vitest`, `vite`, napi, or `child_process`.
- `application` stays free of those too (enforced by `npm run lint:deps` / dependency-cruiser).
- `puca-core` knows oxc only — not Vitest or Git.

Cockburn test: `createRuntime({ useFakes: true })` runs `RunMutationSession` with memory adapters only.

```mermaid
flowchart LR
  subgraph prod [createRuntime]
    P1[NodeWorkspaceFiles]
    P2[GitDiffLocator]
    P3[NapiMutatorEngine]
    P4[VitestTestRunner]
    P5[StdioReport + SchemaJsonFile]
  end
  subgraph fakes ["createRuntime({ useFakes: true })"]
    F1[InMemoryFiles]
    F2[InMemorySourceLocator]
    F3[FakeMutatorEngine]
    F4[FakeTestRunner]
    F5[RecordingReport]
  end
```

---

## Module layout

```mermaid
flowchart TB
  subgraph src [src]
    domain[domain]
    app[application/ports + use-cases]
    adapters[adapters inbound/outbound]
    composition[composition/createRuntime]
    cli[cli.ts]
  end
  subgraph crates [crates]
    core[puca-core]
    binding[puca-binding]
  end
  fixtures[fixtures/loop]
  tests[test/]
  cli --> composition --> adapters --> app --> domain
  adapters --> binding --> core
  tests --> cli
  tests --> fixtures
```

Composition root is the **only** place that chooses prod vs fake adapters. Do not invent alternate type names (`ExecGitAdapter`, `NapiOxcMutator`, …).

---

## Ports

| Port | Responsibility | Prod | Fake |
| --- | --- | --- | --- |
| `RunMutationSession` | Inbound: run a session | CLI + tests | — |
| `MutatorEnginePort` | `discover` / `apply` | `NapiMutatorEngine` | `FakeMutatorEngine` |
| `TestRunnerPort` | Session, reverse map, baseline, runRelated, respawn (**unexported**) | `VitestTestRunner` | `FakeTestRunner` |
| `SourceLocatorPort` | Candidate files | `GitDiffLocator` | `InMemorySourceLocator` |
| `WorkspaceFilesPort` | `readUtf8` / `exists` / `isUnderCwd` | `NodeWorkspaceFiles` | `InMemoryFiles` |
| `ReportPort` | Terminal (+ optional JSON); File Summary is StdioReport-only (ADR-030), not a port method | `StdioReport` + `SchemaJsonFile` | `RecordingReport` |

Clock / IDs are composition helpers, not ports (A12).

```mermaid
flowchart LR
  Inbound["RunMutationSession"] --> UC[Use case]
  UC --> M[MutatorEnginePort]
  UC --> T[TestRunnerPort]
  UC --> S[SourceLocatorPort]
  UC --> W[WorkspaceFilesPort]
  UC --> R[ReportPort]
```

---

## Session pipeline

```mermaid
flowchart TD
  A[Locate candidates] --> B{Empty / A6?}
  B -->|idle| Z0[exit 0]
  B -->|refuse| Z2a[exit 2]
  B -->|ok| C[Start Vitest + RAM plugin]
  C --> D{Browser / missing Vitest?}
  D -->|yes| Z2b[exit 2]
  D -->|no| E[Build reverse map]
  E --> F[Baseline unmutated]
  F -->|fail| Z2c[exit 2 + Vitest output]
  F -->|pass| G[Discover sites]
  G --> H{Related specs?}
  H -->|none| NC[NoCoverage]
  H -->|yes| L[Mutant loop]
  L --> L1[apply from original]
  L1 --> L2[set buffer + invalidate]
  L2 --> L3[runRelated + outer timer]
  L3 --> L4[clear buffer + invalidate]
  L4 --> L5{Timeout?}
  L5 -->|yes| L6[respawn · no retry]
  L5 -->|no| L7[classify status]
  L6 --> L7
  L7 --> Next{More sites?}
  Next -->|yes| L
  Next -->|no| Rep[Report + exit 0/1/2]
  NC --> Rep
```

Site id: `{relpath}:{startOffset}:{mutatorName}:{replacement}`.

---

## Mutator (Rust)

- Parse with oxc; `.ts` vs `.tsx` `SourceType` from extension.
- Sites are **UTF-8 byte offsets** into the original source — discovery does not serialize mutants (ADR-002).
- Operators: arithmetic, equality, boolean, logical, conditional predicates (not `for` headers).
- **ADR-029:** `visit_template_literal` does not walk `${…}` expressions (tagged and untagged); non-template operators including string `+` still discover.
- `apply` splices `replacement` over `[start, end)` — no full AST reprint.
- Disable comments are line-oriented `//` only.

```mermaid
sequenceDiagram
  participant TS as NapiMutatorEngine
  participant NAPI as puca-binding
  participant Core as puca-core
  TS->>NAPI: discover(filename, source)
  NAPI->>Core: parse + operators + disable filter
  Core-->>NAPI: Site[]
  NAPI-->>TS: SiteDto[]
  TS->>NAPI: apply(source, site)
  NAPI->>Core: byte-offset splice
  Core-->>NAPI: mutated string
  NAPI-->>TS: string (RAM only)
```

Missing `.node` after clone → exit 2 until `npm run build`.

---

## Architecture decisions (index)

| ID | Decision |
| --- | --- |
| ADR-001 | Hexagonal TS; Rust behind `MutatorEnginePort` |
| ADR-002 | Offset sites; lazy apply |
| ADR-003 | Resolve Vitest from cwd |
| ADR-004 | Prepend RAM plugin via `viteOverrides` |
| ADR-005 | Reverse map from baseline graph; setup/global attach |
| ADR-006 / ADR-020 | Source-build for contributors; GHA packed `puca-<abi>` tarballs via GitHub Releases; **no** npm registry publish |
| ADR-007 | `--json` = mutation-testing-report-schema |
| ADR-008 | Git via `spawn` `shell:false` |
| ADR-009 | Forced session overlay for determinism |
| ADR-010 | `TestRunnerPort` unexported; no `register()` |
| ADR-011 | Exit 0/1/2 + A6 idle vs refuse |
| ADR-012 | Oxc, not Babel/tsc/SWC |
| ADR-029 | Skip all TemplateLiteral `${…}` expressions unconditionally; no CLI flag |
| ADR-030 | File Summary table is StdioReport presentation only; Kill% not domain; ReportPort unchanged |

---

## Risks (load-bearing)

| ID | Risk | Mitigation |
| --- | --- | --- |
| R1 | Mutant leak across sequential applies | Clear buffer + invalidate; maxWorkers 1; SC-118 tests + fixture |
| R2 | Vitest API drift | Resolve project Vitest; fail closed |
| R5 | Hang mutants (`while (true)`) | Outer timeout + cancel/respawn |
| R6 | Missing native addon | Exit 2 until build |

```mermaid
flowchart LR
  M1[Mutant 1 buffer] --> Clear[Clear + invalidate]
  Clear --> M2[Mutant 2 from original bytes]
  M2 --> Proof["Transform sees only mutant 2<br/>(R1 / SC-118)"]
```

---

## Testing strategy

Behavioral tests under `test/` drive `RunMutationSession` (or focused adapters) with fakes at I/O boundaries. Mock Vitest/Git/NAPI only at those edges — not internal use-case wiring.

```mermaid
flowchart LR
  Test["test/*.test.ts"] --> Inbound[RunMutationSession]
  Inbound --> Fakes[Memory adapters]
  E2E["e2e.loopFixture"] --> CLI["dist/cli.js"]
  CLI --> Prod[Prod adapters]
  Prod --> Fixture[fixtures/loop]
```

E2E: `test/e2e.loopFixture.test.ts` spawns `dist/cli.js` against `fixtures/loop` and checks the oracle, no-sandbox walk, determinism, and leak proof.
