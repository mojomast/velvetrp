# Handoff

## Current Baseline

- Commit `8955b10` is the pushed `main`/`origin/main` baseline. The tree contains the completed SRD 5.1 parity program (Waves 0-4) plus the follow-on runtime surfaces and API E2E coverage.
- Persistence: one current disposable development schema; additive late-schema tables install in place and exact-predecessor upgrades are narrowly recognized. Unknown or partially upgraded schemas reject without repair.
- HTTP: 154 counted explicit trusted-local RPG operations plus separately classified feature discovery; implicit HEAD aliases are excluded.
- Security: the server remains loopback-only with fixed `local-owner`. Feature flags and local ownership are not authentication or remote-safe authorization.
- Authorities: runtime code/contracts own behavior, `docs/api.md` owns HTTP documentation, `docs/operations.md` owns disposable-data/configuration guidance, `docs/repo-architecture.md` owns persistence structure, `docs/ROADMAP.md` owns milestone status, and `docs/srd-5.1-coverage.v1.json` + `docs/srd-5.1-coverage.md` own the bounded SRD parity claims.

## Delivered

### SRD 5.1 parity program (Waves 0-4)

- Wave 0: modularized `rulesets/dnd5e.ts`, `srdStarterCatalog.ts`, `encounterWriteRepo.ts`, `combatPowerRuntime.ts`, `combatActionPlan.ts`; per-domain coverage fragments merged by `scripts/coverage/merge-coverage.mjs`; `scripts/publish-srd-starter.ts`; composed capability registry.
- Wave 1: rules engines R1-R11 (effect vocabulary v2, conditions, monsters, adventuring, v2 execution, riders, magic items, reaction window, death/concentration, movement, progression).
- Wave 2: content breadth - all 12 classes L1-20 with one subclass each, the full 326-spell list, 241 monsters across every CR band, and 278 magic items.
- Wave 3: deterministic encounter builder, encounter rewards, and NPC selection.
- Wave 4: product surfaces and verification.

### Most recent session additions

- Magic-item attunement end to end: additive `actor_item_attunements_v65`, `server/src/repo/attunementRepo.ts`, `GET`/`POST /campaigns/:campaignId/actors/:actorId/attunements`, and the `MagicItemAttunementPanel` client surface.
- Monster multiattack: `planMonsterTurn` exposes the ordered attack sequence and the durable enemy turn resolves one ordered damage outcome per step, stopping early when the target drops. The action-resolution contract allows a bounded multi-outcome attack.
- Player readied actions: additive `combat_ready_actions_v66`, `server/src/repo/encounter/reaction/readyActionRuntime.ts`, a `ready` legal action and declaration, true hit-time firing (a readied Shield reports readiness `ready`), and expiry at the readying combatant's next turn.
- Vision/light/obscurement: pure `server/src/rulesets/dnd5e/vision.ts` (`vision-light@1.0.0`), with unseen-attacker/target flags folded into the shared attack-condition planner.
- Mounted and underwater combat: pure `server/src/rulesets/dnd5e/specialCombat.ts` (`mounted-combat@1.0.0`, `underwater-combat@1.0.0`).
- Encounter reward preview and NPC selection HTTP surfaces; `encounter-rewards@1.1.0` and `npc-selection@1.1.0` flipped to `supported`/`implemented`.
- Coverage merge-drift fix: the three Wave 3 domains had been added only to the aggregate, so the merge tool deleted them; fragments and `DOMAIN_ORDER` entries now exist and the merge is idempotent.
- `e2e/tests/srd-feature-flows.spec.ts`: deterministic API game-flow tests for the new features.
- Client surfaces: DM encounter-builder panel and character-sheet advancement-choices panel.
- Browser E2E coverage for the new client surfaces: `e2e/tests/client-feature-surfaces.spec.ts` drives the SRD magic-item attunement panel (attune, prerequisite rejection, drop), the DM encounter-builder panel, and the character-sheet advancement-choices panel against the deterministic server; a disposable `POST /api/__e2e/materialize-inventory-entry` fixture holds one exact pinned catalog item.
- Underwater combat runtime wiring and honest coverage flip: the durable player-attack, enemy-turn, and opportunity-attack paths derive immersion from the persisted combat map's water terrain (`server/src/repo/encounter/combatEnvironment.ts`), apply the pure `planDnd5eUnderwaterAttack` melee/ranged rules and `dnd5eUnderwaterDamageAdjustment` fire resistance, a new server-generated `underwater` map kind emits all-water layouts, the client map setup exposes the layout, and `underwater-combat@1.0.0` is its own `implemented` coverage domain.

## Coverage Status

`implemented`: d20-tests, passive-checks, attack-resolution, initiative, encounter-builder, encounter-rewards, npc-selection, underwater-combat. Every other domain remains `partial` on purpose because its bounded behavior is executable but the full SRD domain is not. Do not flip a domain to `implemented` unless its bounded behavior has runtime and test evidence and the descriptor capability is `supported`.

## Verification

- Focused: run the affected server test file and `npm run typecheck --workspace velvet-mvp-server`.
- Broad but fast: `npm run test:server:quick`.
- Wave-boundary checkpoint: `npm run test --workspace velvet-mvp-server` and `npm run test --workspace velvet-mvp-client`.
- Deterministic E2E: `npm run test:e2e` (starts the fake provider, deterministic server, and client dev server). Run one spec with `npx playwright test e2e/tests/srd-feature-flows.spec.ts`.
- E2E typecheck: `npm run typecheck:e2e`.

## Conventions and Gotchas

- Adding an HTTP operation requires updating the checked inventory in `docs/api.md` and the `${count} counted` claims in README.md, docs/api.md, docs/operations.md, docs/ROADMAP.md, devplan.md, and handoff.md; `server/test/documentation-drift.test.ts` enforces this.
- Adding a capability requires a matching coverage-inventory evidence entry; `server/test/srd-coverage-inventory.test.ts` enforces an exact match between advertised capabilities and inventory evidence.
- Add new persistence only through the additive late-schema path in `server/src/repo/db/schema.ts`; also add the new SQL file to the five migration-test schema lists.
- Extending an existing CHECK/constraint in `currentSchema.sql` requires updating every exact-predecessor reconstruction (`server/src/map/schemaUpgrade.ts`, `server/src/repo/db/campaignDmUpgrade.ts`, and the migration tests) that strips the v2/underwater algorithm list; since the development schema is disposable, a stale predecessor DB is recreated rather than repaired.
- The deterministic E2E server RNG (`e2e/support/deterministic-server.ts`) is intentionally narrow and throws on unexpected ranges; extend it explicitly when new dice ranges are consumed.
- E2E specs must use explicit `process.env.NAME` access, never dynamic `process.env[key]`, or the environment-classification drift guard fails.
- Content changes require republishing: `npm run build --workspace @velvet/contracts && node --import tsx scripts/publish-srd-starter.ts --write`, then rebuild contracts before running server tests.
- Full-suite flakes: `test/tactical-map-repo.test.ts` and `test/dnd5e-agent-combat-awareness.test.ts` occasionally failed under full parallel load. The root cause was the shared `TMPDIR`, not cross-test state: each server test file installs an ~10 MB starter catalog, a killed run left its data directory behind, and a nearly full temp filesystem then failed whichever file wrote next with `ENOSPC`/`SQLITE_FULL`. `server/test/helpers.ts` now names temp data directories with the owning PID and reaps directories whose owner is gone, so killed runs cannot accumulate. If a flake recurs, check free space in `TMPDIR` before treating it as a regression.

## Next Task

No in-flight work. Candidate follow-ups, in rough priority:

- Give the remaining `partial` domains runtime + API evidence where their bounded behavior is already complete, then flip them honestly (for example the `monster-turn-planner` save riders or the spell execution lanes).
- Surface vision/obscurement and mounted states through campaign persistence and the tactical map so the remaining pure rules have runtime callers. Underwater now has a durable caller; mounted still needs persisted mount/size state and vision needs persisted light/obscurement.

## Working Tree

`.hydration/` and `.opencode/skills/seed-test-campaign/` remain intentionally untracked and must not be staged. There is no uncommitted runtime work as of this handoff.
