# Púca Phase 2 — Fork-Pool Parallel Scoring

Document status: in-review
Planora board: `.planora/puca-phase-2-1794677671.planora.md`
Plan profile: feature
Product: Púca — local mutation-testing loop for ESM/Vitest
Package: `puca` (unscoped; not published this cycle)
Binary / CLI: `puca`
ID namespace: REQ-7xx (pool/child/IPC), REQ-8xx (CLI `--workers` / JSON order / verbose recycles); SC-2xx; NFR-2xx; ADR-013..019; UX-002
Companion board: `.planora/puca-phase-2-1794677671.planora.md`
Phase 1 spec: `.planora/puca-phase-1-technical-solution.md` (still normative for everything this document does not change)

This is an architecture specification. It is not implementation source.

Grill lock (Q1–Q30, 2026-11-15): Phase 2 is hired only to speed the existing local Vitest pre-commit loop. Measure wall-clock vs Phase 1 on `fixtures/loop` (or a checked-in `fixtures/loop-parallel` if loop is too small). No Stryker bake-off, npm prebuilds, disk cache, V8 coverage maps, TUI, `@puca/*`, or `worker_threads`. Centerpiece: `child_process.fork` pool of isolated `VitestTestRunner` sessions. `--workers` default 1 is the Phase 1 in-process path.

---

## 0. Plan envelope

Applicable domains: backend, data, api, integrations, security, operations

Domain inclusion justification:
- backend: parent orchestrator, coordinator Vitest, N scoring children, timeout/RSS/crash recycle
- data: per-child RAM overlay; ephemeral IPC payloads; `--json` mutant order; no durable cache
- api: `--workers`; IPC wire schema; `TestRunnerPort` concurrency; schema JSON sort
- integrations: `child_process.fork`; `vitest/node` from cwd in parent coordinator and every child
- security: mutated source over IPC; `execArgv: []`; `child.kill` blast radius; still no mutant files on disk
- operations: `--workers` runtime flag; source-build unchanged; Windows still not a gate

Omissions: `ui` — terminal remains UX-001/UX-002 CLI contract, not a screen.

Problem: Phase 1 scores mutants sequentially on one keep-alive Vitest. On dirty trees with many sites, wall-clock is bounded by one session. Phase 2 must run N isolated keep-alives without leaking overlays (R1/SC-118) and without changing default (`--workers 1`) behavior.

Users:
- Application developers who opt in with `--workers N` for faster local runs
- Púca maintainers proving oracle identity at N=1 and non-regression wall-clock at N=4 on the in-repo fixture

Scope: `--workers` flag; in-process path when N=1; `PooledVitestTestRunner` when N>=2; coordinator reverse-map + baseline then close then fork N; parent NAPI discover/apply; parent NoCoverage; child inject + `runRelated`; parent timeout kill; RSS recycle 512 MiB; crash → RuntimeError; `globalSetup` + N>=2 → exit 2; JSON sort by `site.id`; `--verbose` recycle count.

Out of scope: V8 `node:inspector` coverage; `.puca/cache.json`; `worker_threads` as the isolation primitive; npm `optionalDependencies` prebuilds; GitHub Actions publish matrix; Stryker/`zod`/`date-fns` bake-offs; live TUI; `puca.config.ts`; `@puca/*`; new mutator operators; changing A6, hard excludes, or Phase 1 statuses.

Assumptions:
- A1–A12 from Phase 1 remain in force unless this document names a delta.
- A13: `--workers` omitted → `1`. Invalid `--workers` → exit 2 (refuse).
- A14: `WORKER_RSS_CAP_BYTES = 512 * 1024 * 1024`. Named constant; no extra flag.
- A15: Peak live Vitest hosts = `max(1, N)` (coordinator never overlaps scoring children).
- A16: Windows remains best-effort (Phase 1 A9). Fork/kill/RSS must work on the maintainer Darwin/Linux gate.
- A17: `setupFiles` still load in each scoring child. Only `globalSetup` refuses N>=2.
- A18: Child `TIMEOUT` IPC status is ignored if it arrives after parent kill; parent timer is source of truth.

Success criteria (summary; catalog in §9):
- SC-201: `--workers 1` (or omitted) matches Phase 1 `fixtures/loop` oracle 100% (sorted by site id).
- SC-202: `--workers 4` wall-clock including warm pool ≤ Phase 1 sequential on the same machine on `fixtures/loop`, or on checked-in `fixtures/loop-parallel` if loop cannot win.
- SC-203: Bad `--workers` → exit 2 + stderr diagnostic.
- SC-204: Hung mutant → Timeout; only that child is killed; others continue; mutant not retried.
- SC-205: `rssBytes > 512 MiB` after a live response → recycle child; status unchanged (not Timeout).
- SC-206: Child crash/disconnect → RuntimeError + stderr `message`; replace child; no retry; run exit 2.
- SC-207: Project `globalSetup` set and `--workers >= 2` → exit 2 before scoring forks.
- SC-208: `--json` for N=1 and N=4 is equal after per-file mutants sorted by `site.id`.
- SC-209: Empty related specs → NoCoverage in parent; no IPC.
- SC-210: Two in-flight mutants on different children never share a RAM `Map` (SC-118 across processes).
- SC-211: Workspace walk still finds no mutant sandbox dirs / mutated sources.
- SC-212: Default `puca` with no `--workers` uses in-process `VitestTestRunner` (no `fork`).

Risks:
- R7: Nested `worker_threads` + Vite (rejected; forks only).
- R8: N× `globalSetup` port binds (mitigate: refuse N>=2 when `globalSetup` is set).
- R9: Large `mutatedSource` IPC (accepted; structured clone; no shared memory).
- R10: RSS recycle too aggressive on jsdom children (512 MiB cap; recycle is not Timeout).
- R1/R5 remain: leak and hang; now per child instead of one session.

Architecture decisions (index; detail in §3):
- ADR-013: Isolation primitive is `child_process.fork`, not `worker_threads`, not shared in-process `Map`.
- ADR-014: Coordinator `VitestTestRunner` for reverse-map + baseline; close; then N scoring forks.
- ADR-015: `process.send` IPC; stdout/stderr are not the protocol.
- ADR-016: `--workers === 1` in-process Phase 1 path; N>=2 `PooledVitestTestRunner`.
- ADR-017: `globalSetup` + N>=2 refuse exit 2.
- ADR-018: Post-mutant RSS cap 512 MiB via child-reported `rssBytes`.
- ADR-019: Outer timeout is a parent timer per IPC call; kill assigns Timeout.

Delivery strategy: Flag + input wiring → child entry + IPC types → pooled runner (coordinator, fork, timeout, RSS, crash) → use-case promise pool → JSON sort / verbose recycles → fixture E2E (N=1 oracle, N=4 wall-clock, leak, no sandbox).

---

## 1. Clarify (Clear / Partial / Missing)

Clear: Product job; leftovers F1–F7 out of Phase 2; source-build; no cache; no V8 maps; fork isolation; parent/child matrix; work-stealing; `--workers` default 1; Timeout/RSS/crash contracts; bench fixture; UX-001 + JSON sort; hexagon names; IPC rssBytes; use-case concurrency; parse rules; child stdio; fork cwd/`execArgv`; Phase 1 invariants.

Partial: If `fixtures/loop` is too small for SC-202, add `fixtures/loop-parallel` in the E2E ticket (same oracle rules, more sites). Not blocking.

Missing: none blocking.

---

## 2. Hexagon (delta)

Phase 1 ports stay. Deltas:

- `MutationSessionInput.workers: number` (default 1).
- `createRuntime({ cwd, workers, useFakes })`: prod `workers === 1` → `VitestTestRunner`; `workers >= 2` → `PooledVitestTestRunner`. Fakes still `FakeTestRunner` (serializes `runRelated`).
- New adapter `src/adapters/outbound/vitest/PooledVitestTestRunner.ts` implements `TestRunnerPort`.
- New child entry `src/adapters/outbound/vitest/vitestChildMain.ts` (built to `dist/adapters/outbound/vitest/vitestChildMain.js`).
- Application and domain still must not import `child_process`, `vitest`, `vite`, or napi.
- Scoring path for N>=2: use case does **not** call `setBuffer` / `invalidateFile` / `respawn()`. Injection lives in the child. Timeout/RSS/crash recycle live in the pool adapter.
- Scoring path for N=1: Phase 1 use-case loop (setBuffer, sequential `runRelated`, respawn on Timeout).

`VitestTestRunner` remains the one-session runner: parent coordinator, in-process N=1, and inside each child.

---

## 3. Architecture decisions

ADR-013: `child_process.fork` pool — rationale: Q8; isolated Vitest, `child.kill`, process RSS; alternatives: `worker_threads` (Vite/NAPI nesting), shared plugin `Map` (R1); consequences: N `createVitest`; IPC of source strings; confidence: high.

ADR-014: Coordinator then pool — rationale: Q18; reverse-map + baseline need Vite; alternatives: N baselines, bootstrap-child graph IPC; consequences: `baseline()` closes coordinator then spawns N; peak `max(1,N)`; confidence: high.

ADR-015: fork IPC — rationale: Q21/Q25/Q28; alternatives: JSON stdin (collides with logs), SharedArrayBuffer; consequences: `serialization: 'advanced'`; stdio ignore/pipe/pipe/ipc; confidence: high.

ADR-016: N=1 in-process — rationale: Q11/Q17; alternatives: always fork; consequences: SC-201 never pays IPC; `createRuntime` branches; confidence: high.

ADR-017: `globalSetup` refuse — rationale: Q20; alternatives: N× globalSetup, silently drop globalSetup; consequences: detect from coordinator Vitest config; exit 2; confidence: high.

ADR-018: RSS via `rssBytes` — rationale: Q13/Q25; alternatives: `/proc`/`ps`; consequences: missing rssBytes treated as 0 (no recycle); confidence: high.

ADR-019: Parent timeout — rationale: Q12/Q25; alternatives: child sends TIMEOUT then dies; consequences: late child TIMEOUT ignored; no retry; confidence: high.

Phase 1 ADR-001..012 unchanged. ADR-006 (source-first NAPI) still forbids prebuild matrix this cycle.

---

## 4. Runtime flow (N>=2)

1. Locate candidates (Phase 1 GitDiffLocator / `--mutate`). A6 unchanged. Do not fork yet.
2. `PooledVitestTestRunner.startSession` may no-op; `buildReverseMap` + `baseline` use an in-process coordinator `VitestTestRunner`.
3. If Vitest config defines `globalSetup` (non-empty) → close coordinator, throw refuse (CLI exit 2) with message instructing `--workers 1`.
4. Baseline red → close coordinator, exit 2 (Phase 1 SC-106). Do not spawn scoring children.
5. Baseline green → close coordinator fully (Vite server/handles). Spawn N children (`fork` of `vitestChildMain.js`).
6. Parent discovers sites (NAPI) and applies lazily.
7. Empty `related` → NoCoverage in the parent (SC-209).
8. Use case promise pool of size N: `apply` then `runRelated({ file, mutatedSource, relatedSpecs })`.
9. Adapter waits for a free child, `process.send` request, parent timer = existing outer timeout (`--timeout` or max(testTimeout+2000, 7000)).
10. Live response → map status; if `rssBytes > WORKER_RSS_CAP_BYTES`, close that child and spawn a replacement before the next job on that slot.
11. Timer fire → `child.kill()`, Timeout, spawn replacement, do not retry.
12. Crash/exit/disconnect before a live response → RuntimeError, capture stderr into `message`, spawn replacement, do not retry.
13. Terminal `writeMutantResult` in completion order. `--json` sorts mutants by `site.id` per file. `--verbose` recycle count = timeout kills + RSS recycles (not Phase 1 session respawns).

N=1 skips steps 5 and 8–12 pool behavior; Phase 1 sequential loop.

---

## 5. IPC wire (REQ-703)

Request (parent → child):

```
{ mutantId: string, file: string, mutatedSource: string, relatedSpecs: string[] }
```

`mutantId` is `site.id`.

Response (child → parent):

```
{ mutantId: string, status: 'KILLED' | 'SURVIVED' | 'TIMEOUT' | 'ERROR', killedBy?: string, message?: string, rssBytes?: number }
```

Map: KILLED → Killed (`killedBy`); SURVIVED → Survived; ERROR → RuntimeError; TIMEOUT from child is ignored when the parent already killed. Parent-inferred hang is Timeout even if no response.

Child locally: `setBuffer` / `invalidateFile` / `runRelated` / clear on **its** `VitestTestRunner` (`maxWorkers: 1`, own `Map`). NAPI is not loaded in the child.

---

## 6. Fork spawn (REQ-716)

```
fork(vitestChildMainJs, [], {
  cwd: process.cwd(),
  serialization: 'advanced',
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  execArgv: [],
})
```

Child resolves `vitest/node` from that cwd (ADR-003). Piped stdout/stderr ignored during scoring; on ERROR/crash parent attaches buffered stderr to `message`.

---

## 7. CLI delta (REQ-801)

Flags add `--workers <n>` / `--workers=n`.
- Omit → 1.
- n must be an integer ≥ 1. Missing value, `0`, negative, float, non-numeric → throw (CLI exit 2) same as bad `--timeout`.
- No upper cap.
- Passed as `MutationSessionInput.workers` and `createRuntime({ workers })`.

`--verbose` footer: `Vitest respawns` remains for N=1; for N>=2 print recycle count (timeout kills + RSS recycles).

JSON: after grouping by file, sort `mutants` by `id` (`site.id`).

Exit 0/1/2 unchanged (ADR-011 / A6). `globalSetup` refuse is exit 2.

---

## 8. Failure and retry

- No retry of Timeout, RuntimeError, or RSS-recycled successes.
- Kill/replace only the offending child; sibling children keep their sessions.
- Pool `respawn()` is not used by the use case for N>=2 (no-op or unused).
- Coordinator failure before spawn: no scoring children leaked (close in `finally`).

---

## 9. Requirements catalog

Pool / child:
- REQ-701 `PooledVitestTestRunner` implements `TestRunnerPort`
- REQ-702 `vitestChildMain.ts` child entry
- REQ-703 IPC schema §5
- REQ-704 N=1 in-process `VitestTestRunner`
- REQ-705 N>=2 fork pool
- REQ-706 coordinator map+baseline then close then spawn
- REQ-707 peak `max(1, N)`
- REQ-708 parent discover/apply/NoCoverage
- REQ-709 child own overlay, `maxWorkers: 1`
- REQ-710 one in-flight mutant per child; extra `runRelated` waits
- REQ-711 parent timer, `child.kill`, Timeout, replace, no retry
- REQ-712 RSS recycle after live response
- REQ-713 crash → RuntimeError, replace, no retry
- REQ-714 `globalSetup` + N>=2 exit 2
- REQ-715 stdio policy
- REQ-716 fork options
- REQ-717 use-case promise pool; no parent `setBuffer`/`respawn` for N>=2
- REQ-718 `FakeTestRunner` serializes

CLI / report:
- REQ-801 `--workers` parse
- REQ-802 JSON sort by site.id
- REQ-803 verbose recycle count
- REQ-804 `createRuntime({ workers })`

SC-201..212 as §0.
NFR-201 = SC-201. NFR-202 = SC-202. NFR-203: no `worker_threads` in src. NFR-204: no `.puca/cache.json`.
UX-001 unchanged. UX-002: terminal completion order; JSON sorted.
ADR-013..019.

---

## 10. Security

| Boundary | Trust | Controls |
|----------|-------|----------|
| Mutated source on IPC | Same as in-process overlay | Not written to disk; child only applies to its Map; `isUnderCwd` still on reads |
| Child process | User tests run there | `execArgv: []`; cwd = project; kill one child only |
| `child.kill` | Parent privileged vs child | Only the hung/crashed slot |
| Vitest in child | User-installed | Resolve from cwd, not Púca’s copy |

Forbidden: `worker_threads` isolation; shared parent `Map`; `shell: true`; mutant files on disk; inheriting parent inspector flags.

---

## 11. Operations

- Still `npm run build` (tsc + napi). Child entry must be in `tsconfig.build.json` include (src/**).
- No publish matrix.
- `--workers` is the only new runtime knob.
- Observability: refuse stderr (`globalSetup`, bad `--workers`); `--verbose` recycles.

---

## 12. Test strategy

- Parse: `--workers` happy/refuse cases in `test/cliReport.exit.test.ts`.
- Use case: FakeTestRunner sequential; N>=2 path does not call `setBuffer`/`respawn`; NoCoverage without `runRelated`.
- Pool: stub child or fork a test double — free-child queue, timeout kill, RSS recycle, crash Error, globalSetup refuse, coordinator closed before spawn.
- E2E: `puca --workers 1 --mutate 'src/**/*.ts'` in `fixtures/loop` = oracle; `--workers 4` statuses sorted equal + wall-clock ≤ sequential; tmp walker; two children cannot leak overlays (SC-210).
- Cruise: `dist/application` still free of `child_process`.

---

## 13. Open items

None blocking. SC-202 fixture scale is an E2E ticket fallback (`fixtures/loop-parallel`), not a product fork.

End of technical solution.
