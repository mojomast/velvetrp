import type {
  AbilityId, CheckInput, CheckResolution, D20RollEvidence, D20TestInput,
  D20TestResolution, RollMode, RulesetCapability, SkillId, TestKind, TestResolution,
} from "../types.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";

export const DND_5E_D20_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "checks", version: "1.0.0", status: "supported" as const }),
  Object.freeze({ id: "passive-checks", version: "1.0.0", status: "supported" as const }),
]);

export function dnd5eAbilityModifier(score: number): number {
  requireInteger(score, "ability score");
  return Math.floor((score - 10) / 2);
}

export function dnd5eProficiencyBonus(level: number): number {
  requireInteger(level, "level");
  if (level < 1 || level > 20) throw new RangeError("level must be between 1 and 20");
  return 2 + Math.floor((level - 1) / 4);
}

export function resolveDnd5eCheck(input: CheckInput): CheckResolution {
  requireInteger(input.d20, "d20");
  if (input.d20 < 1 || input.d20 > 20) throw new RangeError("d20 must be between 1 and 20");
  requireNonNegativeInteger(input.proficiencyBonus, "proficiency bonus");
  requireInteger(input.dc, "DC");
  const abilityModifier = dnd5eAbilityModifier(input.abilityScore);
  const total = input.d20 + abilityModifier + input.proficiencyBonus;
  return Object.freeze({ d20: input.d20, abilityModifier, proficiencyBonus: input.proficiencyBonus, total, dc: input.dc, success: total >= input.dc });
}

export function dnd5eRollMode(advantageSources = 0, disadvantageSources = 0): RollMode {
  requireNonNegativeInteger(advantageSources, "advantage sources");
  requireNonNegativeInteger(disadvantageSources, "disadvantage sources");
  if (advantageSources > 0 && disadvantageSources === 0) return "advantage";
  if (disadvantageSources > 0 && advantageSources === 0) return "disadvantage";
  return "normal";
}

function selectD20(rolls: readonly number[], mode: RollMode): D20RollEvidence {
  const expected = mode === "normal" ? 1 : 2;
  if (rolls.length !== expected) throw new RangeError(`${mode} requires exactly ${expected} d20 roll${expected === 1 ? "" : "s"}`);
  rolls.forEach((roll) => {
    requireInteger(roll, "d20");
    if (roll < 1 || roll > 20) throw new RangeError("d20 must be between 1 and 20");
  });
  const selected = mode === "advantage" ? Math.max(...rolls) : mode === "disadvantage" ? Math.min(...rolls) : rolls[0]!;
  return Object.freeze({ supplied: frozenList(rolls), mode, selectedIndex: rolls.indexOf(selected), selected });
}

export function resolveDnd5eD20Test(input: D20TestInput): D20TestResolution {
  requireInteger(input.dc, "DC");
  const proficiencyBonus = input.proficiencyBonus ?? 0;
  const proficiencyMultiplier = input.proficiencyMultiplier ?? (proficiencyBonus > 0 ? 1 : 0);
  const flatBonus = input.flatBonus ?? 0;
  requireNonNegativeInteger(proficiencyBonus, "proficiency bonus");
  if (![0, 0.5, 1, 2].includes(proficiencyMultiplier)) throw new RangeError("proficiency multiplier must be 0, 0.5, 1, or 2");
  requireInteger(flatBonus, "flat bonus");
  const evidence = selectD20(input.rolls, dnd5eRollMode(input.advantageSources, input.disadvantageSources));
  const abilityModifier = dnd5eAbilityModifier(input.abilityScore);
  const appliedProficiency = Math.floor(proficiencyBonus * proficiencyMultiplier);
  const total = evidence.selected + abilityModifier + appliedProficiency + flatBonus;
  return Object.freeze({ evidence, abilityModifier, proficiencyBonus, proficiencyMultiplier, appliedProficiency, flatBonus, total, dc: input.dc, success: total >= input.dc });
}

/**
 * SRD 5.1 unarmed strike: a melee attack with which every creature is
 * proficient, dealing 1 + Strength modifier bludgeoning damage. A zero-count
 * die keeps the damage an explicit flat bonus while reusing the shared roll
 * and critical-hit machinery.
 */
export const DND_5E_UNARMED_STRIKE = Object.freeze({
  attackAbility: "strength" as const,
  attackType: "melee" as const,
  damageType: "bludgeoning" as const,
  damageDie: Object.freeze({ count: 0, sides: 4 }),
  flatDamageBonus: 1,
  proficient: true as const,
});

export const DND_5E_SKILL_ABILITIES: Readonly<Record<SkillId, AbilityId>> = Object.freeze({
  acrobatics: "dexterity", "animal-handling": "wisdom", arcana: "intelligence", athletics: "strength",
  deception: "charisma", history: "intelligence", insight: "wisdom", intimidation: "charisma",
  investigation: "intelligence", medicine: "wisdom", nature: "intelligence", perception: "wisdom",
  performance: "charisma", persuasion: "charisma", religion: "intelligence", "sleight-of-hand": "dexterity",
  stealth: "dexterity", survival: "wisdom",
});

export function resolveDnd5eAbilityTest(kind: Exclude<TestKind, "skill-check">, ability: AbilityId, input: D20TestInput): TestResolution {
  return Object.freeze({ ...resolveDnd5eD20Test(input), kind, ability });
}

export function resolveDnd5eSkillTest(skill: SkillId, input: D20TestInput): TestResolution {
  return Object.freeze({ ...resolveDnd5eD20Test(input), kind: "skill-check", ability: DND_5E_SKILL_ABILITIES[skill], skill });
}

export function dnd5ePassiveCheck(abilityScore: number, proficiencyBonus = 0, proficiencyMultiplier: 0 | 0.5 | 1 | 2 = proficiencyBonus > 0 ? 1 : 0, advantageSources = 0, disadvantageSources = 0): number {
  requireNonNegativeInteger(proficiencyBonus, "proficiency bonus");
  const mode = dnd5eRollMode(advantageSources, disadvantageSources);
  const modeAdjustment = mode === "advantage" ? 5 : mode === "disadvantage" ? -5 : 0;
  return 10 + dnd5eAbilityModifier(abilityScore) + Math.floor(proficiencyBonus * proficiencyMultiplier) + modeAdjustment;
}
