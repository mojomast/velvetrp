import {
  CHARACTER_BUILDER_ATTRIBUTE_IDS,
  characterDerivedCalculatorInputSchema,
  characterDerivedStatsSchema,
  type CharacterDerivedCalculatorInput,
  type CharacterDerivedStats,
} from "@velvet/contracts";
import { DND_5E_RULESET } from "./rulesets/dnd5e.js";

/**
 * The only M1.3 derived-stat calculator.
 *
 * It is deliberately closed and pure: no database, clock, RNG, mutable global,
 * user supplied result, or executable content participates in these formulas.
 */
export function calculateCharacterDerivedStats(input: CharacterDerivedCalculatorInput): CharacterDerivedStats {
  const normalized = characterDerivedCalculatorInputSchema.parse(input);
  if ("strength" in normalized.scores) {
    if (normalized.rulesetId !== DND_5E_RULESET.descriptor.id
        || normalized.rulesetVersion !== DND_5E_RULESET.descriptor.version) throw new Error("SRD ability scores require the exact compiled ruleset identity");
    const scores = Object.fromEntries(Object.entries(normalized.scores).map(([id, score]) => [id,
      score + (normalized.racialBonuses[id as keyof typeof normalized.racialBonuses] ?? 0)])) as Record<string, number>;
    const mechanics = DND_5E_RULESET.mechanics!;
    const values = mechanics.deriveCharacter({ level: 1, abilityScores: scores as never, armorBase: 10,
      armorDexterity: "full", speed: normalized.raceSpeed, perceptionProficient: false });
    const constitutionModifier = DND_5E_RULESET.abilityModifier(scores.constitution!);
    const spellModifier = DND_5E_RULESET.abilityModifier(scores[normalized.spellcastingAttribute]!);
    const maxHp = Math.max(1, normalized.classHp + constitutionModifier);
    const carryingLimit = Math.max(0, scores.strength! * 15);
    const spellAttack = values.proficiencyBonus + spellModifier, saveDc = 8 + spellAttack;
    return characterDerivedStatsSchema.parse({ rulesetId: DND_5E_RULESET.descriptor.id,
      rulesetVersion: DND_5E_RULESET.descriptor.version, maxHp,
      defenses: { guard: values.armorClass, evasion: values.armorClass, will: values.armorClass },
      armorClass: values.armorClass, proficiencyBonus: values.proficiencyBonus,
      abilityModifiers: values.abilityModifiers, initiative: values.initiativeModifier, speed: values.speed,
      carryingLimit, spellAttack, saveDc, explanations: [
        { statistic: "max-hp", formula: "class maximum hit die + Constitution modifier", inputs: { classHp: normalized.classHp, constitutionModifier }, result: maxHp },
        { statistic: "defense-guard", formula: "armor class", inputs: { armorClass: values.armorClass }, result: values.armorClass },
        { statistic: "defense-evasion", formula: "armor class", inputs: { armorClass: values.armorClass }, result: values.armorClass },
        { statistic: "defense-will", formula: "armor class", inputs: { armorClass: values.armorClass }, result: values.armorClass },
        { statistic: "initiative", formula: "Dexterity modifier", inputs: { dexterityModifier: values.initiativeModifier }, result: values.initiativeModifier },
        { statistic: "speed", formula: "race speed", inputs: { raceSpeed: values.speed }, result: values.speed },
        { statistic: "carrying-limit", formula: "Strength score * 15", inputs: { strengthScore: scores.strength!, multiplier: 15 }, result: carryingLimit },
        { statistic: "spell-attack", formula: "proficiency bonus + primary ability modifier", inputs: { proficiencyBonus: values.proficiencyBonus, abilityModifier: spellModifier }, result: spellAttack },
        { statistic: "save-dc", formula: "8 + proficiency bonus + primary ability modifier", inputs: { base: 8, proficiencyBonus: values.proficiencyBonus, abilityModifier: spellModifier }, result: saveDc },
      ] });
  }
  const legacyScores = normalized.scores as Record<(typeof CHARACTER_BUILDER_ATTRIBUTE_IDS)[number], number>;
  const scores = Object.fromEntries(CHARACTER_BUILDER_ATTRIBUTE_IDS.map((attributeId) => [
    attributeId,
    legacyScores[attributeId] + (normalized.racialBonuses[attributeId] ?? 0),
  ])) as Record<(typeof CHARACTER_BUILDER_ATTRIBUTE_IDS)[number], number>;
  const modifier = (attributeId: (typeof CHARACTER_BUILDER_ATTRIBUTE_IDS)[number]) => Math.floor((scores[attributeId] - 10) / 2);
  const resolve = modifier("resolve");
  const agility = modifier("agility");
  const insight = modifier("insight");
  const spell = modifier(normalized.spellcastingAttribute as (typeof CHARACTER_BUILDER_ATTRIBUTE_IDS)[number]);
  const maxHp = Math.max(1, normalized.classHp + resolve);
  const guard = 10 + resolve;
  const evasion = 10 + agility;
  const will = 10 + insight;
  const carryingLimit = Math.max(0, scores.might * 15);
  const spellAttack = normalized.proficiencyBonus + spell;
  const saveDc = 8 + normalized.proficiencyBonus + spell;
  return characterDerivedStatsSchema.parse({
    maxHp,
    defenses: { guard, evasion, will },
    initiative: agility,
    speed: normalized.raceSpeed,
    carryingLimit,
    spellAttack,
    saveDc,
    explanations: [
      { statistic: "max-hp", formula: "max(1, class hp + resolve modifier)", inputs: { classHp: normalized.classHp, resolveModifier: resolve }, result: maxHp },
      { statistic: "defense-guard", formula: "10 + resolve modifier", inputs: { base: 10, resolveModifier: resolve }, result: guard },
      { statistic: "defense-evasion", formula: "10 + agility modifier", inputs: { base: 10, agilityModifier: agility }, result: evasion },
      { statistic: "defense-will", formula: "10 + insight modifier", inputs: { base: 10, insightModifier: insight }, result: will },
      { statistic: "initiative", formula: "agility modifier", inputs: { agilityModifier: agility }, result: agility },
      { statistic: "speed", formula: "race speed", inputs: { raceSpeed: normalized.raceSpeed }, result: normalized.raceSpeed },
      { statistic: "carrying-limit", formula: "max(0, might score * 15)", inputs: { mightScore: scores.might, multiplier: 15 }, result: carryingLimit },
      { statistic: "spell-attack", formula: "proficiency bonus + spellcasting modifier", inputs: { proficiencyBonus: normalized.proficiencyBonus, spellcastingModifier: spell }, result: spellAttack },
      { statistic: "save-dc", formula: "8 + proficiency bonus + spellcasting modifier", inputs: { base: 8, proficiencyBonus: normalized.proficiencyBonus, spellcastingModifier: spell }, result: saveDc },
    ],
  });
}
