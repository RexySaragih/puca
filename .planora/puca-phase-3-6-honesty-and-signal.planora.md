# Púca Phase 3.6 Honesty Signal then Ops

Plan profile: feature
Review status: in-review
Applicable domains: backend, api, data, integrations, security, operations
Problem: Default puca scores whole dirty files, caches Timeout, aborts on one bad file, has no --help, and Kill% is still noisy (string +, fat conditionals, missing bang).
Users: Local developers on git-dirty TypeScript; CI jobs using opt-in gates; maintainers shipping GitHub Release tarballs.
Scope: Hunk targeting with --full-file; per-file discover skip; cache Killed/Survived/NoCoverage only; --help/--version; cancel hung Vitest; UnaryOperator bang; skip non-empty string +; tighten ConditionalExpression; NoCoverage notice; Jest related-map; ABI supported list; CI Node 22 fmt clippy; lint:deps node:fs; extract use case; install-from-release.sh; v0.3.0 docs. No npm publish.
Out of scope: npm registry; optionalDependencies; Jest multi-worker; Browser Mode; SFC/CJS; V8 coverage; oxc_semantic; block puca-disable; puca.config.ts; workspace package parallelism; renaming master.
Assumptions: A6 idle/refuse exits unchanged; --mutate remains whole-file; hang.ts Identifier predicates keep the loop oracle; x + empty string stays discoverable; crates version may stay 0.1.0 if documented.
Success criteria:
- SC-501: Given --help or --version, when CLI runs, then stdout prints usage or package version and exit is 0.
- SC-502: Given a deleted or unparseable dirty file among valid candidates, when a session runs, then that file is skipped with a notice and scoring continues.
- SC-503: Given --cache, when a site scores Timeout or RuntimeError, then that status is not stored or replayed.
- SC-504: Given a hung related run, when the outer timer fires, then the runner cancelCurrentRun is invoked before respawn.
- SC-505: Given default git targeting and a one-line dirty hunk, when discover yields sites on other lines, then only overlapping sites are scored.
- SC-506: Given string concatenation of non-empty literals, when discover runs, then ArithmeticOperator is omitted; identifier plus empty string remains.
- SC-507: Given if (a && b), when discover runs, then no ConditionalExpression site covers the full predicate.
- SC-508: Given !flag, when discover runs, then UnaryOperator replaces bang with empty.
- SC-509: Given NoCoverage count >= 1 without --fail-on-no-coverage, when the session ends, then stderr mentions --fail-on-no-coverage and exit is unchanged.
- SC-510: Given an unsupported host ABI, when the NAPI loader runs, then the error lists the four shipped ABIs.
- SC-511: Given npm test e2e.loopFixture, when Phase 3.6 lands, then the checked-in oracle statuses still match.
Risks: R31 hunk parse misses renames; R32 over-skip string plus; R33 Jest scan still approximate.
Architecture decisions:
- ADR-040: Default git targeting uses git diff -U0 HEAD hunks; --full-file restores whole dirty files; --mutate stays whole-file.
- ADR-041: Per-file read/discover failures skip with notice; session abort only when A6 refuse rules apply.
- ADR-035: Cache stores Killed Survived NoCoverage only; engineVersion 3.
- ADR-038: Phase 3.6 still GitHub Releases only; install-from-release.sh is DX not npm publish.
Delivery strategy: Wave A honesty then B signal then C Jest/ABI then D CI/extract then E docs/v0.3.0.
Backend — Service boundaries: GitDiffLocator owns hunk parse; use case filters sites by lineRanges and skip policy; puca-core owns new operators; FileHashCache owns stable statuses. Runtime: RAM mutants unchanged. Failure: per-file skip; ABI miss exit 2.
Data — Entities: SourceCandidate lineRanges; cache engine 3. Identity: site id unchanged. Retention: cache metadata only.
API — Consumers: CLI flags --help --version --full-file. NAPI discover_outcome unchanged plus UnaryOperator name. Compatibility: no --json schema fields added.
Integrations — git spawn shell false; Vitest cancelCurrentRun; Jest child wall from outer timeout; GitHub Release tarball names.
Security — git paths still isUnderCwd; cache still rejects mutatedSource; install script pins tag and ABI.
Operations — CI Node 20/22; cargo fmt clippy; Windows test continue-on-error; v0.3.0 tag pairing.
Worker skills index (Build agents must load before coding):
- Wave A: lean-build, hexagonal-architecture, bdd-unit-test
- Wave B: lean-build, bdd-unit-test
- Wave C: lean-build, hexagonal-architecture, bdd-unit-test
- Wave D: lean-build, hexagonal-architecture, safe-refactor
- Wave E: verify-and-stop, lean-build
Traceability index (IDs for Covers):
- ADR-040: hunks
- ADR-041: skip
- ADR-035: cache
- SC-501: help
- SC-502: skip
- SC-503: cache
- SC-504: timeout
- SC-505: hunks
- SC-506: string-plus
- SC-507: conditional
- SC-508: unary
- SC-509: nocov
- SC-510: abi
- SC-511: closeout

## Backlog

Tickets in dependency order. Move to Doing when starting Build.

## Doing

In-progress Build work only.

## Done

Completed tickets.

### E Docs version install script
- id: po_360501
- priority: medium
- status: done
- tags: operations
- phase: polish

Story: Polish
Goal: v0.3.0 package version; README PRODUCT ARCHITECTURE AGENTS; install-from-release.sh; loop oracle still matches.
Covers: SC-511, ADR-038, ADR-040, ADR-041
Files: package.json, README.md, PRODUCT.md, ARCHITECTURE.md, AGENTS.md, create scripts/install-from-release.sh, Cargo.toml
Worker skills: Load before implementing — verify-and-stop, lean-build
Acceptance:
- AC1: Given package.json, when read, then version is 0.3.0.
- AC2: Given README, when read, then --full-file --help hunk default and install script are documented.
- AC3: Given npm test e2e.loopFixture, when run after build, then oracle statuses match.
Steps:
- S1: Load Worker skills; bump version; write install script.
- S2: Update docs ADRs operator table.
- S3: Run e2e.loopFixture and cargo test.
Validation: npm run build && npm test -- e2e.loopFixture && cargo test -p puca-core
Done when: acceptance and validation pass
Depends on: po_360203, po_360302, po_360402, po_360401, po_360301
Parallel: no

### D3 Extract use case modules
- id: po_360402
- priority: medium
- status: done
- tags: backend
- phase: polish

Story: Polish
Goal: Split discover and score helpers under application/ without changing RunMutationSession.
Covers: SC-511
Files: src/application/use-cases/RunMutationSessionUseCase.ts, create src/application/use-cases/discoverSession.ts, create src/application/use-cases/scoreMutants.ts, test/runMutationSession.memory.test.ts, test/mutantLoop.statuses.test.ts
Worker skills: Load before implementing — lean-build, hexagonal-architecture, safe-refactor
Acceptance:
- AC1: Given existing memory and mutantLoop tests, when run, then they pass without 1:1 new class tests.
- AC2: Given dist/application, when lint:deps runs, then inner modules still have no vitest/napi/fs imports.
Steps:
- S1: Load Worker skills; extract discoverSession and scoreMutants after Wave A lands.
- S2: Keep facade execute; run behavioral tests.
Validation: npm test -- runMutationSession.memory mutantLoop.statuses && npm run lint:deps
Done when: acceptance and validation pass
Depends on: po_360105, po_360204, po_360104
Parallel: no

### D1 CI and lint deps
- id: po_360401
- priority: medium
- status: done
- tags: operations
- phase: polish

Story: Polish
Goal: CI Node 20 and 22; cargo fmt clippy; optional Windows test continue-on-error; cruiser forbids node:fs os child_process worker_threads in domain/application.
Covers: SC-511
Files: .github/workflows/ci.yml, dependency-cruiser.cjs
Worker skills: Load before implementing — lean-build
Acceptance:
- AC1: Given ci.yml, when read, then test job matrices node-version 20 and 22 on macos-14 and ubuntu-latest.
- AC2: Given ci.yml, when read, then cargo fmt --check and clippy -D warnings run.
- AC3: Given dependency-cruiser.cjs, when inspected, then node:fs is forbidden from dist/application.
Steps:
- S1: Load Worker skills; extend ci.yml.
- S2: Extend cruiser forbidden to.
Validation: npm run lint:deps
Done when: acceptance and validation pass
Depends on: (none)
Parallel: yes

### C1 Jest related-map and static import
- id: po_360302
- priority: medium
- status: done
- tags: backend, integrations
- phase: user-story

Story: As a Jest user I get fewer false NoCoverage from shallow import scans.
Goal: Honor Jest testMatch when present; tsconfig paths; hop cap 8; jest notice related-map static-scan; Vitest static-string import().
Covers: SC-511
Files: src/adapters/outbound/jest/scanJestRelated.ts, src/adapters/outbound/jest/resolveProjectJest.ts, src/adapters/outbound/jest/JestTestRunner.ts, src/adapters/outbound/vitest/collectImportGraph.ts, src/cli.ts, test/e2e.jestLoop.test.ts
Worker skills: Load before implementing — lean-build, hexagonal-architecture, bdd-unit-test
Acceptance:
- AC1: Given hop depth beyond 1 barrel, when scanJestRelated runs, then the leaf source maps to the spec (up to 8 hops).
- AC2: Given --runner jest, when a session starts scoring, then a notice contains related-map: static-scan.
- AC3: Given import("./mod"), when collectImportGraph walks, then that module is reachable.
Steps:
- S1: Load Worker skills; deepen Jest scan and testMatch.
- S2: Jest notice; static-string dynamic import in Vitest graph.
Validation: npm test -- e2e.jestLoop collectImportGraph
Done when: acceptance and validation pass
Depends on: po_360105
Parallel: no

### C2 ABI supported list
- id: po_360301
- priority: high
- status: done
- tags: backend, operations
- phase: user-story

Story: As a linux-arm64 user I get a clear list of shipped addons instead of a fake ABI name.
Goal: SUPPORTED_ABIS matches napi.targets; unknown host lists those four.
Covers: SC-510
Files: src/adapters/outbound/napi/NapiMutatorEngine.ts, test/napiMutator.engine.test.ts, test/napiPack.identity.test.ts
Worker skills: Load before implementing — lean-build, bdd-unit-test
Acceptance:
- AC1: Given linux arm64 host mapping, when hostPlatformAbi or load runs, then the error lists darwin-arm64 darwin-x64 linux-x64-gnu win32-x64-msvc.
- AC2: Given a supported host missing the .node, when loadPucaBinding fails, then UX-003 still mentions npm run build.
Steps:
- S1: Load Worker skills; add SUPPORTED_ABIS and unsupported-host message.
- S2: Unit tests for message contents.
Validation: npm test -- napiMutator napiPack
Done when: acceptance and validation pass
Depends on: (none)
Parallel: yes

### B4 NoCoverage notice
- id: po_360204
- priority: medium
- status: done
- tags: backend, api
- phase: user-story

Story: As a developer I see when mutants had no related tests without changing default exit.
Goal: Notice when NoCoverage >= 1 and failOnNoCoverage is off; exit codes unchanged.
Covers: SC-509, ADR-031
Files: src/application/use-cases/RunMutationSessionUseCase.ts, test/cliReport.exit.test.ts
Worker skills: Load before implementing — lean-build, bdd-unit-test
Acceptance:
- AC1: Given one NoCoverage mutant without the flag, when execute finishes, then stderr notice mentions --fail-on-no-coverage and exit is 0 if no Survived.
- AC2: Given --fail-on-no-coverage, when NoCoverage exists, then that notice is not required and exit is 1.
Steps:
- S1: Load Worker skills; emit notice from scored counts.
- S2: cliReport behavioral test.
Validation: npm test -- cliReport.exit
Done when: acceptance and validation pass
Depends on: po_360105
Parallel: no

### B1 UnaryOperator bang
- id: po_360203
- priority: high
- status: done
- tags: backend, api
- phase: user-story

Story: As a developer I want bang inversion mutants so tests notice missing negation.
Goal: UnaryOperator replaces ! with empty; unary plus minus stay unmutated; name is a known disable token.
Covers: SC-508
Files: crates/puca-core/src/operators/unary.rs, crates/puca-core/src/operators/mod.rs, crates/puca-core/src/disable.rs, crates/puca-core/tests/operators.rs
Worker skills: Load before implementing — lean-build, bdd-unit-test
Acceptance:
- AC1: Given !flag, when discover runs, then one UnaryOperator site with empty replacement.
- AC2: Given +a; -b, when discover runs, then no UnaryOperator and no ArithmeticOperator.
- AC3: Given // puca-disable-next-line UnaryOperator, when discover runs, then the bang site is omitted.
Steps:
- S1: Load Worker skills; add unary visitor for LogicalNot only.
- S2: Register known mutator name; tests.
Validation: cargo test -p puca-core && npm run build
Done when: acceptance and validation pass
Depends on: po_360201, po_360202
Parallel: no

### B3 Tighten ConditionalExpression
- id: po_360202
- priority: high
- status: done
- tags: backend
- phase: user-story

Story: As a developer I do not want whole-predicate true/false mutants on complex conditions.
Goal: ConditionalExpression only for Identifier or UnaryExpression tests.
Covers: SC-507, SC-511
Files: crates/puca-core/src/operators/conditional.rs, crates/puca-core/src/operators/mod.rs, crates/puca-core/tests/operators.rs
Worker skills: Load before implementing — lean-build, bdd-unit-test
Acceptance:
- AC1: Given while (enabled), when discover runs, then true/false ConditionalExpression sites remain.
- AC2: Given a && b ? x : y, when discover runs, then no ConditionalExpression covers the full a && b span.
Steps:
- S1: Load Worker skills; gate collect_predicate on node kind.
- S2: Rust tests including hang-equivalent identifier.
Validation: cargo test -p puca-core
Done when: acceptance and validation pass
Depends on: (none)
Parallel: yes

### B2 Skip non-empty string plus
- id: po_360201
- priority: high
- status: done
- tags: backend
- phase: user-story

Story: As a developer I do not want concatenation mutants polluting Kill%.
Goal: Omit ArithmeticOperator Addition when either operand is a non-empty StringLiteral or TemplateLiteral; keep x + empty string and identifier a + b.
Covers: SC-506
Files: crates/puca-core/src/operators/arithmetic.rs, crates/puca-core/tests/operators.rs
Worker skills: Load before implementing — lean-build, bdd-unit-test
Acceptance:
- AC1: Given "a" + "b", when discover runs, then no ArithmeticOperator site.
- AC2: Given a + b beside a template, when discover runs, then identifier plus remains.
- AC3: Given x + "", when discover runs, then ArithmeticOperator remains.
Steps:
- S1: Load Worker skills; skip non-empty string-like Addition.
- S2: Update SC-323 tests.
Validation: cargo test -p puca-core
Done when: acceptance and validation pass
Depends on: (none)
Parallel: yes

### A1 Git hunk targeting
- id: po_360105
- priority: high
- status: done
- tags: backend, api
- phase: user-story

Story: As a developer I want default puca to score only the lines I just changed.
Goal: SourceCandidate lineRanges from git diff -U0 HEAD; --full-file whole dirty files; --mutate whole file.
Covers: SC-505, ADR-040
Files: src/application/ports/outbound/SourceLocatorPort.ts, src/domain/mutant.ts, src/adapters/outbound/git/GitDiffLocator.ts, src/adapters/outbound/memory/InMemorySourceLocator.ts, src/application/use-cases/RunMutationSessionUseCase.ts, src/adapters/inbound/cli/parseArgs.ts, src/application/ports/inbound/RunMutationSession.ts, src/cli.ts, test/sourceLocator.git.test.ts, test/runMutationSession.memory.test.ts, test/cliReport.exit.test.ts
Worker skills: Load before implementing — lean-build, hexagonal-architecture, bdd-unit-test
Acceptance:
- AC1: Given a dirty hunk on one line of a two-site file, when execute runs, then only the overlapping site is scored.
- AC2: Given --mutate, when candidateFiles runs, then candidates have no lineRanges.
- AC3: Given --full-file, when git targeting runs, then dirty files have no lineRanges.
- AC4: Given zero eligible after hunks and deletes, when execute runs, then exit is 0 with No files to mutate.
Steps:
- S1: Load Worker skills; add SourceCandidate and --full-file.
- S2: Parse unified hunks in GitDiffLocator; skip missing files.
- S3: Filter discovered sites by line overlap in the use case.
- S4: Git locator and session tests.
Validation: npm test -- sourceLocator.git runMutationSession.memory cliReport.exit
Done when: acceptance and validation pass
Depends on: po_360101, po_360102
Parallel: no

### A5 Cancel hung Vitest and Jest wall
- id: po_360104
- priority: high
- status: done
- tags: backend, integrations
- phase: foundation

Story: As a developer I want hung mutants cancelled at --timeout, not left racing until close.
Goal: TestRunnerPort.cancelCurrentRun on sequential timeout; Jest child wall from outer timeout.
Covers: SC-504
Files: src/application/ports/outbound/TestRunnerPort.ts, src/adapters/outbound/vitest/VitestTestRunner.ts, src/adapters/outbound/jest/JestTestRunner.ts, src/application/use-cases/RunMutationSessionUseCase.ts, src/adapters/outbound/memory/FakeTestRunner.ts, test/mutantLoop.statuses.test.ts
Worker skills: Load before implementing — lean-build, hexagonal-architecture, bdd-unit-test
Acceptance:
- AC1: Given a hang related run, when outer timeout fires, then cancelCurrentRun was called then respawn.
- AC2: Given Jest configureOuterTimeoutMs, when invokeJest runs, then the child timer uses outer plus padding not 120000.
Steps:
- S1: Load Worker skills; add cancelCurrentRun to the port and Vitest/Fake adapters.
- S2: Call cancel then respawn on sequential timeout.
- S3: Jest wall from configureOuterTimeoutMs.
Validation: npm test -- mutantLoop.statuses
Done when: acceptance and validation pass
Depends on: po_360102
Parallel: no

### A3 Cache stable statuses only
- id: po_360103
- priority: high
- status: done
- tags: backend, data
- phase: foundation

Story: As a CI user I do not want a one-off hang cached as Timeout forever.
Goal: Cache set/load only Killed Survived NoCoverage; bump engineVersion to 3.
Covers: SC-503, ADR-035
Files: src/adapters/outbound/cache/FileHashCache.ts, src/application/use-cases/RunMutationSessionUseCase.ts, test/runMutationSession.memory.test.ts, ARCHITECTURE.md
Worker skills: Load before implementing — lean-build, bdd-unit-test
Acceptance:
- AC1: Given a Timeout score, when cache flushes, then that key is absent.
- AC2: Given a loaded entry with Timeout, when get runs, then it is ignored.
- AC3: Given CACHE_ENGINE_VERSION, when inspected, then it is 3.
Steps:
- S1: Load Worker skills; filter statuses in set and load.
- S2: Bump engine version; update memory cache tests.
- S3: Fix ARCHITECTURE.md schema example.
Validation: npm test -- runMutationSession.memory
Done when: acceptance and validation pass
Depends on: (none)
Parallel: yes

### A2 Per-file discover skip
- id: po_360102
- priority: high
- status: done
- tags: backend
- phase: foundation

Story: As a developer I can have one deleted or unparseable dirty file without aborting the whole session.
Goal: exists/readUtf8/discover failures skip with a notice; remaining files score.
Covers: SC-502, ADR-041
Files: src/application/use-cases/RunMutationSessionUseCase.ts, src/adapters/outbound/git/GitDiffLocator.ts, test/runMutationSession.memory.test.ts, test/sourceLocator.git.test.ts
Worker skills: Load before implementing — lean-build, hexagonal-architecture, bdd-unit-test
Acceptance:
- AC1: Given a missing candidate among valid files, when execute runs, then a notice names the skip and other sites score.
- AC2: Given discover throws for one file, when execute runs, then that file is omitted and exit follows remaining statuses.
- AC3: Given git dirty deleted path, when candidateFiles runs, then it is omitted via exists.
Steps:
- S1: Load Worker skills; skip in discoverCandidateSites; notice via ReportPort.
- S2: Filter deleted paths in GitDiffLocator with files.exists.
- S3: Memory and git locator tests.
Validation: npm test -- runMutationSession.memory sourceLocator.git
Done when: acceptance and validation pass
Depends on: (none)
Parallel: yes

### A4 Help and version exit 0
- id: po_360101
- priority: high
- status: done
- tags: backend, api
- phase: foundation

Story: As a developer I can run puca --help or --version and get usage without a refuse.
Goal: --help/-h and --version/-V print to stdout and exit 0; unknown flags still exit 2.
Covers: SC-501
Files: src/adapters/inbound/cli/parseArgs.ts, src/cli.ts, test/cliReport.exit.test.ts
Worker skills: Load before implementing — lean-build, bdd-unit-test
Acceptance:
- AC1: Given --help or -h, when runCli runs, then stdout contains Usage and exit is 0.
- AC2: Given --version or -V, when runCli runs, then stdout contains the package version and exit is 0.
- AC3: Given an unknown flag, when parseArgs runs, then it still throws Unknown argument.
Steps:
- S1: Load Worker skills; add help/version fields to ParsedCliArgs.
- S2: Wire cli.ts stdout printers and exit 0.
- S3: Behavioral tests in cliReport.exit.test.ts.
Validation: npm test -- cliReport.exit
Done when: acceptance and validation pass
Depends on: (none)
Parallel: no
