# Development Plan

Current persistence is `v42r1`; M1-M4 are complete. Planning-board revision 2 was saved `2026-08-11T00:47:24.296Z`, is ready, and has no blockers. [ROADMAP.md](docs/ROADMAP.md) owns scope/status, and the [revision 2 integration plan](docs/revision-2-integration-plan.md) owns actionable dependency order, acceptance, validation, documentation, commit, and rollback detail. This file is only the compact status ledger.

## Complete

- [✅] M1.1-M1.10: core RPG persistence and deterministic mechanics
- [✅] M2.1-M2.11: trusted-local RPG HTTP surfaces
- [✅] M3.1-M3.8: RPG client workflows
- [✅] M4.1-M4.6: bounded AI-driven RPG integration through reviewed atomic campaign-content application at v42r1
- [✅] Revision 2 plan preparation: board decisions and repository research synthesized into the authoritative actionable plan
- [✅] Revision 2 independent plan-review corrections: queue placement, dependencies, E2E evidence, companion authority split, health/validation policy, and Unscheduled milestone detail reconciled across planning docs

## H0 — Active build-now milestone

- [✅] H0.1 rolling migration support foundation: executable supported migration coverage is canonical populated v40/v41->v42; the preserved archive is discoverable and does not claim v2-v39 support; startup preflight rejects persisted foreign-key corruption, unexpected v42 named artifacts, and cross-campaign generation-draft ancestry before marker or artifact mutation
- [ ] H0.2 individually reproduce six deterministic E2E failures with `/dev/shm` and capture expected/actual/source call site before proven repairs (latest observed run: 5 passed / 6 failed; current inspection finds two explicit finalization `200` overrides, not four)
- [ ] H0.3 current documentation reconciliation
- [ ] H0.4 canonical root `npm run health` gate: typecheck, build, `npm test`, deterministic E2E exactly once each in order; CI calls or mirrors it

## Approved queue

- [ ] M5.1-M5.6 Build Next: NPC presence→companion aggregate/local-owner administration; parallel atomic combat, candidate protocol, and post-threat-checkpoint dice tracks; expanded agent adapters with exact per-family dependencies. Delegated grantee exercise/principal-specific UI waits for remote identity/grants
- [ ] Build Later: closed rules IR, licensed offline ingestion (blocked on promoted/delivered mutable authoring unless a separately approved immutable-draft-only path), ephemeral simulation, remote tenancy/authenticated sessions and exercisable grants, harness overrides, proactive automation/tools
- [ ] Approved Build Unscheduled: append-only multiclass, mutable logical unpinned pack authoring over immutable revisions, zones/range bands, boss phases, autonomous parties

Discord, VTT adapters, and simultaneous encounters remain deferred. Preserve one active encounter per campaign session.
