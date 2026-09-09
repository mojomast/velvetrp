# Playability progress

## Current checkpoint
- Baseline commit: `9e5f1b7`
- Active plan/milestone: Plan 1 / P1.4
- Last accepted milestone and commit: P1.3 authorized repository projection, commit to be recorded below
- Next small assignment: expose the readiness projection through a strict static GET route and client transport
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
| P1.3 | accepted | pending coordinator commit | readiness 3; activation 14; generated 2; binding evidence 2; server typecheck; independent integration review accepted | campaign-readiness guide; ledger; activation/repository integration | full shared live envelope unused |
| P1.4 | in-progress | | route/client tests and typechecks pending | | full shared live envelope unused |
| P1.5 | pending | | | | full shared live envelope unused |
| P1.6 | pending | | | | full shared live envelope unused |

## Next agent task
Assignment: P1.4 HTTP and client transport
Goal: expose the committed readiness projection as one strict static GET route and typed client API with no provider or mutation dependency.
Baseline/predecessor: P1.3 projection, commit to be recorded after coordinator commit; repository method `getCampaignDmPreparationReadiness`; contract version `1.0`.
Read first: `server/src/routes/rpg/v1/campaignDm.ts`, route registration in `server/src/routes/rpg/v1/features.ts`, `client/src/api.ts`, existing campaign DM client tests, `docs/api.md`, `test/documentation-drift.test.ts`.
Own writes: `server/src/routes/rpg/v1/campaignDm.ts`, `server/test/rpg-campaign-dm-readiness-route.test.ts` (NEW), `client/src/api.ts`, `client/src/campaignDmApi.test.ts`. Coordinator integration owner updates route registration/operation inventories and docs drift files only.
Inputs/interfaces: trusted-local `local-owner` remains explicit; GET `/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/dm/preparation-readiness`; response is CampaignDmReadinessResponse; no body/query; private no-store; generic unauthorized errors.
Acceptance: feature-disabled, malformed, unknown, unauthorized, cross-campaign, strict response, explicit static registration, no implicit HEAD, zero provider calls, and route/client type compatibility.
Validation: focused route/client transport tests, owning server/client typechecks, and `documentation-drift.test.ts`; rebuild contracts first only if shared exports change.
Constraints: no client UI yet, no provider/live storage, no commits by subagent, preserve excluded paths and existing routes.
Stop: when transport tests/typechecks/docs inventory pass, or report a concrete blocker.
Return: changed files/interfaces, exact commands/results, remaining risks, and smallest next task.
