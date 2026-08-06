# Repository architecture

This document describes the current persistence boundary under `server/src/repo/`. It is an implementation guide, not an HTTP or shared-contract specification. Public API behavior remains defined by [the API reference](api.md), and runtime schemas shared with clients remain owned by `packages/contracts`.

Current persistence is schema v25r1. V23 introduced M1.4 progression, v24 repaired its provenance/integrity graph, and v25 completes M1.5 resources, inventory, economy, and rest without rewriting historical ledgers. The fixed canonical v25 DDL digest is `a5e3a58f8014978315d20440a0ac087871edac95323d059327faa2fe0a983ef7`.

## Public entry point

Application code imports repository capabilities from `server/src/repo/index.ts`. That barrel deliberately exports the established named compatibility functions and the public repository factory/types; it does not export database handles, row types, synchronous implementation helpers, or repository-context plumbing.

Routes and services should import `server/src/repo/index.ts`, not domain files directly. Imports between repository modules are limited to the explicit composition edges described below.

## Files and ownership

| File | Owner and responsibilities |
| --- | --- |
| `index.ts` | Public repository barrel. It controls the persistence API visible to routes, services, tests, and other server modules. Add an export only when the capability is intentionally public to those callers. |
| `db.ts` | SQLite connection lifecycle, data-directory resolution, WAL/foreign-key/busy-timeout setup, the exact current schema, every sequential schema migration and corrective revision, and one-way legacy-store import. This is the sole owner of schema DDL and migration ordering. It must not become a home for domain queries or commands. |
| `repoContext.ts` | Private bridge from named asynchronous compatibility functions to the singleton connection managed by `db.ts`. `db.ts` configures the provider; domain compatibility functions call `getRepositoryDatabase()`. It is not public dependency injection and must never be exported from the barrel. |
| `shared.ts` | Small repository-wide invariants that have no domain owner. It currently owns the fixed trusted-local principal constant used during extraction. It must not accumulate general utilities or HTTP policy. |
| `characterRepo.ts` | Legacy Velvet persona rows and projections: list/get/create/update, guarded deletion, and the synchronous creation helper used by repository composition. Character deletion owns its atomic in-use check and invokes the lore-owned deletion repair before the character row is removed. |
| `settingsRepo.ts` | Harness and provider settings persistence, default recovery, public provider projection, normalization, and the synchronous harness update used by repository composition. It owns stored settings behavior, not prompt generation or provider HTTP calls. |
| `sessionRepo.ts` | Session aggregates, participants, consent logs, context-source persistence, lifecycle transitions, creation/deletion, and atomic stop composition. Its synchronous helpers support the factory unit of work. It does not own messages, summaries, or generation coordination. |
| `messageRepo.ts` | Message trees, active-branch selection, swipes/children, message persistence, and provider-usage ledger writes/aggregation. A final generated message, active-leaf update, and message-backed usage event commit together. |
| `memoryRepo.ts` | Character memory persistence: deduplicated creation, approved/all reads, approval/edit, soft forget, and restore. Memory extraction from prose remains in `server/src/memory.ts`; this module stores already-decided facts. |
| `loreRepo.ts` | Lore rows and ordered character scopes, CRUD, synchronous creation for repository composition, and lore repair during character deletion. Runtime trigger selection remains in `server/src/lore.ts`. |
| `summaryRepo.ts` | Episode-summary read/upsert/delete persistence and row projection. Summary generation and update timing are service concerns, currently in `server/src/routes/roleplay/generationService.ts`. |
| `campaignRepo.ts` | The composed synchronous `Repository`/`RepositoryUnitOfWork` implementation and the current campaign/RPG persistence owner: campaigns, memberships, timelines, room attachment, content packs/configuration, campaign characters/sheets/actors/resources, command/event/receipt audit behavior, authorized projections, and starter operations. It opens factory-owned connections, injects clock/ID/RNG ports, composes helpers from legacy domain repositories, and delegates the dice-specific surface to `diceRepo.ts`. The private campaign event-projection adapter owns bounded public pagination while this facade retains event reconstruction. The filename is historical; its composition role is broader than campaign CRUD. |
| `campaignAdministrationRepo.ts` | Connection-scoped schema-v15 campaign administration facade composed by `campaignRepo.ts`. It owns revision-checked idempotent administration commands, audited membership and room changes (including deterministic compatibility audits for legacy signatures), bounded package validation/apply, role-safe receipt/log reads, and export manifests. Focused administration adapters own membership-backed authority and role-filtered lifecycle/settings projections, checkpoint state snapshots/inherited-prefix forks, recaps, and timeline history. Its parallel immutable command/event/receipt family intentionally does not widen or rebuild the closed gameplay audit tables. |
| `contentCatalogRepo.ts` | Connection-scoped schema-v18 catalog facade composed by `campaignRepo.ts`. It owns pure deterministic `validated-v1` validation/canonical digests, closed starter mechanics, complete class-level/dependency graphs, idempotent application-owner publication, revisioned/idempotent campaign-owner exact pin changes, immutable catalog audit receipts/proposals, transitive public-reachability attestations, persisted-integrity validation, deterministic reports, and structurally role-safe new and legacy reads. It never reads files or URLs and exposes no executable rule language. |
| `characterBuilderRepo.ts` | Schema-v22r1 character-builder facade composed by `campaignRepo.ts`. It owns durable/expiring revisioned drafts, fixed choices, exact validated-v1 pin snapshots, 24 independently injected physical-die rolls, owner/GM/controller policy, persona/controller eligibility, completion previews, immutable proposed command/event/receipt history, and atomic finalization into the existing single-class character aggregate. Draft mutations are factory-only and no draft row is playable. |
| `characterProgressionRepo.ts` | Schema-v24r1 single-class progression facade introduced in v23 and integrity-repaired in v24. It bootstraps supported finalized builder characters exactly once, owns XP/milestone and compensating ledgers, revision/token-bound previews, required catalog-reference choices, one immutable row per applied level, known powers, derived snapshots, strict owner/GM/controller reads, and authoritative receipts. Mutations are factory-only and all crossed levels commit atomically. |
| `characterProgressionPersistence.ts` | Connection-scoped progression persistence and complete provenance/integrity validation shared by migration/startup and the progression facade. It binds bootstrap state, pending revisions, commands/proposals/events/receipts, advancements, power sources, known powers, and derived snapshots. |
| `actorResourceRepo.ts` | Schema-v25r1 actor-resource facade composed by `campaignRepo.ts`. It owns actor resource sidecars and their repository commands. |
| `inventoryRepo.ts` | Schema-v25r1 inventory facade composed by `campaignRepo.ts`. It owns inventory entries, equipment, capacity, and transfer restrictions. |
| `economyRepo.ts` | Schema-v25r1 economy facade composed by `campaignRepo.ts`. It owns integer-minor wallets and currency ledgers, shops, finite stock, quotes, purchases, and bilateral trade. |
| `restRepo.ts` | Schema-v25r1 rest facade composed by `campaignRepo.ts`. It owns short/long rest recovery and receipts. |
| `characterBuilderCalculator.ts` | The one pure closed `velvet-character-derived-v1` calculator. It accepts strict server-assembled inputs and returns HP, three defenses, initiative, speed, carrying limit, spell attack, save DC, and nine explanatory formula records. It has no database, RNG, clock, override, or executable-content dependency. |
| `diceRepo.ts` | Connection-scoped dice repository facade and dice-owned public repository types/errors. It binds deterministic dice execution, visible-character revalidation, recent dice history, and receipt lookup to the same database and runtime dependencies as the composed repository. Low-level audit SQL currently remains in `campaignRepo.ts` so one transaction owns command, roll, terms, event, receipt, and timeline revision. |

## Connection and composition model

```text
legacy named route/service call
  -> repo/index.ts
  -> domain compatibility function
  -> repoContext.ts
  -> db.ts singleton connection

RPG route/service call
  -> repo/index.ts
  -> createRepository(options)
  -> db.ts factory-owned connection
  -> campaignRepo.ts Repository
       -> domain synchronous helpers where explicitly composed
       -> diceRepo.ts connection-scoped facade
       -> campaignAdministrationRepo.ts connection-scoped facade
       -> contentCatalogRepo.ts connection-scoped facade
       -> characterBuilderRepo.ts connection-scoped facade
       -> characterProgressionRepo.ts connection-scoped facade
       -> actorResourceRepo.ts connection-scoped facade
       -> inventoryRepo.ts connection-scoped facade
       -> economyRepo.ts connection-scoped facade
       -> restRepo.ts connection-scoped facade
```

The two surfaces are intentional compatibility layers:

- Named asynchronous exports preserve the original roleplay call shape and use the configured singleton database plus `systemRuntime` where required.
- `createRepository()` returns a closeable synchronous repository with an isolated connection and injectable clock, ID, and RNG dependencies. RPG route registration lazily owns one such repository for its plugin lifetime.
- `Repository.transaction()` exposes only `RepositoryUnitOfWork`, rejects asynchronous callbacks, and invalidates the unit of work after the callback. Factory-only operations are intentionally absent from that surface.

Do not pass a raw `better-sqlite3` connection above the repository layer. If a new composed capability needs a connection-scoped helper, construct it inside `createRepository()` and keep its raw handle private.

## Domain and dependency rules

Repository modules own persistence decisions; routes own HTTP parsing/status/response behavior; services own workflows, provider calls, and orchestration; `packages/contracts` owns shared runtime contracts. A repository may parse a shared contract to defend persisted projections, but it must not redefine a wire schema or import a route.

Allowed current cross-domain edges are narrow and transactional:

- `characterRepo.ts -> loreRepo.ts` only for deletion repair before character removal.
- `messageRepo.ts -> sessionRepo.ts` only to return the established session aggregate after active-branch changes.
- `campaignRepo.ts -> characterRepo.ts`, `loreRepo.ts`, `settingsRepo.ts`, and `sessionRepo.ts` only through synchronous helpers used by repository composition and units of work.
- `campaignRepo.ts <-> diceRepo.ts` is a deliberate composition seam: `campaignRepo.ts` constructs the facade, while `diceRepo.ts` calls explicitly exported low-level dice/audit helpers. Do not add another cycle.
- `campaignRepo.ts -> campaignAdministrationRepo.ts` composes the administration facade with the same private connection and runtime ports. Its private access/projection adapter centralizes membership-backed authority and role-filtered administration reads; the administration module imports only the composition dependency type in return, avoiding a runtime cycle.
- `campaignRepo.ts -> campaign/campaignEventProjectionRepo.ts` composes a private pagination projection with the same invariant-owning event read used by both factory and unit-of-work paths. It does not own event reconstruction or audit SQL.
- `campaignRepo.ts -> contentCatalogRepo.ts` composes the catalog facade with the same private connection and clock. Pure validation and role-safe reads are available in active units of work; publication and configuration remain factory-only and reject nesting.
- `campaignRepo.ts -> characterBuilderRepo.ts` composes the builder with the same private connection and clock/ID/RNG ports. Draft reads and immutable receipt reads are authoritative; create/update/abandon/finalize are factory-only and reject repository-transaction nesting. The builder calls only the pure server calculator and does not call persona-edit persistence.
- `campaignRepo.ts -> characterProgressionRepo.ts` composes progression with the same private connection and runtime ports. Progression delegates persisted graph validation to `characterProgressionPersistence.ts`; mutations remain factory-only and reject nesting.
- `campaignRepo.ts -> actorResourceRepo.ts`, `inventoryRepo.ts`, `economyRepo.ts`, and `restRepo.ts` composes the M1.5 facades with the same private connection and runtime ports. Their exact retries, revisions, and immutable receipts are factory-only and reject nesting.
- `db.ts -> repoContext.ts` only configures the legacy singleton provider. Domain modules may read that provider but must not configure it.

New dependencies should point toward the module that owns the required invariant, avoid duplicate SQL, and avoid cycles. Prefer extracting a small connection-scoped helper over importing an asynchronous named wrapper into a transaction. Repository modules must never depend on Fastify, client code, route modules, generation services, or network/provider code.

## Transactions and audit constraints

- Keep multi-row invariants in one synchronous SQLite transaction. Do not await provider, filesystem, or network work while a transaction is open.
- Use `BEGIN IMMEDIATE` where a write must classify state and hold it stable through dependency use and commit. Preserve established validation and clock/ID/RNG consumption order; those ports are observable in deterministic tests.
- Do not call factory-only immediate operations from `Repository.transaction()`. Their explicit nested-transaction guards protect lock, retry, and classification semantics.
- A transaction callback must not return a promise, retain its unit of work, or invoke it after completion.
- Message persistence must keep the final message, active leaf, and message-backed usage event atomic.
- Campaign command execution must keep command/idempotency identity, exactly one timeline revision advance, domain state, immutable event, and receipt in one transaction. Dice additionally keeps roll aggregates and ordered terms in that commit. Never write audit rows as a later best-effort step.
- Campaign administration mutations similarly advance one campaign administration revision and atomically seal a parallel command/event/receipt. Exact retries return persisted result data; timeline forks retain their parent and checkpoint revision and never rewrite historical timelines.
- Campaign package dry runs are pure reads and deterministically validate bounded schema/Unicode, graph roots/cycles/fork bounds, exact inherited parent prefixes, complete revision histories, references, collisions, exact-version content pins, portable event/command identities, recap room portability, and safe exclusions. Apply repeats that validation inside `BEGIN IMMEDIATE` and reserves a principal-global submission identity before commit. Exact concurrent submissions converge from persisted results; changed payloads conflict.
- Catalog validation completes before publication writes and deterministically orders issues, definitions, dependencies, and exact pins by binary string order. Class levels are contiguous from 1, uniquely owned/referenced, and cycle checked. A publication inserts the catalog, seven-kind v10 metadata, visibility rows, row/aggregate attestations, and immutable idempotency submission around one seal transition in a single transaction. Exact retries resolve through the stored submission; changed-key payloads and differing exact identities conflict. SQLite update/delete/append/`INSERT OR REPLACE` guards protect every sealed and attested row.
- Campaign catalog selection is current mutable state, but it changes only inside one open catalog command after the canonical sole-owner graph and expected administration revision are validated. SQL binds selection and its non-empty ordered authoritative publication pins to an immutable v18 proposal containing the exact event identity, actor, canonical public result, publication digests, and receipt result; event and receipt bytes must match that proposal and command identities/revisions cannot overlap M1.1 history. Each successful change advances exactly once and seals immutable additive command/event/receipt rows. Exact idempotent retries converge from the receipt; changed-key and stale requests do not write. Player/observer reads compute public reachability from separate public/private dependency sidecars before parsing values, preventing private-only or poisoned definitions from crossing roles. Legacy campaign reads verify every row and aggregate first; corruption fails for owner/GM and is masked for player/observer.
- Schema v16 remains preserved as the original additive compatibility layer. Schema v17 adds only new tables, indexes, and triggers after enumerating and verifying the canonical v16 tables, columns, indexes, and triggers; it strictly reparses each full definition graph and derives canonical public JSON/reachability rather than attesting stored v16 public sidecars. Schema v18 similarly verifies the complete canonical v17 catalog layout before adding immutable exact command proposals. No prior catalog table is rebuilt, dropped, renamed, or rewritten during genuine upgrades. Fresh and v15→v16→v17→v18 paths share exact DDL. `legacy-v10` rows remain honest and validated configuration accepts only attested publications.
- Schema v19r1 strictly enumerates the complete v18 catalog layout before adding only character draft/pin/command/event/receipt/revision, final derived snapshot, and starting-grant ledger tables, indexes, and guards. Genuine upgrades do not rebuild, drop, rename, rewrite, or synthesize rows in any prior table; existing characters remain unchanged and receive no implicit drafts. Fresh and sequentially migrated DDL are identical, and a failed preflight or late DDL statement rolls back to the intact v18 marker.
- Schema v20r1 first verifies every v19 builder table, column, index, and trigger, validates every populated v19 command/event/receipt/revision aggregate, then additively backfills exact immutable proposals. Corrupt v19 history rolls back before any v20 artifact. Every current startup verifies all v19/v20 objects and a byte attestation of trigger/index SQL; missing or extra builder artifacts reject. A lower schema marker containing any future v19/v20 object fails before mutation—startup never drops or repairs it.
- Schema v21r1 is additive: it performs no drop, rebuild, or rename. It closes command, event, proposal, and receipt identity to one row per resulting draft revision (including create revision zero), requires the same immutable revision snapshot, and revalidates root/result history on every startup. Canonical fixed digests cover complete `sqlite_master.sql` for prior v20 and v21 builder tables (including constraints and FKs), indexes, and triggers; coherent same-name no-ops, missing/extra objects, and constraintless lookalike tables fail transactionally.
- Additive schema v22r1 permanently retires the legacy v20 deletion capability without dropping prior artifacts. New unconditional guards make the marker inert and reject physical campaign and builder-child deletion even if a hostile connection registers the legacy UDF name. No repository permanent-delete API or deletion UDF exists. Campaign lifecycle is archive. Migration and every startup also bind each draft root's `created_by_principal_id` to its immutable create command actor.
- Additive schema v23r1 preserves the canonical v22 layout and records fixed prior/current DDL digests before adding progression profiles, append-only ledgers, immutable per-level advancements, pending choices, known powers, command receipts, and revision snapshots. Migration backfills supported finalized M1.3 builder aggregates without rewriting them; unsupported legacy aggregates remain unavailable. Startup re-attests DDL plus root/ledger/snapshot, command/result, advancement, and known-power provenance.
- Additive schema v24r1 preserves historical ledgers while repairing exact bootstrap and initial-power provenance, immutable pending snapshots for revision zero and every command, proposal/event/receipt binding, and advancement power sources. Migration reconstructs pending revisions from immutable command results; startup validates the complete graph. Its fixed canonical DDL digest is `e056d9df1ec9f9c00cc1aba740f2acc91b40cc7b03a5716cb75e79ec8df6bec8`.
- Additive schema v25r1 preserves historical ledgers while adding M1.5 actor resource sidecars, inventory/equipment, integer-minor wallets and currency ledgers, shops/finite stock/quotes/purchases, bilateral trade, and short/long rest. Exact retries, revisions, and immutable receipts are factory-only behavior. Its fixed canonical DDL digest is `a5e3a58f8014978315d20440a0ac087871edac95323d059327faa2fe0a983ef7`.
- Character draft create validates campaign authority, controller membership, persona eligibility, exact current `validated-v1` publications, and all non-random input before clock/ID writes. Server roll independently calls the injected RNG for each of 24 physical d6 values using `[1,7)`, drops the first lowest in each ordered group of four, and persists every term. Invalid midstream output rolls back without fallback or hidden retry; exact committed retry reads the immutable result and never rerolls. Effective expiry is checked from the injected clock without rewriting status. Updates cannot change allocation, persona, controller, durability, or pins.
- Every draft command is paired with one immutable v20 proposal binding actor, campaign, draft, command, exact event identity/type/canonical bytes, and exact canonical result. Event insertion additionally binds command revisions and current authoritative draft status/revision; receipt insertion requires the same event and byte-identical proposed result. `request_digest` is informational only, while retry identity compares canonical `requested_json`. Receipt reads bind requested draft, campaign, and command.
- A retained active, abandoned, or finalized draft makes its legacy persona deletion return the established `in-use` result. Direct draft, proposal, audit, revision, derived-snapshot, starting-grant, and campaign deletion remains SQL-guarded. Ordinary and supported lifecycle management archives; repository and HTTP surfaces expose no physical campaign deletion.
- Finalization repeats authority, effective expiry, persona/controller, exact-current-pin, definition, level-one, allocation, and fixed-choice validation under `BEGIN IMMEDIATE`. One commit creates the existing campaign-character/sheet/single-class/attribute/proficiency/choice/actor/private-state graph, initializes health, stores the immutable calculator snapshot and exact kit-or-currency grant ledger, advances the draft once, and seals one command/event/receipt/revision. M1.5 provides repository-owned inventory/wallet materialization. Any failure rolls back every row, and exact retry returns the sole receipt.
- Transfer packages preserve timeline revisions, inherited public gameplay provenance, portable actor mechanics graphs, fork provenance, checkpoint snapshots, recap references, exact content pins, safe memberships, portable rooms, and public administration provenance. Imported actor IDs are remapped consistently through events and snapshots. Packages structurally omit command idempotency keys, provider credentials, local paths, usage history, and actor-private state.
- Exact command retries are reconstructed from persisted audit state without rerunning RNG, clock, or ID dependencies. Do not weaken complete-history validation or cross-campaign isolation to simplify a read.
- `db.ts` owns migration transactions. Schema changes, triggers, indexes, revision checks, and legacy migration changes belong there and require fresh/migrated parity and rollback coverage.

## Contracts and trusted-local boundaries

The repository boundary is not automatically the public API boundary. Internal snapshots may carry request-binding evidence or privileged fields that route/service adapters must validate and strip. Keep public and privileged campaign-character projections distinct, and never expose controller state, private notes, command envelopes, idempotency keys, or raw database rows through a route.

The RPG HTTP adapters always supply fixed `local-owner`. `LOCAL_OWNER_PRINCIPAL_ID` documents that repository-side trusted-local identity, but it is local single-user convenience—not authentication, remote authorization, or proof that a request header identifies a principal. New remote or multi-user behavior requires a separate authenticated principal boundary; do not generalize `local-owner` or accept spoofable identity headers.

M1.1-M1.5 are repository/shared-contract capabilities. The trusted-local boundary remains at 21 operations: the historical 14 plus server-only builder create/read/update, progression read/preview, and administration GET/PATCH. M1.5 has no HTTP route or client/UI. These adapters share the parent feature plugin's one lazy repository and close hook, use relative child paths, and fix `local-owner`; no client/UI is implied. The mechanics starter remains separate from the original metadata-only starter.

## Where to add behavior

1. **Schema, migration, trigger, or connection behavior:** `db.ts` only.
2. **Persistence for one existing roleplay aggregate:** its domain repository file; expose it from `index.ts` only if callers need it.
3. **Campaign/content/actor/audit behavior:** use the focused administration, catalog, character-builder, progression, or dice facade when it owns the invariant; otherwise `campaignRepo.ts` remains the composition layer. Extract a connection-scoped domain module rather than growing duplicate SQL.
4. **Dice execution/history behavior:** `diceRepo.ts` for the facade and ownership; keep or move low-level audit implementation only as an atomic, tested unit.
5. **Cross-domain atomic workflow:** add synchronous owner helpers and compose them in the repository factory/UoW. Do not coordinate atomic persistence from a route.
6. **HTTP validation, status mapping, headers, or response projection:** the appropriate module under `server/src/routes/`, not the repository.
7. **Generation, prompts, summaries, memory extraction, or provider orchestration:** the owning service/domain module outside `server/src/repo/`; call the repository only for persistence.
8. **Shared client/server request or response shape:** `packages/contracts`, followed by adapters in server and client. Do not place transport contracts in repository files.

Before adding a new public repository export, ask whether the behavior belongs behind an existing aggregate method, whether it must participate in a factory transaction, and whether exposing it would let callers bypass an invariant-owning operation.
