# Velvet RPG Integration Plan (Original/Historical)

## Current status (v46r1; Wave A slices committed)

> **Normative current sources:** [ROADMAP.md](ROADMAP.md) owns milestone status and next work, [api.md](api.md) owns the current HTTP contract, and [repo-architecture.md](repo-architecture.md) owns current repository structure and dependency rules. This document preserves the original integration design and historical implementation ledgers; the normative sources win for current behavior.

The canonical current engineering handoff is lowercase [`handoff.md`](../handoff.md).

- Current persistence is schema **v46 revision 1 (v46r1)**, with **102 explicit trusted-local RPG HTTP operations**. The boundary remains fixed unauthenticated `local-owner` loopback-only authority; it is not a remote-safe or multi-user identity boundary. Canonical populated v44/v45->v46 startup upgrades are supported; v43 and earlier are unsupported.
- Milestones **M1-M3, M4.1-M4.6, and M5.1 are complete**. M5.2 remains In Progress/partial after its authoritative companion management GET/closed command POST and client transport because no companion UI, grant exercise, dismissal, or proposal/decision administration exists; its v45 delivery wording is historical, not current support. M5.3 remains In Progress/partial after its separate consumable action/command/exact-result lane and exact client UI/reconciliation flow because the legacy combat union is unchanged and other milestone scope remains. M5.4 is In Progress/partial with exactly its v46 batches, candidates, supersessions, expiration observations, and attestation persistence foundation delivered. Decisions, receipt links, generation, execution, world adapter, provider advertising, routes, client, and E2E are absent. The normal application has no generator, so these tables remain empty outside direct repository use and tests. M5.5 has completed only its pure protocol checkpoint. Remaining integration is ordered and statused only by [ROADMAP.md](ROADMAP.md).
- The v37r1/M2.11 description of deterministic fallback narration, no provider tool bridge, and review-only campaign drafts is historical. M4 subsequently delivered campaign-aware context, the bounded provider/tool and deterministic command bridge, durable confirmation/resume, receipt-aware narration, and reviewed encounter and campaign-content generation/application.
- Supported executable migration coverage is for canonical populated **v44 and v45 databases upgrading to v46**. v43 and earlier migration code and archived tests do not constitute startup-upgrade support.
- A campaign NPC's persona reference remains identity metadata. M5.1 can persist an NPC in a running attached session's present cast, with an optional role-visible location, and retains a stopped session's cast as at-stop history. Presence does not make the NPC a legacy session participant or autonomous speaker, does not create a campaign-NPC speech bridge, and does not imply that the full campaign NPC roster is present.

## Checkpoint language

Every dated slice, gate, schema, operation-count, migration, and handoff entry below is a point-in-time ledger for its named checkpoint/commit. Words such as **current**, **next**, **remaining**, **absent**, **unchanged**, and **unimplemented** inside those entries apply only at that checkpoint and do not override the v46r1 status above.

## Original purpose (historical)

This plan adds the useful gameplay functionality of `mojomast/rpg-dm-bot` to Velvet while preserving Velvet's stronger chat, memory, lore, branching, streaming, prompt, provider, and persistence architecture.

The intended product is a local-first AI roleplaying and gaming application with:

- Campaign and world creation.
- Player-character creation and advancement.
- AI-controlled NPCs, companions, enemies, and a dedicated AI game master.
- Deterministic dice, inventory, economy, spells, effects, combat, quests, and rewards.
- Multi-character roleplay rooms backed by authoritative campaign state.
- Human review and override controls for generated content and consequential AI actions.

This is a functionality port, not a source-level merge. The Python database, FastAPI module, Discord cogs, imperative frontend, and monolithic tool executor from `rpg-dm-bot` will not be copied into Velvet.

## Source Baseline

The plan was built from parallel reviews of:

- Velvet's schema-v8 `HANDOFF.md` and the TypeScript implementation at the original review checkpoint.
- `rpg-dm-bot` at commit `60404539b10aecd0dae2b7e19016619e440c3689`.
- The remote bot's character, inventory, progression, spell, combat, NPC, quest, world, content-pack, tool-calling, campaign-generation, and web UI behavior.

Primary Velvet integration points:

- `server/src/repo/index.ts` (public persistence barrel)
- `server/src/repo/` domain modules; see [Repository architecture](repo-architecture.md)
- `server/src/app.ts` (Fastify composition and plugin registration)
- `server/src/types.ts`
- `server/src/context.ts`
- `server/src/prompt.ts`
- `server/src/promptTemplates.ts`
- `server/src/llm.ts`
- `server/src/lore.ts`
- `server/src/routes/roleplay/lore.ts`
- `server/src/routes/roleplay/memories.ts`
- `server/src/routes/roleplay/promptTemplates.ts`
- `server/src/routes/roleplay/harness.ts`
- `server/src/routes/roleplay/sessions.ts`
- `server/src/routes/roleplay/sessionLifecycle.ts`
- `server/src/routes/roleplay/interactions.ts`
- `server/src/routes/roleplay/generationService.ts`
- `server/src/routes/roleplay/generationRegistry.ts`
- `server/src/legacy.ts`
- `server/src/memory.ts`
- `client/src/App.tsx`
- `client/src/roleplay/CharacterLibraryPage.tsx`
- `client/src/roleplay/navigation.ts`
- `client/src/api.ts`

Primary reference-bot sources:

- `src/database.py`
- `src/tools.py`
- `src/tool_schemas.py`
- `src/chat_handler.py`
- `src/prompts.py`
- `src/content_loader.py`
- `src/mechanics_tracker.py`
- `src/cogs/combat.py`
- `src/cogs/game_master.py`
- `src/cogs/inventory.py`
- `src/cogs/npcs.py`
- `src/cogs/quests.py`
- `data/game_data/packs/fantasy/core/`

## Product Model

### Terminology

- **Campaign**: A durable world, rules profile, content-pack set, cast, quests, factions, economy, and canonical timeline.
- **Campaign character**: A Velvet character's campaign-specific role, progression, location, and RPG sheet.
- **Session**: Velvet's existing resumable, branchable conversation or scene. A campaign can contain many sessions.
- **Actor**: A mechanical participant in a campaign, including a player character, NPC, companion, summon, or enemy instance.
- **Adventure turn**: One player declaration, any deterministic resolutions, and the AI DM's narration.
- **Content pack**: Immutable, validated, versioned rules and game definitions.
- **Timeline**: The canonical sequence of committed campaign events. Restoring a checkpoint forks a new timeline instead of deleting history.

### Core Relationships

The relationship names in this diagram are conceptual product-model names, not a current schema or API inventory.

```text
Campaign
  -> active timeline
  -> pinned rules profile and content packs
  -> campaign characters
       -> Velvet character persona
       -> campaign-specific RPG sheet
  -> world, NPCs, factions, quests, shops, encounters
  -> many existing Velvet sessions
       -> participants
       -> branchable messages
       -> session-local manual and synthesized context
```

### Compatibility

- Existing characters do not automatically receive RPG sheets.
- Existing sessions remain normal roleplay sessions unless attached to a campaign.
- Existing `/api/characters` and `/api/sessions` behavior stays compatible.
- RPG state is additive and initially feature-flagged.
- The same Velvet persona can participate in multiple campaigns with independent levels, equipment, relationships, and history.
- Campaign NPC persona references are identity metadata only. Persisted presence can add an NPC to a running attached session's present cast and optionally associate a role-visible location; stopping the session retains structurally historical at-stop cast state. Presence does not connect the NPC to Velvet speech or memories, make it a legacy session participant or autonomous speaker, or imply presence for the full campaign-visible roster.
- Ordinary enemy instances do not become Velvet characters unless promoted to recurring speaking NPCs.

## Architectural Decisions

### Authority Hierarchy

From highest to lowest:

1. Safety, consent, and actor-control rules.
2. Human-authored campaign canon, GM edits, and explicit overrides.
3. Committed mechanics and campaign events.
4. The current player declaration.
5. Visible normalized campaign state.
6. Approved character memories and visible lore.
7. Campaign recaps, session summaries, and synthesized scene facts.
8. AI plans, suggestions, and narration.

The model may choose intentions, tactics, targets, tone, and narration. It may not invent dice outcomes, HP totals, inventory ownership, prices, XP, legal combat actions, or permissions.

### Branch And Timeline Semantics

Velvet messages can branch, but a campaign may be shared by several sessions. Campaign state therefore cannot silently rewind whenever one session activates a swipe.

Rules:

- A committed mechanic result receives an immutable receipt linked to its source adventure turn and message.
- Swiping DM narration reuses the original receipt. It does not reroll dice, reapply damage, spend resources again, or duplicate rewards.
- A mechanical reroll is an explicit operation with its own permission policy and audit event.
- Editing a declaration before mechanics commit can replace the pending turn.
- Changing already committed campaign state requires a compensating GM command or a checkpoint/timeline fork.
- Session summaries and synthesized scene state remain branch-sensitive.
- Campaign events, provider usage, and audit records remain append-only.
- Optional branch-local simulation can be considered later, but is not part of the first complete implementation.

### Deterministic Commands

All state changes, whether initiated from UI, API, GM, or AI tools, use the same command services.

Each command carries:

```ts
interface CommandEnvelope<T> {
  commandId: string;
  idempotencyKey: string;
  campaignId: string;
  timelineId: string;
  actorId: string | null;
  expectedRevision: number;
  sourceTurnId: string | null;
  command: T;
}
```

Each successful command returns:

```ts
interface CommandReceipt {
  commandId: string;
  campaignId: string;
  revisionBefore: number;
  revisionAfter: number;
  events: DomainEvent[];
  publicFacts: string[];
  narrationHints: string[];
}
```

Every command must validate ownership, active timeline, expected revision, game rules, and idempotency before making one atomic transaction.

### Content Packs

- Packs are immutable after publication.
- Campaigns pin exact pack versions.
- Definitions use references containing pack ID, version, resource kind, and local ID.
- Campaign instances reference definitions but own mutable state.
- No legacy root-file fallback is carried over from `rpg-dm-bot`.
- Imports are schema-validated and cannot provide arbitrary paths.
- Unsupported or prose-only spells and abilities remain disabled until deterministic effects exist.
- Active campaigns never change because a pack file was edited.

### Legal Constraint

The remote README claims MIT, but the repository has no detected `LICENSE` file and its handoff describes transformation from another project. Existing fantasy data also includes recognizable third-party names. Until provenance is clarified:

- Reimplement behavior in original TypeScript.
- Create original schemas, tests, names, and prompt text.
- Do not copy remote code or fantasy catalogs verbatim.
- Create a clean Velvet starter pack with original content.

## Original Prerequisite Refactor Targets (Historical)

The list below records the plan's prerequisite targets. Contracts, server route modules, repository/UoW boundaries, injectable runtime ports, request IDs/problems, and the local principal/campaign-role foundation now exist in the current implementation. Client decomposition remains incremental. This status note does not imply that the aspirational domain/agent layout or later RPG capabilities below are implemented.

The original plan targeted the following refactors without changing behavior at that checkpoint:

1. A `packages/contracts` package for runtime schemas and inferred server/client types.
2. Fastify plugins and route modules split out of `server/src/app.ts`.
3. Existing routes retained under a roleplay module and RPG routes added under `/api/rpg/v1`.
4. Navigation, roleplay pages, and feature modules split out of `client/src/App.tsx`.
5. A shared transaction/unit-of-work boundary around `better-sqlite3`.
6. Injectable random-number and clock interfaces for deterministic testing.
7. Request IDs, structured API problems, command receipts, and consistent redaction.
8. A local principal and campaign-role model preceding AI-controlled mutations, with one local owner principal for existing installations.
9. Existing deterministic and live E2E workflows retained as regression gates.

Proposed top-level server layout:

The following remains an aspirational target layout, not a description of the current tree. Current roleplay routes are under `server/src/routes/roleplay/`, current RPG routes are under `server/src/routes/rpg/v1/`, and current persistence is under `server/src/repo/`.

```text
server/src/
  plugins/
  routes/roleplay/
  routes/rpg/v1/
  domain/campaigns/
  domain/content/
  domain/characters/
  domain/progression/
  domain/resources/
  domain/inventory/
  domain/economy/
  domain/powers/
  domain/effects/
  domain/dice/
  domain/combat/
  domain/world/
  domain/actors/
  domain/factions/
  domain/quests/
  domain/story/
  domain/shops/
  domain/events/
  agent/
```

## Domain Scope

All capability labels and table names in this original domain design are conceptual unless the normative current architecture/API documents explicitly identify an implemented counterpart. They are not promises of literal table names or presently exposed routes.

### Campaigns And Membership

Capabilities:

- Create, edit, publish, pause, complete, archive, import, and export campaigns.
- Attach multiple existing Velvet sessions to one campaign.
- Add player characters, GM avatars, companions, and campaign-managed NPCs.
- Assign owner, GM, player, and observer roles.
- Track current active timeline and checkpoints.
- Configure AI autonomy, confirmation policy, advancement, death, resting, and difficulty.

Core tables:

- `principals`
- `campaigns`
- `campaign_timelines`
- `campaign_memberships`
- `campaign_characters`
- `campaign_sessions`
- `campaign_settings`
- `campaign_content_packs`

### Character Creation

Capabilities:

- Optional RPG sheet for any Velvet character.
- Race/origin, class, background, attributes, proficiencies, skills, languages, and starting features.
- Standard array, point buy, manual assignment, and bounded server-side rolling.
- Starter kit or starting-currency loadout.
- Draft autosave and atomic finalization.
- Derived HP, defenses, initiative, speed, carrying limits, spell attack, and save DC.
- Multi-class support can be represented in the schema but enabled only after single-class advancement is stable.

Core tables:

- `rpg_rules_profiles`
- `rpg_content_packs`
- `rpg_classes`
- `rpg_class_levels`
- `rpg_races`
- `rpg_backgrounds`
- `rpg_skills`
- `rpg_abilities`
- `rpg_spells`
- `rpg_items`
- `rpg_enemy_templates`
- `rpg_campaign_sheets`
- `rpg_character_classes`
- `rpg_character_attributes`
- `rpg_character_proficiencies`
- `rpg_character_choices`

Invariants:

- Finalized sheets satisfy all choice groups.
- All selected content belongs to the campaign's pinned packs.
- Grants are applied exactly once.
- Derived values come from one server implementation.
- Persona editing remains separate from mechanical-sheet editing.

### Progression And Leveling

Capabilities:

- XP and milestone advancement profiles.
- Append-only XP ledger.
- Multi-level threshold crossing.
- Level-up previews and required choices.
- HP/resource increases, proficiency changes, abilities, spells, slots, and advancement points.
- GM awards and corrections with an audit reason.

Core tables:

- `rpg_xp_thresholds`
- `rpg_progression`
- `rpg_xp_ledger`
- `rpg_level_advancements`
- `rpg_pending_choices`
- `rpg_known_powers`

Invariants:

- XP rewards and level applications are idempotent.
- Every crossed level is applied separately.
- A level cannot finalize with unresolved required choices.
- No partial level-up can persist.

### Resources, Inventory, Equipment, And Economy

Capabilities:

- HP, temporary HP, mana, stamina, spell slots, limited uses, and configurable resources.
- Stackable and instanced items.
- Equipment slots and slot-conflict validation.
- Consumables, charges, ammunition, quest-bound and non-transferable items.
- Currency wallets, shops, finite stock, purchases, sales, gifts, and bilateral trades.
- Short and long rests with profile-specific recovery.

Core tables:

- `rpg_actors`
- `rpg_actor_resources`
- `rpg_inventory_entries`
- `rpg_equipment`
- `rpg_currencies`
- `rpg_wallets`
- `rpg_currency_ledger`
- `rpg_shops`
- `rpg_shop_stock`
- `rpg_trades`
- `rpg_trade_items`
- `rpg_trade_currency`

Invariants:

- Resources, balances, and finite stock never become negative.
- Purchases debit currency, decrement stock, add inventory, write ledgers, and emit events in one transaction.
- Trades settle completely or not at all.
- Equipped, reserved, bound, or insufficient items cannot be transferred.
- Client code never computes authoritative prices or derived equipment effects.

### Dice, Checks, Powers, And Effects

Capabilities:

- One bounded dice parser for `NdS`, modifiers, keep-high/low, advantage, and disadvantage.
- Attribute checks, skills, saves, opposed checks, attacks, damage, healing, and initiative.
- Known and prepared spells.
- Spell slots or alternative resource profiles.
- Abilities with action costs and recharge rules.
- Conditions, buffs, debuffs, stacking, duration, periodic effects, resistances, vulnerabilities, immunities, and concentration.
- Deterministic receipt rendering independent of AI narration.

Core tables:

- `rpg_dice_rolls`
- `rpg_dice_terms`
- `rpg_checks`
- `rpg_actor_spell_slots`
- `rpg_actor_power_uses`
- `rpg_effect_definitions`
- `rpg_effect_modifiers`
- `rpg_active_effects`

Invariants:

- The parser consumes the whole expression and caps work.
- The server calculates modifiers and target numbers.
- Resource costs and effects commit atomically.
- Failed validation consumes no slot or item.
- Concentration replacement and effect expiration happen transactionally.

### Combat And Enemies

Capabilities:

- Prepared encounters and improvised encounters.
- Template-backed enemy instances and campaign overrides.
- Initiative, stable turn order, rounds, legal action calculation, reactions, defend, flee, item use, spells, abilities, defeat, and rewards.
- Enemy AI chooses one action from a server-computed allowlist.
- Deterministic fallback tactics if the provider fails.
- Boss phases only after ordinary combat is stable.
- Structured combat log plus concise AI narration.

Core tables:

- `rpg_encounters`
- `rpg_combatants`
- `rpg_combat_actions`
- `rpg_combat_damage`
- `rpg_enemy_instances`
- `rpg_reward_bundles`
- `rpg_reward_xp`
- `rpg_reward_currency`
- `rpg_reward_items`

Invariants:

- One active encounter per campaign session unless a future profile explicitly supports more.
- Only the current actor can use normal turn actions.
- Dead, fled, or removed actors do not receive turns.
- HP has one authoritative resource row; combat does not maintain a second copy.
- Retry and reconnect cannot apply an action or reward twice.
- Provider failure cannot stall an enemy turn.

### Worldbuilding And Travel

Capabilities:

- Hierarchical worlds, regions, settlements, sites, structures, and rooms.
- Directed or bidirectional connections.
- Known, rumored, hidden, open, locked, blocked, and destroyed routes.
- Deterministic travel and individual or party location.
- Discovery visibility and private/shared discoveries.
- Current location and visible exits in prompt context.

Core tables:

- `locations`
- `location_connections`
- `actor_locations`
- `location_discoveries`
- `connection_discoveries`

Invariants:

- Travel validates adjacency, route state, visibility, requirements, and actor membership.
- Travel updates all selected actors and appends one campaign event atomically.
- Hidden locations and routes never enter player or ordinary agent context.
- Location parent and connection references cannot cross campaigns.

### NPCs, Companions, Enemies, And Factions

Capabilities:

- Campaign-managed NPC identity metadata linked to Velvet characters.
- Role, goals, secrets, disposition, location, faction, merchant, and companion state.
- Per-character affinity, trust, fear, and relationship notes.
- Factions, memberships, allies/enemies, party or individual reputation, standing tiers, and favor.
- Promote an enemy into a persistent NPC when it becomes narratively important.
- Campaign NPC persona references remain identity metadata. Persisted session presence and optional role-visible location do not create a speech or memory bridge, make an NPC a legacy session participant or autonomous speaker, or imply that every campaign-visible NPC is present.

Core tables:

- `campaign_npcs`
- `npc_relationships`
- `npc_private_state`
- `factions`
- `faction_memberships`
- `faction_relationships`
- `faction_reputations`

Invariants:

- One Velvet character reference supplies the NPC's identity metadata; it does not make the NPC a Velvet session speaker.
- NPC private state is never sent to unrelated agents or player-facing responses.
- Relationship and reputation mutations are deterministic events, not inferred by parsing generated prose.
- AI never voices a manually controlled player character.

### Quests, Storylines, Clues, And Rewards

Capabilities:

- Draft, available, active, completed, failed, and abandoned quests.
- Ordered and dependency-based objectives.
- NPC, location, faction, encounter, item, and storyline links.
- Idempotent rewards.
- Storyline graphs with nodes, edges, entry rules, and fail-forward effects.
- Plot questions, clue sources, partial/misleading clues, discovery scope, and reveal thresholds.
- Player journal and separate GM-only story view.

Core tables:

- `quests`
- `quest_objectives`
- `quest_objective_dependencies`
- `quest_prerequisites`
- `quest_rewards`
- `storylines`
- `story_nodes`
- `story_edges`
- `story_progress`
- `plot_points`
- `plot_clues`
- `clue_discoveries`

Invariants:

- Objective dependencies and prerequisites are enforced.
- Completion and rewards are exactly-once.
- Hidden answers, undiscovered clues, and GM notes do not enter player prompts.
- Story graph edges cannot cross storylines.
- Narrative summaries never become authoritative quest state.

### Events, Recaps, Checkpoints, Import, And Export

Capabilities:

- Append-only campaign event and command audit.
- Human-readable recaps derived from canonical events and selected dialogue.
- Checkpoints and non-destructive timeline forks.
- Versioned campaign and character export packages.
- Dry-run imports with dependency, conflict, and reference reports.
- Optional importer for `rpg-dm-bot` SQLite/snapshot data after license and format review.

Core tables:

- `campaign_events`
- `command_receipts`
- `campaign_recaps`
- `campaign_checkpoints`
- `campaign_imports`
- `generation_drafts`

Invariants:

- Every consequential mutation has provenance and an actor.
- Restore never deletes the original timeline.
- Imports validate completely before writing and apply in one transaction.
- Provider credentials, usage history, local paths, and secrets are excluded by default.

## AI Game Master And Agent Architecture

The agent roles, module paths, tool categories, prompt-template names, limits, and pipeline below originated as conceptual targets and are not a current implementation inventory. The M2.11 fallback limitations were historical; [ROADMAP.md](ROADMAP.md) owns the delivered M4 boundary and subsequent work.

### Agent Roles

- **DM narrator**: Describes the world and outcomes, presents choices, and coordinates tools. It is a service, not a session character.
- **NPC agent**: Produces one response using its public persona, private goals, visible state, memories, and relationships.
- **Companion agent**: Like an NPC, but operates under configurable manual/shared/AI control.
- **Enemy tactician**: Chooses one legal action ID and legal target. It never receives general campaign mutation tools.
- **Campaign generator**: Produces staged, reviewable drafts outside ordinary play turns.

No role runs an unbounded autonomous loop.

### Tool Registry

Proposed modules:

```text
server/src/agent/types.ts
server/src/agent/toolRegistry.ts
server/src/agent/authorization.ts
server/src/agent/turnCoordinator.ts
server/src/agent/agentLoop.ts
server/src/agent/context.ts
server/src/agent/narration.ts
server/src/agent/campaignGeneration.ts
server/src/agent/nudges.ts
```

Tools are selected server-side by mode, actor role, combat phase, permissions, and current state. The full tool catalog is never sent on every turn.

Tool categories:

- Read-only: sheet, inventory, powers, location, visible NPCs, quests, encounter, and legal actions.
- Resolution: checks, saves, attacks, powers, item use, initiative, and enemy actions.
- Player mutation: move, equip, purchase, transfer, rest, accept quest, claim reward, and recruit.
- World mutation: create NPC/quest drafts, advance objectives, reveal discoveries, and apply approved world effects.
- Administration: campaign generation, pack publication, rules replacement, import, archive, and timeline fork. These are never exposed during normal play.

Forbidden tools:

- Arbitrary SQL, filesystem, shell, or network access.
- Provider or prompt-template editing.
- Session/campaign deletion.
- Manual-canon editing.
- Memory approval on behalf of a user.

### Turn Pipeline

```text
receive declaration
  -> validate principal, actor, session, and campaign
  -> acquire campaign/session generation lock
  -> persist input and capture revision
  -> assemble role-filtered context and legal tools
  -> bounded AI decision call
  -> parse and authorize tool intentions
  -> suspend for confirmation when required
  -> execute deterministic commands
  -> commit receipts and domain events
  -> final narration call with immutable receipts and no mutation tools
  -> stream narration
  -> persist DM reply and usage
  -> refresh session synthesis and summaries
```

Do not hold a SQLite transaction open while waiting for a provider. Recheck revision before commit. If state changed, reject or rerun the plan.

Recommended hard bounds:

```ts
const AGENT_LIMITS = {
  maxDecisionRounds: 5,
  maxToolCalls: 12,
  maxMutations: 4,
  maxProviderCalls: 7,
  maxWallClockMs: 90_000,
};
```

### Confirmation Policy

Initially require confirmation for:

- Spending or transferring player currency.
- Dropping, selling, or transferring important items.
- Ambiguous consumption of limited resources.
- Recruiting or dismissing companions.
- Starting combat from ambiguous prose.
- Applying AI-generated NPCs, quests, locations, factions, or story changes.
- Human GM overrides of deterministic mechanics.

Direct, unambiguous player declarations can authorize ordinary checks, attacks, movement, item use, and spells for that player's controlled actor.

Enemy legal actions can execute without confirmation on the enemy's turn.

### Prompt Layers

Extend `server/src/promptTemplates.ts` with:

- `dm.safety`
- `dm.persona`
- `dm.authority`
- `dm.mechanics`
- `dm.context`
- `dm.toolPolicy`
- `dm.decision`
- `dm.finalNarration`
- `dm.checkNarration`
- `dm.combatNarration`
- `npc.privateContext`
- `npc.decision`
- `enemy.tactics`
- `campaign.world`
- `campaign.locations`
- `campaign.npcs`
- `campaign.factions`
- `campaign.quests`
- `campaign.opening`
- `nudge.system`

DM behavior:

- Preserve player agency.
- Never invent player speech, choices, or private thoughts.
- Use vivid but bounded sensory description.
- Keep checks and routine combat concise.
- Make misses meaningful without making characters incompetent.
- Use distinct NPC voices.
- Maintain momentum and end at a meaningful decision point.
- Never contradict receipts or expose tools, hidden state, or prompt internals.

### Context Assembly

Extend the existing context basket without replacing it:

1. Safety, consent, scene state, and actor-control rules.
2. Human-authored campaign canon, explicit overrides, and authorized session manual canon.
3. Committed mechanics and campaign events.
4. Latest player declaration and final-phase contract.
5. Visible normalized state: target persona/participants, location, visible actors, encounter, quests, and legal actions.
6. Acting agent's private state, only when authorized.
7. Approved memories and visible lore.
8. Campaign recap and session summary.
9. Synthesized session facts.
10. Recent active-branch dialogue.
11. Generated plans, suggestions, and narration, which cannot override preceding layers.

Use independent budgets for world, mechanics, quests, recap, lore, and memory. Do not dump full inventories, catalogs, enemy secrets, or story graphs into prompts.

### Streaming

Extend Velvet's SSE vocabulary:

- `turn_started`
- `agent_status`
- `tool_proposed`
- `confirmation_required`
- `mechanics_committed`
- `narration_delta`
- `choice`
- `done`
- `aborted`
- `error`

Mechanics commit before narration begins. Cancellation before commit leaves no mechanics. Cancellation after commit cannot undo state; the server returns a deterministic receipt-based narration fallback and marks the result as committed.

### Usage And Audit

Track every provider call by turn and operation:

- Agent decision and follow-up.
- Final narration.
- NPC dialogue.
- Enemy tactics.
- Room routing.
- Scene synthesis.
- Campaign-generation stage.
- Proactive nudge.

Snapshot prices at call time rather than applying today's rate to all historical events. Add per-turn call, token, cost, latency, and retry records.

## API Strategy

Keep existing APIs stable. New routes use `/api/rpg/v1`.

Conceptual representative route groups from the original plan (not a current route inventory):

```text
/api/rpg/v1/campaigns
/api/rpg/v1/campaigns/:id/memberships
/api/rpg/v1/campaigns/:id/sessions
/api/rpg/v1/campaigns/:id/characters
/api/rpg/v1/campaigns/:id/world
/api/rpg/v1/campaigns/:id/npcs
/api/rpg/v1/campaigns/:id/factions
/api/rpg/v1/campaigns/:id/quests
/api/rpg/v1/campaigns/:id/storylines
/api/rpg/v1/campaigns/:id/shops
/api/rpg/v1/campaigns/:id/encounters
/api/rpg/v1/campaigns/:id/events
/api/rpg/v1/campaigns/:id/checkpoints
/api/rpg/v1/campaigns/:id/export
/api/rpg/v1/content-packs
/api/rpg/v1/characters/:id/sheet
/api/rpg/v1/characters/:id/level-up-preview
/api/rpg/v1/characters/:id/level-up-commands
/api/rpg/v1/actors/:id/inventory
/api/rpg/v1/actors/:id/powers
/api/rpg/v1/actors/:id/rest-commands
/api/rpg/v1/combats/:id/action-commands
/api/rpg/v1/adventure-turns/stream
/api/rpg/v1/adventure-turns/:id/confirm
/api/rpg/v1/generation-drafts
```

Contract requirements:

- Runtime request and response validation.
- Separate player, GM, and admin projections.
- Opaque string IDs and UTC ISO timestamps.
- SQL checks for enums and bounds.
- Integer minor units for currency.
- Revision on mutable aggregate roots.
- Idempotency key on retry-sensitive commands.
- Structured dice and mechanic data, not presentation-only strings.
- Generated OpenAPI document and contract compatibility checks.

## Frontend Plan

All route labels, screen names, React component names, and directory paths in this section are conceptual original-plan targets unless the normative current sources say otherwise.

### Information Architecture

Global navigation:

- Library: Existing Velvet characters and standalone scenes.
- Campaigns: Create, import, resume, archive, and export.
- Play: Active campaign chat and gameplay.
- Studio: GM world, cast, quests, factions, shops, encounters, and content.
- Settings: Existing provider, prompts, usage, security, and feature settings.

Campaign navigation:

- Overview.
- Play rooms.
- Character sheet.
- Inventory and equipment.
- Spells and abilities.
- Quests and journal.
- World and travel.
- NPCs and factions.
- Combat.
- Campaign log and checkpoints.
- GM studio.

### Major React Features

```text
client/src/rpg/campaigns/
client/src/rpg/characters/
client/src/rpg/inventory/
client/src/rpg/progression/
client/src/rpg/powers/
client/src/rpg/world/
client/src/rpg/actors/
client/src/rpg/quests/
client/src/rpg/shops/
client/src/rpg/combat/
client/src/rpg/dm/
client/src/rpg/content/
```

Key screens:

- Campaign library and setup wizard.
- Character builder and derived-stat review.
- Character sheet with resources, skills, saves, conditions, and rest.
- Inventory list, equipment slots, item details, and trade confirmation.
- Atomic level-up preview and choice flow.
- Spellbook, prepared powers, slots, and ability uses.
- Quest journal and GM quest editor.
- Accessible location tree/list plus optional graph.
- NPC roster, relationships, factions, and reputation.
- Shop browser with server-issued quote and receipt.
- Combat tracker with initiative rail, current turn, legal actions, and combat log.
- AI DM chat with visibly separate narration and mechanic receipts.
- Campaign event log, recap, checkpoints, import, and export.
- Content pack validation and publication studio.

### Play Experience

- Chat remains central but does not host every editor.
- A compact campaign drawer distinguishes the full campaign-visible NPC roster from the running session's persisted present cast, may show role-visible present-NPC locations, and also shows exits, active objectives, party resources, and the current encounter. Stopped at-stop cast history is historical rather than prompt-current or running presence.
- Active combat uses a focused action tray while preserving narration.
- Mechanic receipts are linked to messages and show rolls, modifiers, targets, outcomes, and state changes.
- AI suggestions are visibly different from committed actions.
- GM-only secrets are never sent in player bootstrap payloads.

### Mobile And Accessibility

- Bottom navigation for Play, Sheet, Journal, and More.
- Full-screen combat mode with bottom action tray.
- Bottom sheets for inventory, powers, and context.
- Searchable location list is primary on mobile; graph is optional.
- Maintain `100dvh`, safe-area support, and keyboard-safe composition.
- Target WCAG 2.2 AA.
- Every graph has a keyboard-operable list/tree equivalent.
- Dice, HP, conditions, standing, and rarity never rely on color alone.
- Minimum 44px gameplay touch targets.
- Reduced-motion support for streaming cursor and future dice animation.

## Migration Sequence

Velvet currently uses schema **v46 revision 1**. The concise sequence below is a migration-history summary; [ROADMAP.md](ROADMAP.md) and [repo-architecture.md](repo-architecture.md) are normative for current milestone and repository ownership details.

| Version | Scope |
|---|---|
| v9 | Shared contract-compatible IDs, local principal, campaign, timeline, membership, session attachment |
| v10 | Rules profiles, immutable content packs, classes, races, backgrounds, items, spells, abilities, enemies |
| v11 | Campaign character sheets, attributes, classes, proficiencies, choices, actor registry |
| v12 | Event ledger, command receipts, revisions, idempotency, audit foundation |
| v13 | Minimal named actor resources only; inventory, equipment, currency, shops, stock, and trades remain deferred |
| v14 | Minimal dice rolls only; checks, progression, level choices, rest, powers, and effects remain deferred |
| v15 | M1.1 campaign administration, membership, timelines, checkpoints, recaps, and import/export repository foundation |
| v16-v18 | M1.2 immutable mechanics catalog, role-safe visibility/integrity, campaign pinning, and exact command proposals |
| v19-v22 | M1.3 character drafts, derived sheets, immutable command/revision provenance, and integrity repairs |
| v23 | M1.4 single-class progression, XP/milestone ledgers, advancements, pending choices, powers, and receipts |
| v24 | M1.4 provenance/integrity repair for bootstrap, pending snapshots, proposals, advancements, and power sources |
| v25 | M1.5 actor resource sidecars, inventory/equipment, integer-minor wallets and currency ledgers, shops/finite stock/quotes/purchases, bilateral trade, and short/long rest |
| v26 | M1.6 checks, powers, deterministic effects, and associated receipts |
| v27 | M1.7 encounter and combat foundations |
| v28 | M1.8 world, travel, NPC, faction, and reputation foundations |
| v29r1 | Character-layout attestation |
| v29r2 | Retained quest, storyline, clue, reward, and objective-completion compatibility tables; authoritative quest and story domains arrive in v33 and v34 |
| v30 | Campaign import staging |
| v31 | Encounter lifecycle hardening |
| v32 | World and narrative integrity expansion |
| v33 | Quest-domain persistence and integrity |
| v34 | Story-domain persistence and integrity |
| v35 | M1.10 durable adventure-turn and generation-draft foundation |
| v36 | Adventure coordination and provenance hardening |
| v37 | Exact server-owned proposal-to-mechanics execution bindings |
| v38 | Durable bounded agent-execution operations, provider starts, decision rounds, tool calls, read outcomes, and layout attestation |
| v39 | Provider context/response provenance, dispatch claims, combat proposal bindings, and generalized receipts |
| v40 | Confirmation-policy attestations, authority evidence, expiration operations, mutation accounting, and replanning requirements |
| v41 | Reviewed campaign opening, conservative NPC baseline, and generated quest persistence |
| v42 | Immutable campaign-content commands, receipts, revisions, and layout attestation |
| v43 | Persisted session NPC presence, session-root revisions, optional locations, at-stop history, and layout attestation |
| v44 | Additive empty companion foundation with immutable revisioned commands/receipts and companion, proposal, decision, grant, revocation, audit, and layout-attestation sidecars; no repository commands, routes, UI, or grant exercise |
| v45 | Row-preserving replacement companion sidecars with durable historical principals; owner/GM companion and bounded grant administration exposed through authoritative management GET and receipt-only command POST plus client transport; no companion UI, proposal/decision administration, dismissal, public member HTTP, or grant exercise |
| v46 | Persistence-only exact-candidate batches, candidates, explicit supersessions, expiration observations, and canonical layout attestation; no decisions, receipt links, generation, execution, world adapter, provider advertising, routes, client, or E2E |

Migration requirements:

- Every migration is atomic and advances `meta.schemaVersion` in the same transaction.
- Fresh installations create the latest schema directly.
- The supported executable startup window is canonical populated v44 and v45 databases upgrading to v46; v43 and earlier migration implementations and archived tests are historical and unsupported. The v45 support wording in the M5.2 checkpoint is historical rather than current.
- Existing characters and sessions receive no implicit RPG data.
- Migration failures are loud and rollback completely.
- Production migration instructions include a SQLite online backup.
- Additive tables preserve prior data; binaries still enforce the exact supported schema version, and destructive down-migrations are not provided.

### Historical production v13 to v14 SQLite rollout

1. Resolve the live database path (`$VELVET_DATA_DIR/velvet.sqlite`, otherwise `data/velvet.sqlite`), enable maintenance mode, block new writes, and drain in-flight writers. While the database remains open, take an online backup: `sqlite3 "$DB" ".timeout 10000" ".backup '$BACKUP'"`.
2. Run `sqlite3 "$BACKUP" "PRAGMA quick_check; PRAGMA foreign_key_check; SELECT key,value FROM meta WHERE key IN ('schemaVersion','schemaRevision') ORDER BY key;"`; require `ok`, no FK rows, and expected v13 metadata. Stop every writer, never mix v13/v14 binaries, and repeat the backup if any later write occurred.
3. Start exactly one v14 server. After its atomic startup migration succeeds, require live schema version 14/revision 1, `PRAGMA integrity_check` = `ok`, and no `PRAGMA foreign_key_check` rows before traffic or more instances resume.
4. To restore, stop all writers, preserve the failed file, remove only its `-wal`/`-shm`, copy the verified backup to the original path, reverify it, and start the previous v13 binary. Treat a later v14 retry as a new coordinated rollout; no down-migration exists.

## Implementation Progress

### Historical 2026-08-09 v37r1 boundary

At this historical checkpoint, current persistence was v37r1, 92 explicit trusted-local RPG operations were implemented through M2.11, M1-M3 were complete, and M4.1 was next. M2.11 provided deterministic adventure-turn fallback and draft-review persistence only: it did not execute the future bounded provider tool bridge, perform provider-backed campaign generation, or apply generated changes to campaign-domain state. See [ROADMAP.md](ROADMAP.md), [api.md](api.md), and [repo-architecture.md](repo-architecture.md) for the normative current descriptions.

### 2026-08-05: Schema v25 M1.5 Resources, Inventory, Economy, and Rest

At this checkpoint persistence was v25r1. M1.5 completed the repository/shared-contract layer for actor resource sidecars, inventory/equipment, integer-minor wallets and currency ledgers, shops with finite stock, quotes and purchases, bilateral trade, and short/long rest. Exact retries, revisions, and immutable receipts were factory-only behavior. V25 preserved historical v14 and later ledgers; its fixed canonical DDL digest is `a5e3a58f8014978315d20440a0ac087871edac95323d059327faa2fe0a983ef7`.

At this checkpoint M1.1-M1.5 were complete repository/shared-contract capabilities. The fixed-principal trusted-local boundary was exactly 21 operations: the historical 14 plus server-only builder draft create/read/update, progression read/preview, and administration GET/PATCH. M1.5 added no HTTP routes or client/UI. M1.6 checks, powers, and deterministic effects was next.

### 2026-08-05: Schema v24 M1.4 Progression Integrity Repair

Historical v24r1 introduced M1.4 progression at the repository/shared-contract boundary and repaired exact bootstrap and initial-power provenance, immutable pending snapshots for revision zero and every command, proposal/event/receipt binding, advancement power sources, and complete startup integrity validation. Migration reconstructed pending revisions from immutable command results. Its fixed canonical v24 DDL digest is `e056d9df1ec9f9c00cc1aba740f2acc91b40cc7b03a5716cb75e79ec8df6bec8`.

At that point M1.1-M1.4 were complete repository/shared-contract capabilities. The then-current fixed-principal trusted-local boundary was 21 operations: the historical 14 plus server-only builder draft create/read/update, progression read/preview, and administration GET/PATCH. The mechanics starter remained distinct from the metadata-only original starter and could not replace configured content. No client/UI existed for these routes.

### Historical 2026-08-05 M0 Slice 98 Deterministic Closeout

At this historical checkpoint, exactly 98 M0 slices were complete at schema v14 revision 1 (v14r1), with exactly 13 trusted-local campaign HTTP operations. Slice 98 was documentation-only closeout and added no feature, code, test, contract, route, operation, schema, migration, dependency, database backup, or commit. The final independent Slice 97 backend, client, and closeout reviews reported no findings after remediation.

The delivered campaign surface includes the read-only campaign-character workspace; deterministic dice with bounded newest-first recent history; and room linking with exact campaign-to-chat opening, reload, and authoritative campaign return. All campaign operations remain fixed-principal trusted-local `local-owner` convenience: this is not authentication and is not safe for remote or multi-user exposure. Unexpected dice POST and room-linking PUT outcomes remain commit-ambiguous, require authoritative history/room GET reconciliation, and must never be retried automatically.

The Slice 98 gate ran in exact order: `npm run typecheck` passed; `npm run build` passed with 133 Vite modules; `npm test` passed with contracts 126 across 10 files, server 1,641 passed plus 1 skipped across 72 files, and client 226 across 8 files, totaling 1,993 passed plus 1 skipped; `npm run test:e2e` passed 1, for a deterministic total of 1,994 passed plus 1 skipped. Live E2E was not run. Existing schema/migration exclusions, production online-backup and restore guidance, and all historical implementation/gate ledgers below are preserved. Lowercase `handoff.md` and `devplan.md` remain absent. No next slice is approved; any future work requires explicit separate scope.

### 2026-08-05: M0 Slice 97 Review and Finding Remediation Complete

Exactly 97 M0 slices are complete after Slice 97 review and remediation. The final independent backend, client, and closeout reviews reported no findings. Schema remains v14 revision 1 (v14r1), and the trusted-local campaign boundary remains exactly 13 operations. Workspace GET now sends actual HTTP `Cache-Control: no-store` on success and scoped failures, including exact malformed normalization; its client fetch is also no-store.

Campaign-origin hydration/restoration enters chat only when the returned `session.id` is binary-exact to the requested opaque ID. Private open additionally requires a valid session ID, exactly one participant matching the requested character, matching primary identity, and any compatibility alias to match before origin can clear. Mismatch is a generic local failure that preserves the room and campaign Back origin. Explicit hydration busy disables old-session send/continue/room/swipe/stop/settings/private/open actions while pending, with request/navigation generations still rejecting stale settlement. Save-and-start also requires hydrated identity to equal the newly created session before chat navigation and otherwise remains on the safe library with a generic error.

Create peers synchronously invalidate active roster/options generations and reusable caches at completion. A peer whose matching detail is still pending retains the exact token-scoped reconciliation locally until that detail is ready, then applies it once; stale initial reads cannot restore an unused create option even if they settle later. Dice peers synchronously invalidate history generation/cache, retain completion result, and set matching campaign initialization so delayed detail cannot launch an extra (including failing) history GET. Attach completion ownership remains unchanged and token-scoped; StrictMode replay and unmounted reopen handoff remain safe.

Deterministic E2E now lets a real room PUT commit through Fastify/SQLite and aborts only delivery of the browser response. It asserts one PUT, exactly one room reconciliation GET, attached state, and no repeated action. Opaque special-character path encoding remains unit/integration coverage because real server ID generation cannot practically produce such IDs. No schema, migration, operation, route, dependency, or feature was added.

Final-review remediation makes delayed-detail dice completion invalidate stale history while remaining module-retained and unapplied until exact detail readiness, guards all old-chat session replacement by exact entry ownership, and gives save/start plus ordinary resume operation-sequence and navigation-epoch cancellation. Current remediation/focused and full results are explicitly pre-Slice 98 gate: a separate 226-test client run, root typecheck and production build with 133 Vite modules, all unit suites (126 contracts, 1,641 server plus 1 skip, and 226 client), and deterministic Playwright passed. Live E2E was not run, and no commit was created. Slice 98 is next and is deterministic closeout only.

### 2026-08-04: M0 Slice 96 Campaign Rooms Client, Detail, and Chat Return

Exactly 96 M0 slices are complete at unchanged schema v14 revision 1 (v14r1), with exactly 13 trusted-local campaign operations unchanged. Strict clients validate and encode campaign IDs, preserve exact opaque legacy session IDs in the sole PUT body, strict-parse room projections and request-bind the 200 attachment response, use fresh no-store GETs, and never retry PUT. Campaign detail loads rooms independently for all roles. Attached summaries show safe title fallback, bidi-isolated participant names, dates, and stopped/read-only state; duplicate titles remain positional. Only owners receive eligible or empty attach controls. Session IDs remain closure/index/state/request-only and are absent from rendered text, IDs, names, values, ARIA, data, href, class, and key-derived attributes.

Attachment is a fifth kind in the shared document-lifetime per-campaign mutation-token guard. Ref locks synchronously serialize rapid activation and all campaign writes; acquisition invalidates older room generations and reusable reads, while a manual refresh visibly disables attachment. Reconciliation advances the room generation, and an active-token reopen waits for listener reconciliation instead of starting or reusing pre-PUT room data. Back/Open controls and unload remain guarded through one PUT plus exactly one fresh GET after every success, HTTP error, malformed response, or network outcome. Typed conflict/missing and generic outcomes use conservative safe status, and Refresh rooms is GET-only. Campaign/generation/token/mount/focus guards cover stale settlement, unmount, A→B→A, and return focus without a PUT retry. GM/player/observer never receive candidate UI or attach controls; room action names contain only list kind and position, never the visible Unicode title.

Validated `chatReturnCampaignId` is meaningful only with chat plus an exact session. Opening an attached room uses a monotonic request sequence plus current navigation epoch/view/campaign guards; pending state disables competing detail actions but Back can cancel. Only the latest still-current hydration may enter or clear chat. Generic failure remains as a focused accessible detail alert, while a missing session stays on detail and refreshes Rooms. Feature discovery evaluates current navigation at settlement and can evict only a current campaign view or campaign-origin chat, never a newer ordinary/private chat. Campaign-origin Back clears chat, returns to detail, focuses Rooms after exactly one authoritative GET, and persists across chat reload. Existing send/stream/room/stop/swipe/provider semantics are unchanged. Deterministic E2E counts the attach reconciliation GET and each campaign-return GET, and covers a stale eligible room externally attached to a second campaign as exactly one PUT 409 plus one GET with generic reconciled state and no retry; stopped-new 409 and deletion cascade remain covered. No server, contract, schema, migration, detach route, operation, dependency, or `docs/api.md` HTTP change occurred. Slice 97 is next and requires separate explicit scope.

Final finding-remediation encodes every opaque legacy session/message client path segment exactly once and makes campaign return/missing-room refresh tokens matching-campaign, acknowledgement-based, and one-shot across unmount/reopen. Verification passed 180 focused client tests across 5 files, all 207 client tests across 8 files, the contracts build, root contracts/server/client/E2E typecheck, production build with 133 Vite modules, and one deterministic Playwright workflow. The unchanged latest full-suite baseline remains 126 contract tests and 1,641 server tests plus 1 skip across 72 files. No commit was created.

### 2026-08-04: M0 Slice 95 Campaign Room Linking

Exactly 95 M0 slices are complete at unchanged schema v14 revision 1 (v14r1), with exactly 13 trusted-local campaign operations. Strict bounded contracts add safe attached and owner-only eligible room summaries plus exact `{ sessionId }` attachment. Opaque legacy session IDs are preserved without trim/resource validation; display title/name projections are nonprivate, well-formed, bounded, and participant lists are 1–12. Both lists cap at 1,000 with MAX+1 overflow detection and enforce duplicates, disjointness, strict fields, and deterministic timestamp/binary-ID order.


Feature-gated `GET`/`PUT /api/rpg/v1/campaigns/:campaignId/rooms` use fixed unauthenticated `local-owner`, strict campaign path/query/media/body/output binding, `no-store`, 200 responses, and no `Location`. Snapshot authorization masks missing principal ancestry, unknown roles, stale purported owners, structurally malformed preauthorization, and outsiders before presentation evaluation or attributable parsing. Under `BEGIN IMMEDIATE`, attach establishes exact requested-campaign owner authority and inspects attachment attribution first. A foreign link yields the same typed 409 for healthy or corrupt foreign campaign/session/participant data without clock/ID use. Same-campaign metadata plus its full graph must validate before idempotent return; no link requires a complete eligible graph before insertion. Attributable malformed/orphan state is neutral 500 rather than typed missing/conflict, while complete valid stopped unattached state is typed 409. Unexpected PUT status is ambiguous and must be reconciled by GET; automatic retry is forbidden. HEAD/DELETE/OPTIONS and all other scoped RPG misses remain absent and now consistently carry `Cache-Control: no-store`; logs/problems omit session IDs and bodies. Slice 95 adds no client/UI, schema/migration, detach route, remote authentication, dependency, message/content exposure, or automatic retry. Slice 96 is next and requires separate explicit scope.

Final finding remediation verification passed 61 focused room tests across 3 server files; all 1,641 server tests plus 1 skip across 72 files; root contracts/server/client/E2E typecheck; and the production contracts/server/client build with 133 Vite modules. No client, schema, dependency, devplan, or commit changed.

### 2026-08-04: M0 Slice 94 Campaign Dice Client and Detail UI

Exactly 94 M0 slices are complete at unchanged schema v14 revision 1 (v14r1), and the trusted-local campaign boundary remains exactly 11 operations. Strict clients validate the opaque campaign ID and exact visible-character/expression body before network I/O, encode the path, strict-parse ID-free history/roll responses, bind a successful roll to its request, use `no-store` history reads, and contain no retry. App retains mechanics discovery separately from campaign availability and passes it to detail without delaying legacy library/chat startup.

Only mechanics-enabled owner/GM detail exposes the accessible dice panel. Current characters come solely from the history projection as contiguous visible positions and names; duplicate names remain positional and form values contain only position. Canonical schema validation documents examples and limits. Loading, empty, generic error/retry, guarded focus, narrow/mobile layout, and newest-first latest-20 history show character name/time, expression, every physical term with explicit kept/discarded text, modifier, and total. Campaign-character/actor/timeline/revision/command/event/receipt/idempotency identities are absent from DOM, values, ARIA, document URLs, and errors.

Dice joins the exact document-lifetime campaign mutation token used by rename/setup/create. Synchronous locks serialize duplicate submits; Back, workspace Open, and all campaign writes are disabled through write and reconciliation, while one document-wide `beforeunload` warning survives route unmount and campaign switches. POST is issued once and every issued outcome runs exactly one fresh uncached history GET. A strict request-bound 201 confirms the commit; wording separately says whether latest history refreshed and never identifies a particular identity-free entry as that roll or requires presence. Network, 500, malformed success, and other untyped outcomes remain unknown regardless of identical history projections. Exact typed visible-binding 409 and unavailable 404 are known non-commits with distinct safe messages and still reconcile fresh history. Outcome status and a GET-only Refresh rolls action remain outside the history-ready block, including after failed GET; a shared tokenized ref lock limits rapid pointer/key activation of manual Retry and Refresh to one GET until settlement while the internal reconciliation GET remains unaffected. Later refresh success recomputes conservative wording rather than retaining a stale failed-history message. No branch repeats POST or labels known rejection as unknown/retry. Campaign/token/generation/mount guards and single-use handoff cover StrictMode, unmount/reopen, and A→B→A without stale state or focus. The isolated E2E server injects a reviewed deterministic RNG only into its disposable repository, asserts exact term 2/total 5 and unchanged rendered result after reload, and counts exactly one POST, one reconciliation GET, and one reload GET. Production defaults and HTTP behavior are unchanged. No server, route, contract, schema, migration, production dependency, or operation count changed; `docs/api.md` now records current client consumption without changing semantics. Slice 95 is next and requires separate explicit scope.

Finding remediation verification passed the contracts build; 42 focused client tests across 2 files; all 179 client tests across 8 files; root contracts/server/client/E2E typecheck; production contracts/server/client build with 133 Vite modules; and 1 deterministic Playwright workflow. Its inventory includes the prior critical browser/API path and now exact dice term/total, captured reload-stable rendering, exactly one POST, one reconciliation GET, and one reload history GET. Full server tests and live E2E were not requested or run. No commit was created.

### 2026-08-04: M0 Slice 93 Trusted-Local Campaign Dice HTTP Boundary

Exactly 93 M0 slices are complete at schema v14 revision 1 (v14r1), with exactly 11 trusted-local campaign operations: the existing nine workspace operations plus mechanics-gated campaign dice GET/POST. Strict ID-free contracts cap history at 20, require contiguous one-based visible `{ position, name }` characters, bind each newest-first `{ character, occurredAt, result }` roll to that list, and accept POST only as `{ character, expression }`. Newest means array order derived from descending revisions/event identities; canonical timestamps are informational and may regress or repeat. Existing expression/result/name/timestamp contracts are reused; technical IDs, revisions, checks, DCs, narration, and unknown fields reject. POST's factory-only executor revalidates preflight roster position/name and exact campaign-character/actor ancestry under the same immediate transaction before RNG, event identity, clock, or writes.

Factory/UoW `listRecentCampaignDiceEvents(actor,campaign,timeline)` has a caller-invariant 20 limit. Its one explicit query selects the newest 20 dice event identities before the term join, bounding valid output to 2,000 rows, while complete timeline revisions and all attributable command/event/receipt/roll/term variants and orphans remain validated across full history, including corruption beyond the window. Existing all-role repository authorization, masking, cross-campaign isolation, no-dependency reads, and loud authorized corruption remain intact.

The service uses one UoW snapshot to require fixed-caller owner/GM authority, resolve active timeline/revision, current safe ordered roster and internal actors, and either map bounded history or preflight an exact position/name binding. Player, observer, missing, and denied state are non-disclosing; changed visible binding alone is typed conflict. After preflight closes, one separately injected server ID supplies both internal command and idempotency identity, exact `roll_actor_dice` uses null source turn, and the executor is called once without retry. Stale revision, executor/dependency, and commit-then-malformed-output failures remain untyped and commit-ambiguous; reconciliation is GET history and automatic POST retry is forbidden.

Both routes require campaign and mechanics flags, fixed `local-owner`, no raw query, strict path/media/body/output, safe template-only logs, and `no-store`. GET is 200; POST is 201 without `Location`; typed unavailable/binding conflict map to 404/409 and ambiguous writes to neutral 500 requiring refresh. Exact malformed normalization includes this resource while HEAD/other methods remain absent. No dependency, schema/migration, client/UI, caller ID/header, check/DC, narration, or broader mechanics behavior was added. Slice 94 is next and requires separate explicit scope.

### 2026-08-04: M0 Slice 92 Campaign-Character Workspace Client

Exactly 92 M0 slices are complete at schema v14 revision 1, with exactly nine trusted-local campaign HTTP operations unchanged. Slice 92 adds only strict client consumption and read-only UI for the existing workspace GET. The client validates both opaque IDs before request construction, encodes both path segments, and strict-parses the ID-free response. The private `campaign-character` navigation state requires both contract-valid IDs, restores malformed character state to campaign detail and malformed campaign state to campaigns, feature-falls home, and never changes the browser URL.

Roster rows now provide 44px Open character buttons whose technical ID remains closure-owned. Every Open action uses native disabled semantics and a synchronous handler guard while that campaign has any write/reconciliation pending. Duplicate accessible names are distinguished by nonprivate one-based roster position; no campaign-character/persona/campaign technical ID enters visible text, ARIA/title/data/value, DOM IDs/classes, or document URLs. The responsive workspace includes a 44px Back to campaign target, loading, generic local Retry, 404 return to detail, StrictMode in-flight initial-read reuse, and exact mount/campaign/character/generation guards for unmount and rapid switching. App-owned request intents focus the workspace heading only after the exact open succeeds and focus the exact campaign heading only after Back/404 detail loading succeeds; queued stale and post-unmount settlements cannot focus, navigate, or update state. Ready state bidi-isolates and wraps display metadata, shows race/background/classes, and always renders Attributes, Proficiencies, Choices, and Resources with values or exact empty messages. It has no edit, roll, or resource controls.

Finding remediation passed 143 focused client tests across 5 files and all 161 client tests across 7 files. Campaign-detail transition focus is one-shot: App clears only the exact request after the matching loaded heading successfully receives focus, while stale, unmounted, mismatched, and consumed requests cannot clear or replay after Campaigns/reopen. Full contracts/server/client/E2E typecheck, production contracts/server/client build, and one deterministic E2E test also passed. Deterministic mobile coverage verifies stacked workspace cards, no horizontal overflow, long-safe wrapping, 44px Open/Back targets, transition focus, and desktop viewport restoration. No server, route, HTTP behavior, contract, schema, migration, dependency, write, or operation-count change was made; `docs/api.md` remained intentionally unchanged at this historical Slice 92 checkpoint, now superseded by Slice 93 above.

### 2026-08-04: M0 Slice 91 Campaign-Character Workspace Read

Exactly 91 M0 slices are complete at schema v14 revision 1, with exactly nine trusted-local campaign HTTP operations. Slice 91 adds synchronous factory/UoW `getCampaignCharacterWorkspace(actor, campaignId, campaignCharacterId)` and feature-gated `GET /api/rpg/v1/campaigns/:campaignId/characters/:campaignCharacterId/workspace` over Slice 90's strict ID-free contract. One explicit-column SQLite statement owns authorization, target/path binding, resolved exact pinned definitions, ordered child/resource reconstruction, and integrity evidence; factory calls use its statement snapshot and active UoWs retain their enclosing snapshot. There are no writes, dependencies, explicit factory transactions, client, UI, schema, or migration changes.


The route uses fixed `local-owner`, rejects every raw query including bare delimiters (verified over real HTTP), strictly validates both path IDs, binds both internal snapshot IDs, and emits only the strict workspace envelope. The one statement now also rejects campaign-attributable detached/mismatched sheet, actor, private-state ancestry including strict controller membership/principal/role/timestamp evidence, class, attribute, proficiency, choice, and resource evidence beside a valid root without selecting controller identity or private payload; foreign-campaign evidence remains isolated. Root/collection types, timestamps, positions, identities, MAX+1 bounds, and exact race/background/class/choice profile/pin/sealed/definition metadata ancestry are defensive read invariants. Literal null alone maps to non-disclosing `RPG_CAMPAIGN_CHARACTER_NOT_FOUND` 404; malformed/falsey output, path mismatch, open/repository failures, and corruption map to request-correlated neutral redacted 500s with safe template-only logs/problems. Exact malformed normalization covers either workspace ID without widening unknown/lookalike/legacy behavior; HEAD and unsupported methods remain absent, and all nine operations share one cached plugin-owned repository. Finding remediation built contracts first; 112 focused server tests across 2 files, server source/test typecheck, production server build, and the full server suite with 1,581 passed and 1 skipped across 68 files passed. Slice 92 is next and requires separate explicit scope.

### 2026-08-04: M0 Slice 90 Interim ID-Free Character Workspace Contracts

Exactly 90 M0 slices are complete at this interim contracts-only checkpoint. Schema v14 revision 1 and exactly eight trusted-local campaign HTTP operations remain unchanged. Strict shared `CampaignCharacterWorkspaceResponse` schemas expose only `{ character: { name, race, background, classes, attributes, proficiencies, choices, resources } }`: race/background and ordered classes carry display name/description, classes carry bounded integer levels, attributes carry label/value, proficiencies carry category/label, choices carry label plus `{ kind, name, description }` selection, and resources carry label/current/max. Character/race/background/class/selection names remain content metadata.

All objects are strict and ID-free. Campaign/persona/character/sheet/actor/controller/pack/reference/timestamp/private identities and fields reject at every nesting level. Attribute, proficiency, choice, and resource labels no longer accept generic content names: they require exact one-based `Attribute N`, category-specific forms such as `Skill proficiency N`, `Choice N`, and `Resource N`, with the index matching array position and bounded by the corresponding collection maximum. Arbitrary colon, UUID, and resource-looking technical IDs, wrong field/category prefixes, zero, and out-of-range indices reject. Producers can therefore represent unknown generic IDs by position without exposing or humanizing them. Existing class/level/attribute/proficiency/choice/content-text/resource-amount bounds and types are reused; workspace resources have a 128-entry maximum. Mandatory arrays may be empty and preserve order; resource current cannot exceed max. Thorough contract tests cover strict nesting, prohibited IDs/private fields, IDs in every label field, valid positional labels, category/position/range failures, mandatory fields and empty arrays, maxima, malformed UTF-16 content metadata, types, numeric/resource invariants, and duplicate consistency.

Slice 90 adds no server, client, route, HTTP/API, schema, migration, repository, UI, or gameplay behavior. `docs/api.md` is intentionally unchanged because there is no HTTP change. Finding remediation built contracts into `dist`, passed contract source/test typecheck, and passed 122 contract tests across 8 files. The prior server 1,521 passes plus 1 skip across 67 files and client 145 passes across 6 files remain historical and were not rerun. Slice 91 is next and remains unimplemented pending separate explicit scope.

### 2026-08-04: M0 Slice 89 Deterministic Closeout

Exactly 89 M0 slices are complete at schema v14 revision 1 and exactly eight trusted-local campaign HTTP operations. Slice 89 is deterministic closeout only and adds no feature. After all Slice 88 remediation, its second independent server review, second independent client review, and contracts/closeout review reported no findings.

The mandated root gate ran in exact order: `npm run typecheck` passed; `npm run build` passed with 130 Vite modules transformed; `npm test` passed with contracts 104 across 7 files, server 1,521 passed plus 1 skipped across 67 files, and client 145 across 6 files; `npm run test:e2e` passed 1 test. The unit total is 1,770 passed plus 1 skipped, and the deterministic total is 1,771 passed plus 1 skipped. Live E2E was explicitly excluded and not run. Prior slice gates and focused verification records below are historical.

Trusted-local `local-owner` remains an unauthenticated local single-user convenience, not authentication and unsafe for remote or multi-user exposure. Campaign-character POST outcomes remain commit-ambiguous on an unexpected 500: there is no automatic POST retry, and authoritative roster plus creation-options GET reconciliation is required. Existing exclusions and the production backup/restore procedure remain unchanged. Lowercase `handoff.md` and `devplan.md` remain intentionally absent. This documentation synchronization changed no code or tests, created no file, ran no verification command, and created no commit. No next implementation slice is approved; future work requires explicit separate scope.

### 2026-08-04: M0 Slice 88 Review Remediation And Independent Closeout

Exactly 88 M0 slices are complete at schema v14 revision 1 and exactly eight trusted-local campaign HTTP operations. First review found five bounded defect groups: incomplete roster owner-integrity validation after non-owner authorization; stale completed-create reopen wording after fresher reads; stale setup options across unmount/reopen or A→B→A; incomplete Options Retry focus/announcements; and documentation drift.

The first remediation preserves stale purported-owner and outsider masking, then validates exact `campaigns.owner_role`, the sole pointer-matching owner membership, intact owner principal, and strict owner row in the roster's existing one-statement snapshot. Authorized corruption is loud through the existing redacted 500 route behavior. Reopen consumes its create handoff and owns one fresh roster/options pair shared across StrictMode replay, recomputing newer absent/unused or failed-read outcomes. Follow-up client review found two additional defects: pending pre-setup options could settle over setup state, and required post-setup options refresh intent could be lost after failed detail reconciliation and later Retry. Their remediation makes setup completion immediately supersede pending pre-commit options, evict their reusable promise, and hide stale form/error state. The required refresh intent is module-owned by campaign, survives reconciliation failure, Retry generations, unmount/reopen, and A→B→A, and is consumed only when a current exact-starter detail success starts the fresh options GET (or detail 404 makes the campaign definitively unavailable). Options Retry retains campaign/generation focus intent and guarded queued focus. No write or POST/PUT retry was added.

Final disposition after remediation: the second independent server review reported no findings, the second independent client review reported no findings, and the contracts/closeout review reported no findings. Slice 88 is complete. Its verification was focused/ad hoc rather than an exact full closeout gate: contracts built and all 104 contract tests passed; 249 focused server and 59 focused campaign-detail tests passed; all 145 client tests passed; root/E2E typechecks and production build passed with 130 Vite modules; and deterministic Playwright passed 1 test. Live E2E was not run. This is a historical Slice 88 checkpoint and was subsequently superseded for current exact-gate status by Slice 89 above.

### 2026-08-04: M0 Slice 87 Finalized Original-Starter Campaign-Character UI

Exactly 87 M0 slices are complete at schema v14 revision 1. The trusted-local campaign HTTP boundary remains exactly eight operations; no server, contract, schema, migration, navigation-state, or HTTP behavior changed. Strict client wrappers now path-bind creation options and validate the exact `{ characterId }` request plus character-ID-bound create response. The create wrapper issues one POST and has no internal retry.

Only an exact configured original-starter detail plus a valid options 200 exposes the accessible finalized metadata-only form. It displays the fixed profile, pack, race, background, and level-1 class read-only, preserves persona order and duplicate display names, shows used personas nonselectably, and requires both one unused existing persona and the exact visible single-use finality confirmation. Names use `bdi dir="auto"`; visible nonprivate position text distinguishes duplicate accessible names while closure/index controls retain opaque IDs outside all DOM text, values, attributes, ARIA, and URLs. Initial options failures including 404 remain local with GET-only retry. Options and form expose independent `aria-busy`; visible polite loading/refreshing status and narrow-layout regression coverage preserve the full warning without overflow.

Create is a third exact campaign/token mutation kind serialized synchronously with rename/setup across unmount/reopen and campaign switches. After every issued POST outcome the operation itself owns exactly one fresh concurrent roster/options GET pair and never retries POST. A reconciliation completed while no matching page can receive it is retained for exactly one matching reopen, consumed at handoff, and retained only in that component across StrictMode effect replay. It may supply interim outcome/data but does not increment roster/options generations or invalidate the reopen's newer initial promises; those fresh authoritative GETs win regardless of settlement order, and a second reopen cannot replay the old snapshot. If fresh reads fail, the conservative handed-off outcome and paired GET-only **Refresh character status** remain available. Live operation completion still supersedes reads that predate its POST after exact campaign/detail/token/generation checks, so stale A cannot touch B.

Mutation presence is tracked document-wide separately from displayed-campaign busy state. One `beforeunload` listener remains installed while any campaign mutation/write/reconciliation token exists, survives A→B switching and detail unmount, and is removed only after the final token settles. B's controls and back action remain usable while only A is pending; per-campaign duplicate and navigation guards remain unchanged. Component mutation subscriptions clean up on unmount without clearing module ownership or reload protection.

Final Slice 87 race-remediation verification built contracts first and passed its focused/client/typecheck/build/E2E gates. This historical checkpoint is superseded by the Slice 88 remediation above.

### 2026-08-04: M0 Slice 86 Read-Only Campaign-Character Roster UI

Exactly 86 M0 slices are complete at schema v14 revision 1. The trusted-local campaign HTTP boundary remains exactly eight operations. Slice 86 adds only the runtime-validated client `listCampaignCharacters(campaignId)` over the existing roster GET and Slice 80 strict shared response. It validates the untrimmed 1–128 character resource ID before interpolation, URL-encodes it, and rejects unknown/private/malformed response fields and duplicate opaque identities through the shared contract.

Campaign detail now shows an accessible responsive names-only roster for owner, GM, player, and observer views, whether content is configured or unconfigured. It preserves server order and duplicate display names, distinguishes authorized empty state, and renders names in `bdi dir="auto"`; valid RTL, astral, and maximum 200-code-unit Unicode remains isolated and wraps at narrow widths. No campaign-character/persona ID appears in visible text or any DOM attribute (React keys alone retain the campaign-character ID). The roster owns `aria-busy` independently from outer mutations, keeps a persistent polite completion/empty announcement, focuses its heading after successful retry, and restores the retry control after repeated failure. Retry-focus intent is scoped to the exact campaign and roster generation; only its matching completion may focus, compatibility 404/switch/cleanup/unmount clear it, and a queued callback rechecks mount, campaign identity, and generation. It exposes no controller/private/raw fields and no create/edit/delete/select control, options request, POST, or form. A roster 404 silently compatibility-falls back without calling detail unavailability; every other failure remains a local generic alert with a GET-only retry.

Roster requests use their own monotonic generation plus mounted and exact-campaign guards. Initial per-campaign detail and roster promises are reused only while in flight so React StrictMode replay attaches a current generation without a duplicate network call; explicit retries and mutation reconciliation bypass reuse and issue fresh GETs. Module mutation ownership is keyed by campaign and exact operation token with idempotent release, allowing A and B writes to overlap across prop switches without one completion clearing the other. Returning to A while its operation is pending remains navigation-blocked, then performs authoritative GET reconciliation and restores mutation focus when A releases; the duplicate-write guard is unchanged in strength. Roster loading/retry never joins write busy state, back-navigation blocking, reload warnings, or mutation focus. Findings-remediation verification built contracts first, passed 103 focused API/detail/App/navigation tests and all 121 client tests, and passed client typecheck, production build with 130 Vite modules, E2E typecheck, and one deterministic Playwright workflow. No server, contract, schema, migration, HTTP, navigation-state shape, form, options, create POST/client, or gameplay behavior changed. `docs/api.md` remains the historical API checkpoint and was not edited. Slice 87 is next and unimplemented pending explicit scope.

### 2026-08-04: M0 Slice 85 Trusted-Local Original-Starter Campaign-Character POST

Exactly 85 M0 slices are complete at schema v14 revision 1, with exactly eight feature-gated campaign HTTP operations. Slice 85 exposes `POST /api/rpg/v1/campaigns/:campaignId/characters` over the Slice 84 `createOriginalStarterCharacterCreationService` and unchanged Slice 80 strict contracts. The request is exactly `{ characterId }`; campaign comes only from a strict 1–128 character path, while controller `local-owner`, fixed starter content, sheet/actor/private state, IDs, and timestamps remain server-owned. Success is strict path/request-bound `201 { character: { id, characterId, name } }` without `Location`.

Validation is disabled-first, then any raw query delimiter (including bare `?`), strict path, exact `application/json` with only optional charset, and a single generic malformed/empty/schema-invalid 400. Invalid requests do not open the repository. A valid request creates the fixed service once, which performs one options preflight and at most one specialized atomic write; no idempotency or automatic retry was added. Only exact typed service unavailable/persona/conflict errors map to non-disclosing campaign 404, stable persona 404, and redacted 409. Same-code lookalikes, repository/open/SQL/dependency/corruption failures, falsey/malformed output, and output/request mismatch are correlated generic 500s. Their exact outcome-neutral detail says creation status is unknown, requires authoritative character-list and creation-options GET reconciliation, and says never to retry automatically; it never claims rollback or exposes cause/campaign/persona identity. Shared strict safe persona names reject malformed UTF-16 while preserving valid astral pairs across options, list, and service output.

POST joins method-sensitive malformed/overlong exact `/characters` normalization and never retries automatically. This is a historical Slice 85 checkpoint; Slice 86 was subsequently completed.

### 2026-08-04: M0 Slice 84 Atomic Original-Starter Campaign-Character Creation Service

Exactly 84 M0 slices are complete, with schema v14 revision 1 and exactly seven campaign HTTP operations unchanged. The generic factory-only `Repository.createCampaignCharacter` remains content-generic: valid campaigns may use any strict selected profile and complete sealed pinned pack graph. Its immediate transaction masks missing/denied actor state before attributable validation and validates authority, controller, persona, selected profile, every pin, every sealed parent, and every requested race/background/class/choice definition. Requested-definition absence or corruption is decided before a complete same-campaign duplicate may become a typed conflict, and generic zero-pin state remains malformed. Same persona in another campaign remains valid.

`server/src/content/originalStarterCharacterCreation.ts` accepts strict campaign ID and reduced `{ characterId }`, fixes actor/controller/content, and preflights exact reviewed options once for selection/status. It then calls the dedicated factory-only `Repository.createOriginalStarterCampaignCharacter` exactly once with a complete `CreateCampaignCharacterInput`; the method is absent from UoWs and wrappers and reuses the generic atomic helper. Under the same immediate lock, the specialization additionally requires the exact selected original profile, exactly the sole starter pin, exact sealed profile/pack metadata, all and only reserved definitions with exact metadata, and fixed Avelune/Rainledger/level-1 Pathmender/empty arrays/null notes. Compatible post-preflight pin or selected-profile/configuration drift, including removal to the contract-valid zero-pin state, is typed conflict before generic missing-pin handling; malformed metadata remains untyped. No create dependency, aggregate write, or retry occurs on either path. The service intentionally uses existing parent-backed campaign owner/GM creation authority, not starter setup's dual application-owner/campaign-owner authority. Application ownership is distinct and neither bypasses nor adds a required character-creation gate; `local-owner` may remain a valid campaign GM and controller. A stale owner without GM authority remains unavailable, while malformed owner state is untyped for an attributable GM. The specialized locked method returns internally both its validated privileged projection and the current safe bounded persona display name from the same transaction; generic `createCampaignCharacter` retains its existing public projection return. The service strict-parses and semantically proves the privileged projection internally, then returns only strict `{ character: { id, characterId, name } }` using the locked current name, with no post-write read/retry; controller, notes, sheets, actors, timestamps, and raw aggregates cannot escape it. A deterministic post-preflight rename race proves the response equals the committed current durable profile, and name corruption remains untyped with no write.

Private-note contracts now reject every lone/unpaired UTF-16 surrogate before persistence while retaining the Unicode-code-point limit and valid 4,000-astral behavior for creation and privileged reads. Contracts were built first; all 103 contract tests passed, as did 233 focused server tests across eight generic creation, creation-options, original-starter service/setup/manifest, role-sensitive, and route files, followed by server source/test typecheck and production build. `docs/api.md` remains the historical Slice 83 HTTP checkpoint because no HTTP changed. No schema, migration, route, client, UI, RNG, or gameplay surface changed. Slice 85 is next and remains unimplemented pending explicit scope.

### 2026-08-04: M0 Slice 83 Trusted-Local Safe Campaign-Character Roster GET

Exactly 83 M0 slices are complete, with schema v14 revision 1 unchanged and exactly seven campaign HTTP operations. Slice 83 adds only synchronous factory/UoW `getCampaignCharacterRoster(actorPrincipalId, campaignId)` and feature-gated trusted-local `GET /api/rpg/v1/campaigns/:campaignId/characters`, reusing Slice 80's strict public roster contract and Slice 81's bounded safe legacy-name projection. One explicit-column SQLite statement yields an internal path-bound snapshot: factory calls receive one implicit statement snapshot and active UoWs retain their enclosing snapshot. Existing parent-backed owner/GM/player/observer list authorization is preserved; stale purported owners, missing authorization parents, outsiders, and missing campaigns return `null`, while an authorized empty campaign returns a non-null empty snapshot. The campaign-attributable orphan aggregate is independent of the nullable campaign-character join, so empty authorized rosters still reject orphan sheet descendants, private state, actor resources, sheets, and actors, including resources with missing or cross-campaign actor/character ancestry and descendants left behind when their root moves cross-campaign; foreign-campaign evidence remains non-attributable. Nonempty summaries contain only campaign-character ID, opaque persona ID, and current bounded display name, ordered by `campaign_characters.created_at` then binary ID. Integrity evidence rejects attributable aggregate parent/ancestry corruption without selecting or projecting resource data, controller identity, private notes, command data, sheets, actors, or unrelated persona fields. The 1,000-entry bound is enforced through MAX+1 selection. The read requires no campaign configuration or starter, performs no write, and consumes no clock, ID, or RNG dependency.

The route always delegates as fixed unauthenticated trusted-local `local-owner`, validates a strict 1–128 character path, rejects every raw query delimiter including bare `?`, strict-parses the public `{ characters: [{ id, characterId, name }] }` envelope, and verifies the internal campaign ID against the decoded path before removing it. Literal `null` alone is the non-disclosing campaign 404; `undefined`, other falsey values, malformed output, wrong-path output, repository exceptions, and cached open failures are request-correlated redacted 500s. Authorized empty returns `200 { characters: [] }`. Every scoped campaign catch now logs only generic operation/method/route-template context through the request logger and never serializes a caught exception, stack, SQL/schema/output detail, or private field name/value. Cached open errors therefore remain non-disclosing across repeated roster, creation-options, and existing campaign requests. Body redaction is unchanged. HEAD and every other method remain absent. Exact roster malformed-percent/overlong paths join only the reviewed router normalization set: disabled-first, supported-method query-before-path failure, unsupported-method absence, path-only problem instances, and no query reflection. The route shares the existing lazy cached repository success/failure and one-close lifecycle.

Contracts were built first. The final remediation gate passed 232 repository/role-sensitive/campaign-route/security/problem tests across eight files, including production logging coverage, followed by successful server source/test typecheck and production build. Slice 83 adds no contract change, create service, POST, client, UI, schema, migration, dependency, write, starter/configuration requirement, authentication, or gameplay. Slice 84 is next and remains unimplemented pending explicit scope.

### 2026-08-04: M0 Slice 82 Trusted-Local Campaign-Character Creation Options GET

Exactly 82 M0 slices are complete, with schema v14 revision 1 unchanged. Slice 82 adds only feature-gated `GET /api/rpg/v1/campaigns/:campaignId/characters/creation-options` over the existing Slice 81 factory repository method and Slice 80 strict response contract. It accepts one strict 1–128 character resource ID and no query, disables automatic HEAD, ignores caller identity and delegates only as fixed trusted-local `local-owner`; the repository applies parent-backed owner/GM creation authority to that fixed principal. Literal repository `null` maps to the same non-disclosing `RPG_CAMPAIGN_NOT_FOUND` 404 used for missing or denied campaigns. Success strictly parses and path-binds `{ campaignId, personas, starter }`, preserving repository persona order while exposing only safe summaries and exact basic finalized starter metadata, never full legacy/private projections.

The route shares the exact existing lazy plugin-owned repository cache, including cached open success/failure and one close for a successfully opened repository. Only literal `null` means unavailable; `undefined`, `false`, `0`, the empty string, exceptions, open failures, malformed objects, and schema-valid wrong-path output become request-correlated redacted `RPG_INTERNAL_ERROR` 500 problems. Disabled requests return `RPG_ROUTE_NOT_FOUND` before query/path/repository work. For every normalized exact campaign resource shape, pre-routing malformed-percent and overlong requests preserve feature denial first; supported methods otherwise reject any raw query delimiter, including a bare trailing `?`, as a route-appropriate structured 400 before campaign-ID 404, while unsupported methods remain absent as correlated `RPG_ROUTE_NOT_FOUND`. They do not open the repository or disclose query values. Every structured problem instance is derived as path-only, and unknown/default, legacy, and lookalike fallbacks preserve compatible JSON/code/status while removing queries from reflected messages. The authoritative global router cap remains 128 for strict RPG IDs; the already-approved Slice 72 compatibility consequence is that legacy 101–128-character parameters reach their existing handlers rather than being reduced to the former default cap. This trusted-local endpoint has no caller identity and is not authentication or a remote/multi-user security boundary.

Contracts were built first. The final focused gate passed 123 tests across five files: the combined campaign route gate passed 111 tests across the creation-options route file, existing campaign route file, and starter-setup route/repository file, including the 21 dedicated creation-options tests; the focused security/problem/default-fallback gate passed 12 tests across two files. Server source/test typecheck and production build passed. Production request logging remains enabled with a method/path-only serializer that excludes query strings, request headers, and the top-level request ID binding. Slice 82 adds no service, campaign-character list/create operation, client, UI, schema, migration, write, gameplay, rules-complete builder, or automatic installation. Slice 83 is next and remains unimplemented pending explicit scope.

### 2026-08-04: M0 Slice 81 Campaign-Character Creation-Options Repository Read

Exactly 81 M0 slices are complete, with schema v14 revision 1 unchanged. Slice 81 implements only the bounded synchronous `getCampaignCharacterCreationOptions(actorPrincipalId, campaignId)` read on the repository factory and active unit of work. The read uses one explicit-column SQLite statement: factory calls receive one implicit statement snapshot and UoW calls retain the enclosing transaction snapshot. It does not compose named legacy wrappers, perform independent reads or writes, or consume clock, ID, or RNG dependencies.

The operation authorizes only parent-backed owner/GM creation authority. An owner must still match the raw campaign owner pointer; missing, denied, stale-owner, player, observer, and outsider requests are masked before attributable reconstruction. Once authorized, the read requires a strict campaign including exact `campaigns.owner_role`, exact sole owner membership and principal parent, active timeline parent, valid configuration/profile/pack graph, bounded personas, and bounded valid same-campaign campaign-character links. Authorized parent, content, persona, link, malformed, and persona/link/pin overflow states fail loudly. Every offered persona must have exact persisted `fictional_confirmed = 1` and `is_real_person = 0`. Personas include only `{ characterId, name, alreadyUsed }`, are ordered by `characters.created_at` then binary ID, and `alreadyUsed` considers only the requested campaign. A supported overlong legacy name is projected without storage/API changes to a well-formed UTF-16 value of at most 200 code units, never splitting a surrogate pair; if the ordinary bounded prefix is whitespace-only, projection retries from the first visible code point. Empty, whitespace-only, or malformed UTF-16 names fail loudly.

The response is available only when the campaign selects exactly the reviewed starter rules profile and exactly one pin for the reviewed sealed starter pack, with exact stored profile/pack metadata and the complete reserved definition namespace. As with original-starter setup integrity, extra definitions in the reserved pack and expected reserved definition IDs captured by any other pack/version fail loudly. The fixed basic finalized metadata is strict-output parsed and path-bound to the requested campaign. Persona/link and campaign/owner integrity is proven before a valid unconfigured or differently configured campaign returns `null`. This remains metadata scaffolding, not a rules-complete builder.

Contracts were built before server verification. The dedicated repository file passed 41 tests, including lifecycle, dependency nonuse, statement shape, deterministic ordering, same/other-campaign usage, safe legacy-name projection including a leading-whitespace retry, strict persona eligibility, all bounds, complete reserved namespace, unsupported-configuration attribution, masking, parent/content/persona/link corruption, and an actual WAL snapshot test. The expanded starter setup/manifest/content-read/Slice-81 gate passed 108 tests across four files. Server typecheck and build passed. Slice 81 adds no route, HTTP operation, service, client, UI, schema, migration, write, authentication, or gameplay behavior; `docs/api.md` is unchanged. Slice 82 is next and remains unimplemented pending explicit scope.

### 2026-08-04: M0 Slice 80 Interim Contract Checkpoint

Exactly 80 M0 slices are complete, with schema v14 revision 1 unchanged. Slice 80 adds only strict shared campaign-character HTTP contracts: campaign-scoped creation options with bounded unique safe legacy persona summaries and exact basic finalized starter metadata; minimum public `{ id, characterId, name }` roster summaries and list envelope; exact `{ characterId }` create input; and a create response reusing the public summary. Opaque legacy persona IDs are preserved. Public outputs structurally reject campaign/controller/private/raw fields, and duplicate identities, bounds, complete exact references, starter links, fixed metadata, and level 1 are contract-enforced.

Fixed profile, pack, race, background, and class literals now come from one shared source while preserving `velvet:original-starter@1.0.0+d15042935818` and the current server manifest identity/version. These are explicitly basic finalized metadata records, not a rules-complete builder. Slice 80 adds no repository, server, route, HTTP behavior, client, UI, schema, migration, authentication, gameplay, derived mechanics, draft flow, arbitrary content selection, or manifest content change. `docs/api.md` is unchanged because the exposed five-operation campaign HTTP boundary did not change.

Verification built `@velvet/contracts` successfully. The focused command passed exactly 52 tests across `test/contracts.test.ts`, `test/rpg-characters.test.ts`, and `test/rpg-character-http.test.ts`. Slice 81 is next but remains unimplemented; its exact runtime scope requires a separate explicit instruction.

### 2026-08-04: User-Approved M0 Slices 72-79 Batch

At this historical checkpoint exactly 79 M0 slices were complete. Slice 79 independently remediated the bounded Slices 72–78 findings and added no new product feature. Final server, client, and original-starter content reviews had no remaining findings. Detailed checkpoints remain below as historical records.

The broad domain, migration, API, and frontend sections of this document remain aspirational and do not widen that approved sequence. The order was intentional: Slice 74 preceded its Slice 75 owner UI, and Slice 76's original manifest preceded Slice 77 setup API and Slice 78 setup UI before Slice 79 review.

Legacy compatibility remains explicit throughout the batch: named legacy character deletion must report the existing `in-use` result (and unchanged HTTP 409 behavior) whenever a campaign character references that Velvet persona, just as it does for direct session and participant-junction references. It must not degrade into a foreign-key/cascade failure; deletion is released only after every reference is removed.

### 2026-08-04: M0 Slice 79 - Slices 72–78 Review Remediation (Complete)

Campaign detail output is bound to the path ID. Rename denial masks corruption before attributable validation for actors not matching the raw owner pointer, while the purported owner receives loud invariant failure. Every successful rename persists a validated timestamp strictly greater than the observed token using `max(clock, previous + 1ms)`, including same-name writes and equal/backward clocks; no old token can succeed again. Ambiguous PATCH failures perform one GET but never infer attribution from a matching nonunique name or unrelated timestamp.

Setup inspection validates attributable campaign state, then safely reads raw configuration identity before general detail reconstruction. A campaign pinned to the exact starter profile/pack receives the stable typed conflict when either required reserved row is missing or malformed, without writes, repair, private leakage, or masking unrelated authorized campaign corruption; unconfigured behavior is unchanged. Both specialized setup transactions revalidate, after their immediate lock and before their first write, the sole canonical local application owner, sole canonical campaign owner membership/principal/pointer, complete campaign setup state, exact reserved profile ID, reserved pack ID across all versions, and every expected/captured reserved definition ID. Foreign-version and authority/duplicate/malformed-owner lock races prevent writes. Missing, extra, malformed, captured, wrong-version, unsealed, and incomplete namespace state conflicts without overwrite or repair. Setup success is client-bound to `actorRole: owner` and exact configuration.

Optional RPG feature discovery no longer stalls legacy library or restored chat. Persisted campaign IDs are contract-validated before navigation restoration. Rename/setup share a module in-flight guard across unmount/reopen, disable in-app back navigation and warn on reload, and do not retry automatically; browsers cannot guarantee reload cancellation, so full-reload ambiguity is explicitly retained. The starter version `1.0.0+d15042935818` includes the canonical versionless-manifest digest prefix. Provenance now identifies reviewer/date, retained exact queries plus summarized observations, and explicitly states that exact result pages are nonreproducible because URLs, ordering, provider, region, and review time were not retained; UI states that names are nonunique, review is limited, no distribution license is granted, and wording/concepts are original.

Verification commands and count meanings: contracts were built before the focused server run, whose four files passed 110 tests; the expanded setup file now contains 32 tests. The prior final focused client command covered API, App, navigation, and campaign detail and passed 86 tests; no client production code changed in this final remediation. Root typecheck and production build passed, with 129 Vite modules transformed. Final full units passed 85 contracts, 1,330 server plus 1 skipped, and 104 client: 1,519 passed plus 1 skipped. Deterministic Playwright then passed 1, yielding 1,520 deterministic passes plus 1 skip. Its single workflow covers create/open/rename, authoritative back-list refresh, explicit setup confirmation, configured read-only identifiers, and reload. Live E2E was not run because no live-provider behavior changed.

### 2026-08-04: M0 Slice 78 - Confirmed Original Starter Setup UI

At the Slice 78 checkpoint, Slices 72–78 were implemented and Slice 79 remediation had not yet closed; schema v14 revision 1 was unchanged. `setupOriginalStarter(campaignId)` validates the untrimmed campaign ID, sends only `{ "starterId": "velvet:original-starter@1.0.0+d15042935818" }`, runtime-parses `CampaignDetailResponse`, and requires the exact owner/configured profile and pack result. The version build suffix is tied to the canonical content digest. A strict shared client-safe presentation constant owns profile, pack, race, background, and class names/descriptions; it is contract-parsed, recursively frozen with deep-readonly typing, and consumed by the server manifest so request, preview, and installation identities cannot drift.

Only an exact owner viewing an unconfigured campaign sees the responsive metadata preview and setup action. It explicitly says the starter is metadata scaffolding with no playable mechanics, gameplay, or character creation; setup is final; setup uses two transactions; and the pack may remain installed if configuration fails. An accessible checkbox confirmation is required before PUT. A synchronous ref lock blocks rapid duplicate clicks and disables setup plus rename controls. Non-owners and all configured campaigns receive no setup mutation; configured identifiers remain read-only with no reset, change, or add controls.

After success or any uncertain failure, the client performs one authoritative detail GET and never automatically repeats PUT. Exact reconciled setup becomes configured read-only state; a different configuration, reserved-exact-identity 409, authority 404, generic failure, partial two-transaction outcome, and failed reconciliation receive distinct redacted handling. Shared monotonic generations and a module in-flight guard prevent stale results and duplicate writes across unmount/reopen. Navigation is disabled while pending. A full reload loses JavaScript in-flight knowledge, so its outcome remains ambiguous and must be reconciled without automatic retry.

Contracts were built first. Focused tests passed: 29 contract, 7 manifest, 16 server setup, and 43 API/detail. Root typecheck, production build, full unit tests, and deterministic E2E passed: 85 contract tests, 1,310 server tests with 1 skipped, 100 client tests, and 1 Playwright test, for 1,496 passes and 1 skip; Vite transformed 129 modules. Client coverage explicitly fixes malformed-success and uncertain-failure reconciliation, 409-unconfigured behavior, and failed generic/409/detail-refresh outcomes without PUT retry, including stable state, message, and focus. E2E covers create, open, explicit confirmation, setup, and configured reload. Live E2E was not run because Slice 78 has no provider integration.

### 2026-08-04: M0 Slice 77 - Explicit Trusted-Local Original Starter Setup API

Exactly seventy-seven slices are complete, with schema v14 revision 1 unchanged. Slice 77 adds a fixed exported starter ID, strict literal-only request, minimal campaign-detail response, and feature-gated `PUT /api/rpg/v1/campaigns/:campaignId/starter-setup`. It accepts exact JSON and no query, disables HEAD, ignores spoofed identity, uses fixed trusted-local `local-owner`, validates exact output, shares the cached repository, and emits stable request-correlated 400/404/409/redacted-500 problems. It accepts no arbitrary starter ID or caller content and adds no client or UI.

Setup has dual authority: one preflight snapshot requires the complete current local application owner and exact campaign parent/owner membership. The generic install/configure APIs remain unchanged; setup uses two specialized immediate transactions. Slice 79 strengthens each transaction to recheck full dual authority, setup state, and all reserved exact identities after lock acquisition before writing. Different configuration and reserved exact profile/pack-all-versions/definition-ID collisions are typed conflicts. Inspection compares the entire definition set/count across all kinds. Missing/denied state is non-disclosing unavailable. The transactions are convergent, not atomic, with no repair, overwrite, hidden retry, or automatic startup.

The manifest remains metadata, not playable mechanics. Nothing is installed or configured automatically at startup. Slice 77 adds no schema, migration, client, UI, Slice 78, or live-provider behavior.

Contracts were built first. The expanded focused starter repository/service/route suites passed 23 tests. Root typecheck, production build, full unit tests, and deterministic E2E passed: 83 contract tests, 1,310 server tests with 1 skipped, 86 client tests, and 1 Playwright test, for 1,480 passes and 1 skip; Vite transformed 129 modules. Live E2E was not run because Slice 77 has no provider integration.

### 2026-08-04: M0 Slice 76 - Server-Owned Original Starter Manifest

At the Slice 76 checkpoint, one complete server-owned literal was parsed by `installContentPackInputSchema` at module import and recursively frozen. Fixed namespaced IDs and version identify one newly written class (`Pathmender`), race (`Avelune`), and background (`Rainledger`); the required item, spell, ability, and enemy arrays are present and empty. The payload contains metadata only and no mechanics, grants, paths, files, or third-party rules text.

The adjacent provenance record documents clean-room authorship and a limited public-web similarity review. That review found unrelated fantasy-adjacent public uses of Avelune, including a fantasy book title and a World Anvil character/deity article, and a user-created World Anvil Pathfinder 2e world that references a player character named Pathmender. Velvet does not claim either name is unique. The review found no evidence that this manifest was copied from, derived from, endorsed by, or associated with those uses or with Pathfinder/Paizo, but it was not exhaustive and remains an authorship/similarity note rather than legal advice or trademark clearance.

The reproducible SHA-256 covers canonical UTF-8 JSON of the contract-parsed manifest with only `packVersion` omitted: keys are sorted, array order retained, and no whitespace added. The version build suffix contains the first 12 digest characters; tests prove changed content has a different required identity. Slice 76 itself added no runtime install.

Slice 76 verification built contracts first and passed all 7 focused manifest tests, root typecheck, production build, and full unit tests. Contracts passed 82, server passed 1,294 with 1 skipped, and client passed 86, for 1,462 deterministic unit-test passes and 1 skip; Vite transformed 129 modules. Deterministic and live E2E were not run because Slice 76 itself had no startup, API, UI, or live integration.

### 2026-08-04: M0 Slice 75 - Owner Campaign Rename UI

Exactly seventy-five slices were complete at this checkpoint, with schema v14 revision 1 unchanged. Slice 75 adds the runtime-validated rename client and owner-only inline campaign-detail form over Slice 74. It preserves the required `expectedUpdatedAt`, permits same-name writes, synchronously blocks duplicates, never automatically retries PATCH, reconciles stale and ambiguous results with one authoritative detail GET, and guards all asynchronous completions against stale operations, campaign switches, and unmounts. Non-owners receive no rename control, private identities remain absent, and returning to the campaign library triggers an authoritative list refresh. Slice 75 added no server, schema, setup, manifest, authentication, gameplay, or live-provider behavior.

Slice 75 built contracts first, passed 51 focused API/detail/App tests and all 86 client tests, then passed the deterministic root gate in order. Contracts passed 82, server passed 1,287 with 1 skipped, client passed 86, and deterministic Playwright passed 1, for 1,456 passes and 1 skip; Vite transformed 129 modules. E2E covered create, open, rename, reload, and authoritative back-list refresh. Live E2E was not run.

### 2026-08-04: M0 Slice 74 - Typed Stale-Safe Campaign Rename

At the Slice 74 checkpoint, the factory-only stale-safe rename used an exact timestamp precondition and one conditional immediate-transaction write. Slice 79 supersedes its non-backward timestamp rule with strict advancement beyond the observed token and masks denied actors before attributable corruption validation. Typed unavailable/stale remain non-disclosing 404/409; other failures remain redacted 500. Same-name requests remain writes and no retry exists.

The HTTP boundary requires output ID/name to match the operation and `updatedAt` to be strictly greater than `expectedUpdatedAt`; equal, wrong-ID, wrong-name, and older outputs are redacted 500s.

Focused verification passed all 82 contract tests and all 53 campaign-route tests. The required deterministic root gate then passed in exact order: typecheck, production build, full tests, and E2E. Contracts passed 82, server passed 1,287 with 1 skipped, client passed 76, and deterministic Playwright passed 1, for 1,446 deterministic passes and 1 skip. Vite transformed 129 modules. Live E2E was not run.

### 2026-08-04: M0 Slice 73 - Read-Only Campaign Detail Client

At the Slice 73 checkpoint, campaign detail validated strict untrimmed IDs before interpolation. Slice 79 also validates persisted `campaignId` during navigation parsing; invalid values reconcile directly to campaigns while all other compatibility fields retain their prior semantics.

Campaign cards now provide an explicit accessible Open action without changing the authoritative post-create refresh, announcement, or created-card focus. The responsive read-only detail page shows only campaign name, requesting local role, creation/update dates, and configured/unconfigured rules-profile and content-pack identifiers. It contains no owner principal, active timeline, rename, setup, campaign-character, delete, mechanics, or other mutation/gameplay control. Loading is explicit; generic transient errors are redacted and retry on the retained route; detail 404/unavailability reconciles to campaigns. A monotonic generation and mounted guard cover retries, campaign-ID changes, stale completions, rapid switches, and unmounts so old data cannot overwrite the current campaign or update an unmounted page. Back returns detail to campaigns.

Contracts were built before implementation. Focused API, navigation, campaign-library, campaign-detail, and App tests cover strict input/output validation, persistence/restoration and feature fallback, explicit Open/focus behavior, approved/private field absence, configured/unconfigured projection, transient retry, 404 reconciliation, rapid switching, and unmounted completion guards; all 73 focused tests passed, followed by all 76 client tests. The deterministic root gate ran in exact order and passed typecheck, production build, full tests, and E2E: contracts 80, server 1,254 passed with 1 skipped, client 76, and Playwright 1, for 1,411 deterministic passes and 1 skip. Vite transformed 129 modules. The Playwright workflow creates, opens, reloads, and returns from detail. Live E2E was not run. No live/server route, contract, repository, schema, authentication, or Slice 74 work was added.

### 2026-08-04: M0 Slice 72 - Trusted-Local Campaign Detail

Exactly seventy-two slices are complete, with schema v14 revision 1 unchanged. Slice 72 hardens shared factory/UoW `listCampaigns` and `getCampaign`: authorization first joins valid principal/campaign parents, accepts only recognized roles, and validates the exact selected `CampaignMembershipRead`. A purported owner must agree with `campaign.owner_principal_id` before corruption is attributable. After any membership authorizes, the read requires exactly one owner-role membership, matching the owner pointer, with an intact principal parent and a strict `CampaignMembershipRead`; every owner-invariant corruption then fails loudly for owner/GM/player/observer access. Stale purported owners, unknown roles, orphan authorization parents, outsiders, and missing campaigns remain masked.

Strict shared `CampaignDetail` and response contracts expose only ID, name, requesting role, canonical creation/update timestamps, and a discriminated content state. Unconfigured content has only `status`; configured content additionally has one rules-profile ID and ordered exact pack ID/version pairs. Strict variants reject extra/cross-state fields and duplicate pack IDs, and `updatedAt` cannot precede `createdAt`; owner principal and active timeline are absent. Factory `getCampaignDetail` composes hardened campaign authorization and complete content-configuration graph validation in one SQLite snapshot; the active unit-of-work uses its existing snapshot. It distinguishes denied/missing (`null`) from authorized unconfigured state and validates selected profile metadata plus every exact sealed compatible pinned pack before projection.

Feature-gated `GET /api/rpg/v1/campaigns/:campaignId` accepts a strict resource-ID path and no queries, delegates only as literal `local-owner`, ignores spoof identity headers, masks missing/denied as the same structured 404, validates its minimal output, and redacts repository/corruption/output failures behind a generic request-correlated 500. Contract-overlong and invalid-percent detail paths are normalized from pre-routing Fastify failures to the same request-correlated `RPG_CAMPAIGN_NOT_FOUND` problem with `X-Request-Id`; the disabled feature remains `RPG_ROUTE_NOT_FOUND`. The router cap remains 128, and the framework-error normalization is exact-method/path scoped so legacy and malformed unknown paths retain their prior raw Fastify 414/400 compatibility. HEAD and mutation methods remain unexposed. Detail, collection GET, and collection POST share the existing cached lazy app-owned repository and one close. There is no client, navigation, rename, schema, authentication, cookie, or campaign-detail UI.

Contracts were built first. Slice 72 finding remediation passed 68 focused repository/detail/route tests, server source/test typecheck and build, and the full server suite with 1,254 passed and 1 skipped across 58 files. The full deterministic root gate then passed in exact order: root typecheck, production build, full tests, and deterministic E2E. Contracts passed 80 across 6 files; server passed 1,254 with 1 skipped; client passed 62 across 5 files; Playwright passed 1. Total deterministic results are 1,397 passed and 1 skipped; Vite transformed 128 modules. Live E2E was not run.

### 2026-08-04: M0 Slice 71 - Trusted-Local Campaign Creation

Exactly seventy-one slices are complete, with schema v14 revision 1 unchanged. Slice 71 adds strict shared `CampaignCreateRequest` and `CampaignCreateResponse` contracts; feature-gated `POST /api/rpg/v1/campaigns`; and an accessible responsive creation form in the existing campaign library. The POST rejects every query, requires exact `application/json` with only an optional charset, normalizes malformed/empty/schema-invalid bodies, calls `createCampaign("local-owner", input)` with no caller identity, returns a strict validated `201` envelope without `Location`, ignores spoof headers, and leaves implicit HEAD disabled. GET and POST share the same cached lazy app-owned repository.

Repository creation exposes only two narrow typed failures: mismatch against a complete valid application owner, and a collision in either generated campaign/timeline ID namespace. Missing, malformed, or orphaned application-owner invariant state fails generically before dependencies or writes rather than being misclassified as authorization denial. The route therefore maps only a valid-owner mismatch to redacted 403 and maps collisions to redacted 409; owner corruption, ordinary/lookalike errors, and dependency, SQL, and output-validation failures remain generic redacted 500s. Existing validation, immediate transaction, two-ID-then-clock dependency order, insert order, rollback, and no-retry behavior remain intact. There is no idempotency contract. A missing POST response therefore has an ambiguous commit outcome and callers must list rather than automatically retry creation.

The client parses and normalizes request and response contracts. Its synchronous ref lock prevents duplicate submission; POST failure preserves the draft and exposes only a generic error. Every list GET shares a monotonic generation and mounted guard: a post-create refresh invalidates older initial/retry requests, only the newest mounted completion may update loading/list/error/focus state, and unmounted POST or GET completions do nothing. After POST success it clears the draft, performs an authoritative GET instead of optimistic append, focuses and announces the returned campaign after refresh, and never aborts or retries POST when that refresh fails. A separate GET retry reconciles the partial-success state. No detail/open route was added. This remains an unauthenticated trusted-local-only feature and is not remotely or multi-user safe.

Contracts were built first. The remediated repository/route suites contain 39 passing tests, and the campaign-page suite contains 14 deferred and baseline tests. The required deterministic root gate then passed in exact order: typecheck, build, full tests, and E2E. Contracts passed 78; server passed 1,214 with 1 skipped; client passed 62; deterministic Playwright passed 1, including create, focus, reload, and list verification. Total deterministic results are 1,355 passed and 1 skipped; Vite transformed 128 modules. Live E2E was not run. These are the Slice 71 baseline totals; the completed Slice 72 gate is recorded above.

### 2026-08-04: M0 Slice 70 - Trusted-Local Campaign Library

Exactly seventy slices are complete, and persistence remains schema v14 revision 1. Slice 70 adds one read-only vertical slice: strict shared `CampaignListResponse { campaigns: CampaignAccess[] }`; runtime validation on server and client; feature-gated `GET /api/rpg/v1/campaigns` inside the scoped RPG plugin; and a feature-gated, persisted, mobile-accessible campaign library with loading, empty, populated, generic-error, and retry states. The page shows campaign name, requesting role, and updated date only, with no owner principal or mutation controls.

The route owns one narrow repository per app/plugin lifecycle, calls only existing `repository.listCampaigns("local-owner")`, preserves repository membership authorization and order, and closes the app-owned repository once. Repository initialization now caches either success or failure for the plugin lifetime: repeated requests after an open failure return the same generic failure path without reopening or retrying. Every query parameter is rejected with structured `RPG_INVALID_REQUEST`; principal/auth spoof headers have no identity effect; repository exceptions and malformed repository output become generic redacted structured 500s with problem content type and request IDs; and a disabled campaign flag retains the structured RPG 404. GET-to-HEAD synthesis is disabled, so `HEAD /campaigns` reaches the scoped structured 404 and never initializes or uses the repository. The literal `local-owner` is trusted single-user local context, not authenticated identity and not remote-safe. No create/detail/mutation, schema, authentication, cookie, raw-DB access, named RPG wrapper, or additional route was added.

On the client, `App` is now the sole RPG feature-state owner. It passes `campaignLibraryAvailable` and `onCampaigns` to `CharacterLibraryPage`; the child no longer refetches flags or dispatches a global custom event. Existing component callbacks and rendering remain covered, campaign navigation still appears only when enabled, and stale persisted campaign navigation still falls home when unavailable.

Contracts were built first throughout. Focused remediation runs passed all 8 campaign-route server tests and 19 relevant client tests. The required deterministic root gate then ran in order: typecheck, production build, full unit tests, and deterministic E2E. Root typecheck/build passed across contracts, server source/tests, client, and E2E, with 128 Vite modules transformed. Contracts passed 77 tests across 6 files; the server passed 1,199 with 1 skipped across 57 files; the client passed 50 across 5 files; and deterministic Playwright passed 1, including the empty campaign view. Total final deterministic results are 1,327 passed and 1 skipped. Live E2E was not run. Slice 70 is complete; the next bounded task is a separately explicit Slice 71, and no Slice 71 feature was implemented or inferred.

### 2026-08-04: M0 Slice 69 - Slices 60-68 Read-Batch Closeout

Exactly sixty-nine slices are complete, and persistence remains schema v14 revision 1. Slices 60-68 form one bounded read batch: strict complete campaign content-configuration projection; a strict four-role campaign-membership projection and exact-owner membership list/get reads; exact-owner campaign-session attachment list/get reads; a strict campaign-timeline projection plus all-role list/get reads with complete audit-history integrity; actor-identity campaign-character lookup and shared character-read hardening; and final remediation for roll-owned orphan-term attribution, paired actor/private-state campaign scoping, and complete selected membership authorization validation. Final independent review of the complete batch found no remaining findings.

Slice 69 changed no feature, production, contract, schema, test, route, HTTP, API, UI, client, migration, dependency, transaction, or wrapper implementation. The required deterministic root gate ran in exact order: `npm run typecheck`; `npm run build`; `npm test`; `npm run test:e2e`. Typecheck passed across contracts, server source/tests, client, and E2E. Production builds passed for contracts, server, and client, with 127 Vite modules transformed. Contracts passed 75 tests across 6 files; server passed 1,191 with 1 skipped across 56 files; client passed 41 across 4 files; deterministic Playwright passed 1. Total deterministic results were 1,308 passed and 1 skipped. Live E2E was explicitly excluded and not run; the live command was not invoked.

Authentication is deferred by user direction for the local single-user phase. A future local API or UI may use trusted local-owner context, but that context is not multi-user authentication or a remote security boundary. Repository membership, role, exact-owner, non-disclosure, and corruption checks remain mandatory and must not be weakened. Real authentication and an appropriate security model are required before remote or multi-user exposure. At the Slice 69 closeout the next task was Slice 70; Slice 70 is now complete, and the current next bounded handoff is a separately explicit Slice 71.

### 2026-08-04: M0 Slice 68 - Independent Read-Boundary Remediation

Exactly sixty-eight slices are complete. Final independent remediation closes the remaining read-integrity findings without widening any API. Timeline history still scopes every attribute/resource dice-roll exclusion by event campaign and event ID. Orphan-term attribution now first follows an existing roll's owning campaign; only terms with no roll are safely attributed through a same-campaign event or receipt. A foreign roll plus terms that collides with a clean campaign's non-dice event/receipt ID therefore cannot poison the clean campaign, while deleting a local roll still makes its retained terms loud to local members and outsiders remain masked.

Actor-ID character lookup unions the requested same-campaign actor identity with attributable same-campaign orphan private-state identity. A genuinely absent or foreign actor remains `null`; local private state whose actor parent is missing fails loudly for every authorized role and remains masked from nonmembers. Shared list/get statements now scope sheet and actor joins to the campaign character's caller-authorized campaign, then scope private state to that same campaign; the actor-rooted statement independently retains its same-campaign identity and private-state joins. Raw execution of all three exact production statements proves that even a paired foreign actor plus foreign private-state row cannot select controller identity or notes. Shared authorized reads fail loudly for the incomplete local aggregate, actor lookup does not import the foreign identity, and outsiders remain masked.

`getCampaignContentConfiguration` now selects the authorizing membership's campaign ID, principal ID, role, and creation timestamp in its sole production query and validates that exact row through `CampaignMembershipRead` before projecting configured, zero-pin, or unconfigured state. Canonical IDs/timestamps and recognized roles are therefore enforced for owner, GM, player, and observer alike; owner authorization still requires exact campaign-owner agreement. A malformed selected timestamp fails loudly, while an unknown role, missing authorization parent, stale owner, outsider, application owner, or cross-campaign-only membership is denied as `null` without content disclosure. Existing strict profile/pack graph validation, deterministic pin ordering, and valid zero-pin/unconfigured behavior remain unchanged.

No contract, schema, write, dependency, explicit transaction, wrapper, HTTP, route, UI, client, E2E, live, or Slice 69 scope was added. Contracts were built first. The final three focused remediation suites passed 82 tests. Server source/test typecheck and production build passed, and the full server suite passed 1,191 tests with 1 skipped across 56 files. Root/client/E2E/live gates were not run.

### 2026-08-04: M0 Slice 67 - Campaign Character Lookup by Actor Identity and Read Hardening

Exactly sixty-seven slices are complete. Added synchronous factory/unit-of-work `getCampaignCharacterByActorId(actorPrincipalId, campaignId, actorId): CampaignCharacterRead | null`, reusing the existing strict discriminated read. Its single explicit-column SQLite statement is rooted in both the requesting membership and one target actor/private-state identity, returns one authorized root row, and gates controller identity and private notes in SQL. Exact owner and GM memberships receive privileged data, a player receives privileged data only for its own controlled actor, and other players and observers receive structurally public projections. Genuine missing, denied, and cross-campaign targets return `null`; application ownership grants no bypass.

The shared list/get character boundary is hardened with valid principal/campaign authorization parents, rejection of unknown roles, and exact owner-pointer agreement: a stale owner receives `[]`/`null`, while a valid GM remains authorized. All three reads validate actor-to-character-to-legacy-persona-to-exact-sheet ancestry, private-state and controller principal/membership ancestry, raw campaign/link identity, exact pinned content/definition parents, and every class/attribute/proficiency/choice parent. Optional child arrays and persisted-position ordering remain unchanged. Authorized attributable corruption is loud, outsiders remain masked, and poisoned private notes are neither selected into nor validated through public projections.

No write, dependency, explicit factory transaction, schema, contract, named wrapper, HTTP, route, or UI behavior was added. Contracts were built first. The focused character suite passed 25 tests, and character/resource/command/timeline/campaign regressions passed 737 tests across 21 files. Server source/test typecheck and server build passed. Full server/client/deterministic E2E and live E2E gates were not run.

### 2026-08-04: M0 Slice 66 - Campaign Timeline Get Read

Exactly sixty-six slices are complete. Added synchronous factory/unit-of-work `getCampaignTimeline(actorPrincipalId, campaignId, timelineId): CampaignTimeline | null`. It derives one explicit-column, membership-rooted SQLite `SELECT` from the Slice 65 list statement, constraining only the left-joined timeline target so authorization and every bounded campaign audit aggregate remain shared exactly. Every intact owner, GM, player, and observer membership receives the same strict four-field projection for active, historical, and empty timelines; owner access still requires exact campaign-owner agreement, and application ownership grants no bypass. Genuine missing, denied, and cross-campaign targets return `null`.

The get read shares active-pointer validation, complete contiguous target history, exact command/event/receipt/timeline/actor identity, all attribute/resource/dice variants, normalized contiguous dice terms, stable ties and totals, and safely attributable campaign orphan detection with the list read. Authorized requested or attributable campaign corruption fails loudly, including after revision reset, while outsiders remain masked and completely free terms remain unattributed. List behavior and ordering are unchanged.

No writes, dependencies, explicit factory transaction, private projection, schema, contract, named wrapper, HTTP, route, or UI behavior were added. Contracts were built first. The focused timeline suite passed 25 tests; timeline, audit, dice, and campaign regressions passed 746 tests across 21 files. Server source/test typecheck and server build passed. Full server/client/deterministic E2E and live E2E gates were not run.

### 2026-08-04: M0 Slice 65 - Campaign Timeline Reads

Exactly sixty-five slices are complete. Added synchronous factory/unit-of-work `listCampaignTimelines(actorPrincipalId, campaignId): CampaignTimeline[]`. One explicit-column, membership-rooted SQLite `SELECT` returns one row per timeline and orders by `created_at ASC`, then `id COLLATE BINARY ASC`. Every intact owner, GM, player, and observer membership can read active, historical, and empty timelines; owner access additionally requires exact `campaigns.owner_principal_id` agreement. Application ownership grants no bypass. Missing, denied, and cross-campaign requests return `[]`. The strict projection remains exactly timeline ID, campaign ID, revision, and creation timestamp, with no active flag.

The same statement verifies the campaign active pointer has an exact same-campaign timeline parent and strictly validates every selected membership and timeline. Bounded correlated SQL aggregates require each timeline's complete contiguous `1..revision` history and exact command/event/receipt counts and parents, including exact timeline and actor identity. Attribute, resource, and dice variants are checked independently and completely; dice integrity includes canonical normalized columns, contiguous physical terms, integer kept flags, stable earlier-position tie selection, and exact totals. Campaign-attributable command, event, receipt, roll, and safely attributable orphan-term identities remain detectable after revision reset, while completely free terms are not attributed. Authorized corruption is loud, and outsiders plus unrelated campaigns remain masked.

No writes, dependencies, explicit factory transaction, private projection, schema, contract, named wrapper, HTTP, route, or UI behavior were added. Contracts were built first. The focused suite passed 23 tests. Audit, dice, and campaign regressions passed 724 tests across 21 files; server source/test typecheck and server build passed. Full server/client/deterministic E2E and live E2E gates were not run.

### 2026-08-04: M0 Slice 64 - Campaign Timeline Contract

Exactly sixty-four slices are complete. Added only the strict shared `CampaignTimeline` schema and inferred type with exactly `id`, `campaignId`, `revision`, and `createdAt`, exported through the contracts index. Both identifiers reuse the shared resource-ID primitive, `createdAt` reuses the canonical millisecond UTC timestamp primitive, and `revision` reuses the identical existing `revisionSchema` object and its integer bounds from zero through `Number.MAX_SAFE_INTEGER`; no validation behavior was duplicated.

Coverage locks exact strict keys, every required field, invalid timeline/campaign IDs, noncanonical timestamps, invalid revisions, both revision boundaries, schema identity, and the exact inferred type. Active/status/fork/events/updatedAt fields are absent and individually rejected. The small acyclic contract arrangement adds no server runtime/read, persistence, migration/schema, dependency, wrapper, HTTP, route, UI, or Slice 65 behavior.

Contracts build passed; all 75 contract tests across 6 files passed; contract source/test typecheck passed. Server consumer source/test typecheck and server build then passed against the rebuilt contracts. Server runtime tests, client tests/build, deterministic E2E, and live E2E were not run for this contracts-only slice.

### 2026-08-04: M0 Slice 63 - Campaign Session Attachment Reads

Exactly sixty-three slices are complete. Added synchronous factory/unit-of-work `listCampaignSessionAttachments(actorPrincipalId, campaignId): CampaignSessionAttachment[]` and `getCampaignSessionAttachment(actorPrincipalId, campaignId, sessionId): CampaignSessionAttachment | null` using the existing strict attachment projection. Each operation uses one explicit-column, membership-rooted SQLite statement. Lists order by `attached_at ASC`, then opaque `session_id COLLATE BINARY ASC`; get preserves the exact nonempty legacy session ID without resource-ID normalization. Missing or denied lists return `[]`, while missing, denied, and cross-campaign gets return `null`.

Only an intact exact campaign owner is authorized: the actor principal, campaign, sole owner membership, and `campaigns.owner_principal_id` must exist and agree. Application ownership and GM/player/observer memberships grant no bypass. Selected attachment rows require intact session parents and strict campaign ID, opaque session ID, and canonical attachment timestamp projection. Authorized selected orphan or malformed rows fail loudly, while outsiders and cross-campaign callers remain masked. The queries expose only attachment metadata and select no session title, participants, messages, context, state, stop provenance, or other session details.

No writes, dependencies, explicit factory transaction, schema, contract, named wrapper, HTTP, route, or UI behavior were added. Contracts were built first. The focused suite passed 16 tests, and the attachment/detachment/campaign regression run passed 203 tests across 12 files. Server source/test typecheck and server build passed. Full server/client/deterministic E2E and live E2E gates were not run for this bounded slice.

### 2026-08-04: M0 Slice 62 - Campaign Membership Reads

Exactly sixty-two slices are complete. Added synchronous factory/unit-of-work `listCampaignMemberships(actorPrincipalId, campaignId): CampaignMembershipRead[]` and `getCampaignMembership(actorPrincipalId, campaignId, principalId): CampaignMembershipRead | null`. Each operation uses one explicit-column, membership-rooted SQLite statement and the strict Slice 61 projection. Lists order by `created_at ASC`, then `principal_id COLLATE BINARY ASC`; get returns only the exact target. Missing or denied lists return `[]`, and missing or denied gets return `null`.

Only an intact campaign owner is authorized: the actor principal, campaign, owner membership, and campaign owner identity must exist and agree, with exactly one owner relationship. Application ownership, GM, player, and observer status grant no bypass. Selected rows strictly validate every role including owner and require intact target-principal parents; authorized selected corruption fails loudly, while outsiders and cross-campaign callers remain masked. Both reads consume no clock, ID, or RNG, perform no write or explicit factory transaction, and add no schema, dependency, named wrapper, HTTP, route, or UI behavior.

Contracts were built first. The focused membership query suite passed 15 tests. The membership/campaign regression run passed 187 tests across 11 files, including creation, rename, membership add/read, campaign reads, session attachment/detachment, content configuration/read, and character creation/deletion. Server source/test typecheck and server build passed. Full server/client/deterministic E2E and live E2E gates were not run for this bounded slice.

### 2026-08-04: M0 Slice 61 - Campaign Membership Read Contract

Exactly sixty-one slices are complete. Added the separately named strict shared `CampaignMembershipRead` schema and inferred type with exactly `campaignId`, `principalId`, `role`, and `createdAt`. Both IDs use the shared resource-ID primitive, `createdAt` uses the canonical millisecond UTC timestamp primitive, and `role` deliberately uses `campaignRoleSchema` so owner, GM, player, and observer rows can all be represented by a future read boundary. The schema and type are exported through the contracts index.

This additive read projection does not widen or alter `AddCampaignMembershipInput` or the existing `CampaignMembership` add-result projection: both continue to use the three-role member schema and reject owner creation/results. Contract coverage locks all four read roles, exact strict fields, invalid campaign/principal IDs, invalid timestamps, inferred type shape, and unchanged owner rejection by both existing add schemas. No server runtime/read, persistence, migration, dependency, wrapper, HTTP, route, UI, or other behavior was added.

Contracts build passed; all 73 contract tests across 6 files passed; contract source/test typecheck passed. The server consumer source/test typecheck and build then passed against the rebuilt contracts. Server runtime tests, client tests/build, deterministic E2E, and live E2E were not run for this contracts-only slice.

### 2026-08-04: M0 Slice 60 - Campaign Content Configuration Read

Exactly sixty slices are complete. Added only synchronous factory/unit-of-work `getCampaignContentConfiguration(actorPrincipalId, campaignId): CampaignContentConfiguration | null` using the existing strict contract. One explicit-column, membership-rooted SQL statement provides one SQLite statement snapshot. Current intact owner, GM, player, and observer memberships receive the same configuration; an owner row must exactly agree with `campaigns.owner_principal_id`, and application ownership grants no bypass. Missing, denied, and unconfigured campaigns return `null`, while a configured campaign with no pins returns a non-null configuration with `contentPacks: []`. Pins use deterministic binary/code-unit `packId`, then version ordering.

The read validates the complete selected-profile, pin, and exact sealed profile-compatible pack graph, including strict identifiers, the 64-pack bound, and duplicate `packId` rejection. Campaign-attributable corruption fails loudly for authorized members while outsiders remain masked, including cross-campaign cases. It consumes no clock, ID, or RNG; performs no write or explicit factory transaction; and adds no schema, contract, named wrapper, dependency, HTTP, UI, or Slice 61 scope. Authentication remains deferred for the current single-user product phase; that product decision does not weaken repository membership, exact-owner, non-disclosure, or corruption checks.

Contracts were built first. The focused existing content/configuration suites plus the new focused read suite passed 56 tests across four files. Server source/test typecheck and server build passed. Full server/client/E2E and live E2E gates were not run for this bounded slice.

### 2026-08-04: M0 Slice 59 - Schema V14 Revision-1 Dice Closeout

Exactly fifty-nine slices are complete. The final independent Slice 58 review had no remaining findings. Slice 59 added no feature, contract, production code, test implementation, schema, route, UI, generic system, or gameplay behavior; persistence remains schema v14 revision 1.

The required deterministic gate ran from the repository root in exact order: `npm run typecheck`; `npm run build`; `npm test`; `npm run test:e2e`. Root typecheck passed across contracts, server source/tests, client, and E2E. Root build passed for contracts, server, and client; Vite transformed 127 modules and completed successfully. Contracts passed 71 tests across 6 files; server passed 1,083 tests with 1 skipped across 52 files; client passed 41 tests across 4 files; deterministic Playwright passed 1 test. Total deterministic results were 1,196 passed and 1 skipped.

Live E2E was explicitly excluded and not run; `VELVET_E2E_LIVE=1 npm run test:e2e:live` was not invoked. Future bounded work requires explicit independent scope rather than being derived from the aspirational migration sequence.

### 2026-08-03: M0 Slice 58 - Independent V14 Remediation

At Slice 58, exactly fifty-eight slices were complete. Independent adversarial review found and resolved six separate bounded v14 defects without changing contracts, schema version/revision, routes, UI, generic execution, or gameplay scope. The final independent review after remediation had no remaining findings.

The event seal now enforces stable physical-order ties in SQL for keep-highest, keep-lowest, advantage, and disadvantage, rejecting a later equal-valued kept term when an earlier equal term was discarded; direct fresh and v13-migrated invalid-seal transactions prove exact graph/revision rollback and DDL parity. Dice execution now requires the receipt insert to report exactly one changed row, so receipt-only `RAISE(IGNORE)` rolls the entire command/revision/roll/term/event graph back. Exact retries require the complete same-campaign actor to campaign-character to global-character plus exact-sheet ancestry, and validate every later timeline event through exact command, receipt, timeline, and actor parents plus a complete valid attribute, resource, or dice variant aggregate in one bounded SQL history aggregate. Final remediation makes that aggregate contract-strict for all common public/technical identifiers, nullable command/event source-turn IDs, and attribute/resource identifiers; valid later old-variant history still retries with zero dependencies while independent payload, ID, and source corruption fails closed.

The two one-query public projections now authorize an `owner` row only when it exactly agrees with `campaigns.owner_principal_id`; intact GM/player/observer behavior remains unchanged and stale owners are denied without disclosure. Event-list identity roots now also surface campaign-attributable fully orphaned receipts and rolls even when the requested timeline revision was corruptly reset, while attributable orphan terms are rejected where an event or receipt safely resolves their campaign identity. Cross-campaign orphan receipt/roll/attributable-term tests prove clean campaign A is unaffected, authorized campaign B is loud, and outsiders remain masked. Both reads retain explicit columns, old variants, one-query behavior, outsider masking, and exclusion of payloads, keys, controller identity, and private state. Fresh, migrated, failed, and retried v14 migration tests use a throwing RNG spy alongside clock/ID spies and prove zero dependency use.

Slice 58 verification built contracts first. All focused dice/v14/old-projection/old-executor suites passed 547 tests across nine server files. Server source/test typecheck and server build passed. The complete server suite passed 1,083 tests with 1 skipped across 52 files. Root/client/E2E and live gates were not run during Slice 58; the later Slice 59 closeout results are recorded above.

### 2026-08-03: M0 Slice 57 - Receipt Dice Projection

Exactly fifty-seven slices are complete. Extended only factory/unit-of-work `Repository.getCommandReceipt`; contracts, schema, execution, event-list behavior, APIs, routes, dependencies, and UI remain unchanged.

The read now uses one explicit-column membership-rooted query with `.all` to reconstruct a single strict dice receipt from term-multiplied rows. It roots safely attributable identities from command, event, receipt, or roll; requires exact command/event/receipt/roll identity and normalized agreement; reconstructs contiguous physical terms with raw integer `kept` values; independently preserves stable earlier-index tie selection; and validates complete historical timeline count/minimum/maximum. Existing attribute and resource receipts remain unchanged. Current owner, GM, player, and observer memberships receive identical active or historical results, while missing, outsider, application-owner-only, and cross-campaign requests return `null`; attributable corruption fails loudly only after authorization.

The query uses no `SELECT *`, transaction, write, dependency, private command payload, idempotency projection, controller identity, or private state. Focused coverage locks all five selection modes, ties, 100 terms, all-role and historical parity, one-query behavior, UoW/lifecycle behavior, old receipt compatibility, and broad command/event/receipt/roll/term/parent/history corruption with outsider masking.

Verification built contracts first. The final related run passed 465 tests across seven server files, including receipt/event projections, command reads, dice execution/migration, and both older specialized executors. Server source/test typecheck and server build passed. The full server/client/deterministic E2E gates and live E2E were not run for this bounded slice.

### 2026-08-03: M0 Slice 56 - Event-List Dice Projection

Exactly fifty-six slices are complete. Extended only factory/unit-of-work `Repository.listCampaignEvents`; `getCommandReceipt` deliberately retains its prior dice rejection for Slice 57. No contract, schema, executor, API, route, dependency, or UI surface changed.

The membership-rooted read remains one explicit-column `SELECT` with no explicit transaction, writes, dependency use, `SELECT *`, or private-field projection. It reconstructs normalized roll aggregates and exact contiguous ordered terms, requires persisted `kept` to be raw SQLite integer `0` or `1`, independently enforces stable earlier-index ties, and regroups term-multiplied rows into one event. Events remain ordered by revision then event ID. All current owner/GM/player/observer memberships receive identical active or historical public timelines; missing, outsider, application-owner-only, and cross-campaign requests remain non-disclosing.

Authorized reads now validate complete timeline history, including empty-history corruption, plus command/event/receipt/roll/term and timeline/actor parent identities. Safely attributable roll-only corruption is included without exposing unrelated or cross-campaign rows. Existing attribute/resource event variants and factory/UoW lifecycle behavior remain intact.

Verification built contracts first. The focused dice event-list, command-query, dice-executor, and v14 migration run passed 274 tests across four files. The final related run passed 415 tests across six files, including both older specialized executors; server source/test typecheck and server build passed. The full server/client/deterministic E2E gates and live E2E were not run for this bounded slice. Slice 57 remains unimplemented.

### 2026-08-03: M0 Slice 55 - Specialized Dice Executor

Exactly fifty-five slices are complete. Added only factory `Repository.executeRollActorDice`; it is absent from the unit of work, named exports, dispatchers, routes, and UI. Repository dependencies now include RNG with a compatible `systemRuntime.rng` default.

The executor strictly accepts `roll_actor_dice`. In one immediate transaction it parent-authorizes campaign owner/GM before shared command/key lookup, reconstructs exact complete retries before active timeline/revision/ancestry checks without dependencies, and requires complete same-campaign actor-character-exact-sheet-global-character ancestry for new commands. New execution evaluates exact RNG calls first, then validates one event ID and one clock without retry. Atomic persistence order is command, conditional timeline revision, normalized roll, ordered terms, sealing event, receipt; aggregate timestamps remain unchanged. Retry reconstruction validates command/event/receipt/roll, contiguous ordered terms, stable earlier-index ties, and complete timeline history, failing loudly only after authorization.

Verification: contracts were built first. The focused executor suite passed 48 tests. The final related dice/attribute/resource command, v14 migration, and command-query suites passed 265 tests across five files. Server source/test typecheck and server build passed. No full client/E2E gate or live E2E was run for this bounded slice.

Independent Slice 55 review remediation is complete without implementing Slice 56. Production retry reconstruction now validates each persisted term's `kept` storage value as exactly integer `0` or `1` before boolean conversion, so text, fractional, negative, and other integer values fail closed. The focused suite now covers every command/event/receipt/roll identity and field, expression/normalization/total mismatches, missing/extra/gapped/noninteger/value/kept/selection/tie term corruption, timeline and actor parents, complete and later-valid history, authorization parents/owner disagreement/GM/non-disclosure, both older command variants and split collisions, all real blocked-writer outcomes and reuse, exact dependency short-circuit/snapshots, complete ancestry corruption, deferred-commit FK rollback, revision boundaries, and factory lifecycle/UoW/projection exclusions. Every denial and corruption path asserts zero RNG, ID, and clock use.

Review verification built contracts first. The focused dice executor file passed 173 tests; the required v14 migration, old attribute/resource executor, command-projection, and dice-executor run passed 390 tests across five files. Server source/test typecheck and build passed. No live tests were run. Event-list and receipt dice projection remain explicitly absent for Slices 56 and 57.

### 2026-08-03: M0 Slice 54 - Atomic Minimal Dice Persistence

Schema v14 revision 1 persists only the already-reviewed dice command/event audit variant. It deliberately adds neither dice execution nor dice projection behavior.

Completed:

- Remediated every independent Slice 54 review finding before Slice 55. Production now validates exact v13 `schemaRevision` compatibility before the v13-to-v14 rebuild can mutate anything, while retaining the final current-revision assertion. Missing and unsupported revision tests prove exact schema/data/meta preservation.
- Rebuilt the v13 command/event/receipt graph into an exact three-variant normalized union while preserving all attribute/resource rows, identities, revisions, receipts, resource state, triggers, and broader v13 data. Existing specialized executors still reject `roll_actor_dice`; existing audit projections explicitly reject/detect dice rows and mixed persistence.
- Added immutable `rpg_dice_rolls` keyed directly by `event_id` and immutable ordered `rpg_dice_terms` keyed by `(event_id, position)`. No separate roll ID, JSON payload, implicit roll, executor, projection, route, UI, or RNG behavior was introduced.
- Persisted canonical command expression and normalized count/sides/selection/modifier columns, with matching normalized roll columns and total. SQL checks reconstruct the exact canonical expression and reject invalid selection relationships.
- Designed the insertion graph as command, roll, ordered terms, then `actor_dice_rolled`. A deferred exact campaign/command/event FK permits rolls to precede their event while rejecting unsealed commits. The event seal validates exact envelope/revision linkage, complete contiguous physical terms, side bounds, kept cardinality, high/low semantics, normalized aggregate identity, and total.
- Prevented adding rolls to old events and appending terms after the sealing event. Roll/term updates, deletes, and `INSERT OR REPLACE` conflicts reject independently of recursive-trigger settings.
- Expanded v13 semantic preflight across identities, campaign/timeline/actor parents, source turns, command/event/receipt revisions, attribute/resource variants, complete audit chains, timeline history, and malformed/cross-parent `rpg_actor_resources`.
- Expanded migration-v14 coverage across all/kh/kl/adv/dis, ties and positive/negative modifiers; mismatch, term count, kept cardinality, position, side value, kept semantics, and total rollback; exact reviewed columns/FKs/deferred links with no speculative fields; direct populated-v13 preservation of both old audit variants plus projections/immutability; symmetric fresh/migrated zero rows and zero dependency use; complete relevant `sqlite_master` parity including the timeline revision trigger; exact late fresh/migrated rollback, retry, and parity; and alternate unique-identity REPLACE with recursive triggers disabled and enabled.
- Contracts build passed. The cwd-correct focused v13/v14 migration and old attribute/resource executor/audit-projection suites passed 231 tests across five files; server source/test typecheck and build passed.

Required deterministic gate completed exactly in order:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Review-remediation rerun results: root typecheck and build passed; contracts passed 71 tests across six files; server passed 796 tests with 1 skipped across 49 files; client passed 41 tests across four files; deterministic Playwright passed 1 test. Total deterministic results: 909 passed and 1 skipped. Live E2E was not run. Exactly fifty-four slices are complete. Persistence is schema v14 revision 1. Slice 55 remains unimplemented.

### 2026-08-03: M0 Slice 53 - Dice Command And Event Contracts

The existing reviewed command boundary now admits one actor-targeted dice operation while preserving the exact envelope, revision, and one-event receipt shape. This slice is contracts-only; the schema remains v13 and existing server executors continue to reject the new variant.

Completed:

- Added strict `RollActorDicePayload` containing only canonical `expression`, plus the specialized `roll_actor_dice` command. The payload directly reuses `diceExpressionSchema`; generic mechanics, narration, check, ability/DC, and RNG fields reject.
- Added the public `actor_dice_rolled` event with the unchanged event envelope and `data` exactly aliased to the strict structured `DiceRollResult` schema. No generic result, check outcome, narration, or public-fact fields were introduced.
- Extended only the existing reviewed `rpgCommandSchema` and `rpgEventSchema` unions from two to three variants. The command envelope remains actor-targeted with required nullable source turn and safe expected revision.
- Preserved the receipt as an exact one-event tuple with one safe revision increment and command/campaign/event revision identity checks. Added dice-specific receipt acceptance, cardinality, boundary, and mismatch coverage.
- Exported the exact payload, command, event-data, and event schemas and inferred types through `@velvet/contracts`.
- Added comprehensive canonical-expression, strictness, generic-field rejection, union option-count/narrowing, structured-result, envelope, event, and receipt regression coverage.
- Added no persistence, migration, executor, repository behavior, authorization, route, UI, generation, generic mechanics command, or check resolution. Slice 54 remains unimplemented.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
cd server && npx vitest run test/set-actor-attribute-command.test.ts test/initialize-actor-resource-command.test.ts test/role-sensitive-command-queries.test.ts test/migration-v13.test.ts
```

Results: all 71 contract tests passed across six files; 190 relevant server union-consumer tests passed across four files; contract build/source/test typecheck and server source/test typecheck/build passed. Independent review found no implementation defect; follow-up regression locks verify exact shared dice-schema identity and explicit rejection of the dice variant by both existing specialized executors. Exactly fifty-three slices are complete. Persistence remains schema v13 revision 1. The full server suite, client, E2E, and live E2E were not run.

### 2026-08-03: M0 Slice 52 - Deterministic Dice Evaluator

The evaluator is a pure server boundary over the existing injected `RandomNumberGenerator`; it parses before dependency use and returns only the strict shared structured result.

Completed:

- Remediated the independent Slice 50 contract finding: `DiceResultTerm.value` now accepts integer one while normalized die sides remain bounded to 2-1,000. Explicit term, complete-result, zero-value, and one-sided-die regressions freeze the distinction.
- Added pure `evaluateDiceExpression(input, rng)` in `server/src/dice.ts`. It parses the complete canonical source before RNG use and validates the final projection through `diceRollResultSchema`.
- Every physical die calls `integer(1, sides + 1)` in term order. Ordinary and keep rolls call exactly base count times; advantage/disadvantage call exactly twice; returned terms preserve dependency-call order.
- Each RNG return is immediately required to be an in-range integer. Invalid outputs reject without clamp/retry or further calls, and dependency exceptions propagate by identity unchanged.
- Keep-high, keep-low, advantage, and disadvantage ties explicitly retain earlier term indexes. Totals include only retained values plus the normalized modifier.
- Added focused coverage for all selection modes, modifiers/totals, exclusive bounds, order/count, maximum `100d1000`, all tie modes, parse-before-RNG, invalid outputs, dependency failures, strict output, and zero hidden retries.
- Added no repository, persistence, command/event, migration, authorization, route, UI, generation, checks, damage, or combat behavior.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
cd server && npx vitest run test/dice.test.ts test/runtime.test.ts
cd server && npm run typecheck
cd server && npm run build
```

Results: all 69 contract tests passed across six files; the focused server dice/runtime suites passed 16 tests across two files; contract build/source/test typecheck and server source/test typecheck/build passed. Exactly fifty-two slices are complete. Persistence remains schema v13 revision 1. The full server suite, client, E2E, and live E2E were not run.

### 2026-08-03: M0 Slice 51 - Pure Bounded Dice Parser

The parser remains a small server-owned deterministic boundary: shared contracts own acceptance and the normalized output type, while the server projects already-valid canonical text without introducing evaluation or dependencies.

Completed:

- Added side-effect-free `parseDiceExpression(input)` in `server/src/dice.ts`, returning only the shared `NormalizedDiceExpression` shape.
- Validates the entire input through `diceExpressionSchema` before projection and validates the projected result through `normalizedDiceExpressionSchema`, preserving grammar, numeric, keep-count, and advantage/disadvantage rules.
- Normalizes omitted selection to `{ type: "all" }`, omitted modifiers to zero, `khN`/`klN` to explicit keep variants, and `adv`/`dis` to explicit mode variants.
- Rejects non-string/schema failures, whitespace and trailing input, overflow and out-of-range values, invalid keep counts, combined/reordered/incompatible modes, and oversized hostile input. A constant-time length guard runs before grammar validation to bound parser work.
- Added focused exact-normalization, shared-schema corpus-parity, malformed/boundary, million-character input, deterministic behavior, return-shape, and inferred-return-type coverage.
- Added no evaluator, RNG use, repository/persistence behavior, command/event change, migration, HTTP, UI, generation, check, damage, or combat behavior.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npx vitest run test/dice.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: the focused server dice suite passed 5 tests; contract build and server source/test typecheck/build passed. Exactly fifty-one slices are complete. Persistence remains schema v13 revision 1. Contract tests, the full server suite, client, E2E, and live E2E were not run.

### 2026-08-03: M0 Slice 50 - Dice Contracts And Canonical Grammar

Contract research selected one deliberately small notation and result boundary before any parser or RNG implementation. Canonical source text remains distinct from normalized parsed data, while result validation ties source, normalized values, rolled terms, selection, modifier, and total together without deciding evaluator tie identity.

Completed:

- Added strict shared `DiceExpression`, `DiceSelection`, `NormalizedDiceExpression`, `DiceResultTerm`, and `DiceRollResult` contracts and exported their schemas, types, and reviewed limits through the package index.
- Froze exact whole-input notation as mandatory lowercase positive `NdS`, followed by at most one of `khN`, `klN`, `adv`, or `dis`, then an optional nonzero signed modifier. Whitespace, uppercase/aliases, leading zeros, unsigned modifiers, zero modifiers, reordered suffixes, and trailing input reject.
- Bounded base count at 1-100, sides at 2-1,000, and modifier absolute value at 1,000. Keep counts are positive and cannot exceed base count; `adv`/`dis` require base count exactly one.
- Added strict normalized discriminated variants for all dice, keep-highest, keep-lowest, advantage, and disadvantage. Normalized modifiers use zero for the absent canonical suffix.
- Added strict per-die `{ value, kept }` terms and result consistency for canonical source reconstruction, normalized/top-level modifier equality, expected physical term count, side bounds, exact kept cardinality, high/low value selection, and total equal to kept values plus modifier. Equal boundary values remain valid regardless of which tied term is kept so Slice 52 can explicitly freeze evaluator tie behavior.
- Added comprehensive boundary, grammar, strictness, inferred-type, and cross-field inconsistency coverage.
- Added no parser function, evaluator, RNG call, command/event union member, receipt change, persistence, migration, repository behavior, HTTP, UI, generation, checks, damage, or combat.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
```

Results: contract build and source/test typechecks passed; 68 contract tests passed across six files. Exactly fifty slices are complete. Persistence remains schema v13 revision 1. No server, client, E2E, or live E2E suite was run for this contracts-only slice.

### 2026-08-03: M0 Slice 49 - Role-Sensitive Actor-Resource Reads And V13 Closeout

Independent authorization research selected two actor-scoped current-state reads rather than a campaign-wide dump. Independent runtime and coverage reviews then identified and drove remediation for corrupted resource campaign associations, v12 migration semantic preflight, real contention, malformed retries, complete rollback matrices, strict persisted values, and state/history independence.

Completed:

- Added factory/UoW `listActorResources(actorPrincipalId, campaignId, actorId)` and `getActorResource(actorPrincipalId, campaignId, actorId, name)` using the existing strict `ActorResource` projection; no new contract or migration revision was needed.
- Gives intact owner, GM, player, and observer memberships identical current-state visibility. Application ownership and actor controller status grant no bypass; missing, unauthorized, and cross-campaign list/get results remain indistinguishable as `[]`/`null`.
- Uses one explicit-column membership-rooted query per operation with principal/campaign authorization parents, exact owner identity, complete actor-character-sheet ancestry, no private state/audit selection, no explicit factory transaction, and no clock/ID/RNG/write use.
- Preserves exact case-sensitive resource identity. Lists use deterministic SQLite binary lexical name order; gets require an exact validated name.
- Strictly parses all persisted projection fields and fails loudly for authorized orphaned ancestry, mismatched same-campaign sheets, malformed names/amounts, bounds violations, and corrupted redundant campaign association while outsiders learn nothing.
- Keeps mutable resource state independent from immutable initialization history: current updates/deletion do not rewrite history, and audit deletion in corruption fixtures does not affect current-state reads.
- Hardened initialization existence checks to query the actor/name primary identity before dependencies and reject a corrupt campaign association rather than discovering it only through a late primary-key failure.
- Added pre-rebuild v12 audit semantic validation so commands/events/receipts with incomplete identities, parents, envelope relationships, revisions, or links cannot be silently promoted to v13. Failure leaves exact v12 schema/data retryable and consumes no dependencies.
- Expanded Slice 48 closeout coverage for parent-backed authorization, owner disagreement, cross-variant and split identities, nullable and state-independent retries, malformed audit/parent/revision retries, dependency failures, maximum safe revision, all before/after five-write failures, conditional timeline-write loss, real blocked-writer outcomes, and busy timeout recovery.
- Added no resource mutation beyond initialization, campaign-wide dump, generic query/executor, named wrapper, HTTP, UI, generation, inventory, equipment, currency, shops, effects, combat, or recovery behavior.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npx vitest run test/migration-v13.test.ts test/initialize-actor-resource-command.test.ts test/role-sensitive-actor-resource-queries.test.ts test/migration-v12.test.ts test/set-actor-attribute-command.test.ts test/role-sensitive-command-queries.test.ts test/role-sensitive-character-queries.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: 239 focused server tests passed across seven files; contract build and server source/test typecheck/build passed. Final independent review found no remaining findings. The full deterministic gate passed root typecheck/build, 59 contract tests, 741 server tests with 1 skipped, 41 client tests, and 1 deterministic E2E test: 842 passed and 1 skipped total. Live E2E was not run. Exactly forty-nine slices are complete.

### 2026-08-03: M0 Slice 48 - Atomic Actor-Resource Initialization

Authorization-boundary research confirmed that resource initialization should mirror the reviewed attribute executor while remaining a separate factory-only operation. Resource rows have no timestamps, so the approved five-write transaction does not update campaign, character, sheet, or actor timestamps.

Completed:

- Added synchronous factory-only `executeInitializeActorResource(actorPrincipalId, envelope)` and kept it out of active units of work, named wrappers, generic dispatch, HTTP, and UI.
- Strictly accepts only `initialize_actor_resource` envelopes and authorizes only parent-backed campaign owner/GM membership before command-identity lookup. Application ownership, player/controller status, observer membership, missing parents, and malformed ownership grant no authority.
- Shares campaign-scoped command IDs and idempotency keys with the attribute command. Exact resource retries require complete matching immutable command/event/receipt state, return before active-timeline and resource-existence checks, and remain valid after later revisions or timeline deactivation. Cross-variant and split ID/key reuse conflict without dependency use.
- New execution requires the requested active timeline at the exact safe expected revision, complete same-campaign actor-character-sheet ancestry, and absence of the exact case-sensitive actor/resource name. Existing resources conflict; there is no replace, update, merge, or normalization behavior.
- Consumes and validates one event ID before exactly one canonical clock reading, emits one `actor_resource_initialized` event, and atomically writes command, resource state, timeline revision, event, and receipt in that order.
- Leaves campaign, campaign-character, sheet, and actor timestamps unchanged because the resource table defines no aggregate timestamp contract. All five write boundaries roll back together on failure.
- Added focused coverage for strict variant dispatch, owner/GM authorization, denial/non-disclosure, exact historical retries, identity and cross-variant collisions, case-sensitive existence, active/stale/ancestry rejection, dependency order, write order, rollback, and factory-only lifecycle behavior.
- Added no resource-state read, bulk initialization, resource timestamp/ID, generic command bus, HTTP, UI, generation, inventory, equipment, currency, shops, effects, combat, or recovery behavior.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npx vitest run test/initialize-actor-resource-command.test.ts test/set-actor-attribute-command.test.ts test/role-sensitive-command-queries.test.ts test/migration-v13.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: 148 focused server tests passed across four files; contract build and server source/test typecheck/build passed. Exactly forty-eight slices are complete; full deterministic totals remain the Slice 45 gate pending Slice 49 closeout.

### 2026-08-03: M0 Slice 47 - Atomic Minimal Schema-v13 Actor Resources

Independent migration research determined that the new resource command/event discriminants require an atomic audit-table rebuild rather than nullable columns added onto v12 checks. The approved scope adds one mutable resource table and union-aware immutable audit persistence only; inventory/economy and resource execution/reads remain deferred.

Completed:

- Advanced fresh and migrated persistence to schema v13 while retaining corrective revision 1 and all prior sequential migration/correction ordering.
- Added `rpg_actor_resources` with campaign/actor linkage, exact case-sensitive technical names, integer current/max bounds of 0-1,000,000, `current <= max`, one name per actor, deterministic campaign/actor/name index, and actor cascade for mutable current state.
- Added explicit embedded-NUL rejection so SQLite storage matches the shared resource-name regex. Case-distinct names coexist; missing/cross-campaign actors, invalid names, fractions, negatives, overflow, and over-cap current values reject.
- Fresh databases create final v13 audit DDL directly. V12 migration atomically rebuilds command, event, and receipt tables with strict nullable discriminated attribute/resource columns, exact variant-shape checks, and unchanged campaign-scoped IDs/keys, global event IDs, parent FKs, revision/receipt links, immutability, and REPLACE guards.
- Expanded the command-event matching trigger for exact `set_actor_attribute`/`actor_attribute_set` and `initialize_actor_resource`/`actor_resource_initialized` pairs without linking immutable history to mutable resource rows.
- Preserved complete representative v12 command/event/receipt chains and earlier legacy/campaign/content/sheet/actor data; migrated resource columns are null for attribute audit rows, timeline revisions remain exact, and no resource/audit row is implicit.
- Existing named attribute execution explicitly rejects the resource command before dependencies and remains exact-retry compatible in the shared identity namespace. Existing public event/receipt reads reconstruct both public event variants and reject mixed/corrupt shapes without adding resource-state reads.
- Fresh and migrated v13 DDL parity, zero dependency use, foreign keys, bounds, uniqueness, cascade/restriction, old/new audit immutability, late fresh/migrated rollback, clean v12 restoration, retry, and reopen behavior are verified.
- Added no resource initialization executor, actor-resource query, timestamp/ID, bulk operation, generic command bus, HTTP, UI, generation, inventory, equipment, currency, shops, effects, combat, or recovery behavior.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npx vitest run test/migration-v13.test.ts test/migration-v12.test.ts test/set-actor-attribute-command.test.ts test/role-sensitive-command-queries.test.ts test/migration-v11.test.ts test/migration-v10.test.ts test/migration-v9.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: 157 focused server tests passed across seven files; contract build and server source/test typecheck/build passed; the full server suite passed 637 with 1 skipped. Independent review remediation added NUL-safe SQL checks and comprehensive preservation, FK/boundary, immutability, fresh/migrated rollback/retry, and dependency coverage. Follow-up review found no findings. Exactly forty-seven slices are complete; full deterministic totals remain the Slice 45 gate.

### 2026-08-03: M0 Slice 46 - Minimal v13 Actor-Resource Contracts

Independent contract research found that only non-negativity was previously specified, so reviewed decisions fixed the missing scalar and identity semantics before implementation: exact case-sensitive technical names, integer amounts through 1,000,000, `current <= max`, and valid zero-capacity resources.

Completed:

- Added strict `ActorResourceState` with exact technical `name`, `current`, and `max`; names reuse the untrimmed 1-128 safe resource-ID token syntax and remain case-sensitive.
- Added one shared integer amount contract from 0 through 1,000,000 and enforced `current <= max`; `{ current: 0, max: 0 }` is valid.
- Added strict separate `ActorResource` projection with campaign ID, actor ID, and state only. Existing actor/character projections remain unchanged and cannot gain embedded resources, resource IDs, or timestamps.
- Added singular strict `initialize_actor_resource` command payload/variant and public `actor_resource_initialized` event data/variant using the same resource state contract.
- Extended only the reviewed command/event discriminated unions. The command envelope remains unchanged; the strict receipt still contains exactly one event and one safe revision increment.
- Added no bulk resource array/cardinality/duplicate semantics, persistence, migration, uniqueness, service, authorization, execution, reads, clock/ID/RNG use, HTTP, UI, generation, inventory, equipment, currency, shops, effects, combat, or recovery behavior.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
```

Results: contract build and source/test typechecks passed; 59 contract tests passed across five files. Exactly forty-six slices are complete. Persistence remains schema v12 revision 1; full deterministic totals remain the Slice 45 gate.

### 2026-08-03: M0 Slice 45 - Schema-v12 Adversarial Closeout

A fresh independent batch review and separate coverage audit examined the complete v12 migration, executor, and read boundaries. Every runtime finding was remediated; final independent approval found no remaining persistence, contract, authorization, migration, transaction, or test issues.

Completed:

- Hardened executor authorization to require a valid principal, existing campaign, owner/GM role, and owner identity agreement. Orphaned or forged memberships cannot disclose, retry, or mutate command state; application ownership still grants no bypass.
- Hardened target validation through the complete campaign actor, campaign-character, sheet, and existing-attribute ancestry. Malformed IDs, links, timestamps, values, or missing parents fail before dependency use.
- Strictly validates active, retry, and public-read timeline revisions as safe integers. Historical timelines may advance beyond an event but cannot be missing, malformed, or behind committed event history.
- Real `BEGIN IMMEDIATE` contention proves blocked calls re-read committed state after lock acquisition: an exact winning command returns its persisted receipt without local dependencies; a different winner makes the loser stale; same command ID or key conflicts; active-timeline changes reject new commands; and busy timeout produces no partial local writes or dependency calls while leaving the repository usable.
- Characterized duplicate command IDs, idempotency keys, split identity ownership, stale/ahead revisions, inactive timelines, exact retries after genuine later commands and timeline replacement, global event-ID collision, nullable source turns, and maximum safe revision behavior.
- Expanded malformed command/event/receipt/parent matrices for executor retries and public reads. Authorized corruption fails loudly; nonmembers receive only `[]`/`null`; private idempotency values are integrity-checked but never projected.
- Verified event-ID-before-clock ordering and exact dependency counts across authorization, collision, retry, stale/inactive, target/no-op, generated-value, timeout, and write-failure paths. No hidden retry, re-ID, reclock, RNG, provider, or orchestration occurs.
- Injected before/after failures at command, attribute, sheet timestamp, timeline revision, event, and receipt writes plus conditional-write loss. Exact snapshots prove all state, timestamp, revision, and audit rows roll back together.
- Preserved schema-v12 migration/correction parity, all legacy/runtime APIs and response shapes, named async wrappers, `buildApp({ runtime })` request-ID ownership, default harness/provider behavior, opaque legacy IDs, and the absence of implicit RPG records.
- Added no generic command bus, failure ledger, unauthenticated route, HTTP contract, UI/navigation, generation integration, inventory/economy, effects, combat, or broader gameplay.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npx vitest run test/migration-v12.test.ts test/set-actor-attribute-command.test.ts test/role-sensitive-command-queries.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: 123 focused v12 server tests passed across three files; server source/test typecheck and build passed; the full server suite passed 630 with 1 skipped. Final independent review found no remaining findings.

Post-Slice-45 full deterministic gate:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typecheck/build passed; contracts 49; server 630 passed and 1 skipped; client 41; deterministic E2E 1. Total deterministic tests: 721 passed and 1 skipped. Live E2E was not run because it was not explicitly enabled. Exactly forty-five slices are complete; schema remains v12 corrective revision 1.

### 2026-08-03: M0 Slice 44 - Role-Sensitive Command Receipt And Event Reads

Independent authorization research selected exactly two public read operations: timeline-scoped event listing and command-ID receipt lookup. Current campaign membership is the sole authority for all roles; the strict shared event/receipt contracts are already caller-safe, so no generic audit or command-envelope projection was added.

Completed:

- Added synchronous factory and active-UoW `listCampaignEvents(actorPrincipalId, campaignId, timelineId): RpgEvent[]` and `getCommandReceipt(actorPrincipalId, campaignId, commandId): CommandReceipt | null`, with no named wrappers, HTTP, or UI.
- Owner, GM, player, and observer memberships receive identical public committed event/receipt data. Nonmembers, missing principals, and application owners without campaign membership receive `[]`/`null`; authorization requires a valid membership role plus existing principal/campaign parent.
- Timeline lists accept active or historical same-campaign timelines and order by revision then event ID. Missing, empty, and cross-campaign timelines return `[]`; historical receipts remain readable after later revisions or active-timeline changes.
- Each read validates IDs after lifecycle guards and uses exactly one explicit-column membership-rooted `SELECT`, no `SELECT *`, explicit factory transaction, write, clock, ID, RNG, private command payload, idempotency key, controller identity, or private actor state.
- Audit inspection roots from derived command/event/receipt identity unions so authorized missing or mismatched command, event, receipt, timeline, actor, source, type, revision, or parent links fail loudly rather than disappearing through inner joins. The same corruption remains undisclosed to outsiders.
- Public rows reconstruct only strict `RpgEvent` and `CommandReceipt` projections; command envelopes, failures/status, authorization principals, private audit records, generic event lookup/dump, pagination, route, UI, generation, and orchestration remain absent.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npx vitest run test/role-sensitive-command-queries.test.ts test/set-actor-attribute-command.test.ts test/migration-v12.test.ts test/campaign-queries.test.ts test/content-queries.test.ts test/role-sensitive-character-queries.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: 95 focused server tests passed across six files; the dedicated read suite passed 17 tests; server source/test typecheck and build passed; the full server suite passed 583 with 1 skipped. Independent review remediation added union-root orphan detection, valid membership/parent validation, audit-parent checks, expanded cross-scope/corruption tests, and outsider non-disclosure. Follow-up review found no runtime findings. Exactly forty-four slices are complete. Full deterministic totals remain the Slice 41 gate pending Slice 45.

### 2026-08-03: M0 Slice 43 - Execute `set_actor_attribute`

Independent authorization/execution research fixed membership-only owner/GM authority, identity-collision and exact-retry precedence, active revision/target/no-op ordering, event-ID-then-clock dependency use, trigger-compatible writes, and factory-only scope. Reviewed lifecycle decisions make the RPG sheet the sole timestamp owner and allow exact historical retries before active-timeline checks.

Completed:

- Added synchronous factory-only `Repository.executeSetActorAttribute(actorPrincipalId, envelope): CommandReceipt`, excluded from units of work, named wrappers, HTTP, UI, generation, and any generic executor/bus.
- Validates repository lifecycle, trusted principal ID, and the strict command envelope before one immediate transaction. Authorization uses only campaign owner/GM memberships; player/controller, observer, application-owner-only, missing-principal, and missing-campaign callers receive the same unavailable result before command disclosure or dependencies.
- Resolves campaign-scoped command ID and idempotency-key collisions after authorization. Only one exact full-envelope row with a complete, strictly valid matching persisted event/receipt is a retry; it returns the original event ID/time without writes or dependencies, including after later revisions or active-timeline replacement.
- A new command requires the requested timeline to be the campaign active timeline at exactly `expectedRevision`, then validates the complete actor/campaign-character/sheet link and one existing bounded attribute. Missing or malformed links/targets and same-value no-ops fail before dependencies and create nothing.
- Success consumes and validates one global event ID, then one canonical clock value. The timestamp may equal but not precede the sheet timestamp; it updates only `rpg_campaign_sheets.updated_at`, leaving campaign, campaign-character, and actor registration timestamps unchanged.
- Constructs strict `actor_attribute_set` and one-event receipt projections, then writes command, conditional attribute value, conditional sheet timestamp, exact one-step timeline revision, event, and receipt in that order inside the same immediate transaction. Every injected write-stage failure rolls all six writes back; ID or SQLite collisions do not retry.
- Defensive target reconstruction rejects malformed persisted IDs, timestamps, values, and same-campaign actor-to-wrong-character-sheet links. Null source turns execute and retry exactly; actual split command-ID/key rows conflict rather than selecting one.
- Added no player-controller mutation authority, attribute creation, failure/status persistence, command reads, event reads, public facts, narration hints, mechanics, RNG, provider calls, SSE, route, UI, or gameplay orchestration.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npx vitest run test/set-actor-attribute-command.test.ts test/migration-v12.test.ts test/campaign-character-creation.test.ts test/role-sensitive-character-queries.test.ts test/campaign-content-configuration.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: 123 focused server tests passed across five files; server source/test typecheck and build passed. The focused command suite has 44 tests; the full server suite passed 566 with 1 skipped. Independent review remediation closed malformed actor-sheet linkage, persisted-target validation, actual split-identity collision, dependency ordering, nullable source, rollback timestamp, denial-role, and UoW type-exclusion gaps. Follow-up review found no runtime findings. Exactly forty-three slices are complete. Full deterministic totals remain the Slice 41 gate pending Slice 45.

### 2026-08-03: M0 Slice 42 - Atomic Schema-v12 Command And Audit Migration

Independent migration research selected one timeline revision column and three normalized tables as the smallest persistence capable of exact `set_actor_attribute` retries, immutable public events, and one-event receipt reconstruction. The design explicitly runs the v11 sealed-pin correction before v12 and keeps actor-sheet-attribute validation in the future executor rather than coupling historical audit rows to mutable attribute rows.

Completed:

- Advanced fresh and migrated persistence to schema v12 while retaining corrective revision 1 as proof that sealed campaign-pin correction has run.
- Added bounded safe-integer `campaign_timelines.revision`, defaulting every existing and new timeline to zero without emitting commands, events, or receipts. SQL permits only exact one-step revision updates.
- Added normalized `campaign_commands` containing the complete strict `set_actor_attribute` envelope. Command IDs and idempotency keys are unique per campaign; same-campaign timeline and actor foreign keys restrict audited parent deletion.
- Added globally identified immutable `actor_attribute_set` events with canonical timestamps, unequal bounded before/after values, one event per command and timeline revision, null-safe source-turn equality, and triggers requiring exact command payload, expected next revision, and current timeline revision.
- Added immutable one-event `command_receipts` requiring one safe revision increment, matching command expected revision, and an exact campaign/command/event/revision foreign key.
- Update/delete and `INSERT OR REPLACE` guards make commands, events, and receipts immutable independently of SQLite recursive-trigger settings. Source-turn IDs remain validated non-FK provenance; no generic JSON payload, failure/status row, authorization principal, narration, RNG, attribute FK, or command bus was added.
- Fresh v12, marked v11 revision-1 migration, and unmarked valid v11 correction-then-migration share identical DDL. Representative legacy roleplay, usage, campaign, content, sheet, actor, private-state, class, attribute, proficiency, and choice data are preserved; only timeline revision zero is added.
- Malformed unmarked v11 pins fail before any v12 DDL. Fresh and migrated late failures roll back all v12 DDL/version changes for retry; a successful v11 correction intentionally remains committed if the subsequent independent v12 transaction fails, and retry then completes v12.
- Migrations consume zero clock, ID, or RNG values and create no implicit campaign, timeline, sheet, actor, command, event, or receipt records. No repository command service, read service, HTTP, UI, generation integration, or attribute mutation was added.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npx vitest run test/migration-v12.test.ts test/migration-v11.test.ts test/migration-v10.test.ts test/migration-v9.test.ts test/migration-v5.test.ts test/campaign-content-configuration.test.ts test/campaign-character-creation.test.ts test/campaign-character-deletion.test.ts test/campaign-creation.test.ts test/campaign-rename.test.ts test/campaign-membership-addition.test.ts test/campaign-session-attachment.test.ts test/campaign-session-detachment.test.ts test/repo.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: 254 focused server tests passed across 14 files; contract build and server source/test typecheck/build passed. Independent migration review remediation added contiguous revision/event enforcement, REPLACE-proof immutability, broader v11 preservation, nullable-source/global-event coverage, and correction-plus-v12-failure retry characterization. Follow-up review found no remaining findings. Exactly forty-two slices are complete. Full deterministic totals remain the Slice 41 gate pending the required Slice 45 gate.

### 2026-08-03: M0 Slice 41 - Atomic Initial Campaign Content Configuration

Independent authorization research fixed exact campaign-owner authority, campaign/owner/configuration/content disclosure order, zero-pack finality, order-insensitive exact-set retry semantics, malformed-state refusal, and zero dependency use before implementation. The post-batch independent review was fully remediated and its final pass found no actionable issues.

Completed:

- Added synchronous factory-only `Repository.configureCampaignContent(actorPrincipalId, campaignId, input)`, excluded from units of work, named wrappers, HTTP, and UI.
- Validates lifecycle, actor, campaign, and strict Slice 40 input before one immediate transaction. Inside it, campaign existence resolves before exact owner authority; GM/player/observer roles and current or former application ownership grant no bypass.
- Defensively requires the campaign owner relation and exact owner membership to agree before configuration/content disclosure. Corrupt ownership fails loudly.
- An unconfigured campaign has neither a selected-profile row nor pins. Success requires one existing valid profile and every requested exact pack to exist, use that profile, be sealed, and parse through strict metadata projections before inserting the profile then pins in supplied order.
- Zero packs form a complete final configuration. Existing valid configuration retries compare profile plus exact pack set without order sensitivity and return pins in deterministic JavaScript code-unit order; any different profile/version/set conflicts without writes.
- Existing pins/profile/global metadata are revalidated on every retry. Pins without a profile, missing/mismatched/unsealed packs, invalid identities, malformed metadata, or corrupt ownership fail loudly and are never completed, replaced, deleted, or repaired.
- The transaction consumes no clock, ID, or RNG, changes no campaign timestamp, retries no SQLite error, and rolls profile plus all pin writes back after failures at every tested write stage. Real competing equivalent writers converge after lock wait; different writers conflict after observing committed state.
- Added no profile/pack installation behavior, replacement, append, retarget, unpin, campaign lifecycle restriction, authentication, route, UI, generation, command bus, or gameplay orchestration. Existing content reads and all legacy response shapes remain unchanged.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
npx vitest run test/campaign-content-configuration.test.ts test/content-pack-installation.test.ts test/content-queries.test.ts test/migration-v11.test.ts test/migration-v10.test.ts test/campaign-creation.test.ts test/campaign-membership-addition.test.ts test/repo.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: contracts 49; focused server 163; contract/server builds and typechecks passed. The independent review found and remediation fixed canonical ordering, strict installed metadata validation on initial/retry paths, corrupt owner-link defense, and competing conflicting-writer coverage; final review found no remaining findings.

Post-Slice-41 full deterministic gate:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typecheck/build passed; contracts 49; server 507 passed and 1 skipped; client 41; deterministic E2E 1. Total deterministic tests: 598 passed and 1 skipped. Live E2E was not run because it was not explicitly enabled. Exactly forty-one slices are complete; persistence remains schema v11 revision 1.

### 2026-08-03: M0 Slice 40 - Campaign Content-Configuration Contracts

Independent contract research confirmed the existing schema permits one selected profile, zero pins, and one exact version per `packId`, but the documents did not specify a numerical campaign-pack bound. The reviewed decision sets the maximum to 64, preserves zero-pack configurations and supplied order, and treats repeated `packId` values as duplicates even when versions differ.

Completed:

- Added strict `ConfigureCampaignContentInput` with one rules-profile ID and zero through 64 exact content-pack identifiers.
- Added strict identifier-only `CampaignContentConfiguration` projection carrying campaign ID, selected profile ID, and the same bounded exact pack set.
- Reused existing exact pack-version and resource-ID contracts; duplicate `packId` values reject at the later pack path, while distinct packs may share version text.
- Both schemas reject unknown metadata, sealing, replacement, timestamp, path, definition, authorization, and lifecycle fields. Parsing preserves input order and performs no sorting or mutation.
- Contract ownership remains in `packages/contracts/src/rpg-content.ts`; root exports and focused tests were updated. No server type, persistence, transaction, clock, ID, RNG, authorization, service, wrapper, HTTP, UI, generation, replacement, or unpin behavior was added.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
```

Results: contract build and source/test typechecks passed; 49 contract tests passed across four files. Exactly forty slices are complete. Persistence remains schema v11 revision 1; full deterministic totals remain the Slice 39 closeout totals pending the required Slice 41 gate.

### 2026-08-03: M0 Slice 39 - Minimal v12 Attribute-Command Contracts

Independent research selected `set_actor_attribute` as the first consequential deterministic command because v11 already persists bounded existing attributes and this mutation needs no new mechanics, position allocation, RNG, inventory, or private event policy. Research confirmed v12 persistence is separable and remains deferred.

Completed:

- Added strict command/event ID aliases, exact safe untrimmed idempotency keys, safe integer revisions, and expected revisions that reserve one valid increment.
- Added one strict command expansion boundary: `set_actor_attribute` with a canonical attribute ID and integer value from -1,000 through 1,000.
- Added a strict envelope requiring command ID, idempotency key, campaign ID, timeline ID, non-null actor ID, expected revision, required nullable source-turn ID, and the reviewed command.
- Added one strict event expansion boundary: `actor_attribute_set` with event/command/campaign/timeline/actor IDs, required nullable source turn, positive revision, canonical commit timestamp, and unequal bounded before/after values.
- Added one strict receipt requiring exactly one event, `revisionAfter = revisionBefore + 1`, and matching event revision, command ID, and campaign ID.
- Rejected unknown narration hints, public facts, authorization principals, mechanics, RNG, HP, inventory, private notes, speculative commands, and speculative events.
- Added no schema-v12 migration, timeline revision, event/receipt/idempotency storage, command executor/bus, authorization service, mutation, HTTP, UI, gameplay, or generation integration. Current persistence remains schema v11.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
```

Results: 47 contract tests passed across four files, including 13 focused command tests; contract build and source/test typechecks passed. Exactly thirty-nine slices are complete. Final review and gate results are recorded in the closeout immediately below.

Final review closeout:

- Review found that direct SQL could pin an unsealed pack and finalized character creation did not independently check sealing. Remediation added shared pin insert/retarget triggers, a defensive sealed-pack creation join, and atomic schema-v11 revision 1 handling.
- Fresh and v10-to-v11 paths record revision 1 only after sealed-pin validation. Existing unmarked v11 databases validate and atomically install the same triggers/marker. Missing or unsealed legacy pins fail without automatic publication/deletion; after explicit repair, reopening retries successfully. Trigger collisions also roll back cleanly.
- Final independent verification found no runtime findings. Slice 39 remains contracts-only and schema persistence remains v11 revision 1.

Final deterministic gate:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typecheck/build passed; contracts 47; server 482 passed and 1 skipped; client 41; deterministic E2E 1. Total deterministic tests: 571 passed and 1 skipped. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled. Exactly thirty-nine slices are complete.

### 2026-08-03: M0 Slice 38 - Role-Sensitive Campaign-Character Reads

Independent authorization research fixed the projection matrix and required private-state gating inside SQL before implementation.

Completed:

- Added strict discriminated `CampaignCharacterRead`: `{ access: "public", projection: Public... }` or `{ access: "privileged", projection: Privileged... }`, enabling safe mixed-list narrowing while retaining the privileged creation return.
- Added synchronous factory and active-unit-of-work `listCampaignCharacters` and `getCampaignCharacter`, with no named wrappers, routes, or UI.
- Membership-only policy: owner/GM receive every aggregate privileged; players receive privileged data only for actors they control and public data for all others; observers receive public data; nonmembers and application owners without membership receive `[]`/`null`.
- Each operation uses one explicit-column statement rooted in `campaign_memberships`. SQL `CASE` expressions gate the access marker, controller ID, and private notes so unauthorized private values are never fetched for projection stripping.
- Reconstructs classes, attributes, proficiencies, and choices in persisted position order within the same statement; lists order by campaign-character `created_at`, then ID. Empty optional arrays and position gaps remain valid.
- Uses left joins/presence markers so authorized missing sheet, actor, private state, zero classes, malformed JSON, or invalid projection data fails loudly instead of disappearing/downgrading. Unauthorized access to the same corruption remains non-disclosing.
- Validates after lifecycle guards, consumes zero clock/ID/RNG, performs no write or explicit factory transaction, and preserves active/expired UoW behavior.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
npx vitest run test/role-sensitive-character-queries.test.ts test/campaign-character-creation.test.ts test/campaign-character-deletion.test.ts test/migration-v11.test.ts test/migration-v10.test.ts test/content-pack-installation.test.ts test/content-queries.test.ts test/campaign-*.test.ts test/repo.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Initial Slice 38 results were contracts 33 and focused server 230. Independent review found no authorization, leakage, migration, ordering, or lifecycle defects; remediation added the missing direct `sessions.character_id` deletion guard and standardized private notes on the SQLite-compatible 4,000 Unicode-code-point limit. Remediation passed contracts 34, focused server 47, and full server 473 passed 1 skipped; contract/server builds/typechecks passed. Follow-up independent review found no runtime findings.

Post-v11 full deterministic gate:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typecheck/build passed; contracts 34; server 473 passed and 1 skipped; client 41; deterministic E2E 1. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled. Thirty-eight slices are complete.

### 2026-08-03: M0 Slice 37 - Atomic Campaign-Character Creation

Independent authorization research fixed caller/controller roles, non-disclosure, duplicate semantics, exact-content checks, dependency order, and legacy persona deletion compatibility before implementation.

Completed:

- Added synchronous factory-only `Repository.createCampaignCharacter(actorPrincipalId, input): PrivilegedCampaignCharacterProjection`, excluded from units of work, named wrappers, HTTP, and UI.
- Validates actor and strict complete input before one immediate transaction. A membership join authorizes only campaign owner or GM and collapses missing/unauthorized campaigns to one unavailable error; application ownership grants no bypass.
- Requires one exact existing opaque Velvet persona, rejects any same-campaign persona duplicate instead of treating it as an idempotent retry, and permits the same persona in another campaign.
- Allows owner, GM, or player controllers; rejects observer/nonmember/missing controllers generically. All race/background/class/choice references must match an exact campaign pin and exact definition before dependency use.
- Consumes and validates campaign-character ID, sheet ID, actor ID, then one clock value. Equal campaign time is accepted, backward time rejects after exact dependency consumption, one timestamp supplies all created/updated fields, and campaign `updated_at` is unchanged.
- Inserts campaign character, sheet, ordered classes, attributes, proficiencies, choices, actor, and private state atomically. Omitted notes persist/return as `null`; supplied notes remain byte-for-byte. Any late SQL or ID/clock failure rolls back all rows without retry.
- Added real SQLite write-lock contention coverage and proved no RNG/mechanics behavior.
- Updated named legacy `deleteCharacter` to guard direct `sessions.character_id`, participant junctions, and campaign use plus lore cleanup/deletion inside one immediate transaction. Linked personas produce the existing repository `in-use` and unchanged HTTP 409 body rather than an FK/cascade surprise; removing all references releases deletion.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm test --workspace @velvet/contracts
npx vitest run test/campaign-character-creation.test.ts test/campaign-character-deletion.test.ts test/migration-v11.test.ts test/migration-v10.test.ts test/content-pack-installation.test.ts test/content-queries.test.ts test/campaign-*.test.ts test/repo.test.ts test/api-characters.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: contracts 32 passed across three files; focused server 217 passed across 14 files; contract/server builds and server typecheck passed. Thirty-seven slices are complete. Full deterministic totals remain the reviewed Slice 34 v10 gate pending Slice 38 and v11 review.

### 2026-08-03: M0 Slice 36 - Atomic Schema-v11 Campaign Sheets And Actors

Independent migration research mapped every Slice 35 field to normalized persistence and fixed same-campaign, exact-content, controller, ordering, and deletion constraints before DDL changes.

Completed:

- Advanced schema atomically from v10 to v11 with shared fresh/migrated DDL and an exact campaign-pack-pin unique index.
- Added eight tables for campaign characters, sheets, ordered classes/attributes/proficiencies/choices, player-character actors, and separate actor private state.
- Enforced one persona per campaign while permitting the same persona in multiple campaigns; one sheet and actor per campaign character; and linked actor/sheet/campaign-character campaign identity.
- Required race, background, every class, and every resolved choice to reference both an exact campaign-pinned pack version and an exact definition of the correct kind. Stored all visible arrays with explicit bounded zero-based positions.
- Required actor controllers to be campaign members, while leaving eligible-role policy to the creation service. Persisted only the first `player-character`/`principal` actor literals and nullable bounded private notes.
- Restricted persona, pinned pack, and controller membership deletion while referenced. Campaign-character/campaign deletion cascades normalized children while preserving the Velvet persona and global profile/pack/definition rows.
- Preserved representative v10 campaign/session/attachment, owner/player memberships, rules profile, sealed packs, definitions, selections, and pins exactly; created no implicit campaign characters, sheets, actors, or private state; consumed zero clock/ID values.
- Tested fresh/migrated DDL parity, resource/time/link/content/position/cardinality/private constraints, `foreign_key_check`, and late fresh/migrated failure rollback/retry.
- Added no creation/read service, derived mechanics, progression, resource state, HTTP, or UI.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npx vitest run test/migration-v11.test.ts test/migration-v10.test.ts test/migration-v9.test.ts test/migration-v5.test.ts test/content-pack-installation.test.ts test/content-queries.test.ts test/campaign-*.test.ts test/repo.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: 192 focused server tests passed across 13 files; contract/server builds and server typecheck passed. Thirty-six slices are complete. Full deterministic totals remain the reviewed Slice 34 v10 gate pending the v11 batch closeout.

### 2026-08-03: M0 Slice 35 - Strict v11 Campaign-Character And Actor Contracts

Completed:

- Added a strict complete campaign-character creation input linking an opaque existing Velvet persona ID, campaign, controller principal, exact race/background/class/content choices, attributes, proficiencies, and optional private notes.
- Added bounded class levels and arrays with duplicate validation for exact class references, attribute IDs, proficiency category/ID pairs, and resolved choice IDs. Multi-class representation is supported without enforcing game-rule totals.
- Added strict campaign-character and sheet projections plus the first actor kind only: a principal-controlled player character linked to its campaign character and sheet.
- Added linked public and privileged aggregate projections. Public actors cannot contain controller identity or private notes; privileged actors require both fields (notes nullable), and all campaign/sheet/actor links must agree.
- Preserved opaque legacy persona IDs without trimming or resource-ID rules while requiring shared resource IDs and canonical millisecond UTC timestamps for new records.
- Added no persona-edit fields, derived mechanics, HP/resources, inventory, progression, drafts, RNG allocation, NPC/enemy variants, persistence, route, or UI.

Focused verification completed:

```bash
npm run typecheck --workspace @velvet/contracts
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
```

Results: 32 contract tests passed across three files, including 10 new v11 character/actor tests; contract build and typecheck passed. Thirty-five slices are complete. Full deterministic totals remain the reviewed Slice 34 v10 gate.

### 2026-08-03: M0 Slice 34 - Atomic Immutable Content-Pack Installation

Independent authorization/collision research limited installation to global application administration and identified the missing profile-bootstrap metadata in the Slice 31 input.

Completed:

- Extended strict `InstallContentPackInput` with nested rules-profile metadata while retaining the top-level profile ID, complete seven-kind arrays, exact path-safe pack version, and unknown/path/file rejection.
- Added factory-only synchronous `Repository.installContentPack(actorPrincipalId, input): ContentPack`, excluded from units of work, named wrappers, HTTP, and UI.
- Validates actor and complete normalized input before SQL and rejects duplicate definition IDs within a kind; the same definition ID in different kinds remains valid.
- Uses one immediate transaction and authorizes only the current transferable application owner before profile/pack collision queries. Campaign roles and former application owners receive no collision disclosure.
- Creates a missing profile or requires exact metadata equality, then inserts an unsealed pack and definitions in foreign-key, contract-kind, and supplied order before atomically sealing it. Complete persisted-equivalent retries are idempotent regardless of definition array order; changed ordered tags, profile/pack metadata, or missing/extra/changed definitions conflict.
- Consumes zero clock, ID, and RNG values. Profile, pack, and partial definition writes roll back together on any SQL failure; concurrent instances converge for equal inputs and serialize conflicting inputs without retries.
- Creates no campaign profile selection or pack pin, catalog rows, mechanics, timestamps, route, or UI.
- Review remediation added v10 sealed-pack state: only the exact unsealed-to-sealed transition is allowed, sealed packs reject definition append, pack/definition update/delete remains forbidden, referenced rules-profile metadata is immutable, and reads expose sealed aggregates only. Pack inputs cap each kind at 256 and the complete pack at 1,024 definitions.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
npx vitest run test/content-pack-installation.test.ts test/content-queries.test.ts test/campaign-*.test.ts test/migration-*.test.ts test/repo.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Initial Slice 34 results were contracts 21 and focused server 182. Independent review remediation passed contracts 22; focused remediation 96; campaign-focused 95; full server 426 passed and 1 skipped; contract/server builds and typechecks passed. Follow-up independent review found no runtime findings.

Post-v10 full deterministic gate:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typecheck/build passed; contracts 22; server 426 passed and 1 skipped; client 41; deterministic E2E 1. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled. Thirty-four slices are complete.

### 2026-08-03: M0 Slice 33 - Role-Appropriate Content Reads

Independent authorization research fixed the least-privilege split: global catalog reads belong only to the current application owner; campaign-selected content reads belong equally to every campaign membership role and receive no application-owner bypass.

Completed:

- Added ten synchronous factory and active-unit-of-work reads for global profiles/packs/exact-pack definitions and campaign-selected profile/pinned packs/pinned exact definitions. Added no named wrappers.
- Global queries authorize through the transferable `application_owner` relation. Campaign queries authorize only through `campaign_memberships`; owner, GM, player, and observer receive the same metadata because v10 contains no secret fields.
- Lists collapse absence/denial to `[]`; gets collapse them to `null`. Campaign missing, unconfigured, and unpinned states follow the same non-disclosing behavior.
- Every operation uses one explicit-column authorization-bearing `SELECT`, no `SELECT *`, write, or explicit factory transaction. Profiles order by ID, packs by lexical ID/version, and definitions by public kind order then definition ID.
- Strict identifiers/references validate after lifecycle guards. Tag parsing preserves stored order/duplicates and malformed persisted projections fail loudly rather than returning partial/default data.
- Reads consume zero clock, ID, and RNG values. Active UoW results match factory results and expired UoWs fail before input validation.
- Added no HTTP, UI, authentication assumption, campaign pin mutation, catalog installation, or mechanics.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npx vitest run test/content-queries.test.ts test/campaign-*.test.ts test/migration-*.test.ts test/repo.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
```

Results: 173 focused server tests passed across 11 files; contracts/server builds and server typecheck passed. Thirty-three slices are complete. Full deterministic totals remain pending the v10 batch gate after Slice 34.

### 2026-08-03: M0 Slice 32 - Atomic Schema-v10 Rules And Content Migration

Independent migration research selected five additive tables and one shared DDL helper for fresh/migrated parity.

Completed:

- Advanced the latest schema atomically from v9 to v10. Fresh databases create v10 directly; existing versions continue sequentially through v9 and then v10.
- Added rules profiles, immutable exact-version content packs, one shared discriminated definition table, one selected rules profile per configured campaign, and one exact pinned version per pack ID per campaign.
- Composite foreign keys require every campaign pack pin to use the campaign's selected profile and a pack version belonging to that profile. Explicit child indexes cover foreign-key reads.
- Stored tags as validated JSON arrays while preserving supplied order and duplicates. SQL checks/triggers enforce shape, bounds, strict tags, safe exact versions, and the seven definition kinds.
- Enforced pack and definition immutability against direct update/delete. Campaign deletion cascades only campaign profile/pack selections and retains global profiles, packs, and definitions.
- Preserved representative v9 campaign, timeline, owner/GM membership, session, participant, and attachment rows exactly; created no implicit rules profile, pack, definition, selection, or pin; consumed zero clock/ID values.
- Tested identical fresh/migrated DDL, constraints and foreign keys, `foreign_key_check`, and a late DDL collision that rolls schema/version changes back to v9 and succeeds on retry.
- Added no content installer/read service, catalog rows, timestamps, mechanics, routes, UI, or API changes.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm --workspace velvet-mvp-server exec vitest run test/repo.test.ts test/migration-v10.test.ts test/migration-v9.test.ts test/migration-v5.test.ts
npm --workspace velvet-mvp-server run typecheck
npm --workspace velvet-mvp-server run build
```

Results: 71 focused server tests passed across four files; contracts and server builds passed; server typecheck passed. Thirty-two slices are complete. Full deterministic totals remain pending the v10 batch gate after Slice 34.

### 2026-08-03: M0 Slice 31 - Strict v10 Rules And Content Contracts

Completed:

- Added strict shared rules-profile identifiers/projections, content-pack identifiers/projections, and complete pack-install input contracts.
- Pack versions are opaque, bounded, path-safe exact strings; no version ranges, wildcard resolution, semver dependency, arbitrary paths, or files are accepted.
- Added discriminated class, race, background, item, spell, ability, and enemy metadata definitions plus exact references carrying pack ID, pack version, definition kind, and definition ID.
- Definitions contain only bounded original metadata (`definitionId`, kind, name, description, tags). Complete payloads require ordered arrays for all seven kinds, cap each kind at 256 and total definitions at 1,024, reject duplicate IDs within a kind, and permit the same ID across different kinds.
- Added no persistence, migration, installation behavior, mechanics/effects DSL, third-party catalog, HTTP, UI, or dependency.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
```

Results: 21 contract tests passed across two files; contract build and typecheck passed. Thirty-one slices are complete. Full deterministic totals remain unchanged pending the v10 batch gate.

### 2026-08-03: M0 Slice 30 - Owner-Authorized Campaign-Session Detach

Independent pre-slice research selected explicit detach instead of membership-role update. Detach is the smaller safe boundary because it deletes only `campaign_sessions`; role update would mutate the owner-invariant and authorization-bearing membership table without defined role-change provenance or concurrency policy.

Completed:

- Added strict shared `DetachCampaignSessionInput`, preserving opaque, nonempty legacy session IDs and rejecting unknown fields.
- Added synchronous factory-only `Repository.detachCampaignSession(actorPrincipalId, input)`. After validation it opens one immediate transaction, loads the campaign, authorizes only its exact owner, and deletes only the row matching both campaign and session IDs with `RETURNING`.
- Authorized missing sessions, unattached sessions, cross-campaign attachments, and repeated requests return `null`, preventing cross-campaign disclosure. Stopped-session attachments may be detached. Application ownership grants no bypass.
- Detach consumes zero clock, ID, and RNG values; preserves the original attachment projection on success; does not advance campaign `updated_at`; and leaves the session, campaign, timeline, memberships, and unrelated attachments unchanged. SQL failures roll back without retry and competing instances serialize to one result plus one `null`.
- Kept detach out of units of work, named compatibility wrappers, HTTP, UI, schema changes, role updates/removal, audit records, and gameplay.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm run typecheck --workspace @velvet/contracts
npx vitest run test/campaign-session-detachment.test.ts test/campaign-session-attachment.test.ts
npm run typecheck --workspace velvet-mvp-server
npm run build --workspace velvet-mvp-server
npx vitest run test/repo.test.ts
```

Results: contracts 15 passed; campaign attachment/detachment 30 passed; repository 59 passed; contract and server builds/typechecks passed. Thirty slices are complete. No full gate was required for this isolated pre-v10 slice; the latest full deterministic totals remain contracts 14, server 389 passed and 1 skipped, client 41, deterministic E2E 1.

### 2026-08-03: Slices 25-29 Final Review And Closeout

The final review found no runtime defects. Review remediation added Slice 27 denial coverage for `gm`, `player`, `observer`, and a transferred application owner.

Final focused verification passed: contracts 14; server campaign-focused 147; contract/server typechecks passed.

Final full gate: root typecheck/build passed; contracts 14; server 389 passed 1 skipped; client 41; deterministic E2E 1; live E2E not run because `VELVET_E2E_LIVE=1` was not enabled.

At that historical checkpoint, twenty-nine slices were complete and the engineering handoff was `HANDOFF.md`.

### 2026-08-03: M0 Slice 29 - Owner-Authorized Campaign Rename

Completed:

- Added strict shared `RenameCampaignInput`, reusing `campaignNameSchema` so accepted names are trimmed, nonempty, and at most 200 characters, with unknown fields rejected.
- Added synchronous factory-only `Repository.renameCampaign(actorPrincipalId, campaignId, input): Campaign`, excluded at compile time from `RepositoryUnitOfWork` and unavailable through named wrappers, nested repository transactions, HTTP, or UI.
- Validated actor, campaign ID, and input before opening one immediate transaction. The operation loads the campaign, authorizes only its campaign owner, then consumes one validated clock value and zero IDs. Application ownership grants no bypass, including after transfer.
- Rejected timestamps earlier than the campaign's current `updated_at`, while allowing equal timestamps. Every authorized request performs a fresh write of the trimmed name and `updated_at`, including same-name requests, and returns the exact persisted `Campaign` projection.
- Propagated clock, timestamp-validation, and SQLite failures without retry. Failures roll back the rename, while successful renames leave memberships, timelines, and session attachments unchanged.
- Added focused coverage for the strict input contract, all member roles and nonmembers, application-owner transfer, exact output and rows, unchanged related rows, validation/lifecycle/nesting and lookup/authorization precedence, dependency order/counts, equal/backward/malformed clocks, same-name writes, SQL rollback, and compile-time UoW exclusion. Added no schema, API documentation, route, UI, command receipt, nested transaction support, detach/delete/archive/publish behavior, or v10 work.

Focused verification completed:

```bash
npm --workspace @velvet/contracts run build
npm --workspace @velvet/contracts run test
npm --workspace velvet-mvp-server run test -- test/campaign-rename.test.ts test/campaign-membership-addition.test.ts test/campaign-session-attachment.test.ts test/campaign-queries.test.ts test/campaign-creation.test.ts test/migration-v9.test.ts test/repo.test.ts
npm --workspace @velvet/contracts run typecheck
npm --workspace velvet-mvp-server run typecheck
```

Initial Slice 29 results were contracts 14 passed; 146 focused campaign-rename, campaign-membership, campaign-attachment, campaign-query, campaign-creation, schema-v9 migration, and repository tests passed; contracts and server typechecking passed. Final review remediation raised the server campaign-focused total to 147 by adding Slice 27 denial coverage for `gm`, `player`, `observer`, and a transferred application owner. The final focused and full-gate results are recorded in the closeout entry above.

### 2026-08-03: M0 Slice 28 - Add-Only Campaign Membership

Completed:

- Added strict shared `CampaignMemberRole` (`gm`, `player`, or `observer` only), `AddCampaignMembershipInput`, and exact `CampaignMembership` contracts. Owner membership creation is not representable through this operation.
- Added synchronous factory-only `Repository.addCampaignMembership(actorPrincipalId, campaignId, input)`, excluded at compile time from `RepositoryUnitOfWork` and unavailable through named wrappers, nested repository transactions, HTTP, or UI.
- Used one immediate transaction after strict validation. The operation looks up the campaign, authorizes only its campaign owner, verifies the target principal, and resolves an existing membership in that order. Application ownership grants no bypass, and transferring it does not change campaign authority.
- Same-role retries return the original row without clock use. Different-role and owner-target requests conflict. New membership creation consumes one validated clock and zero IDs, rejects a timestamp before campaign `updated_at`, then inserts the membership and advances campaign `updated_at` atomically.
- Propagated malformed/backward clock and SQLite failures without retry. Trigger failures roll back both membership and campaign timestamp changes; immediate serialization lets competing repository instances resolve the committed same-role row idempotently or reject a different-role conflict without reclocking.
- Added focused coverage for exact contracts, all three member roles, exact rows/output, validation and lookup precedence, application-owner transfer, denial of member-role actors, missing targets, idempotency/conflicts, owner targets, clock/ID counts, equal/backward/malformed time, insert/update trigger rollback, competing instances/no retry, lifecycle/nesting guards, and compile-time UoW exclusion. Added no schema, API documentation, route, UI, role update/removal, or principal provisioning.

Focused verification completed:

```bash
npm --workspace @velvet/contracts run build
npm --workspace @velvet/contracts run test
npm --workspace velvet-mvp-server run test -- test/campaign-membership-addition.test.ts test/campaign-session-attachment.test.ts test/campaign-queries.test.ts test/campaign-creation.test.ts test/migration-v9.test.ts test/repo.test.ts
npm --workspace @velvet/contracts run typecheck
npm --workspace velvet-mvp-server run typecheck
```

Results: contracts 13 passed; 127 focused campaign-membership, campaign-attachment, campaign-query, campaign-creation, schema-v9 migration, and repository tests passed; contracts and server typechecking passed. This gate includes the current Slice 27 `stopped_at` provenance regression, which raises Slice 27's focused server count from 103 to 104. The full suite was not rerun, so the historical Slice 24 full-suite totals below remain the latest recorded full gate.

### 2026-08-03: M0 Slice 27 - Owner-Authorized Campaign-Session Attachment

Completed:

- Added strict shared `AttachCampaignSessionInput` and `CampaignSessionAttachment` contracts. `campaignId` uses the resource-ID contract, while `sessionId` remains an opaque nonempty legacy string with no trimming or resource-ID restriction.
- Added synchronous factory-only `Repository.attachCampaignSession(actorPrincipalId, input)`, excluded at compile time from `RepositoryUnitOfWork` and unavailable through named wrappers, nested repository transactions, HTTP, or UI.
- Used one immediate transaction. The operation looks up the target campaign and authorizes its current owner first, then checks the session and any existing attachment. A same-campaign attachment returns idempotently without clock use, a different-campaign attachment conflicts, and a stopped session is rejected only when no attachment already exists.
- New attachments consume one validated clock value and zero IDs. Clock and SQLite failures roll back without retry; invalid input, missing or unauthorized resources, conflicts, stopped sessions, closed repositories, and nested calls consume no dependencies.
- Preserved an existing attachment after session stop and the schema-v9 cascade behavior: campaign deletion removes the attachment but not the legacy session, and session deletion continues to remove its attachment. Added no detach operation, schema change, API documentation, command bus, generation integration, or gameplay behavior.
- Added focused coverage for exact contracts/projections, opaque legacy IDs, owner and lookup precedence, idempotency after stop, conflicts, stopped-new rejection, clock/ID counts and validation, rollback, lifecycle/nesting guards, compile-time UoW exclusion, and cascade preservation.

Focused verification completed:

```bash
npm --workspace @velvet/contracts run build
npm --workspace @velvet/contracts run test
npm --workspace velvet-mvp-server run test -- test/campaign-session-attachment.test.ts test/campaign-queries.test.ts test/campaign-creation.test.ts test/migration-v9.test.ts test/repo.test.ts
npm --workspace @velvet/contracts run typecheck
npm --workspace velvet-mvp-server run typecheck
```

Results: contracts 11 passed; 104 focused campaign-attachment, campaign-query, campaign-creation, schema-v9 migration, and repository tests passed after adding `stopped_at` provenance coverage; contracts and server typechecking passed. The full suite was not rerun, so the historical Slice 24 full-suite totals below remain the latest recorded full gate.

### 2026-08-03: M0 Slice 26 - Authorized Campaign Queries

Completed:

- Added strict shared `CampaignAccess`, extending the exact `Campaign` projection with the requesting membership's validated `actorRole`.
- Added synchronous `listCampaigns(actorPrincipalId)` and `getCampaign(actorPrincipalId, campaignId)` to both the repository factory and `RepositoryUnitOfWork`. Both validate resource IDs after lifecycle guards and consume no clock, ID, or RNG dependency.
- Authorized each read only through `campaign_memberships`, with no application-owner bypass. Missing and unauthorized gets both return `null`; lists include only the actor's memberships and order by `created_at ASC, id ASC`.
- Used one explicit-column membership join per operation, with no write, explicit transaction, dependency, named wrapper, HTTP route, UI, or schema change.
- Added focused coverage for the exact projection and SQL/order, all four roles, cross-actor filtering, owner non-bypass, missing/unauthorized behavior, ID validation, active/expired unit-of-work behavior, closed/expired precedence, no writes, and no dependency consumption.

Focused verification completed:

```bash
npm --workspace @velvet/contracts run build
npm --workspace @velvet/contracts run test
npm --workspace velvet-mvp-server run test -- test/campaign-queries.test.ts test/campaign-creation.test.ts test/repo.test.ts
npm --workspace @velvet/contracts run typecheck
npm --workspace velvet-mvp-server run typecheck
```

Results: contracts 9 passed; 82 focused campaign-query, campaign-creation, and repository tests passed; contracts and server typechecking passed. The full suite was not rerun, so the historical Slice 24 full-suite totals below remain the latest recorded full gate.

### 2026-08-03: M0 Slice 25 - Atomic Campaign Creation Service

Completed:

- Added strict shared `CreateCampaignInput` and `Campaign` runtime contracts. Campaign names are trimmed and bounded; campaign IDs and timestamps reuse the schema-v9 primitives.
- Added synchronous factory-owned `Repository.createCampaign(actorPrincipalId, input)`, not a unit-of-work method or named global wrapper. The actor is separate from client-controlled input and must match the current singleton application owner.
- Used one immediate transaction for owner authorization and the three deferred-FK writes. The operation consumes campaign ID, timeline ID, then one clock value; validates generated values before writing; and inserts campaign, active timeline, then owner membership atomically.
- Preserved owner transfer, propagated dependency/validation/SQLite failures without retries, and rolled back campaign/timeline rows after later failures. Closed repositories, invalid input, unauthorized actors, and nested repository transactions fail before dependency consumption.
- Added no HTTP route, UI, session attachment operation, campaign update/delete, command bus, receipt, generation integration, schema change, or RNG use.

Focused verification completed:

```bash
npm --workspace @velvet/contracts run build
npm --workspace velvet-mvp-server run test -- test/campaign-creation.test.ts test/migration-v9.test.ts test/repo.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: 79 focused campaign-creation, schema-v9, and repository tests passed; server typechecking passed. The combined full gate remains scheduled after Slices 27-29.

### 2026-08-02: M0 Slice 24 - Schema-v9 Principal And Campaign Foundation

Completed:

- Added shared `resourceIdSchema`, `utcIsoTimestampSchema`, and `campaignRoleSchema` contracts with inferred types. New v9 resource IDs use the documented bounded character set, and new timestamps require canonical millisecond UTC ISO values.
- Advanced SQLite atomically from v8 to v9 and made fresh databases create v9 directly. Added `principals`, a non-deletable singleton `application_owner`, `campaigns`, `campaign_timelines`, `campaign_memberships`, and `campaign_sessions` with foreign keys, checks, and child-key indexes.
- Seeded stable local principal `local-owner` and application ownership without consuming clock, ID, or RNG dependencies. Application ownership remains exactly one and can later transfer to a non-local principal.
- Required every campaign to reference its own active timeline and exact owner membership through deferred composite foreign keys. Campaign owners cannot be removed or demoted, a second owner is rejected, and cross-campaign active timelines are rejected.
- Limited each existing session to at most one campaign. Deleting a campaign removes its timeline, memberships, and attachments while preserving legacy sessions; deleting a session removes only its attachment. Legacy opaque session IDs remain attachable.
- Preserved representative v8 characters, sessions, consent, participants, branches, memories, summaries, context, lore, harness/provider payloads, and usage rows exactly. Existing records receive no campaigns, timelines, memberships, attachments, sheets, or other implicit RPG state.
- Added fresh/migrated schema parity, canonical timestamp, owner-transfer/cardinality, foreign-key, cascade, v8 preservation, transactional rollback/retry, and no-dependency-consumption tests. No campaign repository CRUD, command service, HTTP route, UI, navigation, generation, or gameplay behavior was added.
- Corrected one unrelated flaky session-query assertion that had assumed two independent ambient clock reads always landed in the same millisecond; runtime timestamp behavior is unchanged.

Focused verification completed:

```bash
npm --workspace @velvet/contracts run test
npm --workspace velvet-mvp-server run test -- test/migration-v9.test.ts test/migration-v5.test.ts test/branch.test.ts test/repo.test.ts
npm --workspace @velvet/contracts run typecheck
npm --workspace velvet-mvp-server run typecheck
```

Results: contracts 6 passed; 71 focused migration, branch, and repository tests passed; contracts and server typechecking passed.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 6 passed; server 305 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled.

Remaining work recorded at Slice 24 completion:

- Add a first atomic campaign creation service and contracts using injected IDs and clock, while keeping HTTP and UI out until authorization and compatibility boundaries are explicit. Completed in Slice 25.
- Add command envelope and receipt contracts with the first consequential deterministic RPG command, not as a speculative command bus.
- Keep provider-backed generation and SSE coordination in place until their shared service boundary is characterized.
- Do not add RPG character creation UI before campaign/content foundations and sheet contracts exist.

### 2026-08-02: M0 Slice 23 - Provider Update Route Extraction

Completed:

- Moved exact legacy `PUT /api/provider` handling from `app.ts` into `server/src/routes/roleplay/provider.ts` under `/api`, using the named repository wrapper and existing validation/policy helpers.
- Preserved validation precedence and exact errors, empty/array/unknown-only acceptance, partial updates, nested sampler/pricing behavior, API-key redaction, malformed-value failures, ignored client provenance, and request IDs.
- Kept provider persistence, ambient provider timestamps, generation/provider use, clients, and `buildApp` runtime ownership unchanged.

### 2026-08-02: M0 Slice 22 - Provider Update Compatibility Characterization

Completed:

- Added focused characterization for provider PUT top-level bodies, no-op writes, URL-validation precedence, partial updates, clamps, nulls, stop filtering, start-reply sanitization, redaction, ignored provenance, malformed nested values, and exact prefix ownership.
- Added no production behavior in this preparatory slice and did not change provider timestamps or repository ownership.

### 2026-08-02: M0 Slice 21 - Usage Read Route Extraction

Completed:

- Moved exact legacy `GET /api/usage` handling from `app.ts` into `server/src/routes/roleplay/usage.ts` under `/api`.
- Preserved the empty response, `{ usage }` envelope, provider/estimated totals, current provider-pricing lookup, null and computed costs, grouping and descending-token ordering, session titles, deleted-session behavior, and header-only request IDs.
- Kept usage writes, provider calls, generation, session deletion, repository aggregation, and pricing semantics unchanged.

### 2026-08-02: M0 Slice 20 - Provider Read Route Extraction

Completed:

- Moved exact legacy `GET /api/provider` handling from `app.ts` into `server/src/routes/roleplay/provider.ts` under `/api`.
- Preserved the exact public response and property order, nested pricing/sampler shape, persisted values, `hasApiKey` projection, API-key redaction, ambient default timestamp behavior, exact prefix, and header-only request IDs.
- Kept provider persistence, generation, clients, and runtime ownership unchanged.

Focused verification for Slices 20-23 completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-provider.test.ts test/api-usage.test.ts test/api.test.ts test/api-session-lifecycle.test.ts test/repo.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: 90 focused provider, usage, integration, lifecycle, and repository tests passed; server typechecking passed.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 4 passed; server 301 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled.

Remaining M0 work:

- Characterize the next route or persistence boundary before selecting another narrow slice; do not move provider-backed generation or SSE through an uncharacterized dependency bag.
- Keep default harness reads and provider timestamps on their existing ambient behavior unless separate explicit slices change them.
- Add a first atomic campaign creation service and contracts on the completed v9 identity/campaign foundation. Completed in Slice 25.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Do not add premature RPG UI; campaign and gameplay navigation still depend on later foundations.

### 2026-08-02: M0 Slice 19 - Deterministic Factory Harness Update Timestamp

Completed:

- Added only synchronous `updateHarnessSettings` to the repository factory, not to the unit of work. Its private helper preserves the existing read, copy, patch-normalization, timestamp, serialization/upsert, and return order while obtaining the update timestamp from the injected clock.
- Preserved exact harness shape and property order, `id: "harness"`, ignored client provenance fields, omitted fields, all normalization quirks, accepted no-op writes, malformed-patch timing, and prompt-template override behavior. Successful no-op writes receive a fresh timestamp; clock failures leave prior storage unchanged; updates consume no ID or RNG.
- Kept the named `async updateHarnessSettings` compatibility wrapper on `getDb()` plus `systemRuntime.clock`, with harness and prompt-template routes unchanged. `buildApp({ runtime })` remains limited to request-ID behavior.
- Left `readHarness()` and `defaultHarnessSettings()` unchanged. Missing or malformed harness rows therefore still use the existing ambient default timestamp rather than the factory clock.
- Added no schema, API, UI, navigation, campaign, gameplay, generation, or SSE behavior; SQLite remains at schema v8.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/repo.test.ts test/api-harness.test.ts test/api-prompt-templates.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: 100 focused repository, harness API, and prompt-template API tests passed; server typechecking passed.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 4 passed; server 284 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled.

Remaining M0 work:

- Characterize usage/provider routes before selecting another narrow extraction or dependency-ownership slice.
- Keep default harness reads on their existing ambient defaults unless a separate explicit slice changes that behavior.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Do not add premature RPG UI; campaign and gameplay navigation still depend on later foundations.

### 2026-08-01: M0 Slice 18 - Deterministic Factory Lore Creation

Completed:

- Added only synchronous `createLoreEntry` to the repository factory, not to the unit of work. Its private helper preserves exact scope precedence and normalization, consumes the injected ID before the clock, and transactionally inserts the parent entry followed by ordered scope associations.
- Preserved global scope, explicit plural `characterIds` precedence including an empty array, compatibility `characterId`, supplied scope ordering, rollback, dependency consumption and failures, duplicate/missing references, and closed-repository behavior.
- Kept the named async `createLoreEntry` compatibility wrapper on `getDb()` plus `systemRuntime`, with existing lore routes unchanged. Lore selection, prompt assembly, generation, and SSE remain with their existing owners.
- Added no schema, UI, navigation, campaign, or gameplay behavior; SQLite remains at schema v8 and the injectable RNG remains unused.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/repo.test.ts test/api-lore.test.ts test/api-session-context.test.ts test/lore.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: 95 focused repository, lore API, session-context, and lore-domain tests passed; server typechecking passed.

Full verification for Slices 16-18 completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 4 passed; server 274 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled.

Remaining M0 work:

- As the next safe slice, move only the harness update timestamp behind the repository factory clock. Preserve named compatibility wrappers and prompt-template callers; do not move default harness reads in the same slice.
- Alternatively, characterize usage/provider routes later, after their compatibility boundaries are explicit.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Do not add premature RPG UI; campaign and gameplay navigation still depend on later foundations.

### 2026-08-01: M0 Slice 17 - Deterministic Factory Manual Context Timestamp

Completed:

- Added only synchronous `updateSessionContextSource` to the repository factory. Its private helper obtains the injected clock value before the upsert and consumes no ID.
- Preserved manual-context upsert behavior and exact manual timestamps while retaining synthesized fields and synthesized timestamps. Preserved missing-session foreign-key behavior, closed-repository behavior, and clock/write failures.
- Kept the named async `updateSessionContextSource` compatibility wrapper on `systemRuntime`. Synthesized context updates, scene generation, context assembly, and routes are unchanged.
- Added no schema, UI, navigation, campaign, or gameplay behavior; SQLite remains at schema v8 and the injectable RNG remains unused.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/repo.test.ts test/api-session-context.test.ts test/api-session-lifecycle.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: 64 focused repository, session-context API, and session-lifecycle tests passed; server typechecking passed.

### 2026-08-01: M0 Slice 16 - Deterministic Factory Character Creation

Completed:

- Added only synchronous `createCharacter` to the repository factory, not to the unit of work. Its private helper consumes the injected ID, then the clock, then performs one insert using the exact input and `isRealPerson: false`.
- Preserved closed-repository behavior, ID/clock/insert failures, and duplicate-ID behavior without partially inserting a character. Factory and app runtimes remain separate.
- Kept the named async `createCharacter` compatibility wrapper on `getDb()` plus `systemRuntime` and left character routes unchanged. `buildApp` runtime continues to control request IDs only.
- Added no schema, UI, navigation, campaign, or gameplay behavior; SQLite remains at schema v8 and the injectable RNG remains unused.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/repo.test.ts test/api-characters.test.ts
npm --workspace velvet-mvp-server run test -- test/repo.test.ts test/api-characters.test.ts test/api.test.ts test/runtime.test.ts test/policy.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: 46 focused repository and character-API tests passed; 59 representative repository, character API, route-boundary, and runtime-separation tests passed; server typechecking passed.

### 2026-08-01: M0 Slice 15 - Session Lifecycle Route Extraction

Completed:

- Added `server/src/routes/roleplay/sessionLifecycle.ts` and moved only legacy `DELETE /api/sessions/:id` and `POST /api/sessions/:id/stop` into it under `/api`.
- At this historical Slice 15 checkpoint, the plugin received the existing synchronous generation-abort callback while generation maps still remained private to `app.ts`. Current process-local lock/abort ownership is `server/src/routes/roleplay/generationRegistry.ts`, shared by lifecycle and interaction routes. The checkpoint's lookup-before-abort-before-operation ordering, including no callback for a missing session and abort outside the atomic stop transaction, remains preserved.
- Preserved delete cascades, append-only usage retention and deleted-session labeling, and release of formerly referenced characters. Preserved stop's bare Session response, exact consent event, stable stop time and reason on repeated calls with an additional event, rejection of later writes, request IDs, and active regular SSE stop/delete abort behavior without a reply.
- Kept mutations other than delete/stop, context and sibling reads, branching, summaries, generation, and SSE orchestration unchanged. No UI, schema, RPG table, navigation, campaign, or gameplay changed; SQLite remains at schema v8.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-session-lifecycle.test.ts test/api-stream.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: the initial pre-extraction lifecycle gate passed 16 tests; the final lifecycle-plus-stream gate passed 18 tests; combined lifecycle coverage passed 74 tests; server typechecking passed.

Full verification for Slices 13-15 completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 4 passed; server 251 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled.

Remaining M0 work:

- As the next safe slice, narrowly adopt factory-owned clock/ID dependencies for character creation while preserving the named async compatibility wrapper on `systemRuntime`; `buildApp` runtime must continue to control request IDs only.
- Alternatively, characterize provider/usage routes later, after their compatibility boundary is explicit.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Do not add premature RPG UI; campaign and gameplay navigation still depend on later foundations.

### 2026-08-01: M0 Slice 14 - Branch Sibling Read Extraction

Completed:

- Moved only legacy `GET /api/sessions/:id/messages/:mid/siblings` into `server/src/routes/roleplay/sessions.ts` under the existing `/api` prefix.
- Preserved lookup precedence and cross-session isolation; the exact same-parent definition across message roles and statuses, including root messages; repository order; active-leaf fallback; sibling, descendant, divergent, and null IDs; stopped-session reads; and validated request IDs.
- Kept all mutations, activate/swipe/branch behavior, summaries, generation, and SSE unchanged. No UI, schema, RPG table, navigation, campaign, or gameplay changed; SQLite remains at schema v8.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-branch-reads.test.ts
```

Results: the initial pre-extraction and post-extraction focused gates each passed 6 tests; review added active-leaf fallback coverage for a final focused suite of 7 tests; final combined branch coverage passed 24 tests.

### 2026-08-01: M0 Slice 13 - Session Context Route Extraction

Completed:

- Moved exact legacy `GET /api/sessions/:id/context` and `PUT /api/sessions/:id/context` into the existing `server/src/routes/roleplay/sessions.ts` plugin under `/api`.
- Preserved missing-session precedence and exact empty/context wire shapes; active-branch recent events, threads, and lore; participant projection; approved active memories newest-first with at most three per participant and the existing final cap; lore scope, trigger, order, and budget behavior; and manual-over-synthesized precedence and timestamps.
- Preserved PUT trimming, clearing, the inclusive 8,000 UTF-16-code-unit boundary, closed-session access, and validated request IDs. The routes make no provider calls.
- Kept context, lore, and memory domain/repository logic, synthesis, generation, and SSE unchanged. No UI, schema, RPG table, navigation, campaign, or gameplay changed; SQLite remains at schema v8.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-session-context.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: the pre-extraction and post-extraction focused context suites each passed 18 tests; combined context coverage passed 60 tests; server typechecking passed.

### 2026-08-01: M0 Slice 12 - Session Creation Route Extraction

Completed:

- Extended `server/src/routes/roleplay/sessions.ts` with legacy `POST /api/sessions` and `POST /api/sessions/solo`, registered under the existing `/api` prefix.
- Preserved standard-session validation precedence; singular/plural participant-input precedence; first-occurrence deduplication; the 1-12 unique-participant cap; primary-character defaults and membership validation; first missing-character errors; and the bare `201` Session response with existing defaults and untrimmed optional values.
- Preserved the solo route's exact `200` envelope and input behavior, exact-solo participant matching, exclusion of group, other-participant, and closed sessions, newest eligible-session reuse with active messages, and the existing absence of an authentication claim.
- Kept session context, deletion, stop, message writes, lifecycle, branching, generation, and SSE untouched. No public behavior, UI, schema, RPG table, navigation, campaign, or gameplay changed; SQLite remains at schema v8.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-session-creation.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: the pre-extraction and post-extraction focused session-creation suites each passed 18 tests; combined session-creation coverage passed 79 tests; server typechecking passed.

Full verification for Slices 10-12 completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 4 passed; server 220 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled.

Remaining M0 work:

- Exactly characterize and extract session context GET/PUT as the next safe route slice while leaving context-domain assembly, lore and memory selection, synthesis, and generation unchanged.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Continue incremental characterized route extraction and narrowly scoped persistence dependency injection while preserving compatibility.
- Do not add premature RPG UI; campaign and gameplay navigation still depend on later foundations.

### 2026-08-01: M0 Slice 11 - Session Query Route Extraction

Completed:

- Added `server/src/routes/roleplay/sessions.ts` and moved only legacy `GET /api/sessions`, `GET /api/sessions/:id`, and `GET /api/sessions/:id/messages` into it under the existing `/api` prefix.
- Preserved exact prefix/static route matching, list ordering and filtering including secondary-participant, closed-session, and empty-query cases, complete session response shapes, and legacy misses.
- Preserved active-branch-only message responses, characterized through an actual swipe, plus validated request IDs and the existing versioned RPG boundary.
- Kept POST, context, lifecycle, branch, generation, and SSE handling untouched. No public behavior, UI, schema, RPG table, navigation, campaign, or gameplay changed; SQLite remains at schema v8.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-session-queries.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: the pre-extraction and post-extraction focused session-query suites each passed 5 tests; combined query coverage passed 74 tests; server typechecking passed.

### 2026-08-01: M0 Slice 10 - Harness Roleplay Route Extraction

Completed:

- Added exact compatibility characterization for legacy `GET /api/harness` and `PUT /api/harness`, then moved both handlers into `server/src/routes/roleplay/harness.ts`, registered under the existing `/api` prefix.
- Preserved the full settings/default/persistence response, selective text sanitization and caps, budget floors/clamps/noncoercion, temperature behavior, and validated request IDs.
- Preserved prompt-override replacement, filtering, caps, and bypass quirks. Existing compatibility defects remain exact: arrays and unknown-only writes are accepted no-ops, while non-string text fields and `promptOverrides: null` can yield `500`.
- Kept policy call sites, while the permissive policy stub continues to produce no denials. Prompt templates, provider behavior, generation, repository/schema behavior, and clients are unchanged.
- No public behavior, UI, schema, RPG table, navigation, campaign, or gameplay changed; SQLite remains at schema v8.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-harness.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: the pre-extraction and post-extraction focused harness suites each passed 27 tests; combined harness coverage passed 81 tests; server typechecking passed.

### 2026-08-01: M0 Slice 9 - Prompt-Template Roleplay Route Extraction

Completed:

- Added exact compatibility characterization for legacy `GET /api/prompt-templates` and `PUT /api/prompt-templates/:id`, then moved both handlers into `server/src/routes/roleplay/promptTemplates.ts`, registered under the existing `/api` prefix.
- Preserved the exact hard-coded order of all 20 templates and each entry's exact `id`, `label`, `description`, `defaultTemplate`, `placeholders`, effective `template`, and `overridden` shape. GET and successful PUT continue to return the complete `{ templates }` list.
- Preserved persistent per-template overrides and `template: null` reset to the default. Updating or resetting one template retains every other override and all unrelated harness fields.
- Preserved exact validation and lookup behavior: unknown IDs return `404 { error: "prompt template not found" }`; missing, null, or non-string/non-null templates return `400 { error: "template must be a string or null" }`; exactly 64,000 UTF-16 code units are accepted and 64,001 returns `400 { error: "template is too long" }`.
- Preserved placeholder parsing, including allowed whitespace around names and unknown-placeholder reporting in encounter order without deduplication, with the exact `{ error: "unknown prompt placeholders", unknownPlaceholders }` body.
- Preserved validated `X-Request-Id` response headers without adding request IDs to legacy JSON bodies.
- Kept prompt definitions, `resolvePromptTemplate`, harness repository persistence and `/api/harness` routes, provider and generation orchestration, and all clients unchanged. No public behavior, UI, schema, RPG table, navigation, campaign, or gameplay changed; SQLite remains at schema v8.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-prompt-templates.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: the pre-extraction and post-extraction focused prompt-template suites each passed 14 tests; combined prompt-template, management, prompt, and repository coverage passed 61 tests; server typechecking passed.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 4 passed; server 170 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled for this slice.

Remaining M0 work:

- Exactly characterize and extract the two legacy harness GET/PUT routes as the next smallest safe route slice; do not change prompt templates, provider behavior, generation, or repository semantics.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Continue incremental characterized route extraction and narrowly scoped persistence dependency injection while preserving compatibility.
- Do not add premature RPG UI; campaign and gameplay navigation still depend on later foundations.

### 2026-08-01: M0 Slice 8 - Memory Roleplay Route Extraction

Completed:

- Added exact compatibility characterization for the five legacy memory-management routes and moved `GET /api/characters/:id/memories`, `POST /api/characters/:id/memories`, `PATCH /api/memories/:id`, `POST /api/memories/:id/restore`, and `DELETE /api/memories/:id` into `server/src/routes/roleplay/memories.ts`, registered under the existing `/api` prefix.
- Preserved lookup precedence: list/create resolve the character first, including character-first create behavior before body validation; PATCH resolves the memory before patch validation; restore/delete retain their exact missing-memory responses. Listing returns active, pending, and forgotten rows together, newest first.
- Preserved create defaults and exact wire shape: `kind: "fact"`, `userApproved: true`, `sourceTurnId: "manual"`, active `forgottenAt: null`, and repository-generated identity/timestamp. Content still has injection markers rewritten and controls removed, is sliced to 160 UTF-16 code units, and is then trimmed and checked.
- Preserved soft delete with `{ ok: true, forgottenAt }`, repeated-delete `404`, idempotent POST restore, and idempotent PATCH restore through `{ forgottenAt: null }`. Forgotten rows remain listed and editable.
- Preserved PATCH field retention and immutable provenance: route input cannot change memory ID, owning character, source turn, or creation timestamp. Kind, approval, and content edits retain validation order, and unknown-only non-empty patches remain successful no-ops.
- Preserved characterized compatibility quirks exactly: duplicate active content for one character still returns an empty-body `201`; PATCH content that passes the initial nonblank check but sanitizes to nothing can persist an empty string; create returns a 160-code-unit slice ending in a lone surrogate directly, while PATCH rereads the SQLite value as the Unicode replacement character.
- Preserved validated `X-Request-Id` response headers on all five routes without adding request IDs to legacy JSON bodies.
- Kept memory extraction and summaries in `server/src/memory.ts`, approved-memory prompt/context use in the existing prompt/context owners, and generation and SSE orchestration in their existing owners. No public behavior, client UI, schema, RPG table, navigation, campaign, or gameplay changed; SQLite remains at schema v8.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-memories.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: the pre-extraction and post-extraction focused memory suites each passed 10 tests; combined memory API, management, domain, prompt/context, and repository coverage passed 79 tests; server typechecking passed.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 4 passed; server 170 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled for this slice.

Remaining M0 work:

- Exactly characterize and extract the legacy prompt-template GET/PUT routes without moving prompt definitions, resolution, harness persistence/routes, generation, or clients.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Continue incremental characterized route extraction and narrowly scoped persistence dependency injection while preserving compatibility.
- Preserve deterministic and opt-in live E2E as milestone regression gates; do not add premature RPG UI.

### 2026-08-01: M0 Slice 7 - Deterministic Legacy Repository Import Dependencies

Completed:

- Threaded the existing repository clock and ID ports through legacy `db.json` opening, normalization, and import. Missing legacy session IDs and `createdAt` timestamps, fallback harness/provider `updatedAt`, imported `legacyMigratedAt`, and corrupt-quarantine millisecond suffixes now come from the injected dependencies.
- Preserved supplied session IDs/timestamps and harness/provider `updatedAt` values exactly. A supplied value consumes no fallback ID or clock call for that field.
- Preserved malformed JSON as the only quarantine case. Dependency failures during normalization propagate without quarantine, and import failures propagate, roll back all SQLite import writes including `legacyMigratedAt`, do not create `db.json.migrated`, and leave the valid `db.json` retryable.
- Kept the named repository on `systemRuntime`. No gameplay RNG or ordinary persistence behavior changed, no public API or UI behavior changed, and SQLite remains at schema v8 with no RPG tables or gameplay.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/repo.test.ts test/migration-v5.test.ts test/branch.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: 35 focused repository, migration, and branch tests passed; server typechecking passed.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 4 passed; server 146 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled for this slice.

Remaining M0 work:

- Exactly characterize and extract the legacy memory CRUD routes as the next smallest safe roleplay route slice; leave memory extraction, summaries, prompts, generation, and SSE orchestration in their existing owners.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Continue incremental characterized route extraction and narrowly scoped persistence dependency injection while preserving compatibility.
- Preserve deterministic and opt-in live E2E as milestone regression gates.

### 2026-08-01: M0 Slice 6 - Lore Roleplay Route Extraction

Completed:

- Added exact compatibility characterization for the four legacy lore CRUD routes and moved `GET /api/lore`, `POST /api/lore`, `PATCH /api/lore/:id`, and `DELETE /api/lore/:id` into `server/src/routes/roleplay/lore.ts`, registered under the existing `/api` prefix.
- Preserved exact statuses and bodies: list returns `200 { lore }`; create returns `201` with the lore entry; patch returns `200` with the entry, including unchanged success for `{}`; delete returns `200 { ok: true }`; and missing or already-deleted patch/delete returns `404 { error: "lore entry not found" }`.
- Preserved global scope, singular `characterId`, and plural `characterIds`. An explicitly supplied `characterIds` field takes precedence over `characterId`, including an empty array selecting global scope; scope IDs use ordered first-occurrence deduplication, and `characterId` remains the first scoped ID or `null`.
- Preserved create defaults (`enabled: true`, `insertionOrder: 100`), patch retention of omitted fields and `createdAt`, all-entry listing, character-filtered listing that includes global plus matching scoped entries regardless of enabled state, and ordering by ascending `insertionOrder` then repository insertion sequence (`rowid`).
- Preserved `400` validation bodies with the exact errors `keys must be an array of strings`, `content is required`, `characterId must be a string or null` on create, `characterIds must be an array of strings` (including an invalid singular patch), `enabled must be a boolean`, `insertionOrder must be a finite number`, and `lore patch is required`. Missing referenced scope IDs remain `404 { error: "character not found: <id>" }`; existing policy failure remains `422 { error: "policy violation", violations }`.
- Preserved system-tag/control-character sanitization, key truncation to 60 characters before repository trimming/filtering, repository caps of eight non-empty keys and 1,200 content characters, and validated `X-Request-Id` response headers without adding request IDs to legacy JSON bodies.
- At this historical Slice 6 checkpoint, lore trigger selection stayed in `server/src/lore.ts`, prompt assembly stayed in existing prompt modules, and generation/SSE orchestration still lived in `server/src/app.ts`. Current ownership is `server/src/routes/roleplay/interactions.ts` plus `generationService.ts`; the historical no-behavior-change and schema-v8 facts for that checkpoint are unchanged.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-lore.test.ts
npm --workspace velvet-mvp-server run test -- test/api-lore.test.ts test/api-management.test.ts test/lore.test.ts test/repo.test.ts
npm --workspace velvet-mvp-server run typecheck
```

Results: the pre-extraction lore characterization passed 18 tests; the final exact lore suite passed 20 tests; combined lore, management, domain, and repository coverage passed 65 tests; server typechecking passed.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 4 passed; server 146 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled for this slice.

Remaining M0 work:

- Exactly characterize and extract the legacy memory CRUD routes as the next smallest safe roleplay route slice; leave memory extraction, summaries, prompts, generation, and SSE orchestration in their existing owners.
- Thread repository clock/ID dependencies through legacy opening and import without changing ordinary persistence or consuming gameplay RNG.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Preserve deterministic and opt-in live E2E as milestone regression gates.

### 2026-08-01: M0 Slice 5 - Pure Client Roleplay Navigation-State Extraction

Completed:

- Moved the existing `View` and `StoredNavigation` types, exact `velvet.navigation.v1` storage key, stored-value parser, and `localStorage` read/write helpers from `client/src/App.tsx` into the focused pure compatibility module `client/src/roleplay/navigation.ts`.
- Preserved all six existing views (`home`, `create`, `edit`, `memory`, `lore`, and `chat`) and the exact persisted field names and write serialization behavior. Writes still use `JSON.stringify` on the supplied object, preserving property order and retained values while omitting `undefined`, and storage or serialization failures remain non-blocking.
- Preserved parser behavior for legacy character/session/selection IDs: only object records are considered; unknown views fall back to `home`; non-empty legacy IDs are retained without trimming; invalid values and unknown fields are ignored; `selectedIds` defaults empty and deduplicates; `chat` requires `sessionId`; and `edit`/`memory` require `characterId`. Slice 79 separately requires persisted `campaignId` to satisfy the shared resource-ID contract.
- Preserved missing, malformed, and inaccessible storage fallbacks under the exact existing key. The pure parser still returns only `{ view: "home" }` for non-object inputs, while object-based and storage fallbacks retain the existing empty `selectedIds` behavior.
- Kept React navigation and selection state, restoration orchestration, server-backed stale-character/session ID reconciliation, transitions, rendering, API workflows, and chat orchestration in `App.tsx`.
- Made no visible UI, CSS, API, server, repository, schema, feature-flag, or public-contract changes. No RPG navigation, campaign flow, sheet, mechanics, combat, or other gameplay UI was added, and SQLite remains at schema v8.

Focused verification completed:

```bash
npm --workspace velvet-mvp-client run typecheck
npm --workspace velvet-mvp-client run test -- src/roleplay/navigation.test.ts src/App.test.tsx
```

Results: client typechecking passed; 30 focused navigation/App tests passed.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: root typechecking and production build passed; contracts 4 passed; server 121 passed and 1 skipped; client 41 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not enabled for this slice.

Remaining M0 work:

- Continue server roleplay route extraction only in small, characterized, non-provider-backed groups; leave provider-backed generation and SSE coordination until their shared service boundary is characterized.
- Adopt repository clock/ID dependencies in another persistence or legacy-import operation only during a narrow characterized refactor; keep gameplay RNG separate.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Preserve deterministic and opt-in live E2E as milestone regression gates.

### 2026-08-01: M0 Slice 4 - Client Character Library Page Extraction

Completed:

- Moved the existing character-library/home presentation from `client/src/App.tsx` into `client/src/roleplay/CharacterLibraryPage.tsx` as a focused roleplay page component.
- Kept character/session/provider loading, API mutations, confirmation dialogs, import JSON parsing, export download creation, navigation restoration/persistence, selection reconciliation, shared errors, and view orchestration in `App.tsx`.
- Preserved the exact library markup hierarchy, labels, copy, CSS classes, character and session actions, selection order, primary-speaker controls, session-title behavior, empty/error/provider states, import input reset, and callback payloads.
- Preserved the existing home screen and **New character** flow. Added an App-level regression proving **New character** clears a previously edited character and opens a blank creation form.
- Added focused page characterization for representative and empty states, callback wiring, import-file forwarding/reset, provider fallback, sessions, character actions, and untrimmed title forwarding to the existing App-owned session command.
- Made no CSS, API, server, repository, schema, persistence, feature-flag, or public-contract changes. No RPG navigation, principals, campaigns, roles, sheets, mechanics, combat, or other gameplay UI was added.

Focused verification completed:

```bash
npm --workspace velvet-mvp-client run typecheck
npm --workspace velvet-mvp-client run test -- src/roleplay/CharacterLibraryPage.test.tsx src/App.test.tsx
npm --workspace velvet-mvp-server run test -- test/api-characters.test.ts test/api.test.ts
```

Results: 16 focused client page/App tests passed; client typechecking passed; 19 representative character/server API tests passed. A review subagent found no implementation, behavior, markup, CSS, type, API, or scope regressions after the App-level **New character** coverage was added.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: contracts 4 passed; server 121 passed and 1 skipped; client 25 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not explicitly enabled for this slice.

Remaining M0 work:

- Extract the existing roleplay navigation-state boundary incrementally, starting with `View`, stored-navigation parsing, the `velvet.navigation.v1` key, and storage read/write helpers while preserving the exact format and stale-value fallbacks.
- Keep the App render switch, API loading, mutations, chat, page markup, and all RPG-facing navigation unchanged during that pure compatibility extraction.
- Continue server roleplay route extraction only in small characterized groups; leave provider-backed generation and SSE coordination until their service boundary is characterized.
- Adopt repository clock/ID dependencies in additional persistence and legacy-import operations only as each operation is refactored and characterized.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Preserve deterministic and opt-in live E2E as milestone regression gates.

### 2026-08-01: M0 Slice 3 - Character Roleplay Route Extraction

Completed:

- Added exact API characterization for all seven existing character endpoints: list, create, get, update, delete, export, and import.
- Moved those handlers and their character-only parsing/policy-candidate helpers from `server/src/app.ts` into the focused `server/src/routes/roleplay/characters.ts` Fastify plugin.
- Registered the plugin under the existing `/api` prefix. At this historical Slice 3 checkpoint, character memory routes still remained in `app.ts` because memory management was outside that extraction slice; they now live in `server/src/routes/roleplay/memories.ts`.
- Preserved every characterized status and JSON body, validation message, permissive `checkCharacter` call site, `isRealPerson: false`, repository-generated UUID/timestamp behavior, direct and wrapped import forms, `velvet-character@1` export shape, missing-character responses, and guarded deletion `409` text.
- Preserved validated `X-Request-Id` response headers without adding request IDs to legacy character JSON bodies.
- Kept all existing repository named exports and callers unchanged. Routes continue to use repository functions and receive no raw database handles.
- Kept SQLite schema version 8 and existing records authoritative. No migration, principal, campaign, role, RPG sheet, gameplay table, command bus, authorization boundary, frontend change, mechanics, or combat was added.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run test -- test/api-characters.test.ts
npm --workspace velvet-mvp-server run test -- test/api-characters.test.ts test/api.test.ts test/api-management.test.ts
npm --workspace velvet-mvp-server run typecheck
npm --workspace velvet-mvp-server run test -- test/api-characters.test.ts test/repo.test.ts test/api.test.ts test/api-management.test.ts test/api-stream.test.ts test/branch.test.ts test/api-branch.test.ts test/migration-v5.test.ts
```

Results: the pre-extraction character characterization passed 11 tests; post-extraction focused API coverage passed 29 tests; representative repository, session, streaming, branch, and migration coverage passed 77 tests; server source and test typechecking passed.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: contracts 4 passed; server 121 passed and 1 skipped; client 22 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not explicitly enabled for this slice.

Remaining M0 work:

- Extract the existing client character-library page without changing markup, home-screen behavior, or the **New character** flow, then extract the navigation shell incrementally.
- Continue roleplay route extraction in small characterized groups; leave provider-backed generation, streaming, room routing, scene synthesis, memories, lore, sessions, and branch orchestration unchanged until each boundary is explicitly selected.
- Adopt repository clock/ID dependencies in additional persistence and legacy-import operations only as each operation is refactored and characterized.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Add command envelope and receipt contracts with the first deterministic RPG command service, not as a speculative command bus.
- Expand runtime validation endpoint by endpoint and add generated OpenAPI/compatibility checks.
- Preserve deterministic and opt-in live E2E as milestone regression gates.

### 2026-08-01: M0 Slice 2 - Repository Transaction And Dependency-Injection Foundation

Completed:

- Added `createRepository()` as the factory-owned SQLite connection boundary while preserving the existing named async repository exports and their current callers.
- Added a synchronous transaction/unit-of-work API for the session operations touched by this slice. Its TypeScript callback contract excludes Promise results, runtime validation rejects thenables and rolls back, and the scoped unit of work is invalid after callback return.
- Injected clock and ID dependencies into consent-event insertion and session transition only. Gameplay RNG remains separate and is not consumed by persistence.
- Converted explicit `POST /api/sessions/:id/stop` consent insertion plus session closure into one short atomic repository command. Generation abort remains outside the transaction, and no provider, streaming, routing, or synthesis work occurs inside it.
- Preserved the first stopped timestamp and reason on repeated stops, the existing stop response body and status, consent-event content and ordering, and default system clock/UUID behavior.
- Kept SQLite schema version 8. Opening a representative v8 repository does not rewrite its roleplay records, and no principals, campaigns, roles, RPG sheets, gameplay tables, or migrations were added.

Focused verification completed:

```bash
npm --workspace velvet-mvp-server run typecheck
npm --workspace velvet-mvp-server run test -- test/repo.test.ts test/api.test.ts test/api-stream.test.ts test/branch.test.ts test/api-branch.test.ts test/migration-v5.test.ts
```

Results: 56 focused server tests passed.

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: contracts 4 passed; server 110 passed and 1 skipped; client 22 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not explicitly enabled for this slice.

Remaining M0 work:

- Adopt repository clock/ID dependencies in additional persistence and legacy-import operations only as each operation is refactored and characterized.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Extract roleplay route groups incrementally, starting with character routes and exact response characterization; leave generation/SSE coordination until its shared service boundary is characterized.
- Extract the client library page and then navigation shell without changing current UI behavior.
- Add command envelope and receipt contracts when their first deterministic RPG command service is implemented.
- Expand runtime validation endpoint by endpoint and add generated OpenAPI/compatibility checks.
- Preserve deterministic and opt-in live E2E as milestone regression gates.

### 2026-08-01: M0 Slice 1 - HTTP And Runtime Foundation

Completed:

- Added the compiled `@velvet/contracts` npm workspace with Zod runtime schemas for legacy roleplay feature flags, RPG feature flags, request IDs, and structured API problems.
- Preserved `GET /api/health` and `GET /api/features` response bodies while moving them into the first roleplay Fastify route plugin.
- Added validated `X-Request-Id` propagation without adding fields to existing roleplay response bodies.
- Added structured `application/problem+json` responses only for unknown routes under the new `/api/rpg/v1` boundary. Existing roleplay errors remain compatible.
- Added `GET /api/rpg/v1/features`; campaign, mechanics, combat, studio, and remote-authentication capabilities are opt-in and default off.
- Added injectable clock, ID-generator, and random-number interfaces. Request ID generation is the first injected consumer; repository clock/ID adoption is deferred.
- Updated the client feature response boundary to perform runtime validation and taught `ApiError` to decode both structured RPG problems and existing legacy errors.
- Kept SQLite schema version 8. No principals, campaigns, RPG sheets, gameplay tables, or implicit RPG records were added.

Focused verification completed:

```bash
npm run build --workspace @velvet/contracts
npm run test --workspace @velvet/contracts
npm --workspace velvet-mvp-server run test -- test/api.test.ts test/runtime.test.ts
npm --workspace velvet-mvp-client run test -- src/api.test.ts
```

Full verification completed:

```bash
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Results: contracts 4 passed; server 105 passed and 1 skipped; client 22 passed; deterministic Playwright 1 passed. Live E2E was not run because `VELVET_E2E_LIVE=1` was not explicitly enabled for this slice.

Remaining M0 work:

- Add a repository factory and synchronous transaction/unit-of-work boundary, then prove it with one short atomic command. Do not hold transactions across provider calls.
- Inject clock and ID dependencies into repository persistence and legacy import paths.
- Add the local owner principal and campaign-role foundation in an atomic v9 migration with representative v8 preservation and rollback tests.
- Extract roleplay route groups incrementally, leaving generation/SSE coordination until its shared service boundary is characterized.
- Extract the client library page and then navigation shell without changing current UI behavior.
- Add command envelope and receipt contracts when their first deterministic command service is implemented.
- Expand runtime validation endpoint by endpoint and add generated OpenAPI/compatibility checks.
- Preserve deterministic and opt-in live E2E as milestone regression gates.

## Original Delivery Phases M0-M9 (Superseded)

These phase names and deliverables preserve the original plan and are superseded by the normative milestone structure in [ROADMAP.md](ROADMAP.md). They are not current status labels, literal component commitments, or evidence that similarly numbered current milestones are incomplete.

### Original Phase M0: Architecture Foundation (Superseded)

Deliver:

- Shared contracts package.
- Route and React-shell decomposition without behavior changes.
- Local principal, campaign roles, command envelope, transaction boundary, RNG, clock, request IDs, and API problems.
- Feature flags for campaign, mechanics, combat, studio, and remote authentication.

Acceptance:

- All current typechecks, tests, builds, deterministic E2E, and live E2E remain green.
- Existing API responses and roleplay workflows remain compatible.
- No new RPG feature is required to use existing Velvet.

### Original Phase M1: Campaigns And Content (Superseded)

Deliver:

- Campaign library, draft/publish flow, timelines, membership, and session attachment.
- Versioned content pack loader and validator.
- Original `fantasy_core@1` Velvet starter pack with classes, races, backgrounds, basic items, spells, abilities, and enemies.
- Campaign-aware context shell.

Acceptance:

- One campaign contains multiple existing sessions.
- One persona can join multiple campaigns.
- Campaigns pin immutable content versions.
- Invalid pack references block publication.
- Existing standalone roleplay remains unchanged.

### Original Phase M2: Character Builder And Sheets (Superseded)

Deliver:

- RPG sheet drafts and finalization.
- Attribute methods, race, class, background, proficiencies, skills, starting loadout, and derived stats.
- Character sheet UI and player/GM projections.

Acceptance:

- A complete level-one character can be built without manual database edits.
- All requirements and grants validate and apply exactly once.
- Reloading reproduces identical derived values.
- Character creation is one atomic finalization.

### Original Phase M3: Event Core, Inventory, Economy, And Resources (Superseded)

Deliver:

- Campaign revisions, idempotent commands, receipts, events, and audit.
- HP/resources, inventory, equipment, item use, wallets, shops, purchases, sales, transfers, trades, and rest.
- Party resource and inventory UI.

Acceptance:

- All mutations return structured receipts.
- Purchases, trades, item use, and rests are atomic.
- Retry and reconnect never duplicate state.
- Server and UI display the same authoritative resources.

### Original Phase M4: Dice, Progression, Powers, And Effects (Superseded)

Deliver:

- Canonical bounded dice engine.
- Checks, saves, opposed checks, and structured results.
- XP ledger, milestone mode, multi-level advancement, and level-up choices.
- Spells, ability uses, effects, duration, stacking, concentration, and recharge.

Acceptance:

- Seeded tests reproduce every roll.
- One XP grant can correctly cross multiple levels.
- Level-up cannot partially commit.
- A failed power consumes no resource.
- Effect clocks and concentration follow the selected rules profile.

### Original Phase M5: World, NPCs, Factions, Quests, And Story (Superseded)

Deliver:

- Location hierarchy, connections, travel, and discovery.
- Campaign-managed NPC identity metadata, private state, relationships, companions, factions, and reputation.
- Quests, objectives, rewards, story graphs, plot points, and clues.
- Player journal and GM world/story studio.

Acceptance:

- Hidden GM data does not appear in player APIs or prompts.
- Travel cannot bypass connection rules.
- Campaign NPC identity metadata does not establish Velvet speech, memory, room participation, or presence; no campaign-NPC speech/session bridge is part of this target.
- Quest and reveal progression is deterministic and idempotent.
- Current world state appears in bounded prompt context.

### Original Phase M6: Combat And Enemy AI (Superseded)

Deliver:

- Encounter preparation and runtime.
- Enemy instances, initiative, action economy, attacks, damage, conditions, spells, items, flee, defeat, and rewards.
- Combat tracker and legal action tray.
- Deterministic fallback enemy tactics.

Acceptance:

- Multi-round combat works without AI narration.
- Turn order and action legality are enforced.
- Duplicate requests cannot apply damage twice.
- Combat and sheet share one HP source.
- Enemy provider failure cannot stall the encounter.
- Rewards apply exactly once.

### Original Phase M7: AI DM And Agent Tools (Superseded)

Deliver:

- DM narrator mode and new prompt layers.
- Contextual typed tool registry.
- Bounded decision loop, authorization, confirmation suspension, deterministic execution, final narration, SSE events, and receipt fallback.
- NPC and companion agents.
- Enemy tactic selection using legal action IDs.
- Turn-level usage and audit UI.

Acceptance:

- AI cannot bypass actor control or deterministic rules.
- Mechanics commit before narration.
- Swipes reuse receipts and do not reroll or duplicate effects.
- Confirmation resumes stored normalized arguments only when revision is current.
- Provider failure after commit returns factual fallback narration.
- Prompt-injected lore cannot grant items, gold, XP, or permissions.

### Original Phase M8: Campaign Generation, Recaps, Checkpoints, And Transfer (Superseded)

Deliver:

- Staged world, location, NPC, faction, quest, and opening generation.
- Durable generation drafts with validation, editing, selective apply, and atomic finalization.
- Campaign recaps and event log.
- Checkpoints and timeline forks.
- `velvet-campaign@1` import/export.
- Optional reviewed importer for remote RPG bot data.

Acceptance:

- Generation never mutates a campaign before approval.
- Invalid references block finalization.
- Import/export round-trips preserve graph integrity.
- Restore creates a child timeline and preserves original history.
- Generated campaigns open in a playable starting location.

### Original Phase M9: Hardening And Multiplayer Readiness (Superseded)

Deliver:

- Real authentication when deployment beyond loopback is desired.
- Campaign authorization, secure sessions, CSRF, same-origin CORS, rate limiting, and invite tokens.
- Durable generation leases/restart recovery.
- Accessibility, mobile, load, race, backup, security, and adversarial prompt-injection hardening.
- Optional opt-in proactive DM nudges with quiet hours and caps.

Acceptance:

- Role matrix and IDOR tests pass.
- GM secrets are absent from player payloads and logs.
- Pending/committed turns recover safely after restart.
- Performance gates pass for large campaigns.
- WCAG 2.2 AA automated and keyboard workflows pass.

## Original Test Strategy (Historical Target)

This section and the acceptance, operations, observability, decision, deferred-scope, and completion sections that follow preserve original target criteria rather than current implementation status.

### Required Harnesses

- Temporary SQLite databases.
- Injectable seeded RNG and clock.
- Fixed validated content packs.
- Fake provider supporting valid, malformed, unauthorized, repeated, timeout, and partial-stream behavior.
- Existing fake-provider deterministic E2E.
- Existing opt-in live provider tests with capped calls and cloned data.

### Unit And Domain Tests

- Content reference and pack validation.
- Character choices and derived stats.
- Dice grammar, bounds, advantage, critical rules, and seeded output.
- XP threshold crossing and level choices.
- Equipment conflicts, stack rules, effects, concentration, and rest.
- Wallet, stock, purchase, transfer, trade, and reward invariants.
- Travel adjacency and hidden-state filtering.
- Quest dependencies, story transitions, clue thresholds, and reputation.
- Combat legality, target validation, damage, conditions, victory, and fallback tactics.
- Agent tool selection, authorization, confirmation, idempotency, and loop bounds.

### Migration And Repository Tests

- Fresh latest schema.
- Sequential migration from representative v8 data.
- Rollback on every staged migration failure.
- Foreign-key and unique-index enforcement.
- Existing roleplay records unchanged.
- Pack seed idempotency and hash stability.
- Session/campaign/character archival and deletion behavior.

### API And Security Tests

- Runtime contract validation and status codes.
- Cross-campaign and cross-principal ID rejection.
- Player, GM, observer, and system authorization matrix.
- Stale revision and duplicate idempotency handling.
- GM-secret response filtering.
- Import limits and path/reference validation.
- Prompt injection and unauthorized tool calls.
- SSE event ordering, cancellation before commit, and interruption after commit.

### React Tests

- Campaign setup and draft recovery.
- Character-builder choice validation.
- Sheet, inventory, shop, level-up, quest, world, and combat state refresh.
- Confirmation, stale state, retry, and receipt rendering.
- Player versus GM visibility.
- Mobile layout, keyboard operation, focus management, reduced motion, and axe checks.

### Original End-To-End Acceptance Scenario (Historical Target Criteria)

1. Create and publish a campaign with a pinned starter pack.
2. Create a persona and complete an RPG sheet.
3. Attach a multi-character Velvet session.
4. Meet a persistent AI NPC through campaign gameplay without treating its persona metadata as a Velvet room participant.
5. Travel through a valid route and reject an invalid route.
6. Accept a quest and discover a clue.
7. Buy, equip, transfer, and consume items.
8. Resolve deterministic checks through the AI DM.
9. Start combat, roll initiative, attack, cast, apply and expire an effect, run enemy turns, and grant rewards.
10. Rest and complete an atomic level-up.
11. Swipe DM narration and verify mechanics do not change.
12. Retry a committed request and verify no duplicate damage or reward.
13. Reload client and server and verify all state.
14. Generate a campaign draft, edit it, validate it, and apply it.
15. Create a checkpoint, fork the timeline, and verify both histories remain intact.
16. Export and import the campaign into a clean database.

## Original Security And Operations (Historical Target Criteria)

For local-only use, one backfilled local owner principal is sufficient initially. Before network or multi-user exposure, require:

- Secure authentication and session cookies.
- CSRF protection.
- Owner, GM, player, and observer authorization on every entity lookup and mutation.
- Same-origin CORS.
- Rate limits for chat, tools, dice, generation, imports, and invitations.
- Provider URL SSRF and credential-host protections at least as strict as current Velvet.
- Upload, decompression, nesting, and resource-count limits.
- Secret-aware response projections and log redaction.
- Structured audit for role, content, XP, currency, inventory, quest, combat, and GM override changes.
- Database backup and recovery procedures.

The current permissive `server/src/policy.ts` is not an authorization or tool-safety boundary.

## Original Performance And Observability (Historical Target Criteria)

- Propagate request, turn, command, and provider-call IDs.
- Track command duration, conflicts, retries, provider latency, token usage, cost, and tool rejection.
- Use one campaign event stream instead of polling every panel.
- Paginate and search inventory, NPCs, quests, logs, and content.
- Cache immutable content packs by ID and version.
- Keep prompts role-filtered and budgeted.
- Add indexes around campaign ownership, membership, event sequence, location, quest status, inventory ownership, and combat turn state.
- Establish fixture budgets for 100 NPCs, 500 items, 30 combatants, and long conversation histories.
- Document SQLite's supported local/small-group concurrency envelope before hosted multiplayer work.

## Original Decisions To Confirm Before M1 (Historical Target Criteria)

Recommended defaults are shown here so work can start without blocking:

| Decision | Recommended default |
|---|---|
| Deployment target | Local-first single owner; design roles now, hosted auth later |
| Rules engine | Original simplified d20 fantasy profile, not branded D&D compatibility |
| RPG mode | Opt-in per campaign/session |
| Character persistence | Persona global; mechanics and progression campaign-specific |
| Advancement | XP or milestone profile; level-up requires review of choices |
| AI authority | Deterministic ordinary actions allowed from explicit intent; consequential ambiguity requires confirmation |
| PC control | AI never speaks or chooses for manual PCs; optional shared companion control |
| Combat | Deterministic server rules with optional AI tactics and narration |
| Maps | Location tree/list and graph first; tactical grid maps deferred |
| Content | One original fantasy starter pack first; pack architecture supports more genres |
| Branches | Narration swipes reuse receipts; mechanical changes use explicit reroll/override/timeline fork |
| Campaign generation | Reviewable draft, never immediate activation |
| Discord | Not part of the initial port; web gameplay is authoritative |
| Proactive nudges | Deferred, opt-in, non-mutating, durable schedule |

## Originally Deferred Until Core Completion (Historical Target Criteria)

- Tactical grid maps and line-of-sight simulation.
- Unbounded autonomous AI parties or director loops.
- Native Discord transport.
- Third-party VTT and character-builder imports.
- User-authored executable rules code.
- Mid-campaign mutation of published content packs.
- Multiple simultaneous encounters in one scene.
- Cryptographically verifiable dice.
- Fully system-neutral effect expression language before the first rules profile works end to end.

## Original Definition Of Complete (Historical Target Criteria)

The integration is complete when a user can:

1. Create or generate a campaign and review its world.
2. Build a mechanically valid player character linked to a Velvet persona.
3. Roleplay through Velvet chat with an AI DM and persistent AI NPCs.
4. Travel, discover, accept quests, investigate clues, buy and use items, cast powers, fight enemies, gain rewards, rest, and level up.
5. See deterministic mechanic receipts independently of narration.
6. Override or confirm consequential AI proposals without losing auditability.
7. Resume after client/server restart without duplicated or contradictory state.
8. Regenerate narration without silently changing committed mechanics.
9. Save, fork, export, and import a campaign without destroying prior history.
10. Continue using all existing standalone Velvet roleplay features unchanged.
