# SRD 5.1 Ruleset Coverage

The `dnd-5e@1.0.0` development ruleset is a pure, swappable mechanics module adapted from the 2014 SRD 5.1. It is a deliberately incomplete implementation, not full D&D support or full SRD conformance. Callers inject every die face; functions return immutable resolutions or proposed state-change plans and never access a database, network, provider, clock, or global random source.

This work includes material taken from the System Reference Document 5.1 (SRD 5.1) by Wizards of the Coast LLC. The [official SRD source page](https://www.dndbeyond.com/srd) provides the exact [SRD 5.1 Creative Commons PDF](https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf). The SRD 5.1 is licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/legalcode). VelvetRP adapts and modifies the source material by selecting a limited rules subset and expressing it as deterministic software mechanics; Wizards of the Coast LLC has not endorsed these modifications.

The Training Dummy is an original Velvet deterministic integration fixture, not SRD material. Release attribution and modification details are in [`NOTICE.md`](../NOTICE.md).

The recommended development starter is the exact `srd-5.1:rules:starter-v1` profile and `srd-5.1:starter@1.1.0+2b1f05336aac` publication. It supports only the exact Human/Acolyte/Fighter path through level 2: level 1 maximum d10 hit points, the level 2 fixed hit-point increase (6 before Constitution modifier), proficiency bonus +2, and durable Second Wind and Action Surge metadata. Their effects are not executable. Martial Archetype is deliberately unsupported, so progression is capped at level 2. The prior `srd-5.1:starter@1.0.3+013693787a86` publication remains immutable. Existing `velvet:rules:starter-v1` and original Velvet starter campaigns remain bound to `velvet-starter-v1@1.0.0` through the behavior-preserving legacy adapter. A campaign binding is immutable after mechanics descendants exist. Resolution verifies the rules profile binding, compiled module version, and every exact publication; unknown or mixed identities fail closed.

New campaign setup presents this SRD starter as the recommended mechanical profile. Campaign generation receives the exact trusted `srd-5.1:rules:starter-v1` and `dnd-5e@1.0.0` identity plus only the campaign's pinned public catalog references. Generated encounters, quest items, and monster concepts may reference those exact definitions but cannot invent mechanics or create executable entities. Adventure planning and narration use the selected campaign descriptor rather than a global D&D default.

The descriptor's `capabilities` array is the machine-readable compatibility surface. Each capability is independently versioned. The module version changes when this combined surface changes; capability versions allow integrations to depend on narrower behavior.

## Machine-Readable Inventory

[`srd-5.1-coverage.v1.json`](srd-5.1-coverage.v1.json) is the authoritative versioned coverage inventory. It records major SRD rules and content domains using only `implemented`, `partial`, `unsupported`, or `not-applicable`; links section identifiers to the exact official PDF; and identifies capability, runtime, test, and API evidence without reproducing SRD rules text. The `complete` field is a bounded inventory claim, not a claim of complete D&D or SRD conformance.

## Coverage Matrix

| Area | Status | Capability | Implemented behavior | Deliberate limits |
| --- | --- | --- | --- | --- |
| Ability modifiers and proficiency | Supported | `checks@1.0.0` | Scores, level 1-20 proficiency, proficiency/half/expertise rounding | No class-specific substitutions |
| Ability, skill, and saving throws | Supported | `checks@1.0.0` | All 18 SRD skills, DC comparison, flat bonuses, typed results | Contests and group checks require caller orchestration |
| Advantage/disadvantage | Supported | `checks@1.0.0` | Two injected d20s, any opposing sources cancel, evidence records selection | Elven Accuracy and reroll features unsupported |
| Passive checks | Supported | `passive-checks@1.0.0` | Base 10, proficiency multiplier, +/-5 for advantage state | Situation-specific modifiers are caller supplied |
| Attacks and critical hits | Supported | `attacks@1.0.0` | Attack bonus vs AC, natural 1 miss, natural 20 or configured 2-20 threshold critical | Cover, reach, range, concealment, and weapon properties unsupported |
| Damage rolls | Supported | `damage@1.0.0` | Multi-term injected dice evidence, doubled critical dice, modifier once, minimum zero | Rerolls, minimum-die features, damage type interactions unsupported |
| Damage adjustments | Partial | `damage@1.0.0` | One explicit normal/resistance/vulnerability/immunity adjustment | Caller must determine applicability; multiple simultaneous types and temporary HP unsupported |
| Initiative | Supported | `initiative@1.0.0` | Injected rolls, modifiers, stable deterministic ordering | SRD player/GM tie choice represented by deterministic Dexterity then ID policy; surprise unsupported |
| Speed and movement | Partial | `movement@1.0.0` | Pure speed/movement plans; authoritative tactical grid paths and difficult terrain spend the persisted current-turn allowance | Dash and special movement plans are not executable tactical commands; jumping, squeezing, mounts, flight, falling, and opportunity attacks unsupported |
| Short and long rests | Partial | `rests@1.0.0` | Hit-die spending, HP caps, long-rest HP/hit-die recovery, one exhaustion reduction, active-combat rejection, and one durable server-time 24-hour long-rest interval | No authored in-game time, camp safety, sleep, food/water, interruption, or class-feature recovery |
| Concentration | Partial | `concentration@1.0.0` | Damage DC, Constitution save, replacement plan | Environmental DC selection and incapacitation/death triggers require caller plans |
| Conditions | Partial | `conditions@1.0.0` | Immutable add/remove plans for 14 SRD conditions | Mechanical effects and exhaustion levels are not automatically evaluated |
| Generic resources | Supported | `resources@1.0.0` | Atomic, aggregated resource affordability and resulting-pool plans | Recharge timing is caller-controlled |
| Spell costs | Partial | `spell-costs@1.0.0` | Cantrips, slot level/upcasting affordability, consumed-material availability | Components, preparation, known spells, ritual casting, casting time, targets, and spell effects unsupported |
| Character derived values | Partial | `derived-values@1.0.0` | Ability modifiers, proficiency, armor formula inputs, initiative, passive Perception, speed | Classes, races, multiclassing, encumbrance, HP, saves, and feature interactions unsupported |
| Development character creation | Partial | `derived-values@1.0.0` | Six SRD abilities; standard array, 27-point buy, and server 4d6-drop-lowest; reviewed Human, Acolyte, and Fighter level-one selections; level-one HP, baseline unarmored AC, initiative, speed, proficiency, skill/save semantics | Only the exact starter choices are available; alternate ancestry/background/class choices and optional rules are unsupported |
| Campaign actor checks | Partial | `checks@1.0.0` | Ability, save, and all semantic SRD skill IDs resolve from the authoritative sheet with campaign-owned RNG and named DCs | Opposed SRD checks and situational feature exceptions are unsupported |
| Repository basic attacks | Partial | `attacks@1.0.0` | Exact equipped one-handed Longsword profile supplies slashing damage dice; Strength and bounded starter Fighter proficiency versus live authoritative AC; critical dice, atomic HP, equipment-bound HTTP/agent action IDs, idempotent receipt and restart replay. Server-owned enemy turns execute one catalog-pinned basic attack for Goblin, Bandit, Wolf, or the original Training Dummy against the deterministic first legal actor target. | No unarmed fallback; alternate weapons, enemy traits/actions/riders, ranged/finesse properties, cover, reach, and opportunity attacks unsupported; no client enemy target choices; legacy typed attacks resolve current equipment at execution |
| Repository turn economy | Partial | Repository integration | Durable turn identity, action/bonus-action costs, explicit end-turn, legal-action filtering, replay and restart; atomic tactical movement spending and combat revision updates | Reaction availability is stored but triggers are unsupported; Dash and special movement commands unsupported |
| Equipment profiles | Partial | Catalog and repository integration | Typed weight and weapon/armor profiles; exact equipped Longsword one-handed attacks; live Leather Armor, Chain Shirt, Chain Mail and Shield AC shared by sheets and combat without rewriting baseline snapshots | Single hand slot disallows simultaneous sword/shield; versatile two-handed grip, armor speed penalties, stealth disadvantage, and encumbrance unsupported |
| Repository Fighter rests | Partial | `rests@1.0.0` | Durable level-one d10 pool and exhaustion resource; explicit short-rest die selection, server RNG, atomic capped healing; long-rest HP/dice/exhaustion recovery, 24-hour receipt limit, and replay | Duration, interruption, sleep, sustenance, camp safety, other classes, and automatic exhaustion effects are not enforced |
| Survival at zero HP | Partial | Repository integration | D&D actor 0 HP becomes unconscious; durable death saves, stable/dead states, server-rolled saves, damage failures, exact ally stabilization, healing recovery, replay and restart | Stabilization has no range/adjacency check; temporary HP, medicine checks, revivification, and broader condition effects are unsupported |
| Legal action envelope | Supported | `legal-action-plans@1.0.0` | Deterministic `legal`, `reasons`, and nullable `result` shape | Action economy and encounter legality need domain state from the caller |

## Unsupported SRD Areas

The module does not claim full SRD conformance. Unsupported areas include character advancement beyond level one, subclasses, additional races/backgrounds/classes, feats, general equipment catalogs, armor speed/stealth effects, encumbrance enforcement, complete action economy, grappling contests, cover, visibility, surprise, temporary hit points, exhaustion effects, mounted and underwater combat, complete SRD monster stat blocks, encounter building, treasure, downtime, travel, environmental hazards, spell casting/effects, and feature-specific exceptions. Goblin, Bandit, and Wolf expose one sourced, pinned basic attack each; their other traits, actions, and riders are not executable. The catalog's Light entry is attribution-visible coverage metadata only and is not executable. Generic SRD damage powers are withheld rather than allowed to bypass authoritative weapon attack checks. SRD progression commands fail closed and never use Velvet formulas.

## Integration Contract

Repositories resolve through the exact `(rulesetId, rulesetVersion)` registry key and `campaign_ruleset_bindings_v60`, verify profile/publication agreement, verify the required descriptor capability, and invoke the optional typed `module.mechanics` surface. The repository remains responsible for authorization, current-state lookup, RNG, idempotency, transaction boundaries, durable receipts, and applying a legal plan atomically. Modules without `mechanics` support only the retained legacy API.

1. Build inputs from authoritative state and caller intent.
2. Obtain random die faces outside the ruleset and pass them as `rolls` arrays.
3. Call a pure resolver or planner exported by `server/src/rulesets/index.ts`.
4. Reject plans where `legal` is false, exposing `reasons` as appropriate.
5. Persist the input/evidence, result or plan, ruleset ID/version, capability version, and resulting state in one repository transaction.

Do not infer mechanics from `supportedMechanics`; use the versioned `capabilities` manifest and the typed function API. The legacy `resolveCheck`, `abilityModifier`, and `proficiencyBonus` module methods remain available for existing repositories.
