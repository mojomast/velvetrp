# Playability progress

## Current checkpoint
- Baseline commit: `9e5f1b7`
- Active plan/milestone: Plan 1 / P1.6
- Last accepted milestone and commit: P1.5 GM readiness panel, commit to be recorded below
- Next small assignment: prove the isolated readiness workflow through browser/HTTP/SQLite acceptance
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
| P1.4 | accepted | `f01cb68` | route 4; server typecheck; client API 6; client typecheck; documentation drift 7; independent transport review accepted | API inventory/counts; campaign-readiness guide; docs index; ledger | full shared live envelope unused |
| P1.5 | accepted | pending coordinator commit | CampaignDmPanel 16; readiness panel 3; client typecheck; independent UI review accepted | campaign-readiness guide; ledger | full shared live envelope unused |
| P1.6 | in-progress | | focused readiness E2E and E2E typecheck pending | | full shared live envelope unused |

## Next agent task
Assignment: P1.6 browser acceptance and handoff
Goal: prove the isolated HTTP/SQLite readiness workflow and GM-only Living Atlas inspection through a real browser path, then finish the Plan 1 handoff without claiming full campaign solvability.
Baseline/predecessor: P1.5 readiness panel, commit to be recorded after coordinator commit; route `/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/dm/preparation-readiness`; strict report v1.0; no live provider calls.
Read first: `docs/plan-1-campaign-readiness.md`; `docs/campaign-readiness.md`; `docs/playability-progress.md`; `e2e/tests/campaign-dm.spec.ts`; `e2e/tests/campaign-control-plane.spec.ts`; `client/src/components/rpg/play/CampaignDmPanel.tsx`; `server/test/rpg-campaign-dm-readiness-route.test.ts`.
Own writes: `e2e/tests/campaign-dm-readiness.spec.ts` (NEW), readiness/AI-DM/generation docs as needed, `docs/playability-progress.md`, `docs/ROADMAP.md`, `devplan.md`, `handoff.md`, and Plan 1 handoff text. Coordinator owns shared fixture/API inventory changes.
Inputs/interfaces: use normal production setup/placement commands over disposable storage; no direct SQL state repair; fake provider only if existing setup requires it, with zero paid calls. Test activation-ready but inadequately prepared content, supported preparation remedy, reinspection improvement, private-content exclusion, role denial, reload/read-only behavior, and no provider dispatch.
Acceptance: desktop/browser route and panel, player/observer never see private diagnostics, stale/late response discarded, no mutation or command ownership from inspection, source/receipt-linked safe issues, docs match actual route/counts, no critical readiness/security finding.
Validation: `npx playwright test e2e/tests/campaign-dm-readiness.spec.ts`, `npm run typecheck:e2e`, affected server/client tests/typechecks, and documentation drift. No live API calls.
Constraints: apply_patch; no commits by subagent; preserve excluded paths; do not infer mandatory finale/solvability or use admin HTTP shortcuts where browser coverage is required.
Stop: when focused E2E/typecheck/review/docs gates pass, or report a concrete blocker.
Return: changed files, exact browser/test results, private/public observations, handoff DTO/API/limits/revision semantics, remaining risks, and smallest next task.
