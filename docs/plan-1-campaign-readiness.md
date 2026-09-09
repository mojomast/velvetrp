# Plan 1: Campaign readiness

Status: planned, not implemented. Researched against `9e5f1b7`.

Execute under [the shared execution protocol](playability-execution.md). Finish
this plan before [Plan 2](plan-2-reviewed-adventure.md); its reports become
preparation evidence for [Plan 3](plan-3-memory-evaluation.md).

## Outcome

An owner/GM can inspect an accepted campaign in a particular room and understand
which resources are usable, what needs preparation, and what requires human
review. Inspection is read-only, provider-free, and private. It neither starts a
scene nor declares the entire campaign solvable.

Do not add another activation gate. `campaignRoomActivationRepo.ts` already owns
publication, safety, participant, rules/catalog, starting-location, and room
activation checks. Compose that existing response unchanged in a separate report
section. Its administration revision is not a revision for all game domains.

## Research decisions

- The [Three Clue Rule](https://thealexandrian.net/wordpress/1118/roleplaying-games/three-clue-rule)
  motivates reviewing essential-information chokepoints and alternate discovery
  routes. It is practitioner advice, not evidence that counting three clue records
  proves independent routes or solvability.
- [Fate's four outcomes](https://fate-srd.com/fate-core/four-outcomes) illustrate
  complications and success at a cost rather than dead ends. Borrow preparation
  ideas, not Fate mechanics or permission for prose to grant success.
- [Existing AI-DM research](ai-dungeon-master.md#research-and-evidence) supports
  separation of creative assistance, mechanical adjudication, and disclosure.
  A readiness report must retain that separation.

## Current constraints

- Accepted encounter plans are not executable encounters. Current materialization
  needs exact pinned enemy references, suitable actors, and matching location.
  Nonempty monster-concept or participant-NPC lists currently block that path.
- `storyDisclosure.ts` protects generated GM-only nodes, clues, and synthetic clue
  anchors. Reveal state, AI delegation, and binding do not declassify their text.
  Existing Story Studio can author separate reviewed public-safe story content.
- AI resolution requires an explicit scene/evidence binding and fresh, qualifying,
  unused committed evidence. A prepared binding awaiting future play is normal.
  Check-turn bindings cannot exist before their target turn exists.
- Story `requires` edges, reveal thresholds, and clue-source thresholds have
  different semantics. World connections are directed; containment is not travel.
- There is no typed mandatory-scene/finale designation. Do not infer required
  paths, OR-branches, narrative meaning, or endings from titles or prose.
- Private and optional resources may coexist with a playable public path. Their
  restrictions are resource-specific, not necessarily campaign-wide blockers.

## Contract target

Proposed GET: `/api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/dm/preparation-readiness`.
This is a proposed addition, not a current endpoint. Owner/GM authorization must
precede private reads. Keep the existing trusted-local HTTP limitation explicit.

Use a strict versioned DTO containing campaign/room/timeline identity, existing
activation readiness, DM mode, deterministically ordered issues, inspected and
omitted coverage, and manual-review limitations. Avoid a global `ready: true`.

Each issue has a finite stable code, severity (`blocker`, `warning`, `review`),
scope, bounded resource reference and GM label, fixed explanatory wording, and a
typed remediation destination. Distinguish current-room blockers, later-location
preparation, and awaiting-play-evidence. Never return executable candidate digests.

Starting bounds: 128 returned issues, labels at most 200 characters, explanations
at most 800 characters. Establish finite per-family inspection limits in P1.1;
overflow must return `partial`, never a clean bill of health. These are proposed
limits to validate against existing generation caps, not existing contracts.

No persistent report, schema change, provider prompt, automatic repair, content
conversion, or generation call is required. A genuine need for persistence must
go through the shared scope-change gate before code is written.

## Milestones

Each numbered milestone is one implementation assignment and one reviewed commit.
Use the shared task template; do not give a subagent this entire plan to implement.

### P1.1: Diagnostic contract

Read: `packages/contracts/src/campaign-dm-http.ts`,
`campaign-room-activation-http.ts`, `campaign-content-generation-http.ts`,
`server/src/repo/campaignDmRepo.ts`, and `server/src/repo/storyDisclosure.ts`.

Own: new `packages/contracts/src/campaign-dm-readiness-http.ts`, its new contract
test, and `packages/contracts/src/index.ts`. Write the finite taxonomy and proposed
limits into new `docs/campaign-readiness.md` and index it in `docs/README.md`.

Deliver: strict schemas and examples for a room obstacle, a private artifact,
missing binding, waiting evidence, optional disconnected content, and partial
coverage. Existing activation and director contracts remain unchanged.

Gate: reject unknown fields, invalid scope/version/references, and oversized
arrays/text. Tests establish that incomplete coverage cannot masquerade as complete.
Run the new contract test, contracts typecheck, and
`npm run build --workspace @velvet/contracts` before downstream work.
Handoff: exported types and
issue-code/remediation table. Commit: `feat(contracts): define DM preparation diagnostics`.

### P1.2: Pure diagnostic checks

Read: `server/src/repo/storyRepo.ts`, `campaignDmRepo.ts`,
`campaignGenerationRepo.ts`, and world contracts. Do not open application storage.

Own: new `server/src/repo/campaignDmReadinessChecks.ts` and
`server/test/campaign-dm-readiness-checks.test.ts`.

Deliver: deterministic checks over supplied authorized facts for public rendering,
dependency/threshold obstruction, binding classification, exact encounter roster
support, and directed location connectivity. Add explicit human-review reminders
for clue alternatives, fail-forward, finale/aftermath, and player choice.

Gate: tests cover private predecessors, optional/private companion graphs, threshold
rules, directed routes, concept-versus-executable distinctions, and stable issue
order. No SQL, model call, text interpretation, or mutation in this module.
Run its test and server typecheck. Commit: `feat(rpg): check campaign preparation structure`.

### P1.3: Authorized repository projection

Read: `campaignRoomActivationRepo.ts`, `campaignDmRepo.ts`,
`campaignGenerationRepo.ts`, `storyDisclosure.ts`, and repository composition.

Own: new `server/src/repo/campaignDmReadinessRepo.ts` and
`server/test/campaign-dm-readiness.test.ts`; integration owner exclusively edits
`server/src/repo/campaignRepositoryOrchestration.ts`,
`server/src/repo/campaign/campaignTypes.ts`, and `server/src/repo/index.ts`.
If eligibility extraction is necessary, explicitly assign the small affected
`campaignDmRepo.ts` region to this owner and preserve execution behavior.

Deliver: one read transaction that checks owner/GM access before inspecting
activation, accepted preparation, story disclosure, bindings, catalog pins, and
room placement. Match actual director restrictions; do not obtain diagnostics by
opening, claiming, or recovering a director run.

Gate: player/observer/outsider/revoked-GM/cross-campaign denial; repeated reads change
no rows or revisions and dispatch no provider. Activation result matches its owning
reader. Distinguish later-location resources from current missing placement. Test
overflow and private/public parallel graphs. Run the new tests plus affected
`campaign-room-activation`, `campaign-dm-generated`, and
`campaign-dm-binding-evidence` tests and server typecheck.
Commit: `feat(repo): project private campaign readiness`.

### P1.4: HTTP and client transport

Own: `server/src/routes/rpg/v1/campaignDm.ts`, new
`server/test/rpg-campaign-dm-readiness-route.test.ts`, `client/src/api.ts`, and
`client/src/campaignDmApi.test.ts`. Integration owner updates `docs/api.md` and
actual operation-count assertions/documentation without weakening drift checks.

Deliver: one explicit static GET registration, `private, no-store`, no implicit
HEAD, strict path/response validation, and no body/query or provider dependency.

Gate: feature-disabled, malformed, unknown, and unauthorized cases; generic public
errors; strict response binding; zero provider calls. Run route/client transport
tests, owning typechecks, and `documentation-drift.test.ts`.
Commit: `feat(api): expose GM preparation inspection`.

### P1.5: GM readiness panel

Own: new `client/src/components/rpg/play/CampaignDmReadinessPanel.tsx` and test,
`client/src/components/rpg/play/CampaignDmPanel.tsx` and its test, and
`client/src/components/rpg/play/campaignDmPanel.css`.

Deliver: explicit Inspect preparation action, separate activation section, scoped
issues, awaiting-evidence state, coverage warning, and real remediation links or
instructions. Reuse named scene-binding controls. Do not invent deep links to
targets that existing navigation cannot select. Keep map/draft and pending command
recovery intact; report inspection does not take command ownership.

Gate: no player/observer private fetch; clear on role/room/campaign change and
discard late responses. Do not persist private diagnostic text in browser storage.
GET-only reload/inspection; mobile readability and accessible status labels.
Run affected client tests/typecheck. Commit: `feat(ui): guide GM preparation fixes`.

### P1.6: Acceptance and handoff

Own: new `e2e/tests/campaign-dm-readiness.spec.ts`, readiness guide, relevant
AI-DM/generation docs, progress ledger, and handoff.

Deliver: isolated browser/HTTP/SQLite fixture showing activation-ready but
inadequately prepared content; normal supported preparation remedies; reinspection
recognizes the improvement; private preparation never appears in shared history.
Use existing production commands, not direct SQL state repair.

Gate: focused E2E and E2E typecheck; affected regressions; independent review of
authorization-before-read, no side effects, and parity with director eligibility.
Commit: `test(rpg): verify preparation readiness workflow`.

## Plan 2 handoff

Save under `docs/playability-progress.md` the DTO/version, issue taxonomy, new API,
tested permissions, inspection limits, revision semantics, and the final commit.
Record the fixture's expected private/optional warnings; Plan 2 must not suppress
them or require every future scene to possess successful evidence at startup.

Plan 2 owns its adventure fixture, supported branch manifest, actual resource-ID
mapping, and narrative review. This report cannot prove narrative quality or replace
that work. Exit only when P1.1 through P1.6 pass, docs match code, and no critical
readiness/security finding remains.
