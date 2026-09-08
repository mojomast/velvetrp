import {
  SRD_5_1_STARTER_IDENTITY,
  publishContentCatalogInputSchema,
  type PublishContentCatalogInput,
} from "@velvet/contracts";
import { calculateCatalogDigest } from "../repo/contentCatalog/index.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

let catalogVersion: string = SRD_5_1_STARTER_IDENTITY.packVersion;
const ref = (kind: string, definitionId: string) => ({
  packId: SRD_5_1_STARTER_IDENTITY.packId,
  packVersion: catalogVersion,
  kind,
  definitionId,
});

function literal(digest: string): PublishContentCatalogInput {
  const currency = ref("currency", "srd-5.1:currency:gp");
  const insight = ref("skill", "insight");
  const religion = ref("skill", "religion");
  const sword = ref("item", "srd-5.1:item:longsword");
  const pack = ref("item", "srd-5.1:item:explorers-pack");
  const acolyteEquipment = ref("item", "srd-5.1:item:acolyte-equipment");
  const attack = ref("ability", "srd-5.1:ability:longsword-attack");
  const goblinAttack = ref("ability", "srd-5.1:ability:goblin-scimitar");
  const goblinNimbleEscape = ref("ability", "srd-5.1:ability:goblin-nimble-escape");
  const banditAttack = ref("ability", "srd-5.1:ability:bandit-scimitar");
  const wolfAttack = ref("ability", "srd-5.1:ability:wolf-bite");
  const wolfPackTactics = ref("ability", "srd-5.1:ability:wolf-pack-tactics");
  const wolfKnockdown = ref("ability", "srd-5.1:ability:wolf-knockdown");
  const light = ref("spell", "srd-5.1:spell:light");
  const bless = ref("spell", "srd-5.1:spell:bless");
  const cureWounds = ref("spell", "srd-5.1:spell:cure-wounds");
  const magicMissile = ref("spell", "srd-5.1:spell:magic-missile");
  const shield = ref("spell", "srd-5.1:spell:shield");
  const healingWord = ref("spell", "srd-5.1:spell:healing-word");
  const guidingBolt = ref("spell", "srd-5.1:spell:guiding-bolt");
  const mageHand = ref("spell", "srd-5.1:spell:mage-hand");
  const sacredFlame = ref("spell", "srd-5.1:spell:sacred-flame");
  const cleric = ref("class", "srd-5.1:class:cleric");
  const clericOne = ref("class-level", "srd-5.1:class-level:cleric-1");
  const barbarian = ref("class", "srd-5.1:class:barbarian");
  const barbarianOne = ref("class-level", "srd-5.1:class-level:barbarian-1");
  const rage = ref("ability", "srd-5.1:ability:barbarian-rage");
  const rogue = ref("class", "srd-5.1:class:rogue");
  const rogueOne = ref("class-level", "srd-5.1:class-level:rogue-1");
  const sneakAttack = ref("ability", "srd-5.1:ability:rogue-sneak-attack");
  const wizard = ref("class", "srd-5.1:class:wizard");
  const wizardOne = ref("class-level", "srd-5.1:class-level:wizard-1");
  const wizardSpellbook = ref("ability", "srd-5.1:ability:wizard-spellbook");
  const rayOfFrost = ref("spell", "srd-5.1:spell:ray-of-frost");
  const wizardCantrip = ref("spell", "srd-5.1:spell:fire-bolt");
  const paladin = ref("class", "srd-5.1:class:paladin");
  const paladinOne = ref("class-level", "srd-5.1:class-level:paladin-1");
  const divineSense = ref("ability", "srd-5.1:ability:paladin-divine-sense");
  const layOnHands = ref("ability", "srd-5.1:ability:paladin-lay-on-hands");
  const ranger = ref("class", "srd-5.1:class:ranger");
  const rangerOne = ref("class-level", "srd-5.1:class-level:ranger-1");
  const favoredEnemy = ref("ability", "srd-5.1:ability:ranger-favored-enemy");
  const naturalExplorer = ref("ability", "srd-5.1:ability:ranger-natural-explorer");
  const klass = ref("class", "srd-5.1:class:fighter");
  const level = ref("class-level", "srd-5.1:class-level:fighter-1");
  const levelTwo = ref("class-level", "srd-5.1:class-level:fighter-2");
  const levelThree = ref("class-level", "srd-5.1:class-level:fighter-3-unsupported");
  const secondWind = ref("ability", "srd-5.1:ability:fighter-second-wind");
  const actionSurge = ref("ability", "srd-5.1:ability:fighter-action-surge");
  const dwarfResilience = ref("ability", "srd-5.1:ability:dwarf-resilience");
  const dwarfStonecunning = ref("ability", "srd-5.1:ability:dwarf-stonecunning");
  const elfDarkvision = ref("ability", "srd-5.1:ability:elf-darkvision");
  const elfKeenSenses = ref("ability", "srd-5.1:ability:elf-keen-senses");
  const halflingLucky = ref("ability", "srd-5.1:ability:halfling-lucky");
  const halflingBrave = ref("ability", "srd-5.1:ability:halfling-brave");
  const dragonbornAncestry = ref("ability", "srd-5.1:ability:dragonborn-ancestry");
  const dragonbornBreath = ref("ability", "srd-5.1:ability:dragonborn-breath-weapon");
  const gnomeCunning = ref("ability", "srd-5.1:ability:gnome-cunning");
  const halfOrcEndurance = ref("ability", "srd-5.1:ability:half-orc-relentless-endurance");
  const halfOrcSavage = ref("ability", "srd-5.1:ability:half-orc-savage-attacks");
  const classLevelMetadata = (classRef: ReturnType<typeof ref>, levelRef: ReturnType<typeof ref>, className: string, level: number) => ({
    reference: levelRef,
    name: `${className} Level ${level}`,
    description: `SRD ${className} level ${level} progression metadata; subclass and execution-dependent features remain unsupported.`,
    tags: ["srd-5.1", "unsupported-runtime", `${className.toLowerCase()}-${level}`],
    mechanics: { classRef, level, proficiencyBonus: level < 5 ? 2 : 3, hpGain: level === 2 ? 6 : 6, abilityRefs: [], spellRefs: [] },
  });
  const levelRefs = {
    barbarianTwo: ref("class-level", "srd-5.1:class-level:barbarian-2"), barbarianThree: ref("class-level", "srd-5.1:class-level:barbarian-3"),
    rogueTwo: ref("class-level", "srd-5.1:class-level:rogue-2"), rogueThree: ref("class-level", "srd-5.1:class-level:rogue-3"),
    wizardTwo: ref("class-level", "srd-5.1:class-level:wizard-2"), wizardThree: ref("class-level", "srd-5.1:class-level:wizard-3"),
    paladinTwo: ref("class-level", "srd-5.1:class-level:paladin-2"), paladinThree: ref("class-level", "srd-5.1:class-level:paladin-3"),
    rangerTwo: ref("class-level", "srd-5.1:class-level:ranger-2"), rangerThree: ref("class-level", "srd-5.1:class-level:ranger-3"),
    clericTwo: ref("class-level", "srd-5.1:class-level:cleric-2"), clericThree: ref("class-level", "srd-5.1:class-level:cleric-3"),
  };
  const weapon = (id: string, name: string, description: string, price: number, weightPounds: number, proficiency: "simple" | "martial", attackType: "melee" | "ranged", damageType: "bludgeoning" | "piercing" | "slashing", sides: 4 | 6 | 8 | 10 | 12, properties: unknown[]) => ({
    reference: ref("item", `srd-5.1:item:${id}`), name, description, tags: ["srd-5.1", "equipment"],
    mechanics: { category: "weapon", stackable: false, slot: "hand", price: { currency, amount: price }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds, equipmentProfile: { kind: "weapon", proficiency, attackType, damage: { type: damageType, die: { count: 1, sides } }, properties } } },
  });
  const armor = (id: string, name: string, description: string, price: number, weightPounds: number, category: "light" | "medium" | "heavy", baseArmorClass: number, dexterity: unknown, strengthRequirement: number | null, stealthDisadvantage: boolean) => ({
    reference: ref("item", `srd-5.1:item:${id}`), name, description, tags: ["srd-5.1", "equipment"],
    mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: price }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds, equipmentProfile: { kind: "armor", category, baseArmorClass, dexterity, strengthRequirement, stealthDisadvantage, shieldBonus: 0 } } },
  });
  return publishContentCatalogInputSchema.parse({
      idempotencyKey: "srd-5.1-starter-publication-v5",
    manifest: {
      packId: SRD_5_1_STARTER_IDENTITY.packId,
      packVersion: catalogVersion,
      name: "SRD 5.1 Development Starter",
        description: "A reviewed, deliberately narrow SRD 5.1 starter with closed level-one profiles for Fighter, Cleric, Barbarian, Rogue, Wizard, Paladin, and Ranger.",
      tags: ["srd-5.1", "cc-by-4.0", "development-starter"],
      rulesProfile: {
        name: "SRD 5.1 Development Rules",
        description: "Exact dnd-5e@1.0.0 profile with bounded level-one class profiles and a two-level Fighter progression lane.",
        tags: ["srd-5.1", "cc-by-4.0"],
      },
      compatibility: { rulesEngine: "dnd-5e", rulesEngineVersion: "1.0.0", rulesProfileId: SRD_5_1_STARTER_IDENTITY.rulesProfileId, catalogFormat: "validated-v1" },
      digest,
      provenance: {
        authorship: "licensed",
        author: "Wizards of the Coast LLC; integration selection by Velvet project",
        authoredAt: "2016-05-04T00:00:00.000Z",
        reviewedBy: "Velvet SRD integration review",
        reviewedAt: "2026-09-04T00:00:00.000Z",
        declaration: "Narrow, modified selection from the CC BY 4.0 SRD 5.1. Source, license, and modification details are in NOTICE.md.",
        thirdPartyData: true,
      },
    },
    definitions: [
      { reference: ref("race", "srd-5.1:race:human"), name: "Human", description: "A level-one development ancestry with a +1 increase to each ability score.", tags: ["srd-5.1"], mechanics: { size: "Medium", speed: 30, attributeBonuses: { strength: 1, dexterity: 1, constitution: 1, intelligence: 1, wisdom: 1, charisma: 1 }, abilityRefs: [], languages: ["Common", "one language of choice"], proficiencies: [], damageResistances: [], senses: [] } },
      { reference: ref("race", "srd-5.1:race:dwarf"), name: "Dwarf", description: "A sturdy SRD ancestry with Constitution training and resilient stonecraft traditions.", tags: ["srd-5.1", "metadata-only"], mechanics: { size: "Medium", speed: 25, attributeBonuses: { constitution: 2 }, abilityRefs: [dwarfResilience, dwarfStonecunning], languages: ["Common", "Dwarvish"], proficiencies: ["battleaxe", "handaxe", "light hammer", "warhammer"], damageResistances: ["poison"], senses: [{ kind: "darkvision", rangeFeet: 60 }] } },
      { reference: ref("race", "srd-5.1:race:elf"), name: "Elf", description: "An SRD ancestry with Dexterity training, keen senses, and fey heritage.", tags: ["srd-5.1", "metadata-only"], mechanics: { size: "Medium", speed: 30, attributeBonuses: { dexterity: 2 }, abilityRefs: [elfDarkvision, elfKeenSenses], languages: ["Common", "Elvish"], proficiencies: ["Perception"], damageResistances: [], senses: [{ kind: "darkvision", rangeFeet: 60 }] } },
      { reference: ref("race", "srd-5.1:race:halfling"), name: "Halfling", description: "A nimble SRD ancestry known for luck and courage.", tags: ["srd-5.1", "metadata-only"], mechanics: { size: "Small", speed: 25, attributeBonuses: { dexterity: 2 }, abilityRefs: [halflingLucky, halflingBrave], languages: ["Common", "Halfling"], proficiencies: [], damageResistances: [], senses: [] } },
      { reference: ref("race", "srd-5.1:race:dragonborn"), name: "Dragonborn", description: "A draconic SRD ancestry with Strength, Charisma, ancestry, and breath-weapon metadata.", tags: ["srd-5.1", "metadata-only"], mechanics: { size: "Medium", speed: 30, attributeBonuses: { strength: 2, charisma: 1 }, abilityRefs: [dragonbornAncestry, dragonbornBreath], languages: ["Common", "Draconic"], proficiencies: [], damageResistances: [], senses: [] } },
      { reference: ref("race", "srd-5.1:race:gnome"), name: "Gnome", description: "A small SRD ancestry with Intelligence training and innate cunning.", tags: ["srd-5.1", "metadata-only"], mechanics: { size: "Small", speed: 25, attributeBonuses: { intelligence: 2 }, abilityRefs: [gnomeCunning], languages: ["Common", "Gnomish"], proficiencies: [], damageResistances: [], senses: [{ kind: "darkvision", rangeFeet: 60 }] } },
      { reference: ref("race", "srd-5.1:race:half-orc"), name: "Half-Orc", description: "An SRD ancestry with Strength, Constitution, endurance, and savage-attack metadata.", tags: ["srd-5.1", "metadata-only"], mechanics: { size: "Medium", speed: 30, attributeBonuses: { strength: 2, constitution: 1 }, abilityRefs: [halfOrcEndurance, halfOrcSavage], languages: ["Common", "Orc"], proficiencies: ["Intimidation"], damageResistances: [], senses: [{ kind: "darkvision", rangeFeet: 60 }] } },
      { reference: ref("background", "srd-5.1:background:acolyte"), name: "Acolyte", description: "An SRD background with Insight, Religion, and a bounded starter-equipment package.", tags: ["srd-5.1"], mechanics: { skillRefs: [insight, religion], itemRefs: [acolyteEquipment], startingCurrency: { currency, amount: 15 } } },
      { reference: klass, name: "Fighter", description: "Bounded SRD Fighter progression supports levels 1-2 only. Level 3 Martial Archetype is deliberately not executable.", tags: ["srd-5.1", "fighter-1-2"], mechanics: { hitDie: 10, primaryAttribute: "strength", savingAttributes: ["strength", "constitution"], levelRefs: [level, levelTwo, levelThree] } },
       { reference: cleric, name: "Cleric", description: "Bounded SRD Cleric progression includes levels 1-3 as metadata; spell execution and domain choices remain unsupported.", tags: ["srd-5.1", "cleric-1-3", "prepared-spells"], mechanics: { hitDie: 8, primaryAttribute: "wisdom", savingAttributes: ["wisdom", "charisma"], levelRefs: [clericOne, levelRefs.clericTwo, levelRefs.clericThree] } },
       { reference: barbarian, name: "Barbarian", description: "Bounded SRD Barbarian progression includes levels 1-3 as metadata; rage and primal-path execution remain unsupported.", tags: ["srd-5.1", "barbarian-1-3", "unsupported-runtime"], mechanics: { hitDie: 12, primaryAttribute: "strength", savingAttributes: ["strength", "constitution"], levelRefs: [barbarianOne, levelRefs.barbarianTwo, levelRefs.barbarianThree] } },
       { reference: rogue, name: "Rogue", description: "Bounded SRD Rogue progression includes levels 1-3 as metadata; expertise and archetype execution remain unsupported.", tags: ["srd-5.1", "rogue-1-3", "unsupported-runtime"], mechanics: { hitDie: 8, primaryAttribute: "dexterity", savingAttributes: ["dexterity", "intelligence"], levelRefs: [rogueOne, levelRefs.rogueTwo, levelRefs.rogueThree] } },
       { reference: wizard, name: "Wizard", description: "Bounded SRD Wizard progression includes levels 1-3 as metadata; spell execution and Arcane Tradition remain unsupported.", tags: ["srd-5.1", "wizard-1-3", "unsupported-runtime"], mechanics: { hitDie: 6, primaryAttribute: "intelligence", savingAttributes: ["intelligence", "wisdom"], levelRefs: [wizardOne, levelRefs.wizardTwo, levelRefs.wizardThree] } },
       { reference: paladin, name: "Paladin", description: "Bounded SRD Paladin progression includes levels 1-3 as metadata; oath and smite execution remain unsupported.", tags: ["srd-5.1", "paladin-1-3", "unsupported-runtime"], mechanics: { hitDie: 10, primaryAttribute: "charisma", savingAttributes: ["wisdom", "charisma"], levelRefs: [paladinOne, levelRefs.paladinTwo, levelRefs.paladinThree] } },
       { reference: ranger, name: "Ranger", description: "Bounded SRD Ranger progression includes levels 1-3 as metadata; favored terrain and archetype execution remain unsupported.", tags: ["srd-5.1", "ranger-1-3", "unsupported-runtime"], mechanics: { hitDie: 10, primaryAttribute: "dexterity", savingAttributes: ["strength", "dexterity"], levelRefs: [rangerOne, levelRefs.rangerTwo, levelRefs.rangerThree] } },
      { reference: level, name: "Fighter Level 1", description: "Level-one hit points use the Fighter d10 maximum and proficiency bonus +2. Second Wind is tracked as a short-rest power; its healing effect is not executable.", tags: ["srd-5.1", "fighter-1-2"], mechanics: { classRef: klass, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [attack, secondWind], spellRefs: [] } },
      { reference: levelTwo, name: "Fighter Level 2", description: "Level-two advancement uses the SRD fixed hit-point increase of 6 before Constitution modifier and grants Action Surge tracking. Proficiency remains +2.", tags: ["srd-5.1", "fighter-1-2"], mechanics: { classRef: klass, level: 2, proficiencyBonus: 2, hpGain: 6, abilityRefs: [actionSurge], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
      { reference: levelThree, name: "Fighter Level 3", description: "Martial Archetype is an SRD level-three Fighter feature, but no SRD archetype is implemented in this pack. The canonical progression profile caps advancement at level 2.", tags: ["srd-5.1", "unsupported-runtime", "martial-archetype-gate"], mechanics: { classRef: klass, level: 3, proficiencyBonus: 2, hpGain: 6, abilityRefs: [], spellRefs: [] } },
       { reference: clericOne, name: "Cleric Level 1", description: "Level-one Cleric hit points use the d8 maximum. Bless, Cure Wounds, and Healing Word are exact prepared-spell selections; the supported healing spells enforce their target and range contracts.", tags: ["srd-5.1", "cleric-1", "prepared-spells"], mechanics: { classRef: cleric, level: 1, proficiencyBonus: 2, hpGain: 8, abilityRefs: [], spellRefs: [], preparedSpellRefs: [bless, cureWounds, healingWord] } },
      { reference: barbarianOne, name: "Barbarian Level 1", description: "Level-one Barbarian uses the d12 maximum and tracks two Rage uses per long rest as bounded capacity metadata.", tags: ["srd-5.1", "barbarian-1", "unsupported-runtime"], mechanics: { classRef: barbarian, level: 1, proficiencyBonus: 2, hpGain: 12, abilityRefs: [rage], spellRefs: [], resourceGrants: [{ resourceId: "rage", maxIncrease: 2, currentIncrease: 2 }] } },
      { reference: rogueOne, name: "Rogue Level 1", description: "Level-one Rogue uses the d8 maximum and grants Sneak Attack metadata; its conditional damage is not executable here.", tags: ["srd-5.1", "rogue-1", "unsupported-runtime"], mechanics: { classRef: rogue, level: 1, proficiencyBonus: 2, hpGain: 8, abilityRefs: [sneakAttack], spellRefs: [] } },
       { reference: wizardOne, name: "Wizard Level 1", description: "Level-one Wizard uses the d6 maximum, grants a closed spellbook feature, two first-level spell slots, two exact cantrips, and Magic Missile preparation metadata.", tags: ["srd-5.1", "wizard-1", "unsupported-runtime"], mechanics: { classRef: wizard, level: 1, proficiencyBonus: 2, hpGain: 6, abilityRefs: [wizardSpellbook], spellRefs: [wizardCantrip, rayOfFrost], preparedSpellRefs: [magicMissile], resourceGrants: [{ resourceId: "spell-slot-1", maxIncrease: 2, currentIncrease: 2 }] } },
      { reference: paladinOne, name: "Paladin Level 1", description: "Level-one Paladin uses the d10 maximum and tracks five points of Lay on Hands capacity; the healing resolution is not executable here.", tags: ["srd-5.1", "paladin-1", "unsupported-runtime"], mechanics: { classRef: paladin, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [divineSense, layOnHands], spellRefs: [], resourceGrants: [{ resourceId: "lay-on-hands", maxIncrease: 5, currentIncrease: 5 }] } },
       { reference: rangerOne, name: "Ranger Level 1", description: "Level-one Ranger uses the d10 maximum and grants the closed Favored Enemy and Natural Explorer feature metadata.", tags: ["srd-5.1", "ranger-1", "unsupported-runtime"], mechanics: { classRef: ranger, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [favoredEnemy, naturalExplorer], spellRefs: [] } },
       classLevelMetadata(cleric, levelRefs.clericTwo, "Cleric", 2),
       classLevelMetadata(cleric, levelRefs.clericThree, "Cleric", 3),
       classLevelMetadata(barbarian, levelRefs.barbarianTwo, "Barbarian", 2),
       classLevelMetadata(barbarian, levelRefs.barbarianThree, "Barbarian", 3),
       classLevelMetadata(rogue, levelRefs.rogueTwo, "Rogue", 2),
       classLevelMetadata(rogue, levelRefs.rogueThree, "Rogue", 3),
       classLevelMetadata(wizard, levelRefs.wizardTwo, "Wizard", 2),
       classLevelMetadata(wizard, levelRefs.wizardThree, "Wizard", 3),
       classLevelMetadata(paladin, levelRefs.paladinTwo, "Paladin", 2),
       classLevelMetadata(paladin, levelRefs.paladinThree, "Paladin", 3),
       classLevelMetadata(ranger, levelRefs.rangerTwo, "Ranger", 2),
       classLevelMetadata(ranger, levelRefs.rangerThree, "Ranger", 3),
      { reference: insight, name: "Insight", description: "Wisdom-based discernment.", tags: ["srd-5.1"], mechanics: { attribute: "wisdom" } },
      { reference: religion, name: "Religion", description: "Intelligence-based religious knowledge.", tags: ["srd-5.1"], mechanics: { attribute: "intelligence" } },
      { reference: attack, name: "Longsword Attack", description: "A basic Strength-based melee weapon attack.", tags: ["srd-5.1"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "physical", dice: { count: 1, sides: 8, modifier: 0 } }] } },
      { reference: secondWind, name: "Second Wind", description: "Fighter feature: as a bonus action, recover 1d10 hit points plus your Fighter level; one use per short or long rest.", tags: ["srd-5.1", "fighter-1-2", "combat-feature"], mechanics: { actionCost: "bonus-action", recovery: "short-rest", uses: 1, target: "self", effects: [{ type: "healing", dice: { count: 1, sides: 10, modifier: 1 } }] } },
      { reference: actionSurge, name: "Action Surge", description: "Fighter feature metadata: one use per short or long rest. Granting an additional action is not executable in this bounded pack.", tags: ["srd-5.1", "fighter-1-2", "unsupported-runtime"], mechanics: { actionCost: "passive", recovery: "short-rest", uses: 1, target: "self", effects: [] } },
      { reference: rage, name: "Rage", description: "Barbarian feature metadata: two long-rest uses. Damage resistance, advantage, and bonus damage are not executable in this bounded pack.", tags: ["srd-5.1", "barbarian-1", "unsupported-runtime"], mechanics: { actionCost: "bonus-action", recovery: "long-rest", uses: 2, target: "self", effects: [] } },
      { reference: sneakAttack, name: "Sneak Attack", description: "Rogue feature metadata: once per turn, conditional 1d6 damage. The condition and damage rider are not executable in this bounded pack.", tags: ["srd-5.1", "rogue-1", "unsupported-runtime"], mechanics: { actionCost: "passive", recovery: "none", uses: 0, target: "enemy", effects: [] } },
      { reference: wizardSpellbook, name: "Spellbook", description: "Wizard feature metadata for a closed level-one spellbook; preparation and casting remain outside this progression lane.", tags: ["srd-5.1", "wizard-1", "unsupported-runtime"], mechanics: { actionCost: "passive", recovery: "none", uses: 0, target: "self", effects: [] } },
      { reference: divineSense, name: "Divine Sense", description: "Paladin feature metadata: five uses per long rest. Detection is not executable in this bounded pack.", tags: ["srd-5.1", "paladin-1", "unsupported-runtime"], mechanics: { actionCost: "action", recovery: "long-rest", uses: 5, target: "self", effects: [] } },
      { reference: layOnHands, name: "Lay on Hands", description: "Paladin feature metadata for a five-point healing pool; healing resolution is not executable in this bounded pack.", tags: ["srd-5.1", "paladin-1", "unsupported-runtime"], mechanics: { actionCost: "action", recovery: "long-rest", uses: 0, target: "ally", effects: [] } },
      { reference: favoredEnemy, name: "Favored Enemy", description: "Ranger feature metadata for a chosen favored enemy; no client-selected enemy type is accepted by this closed catalog.", tags: ["srd-5.1", "ranger-1", "unsupported-runtime"], mechanics: { actionCost: "passive", recovery: "none", uses: 0, target: "self", effects: [] } },
       { reference: naturalExplorer, name: "Natural Explorer", description: "Ranger feature metadata for a chosen favored terrain; no client-selected terrain is accepted by this closed catalog.", tags: ["srd-5.1", "ranger-1", "unsupported-runtime"], mechanics: { actionCost: "passive", recovery: "none", uses: 0, target: "self", effects: [] } },
       ...[
         [dwarfResilience, "Dwarven Resilience", "Dwarf resilience and poison-resistance trait metadata."], [dwarfStonecunning, "Stonecunning", "Dwarf stonecunning trait metadata."],
         [elfDarkvision, "Darkvision", "Darkvision trait metadata for Elf."], [elfKeenSenses, "Keen Senses", "Elf proficiency in Perception metadata."],
         [halflingLucky, "Lucky", "Halfling luck trait metadata."], [halflingBrave, "Brave", "Halfling bravery trait metadata."],
         [dragonbornAncestry, "Draconic Ancestry", "Dragonborn damage ancestry selection is intentionally closed and metadata-only."], [dragonbornBreath, "Breath Weapon", "Dragonborn breath weapon metadata; damage type selection is unsupported."],
         [gnomeCunning, "Gnome Cunning", "Gnome mental-save advantage metadata."], [halfOrcEndurance, "Relentless Endurance", "Half-Orc Relentless Endurance metadata."], [halfOrcSavage, "Savage Attacks", "Half-Orc Savage Attacks metadata."],
       ].map(([reference, name, description]) => ({ reference, name, description, tags: ["srd-5.1", "ancestry-trait", "metadata-only"], mechanics: { actionCost: "passive", recovery: "none", uses: 0, target: "self", effects: [] } })),
      { reference: goblinAttack, name: "Goblin Scimitar", description: "The executable basic melee attack selected from the Goblin entry.", tags: ["srd-5.1", "enemy-basic-attack"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "slashing", dice: { count: 1, sides: 6, modifier: 2 } }] } },
      { reference: goblinNimbleEscape, name: "Nimble Escape", description: "Goblin bonus-action escape profile. The enemy-turn runtime records this as a short reposition policy; grid movement is not modeled.", tags: ["srd-5.1", "enemy-trait", "bounded", "unsupported-runtime"], mechanics: { actionCost: "bonus-action", recovery: "none", uses: 0, target: "self", effects: [] } },
      { reference: banditAttack, name: "Bandit Scimitar", description: "The executable basic melee attack selected from the Bandit entry.", tags: ["srd-5.1", "enemy-basic-attack"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "slashing", dice: { count: 1, sides: 6, modifier: 1 } }] } },
      { reference: wolfAttack, name: "Wolf Bite", description: "The executable basic melee attack selected from the Wolf entry.", tags: ["srd-5.1", "enemy-basic-attack"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "piercing", dice: { count: 2, sides: 4, modifier: 2 } }] } },
      { reference: wolfPackTactics, name: "Pack Tactics", description: "Wolf trait marker for the executable two-roll attack policy when an active ally is present.", tags: ["srd-5.1", "enemy-trait", "combat-feature"], mechanics: { actionCost: "passive", recovery: "none", uses: 0, target: "self", effects: [] } },
      { reference: wolfKnockdown, name: "Wolf Knockdown", description: "Wolf bite rider marker for the executable prone condition after a confirmed hit.", tags: ["srd-5.1", "enemy-trait", "combat-feature"], mechanics: { actionCost: "passive", recovery: "none", uses: 0, target: "enemy", effects: [] } },
       { reference: light, name: "Light", description: "Catalog coverage marker only; casting and spell effects are not implemented.", tags: ["srd-5.1", "unsupported-runtime"], mechanics: { level: 0, school: "evocation", castingTime: "action", actionCost: "action", range: 0, target: "single", duration: "1-hour", attackType: "none", saveType: "none", concentration: false, ritual: false, components: { verbal: true, somatic: false, material: true, materialDescription: "a firefly or phosphorescent moss" }, effects: [] } },
       { reference: bless, name: "Bless", description: "A level-one Cleric spell. Creatures in the area gain a +1 bonus to attack rolls and saving throws while the caster concentrates.", tags: ["srd-5.1", "cleric-1", "spellcasting"], mechanics: { level: 1, school: "enchantment", castingTime: "action", actionCost: "action", range: 30, target: "area", duration: "concentration", attackType: "none", saveType: "none", concentration: true, ritual: false, components: { verbal: true, somatic: true, material: true, materialDescription: "a sprinkling of holy water" }, effects: [{ type: "modifier", statistic: "attack", amount: 1, duration: "encounter" }] } },
       { reference: cureWounds, name: "Cure Wounds", description: "A level-one Cleric spell that restores 1d8 hit points to a touched ally.", tags: ["srd-5.1", "cleric-1", "spellcasting"], mechanics: { level: 1, school: "evocation", castingTime: "action", actionCost: "action", range: 5, target: "ally", duration: "instantaneous", attackType: "none", saveType: "none", concentration: false, ritual: false, components: { verbal: true, somatic: true, material: false }, effects: [{ type: "healing", dice: { count: 1, sides: 8, modifier: 0 } }] } },
       { reference: wizardCantrip, name: "Fire Bolt", description: "A level-zero Wizard cantrip reference; casting and damage are not executable in this bounded pack.", tags: ["srd-5.1", "wizard-1", "unsupported-runtime"], mechanics: { level: 0, school: "evocation", castingTime: "action", actionCost: "action", range: 120, target: "enemy", duration: "instantaneous", attackType: "ranged", saveType: "none", concentration: false, ritual: false, components: { verbal: true, somatic: true, material: false }, effects: [{ type: "damage", damageType: "fire", dice: { count: 1, sides: 10, modifier: 0 } }] } },
        { reference: rayOfFrost, name: "Ray of Frost", description: "A level-zero Wizard cantrip reference; casting and slowing are not executable in this bounded pack.", tags: ["srd-5.1", "wizard-1", "unsupported-runtime"], mechanics: { level: 0, school: "evocation", castingTime: "action", actionCost: "action", range: 60, target: "enemy", duration: "instantaneous", attackType: "ranged", saveType: "none", concentration: false, ritual: false, components: { verbal: true, somatic: true, material: false }, effects: [{ type: "damage", damageType: "frost", dice: { count: 1, sides: 8, modifier: 0 } }] } },
        { reference: mageHand, name: "Mage Hand", description: "A level-zero Wizard cantrip reference; its interaction and carrying rules are metadata-only.", tags: ["srd-5.1", "cantrip", "metadata-only"], mechanics: { level: 0, school: "conjuration", castingTime: "action", actionCost: "action", range: 30, target: "single", duration: "1-minute", attackType: "none", saveType: "none", concentration: true, ritual: false, components: { verbal: true, somatic: true, material: true, materialDescription: "a bit of fleece" }, effects: [] } },
        { reference: sacredFlame, name: "Sacred Flame", description: "A level-zero Cleric cantrip reference; saving throw and radiant damage execution are unsupported.", tags: ["srd-5.1", "cantrip", "metadata-only"], mechanics: { level: 0, school: "evocation", castingTime: "action", actionCost: "action", range: 60, target: "enemy", duration: "instantaneous", attackType: "none", saveType: "dexterity", concentration: false, ritual: false, components: { verbal: true, somatic: true, material: false }, effects: [{ type: "damage", damageType: "radiant", dice: { count: 1, sides: 8, modifier: 0 } }] } },
         { reference: magicMissile, name: "Magic Missile", description: "A first-level Wizard spell with automatic-hit force darts, authoritative range, components, slot use, and replay-safe execution.", tags: ["srd-5.1", "level-1", "spellcasting"], mechanics: { level: 1, school: "evocation", castingTime: "action", actionCost: "action", range: 120, target: "enemy", duration: "instantaneous", attackType: "none", saveType: "none", concentration: false, ritual: false, components: { verbal: true, somatic: true, material: true, materialDescription: "a tiny ball of bat guano and sulfur" }, effects: [{ type: "damage", damageType: "force", dice: { count: 3, sides: 4, modifier: 3 } }] } },
        { reference: shield, name: "Shield", description: "A first-level reaction spell reference; its AC reaction window is metadata-only and not executable.", tags: ["srd-5.1", "level-1", "metadata-only"], mechanics: { level: 1, school: "abjuration", castingTime: "reaction", actionCost: "reaction", range: 0, target: "self", duration: "1-round", attackType: "none", saveType: "none", concentration: false, ritual: false, components: { verbal: true, somatic: true, material: false }, effects: [] } },
         { reference: healingWord, name: "Healing Word", description: "A first-level Cleric healing spell with authoritative 60-foot range, ally targeting, slot use, and replay-safe execution.", tags: ["srd-5.1", "level-1", "spellcasting"], mechanics: { level: 1, school: "evocation", castingTime: "bonus-action", actionCost: "bonus-action", range: 60, target: "ally", duration: "instantaneous", attackType: "none", saveType: "none", concentration: false, ritual: false, components: { verbal: true, somatic: false, material: false }, effects: [{ type: "healing", dice: { count: 1, sides: 4, modifier: 0 } }] } },
        { reference: guidingBolt, name: "Guiding Bolt", description: "A first-level Cleric spell reference with exact 120-foot range; radiant damage and advantage rider are unsupported.", tags: ["srd-5.1", "level-1", "metadata-only"], mechanics: { level: 1, school: "evocation", castingTime: "action", actionCost: "action", range: 120, target: "enemy", duration: "instantaneous", attackType: "ranged", saveType: "none", concentration: false, ritual: false, components: { verbal: true, somatic: true, material: false }, effects: [{ type: "damage", damageType: "radiant", dice: { count: 4, sides: 6, modifier: 0 } }] } },
      { reference: sword, name: "Longsword", description: "A martial melee weapon dealing 1d8 slashing damage, or 1d10 when wielded with two hands.", tags: ["srd-5.1"], mechanics: { category: "weapon", stackable: false, slot: "hand", price: { currency, amount: 15 }, effects: [{ type: "damage", damageType: "physical", dice: { count: 1, sides: 8, modifier: 0 } }], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 3, equipmentProfile: { kind: "weapon", proficiency: "martial", attackType: "melee", damage: { type: "slashing", die: { count: 1, sides: 8 } }, properties: [{ property: "versatile", damageDie: { count: 1, sides: 10 } }] } } } },
      { reference: ref("item", "srd-5.1:item:leather-armor"), name: "Leather Armor", description: "Light armor with base AC 11 and full Dexterity contribution.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 10 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 10, equipmentProfile: { kind: "armor", category: "light", baseArmorClass: 11, dexterity: { policy: "full" }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 } } } },
      { reference: ref("item", "srd-5.1:item:chain-shirt"), name: "Chain Shirt", description: "Medium armor with base AC 13 and Dexterity contribution capped at +2.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 50 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 20, equipmentProfile: { kind: "armor", category: "medium", baseArmorClass: 13, dexterity: { policy: "capped", maxBonus: 2 }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 } } } },
      { reference: ref("item", "srd-5.1:item:chain-mail"), name: "Chain Mail", description: "Heavy armor with AC 16, Strength 13 requirement, and stealth disadvantage.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 75 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 55, equipmentProfile: { kind: "armor", category: "heavy", baseArmorClass: 16, dexterity: { policy: "none" }, strengthRequirement: 13, stealthDisadvantage: true, shieldBonus: 0 } } } },
      { reference: ref("item", "srd-5.1:item:hide-armor"), name: "Hide Armor", description: "Medium armor with AC 12 and Dexterity capped at +2.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 10 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 12, equipmentProfile: { kind: "armor", category: "medium", baseArmorClass: 12, dexterity: { policy: "capped", maxBonus: 2 }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 } } } },
      { reference: ref("item", "srd-5.1:item:scale-mail"), name: "Scale Mail", description: "Medium armor with AC 14, Dexterity capped at +2, and stealth disadvantage.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 50 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 45, equipmentProfile: { kind: "armor", category: "medium", baseArmorClass: 14, dexterity: { policy: "capped", maxBonus: 2 }, strengthRequirement: null, stealthDisadvantage: true, shieldBonus: 0 } } } },
      { reference: ref("item", "srd-5.1:item:breastplate"), name: "Breastplate", description: "Medium armor with AC 14 and Dexterity capped at +2.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 400 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 20, equipmentProfile: { kind: "armor", category: "medium", baseArmorClass: 14, dexterity: { policy: "capped", maxBonus: 2 }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 } } } },
      { reference: ref("item", "srd-5.1:item:plate"), name: "Plate", description: "Heavy armor with AC 18, Strength 15 requirement, and stealth disadvantage.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 1500 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 65, equipmentProfile: { kind: "armor", category: "heavy", baseArmorClass: 18, dexterity: { policy: "none" }, strengthRequirement: 15, stealthDisadvantage: true, shieldBonus: 0 } } } },
      { reference: ref("item", "srd-5.1:item:shield"), name: "Shield", description: "A wielded shield granting a +2 armor class bonus.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "hand", price: { currency, amount: 10 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 6, equipmentProfile: { kind: "armor", category: "shield", baseArmorClass: null, dexterity: { policy: "none" }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 2 } } } },
      { reference: pack, name: "Explorer's Pack", description: "A single bounded starter-gear entry; individual contents are not modeled.", tags: ["srd-5.1"], mechanics: { category: "gear", stackable: false, slot: null, price: { currency, amount: 10 }, effects: [] } },
       { reference: acolyteEquipment, name: "Acolyte Equipment", description: "One grant-only entry representing a holy symbol, prayer book, five sticks of incense, vestments, and common clothes.", tags: ["srd-5.1", "bounded-aggregate", "grant-only"], mechanics: { category: "gear", stackable: false, slot: null, price: { currency, amount: 0 }, effects: [] } },
       weapon("dagger", "Dagger", "A simple finesse and light melee weapon.", 2, 1, "simple", "melee", "piercing", 4, [{ property: "finesse" }, { property: "light" }, { property: "thrown", range: { normalFeet: 20, longFeet: 60 } }]),
       weapon("club", "Club", "A simple light bludgeoning weapon.", 0, 2, "simple", "melee", "bludgeoning", 4, [{ property: "light" }]),
       weapon("handaxe", "Handaxe", "A simple light and thrown slashing weapon.", 5, 2, "simple", "melee", "slashing", 6, [{ property: "light" }, { property: "thrown", range: { normalFeet: 20, longFeet: 60 } }]),
       weapon("mace", "Mace", "A simple bludgeoning weapon.", 5, 4, "simple", "melee", "bludgeoning", 6, []),
       weapon("quarterstaff", "Quarterstaff", "A simple versatile bludgeoning weapon.", 0, 4, "simple", "melee", "bludgeoning", 6, [{ property: "versatile", damageDie: { count: 1, sides: 8 } }]),
       weapon("spear", "Spear", "A simple versatile and thrown piercing weapon.", 1, 3, "simple", "melee", "piercing", 6, [{ property: "thrown", range: { normalFeet: 20, longFeet: 60 } }, { property: "versatile", damageDie: { count: 1, sides: 8 } }]),
       weapon("shortbow", "Shortbow", "A simple ranged piercing weapon.", 25, 2, "simple", "ranged", "piercing", 6, [{ property: "ammunition", range: { normalFeet: 80, longFeet: 320 } }, { property: "two-handed" }]),
       weapon("light-crossbow", "Light Crossbow", "A simple loading ranged piercing weapon.", 25, 5, "simple", "ranged", "piercing", 8, [{ property: "ammunition", range: { normalFeet: 80, longFeet: 320 } }, { property: "loading" }, { property: "two-handed" }]),
       weapon("rapier", "Rapier", "A martial finesse piercing weapon.", 25, 2, "martial", "melee", "piercing", 8, [{ property: "finesse" }]),
       weapon("battleaxe", "Battleaxe", "A martial versatile slashing weapon.", 10, 4, "martial", "melee", "slashing", 8, [{ property: "versatile", damageDie: { count: 1, sides: 10 } }]),
       weapon("greatsword", "Greatsword", "A martial heavy two-handed slashing weapon.", 50, 6, "martial", "melee", "slashing", 6, [{ property: "heavy" }, { property: "two-handed" }]),
       armor("padded-armor", "Padded Armor", "Light armor with base AC 11 and stealth disadvantage.", 5, 8, "light", 11, { policy: "full" }, null, true),
       armor("studded-leather-armor", "Studded Leather Armor", "Light armor with base AC 12 and full Dexterity contribution.", 45, 13, "light", 12, { policy: "full" }, null, false),
       armor("splint", "Splint", "Heavy armor with AC 17, Strength 15 requirement, and stealth disadvantage.", 200, 60, "heavy", 17, { policy: "none" }, 15, true),
       armor("ring-mail", "Ring Mail", "Heavy armor with AC 14, Strength 13 requirement, and stealth disadvantage.", 30, 40, "heavy", 14, { policy: "none" }, 13, true),
      { reference: currency, name: "Gold Piece", description: "A whole-unit development currency reference.", tags: ["srd-5.1"], mechanics: { symbol: "gp", minorPerMajor: 1 } },
      { reference: ref("enemy-template", "velvet:test-fixture:enemy-template:training-dummy"), name: "Training Dummy", description: "An original Velvet deterministic integration target; not SRD content.", tags: ["velvet:test-fixture", "original", "non-srd"], mechanics: { tier: 1, maxHp: 8, defense: 10, speed: 0 + 1, abilityRefs: [attack], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 0, attack: { abilityRef: attack, attackBonus: 0 } } }, private: { tactics: "Use only as a stationary basic-attack integration target.", gmNotes: "Original Velvet test fixture, not an SRD monster.", hiddenAbilityRefs: [] } },
      { reference: ref("enemy-template", "srd-5.1:enemy-template:goblin"), name: "Goblin", description: "A bounded SRD Goblin profile with a pinned scimitar attack and Nimble Escape policy.", tags: ["srd-5.1", "enemy-basic-attack", "enemy-trait", "bounded"], mechanics: { tier: 1, maxHp: 7, defense: 15, speed: 30, abilityRefs: [goblinAttack, goblinNimbleEscape], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 2, attack: { abilityRef: goblinAttack, attackBonus: 4 } } }, private: { tactics: "Use the pinned scimitar attack against the deterministic legal target; retain a short Nimble Escape reposition state.", gmNotes: "SRD 5.1 Goblin attack and Nimble Escape policy are catalog-pinned. Grid movement is not modeled.", hiddenAbilityRefs: [] } },
      { reference: ref("enemy-template", "srd-5.1:enemy-template:bandit"), name: "Bandit", description: "A bounded SRD Bandit profile with only its scimitar attack executable.", tags: ["srd-5.1", "enemy-basic-attack", "bounded"], mechanics: { tier: 1, maxHp: 11, defense: 12, speed: 30, abilityRefs: [banditAttack], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 2, attack: { abilityRef: banditAttack, attackBonus: 3 } } }, private: { tactics: "Use the pinned scimitar attack against the deterministic legal target.", gmNotes: "SRD 5.1 Bandit basic attack only; other actions are not executable.", hiddenAbilityRefs: [] } },
      { reference: ref("enemy-template", "srd-5.1:enemy-template:wolf"), name: "Wolf", description: "A bounded SRD Wolf profile with bite, Pack Tactics, and a hit-confirmed knockdown rider.", tags: ["srd-5.1", "enemy-basic-attack", "enemy-trait", "bounded"], mechanics: { tier: 1, maxHp: 11, defense: 13, speed: 40, abilityRefs: [wolfAttack, wolfPackTactics, wolfKnockdown], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 2, attack: { abilityRef: wolfAttack, attackBonus: 4 } } }, private: { tactics: "Use the pinned bite attack against the deterministic legal target; apply Pack Tactics and knockdown only through server-derived evidence.", gmNotes: "SRD 5.1 Wolf bite, Pack Tactics, and the hit-confirmed rider are catalog-pinned.", hiddenAbilityRefs: [] } },
    ],
  });
}

catalogVersion = "1.0.0+000000000000";
const draft = literal("0".repeat(64));
const digest = calculateCatalogDigest(draft);
if (!SRD_5_1_STARTER_IDENTITY.packVersion.endsWith(digest.slice(0, 12))) {
  throw new Error(`SRD starter contract identity must end in ${digest.slice(0, 12)}`);
}

catalogVersion = SRD_5_1_STARTER_IDENTITY.packVersion;
export const SRD_5_1_STARTER_CATALOG = deepFreeze(literal(digest));
