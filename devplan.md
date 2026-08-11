# Development Plan

Current persistence is `v42r1`; M1-M4 are complete. Planning-board revision 2 was saved `2026-08-11T00:47:24.296Z`, is ready, and has no blockers. [ROADMAP.md](docs/ROADMAP.md) owns scope/status, and the [revision 2 integration plan](docs/revision-2-integration-plan.md) owns actionable dependency order, acceptance, validation, documentation, commit, and rollback detail. This file is only the compact status ledger.

## Complete

- [✅] M1.1-M1.10: core RPG persistence and deterministic mechanics
- [✅] M2.1-M2.11: trusted-local RPG HTTP surfaces
- [✅] M3.1-M3.8: RPG client workflows
- [✅] M4.1-M4.6: bounded AI-driven RPG integration through reviewed atomic campaign-content application at v42r1
- [✅] Revision 2 plan preparation: board decisions and repository research synthesized into the authoritative actionable plan
- [✅] Revision 2 independent plan-review corrections: queue placement, dependencies, E2E evidence, companion authority split, health/validation policy, and Unscheduled milestone detail reconciled across planning docs

## H0 — Complete (Wave H green)

- [✅] H0.1 rolling migration support foundation: executable supported migration coverage is canonical populated v40/v41->v42; the preserved archive is discoverable and does not claim v2-v39 support; startup preflight rejects persisted foreign-key corruption, unexpected v42 named artifacts, and cross-campaign generation-draft ancestry before marker or artifact mutation
- [✅] H0.2 six deterministic E2E repairs: four finalization call sites expected `200` versus authoritative `201` and now preserve the `201` public contract through an E2E-only authorized actor resolver; the attached unconfigured room expected legacy chat/back but routed to play under feature-only routing and now uses a configured-status gate with cancellation/error handling; storyline/quest setup expected creation but story `POST` returned `400` under the strict graph contract and now uses the current strict workflow with idempotent replay. The old supplied aggregate drifted: M2.5 passed and the current full suite includes 12 cases. Validation passed: client focused 3 files/113 tests plus client typecheck; server fixture/M1.5 2 files/17 tests plus server typecheck; `typecheck:e2e`; full deterministic E2E 12 passed; `git diff --check`. Commits: `ee7dfba fix(client): preserve authoritative campaign navigation`; `60afa5f test(e2e): align authoritative RPG workflows`
- [✅] H0.3 current documentation reconciliation: active docs now describe v42r1, completed M4.1-M4.6, 95 current trusted-local RPG HTTP operations versus the historical 92-operation M2.11 baseline, and supported canonical populated v40/v41->v42 upgrades; historical ledgers remain preserved and visibly distinguished from current, Planned, Unscheduled, deferred, and excluded status. Targeted stale-claim `rg`, 37 local Markdown links/anchors, and `git diff --check` passed; no code tests were run for this docs-only slice. Commits: `77ed4b0 docs: reconcile current RPG guidance`; `2a50a41 docs: qualify historical RPG baselines`; docs/status commit remains pending
- [✅] H0.4 canonical health gate: root `npm run health` runs typecheck, build, `npm test`, and deterministic E2E exactly once each in order. The first attempt timed out externally; the second exposed a global foreign-key preflight regression, corrected and scoped before the final recovery wrapper run passed all four phases in order with a unique `/dev/shm` `TMPDIR`. Independent release/security review found no material issues and confirmed deterministic/live credential isolation. Commits: `3e6c1a6 fix(repo): scope migration integrity preflight`; `f18a081 chore: add canonical health gate`; `7286ded docs: document canonical health gate`; docs/status commit remains pending

## M5 — Build Next

- [ ] M5.1 In Progress, not delivered: the read-only start recheck confirms provisional v43r1 available, no contract/code/schema drift, and no blockers
- [ ] M5.1 implementation policy: stopped projections are structurally historical at-stop and writes reject; detach blocks only running live-present rows and preserves history; player location uses the existing principal-visible location union with no actor inference; mutations use session-root `expectedRevision` with informational per-NPC revision; authority/transitions run in one immediate repository transaction and DDL is structural only
- [ ] M5.2-M5.6 remain Planned: companion aggregate/local-owner administration; parallel atomic combat, candidate protocol, and post-threat-checkpoint dice tracks; expanded agent adapters with exact per-family dependencies. Delegated grantee exercise/principal-specific UI waits for remote identity/grants
- [ ] Next exact operation: parallel disjoint new contract files/tests and sole schema-steward v43 migration/fixture work; shared barrels/wiring are reserved for the integration owner; protected `server/src/repo/contentCatalogRepo.ts` remains untouched
- [ ] No M5.1 shipped or feature-validation claim is made by this start record

## Approved queue

- [ ] Build Later: closed rules IR, licensed offline ingestion (blocked on promoted/delivered mutable authoring unless a separately approved immutable-draft-only path), ephemeral simulation, remote tenancy/authenticated sessions and exercisable grants, harness overrides, proactive automation/tools
- [ ] Approved Build Unscheduled: append-only multiclass, mutable logical unpinned pack authoring over immutable revisions, zones/range bands, boss phases, autonomous parties

Discord, VTT adapters, and simultaneous encounters remain deferred. Preserve one active encounter per campaign session.
