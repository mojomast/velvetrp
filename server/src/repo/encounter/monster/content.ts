import { abilityCatalogDefinitionSchema, enemyTemplateCatalogDefinitionSchema } from "@velvet/contracts";
import type { MonsterActionPlan, MonsterAttackStep, MonsterSavePlan } from "../../../rulesets/dnd5e/monsters.js";
import { planMonsterMultiattack, planMonsterSave } from "../../../rulesets/dnd5e/monsters.js";

/**
 * Adapts pinned enemy-template and ability catalog content into the pure
 * monster action vocabulary. This is the only place that couples the closed
 * catalog schemas to the engine, so the ruleset module stays content-agnostic.
 */

export type PinnedEnemyDefinition = ReturnType<typeof enemyTemplateCatalogDefinitionSchema.parse>;
export type PinnedAbilityDefinition = ReturnType<typeof abilityCatalogDefinitionSchema.parse>;

/** Returns the executable melee attack step for an ability, or null. */
export function monsterAttackStepFromAbility(enemy: PinnedEnemyDefinition, ability: PinnedAbilityDefinition): MonsterAttackStep | null {
  const profile = enemy.mechanics.combatProfile;
  if (!profile) return null;
  const effect = ability.mechanics.effects[0] as
    | { type?: string; damageType?: string; dice?: { count?: number; sides?: number; modifier?: number } }
    | undefined;
  if (ability.mechanics.actionCost !== "action" || ability.mechanics.target !== "enemy" || effect?.type !== "damage") return null;
  const dice = effect.dice;
  if (!dice) return null;
  const { count, sides, modifier } = dice;
  if (typeof count !== "number" || typeof sides !== "number" || typeof modifier !== "number"
      || !Number.isInteger(count) || !Number.isInteger(sides) || !Number.isInteger(modifier)) return null;
  return Object.freeze({
    abilityId: ability.reference.definitionId,
    label: ability.name,
    attackBonus: profile.attack.attackBonus,
    damageDie: Object.freeze({ count, sides }),
    damageModifier: modifier,
    damageType: effect.damageType ?? "physical",
  });
}

/** The ordered executable attack steps available to a pinned enemy. */
export function monsterAttackStepsFromContent(enemy: PinnedEnemyDefinition, abilities: readonly PinnedAbilityDefinition[]): readonly MonsterAttackStep[] {
  return Object.freeze(abilities
    .map((ability) => monsterAttackStepFromAbility(enemy, ability))
    .filter((step): step is MonsterAttackStep => step !== null));
}

/**
 * Builds the highest-priority executable monster action for an enemy. A
 * multiattack shape wins; otherwise the primary attack is planned with any
 * referenced on-hit save rider (Wolf Knockdown); a standalone save action is
 * used when the enemy's first executable ability only forces a save.
 */
export function monsterActionPlanFromContent(enemy: PinnedEnemyDefinition, abilities: readonly PinnedAbilityDefinition[]): MonsterActionPlan | null {
  const steps = monsterAttackStepsFromContent(enemy, abilities);
  const multiattack = planMonsterMultiattack(enemy.reference.definitionId, steps);
  if (multiattack) return multiattack;
  const step = steps[0] ?? null;
  if (!step) {
    const standalone = abilities.map((ability) => planMonsterSave(ability.reference.definitionId)).find((plan): plan is MonsterSavePlan => plan !== null);
    return standalone ?? null;
  }
  const onHit = abilities.map((ability) => planMonsterSave(ability.reference.definitionId)).find((plan): plan is MonsterSavePlan => plan !== null);
  return Object.freeze({ kind: "attack", step, ...(onHit ? { onHit } : {}) });
}
