# Púca Phase 3.1 — Prebuild Pipeline Without npm Publish

Document status: in-review
Planora board: `.planora/puca-phase-3-1-1794680267.planora.md`
Plan profile: feature
Product: Púca — local mutation-testing loop for ESM/Vitest
Package: `puca` (unscoped; **not published to npm this cycle**)
Binary / CLI: `puca`
ID namespace: REQ-9xx (loader), REQ-10xx (packaging), REQ-11xx (CI/origin); SC-3xx; NFR-3xx; ADR-020..028; UX-003
Companion board: `.planora/puca-phase-3-1-1794680267.planora.md`
Phase 1 spec: `.planora/puca-phase-1-technical-solution.md` (still normative except ADR-006 as amended here)
Phase 2 spec: `.planora/puca-phase-2-technical-solution.md` (still normative; no `--workers` / pool deltas in this slice)

This is an architecture specification. It is not implementation source.

Grill lock (Q1–Q30, 2026-11-15): Phase 3.1 serves the Phase 2 buyer (Vitest/TS `puca` users). Centerpiece is a **NAPI prebuild pipeline** so a rust-free host can run packed tarballs. **No npm registry publish**, no `napi pre-publish`, no OIDC trusted publishing. Platform names are unscoped `puca-<abi>` (`@puca` is a third-party npm org). GitHub origin is `https://github.com/RexySaragih/puca`, default branch `master`. First product semver in git is `0.2.0` (phase number is not the npm version). Default no-flag `puca` stays Phase 1+2. Hexagon names stay (`NapiMutatorEngine`, `loadPucaBinding`).

---

## 0. Plan envelope

Applicable domains: backend, data, api, integrations, security, operations

Domain inclusion justification:
- backend: loader cascade in `NapiMutatorEngine`; CLI still maps throw → exit 2
- data: packed `.tgz` artifacts, `npm/<abi>/package.json` stubs, `files` field, version `0.2.0` lifecycle
- api: `napi.packageName`, platform package names, `repository` field, UX-003 stderr, `--json` schema still shipped
- integrations: napi-rs CLI (`create-npm-dirs` / `artifacts` / `build --target`); GitHub Actions; GitHub Releases; `npm pack` (not `npm publish`)
- security: no postinstall CDN; no `NPM_TOKEN`; throw not `process.exit` in the adapter; public native tarballs on GitHub Releases
- operations: `ci.yml` / `release.yml`; rust-free smoke; origin; Windows omit; version bump

Omissions: `ui` — terminal remains UX-001/UX-003 CLI contract, not a screen.

Problem: `npx` / a clean machine cannot run Púca without `rustc`. Phase 1–2 require `npm run build`. This slice must produce platform tarballs and prove a rust-free install scores `fixtures/loop`, without putting immutable packages on the npm registry.

Users:
- Application developers who will later `npx puca` without a Rust toolchain (this cycle: GitHub Release / CI tarballs only)
- Púca maintainers who still `npm run build` with rustc, and who run GHA

Scope: loader cascade; `napi.packageName: "puca"`; committed `npm/<abi>/package.json` stubs; root `files` = `dist` + `schema` (zero `.node`); git `version` `0.2.0`; `repository` URL; public origin; PR `ci.yml` (source tests + host pack smoke); tag `release.yml` (4-target matrix, GitHub Release tarballs, **no registry**); rust-free oracle smoke.

Out of scope: `npm publish`; `napi pre-publish`; npm Trusted Publishing / OIDC; `optionalDependencies` in git `package.json`; `@puca/*`; `--break-on-score`; SARIF/HTML; `.puca/cache.json`; `JestTestRunner`; `--workspace`; template-literal `${}` operator; §3 adversarial product fixtures; musl / linux-arm64 / win-arm64; renaming default branch to `main`; new CLI flags; changing A6, ADR-011, Phase 2 pool semantics.

Assumptions:
- A1–A18 from Phase 1–2 remain in force unless this document names a delta.
- A19: GHA Node is `20` (matches `engines` `>=20.6.0`).
- A20: `gh` can create `RexySaragih/puca` as public; `repository` field is that URL even before the first push.
- A21: `fixtures/loop/oracle.statuses.json` is the smoke oracle (exit 1).
- A22: napi-rs 3 platform dirs are `npm/<abi>/` with `name` `puca-<abi>`; `.node` files stay gitignored (`*.node` already in `.gitignore`).
- A23: First git tag `v0.2.0` is **after** 3.1 lands on `master`, not from the implementation PR.
- A24: Smoke copies tarballs into `smoke-workspace/` then `npm install ./puca-0.2.0.tgz ./puca-<host-abi>-0.2.0.tgz`.
- A25: `hostPlatformAbi()` is unchanged (no musl probe). Unsupported or missing optional → UX-003 + exit 2.
- A26: No new CLI flags. `--workers`, `--mutate`, `--json`, `--timeout`, `--include-untracked`, `--verbose` unchanged.

Success criteria (summary; catalog in §9):
- SC-301: Missing local `.node` and missing `puca-<abi>` → throw UX-003 (includes `puca-<abi>` and `npm run build`).
- SC-302: Package-root `puca-binding.<abi>.node` loads (contributor `npm run build`).
- SC-303: `crates/puca-binding/puca-binding.<abi>.node` loads if root miss.
- SC-304: With no local `.node`, `createRequire` from `root/package.json` loads `puca-<abi>` (installed puca `root` walks to the parent workspace `node_modules`, same as Q24 smoke).
- SC-305: `npm pack` of root contains zero `.node` files and still contains `schema/`.
- SC-306: Platform pack contains `puca-binding.<abi>.node` and declares `os` / `cpu` (`libc` on linux gnu).
- SC-307: PR macos-14 rust-free smoke matches `oracle.statuses.json` (exit 1).
- SC-308: PR ubuntu-latest rust-free smoke matches the same oracle.
- SC-309: Smoke job `which rustc` fails.
- SC-310: CLI missing-binding path still exit 2 (e2e AC4).
- SC-311: Git `package.json` has no `optionalDependencies`.
- SC-312: Workflows contain no `npm publish`, `napi pre-publish`, or `NPM_TOKEN`.
- SC-313: Tag darwin-x64 artifact is `x86_64` Mach-O (`file` / `otool`).
- SC-314: Windows job failure does not fail `release.yml`.
- SC-315: GitHub Release on `v*` attaches root + gate platform `.tgz` (Windows only if that job succeeded).
- SC-316: No-flag `puca` behavior unchanged (Phase 1+2).
- SC-317: Hexagon identifiers unchanged: `NapiMutatorEngine`, `loadPucaBinding`, `bindingCandidatePaths`, `hostPlatformAbi`, `bin` `dist/cli.js`.

Risks:
- R11: Accidental `npm publish` on a `v*` tag (mitigate: no publish steps in `release.yml`; review gate to add them later).
- R12: `file:` optionalDeps inside packed root (rejected; smoke uses sibling tarball install).
- R13: `@puca/binding-*` name collision (rejected; unscoped `puca-<abi>`).
- R14: Smoke `npx puca` inside empty workspace → A6 idle (mitigate: cwd `fixtures/loop` + `--mutate "src/**/*.ts"`).
- R15: Same-job smoke after rustup still has `rustc` on PATH (mitigate: separate Node-only job).
- R6 remains: missing native addon → exit 2.
- R16: e2e missing-NAPI AC4 today symlinks the **repo** `node_modules` onto the empty root. After step 3, that can resolve a locally installed `puca-<abi>` and false-green. Mitigate: AC4 must not share the repo `node_modules`; give the fixture Vitest only.
- R17: A `build` job that `npm pack`s without `tsc` emits a root tarball with no `dist/cli.js`. Mitigate: pack jobs run `npm run build` (or `tsc` + `napi build`) first.

Architecture decisions (index; detail in §3):
- ADR-020: ADR-006 amended — prebuild **pipeline** this cycle; registry publish still forbidden.
- ADR-021: `napi.packageName` `"puca"`; `binaryName` `"puca-binding"`; packages `puca-<abi>`.
- ADR-022: Loader filesystem then `puca-<abi>`; throw; never `process.exit`.
- ADR-023: Packed/published root tarball has zero `.node`; `files` = `dist` + `schema`.
- ADR-024: No `optionalDependencies` in git; smoke sibling-installs both tarballs.
- ADR-025: Two-job rust-free smoke; cwd `fixtures/loop`; oracle match.
- ADR-026: GHA only for release artifacts; no laptop publish; no registry commands.
- ADR-027: Tag `v*` GitHub Releases; Windows omit-if-failed.
- ADR-028: Origin `https://github.com/RexySaragih/puca`; branch `master`.

Delivery strategy: Origin → loader + UX-003 → package manifests/stubs → local pack identity tests → PR `ci.yml` two-job smoke → tag `release.yml` → docs (ADR-006 / PRODUCT / README).

---

## 1. Clarify (Clear / Partial / Missing)

Clear: Buyer; 3.1 vs 3.2 cut; no registry; unscoped names; gates vs Windows; version `0.2.0`; hexagon; throw contract; `files`+schema; GHA topology; smoke cwd/oracle; rust-free job split; origin URL; default branch `master`; UX-003 string.

Partial: `gh repo create` needs network/auth at Build; not a product fork.

Missing: none blocking.

---

## 2. Hexagon (delta)

Phase 1–2 ports stay. **No new port.** Deltas live in the existing NAPI adapter:

- `src/adapters/outbound/napi/NapiMutatorEngine.ts` — extend `loadPucaBinding` / `bindingCandidatePaths` only. Do **not** add `napiMutatorAdapter.ts`.
- `createRuntime` still constructs `NapiMutatorEngine` (which calls `loadPucaBinding()`). Missing binding still throws; `runCli` catch → stderr + exit 2.
- Application and domain still must not import napi, `child_process`, or vitest.
- CLI flags, `TestRunnerPort`, pool, and reports are unchanged.

---

## 3. Architecture decisions

ADR-020: Prebuild pipeline, not npm publish — rationale: Q5/Q19; `npx` without rustc is the buyer pain; registry versions are immutable. Alternatives: publish `0.2.0` now (user locked no); GitHub Releases only as this cycle’s distribution. Consequences: `optionalDependencies` cannot live in git until packages exist; later unlock is a new grill. Confidence: high.

ADR-021: Unscoped `puca-<abi>` — rationale: Q6; `@puca` org is taken (`@puca/puca-front`). Alternatives: new scope `@pucajs`; fat root tarball. Consequences: set `napi.packageName` `"puca"` so napi-rs does not emit `puca-binding-darwin-arm64`. `binaryName` stays `puca-binding` (file `puca-binding.<abi>.node`). Confidence: high.

ADR-022: Filesystem then optional package; throw — rationale: Q10/Q14; contributors `napi build` write root and/or crates `.node`; tests call `loadPucaBinding(root)`. Grill wrote `createRequire(import.meta.url)`; that ignores `root` for step 3, so `loadPucaBinding(tmp)` cannot isolate optional-package lookup. **Refinement:** step 3 is `createRequire(path.join(root, "package.json"))("puca-" + abi)`. Default `root` is `packageRootFromThisModule()` (`node_modules/puca` when installed), so resolution still walks to the parent workspace — same as `import.meta.url` from `dist/adapters/outbound/napi`. Alternatives: `process.exit` in adapter; optional-package-first. Consequences: CLI mapping unchanged; unit tests can stub `puca-<abi>` under `tmp/node_modules`. Confidence: high.

ADR-023: Root tarball JS+schema only — rationale: Q11/Q14; otherwise `npx` can load a host `.node` from the root pack and skip `puca-<abi>`. Alternatives: dual-ship. Consequences: `files` drops `*.node` and `crates/puca-binding/*.node`; keep `schema`. Confidence: high.

ADR-024: No git `optionalDependencies` — rationale: Q21/Q24; unpublished names 404-warn on every `npm install`. Alternatives: `file:` inside packed root (breaks `npm pack`). Consequences: rust-free smoke installs **both** tarballs in a parent workspace so `createRequire` from `node_modules/puca/dist/...` walks up to `puca-<abi>`. Confidence: high.

ADR-025: Isolated smoke job + fixture cwd — rationale: Q29/Q30; A6 idle if no `--mutate`; Vitest from fixture cwd (ADR-003); rustc on PATH is not rust-free. Alternatives: `npx puca` in empty workspace. Consequences: command in §6. Confidence: high.

ADR-026: No registry commands in GHA — rationale: Q12/Q20; tag-triggered publish is a landmine. Alternatives: `if: false` publish steps. Consequences: GitHub Release `.tgz` is the only distribution. Confidence: high.

ADR-027: Windows omit-if-failed — rationale: Q7/Q13/Q28; A9/A16. Alternatives: Windows as merge gate. Consequences: GitHub Release may lack `puca-win32-x64-msvc-0.2.0.tgz`; do not list a missing name. Confidence: high.

ADR-028: Public origin, keep `master` — rationale: Q22/Q26. Alternatives: rename to `main`. Consequences: workflows trigger on `master` and tags `v*`. Confidence: high.

Phase 1 ADR-001..005, 007..012 unchanged. Phase 2 ADR-013..019 unchanged. ADR-006 **amended** by ADR-020 (pipeline yes, registry no).

---

## 4. Loader cascade (REQ-901)

`loadPucaBinding(root = packageRootFromThisModule(), abi = hostPlatformAbi())`:

1. If `root/puca-binding.<abi>.node` exists → `require(that path)`.
2. Else if `root/crates/puca-binding/puca-binding.<abi>.node` exists → `require(that path)`.
3. Else try `createRequire(path.join(root, "package.json"))("puca-" + abi)`.
4. If all miss, or any require/`dlopen` throws: throw `Error` with UX-003. If a load threw, append that `error.message`.

If `root/package.json` is missing (unit tests using a bare temp dir), treat step 3 as a miss and throw UX-003 (do not fall back to `import.meta.url`, or tests cannot isolate).

Do not `process.exit`. Do not postinstall. Do not fetch GitHub/CDN.

`hostPlatformAbi()` stays as shipped (darwin-arm64 / darwin-x64 / linux-x64-gnu / linux-arm64-gnu / win32-x64-msvc / win32-arm64-msvc). linux-arm64-gnu has **no** 3.1 package → step 3 fails → UX-003.

---

## 5. Packaging (REQ-10xx)

Root `package.json`:
- `name`: `puca`
- `version`: `0.2.0`
- `bin.puca`: `./dist/cli.js`
- `files`: `["dist", "schema"]` only
- **no** `optionalDependencies`
- `repository`: `{ "type": "git", "url": "https://github.com/RexySaragih/puca.git" }`
- `napi.binaryName`: `puca-binding`
- `napi.packageName`: `puca`
- `napi.targets`: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`

Committed stubs (no `.node` in git):

| Dir | name | os | cpu | libc |
| --- | --- | --- | --- | --- |
| `npm/darwin-arm64` | `puca-darwin-arm64` | darwin | arm64 | (omit) |
| `npm/darwin-x64` | `puca-darwin-x64` | darwin | x64 | (omit) |
| `npm/linux-x64-gnu` | `puca-linux-x64-gnu` | linux | x64 | glibc |
| `npm/win32-x64-msvc` | `puca-win32-x64-msvc` | win32 | x64 | (omit) |

Each stub: `"main"` / `files` = `puca-binding.<abi>.node`; `version` lockstep `0.2.0`; MIT.

CI copies the compiled file into the stub, then packs that directory (do not depend on an unspecified `napi artifacts` layout):

```
napi build --platform --release --package puca-binding --target <triple>
cp puca-binding.<abi>.node npm/<abi>/puca-binding.<abi>.node
npm pack ./npm/<abi>
```

Root pack (after `npm run build` so `dist/` exists): `npm pack .` with `files` `dist` + `schema`.

---

## 6. Smoke (REQ-1104, REQ-1105)

Build job: rustc, **`npm run build` first** (tsc + napi so `dist/` exists), then pack root + host/matrix platform dirs, upload `.tgz`.

Smoke job: Node 20, **no rustup**. `which rustc` must fail. **Checkout the repo** (for `fixtures/loop` + oracle) **and** download tarballs. Do not run `npm run build` in smoke. Do not put repo `dist/` on `PATH`.

Install fixture JS deps without the repo `node_modules` symlink used by local e2e (R16): `npm install` inside `fixtures/loop` (Vitest only).

```
mkdir smoke-workspace
cp puca-0.2.0.tgz puca-<host-abi>-0.2.0.tgz smoke-workspace/
cd smoke-workspace && npm install ./puca-0.2.0.tgz ./puca-<host-abi>-0.2.0.tgz
```

Then, **cwd = `fixtures/loop`**:

```
<path-to>/smoke-workspace/node_modules/.bin/puca --mutate "src/**/*.ts" --timeout 4000 --json <tmp.json>
```

Assert: process exit code equals `oracle.statuses.json` `exitCode` (1); JSON mutant statuses equal the oracle (same sort as e2e); workspace walk finds no `.puca-tmp` / `.stryker-tmp` / mutated fixture sources.

Do not run `npx puca` inside `smoke-workspace` as cwd (A6 idle). Do not use repo `dist/cli.js` or repo `.node` in the smoke job.

PR execute gates: macos-14 (`darwin-arm64`) and ubuntu-latest (`linux-x64-gnu`). Tag: same two execute; darwin-x64 `file`/`otool` x86_64 Mach-O (execute optional); win32-x64-msvc best-effort (failure does not fail the workflow).

---

## 7. CI and origin (REQ-11xx)

Origin: public `https://github.com/RexySaragih/puca`, default branch `master`.

`.github/workflows/ci.yml` — pull_request / push to `master` (three jobs; ADR-025 “two-job” means rust vs rust-free, not a job-count cap):
- `test` (rust allowed): `macos-14` + `ubuntu-latest`; `npm run build` + `npm test` (existing unit/e2e, including missing-NAPI AC4 **without** repo `node_modules` symlink — R16).
- `build` (rust allowed): `npm run build`; copy `.node` → `npm/<host-abi>/`; `npm pack .` and `npm pack ./npm/<host-abi>`; upload `.tgz`.
- `smoke` (needs `build`; Node only): §6. Fail the PR if smoke fails.

`.github/workflows/release.yml` — tags `v*`:
- Matrix build four targets (`darwin-x64` via `--target x86_64-apple-darwin` on macos-14).
- `napi artifacts` / pack; rust-free smoke on darwin-arm64 + linux-x64-gnu.
- Upload GHA artifacts; attach `.tgz` to GitHub Release.
- **Forbidden strings in both YAML files:** `npm publish`, `napi pre-publish`, `NPM_TOKEN`, `provenance` publish.

No new CLI flags. Exit 0/1/2 unchanged (ADR-011 / A6). Missing binding is refuse exit 2 (SC-114 family).

---

## 8. Failure paths

| Case | Result |
| --- | --- |
| Clone, no `.node`, no `puca-<abi>` | UX-003 throw → CLI exit 2 |
| `.node` present, `dlopen` fails | UX-003 + `error.message` → exit 2 |
| `--no-optional` consumer after future publish | same as missing `puca-<abi>` |
| linux-arm64 / musl / freebsd | UX-003 (no package this cycle) |
| Windows matrix job red | `release.yml` green; no win32 tarball on that Release |
| Clean git + no `--mutate` in smoke cwd | **not used**; smoke always `--mutate` |

No retry. No fallback download.

---

## 9. Requirements catalog

Loader:
- REQ-901 cascade §4
- REQ-902 UX-003 exact text
- REQ-903 append `dlopen` `error.message`
- REQ-904 CLI catch → exit 2 (no adapter `process.exit`)
- REQ-905 `hostPlatformAbi` unchanged (no musl)

Packaging:
- REQ-1001 `napi.packageName` `"puca"`
- REQ-1002 committed `npm/<abi>/package.json` stubs
- REQ-1003 `files` `dist` + `schema`
- REQ-1004 version `0.2.0`
- REQ-1005 `repository` URL
- REQ-1006 names `puca-<abi>`
- REQ-1007 packed root has zero `.node`

CI:
- REQ-1101 origin + `master`
- REQ-1102 `ci.yml` test + pack + rust-free smoke
- REQ-1103 `release.yml` `v*` matrix, no registry
- REQ-1104 smoke command §6
- REQ-1105 smoke `which rustc` fails
- REQ-1106 darwin-x64 Mach-O check
- REQ-1107 Windows non-gating
- REQ-1108 GitHub Release `.tgz`
- REQ-1109 GHA Node 20

SC-301..317 as §0.
NFR-301: no postinstall / CDN. NFR-302: no `@puca/*`. NFR-303: loader does not import `worker_threads`. NFR-304: Node `>=20.6`. NFR-305: Windows not a merge gate.
UX-003: `Native Púca addon is missing for '<abi>'. Looked for puca-binding.<abi>.node (package root, crates/puca-binding) and package 'puca-<abi>'. Install optional dependencies (do not use --no-optional) or run npm run build (requires a Rust toolchain).`
UX-001 unchanged.

---

## 10. Security

| Boundary | Trust | Controls |
| --- | --- | --- |
| Native `.node` | Maintainer CI produces it | Gitignore artifacts; GitHub Release is public (accepted); no install-script download |
| Loader | Runs in CLI process | Throw; no `process.exit`; no network |
| npm registry | Not used this cycle | No `NPM_TOKEN`; no publish steps |
| User tests | Unchanged Phase 1–2 | RAM mutants; smoke still AC2 walk |

Forbidden: `@puca/*`; postinstall fetch; laptop `npm publish`; `optionalDependencies` on unpublished names in git.

---

## 11. Operations

- Contributors: `npm run build` (tsc + `napi build --platform --release --package puca-binding`) still required for local tests.
- Consumers this cycle: GitHub Release `.tgz` pair (root + matching abi), or GHA artifacts.
- Observability: UX-003 on stderr; smoke oracle vs `fixtures/loop/oracle.statuses.json`.
- Rollback: git revert; do not un-publish (nothing was published). GitHub Release assets may stay.
- Unlock npm later: new grill; add `optionalDependencies` + trusted publishing then.

---

## 12. Test strategy

- Unit: cascade order; UX-003 regex; host `.node` still loads; missing root throws; optional `puca-<abi>` JS stub under **that same temp root’s** `node_modules` proves step 3 (`loadPucaBinding(tmp)` must not see the repo’s `puca-<abi>`).
- Pack: `npm pack` root; `tar tzf` has `schema/` and no `.node`.
- E2E AC4: exit 2; stderr matches UX-003. Empty root must **not** symlink the repo `node_modules` (R16); install or symlink **vitest only** for the fixture cwd.
- GHA: SC-307..315. Existing `e2e.loopFixture` source-build tests stay on the rust `test` job.
- Cruise: application still free of napi/fs addon paths beyond the adapter.

---

## 13. Open items

None blocking. Creating `RexySaragih/puca` is a Setup ticket (needs `gh` auth at Build).

End of technical solution.
