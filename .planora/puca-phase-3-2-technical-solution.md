# Púca Phase 3.2 — Local Loop Accuracy & File Summary

Document status: in-review
Planora board: `.planora/puca-phase-3-2-1794710717.planora.md`
Plan profile: feature
Product: Púca — local mutation-testing loop for ESM/Vitest
Package: `puca` (unscoped; **not published to npm this cycle**)
Binary / CLI: `puca`
ID namespace: REQ-12xx (TemplateLiteral skip), REQ-13xx (file summary terminal); SC-321..327; NFR-32x; ADR-029..030; UX-004
Companion board: `.planora/puca-phase-3-2-1794710717.planora.md`
Phase 1–2 specs: still normative for everything this document does not change
Phase 3.1 spec: `.planora/puca-phase-3-1-technical-solution.md` (distribution locked; **unchanged** by 3.2)
Phase 3 roadmap map: `.planora/puca-phase-3-technical_proposal.md` (post-3.1 rewrite)

This is an architecture specification. It is not implementation source.

Grill lock (Q1–Q22, 2026-11-15): Phase 3.2 is hired only to raise **local Vitest accuracy / lower junk signal** on git-dirty trees. Centerpiece: (1) exclude `${…}` expressions inside all `TemplateLiteral` nodes in `puca-core`; (2) stdout file-level summary table after session Summary. No new CLI flags. No distribution / GHA / loader / npm publish. No CI gates, SARIF, HTML, cache, Jest, or `--workspace`.

---

## 0. Plan envelope

Applicable domains: backend, data, api, security, operations

Domain inclusion justification:
- backend: Rust oxc visitor skip; StdioReport post-score formatting
- data: SessionResult statuses already in memory; no new durable store; Kill% is presentation-only
- api: terminal stdout contract (UX-004); no new CLI flags; `--json` schema unchanged
- security: still executes user tests on purpose; mutants never on disk; no new trust surface
- operations: source-build + existing test/lint gates; no GHA/distribution delta

Omissions: `ui` — terminal table is a CLI contract (UX-004), not a screen. `integrations` — no new external systems (Vitest/Git/NAPI unchanged).

Problem: Local `puca` still discovers mutants inside template interpolations (`` `${a + b}` ``), producing low-value noise, and the terminal only shows session-wide buckets — developers cannot scan per-file kill signal after a dirty-tree run.

Users:
- Application developers running `puca` locally on Vitest/TS repos before commit
- Púca maintainers proving SC-321..327 without changing the loop oracle

Scope: Unconditional TemplateLiteral expression skip in `puca-core`; Rust + NAPI proofs; stdout `── File Summary ──` after `── Summary ──` for scored runs; idle/refuse omit the block; PRODUCT/ARCHITECTURE/AGENTS/README sync.

Out of scope: `--mutate-template-expressions`; string-`+` policy change; `.puca/cache.json`; Jest; `--workspace`; `--break-on-score`; SARIF/HTML; npm publish / `optionalDependencies` / `@puca/*`; GHA/loader/tarball changes; ReportPort / use-case / domain Kill% types; adversarial fixtures; `fixtures/loop` oracle status changes.

Assumptions:
- A1–A26 from Phases 1–3.1 remain in force unless this document names a delta.
- A27: Oxc default `walk_template_literal` visits expressions today; 3.2 overrides `visit_template_literal` so expressions are **not** walked.
- A28: Tagged and untagged templates share one rule (no tag special case).
- A29: Kill% = Killed / (Killed + Survived) × 100; Timeout / NoCoverage / RuntimeError excluded from denominator; denom 0 → `-`.
- A30: File table rows = files with ≥1 discovered site only (including all-NoCoverage / all-Timeout / all-Error).
- A31: Idle exit 0 and pre-score refuse exit 2 print **no** File Summary block.
- A32: No new CLI flags in 3.2.
- A33: `fixtures/loop` has no template-literal sources; oracle statuses and exit code stay identical.

Success criteria (summary; catalog in §9):
- SC-321: Untagged `` `${a + b}` `` / `` `${flag}` `` → 0 sites for those expressions.
- SC-322: Tagged `` tag`${a + b}` `` → 0 sites for the inner expression.
- SC-323: Non-template `a + b` still discovers ArithmeticOperator.
- SC-324: Scored run stdout: Summary then File Summary with Q18 columns and Q11 Kill%.
- SC-325: Idle / pre-score refuse → no File Summary.
- SC-326: `fixtures/loop` oracle + exit unchanged.
- SC-327: `lint:deps` clean; zero new flags; exit/A6 unchanged.

Risks:
- R18: Overriding `visit_template_literal` incorrectly also skips nested statements that should still mutate outside templates — mitigate: only skip template **expressions**; still visit quasis if required by Visit contract; SC-323 regression.
- R19: File table printed on idle if Summary path always calls formatter — mitigate: gate on `result.statuses.length > 0` (or equivalent “scored sites present”); SC-325.
- R1/R5/R6 unchanged.

Architecture decisions (index; detail in §3):
- ADR-029: Skip all TemplateLiteral expressions unconditionally; no CLI flag.
- ADR-030: File Summary is StdioReport presentation only; Kill% not domain; ReportPort unchanged.

Delivery strategy: Rust TemplateLiteral skip + unit tests → file-summary formatter + StdioReport → NAPI/E2E/oracle lock → docs sync.

---

## 1. Clarify (Clear / Partial / Missing)

Clear: Buyer; 3.2 vs 3.3 vs 3.4+; template skip; no flag; file table columns/sort/Kill%/streams; idle omit; hexagon touchpoints; SC catalog; ticket cut; distribution frozen.

Partial: none blocking.

Missing: none blocking.

---

## 2. Hexagon (delta)

Phase 1–3.1 ports stay. **No new port. No use-case or domain change for Kill%.**

Deltas:
- `crates/puca-core/src/operators/mod.rs` — override `visit_template_literal` so `${…}` expressions are not visited by operator collectors.
- `src/adapters/outbound/report/StdioReport.ts` — after `formatSummary`, if scored statuses exist, append `formatFileSummaryTable(...)`.
- Optional pure helper `src/adapters/outbound/report/formatFileSummaryTable.ts` (same adapter package; not a port).
- Tests under `crates/puca-core/tests/` and `test/`.

`ReportPort`, `RunMutationSessionUseCase`, `createRuntime`, CLI `parseArgs`, NAPI loader, Vitest runners, and GHA remain untouched for behavior (docs may mention 3.2).

---

## 3. Architecture decisions

ADR-029: Unconditional TemplateLiteral expression skip — rationale: grill Q5=A, Q10=A, Q19=A; template interpolations are high junk / low signal for the local pre-commit buyer; code today walks expressions via oxc default walk while the old Phase 3 proposal incorrectly claimed exclusion. Alternatives: keep mutating (Q5=B); exclude + `--mutate-template-expressions` (Q5=C / Q10=B). Consequences: no flag; tagged and untagged identical; string `+` outside templates still mutated (A10). Confidence: high.

ADR-030: File Summary in StdioReport only — rationale: grill Q7=B, Q11=A, Q13=A, Q20=A; Kill% is human-scannable UX, must not affect exit codes or domain types. Alternatives: extend ReportPort; domain KillRate value object; fold into verbose stderr footer. Consequences: stdout order Summary → File Summary; verbose footer stays stderr; RecordingReport/fakes need no Kill% API. Confidence: high.

Phase 1 ADR-001..012, Phase 2 ADR-013..019, Phase 3.1 ADR-020..028 unchanged. npm registry publish remains forbidden.

---

## 4. TemplateLiteral skip (REQ-12xx)

In `OperatorVisitor` (`crates/puca-core/src/operators/mod.rs`):

Implement `visit_template_literal` so it does **not** call `walk::walk_template_literal` (which walks `expressions`). Do not visit nested expressions inside `${…}`. Tagged templates (`TaggedTemplateExpression` → `TemplateLiteral`) use the same literal visitor — one rule.

Do **not** skip:
- Binary / logical / boolean / conditional sites outside templates
- String `+` (A10)
- Operators inside ordinary parentheses, if/while/ternary, etc.

Discover outcome for a file that only contains `` `x ${a + b}` `` may be zero sites (omit from File Summary if the whole file has zero sites after discover — consistent with row rule).

---

## 5. File Summary terminal contract (REQ-13xx, UX-004)

### When to print

After `formatSummary` writes `── Summary ──` on **stdout**, if `result.statuses.length >= 1`, write `── File Summary ──` table on **stdout**. If `statuses` is empty (idle message path or refuse-before-score with no mutant rows), omit the File Summary block entirely (SC-325).

Pre-score refuse that somehow carries statuses is out of product paths; idle is empty statuses + message.

### Columns (pipe-aligned or monospace spaces; stable header)

```
── File Summary ──
File                  Total  Killed  Survived  Timeout  NoCov  Error  Kill%
src/a.ts                  4       3         1        0      0      0    75%
src/b.ts                  2       0         0        1      1      0     -
```

Exact padding may use simple space columns; tests assert header labels, per-file counts, Kill% tokens, and relative order — not pixel-perfect width.

### Aggregation

Group `result.statuses` by site file path rendered as POSIX path relative to reporter `cwd` (same relativization as detail lines). Sort rows by that string ascending. Include a file iff it has ≥1 mutant in `statuses`.

Per row:
- Total = count of mutants for that file
- Killed / Survived / Timeout / NoCov / Error = bucket counts (`RuntimeError` → Error column; NoCoverage → NoCov)
- Kill% = if (Killed + Survived) == 0 then `-` else integer percent `round(100 * Killed / (Killed + Survived))` with a trailing `%` (e.g. `75%`). Ties on `.5`: use standard half-away-from-zero or floor — pick **round half up** via `Math.round`.

### Streams

- stdout: Summary + File Summary
- stderr: existing verbose footer unchanged

### Exit codes

Kill% never changes exit codes (A6 / ADR-011 stay).

---

## 6. Requirements catalog

### REQ-12xx — TemplateLiteral

| ID | Requirement |
| --- | --- |
| REQ-1201 | Operator visitor must not collect sites from expressions inside any `TemplateLiteral`. |
| REQ-1202 | Tagged and untagged templates share REQ-1201. |
| REQ-1203 | Non-template operator discovery regresses zero for Phase 1 operator set (including string `+`). |
| REQ-1204 | No CLI flag controls template skipping in 3.2. |

### REQ-13xx — File Summary

| ID | Requirement |
| --- | --- |
| REQ-1301 | After a scored session with ≥1 mutant status, stdout includes `── File Summary ──` immediately after `── Summary ──`. |
| REQ-1302 | Columns: File, Total, Killed, Survived, Timeout, NoCov, Error, Kill%. |
| REQ-1303 | Rows: files with ≥1 status; cwd-relative POSIX paths; ascending sort. |
| REQ-1304 | Kill% = Killed/(Killed+Survived)×100 informational; `-` when denom 0. |
| REQ-1305 | Idle empty statuses and pre-score refuse with empty statuses omit File Summary. |
| REQ-1306 | ReportPort interface unchanged; Kill% not added to domain. |

---

## 7. NFR / UX

| ID | Requirement |
| --- | --- |
| NFR-321 | `cargo test -p puca-core` covers SC-321..323. |
| NFR-322 | `npm run lint:deps` remains clean. |
| NFR-323 | No GHA / package.json distribution field changes in 3.2 tickets 1–3. |
| UX-004 | File Summary table matches §5; scoring live stream (UX-001) unchanged. |

---

## 8. Testing strategy

- Rust: new cases in `crates/puca-core/tests/operators.rs` (or dedicated `template_skip.rs`) for untagged, tagged, and non-template `a + b`.
- TS: extend `test/cliReport.exit.test.ts` (or sibling) for File Summary stdout + idle omit; NAPI discover proof if needed in `test/napiMutator.engine.test.ts`.
- E2E: `test/e2e.loopFixture.test.ts` oracle identity (SC-326); assert no accidental File Summary requirement that breaks oracle — table may appear but statuses/exit must match.

Behavioral tests; mock only I/O boundaries already used.

---

## 9. Success criteria catalog

| ID | Criterion |
| --- | --- |
| SC-321 | Untagged `` `${a + b}` `` and `` `${flag}` `` generate 0 mutant sites for those expressions. |
| SC-322 | Tagged `` tag`${a + b}` `` inner expressions generate 0 mutant sites. |
| SC-323 | Non-template `a + b` still generates ArithmeticOperator site(s). |
| SC-324 | Scored runs stdout: `── Summary ──` then `── File Summary ──` with §5 columns and Kill% rules. |
| SC-325 | Idle exit 0 and pre-score refuse exit 2 produce no `── File Summary ──`. |
| SC-326 | `fixtures/loop` oracle statuses and exit code unchanged. |
| SC-327 | `lint:deps` clean; zero new CLI flags; exit/A6 locks intact. |

---

## 10. Traceability → tickets

| Ticket theme | Covers |
| --- | --- |
| TemplateLiteral skip (`puca-core`) | REQ-1201..1204, SC-321..323, ADR-029, NFR-321 |
| File Summary StdioReport | REQ-1301..1306, SC-324..325, ADR-030, UX-004 |
| NAPI / E2E / oracle lock | SC-321..323 (TS), SC-326..327, NFR-322 |
| Docs sync | ADR-029, ADR-030, SC-327, UX-004 |

---

## 11. Explicit non-goals (3.2)

Cache · Jest · monorepo · CI score gates · SARIF · HTML · npm publish · `@puca/*` · template opt-in flag · adversarial fixtures · string-`+` skip · ReportPort inflation · distribution/loader/GHA edits.
