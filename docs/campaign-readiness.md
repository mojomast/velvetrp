# Campaign DM Readiness Contract

P1.1 freezes provider-free response version `1.0` for the proposed owner/GM
preparation inspection. It is read-only diagnostic data, not an activation gate,
solvability claim, candidate list, or executable digest.

## Shape and limits

`campaignDmReadinessResponseSchema` contains identity (`campaignId`, `sessionId`,
`timelineId`, and separate campaign/timeline revisions), the unchanged
`campaignRoomActivationReadinessSchema` as `activationReadiness`, DM `mode`,
ordered `issues`, family `coverage`, and explicit `manualReviewLimitations`.
The issue list is capped at 128; labels are capped at 200 characters and
explanations at 800. Coverage is complete only when every family is complete and
has no omitted references. Any omitted or capped family must be `partial` or
`omitted`, so incomplete inspection cannot look clean.

Coverage families and caps are: locations 64, connections 96, actors 64, quests
64, encounters 64, story 96, clues 96, artifacts 96, bindings 64, evidence 64.
References use a finite kind enum and resource IDs only. Candidate IDs and
digests are not valid references.

## Issue taxonomy

| Code | Severity/scope example | Remediation |
| --- | --- | --- |
| `room-obstacle` | blocker, current-room | activation |
| `private-artifact` | warning, campaign-level | content |
| `missing-binding` | blocker, current-room | binding |
| `awaiting-play-evidence` | review, awaiting-play-evidence | play |
| `optional-disconnected-content` | warning, later-location | content |
| `missing-public-rendering` | blocker, current-room | story |
| `unbound-encounter` | blocker, later-location | binding |
| `unsupported-encounter-roster` | blocker, later-location | content |
| `coverage-truncated` | warning, campaign-level | coverage |
| `manual-review-required` | review, campaign-level | manual-review |

Every issue has a finite code, severity (`blocker`, `warning`, `review`), scope
(`current-room`, `later-location`, `awaiting-play-evidence`, `campaign-level`),
bounded reference, fixed safe GM label/explanation, and typed remediation destination.
Issue codes use the catalog order and duplicate issue objects are rejected. Manual
review limitations are also finite safe messages; callers cannot put provider prose,
private artifact text, or executable candidate digests into this DTO.

## Examples

Issue examples (each is an element of `issues`) are:

```json
{"code":"room-obstacle","severity":"blocker","scope":"current-room","reference":{"kind":"room","id":"room-1"},"label":"Room obstacle","explanation":"The existing activation readiness checks report an obstacle in the inspected room.","remediation":"activation"}
{"code":"private-artifact","severity":"warning","scope":"campaign-level","reference":{"kind":"artifact","id":"artifact-1"},"label":"Private artifact","explanation":"This preparation artifact is not public player-facing content.","remediation":"content"}
{"code":"missing-binding","severity":"blocker","scope":"current-room","reference":{"kind":"encounter","id":"encounter-1"},"label":"Missing scene binding","explanation":"The prepared scene has no explicit binding for qualifying committed evidence.","remediation":"binding"}
{"code":"awaiting-play-evidence","severity":"review","scope":"awaiting-play-evidence","reference":{"kind":"evidence","id":"turn-1"},"label":"Awaiting play evidence","explanation":"The prepared binding is waiting for qualifying committed play evidence.","remediation":"play"}
{"code":"optional-disconnected-content","severity":"warning","scope":"later-location","reference":{"kind":"artifact","id":"artifact-2"},"label":"Optional disconnected content","explanation":"This optional resource is not reachable from the inspected room and does not block the current path.","remediation":"content"}
```

Partial coverage is represented with `coverage.state: "partial"`, family entries
marked `partial` or `omitted`, omitted references, and a manual limitation. It
cannot be represented as `state: "complete"`; `coverage-truncated` is the finite
code for an issue caused by an inspection bound.

## Pure Check Interface

`checkCampaignDmReadiness` consumes explicit, already-authorized fact objects and
does not open storage, call a provider, interpret prose, or mutate state. Its
fact families cover public rendering, story `requires` dependencies and reveal
thresholds, explicit scene bindings, exact pinned encounter rosters, and directed
location connections. Every `requires` predecessor must be resolved and have
reviewed public rendering before it contributes to a threshold; private or
private-companion nodes are reported as private resources rather than blocked by
their own thresholds. Reverse-only location edges do not establish reachability.

Facts carry `current-room` or `later-location` scope. Optional resources remain
warnings at campaign scope, while missing required resources retain blocker
severity. Encounter concepts, participant-NPC lists, and empty enemy references
never count as executable exact rosters. The check result always includes finite
manual-review reminders for clue alternatives/fail-forward, finale/aftermath,
player choice, and the fact that required paths or endings are not inferred from
titles or prose.

## Repository Projection

`createCampaignDmReadinessRepository` exposes the read-only
`getCampaignDmPreparationReadiness` projection. It authorizes the attached room
and owner/GM membership before reading preparation, story, binding, catalog, or
placement facts. The response uses the active campaign timeline and preserves
the existing activation readiness object unchanged. Activation inspection is
shared through a transaction-safe `createCampaignRoomActivationReadinessInspector`
so readiness and activation use the same authorization and blocker semantics
without starting a director run.

Scene bindings retain their evidence kind and target ID. A binding is
`awaiting-play-evidence` until persisted `dm_story_evidence` is joined to a run
whose authorized context contains the exact source; encounter materialization
bindings are not treated as scene evidence. Generated and authored public story
nodes/clues both participate in disclosure checks. Encounter rosters require
exact pinned `enemy-template` references, and all resource lists are bounded;
overflow is explicit partial coverage.

The HTTP transport is `GET /api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/dm/preparation-readiness`.
It is a trusted-local owner/GM read, rejects query and body input, binds the
response identity to the path, uses `private, no-store`, and returns generic
not-found errors for unavailable or unauthorized resources.
