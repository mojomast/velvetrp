# VelvetRP RPG Feature Roadmap

This roadmap turns the completed gap analysis in [the RPG integration plan](rpg-integration-plan.md) and [the 2026 architecture notes](roleplay-architecture-2026.md) into dependency-ordered work. It starts from schema v28 revision 1, the repository modules under `server/src/repo/`, the shared runtime contracts under `packages/contracts/src/`, and the 21 trusted-local operations in `server/src/routes/rpg/v1/features.ts`. M1.8 adds no HTTP routes or client/UI.

All milestones preserve existing roleplay APIs and local-first SQLite operation. Until a separate remote-authentication project supplies verified principals and authorization, RPG HTTP handlers must continue to use the fixed trusted-local `local-owner` principal, bind only to loopback, and must not be represented as safe for remote or multi-user deployment. Mutations use revisions, idempotency keys, atomic repository transactions, structured problems, and authoritative-read reconciliation when delivery leaves commit status unknown.

M1.1-M1.8 are complete repository/shared-contract capabilities. The trusted-local HTTP boundary remains exactly 21 operations: the historical 14 plus builder create/read/update, progression read/preview, and administration GET/PATCH. M1.8 is repository-only and adds no routes or client/UI; M1.9 is next. The fixed v28r1 DDL digest is `2f6001699f45ecc90c426e05065d0ef004196c4419a5fbe2a94cd7e3770688c7`.

## Milestone 1 — Core RPG Mechanics (Schema + Repo layer)

### M1.1 Campaign administration, membership, and timelines

**Status: Complete (repository/shared-contract only)**

Extend the existing campaign foundation with lifecycle state, settings, membership administration, canonical checkpoints, non-destructive timeline forks, recaps, command logs, and versioned import/export records.

- **Complexity:** L
- **Dependencies:** Existing v9-v14 campaign, membership, timeline, event, receipt, and room-attachment tables; `campaignRepo.ts`; shared campaign contracts.
- **Acceptance criteria:**
  - Additive migrations and strict shared types represent draft, published, paused, completed, and archived lifecycle states; bounded campaign settings; membership role changes; checkpoints; forks; recaps; imports; and export manifests.
  - Repository methods enforce the sole-owner invariant, role-based projections, active-timeline revisions, immutable historical timelines, and append-only command/event provenance in atomic transactions.
  - Import dry runs validate schema version, references, collisions, limits, and excluded secrets without writing; apply is all-or-nothing and export omits credentials, local paths, and usage history by default.
  - Fresh and sequentially migrated databases have equivalent DDL, and existing characters, sessions, campaigns, and audit history remain unchanged.

### M1.2 Immutable content catalog and campaign pinning

**Status: Complete (repository/shared-contract only)**

Complete repository support for rules profiles and versioned content definitions while retaining exact-version campaign pins and immutable publication.

- **Complexity:** M
- **Dependencies:** M1.1; existing v10 rules profile, sealed pack, definition, campaign-selection, and pin tables; `packages/contracts/src/rpg-content.ts`.
- **Acceptance criteria:**
  - Shared schemas cover validation reports, compatibility metadata, publication manifests, and role-filtered catalog projections for races, backgrounds, classes, levels, skills, abilities, spells, items, currencies, and enemy templates.
  - Repository operations validate a complete pack before sealing it, reject arbitrary paths and unsupported mechanics, and never mutate or replace a sealed version.
  - Campaign configuration accepts only compatible sealed versions and produces deterministic definition ordering and reference-resolution errors.
  - The provenance-reviewed `velvet:mechanics-starter` remains sufficient for deterministic integration tests; it stays distinct from the metadata-only `velvet:original-starter`, and no third-party catalog is copied.

### M1.3 Character builder and derived sheet

**Status: Complete (schema v22r1 integrity repair; repository/shared-contract only)**

Add draft character construction, bounded attribute allocation, finalization, and one authoritative derived-stat calculator around the existing finalized campaign-character aggregate.

- **Complexity:** L
- **Dependencies:** M1.2; existing v11 campaign character, sheet, class, attribute, proficiency, choice, actor, and private-state tables.
- **Acceptance criteria:**
  - Additive schema and strict types represent expiring or durable drafts, choice-group completion, standard array, point buy, manual values, bounded server rolls, and starter kit or currency selection.
  - Repository finalization verifies persona eligibility, controller membership, pinned definitions, every required choice, and grants exactly once in one transaction.
  - A pure server-owned calculator derives HP, defenses, initiative, speed, carrying limit, spell attack, and save DC; clients receive values and explanatory inputs but cannot override results.
  - Persona edits remain separate from sheet edits, and incomplete drafts cannot become playable actors.

### M1.4 Progression and level application

**Status: Complete (introduced in v23r1; provenance/integrity repaired in v24r1; repository/shared-contract only)**

Persist XP or milestone advancement, previews, pending choices, and atomic single-class level application.

- **Complexity:** L
- **Dependencies:** M1.3; append-only events and command receipts from M1.1.
- **Acceptance criteria:**
  - Additive tables and contracts cover progression profiles, XP thresholds, XP ledger entries, level advancements, pending choices, and known powers.
  - Repository previews cross every applicable threshold in order and expose required choices and exact HP, proficiency, resource, power, and spell changes without writing.
  - Applying an advancement is idempotent, revision-checked, exactly-once, and leaves no partial level or unresolved required choice.
  - GM corrections require a bounded reason and append compensating ledger and audit events rather than rewriting history.

### M1.5 Resources, inventory, equipment, economy, and rest

**Status: Complete (schema v25r1; repository/shared-contract only; no HTTP routes or client/UI)**

Expand minimal actor resources into transactional inventory, equipment, wallets, shops, trades, and profile-defined recovery.

- **Complexity:** L
- **Dependencies:** M1.2-M1.4; existing v13 actor-resource rows and command infrastructure.
- **Acceptance criteria:**
  - Additive schema and contracts cover stackable and instanced items, slots, charges, ammunition, binding, wallets in integer minor units, currency ledgers, shops, finite stock, quotes, bilateral trades, and rest usage.
  - Repository commands prevent negative resources, balances, and stock; enforce capacity, slot conflicts, transfer restrictions, quote expiry, and actor control; and settle each purchase or trade atomically.
  - Short and long rests calculate recovery from the pinned rules profile, reject illegal rest state, and emit a receipt listing every changed resource and effect.
   - Exact retries, revisions, and immutable receipts are factory-only behavior; unknown write delivery is reconciled from authoritative inventory, wallet, stock, and receipt reads without automatic replay.

### M1.6 Checks, powers, and deterministic effects

**Status: Complete (schema v26r1; repository/shared-contract only)**

Build server-calculated checks and power execution on the existing bounded dice evaluator, with a deliberately typed first effect vocabulary.

- **Complexity:** L
- **Dependencies:** M1.4-M1.5; existing v14 dice parser, evaluator, normalized roll persistence, and receipts.
- **Acceptance criteria:**
  - Tables and contracts represent checks, saves, attacks, healing, opposed checks, spell slots, limited power uses, concentration, active effects, duration, periodic changes, and typed modifiers needed by the starter rules.
  - The server derives modifiers and target numbers, consumes the entire canonical dice expression, caps work, and returns structured terms, total, target, outcome, and state changes.
  - Power costs, concentration replacement, effects, and resulting resources commit atomically; failed validation consumes nothing.
  - Stacking, resistance, vulnerability, immunity, duration, and expiration have deterministic tests and do not depend on generated prose.

### M1.7 Encounters and turn-based combat

**Status: Complete (schema v27r1; repository/shared-contract only; no HTTP routes or client/UI)**

Prepared and improvised encounters provide stable initiative, legal-action calculation, enemy instances, combat logs, and exactly-once recorded reward claims.

- **Complexity:** L
- **Dependencies:** M1.5-M1.6; campaign events and actor ancestry from M1.1 and M1.3.
- **Acceptance criteria:**
  - Additive tables and contracts cover encounters, combatants, enemy instances, initiative, rounds, actions, damage, defeat state, and reward bundles.
  - One active encounter is allowed per campaign session; only the current combatant may take normal actions; dead, fled, and removed actors leave turn rotation deterministically.
  - The repository returns a server-computed allowlist for attacks, powers, items, defend, flee, and end-turn, and rejects every action not in that revision-bound list.
  - Action, HP state, turn advance, combat-log entry, and recorded reward-claim state commit in one idempotent transaction; deterministic fallback tactics can always finish an enemy turn.
  - Powers and items reject when their independent resource or inventory streams cannot be atomically settled in the combat transaction. Rewards are currency-only, server-generated recorded claims, not generic caller input; recorded claims do not settle wallets.

### M1.8 World, travel, NPCs, and factions

**Status: Complete (schema v28r1; repository/shared-contract only; no HTTP routes or client/UI)**

Persist a visibility-aware location graph plus campaign NPC personas, private goals, relationships, factions, and reputation.

- **Complexity:** L
- **Dependencies:** M1.1-M1.3; M1.5 for merchant state; existing Velvet character and room participant repositories.
- **Acceptance criteria:**
  - Additive schema and contracts cover location hierarchy and connections, discoveries, actor location, campaign NPC links, private NPC state, relationships, faction membership/relations, and reputation ledgers.
  - Travel validates campaign ancestry, adjacency, route state, discovery, requirements, and selected party membership before one atomic location event.
  - Player projections structurally exclude hidden routes, undiscovered locations, NPC secrets/private goals, unrelated private location state, and GM-only notes at query time. GM projections own those fields.
  - Location and route management, discovery, actor placement, and reputation changes are owner/GM-only. Speaking NPCs use one fictional confirmed Velvet persona that cannot also be a campaign character; speech is manual only, with no AI NPC speech and no path for AI to voice a manually controlled player character.

### M1.9 Quests, storylines, clues, and rewards

Add explicit quest and story graphs whose state advances through commands rather than narration parsing.

- **Complexity:** L
- **Dependencies:** M1.5-M1.8; campaign logs and receipts from M1.1.
- **Acceptance criteria:**
  - Additive schema and contracts represent quest lifecycle, ordered and dependency-based objectives, prerequisites, links, rewards, story nodes and edges, plot questions, clue sources, discovery scope, and reveal thresholds.
  - Repository commands enforce objective dependencies, valid state transitions, same-campaign graph edges, and exactly-once completion and rewards.
  - Player journal, participant context, and GM studio projections are separately queried so hidden answers, undiscovered clues, misleading-clue truth, and GM notes never enter player data.
  - Summaries and generated narration can cite committed state but cannot directly establish quest, clue, or storyline truth.

### M1.10 Adventure turns, confirmations, and generation drafts

Persist the durable coordination state needed for player declarations, proposed tools, confirmation pauses, committed mechanics, and staged generated campaign content.

- **Complexity:** L
- **Dependencies:** M1.1-M1.9; existing session messages, generation locks, usage ledger, command receipts, and provider runtime ports.
- **Acceptance criteria:**
  - Additive schema and strict types cover adventure turns, bounded tool proposals/calls, confirmation decisions and expiry, provider-call metadata, generation drafts, review decisions, and final receipt links.
  - A turn may wait for a human without holding a SQLite transaction; resume rechecks principal, campaign, active timeline, expected revision, and idempotency before any command commits.
  - Swiped or retried narration reuses committed receipts and cannot reroll, re-spend, reapply damage, or duplicate rewards.
  - Cancellation before commit writes no mechanics; cancellation after commit preserves receipts and supports deterministic fallback narration.

## Milestone 2 — API Surface (Routes + Contracts)

All routes below are gaps under `/api/rpg/v1`; the existing campaign list/create/detail/rename, original and mechanics starter setup, character roster/create/options/workspace, dice history/roll, room list/attach, and feature discovery operations remain compatible. Each new request and response receives a strict runtime schema in `packages/contracts/src/`, opaque IDs are path-encoded once, mutable responses include revisions, retry-sensitive writes require `idempotencyKey`, and role-specific response schemas omit unauthorized fields structurally.

### M2.1 Campaign lifecycle and settings routes

Expose lifecycle and settings administration without overloading the current rename contract.

- **Complexity:** M
- **Dependencies:** M1.1; current campaign HTTP contracts and scoped problem handling in `features.ts`.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/administration` returns `{ campaign: { id, status, settings, activeTimelineId, revision, updatedAt } }` for owner/GM projections.
  - `PATCH /campaigns/:campaignId/administration` accepts `{ expectedRevision, idempotencyKey, status?, settings? }` and returns `{ campaign, receipt }`; empty patches and illegal lifecycle transitions reject.
  - `DELETE /campaigns/:campaignId` accepts `{ expectedRevision, idempotencyKey, confirmationName }` and archives rather than physically deleting, returning `{ campaign, receipt }`.
  - Every method rejects caller-supplied identity, unknown fields, unsupported media types, and query parameters unless the contract explicitly names them.

### M2.2 Membership and room-administration routes

Provide owner-controlled membership changes and complete the campaign/session attachment lifecycle.

- **Complexity:** M
- **Dependencies:** M2.1; M1.1 membership and audit repositories; existing `GET`/`PUT /campaigns/:campaignId/rooms`.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/memberships` returns `{ memberships: [{ principalId, role, createdAt }] }`; `POST` accepts `{ principalId, role, expectedRevision, idempotencyKey }` and returns `{ membership, receipt }`.
  - `PATCH /campaigns/:campaignId/memberships/:principalId` accepts `{ role, expectedRevision, idempotencyKey }`; `DELETE` accepts `{ expectedRevision, idempotencyKey }`; both return `{ membership, receipt }` and cannot demote or remove the sole owner.
  - `DELETE /campaigns/:campaignId/rooms/:sessionId` accepts `{ expectedRevision, idempotencyKey }` and returns `{ attachment, receipt }`; stopped sessions can detach and roleplay history remains intact.
  - List projections are role-filtered, all opaque path segments are encoded once, and ambiguous writes require a fresh membership or room GET before another user-authorized attempt.

### M2.3 Timeline, checkpoint, log, and recap routes

Expose canonical history and non-destructive restoration with bounded pagination.

- **Complexity:** M
- **Dependencies:** M2.1; M1.1 timeline, checkpoint, recap, event, and receipt repositories.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/timelines` returns `{ activeTimelineId, timelines: [{ id, parentTimelineId, forkedFromRevision, revision, createdAt }] }`.
  - `GET /campaigns/:campaignId/events?timelineId=&afterRevision=&limit=` returns `{ events, nextAfterRevision }`; `GET /campaigns/:campaignId/commands/:commandId/receipt` returns `{ receipt }` with public structured event data only.
  - `POST /campaigns/:campaignId/checkpoints` accepts `{ timelineId, revision, label, idempotencyKey }`; `GET /campaigns/:campaignId/checkpoints` returns `{ checkpoints }`; `POST /campaigns/:campaignId/timeline-forks` accepts `{ checkpointId, expectedRevision, idempotencyKey }` and returns `{ timeline, receipt }`.
  - `POST /campaigns/:campaignId/recaps` accepts `{ timelineId, throughRevision, selectedSessionIds, idempotencyKey }` and returns `{ recap }`; `GET /campaigns/:campaignId/recaps` returns bounded metadata and text permitted to the requesting role.

### M2.4 Campaign import and export routes

Make transfer packages reviewable, versioned, and safe for local files without accepting filesystem paths.

- **Complexity:** L
- **Dependencies:** M2.1-M2.3; M1.1 import/export repository support.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/export?includeMessages=true|false` returns a download with `{ formatVersion, exportedAt, campaign, timelines, contentPins, records }` and no provider secrets, usage prices/history, or local paths.
  - `POST /campaign-imports` accepts `{ package, mode: "dry-run" }` and returns `{ importId, report: { valid, conflicts, missingReferences, warnings, counts } }` without writes to campaign state.
  - `POST /campaign-imports/:importId/apply` accepts `{ idempotencyKey, conflictResolutions }` and returns `{ campaign, receipt }` only for an unchanged valid dry-run record.
  - Size, nesting, record-count, Unicode, ID, and schema-version limits are enforced before apply; malformed or stale imports leave no partial rows.

### M2.5 Content catalog and publication routes

Expose validated immutable catalogs and exact campaign pin selection.

- **Complexity:** M
- **Dependencies:** M1.2; M2.1 authorization and revision conventions.
- **Acceptance criteria:**
  - `GET /content-packs?status=&cursor=&limit=` returns `{ packs, nextCursor }`; `GET /content-packs/:packId/versions/:packVersion` returns `{ pack, definitions }` with role-safe metadata.
  - `POST /content-pack-validations` accepts `{ manifest, definitions }` and returns `{ valid, issues, normalizedSummary }` without persistence.
  - `POST /content-packs` accepts `{ manifest, definitions, idempotencyKey }` and returns `201 { pack }` only after complete validation and atomic sealing; an existing different exact version conflicts.
  - `PUT /campaigns/:campaignId/content` accepts `{ rulesProfileId, contentPacks, expectedRevision, idempotencyKey }` and returns `{ content, receipt }`; only sealed compatible exact versions can be pinned.

### M2.6 Character builder and progression routes

Provide general draft construction and atomic advancement alongside the current starter-character convenience route.

- **Complexity:** L
- **Dependencies:** M1.3-M1.4; M2.5 content lookup.
- **Acceptance criteria:**
  - `POST /campaigns/:campaignId/character-drafts` accepts `{ personaId, allocationMethod, idempotencyKey }` and returns `201 { draft, options, derivedPreview }`; `GET /character-drafts/:draftId` returns the same shape; `PATCH /character-drafts/:draftId` accepts `{ expectedRevision, selections }` and returns the updated shape.
  - `POST /campaigns/:campaignId/character-drafts/:draftId/finalize` accepts `{ expectedRevision, idempotencyKey }` and returns `201 { character, sheet, resources, receipt }` only when every required choice is valid.
  - `GET /characters/:campaignCharacterId/sheet` returns `{ sheet, derived, progression }`; `POST /characters/:campaignCharacterId/xp-commands` accepts `{ amount, reason, expectedRevision, idempotencyKey }` and returns `{ progression, receipt }`.
  - `GET /characters/:campaignCharacterId/level-up-preview` returns `{ levels, choices, changes }`; `POST /characters/:campaignCharacterId/level-up-commands` accepts `{ previewRevision, choices, idempotencyKey }` and returns `{ sheet, progression, receipt }` atomically.

### M2.7 Resource, inventory, economy, and rest routes

Expose authoritative actor state and command receipts for common non-combat mechanics.

- **Complexity:** L
- **Dependencies:** M1.5; M2.6 playable actors.
- **Acceptance criteria:**
  - `GET /actors/:actorId/resources` returns `{ resources, revision }`; `POST /actors/:actorId/resource-commands` accepts `{ kind, amount, resourceName, expectedRevision, idempotencyKey }` and returns `{ resources, receipt }`.
  - `GET /actors/:actorId/inventory` returns `{ entries, equipment, capacity, revision }`; `POST /actors/:actorId/inventory-commands` accepts a discriminated `{ kind: "equip"|"unequip"|"consume"|"drop"|"gift", ...targets, expectedRevision, idempotencyKey }` and returns `{ inventory, receipt }`.
  - `GET /campaigns/:campaignId/shops/:shopId` returns `{ shop, stock, currencies }`; `POST /shops/:shopId/quotes` accepts `{ actorId, lines }` and returns `{ quoteId, expiresAt, totals }`; `POST /shops/:shopId/purchase-commands` accepts `{ quoteId, expectedRevision, idempotencyKey }` and returns `{ wallet, inventory, stock, receipt }`.
  - `POST /campaigns/:campaignId/trades` creates `{ trade }`; `POST /trades/:tradeId/accept-commands` settles `{ trade, actorStates, receipt }`; `POST /actors/:actorId/rest-commands` accepts `{ kind: "short"|"long", expectedRevision, idempotencyKey }` and returns `{ actorState, receipt }`.

### M2.8 Check, power, and effect routes

Expose deterministic resolution without allowing clients to supply authoritative modifiers or outcomes.

- **Complexity:** L
- **Dependencies:** M1.6; M2.7 actor resources.
- **Acceptance criteria:**
  - `POST /actors/:actorId/check-commands` accepts `{ kind, skillOrAttribute, targetActorId?, difficultyRef?, expectedRevision, idempotencyKey }` and returns `{ check: { terms, modifier, total, target, outcome }, receipt }` without a caller-supplied modifier or total.
  - `GET /actors/:actorId/powers` returns `{ known, prepared, slots, uses, legalNow, revision }`; `POST /actors/:actorId/power-commands` accepts `{ powerRef, targetIds, choices, expectedRevision, idempotencyKey }` and returns `{ resolution, actorStates, receipt }`.
  - `GET /actors/:actorId/effects` returns `{ effects, concentration, revision }`; `POST /actors/:actorId/effect-commands` accepts a GM-authorized discriminated apply/remove/advance-duration command and returns `{ effects, receipt }`.
  - Responses expose typed source, duration, stacking, modifiers, and state deltas; hidden enemy details and private DC sources are omitted from player projections.

### M2.9 Encounter and combat routes

Provide encounter preparation, legal turn actions, and an append-only combat log.

- **Complexity:** L
- **Dependencies:** M1.7; M2.8 checks, powers, and effects.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/encounters` returns `{ encounters }`; `POST /campaigns/:campaignId/encounters` accepts `{ sessionId, name, combatants, idempotencyKey }` and returns `201 { encounter }`; `POST /encounters/:encounterId/start-commands` accepts `{ expectedRevision, idempotencyKey }` and returns `{ combat, receipt }`.
  - `GET /combats/:combatId` returns `{ round, currentCombatant, combatants, legalActions, revision }`; `GET /combats/:combatId/log?afterSequence=&limit=` returns `{ entries, nextAfterSequence }`.
  - `POST /combats/:combatId/action-commands` accepts `{ legalActionId, targetIds, choices, expectedRevision, idempotencyKey }` and returns `{ resolution, combat, receipt }`; callers cannot submit arbitrary damage, DCs, or turn order.
  - `POST /combats/:combatId/end-commands` accepts `{ expectedRevision, idempotencyKey }` and returns `{ encounter, rewards, receipt }`, with reconnects unable to repeat actions or rewards.

### M2.10 World, NPC, faction, quest, and story routes

Expose separate player and GM projections for campaign world and narrative state.

- **Complexity:** L
- **Dependencies:** M1.8-M1.9; M2.7 economy and M2.9 encounters.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/world` returns `{ currentLocations, visibleLocations, visibleConnections }`; `POST /actors/:actorId/travel-commands` accepts `{ connectionId, partyActorIds, expectedRevision, idempotencyKey }` and returns `{ locations, discoveries, receipt }`.
  - `GET /campaigns/:campaignId/npcs` returns `{ npcs, relationships }`; `POST /campaigns/:campaignId/npcs` accepts `{ personaId, publicState, privateState, expectedRevision, idempotencyKey }` and returns `201 { npc, receipt }`; `POST /npcs/:npcId/relationship-commands` accepts `{ subjectActorId, affinityDelta, trustDelta, fearDelta, reason, expectedRevision, idempotencyKey }` and returns `{ relationship, receipt }`.
  - `GET /campaigns/:campaignId/factions` returns `{ factions, standings }`; `POST /campaigns/:campaignId/factions` accepts `{ name, publicState, privateState, expectedRevision, idempotencyKey }` and returns `201 { faction, receipt }`; `POST /factions/:factionId/reputation-commands` accepts `{ subjectActorId, delta, reason, expectedRevision, idempotencyKey }` and returns `{ standing, receipt }`.
  - `GET /campaigns/:campaignId/quests` returns `{ quests, objectives, journal }`; `POST /campaigns/:campaignId/quests` accepts `{ quest, expectedRevision, idempotencyKey }` and returns `201 { quest, receipt }`; `POST /quests/:questId/commands` accepts a discriminated `{ kind: "accept"|"advance-objective"|"abandon"|"claim-reward", objectiveId?, expectedRevision, idempotencyKey }` and returns `{ quest, receipt }`.
  - `GET /campaigns/:campaignId/story` returns player-safe `{ visibleNodes, discoveredClues }` or GM `{ storylines, nodes, edges, plotPoints, clues }`; `POST /campaigns/:campaignId/storylines` accepts `{ storyline, expectedRevision, idempotencyKey }` and returns `201 { storyline, receipt }`; `POST /storylines/:storylineId/commands` accepts `{ kind, targetId, data, expectedRevision, idempotencyKey }` and returns `{ story, receipt }`, rejecting cross-story or cross-campaign references.

### M2.11 Adventure turn, confirmation, and generation routes

Add one streaming turn protocol plus durable confirmation and reviewable generation resources.

- **Complexity:** L
- **Dependencies:** M1.10; all command routes M2.7-M2.10; existing roleplay SSE and request/problem infrastructure.
- **Acceptance criteria:**
  - `POST /adventure-turns/stream` accepts `{ campaignId, sessionId, actorId, declaration, expectedRevision, idempotencyKey }` and streams `turn_started`, `agent_status`, `tool_proposed`, `confirmation_required`, `mechanics_committed`, `narration_delta`, `choice`, and terminal events with validated payloads.
  - `GET /adventure-turns/:turnId` returns `{ turn, proposals, confirmation, receipts, narrationStatus }`; `POST /adventure-turns/:turnId/confirm` accepts `{ proposalIds, decision: "approve"|"reject", expectedRevision, idempotencyKey }` and returns `{ turn }` or resumes the stream through a separately issued resume token.
  - `POST /generation-drafts` accepts `{ campaignId, kind, brief, constraints, idempotencyKey }`; `GET /generation-drafts/:draftId` returns staged content and validation issues; `POST /generation-drafts/:draftId/apply` accepts `{ selectedChanges, expectedRevision, idempotencyKey }` and returns `{ draft, receipts }`.
  - SSE disconnect, process restart, and duplicate confirmation requests preserve durable state; a committed turn always exposes receipts even if narration delivery fails.

## Milestone 3 — Client UI

### M3.1 Campaign Administration Studio

Create `CampaignAdministrationPage`, `CampaignSettingsForm`, `MembershipManager`, and `TimelineCheckpointPanel` for lifecycle, roles, policies, and forks.

- **Complexity:** L
- **Dependencies:** M2.1-M2.4.
- **Acceptance criteria:**
  - Owners can publish, pause, archive, edit settings, administer non-owner roles, create checkpoints, fork a timeline, and inspect import reports with explicit confirmation and receipt-backed success.
  - GM/player/observer users see only permitted controls and projections; secrets and disabled operations are absent rather than cosmetically hidden.
  - Every uncertain mutation blocks duplicate submission and offers an authoritative refresh without automatic write retry.

### M3.2 Content Pack Studio

Create `ContentPackLibraryPage`, `ContentPackEditor`, `PackValidationReport`, and `CampaignContentPicker` for local pack review, publication, and exact pinning.

- **Complexity:** L
- **Dependencies:** M2.5; M3.1 campaign settings shell.
- **Acceptance criteria:**
  - Users can inspect definitions by kind, run validation before publication, navigate issues to fields, and see that publication makes an exact version immutable.
  - Campaign owners can compare compatible sealed versions and review all pin changes before applying them.
  - The interface never accepts server filesystem paths and clearly distinguishes editable local drafts from sealed versions.

### M3.3 Character Builder and Advancement Flow

Create `CharacterBuilderPage`, `AttributeAllocator`, `ChoiceGroupEditor`, `DerivedStatsReview`, and `LevelUpWizard` for draft-to-play and progression.

- **Complexity:** L
- **Dependencies:** M2.6; M3.2 content presentation.
- **Acceptance criteria:**
  - Drafts autosave with visible revision state, incomplete required choices are focus-linked, and finalization presents server-derived stats and exact starter grants before confirmation.
  - `LevelUpWizard` displays every crossed level, required choices, and server-calculated changes, then applies them once or leaves the sheet unchanged.
  - Persona editing remains a separate navigation target from mechanical sheet editing.

### M3.4 Character Sheet, Inventory, and Economy

Create `RpgCharacterSheetPage`, `ResourceTrackers`, `InventoryPanel`, `EquipmentSlots`, `ShopBrowser`, `TradeReviewDialog`, and `RestDialog`.

- **Complexity:** L
- **Dependencies:** M2.7; M3.3 playable characters.
- **Acceptance criteria:**
  - The sheet displays server values for resources, skills, saves, defenses, conditions, capacity, equipment, wallets, and recovery without client-side authoritative calculations.
  - Equip, consume, purchase, gift, trade, and rest flows show predicted costs, require confirmation where policy demands it, and render returned receipts and fresh state.
  - Currency uses integer-minor-unit formatting, scarce stock and binding restrictions are announced accessibly, and ambiguous writes are never replayed automatically.

### M3.5 Powers and Combat Workspace

Create `PowerLibraryPanel`, `EffectList`, `CombatTrackerPage`, `InitiativeRail`, `LegalActionTray`, and `CombatLog`.

- **Complexity:** L
- **Dependencies:** M2.8-M2.9; M3.4 resources and inventory.
- **Acceptance criteria:**
  - Players can choose only server-returned legal powers/actions and valid targets; costs, slots, concentration, and likely consequences are reviewed before submission.
  - The tracker identifies round and current turn, displays structured roll/damage/effect receipts, and refreshes safely after reconnect without repeating an action.
  - Mobile uses a full-screen combat layout with a bottom action tray, while keyboard users can operate a list equivalent to the initiative rail.

### M3.6 World, Cast, and Journal Studio

Create `WorldExplorerPage`, `LocationTree`, `TravelDialog`, `NpcRosterPage`, `FactionStandingPanel`, `QuestJournalPage`, and `StoryStudioPage`.

- **Complexity:** L
- **Dependencies:** M2.10; M3.1 role-aware studio shell.
- **Acceptance criteria:**
  - Players can browse known locations and exits, travel through eligible routes, inspect visible NPC/faction standing, and track objectives and discovered clues.
  - GMs can edit the corresponding private records in separately authorized views and preview the player projection before saving.
  - Every graph has a keyboard-operable tree/list, hidden nodes are absent from player payloads, and state updates are receipt-backed.

### M3.7 Campaign Play Shell and mechanic receipts

Create `CampaignPlayPage`, `CampaignContextDrawer`, `MechanicReceiptCard`, `ConfirmationBanner`, and `AdventureActionComposer` around the existing chat experience.

- **Complexity:** L
- **Dependencies:** M2.11; M3.4-M3.6 gameplay views; existing session chat and room-opening behavior in `App.tsx`.
- **Acceptance criteria:**
  - Chat remains central while the drawer shows current location, exits, present NPCs, active objectives, party resources, and encounter status from role-filtered APIs.
  - AI suggestions, pending confirmations, committed mechanics, and narration have distinct visual and screen-reader labels; receipt cards show rolls, modifiers, targets, outcomes, and state deltas.
  - Reloading or swiping narration preserves receipt identity and never implies that mechanics were rerun; committed turns remain inspectable when streaming narration fails.

### M3.8 Event Log, recap, import, and export experience

Create `CampaignEventLogPage`, `RecapViewer`, `CheckpointTimeline`, `CampaignImportWizard`, and `CampaignExportDialog`.

- **Complexity:** M
- **Dependencies:** M2.3-M2.4; M3.1 administration navigation.
- **Acceptance criteria:**
  - Users can page through structured events, open public receipts, read role-safe recaps, and understand that checkpoint restore creates a fork rather than erasing history.
  - Import always presents a dry-run conflict/reference report before apply, and export lists included and excluded data before download.
  - Loading, empty, stale, partial-failure, and retry states preserve focus, do not expose technical IDs in ordinary labels, and meet WCAG 2.2 AA targets.

## Milestone 4 — AI-Driven RPG Integration

### M4.1 Campaign-aware context assembly

Extend the existing context basket with bounded, role-filtered campaign mechanics, world, cast, quest, recap, and legal-action sections.

- **Complexity:** L
- **Dependencies:** M1.8-M1.10; M2.7-M2.11; existing `server/src/context.ts`, `prompt.ts`, and `promptTemplates.ts`.
- **Acceptance criteria:**
  - Context precedence follows safety and control, human canon, committed mechanics, declaration, visible normalized state, approved memories/lore, summaries, then generated suggestions.
  - Independent budgets limit world, mechanics, quests, recap, lore, and memory; full catalogs, inventories, enemy secrets, and story graphs are not dumped into prompts.
  - Player, DM, NPC, companion, and enemy contexts have explicit projection tests proving private and hidden fields cannot cross roles.

### M4.2 Bounded tool loop and deterministic command bridge

Implement a server-selected tool registry and bounded decision loop that can propose only authorized reads and command-service calls.

- **Complexity:** L
- **Dependencies:** M4.1; all deterministic repositories and command routes from Milestones 1-2.
- **Acceptance criteria:**
  - Tool availability is selected by agent role, campaign role, actor control, encounter phase, and current legal actions; arbitrary SQL, filesystem, network, policy, prompt, permission, deletion, and memory-approval tools do not exist.
  - A turn is capped at 5 decision rounds, 12 tool calls, 4 mutations, 7 provider calls, and 90 seconds, with lower configurable limits permitted.
  - Every mutation passes through the same revision-checked, idempotent command service used by HTTP/UI, and provider failure cannot bypass validation or leave an enemy turn permanently blocked.

### M4.3 Durable confirmation and resume

Pause consequential AI proposals for human review and resume from persisted state after disconnect or restart.

- **Complexity:** L
- **Dependencies:** M4.2; M1.10 and M2.11 durable turn/confirmation resources; `ConfirmationBanner` from M3.7.
- **Acceptance criteria:**
  - Currency transfer, important-item loss, ambiguous limited-resource use, companion changes, ambiguous combat start, generated world changes, and deterministic GM overrides require confirmation by policy.
  - Confirmation stores proposal identity, exact parameters, authorizing principal, decision, expiry, and observed revision without holding an open database transaction.
  - Duplicate decisions converge, stale revisions require replanning, rejection commits no proposed mechanic, and approved commands remain attributable through receipts.

### M4.4 Receipt-aware narration and narrative consequence injection

Generate final narration only after mechanics commit, injecting immutable receipts and bounded narrative consequences without granting mutation tools.

- **Complexity:** L
- **Dependencies:** M4.2-M4.3; receipt UI from M3.7.
- **Acceptance criteria:**
  - Final narration receives public facts, state deltas, roll outcomes, and narration hints from committed receipts and cannot contradict totals, HP, ownership, prices, rewards, permissions, or actor control.
  - Narrative consequence injection may alter tone, sensory detail, NPC reaction suggestions, and decision framing, but authoritative relationship, quest, location, effect, and reward changes require later explicit commands.
  - Swipes reuse the same receipts, provider failure yields a deterministic receipt renderer, and post-commit cancellation records narration status without undoing mechanics.

### M4.5 LLM encounter generation

Create staged encounter drafts from campaign-aware constraints, then validate and require review before adding them to play.

- **Complexity:** L
- **Dependencies:** M4.1-M4.3; content definitions from M1.2 and encounter repository from M1.7.
- **Acceptance criteria:**
  - Generation inputs include party capability summary, visible location, campaign tone, pinned enemy definitions, difficulty policy, and explicit exclusions within fixed budgets.
  - Output is a typed draft of combatants, terrain prose, motives, rewards, and validation findings; unknown references, impossible budgets, hidden-data leakage, and unsupported mechanics reject.
  - Applying selected draft changes requires GM confirmation and deterministic commands; ordinary adventure turns cannot publish or silently activate generated encounters.

### M4.6 NPC stat derivation and campaign-content generation

Derive playable NPC mechanics from approved narrative briefs and support staged NPC, location, faction, quest, and opening drafts.

- **Complexity:** L
- **Dependencies:** M4.1-M4.5; world/story repositories from M1.8-M1.9; generation drafts from M1.10.
- **Acceptance criteria:**
  - NPC stat derivation selects pinned templates and bounded deterministic adjustments, with the server recomputing all derived values and rejecting unsupported powers or effect references.
  - Generated personas, goals, secrets, relationships, locations, factions, quests, clues, and openings remain typed drafts with provenance, validation, role-safe previews, and per-change approval.
  - Applying a draft emits command receipts; generated prose cannot directly mutate campaign state, create permissions, voice player characters, or expose hidden information.

## Out of Scope / Deferred

### D1 Alternate state and combat models

Defer mechanics that multiply authoritative state models until the single canonical timeline and ordinary encounter loop are stable.

- **Complexity:** L
- **Dependencies:** Demonstrated stability and migration strategy after M1.7, M1.10, and M4.4.
- **Acceptance criteria:**
  - Branch-local simulation, boss phases, tactical grids/line-of-sight (LOS), and simultaneous encounters remain absent from schemas, contracts, repositories, routes, tools, and UI in these milestones.
  - Message branches continue to reuse committed receipts; campaign correction uses compensating commands or timeline forks, and one active encounter per campaign session remains the rule.

### D2 Advanced rules extensibility

Defer rule execution that would undermine the initial typed, testable mechanics boundary.

- **Complexity:** L
- **Dependencies:** Stable single-class advancement, typed starter effects, and published-pack compatibility evidence after M1.2, M1.4, and M1.6.
- **Acceptance criteria:**
  - Multiclass execution until stable, executable user rules, a fully system-neutral effects DSL, and mutable published packs remain unsupported.
  - Schemas may preserve future-compatible identities where already designed, but no client or AI path can execute these capabilities, and sealed pack versions remain immutable.

### D3 External ingestion and remote identity

Defer optional reference-data migration and network identity until provenance and a real security boundary are separately approved.

- **Complexity:** L
- **Dependencies:** License/format review for the optional reference importer; a dedicated authentication, authorization, transport-security, and deployment project for remote access.
- **Acceptance criteria:**
  - The optional reference importer is not shipped unless provenance, format, and clean-room transformation are reviewed; normal campaign package import remains limited to the versioned Velvet format from M2.4.
  - Remote auth stays deferred: fixed `local-owner` remains trusted-local convenience only, binds to loopback, ignores caller identity headers, and is never described as safe for remote or multi-user exposure.

### D4 Autonomous and third-party play surfaces

Defer unattended play and external chat/tabletop adapters so all initial consequential actions retain direct human oversight.

- **Complexity:** L
- **Dependencies:** Separate product, privacy, authorization, rate-limit, and adapter reliability designs after M4 completes.
- **Acceptance criteria:**
  - Autonomous parties, Discord, and VTT integrations remain absent from runtime dependencies, routes, agent roles, and client navigation.
  - No external service can initiate turns, approve confirmations, control player characters, or receive campaign-private context through the roadmap surface.

### D5 Fairness extensions and proactive automation

Defer stronger randomness guarantees and unsolicited agent activity beyond explicit user-driven turns.

- **Complexity:** M
- **Dependencies:** A separately reviewed randomness threat model and opt-in background-agent policy after deterministic local mechanics and durable turns are stable.
- **Acceptance criteria:**
  - Cryptographic dice and proactive nudges remain absent; production continues to use the bounded injectable RNG contract, and deterministic tests continue to inject controlled randomness.
  - Agents run only within explicit bounded requests or durable confirmed resumes and cannot autonomously schedule messages, mechanics, spending, travel, or encounters.
