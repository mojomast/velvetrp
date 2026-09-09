# Playability progress

## Current checkpoint
- Baseline commit: `9e5f1b7`
- Active plan/milestone: Plan 1 / P1.5
- Last accepted milestone and commit: P1.4 HTTP and client transport, commit to be recorded below
- Next small assignment: add a GM-only readiness panel without disturbing map/draft or command recovery state
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
| P1.2 | accepted | `c1c1f45` | 5 focused pure-check tests; server typecheck; independent review accepted | campaign-readiness guide updated; ledger | full shared live envelope unused |
| P1.3 | accepted | `599fe9d` | readiness 3; activation 14; generated 2; binding evidence 2; server typecheck; independent integration review accepted | campaign-readiness guide; ledger; activation/repository integration | full shared live envelope unused |
| P1.4 | accepted | pending coordinator commit | route 4; server typecheck; client API 6; client typecheck; documentation drift 7; independent transport review accepted | API inventory/counts; campaign-readiness guide; docs index; ledger | full shared live envelope unused |
| P1.5 | in-progress | | readiness panel/client tests/typecheck pending | | full shared live envelope unused |
| P1.6 | pending | | | | full shared live envelope unused |

## Next agent task
Assignment: P1.5 GM readiness panel
Goal: add an explicit Inspect preparation action and bounded private diagnostics to the existing Campaign DM panel without taking command ownership or exposing data to players/observers.
Baseline/predecessor: P1.4 transport, commit to be recorded after coordinator commit; client `getCampaignDmPreparationReadiness(campaignId, sessionId)` returns strict `CampaignDmReadinessResponse`.
Read first: `docs/plan-1-campaign-readiness.md`; `docs/campaign-readiness.md`; `client/src/components/rpg/play/CampaignDmPanel.tsx`; `client/src/components/rpg/play/CampaignDmPanel.test.tsx`; `client/src/components/rpg/play/campaignDmPanel.css`; `client/src/api.ts`; existing scene-binding controls and campaign role/session state.
Own writes: `client/src/components/rpg/play/CampaignDmReadinessPanel.tsx` (NEW), its focused test (NEW), `client/src/components/rpg/play/CampaignDmPanel.tsx`, `client/src/components/rpg/play/CampaignDmPanel.test.tsx`, and `client/src/components/rpg/play/campaignDmPanel.css`. Do not edit API/server/contracts, parent page, browser E2E, docs ledger, or excluded paths.
Inputs/interfaces: GM/owner-only fetch; activation section is separate from preparation issues; issues are already fixed safe labels/explanations/remediation enums; coverage state and awaiting-evidence state are explicit. Use existing named scene-binding controls/navigation only; no invented deep links.
Acceptance: Inspect preparation action; player/observer never fetches; campaign/room/role changes clear state and discard late responses; private diagnostic text is not persisted in browser storage; GET/reload/inspection creates no commands; pending command/draft/map recovery remains intact; mobile readable and status labels accessible; remediation is actionable without claiming solvability.
Validation: focused CampaignDmPanel/readiness tests and `npm run typecheck --workspace velvet-mvp-client`. No provider/live storage.
Constraints: apply_patch; no commits/pushes; preserve existing UI behavior/tests; do not weaken role/privacy assertions.
Stop: when focused client tests/typecheck pass, or report a concrete blocker.
Return: changed files/interfaces, exact commands/results, remaining risks, and smallest next task.
