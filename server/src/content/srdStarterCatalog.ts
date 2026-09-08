import {
  SRD_5_1_STARTER_IDENTITY,
  publishContentCatalogInputSchema,
  type PublishContentCatalogInput,
} from "@velvet/contracts";
import { calculateCatalogDigest } from "../repo/contentCatalog/index.js";

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
  const banditAttack = ref("ability", "srd-5.1:ability:bandit-scimitar");
  const wolfAttack = ref("ability", "srd-5.1:ability:wolf-bite");
  const light = ref("spell", "srd-5.1:spell:light");
  const klass = ref("class", "srd-5.1:class:fighter");
  const level = ref("class-level", "srd-5.1:class-level:fighter-1");
  const levelTwo = ref("class-level", "srd-5.1:class-level:fighter-2");
  const levelThree = ref("class-level", "srd-5.1:class-level:fighter-3-unsupported");
  const secondWind = ref("ability", "srd-5.1:ability:fighter-second-wind");
  const actionSurge = ref("ability", "srd-5.1:ability:fighter-action-surge");
  return publishContentCatalogInputSchema.parse({
      idempotencyKey: "srd-5.1-starter-publication-v4",
    manifest: {
      packId: SRD_5_1_STARTER_IDENTITY.packId,
      packVersion: catalogVersion,
      name: "SRD 5.1 Development Starter",
        description: "A reviewed, deliberately narrow SRD 5.1 Human Acolyte Fighter development catalog with executable progression through Fighter level 2 and an explicit level-3 archetype gate.",
      tags: ["srd-5.1", "cc-by-4.0", "development-starter"],
      rulesProfile: {
        name: "SRD 5.1 Development Rules",
        description: "Exact dnd-5e@1.0.0 profile with bounded Human Acolyte Fighter progression through level 2; Martial Archetype and all later levels are not supported.",
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
      { reference: ref("race", "srd-5.1:race:human"), name: "Human", description: "A level-one development ancestry with a +1 increase to each ability score.", tags: ["srd-5.1"], mechanics: { speed: 30, attributeBonuses: { strength: 1, dexterity: 1, constitution: 1, intelligence: 1, wisdom: 1, charisma: 1 }, abilityRefs: [] } },
      { reference: ref("background", "srd-5.1:background:acolyte"), name: "Acolyte", description: "An SRD background with Insight, Religion, and a bounded starter-equipment package.", tags: ["srd-5.1"], mechanics: { skillRefs: [insight, religion], itemRefs: [acolyteEquipment], startingCurrency: { currency, amount: 15 } } },
      { reference: klass, name: "Fighter", description: "Bounded SRD Fighter progression supports levels 1-2 only. Level 3 Martial Archetype is deliberately not executable.", tags: ["srd-5.1", "fighter-1-2"], mechanics: { hitDie: 10, primaryAttribute: "strength", savingAttributes: ["strength", "constitution"], levelRefs: [level, levelTwo, levelThree] } },
      { reference: level, name: "Fighter Level 1", description: "Level-one hit points use the Fighter d10 maximum and proficiency bonus +2. Second Wind is tracked as a short-rest power; its healing effect is not executable.", tags: ["srd-5.1", "fighter-1-2"], mechanics: { classRef: klass, level: 1, proficiencyBonus: 2, hpGain: 10, abilityRefs: [attack, secondWind], spellRefs: [] } },
      { reference: levelTwo, name: "Fighter Level 2", description: "Level-two advancement uses the SRD fixed hit-point increase of 6 before Constitution modifier and grants Action Surge tracking. Proficiency remains +2.", tags: ["srd-5.1", "fighter-1-2"], mechanics: { classRef: klass, level: 2, proficiencyBonus: 2, hpGain: 6, abilityRefs: [actionSurge], spellRefs: [], resourceGrants: [{ resourceId: "hit-dice-d10", maxIncrease: 1, currentIncrease: 1 }] } },
      { reference: levelThree, name: "Fighter Level 3", description: "Martial Archetype is an SRD level-three Fighter feature, but no SRD archetype is implemented in this pack. The canonical progression profile caps advancement at level 2.", tags: ["srd-5.1", "unsupported-runtime", "martial-archetype-gate"], mechanics: { classRef: klass, level: 3, proficiencyBonus: 2, hpGain: 6, abilityRefs: [], spellRefs: [] } },
      { reference: insight, name: "Insight", description: "Wisdom-based discernment.", tags: ["srd-5.1"], mechanics: { attribute: "wisdom" } },
      { reference: religion, name: "Religion", description: "Intelligence-based religious knowledge.", tags: ["srd-5.1"], mechanics: { attribute: "intelligence" } },
      { reference: attack, name: "Longsword Attack", description: "A basic Strength-based melee weapon attack.", tags: ["srd-5.1"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "physical", dice: { count: 1, sides: 8, modifier: 0 } }] } },
      { reference: secondWind, name: "Second Wind", description: "Fighter feature metadata: one bonus-action use per short or long rest. The 1d10 + Fighter level healing resolution is not executable in this bounded pack.", tags: ["srd-5.1", "fighter-1-2", "unsupported-runtime"], mechanics: { actionCost: "bonus-action", recovery: "short-rest", uses: 1, target: "self", effects: [] } },
      { reference: actionSurge, name: "Action Surge", description: "Fighter feature metadata: one use per short or long rest. Granting an additional action is not executable in this bounded pack.", tags: ["srd-5.1", "fighter-1-2", "unsupported-runtime"], mechanics: { actionCost: "passive", recovery: "short-rest", uses: 1, target: "self", effects: [] } },
      { reference: goblinAttack, name: "Goblin Scimitar", description: "The executable basic melee attack selected from the Goblin entry.", tags: ["srd-5.1", "enemy-basic-attack"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "slashing", dice: { count: 1, sides: 6, modifier: 2 } }] } },
      { reference: banditAttack, name: "Bandit Scimitar", description: "The executable basic melee attack selected from the Bandit entry.", tags: ["srd-5.1", "enemy-basic-attack"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "slashing", dice: { count: 1, sides: 6, modifier: 1 } }] } },
      { reference: wolfAttack, name: "Wolf Bite", description: "The executable basic melee attack selected from the Wolf entry.", tags: ["srd-5.1", "enemy-basic-attack"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "piercing", dice: { count: 2, sides: 4, modifier: 2 } }] } },
      { reference: light, name: "Light", description: "Catalog coverage marker only; casting and spell effects are not implemented.", tags: ["srd-5.1", "unsupported-runtime"], mechanics: { level: 0, actionCost: "action", range: 0, target: "self", concentration: false, effects: [] } },
      { reference: sword, name: "Longsword", description: "A martial melee weapon dealing 1d8 slashing damage, or 1d10 when wielded with two hands.", tags: ["srd-5.1"], mechanics: { category: "weapon", stackable: false, slot: "hand", price: { currency, amount: 15 }, effects: [{ type: "damage", damageType: "physical", dice: { count: 1, sides: 8, modifier: 0 } }], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 3, equipmentProfile: { kind: "weapon", proficiency: "martial", attackType: "melee", damage: { type: "slashing", die: { count: 1, sides: 8 } }, properties: [{ property: "versatile", damageDie: { count: 1, sides: 10 } }] } } } },
      { reference: ref("item", "srd-5.1:item:leather-armor"), name: "Leather Armor", description: "Light armor with base AC 11 and full Dexterity contribution.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 10 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 10, equipmentProfile: { kind: "armor", category: "light", baseArmorClass: 11, dexterity: { policy: "full" }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 } } } },
      { reference: ref("item", "srd-5.1:item:chain-shirt"), name: "Chain Shirt", description: "Medium armor with base AC 13 and Dexterity contribution capped at +2.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 50 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 20, equipmentProfile: { kind: "armor", category: "medium", baseArmorClass: 13, dexterity: { policy: "capped", maxBonus: 2 }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 0 } } } },
      { reference: ref("item", "srd-5.1:item:chain-mail"), name: "Chain Mail", description: "Heavy armor with AC 16, Strength 13 requirement, and stealth disadvantage.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "body", price: { currency, amount: 75 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 55, equipmentProfile: { kind: "armor", category: "heavy", baseArmorClass: 16, dexterity: { policy: "none" }, strengthRequirement: 13, stealthDisadvantage: true, shieldBonus: 0 } } } },
      { reference: ref("item", "srd-5.1:item:shield"), name: "Shield", description: "A wielded shield granting a +2 armor class bonus.", tags: ["srd-5.1"], mechanics: { category: "armor", stackable: false, slot: "hand", price: { currency, amount: 10 }, effects: [], engineDetails: { rulesEngine: "dnd-5e", weightPounds: 6, equipmentProfile: { kind: "armor", category: "shield", baseArmorClass: null, dexterity: { policy: "none" }, strengthRequirement: null, stealthDisadvantage: false, shieldBonus: 2 } } } },
      { reference: pack, name: "Explorer's Pack", description: "A single bounded starter-gear entry; individual contents are not modeled.", tags: ["srd-5.1"], mechanics: { category: "gear", stackable: false, slot: null, price: { currency, amount: 10 }, effects: [] } },
      { reference: acolyteEquipment, name: "Acolyte Equipment", description: "One grant-only entry representing a holy symbol, prayer book, five sticks of incense, vestments, and common clothes.", tags: ["srd-5.1", "bounded-aggregate", "grant-only"], mechanics: { category: "gear", stackable: false, slot: null, price: { currency, amount: 0 }, effects: [] } },
      { reference: currency, name: "Gold Piece", description: "A whole-unit development currency reference.", tags: ["srd-5.1"], mechanics: { symbol: "gp", minorPerMajor: 1 } },
      { reference: ref("enemy-template", "velvet:test-fixture:enemy-template:training-dummy"), name: "Training Dummy", description: "An original Velvet deterministic integration target; not SRD content.", tags: ["velvet:test-fixture", "original", "non-srd"], mechanics: { tier: 1, maxHp: 8, defense: 10, speed: 0 + 1, abilityRefs: [attack], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 0, attack: { abilityRef: attack, attackBonus: 0 } } }, private: { tactics: "Use only as a stationary basic-attack integration target.", gmNotes: "Original Velvet test fixture, not an SRD monster.", hiddenAbilityRefs: [] } },
      { reference: ref("enemy-template", "srd-5.1:enemy-template:goblin"), name: "Goblin", description: "A bounded SRD Goblin profile with only its scimitar attack executable.", tags: ["srd-5.1", "enemy-basic-attack", "bounded"], mechanics: { tier: 1, maxHp: 7, defense: 15, speed: 30, abilityRefs: [goblinAttack], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 2, attack: { abilityRef: goblinAttack, attackBonus: 4 } } }, private: { tactics: "Use the pinned scimitar attack against the deterministic legal target.", gmNotes: "SRD 5.1 Goblin basic attack only; traits and other actions are not executable.", hiddenAbilityRefs: [] } },
      { reference: ref("enemy-template", "srd-5.1:enemy-template:bandit"), name: "Bandit", description: "A bounded SRD Bandit profile with only its scimitar attack executable.", tags: ["srd-5.1", "enemy-basic-attack", "bounded"], mechanics: { tier: 1, maxHp: 11, defense: 12, speed: 30, abilityRefs: [banditAttack], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 2, attack: { abilityRef: banditAttack, attackBonus: 3 } } }, private: { tactics: "Use the pinned scimitar attack against the deterministic legal target.", gmNotes: "SRD 5.1 Bandit basic attack only; other actions are not executable.", hiddenAbilityRefs: [] } },
      { reference: ref("enemy-template", "srd-5.1:enemy-template:wolf"), name: "Wolf", description: "A bounded SRD Wolf profile with only its bite attack executable.", tags: ["srd-5.1", "enemy-basic-attack", "bounded"], mechanics: { tier: 1, maxHp: 11, defense: 13, speed: 40, abilityRefs: [wolfAttack], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 2, attack: { abilityRef: wolfAttack, attackBonus: 4 } } }, private: { tactics: "Use the pinned bite attack against the deterministic legal target.", gmNotes: "SRD 5.1 Wolf basic attack only; traits and rider effects are not executable.", hiddenAbilityRefs: [] } },
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
export const SRD_5_1_STARTER_CATALOG = Object.freeze(literal(digest));
