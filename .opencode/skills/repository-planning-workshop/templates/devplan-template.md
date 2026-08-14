# Devplan Template

Replace placeholders with repository-relative paths and safe logical state aliases; never leak local absolute paths.

```markdown
# <Initiative> Devplan

## Authority and source

- Saved state: revision `<revision>` at `<timestamp>`
- Manifest/state/snapshot digests: `<digests>`
- Saved baseline: `<baseline digest; HEAD; branch>`
- Current repository: `<commit; branch>`
- Freshness: `<evidence result; unrelated drift separately>`
- Authority documents and roles: `<repository-relative paths>`
- Intent Brief: `<problem; actors; success signals; constraints; non-goals; horizon>`

## Approved scope

| ID | Outcome/acceptance signals | Approved priority/rationale | Selected decisions/rationale/risks | Effective dependencies |
| --- | --- | --- | --- | --- |
| EPIC-001 | ... | P1: ... | DEC-001=DEC-001-OPT-02: ... | ... |

## Excluded scope

| ID | Disposition/disabled | Recorded reason | Dependency consequence |
| --- | --- | --- | --- |
| EPIC-002 | Defer | ... | ... |

## Dependency order

`EPIC-001 -> EPIC-003`

Cycle check: passed. Tie-breaker: canonical manifest order.

## Milestone 1: <verifiable outcome>

- IDs: `<enabled Build IDs only>`
- Outcome: `<observable result>`
- Problem and intent link: `<demonstrated problem; affected actors; intent success signal>`
- Acceptance criteria: `<criterion | evidence/decision source | verification method | expected result>`
- Dependencies/topological basis: `<prior milestones and reason>`
- Scope: `<specific behavior/boundaries>`
- Exclusions: `<non-goals>`
- Approved decisions: `<no inference>`
- Change map: `<confirmed / likely / unknown boundaries with evidence; unknowns become discovery gates>`
- Effort/horizon: `<epic effort class; delivery horizon; external dependency or none>`
- Data/migration: `<additive schema/backfill/flag/rollout/cleanup or none>`
- Command/projection constraints: `<authoritative writes/events/read models/consistency>`
- Focused tests: `<commands and acceptance evidence>`
- Owning typecheck: `<repository command or verified unavailable>`
- Security/operations/accessibility: `<focused checks>`
- Documentation: `<authority docs updated in this milestone>`
- Diff/status gate: `<full review; milestone-owned vs unrelated>`
- Staging gate: `<only owned paths after checks; staged review; commit only if authorized>`
- Failure rule: `Stop on any failed required check; do not stage/commit or claim completion.`
- Rollback/recovery: `<safe reversal/retry/compatibility>`
- Commit boundary: `<one coherent proposed commit>`
- Owner/conflict boundary: `<scope and prohibited shared paths>`

## Milestone N: <verifiable outcome>

<Repeat every field.>

## Parallel execution map

| Wave | Owner | IDs | Exclusive paths/components | Inputs/outputs | Validation | Serialize with |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ... | ... | ... | ... | ... | ... |

## Final integration gates

- Integrate in DAG order under one coordinator.
- Confirm every milestone's focused tests, typecheck, docs, diff/status, and staging review.
- Run justified repository-wide checks without replacing focused gates.
- Verify migration/recovery, security, operations, and accessibility where relevant.
- Reconcile roadmap/devplan/handoff/ADR authority; record residual risks and next owner.
- Confirm pre-existing/unrelated dirty paths remained untouched.

## Completion record

- Milestones/commits (only if later authorized): `<...>`
- Validation evidence: `<commands/results>`
- Documentation reconciled: `<paths>`
- Rollback/recovery: `<result>`
- Residual risks/blockers: `<none or explicit>`
- Workshop-owned changes: `<paths>`
- Unrelated dirty paths confirmed untouched: `<paths or none>`
```
