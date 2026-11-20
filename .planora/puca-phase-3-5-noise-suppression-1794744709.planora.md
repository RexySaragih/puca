# Púca Phase 3.5 Discovery Noise Suppression & Comment Directives

Plan profile: feature
Review status: in-review
Applicable domains: backend, api, data, security, operations
Problem: Cut unkillable discovery noise (diagnostic call args and trivial arithmetic identities) and add operator-specific disable directives so Kill% reflects actionable tests, without a sixth scored status or schema-breaking report changes.
Users: Local developers reading terminal File Summary and --verbose audits; maintainers proving SC-401..407 after v0.2.0; CI consumers who require unchanged --json HTML SARIF contracts.
Scope: Collect-all then heuristic filter then directive filter in puca-core; NAPI two counters plus warnings; TS notices verbose File Summary Disabled column; ADR-039 docs; target tag v0.2.1 after Phase 3 freeze. Spec: `.planora/puca-phase-3-5-noise-suppression-technical-solution.md`.
Out of scope: oxc_semantic; bare debug() skip; block puca-disable/enable; force-enable inside console/logger; --suppress-callees config; string-literal mutator; CFG equivalence; sixth Ignored status; custom --json fields; HTML/SARIF Disabled UI; npm publish Phase 4.
Assumptions: A47-A53 in technical solution; ADR-035 remains CachePort (Phase 3.4); this feature is ADR-039; five current mutator names only; heuristic-first overlap attribution.
Success criteria:
- SC-401: Given // puca-disable-next-line with optional Op list, when discover runs, then bare form omits all mutators on the next line and named form omits only listed operators.
- SC-402: Given an unknown mutator token in a directive, when discover runs, then warnings are returned and written to stderr notices, known tokens still apply, and the run does not fail for that reason.
- SC-403: Given console.* or logger.* Identifier.Member calls, when discover runs, then zero sites are returned for any current mutator inside argument subtrees.
- SC-404: Given closed TCE shapes on plain NumericLiteral, when discover runs, then those sites are omitted while 0 - x and string + "" remain discoverable.
- SC-405: Given DiscoverOutcome, when mapped through NAPI/TS, then disabledByDirective and skippedByHeuristic are separate, suppressed sites never enter scoring IPC, and Kill% denom stays killed/(killed+survived).
- SC-406: Given session disabled total, when File Summary prints, then Disabled column appears only if total > 0 with per-file values; verbose splits directive vs heuristic; --json HTML SARIF unchanged.
- SC-407: Given Cargo.toml and disable grammar, when audited, then no oxc_semantic dependency, no bare debug() heuristic, and no block disable/enable parsing shipped in v1.
Risks: R27 over-suppress aliases; R28 counter drift; R29 File Summary plumbing; R30 JSON schema pollution.
Architecture decisions:
- ADR-039: Discovery noise suppression and comment directive architecture (collect-filter; two counters; terminal-only Disabled; no oxc_semantic).
Delivery strategy: Wave A heuristics then B directives then C NAPI/port then D terminal report then E docs/v0.2.1 closeout.
Backend — Service boundaries: puca-core discover pipeline owns omit rules; NapiMutatorEngine maps outcome; RunMutationSessionUseCase aggregates per-file counts and notices; StdioReport/formatFileSummaryTable present Disabled. Runtime: discovery-time only; no worker change for omitted sites. Failure: unknown directive tokens warn only (non-fatal).
Data — Entities: DiscoverOutcome counters and warnings; per-file disabled totals in session report model. Identity: site spans + mutatorName. Validation: known mutator name set for directives. Retention: no durable suppression store.
API — Consumers: CLI human; NAPI DiscoverOutcome. Operations: no new flags. Outputs: terminal + stderr verbose/notices. Errors: warnings non-fatal. Compatibility: replace disabledCount with two fields + warnings on discover outcome.
Security — Trust: source comments are untrusted input; parse line-oriented only; do not execute directive text; ignore foreign tool directives still.
Operations — Document ADR-039; release notes aim v0.2.1; still no npm publish; SC-407 Cargo audit.
Worker skills index (Build agents must load before coding):
- Wave A heuristics: lean-build, hexagonal-architecture, bdd-unit-test
- Wave B directives: lean-build, bdd-unit-test
- Wave C NAPI/port: lean-build, hexagonal-architecture, bdd-unit-test
- Wave D terminal: lean-build, bdd-unit-test
- Wave E closeout: verify-and-stop, lean-build
Traceability index (IDs for Covers):
- ADR-039: closeout
- REQ-2101: heuristics
- REQ-2102: heuristics
- REQ-2103: heuristics
- REQ-2104: heuristics
- REQ-2201: directives
- REQ-2202: directives
- REQ-2203: directives
- REQ-2204: directives
- REQ-2205: directives
- REQ-2301: napi
- REQ-2302: napi
- REQ-2303: napi
- REQ-2304: napi
- REQ-2401: report
- REQ-2402: report
- REQ-2403: report
- REQ-2404: report
- SC-401: directives
- SC-402: directives
- SC-403: heuristics
- SC-404: heuristics
- SC-405: napi
- SC-406: report
- SC-407: closeout
- UX-007: report
- NFR-351: closeout
- NFR-352: closeout
- NFR-353: closeout

## Backlog

Tickets in dependency order Waves A-E. Move to Doing when starting Build. Do not implement in Plan mode. Each ticket lists Worker skills for the Build agent.

## Doing

In-progress Build work only. Plan mode leaves this empty.

## Done

### Wave A Heuristic noise omit TCE and diagnostic calls
- id: po_350101
- priority: high
- status: done
- tags: backend
- phase: foundation

Story: As a developer I get zero mutants inside console/logger args and for trivial numeric identities without writing directives.
Goal: Implement Stage-1 heuristic filter after collect_sites for matched console/logger arg subtrees and closed TCE arithmetic; expose skipped_by_heuristic on DiscoverOutcome (fields may land fully in Wave B/C but Rust counter must be accurate).
Covers: REQ-2101, REQ-2102, REQ-2103, REQ-2104, SC-403, SC-404, ADR-039
Files: crates/puca-core/src/discover.rs, crates/puca-core/src/operators/, create crates/puca-core/src/heuristics.rs (or equivalent), crates/puca-core/tests/operators.rs, crates/puca-core/Cargo.toml
Worker skills: Load before implementing — lean-build (post-filter only; no oxc_semantic), hexagonal-architecture (keep omit rules in core, not TS), bdd-unit-test (SC-403/404 fixtures).
Acceptance:
- AC1: Given source `console.log(a + b)` or `logger.info(x === 1)`, when discover_outcome runs, then no sites are returned whose spans lie in those call arguments.
- AC2: Given `x + 0`, `0 + x`, `x - 0`, `x * 1`, `1 * x`, `x / 1` with plain NumericLiteral, when discover runs, then those ArithmeticOperator sites are omitted and counted in skipped_by_heuristic.
- AC3: Given `0 - x` or `x + ""`, when discover runs, then corresponding operator sites remain present.
- AC4: Given Cargo.toml, when inspected, then oxc_semantic is not a dependency.
Steps:
- S1: Load Worker skills; add call-arg span collection for exact Identifier.Member console/logger allowlist methods.
- S2: Add TCE predicates; Stage-1 filter removing matching sites and counting skipped_by_heuristic.
- S3: Rust tests for SC-403 and SC-404 closed sets and negatives.
Validation: cargo test -p puca-core
Done when: acceptance and validation pass
Depends on: (none)
Parallel: no

### Wave B Operator-specific disable directives and warnings
- id: po_350102
- priority: high
- status: done
- tags: backend
- phase: foundation

Story: As a developer I can suppress only named mutators on the next line and get warned about typos without failing the run.
Goal: Extend disable.rs for operator lists; Stage-2 filter after heuristics; disabled_by_directive counter; warnings vec for unknown tokens; keep // puca-disable rest-of-file; no block comments.
Covers: REQ-2201, REQ-2202, REQ-2203, REQ-2204, REQ-2205, SC-401, SC-402, SC-407
Files: crates/puca-core/src/disable.rs, crates/puca-core/src/discover.rs, crates/puca-core/tests/
Worker skills: Load before implementing — lean-build (extend line scanner; no trivia rewrite), bdd-unit-test (operator list and unknown-token cases).
Acceptance:
- AC1: Given `// puca-disable-next-line` above `a + b && c`, when discover runs, then all mutators starting on that next line are omitted.
- AC2: Given `// puca-disable-next-line EqualityOperator` above a line with both Equality and Arithmetic sites, when discover runs, then only EqualityOperator sites on that line are omitted.
- AC3: Given `// puca-disable-next-line NoSuchOp, ArithmeticOperator`, when discover runs, then warnings contains an unknown-mutator notice, ArithmeticOperator is still omitted, and discovery succeeds.
- AC4: Given only block-comment style `/* puca-disable */`, when discover runs, then it is ignored (no block parsing in v1).
Steps:
- S1: Load Worker skills; parse optional comma-separated mutator names after disable-next-line.
- S2: Wire Stage-2 filter and disabled_by_directive; accumulate warnings.
- S3: Unit tests for SC-401/402 and block-comment non-goal.
Validation: cargo test -p puca-core
Done when: acceptance and validation pass
Depends on: po_350101
Parallel: no

### Wave C NAPI DiscoverOutcome and MutatorEnginePort plumbing
- id: po_350103
- priority: high
- status: done
- tags: backend, api
- phase: user-story

Story: As the TS runtime I receive separate directive/heuristic counts and warning strings from native discover.
Goal: Expose DiscoverOutcome { sites, disabledByDirective, skippedByHeuristic, warnings } over NAPI; update MutatorEnginePort DiscoverResult; map in NapiMutatorEngine and FakeMutatorEngine; use case writes notices for warnings and never scores omitted sites.
Covers: REQ-2301, REQ-2302, REQ-2303, REQ-2304, SC-405, SC-402
Files: crates/puca-binding/src/lib.rs, src/adapters/outbound/napi/NapiMutatorEngine.ts, src/application/ports/outbound/MutatorEnginePort.ts, src/adapters/outbound/memory/FakeMutatorEngine.ts, src/application/use-cases/RunMutationSessionUseCase.ts, test/
Worker skills: Load before implementing — hexagonal-architecture (port shape owns counters), lean-build (replace disabledCount rather than triple-field mess), bdd-unit-test (fake engine + notice routing).
Acceptance:
- AC1: Given discover_outcome from binding, when inspected from TS, then disabledByDirective and skippedByHeuristic are present and disabledCount is not required.
- AC2: Given warnings from a bad directive token, when a session discovers that file, then report.writeNotice is invoked for each warning and exit code is not forced to 2 by warnings alone.
- AC3: Given suppressed sites, when scoring runs, then those sites are absent from statuses / worker apply path.
- AC4: Given FakeMutatorEngine memory tests, when updated, then they compile against the new DiscoverResult shape.
Steps:
- S1: Load Worker skills; update Rust DTO + napi-rs exports; rebuild binding.
- S2: Update MutatorEnginePort, NapiMutatorEngine, FakeMutatorEngine.
- S3: Use-case notice loop + tests for SC-405 mapping.
Validation: npm run build && npm test -- NapiMutatorEngine runMutationSession
Done when: acceptance and validation pass
Depends on: po_350102
Parallel: no

### Wave D File Summary Disabled column and verbose audit
- id: po_350104
- priority: high
- status: done
- tags: backend, api
- phase: user-story

Story: As a CLI user I see a Disabled column only when something was suppressed and a verbose split of why.
Goal: Plumb per-file disabled totals into formatFileSummaryTable; omit column when session total is 0; verbose footer prints directive vs heuristic split; leave --json HTML SARIF untouched.
Covers: REQ-2401, REQ-2402, REQ-2403, REQ-2404, SC-406, UX-007
Files: src/adapters/outbound/report/formatFileSummaryTable.ts, src/adapters/outbound/report/StdioReport.ts, src/application/use-cases/RunMutationSessionUseCase.ts, src/domain/mutant.ts, test/cliReport.exit.test.ts
Worker skills: Load before implementing — lean-build (terminal only), bdd-unit-test (column visibility and verbose text).
Acceptance:
- AC1: Given a scored session with zero suppressed sites, when File Summary prints, then no Disabled column header appears.
- AC2: Given per-file directive/heuristic omits, when File Summary prints, then Disabled values match per-file sums and appear only because session total > 0.
- AC3: Given --verbose, when session ends, then stderr contains `Suppression summary: N skipped via comment directives, M skipped via auto-heuristics.`
- AC4: Given existing schema JSON / HTML / SARIF tests, when run, then they still pass without new Disabled fields in those artifacts.
Steps:
- S1: Load Worker skills; extend File Summary API to accept optional per-file disabled map/rows.
- S2: Wire use-case aggregation into StdioReport path; update verbose footer copy.
- S3: cliReport behavioral tests for SC-406; confirm exporter tests unchanged.
Validation: npm test -- cliReport.exit htmlReport
Done when: acceptance and validation pass
Depends on: po_350103
Parallel: no

### Wave E ADR-039 docs and Phase 3.5 closeout
- id: po_350105
- priority: medium
- status: done
- tags: operations, security
- phase: polish

Story: Polish
Goal: Document ADR-039 and directive/heuristic rules; prove SC-401..407; record v0.2.1 Phase 3.5 slot; confirm non-goals (no oxc_semantic, no block disable, no npm unlock).
Covers: SC-401, SC-402, SC-403, SC-404, SC-405, SC-406, SC-407, ADR-039, NFR-351, NFR-352, NFR-353
Files: ARCHITECTURE.md, PRODUCT.md, README.md, AGENTS.md, crates/puca-core/Cargo.toml
Worker skills: Load before implementing — verify-and-stop (prove SCs without new features), lean-build (docs only after green tests).
Acceptance:
- AC1: Given ARCHITECTURE.md, when read, then ADR-039 describes noise suppression and notes ADR-035 remains cache.
- AC2: Given PRODUCT.md and README.md, when read, then operator-specific next-line syntax, quiet console/logger + TCE rules, and Disabled column behavior are documented.
- AC3: Given Cargo.toml, when grepped, then oxc_semantic is absent.
- AC4: Given full targeted test set for this phase, when run, then SC-401..407 evidence is green.
Steps:
- S1: Load Worker skills; run phase test suite / cargo tests proving SC catalog.
- S2: Update ARCHITECTURE PRODUCT README AGENTS for ADR-039 and Phase 3.5 / v0.2.1.
- S3: Stop — no Phase 4 publish work.
Validation: cargo test -p puca-core && npm test -- cliReport.exit && rg oxc_semantic crates/puca-core/Cargo.toml; test ! $? -eq 0 || ! rg -q oxc_semantic crates/puca-core/Cargo.toml
Done when: acceptance and validation pass
Depends on: po_350104
Parallel: no
