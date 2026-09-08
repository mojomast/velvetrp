import { describe, expect, it } from "vitest";
import {
  deriveDnd5eCharacter, planDnd5eAction, planDnd5eConcentrationReplacement, planDnd5eCondition,
  planDnd5eMovement, planDnd5eResourceCosts, planDnd5eRest, planDnd5eSpellCost,
  type AbilityId,
} from "../src/rulesets/index.js";

describe("SRD state and cost plans", () => {
  it("calculates movement cost for terrain, special modes, and Dash", () => {
    expect(planDnd5eMovement({ distance: 15, speed: 30 })).toMatchObject({ cost: 15, budget: 30, remaining: 15, legal: true });
    expect(planDnd5eMovement({ distance: 15, speed: 30, mode: "climb", difficultTerrain: true })).toMatchObject({ cost: 45, legal: false });
    expect(planDnd5eMovement({ distance: 30, speed: 30, mode: "swim", specialSpeed: 30, dash: true })).toMatchObject({ cost: 30, budget: 60, remaining: 30, legal: true });
  });

  it("plans short and long rest recovery without mutating state", () => {
    expect(planDnd5eRest({ kind: "short", currentHitPoints: 5, maxHitPoints: 20, hitDiceRemaining: 2, level: 3, hitDiceSpent: [{ die: 6, constitutionModifier: 2 }] })).toMatchObject({ hitPointsRecovered: 8, resultingHitPoints: 13, hitDiceSpent: 1, legal: true });
    expect(planDnd5eRest({ kind: "long", currentHitPoints: 1, maxHitPoints: 20, hitDiceRemaining: 0, level: 5, exhausted: true })).toMatchObject({ hitPointsRecovered: 19, resultingHitPoints: 20, hitDiceRecovered: 2, clearExhaustionLevels: 1 });
    expect(planDnd5eRest({ kind: "short", currentHitPoints: 5, maxHitPoints: 20, hitDiceRemaining: 0, level: 1, hitDiceSpent: [{ die: 4, constitutionModifier: 0 }] }).legal).toBe(false);
  });

  it("returns idempotent immutable condition plans", () => {
    const add = planDnd5eCondition(["prone"], "add", "poisoned");
    expect(add).toMatchObject({ before: ["prone"], after: ["prone", "poisoned"], changed: true });
    expect(planDnd5eCondition(add.after, "add", "poisoned").changed).toBe(false);
    expect(planDnd5eCondition(add.after, "remove", "prone").after).toEqual(["poisoned"]);
    expect(Object.isFrozen(add.after)).toBe(true);
  });

  it("aggregates resource costs atomically", () => {
    const pools = [{ id: "ki", current: 3, maximum: 5 }, { id: "rage", current: 1, maximum: 2 }];
    expect(planDnd5eResourceCosts(pools, [{ resourceId: "ki", amount: 1 }, { resourceId: "ki", amount: 2 }])).toMatchObject({ legal: true, resultingPools: [{ id: "ki", current: 0, maximum: 5 }, { id: "rage", current: 1, maximum: 2 }] });
    expect(planDnd5eResourceCosts(pools, [{ resourceId: "ki", amount: 4 }])).toMatchObject({ legal: false, resultingPools: pools });
  });

  it("plans cantrip, leveled spell slot, upcast, and material costs", () => {
    expect(planDnd5eSpellCost({ spellLevel: 0, slotLevel: 0, slots: {} })).toMatchObject({ legal: true, resultingSlots: {} });
    expect(planDnd5eSpellCost({ spellLevel: 2, slotLevel: 3, slots: { 2: 1, 3: 2 } })).toMatchObject({ legal: true, resultingSlots: { 2: 1, 3: 1 } });
    expect(planDnd5eSpellCost({ spellLevel: 3, slotLevel: 2, slots: { 2: 1 } }).legal).toBe(false);
    expect(planDnd5eSpellCost({ spellLevel: 1, slotLevel: 1, slots: { 1: 1 }, consumesMaterial: true, materialAvailable: false }).legal).toBe(false);
  });

  it("derives modifiers, AC, initiative, perception, proficiency, and speed", () => {
    const abilityScores = Object.fromEntries((["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"] as AbilityId[]).map((id) => [id, 10])) as Record<AbilityId, number>;
    abilityScores.dexterity = 18; abilityScores.wisdom = 16;
    expect(deriveDnd5eCharacter({ level: 5, abilityScores, armorBase: 14, armorDexterity: "maximum-2", shieldBonus: 2, speed: 30, perceptionExpertise: true })).toEqual({ abilityModifiers: { strength: 0, dexterity: 4, constitution: 0, intelligence: 0, wisdom: 3, charisma: 0 }, proficiencyBonus: 3, armorClass: 18, initiativeModifier: 4, passivePerception: 19, speed: 30 });
  });

  it("uses a common legal-action envelope and explicit concentration replacement", () => {
    expect(planDnd5eAction("drink-potion", [], { healing: 5 })).toEqual({ kind: "drink-potion", legal: true, reasons: [], result: { healing: 5 } });
    expect(planDnd5eAction("drink-potion", ["no potion"], { healing: 5 }).result).toBeNull();
    expect(planDnd5eConcentrationReplacement("bless", "haste")).toMatchObject({ legal: true, result: { endEffectId: "bless", startEffectId: "haste" } });
  });
});
