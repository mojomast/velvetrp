# Revision 2 integration plan

**Authority and status.** This is the actionable execution design for planning-board revision 2, saved 2026-08-11T00:47:24.296Z with `ready: true` and no blockers. [ROADMAP.md](ROADMAP.md) owns scope and milestone status; this document is subordinate to it and supplies implementation detail. Runtime contracts and current code remain authoritative for shipped behavior. Current persistence is v46r1, the supported startup window is canonical populated v44/v45->v46, v43 and earlier are unsupported, and the current trusted-local RPG surface has 102 explicit operations.

**Research baseline.** Repository research was performed against `e0025a41f1393a61dcab9d24e08d1804d374169b` and the preserved dirty worktree on 2026-08-11. At that historical baseline persistence was v42r1 and M4 was complete. Existing dirty migration archive/support-window fixtures, documentation, and planning-board work were evidence to finish rather than reset. File paths called **observed** existed at that baseline; paths called **likely/new** were proposed ownership, not claims that a file existed. The saved board and repository can evolve independently, so each milestone starts with a focused contract/code recheck and records any discovery without silently changing the approved product decision.

## Approved scope and interpretation

### Build now

1. Establish a tested rolling current-minus-two migration window, which at H0.1 completion was canonical populated v40 and v41 upgrades to v42, while retaining older migration tests only as an explicit archive.
2. Repair the six known deterministic E2E failures without weakening authoritative behavior.
3. Reconcile current documentation.
4. Make one reproducible health command the stop-on-failure release gate.

### Build next

- Session-scoped NPC presence with optional location.
- Companion aggregates with bounded controller grants and confirmation; autonomous companion speech/actions are not part of the first delivery.
- Atomic combat power/item settlement through a composition-owned transaction, retaining one active encounter per campaign session.
- A persisted, generic, reviewable agent candidate/quote protocol with exact server-generated candidates and policy metadata.
- Agent mechanics expanded one family at a time from those exact candidates.
- Commit-reveal verifiable dice with additive sidecars and proofs.

### Build later

- A closed declarative rules IR; licensed, reviewed offline reference ingestion; non-promotable ephemeral branch-local simulation.
- Campaign-scoped remote tenancy and server-derived authenticated session principal metadata.
- Global harness defaults with bounded session overrides.
- Allowlisted scoped external tools and policy-granted proactive automation with visible receipts.

Reference ingestion remains blocked until mutable authoring is promoted and delivered. The only exception is a separately reviewed and approved ingestion design that can produce immutable drafts without a mutable publication head; this plan does not promote ingestion or silently relax that gate.

### Approved Build Unscheduled

- Append-only multiclass levels and prerequisites.
- Mutable pack authoring through a logical unpinned head that creates immutable revisions; exact pins and history never mutate.
- Explicit boss phase state.
- Zones/range bands before any full tactical grid.
- Autonomous parties using revocable, scoped grants.

### Explicit exclusions

- Defer Discord for now.
- VTT adapters and simultaneous encounters are deferred.
- Full tactical grids/LOS, arbitrary executable rules, URL/network reference import, mutation of pinned history, simulation promotion, and bilateral agent trade without counterpart consent are excluded.
- The single-active-encounter invariant remains in force.

## Cross-cutting invariants

- **Authority:** every mechanic uses the same server-owned, revision-checked, idempotent command service as HTTP/UI. Provider work, OIDC exchange, filesystem review, and all remote calls happen outside SQLite transactions.
- **Atomicity:** composition-owned commands validate principal authority, ancestry, candidates/quotes, revisions, and idempotency inside one immediate transaction, then commit state, normalized sidecars, immutable event, and receipt together. Unknown delivery is reconciled; it is never permission to replay.
- **Projection:** private tool arguments, provider metadata, principals, controller identity, opaque internal IDs, hidden state, secrets, and unrevealed world/story facts stay out of player/public projections. Responses expose only safe labels, typed outcomes, state deltas, proof material intended for verification, and stable public locators when needed.
- **Persistence:** migrations are additive and transactional. Historical migration layouts are never edited. Backfills are deterministic, bounded, restart-safe through transaction rollback, and validated before the marker advances.
- **Migration window:** at schema `N`, startup upgrades from canonical populated `N-2` and `N-1` are supported and tested. When a new version lands, add its canonical fixture, promote the previous current fixture, archive the old `N-2` executable suite, and update operations/architecture docs in the same milestone. This policy does not imply support for every older marker still reachable in code.
- **Schema allocation:** M5.1 delivered **v43r1**, the M5.2 foundation delivered **v44r1**, durable companion principals delivered **v45r1**, and the M5.4 persistence-only exact-candidate foundation delivered **v46r1**. M5.3 Slice 0, its consumable contract and repository runtime, and the M5.5 contract/vector checkpoint are no-schema. The next persistence slice receives a number from its schema steward only at implementation start, and each allocation moves the rolling support window.
- **Security:** current fixed `local-owner` is loopback-only convenience. Remote work uses campaign tenancy and server-derived authenticated session metadata, never caller identity headers. Platform settings are admin-only; legacy routes become local-only or explicitly scoped before remote exposure.
- **Limits and receipts:** all new collections, strings, graph depth, work, duration, calls, and mutations have strict server caps. Consequential operations have visible confirmation/policy decisions and immutable receipts.

## Dependency DAG and delivery waves

```text
H0.1 migration foundation ─┐
H0.2 E2E repairs ──────────┼──> H0.4 canonical health gate
H0.3 docs reconciliation ──┘

After H0.4, these tracks may proceed in parallel:
  M5.1 NPC presence -> M5.2 v45 repository administration -> HTTP/client transport -> optional UI
  M5.3 combat-health Slice 0 -> consumable runtime -> separate HTTP/client UI -> modifier exclusion decided
  M5.4 exact-candidate v1 checkpoint Complete -> v46 persistence foundation -> travel adapter/generator/execution design
  M5.5 exact protocol checkpoint Complete -> gated persistence integration

M5.6 adapters depend per family, not on a blanket chain:
  travel/rest -----------------> M5.4 + existing authoritative commands
  out-of-combat power/inventory -> M5.4 + existing authoritative commands
  combat powers/items ----------> M5.3 (+ M5.4 when agent-selected)
  companion actions ------------> M5.2 + exercisable principal/grant model in L5
  random mechanics -------------> M5.5 only where proof policy requires

M5.3 + relevant M5.6 families -> L1 rules IR
U2 mutable authoring promoted+delivered -> L3 licensed offline ingestion
  (or separately approved immutable-draft-only ingestion path)
M5.3 + relevant M5.6 (+ M5.5 only for proof-required randomness) -> L4 simulation
H0.4 -> L5 remote identity/tenancy and exercisable grants -> L6 harness overrides -> L7 proactive automation/tools

U1 multiclass <- L1 + stable progression
U2 mutable pack authoring <- immutable catalog + promotion review
U3 zones/range bands <- M5.3 + rules semantics
U4 boss phases <- M5.3 + stable combat
U5 autonomous parties <- M5.2 + M5.4 + L5 + L7
```

Delivery waves are: **Wave H (health, green)** H0.1-H0.4; then parallel **Wave A tracks** for NPC→companion core, atomic combat, candidate protocol, and dice after its threat-model checkpoint; **Wave B (per-family integration)** M5.6 adapters gated only by their exact domain dependencies; **Wave C (extensibility and safe local tooling)** L1, L3, and L4, with ingestion still blocked by promoted/delivered U2 unless its separate immutable-draft-only exception is approved; and **Wave D (remote trust and automation)** L5-L7. A wave is an integration grouping, not a blanket prerequisite chain. H0 and M5.1 are complete; Wave A has committed bounded foundations/slices/checkpoints, but M5.2-M5.5 are not thereby fully complete and M5.6 remains Planned.

## H0 — repository health baseline (green)

### H0.1 — Rolling migration support foundation

**Status:** Complete.

- **Outcome:** fresh v42 creation and canonical populated v40/v41 startup upgrades are the only executable supported migration baseline; old suites remain discoverable but non-running.
- **Dependencies:** none. Preserve the current dirty archive/support work and do not rewrite old migration implementations.
- **Scope and decisions:** finish the existing archive rename/index work; replace ad hoc current-database marker rewinds with reusable canonical populated fixtures/builders for v40 and v41; assert v40→v41→v42 and v41→v42 parity, data preservation, attestation, malformed ancestry rejection, rollback, retry, and unchanged markers on failure. Keep legacy paths in the binary without calling them supported.
- **Observed files:** `server/test/migration-support-window.test.ts`, `server/test/MIGRATION_TEST_ARCHIVE.md`, archived `server/test/migration-v*.archived.ts`, `server/test/helpers.ts`, `server/test/migration-v42.test.ts`, `server/test/repo.test.ts`, `server/test/branch.test.ts`, `server/test/m4-agent-acceptance.test.ts`, `server/src/repo/db/schema.ts`, `docs/operations.md`, `docs/repo-architecture.md`, root `README.md`, `CONTRIBUTING.md`, `.gitignore`, and `package.json`. **Protected boundary:** do not inspect or modify `server/src/repo/contentCatalogRepo.ts`.
- **Likely/new files:** `server/test/fixtures/migrations/v40.ts` and `v41.ts`, or equivalently named fixture builders owned only by migration tests. Do not commit binary SQLite fixtures unless deterministic source builders are demonstrably insufficient and a review approves provenance/size.
- **Command/transaction/projection requirements:** fixture creation must use frozen IDs/time and canonical version-owned APIs/DDL; migration startup remains one transaction per version and advances its marker last. Tests inspect only schema/data, not public projections; no production command behavior changes in this slice.
- **Security/privacy:** fixtures contain synthetic values only—no copied local database, provider key, path, principal beyond synthetic/local-owner test identity, or campaign-private content.
- **Migration/backfill:** no new schema. Validate populated v40 campaign state and populated v41 opening-narrative/generation state, fresh/migrated DDL parity, v42 attestation, and rollback after injected v41/v42 marker failures.
- **Non-goals:** no support promise for v2-v39; no deletion of historical migration code; no editing historical layouts; no schema bump; no broad repository refactor.
- **Acceptance:** archive inventory is complete and intentional; only supported-window suites execute; canonical populated fixtures cannot accidentally include future artifacts; focused migration tests pass and docs say v40/v41→v42.
- **Validation:** with a unique `/dev/shm` temp directory, run `npm run test --workspace velvet-mvp-server -- test/migration-support-window.test.ts test/migration-v42.test.ts`, then `npm run typecheck --workspace velvet-mvp-server`. Run related `repo.test.ts`, `branch.test.ts`, and `m4-agent-acceptance.test.ts` only if shared helpers/skips change. Stop at first failure.
- **Docs:** update `MIGRATION_TEST_ARCHIVE.md`, `docs/operations.md`, `docs/repo-architecture.md`, root `README.md`, then ROADMAP/devplan/handoff lifecycle files.
- **Logical commits:** (1) archive/fixture ownership; (2) canonical support-window tests; (3) migration docs/status. Code/test commits require the owning workspace typecheck; the docs-only commit requires targeted consistency/link checks and `git diff --check`. Do not bundle planning-board work.
- **Rollback/recovery:** tests/builders can be reverted independently without changing a database. If production migration behavior must change, retain the failing synthetic DB and restore the prior code; never lower a real marker or remove populated future artifacts.

### H0.2 — Six deterministic E2E repairs

**Status:** Complete.

- **Outcome:** the deterministic suite matches current authoritative HTTP and navigation contracts without changing those contracts merely to satisfy stale expectations.
- **Dependencies:** may proceed beside H0.1; merge before H0.4.
- **Observed failure evidence and repairs:** the original six failures were four finalization call sites in `e2e/tests/app.spec.ts` that expected `200` while the authoritative response was `201`; they were repaired to preserve the `201` public contract and obtain internal actor identity through an authorized resolver available only in the deterministic E2E harness. The attached unconfigured-room case expected legacy chat/back behavior but actually routed to play because routing checked feature availability alone; it was repaired with a configured-status gate plus cancellation/error handling. The storyline/quest case expected creation but its story `POST` actually returned `400` under the strict graph contract; it was repaired to use the current strict story/quest workflow and verify idempotent replay. The old supplied aggregate drifted from the repository: M2.5 passed, and the current full deterministic suite includes 12 cases. No aggregate total is inferred for the original six-failure run beyond those six recorded failures.
- **Observed files:** `e2e/tests/app.spec.ts`, `client/src/App.tsx`, `client/src/App.test.tsx`, `client/src/components/rpg/play/CampaignPlayPage.tsx`, `server/src/routes/rpg/v1/characterBuilder.ts`, `storyRoutes.ts`, `questRoutes.ts`, `packages/contracts/src/character-builder-http.ts`, `story-http.ts`, `quest-http.ts`, and their focused tests.
- **Command/projection requirements:** E2E inputs use server-required IDs, expected revisions, idempotency keys, complete graph definitions, and legal commands. Assertions use public fields only and must not surface internal actor/sheet/campaign IDs in DOM checks merely to make setup convenient.
- **Security/privacy:** keep fake provider and disposable database; no live provider, hidden story answers, private NPC state, raw receipt internals, or principal metadata in browser assertions.
- **Migration/backfill:** none.
- **Non-goals:** no production status-code change, legacy route resurrection, content-configuration bypass, E2E-only production backdoor, timeout increase, retry loop, or assertion deletion without replacement.
- **Acceptance:** every failure has a recorded expected/actual/source call site and a reproduced root cause; each repaired path has a positive authoritative assertion; proven finalize status expectations retain authoritative 201; play-shell reload/back behavior remains covered where reproduced; story/quest workflow uses current bodies/routes where reproduced; `npm run test:e2e` passes deterministically.
- **Validation completed:** client focused 3 files/113 tests plus client typecheck; server fixture/M1.5 2 files/17 tests plus server typecheck; `typecheck:e2e`; full deterministic E2E 12 passed; `git diff --check`.
- **Docs:** repaired baseline recorded in ROADMAP/devplan/handoff; H0.3 remains the dedicated current-documentation reconciliation task.
- **Commits:** `ee7dfba fix(client): preserve authoritative campaign navigation`; `60afa5f test(e2e): align authoritative RPG workflows`.
- **Rollback/recovery:** revert one E2E slice at a time. If a current contract is actually wrong, stop and open a separately reviewed contract correction rather than silently changing server/client behavior in this repair.

### H0.3 — Current documentation reconciliation

**Status:** Complete.

- **Outcome:** at H0.3 completion, normative and entry-point docs described v42r1, completed M4.1-M4.6, the then-current migration support, and the approved post-M4 plan; historical ledgers remain visibly historical.
- **Delivered evidence:** at that checkpoint, active documentation recorded 95 trusted-local RPG HTTP operations versus the historical 92-operation M2.11 baseline, completed M4.1-M4.6, and canonical populated v40/v41->v42 executable support. Historical schema, milestone, operation-count, and gate ledgers remain preserved and are distinguished from current implementation, Planned, Unscheduled, deferred, and excluded status.
- **Dependencies:** H0.1 policy wording and H0.2 final result should be known before closeout.
- **Scope:** repair stale active/current sections in root `README.md`, `docs/rpg-integration-plan.md`, `docs/roleplay-architecture-2026.md`, and `docs/customizable-harness.md`; retain dated ledgers and v37 milestone history rather than rewriting it. Reconcile `docs/api.md`, `docs/operations.md`, `docs/repo-architecture.md`, `docs/README.md`, ROADMAP, devplan, and handoff where their normative roles require it.
- **Reconciled stale-claim evidence:** root README had said M4.2 was next and fallback/generation work remained; both historical design docs had labeled v37r1/M4.1 as current; harness docs had said the production tool loop remained M4.2. Those active claims are corrected, while historical v37 descriptions inside dated sections remain valid when labeled as such.
- **Authority/projection/security:** documentation must preserve loopback-only `local-owner`, provider-outside-transaction, role-safe projection, immutable receipts, and no remote-safe claims. Do not invent future operation totals or report hidden/private examples.
- **Migration/backfill:** documentation only.
- **Non-goals:** no production/test/package changes and no erasure of historical acceptance/gate records.
- **Acceptance completed:** targeted searches found no unlabeled active v37/M4-next claims; all 37 checked local Markdown links and anchors resolved; the current support window and post-M4 status agree; historical context remains intact.
- **Validation completed:** targeted stale-claim `rg`, 37 local Markdown link/anchor resolutions, and `git diff --check` passed. No code tests were run or required for this docs-only reconciliation.
- **Docs:** this is the docs slice; finish ROADMAP/devplan/handoff last.
- **Logical commits:** normative/entry docs, then historical headers/qualifiers, then planning lifecycle. For each docs-only commit, run targeted consistency/link checks plus `git diff --check`; do not run root typecheck unless the docs change generated/typechecked code or repository instructions explicitly require it. Commits: `77ed4b0 docs: reconcile current RPG guidance`; `2a50a41 docs: qualify historical RPG baselines`; `8a9a1c5 docs: mark H0.3 complete`; `8061da1 docs: finalize H0.3 handoff`.
- **Rollback/recovery:** revert only inaccurate paragraphs; never remove historical ledgers to resolve a search hit.

### H0.4 — Canonical health command and gate

**Status:** Complete; Wave H/H0 green.

- **Outcome:** one documented root command runs the release-health sequence in deterministic order and CI uses or exactly mirrors it.
- **Dependencies:** H0.1-H0.3 complete.
- **Scope:** add the single root command `npm run health`, representing exactly `npm run typecheck && npm run build && npm test && npm run test:e2e` in that order with fail-fast sequencing; document invocation with a unique temp directory such as `TMPDIR="$(mktemp -d /dev/shm/velvet-health.XXXXXX)" npm run health`. Migration-support tests are discovered within `npm test`; focused migration commands remain milestone gates and are not rerun separately in final health. Security suites are named and run by the milestones that own them, not appended as an unspecified H0 phase. CI must either call `npm run health` once or mirror these same four phases once each, in order.
- **Observed files:** root `package.json`, `.github/workflows/*` if present, `README.md`, `CONTRIBUTING.md`, `docs/operations.md`. **Likely/new:** a small cross-platform Node gate runner only if npm chaining cannot safely provide cleanup/port handling.
- **Command/transaction/projection requirements:** no runtime command change. E2E uses disposable storage/fake provider and fails on any child exit; no paid/live suite is included.
- **Security/privacy:** redact environment/secrets and never clone operator data. Security/privacy suites remain explicit milestone validations; final health relies on their normal discovery in `npm test` where applicable and adds no duplicate or unspecified security phase.
- **Migration/backfill:** no schema; the gate executes H0.1 supported-window tests.
- **Non-goals:** no dependency upgrade, flaky retry, ignored exit code, fixed shared temp path, live-provider call, or exact test-total assertion.
- **Acceptance:** `npm run health` stops at first failure, returns nonzero, and runs exactly root typecheck, build, `npm test`, and deterministic E2E once each in that order; CI calls it or exactly mirrors those four phases once. The final H0 gate passes before feature work starts.
- **Validation:** run the new command once with unique `/dev/shm` `TMPDIR`; also run `git diff --check`. Record outcomes without test totals.
- **Docs:** README commands, operations testing, contributing gate, ROADMAP/devplan/handoff.
- **Completion evidence:** the first canonical run timed out externally; the second exposed a global foreign-key preflight regression, which was corrected and scoped before the final wrapper run. The final recovery run used a unique `/dev/shm` `TMPDIR` and passed all four phases in order. Independent release/security review found no material issues and confirmed deterministic/live credential isolation.
- **Logical commits:** `3e6c1a6 fix(repo): scope migration integrity preflight`; `f18a081 chore: add canonical health gate`; `7286ded docs: document canonical health gate`; `f6cf177 docs: mark H0 health baseline complete`; `31bec78 docs: finalize H0 handoff`.
- **Rollback/recovery:** preserve the previous individual scripts; if the wrapper is faulty, remove only the wrapper and use the documented explicit sequence until corrected.

## Build-next feature milestones

### M5.1 — Session NPC presence

**Status:** Complete/Delivered. **Schema:** v43r1.

- **Delivered outcome:** persisted session-root presence records which campaign NPCs are `present` or `left` in a campaign session, with an optional campaign location. Unknown roster membership is not presence, and location is never inferred from actors or co-location.
- **Delivered scope/decisions:** the running projection returns only the live present cast; the stopped projection is structurally historical at-stop and every write rejects after stop. Owner/GM place, move, and remove commands use the session-root revision. Detach blocks only while a running attached session has live-present rows; stopped-session detach remains allowed and historical presence survives detachment. Two trusted-local routes provide role-safe reads and commands. Agent context and the client drawer consume persisted presence, and client mutations reconcile from authoritative reads.
- **Delivered files/services:** NPC-presence contracts; the v43 migration; `server/src/repo/world/` presence reads/writes and world orchestration; `npcPresenceRoutes.ts` and RPG route composition; campaign agent-context reads; client API, mutation registry, and campaign context drawer; deterministic fixture/E2E support; and focused contract/migration/repository/route/context/client tests.
- **Authority/transaction/projection:** one world command validates membership, running session attachment, NPC/location ancestry, session-root `expectedRevision`, and idempotency in an immediate repository transaction; authority, transition, state, event, and receipt commit together. Per-NPC revision is informational rather than a mutation precondition. Player location is drawn from the existing principal-visible location union and is never inferred from an actor or co-location. Player projection exposes public NPC identity/display fields and an authorized visible location label only—not goals, controller, principal, private location, command IDs, or hidden absence reasons. DDL enforces structural integrity only; authorization and lifecycle transitions do not live in triggers.
- **Security/migration:** additive v43 tables perform a deterministic backfill of **no presence rows** (unknown is not absent). Fresh and canonical populated v41/v42→v43 upgrades are supported; malformed FK, rollback, attestation, and parity coverage moved the tested window to v41/v42. No historical layout was edited.
- **Retained exclusions:** no companion, autonomous NPC speech/action, inferred co-location, pathfinding, schedule, remote identity, or multiple active encounters. HTTP remains fixed trusted-local `local-owner`.
- **Acceptance:** absent/unknown differs from present; optional location validates; session detach/stop policy is explicit; GM/player projections are structurally distinct; context and drawer say “present” only from persisted presence; retries do not duplicate transitions.
- **Validation completed:** focused contracts; server migration, support-window, NPC-presence repository, detach, route, agent-context, deterministic fixture, and general repository tests; focused client API, drawer, and registry tests; workspace and root typechecks; full deterministic E2E; and `git diff --check` all passed. The final focused nondisclosure regression and server typecheck passed. No totals are asserted here.
- **Commits:** `0b08f5a docs: freeze M5.1 integration contract`; `30cb781 feat(contracts): define session NPC presence`; `06859d4 feat(repo): add v43 NPC presence schema`; `04d7eba fix(contracts): make presence retries receipt-only`; `4cd41d3 feat(repo): add authoritative NPC presence`; `02eeec8 fix(contracts): preserve opaque presence sessions`; `49d6f02 feat(api): add session NPC presence routes`; `50c0403 feat(agent): use persisted NPC presence context`; `759a72c feat(client): manage session NPC presence`; `7094642 test(e2e): cover session NPC presence`; `3c4a2b6 fix(api): reject presence GET bodies`; `b07a355 docs: document session NPC presence`; `3b3772a docs: reconcile M5.1 architecture status`; `4479950 fix(repo): mask foreign presence sessions`. Docs/status commit remains pending.
- **Wave A progress:** M5.2 repository administration plus HTTP/client transport, M5.3 Slice 0 plus the separate consumable HTTP/client/UI flow, the M5.4 protocol checkpoint plus v46 persistence-only foundation, and the pure M5.5 protocol checkpoint are delivered. These are bounded slices, not full milestone completion.
- **Next work:** separately design and review the connection-scoped authoritative world travel candidate adapter, generator, and execution path. Linking execution receipts requires a later additive schema. Provider advertising, routes, client, and E2E remain later slices. M5.2 may still add a minimal companion management UI, and M5.5 persistence/command/client integration remains Planned. The protected catalog remains unchanged.
- **Rollback/recovery:** feature-gate reads/writes if necessary; additive rows can remain ignored by the previous feature layer. Restore a pre-migration DB for binary rollback—never downgrade the marker.

### M5.2 — Companion core and bounded controller grants

**Status:** In Progress/partial; repository and HTTP/client transport delivered, management UI and later companion lifecycle work remain. **Schema:** v45r1 delivered.

- **Outcome/dependencies:** the delivered boundary extends existing NPC identity and v43 session presence rather than replacing either model. Owner/GM can create a companion from a persisted present NPC in an attached running session and create or revoke bounded grants through an authoritative management GET and closed command POST. The client currently provides transport only.
- **Scope/decisions:** the sidecar links companion state to the existing campaign NPC and v43 presence records. Companion-owned proposal/decision records retain who or what proposed, the exact reviewed decision, confirmation state, and resulting receipt without transferring authority to a provider. Closed grants record grantee, allowed command families, actor/resource scope, maximum spend/use, start/expiry, revocation, and confirmation policy. Under the current trusted-local HTTP model, owner/GM may administer companion and grant state, but grants are never exercisable before L5 supplies an authenticated principal/grant boundary. Context and repository authorization derive authority from persisted relationships and the server-supplied principal; no impersonation field or header workaround is permitted.
- **Delivered repository scope:** v45 replaces v44 companion sidecars while preserving every row and moves historical actor references to durable principals. `companionRepo.ts` supplies immediate atomic revision/idempotency/receipt/audit behavior, owner/GM management projections, member public projections, and exact issuer replay after demotion or membership removal. Fresh authorization remains derived from current owner/GM relationships.
- **Likely next files/services:** an optional minimal companion management UI; later campaign context and `confirmationPolicy.ts` integration. Reuse NPC presence rather than inventing a second location model.
- **Authority/transaction/projection:** grant create/revoke and any locally exercisable companion administration are authoritative, revisioned command services. Grant authority is derived in the repository transaction from the server-supplied principal; public projections show companion public state and user-readable effective permissions/expiry, never controller principal, private policy inputs, opaque grant IDs unless needed for an authorized management path, or provider arguments.
- **Security/migration:** at the historical v45 delivery checkpoint, v45 replaced v44 sidecars and preserved all rows while durable principals decoupled retained history from membership lifecycle; canonical populated v43/v44->v45 was that checkpoint's support window. Current support is governed by the v46 status above. Revocation wins immediately; expiry uses server time; no self-grant, cross-campaign grant, caller principal, or grant exercise before L5.
- **Non-goals:** no delegated non-owner grantee exercise through trusted-local HTTP/client, caller-selected principal, impersonation/header workaround, autonomous speech/action, proactive scheduling, autonomous parties, unrestricted “act as user,” or permanent hidden grant. Delegated exercise, principal-specific UI/E2E, and autonomous companion actions belong to L5 or an explicitly approved later integration.
- **Acceptance:** bounded grant records can be reviewed, confirmed, expired, and revoked; repository tests prove authority derivation and stale/replayed commands cannot outlive grant state; local-owner owner/GM administration is explicit; context fails closed without repository authority; receipts identify action and human-readable authority scope. No acceptance claim implies pre-auth non-owner HTTP exercise.
- **Validation:** contract/repository/confirmation/context tests, allocated migration/support-window tests, and security projection tests; route/client tests cover only current local-owner administration. Owning workspace typechecks and deterministic E2E apply where this milestone actually crosses HTTP/client/persistence boundaries; principal-specific exercise tests wait for L5.
- **Docs/commits:** transport delivery is `409103e feat(api): add companion administration lane`; UI, dismissal, proposal/decision administration, grant exercise, context integration, and final status remain later slices.
- **Rollback/recovery:** disable companion commands while retaining additive history; revoke grants through an authoritative operation; restore backup for schema rollback.

### M5.3 — Atomic combat powers and items

**Status:** In Progress/partial; no-schema Slice 0 plus the separate consumable HTTP/client/UI flow delivered. The instant-modifier decision is closed by contract exclusion, but other milestone scope must still be completed before M5.3 can close. **Schema:** no M5.3 schema allocated.

- **Outcome/dependencies:** independently after H0.4, legal combat power/item actions settle all combat, resource, inventory, effect, concentration, log, turn, event, and receipt changes atomically. This work does not depend on companion delivery.
- **Delivered Slice 0:** while an encounter is active, encounter combatant HP is authoritative and actor health mirrors atomically through M15 in the same transaction. Health-mutating external commands fail closed. Round-based durations decrement only at round wrap, the only currently representable anchor. Concentration persists until explicit replacement or removal; there is no damage-break rule. Committed exact replay remains stable and post-RNG/pre-commit failure remains ambiguous without automatic retry.
- **Delivered consumable contract/runtime:** the shared contract freezes exact item, inventory entry, target, effect plan, canonical request digest, expected acting/target M15 revisions, and result evidence. Policy requires an exact pinned category-`consumable` item and quantity one. The repository runtime resolves effects in catalog order for damage, healing, and health/guard/focus resources. Commit `87d53ab` makes every consumable modifier duration explicitly ineligible: instant modifiers use `instant-modifier-semantics-unavailable`, while noninstant modifiers use `noninstant-modifier`. The lane has no modifier descriptor, settlement, legal action, or runtime execution, and no successful historical consumable modifier result exists. Shared catalog and power modifier contracts are unchanged; powers retain receipt-only instant-modifier outcomes without an active effect or state delta. Spell-slot effects, conditions, other unsupported effects, and nonconsumables are excluded.
- **Delivered transaction boundary:** one immediate transaction re-derives exact catalog/inventory/target/combat/M15/effect-plan legality and validates every generated identity before RNG. It consumes one unit and the acting turn's action, aggregates acting and distinct-target M15 revisions, keeps actor-backed and combat HP coherent, performs M16 duration advancement only on round wrap, advances turn/combat state, and writes logs, events, and one immutable receipt. Exact replay is immutable, and dedicated legal-action/result readers remain role-safe and separate from the unchanged live route unions.
- **Observed files:** `server/src/repo/encounter/`, `encounterRepo.ts`, `actorPowerCommandPlanner.ts`, `actorPowerUseRepo.ts`, `powerRepo.ts`, `inventoryRepo.ts`, `effectRepo.ts`, `campaignRepositoryOrchestration.ts`, `combatCommands.ts`, encounter/power/inventory contracts and focused tests. **Likely/new:** composition executor/plan types and atomicity tests.
- **Authority/transaction/projection:** provider/UI supplies only a current legal-action candidate and visible choices. Transaction re-derives legality and cost, acquires one immediate lock, validates all revisions/idempotency/ancestry, applies every stream once, and writes one composed receipt. No nested factory transaction and no provider call inside it.
- **Security/migration:** expose safe roll/cost/delta labels; hide enemy private stats, inventory details, tactics, internal IDs, principal, and raw command plan. Slices 0/1 use existing records and receipts and are no-schema only for the fixed subset above; expanding beyond it requires a fresh schema decision.
- **Non-goals:** no simultaneous encounters, full grids, boss phases, arbitrary effects, client-calculated damage, bilateral trade, autonomous combat, area actions, or agent actions. Condition effects, any non-instant or persistent effect, and Waylamp are excluded from the item subset.
- **Acceptance:** injected failure at every write boundary leaves all state/revisions/logs unchanged. A committed exact replay returns the stable prior result without rerolling or consuming state again. Failure after RNG but before commit is ambiguous and never authorizes automatic retry. Stale inventory or resource rejects before any write; reconnect reconciles one result. Repository tests cover exact server-derived execution, duplicate generated-ID cardinality, boundary rollback, stable replay, and reopen/result lookup. The delivered item slice accepts an exact pinned category-`consumable` item only when quantity is >= 1 and every effect has supported runtime semantics; the command consumes one unit and the acting turn's action by server policy rather than catalog `actionCost`.
- **Validation:** encounter/power/inventory/effect/composition tests plus server typecheck; root typecheck if contracts change; deterministic E2E because HTTP/persistence/combat cross boundaries; migration tests only if schema changes.
- **HTTP/client delivery:** separate action GET, command POST, and exact-result GET use fixed `local-owner` without widening the legacy combat union. The client displays only the exact server target, quantity one, and action cost, persists ambiguity before POST, performs no automatic retry, and reconciles exact result plus combat/log/actions across reload.
- **Validation/commits:** `77505fb feat(app): expose companion and consumable actions`; `bab31cc fix(repo): share consumable action authority`; `441defc test(e2e): cover companion and consumable flows`. The deterministic suite passed 15 cases, including companion create/grant/revoke/replay and one response-after-commit consumable POST/reload with a coherent custom immutable published pack. Fixture support is harness-only and catalog attestation is unchanged. Earlier Slice 0, contract, repository, and rollback commits remain part of the delivery.
- **Rollback/recovery:** retain old rejection behavior behind the action-family gate until each family is proven; never fall back to partial settlement. Reconcile unknown delivery from combat and receipt reads.

### M5.4 — Persisted exact candidate/quote protocol

**Status:** In Progress/partial; v46 persistence-only foundation delivered, while generation, execution, world adapter, and exposure remain Planned. **Schema:** v46r1.

- **Outcome/dependencies:** the pure contract work and v46 persistence-only foundation are complete. Generator, adapter, and execution work remain separately gated by their exact domain mechanics and lifecycle design. Every eventual agent mutation references an exact, reviewable server-generated candidate or quote instead of provider-authored command arguments.
- **Delivered checkpoint:** exact-candidate protocol v1 freezes the envelope, canonical frames/digests, provider-safe projection, exhaustive kind policy, lifecycle/decision/supersession/expiry/quote/receipt bindings, and fail-closed execution gates. Its first and only current v1 kind is `actor.travel`; adding a family requires an explicit protocol decision rather than silently widening v1.
- **Frozen persistence semantics:** `connectionId` is server-owned `adventure-turn:<turnId>` and stable for one turn across calls/restart; travel is exactly `[scope.actorId]`, confirmation and quote are not applicable, and more than 32 authoritative routes fails closed without truncation. Expiry is enforced from server time whether observed or not. Supersession is only an explicit source-to-replacement edge of the same kind/version/exact scope; absence is natural expiry/staleness, not cancellation. Candidate `receiptId` is the dedicated receipt-link identity and `binding.commandId` is the eventual world command.
- **Delivered files/services:** exact-candidate contracts; `candidateRepo/`; `db/migrations/v46_exact_candidates.ts`; repository composition/types; and migration support fixtures/tests. **Later files/services:** a connection-scoped world travel adapter/generator/executor, followed by any separately approved provider, route, client, and E2E integration.
- **Authority/transaction/projection:** candidate generation is an authoritative read/quote service; execution rechecks digest, actor/campaign/session, policy, grant, expiry, revision, and current legal state inside the domain command transaction. Every eventual command adapter must be connection-scoped so execution joins the owning domain transaction without nested factory transactions. Candidate creation/execution linking is idempotent. Public/provider projections omit private args, principals, opaque domain IDs not required for selection, hidden state, policy internals, and provider metadata.
- **Security/migration:** v46 delivers exactly five persistence categories: immutable batches, candidates, explicit supersessions, expiration observations, and canonical layout attestation, with empty backfill. Canonical action/envelope frames and digests plus every duplicated relational binding are reconstructed with platform SHA-256. Historical principals remain durable, but full-envelope issue/read/replay requires the exact scoped principal to retain current owner/GM/controller authority; unrelated members and observers are masked before integrity work. The normal application has no generator, so these tables remain empty outside direct repository use and tests. Decisions and receipt links are absent and require a later additive execution schema. Supported populated upgrades are v44/v45->v46; v43 is rejected before future-artifact cleanup.
- **Non-goals:** no arbitrary JSON tool arguments, SQL/fs/network tool, provider approval, policy editing, background execution, bilateral trade, or implicit command replay.
- **Acceptance:** tampered/unknown/stale/cross-scope candidate fails closed; review shows exact visible consequence and cost; confirmation resumes only the same candidate; exact retry converges; candidate projections are provider-safe by exact-key tests.
- **Validation:** final focused aggregates passed 38 contract tests and 83 server candidate/migration/support/repository tests; contract and server typechecks passed. No E2E was run because generation, execution, provider, HTTP, and client boundaries were not added.
- **Docs/commits:** protocol and persistence delivery commits are `e0ef5f8 feat(contracts): freeze travel candidate persistence`, `a690e3a feat(repo): add v46 exact candidates`, and `71393a9 feat(repo): persist exact travel candidates`. No decisions, receipt links, world generator/execution adapter, execution claim, provider advertising, HTTP/client, or E2E are included.
- **Rollback/recovery:** retain immutable persistence records while withholding later generation/execution integration; never reinterpret old candidate payloads under a new version.

### M5.5 — Commit-reveal verifiable dice

**Status:** exact no-schema protocol/vector checkpoint Complete; persistence and command/client integration Planned. **Schema:** none allocated.

- **Outcome/dependencies:** the exact protocol checkpoint is complete, but this track is not a blanket prerequisite for travel, rest, or non-random mechanics and does not imply persistence or product integration readiness.
- **Delivered checkpoint:** exact versioned binary framing/domain separation; platform SHA-256, HKDF, HMAC, and unbiased rejection sampling behind an injectable secure-byte port; commitment, entropy/nonce, reveal, transcript, expression/result, and command/candidate/roll bindings; lifecycle/timeout/abandonment rules; proof vectors; and a mandatory opaque capability transition from observed commitment to contributed input before verification authority. Withholding remains detectable, not preventable.
- **Likely files/services:** `packages/contracts/src/rpg-dice*.ts`, `server/src/repo/diceRepo.ts`, dice/check/power/combat command services and routes, additive migration, client receipt verifier, focused tests. Use reviewed platform cryptography; do not design a custom hash primitive.
- **Authority/transaction/projection:** server remains authoritative for legal expression/modifiers/outcomes. Store commitment before reveal; settle reveal/result/receipt atomically where possible, with explicit abandoned state after crash. Public proof exposes only protocol, commitments, public entropy/reveal needed to verify, expression/result, and digest—not server secrets, principal, private modifiers, RNG state, or hidden target data.
- **Security/migration:** no schema is allocated for contract/vector work. Eventual additive commitment/reveal/proof sidecars link to existing immutable rolls; historical rolls remain valid in explicit `legacy` state, never synthetic-backfilled proofs. The threat model concludes that withholding is detectable but not preventable and covers replay, nonce reuse, ordering, concurrent rolls, and malicious clients/providers. Platform crypto is mandatory; no custom primitive or biased modulo mapping.
- **Non-goals:** no blockchain, public randomness beacon, provider-generated entropy, retroactive proofs, or claim that commit-reveal makes every endpoint cryptographically fair.
- **Checkpoint acceptance delivered:** independent vectors reproduce framed digests/results; domain and cross-version confusion, commitment mismatch/reuse, malformed or cross-command proofs, invalid rejection paths, stale capabilities, and timeout-state violations reject; deterministic injected secure-byte fixtures cover bounded-dice rejection sampling. Withheld reveal remains detectable with explicit abandonment handling, not preventable.
- **Validation:** the no-schema checkpoint is represented by focused framing, crypto-input, lifecycle, capability, rejection, timeout, and proof-vector tests. Repository/command/route/client verifier, migration/support-window, workspace typecheck, and deterministic commit->reveal->verify plus restart/abandon E2E coverage wait for implementation of those boundaries.
- **Docs/commits:** checkpoint delivered as `3d834f4 feat(server): freeze verifiable dice protocol`; persistence, command integration, verifier/UI, and final status remain gated by their domain design.
- **Rollback/recovery:** disable new proof initiation, preserve sidecars, finish or explicitly abandon committed rolls according to versioned policy; never delete commitments or issue a second result for the same command.

### M5.6 — Agent mechanic families

**Status:** Planned. **Schema:** `vNext` allocated at milestone start only when the next family needs persistence not supplied by M5.4/M5.5.

- **Outcome/dependencies:** expand the agent using exact server candidates/quotes one independently gated family at a time. Candidate-backed travel/rest and out-of-combat power/inventory depend on M5.4 plus their already delivered authoritative commands; combat powers/items depend on M5.3 and M5.4 when agent-selected; companion actions depend on M5.2 plus the exercisable principal/grant model delivered by L5 or an explicit later integration; random mechanics depend on M5.5 only where proof policy requires. No unrelated family waits on dice or companions.
- **Preferred family rollout:** travel; prequoted rest; out-of-combat power use; inventory consume; inventory drop/gift; purchases/currency; combat powers/items and combat start after M5.3; quest/story/world/generated changes; companion actions only after exercisable grants. Families may be scheduled by exact readiness while preserving an independent merge gate. Bilateral trade remains deferred without explicit counterpart consent.
- **Scope/decisions:** each family adds candidate generation, provider-safe projection, policy/confirmation mapping, command adapter, receipt narration, context selection, limits, and feature gate. Purchases use unexpired server quotes; generated changes always remain staged/reviewed before apply.
- **Likely files/services:** `toolRegistry.ts`, `adventureOrchestrator.ts`, `confirmationPolicy.ts`, campaign context reads, existing world/rest/power/inventory/economy/encounter/quest/story/generation command services, candidate contracts/repository, route/client receipt surfaces, per-family tests.
- **Authority/transaction/projection:** provider selects exact candidates only and never supplies mechanics arguments. Each adapter invokes its authoritative domain command; no provider call is inside transaction. Projections include safe labels/cost/outcome only and omit hidden routes, inventory internals, private DCs, principals, opaque hidden IDs, private tool args, and provider traces.
- **Security/migration:** policy escalates limited resources, gift/drop, spending, combat start, and world/story/generated change to confirmation as configured. Use M5.4 sidecars; any new sidecar is additive and shifts support fixtures.
- **Non-goals:** no family reordering to chase demos; no arbitrary tool; no autonomous/proactive execution; no companion autonomy; no bilateral trade; no simultaneous encounter.
- **Acceptance:** every family has exact candidate tamper/stale/expiry/retry/confirmation/unknown-delivery tests and deterministic fallback narration; failure cannot consume state; disabled later families remain unavailable. A family does not merge until its gate passes.
- **Validation:** per-family contract/command/policy/orchestrator/route/client tests and owning typechecks; deterministic E2E for each family crossing streaming/HTTP/persistence; migration tests only when allocated. Stop the sequence on failure.
- **Docs/commits:** one logical commit chain per family—candidate/contract, adapter/policy, tests/UI, docs/status—using the global scope-based code versus docs-only validation policy. Update API, streaming, provider/privacy, feature docs, ROADMAP/devplan/handoff after every family.
- **Rollback/recovery:** disable only the failing family; preserve candidates/receipts and reconcile committed commands. Never route a disabled family through free-form provider text as an executable fallback.

## Build-later milestones

### L1 — Closed declarative rules IR

**Status:** Planned. **Dependencies:** stable M5.3/M5.6 mechanics. **Schema:** `vNext` at start if persisted.

- **Outcome/scope:** typed, versioned predicates and effects compiled only into existing authoritative command plans. Closed node discriminants; strict schema; deterministic evaluator with depth, node-count, collection, numeric, and wall/work limits.
- **Decision/security:** no JavaScript, SQL, filesystem, network, dynamic imports, formulas, eval, regex-like unbounded work, or open effect/predicate strings. Unknown node/version fails validation; provider may suggest a draft but cannot execute or publish it.
- **Likely files:** new contracts/evaluator/validator, content validation and publication integration, mechanics adapters, fixtures/tests; do not assume ownership in the protected catalog facade without a separate review.
- **Authority/migration/projection:** IR compiles to server commands; execution remains in command transactions. Persist canonical validated IR additively; old packs keep their version. Public explanation is bounded and omits hidden inputs.
- **Non-goals:** system-neutral arbitrary DSL, user code/plugins, broad formula language, hot patching pinned packs.
- **Acceptance/validation:** exhaustive node tests, fuzz/limit tests, deterministic compilation, no side effects on invalid IR, contract/content/mechanics/security tests, typechecks, E2E only when publication→play crosses boundaries.
- **Docs/commits/rollback:** spec+threat model; validator; evaluator; integrations; docs. Feature-gate by IR version; old typed mechanics remain usable. Update lifecycle docs/status and shift migration fixtures if allocated.

### L3 — Explicitly licensed offline reference ingestion

**Status:** Planned. **Dependencies:** U2 mutable pack authoring must first be promoted and delivered, plus legal/source-format approval. This milestone stays Build Later and is not promoted by that dependency statement. A separately reviewed immutable-draft-only ingestion path may replace the U2 dependency only through explicit approval.

- **Outcome/scope:** browser-selected or explicitly reviewed local files enter an import preview with source name, license, attribution, provenance digest, transformation report, conflicts, and validation; accepted rows become editable drafts only.
- **Likely files:** new client file picker/parser worker, contracts, server validation/staging, provenance UI/tests. No general network tool.
- **Authority/security:** strict size/depth/record/Unicode/archive limits; no filesystem paths accepted by server; no URL fetching, redirects, remote images, executable documents, credential access, or hidden file reads. License must be allowlisted/explicitly acknowledged.
- **Persistence/projection:** staging can be ephemeral or additive reviewed records; no auto publish/pin. Public publication provenance excludes local paths and user identity.
- **Non-goals:** scraping, URL import, general network access, copyrighted corpus bundling, auto-cleanup that changes meaning, provider publication, or silently using ingestion to promote/bypass mutable authoring.
- **Acceptance/validation:** malformed/archive bomb/license/conflict/provenance tests, preview-before-write, no writes on dry run, contract/server/client typechecks, E2E for browser-file→draft if shipped.
- **Docs/commits/rollback:** format/security spec; parser; preview; draft apply; docs. Delete/reject unapproved staging; immutable published corrections use the delivered U2 authoring path to create a new revision.

### L4 — Ephemeral branch-local simulation

**Status:** Planned. **Dependencies:** hardened deterministic M5.3 and relevant M5.6 mechanics; M5.5 only for simulated random mechanics whose proof policy requires verifiable dice.

- **Outcome/scope:** bounded in-memory simulation evaluates hypothetical branch-local mechanics with a short TTL and deterministic seed, returning clearly labeled previews.
- **Likely files:** new pure simulation service/contracts/client preview and tests; reuse pure calculators/planners without repository writes.
- **Authority/security:** no SQLite writes, receipts, promotion, provider calls, canonical effects, IDs usable as commands, or private facts beyond caller-authorized snapshot. Strict branch count, steps, memory, time, seed, and result-size limits.
- **Migration:** none expected.
- **Non-goals:** save/restore, promotion, background Monte Carlo, alternate canonical timeline, provider-driven search.
- **Acceptance/validation:** database byte/state unchanged; TTL eviction; deterministic result; cap failures; role-safe projection; service/contract/client tests and typechecks, E2E only for UI boundary.
- **Docs/commits/rollback:** pure engine; API/UI; docs. Disable endpoint and drop memory to roll back; nothing canonical requires repair.

### L5 — Campaign tenancy and remote authenticated sessions

**Status:** Planned. **Dependencies:** H0.4 and approved threat/deployment model. **Schema:** `vNext` at start.

- **Outcome/scope:** campaign-scoped tenancy and server-derived authenticated session principal metadata replace fixed identity on remote-capable routes. This milestone also supplies the exercisable principal/grant boundary needed for a distinct authorized companion grantee: delegated grantee exercise, principal-specific UI/E2E, and any later autonomous companion action integration occur here or in an explicitly approved dependent slice, never in trusted-local pre-auth. OIDC Authorization Code + PKCE with server-side sessions is a recommended implementation detail, subject to threat-model approval—not the board-authoritative product choice.
- **Authority decision:** campaign tenancy and server-derived session metadata are mandatory; no caller identity headers, impersonation parameters, or pre-auth grantee selection. Local-owner migration is an explicit loopback bootstrap that creates/claims a local account/tenant with review and recovery, never an implicit remote superuser. Companion exercise re-derives the authenticated principal's active persisted grant inside the authoritative command transaction.
- **Likely files:** new auth/session/tenant/grant contracts, additive migrations and repository, request principal context, route authorization adapters, CSRF/session/cookie middleware, admin UI, security/operations tests/docs.
- **Transaction/security:** authentication exchange outside SQLite transaction; short transaction persists hashed/opaque session linkage. Secure/HttpOnly/SameSite cookies, rotation/revocation, CSRF, origin/transport policy, rate limits, audit, tenant-rooted queries, and non-disclosing errors. Platform settings admin-only; legacy routes local-only or explicitly scoped before remote bind.
- **Projection:** never return access/refresh tokens, session secrets, raw provider claims, principals in ordinary campaign projections, tenant IDs, or auth sidecar internals.
- **Non-goals:** merely enabling `FEATURE_REMOTE_AUTHENTICATION`, trusting reverse-proxy headers, public bind before threat-model gate, social graph, proactive/autonomous agents.
- **Acceptance/validation:** tenant isolation and confused-deputy tests; session fixation/rotation/revocation/CSRF/origin/header/impersonation rejection; local bootstrap/recovery; delegated companion grant exercise/revocation tests when integrated; migration/support-window; route/client typechecks; principal-specific deterministic auth/grant E2E; external security review.
- **Docs/commits/rollback:** threat model; tenancy migration; sessions; route conversion; local bootstrap; deployment/admin docs. Keep remote bind disabled until all gates pass; revoke sessions and return to loopback-only mode for recovery.

### L6 — Harness defaults and bounded session overrides

**Status:** Planned. **Dependencies:** M5.4 policy metadata; L5 before multi-user semantics. **Schema:** `vNext` at start if persisted sidecars are needed.

- **Outcome/scope:** global/admin defaults remain the hard-capped baseline; authorized session overrides select only an allowlisted subset and are bounded by global minimum/maximum caps.
- **Likely files:** harness contracts/settings repo/routes/UI, prompt assembly, policy metadata, additive override audit if needed, tests/docs.
- **Authority/security:** server derives effective values and records source; platform settings admin-only, campaign/session controls role-scoped. No override raises tool/provider/time/token/mutation/privacy limits above global caps or changes identity/policy/safety secrets.
- **Projection:** show human-readable effective settings and override source, not principals, provider secrets, hidden prompt layers, or private policy internals.
- **Non-goals:** caller arbitrary model params, per-message cap bypass, prompt replacement, remote multiuser behavior before L5.
- **Acceptance/validation:** precedence/cap/stale/retry/audit tests, role-safe projections, contract/server/client typechecks, E2E for admin default→session override.
- **Docs/commits/rollback:** contracts; persistence; assembly; UI; docs. Clear/disable overrides to fall back to safe defaults; retain audit.

### L7 — Allowlisted tools and proactive policy grants

**Status:** Planned. **Dependencies:** M5.4/M5.6, L5, then L6. **Schema:** `vNext` at start.

- **Outcome/scope:** administrators define allowlisted external tool adapters and users grant narrow campaign/session/actor scopes for proactive jobs; every run produces visible initiation, decision, action, and delivery receipts.
- **Likely files:** tool adapter interface/registry, grant/policy/scheduler contracts and repository, additive grants/jobs/receipts migration, worker lifecycle, admin/grant UI, security/operations tests.
- **Authority/security:** external calls are outside SQLite transactions; results are untrusted input and cannot directly mutate state. Tools are allowlisted by adapter, host, method, data class, egress cap, timeout, and credential scope. Grants are opt-in, expiring, revocable, rate-limited, budgeted, and checked again before each candidate/command. Remote authenticated identity precedes this work.
- **Projection:** visible receipts show what policy/tool acted and safe outcomes; omit credentials, private tool arguments/results, provider metadata, principals, opaque grant/job IDs, and hidden campaign context.
- **Non-goals:** arbitrary URL/network tool, shell/fs, hidden background messages, self-grant, autonomous parties, Discord/VTT, consentless spending/trade/combat.
- **Acceptance/validation:** revoke/race/restart/rate/budget/egress/SSRF/credential isolation tests; no command on external failure; migration/security/typechecks; deterministic fake-adapter E2E.
- **Docs/commits/rollback:** threat model/adapter contract; grants; scheduler; one adapter; UI/receipts; docs. Disable scheduler/adapter, revoke grants, and reconcile any already committed command by receipt—never compensate blindly.

## Approved Build Unscheduled

Promotion from Unscheduled requires named product owner approval, a threat/invariant design, prerequisite health gates green, complete acceptance/test/rollback design, and no erosion of explicit exclusions. If persistence is approved, the schema steward allocates **`vNext` at promotion/start**; these milestones reserve no future migration number.

### U1 — Append-only multiclass progression

**Status:** Unscheduled.

- **Outcome:** support append-only multiclass progression with deterministic prerequisites and derived-state composition while preserving every prior level application.
- **Dependencies/promotion gate:** L1 closed rules IR, stable single-class progression, approved prerequisite and derived-stat conflict ordering, content compatibility evidence, green health, and named product-owner promotion.
- **Scope/decisions:** class levels append in application order with immutable class/version, source, prerequisite, and choice snapshots; corrections are compensating entries. Preview and apply share one authoritative calculator and define cross-class resource, proficiency, power, and spell ordering.
- **Likely files/services/owner (likely):** progression/content contracts and calculators, progression repository/commands, character sheet projections/UI, additive level ledger, and focused tests; likely owners are progression domain, contracts, migration, and character-sheet stewards.
- **Migration/backfill:** allocate `vNext` by the schema steward only at promotion if needed; additive ledgers with deterministic single-class compatibility backfill and then-current support-window/parity/rollback tests. Never rewrite old level rows.
- **Authority/privacy:** owner-controlled characters advance only through revision-checked idempotent commands; projections expose class/level choices and derived explanations but omit principals, hidden eligibility inputs, and private content unavailable to the viewer.
- **Non-goals:** free-form class scripts, retroactive prerequisite mutation, rewriting/removing prior levels, arbitrary respec, or provider-calculated derived state.
- **Acceptance:** deterministic preview equals apply; illegal ordering and stale/replayed choices fail without writes; cross-class resources/powers compose predictably; correction history remains visible and immutable.
- **Validation:** contract/calculator/repository/projection tests, focused migration/support-window tests if allocated, owning typechecks, and deterministic E2E for the delivered HTTP/client/persistence flow.
- **Docs:** update progression/API/repository architecture/operations and lifecycle status docs; explain ordering, corrections, compatibility, and rollback.
- **Logical commits:** threat/ordering contract; optional migration; calculator/repository; routes/UI; docs/status. Code commits use owning typechecks; docs-only commits use targeted consistency/link checks plus `git diff --check`.
- **Rollback:** disable new multiclass applications and retain append-only history; recover via compensating commands or a pre-migration backup, never deletion or marker downgrade.

### U2 — Mutable pack authoring over immutable revisions

**Status:** Unscheduled.

- **Outcome:** let an authorized author edit a logical unpinned pack head by publishing a new immutable revision on every advance; exact pins and all historical revisions remain byte-for-byte immutable and addressable.
- **Dependencies/promotion gate:** stable immutable catalog/publication behavior, approved authoring ownership and compatibility policy, protected-facade owner coordination, green health, and named product-owner promotion. L3 ingestion remains blocked until this milestone is promoted **and delivered**, unless a separately reviewed immutable-draft-only ingestion path is explicitly approved.
- **Scope/decisions:** separate mutable draft/head metadata from immutable published revisions; head advancement is reviewed, idempotent, race-safe, and receipt-backed. Unpinned consumers follow only under explicit policy; exact campaign pins never move automatically.
- **Likely files/services/owner (likely):** content contracts/validation, catalog repository modules (subject to protected-facade coordination), publication routes, content studio and campaign pin UI, additive head/revision/audit persistence, and focused tests; likely owners are content-domain, contracts, migration, API/client, and security stewards.
- **Migration/backfill:** allocate `vNext` by the schema steward only at promotion; additive logical-head, immutable-revision, and audit records with deterministic mapping of existing sealed packs, current support-window/parity/attestation/rollback tests, and no historical publication rewrite.
- **Authority/privacy:** author/admin authority is repository-derived; publish/advance validates revision, compatibility, review decision, and idempotency atomically. Public projections expose safe provenance/version only, never author principal, private drafts, review notes, local paths, or provider metadata.
- **Non-goals:** in-place mutation, mutable exact versions, history deletion, provider auto-publish, automatic campaign repin, or using ingestion to bypass review.
- **Acceptance:** stale/racing head advances converge or reject safely; exact pins and historical fetches remain unchanged; an advance creates exactly one immutable revision and receipt; compatibility failures write nothing.
- **Validation:** contract/content/repository/race/projection/security tests, allocated migration/support-window tests, owning typechecks, and deterministic E2E for author→review→advance→pin behavior.
- **Docs:** update content/API/repository architecture/operations/security and lifecycle status docs; explicitly document immutable history, unpinned-follow policy, and L3's blocking dependency.
- **Logical commits:** threat/contract; optional migration; authoring repository; head advance/routes; UI; docs/status. Code commits use owning typechecks; docs-only commits use targeted consistency/link checks plus `git diff --check`.
- **Rollback:** disable authoring/head advancement, retain immutable revisions, and pin a prior revision or publish a corrective new revision; never mutate history or downgrade a marker.

### U3 — Zones and range bands

**Status:** Unscheduled.

- **Outcome:** add typed zones, adjacency, occupancy, and range bands as the approved tactical precursor to a grid.
- **Dependencies/promotion gate:** M5.3 atomic combat, approved movement/targeting and world/encounter ownership semantics, accessibility design, green health, and named product-owner promotion.
- **Scope/decisions:** server-owned legal actions derive movement, reach, targeting, and area membership from revisioned zone state; world locations and encounter zones have explicit boundaries and conversion rules.
- **Likely files/services/owner (likely):** encounter/world contracts, repositories and command composition, routes, combat/world UI, additive zone/position state, and focused tests; likely owners are encounter/world domain, contracts, migration, and combat client stewards.
- **Migration/backfill:** allocate `vNext` by the schema steward only at promotion; additive optional zone/position records with deterministic “unpositioned” backfill and current support-window/parity/rollback tests. Existing encounters are never reinterpreted implicitly.
- **Authority/privacy:** movement/target commands are revision-checked and atomic; player projections expose only discovered/visible zones and legal range labels, not hidden occupancy, traps, enemy plans, principals, or internal topology.
- **Non-goals:** coordinates, full tactical grid, LOS physics, pathfinding engine, simultaneous encounters, or client-authoritative distance.
- **Acceptance:** deterministic movement/targeting and stale/retry behavior; inaccessible/hidden topology cannot leak; keyboard/screen-reader users receive an equivalent ordered representation; one-active-encounter remains enforced.
- **Validation:** contract/repository/combat/world/projection/accessibility tests, allocated migration/support-window tests, owning typechecks, and deterministic E2E for movement/targeting boundaries.
- **Docs:** update combat/world/API/repository architecture/accessibility/operations and lifecycle status docs.
- **Logical commits:** semantics/threat design; optional migration; domain commands; routes/UI/accessibility; docs/status. Code commits use owning typechecks; docs-only commits use targeted consistency/link checks plus `git diff --check`.
- **Rollback:** prevent creation of new zoned encounters and preserve existing explicit positions read-only until supported; never reinterpret or delete position history.

### U4 — Explicit boss phase state

**Status:** Unscheduled.

- **Outcome:** represent boss phases as explicit authoritative encounter state with deterministic transitions and legal-action recalculation.
- **Dependencies/promotion gate:** M5.3 atomic combat, stable encounter logs and effect ordering, approved phase visibility semantics, green health, and named product-owner promotion.
- **Scope/decisions:** persist phase index/version/state and transition predicates/effects; a composition-owned command commits transition, effects, combat log, event, and receipt together. Narration may describe but never infer or trigger a phase.
- **Likely files/services/owner (likely):** encounter/power/effect contracts, encounter repository and combat composition, routes, tracker UI, additive phase/event sidecars, and focused tests; likely owners are encounter domain, contracts, migration, and combat client stewards.
- **Migration/backfill:** allocate `vNext` by the schema steward only at promotion; additive phase sidecars with no inferred phase for existing encounters, plus current support-window/parity/rollback tests.
- **Authority/privacy:** server evaluates transitions from committed state inside the combat transaction; role-safe projections may hide unrevealed phase labels/triggers and must omit private stats, tactics, principals, and raw predicates.
- **Non-goals:** simultaneous encounters, prose-parsed phases, arbitrary scriptable phase code, provider-triggered transitions, or retroactive log rewriting.
- **Acceptance:** each transition occurs exactly once; injected failures leave phase/combat/effects/log unchanged; retry/restart converges; legal actions recalculate atomically; hidden future phases do not leak.
- **Validation:** contract/encounter/effect/composition/projection tests, allocated migration/support-window tests, owning typechecks, and deterministic E2E for visible transition/reconnect behavior.
- **Docs:** update combat/API/repository architecture/operations/security and lifecycle status docs with transition and visibility rules.
- **Logical commits:** phase/threat contract; optional migration; transition composition; routes/UI; docs/status. Code commits use owning typechecks; docs-only commits use targeted consistency/link checks plus `git diff --check`.
- **Rollback:** disable new phased templates/transitions while retaining phase history; reconcile committed receipts and use backup recovery for schema rollback, never delete phase events.

### U5 — Autonomous parties with revocable grants

**Status:** Unscheduled.

- **Outcome:** permit bounded unattended party activity only through visible, revocable, principal-bound grants and exact authoritative candidates/commands.
- **Dependencies/promotion gate:** M5.2 companion authority, M5.4 candidates, all required M5.6 families, L5 authenticated exercisable principals/grants, L7 jobs/tools/receipts, a separate unattended-play safety review, green health, and named product-owner promotion.
- **Scope/decisions:** every party, actor, tool, and action family has explicit time/budget/resource scope, confirmation threshold, scheduling window, pause/kill control, and immediate revocation. Autonomous companion actions are integrated only here or in another explicitly approved post-L5 slice.
- **Likely files/services/owner (likely):** party/grant/job contracts, persistence, scheduler, candidate/policy orchestration, admin/player UI, receipts, and adversarial tests; likely owners are agent/security, auth/grants, migration, API/client, and operations stewards.
- **Migration/backfill:** allocate `vNext` by the schema steward only at promotion; additive grants/jobs/checkpoints/receipt links with empty backfill and current support-window/parity/restart/rollback tests.
- **Authority/privacy:** authenticated principal and active grant are re-derived before every candidate and command; external/provider work stays outside transactions. Receipts are visible but omit principals, private tool arguments, hidden campaign facts, credentials, provider metadata, and opaque internal IDs.
- **Non-goals:** consentless bilateral trade, hidden activity, caller-selected identity, self-grant, irreversible self-expansion, Discord/VTT, simultaneous encounters, or bypassing confirmation/budget limits.
- **Acceptance:** revoke/pause wins before the next command; races, restart, expiry, spend, combat, privacy, and unknown delivery converge safely; every committed action has a deterministic visible receipt; no grant permits scope expansion.
- **Validation:** adversarial policy/grant/scheduler/restart/budget/command/projection/security tests, allocated migration/support-window tests, owning/root typechecks as applicable, and deterministic principal-specific end-to-end receipts.
- **Docs:** update threat model, API, auth/grants, agent policy, operations/runbooks, privacy, and lifecycle status docs before promotion completion.
- **Logical commits:** safety/threat contract; optional migration; grants/jobs; scheduler/policy; family integration; UI/receipts; docs/status. Code commits use owning typechecks; docs-only commits use targeted consistency/link checks plus `git diff --check`.
- **Rollback:** disable scheduling, pause jobs, and revoke grants; preserve immutable job/action receipts and reconcile committed commands only—never compensate blindly or delete history.

## Parallel ownership and dirty-worktree protocol

### Ownership matrix

| Lane | May own | Must not concurrently own |
| --- | --- | --- |
| Migration steward | `server/src/repo/db/schema.ts`, one allocated migration, support fixtures/tests, migration docs | Domain repository/route/client behavior |
| Contracts steward | `packages/contracts/src/*` and matching contract tests for one milestone | Migration/schema and route implementation |
| Domain steward | One focused repository/command composition and focused server tests | Shared contracts after freeze, migration wiring, shared docs |
| API/client steward | One route family, API adapter, one feature UI, focused route/client/E2E slice | Repository SQL and schema |
| Agent/security steward | agent registry/orchestrator/policy or auth/grants and security tests | Domain command internals and provider work inside transactions |
| Documentation steward | API/architecture/operations/security/feature docs after interfaces freeze | Production behavior or board state |
| Release steward | health command, CI equivalence, ROADMAP/devplan/handoff closeout | Feature implementation |

Single-owner shared files per active milestone are `packages/contracts/src/index.ts`, `server/src/repo/index.ts`, `campaignRepositoryOrchestration.ts`, `server/src/repo/db/schema.ts`, RPG route registration/composition, `client/src/api.ts`, `client/src/App.tsx`, root `package.json`, `docs/ROADMAP.md`, `devplan.md`, and `handoff.md`. Assign one integrator; other lanes provide patches or commits that the owner applies after review.

### Isolation protocol

1. Before work, record `git status --short`, current HEAD, assigned files, and pre-existing dirty/untracked paths. Never clean, reset, checkout over, stash, stage, or amend another lane's work.
2. Use a dedicated git worktree/branch per lane only when the current dirty changes are safely represented in that lane; otherwise work in place on disjoint files. Do not copy operator databases or `.velvet` board state between worktrees.
3. Shared-file changes wait for the single owner. Integrate narrow commits in dependency order; never resolve a conflict by choosing an entire side.
4. Use unique `VELVET_DATA_DIR`, ports, and `TMPDIR` under `/dev/shm` per lane. No process may share test SQLite or planning-board state.
5. Before handoff, list changed files, focused validation, unresolved findings, and dirty paths deliberately left untouched. Commit/push only when explicitly requested.

## Stop-on-failure and completion gates

For every milestone and family:

1. Freeze decisions, contracts, projections, transaction owner, limits, migration need, and rollback before implementation.
2. Run the smallest focused tests after each slice; stop on unexplained failure. Do not hide a failure with retries, skips, larger timeouts, weakened assertions, or removed privacy checks.
3. Follow smallest validation by commit scope. Code, test, or contract commits require the owning workspace typecheck; contract changes require building contracts before downstream tests; shared/cross-workspace commits require root typecheck. Docs-only commits require targeted consistency/link checks plus `git diff --check`, with no root typecheck unless docs change generated/typechecked code or repository instructions explicitly require it.
4. Migration changes require fresh plus populated `N-2`/`N-1`, parity, attestation, rollback, retry, future-artifact, and unchanged-marker tests before domain merge.
5. Browser/HTTP/streaming/persistence/migration changes trigger deterministic E2E. Live-provider E2E remains opt-in and outside the ordinary gate.
6. Complete API/architecture/operations/security/feature docs, then update ROADMAP status, devplan ledger, and handoff **after every milestone** (and each M5.6 family) before marking complete.
7. Use a unique `/dev/shm` directory, for example `TMPDIR="$(mktemp -d /dev/shm/velvet-gate.XXXXXX)"`; clean only the temp directory created by that invocation.

Final release gate is one exact nonduplicative command: `npm run health`, representing `npm run typecheck && npm run build && npm test && npm run test:e2e` in that order and fail-fast. Migration-support tests are discovered by `npm test`; focused migration commands remain milestone gates and are not repeated separately here. Security suites are named in and run for their owning milestones, not appended as an unspecified final phase. CI either calls `npm run health` once or exactly mirrors those four phases once each. After health, perform documentation consistency/link/current-status searches, `git diff --check`, and scoped diff/status review; these review checks do not duplicate health phases. Do not claim exact future operation or test totals. A gate is green only from results actually run at that revision.

## Full deferred and removed scope

- **Three product deferrals:** Discord for now; VTT adapters; simultaneous encounters.
- **Other later/excluded boundaries:** bilateral agent trade has no path without counterpart consent; full tactical grids/LOS remain excluded (zones/range bands are the approved precursor); autonomous companion speech/actions are outside companion core and require L5 plus an explicit later integration; autonomous parties wait for U5 promotion; broad public remote deployment waits for L5; stronger public randomness infrastructure is outside M5.5 commit-reveal.
- **Removed/rejected approaches:** caller-supplied principal headers; provider-authored mechanics arguments; provider/network/fs work in SQLite transactions; arbitrary SQL/JS/formula/open-string rules; URL fetching/general network reference ingestion; auto publish/pin; mutation of exact pinned or historical publications; simulation writes, receipts, promotion, provider calls, or canonical effects; implicit boss phases parsed from prose; invisible proactive work; irrevocable/unbounded grants; schema-number reservation for all future work; historical migration-layout edits.
- **Preserved invariants:** one active encounter per campaign session; immutable receipts/events/history; corrections by compensating commands or new immutable revisions; local-owner remains loopback-only until explicit migration; private/provider/security data stays structurally absent from unauthorized projections.
