# SRD 5.1 parity: gap map and parallel execution plan

Status: planning only. Based on source review of VelvetRP commit `8cdf577aae1cf5af7c8c09e4466bd4c71c32b27a`, `docs/srd-5.1-coverage.v1.json`, `server/src/content/srdStarterCatalog.ts`, and `server/src/rulesets/dnd5e.ts`. No mechanics or content were added for this plan. No database was opened or migrated. This is a proposed sequencing of missing work, not a claim that any missing item is scheduled.

This revision is written to be executed by **many parallel subagents**. The central thesis is that SRD 5.1 parity is mostly *content breadth* (hundreds of spells, monsters, items) plus a *small number of shared engines*. Content breadth is embarrassingly parallel **only if** the shared engines, contracts, and content files are first split into disjoint, single-owner modules. The plan therefore front-loads that split (Wave 0), freezes interfaces, and only then fans out.

SRD content counts below are approximate and marked with `~`; the authoritative source is always the [SRD 5.1 PDF](https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf) and the versioned inventory in `docs/srd-5.1-coverage.v1.json`.

## Product goal

Full SRD 5.1 parity means every SRD race, class, subclass, background, feat, spell, monster, and magic item is represented with executable, deterministic semantics (or explicitly bounded metadata), and every core rules subsystem (conditions, exhaustion, cover/vision, reactions, adventuring, encounter building) is enforced by the server. "Parity" here is a bounded, evidence-backed claim: each coverage domain flips to `implemented` in the inventory with runtime and test evidence.

The current module is deliberately a partial subset. Parity is reached by widening the shared effect/action vocabulary first, then filling content against that vocabulary, rather than by special-casing individual features.

## Legend

- **Rules gap**: a mechanics subsystem that is absent, partial, or simulated by a special case.
- **Content gap**: catalog entries missing from the exact starter publication.
- **Product gap**: a surface or tool the DM/players need to use the above.
- **Work unit**: one dispatachable subagent assignment with a single owner, a bounded deliverable, and a verification command.
- **Wave**: a set of work units that may run concurrently because their file ownership is disjoint.
- **Hot file**: a file many tracks would otherwise edit; it has exactly one owner per wave.
- Sizing is rough: `S` (days), `M` (1–2 weeks), `L` (multi-week), `XL` (multi-month).

## Baseline

Catalog: **108 definitions**.

| Kind | Count | Notes |
| --- | --- | --- |
| race | 7 | Human, Dwarf, Elf, Halfling, Dragonborn, Gnome, Half-Orc. Traits are metadata-only. |
| class | 7 | Fighter, Cleric, Barbarian, Rogue, Wizard, Paladin, Ranger. |
| class-level | 21 | Levels 1–3 for each of the 7 classes. |
| background | 1 | Acolyte (the SRD sample). |
| item | 26 | Mundane weapons/armor only. No tools, mounts, or magic items. |
| enemy-template | 4 | Goblin, Bandit, Wolf, and the non-SRD Training Dummy fixture. |
| spell | 12 | 6 executable, 6 metadata-only. |
| ability | 27 | A handful executable; most are metadata. |

Ruleset capabilities (`server/src/rulesets/dnd5e.ts`): `checks`, `passive-checks`, `attacks@1.5.0`, `damage@1.2.0`, `initiative`, `movement@1.4.0`, `rests@1.1.0`, `concentration`, `conditions@1.1.0`, `exhaustion`, `combat-markers`, `resources`, `spell-costs@1.2.0`, `derived-values`, `legal-action-plans`.

Executable today: weapon attacks (melee/ranged/thrown/unarmed), criticals, cover, line-of-effect, grapple/escape/shove, Dash, Disengage, Help, Hide, prone stand-up, opportunity attacks, Second Wind, Rage state, Lay on Hands, and six spells (Bless, Cure Wounds, Healing Word, Magic Missile, False Life, Shield).

## Rules gap map

| SRD 5.1 area | Modeled now | Missing for parity | Size |
| --- | --- | --- | --- |
| Ability scores, checks, saves | Ability/skill/save checks, passive checks, advantage/disadvantage, DCs | Group checks, opposed-check orchestration conventions, many feature/situational modifiers | M |
| Feats & ability score improvements | None | All SRD feats; ASI at levels 4/8/12/16/19 | L |
| Multiclassing | None | Multiclass prerequisites, proficiency grants, combined slot table | L |
| Attacks | Core attack vs AC, crits, ranged/thrown, unarmed, cover, line-of-effect | Two-weapon fighting, reach beyond 5 ft, Extra Attack, multiattack, grappled targets, non-lethal, attack riders | L |
| Reactions & interrupts | Opportunity attacks; Shield declared in the caster's own turn window | Readied action, true hit-time triggers, generalized reaction window, Counterspell-style interrupts | L |
| Conditions | 10 persisted; attack-roll effects automated | Persist deafened, invisible, paralyzed, petrified; automate frightened, poisoned checks, incapacitation, invisibility/vision, petrified saves, prone movement | L |
| Exhaustion | Speed and attack disadvantage enforced; one level removed on long rest | Ability-check/save disadvantage, HP-maximum halving, level-6 death | M |
| Death & dying | Unconscious at 0 HP, death saves, stable/dead, stabilization, healing recovery | Revivification, medicine checks, ranged stabilization rules, massive-damage instant death | M |
| Concentration | Damage-triggered Constitution save, replacement plan | Incapacitation/death triggers, caster-controlled ending, environmental DCs | M |
| Movement | Speed, difficult terrain, encumbrance, Dash, prone stand-up, Disengage | Jumping, climbing/swimming/squeezing, flying, falling, mounted combat, underwater combat, full reach geometry | L |
| Vision & light | None | Bright/dim/darkness, blindsight/darkvision/truesight, unseen attackers, concealment, surprise | L |
| Resting & downtime | Camp-gated short/long rests, hit dice, HP/exhaustion recovery | Food/water, sleep interruption, downtime activities, training, lifestyle expenses | M |
| Adventuring environment | None | Travel pace, weather, hazards (falling, suffocation, extreme heat/cold), disease/poison | M |
| Encounter building | None | Challenge rating, XP budgets, encounter difficulty, treasure/magic-item rewards | L |
| Spellcasting | Prep, components (bounded), level-1 slots, six effects, upcast-by-die | Cantrip scaling, ritual casting, material inventory, slots 2–9, prepared/known/spellbook management, casting-time variants, most spell effects | XL |
| Spell effects vocabulary | damage, healing, temp HP, resource, condition, modifier | Areas/targeting shapes, save-with-rider, ongoing damage, forced movement/teleport, summoning, illusions, dispel/counterspell, utility | XL |
| Monster mechanics | Basic attack, one knockdown rider, escape policy | Multiattack, recharge, legendary/lair actions, save-or-suck, monster spellcasting, traits, CR | XL |

## Content gap map

| Content | Modeled now | Missing for parity | Size | Parallel fan-out |
| --- | --- | --- | --- | --- |
| Races | 7/9 | Half-Elf, Tiefling; executable racial traits for all 9 | L | 1–2 agents |
| Classes | 7/12, levels 1–3 | Bard, Druid, Monk, Sorcerer, Warlock; levels 4–20 for all 12 | XL | 1 agent per class |
| Subclasses | 0/12 | One SRD subclass per class (e.g., Champion, Life Domain, Path of the Berserker, School of Evocation, Oath of Devotion, Hunter, Thief, College of Lore, Circle of the Land, Way of the Open Hand, Draconic Bloodline, The Fiend) | XL | 1 agent per subclass |
| Class features | Mostly metadata | Every class/level feature with executable semantics (Action Surge, Channel Divinity, Divine Smite, Wild Shape, Ki, Metamagic, Invocations, Bardic Inspiration, Sneak Attack, Extra Attack, …) | XL | 1 agent per class feature set |
| Backgrounds | Acolyte | Any additional SRD-listed background content; confirm the exact SRD background list before scoping | S/M | 1 agent |
| Spells | 12/~319 | ~307 spells across cantrips and levels 1–9, with effect semantics and class lists | XL | 1 agent per level band |
| Monsters | 3/~330 | ~327 stat blocks with actions, traits, and CR | XL | 1 agent per CR band |
| Magic items | 0/~200 | All magic items with attunement, charges, passive modifiers, and granted spells | XL | 1 agent per rarity/type band |
| Equipment | 26 mundane | Tools, mounts/vehicles, trade goods, ammunition variety, expenses/lifestyle | M | 1–2 agents |
| Treasure | None | Coin/gem/art/items tables, hoard generation | M | 1 agent |
| Feats | 0 | All SRD feats | L | 1 agent |

## Why this is not parallel today (and the fix)

Parallel subagents write to the **same working tree**, so two agents editing one file is a hard conflict, not a merge to resolve later. The repo rule is explicit: parallel writers must have non-overlapping file ownership. The current tree concentrates all SRD behavior in a handful of large files, and every content change touches the same central version and coverage files. That is the real blocker to acceleration, not the amount of SRD text.

| Blocker | Evidence | Enabling change |
| --- | --- | --- |
| One ruleset monolith holds every subsystem and all capability versions | `server/src/rulesets/dnd5e.ts` (408 lines) | Split into `server/src/rulesets/dnd5e/` submodules + a capability registry each track appends to through one owner |
| One 252-line catalog literal holds all content | `server/src/content/srdStarterCatalog.ts` | Split into per-domain (and per-class/per-level-band) content modules aggregated by a barrel |
| Action execution is one ~1000-line file | `server/src/repo/encounter/encounterWriteRepo.ts` (997 lines) | Split into `actionExecution/` per-action-kind executors |
| Power/effect runtime is one switch | `server/src/repo/encounter/combatPowerRuntime.ts` (235 lines) | Split effect handlers into `effectHandlers/` keyed by effect kind |
| Action planning is one builder | `server/src/repo/encounter/combatActionPlan.ts` (354 lines) | Split planners into `actionPlanners/` |
| Every track edits the same coverage JSON | `docs/srd-5.1-coverage.v1.json` | Per-domain fragment files merged by tooling; only the tool owns the aggregate |
| Every content change edits the same exact starter identity | `packages/contracts/src/srd-starter.ts`, client assertions | Single publish command; client/tests derive from the exported identity instead of literals |
| Every track may need contract changes | `packages/contracts/src/*.ts` + `dist/` build output | One contracts owner per wave; agents request changes instead of editing |
| Schema changes are global | `server/src/repo/db/currentSchema.sql`, `schema.ts`, `connection.ts` | One schema owner per wave; migrations serialized |

## Cross-cutting prerequisites

These gate all breadth. Adding content before they exist forces per-feature special cases and will not scale.

1. **Wave 0 modularization (parallelization enabler).** Split the ruleset, catalog, action executor, action planner, and effect runtime into disjoint single-owner modules with barrels. Without this, no two content tracks can run concurrently.
2. **Content publishing and republish tooling.** Today a content change recomputes the starter digest and requires editing the exported identity plus exact-version test assertions and regenerating the reviewed-adventure digest (a few references remain even though the identity literal is centralized). This must become a single deterministic command before bulk content lands.
3. **Coverage fragments + merge tooling.** Coverage must be assembled from per-domain fragments so parallel tracks never edit one JSON.
4. **Effect/action vocabulary v2 (interface freeze).** The closed `starterEffectSchema` cannot express areas, save-with-rider, ongoing effects, forced movement, summoning, illusions, or dispel. The contracts must be frozen and versioned before parallel content authoring; every consumer (`combatPowerRuntime`, `actorPowerUseRepo`, `adventurePowerRestRepo`, client receipt rendering, coverage) is updated once by named owners.
5. **On-hit rider pipeline.** Needed for Sneak Attack, Divine Smite, maneuvers, and monster riders. Composes with the frozen condition/effect vocabulary.
6. **Reaction/interrupt engine.** Generalize the Shield and opportunity-attack special cases into trigger windows keyed on events (hit, targeted, turn start, leaves reach), consuming one reaction per round.
7. **Monster action/trait engine.** Multiattack, recharge, legendary/lair actions, save-or-suck, and monster spellcasting, driven by pinned stat-block content.
8. **Magic item and attunement engine.**
9. **Progression engine.** ASI, feats, subclasses, multiclassing, and level 4–20 class/slot tables.
10. **Full condition engine.** Persist all 15 conditions and automate their non-attack effects, including vision and action/save denial.
11. **Encounter/CR builder.**

## Parallel execution model

### Unit of work

A **work unit** is one subagent task. It has one owner, a disjoint file set, a bounded deliverable, one verification command per the repo's focused-validation rule, and a stop condition. A work unit never edits a hot file owned by another unit; if it needs such a change, it returns a request instead.

### Ownership rules

1. **Disjoint writes.** Two concurrently running units never share a writable file. Read-only imports are unlimited.
2. **One owner per hot file per wave.** The hot files above are assigned to a single unit (usually the integrator or the tooling unit).
3. **Interface freeze.** Once a contract in `packages/contracts/` is frozen for a wave, it is read-only to every other unit. Contract changes are a separate serialized unit.
4. **Barrels and registries are not appended to concurrently.** Instead of every track appending to one registry, each track owns its own module and one integration unit updates the barrel/registry after merges.
5. **Schema is serialized.** At most one unit per wave touches `currentSchema.sql`/`schema.ts`/`connection.ts`; migration work is its own unit.
6. **Verification is layered.** Units run focused tests + the owning workspace typecheck. Contracts build output (`packages/contracts/dist/`) is written only by the contracts owner, so other units must not run the contracts build concurrently. The integration owner runs the broad suite at each checkpoint.

### Integration checkpoints

Parallel output is merged by the orchestrator at wave boundaries:

1. Each unit returns a final summary: deliverable, files, verification command and result, and any unresolved request.
2. The integration owner (single agent) applies barrel/registry updates, regenerates the coverage aggregate with the merge tool, republishes the starter, and runs the broad gates.
3. Only after the checkpoint is green does the next wave fan out. Hot-file owners are rotated at checkpoints.

## Workstream ownership map

Tracks below are the intended long-lived parallel lanes. `Hot` marks the single owner of a shared file; `RW` = writable by that track; `RO` = read-only.

| Track | Owns (RW) | Reads (RO) | Hot files it must not edit |
| --- | --- | --- | --- |
| **Contracts** | `packages/contracts/src/effects.ts`, `encounters.ts`, `powers.ts`, `combat-power-http.ts`, `encounters-http.ts`, related `*-http.ts`, `index.ts` | all server/client consumers | — (contracts track *is* the owner) |
| **Ruleset core** | `server/src/rulesets/dnd5e/*` split modules | contracts | `capabilities.ts` registry (integration owner) |
| **Attack/riders** | `server/src/repo/encounter/actionExecution/attack.ts`, `riders/*` | ruleset, conditions | `combatConditionRuntime.ts`, schema |
| **Reactions** | `server/src/repo/encounter/reaction/*`, `opportunityAttackRuntime.ts` | attack executor (RO) | attack executor (owned by Attack/riders) |
| **Conditions** | `server/src/repo/encounter/combatConditionRuntime.ts` (or split `conditions/*`) | ruleset | effect vocabulary (Contracts) |
| **Movement/env** | `server/src/repo/encounter/movement/*`, `server/src/map/*` move helpers | ruleset | action planner registry |
| **Death/concentration** | `server/src/repo/encounter/death/*`, `concentration/*` | conditions | attack executor |
| **Adventuring** | `server/src/repo/adventure/*` (new) | ruleset, catalog | schema |
| **Content: races/backgrounds/feats** | `server/src/content/srdStarter/races.ts`, `backgrounds.ts`, `feats.ts` | contracts, ruleset | `srdStarterCatalog.ts` barrel (integration owner) |
| **Content: classes** | `server/src/content/srdStarter/classes/<class>.ts` (one file per class) | progression engine, contracts | class registry barrel |
| **Content: spells** | `server/src/content/srdStarter/spells/level-<n>.ts` (one file per level band) | effect vocabulary | spell registry barrel |
| **Content: monsters** | `server/src/content/srdStarter/monsters/cr-<band>.ts` | monster engine | monster registry barrel |
| **Content: items/equipment/treasure** | `server/src/content/srdStarter/items/*`, `equipment/*`, `treasure/*` | item engine | item registry barrel |
| **Client surfaces** | `client/src/components/rpg/**` per-feature subfolder | contracts | shared `CommandCenter.tsx` (one owner) |
| **Schema** | `server/src/repo/db/currentSchema.sql`, `schema.ts`, `connection.ts` | all | serialized, one unit per wave |
| **Integration** | `server/src/rulesets/dnd5e/capabilities.ts`, `server/src/content/srdStarterCatalog.ts`, `docs/srd-5.1-coverage.v1.json`, barrels, `packages/contracts/src/srd-starter.ts` | all | — |

## Wave 0 — Parallelize the codebase

Outcome: the tree can support concurrent tracks. These units are mostly disjoint already (different directories), with the integration unit owning barrels.

| Unit | Deliverable | Owns | Depends on | Verify |
| --- | --- | --- | --- | --- |
| W0.1 | Split `rulesets/dnd5e.ts` into `rulesets/dnd5e/{d20,attack,damage,movement,rests,conditions,effects}.ts` + re-export barrel; behavior byte-for-byte unchanged | `server/src/rulesets/dnd5e.*` | — | `npm run test --workspace velvet-mvp-server -- test/srd-ruleset-integration.test.ts test/dnd5e-plans.test.ts` |
| W0.2 | Split `srdStarterCatalog.ts` into per-domain modules + `srdStarterCatalog.ts` barrel aggregator; digest unchanged | `server/src/content/srdStarter/*`, barrel | — | `npm run test --workspace velvet-mvp-server -- test/srd-equipment-catalog.test.ts test/reviewed-adventure-fixture.test.ts` |
| W0.3 | Split `encounterWriteRepo.ts` into `actionExecution/*` per action kind + barrel | `server/src/repo/encounter/actionExecution/*`, `encounterWriteRepo.ts` | — | `npm run test --workspace velvet-mvp-server -- test/dnd5e-combat.test.ts` |
| W0.4 | Split `combatPowerRuntime.ts` into `effectHandlers/*` keyed by effect kind + barrel | `server/src/repo/encounter/effectHandlers/*` | — | `npm run test --workspace velvet-mvp-server -- test/dnd5e-spell-attack.test.ts test/dnd5e-temporary-hit-points.test.ts` |
| W0.5 | Split `combatActionPlan.ts` into `actionPlanners/*` + barrel | `server/src/repo/encounter/actionPlanners/*` | — | `npm run test --workspace velvet-mvp-server -- test/dnd5e-plans.test.ts` |
| W0.6 | Publish/republish command: one deterministic entry point computes the catalog digest, updates `srd-starter.ts` identity, regenerates reviewed-adventure digest, and validates coverage | `scripts/publish-srd-starter.*`, tooling | W0.2 | `npm run test --workspace velvet-mvp-server -- test/srd-coverage-inventory.test.ts` |
| W0.7 | Coverage fragments: move domains into `docs/coverage/<domain>.json`, add merge tool that emits `srd-5.1-coverage.v1.json` | `docs/coverage/*`, merge tool | — | `npm run test --workspace velvet-mvp-server -- test/srd-coverage-inventory.test.ts` |
| W0.8 | Capability registry split: each subsystem exports its descriptor; `capabilities.ts` composes them | `server/src/rulesets/dnd5e/capabilities.ts`, subsystem descriptors | W0.1 | `npm run test --workspace velvet-mvp-server -- test/srd-coverage-inventory.test.ts` |

W0.1–W0.5 and W0.7 are mutually disjoint and can all run in one batch. W0.6 depends on W0.2; W0.8 on W0.1. The integration owner then updates barrels, merges fragments, and runs the full server suite.

## Wave 1 — Parallel rules engines

Outcome: contract vocabulary is frozen and the core engines exist. Units may run concurrently where their owned files are disjoint; the attack executor and the contracts are each single-owner.

| Unit | Deliverable | Owns | Depends on | Verify |
| --- | --- | --- | --- | --- |
| R1 Contracts freeze | Effect vocabulary v2 (area/targeting, save-with-conditional-effect, ongoing, forced movement, utility), versioned and frozen | `packages/contracts/src/effects.ts`, `encounters.ts`, `powers.ts`, `*-http.ts` | W0 | `npm run typecheck --workspace @velvet/contracts` + contracts tests |
| R2 Effect engine | Runtime handlers for R1 kinds, replacing the old switch | `effectHandlers/*`, `actorPowerUseRepo.ts`, `adventurePowerRestRepo.ts` | R1 | `npm run test --workspace velvet-mvp-server -- test/dnd5e-spell-attack.test.ts` |
| R3 On-hit riders | Declarative rider pipeline proven by Sneak Attack + Divine Smite | `actionExecution/attack.ts`, `riders/*` | R1 | `npm run test --workspace velvet-mvp-server -- test/dnd5e-combat.test.ts test/dnd5e-riders.test.ts` |
| R4 Reaction engine | Trigger windows, reaction budget, Ready action, true hit-time Shield | `reaction/*`, `opportunityAttackRuntime.ts` | R1, R3 (read) | `npm run test --workspace velvet-mvp-server -- test/dnd5e-reaction-shield.test.ts test/dnd5e-ready.test.ts` |
| R5 Condition engine v2 | Persist all 15 conditions; automate non-attack effects, vision, exhaustion completion | `combatConditionRuntime.ts`, `conditions/*` | R1 | `npm run test --workspace velvet-mvp-server -- test/dnd5e-attack-conditions.test.ts test/dnd5e-exhaustion.test.ts` |
| R6 Movement/env engine | Jumping, climbing/swimming/squeezing, flying, falling, reach geometry | `movement/*`, `server/src/map/*` | W0.5 | `npm run test --workspace velvet-mvp-server -- test/dnd5e-dash.test.ts` |
| R7 Death/concentration | Massive damage, medicine checks, revivify; incapacitation/death triggers, caster-ended concentration | `death/*`, `concentration/*` | R5 | `npm run test --workspace velvet-mvp-server -- test/combat-concentration.test.ts` |
| R8 Progression engine | ASI, feats, subclasses, multiclassing, levels 4–20 tables | `progression/*`, `characterBuilder/*` | W0.6, R1 | `npm run test --workspace velvet-mvp-server -- test/character-builder-*.test.ts` |
| R9 Monster engine | Multiattack, recharge, legendary/lair, save-or-suck, monster spellcasting | `monster/*` | R1 | `npm run test --workspace velvet-mvp-server -- test/dnd5e-combat.test.ts` |
| R10 Item engine | Attunement, charges, passive modifiers, granted spells | `item/*` | R1 | `npm run test --workspace velvet-mvp-server -- test/srd-equipment-runtime.test.ts` |
| R11 Adventuring | Travel pace, weather, hazards, suffocation, food/water, downtime, lifestyle | `server/src/repo/adventure/*` | W0 | `npm run test --workspace velvet-mvp-server -- test/dnd5e-adventuring.test.ts` |

Parallel groups: {R2, R3, R4 (after R3), R5, R6, R9, R10, R11} can fan out after R1 freezes; R7 follows R5; R8 follows W0.6. Attack executor (`R3`) is the one hot file in this wave and is owned by R3; R4 reads it only.

## Wave 2 — Parallel content breadth

Outcome: full SRD content written against the frozen vocabulary. This is the highest-fan-out wave: after W0.2 splits content by file, each file is a pure data module validated by a shared schema test, so **N agents can author N files concurrently**.

| Unit | Deliverable | Owns | Depends on |
| --- | --- | --- | --- |
| C1 | Half-Elf, Tiefling, executable racial traits for all 9 races | `srdStarter/races.ts` | R1–R5 |
| C2 | All 12 classes, levels 1–20, one SRD subclass each | `srdStarter/classes/<class>.ts` (12 files) | R8 |
| C3 | ~319 spells by level band, class lists, cantrip scaling, rituals | `srdStarter/spells/level-<n>.ts` (10 files) | R1, R2 |
| C4 | ~330 monsters by CR band | `srdStarter/monsters/cr-<band>.ts` | R9 |
| C5 | ~200 magic items + treasure hoards | `srdStarter/items/*`, `treasure/*` | R10 |
| C6 | Tools, mounts/vehicles, trade goods, expenses | `srdStarter/equipment/*` | R1 |
| C7 | All SRD feats | `srdStarter/feats.ts` | R8 |
| C8 | Additional SRD backgrounds after the list is confirmed | `srdStarter/backgrounds.ts` | R1 |

Fan-out within a unit: C2 can be split one class per agent (12 agents), C3 one level band per agent (`~10` agents), C4 one CR band per agent (`~6` agents), C5 by rarity/type. The integration owner updates the content barrel and republishes with W0.6 between batches.

## Wave 3 — DM tooling

Outcome: DMs build and reward encounters without hand-authoring mechanics.

- Encounter builder with CR/XP budgets (`encounterBuilder/*`) — needs R9, C4.
- Treasure and reward generation from pinned content (`treasure/*`) — needs C5.
- NPC creation and stat-block selection — needs C4, R8.
- Downtime/training workflows — needs R11.

These own separate new modules and can run in parallel; all read the frozen contracts.

## Wave 4 — Product surfaces and verification

- Character sheet: feats, subclass features, spell management, magic-item attunement.
- Combat: multiattack selection, readied actions, vision/light, mounted/underwater states.
- DM surfaces: encounter builder, monster detail, treasure.
- Deterministic E2E per domain; coverage inventory flipped to `implemented` with evidence.

Surfaces share a few client entry components, so at most one surface agent owns each shared component per wave; feature panels live in their own files.

## Critical path and parallel width

Serial spine: **W0 modularization + publish tooling + coverage fragments → R1 contracts freeze → R8 progression → C2 classes → C3 spells → C4 monsters → C5 items → Wave 3 → Wave 4.** Everything else hangs off that spine and fans out.

| Wave | Max useful parallel width | Serialization points |
| --- | --- | --- |
| 0 | ~7 | integration owner for barrels |
| 1 | ~8 | R1 contracts, R3 attack executor |
| 2 | ~35+ (per-file content) | content barrel + publish tool |
| 3 | ~4 | contracts read-only |
| 4 | per-feature | shared client entry components |

Acceleration is real only while every agent in a wave has an exclusive file. When in doubt, split the file first; do not "just coordinate" two writers on one file.

## Subagent task contract template

Every dispatch uses this prompt shape (the task prompt is the complete contract; the subagent has fresh context):

```text
Repo: /home/mojo/projects/velvet-mvp
Wave/unit: W0.1 — split rulesets/dnd5e.ts
Goal: <one sentence>
Deliverable: <exact files/behavior to produce>
Ownership: You may WRITE only: <paths>.
  You may READ: <paths>. Do NOT edit any other file, especially <hot files>.
  If you need a shared-file or contract change, STOP and return a
  "REQUEST:" note instead of editing it.
Constraints: Behavior-preserving unless stated. No new dependencies.
  No DB migration unless stated. Keep capability versions unchanged unless stated.
Acceptance: <observable criterion>
Verification (run exactly these, once):
  npm run typecheck --workspace <workspace>
  npm run test --workspace <workspace> -- <focused test files>
Final response must include: status; files changed; verification command + result;
  any REQUEST/blocker; remaining risk. Do not end on a tool call.
```

Parent rules (repo conventions): emit one `task` call per assignment, batch independent assignments in a single message, never launch-and-wait sequentially for independent work, do not poll running subagents, and if a task returns an empty result, resume the same `task_id` once for a concise summary rather than launching a replacement.

## Dispatch runbook

1. **Pick the wave.** Confirm every unit's writable files are disjoint. If two units need the same hot file, one of them waits or the file gets split first.
2. **Batch-dispatch.** Put one `task` call per unit in a single message. The batch count must equal the number of agents promised.
3. **Wait once.** Consume each final summary as it arrives; do not poll.
4. **Integrate.** The integration owner updates barrels/registries, merges coverage fragments, republishes, and runs the broad gates (`npm test`, plus E2E only if a browser/HTTP/streaming/persistence/migration boundary moved).
5. **Rotate and repeat.** Reassign hot-file ownership at the checkpoint, then fan out the next wave.

## Suggested first dispatch

Immediately runnable in one batch (disjoint, behavior-preserving): **W0.1, W0.2, W0.3, W0.4, W0.5, W0.7** — six agents. Then, after that checkpoint: **W0.6 + W0.8**, then R1 as a single serialized contracts unit. Only after R1 freeze does the wide Wave 1 fan-out begin.

## Inventory maintenance

- `docs/srd-5.1-coverage.md` currently contains stale limit lines that contradict implemented behavior (for example "No unarmed fallback", "Dash does not extend allowance", and "other classes" in the rest row). These should be corrected whenever their domain is touched.
- Every increment that changes an advertised capability must bump its capability version in `server/src/rulesets/dnd5e.ts` and update the coverage evidence; `server/test/srd-coverage-inventory.test.ts` enforces an exact match between advertised capabilities and inventory evidence.
- Content additions must republish the exact immutable starter; the version suffix is a content digest and callers fail closed on unknown identities.
- Keep coverage in per-domain fragments; only the merge tool writes the aggregate, so parallel units never conflict on it.

## Definition of done for parity

- Every SRD race, class, subclass, background, feat, spell, monster, and magic item is present with executable semantics or explicitly bounded metadata.
- All 15 conditions and exhaustion are persisted and enforced, including vision, surprise, cover, mounted, and underwater rules.
- Adventuring, downtime, encounter building, and treasure exist.
- `docs/srd-5.1-coverage.v1.json` reports every domain `implemented` with runtime and API evidence, and deterministic E2E plus the full server suite pass.

## Open questions

- Exact SRD background list to confirm before scoping that row.
- Exact SRD spell and monster counts to pin against the PDF table of contents rather than approximate.
- Whether parity includes optional rules (feats, multiclassing, encumbrance variant) as first-class or explicitly out of scope.
- Whether content modules should be code data literals (current style, parallel-safe) or generated from a machine-readable SRD extract; the latter would accelerate Wave 2 further but adds a generation/verification step.
