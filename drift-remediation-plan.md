# Drift Remediation Plan

## Purpose

Bring current documentation, migration policy, API inventory, configuration guidance, and planning records back into agreement with executable behavior, then add focused automated checks that prevent the same classes of drift from returning.

This is an execution plan, not an assertion that every provisional baseline below is already authoritative. Repository code and tests must resolve uncertain facts before current claims are rewritten.

## Progress

Update this section whenever work starts, completes, becomes blocked, or changes scope.

**Overall status:** Complete
**Current phase:** Phase 6 - Complete
**Last updated:** 2026-08-14
**Coordinator:** OpenCode coordinating implementation agent
**Blockers:** None recorded

### Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete and validated
- `[!]` Blocked; explain in the decision or blocker log
- `[-]` Accepted exclusion; allowed only for an explicitly conditional task or with recorded user approval

### Milestone Tracker

| Phase | Scope | Status | Evidence |
| --- | --- | --- | --- |
| 0 | Establish authoritative current facts | [x] | v53r1; v46-v52 upgrade reachability; 111 counted operations plus discovery; configuration and document authority inventories recorded below. |
| 1 | Decide and enforce migration support policy | [x] | Runtime policy, populated v46-v52 full-startup matrix, archive distinction, and operator guidance aligned. |
| 2 | Reconcile current API and release documentation | [x] | v53r1/111-operation current claims, sole parseable inventory, nine added operations, migration and architecture guidance reconciled. |
| 3 | Reconcile planning, handoff, and documentation ownership | [x] | Roadmap authority, compact ledger, current handoff, retired reroll TODO, historical preambles, and complete docs index aligned. |
| 4 | Reconcile configuration examples and guidance | [x] | Complete root example, scoped server example, classified inventory, provider precedence/host/live-test corrections, and no-auto-load guidance aligned. |
| 5 | Add executable drift-prevention checks | [x] | One discovered server test covers schema/count claims, Fastify inventory, docs ownership, offline links/anchors, and configuration coverage without side effects. |
| 6 | Independent review and final validation | [x] | Four independent read-only reviews, all confirmed remediations, final focused checks, `git diff --check`, and canonical health passed. |

## Initial Evidence

These were starting points for Phase 0 and are retained as resolved plan context, not current claims.

- Runtime schema constants are version `53`, revision `1` in `server/src/repo/db/schema.ts`.
- At plan start, active documents still contained current-state claims for v47 or v48, including `README.md`, `devplan.md`, `docs/ROADMAP.md`, `docs/api.md`, `docs/operations.md`, and `docs/repo-architecture.md`.
- Runtime currently rejects schema markers at or below v45, despite a nearby comment describing a two-version support window.
- Preliminary route registration review found 111 explicit RPG method/path operations, excluding `GET /api/rpg/v1/features` and implicit `HEAD`. The coordinator must derive and verify this count from runtime registration before publishing it.
- At plan start, `docs/api.md` did not fully inventory recent character reroll, actor placement, combat reward, generated campaign read, and material publication routes.
- At plan start, `docs/campaign-generation.md`, `docs/interactive-gameplay-agent-instructions.md`, and `docs/planning-board.md` were not listed in `docs/README.md`.
- Root and server environment examples cover different incomplete subsets of the variables described by code and `docs/operations.md`.
- Existing workspace tests discover focused Vitest files automatically, so drift checks can join the existing test gate without a duplicate CI phase.

## Working Rules

- Preserve unrelated user or agent changes. Never revert work that is outside this plan.
- Keep one coordinating agent responsible for synthesis, edits, validation, and progress updates.
- Use subagents for bounded, independent, read-only research and final review. Do not let multiple agents edit overlapping files.
- If edit delegation is unavoidable, assign disjoint files and require agents to avoid formatting or cleanup outside those files.
- Treat runtime code and tests as evidence, not automatically as intended policy. Migration compatibility is a product decision and must be recorded explicitly.
- Unless stronger repository evidence establishes a narrower approved policy, use the non-destructive migration default for this plan: preserve currently accepted persisted inputs, document that support accurately, and strengthen its executable evidence.
- Keep historical checkpoint claims when they are clearly labeled and useful. Correct only claims presented as current, or qualify historical language that can be mistaken for current policy.
- Prefer the smallest automated guard that checks an existing authority. Do not create a second hand-maintained source of truth.
- Follow `AGENTS.md` and `CONTRIBUTING.md`: run focused tests and owning-workspace typechecks during implementation, then one final broad gate.
- Do not commit, push, or create a pull request unless separately requested.

## Subagent Strategy

The coordinator should launch independent research tasks in parallel where possible.

### Initial Read-Only Research

- **Route inventory researcher:** derive normalized explicit Fastify method/path registrations, explain implicit `HEAD` handling, compare the result with `docs/api.md`, and report exact discrepancies.
- **Migration policy researcher:** map schema constants, actual accepted markers, migration sequencing, active tests, canonical populated fixtures, and all current support-window claims.
- **Documentation researcher:** classify each Markdown file as normative, operational, current planning, historical, or ancillary; identify stale current claims, broken ownership statements, and orphan documents.
- **Configuration researcher:** inventory production, client-development, and test-only environment variables, defaults, validation, precedence, and coverage in examples/docs.
- **Guardrail researcher:** inspect current Fastify, Vitest, Zod, npm workspace, and CI conventions and recommend minimal drift tests without adding unnecessary dependencies.

Every research prompt must say: read-only; do not edit, format, stage, generate, or commit; return file/line evidence, uncertainties, and acceptance-test suggestions.

### Researching August 2026 Best Practices

Repository facts remain authoritative for Velvet behavior. External research is appropriate only where implementation depends on tool behavior or current ecosystem practice. When needed, research sources current as of August 2026 and record links plus access dates in the research log.

Potential research topics:

- Fastify v5 `onRoute` semantics, encapsulation, route prefixes, method arrays, and implicit `HEAD` registration.
- Zod 4 JSON Schema behavior and input/output distinctions if contract-backed examples are introduced.
- Current deterministic Markdown link and anchor checking options, including offline behavior and supply-chain implications.
- GitHub Actions behavior for required checks, skipped jobs, path filters, permissions, concurrency, and artifact retention.
- Current OpenAPI 3.1/3.2 tooling only if a real OpenAPI consumer is identified. OpenAPI is not required merely to fix drift.

Prefer primary sources: official Fastify, Zod, GitHub, npm, TypeScript, and OpenAPI documentation or release notes. Record why each external conclusion applies to the versions actually installed in this repository.

### Final Read-Only Review

After implementation and focused validation, run these reviews in parallel:

- **Correctness reviewer:** look for false authoritative claims, route count mistakes, migration-policy mismatches, and missing tests.
- **Documentation reviewer:** check current-versus-historical wording, links, ownership, readability, and progress records.
- **Test/CI reviewer:** check determinism, false positives, runtime side effects, CI discovery, and redundant validation.
- **Security reviewer:** check that configuration or documentation changes do not imply remote safety, authentication, or broader credential transmission.

The coordinator owns all remediation from review findings and reruns affected validation.

## Phase 0: Establish Authoritative Current Facts

**Goal:** produce a reviewed factual baseline before changing current claims.

- [x] Record the exact schema version and revision from runtime constants.
- [x] Derive the explicit RPG method/path manifest from Fastify registration.
- [x] Define and document the route counting rules: prefix normalization, feature discovery treatment, multi-method routes, and implicit `HEAD` exclusion.
- [x] Verify the provisional count of 111 or replace it with the runtime-derived result.
- [x] Inventory schema markers currently accepted by startup and the migrations traversed by each marker.
- [x] Separate currently executable migration reachability from the migration window the project intends to support.
- [x] Inventory production, client-development, and test-only environment keys and defaults.
- [x] Classify Markdown documents by authority and historical status.
- [x] Record delivered v49-v53 capabilities that affect current roadmap, API, architecture, or handoff claims.
- [x] Add all resolved facts and unresolved policy questions to the logs below.

**Acceptance criteria:**

- Each current fact has one named executable or explicitly designated authority.
- Route inventory is reproducible and does not depend on manual arithmetic.
- Unresolved policy choices are not presented as shipped facts.
- No production behavior has changed during this phase.

## Phase 1: Decide and Enforce Migration Support Policy

**Goal:** make intended compatibility, runtime acceptance, tests, and operator guidance agree.

- [x] Decide whether v53 supports only canonical populated v51/v52 inputs, all currently reachable v46-v52 inputs, or another explicit set.
- [x] Record the decision, rationale, data-preservation implications, and rollback expectations in the decision log.
- [-] If narrowing support, reject unsupported markers before cleanup, schema dependency resolution, or mutation. Conditional path not used; broad accepted compatibility is retained.
- [x] If retaining broad support, remove inaccurate “two-version” language and add evidence for every promised input.
- [x] Add or strengthen full-startup tests using canonical populated fixtures for every supported marker.
- [x] Assert unsupported markers fail before mutation and preserve marker/data state.
- [x] Preserve isolated historical migration-unit tests, but label them so they do not imply current startup support.
- [x] Test fresh/current schema parity, foreign-key integrity, rollback on late failure, and marker preservation where relevant.
- [x] Update `server/test/MIGRATION_TEST_ARCHIVE.md` to distinguish active support evidence from historical migration coverage.

**Acceptance criteria:**

- Runtime acceptance exactly matches the recorded support policy.
- Every supported input has canonical populated full-startup evidence.
- Every unsupported input fails before mutation.
- Operator documentation states the same window and backup/downgrade limitations.

**Focused validation:**

```bash
npm run test --workspace velvet-mvp-server -- test/migration-support-window.test.ts
npm run test --workspace velvet-mvp-server -- test/migration-v51.test.ts test/migration-v52.test.ts test/migration-v53.test.ts
npm run typecheck --workspace velvet-mvp-server
```

Adjust the focused file list to the final test ownership. Do not add a duplicate migration phase to CI.

## Phase 2: Reconcile Current API and Release Documentation

**Goal:** make all current-facing schema, operation, API, architecture, and operational claims accurate.

- [x] Update the current release statement in `README.md` and remove its internally inconsistent persistence statement.
- [x] Update `docs/api.md` with the verified method/path inventory and counting convention. Its parseable operation table is the sole checked documentation inventory; runtime Fastify registration remains the executable authority.
- [x] Document all currently registered operations missing from `docs/api.md`, including their feature gates, body/query rules, response contracts, errors, privacy, idempotency, and reconciliation semantics.
- [x] Update `docs/operations.md` with the decided support window and current schema behavior.
- [x] Extend `docs/repo-architecture.md` through v53 and document current migration ownership and integrity guarantees.
- [x] Update current-status sections in `docs/customizable-harness.md` and architecture/integration documents without rewriting valid historical checkpoints.
- [x] Ensure campaign generation and material publication documentation agrees with the normative API reference.
- [x] Remove manually accumulated operation arithmetic where a generated or checked manifest can be referenced instead.

**Acceptance criteria:**

- No normative/current document claims v47 or v48 as current.
- Current route count and inventory match runtime registration.
- Every current operation documents or links to its feature gate, input/body/query rules, response contract, error behavior, privacy constraints, and idempotency/reconciliation semantics where applicable.
- Current migration claims match Phase 1.
- Historical version/count statements are clearly scoped to their checkpoint.
- Security text still states fixed `local-owner`, loopback-only operation, and no authentication boundary.

## Phase 3: Reconcile Planning, Handoff, and Documentation Ownership

**Goal:** restore a clear hierarchy for current status, actionable work, and historical records.

- [x] Update `docs/ROADMAP.md` as the owner of milestone status, including delivered v49-v53 work and remaining exclusions.
- [x] Reduce `devplan.md` to an accurate compact status ledger that does not contradict its completed entries.
- [x] Update `handoff.md` with the current release baseline and the next unfinished task after drift remediation.
- [x] Resolve `todo.md` if its reroll request is already delivered: mark it complete, replace it with remaining scope, or retire it with an explanation.
- [x] Update current-status preambles in historical integration plans so they defer clearly to current authorities.
- [x] Add every maintained `docs/*.md` file other than the index itself to `docs/README.md`, or place it in one explicit checked list of historical/internal exclusions with an explanation.
- [x] Update the root documentation table where a guide is useful to operators or contributors.
- [x] Define document ownership in `docs/README.md`: code/contracts, API reference, operations, repository architecture, roadmap, devplan, and handoff.

**Acceptance criteria:**

- There is one unambiguous owner for current milestone status.
- Planning files do not label delivered work as pending or next.
- Every maintained guide is discoverable.
- Historical records remain available but cannot override current authorities.

## Phase 4: Reconcile Configuration Examples and Guidance

**Goal:** make supported configuration discoverable without confusing runtime, development, and test-only settings.

- [x] Classify each environment variable as server runtime, client development, deterministic test, or opt-in live test.
- [x] Decide whether root `.env.example` is the complete user-facing example and whether `server/.env.example` remains intentionally scoped.
- [x] Add missing operational variables and safe defaults to the appropriate example files.
- [x] Keep secrets empty and retain warnings about persisted provider keys and outbound context.
- [x] Ensure provider precedence and credential-host restrictions match runtime behavior.
- [x] Document that `.env` is not loaded automatically.
- [x] Consider typed centralized startup parsing only if it is needed to prevent configuration drift or unsafe binding; do not add abstraction solely for documentation symmetry.
- [-] If startup parsing changes, validate port ranges and preserve loopback-by-default behavior. Conditional path not used; startup parsing did not change and loopback defaults remain intact.

**Acceptance criteria:**

- Every supported user-configurable variable appears in the appropriate example and operational reference.
- Defaults and precedence match code.
- Test-only variables are not presented as ordinary production configuration.
- No example encourages public binding or contains a credential.

## Phase 5: Add Executable Drift-Prevention Checks

**Goal:** fail focused tests when authoritative current facts and maintained documentation diverge.

### Required Guards

- [x] Add a focused server drift test that imports schema constants and checks marked current-schema claims in an explicit list of normative/current documents.
- [x] Capture route registration through a supported Fastify mechanism, preferably `onRoute`, and compare normalized explicit RPG routes with the parseable operation inventory in `docs/api.md`.
- [x] Ensure the route check excludes implicit `HEAD` consistently and treats feature discovery according to the documented convention.
- [x] Ensure route collection starts no listener, performs no network access, and does not open or migrate a persistent repository.
- [x] Add a documentation ownership/orphan check for `docs/*.md`, with explicit exclusions for intentionally internal or historical files.
- [x] Add deterministic local Markdown link/anchor validation, either with a small repository-owned check or a justified maintained dependency.
- [x] Add a configuration coverage check if it can reliably compare direct environment usage with the documented classified inventory.
- [-] Add contract-backed tests for high-change API examples only where existing exported Zod schemas make the check simple and valuable. Conditional option not used: the new API prose uses inline shapes rather than standalone JSON examples, and existing route/contract tests already validate the exported schemas.
- [-] Add an optional `check:drift` convenience script only if it invokes the same tests already discovered by `npm test`. Conditional option not used: the focused test command is direct and a script would duplicate existing Vitest discovery.
- [x] Confirm existing CI discovers all new checks; avoid a redundant path-filtered drift job.

### Design Constraints

- Do not regex every historical version number in the repository.
- Do not duplicate route definitions in a second manually maintained TypeScript registry merely to test documentation.
- Do not use generated-file worktree diffs as the only correctness check.
- Do not add OpenAPI unless a concrete consumer justifies the extra authority and maintenance surface.
- Produce actionable failure messages naming the stale document, missing route, undocumented variable, or orphan file.

**Acceptance criteria:**

- Changing schema constants fails until marked current claims are updated.
- Adding or removing an explicit RPG route fails until the normative inventory is updated.
- Historical checkpoint prose does not produce false positives.
- A newly maintained guide cannot become silently orphaned.
- A broken local Markdown link or anchor fails with the source file and target in the diagnostic.
- If configuration coverage is implemented, a newly used user-configurable variable fails until it is classified and documented, while dynamic or test-only exclusions are explicit.
- If contract-backed examples are implemented, an invalid example fails through its owning exported Zod schema.
- New checks are deterministic, offline, and part of existing workspace test discovery.

**Focused validation:**

```bash
npm run test --workspace velvet-mvp-server -- test/documentation-drift.test.ts
npm run typecheck --workspace velvet-mvp-server
```

Run any added contract or documentation checker tests in their owning workspace as well.

## Phase 6: Independent Review and Final Validation

**Goal:** resolve review findings, prove the final repository state, and leave a usable handoff.

- [x] Run the four final read-only subagent reviews described above in parallel.
- [x] Record every material finding and disposition in the review log.
- [x] Fix confirmed findings without reverting unrelated work.
- [x] Rerun affected focused tests and owning-workspace typechecks after fixes.
- [x] Run `git diff --check`; distinguish and record any pre-existing failure outside the plan's touched files rather than modifying unrelated work.
- [x] Run each final broad-gate attempt once using the repository's documented canonical `/dev/shm` invocation of `npm run health`; retry only after diagnosing and fixing a failed attempt.
- [-] If the environment cannot run a gate, record the exact command, error, and residual risk; not applicable because the final gate ran successfully.
- [x] Re-run targeted stale-claim searches for current v47/v48 and obsolete operation-count language, reviewing each remaining match as current or historical.
- [x] Update this plan, `devplan.md`, and `handoff.md` with final status, validation evidence, remaining exclusions, and the next task.

**Acceptance criteria:**

- All plan tasks are `[x]`, or are explicitly conditional and have a recorded `[-]` disposition. Any other exclusion requires recorded user approval.
- No `[!]` blockers remain.
- Focused validation and the final broad gate pass.
- Worktree changes are limited to intended files plus preserved pre-existing changes.
- Final documentation identifies current schema, support policy, API authority, and next work consistently.

## Decision Log

Add one row for every policy choice or material scope change.

| Date | Decision | Rationale | Evidence/Owner |
| --- | --- | --- | --- |
| 2026-08-14 | Current persistence authority is schema v53 revision 1. | Runtime constants and startup assertions supersede stale current-document summaries. | `server/src/repo/db/schema.ts`; repository authority |
| 2026-08-14 | Support populated v46-v52 databases upgrading to v53, plus v53 reopen; reject every other persisted marker before mutation. | Startup already accepts v46-v52. No current repository decision authorizes dropping those accepted databases, so the plan's non-destructive default preserves data compatibility. Automatic downgrade remains unsupported. Individual migration steps are transactional, but the multi-step startup chain is resumable rather than one all-versions transaction; backups remain required. | `server/src/repo/db/schema.ts`; Phase 1 policy decision |
| 2026-08-14 | Count 111 explicit RPG operations; classify `GET /api/rpg/v1/features` separately as discovery and exclude all implicit `HEAD`. | Fastify registration capture produced 112 non-HEAD registrations including exactly one discovery route. Method arrays count once per method; paths use the complete `/api/rpg/v1` prefix and omit query examples. | `server/src/routes/rpg/v1/features.ts`; runtime `onRoute` inventory |
| 2026-08-14 | `docs/api.md` will own the sole parseable documentation operation inventory; Fastify registration remains executable authority. | Avoids deriving current inventory from scattered historical tables or adding a second TypeScript registry. | Phase 5 guard design |
| 2026-08-14 | Root `.env.example` is the complete user-facing server-runtime/client-development example; `server/.env.example` remains a documented server-only OpenAI-compatible subset. Test-only and internal variables stay in classified docs, not ordinary production examples. | One complete user example prevents split coverage while preserving the useful server-only legacy-compatible sample. | Phase 0 configuration inventory |
| 2026-08-14 | Do not add centralized startup parsing in this remediation. | Existing runtime defaults are small and directly testable; documentation/coverage guards address the demonstrated drift without a new configuration abstraction or behavior change. | Phase 4 implementation decision |
| 2026-08-14 | Keep drift prevention in one repository-owned server test with no new dependency, script, generated file, OpenAPI layer, or CI job. | Existing Vitest/root/CI discovery is authoritative; the small current Markdown corpus and direct environment usage are deterministically checkable offline. | `server/test/documentation-drift.test.ts` |

## Research Log

Record repository research and any August 2026 external sources used.

| Date | Topic | Source or repository path | Conclusion |
| --- | --- | --- | --- |
| 2026-08-14 | Schema and migration reachability | `server/src/repo/db/schema.ts`, `server/test/fixtures/migrations/support-window.ts`, active migration tests | v53r1 is current; startup reaches v53 from v46-v52 and reopens v53; v45 and earlier are rejected. Existing populated full-startup evidence does not cover every accepted marker. |
| 2026-08-14 | RPG route inventory | `server/src/app.ts`, `server/src/routes/rpg/v1/**/*.ts`, side-effect-free Fastify `onRoute` capture | 111 counted explicit operations: GET 51, POST 49, PATCH 4, PUT 4, DELETE 3. Discovery is a separate GET; five generated HEAD aliases are implicit and excluded. |
| 2026-08-14 | Delivered v49-v53 behavior | versioned migrations, route modules, client flows, `docs/campaign-generation.md` | v49 rerolls; v50 generation provenance/foundation; v51 starter settlement, placement, and combat rewards; v52 sparse generation/planning; v53 material delivery. Nine registered operations were absent from the API reference. |
| 2026-08-14 | Document authority | repository Markdown inventory | Code/contracts own behavior; API reference owns HTTP inventory; operations owns deployment/migration configuration; repository architecture owns persistence; roadmap owns milestone status; devplan is a compact ledger; handoff owns the immediate next task. Dated plans remain historical. |
| 2026-08-14 | Configuration | direct environment usage, examples, operations/provider guides | Server runtime, client-development, deterministic-test, live-test, and internal keys require explicit classification. Velvet does not auto-load `.env`; persisted provider settings override bootstrap defaults; credentials are sent only to exact allowlisted hosted names or loopback. |
| 2026-08-14 | Fastify v5 route hooks and HEAD | https://fastify.dev/docs/v5.11.x/Reference/Hooks/#onroute and https://fastify.dev/docs/v5.11.x/Reference/Routes/ (accessed 2026-08-14) | Installed Fastify 5.11.0 supports synchronous encapsulated `onRoute`; route methods may be arrays; `exposeHeadRoute` can add sibling HEAD registration. `ready()` permits registration capture without listening. |
| 2026-08-14 | Vitest discovery | https://vitest.dev/config/include.html (accessed 2026-08-14); `server/vitest.config.ts` | Installed Vitest 4.1.10 discovers `server/test/**/*.test.ts`; one focused server drift test joins existing root/CI discovery without a new job. |
| 2026-08-14 | npm workspaces | https://docs.npmjs.com/cli/v11/using-npm/workspaces (accessed 2026-08-14) | Existing workspace test scripts are sufficient for focused and root discovery. |
| 2026-08-14 | Zod 4 JSON Schema | https://zod.dev/json-schema (accessed 2026-08-14) | Installed Zod 4.4.3 emits output-oriented JSON Schema by default and supports `io: "input"`; no JSON Schema/OpenAPI layer is needed for this remediation. |

## Validation Log

Record focused and broad validation as it runs. Do not replace evidence with “tests pass.”

| Date | Command | Result | Notes |
| --- | --- | --- | --- |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/migration-support-window.test.ts` | Passed: 1 file, 14 tests | Full populated v46-v52 startup matrix; unsupported marker/revision immutability; fresh/current DDL parity; FK integrity; late v52-to-v53 rollback. Initial run exposed only the test's expected `meta.schemaVersion` comparison and passed after excluding the intentionally advanced marker from row-preservation comparison. |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/migration-v47.test.ts test/migration-v48.test.ts test/migration-v50.test.ts test/migration-v51.test.ts test/migration-v52.test.ts test/migration-v53.test.ts` | Passed: 6 files, 15 tests | Related one-step, layout, rollback, and startup coverage. |
| 2026-08-14 | `npm run typecheck --workspace velvet-mvp-server` | Passed | Run after migration runtime/fixture/test changes. |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/documentation-drift.test.ts` | Passed: 1 file, 5 tests | Schema/count claims, 112-row non-HEAD runtime/docs parity with 111 counted operations, no listener/repository, docs ownership, offline links/anchors, and configuration coverage. Initial run found one wording-order mismatch (`111 explicit counted`) and passed after normalizing the README claim. |
| 2026-08-14 | `npm run typecheck --workspace velvet-mvp-server` | Passed | Includes the new drift test in `tsconfig.test.json`. |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/migration-support-window.test.ts` | Passed: 1 file, 16 tests | Review remediation adds markerless immutability, globally canonical future-shell rejection, and marker-owned populated v46-v52 histories including provider binding, reroll, generation, starter/placement/reward, and expansion records. |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/rpg-campaign-content-generation-route.test.ts` | Passed: 1 file, 9 tests | Adds post-publication ambiguity and provider-error log-redaction evidence. |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/documentation-drift.test.ts` | Passed: 1 file, 6 tests | Hardened balanced/reference link parsing, explicit-HEAD rejection, TypeScript-AST environment discovery, and parser canaries. |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/rpg-world-route.test.ts test/rpg-campaign-content-generation-route.test.ts test/rpg-combat-command-route.test.ts` | Passed: 3 files, 15 tests | Affected placement, generated reads/publication, reward semantics, structured errors, privacy, and reconciliation. |
| 2026-08-14 | `npm run typecheck --workspace velvet-mvp-server` | Passed | Run after all initial-review runtime/test remediations. |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/migration-support-window.test.ts` | Passed: 1 file, 20 tests | Final review remediation validates all baseline and marker-owned layouts before mutation, compares canonical v49-v53 DDL, and preserves malformed v46/v52 databases exactly. |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/migration-v47.test.ts test/migration-v48.test.ts test/migration-v50.test.ts test/migration-v51.test.ts test/migration-v52.test.ts test/migration-v53.test.ts` | Passed: 6 files, 15 tests | Final active versioned migration rerun, including a real v48 same-name DDL tamper rejection. |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/documentation-drift.test.ts` | Passed: 1 file, 7 tests | Final AST/parser canaries cover wrapped, aliased, typed, element, shadowed, and dynamic environment access; explicit/dynamic/bound HEAD; caught-error serialization; inventory grammar; maintained links and repository boundaries. |
| 2026-08-14 | `npm run test --workspace velvet-mvp-server -- test/rpg-world-route.test.ts test/rpg-campaign-content-generation-route.test.ts test/rpg-combat-command-route.test.ts test/api-stream.test.ts test/api.test.ts` | Passed: 5 files, 40 tests | Final request/result binding, commit-ambiguity, generated-read campaign binding, provider-log redaction, and roleplay regression coverage. |
| 2026-08-14 | `npm run typecheck --workspace velvet-mvp-server` | Passed | Final focused server production/test typecheck after all review remediations. |
| 2026-08-14 | `git diff --check` | Passed with no output | Final intended diff has no whitespace errors. |
| 2026-08-14 | Canonical `/dev/shm` `npm run health`, first attempt | Failed in server tests: 9 stale v45 corruption expectations and one 100 ms contention timing assumption | Diagnosed and fixed by moving supported-input FK fixtures to v46 and giving the real lock enough time to survive stricter read-only startup preflight; affected files then passed 67 and 45 tests. |
| 2026-08-14 | Canonical `/dev/shm` `npm run health`, second attempt | Typecheck/build and all 2,978 unit/integration tests passed; deterministic E2E was invalidated by port collision | A user-owned server watcher restarted on fixed E2E port 18787, so Playwright reached stale state while its replacement failed with `EADDRINUSE`. With user approval the watcher was stopped; isolated E2E then exposed and repaired two genuine stale UI/workflow expectations. |
| 2026-08-14 | `TMPDIR=<unique /dev/shm dir> npm run test:e2e` | Passed: 16 tests | Full deterministic workflow after aligning starter inventory assertions with v51 materialization and opening the collapsed maintenance disclosure before interacting with hidden controls/content. |
| 2026-08-14 | Canonical `/dev/shm` `npm run health`, final attempt | Passed | Contracts: 54 files/364 tests; server: 133 files/2,143 passed and 5 skipped; client: 27 files/471 tests; deterministic E2E: 16 passed. All workspace typechecks and builds passed. The existing Vite large-chunk warning remained non-fatal. |

## Review Log

| Date | Reviewer | Finding | Severity | Disposition |
| --- | --- | --- | --- | --- |
| 2026-08-14 | Correctness/security | Markerless nonempty SQLite was given a `meta` table before rejection. | High | Fixed: inspect existing tables before metadata creation; exact schema/row preservation test added. |
| 2026-08-14 | Correctness/documentation | v49-v53 empty future shells were not globally or canonically validated before sequential cleanup. | High | Fixed: compare every present shell's complete normalized `sqlite_master` inventory/DDL with creator-generated canonical in-memory DDL before any cleanup; malformed-shell preservation test added. |
| 2026-08-14 | Correctness/test | v46-v52 startup fixtures populated shared legacy rows but not marker-owned histories. | High | Fixed: matrix fixtures now contain real v46 issuance, v47 execution, v48 provider binding, v49 reroll, v50 provenance, all three v51 settlement/placement tables, and all six v52 tables before full startup. |
| 2026-08-14 | Correctness | Reward docs implied owner/GM claim and exact-result authority. | Medium | Fixed: normative API distinguishes owner/GM list access from controller-only claim/result authority. |
| 2026-08-14 | Documentation | Current docs overstated Playwright test totals and put the generated-campaign journey in E2E. | Medium | Fixed: volatile total removed; Playwright and deterministic server integration coverage are distinguished. |
| 2026-08-14 | Documentation | Nine-operation additions lacked a complete exact error/status matrix. | Medium | Fixed: API now records validation/media, non-disclosing 404s, exact stale/conflict codes, structured read failures, and ambiguous write recovery; generated reads and placement runtime details were aligned. |
| 2026-08-14 | Documentation | Historical revision-2 plan still delegated current support to v47 text. | Low | Fixed: sentence now defers to `operations.md` and scopes v47 as historical. |
| 2026-08-14 | Test/CI | Markdown checker could miss balanced destinations and explicit reference links. | Medium | Fixed: balanced scanner, full/collapsed/defined shortcut reference handling, undefined-reference failures, and parser canaries added. |
| 2026-08-14 | Test/CI | Environment discovery was regex/path fragile. | Medium | Fixed: TypeScript-AST scanner covers aliases, destructuring, injected `ProcessEnv`, optional/bracket access, and `import.meta.env` across production/client/E2E/tool roots, with canaries and dynamic-access failure. |
| 2026-08-14 | Test/CI | Route guard assumed all observed HEAD registrations were implicit. | Low | Fixed: source-level explicit HEAD registrations now fail; observed aliases must still pair with GET. |
| 2026-08-14 | Security | Campaign apply/publication post-commit projection errors said no content was applied. | Medium | Fixed: post-write failures use neutral commit-ambiguous 503 guidance; focused response-after-commit test added. |
| 2026-08-14 | Security | Provider-controlled error text and campaign context could enter generation logs. | Medium | Fixed: caught errors/messages are no longer logged; provider-echo canary test proves logs and response omit content. |
| 2026-08-14 | Correctness/documentation | `devplan.md`/`handoff.md` completion wording preceded the still-running final phase. | Medium | Resolved: the coordinator continued through final review and health, and the completion record now supplies the referenced evidence before handoff. |
| 2026-08-14 | Migration correctness | Supported marker-owned layouts were fully asserted only after migration, and v49-v53 assertions did not prove canonical same-name DDL. | High | Fixed: every supported persisted input now passes read-only baseline/version assertions plus canonical v49-v53 in-memory DDL comparison before cleanup or migration; exact-preservation v46 and v52 tamper tests added. |
| 2026-08-14 | Migration test/docs | The v48 tamper test recreated canonical SQL while expecting success, and the archive inventory omitted `migration-v46.archived.ts`. | Low | Fixed: the test now changes trigger behavior and requires rejection; the archive inventory is complete. |
| 2026-08-14 | Runtime/security | Generated reads and potentially committed placement, reward, apply, and publication results were schema-valid but not fully bound to route/request identity. | Medium | Fixed: handlers verify campaign, actor/draft/artifact/claim identity, idempotency, and revisions as applicable; valid cross-bound projections receive structured read failure or commit-ambiguous guidance. |
| 2026-08-14 | Security/test | Additional roleplay provider exceptions could be serialized, and the static guard missed direct, aliased, warning-level, and element-access logger forms. | High | Fixed: caught provider exceptions are not logged; AST analysis follows caught-error aliases across supported logger forms and has executable canaries. |
| 2026-08-14 | Test/CI | Environment, HEAD, inventory, Markdown coverage, and local-link checks retained concrete parser bypasses. | Medium | Fixed: wrapped/element/type-alias/shadow-aware environment analysis, bound/destructured HEAD detection, strict inventory rows, all maintained Markdown, and repository-bound path validation were added with canaries. |
| 2026-08-14 | Final rereview | Migration, runtime/security, and guardrail reviewers rechecked all remediations. | None | No actionable findings remained; documentation review's only completion-order finding is resolved by completing Phase 6 before handoff. |

## Blocker Log

| Date | Blocker | Impact | Owner | Resolution needed |
| --- | --- | --- | --- | --- |
| | | | | |

## Completion Record

**Completed:** 2026-08-14
**Final schema/revision:** v53 revision 1 (`v53r1`)
**Supported migration inputs:** populated v46-v52 forward startup to v53, plus canonical v53 reopen; v45 and earlier, unsupported revisions, markerless nonempty databases, malformed layouts, foreign-key corruption, and noncanonical/populated future shells reject before mutation.
**Explicit RPG operation convention/count:** 111 counted explicit method/path operations, plus separately classified `GET /api/rpg/v1/features`; implicit `HEAD` aliases are excluded.
**Focused validation:** migration support 20 tests; active v47-v53 suites 15 tests; documentation drift 7 tests; affected runtime/roleplay routes 40 tests; corruption/lock health remediations 112 tests; server typecheck passed; final deterministic E2E 16 tests.
**Final health gate:** passed the documented unique-`/dev/shm` `npm run health` invocation after diagnosed retries; all typechecks/builds, 2,978 unit/integration tests, and 16 deterministic E2E tests passed.
**Remaining accepted exclusions:** live-provider E2E was intentionally not run; historical archived migration suites remain non-product evidence.
**Next task:** scope the closed declarative rules IR milestone with exact consumers, contract boundaries, migration impact, and exclusions before implementation.

## Fresh-Agent Execution Prompt

Use the prompt below from the repository root with a fresh implementation agent.

```text
Work in /home/mojo/projects/velvet-mvp and execute drift-remediation-plan.md completely.

Your role is the coordinating implementation agent. Continue autonomously until every phase is complete, all review findings are resolved, and required validation passes. Do not stop after research, planning, a partial phase, or the first successful test. Stop only if a genuine decision or external blocker cannot be resolved from repository evidence or current primary-source research; if blocked, document exactly what is blocked, what you tried, and the smallest decision required from the user.

Start by reading AGENTS.md, CONTRIBUTING.md, drift-remediation-plan.md, package.json, the current git status, and the authority documents named in the plan. Preserve all unrelated and pre-existing changes. Never revert or overwrite work you did not make. Do not commit, push, amend, or create a pull request unless the user separately asks.

Maintain progress directly in drift-remediation-plan.md as work proceeds:
- Keep exactly one phase in progress.
- Change checklist markers in real time, not in one final batch.
- Record policy decisions, research sources, validation commands/results, review findings, blockers, and final completion evidence in the provided logs.
- Mark work complete only after implementation and required validation.

Use subagents properly:
1. At the start, launch independent read-only subagents in parallel for route inventory, migration policy/tests, document authority/drift, configuration inventory, and minimal automated guardrail design.
2. Tell every research subagent not to edit, format, stage, generate, or commit files. Require exact file/line evidence, uncertainties, risks, and acceptance-test suggestions.
3. You remain the sole editor and synthesize their findings. If edits must be delegated, assign strictly disjoint files and prohibit unrelated cleanup.
4. After implementation and focused tests pass, launch independent read-only correctness, documentation, test/CI, and security reviewers in parallel.
5. Resolve confirmed review findings yourself, rerun affected checks, and repeat targeted review when a fix materially changes the design.

Research best practices current as of August 2026 when repository evidence is insufficient or behavior depends on external tooling. Relevant topics may include Fastify v5 onRoute/implicit HEAD behavior, Zod 4 JSON Schema semantics, deterministic Markdown link checking, and GitHub Actions required-check behavior. Prefer official primary documentation and release notes, verify applicability to installed versions, and record URLs plus access dates in the plan's research log. Do not use external sources to decide Velvet-specific facts such as the actual route inventory, schema version, migration policy intent, environment defaults, feature gates, or security model; derive those from this repository and record any true product-policy decision explicitly.

Implementation constraints:
- Establish authoritative facts before rewriting current claims.
- Do not silently narrow or broaden migration compatibility. Decide and record the supported input markers, then align runtime, canonical populated tests, and operator docs.
- This plan authorizes a non-destructive default when repository evidence does not establish that accepted persisted database versions may be dropped: preserve currently accepted inputs, document the broader window accurately, and strengthen its evidence. Do not stop merely to ask whether existing data compatibility should be removed.
- Derive route facts from Fastify registration. Exclude implicit HEAD and handle GET /api/rpg/v1/features according to one documented convention.
- Preserve clearly labeled historical checkpoints while correcting or qualifying misleading current claims.
- Prefer focused executable consistency tests around existing authorities. Do not create another hand-maintained source of truth.
- Keep drift checks deterministic, offline, side-effect free, and discoverable by existing workspace tests.
- Do not add OpenAPI, a configuration framework, or new dependencies unless a concrete need is demonstrated and recorded.
- Preserve trusted-loopback security wording and never imply that feature flags or fixed local-owner behavior provide authentication.
- Follow the repository's smallest-validation guidance during each phase.

Use focused tests and owning-workspace typechecks while iterating. Once all phases and review remediations are complete, run git diff --check and then one attempt of the documented canonical /dev/shm npm run health gate. Do not run live-provider E2E. If final health fails, diagnose and fix it, rerun the smallest affected checks, and then make a new final-gate attempt. Do not declare completion with failing or unrun required validation unless an unavoidable environment blocker is fully documented.

At completion, verify that every task in drift-remediation-plan.md is complete. Only explicitly conditional tasks may be marked as accepted exclusions without prior user approval. Confirm that no blockers remain, the completion record is filled in, current documents agree, the automated drift checks pass, and git status contains no unintended files. Then report a concise summary of decisions, files changed, validation evidence, and any accepted exclusions.
```
