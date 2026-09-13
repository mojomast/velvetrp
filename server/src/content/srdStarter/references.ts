import { SRD_5_1_STARTER_IDENTITY } from "@velvet/contracts";

export interface StarterReference {
  packId: string;
  packVersion: string;
  kind: string;
  definitionId: string;
}

export function createStarterReferences(catalogVersion: string) {
  const ref = (kind: string, definitionId: string): StarterReference => ({
    packId: SRD_5_1_STARTER_IDENTITY.packId,
    packVersion: catalogVersion,
    kind,
    definitionId,
  });
  return {
    ref,
    currency: ref("currency", "srd-5.1:currency:gp"),
    insight: ref("skill", "insight"),
    religion: ref("skill", "religion"),
    sword: ref("item", "srd-5.1:item:longsword"),
    pack: ref("item", "srd-5.1:item:explorers-pack"),
    acolyteEquipment: ref("item", "srd-5.1:item:acolyte-equipment"),
    attack: ref("ability", "srd-5.1:ability:longsword-attack"),
    goblinAttack: ref("ability", "srd-5.1:ability:goblin-scimitar"),
    goblinNimbleEscape: ref("ability", "srd-5.1:ability:goblin-nimble-escape"),
    banditAttack: ref("ability", "srd-5.1:ability:bandit-scimitar"),
    wolfAttack: ref("ability", "srd-5.1:ability:wolf-bite"),
    wolfPackTactics: ref("ability", "srd-5.1:ability:wolf-pack-tactics"),
    wolfKnockdown: ref("ability", "srd-5.1:ability:wolf-knockdown"),
    light: ref("spell", "srd-5.1:spell:light"),
    bless: ref("spell", "srd-5.1:spell:bless"),
    cureWounds: ref("spell", "srd-5.1:spell:cure-wounds"),
    magicMissile: ref("spell", "srd-5.1:spell:magic-missile"),
    shield: ref("spell", "srd-5.1:spell:shield"),
    healingWord: ref("spell", "srd-5.1:spell:healing-word"),
    guidingBolt: ref("spell", "srd-5.1:spell:guiding-bolt"),
    mageHand: ref("spell", "srd-5.1:spell:mage-hand"),
    sacredFlame: ref("spell", "srd-5.1:spell:sacred-flame"),
    falseLife: ref("spell", "srd-5.1:spell:false-life"),
    cleric: ref("class", "srd-5.1:class:cleric"),
    clericOne: ref("class-level", "srd-5.1:class-level:cleric-1"),
    barbarian: ref("class", "srd-5.1:class:barbarian"),
    barbarianOne: ref("class-level", "srd-5.1:class-level:barbarian-1"),
    rage: ref("ability", "srd-5.1:ability:barbarian-rage"),
    rogue: ref("class", "srd-5.1:class:rogue"),
    rogueOne: ref("class-level", "srd-5.1:class-level:rogue-1"),
    sneakAttack: ref("ability", "srd-5.1:ability:rogue-sneak-attack"),
    wizard: ref("class", "srd-5.1:class:wizard"),
    wizardOne: ref("class-level", "srd-5.1:class-level:wizard-1"),
    wizardSpellbook: ref("ability", "srd-5.1:ability:wizard-spellbook"),
    rayOfFrost: ref("spell", "srd-5.1:spell:ray-of-frost"),
    wizardCantrip: ref("spell", "srd-5.1:spell:fire-bolt"),
    paladin: ref("class", "srd-5.1:class:paladin"),
    paladinOne: ref("class-level", "srd-5.1:class-level:paladin-1"),
    divineSense: ref("ability", "srd-5.1:ability:paladin-divine-sense"),
    layOnHands: ref("ability", "srd-5.1:ability:paladin-lay-on-hands"),
    ranger: ref("class", "srd-5.1:class:ranger"),
    rangerOne: ref("class-level", "srd-5.1:class-level:ranger-1"),
    favoredEnemy: ref("ability", "srd-5.1:ability:ranger-favored-enemy"),
    naturalExplorer: ref("ability", "srd-5.1:ability:ranger-natural-explorer"),
    klass: ref("class", "srd-5.1:class:fighter"),
    level: ref("class-level", "srd-5.1:class-level:fighter-1"),
    levelTwo: ref("class-level", "srd-5.1:class-level:fighter-2"),
    levelThree: ref("class-level", "srd-5.1:class-level:fighter-3-unsupported"),
    secondWind: ref("ability", "srd-5.1:ability:fighter-second-wind"),
    actionSurge: ref("ability", "srd-5.1:ability:fighter-action-surge"),
    dwarfResilience: ref("ability", "srd-5.1:ability:dwarf-resilience"),
    dwarfStonecunning: ref("ability", "srd-5.1:ability:dwarf-stonecunning"),
    elfDarkvision: ref("ability", "srd-5.1:ability:elf-darkvision"),
    elfKeenSenses: ref("ability", "srd-5.1:ability:elf-keen-senses"),
    halflingLucky: ref("ability", "srd-5.1:ability:halfling-lucky"),
    halflingBrave: ref("ability", "srd-5.1:ability:halfling-brave"),
    dragonbornAncestry: ref("ability", "srd-5.1:ability:dragonborn-ancestry"),
    dragonbornBreath: ref("ability", "srd-5.1:ability:dragonborn-breath-weapon"),
    gnomeCunning: ref("ability", "srd-5.1:ability:gnome-cunning"),
    halfOrcEndurance: ref("ability", "srd-5.1:ability:half-orc-relentless-endurance"),
    halfOrcSavage: ref("ability", "srd-5.1:ability:half-orc-savage-attacks"),
    levelRefs: {
      barbarianTwo: ref("class-level", "srd-5.1:class-level:barbarian-2"), barbarianThree: ref("class-level", "srd-5.1:class-level:barbarian-3"),
      rogueTwo: ref("class-level", "srd-5.1:class-level:rogue-2"), rogueThree: ref("class-level", "srd-5.1:class-level:rogue-3"),
      wizardTwo: ref("class-level", "srd-5.1:class-level:wizard-2"), wizardThree: ref("class-level", "srd-5.1:class-level:wizard-3"),
      paladinTwo: ref("class-level", "srd-5.1:class-level:paladin-2"), paladinThree: ref("class-level", "srd-5.1:class-level:paladin-3"),
      rangerTwo: ref("class-level", "srd-5.1:class-level:ranger-2"), rangerThree: ref("class-level", "srd-5.1:class-level:ranger-3"),
      clericTwo: ref("class-level", "srd-5.1:class-level:cleric-2"), clericThree: ref("class-level", "srd-5.1:class-level:cleric-3"),
    },
  };
}

export type StarterReferences = ReturnType<typeof createStarterReferences>;
