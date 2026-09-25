# Free-form generation research

Status: research + design. This document does not change runtime code. It analyzes the
failed Larkspur Falls AI opening beat, proposes bounded, rules-consistent mechanisms for
player attempts the prepared campaign never defined, and records the correct way to add a
new TypeSafe System One (Jev) lane. Every claim names the file and line or table it comes
from.

Controlling invariants assumed throughout (from `docs/ai-dungeon-master.md` and
`docs/jev-integration.md`):

- Prose never establishes mechanics; every committed change has a receipt.
- The model may propose what happens next; it never decides what became true.
- Server-issued candidate sets are closed; the model selects, it does not invent.
- Accepted generated canon is immutable; new content is additive.
- Jev never generates prose, never invents stats/prices/stock, and never mutates state.

---

## 1. Task 1 — Why the Larkspur Falls opening beat blocked, and what to fix

### 1.1 The exact failure path

The opening beat was requested with `intent: "open"` through
`POST /campaigns/:campaignId/rooms/:sessionId/dm/beat-commands`
(`server/src/routes/rpg/v1/campaignDm.ts:78`). Creation calls
`snapshot()` (`server/src/repo/campaignDmRepo.ts:447-585`), which builds the
server-issued `bindings` and a `blockers` list. Two things then combine:

1. The reported blockers are produced at:
   - `encounter-preparation-requires-exact-catalog-roster` —
     `campaignDmRepo.ts:529` and `:535`;
   - `story-public-rendering-required` — `campaignDmRepo.ts:538` (nodes) and `:556`
     (clues).
2. `claimDmPlanning` decides blocked vs. pacing: when `bindings` is empty and any blocker
   is not exactly `waiting-for-player-combat-action`, the run is set to `state='blocked'`
   with the stored blockers (`campaignDmRepo.ts:771-779`). `project()` then surfaces that
   state and the blocker list to the client (`campaignDmRepo.ts:179-188`).

Two structural facts make this unavoidable for a GM-visibility campaign:

- The pacing fallback is emitted only when *every* blocker is a member of
  `PACING_BLOCKERS` (`campaignDmRepo.ts:81`, `:566`). That set contains only
  `waiting-for-player-combat-action` and
  `scene-resolution-requires-gm-binding-or-human-adjudication`. Neither
  `story-public-rendering-required` nor `encounter-preparation-requires-exact-catalog-roster`
  qualifies, so no `advance-time`/`ambient-beat` candidate is ever added.
- If *no* story node, clue, encounter, or open encounter is usable, `bindings` is empty, so
  `claimDmPlanning` hits the empty-binding branch (`campaignDmRepo.ts:771-779`) and
  hard-blocks. An opening beat therefore needs at least one admitted candidate.

### 1.2 (a) Why GM-visibility story nodes/clues can never open a scene

Disclosure is enforced by `publicStoryResourceSql` (`server/src/repo/storyDisclosure.ts:1-10`).
A resource is public only when there is **no** accepted artifact in
`campaign_generation_accepted_artifacts_v52` with `visibility='gm'` whose
`server_resource_id` equals it (or that anchors it as a GM clue source). `snapshot` calls this
per node (`campaignDmRepo.ts:538`) and per clue (`:556`) through the local `publicSource`
closure (`:137-138`); a GM-visibility resource pushes `story-public-rendering-required` and is
skipped.

Acceptance materializes a story node's accepted artifact row with the *candidate's* visibility
and its generated `server_resource_id` (`server/src/repo/campaignGenerationRepo.ts:190-196`,
`:207`). So a GM-visibility story node always has a GM accepted artifact pointing at its node
id, and `publicSource` is always false. The readiness projection reaches the same conclusion:
a node is only `rendered` when the story-node accepted artifact is public, or when a second
accepted artifact with the same `server_resource_id` is public
(`server/src/repo/campaignDmReadinessRepo.ts:109-124`).

The trap is that there is currently **no apply path that binds a second public artifact to an
already-materialized node id**. The apply loop derives server ids per candidate artifact key
via `stableId(...)` (`campaignGenerationRepo.ts:180`) into a fresh `ids` map; a public
"rendering" candidate for the same story would get a different node id. The design guidance to
"prepare a separate reviewed public-safe story rendering"
(`docs/ai-dungeon-master.md:67`, `docs/campaign-generation.md:71`) is therefore not executable
with the current schema. A GM-only campaign has no way to satisfy the blocker for that node.

Compounding details:

- Generated nodes are created with `revealThreshold: 0` (`campaignGenerationRepo.ts:190`) and
  `status='hidden'` (`:195`). A node can be added as `reveal-node` when
  `status==='hidden' && resolved >= revealThreshold` (`campaignDmRepo.ts:543`), and
  `resolved` counts only incoming edges from *public and resolved* predecessors
  (`:541`). A GM node is skipped before that, so it can never reveal.
- Generated clues force `revealThreshold: 1` (`campaignGenerationRepo.ts:193`) and their
  sources must be public non-hidden nodes or answered plot points (`campaignDmRepo.ts:555-561`).
  A GM-only campaign has neither.

### 1.3 (b) Why generated monster-concept / NPC-participant encounters fail the exact-roster check

Encounter candidate artifacts carry three roster-ish fields
(`packages/contracts/src/campaign-content-generation-http.ts:63-70`):
`participantNpcKeys`, `enemyReferences` (exact `enemyTemplateCatalogReferenceSchema`), and
`monsterConceptKeys`.

`snapshot` rejects a prepared encounter plan when *any* of these hold
(`server/src/repo/campaignDmRepo.ts:517-529`):

- `plan.monsterConceptIds.length` is non-zero;
- `plan.participantNpcIds.length` is non-zero;
- any actor in the plan's `locationId` is missing from
  `getEncounterSetupCandidates` (`:518`);
- any `enemyReference` does not resolve to an exact pinned `enemy-template` definition whose
  parsed `reference` deep-equals the reference (`:519-528`).

Why this is structural, not a generator bug:

- A monster concept is *narrative planning canon only*. Its `mechanics` union is
  `catalog-bound` (an exact reference) or `inert`; a concept does not create an enemy template
  and "do not themselves ... spawn enemies, or create encounters"
  (`docs/campaign-generation.md:56`, `:115-116`). A plan that expresses enemies as
  `monsterConceptKeys` cannot become a roster.
- `participantNpcKeys` resolves to `campaign_npcs_v28` ids
  (`campaignGenerationRepo.ts:158`), but `encounterCreateRequestSchema` combatants accept only
  `{ kind: "actor", actorId }` or `{ kind: "enemy", template }`
  (`campaignDmRepo.ts:531-533`). There is no NPC combatant kind. NPC combat is entered only
  through target-initiated `initiateCombat` (below), which resolves an exact SRD template by
  heuristic (`server/src/repo/encounter/npcCombatProfile.ts`). So a plan naming NPC
  participants cannot construct the create request.

The readiness checks agree: `conceptOnly` or `unsupportedRoster` produces a blocker-level
`unsupported-encounter-roster` issue
(`server/src/repo/campaignDmReadinessChecks.ts:171-177`,
`server/src/repo/campaignDmReadinessRepo.ts:143-154`).

### 1.4 Provenance trap observed in the sibling bug

Two errors observed in campaign play share one cause: a persisted progression/sheet state that
does not reconstruct from its own provenance.

- Sheet reads assert `sheet class levels == progression level` in both the gameplay sheet
  (`packages/contracts/src/gameplay-sheet-http.ts:110-115`) and the character sheet
  (`packages/contracts/src/character-sheet-http.ts:23-32`).
- Progression reads assert the stored pending snapshot matches the authoritative calculator:
  `character_progression_pending_snapshots_v24` must equal
  `canonicalCatalogJson(expected)` and its digest
  (`server/src/repo/characterProgression/characterProgressionReadRepo.ts:89-96`); known power
  and option provenance are re-derived from the exact catalog and advancements (`:97-139`).
- The write side maintains class levels through `rpg_character_classes` and the progression
  root together (`server/src/repo/characterProgression/characterProgressionWriteRepo.ts:766-855`).

The trap: any path that changes a class level, a buff/level-like field, or a progression choice
**outside** `characterProgressionWriteRepo` can leave the class-level sum, the progression
root level, and the pending-snapshot digest mutually inconsistent. A generated NPC/actor or a
free-form "buffed" actor must never write `rpg_character_classes`, `character_progression_v23`,
or `character_progression_pending_snapshots_v24` directly. This is a hard constraint for Task 2:
ad-hoc actors/NPCs either get no class levels (NPCs use
`campaign_npc_baseline_stats_v41`, not player classes) or must be created through the
progression write repo so level, classes, and pending digest are computed together.

### 1.5 Concrete, low-risk Task 1 improvements

Ordered by risk (lowest first). All are additive; none rewrite accepted canon.

1. **Make the opening scene a public story node at generation time.** In the
   `campaign-content-v6` prompt and the generation validation
   (`server/src/routes/rpg/v1/campaignContentGeneration.ts:194-204`), require the first
   story node (the opening) to be `visibility: "public"` and keep secrets in separate
   GM-only nodes. A public opening has no GM accepted artifact and passes
   `publicStoryResourceSql`. This needs no schema change and directly satisfies the readiness
   `rendered` predicate (`campaignDmReadinessRepo.ts:114-116`).
2. **Treat private-only story as skippable for an opening, not a hard block.** In
   `snapshot`, do not push `story-public-rendering-required` for nodes/clues that are not on
   the required progress path; or, more conservatively, make `open` intent emit a
   server-owned public opening candidate (a bounded `ambient-beat`/scene prompt anchored to
   `campaign_starting_locations_v51` plus the public premise) when there is a starting
   location, and record the private rendering as an advisory blocker. This matches the
   readiness model, where private nodes are warnings, not blockers
   (`campaignDmReadinessChecks.ts:124`, `:148-151`), and preserves the invariant that the
   Director never fabricates a public rendering (`docs/ai-dungeon-master.md:67`).
   Note the current hard stop is the empty-binding branch (`campaignDmRepo.ts:771-779`), so
   this requires at least one server-owned opening binding.
3. **Reject concept-only / NPC-participant rosters in accepted encounter plans.** Add a
   generation-stage rule that an accepted encounter's roster is exact pinned
   `enemyReferences` only; `monsterConceptKeys` and `participantNpcKeys` may annotate the plan
   but cannot satisfy the roster. For NPC participants, resolve each NPC to an exact SRD
   template at plan-resolution time via
   `resolveNpcCombatProfile` (`server/src/repo/encounter/npcCombatProfile.ts:338-415`) and
   store that reference, mirroring how `initiateCombat` already handles attacked NPCs
   (`server/src/repo/encounter/initiateCombat.ts:1-23`,
   `docs/ai-dungeon-master.md:47`).
4. **Publish opening handouts/scene prompts explicitly at startup.** `publishCampaignMaterial`
   already exists and only accepts public `handout`/`scene-prompt` artifacts
   (`campaignGenerationRepo.ts:160-165`). Add a bounded "open campaign" step that publishes
   eligible public opening materials (expected v53 revision + idempotency key) so the first
   beat has public material without a manual detour.
5. **Readiness as a precondition, not a surprise.** Surface
   `getCampaignDmPreparationReadiness` (`server/src/repo/campaignDmReadinessRepo.ts:59-193`)
   in the open flow and refuse to open only when the readiness report has a blocker-level
   issue that cannot be paced around. This converts a mid-beat `blocked` into an actionable
   preparation checklist.

Focused test targets for these: `server/test/campaign-dm-run.test.ts`,
`server/test/campaign-dm-generated.test.ts`, `server/test/campaign-dm-readiness.test.ts`,
`server/test/campaign-dm-readiness-checks.test.ts`,
`server/test/rpg-campaign-content-generation-route.test.ts`,
`server/test/npc-combat-profile.test.ts`.
Run the owning workspace typecheck (`npm run typecheck --workspace velvet-mvp-server`).

---

## 2. Task 2 — Free-form generation design

### 2.0 Shared framework

Every free-form materialization follows the same shape so it cannot become an arbitrary
state patch:

1. **Trigger.** A player declaration or an explicit GM action. The server, never the model,
   decides whether the attempt needs new content and whether it is legal.
2. **Bounded candidate space.** The server builds a closed, small candidate set
   (which location seed, which NPC archetype, which catalog items). Jev may rank/select;
   the prose provider may author *text fields*; neither may add candidates or mechanics.
3. **One atomic transaction.** Materialization reuses
   `campaignGenerationRepo`'s draft/apply machinery
   (`server/src/repo/campaignGenerationRepo.ts`,
   `applyCampaignContentGenerationDraftAtomically`, `:166-213`) so candidate artifacts
   (`campaign_generation_candidate_artifacts_v52`) are staged, reviewed, re-validated, and
   applied with a durable command/receipt (`campaign_content_commands_v42` /
   `campaign_content_receipts_v42`). Movement uses `world_commands_v28` /
   `world_receipts_v28` / `world_events_v28` with `campaign_actor_locations_v28`.
4. **Visibility + public rendering.** Player-facing content is `visibility: 'public'`.
   GM secrets stay GM-only. Apply already rejects a public artifact that transitively depends
   on a GM artifact (`campaignGenerationRepo.ts:173-176`), and readiness flags private
   artifacts (`campaignDmReadinessRepo.ts:109-124`).
5. **Fail closed / rollback.** `apply...Atomically` is a single `db.transaction(...).immediate()`
   (`campaignGenerationRepo.ts:166`): a failure leaves nothing materialized. Free-form
   commands must never auto-retry a provider; a duplicate request converges through the
   existing idempotency keys/digests. If a later step (e.g. movement) fails, the outer
   transaction rolls back the materialization too.
6. **Receipt.** At least one durable receipt per committed artifact plus one world receipt
   per movement. Cross-reference ids in a small free-form sidecar (proposed
   `freeform_materializations_v61`) so a resume/audit can reconstruct the whole action.

Proposed modules (new, additive):

- `server/src/repo/freeform/freeformIntentRepo.ts` — deterministic attempt classification
  (`new-location`, `new-npc`, `hostile`, `shop`, `faction`, `quest`, `clue/lore`) plus a
  bounded, server-owned candidate projection. Jev may later gate this in shadow.
- `server/src/repo/freeform/freeformMaterializationRepo.ts` — owns the outer transaction; builds
  the generation draft, calls the existing apply, then the world move; writes the sidecar
  receipt.
- `server/src/repo/freeform/freeformNpcRepo.ts` — ad-hoc NPC/persona/baseline creation, reusing
  the exact statements already in `campaignGenerationRepo.ts:203`.
- `server/src/repo/freeform/freeformShopRepo.ts` — bounded shop/stock creation over the
  existing economy tables.
- `server/src/repo/freeform/freeformEncounterRepo.ts` — catalog-bound hostile plan
  materialization and `initiateCombat` reuse.

All new tables should ship as a late sidecar (`server/src/repo/db/*Schema.sql` composed in
`schema.ts`), matching `docs/jev-integration.md`'s migration discipline and `AGENTS.md`.

### 2.1 Travel to an unmapped location ("I go to the glassblower's district")

**Trigger / decision.** The player declaration goes through the existing adventure-turn
path. The server checks `campaign_locations_v28` by name/alias and open
`campaign_location_connections_v28` from the current location. If the destination does not
exist, the free-form intent repo emits a bounded `materialize-location` candidate. The player
does not get to invent mechanics; the server owns the candidate space.

**Boundedness.**

- At most one new location and one connection per declaration.
- Name is the player's bounded phrase (≤200 chars) or a server-picked catalog/naming seed;
  description/atmosphere come from the prose provider or a deterministic template.
- The new location must attach to the actor's current location via a public connection
  (`campaign_location_connections_v28`, schema
  `server/src/repo/db/currentSchema.sql:2788-2800`).
- If the attempt implies a hazard, that is a separate bounded check (see below).

**Skill check first?** The documented behavior is that "pure travel" maps to no check and
any concrete attempt maps to a server-selected check (`docs/ai-dungeon-master.md:50`). Keep
that: materialization itself is not a check. A check is appropriate only for a *hazard the
new location introduces* (locked gate, climb, navigation), and it must be the normal
server-issued SRD check path, not a model-authored roll.

**Atomic write.** Reuse the generation apply with candidate artifacts `location` (public) and
`connection` (public). The existing apply already inserts
`campaign_locations_v28` and `campaign_location_connections_v28`
(`campaignGenerationRepo.ts:201`, `:204`). Then, in the same outer transaction, issue a world
`set_actor_location` or `travel` command. `setActorLocation` is GM-authority
(`server/src/repo/world/worldWriteRepo.ts:180-181`) and writes `world_events_v28` and a
guarded `campaign_actor_locations_v28` revision
(`currentSchema.sql:2879-2882`). The free-form path resolves GM authority the same way
`initiateCombat` does (`initiateCombat.ts:10-16`). Because `apply...Atomically` and
`setActorLocation` each open their own immediate transaction, the new repo must own an
**outer** `db.transaction` and call both inside it; better-sqlite3 nests these as savepoints,
so a failure in either rolls back both. If nesting is deemed too clever, the fallback is a
two-phase design where materialization commits first and a failed move simply leaves the actor
where they were (no partial mechanics, but two receipts).

**Scene image / grounding consequences.** The new location's public artifact carries
`atmosphere`; the scene-image integration reads public campaign materials and the existing
live context path (`docs/campaign-generation.md:77-86`). The tactical map uses location text
only to infer layout kind (`server/src/repo/combatTacticalMap.ts:24-29`,
`KIND_KEYWORDS`). Movement should also write `campaign_location_discoveries_v28` for the
moving actor(s) (as `placeFinalizedActorAtCampaignStartV51` does,
`server/src/repo/grantSettlementRepo.ts:91-92`).

**Failure/rollback.** Provider prose generation failure falls back to a deterministic template
or leaves the location unmaterialized and the beat narrates a bounded "you cannot get there
yet" hold. Never leave a location without a connection or an actor location revision without
its world event.

### 2.2 Ad-hoc NPC generation

**Trigger.** A player addresses an NPC not present/known in the public roster. The server
checks `campaign_npcs_v28` + `campaign_npc_presence_v43` at the current location, then emits a
bounded `materialize-npc` candidate.

**Reuse.** The apply path already creates everything an ad-hoc NPC needs for kind `npc`
(`campaignGenerationRepo.ts:203`):

- `characters` persona row (`fictional_confirmed=1`, `is_real_person=0`);
- `campaign_npcs_v28` and `campaign_npc_private_state_v28`;
- `campaign_npc_metadata_v32` with `public_state_json` and private `{goals,gmNotes,merchantState}`;
- `campaign_npc_baseline_stats_v41` fixed at `10,10,10,'generated-deterministic-baseline'`;
- world narrative command/receipt/event (`recordWorld`, `campaignGenerationRepo.ts:182`);
- a `generated_npc_placement_intents_v52` row when a `locationKey` is present (`:209`), reconciled
  by `reconcileGeneratedNpcPlacementsV52` (`:59-87`).

So an ad-hoc NPC is a **one-artifact generation draft** through the existing machinery. Do not
write these tables directly.

**Visibility.** Public persona/description; private motives in `privateGoals` (GM-only). A
public NPC must not reference a GM artifact (`campaignGenerationRepo.ts:175-176`). The public
rendering query already excludes GM-hidden NPCs by accepted artifact
(`campaignDmRepo.ts:325-326`).

**Combat profile.** When attacked, `initiateCombat` resolves the NPC to the nearest exact SRD
template via `resolveNpcCombatProfile`, which reads public name/state/archetype plus baseline
stats (`npcCombatProfile.ts:338-415`; tier table `:43-84`). It pins on demand and never invents
stats. This is the only correct way to give an ad-hoc NPC a combat profile.

**Avoiding GM-only blockers.** Keep `campaign_npcs_v28` NPCs public when they are meant to be
met. A GM-only NPC does not create a hard blocker by itself (private is a readiness warning),
but it is excluded from the public cast and cannot be a public scene dependency.

### 2.3 Unplanned encounters / hostiles

**Already-implemented lane.** An explicit attack declaration naming a visible campaign actor
or NPC materializes and starts an encounter through the normal lifecycle, generates exactly one
deterministic tactical map, and invents no statistics
(`docs/ai-dungeon-master.md:47-48`; `server/src/repo/encounter/initiateCombat.ts`). The attack
declaration itself starts combat; a separate "initiate" button is not required.

**Director path.** The Director may only propose `encounter-materialize` from an accepted,
exact-catalog-bound plan (`campaignDmRepo.ts:509-536`; `docs/campaign-generation.md:115`).

**Free-form hostiles.** When players provoke a fight the prepared campaign did not define:

- Do **not** bypass the plan. Synthesize a bounded encounter *plan* artifact (server-owned)
  whose `enemyReferences` are exact pinned templates chosen from a deterministic server table
  (the `TIER_TEMPLATES` pattern in `npcCombatProfile.ts:43-84`, or a scene/terrain tier
  mapping). Prose may name the creature; the reference is server-selected and re-parsed
  (`campaignDmRepo.ts:526-527`).
- Materialize/start through the same `encounterCreateRequestSchema` + `startEncounter` path
  (`campaignDmRepo.ts:591-602`). `initiateCombat` is the player-facing equivalent for an
  attacked target.
- The tactical map is produced inside encounter start (`ensureCombatTacticalMap`,
  `combatTacticalMap.ts:9-18`), deterministic seed, one map per encounter.

**Atomicity.** `initiateCombat` already wraps create+start in one transaction and rolls back
fully on failure (`initiateCombat.ts:10-23`). The free-form plan + create + start must likewise
be one transaction, or fall back to a recorded blocker with no partial encounter.

### 2.4 Shopkeeper inventories and trade

The economy subsystem already exists; only the free-form *stock generation* is missing.

Existing tables and code:

- `rpg_shop_definitions_v25`, `rpg_shop_stock_v25`, `rpg_shop_quotes_v25`,
  `rpg_trade_proposals_v25`, `rpg_wallets_v25`, `rpg_currency_references_v25`,
  `rpg_purchase_receipts_v25` (`server/src/repo/db/currentSchema.sql:2271-2349`).
- Buy/sell/trade mutation: `server/src/repo/economy/economyWriteRepo.ts` (wallet debit/credit,
  stock decrement/increment, purchase/sell/trade receipts).
- HTTP: `server/src/routes/rpg/v1/actorEconomy.ts` (shop read, quote, purchase, sell, trades);
  adventure integration and narration receipts in
  `server/src/repo/adventureCommerceRepo.ts` and
  `server/src/routes/rpg/v1/adventureTurns.ts:72-73,150`.
- GM buy-back policy: `configureCampaignBuyPolicy` / `setShopBuyPolicy`
  (`adventureCommerceRepo.ts:78`; `campaignAdministrationIntegrations.ts:52`).
- `merchantState` already exists as a GM-only NPC field:
  `campaign_npc_private_state_v28.merchant_state_json`
  (`currentSchema.sql:2814`; written with `NULL` for generated NPCs,
  `campaignGenerationRepo.ts:203`).

Design (proposed `freeformShopRepo.ts`):

- **Trigger.** A player asks to buy from an NPC identified as a merchant, or the GM marks a
  generated NPC as a merchant.
- **Boundedness.** Create/attach one `rpg_shop_definitions_v25` row per NPC/location
  (idempotent). Choose 2–8 items from
  `rpg_campaign_catalog_definitions_v25` (exact pinned `item` kind). Quantities bounded
  (e.g. 1–20). Never create a shop for a non-pinned item.
- **Prices.** Use the catalog item's base/price field when present; otherwise a deterministic
  server formula. **Prices and stock are explicitly on the Jev "must not go" list**
  (`docs/jev-integration.md:754-762`); the prose provider must not supply them either.
- **Currency.** Resolve/attach through `rpg_currency_references_v25` exactly as
  `grantSettlementRepo.currencyCode` does (`grantSettlementRepo.ts:28-38`).
- **Trade.** Reuse `economyWriteRepo.mutateEconomyForActor` and the existing routes; the
  adventure lane already produces public commerce receipts
  (`adventureCommerceRepo.ts`). No new purchase command is needed.
- **Provenance.** `rpg_shop_stock_v25` has exact FKs to campaign catalog definitions and
  currency references (`currentSchema.sql:2295-2306`); a free-form shop is only valid if the
  item is pinned. Record the stock command/receipt in the free-form sidecar (shops have no
  built-in command table).

### 2.5 Factions, quests, clues, lore, rumors

These are all already generatable artifact kinds; free-form should create them through the
same one-or-few-artifact draft mechanism rather than new bespoke writers.

- **Faction.** Apply creates `campaign_factions_v28` + private state + world narrative
  command/receipt/event + `campaign_faction_metadata_v32`
  (`campaignGenerationRepo.ts:202`). Reputation changes use the world
  `change_reputation` command (`worldWriteRepo.ts:372`).
- **Quest.** Apply creates `quests`, `quest_definitions_v33`, objectives, objective
  progress/dependencies, and a storyline (`campaignGenerationRepo.ts:205`). A free-form quest
  must keep objectives public and rewards catalog-safe (`xp`/`custom`); currency rewards need
  exact pins, so prefer modeling physical loot as a separate catalog-bound item.
- **Clue.** A clue artifact either names `revealsStoryNodeKey` or gets a synthetic hidden
  source node (`campaignGenerationRepo.ts:187-195`; `docs/campaign-generation.md:119`). A
  free-form clue must be public with a public source node, otherwise it hits the same
  `story-public-rendering-required` trap as Task 1.
- **Lore / rumor.** Model as a `lore` artifact (narrative canon, `campaign-generation.md:116`).
  Do **not** write rumors into `agent_observations` by extracting prose: the project
  deliberately never does LLM extraction into the knowledge ledger
  (`docs/jev-integration.md:757-760`). If an NPC "knows" the rumor, that is an explicit
  GM/authorized relationship decision, not an inference.

**Invariant protection.** Accepted canon is never edited; a later generation apply creates a
new artifact/storyline because v34 graphs are immutable
(`docs/campaign-generation.md:117`). Free-form additions must close their dependency graph,
keep public→GM dependencies forbidden, and be capped (e.g. ≤4 new artifacts per beat,
rate-limited per session).

### 2.6 Proposed new Jev lane for free-form

Add an advisory/shadow-only lane `freeform-materialization` (see §3 for the mechanics):

- `choice` over the server-authored materialization candidate list
  (`materialize-location`, `materialize-npc`, `hostile-encounter`, `shop-stock`, `new-clue`,
  `none_of_these`).
- `noul` "does this attempt actually require new durable content, or is a narration/hold
  sufficient?"
- `noul` "is this attempt legal under the current readiness/canon constraints?"

Composition in code: act only when the `noul` gates and the choice agree at the action
threshold; otherwise fall back to the deterministic classifier (or hold). Jev still never
authors names, descriptions, stats, or prices.

---

## 3. Task 3 — Jev best practices and adding a lane

### 3.1 What Jev is and is not

Jev is TypeSafe's typed-decision service: `POST https://api.typesafe.ai/v1/systemone` with a
bounded `state` and server-issued `choice`/`score`/`noul` questions; one typed answer per
question, strict Zod validation, no free text (`docs/jev-integration.md:61-135`). It never
mutates state, authorizes a command, generates prose, or invents stats/prices/stock
(`:184-199`, `:754-762`). Everything is disabled by default (`:880-898`).

### 3.2 Adding a new lane (checklist, exact files)

1. **Lane registry.** Add the literal to `SYSTEM_ONE_LANES`
   (`server/src/types.ts:370-378`). This automatically extends
   `defaultSystemOneLaneModes`, `defaultSystemOneConfidencePolicy`, and
   `defaultSystemOneConfidenceCalibration` (`server/src/defaults.ts:24-28`, `:116-129`) and the
   public/update settings shapes (`types.ts:431-483`). The settings loader maps over
   `SYSTEM_ONE_LANES` (`server/src/repo/settingsRepo.ts:206`).
2. **Promotion gate.** Add an entry to `DEFAULT_SYSTEM_ONE_LANE_GATES`
   (`server/src/agent/systemOnePromotion.ts:87-95`). The `Record<SystemOneLane, ...>` type
   forces this to compile. Reuse the conservative `BASE_LANE_GATE`
   (`minSamples 30`, `minAccuracy 0.9`, Wilson lower bound 0.8, Brier/ECE ≤0.1) unless the
   lane's mistakes are visible or expensive.
3. **Pure battery/composition module.** Add `server/src/agent/systemOne<Lane>.ts` that builds
   atomic questions ("one property per question", `docs/jev-integration.md:629-644`) and
   composes the decision in code using `combineSystemOneBands`
   (`server/src/agent/systemOnePolicy.ts:61-66`). It must not hold prose.
4. **Execution contract (only if the lane can ever act).** Add an entry to
   `SYSTEM_ONE_EXECUTION_CONTRACTS` (`server/src/agent/systemOneBinding.ts:7-16`) with
   `questionVersion`, `compositionVersion`, `candidateStrategy`, `stateVersion`. Capture
   `systemOneEvaluationBinding(...)` (`:40-57`) in the evaluation; `isLanePromoted` requires an
   exact, order-independent binding match (`:72-74`, `systemOnePromotion.ts:413-417`).
5. **Lane modes.** Gating order: `FEATURE_SYSTEM_ONE` (`server/src/features.ts`,
   `docs/operations.md:94`) **and** `SystemOneSettings.enabled` **and** a usable key **and** a
   non-`off` `systemOneLaneMode` (`server/src/defaults.ts:31-34`). `active` additionally
   requires `isLanePromoted(lane, currentBinding)`. `shadow` records but never changes
   behavior; `off` makes no call. Default is `shadow` (`defaults.ts:17`).
6. **Budget.** Reserve before dispatch and settle/release after via the lane-scoped
   `SystemOneLaneBudgetManager` (`server/src/agent/systemOneBudget.ts:118-224`). Never share
   the adventure turn budget (`docs/jev-integration.md:259-270`, `:543-545`). A denied reserve
   falls back without dispatching.
7. **Usage accounting.** Record under a lane-specific kind following the
   `room_routing_system_one` pattern
   (`server/src/routes/roleplay/interactions.ts:64,338,468`).
8. **Immutable decision record.** Write every dispatch (shadow or active) to
   `system_one_decisions_v1` through `server/src/repo/systemOneDecisionRepo.ts` with
   request/question/state digests and a re-verifiable integrity assertion. Recording is
   advisory and must never fail the turn (`docs/jev-integration.md:272-292`, `:546-549`).
9. **Fake for tests.** `createFakeSystemOneCaller` is generic over any battery; script answers
   by question id and assert the recorded `calls` (`server/src/provider/systemOneFake.ts`).
   Deterministic E2E and unit tests use the fake; live calls stay opt-in, mirroring the live
   provider gate.
10. **Calibration + promotion.** Raw confidence is under-confident, so fit the monotonic Platt
    map out of band (`server/src/agent/systemOneCalibration.ts`) and record it in
    `confidenceCalibration`; the promotion record names the map that produced the metrics
    (`systemOnePromotion.ts:277-401`). Evaluate Brier/ECE plus the Wilson lower bound and
    decision stability on a frozen holdout with **negative examples**; a green gate on a corpus
    with no acted errors is a promotion *candidate*, not proof
    (`docs/jev-integration.md:386-392`, `:423-438`).
11. **Fallbacks and bounds.** Missing key, `enabled:false`, `401`, `422`, timeout, protocol
    error, over-budget, or an unknown answer shape all select the deterministic fallback;
    `429`/`529` use bounded backoff (`server/src/provider/systemOneCompletion.ts:187-239`,
    `docs/jev-integration.md:816-832`). Keep `state` bounded, candidates closed, and never place
    secrets in `state`.

Validation target per lane: the lane's unit test, its shadow test, its promotion/gate test, and
the owning workspace typecheck. Examples:
`server/test/system-one-policy.test.ts`, `server/test/system-one-promotion.test.ts`,
`server/test/system-one-director-shadow.test.ts`, `server/test/system-one-adventure-shadow.test.ts`,
`server/test/system-one-guardrails-shadow.test.ts`, `server/test/system-one-transport.test.ts`,
`server/test/system-one-completion.test.ts`.

### 3.3 Where Jev legitimately helps free-form generation

- **Needs-content gating.** `noul`: "does this attempt require new durable content?" This is a
  routing/classification decision, exactly Jev's shape.
- **Bounded candidate selection.** `choice` over the server-authored materialization
  candidate list, with an explicit `none_of_these` fail-closed option.
- **Guardrail checks.** Reuse L6 (`server/src/agent/systemOneGuardrails.ts`) before
  materialization; advisory to the deterministic policy, never a block by itself
  (`docs/jev-integration.md:556-600`).
- **Canon contradiction / duplicate detection.** Advisory `noul` before GM review
  (`docs/jev-integration.md:707-720`); never edits canon.
- **Cost/quality routing.** Choose deterministic template vs. provider generation vs. human
  review (`server/src/agent/systemOneRouter.ts`); may only route toward cheaper or human, and
  every route inherits the same authorization/receipt path
  (`docs/jev-integration.md:602-627`).

### 3.4 Where the prose provider must do the creative work

- Names, descriptions, atmosphere, dialogue, scene framing, lore prose, and any handout/read
  aloud text remain with the generative provider (`campaign-dm-narration-v1`,
  `campaign-content-v6` generation drafts; `docs/campaign-generation.md:60-88`,
  `docs/ai-dungeon-master.md:38`).
- Stats come only from the pinned SRD catalog or a deterministic server formula; prices and
  stock come only from the catalog/server formula. Jev and the prose provider are both barred
  from inventing them (`docs/jev-integration.md:754-762`).

---

## 4. Phased implementation plan

### Phase 0 — Opening-beat hot path (no new tables)

- P0.1 Public opening story node required by generation validation; reviewer check.
- P0.2 Opening intent gets a server-owned public opening candidate so a private-only story
  graph cannot hard-block the first beat.
- P0.3 Enforce exact-catalog encounter rosters for accepted plans; map NPC participants to
  `resolveNpcCombatProfile` references at resolution.
- P0.4 Startup publication of eligible public handouts/scene prompts.
- Focused tests: `campaign-dm-run`, `campaign-dm-generated`, `campaign-dm-readiness*`,
  `rpg-campaign-content-generation-route`, `npc-combat-profile`.

### Phase 1 — Free-form core (locations)

- New sidecar `freeform_materializations_v61` (proposed).
- `freeformIntentRepo` deterministic classification + bounded candidates.
- `freeformMaterializationRepo` outer transaction: draft → apply → world move → sidecar
  receipt.
- Focused tests: a new `server/test/freeform-materialization.test.ts` plus
  `server/test/campaign-dm-composition.test.ts` (composition/partial-failure behavior) and
  `server/test/tactical-map-generation.test.ts` for map consequences.

### Phase 2 — NPCs and shops

- `freeformNpcRepo` reusing the exact apply statements in
  `campaignGenerationRepo.ts:203`; combat via `initiateCombat`.
- `freeformShopRepo` over the existing economy tables with catalog-bound items/currencies.
- Focused tests: new freeform repo tests; `server/test/npc-combat-profile.test.ts`;
  existing economy/adventure-commerce tests.

### Phase 3 — Hostiles

- `freeformEncounterRepo`: bounded plan with exact pinned references, then create+start in one
  transaction; deterministic tactical map.
- Focused tests: `server/test/campaign-dm-generated.test.ts`,
  `server/test/campaign-dm-composition.test.ts`, `server/test/tactical-map-generation.test.ts`.

### Phase 4 — Factions, quests, clues, lore

- One-to-few-artifact drafts using accepted artifact kinds and the existing apply writers;
  never direct table writes.
- Focused tests: `server/test/rpg-generation-draft-route.test.ts`,
  `server/test/campaign-dm-readiness-checks.test.ts`.

### Phase 5 — Jev `freeform-materialization` lane

- Shadow first: battery + `systemOneFreeformMaterialization.ts`, decision records, no behavior
  change. Evaluate against a frozen labeled corpus with negative examples; add an execution
  contract and promotion record only on a passing gate.
- Focused tests: new lane unit/shadow/promotion tests following the
  `system-one-*-shadow.test.ts` pattern.

Every phase must state its trigger, boundedness, atomicity, visibility, and reuse point, and
must ship with a rollback story (fail closed, no auto-retry).

---

## 5. Risks

- **Nesting transactions.** Wrapping `apply...Atomically` and `setActorLocation` in one outer
  immediate transaction relies on savepoint nesting. Validate explicitly, or accept the
  two-phase fallback and document it.
- **Public-rendering trap.** Any free-form story/clue must be public with a public source;
  otherwise it reproduces the Task 1 blocker.
- **Provenance drift.** Never write `rpg_character_classes`, `character_progression_v23`, or
  `character_progression_pending_snapshots_v24` outside
  `characterProgressionWriteRepo`. NPCs use baseline stats, not player classes.
- **Catalog drift.** A reference that was pinned when planned may be unpinned at apply; the
  existing re-check rejects it (`campaignGenerationRepo.ts:174`). Free-form must fail closed.
- **Rate/cost blow-up.** Free-form can trigger paid generation per attempt. Bound per beat,
  per session, and reuse the lane-specific Jev budget; never share the chat budget.
- **Prose-to-mechanics leakage.** Only receipts establish outcomes; free-form narration must
  read committed receipts.
- **Visibility leakage.** A public artifact that transitively depends on a GM artifact is
  rejected; keep public and private causal chains separate
  (`campaign-generation.md:71`).

## 6. What not to do

- Do not let Jev or the prose provider invent stats, enemy templates, item references, prices,
  stock, or currency codes.
- Do not edit accepted canon in place; add new artifacts/storylines.
- Do not write story/clue content that is GM-only and then expect the opening beat to narrate
  it; `story-public-rendering-required` is a preparation blocker, not an auto-redaction request
  (`docs/ai-dungeon-master.md:67`).
- Do not pass `participantNpcKeys` or `monsterConceptKeys` as an executable roster.
- Do not write `campaign_npcs_v28`, `campaign_locations_v28`, `campaign_actor_locations_v28`,
  economy tables, or progression tables directly from a route/model; go through the owning
  repo and receipt.
- Do not enable a Jev lane in `active` without a matching execution contract and a passing
  promotion record; do not treat a no-error frozen corpus as proof.
- Do not extract prose into the NPC knowledge/observation ledger.
- Do not auto-retry paid provider calls; require explicit acknowledgement of a failed attempt
  (`docs/campaign-generation.md:96-98`).
- Do not expose a free-form command that skips authorization, revision checks, idempotency, or
  receipts.
