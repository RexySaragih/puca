# Púca Phase 3.4 — Final Phase 3 Consolidation (Native HTML, Cache, Workspace, Jest)

Document status: in-review
Planora board: `.planora/puca-phase-3-4-1794712087.planora.md`
Plan profile: feature
Product: Púca — Vitest-first local mutation loop; Phase 3.4 adds opt-in HTML/cache/workspace/Jest
Package: `puca` (unscoped; **not published to npm in Phase 3**)
Binary / CLI: `puca`
ID namespace: REQ-17xx (HTML), REQ-18xx (cache), REQ-19xx (workspace), REQ-20xx (Jest/runner); SC-341..348; NFR-34x; ADR-034..038; UX-006
Companion board: `.planora/puca-phase-3-4-1794712087.planora.md`
Prior specs: Phases 1–3.3 remain normative except where this document adds opt-in flags
Phase 3 roadmap: `.planora/puca-phase-3-technical_proposal.md`

This is an architecture specification. It is not implementation source.

Grill lock (2026-11-15): Phase 3.4 is the **last** Phase 3 slice (no 3.5). Five ordered waves: A HTML → B cache → C workspace → D Jest → E closeout. Native static HTML (zero `@stryker-mutator/*` UI). Keep unscoped `mutation-testing-report-schema` for `--json`. npm publish / OIDC / git `optionalDependencies` deferred to **Phase 4**. Vitest-first; Jest opt-in single-worker.

---

## 0. Plan envelope

Applicable domains: ui, backend, data, api, integrations, security, operations

Domain inclusion justification:
- ui: offline static HTML report (filters, diffs, file tree) — CLI artifact, not a hosted product site
- backend: use-case orchestration for cache hits, workspace multi-session, Jest runner
- data: `.puca/cache.json` metadata; embedded SessionResult JSON in HTML
- api: new CLI flags; additive ReportPort.writeHtml; CachePort; WorkspaceDiscoveryPort
- integrations: resolve jest from cwd; workspace manifest parsers (pnpm/npm/yarn)
- security: still executes user tests; cache must never store mutated source; no CDN in HTML
- operations: GitHub Releases remain distribution; docs closeout; zero npm publish in 3.4

Problem: Finish Phase 3 with opt-in native HTML, incremental cache, monorepo workspace runs, and a Jest adapter — without Stryker UI deps and without unlocking npm registry publish.

Users:
- Local Vitest developers (default path unchanged)
- CI engineers already on 3.3 gates/SARIF who want `--html`
- Monorepo and Jest-legacy maintainers opting into `--workspace` / `--runner jest`

Scope: Waves A–E as locked in grill Q12–Q19 / SC-341..348.

Out of scope: npm publish/OIDC/optionalDependencies; `@stryker-mutator/*` packages; CDN HTML assets; Jest multi-worker pool; Phase 3.5; changing A6 / default no-flag exits; storing mutated source in cache.

Assumptions:
- A1–A40 from Phases 1–3.3 remain unless named here.
- A41: `--html` non-empty path; self-contained single file; inline CSS/JS; SessionResult embedded as JSON.
- A42: `--cache` off by default; key = hash(normalized target span AST) ⊕ hash(related test contents) ⊕ engineVersion; status metadata only; corrupt → fail open.
- A43: `--workspace` sequential per-package sessions; exit worst-of 2>1>0; per-package `.puca/cache.json` when `--cache`.
- A44: `--runner` omit → vitest; `jest` → JestTestRunner; unknown → exit 2; jest + workers>1 → notice + force 1.
- A45: `fixtures/jest-loop` is the Jest oracle fixture; missing jest in cwd → exit 2.
- A46: ReportPort path is `src/application/ports/outbound/ReportPort.ts` (additive methods only).

Success criteria: SC-341..348 (§9).

Risks:
- R23: HTML template bloat / incomplete generation — mitigate: full-output skill; fixture snapshot size budget in tests.
- R24: Cache false hits after test edits missed by hash — mitigate: include related test contents; version bump wipe.
- R25: Workspace discovery false roots — mitigate: only declared workspace members matching glob; fail closed if none match (exit 2).
- R26: Jest transformer leak across mutants — mitigate: clear module registry / isolate per mutant; SC-343 + no-sandbox walk.
- R11: Accidental npm publish — mitigate: SC-347 grep; Wave E audit.

Architecture decisions:
- ADR-034: Native self-contained HTML; ban scoped Stryker UI; keep mutation-testing-report-schema for JSON.
- ADR-035: CachePort + FileHashCache; metadata only; opt-in `--cache`.
- ADR-036: WorkspaceDiscoveryPort + sequential multi-session; worst-of exit.
- ADR-037: JestTestRunner single-worker; soft force workers=1 with stderr notice.
- ADR-038: Phase 3 distribution stays GitHub Releases only; npm → Phase 4.

Delivery strategy: Wave A → B → C → D → E (strict Depends-on).

Worker skills (Build agents — load before implementing):

| Wave | Skills to load |
| --- | --- |
| A (HTML UI) | `antislop-ui`, `antislop-human`, `frontend-design` or `minimalist-ui`, `full-output-enforcement`, `sentinel`, `hexagonal-architecture`, `lean-build` |
| B (cache) | `hexagonal-architecture`, `lean-build`, `bdd-unit-test`, `sentinel` |
| C (workspace) | `hexagonal-architecture`, `lean-build`, `bdd-unit-test` |
| D (Jest) | `hexagonal-architecture`, `lean-build`, `bdd-unit-test`, `sentinel` |
| E (closeout) | `verify-and-stop`, `antislop-code` (docs/comment hygiene only if touching code), `lean-build` |

---

## 1. Clarify

Clear: Waves; zero scoped Stryker UI; schema retained; npm out; Vitest-first; HTML/cache/workspace/Jest contracts; SC catalog; skills for workers.

Partial: none blocking.

Missing: none blocking.

---

## 2. Hexagon (delta)

Additive / new only:

| Seam | Location |
| --- | --- |
| `ReportPort.writeHtml?` | `src/application/ports/outbound/ReportPort.ts` |
| `HtmlFile` | `src/adapters/outbound/report/HtmlFile.ts` |
| `CachePort` | `src/application/ports/outbound/CachePort.ts` |
| `FileHashCache` | `src/adapters/outbound/cache/FileHashCache.ts` |
| `WorkspaceDiscoveryPort` | `src/application/ports/outbound/WorkspaceDiscoveryPort.ts` |
| Discovery adapter | `src/adapters/outbound/workspace/` |
| `WorkspaceTargetResolver` | `src/application/` service or use-case orchestration |
| `JestTestRunner` | `src/adapters/outbound/jest/JestTestRunner.ts` (or `runner/`) |
| `fixtures/jest-loop` | new fixture tree |

`createRuntime` selects Vitest vs Jest runner from input; wires cache/html when flags set.

---

## 3. Architecture decisions

ADR-034: Native HTML exporter — rationale: grill Q1=A, Q5=A; ban `@stryker-mutator/*` UI while keeping JSON schema package. Alternatives: elements package (rejected); HTML+asset dir (rejected). Consequences: inline template ownership; SC-341/348. Confidence: high.

ADR-035: Opt-in metadata cache — rationale: Q6–Q7; RAM mutant invariant. Alternatives: always-on; file-level only. Consequences: `.puca/cache.json` allowed disk write alongside `--json`/`--sarif`/`--html`. Confidence: high.

ADR-036: Sequential workspace sessions — rationale: Q8=A; ADR-003 per cwd. Alternatives: single multi-root session; parallel packages. Consequences: worst-of exit; per-package cache files. Confidence: high.

ADR-037: Jest single-worker — rationale: Q9=B, Q16=A. Alternatives: full fork pool parity. Consequences: notice + force workers=1; class name JestTestRunner. Confidence: high.

ADR-038: No npm in Phase 3 — rationale: Q2=B. Alternatives: OIDC in 3.4. Consequences: SC-347; Phase 4 owns publish. Confidence: high.

---

## 4. Wave A — HTML (REQ-17xx)

- Flag `--html <path>`: non-empty; else exit 2 with html diagnostic (same family as sarif).
- `HtmlFile.writeHtml`: one file; inline `<style>`/`<script>`; embed SessionResult JSON; status filters; per-mutant diffs; file navigation.
- Combinable with `--json` / `--sarif`; terminal always on.
- Zero network in generated page; zero `@stryker-mutator/*` imports in repo for this feature.

---

## 5. Wave B — Cache (REQ-18xx)

- Flag `--cache` boolean, default off.
- `FileHashCache` under package cwd `.puca/cache.json`.
- Discover always; on hit skip test run and reuse status; on miss score + set.
- Corrupt/unreadable → ignore, full score, rewrite; no exit 2.
- Never store mutated source strings.

---

## 6. Wave C — Workspace (REQ-19xx)

- Flag `--workspace <glob>`: non-empty; discover roots from pnpm-workspace.yaml / package.json workspaces / yarn; filter by glob.
- Zero matches after filter → exit 2.
- Sequential `RunMutationSession` (or equivalent) per package cwd.
- Aggregate summaries; process exit = max severity (2>1>0).
- With `--cache`, each package uses its own `.puca/cache.json`.

---

## 7. Wave D — Jest (REQ-20xx)

- `--runner vitest|jest`; omit → vitest; unknown/missing value → exit 2.
- `JestTestRunner`: RAM module interception; no sandbox dirs; workers forced to 1 with stderr notice if N>1.
- Resolve jest from cwd; missing → exit 2.
- `fixtures/jest-loop` e2e oracle.

---

## 8. Requirements catalog (summary)

| Family | IDs | Theme |
| --- | --- | --- |
| REQ-17xx | 1701–1705 | html path, HtmlFile, writeHtml, coexistence, no Stryker UI |
| REQ-18xx | 1801–1805 | --cache, CachePort, key formula, fail open, no mutant source |
| REQ-19xx | 1901–1905 | --workspace, discovery, sequential sessions, worst-of exit, per-pkg cache |
| REQ-20xx | 2001–2006 | --runner, JestTestRunner, force workers 1, jest-loop, missing jest refuse |

---

## 9. Success criteria

| ID | Criterion |
| --- | --- |
| SC-341 | `--html <path>` one static HTML; zero `@stryker-mutator/*`; zero network in artifact. |
| SC-342 | `--cache` updates `.puca/cache.json` metadata; second run skips unchanged sites; no mutated source in file. |
| SC-343 | `--runner jest` scores `fixtures/jest-loop` in RAM; single-worker; no sandbox dirs. |
| SC-344 | `--workspace <glob>` sequential per-package; worst-of exit. |
| SC-345 | Invalid `--html` / `--runner` / `--workspace` / `--break-on-score` / `--sarif` → exit 2. |
| SC-346 | No-flag `puca` matches Phase 1–3.3 defaults. |
| SC-347 | No npm publish / OIDC / git optionalDependencies in 3.4; GitHub Releases remain distribution. |
| SC-348 | No `@stryker-mutator/*`; `mutation-testing-report-schema` may remain for `--json`. |

---

## 10. Traceability → waves

| Wave | Covers |
| --- | --- |
| A | REQ-17xx, SC-341, SC-345 (html path), ADR-034, UX-006 |
| B | REQ-18xx, SC-342, ADR-035 |
| C | REQ-19xx, SC-344, ADR-036 |
| D | REQ-20xx, SC-343, ADR-037 |
| E | SC-345..348, ADR-038, docs |

---

## 11. Explicit non-goals (Phase 3.4 / end of Phase 3)

npm publish · OIDC · optionalDependencies · scoped Stryker UI · CDN HTML · Jest worker pool · Phase 3.5 · always-on cache · storing mutants on disk.
