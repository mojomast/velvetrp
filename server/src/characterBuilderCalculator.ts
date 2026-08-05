import {
  CHARACTER_BUILDER_ATTRIBUTE_IDS,
  characterDerivedCalculatorInputSchema,
  characterDerivedStatsSchema,
  type CharacterDerivedCalculatorInput,
  type CharacterDerivedStats,
} from "@velvet/contracts";

/**
 * The only M1.3 derived-stat calculator.
 *
 * It is deliberately closed and pure: no database, clock, RNG, mutable global,
 * user supplied result, or executable content participates in these formulas.
 */
export function calculateCharacterDerivedStats(input: CharacterDerivedCalculatorInput): CharacterDerivedStats {
  const normalized = characterDerivedCalculatorInputSchema.parse(input);
  const scores = Object.fromEntries(CHARACTER_BUILDER_ATTRIBUTE_IDS.map((attributeId) => [
    attributeId,
    normalized.scores[attributeId] + (normalized.racialBonuses[attributeId] ?? 0),
  ])) as Record<(typeof CHARACTER_BUILDER_ATTRIBUTE_IDS)[number], number>;
  const modifier = (attributeId: (typeof CHARACTER_BUILDER_ATTRIBUTE_IDS)[number]) => Math.floor((scores[attributeId] - 10) / 2);
  const resolve = modifier("resolve");
  const agility = modifier("agility");
  const insight = modifier("insight");
  const spell = modifier(normalized.spellcastingAttribute);
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
