# Repository architecture

This document describes the current persistence boundary under `server/src/repo/`. It is an implementation guide, not an HTTP or shared-contract specification. Public API behavior remains defined by [the API reference](api.md), and runtime schemas shared with clients remain owned by `packages/contracts`.

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
| `campaignRepo.ts` | The composed synchronous `Repository`/`RepositoryUnitOfWork` implementation and the current campaign/RPG persistence owner: campaigns, memberships, timelines, room attachment, content packs/configuration, campaign characters/sheets/actors/resources, command/event/receipt audit behavior, authorized projections, and starter operations. It opens factory-owned connections, injects clock/ID/RNG ports, composes helpers from legacy domain repositories, and delegates the dice-specific surface to `diceRepo.ts`. The filename is historical; its composition role is broader than campaign CRUD. |
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
- `db.ts -> repoContext.ts` only configures the legacy singleton provider. Domain modules may read that provider but must not configure it.

New dependencies should point toward the module that owns the required invariant, avoid duplicate SQL, and avoid cycles. Prefer extracting a small connection-scoped helper over importing an asynchronous named wrapper into a transaction. Repository modules must never depend on Fastify, client code, route modules, generation services, or network/provider code.

## Transactions and audit constraints

- Keep multi-row invariants in one synchronous SQLite transaction. Do not await provider, filesystem, or network work while a transaction is open.
- Use `BEGIN IMMEDIATE` where a write must classify state and hold it stable through dependency use and commit. Preserve established validation and clock/ID/RNG consumption order; those ports are observable in deterministic tests.
- Do not call factory-only immediate operations from `Repository.transaction()`. Their explicit nested-transaction guards protect lock, retry, and classification semantics.
- A transaction callback must not return a promise, retain its unit of work, or invoke it after completion.
- Message persistence must keep the final message, active leaf, and message-backed usage event atomic.
- Campaign command execution must keep command/idempotency identity, exactly one timeline revision advance, domain state, immutable event, and receipt in one transaction. Dice additionally keeps roll aggregates and ordered terms in that commit. Never write audit rows as a later best-effort step.
- Exact command retries are reconstructed from persisted audit state without rerunning RNG, clock, or ID dependencies. Do not weaken complete-history validation or cross-campaign isolation to simplify a read.
- `db.ts` owns migration transactions. Schema changes, triggers, indexes, revision checks, and legacy migration changes belong there and require fresh/migrated parity and rollback coverage.

## Contracts and trusted-local boundaries

The repository boundary is not automatically the public API boundary. Internal snapshots may carry request-binding evidence or privileged fields that route/service adapters must validate and strip. Keep public and privileged campaign-character projections distinct, and never expose controller state, private notes, command envelopes, idempotency keys, or raw database rows through a route.

The RPG HTTP adapters always supply fixed `local-owner`. `LOCAL_OWNER_PRINCIPAL_ID` documents that repository-side trusted-local identity, but it is local single-user convenience—not authentication, remote authorization, or proof that a request header identifies a principal. New remote or multi-user behavior requires a separate authenticated principal boundary; do not generalize `local-owner` or accept spoofable identity headers.

## Where to add behavior

1. **Schema, migration, trigger, or connection behavior:** `db.ts` only.
2. **Persistence for one existing roleplay aggregate:** its domain repository file; expose it from `index.ts` only if callers need it.
3. **Campaign/content/actor/audit behavior:** currently `campaignRepo.ts`; extract a connection-scoped domain module when the behavior has a coherent owner, then compose it without changing the public barrel unnecessarily.
4. **Dice execution/history behavior:** `diceRepo.ts` for the facade and ownership; keep or move low-level audit implementation only as an atomic, tested unit.
5. **Cross-domain atomic workflow:** add synchronous owner helpers and compose them in the repository factory/UoW. Do not coordinate atomic persistence from a route.
6. **HTTP validation, status mapping, headers, or response projection:** the appropriate module under `server/src/routes/`, not the repository.
7. **Generation, prompts, summaries, memory extraction, or provider orchestration:** the owning service/domain module outside `server/src/repo/`; call the repository only for persistence.
8. **Shared client/server request or response shape:** `packages/contracts`, followed by adapters in server and client. Do not place transport contracts in repository files.

Before adding a new public repository export, ask whether the behavior belongs behind an existing aggregate method, whether it must participate in a factory transaction, and whether exposing it would let callers bypass an invariant-owning operation.
