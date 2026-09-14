import type { StarterReferences } from "./references.js";

export function buildAbilities(refs: StarterReferences) {
  const { attack, secondWind, actionSurge, rage, sneakAttack, wizardSpellbook, divineSense, layOnHands, favoredEnemy, naturalExplorer,
    dwarfResilience, dwarfStonecunning, elfDarkvision, elfKeenSenses, halflingLucky, halflingBrave, dragonbornAncestry, dragonbornBreath,
    gnomeCunning, halfOrcEndurance, halfOrcSavage, goblinAttack, goblinNimbleEscape, banditAttack, wolfAttack, wolfPackTactics, wolfKnockdown,
    ref } = refs;
  const halfElfFeyAncestry = ref("ability", "srd-5.1:ability:half-elf-fey-ancestry");
  const halfElfSkillVersatility = ref("ability", "srd-5.1:ability:half-elf-skill-versatility");
  const halfElfDarkvision = ref("ability", "srd-5.1:ability:half-elf-darkvision");
  const tieflingHellishResistance = ref("ability", "srd-5.1:ability:tiefling-hellish-resistance");
  const tieflingInfernalLegacy = ref("ability", "srd-5.1:ability:tiefling-infernal-legacy");
  const tieflingDarkvision = ref("ability", "srd-5.1:ability:tiefling-darkvision");
  return [
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
    ...([
      [dwarfResilience, "Dwarven Resilience", "Dwarf resilience and poison-resistance trait metadata."], [dwarfStonecunning, "Stonecunning", "Dwarf stonecunning trait metadata."],
      [elfDarkvision, "Darkvision", "Darkvision trait metadata for Elf."], [elfKeenSenses, "Keen Senses", "Elf proficiency in Perception metadata."],
      [halflingLucky, "Lucky", "Halfling luck trait metadata."], [halflingBrave, "Brave", "Halfling bravery trait metadata."],
      [dragonbornAncestry, "Draconic Ancestry", "Dragonborn damage ancestry selection is intentionally closed and metadata-only."], [dragonbornBreath, "Breath Weapon", "Dragonborn breath weapon metadata; damage type selection is unsupported."],
      [gnomeCunning, "Gnome Cunning", "Gnome mental-save advantage metadata."], [halfOrcEndurance, "Relentless Endurance", "Half-Orc Relentless Endurance metadata."], [halfOrcSavage, "Savage Attacks", "Half-Orc Savage Attacks metadata."],
      [halfElfFeyAncestry, "Fey Ancestry", "Half-Elf fey heritage metadata: advantage on saves against being charmed and immunity to magical sleep."],
      [halfElfSkillVersatility, "Skill Versatility", "Half-Elf trait metadata for two chosen skill proficiencies; player-selected skills are not expressible in this closed catalog."],
      [halfElfDarkvision, "Darkvision", "Half-Elf darkvision trait metadata."],
      [tieflingHellishResistance, "Hellish Resistance", "Tiefling infernal heritage metadata; fire resistance is carried on the race mechanics."],
      [tieflingInfernalLegacy, "Infernal Legacy", "Tiefling Infernal Legacy metadata: Thaumaturgy cantrip plus Hellish Rebuke and Darkness at higher levels; spell selection is not executable in this pack."],
      [tieflingDarkvision, "Darkvision", "Tiefling darkvision trait metadata."],
    ] as const).map(([reference, name, description]) => ({ reference, name, description, tags: ["srd-5.1", "ancestry-trait", "metadata-only"], mechanics: { actionCost: "passive", recovery: "none", uses: 0, target: "self", effects: [] } })),
    { reference: goblinAttack, name: "Goblin Scimitar", description: "The executable basic melee attack selected from the Goblin entry.", tags: ["srd-5.1", "enemy-basic-attack"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "slashing", dice: { count: 1, sides: 6, modifier: 2 } }] } },
    { reference: goblinNimbleEscape, name: "Nimble Escape", description: "Goblin bonus-action escape profile. The enemy-turn runtime records this as a short reposition policy; grid movement is not modeled.", tags: ["srd-5.1", "enemy-trait", "bounded", "unsupported-runtime"], mechanics: { actionCost: "bonus-action", recovery: "none", uses: 0, target: "self", effects: [] } },
    { reference: banditAttack, name: "Bandit Scimitar", description: "The executable basic melee attack selected from the Bandit entry.", tags: ["srd-5.1", "enemy-basic-attack"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "slashing", dice: { count: 1, sides: 6, modifier: 1 } }] } },
    { reference: wolfAttack, name: "Wolf Bite", description: "The executable basic melee attack selected from the Wolf entry.", tags: ["srd-5.1", "enemy-basic-attack"], mechanics: { actionCost: "action", recovery: "none", uses: 0, target: "enemy", effects: [{ type: "damage", damageType: "piercing", dice: { count: 2, sides: 4, modifier: 2 } }] } },
    { reference: wolfPackTactics, name: "Pack Tactics", description: "Wolf trait marker for the executable two-roll attack policy when an active ally is present.", tags: ["srd-5.1", "enemy-trait", "combat-feature"], mechanics: { actionCost: "passive", recovery: "none", uses: 0, target: "self", effects: [] } },
    { reference: wolfKnockdown, name: "Wolf Knockdown", description: "Wolf bite rider marker for the executable prone condition after a confirmed hit.", tags: ["srd-5.1", "enemy-trait", "combat-feature"], mechanics: { actionCost: "passive", recovery: "none", uses: 0, target: "enemy", effects: [] } },
  ];
}
