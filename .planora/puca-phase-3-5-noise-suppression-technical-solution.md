# Púca Phase 3.5 — Discovery Noise Suppression & Comment Directives

Document status: in-review
Planora board: `.planora/puca-phase-3-5-noise-suppression-1794744709.planora.md`
Plan profile: feature
Product: Púca — local mutation loop; Phase 3.5 cuts unkillable discovery noise after v0.2.0 freeze
Package: `puca` (unscoped; **still not published to npm** — Phase 4)
Binary / CLI: `puca`
ID namespace: REQ-21xx (heuristics), REQ-22xx (directives), REQ-23xx (NAPI/TS plumbing), REQ-24xx (terminal report); SC-401..407; NFR-351..353; ADR-039; UX-007
Companion board: `.planora/puca-phase-3-5-noise-suppression-1794744709.planora.md`
Prior specs: Phases 1–3.4 remain normative except where this document extends discovery / disable / File Summary
Phase 3 roadmap: `.planora/puca-phase-3-technical_proposal.md` (3.4 claimed “no 3.5”; **superseded** by grill lock Q25 → Phase 3.5 / `v0.2.1`)

This is an architecture specification. It is not implementation source.

Grill lock (Rounds 1–4, 2026-11-15): Trust/noise KPI; extend `disable.rs` + visitor/heuristics (no `oxc_semantic` rewrite); quiet void-context only; rebrand as noise suppression (not equivalent-mutant elimination); omit suppressed sites from discovery; two internal counters; terminal `Disabled` column; no JSON/HTML/SARIF schema change; Phase 3.5 after `v0.2.0` → tag `v0.2.1`.

ADR ID note: Grill text said “ADR-035”; that number is already **CachePort** (Phase 3.4). This phase records **ADR-039** for noise suppression.

---

## 0. Plan envelope

Applicable domains: backend, api, data, security, operations

Domain inclusion justification:
- backend: Rust collect→filter discovery; StdioReport / File Summary presentation
- api: NAPI `DiscoverOutcome` contract break/extend; `MutatorEnginePort.DiscoverResult`
- data: in-memory per-file suppression counts through session → terminal only (no durable store)
- security: comment directives are untrusted source text — parse safely; unknown tokens warn only
- operations: docs + `v0.2.1` closeout; still no npm publish

Omissions: `ui` — terminal table is CLI contract (UX-007), not a screen. `integrations` — no new external systems.

Problem: Unkillable diagnostic / identity sites and coarse whole-line disables inflate noise and erode Kill% trust; developers need quiet skips for zero-ambiguity void contexts plus operator-specific directives, without inventing a sixth scored status or breaking report schemas.

Users:
- Local Vitest/Jest developers reading terminal File Summary / verbose audits
- Maintainers proving SC-401..407 after Phase 3 freeze
- CI consumers who must keep `--json` / SARIF / HTML contracts stable

Scope: Collect-all then Stage-1 heuristic omit (console/logger arg subtrees + closed TCE) then Stage-2 directive omit (operator-specific next-line + existing rest-of-file); NAPI two counters + `warnings`; TS notices + verbose split + dynamic File Summary `Disabled` column; ADR-039 + PRODUCT/README; release slot `v0.2.1`.

Out of scope: `oxc_semantic`; bare `debug()` skip; block `/* puca-disable */` … `/* puca-enable */`; force-enable inside logger/console; config `--suppress-callees`; string-literal mutator; deeper equivalence / CFG; changing Kill% formula; injecting custom `--json` fields; HTML/SARIF Disabled UI; npm publish / Phase 4.

Assumptions:
- A47: Current operators remain ArithmeticOperator, EqualityOperator, BooleanLiteral, LogicalOperator, ConditionalExpression (no string-literal mutator).
- A48: Heuristic-first attribution when a site matches both stages → `skippedByHeuristic` only.
- A49: Known directive mutator tokens = exact current mutator name strings; unknown → warning + apply known.
- A50: Callee match = `Identifier(console|logger).Identifier(log|info|warn|error|debug|trace)` only.
- A51: TCE uses plain oxc `NumericLiteral` 0/1 only; never `0 - x`; no unary peel; no `+ ""`.
- A52: `DiscoverResult.disabledCount` replaced by `disabledByDirective` + `skippedByHeuristic` (TS sums).
- A53: Phase 3.4 ADRs 034–038 unchanged; this phase adds ADR-039 only.

Success criteria: SC-401..407 (§9).

Risks:
- R27: Over-suppression of real domain logic under `logger.*` aliases — mitigate: exact Identifier.Member only; document; directives for rest.
- R28: Counter drift if heuristics skip during visit instead of post-filter — mitigate: unified collect→filter (Q20).
- R29: File Summary column without per-file plumbing — mitigate: thread discovery counts per file into report model (Q16).
- R30: Accidental schema pollution in `--json` — mitigate: SC-406; Ajv tests unchanged.

Architecture decisions:
- ADR-039: Discovery noise suppression & comment directive architecture (see §3).

Delivery strategy: Wave A heuristics → B directives → C NAPI/port → D terminal report → E docs/`v0.2.1` closeout.

Worker skills (Build agents — load before implementing):

| Wave | Skills to load |
| --- | --- |
| A (heuristics) | `lean-build`, `hexagonal-architecture`, `bdd-unit-test` (Rust/NAPI tests as behavioral proofs) |
| B (directives) | `lean-build`, `bdd-unit-test` |
| C (NAPI/TS port) | `lean-build`, `hexagonal-architecture`, `bdd-unit-test` |
| D (terminal report) | `lean-build`, `bdd-unit-test` |
| E (closeout) | `verify-and-stop`, `lean-build` |

---

## 1. Clarify

Clear: Grill Q1–Q25; SC-401..407; closed allowlists; NAPI shape; report boundaries; delivery slot.

Partial: none blocking.

Missing: none blocking.

---

## 2. Hexagon (delta)

| Seam | Change |
| --- | --- |
| `crates/puca-core` discover pipeline | collect → heuristic filter → directive filter; new counters + warnings |
| `crates/puca-core/src/disable.rs` | operator-specific next-line; warning collection |
| new heuristic helpers (core) | diagnostic call arg spans; TCE predicates |
| `crates/puca-binding` | `DiscoverOutcomeDto` fields |
| `MutatorEnginePort` / `DiscoverResult` | two counters + `warnings` |
| `NapiMutatorEngine` / `FakeMutatorEngine` | map new outcome |
| `RunMutationSessionUseCase` | per-file counts; notices; verbose footer text |
| `formatFileSummaryTable` / `StdioReport` | optional `Disabled` column |
| PRODUCT / ARCHITECTURE / README | ADR-039 + syntax + quiet-skip rules |

Domain five-bucket statuses unchanged. No ReportPort JSON/HTML/SARIF delta.

---

## 3. Architecture decisions

ADR-039: Discovery noise suppression & comment directives — rationale: grill Rounds 1–4; trust KPI without undecidable equivalence branding. Alternatives: oxc_semantic parent queries (rejected); silent config allowlists (deferred YAGNI); sixth Ignored status (rejected). Consequences: collect→filter; two counters; terminal-only Disabled; SC-401..407; ID is 039 not grill’s 035. Confidence: high.

---

## 4. Wave A — Heuristic omit (REQ-21xx)

- After `collect_sites`, compute omit set:
  - Sites whose primary span falls inside argument ranges of matched `console.*` / `logger.*` CallExpressions.
  - ArithmeticOperator sites whose binary expression matches closed TCE set.
- Count removed sites as `skipped_by_heuristic`.
- Do not push alternate visitor early-return counting (accuracy via post-filter).
- Record call arg spans during a dedicated walk or during collect via context stack used only to build span sets for the filter stage (implementation may stack during collect, but **counting** is filter-stage removal).

---

## 5. Wave B — Directive omit (REQ-22xx)

- Extend `scan_disables`:
  - Bare `// puca-disable-next-line` → all mutators on next line.
  - `// puca-disable-next-line OpA, OpB` → named mutators only (comma-separated, trim).
  - `// puca-disable` → rest-of-file all mutators (unchanged).
- Unknown Op tokens → push warning string; still apply known tokens.
- Stage-2 filter on remaining sites → `disabled_by_directive`.
- Known names: exact five current mutator strings.

---

## 6. Wave C — NAPI & TS port (REQ-23xx)

`DiscoverOutcome` / DTO / `DiscoverResult`:

```text
sites
disabledByDirective
skippedByHeuristic
warnings: string[]
```

- Remove sole `disabledCount` from the public discover outcome (TS computes sum).
- `FakeMutatorEngine` updated for memory tests.
- Use case: for each warning → `report.writeNotice`; verbose footer uses split audit line.
- Suppressed sites never enter scoring / IPC.

---

## 7. Wave D — Terminal File Summary (REQ-24xx / UX-007)

- Thread per-file `(disabledByDirective + skippedByHeuristic)` into File Summary input.
- Show `Disabled` column only when session sum > 0.
- Verbose: `Suppression summary: N skipped via comment directives, M skipped via auto-heuristics.`
- `--json` / HTML / SARIF unchanged.

---

## 8. Requirements catalog

| Family | IDs | Theme |
| --- | --- | --- |
| REQ-21xx | 2101–2104 | diagnostic call omit; TCE omit; heuristic counter; no oxc_semantic |
| REQ-22xx | 2201–2205 | bare next-line; operator list; rest-of-file; unknown→warning; directive counter |
| REQ-23xx | 2301–2304 | NAPI DTO; MutatorEnginePort; notices; no score pollution |
| REQ-24xx | 2401–2404 | Disabled column gate; per-file plumbing; verbose split; schema exporters untouched |

---

## 9. Success criteria

| ID | Criterion |
| --- | --- |
| SC-401 | Bare next-line suppresses all mutators on that line; named list suppresses only those operators. |
| SC-402 | Unknown mutator tokens → stderr notices via `warnings`; known tokens still apply; run continues. |
| SC-403 | Matched `console.*` / `logger.*` arg subtrees yield 0 discovered sites for all current mutators. |
| SC-404 | Closed TCE set yields 0 sites; `0 - x` and `+ ""` remain discoverable. |
| SC-405 | Outcome exposes two counters; suppressed sites never IPC; Kill% denom unchanged. |
| SC-406 | File Summary `Disabled` only when total > 0 (per-file); verbose splits; json/html/sarif unchanged. |
| SC-407 | No `oxc_semantic`; no bare `debug()` skip; no block disable/enable parsing in v1. |

---

## 10. Traceability → waves

| Wave | Covers |
| --- | --- |
| A | REQ-21xx, SC-403, SC-404, SC-407 (heuristics bounds), ADR-039 |
| B | REQ-22xx, SC-401, SC-402, SC-407 (no block comments) |
| C | REQ-23xx, SC-405, SC-402 (warnings path) |
| D | REQ-24xx, SC-406, UX-007 |
| E | SC-401..407 audit, ADR-039 docs, NFR-351..353, `v0.2.1` notes |

---

## 11. Explicit non-goals (Phase 3.5)

oxc_semantic · bare debug() · block enable/disable · force-enable in logger · --suppress-callees · string-literal mutator · CFG/type equivalence · sixth status · JSON schema custom fields · HTML/SARIF Disabled · npm publish / Phase 4.
