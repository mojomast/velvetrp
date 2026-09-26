# Campaign startup

Status: implemented runtime command. It turns a prepared campaign into a playable
AI-directed room. It is owner/GM-authoritative, idempotent, and never selects
candidates or writes domain canon itself; every step delegates to the owning
repository or service.

## HTTP command

`server/src/routes/rpg/v1/campaignStartup.ts` owns
`POST /api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/startup-commands`
(`:107`). It requires the `campaign` and `mechanics` feature flags (`:76`), the
fixed trusted-local principal `local-owner` (`:38`), `application/json`, no query
parameters, and either no body or exactly `{}` (`:40`, `:80-86`, `:115`). It
always returns `cache-control: private, no-store`.

The strict response (`campaignStartupResponseSchema`, `:56-70`; mirrored in
`client/src/api.ts:1450`) is `{ campaignId, sessionId, dmMode, dmModeRevision,
published[], beat: { runId|null, state }, imagesEnqueued[], blockers[] }` with
bounds 64 published, 64 images, and 16 blockers. `beat.state` is one of
`completed`, `blocked`, `planning`, `awaiting-approval`, `cancelled`, `unknown`,
`none`. Unavailable/conflict failures map to 404 `RPG_CAMPAIGN_STARTUP_NOT_FOUND`
or 409 `RPG_CAMPAIGN_STARTUP_CONFLICT`; anything else is a 500
`RPG_INTERNAL_ERROR` whose message requires reconciling the identical request
before retrying (`:91-105`).

## Ordered pipeline

`runCampaignStartup` (`server/src/startup/campaignStartup.ts:94`) performs exactly
four ordered steps. It re-reads durable state and authorizes as owner/GM before
any write; a missing membership/room fails closed
(`server/src/repo/campaignStartupRepo.ts:5-16`, `:43-79`).

1. **AI delegation to the acting owner as delegator.** It sets the Director mode
   to `ai` with the caller as delegator, revision-bound and provider-free,
   through the existing `setDmControl` (`server/src/startup/campaignStartup.ts:112-123`).
   When the mode is already `ai` it keeps the existing revision instead of
   bumping it.
2. **Publish eligible public materials.** It reads the generated planning
   projection and publishes every accepted public handout/scene-prompt that is
   not yet delivered, through `publishCampaignMaterial`
   (`server/src/startup/campaignStartup.ts:128-143`). GM-only artifacts and
   already-published materials are skipped; the publish revision is threaded
   forward from each receipt.
3. **Opening beat through the planning gate.** It runs the existing DM repo plus
   orchestrator (`orchestrateCampaignDmBeat`,
   `server/src/agent/campaignDmOrchestrator.ts`) with `intent: "open"`, so the
   server-issued candidate set and planning gate stay authoritative
   (`server/src/startup/campaignStartup.ts:145-168`). A completed open run is
   reused; a pending `planning`/`awaiting-approval` run is resumed; otherwise a
   fresh open run is created.
4. **One scene image per public location.** Only after the opening beat is
   `completed`, and only when the scene-image lane is installed and enabled, it
   enqueues one image per public campaign location
   (`server/src/startup/campaignStartup.ts:170-222`). It uses the configured
   `location:<locationId>` prompt override when present, otherwise
   `buildScenePrompt`. A disabled lane skips cleanly and a per-location failure
   is recorded as `skipped`; neither fails the command.

The public-location read seam (`getCampaignStartupRead`) exposes only the
designated public starting location and every `visibility='public'` location; it
never exposes GM-only locations, accepted-artifact internals, or story secrets
(`server/src/repo/campaignStartupRepo.ts:7-34`, `:58-67`).

## Deterministic idempotency

Every write key is derived server-side from a durable identity with
`startupKey(operation, identity)` = `startup.<operation>.<sha256(identity)[0:40]>`
(`server/src/startup/campaignStartup.ts:89-92`). The request carries no
caller-controlled command body, so replaying the identical request converges
against durable state rather than issuing a second publish, open, or image:

- `startup.dm-mode.<campaignId:revision>` — a fresh delegation after an explicit
  takeover is a new command, while an immediate replay converges.
- `startup.publish.<campaignId:artifactKey>`.
- `startup.open.<campaignId:sessionId:preparationToken>`, where the preparation
  token is
  `<startingLocationId|none>:<administrationRevision>:<sessionState>:<stopped|running>`
  (`:105-107`). A fixed campaign therefore gets a new opening attempt instead of
  replaying a previously blocked run.
- `startup.image.<campaignId:sessionId:locationId>`.

## Opening and readiness behavior

The Director snapshot in `server/src/repo/campaignDmRepo.ts` builds the candidate
set and blocker list. Since P0.2, GM-private story rendering and concept-only
encounter rosters no longer hard-block an `open` when the campaign has a public
starting location:

- The local `reportPreparation` only pushes
  `story-public-rendering-required` (nodes `:549`, clues `:567`) or
  `encounter-preparation-requires-exact-catalog-roster` (`:540`) when the intent
  is not `open`, or when no public starting location exists
  (`server/src/repo/campaignDmRepo.ts:514-519`). For an `open` with a public
  `campaign_starting_locations_v51` row, these are advisory.
- When no usable public story, clue, or exact-roster encounter candidate exists,
  the server adds a server-owned `ambient-beat` anchored to the public starting
  location (`server/src/repo/campaignDmRepo.ts:574-582`). This is presentation
  only: it reveals no GM-private rendering and commits no world state.
- Without a public starting location there is no opening candidate, so the
  preparation blockers still hard-block. The Director never fabricates a public
  rendering for GM-only content (`docs/ai-dungeon-master.md:67`).

Generation must still supply the content those candidates depend on.
`server/src/routes/rpg/v1/campaignContentGeneration.ts` enforces:

- **Public opening root story node.** When the `story` section is requested and
  nonempty, the first/root node (the single node, or the node with no incoming
  relationship) must have `visibility: "public"` (`:138`). Secrets belong in
  separate GM-only nodes. The `campaign-content-v6` output rules restate this
  (`:183`).
- **Exact pinned encounter rosters.** A candidate carrying any
  `participantNpcKeys`, `monsterConceptKeys`, or `enemyReferences` must carry at
  least one exact pinned enemy reference, and every reference must resolve to a
  pinned `enemy-template` definition (`:135`). With
  `tolerateInvalidReferences`, `sanitizeGeneratedCampaignContent` drops
  unusable/colliding references instead of failing the whole candidate
  (`:99-102`). `monsterConceptKeys`/`participantNpcKeys` may annotate a plan but
  never satisfy an executable roster (`server/src/repo/campaignDmRepo.ts:528-540`);
  see the rationale in
  [free-form generation research](freeform-generation-research.md).
- **Blocked opening is not fatal.** If the settled opening run is `blocked`,
  `unknown`, or `cancelled`, its blocker codes are returned in `blockers` rather
  than thrown; everything already applied stays in effect and a later run with a
  changed preparation token completes the remaining steps
  (`server/src/startup/campaignStartup.ts:149-168`, `:224-233`).

## Automatic creation paths

The startup command is normally invoked automatically so a fresh campaign is
playable without a manual detour.

### Hydration CLI

`scripts/hydrate-campaign.ts` runs startup after every generation/apply pass. It
is **on by default for `--create-campaign`** and can be forced with `--startup`
or opted out with `--skip-startup`
(`(options.startup ?? (options.createCampaign !== undefined))`,
`scripts/hydrate-campaign.ts:354-370`). It resolves the campaign's first attached
room from the rooms list deterministically (`firstAttachedRoom`, `:158-173`); if
none is attached it logs a skip and leaves `ledger.startup` unrecorded so a later
run can retry (`:360-363`). It otherwise POSTs the command with an empty body
(`:364-368`). Reported blockers are logged; the ledger records
`startup.status: "complete"` even when blockers exist, so the CLI does not
automatically re-attempt on resume — re-invoke the command (or attach a room
first) to finish. A persisted `startup.status: "dispatching"` at load means the
outcome is uncertain and stops the run for explicit inspection (`:323`).

### Client first-room attach

`client/src/components/rpg/overview/CampaignPreparation.tsx` calls
`campaignStartup(campaignId, sessionId)` (`:116-124`, `client/src/api.ts:1468`)
immediately after a successful first-room attach. It fires only when the campaign
had **no** attached rooms before the attach
(`command.kind === "attach" && startupSessionId && data.rooms.attached.length === 0`,
`:92-96`), so attaching another room to a campaign already under play never
starts it again. The helper never throws: a blocked or failed startup surfaces
through the normal status notice and must not turn the already-succeeded attach
into an uncertain write; no retry is issued (`:110-124`).
