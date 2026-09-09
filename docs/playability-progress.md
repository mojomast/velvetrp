# Playability progress

## Current checkpoint
- Baseline commit: `9e5f1b7`
- Active plan/milestone: Plan 2 / P2.F, player-elected optional encounter fixture variant
- Last accepted milestone and commit: P2.1 reviewed fixture, `b375e35`; P2.F bounded readiness reference fix, `bd3b3a8`
- Next small assignment: add a journey-only fixture option that leaves the optional encounter unmaterialized until director planning
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
| P2.1 | accepted | `b375e35` | reviewed fixture 3; readiness/checks/fixture 12; server typecheck; independent review accepted | reviewed fixture guide; docs index; readiness observations | full shared live envelope unused |
| P2.F | accepted | `bd3b3a8` | readiness/checks/fixture 12; server typecheck; independent review accepted | scope amendment and binding-reference policy in ledger | full shared live envelope unused |
| P2.2 | blocked | | risky route blocked: optional encounter is pre-created before player election | P2.F evidence recorded in ledger | full shared live envelope unused |
| P2.F.2 | accepted | pending coordinator commit | reviewed fixture 4; server typecheck; independent review accepted | scope amendment in ledger | full shared live envelope unused |

## Next agent task
P2.F handoff: readiness projection uses raw colon-free valid binding references only; colon-containing, oversized, invalid, or digest-shaped tuples use `binding:` plus a 48-hex SHA-256 prefix of an unambiguous JSON tuple. Internal evidence matching remains exact JSON tuple semantics. Prepared future evidence is `review` severity, while missing binding stays a blocker. The actual reviewed fixture is activation-ready/active and emits one `private-artifact` warning plus two `awaiting-play-evidence` reviews. `optional-disconnected-content` is documented only as a branch expectation because generated content has no optional flag.

Amendment: P2.2 found `createReviewedAdventure` creates the optional Gloam-Mite encounter during fixture setup, before player risky-route election. The existing director then offers only `encounter-start`; its materialization lane requires no open encounter and accepted planning. Add a journey-only fixture option that preserves the P2.1 default initial-state proof but omits this pre-created encounter, so P2.2 can prove player-authorized travel followed by existing director materialization. No new player encounter-election API, route, authority, schema, or combat-retreat behavior is authorized.

Assignment: P2.F.2 optional encounter fixture variant
Goal: add a journey-only reviewed fixture option that does not pre-create the optional encounter, while retaining the existing P2.1 default fixture and all unearned-state guarantees.
Baseline/predecessor: P2.1 `b375e35`; P2.2 blocker evidence above. Existing materialization must use accepted planning after player travel, not direct state repair.
Read first: `server/test/fixtures/reviewedAdventure.ts`; `server/test/reviewed-adventure-fixture.test.ts`; `server/src/repo/campaignDmRepo.ts`; `server/test/campaign-dm-generated.test.ts`; `docs/plan-2-reviewed-adventure.md`.
Own writes: `server/test/fixtures/reviewedAdventure.ts` and `server/test/reviewed-adventure-fixture.test.ts` only. Do not edit routes/contracts/runtime/docs/ledger.
Acceptance: default P2.1 fixture still has its prepared encounter/bindings; journey option has no encounter row or encounter binding at setup but retains accepted public planning/roster at Breakwater Cave, activation, actor/resource map, exact other objective bindings, and no earned outcomes/provider calls. Tests prove both variants and empty-target refusal. No materialization happens until P2.2 real director path.
Validation: fixture test and server typecheck. No providers/commits.
Return: files/results, exact variant semantics, and smallest next task.
