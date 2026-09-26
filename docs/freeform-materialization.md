# Free-form materialization (locations and NPCs)

Status: implemented bounded commands. They let play continue past the prepared
campaign without letting prose or a model invent canon: when a player declares
travel to an unmapped place or addresses an unknown person, the server decides
whether new durable content is needed and owns a closed candidate set. This is
the runtime counterpart to the design analysis in
[free-form generation research](freeform-generation-research.md); shop stock is
repository-only and not yet routed (see below).

## Shared invariants

Both routed commands in `server/src/repo/freeform/` follow the same shape:

- **Server-authored closed candidate sets.** Classification is deterministic and
  server-owned (`classifyFreeformTravel`, `server/src/repo/freeform/freeformTravelRepo.ts:162`;
  `classifyFreeformNpc`, `server/src/repo/freeform/freeformNpcRepo.ts:256`). It
  produces either "no intent" with a fail-closed reason or a small candidate list
  (currently exactly one candidate). A caller may only select a candidate the
  classifier produced: a supplied `candidateId` that does not match the
  deterministic candidate id is rejected as a conflict
  (`freeformTravelRepo.ts:348-350`, `freeformNpcRepo.ts:425-427`).
- **No model in this path.** The player supplies only a bounded phrase (the new
  location name, or the person/role). The location description is a deterministic
  template (`freeformTravelRepo.ts:193`), and the NPC archetype, description, and
  GM-only goals come from a closed server table
  (`FREEFORM_NPC_ARCHETYPES`, `freeformNpcRepo.ts:97-146`). No free-text world
  lore or model-authored persona is accepted.
- **Atomic, receipted writes through existing command paths.** Materialization
  runs inside one caller-owned immediate transaction and reuses the generation
  draft/apply machinery (`createGenerationDraft`, `recordCampaignGenerationCandidate`,
  `applyCampaignContentGenerationDraftAtomically` → `campaign_content_commands_v42`
  / `campaign_content_receipts_v42` / `campaign_generation_candidate_artifacts_v52`).
  Travel additionally issues the existing world `travel` command →
  `world_commands_v28` / `world_receipts_v28` and `campaign_actor_locations_v28`.
  These modules never write a domain table directly, and a failure in either half
  rolls back both (`freeformTravelRepo.ts:1-35`, `:354-420`;
  `freeformNpcRepo.ts:1-43`, `:431-498`).
- **Deterministic idempotency keys.** Keys derive from the durable identity
  `campaignId:sessionId:actorId:<normalized phrase>` (`ff-draft-`, `ff-apply-`,
  `ff-travel-`, `ff-npc-draft-`, `ff-npc-apply-`). A replay converges and reads
  the committed draft/receipts back instead of creating a second location or NPC
  (`freeformTravelRepo.ts:289-325`, `freeformNpcRepo.ts:379-403`).
- **Public visibility with GM content kept separate.** Materialized content is
  `visibility: 'public'`. NPC GM-only goals are a **separate** `visibility: 'gm'`
  `lore` artifact in the same draft and never appear in the public persona;
  the generation apply rejects a public artifact that transitively depends on a
  GM-only artifact (`freeformNpcRepo.ts:446-458`).
- **No fabricated stats, items, or prices.** Travel creates only a location,
  connection, and actor movement. The NPC command creates only a persona; it
  invents no ability scores, HP, class levels, or other combat stat and never
  writes `rpg_character_classes`, `character_progression_v23`, or
  `character_progression_pending_snapshots_v24`. The existing apply path records
  only the fixed `10,10,10,'generated-deterministic-baseline'` row in
  `campaign_npc_baseline_stats_v41`; combat is resolved later, on demand, by
  `resolveNpcCombatProfile` / `initiateCombat`
  (`freeformNpcRepo.ts:32-39`, `server/src/repo/encounter/npcCombatProfile.ts`).
- **Authorization.** Campaign membership is required and `observer` is rejected;
  owner/GM may act, otherwise the principal must control the actor. GM
  materialization authority is resolved the same way `initiateCombat` does
  (`freeformTravelRepo.ts:228-247`, `freeformNpcRepo.ts:318-337`). Both routes use
  the trusted-local `local-owner` principal, require the `campaign` and
  `mechanics` flags, reject query parameters, and require `application/json`.

## Travel to an unmapped location

`POST /api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-travel-commands`
(`server/src/routes/rpg/v1/freeformTravel.ts:149`) accepts
`{ text: string (1..2000), candidateId?: string }` (`:108-111`).

The route always classifies first. A declaration that names an existing location
or carries no travel intent returns only `{ classification }`; only a
`materialize-location` classification reaches `materializeFreeformTravel`
(`freeformTravel.ts:183-189`). Fail-closed reasons are `no-travel-intent`,
`empty-destination`, `destination-too-long`, `known-location`,
`no-current-location`, and `current-location-unmapped` (`:43-50`). The actor's
current location must be an accepted public generated location (it needs a
public location artifact key to attach a connection to,
`freeformTravelRepo.ts:178-196`).

On materialization the command writes a public `location` and public `connection`
through apply, then moves the actor and returns `locationId`, `connectionId`,
`draftId`, `contentReceiptId`, the world receipt, and discoveries
(`freeformTravel.ts:79-106`; `freeformTravelRepo.ts:369-419`).

## Addressing an unknown NPC

`POST /api/rpg/v1/campaigns/:campaignId/rooms/:sessionId/actors/:actorId/freeform-npc-commands`
(`server/src/routes/rpg/v1/freeformNpc.ts:140`) accepts the same
`{ text, candidateId? }` body (`:99-102`).

Classification returns `none` (with `no-npc-intent`, `empty-name`,
`name-too-long`, `known-npc`, `no-current-location`, or
`current-location-unmapped`) or `materialize-npc` with a closed candidate
(`freeformNpc.ts:44-51`, `freeformNpcRepo.ts:256-289`). The archetype is selected
deterministically from the declared name tokens; only the actor's accepted public
location and its public factions supply placement context
(`freeformNpcRepo.ts:241-248`, `:339-357`).

Materialization writes a public `npc` persona and a separate GM-only `lore`
artifact, and returns `npcId`, `draftId`, `contentReceiptId`, and
`gmGoalsArtifactKey` (`freeformNpc.ts:81-97`, `freeformNpcRepo.ts:446-497`). The
persona is placed through the normal apply path with the current public location
as context, so the existing generated-NPC placement intent reconciliation applies
(see [campaign generation](campaign-generation.md#npc-location-intent)).

## Shop stock (in progress)

Free-form shop/stock generation exists at the repository level
(`server/src/repo/freeform/freeformShopRepo.ts`) and is wired into the campaign
repository, but it has **no HTTP command or client surface**, so a player
declaration cannot reach it yet. It is in progress, not playable.

Where it is implemented it is bounded and catalog-bound: it stocks only
publicly reachable, pinned items; the unit price is the catalog's exact
`mechanics.price.amount`; and currency resolves through
`rpg_currency_references_v25` with the same deterministic code as
`grantSettlementRepo.currencyCode`. Materialization writes
`rpg_shop_definitions_v25` and `rpg_shop_stock_v25` plus the
`campaign_npc_shop_bindings_v57` merchant binding in the same transaction as a
public shop-notice content receipt (`freeformShopRepo.ts:20-51`, `:444-548`).
Shops have no built-in command table, so the content receipt is the durable
receipt for the whole action; the research document's proposed
`freeform_materializations_v61` sidecar does not exist and remains a recommended
follow-up (`freeformShopRepo.ts:44-51`). See
[free-form generation research](freeform-generation-research.md).

## System One (Jev) freeform-materialization lane

The advisory `freeform-materialization` lane
(`server/src/agent/systemOneFreeformMaterialization.ts`) is registered, has a
shadow battery, a promotion gate (`DEFAULT_SYSTEM_ONE_LANE_GATES`), and — as of
this promotion-path slice — an execution contract (`SYSTEM_ONE_EXECUTION_CONTRACTS`
in `server/src/agent/systemOneBinding.ts`). It remains **shadow-only and
unpromoted**: `isLanePromoted("freeform-materialization")` is false in production
because there is deliberately **no production promotion record**, and no call
site consumes its composition. System One is disabled by default
(`SystemOneSettings.enabled: false`) and the lane's default mode is `shadow`, so
even shadow recording does not run unless an operator opts in.

The execution contract is bounded: the lane's `choice` may only select a
candidate the server already authored (`materialize-location`, `materialize-npc`,
`hostile-encounter`, `shop-stock`, `new-clue`) or fail closed to
`none_of_these`; the composition never returns prose, stats, prices, stock, or a
state mutation, and a future active path must bind under the single action family
`FREEFORM_MATERIALIZATION_ACTION_FAMILY` (`freeform.materialize-candidate`).

### Remaining evidence required to activate in production

A future activation needs all of the following; none exists yet:

- A frozen, provider-free **holdout with negative examples**: attempts that must
  hold, duplicate or illegal materializations, and attempts where a wrong
  candidate would be chosen. A no-error positive corpus is a promotion candidate,
  not proof.
- A passing `evaluatePromotionGate("freeform-materialization", metrics)` on that
  holdout: at least 30 acted samples, accuracy >= 0.9, Wilson lower bound >= 0.8,
  Brier and ECE <= 0.1.
- A fitted monotonic Platt map recorded in `confidenceCalibration` for the lane,
  and an `evaluatedBindings` record that exactly matches the runtime
  `systemOneEvaluationBinding("freeform-materialization", settings,
  responseModel, FREEFORM_MATERIALIZATION_ACTION_FAMILY)`.
- An active call site that consumes the composed candidate and goes through the
  existing receipted repository path (never a direct table write), gated by an
  `active` lane mode **and** `isLanePromoted`. Until then the deterministic
  classifier owns materialization.
