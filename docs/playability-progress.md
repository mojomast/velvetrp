# Playability progress

## Current checkpoint
- Baseline commit: `9e5f1b7`
- Active plan/milestone: Plan 2 / P2.F, fixture-triggered bounded readiness-reference fix
- Last accepted milestone and commit: Plan 1 readiness handoff, `2bda645`
- Next small assignment: correct reviewed fixture target ownership/finale binding, then restore readiness severity/reference compatibility
- Uncommitted file owners: coordinator owns plan/protocol/docs index/ledger; excluded paths remain untouched
- Blockers and decision required: none; no provider calls authorized or required yet
- Live budget remaining / audit path / uncertain dispatch IDs: USD 2.00, 130 dispatches, 250,000 reserved/settled tokens, 40 minutes; no live dispatches; no audit IDs

## Interface handoffs
- P1 readiness DTO, codes, API, coverage, and expected warnings: v1.0 `CampaignDmReadinessResponse`; fixed-safe issue taxonomy; private GET `/campaigns/:campaignId/rooms/:sessionId/dm/preparation-readiness`; 128 issues, labels <=200, explanations <=800, exact ten bounded coverage families; activation revision remains separate; expected warnings include optional/private resources and prepared bindings awaiting committed evidence; no solvability inference.
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
| P1.5 | accepted | `04a5125` | CampaignDmPanel 16; readiness panel 3; client typecheck; independent UI review accepted | campaign-readiness guide; ledger | full shared live envelope unused |
| P1.6 | accepted | `2bda645` | readiness E2E 1 (24.3s); E2E typecheck; documentation drift 7; independent acceptance review accepted | readiness/Director/roadmap/devplan/handoff/ledger docs | full shared live envelope unused |
| P1 | accepted | `2bda645` | P1.1-P1.6 focused gates accepted; zero provider calls | Plan 1 handoff recorded | full shared live envelope unused |
| P2.1 | in-progress | | fixture test and server typecheck pending | | full shared live envelope unused |
| P2.F | accepted | pending coordinator commit | readiness/checks/fixture 12; server typecheck; independent review accepted | scope amendment and binding-reference policy in ledger | full shared live envelope unused |

## Next agent task
Amendment: P2.1 found that the P1 readiness projection serializes scene-binding tuple IDs as `nodeId:evidenceKind:targetId`; valid generated IDs can exceed the DTO's 128-character `resourceId` cap. This blocks inspection of a real reviewed fixture. The fix is limited to deterministic bounded synthetic binding references in the readiness projection. Review additionally found fixture target-directory ownership was not passed to `createRepository`, the finale binding did not target its final objective, normal awaiting evidence was classified contrary to the readiness guide, and short existing binding references were unnecessarily replaced. These corrections preserve authority and require no schema/provider change.

Assignment: P2.F bounded readiness binding reference
Goal: emit deterministic bounded non-candidate binding reference IDs for readiness diagnostics/coverage while preserving exact internal node/kind/target binding semantics.
Baseline/predecessor: P2.1 fixture worktree; P1 readiness DTO rejects 64-character digest-shaped IDs and caps resource references at 128.
Read first: `server/src/repo/campaignDmReadinessRepo.ts`; `server/src/repo/campaignDmReadinessChecks.ts`; `packages/contracts/src/campaign-dm-readiness-http.ts`; `server/test/campaign-dm-readiness.test.ts`; `server/test/fixtures/reviewedAdventure.ts`.
Own writes: `server/src/repo/campaignDmReadinessRepo.ts`, `server/src/repo/campaignDmReadinessChecks.ts`, `server/test/campaign-dm-readiness.test.ts`, and `server/test/campaign-dm-readiness-checks.test.ts` only. Do not edit contracts, fixture, routes, docs, or any authority logic.
Acceptance: generated long binding tuple is inspectable; projected binding reference is <=128, deterministic, non-candidate-shaped, collision-resistant for fixture-scale tuples, and contains no target/private text; qualifying evidence still maps to `evidence-committed`; no provider/mutation/recovery work; existing simple binding output remains valid.
Validation: focused readiness repository test, reviewed fixture test, and server typecheck. No live API/provider calls or commits.
Return: changed files, projected-ID policy, exact results, risk, and smallest next task.
