# Playability progress

## Current checkpoint
- Baseline commit: `9e5f1b7`
- Active plan/milestone: Plan 1 / P1.2
- Last accepted milestone and commit: P1.1 diagnostic contract, commit to be recorded below
- Next small assignment: implement deterministic readiness checks over supplied authorized facts
- Uncommitted file owners: coordinator owns plan/protocol/docs index/ledger; excluded paths remain untouched
- Blockers and decision required: none; no provider calls authorized or required yet
- Live budget remaining / audit path / uncertain dispatch IDs: USD 2.00, 130 dispatches, 250,000 reserved/settled tokens, 40 minutes; no live dispatches; no audit IDs

## Interface handoffs
- P1 readiness DTO, codes, API, coverage, and expected warnings: not implemented; P1.1 will freeze the DTO and finite issue taxonomy
- P2 fixture version/digest, branch oracle, observations, and live status: blocked on the committed P1 handoff
- P3 inspector DTO/lanes, corpus version, baseline, chosen improvement/gates: blocked on committed P2 observations

## Milestone records
| ID | Status | Commit | Tests actually run | Docs updated | Remaining limit |
| --- | --- | --- | --- | --- | --- |
| Docs-0 | accepted | `62bad81` | `git status --short`; `git diff --check` | plan/protocol/index/ledger committed | full shared live envelope unused |
| P1.1 | accepted | pending coordinator commit | 4 focused contract tests; contracts typecheck; contracts build; independent review accepted | campaign-readiness guide; docs index; ledger | full shared live envelope unused |
| P1.2 | in-progress | | pure-check tests and server typecheck pending | | full shared live envelope unused |
| P1.3 | pending | | | | full shared live envelope unused |
| P1.4 | pending | | | | full shared live envelope unused |
| P1.5 | pending | | | | full shared live envelope unused |
| P1.6 | pending | | | | full shared live envelope unused |

## Next agent task
Assignment: P1.2 pure diagnostic checks
Goal: implement deterministic readiness checks over supplied authorized facts for public rendering, dependency/threshold obstruction, binding classification, exact encounter roster support, and directed location connectivity.
Baseline/predecessor: P1.1 diagnostic contract; coordinator will record its commit immediately after this ledger update. Use exported `CampaignDmReadinessIssue` and coverage taxonomy.
Read first: `server/src/repo/storyRepo.ts`, `server/src/repo/campaignDmRepo.ts`, `server/src/repo/campaignGenerationRepo.ts`, relevant world/story contracts, `docs/plan-1-campaign-readiness.md`.
Own writes: `server/src/repo/campaignDmReadinessChecks.ts` (NEW) and `server/test/campaign-dm-readiness-checks.test.ts` (NEW). Do not edit contracts, repositories, routes, client files, docs ledger, excluded paths, or shared barrels.
Inputs/interfaces: pure functions over explicit authorized fact DTOs; return stable issue records and coverage/manual-review facts compatible with the P1.1 contract. No SQL, model call, text interpretation, or mutation.
Acceptance: tests cover private predecessors, optional/private companion graphs, threshold rules, directed routes, concept-versus-executable encounters, stable issue order, and explicit human-review reminders for clue alternatives, fail-forward, finale/aftermath, and player choice.
Validation: `npm run test --workspace velvet-mvp-server -- test/campaign-dm-readiness-checks.test.ts` and `npm run typecheck --workspace velvet-mvp-server`.
Constraints: apply_patch; no provider calls/live DB; no commits; preserve unrelated work and do not weaken tests.
Stop: when focused tests and server typecheck pass, or report a concrete blocker.
Return: completed work, changed files/exported interfaces, exact commands/results, remaining risks, and the smallest next task.
