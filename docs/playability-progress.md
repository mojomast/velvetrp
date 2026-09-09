# Playability progress

## Current checkpoint
- Baseline commit: `9e5f1b7`
- Active plan/milestone: Plan 1 / P1.3
- Last accepted milestone and commit: P1.2 pure diagnostic checks, commit to be recorded below
- Next small assignment: project authorized campaign readiness in one read-only repository transaction
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
| P1.1 | accepted | `b092af8` | 4 focused contract tests; contracts typecheck; contracts build; independent review accepted | campaign-readiness guide; docs index; ledger | full shared live envelope unused |
| P1.2 | accepted | pending coordinator commit | 5 focused pure-check tests; server typecheck; independent review accepted | campaign-readiness guide updated; ledger | full shared live envelope unused |
| P1.3 | in-progress | | repository projection tests and affected regressions pending | | full shared live envelope unused |
| P1.4 | pending | | | | full shared live envelope unused |
| P1.5 | pending | | | | full shared live envelope unused |
| P1.6 | pending | | | | full shared live envelope unused |

## Next agent task
Assignment: P1.3 authorized repository projection
Goal: assemble a read-only authorized readiness response from existing campaign activation, accepted preparation, disclosure, binding, catalog, and room-placement repositories without opening or claiming a director run.
Baseline/predecessor: P1.2 pure checks, commit to be recorded after coordinator commit; P1.1 response schema version `1.0`; existing activation reader remains authoritative for activation readiness.
Read first: `server/src/repo/campaignRoomActivationRepo.ts`, `server/src/repo/campaignDmRepo.ts`, `server/src/repo/campaignGenerationRepo.ts`, `server/src/repo/storyDisclosure.ts`, `server/src/repo/campaignRepositoryOrchestration.ts`, `server/src/repo/campaign/campaignTypes.ts`, `server/src/repo/index.ts`.
Own writes: `server/src/repo/campaignDmReadinessRepo.ts` (NEW) and `server/test/campaign-dm-readiness.test.ts` (NEW). Coordinator integration owner exclusively edits orchestration/types/index; assign any narrow `campaignDmRepo.ts` extraction before editing it.
Inputs/interfaces: owner/GM authorization must precede all private reads; return `CampaignDmReadinessResponse` with unchanged activation result, P1.2 checks, bounded coverage, and deterministic revisions. No executable candidate digests or private text.
Acceptance: player/observer/outsider/revoked-GM/cross-campaign denial; repeated reads mutate no rows/revisions and dispatch no provider; activation parity; current-room versus later-location distinction; overflow/partial coverage; private/public parallel graphs; no director open/claim/recovery.
Validation: new readiness test plus affected `campaign-room-activation`, `campaign-dm-generated`, and `campaign-dm-binding-evidence` tests, then server typecheck. No provider calls/live user storage.
Constraints: apply_patch; no commits by subagent; preserve unrelated work and excluded paths; no weakening authorization or side-effect tests.
Stop: when focused and affected tests/typecheck pass, or report a concrete blocker.
Return: completed work, exact changed files/interfaces, exact commands/results, remaining risks, and the smallest next task.
