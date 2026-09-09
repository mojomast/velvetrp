# Playability progress

## Current checkpoint
- Baseline commit: `9e5f1b7`
- Active plan/milestone: Plan 2 / P2.2
- Last accepted milestone and commit: P2.1 reviewed fixture, commit to be recorded below; P2.F bounded readiness reference fix, `bd3b3a8`
- Next small assignment: execute all reviewed branches in human/AI mode through real HTTP/SSE with fake completions and deterministic rolls
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
| P2.1 | accepted | pending coordinator commit | reviewed fixture 3; readiness/checks/fixture 12; server typecheck; independent review accepted | reviewed fixture guide; docs index; readiness observations | full shared live envelope unused |
| P2.F | accepted | `bd3b3a8` | readiness/checks/fixture 12; server typecheck; independent review accepted | scope amendment and binding-reference policy in ledger | full shared live envelope unused |
| P2.2 | in-progress | | HTTP/SSE journey tests and server typecheck pending | | full shared live envelope unused |

## Next agent task
P2.F handoff: readiness projection uses raw colon-free valid binding references only; colon-containing, oversized, invalid, or digest-shaped tuples use `binding:` plus a 48-hex SHA-256 prefix of an unambiguous JSON tuple. Internal evidence matching remains exact JSON tuple semantics. Prepared future evidence is `review` severity, while missing binding stays a blocker. The actual reviewed fixture is activation-ready/active and emits one `private-artifact` warning plus two `awaiting-play-evidence` reviews. `optional-disconnected-content` is documented only as a branch expectation because generated content has no optional flag.

Assignment: P2.2 production HTTP journey
Goal: execute the manifest's three primary branches in human and AI modes through real HTTP/SSE with fake completions and deterministic rolls, comparing normalized receipts/state rather than IDs/prose.
Baseline/predecessor: P2.1 fixture digest `9517022bfcd508893f6b2f83a89c2c26560fd701d6fd46551da7ef107516929d`; P2.F `bd3b3a8`; actual readiness reviews are expected at startup.
Read first: `docs/plan-2-reviewed-adventure.md`; `docs/reviewed-adventure.md`; `server/test/fixtures/reviewedAdventure.ts`; `server/test/rpg-generated-campaign-journey.test.ts`; `server/test/campaign-dm-binding-evidence.test.ts`; `server/test/adventure-quest-progression-action.test.ts`.
Own writes: `server/test/reviewed-adventure-journey.test.ts` (NEW) and narrow helpers only inside `server/test/fixtures/reviewedAdventure.ts`. Do not edit routes/contracts/runtime/docs/ledger without coordinator assignment.
Acceptance: all primary success/safe, failure/alternate, and combat-victory branches in human/AI through HTTP/SSE; original player turns; explicit finale tuple; failed roll not promoted; source/privacy safety; reward claim semantics; director holds on player turns; no evidence reuse; bounded steps/rounds; stop on unexpected candidate.
Validation: focused journey test and server typecheck. Provider fake only, no live dispatch/commits.
Return: files, exact normalized oracle/results, fake dispatch count, blocked product gaps, and smallest next task.
