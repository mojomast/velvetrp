import type { StarterReferences } from "./references.js";

export function buildEnemies(refs: StarterReferences) {
  const { ref, attack, goblinAttack, goblinNimbleEscape, banditAttack, wolfAttack, wolfPackTactics, wolfKnockdown } = refs;
  const ability = (definitionId: string) => ref("ability", definitionId);
  const enemyTemplate = (
    definitionId: string, name: string, crTag: string,
    maxHp: number, defense: number, speed: number,
    attackId: string, attackBonus: number,
    traits: readonly string[] = [],
  ) => {
    const primaryAttack = ability(attackId);
    const traitRefs = traits.map(ability);
    return {
      reference: ref("enemy-template", definitionId),
      name,
      description: `${name} is a bounded SRD 5.1 enemy profile; only its basic attack is executable.`,
      tags: ["srd-5.1", "enemy-basic-attack", "bounded", crTag, ...(traitRefs.length > 0 ? ["enemy-trait"] : [])],
      mechanics: {
        tier: 1, maxHp, defense, speed,
        abilityRefs: [primaryAttack, ...traitRefs],
        resistances: [], vulnerabilities: [], immunities: [],
        combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1" as const, proficiencyBonus: 2, attack: { abilityRef: primaryAttack, attackBonus } },
      },
      private: {
        tactics: "Use the pinned basic attack against the deterministic legal target.",
        gmNotes: `${name} is a bounded SRD 5.1 basic attack; other actions and traits are metadata only.`,
        hiddenAbilityRefs: [],
      },
    };
  };
  const packTactics = "srd-5.1:ability:enemy-pack-tactics";
  const sunlightSensitivity = "srd-5.1:ability:kobold-sunlight-sensitivity";
  const undeadFortitude = "srd-5.1:ability:zombie-undead-fortitude";
  const aggressive = "srd-5.1:ability:orc-aggressive";
  const martialAdvantage = "srd-5.1:ability:hobgoblin-martial-advantage";
  return [
    { reference: ref("enemy-template", "velvet:test-fixture:enemy-template:training-dummy"), name: "Training Dummy", description: "An original Velvet deterministic integration target; not SRD content.", tags: ["velvet:test-fixture", "original", "non-srd"], mechanics: { tier: 1, maxHp: 8, defense: 10, speed: 0 + 1, abilityRefs: [attack], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 0, attack: { abilityRef: attack, attackBonus: 0 } } }, private: { tactics: "Use only as a stationary basic-attack integration target.", gmNotes: "Original Velvet test fixture, not an SRD monster.", hiddenAbilityRefs: [] } },
    { reference: ref("enemy-template", "srd-5.1:enemy-template:goblin"), name: "Goblin", description: "A bounded SRD Goblin profile with a pinned scimitar attack and Nimble Escape policy.", tags: ["srd-5.1", "enemy-basic-attack", "enemy-trait", "bounded"], mechanics: { tier: 1, maxHp: 7, defense: 15, speed: 30, abilityRefs: [goblinAttack, goblinNimbleEscape], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 2, attack: { abilityRef: goblinAttack, attackBonus: 4 } } }, private: { tactics: "Use the pinned scimitar attack against the deterministic legal target; retain a short Nimble Escape reposition state.", gmNotes: "SRD 5.1 Goblin attack and Nimble Escape policy are catalog-pinned. Grid movement is not modeled.", hiddenAbilityRefs: [] } },
    { reference: ref("enemy-template", "srd-5.1:enemy-template:bandit"), name: "Bandit", description: "A bounded SRD Bandit profile with only its scimitar attack executable.", tags: ["srd-5.1", "enemy-basic-attack", "bounded"], mechanics: { tier: 1, maxHp: 11, defense: 12, speed: 30, abilityRefs: [banditAttack], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 2, attack: { abilityRef: banditAttack, attackBonus: 3 } } }, private: { tactics: "Use the pinned scimitar attack against the deterministic legal target.", gmNotes: "SRD 5.1 Bandit basic attack only; other actions are not executable.", hiddenAbilityRefs: [] } },
    { reference: ref("enemy-template", "srd-5.1:enemy-template:wolf"), name: "Wolf", description: "A bounded SRD Wolf profile with bite, Pack Tactics, and a hit-confirmed knockdown rider.", tags: ["srd-5.1", "enemy-basic-attack", "enemy-trait", "bounded"], mechanics: { tier: 1, maxHp: 11, defense: 13, speed: 40, abilityRefs: [wolfAttack, wolfPackTactics, wolfKnockdown], resistances: [], vulnerabilities: [], immunities: [], combatProfile: { kind: "dnd-5e-pinned-basic-attack-v1", proficiencyBonus: 2, attack: { abilityRef: wolfAttack, attackBonus: 4 } } }, private: { tactics: "Use the pinned bite attack against the deterministic legal target; apply Pack Tactics and knockdown only through server-derived evidence.", gmNotes: "SRD 5.1 Wolf bite, Pack Tactics, and the hit-confirmed rider are catalog-pinned.", hiddenAbilityRefs: [] } },
    enemyTemplate("srd-5.1:enemy-template:bat", "Bat", "cr-0", 1, 12, 30, "srd-5.1:ability:bat-bite", 0),
    enemyTemplate("srd-5.1:enemy-template:cat", "Cat", "cr-0", 2, 12, 40, "srd-5.1:ability:cat-claws", 0),
    enemyTemplate("srd-5.1:enemy-template:crab", "Crab", "cr-0", 2, 11, 20, "srd-5.1:ability:crab-claw", 0),
    enemyTemplate("srd-5.1:enemy-template:giant-fire-beetle", "Giant Fire Beetle", "cr-0", 4, 13, 30, "srd-5.1:ability:giant-fire-beetle-bite", 1),
    enemyTemplate("srd-5.1:enemy-template:jackal", "Jackal", "cr-0", 3, 12, 40, "srd-5.1:ability:jackal-bite", 1, [packTactics]),
    enemyTemplate("srd-5.1:enemy-template:lizard", "Lizard", "cr-0", 2, 10, 20, "srd-5.1:ability:lizard-bite", 0),
    enemyTemplate("srd-5.1:enemy-template:rat", "Rat", "cr-0", 1, 10, 20, "srd-5.1:ability:rat-bite", 0),
    enemyTemplate("srd-5.1:enemy-template:weasel", "Weasel", "cr-0", 1, 13, 30, "srd-5.1:ability:weasel-bite", 5),
    enemyTemplate("srd-5.1:enemy-template:blood-hawk", "Blood Hawk", "cr-1-8", 7, 12, 60, "srd-5.1:ability:blood-hawk-beak", 4, [packTactics]),
    enemyTemplate("srd-5.1:enemy-template:cultist", "Cultist", "cr-1-8", 9, 12, 30, "srd-5.1:ability:cultist-scimitar", 3),
    enemyTemplate("srd-5.1:enemy-template:giant-rat", "Giant Rat", "cr-1-8", 7, 12, 30, "srd-5.1:ability:giant-rat-bite", 4, [packTactics]),
    enemyTemplate("srd-5.1:enemy-template:giant-weasel", "Giant Weasel", "cr-1-8", 9, 13, 40, "srd-5.1:ability:giant-weasel-bite", 5),
    enemyTemplate("srd-5.1:enemy-template:guard", "Guard", "cr-1-8", 11, 16, 30, "srd-5.1:ability:guard-spear", 3),
    enemyTemplate("srd-5.1:enemy-template:kobold", "Kobold", "cr-1-8", 5, 12, 30, "srd-5.1:ability:kobold-dagger", 4, [packTactics, sunlightSensitivity]),
    enemyTemplate("srd-5.1:enemy-template:mastiff", "Mastiff", "cr-1-8", 5, 12, 40, "srd-5.1:ability:mastiff-bite", 3),
    enemyTemplate("srd-5.1:enemy-template:tribal-warrior", "Tribal Warrior", "cr-1-8", 11, 12, 30, "srd-5.1:ability:tribal-warrior-spear", 3, [packTactics]),
    enemyTemplate("srd-5.1:enemy-template:axe-beak", "Axe Beak", "cr-1-4", 19, 11, 50, "srd-5.1:ability:axe-beak-beak", 4),
    enemyTemplate("srd-5.1:enemy-template:boar", "Boar", "cr-1-4", 11, 11, 40, "srd-5.1:ability:boar-tusk", 3),
    enemyTemplate("srd-5.1:enemy-template:constrictor-snake", "Constrictor Snake", "cr-1-4", 13, 12, 30, "srd-5.1:ability:constrictor-snake-bite", 4),
    enemyTemplate("srd-5.1:enemy-template:giant-bat", "Giant Bat", "cr-1-4", 22, 13, 60, "srd-5.1:ability:giant-bat-bite", 4),
    enemyTemplate("srd-5.1:enemy-template:giant-lizard", "Giant Lizard", "cr-1-4", 19, 12, 30, "srd-5.1:ability:giant-lizard-bite", 4),
    enemyTemplate("srd-5.1:enemy-template:giant-wolf-spider", "Giant Wolf Spider", "cr-1-4", 11, 13, 40, "srd-5.1:ability:giant-wolf-spider-bite", 3),
    enemyTemplate("srd-5.1:enemy-template:panther", "Panther", "cr-1-4", 13, 12, 50, "srd-5.1:ability:panther-bite", 4),
    enemyTemplate("srd-5.1:enemy-template:skeleton", "Skeleton", "cr-1-4", 13, 13, 30, "srd-5.1:ability:skeleton-shortsword", 4),
    enemyTemplate("srd-5.1:enemy-template:zombie", "Zombie", "cr-1-4", 22, 8, 20, "srd-5.1:ability:zombie-slam", 3, [undeadFortitude]),
    enemyTemplate("srd-5.1:enemy-template:ape", "Ape", "cr-1-2", 19, 12, 30, "srd-5.1:ability:ape-fist", 5),
    enemyTemplate("srd-5.1:enemy-template:black-bear", "Black Bear", "cr-1-2", 19, 11, 40, "srd-5.1:ability:black-bear-bite", 3),
    enemyTemplate("srd-5.1:enemy-template:crocodile", "Crocodile", "cr-1-2", 19, 12, 20, "srd-5.1:ability:crocodile-bite", 4),
    enemyTemplate("srd-5.1:enemy-template:giant-goat", "Giant Goat", "cr-1-2", 19, 11, 40, "srd-5.1:ability:giant-goat-ram", 5),
    enemyTemplate("srd-5.1:enemy-template:hobgoblin", "Hobgoblin", "cr-1-2", 11, 18, 30, "srd-5.1:ability:hobgoblin-longsword", 3, [martialAdvantage]),
    enemyTemplate("srd-5.1:enemy-template:orc", "Orc", "cr-1-2", 15, 13, 30, "srd-5.1:ability:orc-greataxe", 5, [aggressive]),
    enemyTemplate("srd-5.1:enemy-template:scout", "Scout", "cr-1-2", 16, 13, 30, "srd-5.1:ability:scout-shortsword", 4),
    enemyTemplate("srd-5.1:enemy-template:warhorse", "Warhorse", "cr-1-2", 19, 11, 60, "srd-5.1:ability:warhorse-hooves", 6),
    enemyTemplate("srd-5.1:enemy-template:worg", "Worg", "cr-1-2", 26, 13, 50, "srd-5.1:ability:worg-bite", 5),
  ];
}
