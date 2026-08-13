# Repository architecture

This is the normative persistence guide for schema v47 revision 1 (`v47r1`). It describes `server/src/repo/`; HTTP behavior belongs in [the API reference](api.md), and shared runtime schemas belong in `packages/contracts`.

## Public boundary and composition

Application code imports repository behavior from `server/src/repo/index.ts`. The public barrel exports `closeRepo`, named legacy roleplay functions, `createRepository()`, repository-owned errors/types, the supported catalog validation/digest/canonicalization helpers, character derived-stat/progression calculators, and mechanics-starter catalog constants. It does not export database handles, row types, `repoContext.ts`, or internal composition helpers.

```text
legacy named call -> repo/index.ts -> domain wrapper -> repoContext.ts -> db.ts singleton
RPG call          -> repo/index.ts -> createRepository() -> factory-owned SQLite connection
                                                   -> campaignRepositoryOrchestration.ts
                                                   -> focused connection-scoped repositories
```

- Named asynchronous functions retain the original roleplay call shapes and use the configured singleton.
- `createRepository()` returns a synchronous, closeable repository with injectable clock, ID, and RNG ports. It is the composition root for campaign and M1.1-M1.10 behavior.
- `Repository.transaction()` supplies a synchronous `RepositoryUnitOfWork`, rejects promise-returning callbacks, and invalidates the unit after completion. Operations with their own immediate transaction are factory-only and reject nesting.
- Routes, services, and generation code must not receive `better-sqlite3` handles or import private repository modules to bypass the facade.

## Database facade and modules

`server/src/repo/db.ts` remains the compatibility facade and wiring root, not the sole implementation file. It imports every migration dependency, configures schema and connection modules, configures the legacy singleton provider, retains historical v2-v14 migration implementation, and re-exports connection lifecycle functions.

| Owner | Responsibility |
| --- | --- |
| `db.ts` | Stable facade, dependency wiring, historical v2-v14 migration code, and public connection lifecycle re-exports. No domain query or command SQL belongs here. |
| `db/connection.ts` | Data-directory resolution, connection ownership, `velvet.sqlite`, directory permissions, WAL, foreign keys, busy timeout, schema startup, legacy import invocation, singleton lifecycle, and factory connection opening. |
| `db/schema.ts` | `SCHEMA_VERSION = 47`, `SCHEMA_REVISION = 1`, fresh-schema construction, sequential migration order, revision repair, future-artifact classification, startup assertions, and migration rollback boundaries. |
| `db/migrations/*.ts` | Version-owned DDL, canonical object inventories/digests, data validation, backfill, and one-step migration functions. New schema behavior goes in the migration that introduces it. |
| `db/legacyImport.ts` | One-way import of an otherwise-empty legacy `db.json` store into SQLite. It does not merge stores. |
| `repoContext.ts` | Private provider bridge for legacy named wrappers. Only database setup configures it. |

Fresh creation and canonical populated v45-to-v47 and v46-to-v47 upgrades in the tested support window converge on equivalent v47r1 DDL and validated preexisting data. v45 preserves durable-principal companion history; v46 adds exact-candidate issuance and lifecycle history; v47 adds empty-backfill immutable execution links. v44 and earlier marker paths are unsupported. Automatic downgrade is unsupported. Recreate older development databases or restore them from backups made by compatible builds. Before marker or artifact mutation, startup preflight rejects database-wide persisted foreign-key corruption, unexpected current/future named artifacts, and cross-campaign generation-draft ancestry. Schema markers are not permission to accept partial, extra, modified, or populated future artifacts. Migrations run transactionally, preserve prior immutable history, and fail without advancing the marker when ancestry or provenance cannot be proved.

## Migrations v26-v47

| Version | Additive responsibility |
| --- | --- |
| v26 | M1.6 actor mutation revisions; immutable check, power, and effect commands/events/receipts; normalized check results, power costs, active effects, modifiers, and lifecycle. |
| v27 | M1.7 combat foundation: encounters, combatants, initiative/turn state, combat audit, logs, reward bundles, and recorded claims. |
| v28 | M1.8 location graph, discoveries, travel state/audit, actor locations, NPC/faction ancestry, relationships, and reputation ledger. |
| v29r1/r2 | V29r1 character-layout attestation, then v29r2 retained storyline/quest/clue/reward/objective-completion compatibility tables only. Authoritative quest and story persistence arrives in v33 and v34. |
| v30 | Immutable campaign-import dry-run staging used to bind later apply to an exact validated package. |
| v31 | Encounter lifecycle and enemy-template provenance sidecars over the v27 combat foundation. |
| v32 | Revisioned world-narrative command/event/receipt history plus role-sensitive NPC/faction metadata, relationships, and reputation state. |
| v33 | Authoritative quest definitions, dependency-ordered objectives, progress, reward claims, journal projections, and quest audit. |
| v34 | Authoritative story graph, node state, edges, plot points/answers, clues/sources/discoveries, and story audit. |
| v35 | M1.10 durable adventure turns, tool proposals, confirmations, provider-call metadata, generation drafts, reviews, and final receipt links. |
| v36 | Adventure coordination command/event/receipt ledgers, exact turn-mechanics links, generation-draft apply receipts, and hardened v35 layout/data validation. |
| v37 | Exact server-owned proposal execution bindings tying each proposal to its idempotency key, command type, source turn, timeline, and actor; ambiguous historical receipts reject migration. |
| v38 | Durable bounded agent execution, decision rounds, tool calls, provider starts, and recovery state. |
| v39 | Agent provider-response provenance, dispatch claims, combat proposal bindings, and generalized receipts. |
| v40 | Confirmation policy, authority evidence, expiry operations, mutation accounting, and replan requirements. |
| v41 | Reviewed campaign-content generation drafts and projections. |
| v42 | Additive immutable campaign-content commands, receipts, revisions, and layout attestation sealing reviewed atomic application. |
| v43 | M5.1 room-scoped NPC-presence revisions, materialized current state, immutable commands/events/receipts, exact graph triggers, and canonical layout attestation. Migration owns no inferred presence and creates no backfill rows. |
| v44 | M5.2 additive empty companion foundation: immutable revisioned commands/receipts and companion, presence-link, proposal, decision, grant, revocation, audit, and canonical layout-attestation sidecars. No repository commands, routes, UI, grant exercise, or inferred rows are delivered. |
| v45 | Replaces the v44 companion sidecars while preserving all rows; historical command, proposal, decision, grant, and revocation principals reference durable principals so membership removal neither invalidates nor pins history. |
| v46 | Adds immutable exact-candidate batches, candidates, explicit supersessions, expiration observations, and canonical layout attestation with static DDL, a reviewed digest, and empty backfill. |
| v47 | Adds one immutable attested exact-candidate execution-link table with empty backfill. It binds canonical selection/result evidence to the original v46 candidate and exact world command, receipt, event, destination, and party sidecars. Repository reconstruction remains the cryptographic authority. |

## Repository ownership

`campaignRepositoryOrchestration.ts` opens the factory connection, installs runtime ports and nested-transaction guards, composes the public `Repository`, and delegates invariants to focused owners. Its `campaign/` adapters own authorization-rooted campaign reads/writes, actors, content selection, rooms, timelines, command/event projections, play bootstrap, role-sensitive agent context, and legacy compatibility seams. Avoid duplicate SQL in the orchestration facade.

| Milestone | Persistence owner |
| --- | --- |
| M1.1 | `campaignAdministrationRepo.ts`, `campaignAdmin/`, and focused `campaign/` modules own lifecycle/settings, sole-owner membership, timelines/checkpoints/forks, recaps, administration audit, and import/export. Core gameplay command/event/receipt reconstruction remains in the campaign composition boundary. |
| M1.2 | `contentCatalogRepo.ts` and `contentCatalog/` own deterministic validation, immutable publication, visibility/reachability, exact campaign pins, catalog audit, and role-filtered definition projections. |
| M1.3 | `characterBuilderRepo.ts` and `characterBuilder/` own revisioned drafts, server rolls, choices, pin snapshots, finalization, provenance, and receipts. `characterBuilderCalculator.ts` is the sole pure derived-stat calculator. |
| M1.4 | `characterProgressionRepo.ts`, `characterProgression/`, and `characterProgressionPersistence.ts` own progression reads/commands, XP and compensating ledgers, previews/tokens, level application, known powers, snapshots, and complete provenance validation. |
| M1.5 | `actorResourceRepo.ts` plus `actorResource/`, `inventoryRepo.ts`, `economyRepo.ts` plus `economy/`, and `restRepo.ts` own resource, inventory/equipment, wallet/shop/trade, and recovery state and receipts. The separate `campaign/campaignActorResourceRepo.ts` is only the role-safe campaign read adapter. |
| M1.6 | `checkRepo.ts`, `powerRepo.ts`, and `effectRepo.ts` own server-derived checks, power availability/costs, deterministic effects, and the shared v26 revision/idempotency protocol. `actorPowerCommandPlanner.ts` and `actorPowerUseRepo.ts` own actor-scoped legal command planning and atomic execution. |
| M1.7 | `encounterRepo.ts` and `encounter/` own encounter lifecycle, legal-action planning, combat mutations/logs, enemy provenance, turn advancement, and recorded reward claims. |
| M1.8 | `worldRepo.ts` and `world/` own locations, discovery/travel, actor placement, NPC/faction metadata and relationships, reputation, commands, and GM/player projections. |
| M1.9 | `questRepo.ts` plus `quest/` own quest definitions, objectives, progress, rewards, journal reads, and retained v29 compatibility reads. `storyRepo.ts` owns story graphs, plot questions, clues/discovery, state transitions, and audience-specific story projections. |
| M1.10 | `adventureTurnRepo.ts` and `adventureTurn/` own turns, proposals, confirmations, provider-call metadata, receipt linking/reconciliation, narration state, generation drafts, review, and apply receipts. Generation/provider execution remains outside the repository; only durable coordination metadata and reviewed staged content are persisted here. |
| M4.1 | `campaign/campaignAgentContextReadRepo.ts` owns focused campaign/session/audience snapshots for server orchestrators. The factory facade wraps each read in one deferred SQLite transaction so membership, role/control, target ancestry, visible state, current combat, legal actions, and authorized target-private facts share one snapshot. `server/src/context.ts` owns the independent whole-line UTF-16 budgets and precedence assembly outside persistence. |
| M4.2-M4.4 | `agent/adventureOrchestrator.ts`, `agent/toolRegistry.ts`, and `agent/confirmationPolicy.ts` own bounded provider orchestration, role-selected tools, deterministic command bridging, durable confirmation/resume, and receipt-aware narration. Durable execution and response provenance are persisted through the v38-v40 repository boundary. |
| M4.5 | `generationDrafts.ts` and the encounter repository own typed encounter draft validation, reviewed authoritative encounter application, and role-safe projections. |
| M4.6 | `campaignContentGeneration.ts`, `campaign/campaignContentWriteRepo.ts`, and the v41-v42 migrations own typed campaign-content drafts, conservative NPC baselines, and atomic reviewed campaign-content application with immutable receipts. |
| M5.1 | `world/npcPresenceRepo.ts`, `world/npcPresenceReadRepo.ts`, `world/npcPresenceWriteRepo.ts`, and `db/migrations/v43_npc_presence.ts` own room-scoped NPC presence, role/lifecycle projections, command idempotency, graph integrity, detachment protection, and canonical v43 layout. |
| M5.2 companion administration | `db/migrations/v45_companion_principals.ts` owns the durable-principal companion layout and v44 row-preserving migration. `companionRepo.ts` owns owner/GM creation from a persisted present NPC in an attached running session, bounded grant creation/revocation, management/public projections, revision/idempotency/receipt/audit, and replay after demotion or membership removal. The fixed-local-owner HTTP lane exposes an authoritative management GET and closed receipt-only command POST; the client has transport only. UI, dismissal, proposal/decision administration, public member HTTP, and grant exercise remain undelivered. |
| M5.3 Slice 0 | `encounter/combatCompositionPlan.ts`, `encounter/combatCompositionExecutor.ts`, and encounter write composition own active-encounter HP authority, atomic actor-health mirroring through M15, round-wrap effect advancement, and concentration retention until replacement/removal. |
| M5.3 consumables | Shared encounter contracts freeze the exact item, inventory entry, target, effect plan, canonical request digest, expected M15 revisions, and result evidence. `encounter/useConsumableRuntime.ts` owns server-derived legal actions and one immediate-transaction execution for exact pinned category-`consumable` quantity one. The runtime applies effects in catalog order for damage, healing, and health/guard/focus resources. Every modifier duration is ineligible at the consumable contract boundary: instant modifiers report unavailable semantics and noninstant modifiers report unsupported duration; no modifier descriptor, settlement, legal action, or runtime path exists. No successful historical consumable modifier result exists. Shared catalog and power modifier contracts are unchanged, and powers retain receipt-only instant-modifier outcomes. `combatConsumables.ts` exposes separate legal-action, command, and exact-result routes without widening the legacy combat union; the client renders exact server target, quantity, and action cost and uses durable no-retry reconciliation. |
| M5.4 exact candidates | `candidateRepo/`, `v46_exact_candidates.ts`, and `v47_exact_candidate_executions.ts` own issuance, lifecycle, immutable attested execution links, and atomic exact actor travel. Repository replay reconstructs the complete original batch and cryptographically verifies candidate, selection, linked envelope, result, world command, receipt, and scoped travel evidence. Provider/tool advertising, candidate routes/client, and candidate E2E remain absent. Existing manual travel remains public and is not candidate-backed. |

Legacy persona, settings, session, message, memory, lore, and summary aggregates remain owned by their corresponding `*Repo.ts` files. Services own prompt construction, provider calls, summary generation, and memory extraction; repositories persist already-decided state.

## Transactions, audit, and retries

- Keep every multi-row invariant in one synchronous SQLite transaction. Use an immediate transaction when authorization, revision classification, idempotency lookup, dependency use, and writes must share one write lock.
- Never await provider, network, or filesystem work in a database transaction. Adventure confirmation waits and provider calls are explicitly split from their short persistence transactions.
- Validate current principal authority, campaign/actor ancestry, active timeline or session, and expected revision inside the write transaction, not only in a route preflight.
- A successful mutation advances its owning revision exactly once and atomically writes domain state plus its immutable command, event, receipt, normalized sidecars, and audit links. Do not append audit as best effort.
- Resolve an exact idempotent retry from the persisted receipt before stale-revision classification and without consuming clock, ID, or RNG. Reuse with changed canonical input is a conflict; never silently reinterpret a key.
- Preserve append-only history. Corrections use compensating records; lifecycle removal is archive/status state where the domain requires retained provenance. Do not use `INSERT OR REPLACE` on sealed or audited aggregates.
- Unknown delivery is not permission to replay. Callers reconcile through authoritative reads and command/receipt locators. For adventure turns, recover exact committed source-turn commands through v37 proposal execution bindings, persist missing links, and reuse mechanics receipts for swipes, retries, fallback narration, and post-commit cancellation.
- Preserve observable clock, ID, and RNG consumption order. Failed validation and exact retries must not reroll, spend resources again, duplicate rewards, or fabricate identifiers.

M5.1 presence reads execute in one deferred transaction: membership, scoped graph verification, room lifecycle, session revision, event reconstruction, NPC metadata, and role-visible locations share one snapshot without taking the write lock early. Presence writes execute in one immediate transaction. They derive owner/GM authority, verify the complete scoped graph, resolve an exact idempotent replay before attachment/lifecycle/staleness checks, then validate an attached running room, the session revision, campaign NPC/location ancestry, and the transition before consuming clock or IDs. A fresh commit advances the session root exactly once and atomically writes one command, event, receipt, and matching materialized state.

The v43 integrity boundary requires contiguous revisions from zero; one exact event and receipt per command; exact command/event/receipt NPC, state, location, revision, and timestamp bindings; valid principal/NPC/location ancestry; monotonic command time; and materialized state reconstructed exactly from the immutable ledger. Authorized corruption fails loudly; an outsider remains non-disclosing. Exact idempotency reuse returns the persisted receipt without dependency, clock, ID, lifecycle, or write use even after stop/detach. Changed reuse conflicts. Place transitions absent/left to present, move transitions present to a different location, remove transitions present to left, and a later place may begin a new presence interval.

Both legacy direct detach and audited administration detach consult `hasAttachedRunningNpcPresence()` inside their immediate transaction. Only an attached running room with at least one materialized `present` row is blocked. Detach does not delete the v43 root, ledger, receipts, or state; stopped history and exact receipt replay remain available. Fresh commands continue to require attachment and a non-stopped lifecycle.

M5.2 administration runs under one immediate transaction and derives current owner/GM authority from repository relationships. Creation requires an existing persisted `present` NPC in the attached running session. Grant creation and revocation are bounded, revisioned, idempotent, receipt-backed, and audited atomically. Exact issuer replay remains available after demotion or membership removal because v45 history references durable principals; this does not confer current authorization for a fresh command.

M5.3 consumable execution runs under one caller-owned immediate transaction. Before RNG it re-derives the exact catalog pin, inventory possession, target relation, active combat/turn, combat and acting/distinct-target M15 revisions, supported ordered effect plan, resource availability, and every generated identity for either round outcome. A commit consumes one item and the acting action, aggregates acting and distinct target M15 changes, keeps actor-backed and combat HP coherent, applies round-wrap M16 duration work, advances turn/combat state, and seals logs, events, and the receipt together. Exact immutable replay precedes stale classification; the separate result reader remains role-safe. Cardinality, injected-boundary rollback, duplicate-ID rejection, and reopen reads protect recovery without coupling this lane to the legacy combat union.

## Role-safe projections

Authorization and projection are repository concerns even in trusted-local mode. Start reads from validated membership/control ancestry, select explicit columns, and use structurally distinct owner/GM, player, observer, public, and private schemas. Unauthorized or unrelated identities return the domain's non-disclosing `null`/empty/not-found result; an authorized reader encountering corrupt persisted state receives an integrity failure.

Never project raw rows, idempotency keys, command envelopes, provider/private coordination data, controller identity, actor-private notes, hidden world routes, NPC goals, unrevealed quest/story truth, or staged generation content to a role that cannot see it. Internal path-binding evidence may accompany a repository snapshot only long enough for the route adapter to verify and strip it.

M4.1 agent snapshots derive visibility from the requested audience plus current membership, campaign role, actor control, attached session, target ancestry, encounter state, and the validated v43 presence graph; they do not reuse a caller-selected general-purpose projection. They contain bounded-source facts rather than full catalogs, full inventories, or story graphs. During a running room, v43 presence adds campaign-NPC roster facts only for NPCs whose state is currently `present`, and an NPC speaker target must itself be present in that running room. Legacy room participants linked through `session_characters` remain independently included and are not filtered by NPC presence. NPC locations follow the same GM-versus-controlled-principal discovery rule as the HTTP projection. Target actor notes/attributes, the speaking NPC's goals, or the target enemy's tactic/template may appear only in that authorized target's private planning layer; unrelated private facts remain absent. NPC/enemy planning has an immutable higher-precedence nondisclosure rule.

The snapshot method is server-internal repository API, not HTTP or shared wire surface. At M4.1 completion it added no production tool/provider loop or mutation capability; M4.2 subsequently composed those concerns without bypassing this disclosure boundary.

## Trusted-local HTTP and client context

RPG HTTP adapters use the fixed `LOCAL_OWNER_PRINCIPAL_ID` (`local-owner`) on a loopback, single-user boundary. This is convenience identity, not authentication or a remote-safe authorization design; do not accept caller identity headers or generalize it to multi-user deployment. Routes own request parsing, status/problem mapping, and wire projection; `packages/contracts` owns strict transport schemas. The client owns interaction, streaming state, resume tokens, and authoritative-read reconciliation, but never invents revisions, mechanics outcomes, or persistence truth. Consult `docs/api.md` for the route inventory rather than duplicating it here.

For M5.1, the client treats the campaign NPC roster and persisted room presence as separate authorities: the roster supplies GM placement candidates, while the no-store present-cast GET supplies running presence or stopped history. It accepts only a request-bound receipt-only POST response, keeps at most one in-memory mutation lock per campaign/session, and never automatically repeats the POST. Receipt-backed locks require an authoritative revision at least as new as the receipt; ambiguous locks require explicit refresh. Player projections are structurally unable to contain persona IDs, command principals, private NPC state, controller identities, or location IDs, and authorization downgrade clears GM-only controls and lock state.

M5.2 client support is transport-only over the authoritative owner/GM management GET and receipt-only command POST. M5.3 writes a durable ambiguity marker before consumable POST, submits once, and clears it only after exact-result and authoritative combat/log/action reconciliation; a reload retains unresolved state. The UI submits the exact server-derived target, quantity one, and action cost rather than synthesizing mechanics.

## Test approach

- Repository behavior tests use temporary data directories, real SQLite connections, deterministic clock/ID/RNG ports, restart/reopen checks, exact retry versus changed-key conflict cases, stale revisions, authorization loss, cross-campaign isolation, and nested-transaction guards.
- Role-projection tests assert exact object keys and absence of private text/identities, outsider nondisclosure, membership-rooted SQL, and fail-loud behavior for authorized corruption.
- Migration tests cover fresh creation and each relevant historical marker, populated backfills, canonical object inventory/digest attestation, fresh/migrated parity, immutable triggers, malformed or future artifacts, late failures, and unchanged marker/data after rollback.
- Contract tests validate shared schemas independently; route tests validate HTTP adaptation and reconciliation; client tests validate durable-state rendering without replacing repository tests.
- Run focused Vitest files while developing, then `npm --workspace velvet-mvp-server run typecheck` and `npm --workspace velvet-mvp-server test`. Changes spanning contracts or client behavior require the root `npm run typecheck` and `npm test`.

New persistence behavior belongs with the module that owns its invariant. Add a public export only when callers need a stable capability, and compose cross-domain atomic work inside `createRepository()` rather than in routes or services.
