# VelvetRP RPG Feature Roadmap

This roadmap turns the completed gap analysis in [the RPG integration plan](rpg-integration-plan.md) and [the 2026 architecture notes](roleplay-architecture-2026.md) into dependency-ordered work. Current persistence is schema v42r1, with repository modules under `server/src/repo/`, shared runtime contracts under `packages/contracts/src/`, and the trusted-local RPG surface implemented through M2.11 and the completed M4 integration work under `server/src/routes/rpg/v1/`.

All milestones preserve existing roleplay APIs and local-first SQLite operation. Until a separate remote-authentication project supplies verified principals and authorization, RPG HTTP handlers must continue to use the fixed trusted-local `local-owner` principal, bind only to loopback, and must not be represented as safe for remote or multi-user deployment. Mutations use revisions, idempotency keys, atomic repository transactions, structured problems, and authoritative-read reconciliation when delivery leaves commit status unknown.

M1.1-M1.10, trusted-local HTTP milestones M2.1-M2.11, client milestones M3.1-M3.8, and M4.1-M4.6 are complete. Earlier schema digests and milestone baseline descriptions remain historical records in the sections below.

## Approved post-M4 milestone DAG and status

Planning-board revision 2 (saved 2026-08-11T00:47:24.296Z, ready with no blockers) is approved. The [revision 2 integration plan](revision-2-integration-plan.md) is the authoritative actionable execution design subordinate to this roadmap's scope and status. Its dependency order is:

```text
H0.1 migration support ─┐
H0.2 E2E repairs ───────┼─> H0.4 health gate
H0.3 docs reconciliation┘
After H0.4, parallel tracks are:
  M5.1 NPC presence -> M5.2 companion core/local-owner administration
  M5.3 atomic combat
  M5.4 candidate protocol contract/persistence
  M5.5 threat-model checkpoint -> commit-reveal dice
M5.6 adapters use per-family dependencies: existing commands+candidates for travel/rest and
out-of-combat power/inventory; atomic combat for combat powers/items; companion authority plus
exercisable L5 principals/grants for companion actions; dice only for proof-required randomness.
Later: rules/simulation use only relevant mechanics; remote identity -> harness -> proactive automation.
```

### Build now — H0 repository health

- **H0.1 Complete:** executable supported migration coverage is canonical populated v40/v41->v42, with the historical test archive retained and discoverable. The archive does not claim v2-v39 support; startup preflight rejects persisted foreign-key corruption, unexpected v42 named artifacts, and cross-campaign generation-draft ancestry before marker or artifact mutation.
- **H0.2 Complete:** the original six failures were four finalization call sites in `e2e/tests/app.spec.ts` expecting `200` versus authoritative `201`, one attached unconfigured room expecting legacy chat/back but routing to play under feature-only routing, and one storyline/quest setup expecting creation while story `POST` returned `400` under the strict graph contract. Repairs preserve the public `201` contract with an E2E-only authorized actor resolver, gate play routing on configured status with cancellation/error handling, and use the current strict story/quest workflow with idempotent replay. The old supplied aggregate had drifted: M2.5 passed and the current full deterministic suite includes 12 cases. Validation passed: client focused 3 files/113 tests plus client typecheck; server fixture/M1.5 2 files/17 tests plus server typecheck; `typecheck:e2e`; full deterministic E2E 12 passed; `git diff --check`. Commits: `ee7dfba fix(client): preserve authoritative campaign navigation`; `60afa5f test(e2e): align authoritative RPG workflows`.
- **H0.3 Complete:** active documentation now describes v42r1, completed M4.1-M4.6, 95 current trusted-local RPG HTTP operations versus the historical 92-operation M2.11 baseline, and supported canonical populated v40/v41->v42 startup upgrades. Historical schema, operation, and milestone ledgers remain preserved and visibly distinct from current implementation, Planned, Unscheduled, deferred, and excluded status. Commits: `77ed4b0 docs: reconcile current RPG guidance`; `2a50a41 docs: qualify historical RPG baselines`; docs/status commit remains pending.
- **H0.4 Planned (next):** establish root `npm run health` as exactly `npm run typecheck && npm run build && npm test && npm run test:e2e`; migration-support tests are discovered by `npm test`, milestone-focused migration/security gates are not duplicated, and CI calls health once or mirrors those four phases once.

### Build next — M5

- **M5.1-M5.6 Planned:** session NPC presence; companion aggregate, closed grants, repository authority, and local-owner owner/GM administration (not pre-auth non-owner HTTP exercise); composition-owned atomic combat power/item settlement; persisted exact reviewable candidates/quotes and policy metadata; commit-reveal dice after its threat checkpoint; and agent mechanics one family at a time behind exact domain dependencies. Delegated grantee exercise and principal-specific UI/E2E wait for remote identity/grants. Single active encounter remains mandatory.
- Only the first persistence milestone has provisional schema allocation v43r1. Every later persistence milestone receives `vNext` from the schema steward at milestone start; each version moves the tested current-minus-two support window.

### Build later

- **Planned:** closed declarative rules IR; explicitly licensed offline reference ingestion; non-promotable ephemeral branch-local simulation; campaign tenancy and server-derived authenticated session metadata; bounded harness session overrides; allowlisted tools and proactive policy grants with visible receipts.
- Reference ingestion remains blocked until Unscheduled mutable authoring is promoted and delivered, unless a separately reviewed immutable-draft-only ingestion path is approved. This dependency does not promote ingestion.
- Remote identity/tenancy precedes remote multi-user harness semantics, proactive automation, and autonomous work. OIDC PKCE/server sessions are a recommended implementation detail subject to threat-model approval, not a caller-header identity scheme.

### Approved Build Unscheduled

- **Unscheduled:** append-only multiclass levels/prerequisites; mutable logical unpinned pack authoring that creates immutable revisions while exact pins/history never mutate; zones/range bands before full grids; explicit boss phase state; autonomous parties with revocable scoped grants. Promotion gates, full milestone fields, and `vNext`-only-at-promotion policy are defined in the detailed plan.

### Still deferred or excluded

- The three product deferrals are Discord, VTT adapters, and simultaneous encounters. Bilateral agent trade has no path without counterpart consent. Full grids/LOS, arbitrary executable rules, URL/network reference ingestion, in-place mutation of pinned history, and promotable/persistent simulation are excluded.

## Milestone 1 — Core RPG Mechanics (Schema + Repo layer)

### M1.1 Campaign administration, membership, and timelines

**Status: Complete (repository/shared-contract only)**

Extend the existing campaign foundation with lifecycle state, settings, membership administration, canonical checkpoints, non-destructive timeline forks, recaps, command logs, and versioned import/export records.

- **Complexity:** L
- **Dependencies:** Existing v9-v14 campaign, membership, timeline, event, receipt, and room-attachment tables; `campaignRepositoryOrchestration.ts`; shared campaign contracts.
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

**Status: Complete (schema v25r1; at M1 completion, repository/shared-contract only with no HTTP routes or client/UI)**

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

**Status: Complete (schema v27r1; at M1 completion, repository/shared-contract only with no HTTP routes or client/UI)**

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

**Status: Complete (schema v28r1; at M1 completion, repository/shared-contract only with no HTTP routes or client/UI)**

Persist a visibility-aware location graph plus campaign NPC personas, private goals, relationships, factions, and reputation.

- **Complexity:** L
- **Dependencies:** M1.1-M1.3; M1.5 for merchant state; existing Velvet character and room participant repositories.
- **Acceptance criteria:**
  - Additive schema and contracts cover location hierarchy and connections, discoveries, actor location, campaign NPC links, private NPC state, relationships, faction membership/relations, and reputation ledgers.
  - Travel validates campaign ancestry, adjacency, route state, discovery, requirements, and selected party membership before one atomic location event.
  - Player projections structurally exclude hidden routes, undiscovered locations, NPC secrets/private goals, unrelated private location state, and GM-only notes at query time. GM projections own those fields.
  - Location and route management, discovery, actor placement, and reputation changes are owner/GM-only. Speaking NPCs use one fictional confirmed Velvet persona that cannot also be a campaign character; speech is manual only, with no AI NPC speech and no path for AI to voice a manually controlled player character.

### M1.9 Quests, storylines, clues, and rewards

**Status: Complete (schema v29r2; at M1 completion, repository/shared-contract only with no HTTP routes or client/UI)**

Add explicit quest and story graphs whose state advances through commands rather than narration parsing.

- **Complexity:** L
- **Dependencies:** M1.5-M1.8; campaign logs and receipts from M1.1.
- **Acceptance criteria:**
  - Additive schema and contracts represent quest lifecycle, ordered and dependency-based objectives, prerequisites, links, rewards, story nodes and edges, plot questions, clue sources, discovery scope, and reveal thresholds.
  - Repository commands enforce objective dependencies, valid state transitions, same-campaign graph edges, and exactly-once completion and rewards.
  - Player journal, participant context, and GM studio projections are separately queried so hidden answers, undiscovered clues, misleading-clue truth, and GM notes never enter player data.
  - Summaries and generated narration can cite committed state but cannot directly establish quest, clue, or storyline truth.

### M1.10 Adventure turns, confirmations, and generation drafts

**Status: Complete (schema v37r1; repository/shared-contract only)**

Persist the durable coordination state needed for player declarations, proposed tools, confirmation pauses, committed mechanics, and staged generated campaign content.

- **Complexity:** L
- **Dependencies:** M1.1-M1.9; existing session messages, generation locks, usage ledger, command receipts, and provider runtime ports.
- **Acceptance criteria:**
  - Additive schema and strict types cover adventure turns, bounded tool proposals/calls, confirmation decisions and expiry, provider-call metadata, generation drafts, review decisions, and final receipt links.
  - A turn may wait for a human without holding a SQLite transaction; resume rechecks principal, campaign, active timeline, expected revision, and idempotency before any command commits.
  - Swiped or retried narration reuses committed receipts and cannot reroll, re-spend, reapply damage, or duplicate rewards.
  - Cancellation before commit writes no mechanics; cancellation after commit preserves receipts and supports deterministic fallback narration.

#### Implementation notes

Schema v35 provides the durable adventure-turn and generation-draft foundation, v36 adds coordination and provenance hardening, and v37 binds each proposal to its exact server-owned mechanics execution. Human waits hold no SQLite transaction; resume can reconcile source-turn mechanics receipts exposed by a crash before narration without rerunning the command.

## Milestone 2 — API Surface (Routes + Contracts)

**Progress: M2.1-M2.11 complete as trusted-local HTTP routes; M4.1-M4.6 are complete.**

All routes below are delivered under `/api/rpg/v1`; the existing campaign list/create/detail/rename, original and mechanics starter setup, character roster/create/options/workspace, dice history/roll, room list/attach, and feature discovery operations remain compatible. Each request and response has a strict runtime schema in `packages/contracts/src/`, opaque IDs are path-encoded once, mutable responses include revisions, retry-sensitive writes require `idempotencyKey`, and role-specific response schemas omit unauthorized fields structurally.

### M2.1 Campaign lifecycle and settings routes

**Status: Complete (trusted-local HTTP routes)**

Expose lifecycle and settings administration without overloading the current rename contract.

- **Complexity:** M
- **Dependencies:** M1.1; current campaign HTTP contracts and scoped problem handling in `features.ts`.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/administration` returns `{ campaign: { id, status, activeTimelineId, revision, updatedAt, actorRole, settings } }`, discriminated by `actorRole`: owner/GM projections include full settings, while player/observer projections structurally omit GM-only settings.
  - `PATCH /campaigns/:campaignId/administration` accepts `{ expectedRevision, idempotencyKey, status?, settings? }` and returns `{ campaign, receipt }`; empty patches and illegal lifecycle transitions reject.
  - `DELETE /campaigns/:campaignId/administration` accepts `{ expectedRevision, idempotencyKey, confirmationName }` and archives rather than physically deleting, returning `{ campaign, receipt }`.
  - Every method rejects caller-supplied identity, unknown fields, unsupported media types, and query parameters unless the contract explicitly names them.

### M2.2 Membership and room-administration routes

**Status: Complete (trusted-local HTTP routes)**

Provide owner-controlled membership changes and complete the campaign/session attachment lifecycle.

- **Complexity:** M
- **Dependencies:** M2.1; M1.1 membership and audit repositories; existing `GET`/`PUT /campaigns/:campaignId/rooms`.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/memberships` returns `{ memberships: [{ principalId, role, createdAt }] }`; `POST` accepts `{ principalId, role, expectedRevision, idempotencyKey }` and returns `{ membership, receipt }`.
  - `PATCH /campaigns/:campaignId/memberships/:principalId` accepts `{ role, expectedRevision, idempotencyKey }`; `DELETE` accepts `{ expectedRevision, idempotencyKey }`; both return `{ membership, receipt }` and cannot demote or remove the sole owner.
  - `DELETE /campaigns/:campaignId/rooms/:sessionId` accepts `{ expectedRevision, idempotencyKey }` and returns `{ attachment, receipt }`; stopped sessions can detach and roleplay history remains intact.
  - List projections are role-filtered, all opaque path segments are encoded once, and ambiguous writes require a fresh membership or room GET before another user-authorized attempt.

### M2.3 Timeline, checkpoint, log, and recap routes

**Status: Complete (trusted-local HTTP routes)**

Expose canonical history and non-destructive restoration with bounded pagination.

- **Complexity:** M
- **Dependencies:** M2.1; M1.1 timeline, checkpoint, recap, event, and receipt repositories.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/timelines` returns `{ activeTimelineId, timelines: [{ id, parentTimelineId, forkedFromRevision, revision, createdAt, active }] }`.
  - `GET /campaigns/:campaignId/events?timelineId=&afterRevision=&limit=` returns `{ events, nextAfterRevision }`; `GET /campaigns/:campaignId/commands/:commandId/receipt` returns `{ receipt }` with public structured event data only.
  - `POST /campaigns/:campaignId/checkpoints` accepts `{ timelineId, timelineRevision, label, expectedRevision, idempotencyKey }`; `GET /campaigns/:campaignId/checkpoints` returns `{ checkpoints }`; `POST /campaigns/:campaignId/timeline-forks` accepts `{ checkpointId, expectedRevision, idempotencyKey }` and returns `{ timeline, receipt }`.
  - `POST /campaigns/:campaignId/recaps` accepts `{ timelineId, throughRevision, selectedSessionIds, visibility, text, expectedRevision, idempotencyKey }` and returns `{ recap, receipt }`; `GET /campaigns/:campaignId/recaps` returns bounded metadata and text permitted to the requesting role.

### M2.4 Campaign import and export routes

**Status: Complete (trusted-local HTTP routes)**

Make transfer packages reviewable, versioned, and safe for local files without accepting filesystem paths.

- **Complexity:** L
- **Dependencies:** M2.1-M2.3; M1.1 import/export repository support.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/export?includeMessages=true|false` returns a JSON attachment named `<campaignId>-campaign-export-v1.json` with `{ package, messages }`; `package` contains `{ formatVersion, exportedAt, campaign, timelines, activeTimelineSourceId, content, records, excluded }`, and messages are either explicitly excluded or contain the attached-room archive.
  - `POST /campaign-imports` accepts `{ package, mode: "dry-run" }` and returns `{ importId, report: { valid, conflicts, missingReferences, warnings, counts } }` without writes to campaign state.
  - `POST /campaign-imports/:importId/apply` accepts `{ idempotencyKey, conflictResolutions }` and returns `{ campaign, receipt }` only for an unchanged valid dry-run record.
  - Size, nesting, record-count, Unicode, ID, and schema-version limits are enforced before apply; malformed or stale imports leave no partial rows.

### M2.5 Content catalog and publication routes

**Status: Complete (trusted-local HTTP routes)**

Expose validated immutable catalogs and exact campaign pin selection.

- **Complexity:** M
- **Dependencies:** M1.2; M2.1 authorization and revision conventions.
- **Acceptance criteria:**
  - `GET /content-packs?cursor=&limit=` returns `{ publications, nextCursor }`; `GET /content-packs/:packId/versions/:packVersion` returns owner-safe `{ catalog }` with publication, provenance, and definitions.
  - `POST /content-packs/validate` accepts `{ manifest, definitions }` and returns `{ report: { valid, issues, normalizedSummary } }` without persistence.
  - `POST /content-packs` accepts `{ idempotencyKey, manifest, definitions }` and returns `201 { catalog }` only after complete validation and atomic sealing; an existing different exact version conflicts.
  - `GET /campaigns/:campaignId/content` returns `{ content }`; `PUT /campaigns/:campaignId/content` accepts `{ rulesProfileId, contentPacks, expectedRevision, idempotencyKey }` and returns `{ content, receipt }`; `GET /campaigns/:campaignId/content-packs/:packId/versions/:packVersion` returns role-safe `{ catalog }` for an exact campaign pin.

### M2.6 Character builder and progression routes

**Status: Complete (trusted-local HTTP routes)**

Provide general draft construction and atomic advancement alongside the current starter-character convenience route.

- **Complexity:** L
- **Dependencies:** M1.3-M1.4; M2.5 content lookup.
- **Acceptance criteria:**
  - `POST /campaigns/:campaignId/character-drafts` accepts `{ personaId, durability, allocation, idempotencyKey }` and returns `201 { draft, receipt }`; `GET /campaigns/:campaignId/character-drafts/:draftId` returns the strict public draft; `PATCH` on that path accepts `{ expectedRevision, idempotencyKey, selections }` and returns `{ draft, receipt }`.
  - `POST /campaigns/:campaignId/character-drafts/:draftId/finalize` accepts `{ expectedRevision, idempotencyKey }` and returns `201 { character, sheet, resources, receipt }` only when every required choice is valid.
  - `GET /campaigns/:campaignId/characters/:campaignCharacterId/sheet` returns `{ sheet, derived, progression }`; `GET /campaigns/:campaignId/characters/:campaignCharacterId/progression` returns `{ progression }`; `POST /campaigns/:campaignId/characters/:campaignCharacterId/xp-commands` accepts `{ amount, reason, expectedRevision, idempotencyKey }` and returns `{ progression, receipt }`.
  - `POST /campaigns/:campaignId/characters/:campaignCharacterId/progression/preview` accepts `{ selections }` and returns `{ preview }` with `previewRevision` and `previewToken`; `POST /campaigns/:campaignId/characters/:campaignCharacterId/progression/apply` accepts `{ previewRevision, previewToken, selections, idempotencyKey }` and returns `{ progression, receipt }` atomically.

### M2.7 Resource, inventory, economy, and rest routes

**Status: Complete (trusted-local HTTP routes)**

Expose authoritative actor state and command receipts for common non-combat mechanics.

- **Complexity:** L
- **Dependencies:** M1.5; M2.6 playable actors.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/actors/:actorId/resources` returns `{ resources, revision }`; `POST /campaigns/:campaignId/actors/:actorId/resource-commands` accepts `{ kind: "change", resourceName, amount, expectedRevision, idempotencyKey }` and returns `{ resources, receipt }`.
  - `GET /campaigns/:campaignId/actors/:actorId/inventory` returns `{ entries, equipment, capacity, revision }`; `POST /campaigns/:campaignId/actors/:actorId/inventory-commands` accepts a discriminated `{ kind: "equip"|"unequip"|"consume"|"drop"|"gift", ...targets, expectedRevision, idempotencyKey }` and returns `{ inventory: { entries, equipment, capacity, revision }, receipt }`.
  - `GET /campaigns/:campaignId/actors/:actorId/wallet` returns `{ wallet, revision }`; `GET /campaigns/:campaignId/shops/:shopId` returns `{ shop, stock, currencies }`; `POST /campaigns/:campaignId/actors/:actorId/economy-commands` accepts exactly one of `request_purchase_quote`, `purchase_from_shop`, or `propose_bilateral_trade` plus its typed fields, `expectedRevision`, and `idempotencyKey`, returning the matching `{ type, quote|purchase|trade, receipt }` envelope.
  - `POST /campaigns/:campaignId/actors/:actorId/rest-commands` accepts `{ type: "take_short_rest"|"take_long_rest", expectedRevision, idempotencyKey }` and returns `{ actorState: { resources, revision }, receipt }`; all commands remain actor-control checked, revision checked, idempotent, and atomically settled. Ambiguous delivery requires fresh resource, inventory, and wallet reads as applicable; shop GET can refresh stock but cannot prove whether a purchase committed, and there is no automatic replay because the generic receipt route does not cover these commands.

### M2.8 Check, power, and effect routes

**Status: Complete (trusted-local HTTP routes)**

Expose deterministic resolution without allowing clients to supply authoritative modifiers or outcomes.

- **Complexity:** L
- **Dependencies:** M1.6; M2.7 actor resources.
- **Acceptance criteria:**
  - `POST /actors/:actorId/check-commands` accepts `{ kind, skillOrAttribute, targetActorId?, difficultyRef?, expectedRevision, idempotencyKey }` and returns `{ check: { terms, modifier, total, target, outcome }, receipt }` without a caller-supplied modifier or total.
  - `GET /actors/:actorId/powers` returns `{ known, prepared, slots, uses, legalNow, legalCommands, revision }`; `POST /actors/:actorId/power-commands` accepts `{ powerRef, targetIds, choices, expectedRevision, idempotencyKey }` and returns `{ resolution, actorStates, receipt }`.
  - `GET /actors/:actorId/effects` returns `{ effects, concentration, revision }`; `POST /actors/:actorId/effect-commands` accepts a GM-authorized discriminated apply/remove/advance-duration command and returns `{ effects, receipt }`.
  - Responses expose typed source, duration, stacking, modifiers, and state deltas; hidden enemy details and private DC sources are omitted from player projections.

### M2.9 Encounter and combat routes

**Status: Complete (trusted-local HTTP routes)**

Provide encounter preparation, legal turn actions, and an append-only combat log.

- **Complexity:** L
- **Dependencies:** M1.7; M2.8 checks, powers, and effects.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/encounters` returns `{ encounters }`; `POST /campaigns/:campaignId/encounters` accepts `{ sessionId, name, combatants, idempotencyKey }` and returns `201 { encounter }`; `POST /encounters/:encounterId/start-commands` accepts `{ expectedRevision, idempotencyKey }` and returns `{ combat, receipt }`.
  - `GET /combats/:combatId` returns `{ round, currentCombatant, combatants, legalActions, revision }`; `GET /combats/:combatId/log?afterSequence=&limit=` returns `{ entries, nextAfterSequence }`.
  - `POST /combats/:combatId/action-commands` accepts `{ legalActionId, targetIds, choices, expectedRevision, idempotencyKey }` and returns `{ resolution, combat, receipt }`; callers cannot submit arbitrary damage, DCs, or turn order.
  - `POST /combats/:combatId/end-commands` accepts `{ expectedRevision, idempotencyKey }` and returns `{ encounter, rewards, receipt }`, with reconnects unable to repeat actions or rewards.
  - `GET /campaigns/:campaignId/combats/:combatId/command-results/:idempotencyKey` is a read-only reconciliation path returning `{ operation: "action", result: { resolution, combat, receipt } }` or `{ operation: "end", result: { encounter, rewards, receipt } }`; it never executes a command, preserves action-control/end-GM authorization, and a non-disclosing `404` never authorizes automatic replay.

### M2.10 World, NPC, faction, quest, and story routes

**Status: Complete (trusted-local HTTP routes)**

Expose separate player and GM projections for campaign world and narrative state.

- **Complexity:** L
- **Dependencies:** M1.8-M1.9; M2.7 economy and M2.9 encounters.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/world` returns `{ currentLocations, visibleLocations, visibleConnections }`; `POST /actors/:actorId/travel-commands` accepts `{ connectionId, partyActorIds, expectedRevision, idempotencyKey }` and returns `{ locations, discoveries, receipt }`.
  - `GET /campaigns/:campaignId/npcs` returns `{ npcs, relationships }`; `POST /campaigns/:campaignId/npcs` accepts `{ personaId, publicState, privateState, expectedRevision, idempotencyKey }` and returns `201 { npc, receipt }`; `POST /npcs/:npcId/relationship-commands` accepts `{ subjectActorId, affinityDelta, trustDelta, fearDelta, reason, expectedRevision, idempotencyKey }` and returns `{ relationship, receipt }`.
  - `GET /campaigns/:campaignId/factions` returns `{ factions, standings }`; `POST /campaigns/:campaignId/factions` accepts `{ name, publicState, privateState, expectedRevision, idempotencyKey }` and returns `201 { faction, receipt }`; `POST /factions/:factionId/reputation-commands` accepts `{ subjectActorId, delta, reason, expectedRevision, idempotencyKey }` and returns `{ standing, receipt }`.
  - `GET /campaigns/:campaignId/quests` returns `{ quests, objectives, journal }`; `POST /campaigns/:campaignId/quests` accepts `{ quest, expectedRevision, idempotencyKey }` and returns `201 { quest, definition, projection, revision, receipt }`; `POST /quests/:questId/commands` accepts a discriminated `{ kind: "accept"|"advance-objective"|"abandon"|"claim-reward", objectiveId?, actorId?, rewardId?, expectedRevision, idempotencyKey }` and returns `{ quest, receipt }`; `claim-reward` requires both `actorId` and `rewardId`.
  - `GET /campaigns/:campaignId/story` returns player-safe `{ visibleNodes, discoveredClues }` or GM `{ storylines, nodes, edges, plotPoints, clues }`; `POST /campaigns/:campaignId/storylines` accepts `{ storyline, expectedRevision, idempotencyKey }` and returns `201 { storyline, story, receipt }`; `POST /storylines/:storylineId/commands` accepts `{ kind, targetId, data, expectedRevision, idempotencyKey }` and returns `{ story, receipt }`, rejecting cross-story or cross-campaign references.

### M2.11 Adventure turn, confirmation, and generation routes

**Status: Complete (trusted-local HTTP routes)**

Add one streaming turn protocol plus durable confirmation and reviewable generation resources.

- **Complexity:** L
- **Dependencies:** M1.10; all command routes M2.7-M2.10; existing roleplay SSE and request/problem infrastructure.
- **Acceptance criteria:**
  - `GET /campaigns/:campaignId/rooms/:sessionId/play-bootstrap` returns role-safe `{ campaignId, sessionId, expectedRevision, session, principal, playableActors }`, with play eligibility and actor control derived authoritatively from the attached session and fixed local principal.
  - `POST /adventure-turns/stream` accepts an initial `{ campaignId, sessionId, actorId, declaration, expectedRevision, idempotencyKey }`, a narration derivative `{ variant: "narration-retry"|"narration-swipe", campaignId, sessionId, actorId, priorTurnId, expectedRevision, idempotencyKey }`, or `{ resumeToken }`; it returns validated SSE events and identifies the durable turn in `X-Adventure-Turn-Id`.
  - `GET /adventure-turns/reconcile-initial?campaignId=&sessionId=&actorId=&idempotencyKey=` is a read-only initial-turn locator returning `{ result: AdventureTurnGetResponse | null }`; null remains race-ambiguous and never proves non-commit or permits an automatic stream retry.
  - `GET /adventure-turns/:turnId` returns `{ turn, proposals, confirmation, receipts, narrationStatus, resumeToken? }`; `POST /adventure-turns/:turnId/confirm` accepts `{ proposalIds, decision: "approve"|"reject", expectedRevision, idempotencyKey }` and returns `{ turn, resumeToken? }`, with the opaque token used only in the strict stream-resume body.
  - `POST /generation-drafts` accepts `{ campaignId, kind, brief, constraints, idempotencyKey }` and returns `201 { draft, provenance, changes, validationIssues }`; `GET /generation-drafts/:draftId` returns the same staged projection; `POST /generation-drafts/:draftId/apply` accepts `{ selectedChanges, expectedRevision, idempotencyKey }` and returns `{ draft, application, receipts }`.
  - SSE disconnect, process restart, duplicate confirmation, narration retry, and narration swipe preserve durable state and prior receipt identity; resume reconciles crash-visible mechanics before narration without rerunning commands, and a committed turn always exposes receipts even if narration delivery fails.

#### Implementation notes

At M2.11 completion, proposal, confirmation, mechanics, and choice events were conditional because the M4.2 provider-driven tool planner and deterministic command bridge were pending; the no-tool lane used deterministic fallback narration. Generation creation was deterministic fallback, and apply sealed selected review changes only with `campaignDomainMutated: false`. The delivered surface also included a role-safe campaign play bootstrap, read-only initial-turn reconciliation, and narration retry/swipe stream variants that reused prior receipts without rerunning mechanics.

## Milestone 3 — Client UI

### M3.1 Campaign Administration Studio

**Status: Complete (client UI)**

Create `CampaignAdministrationPage`, `CampaignSettingsForm`, `MembershipManager`, and `TimelineCheckpointPanel` for lifecycle, roles, policies, and forks.

- **Complexity:** L
- **Dependencies:** M2.1-M2.4.
- **Acceptance criteria:**
  - Owners can publish, pause, archive, edit settings, administer non-owner roles, create checkpoints, fork a timeline, and inspect import reports with explicit confirmation and receipt-backed success.
  - GM/player/observer users see only permitted controls and projections; secrets and disabled operations are absent rather than cosmetically hidden.
  - Every uncertain mutation blocks duplicate submission and offers an authoritative refresh without automatic write retry.

### M3.2 Content Pack Studio

**Status: Complete (client UI)**

Create `ContentPackLibraryPage`, `ContentPackEditor`, `PackValidationReport`, and `CampaignContentPicker` for local pack review, publication, and exact pinning.

- **Complexity:** L
- **Dependencies:** M2.5; M3.1 campaign settings shell.
- **Acceptance criteria:**
  - Users can inspect definitions by kind, run validation before publication, navigate issues to fields, and see that publication makes an exact version immutable.
  - Campaign owners can compare compatible sealed versions and review all pin changes before applying them.
  - The interface never accepts server filesystem paths and clearly distinguishes editable local drafts from sealed versions.

### M3.3 Character Builder and Advancement Flow

**Status: Complete (client UI)**

Create `CharacterBuilderPage`, `AttributeAllocator`, `ChoiceGroupEditor`, `DerivedStatsReview`, and `LevelUpWizard` for draft-to-play and progression.

- **Complexity:** L
- **Dependencies:** M2.6; M3.2 content presentation.
- **Acceptance criteria:**
  - Drafts autosave with visible revision state, incomplete required choices are focus-linked, and finalization presents server-derived stats and exact starter grants before confirmation.
  - `LevelUpWizard` displays every crossed level, required choices, and server-calculated changes, then applies them once or leaves the sheet unchanged.
  - Persona editing remains a separate navigation target from mechanical sheet editing.

### M3.4 Character Sheet, Inventory, and Economy

**Status: Complete (client UI)**

Create `RpgCharacterSheetPage`, `ResourceTrackers`, `InventoryPanel`, `EquipmentSlots`, `ShopBrowser`, `TradeReviewDialog`, and `RestDialog`.

- **Complexity:** L
- **Dependencies:** M2.7; M3.3 playable characters.
- **Acceptance criteria:**
  - The sheet displays server values for resources, skills, saves, defenses, conditions, capacity, equipment, wallets, and recovery without client-side authoritative calculations.
  - Equip, consume, purchase, gift, trade, and rest flows show predicted costs, require confirmation where policy demands it, and render returned receipts and fresh state.
  - Currency uses integer-minor-unit formatting, scarce stock and binding restrictions are announced accessibly, and ambiguous writes are never replayed automatically.

### M3.5 Powers and Combat Workspace

**Status: Complete (client UI)**

Create `PowerLibraryPanel`, `EffectList`, `CombatTrackerPage`, `InitiativeRail`, `LegalActionTray`, and `CombatLog`.

- **Complexity:** L
- **Dependencies:** M2.8-M2.9; M3.4 resources and inventory.
- **Acceptance criteria:**
  - Players can choose only server-returned legal powers/actions and valid targets; costs, slots, concentration, and likely consequences are reviewed before submission.
  - The tracker identifies round and current turn, displays structured roll/damage/effect receipts, and refreshes safely after reconnect without repeating an action.
  - Mobile uses a full-screen combat layout with a bottom action tray, while keyboard users can operate a list equivalent to the initiative rail.

### M3.6 World, Cast, and Journal Studio

**Status: Complete (client UI)**

Create `WorldExplorerPage`, `LocationTree`, `TravelDialog`, `NpcRosterPage`, `FactionStandingPanel`, `QuestJournalPage`, and `StoryStudioPage`.

- **Complexity:** L
- **Dependencies:** M2.10; M3.1 role-aware studio shell.
- **Acceptance criteria:**
  - Players can browse known locations and exits, travel through eligible routes, inspect visible NPC/faction standing, and track objectives and discovered clues.
  - GMs can edit the corresponding private records in separately authorized views and preview the player projection before saving.
  - Every graph has a keyboard-operable tree/list, hidden nodes are absent from player payloads, and state updates are receipt-backed.

### M3.7 Campaign Play Shell and mechanic receipts

**Status: Complete (client UI)**

Create `CampaignPlayPage`, `CampaignContextDrawer`, `MechanicReceiptCard`, `ConfirmationBanner`, and `AdventureActionComposer` around the existing chat experience.

- **Complexity:** L
- **Dependencies:** M2.11; M3.4-M3.6 gameplay views; existing session chat and room-opening behavior in `App.tsx`.
- **Acceptance criteria:**
  - Chat remains central while the drawer shows current location, exits, the campaign-visible NPC roster, active objectives, party resources, and encounter status from role-filtered APIs; it explicitly does not claim NPC presence because no NPC location/presence model is delivered.
  - AI suggestions, pending confirmations, committed mechanics, and narration have distinct visual and screen-reader labels; receipt cards show rolls, modifiers, targets, outcomes, and state deltas.
  - Reloading or swiping narration preserves receipt identity and never implies that mechanics were rerun; committed turns remain inspectable when streaming narration fails.

#### Implementation notes

At M3.7 completion, chat remained central, with role-filtered context, durable receipt recovery, and narration swipes. Because the backend had no NPC location/presence model, the drawer visibly labeled and showed the campaign-visible NPC roster rather than claiming those NPCs were present. Receipt cards omitted unavailable target or outcome fields and never inferred them; provider-driven tools remained future M4 work at that historical checkpoint. M4.2 subsequently delivered the bounded provider tool loop and deterministic command bridge.

### M3.8 Event Log, recap, import, and export experience

**Status: Complete (client UI)**

Create `CampaignEventLogPage`, `RecapViewer`, `CheckpointTimeline`, `CampaignImportWizard`, and `CampaignExportDialog`.

- **Complexity:** M
- **Dependencies:** M2.3-M2.4; M3.1 administration navigation.
- **Acceptance criteria:**
  - Users can page through structured events, open public receipts, read role-safe recaps, and understand that checkpoint restore creates a fork rather than erasing history.
  - Import always presents a dry-run conflict/reference report before apply, and export lists included and excluded data before download.
  - Loading, empty, stale, partial-failure, and retry states preserve focus, do not expose technical IDs in ordinary labels, and meet WCAG 2.2 AA targets.

## Milestone 4 — AI-Driven RPG Integration

### M4.1 Campaign-aware context assembly

**Status: Complete (server-internal context/repository boundary; no HTTP or wire change)**

Extend the existing context basket with bounded, role-filtered campaign mechanics, world, cast, quest, recap, and legal-action sections.

- **Complexity:** L
- **Dependencies:** M1.8-M1.10; M2.7-M2.11; existing `server/src/context.ts`, `prompt.ts`, and `promptTemplates.ts`.
- **Acceptance criteria:**
  - Context precedence is exactly: (1) safety/control, (2) human canon, (3) committed mechanics, (4) the exact final declaration, (5) visible world/cast/quests and legal actions, (6) authorized private target facts, (7) approved memory/lore, (8) recap/summary, and (9) generated suggestions.
  - Safety/control, human canon, world, mechanics/legal actions, quests, authorized private target facts, recap/summary, lore, memory, and suggestions each have an independent UTF-16 code-unit budget. Deterministic truncation includes or omits normalized whole lines, reports exact accounting, and never borrows budget or splits a line/surrogate pair.
  - Repository reads derive audience visibility from current campaign membership, role, actor control, attached session, target ancestry, and encounter state in one deferred SQLite snapshot. Player, DM, NPC, companion, and enemy authorization/projection tests prove private and hidden fields cannot cross audiences.
  - Full catalogs, full inventories, story graph dumps, hidden routes, unrelated private state, and controller identities never enter the snapshot. NPC and enemy target-private goals/tactics are planning-only and have a non-overridable earlier rule forbidding disclosure, quotation, paraphrase, hints, or confirmation.
  - Player and NPC legacy prompt generation is bound to the exact server-derived speaker persona and session and preserves the exact final declaration. DM and enemy legacy character prompts fail closed; companion context fails closed for every role because there is no persisted companion model or controller binding.

#### Implementation notes

At M4.1 completion, the milestone delivered typed server-internal campaign audiences, role-sensitive repository snapshots, deterministic basket assembly/truncation metadata, and optional provider-message plumbing. When campaign context is supplied, its approved retrieval layers replace the legacy lore/memory/shared-context trio to avoid duplicate context; generations without campaign context remain unchanged. There was no new route or shared wire contract, and no production adventure-turn tool/provider loop invoked this boundary yet. M4.2 subsequently added that bounded loop and deterministic command bridge.

### M4.2 Bounded tool loop and deterministic command bridge

**Status: Complete**

Implement a server-selected tool registry and bounded decision loop that can propose only authorized reads and command-service calls.

- **Complexity:** L
- **Dependencies:** M4.1; all deterministic repositories and command routes from Milestones 1-2.
- **Acceptance criteria:**
  - Tool availability is selected by agent role, campaign role, actor control, encounter phase, and current legal actions; arbitrary SQL, filesystem, network, policy, prompt, permission, deletion, and memory-approval tools do not exist.
  - A turn is capped at 5 decision rounds, 12 tool calls, 4 mutations, 7 provider calls, and 90 seconds, with lower configurable limits permitted.
  - Every mutation passes through the same revision-checked, idempotent command service used by HTTP/UI, and provider failure cannot bypass validation or leave an enemy turn permanently blocked.

### M4.3 Durable confirmation and resume

**Status: Complete**

Pause consequential AI proposals for human review and resume from persisted state after disconnect or restart.

- **Complexity:** L
- **Dependencies:** M4.2; M1.10 and M2.11 durable turn/confirmation resources; `ConfirmationBanner` from M3.7.
- **Acceptance criteria:**
  - Currency transfer, important-item loss, ambiguous limited-resource use, companion changes, ambiguous combat start, generated world changes, and deterministic GM overrides require confirmation by policy.
  - Confirmation stores proposal identity, exact parameters, authorizing principal, decision, expiry, and observed revision without holding an open database transaction.
  - Duplicate decisions converge, stale revisions require replanning, rejection commits no proposed mechanic, and approved commands remain attributable through receipts.

### M4.4 Receipt-aware narration and narrative consequence injection

**Status: Complete**

Generate final narration only after mechanics commit, injecting immutable receipts and bounded narrative consequences without granting mutation tools.

- **Complexity:** L
- **Dependencies:** M4.2-M4.3; receipt UI from M3.7.
- **Acceptance criteria:**
  - Final narration receives public facts, state deltas, roll outcomes, and narration hints from committed receipts and cannot contradict totals, HP, ownership, prices, rewards, permissions, or actor control.
  - Narrative consequence injection may alter tone, sensory detail, NPC reaction suggestions, and decision framing, but authoritative relationship, quest, location, effect, and reward changes require later explicit commands.
  - Swipes reuse the same receipts, provider failure yields a deterministic receipt renderer, and post-commit cancellation records narration status without undoing mechanics.

### M4.5 LLM encounter generation

**Status: Complete**

Create staged encounter drafts from campaign-aware constraints, then validate and require review before adding them to play.

- **Complexity:** L
- **Dependencies:** M4.1-M4.3; content definitions from M1.2 and encounter repository from M1.7.
- **Acceptance criteria:**
  - Generation inputs include party capability summary, visible location, campaign tone, pinned enemy definitions, difficulty policy, and explicit exclusions within fixed budgets.
  - Output is a typed draft of combatants, terrain prose, motives, rewards, and validation findings; unknown references, impossible budgets, hidden-data leakage, and unsupported mechanics reject.
  - Applying selected draft changes requires GM confirmation and deterministic commands; ordinary adventure turns cannot publish or silently activate generated encounters.

### M4.6 NPC stat derivation and campaign-content generation

**Status: Complete (schema v42r1 additive integrity sealing)**

Support staged NPC, location, faction, quest, and opening drafts with explicit conservative NPC baselines.

- **Complexity:** L
- **Dependencies:** M4.1-M4.5; world/story repositories from M1.8-M1.9; generation drafts from M1.10.
- **Acceptance criteria:**
  - NPC application records only explicit 10/10/10 conservative baseline stats, with no catalog powers or effects.
  - Generated personas, goals, secrets, relationships, locations, factions, quests, clues, and openings remain typed drafts with provenance, validation, role-safe previews, and per-change approval.
  - Applying a draft emits command receipts; generated prose cannot directly mutate campaign state, create permissions, voice player characters, or expose hidden information.

## Historical out-of-scope / deferred baseline

The D1-D5 entries below preserve the pre-revision-2 boundary as historical rationale. The approved post-M4 section above supersedes their disposition: branch-local simulation, boss phases, zones/range bands, closed rules IR, mutable **logical unpinned heads over immutable revisions**, licensed offline ingestion, remote identity/tenancy, autonomous parties, commit-reveal dice, and policy-granted proactive automation are Planned or Unscheduled exactly as stated above; notably, mutable authoring is Unscheduled and ingestion remains Build Later but blocked. Discord, VTT adapters, and simultaneous encounters remain deferred.

### D1 Alternate state and combat models

**Historical status:** Partly superseded by revision 2. Ephemeral non-promotable simulation is Planned; explicit boss phases and zones/range bands are Unscheduled. Simultaneous encounters and full grids remain deferred/excluded.

Defer mechanics that multiply authoritative state models until the single canonical timeline and ordinary encounter loop are stable.

- **Complexity:** L
- **Dependencies:** Demonstrated stability and migration strategy after M1.7, M1.10, and M4.4.
- **Acceptance criteria:**
  - Branch-local simulation, boss phases, tactical grids/line-of-sight (LOS), and simultaneous encounters remain absent from schemas, contracts, repositories, routes, tools, and UI in these milestones.
  - Message branches continue to reuse committed receipts; campaign correction uses compensating commands or timeline forks, and one active encounter per campaign session remains the rule.

### D2 Advanced rules extensibility

**Historical status:** Partly superseded by revision 2. Closed rules IR is Planned; append-only multiclass and mutable logical unpinned-head authoring are Unscheduled. If promoted, advancing a head creates a new immutable revision; exact pins and historical revisions remain immutable.

Defer rule execution that would undermine the initial typed, testable mechanics boundary.

- **Complexity:** L
- **Dependencies:** Stable single-class advancement, typed starter effects, and published-pack compatibility evidence after M1.2, M1.4, and M1.6.
- **Acceptance criteria:**
  - Multiclass execution until stable, executable user rules, a fully system-neutral effects DSL, and mutable published packs remain unsupported.
  - Schemas may preserve future-compatible identities where already designed, but no client or AI path can execute these capabilities, and sealed pack versions remain immutable.

### D3 External ingestion and remote identity

**Historical status:** Superseded into Planned work with prerequisites: licensed reviewed offline files only, and threat-modeled campaign tenancy/server-derived authenticated sessions before remote exposure. Current `local-owner` restrictions remain until delivery.

Defer optional reference-data migration and network identity until provenance and a real security boundary are separately approved.

- **Complexity:** L
- **Dependencies:** License/format review for the optional reference importer; a dedicated authentication, authorization, transport-security, and deployment project for remote access.
- **Acceptance criteria:**
  - The optional reference importer is not shipped unless provenance, format, and clean-room transformation are reviewed; normal campaign package import remains limited to the versioned Velvet format from M2.4.
  - Remote auth stays deferred: fixed `local-owner` remains trusted-local convenience only, binds to loopback, ignores caller identity headers, and is never described as safe for remote or multi-user exposure.

### D4 Autonomous and third-party play surfaces

**Historical status:** Partly superseded. Autonomous parties are Unscheduled behind remote identity and revocable grants. Defer Discord for now; VTT remains deferred.

Defer unattended play and external chat/tabletop adapters so all initial consequential actions retain direct human oversight.

- **Complexity:** L
- **Dependencies:** Separate product, privacy, authorization, rate-limit, and adapter reliability designs after M4 completes.
- **Acceptance criteria:**
  - Autonomous parties, Discord, and VTT integrations remain absent from runtime dependencies, routes, agent roles, and client navigation.
  - No external service can initiate turns, approve confirmations, control player characters, or receive campaign-private context through the roadmap surface.

### D5 Fairness extensions and proactive automation

**Historical status:** Superseded into Planned commit-reveal dice and later policy-granted proactive automation with visible receipts. Neither is current behavior.

Defer stronger randomness guarantees and unsolicited agent activity beyond explicit user-driven turns.

- **Complexity:** M
- **Dependencies:** A separately reviewed randomness threat model and opt-in background-agent policy after deterministic local mechanics and durable turns are stable.
- **Acceptance criteria:**
  - Cryptographic dice and proactive nudges remain absent; production continues to use the bounded injectable RNG contract, and deterministic tests continue to inject controlled randomness.
  - Agents run only within explicit bounded requests or durable confirmed resumes and cannot autonomously schedule messages, mechanics, spending, travel, or encounters.
