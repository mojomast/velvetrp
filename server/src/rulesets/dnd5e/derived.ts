import type { AbilityId, CharacterDerivedInput, CharacterDerivedValues, RulesetCapability } from "../types.js";
import { dnd5eAbilityModifier, dnd5eProficiencyBonus } from "./d20.js";
import { requireInteger, requireNonNegativeInteger } from "./internal.js";

export const DND_5E_DERIVED_CAPABILITIES: readonly RulesetCapability[] = Object.freeze([
  Object.freeze({ id: "derived-values", version: "1.0.0", status: "partial" as const }),
]);

export function deriveDnd5eCharacter(input: CharacterDerivedInput): CharacterDerivedValues {
  const proficiencyBonus = dnd5eProficiencyBonus(input.level);
  requireInteger(input.armorBase, "armor base");
  requireNonNegativeInteger(input.speed, "speed");
  const ids: AbilityId[] = ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"];
  const abilityModifiers = Object.freeze(Object.fromEntries(ids.map((id) => [id, dnd5eAbilityModifier(input.abilityScores[id])])) as unknown as Record<AbilityId, number>);
  const dexterityForArmor = input.armorDexterity === "none" ? 0 : input.armorDexterity === "maximum-2" ? Math.min(2, abilityModifiers.dexterity) : abilityModifiers.dexterity;
  const perceptionMultiplier = input.perceptionExpertise ? 2 : input.perceptionProficient ? 1 : 0;
  return Object.freeze({
    abilityModifiers,
    proficiencyBonus,
    armorClass: input.armorBase + dexterityForArmor + (input.shieldBonus ?? 0),
    initiativeModifier: abilityModifiers.dexterity,
    passivePerception: 10 + abilityModifiers.wisdom + proficiencyBonus * perceptionMultiplier,
    speed: input.speed,
  });
}
