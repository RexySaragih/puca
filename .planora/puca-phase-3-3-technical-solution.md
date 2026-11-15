# Púca Phase 3.3 — Opt-In CI Gates & SARIF

Document status: in-review
Planora board: `.planora/puca-phase-3-3-1794711350.planora.md`
Plan profile: feature
Product: Púca — local mutation-testing loop for ESM/Vitest
Package: `puca` (unscoped; **not published to npm this cycle**)
Binary / CLI: `puca`
ID namespace: REQ-14xx (CLI gates/flags), REQ-15xx (exit/gates), REQ-16xx (SARIF); SC-331..338; NFR-33x; ADR-031..033; UX-005
Companion board: `.planora/puca-phase-3-3-1794711350.planora.md`
Phase 1–3.2 specs: still normative except exit composition when opt-in gates are set
Phase 3.1 distribution: unchanged (GitHub Release tarballs only)
Phase 3 roadmap map: `.planora/puca-phase-3-technical_proposal.md`

This is an architecture specification. It is not implementation source.

Grill lock (2026-11-15): Phase 3.3 is hired for the **CI / platform engineer**. Centerpiece: opt-in `--break-on-score`, `--fail-on-no-coverage`, and `--sarif <path>`. Default no-flag `puca` stays Phase 1–3.2. HTML deferred to 3.4. No npm publish.

---

## 0. Plan envelope

Applicable domains: backend, data, api, integrations, security, operations

Domain inclusion justification:
- backend: gate evaluation in RunMutationSessionUseCase; pure evaluateQualityGates helper
- data: SessionResult statuses; SARIF file write; no cache
- api: new CLI flags; additive ReportPort.writeSarif; --json unchanged
- integrations: GitHub Code Scanning consumes SARIF (file artifact only; no GitHub API client)
- security: still executes user tests; SARIF paths must not escape product write norms (explicit path from user)
- operations: docs for CI usage; no GHA publish unlock

Omissions: `ui` — SARIF/terminal are CLI/API contracts, not screens. HTML reporter is out (3.4).

Problem: CI buyers need opt-in score / NoCoverage merge gates and Survived annotations for PR Code Scanning, without changing the local zero-flag pre-commit loop.

Users:
- CI/platform engineers wiring `puca` in pipelines with gates + SARIF
- App developers who keep running bare `puca` unchanged
- Maintainers proving SC-337 non-regression on fixtures/loop

Scope: parseArgs + MutationSessionInput for three flags; validate break-on-score and sarif path (exit 2); evaluateQualityGates + use-case exit composition; SarifFile adapter; ReportPort.writeSarif?; CompositeReport + createRuntime + RecordingReport; behavioral tests; PRODUCT/ARCHITECTURE/AGENTS/README.

Out of scope: HTML / mutation-testing-elements; `--report` family; npm publish / optionalDependencies / `@puca/*`; cache; Jest; `--workspace`; changing A6 idle/refuse; weakening Survived→1; rewriting `--json` thresholds from `--break-on-score`; GHA distribution matrix changes; magic default SARIF path.

Assumptions:
- A1–A33 from Phases 1–3.2 remain unless this document names a delta.
- A34: Session score = Killed / (Killed + Survived) × 100 (Timeout / NoCoverage / RuntimeError excluded); aligns with 3.2 File Kill%.
- A35: (Killed + Survived) == 0 → score N/A; `--break-on-score` does not fail.
- A36: Exit priority: any RuntimeError or pre-score refuse → 2; else Survived≥1 OR score `< n` OR (failOnNoCoverage && NoCoverage≥1) → 1; else 0.
- A37: `--break-on-score` integer 1..100 inclusive; else exit 2 with exact stderr family naming the flag.
- A38: `--sarif` requires non-empty path; else exit 2; no `./puca-report.sarif` default.
- A39: SARIF results = Survived only, level `error`, physical location line/col.
- A40: Schema JSON thresholds stay `{ high: 80, low: 60 }` placeholders (Phase 1 A8).

Success criteria (summary; catalog in §9): SC-331..338.

Risks:
- R20: Gate logic duplicated in CLI — mitigate: sole authority in use case (ADR-032).
- R21: SARIF schema drift / GitHub reject — mitigate: minimal 2.1.0 document; validate shape in tests; Survived-only.
- R22: Accidental HTML dep — mitigate: SC-338 audit; HTML not in Files.
- R11 remains: no npm publish in workflows.

Architecture decisions (index; detail in §3):
- ADR-031: Opt-in CI flags; default path unchanged.
- ADR-032: evaluateQualityGates + use-case exit authority; Survived never suppressed.
- ADR-033: Additive writeSarif? + SarifFile; Survived-only SARIF; explicit `--sarif <path>`.

Delivery strategy: CLI parse/validate → gates in use case → SARIF port/adapter → E2E + docs.

---

## 1. Clarify (Clear / Partial / Missing)

Clear: Buyer; mission; flags; validation stderr; score formula; N/A denom; exit matrix; SARIF scope; ReportPort additive; --json decoupling; HTML→3.4; distribution frozen; SC/tickets.

Partial: none blocking.

Missing: none blocking.

---

## 2. Hexagon (delta)

No new inbound port. Deltas:

- `src/adapters/inbound/cli/parseArgs.ts` (+ `src/cli.ts` wiring) — flags + refuse diagnostics
- `src/application/ports/inbound/RunMutationSession.ts` — optional `breakOnScore?`, `failOnNoCoverage?`, `sarifPath?`
- `src/application/` pure helper `evaluateQualityGates` (or under `application/services/`) — no I/O
- `src/application/use-cases/RunMutationSessionUseCase.ts` — final exitCode via helper after statuses known; call `report.writeSarif` when path set
- `src/application/ports/outbound/ReportPort.ts` — **add** `writeSarif?(path, result)`; keep `writeTerminal`, `writeJson?`, `writeNotice?`, `writeSessionStart?`, `writeMutantResult?`
- `src/adapters/outbound/report/SarifFile.ts` — new
- `CompositeReport`, `RecordingReport`, `createRuntime` — wire SARIF

Do **not** rename methods to `notice` / `progress` / `writeReport`. Path is `src/application/ports/outbound/ReportPort.ts` (not `src/ports/...`).

---

## 3. Architecture decisions

ADR-031: Opt-in CI surface — rationale: grill Q1–Q3; local buyer must not see new defaults. Alternatives: always-on score gate (rejected). Consequences: no-flag oracle identical to 3.2 (SC-337). Confidence: high.

ADR-032: Use-case exit authority + independent Survived — rationale: Q6–Q8, Q12; single exit story for CLI and tests. Alternatives: CLI rewrite exit (rejected). Consequences: MutationSessionInput carries gate fields; RuntimeError still wins 2; Survived always contributes to exit 1. Confidence: high.

ADR-033: Explicit `--sarif <path>` + Survived-only SARIF via additive port — rationale: Q9=D, Q13–Q14, Q19–Q20; avoid `--report` collision with `--json`; avoid Code Scanning noise. Alternatives: `--report sarif`; default cwd file; include NoCoverage in SARIF. Consequences: SarifFile naming mirrors SchemaJsonFile; missing path → exit 2. Confidence: high.

---

## 4. CLI (REQ-14xx)

| Flag | Rules |
| --- | --- |
| `--break-on-score <n>` | Integer 1..100. Invalid → exit 2, stderr: `Error: Invalid value for --break-on-score. Expected integer between 1 and 100, received '<value>'.` |
| `--fail-on-no-coverage` | Boolean switch; no value. |
| `--sarif <path>` | Non-empty path. Missing/empty → exit 2, stderr: `Error: Invalid value for --sarif. Expected a valid file path, received empty or missing argument.` |

`--json <path>` unchanged. No `--report`.

---

## 5. Score & gates (REQ-15xx)

```text
score = (Killed + Survived) == 0
  ? N/A
  : round(100 * Killed / (Killed + Survived))   // Math.round; same spirit as File Kill%
```

`evaluateQualityGates({ killed, survived, noCoverage, hasRuntimeError }, { breakOnScore?, failOnNoCoverage? })`:

1. If hasRuntimeError (or caller already refused pre-score with exit 2) → 2  
2. If survived ≥ 1 → 1  
3. If breakOnScore != null && score is number && score < breakOnScore → 1  
4. If failOnNoCoverage && noCoverage ≥ 1 → 1  
5. Else → 0  

Pre-score refuse paths (A6 empty mutate, not-a-git, red baseline, missing Vitest/NAPI, bad flags) remain exit 2 **before** gate evaluation.

Idle empty statuses → exit 0; gates with no mutants: score N/A; fail-on-no-coverage with 0 NoCoverage → 0.

---

## 6. SARIF (REQ-16xx)

`SarifFile.writeSarif(path, result)`:

- SARIF version `2.1.0`
- One run; tool driver name `puca` (version from package when practical)
- One result per Survived mutant: `level: "error"`, message includes mutator + original→replacement (or site id), locations physical uri (file path as reported; prefer cwd-relative or absolute consistently — pick **absolute file URI** or path string GitHub accepts; document in adapter), `startLine` / `startColumn` from site (1-based)
- No results for Killed / Timeout / NoCoverage / RuntimeError
- Create/overwrite only when `--sarif` provided; never write when omitted

Use case calls `writeSarif` after terminal/json the same way it calls `writeJson` when path set.

---

## 7. Requirements catalog

### REQ-14xx

| ID | Requirement |
| --- | --- |
| REQ-1401 | parseArgs accepts `--break-on-score`, `--fail-on-no-coverage`, `--sarif`. |
| REQ-1402 | Invalid break-on-score → exit 2 + specified stderr. |
| REQ-1403 | Missing/empty sarif path → exit 2 + specified stderr. |
| REQ-1404 | No-flag parse result has undefined breakOnScore, false/undefined failOnNoCoverage, undefined sarifPath. |

### REQ-15xx

| ID | Requirement |
| --- | --- |
| REQ-1501 | Session score formula A34; N/A when denom 0. |
| REQ-1502 | Exit composition A36; Survived never suppressed by score ≥ n. |
| REQ-1503 | evaluateQualityGates is pure (no I/O); use case is sole exit authority for scored runs. |

### REQ-16xx

| ID | Requirement |
| --- | --- |
| REQ-1601 | ReportPort gains optional writeSarif only (additive). |
| REQ-1602 | SarifFile emits 2.1.0 Survived-only error results with line/col. |
| REQ-1603 | No SARIF file when flag omitted. |
| REQ-1604 | --json thresholds remain placeholders; not driven by break-on-score. |

---

## 8. NFR / UX

| ID | Requirement |
| --- | --- |
| NFR-331 | No new runtime dependency for HTML/elements. |
| NFR-332 | Workflows still contain no npm publish / NPM_TOKEN. |
| NFR-333 | git package.json has no optionalDependencies. |
| UX-005 | Gate refuse diagnostics name the flag on stderr (SC-331 / sarif path). |

---

## 9. Success criteria catalog

| ID | Criterion |
| --- | --- |
| SC-331 | Invalid `--break-on-score` → exit 2 + stderr diagnostic. |
| SC-332 | `--break-on-score 80` with score 75 → exit 1; RuntimeError → 2. |
| SC-333 | Denom 0 + `--break-on-score` → N/A, does not force exit 1. |
| SC-334 | `--fail-on-no-coverage` with ≥1 NoCoverage → exit 1. |
| SC-335 | ≥1 Survived → exit 1 even if score ≥ break threshold. |
| SC-336 | `--sarif <path>` writes SARIF 2.1.0 Survived locations; omitted → no file. |
| SC-337 | No-flag + fixtures/loop exit/oracle behavior matches Phase 3.2 baseline. |
| SC-338 | No HTML dep; no npm publish workflows; no optionalDependencies in git. |

---

## 10. Traceability → tickets

| Ticket | Covers |
| --- | --- |
| CLI parse/validate | REQ-1401..1404, SC-331, UX-005 |
| Gates + use case | REQ-1501..1503, SC-332..335, ADR-032 |
| SARIF adapter + port | REQ-1601..1604, SC-336, ADR-033 |
| E2E + docs | SC-337..338, NFR-331..333, ADR-031 |

---

## 11. Explicit non-goals (3.3)

HTML · `--report` · npm publish · cache · Jest · monorepo · default SARIF path · schema threshold coupling · ReportPort renames · distribution/GHA pack changes.
