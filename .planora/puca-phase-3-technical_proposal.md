# Púca Phase 3 Technical Proposal
## Post-3.1 Roadmap Through Final Phase 3.4 Consolidation

Document status: roadmap (aligned 2026-11-15; Phases 3.2–3.4 grilled)
Companions:
- 3.2: `.planora/puca-phase-3-2-technical-solution.md` · `.planora/puca-phase-3-2-1794710717.planora.md`
- 3.3: `.planora/puca-phase-3-3-technical-solution.md` · `.planora/puca-phase-3-3-1794711350.planora.md`
- 3.4: `.planora/puca-phase-3-4-technical-solution.md` · `.planora/puca-phase-3-4-1794712087.planora.md`

---

## 1. Executive summary

Phases 1–2: local Vitest RAM loop + `--workers` pool.  
Phase **3.1 shipped**: GitHub Release `puca` + `puca-<abi>` tarballs (no npm registry).  
Phases **3.2–3.4**: planned slices; **3.4 is the last Phase 3 cut** (no 3.5).

| Slice | Status | Mission |
| :--- | :--- | :--- |
| **3.1 Distribution** | **Shipped** | Rust-free GitHub Release tarballs |
| **3.2 Local accuracy + terminal** | **Planned** | TemplateLiteral `${}` skip; File Summary table |
| **3.3 Opt-in CI gates + SARIF** | **Planned** | `--break-on-score`, `--fail-on-no-coverage`, `--sarif` |
| **3.4 Final consolidation** | **Planned** | Native `--html`, `--cache`, `--workspace`, `--runner jest` |
| **Phase 4+** | Deferred | npm OIDC publish, Jest worker pool, etc. |

**Vitest-first.** Jest is opt-in in 3.4 only.  
**Zero** `@stryker-mutator/*` scoped UI packages. Keep unscoped `mutation-testing-report-schema` for `--json`.  
**npm publish is OUT of all Phase 3** (deferred to Phase 4).

---

## 2. Phase 3.1 — shipped

Unscoped `puca-<abi>`; loader cascade; GHA smoke; GitHub Releases; no registry publish.  
Spec: `.planora/puca-phase-3-1-technical-solution.md`.

---

## 3. Phase 3.2 — local accuracy

TemplateLiteral expression skip (no flag); stdout File Summary; SC-321..327.  
Spec: `.planora/puca-phase-3-2-technical-solution.md`.

---

## 4. Phase 3.3 — CI gates + SARIF

`--break-on-score`, `--fail-on-no-coverage`, `--sarif <path>`; Survived-only SARIF; SC-331..338.  
HTML **not** in 3.3. Spec: `.planora/puca-phase-3-3-technical-solution.md`.

---

## 5. Phase 3.4 — final consolidation (five waves)

Single milestone, ordered waves (no further 3.x):

| Wave | Deliverable |
| :--- | :--- |
| **A** | Native static `--html <path>` (self-contained; zero Stryker UI; zero CDN) |
| **B** | Opt-in `--cache` → `.puca/cache.json` status metadata only |
| **C** | `--workspace <glob>` sequential per-package sessions; worst-of exit |
| **D** | `--runner jest` via `JestTestRunner`; workers forced to 1; `fixtures/jest-loop` |
| **E** | SC-345..348 audit + docs closeout |

SC-341..348. Spec: `.planora/puca-phase-3-4-technical-solution.md`.

---

## 6. Deferred to Phase 4+

| Item | Why |
| :--- | :--- |
| npm registry publish + OIDC + git `optionalDependencies` | Explicit unlock after Phase 3 |
| Jest multi-worker / fork pool parity | 3.4 is single-worker only |
| Template `${}` opt-in flag | No buyer |

---

## 7. Architecture snapshot

```
CLI → RunMutationSession (+ workspace multi-session in 3.4)
  → MutatorEngine (puca-core)          ← 3.2 TemplateLiteral skip
  → TestRunner: Vitest | Jest          ← 3.4 Jest opt-in
  → CachePort (optional)               ← 3.4
  → Report: Stdio + Json + Sarif + Html
```

Distribution: GitHub Release tarballs through end of Phase 3.

---

## 8. CLI flags (through 3.4)

```text
# Phases 1–2
--mutate --workers --timeout --json --include-untracked --verbose

# Phase 3.3
--break-on-score <n> --fail-on-no-coverage --sarif <path>

# Phase 3.4
--html <path> --cache --workspace <glob> --runner vitest|jest
```

No-flag default remains Phase 1–3.2 local Vitest loop (+ 3.2 accuracy/UX once built).

---

## 9. Success signals

| Slice | Signal |
| :--- | :--- |
| 3.1 | Rust-free smoke = loop oracle; no publish in workflows |
| 3.2 | SC-321..327 |
| 3.3 | SC-331..338; no-flag unchanged |
| 3.4 | SC-341..348; no `@stryker-mutator/*`; no npm publish |
