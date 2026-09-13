# SRD 5.1 parity: gap map and plan

Status: planning only. Based on source review of VelvetRP commit `1c2465a369b79c8dd8b00810f59c5f54e341eccf`, `docs/srd-5.1-coverage.v1.json`, `server/src/content/srdStarterCatalog.ts`, and `server/src/rulesets/dnd5e.ts`. No mechanics or content were added for this plan. No database was opened or migrated. This is a proposed sequencing of missing work, not a claim that any missing item is scheduled.

SRD content counts below are approximate and marked with `~`; the authoritative source is always the [SRD 5.1 PDF](https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf) and the versioned inventory in `docs/srd-5.1-coverage.v1.json`.

## Product goal

Full SRD 5.1 parity means every SRD race, class, subclass, background, feat, spell, monster, and magic item is represented with executable, deterministic semantics (or explicitly bounded metadata), and every core rules subsystem (conditions, exhaustion, cover/vision, reactions, adventuring, encounter building) is enforced by the server. "Parity" here is a bounded, evidence-backed claim: each coverage domain flips to `implemented` in the inventory with runtime and test evidence.

The current module is deliberately a partial subset. Parity is reached by widening the shared effect/action vocabulary first, then filling content against that vocabulary, rather than by special-casing individual features.

## Legend

- **Rules gap**: a mechanics subsystem that is absent, partial, or simulated by a special case.
- **Content gap**: catalog entries missing from the exact starter publication.
- **Product gap**: a surface or tool the DM/players need to use the above.
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

| Content | Modeled now | Missing for parity | Size |
| --- | --- | --- | --- |
| Races | 7/9 | Half-Elf, Tiefling; executable racial traits for all 9 | L |
| Classes | 7/12, levels 1–3 | Bard, Druid, Monk, Sorcerer, Warlock; levels 4–20 for all 12 | XL |
| Subclasses | 0/12 | One SRD subclass per class (e.g., Champion, Life Domain, Path of the Berserker, School of Evocation, Oath of Devotion, Hunter, Thief, College of Lore, Circle of the Land, Way of the Open Hand, Draconic Bloodline, The Fiend) | XL |
| Class features | Mostly metadata | Every class/level feature with executable semantics (Action Surge, Channel Divinity, Divine Smite, Wild Shape, Ki, Metamagic, Invocations, Bardic Inspiration, Sneak Attack, Extra Attack, …) | XL |
| Backgrounds | Acolyte | Any additional SRD-listed background content; confirm the exact SRD background list before scoping | S/M |
| Spells | 12/~319 | ~307 spells across cantrips and levels 1–9, with effect semantics and class lists | XL |
| Monsters | 3/~330 | ~327 stat blocks with actions, traits, and CR | XL |
| Magic items | 0/~200 | All magic items with attunement, charges, passive modifiers, and granted spells | XL |
| Equipment | 26 mundane | Tools, mounts/vehicles, trade goods, ammunition variety, expenses/lifestyle | M |
| Treasure | None | Coin/gem/art/items tables, hoard generation | M |
| Feats | 0 | All SRD feats | L |

## Cross-cutting prerequisites

These gate all breadth. Adding content before they exist forces per-feature special cases and will not scale.

1. **Content publishing and republish tooling.** Today every content change recomputes the starter digest and requires editing ~10 version references plus regenerating the reviewed-adventure digest. This must become a single deterministic command before bulk content lands.
2. **Effect/action vocabulary v2.** The closed `starterEffectSchema` cannot express areas, save-with-rider, ongoing effects, forced movement, summoning, illusions, or dispel. New variant types must be handled by every consumer (`combatPowerRuntime`, `actorPowerUseRepo`, `adventurePowerRestRepo`, client receipt rendering, coverage).
3. **On-hit rider pipeline.** Needed for Sneak Attack, Divine Smite, maneuvers, and monster riders. Should compose with the condition/effect vocabulary.
4. **Reaction/interrupt engine.** Generalize the Shield and opportunity-attack special cases into trigger windows keyed on events (hit, targeted, turn start, leaves reach), consuming one reaction per round.
5. **Monster action/trait engine.** Multiattack, recharge, legendary/lair actions, save-or-suck, and monster spellcasting, driven by pinned stat-block content.
6. **Magic item and attunement engine.**
7. **Progression engine.** ASI, feats, subclasses, multiclassing, and level 4–20 class/slot tables.
8. **Full condition engine.** Persist all 15 conditions and automate their non-attack effects, including vision and action/save denial.
9. **Encounter/CR builder.**

## Phased plan

### Phase 0 — Scale foundations

Outcome: every later content addition uses shared, tested vocabulary and tooling.

| Epic | Deliverable | Depends on | Size |
| --- | --- | --- | --- |
| Publish tooling | One command publishes a catalog, bumps the exact version, updates all references, regenerates the reviewed-adventure digest, and validates coverage | — | M |
| Effect vocabulary v2 | Area/targeting shapes, save-with-conditional-effect, ongoing effects, forced movement, utility effect kinds, with contracts + runtime + client rendering + coverage | — | L |
| On-hit rider pipeline | Declarative riders resolved inside attack resolution, with receipts | Effect vocabulary v2 | M |
| Reaction/interrupt engine | Trigger windows, reaction budget, Ready action, hit-time Shield | — | L |
| Monster action engine | Stat-block actions, multiattack, recharge, legendary/lair | Effect vocabulary v2 | L |
| Magic item engine | Attunement, charges, passive modifiers, granted spells | Effect vocabulary v2 | L |
| Progression engine | ASI, feats, subclasses, multiclassing, levels 4–20 | Publish tooling | L |
| Condition engine v2 | All 15 conditions persisted; automated effects; vision; exhaustion completion | — | L |

### Phase 1 — Core rules completeness

Outcome: `attacks`, `movement`, `conditions`, `exhaustion`, `concentration`, and `rests` move to `implemented`.

- Conditions: persist and automate deafened, invisible, paralyzed, petrified; finish frightened/poisoned; complete exhaustion.
- Combat: two-weapon fighting, reach, Extra Attack/multiattack, Ready action, surprise, concealment/invisibility, mounted and underwater, instant death/revivify.
- Movement: jumping, climbing/swimming/squeezing, flying, falling.
- Adventuring: travel pace, weather, hazards, suffocation, food/water, downtime and training, lifestyle expenses.

### Phase 2 — Content breadth

Outcome: full SRD content against the Phase 0 vocabulary. Sequence chosen to feed encounters early.

1. Races: add Half-Elf and Tiefling; make all 9 racial traits executable.
2. Classes and subclasses: all 12 classes, one SRD subclass each, levels 1–20, features executable.
3. Spells: ~319 spells by level and school, class lists, cantrip scaling, rituals.
4. Monsters: ~330 stat blocks by CR with actions/traits.
5. Magic items and treasure: ~200 items plus hoards.
6. Equipment breadth: tools, mounts/vehicles, trade goods, expenses.
7. Feats.

### Phase 3 — DM tooling

Outcome: DMs build and reward encounters without hand-authoring mechanics.

- Encounter builder with CR/XP budgets.
- Treasure and reward generation from pinned content.
- NPC creation and stat-block selection.
- Downtime/training workflows.

### Phase 4 — Product surfaces and verification

- Character sheet: feats, subclass features, spell management (prepared/known/spellbook), magic-item attunement.
- Combat: multiattack selection, readied actions, vision/light, mounted/underwater states.
- DM surfaces: encounter builder, monster detail, treasure.
- Deterministic E2E per domain; coverage inventory flipped to `implemented` with evidence.

## Critical path

Publish tooling + effect vocabulary v2 + reaction engine + condition engine → progression/classes → spells → monsters → items → DM tooling → surfaces. Content phases are parallelizable once Phase 0 vocabulary lands; they compete for the same coverage inventory and client rendering contracts, so they should land in reviewable slices.

## Suggested first five increments

1. Publish/republish tooling (removes manual digest and reference churn).
2. Effect vocabulary v2 with saving-throw-with-conditional-effect and area targeting.
3. Full condition engine (persist 15, automate non-attack effects, finish exhaustion).
4. On-hit rider pipeline, proven with Sneak Attack and Divine Smite.
5. Reaction window engine, proven with Readied action and true hit-time Shield.

## Inventory maintenance

- `docs/srd-5.1-coverage.md` currently contains stale limit lines that contradict implemented behavior (for example "No unarmed fallback", "Dash does not extend allowance", and "other classes" in the rest row). These should be corrected whenever their domain is touched.
- Every increment that changes an advertised capability must bump its capability version in `server/src/rulesets/dnd5e.ts` and update `docs/srd-5.1-coverage.v1.json`; `server/test/srd-coverage-inventory.test.ts` enforces the match.
- Content additions must republish the exact immutable starter; the version suffix is a content digest and callers fail closed on unknown identities.

## Definition of done for parity

- Every SRD race, class, subclass, background, feat, spell, monster, and magic item is present with executable semantics or explicitly bounded metadata.
- All 15 conditions and exhaustion are persisted and enforced, including vision, surprise, cover, mounted, and underwater rules.
- Adventuring, downtime, encounter building, and treasure exist.
- `docs/srd-5.1-coverage.v1.json` reports every domain `implemented` with runtime and API evidence, and deterministic E2E plus the full server suite pass.

## Open questions

- Exact SRD background list to confirm before scoping that row.
- Exact SRD spell and monster counts to pin against the PDF table of contents rather than approximate.
- Whether parity includes optional rules (feats, multiclassing, encumbrance variant) as first-class or explicitly out of scope.
