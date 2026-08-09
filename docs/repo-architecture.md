# Repository architecture

This is the normative persistence guide for schema v37 revision 1 (`v37r1`). It describes `server/src/repo/`; HTTP behavior belongs in [the API reference](api.md), and shared runtime schemas belong in `packages/contracts`.

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
| `db/schema.ts` | `SCHEMA_VERSION = 37`, `SCHEMA_REVISION = 1`, fresh-schema construction, sequential migration order, revision repair, future-artifact classification, startup assertions, and migration rollback boundaries. |
| `db/migrations/*.ts` | Version-owned DDL, canonical object inventories/digests, data validation, backfill, and one-step migration functions. New schema behavior goes in the migration that introduces it. |
| `db/legacyImport.ts` | One-way import of an otherwise-empty legacy `db.json` store into SQLite. It does not merge stores. |
| `repoContext.ts` | Private provider bridge for legacy named wrappers. Only database setup configures it. |

Fresh creation and every supported sequential upgrade must converge on equivalent v37r1 DDL and validated data. Schema markers are not permission to accept partial, extra, modified, or populated future artifacts. Migrations run transactionally, preserve prior immutable history, and fail without advancing the marker when ancestry or provenance cannot be proved.

## Migrations v26-v37

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

## Repository ownership

`campaignRepositoryOrchestration.ts` opens the factory connection, installs runtime ports and nested-transaction guards, composes the public `Repository`, and delegates invariants to focused owners. Its `campaign/` adapters own authorization-rooted campaign reads/writes, actors, content selection, rooms, timelines, command/event projections, play bootstrap, and legacy compatibility seams. Avoid duplicate SQL in the orchestration facade.

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

## Role-safe projections

Authorization and projection are repository concerns even in trusted-local mode. Start reads from validated membership/control ancestry, select explicit columns, and use structurally distinct owner/GM, player, observer, public, and private schemas. Unauthorized or unrelated identities return the domain's non-disclosing `null`/empty/not-found result; an authorized reader encountering corrupt persisted state receives an integrity failure.

Never project raw rows, idempotency keys, command envelopes, provider/private coordination data, controller identity, actor-private notes, hidden world routes, NPC goals, unrevealed quest/story truth, or staged generation content to a role that cannot see it. Internal path-binding evidence may accompany a repository snapshot only long enough for the route adapter to verify and strip it.

## Trusted-local HTTP and client context

RPG HTTP adapters use the fixed `LOCAL_OWNER_PRINCIPAL_ID` (`local-owner`) on a loopback, single-user boundary. This is convenience identity, not authentication or a remote-safe authorization design; do not accept caller identity headers or generalize it to multi-user deployment. Routes own request parsing, status/problem mapping, and wire projection; `packages/contracts` owns strict transport schemas. The client owns interaction, streaming state, resume tokens, and authoritative-read reconciliation, but never invents revisions, mechanics outcomes, or persistence truth. Consult `docs/api.md` for the route inventory rather than duplicating it here.

## Test approach

- Repository behavior tests use temporary data directories, real SQLite connections, deterministic clock/ID/RNG ports, restart/reopen checks, exact retry versus changed-key conflict cases, stale revisions, authorization loss, cross-campaign isolation, and nested-transaction guards.
- Role-projection tests assert exact object keys and absence of private text/identities, outsider nondisclosure, membership-rooted SQL, and fail-loud behavior for authorized corruption.
- Migration tests cover fresh creation and each relevant historical marker, populated backfills, canonical object inventory/digest attestation, fresh/migrated parity, immutable triggers, malformed or future artifacts, late failures, and unchanged marker/data after rollback.
- Contract tests validate shared schemas independently; route tests validate HTTP adaptation and reconciliation; client tests validate durable-state rendering without replacing repository tests.
- Run focused Vitest files while developing, then `npm --workspace velvet-mvp-server run typecheck` and `npm --workspace velvet-mvp-server test`. Changes spanning contracts or client behavior require the root `npm run typecheck` and `npm test`.

New persistence behavior belongs with the module that owns its invariant. Add a public export only when callers need a stable capability, and compose cross-domain atomic work inside `createRepository()` rather than in routes or services.
