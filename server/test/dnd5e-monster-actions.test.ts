import { describe, expect, it } from "vitest";
import { SRD_5_1_STARTER_CATALOG } from "../src/content/srdStarterCatalog.js";
import {
  planMonsterMultiattack, planMonsterRecharge, planMonsterSave, resolveMonsterAttack, resolveMonsterRecharge,
  type MonsterAttackPlan, type MonsterRechargePlan, type MonsterRng, type MonsterSavePlan,
} from "../src/rulesets/dnd5e/monsters.js";
import { monsterActionPlanFromContent, monsterAttackStepsFromContent } from "../src/repo/encounter/monster/content.js";
import {
  beginMonsterTurn, executeMonsterAction, spendMonsterAbility,
  type MonsterAttackOutcome, type MonsterSaveActionOutcome,
} from "../src/repo/encounter/monster/execute.js";

const definitions = SRD_5_1_STARTER_CATALOG.definitions as any[];
const byReference = (kind: string, definitionId: string) =>
  definitions.find((definition) => definition.reference.kind === kind && definition.reference.definitionId === definitionId);

const GOBLIN = "srd-5.1:enemy-template:goblin";
const GOBLIN_SCIMITAR = "srd-5.1:ability:goblin-scimitar";
const BANDIT = "srd-5.1:enemy-template:bandit";
const BANDIT_SCIMITAR = "srd-5.1:ability:bandit-scimitar";
const WOLF = "srd-5.1:enemy-template:wolf";
const WOLF_BITE = "srd-5.1:ability:wolf-bite";
const WOLF_KNOCKDOWN = "srd-5.1:ability:wolf-knockdown";
const RECHARGE = "velvet:test-fixture:ability:recharge-5-6";

function scriptedRng(...values: number[]): MonsterRng {
  let index = 0;
  return {
    integer: (min, max) => {
      if (index >= values.length) throw new Error("scripted RNG exhausted");
      const value = values[index++]!;
      if (value < min || value >= max) throw new Error(`scripted roll ${value} is outside [${min}, ${max})`);
      return value;
    },
  };
}

const goblinMultiattackPlan = () => {
  const goblin = byReference("enemy-template", GOBLIN);
  const scimitar = byReference("ability", GOBLIN_SCIMITAR);
  const steps = monsterAttackStepsFromContent(goblin, [scimitar]);
  const plan = planMonsterMultiattack(GOBLIN, steps);
  if (!plan) throw new Error("Goblin multiattack plan is unavailable");
  return { goblin, scimitar, steps, plan };
};

describe("SRD 5.1 monster action engine", () => {
  it("plans the Goblin's SRD multiattack as an ordered two-scimitar sequence", () => {
    const { scimitar, steps, plan } = goblinMultiattackPlan();
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      abilityId: GOBLIN_SCIMITAR, attackBonus: 4, damageType: "slashing", damageDie: { count: 1, sides: 6 }, damageModifier: 2,
    });
    expect(plan.kind).toBe("multiattack");
    expect(plan.sequence.map((step) => step.abilityId)).toEqual([GOBLIN_SCIMITAR, GOBLIN_SCIMITAR]);
    expect(plan.sequence[0]).toEqual(plan.sequence[1]);
    expect(scimitar).toBeDefined();
  });

  it("executes one ordered attack outcome per multiattack step with injected dice", () => {
    const { plan } = goblinMultiattackPlan();
    const receipt = executeMonsterAction({
      encounterId: "encounter", combatantId: "goblin-1", round: 1, actionId: "action-1", legalActionId: "attack:goblin:multiattack",
      plan, target: { combatantId: "hero", armorClass: 13, saveBonus: 0 }, rng: scriptedRng(10, 5, 12, 3),
    });
    expect(receipt.action).toBe("multiattack");
    expect(receipt.encounterId).toBe("encounter");
    expect(receipt.outcomes).toHaveLength(2);
    expect(receipt.outcomes[0]).toMatchObject({
      kind: "attack", stepIndex: 0, abilityId: GOBLIN_SCIMITAR, targetId: "hero",
      attackRoll: 10, attackTotal: 14, armorClass: 13, hit: true, critical: false, damageRolls: [5], damage: 7,
    });
    expect(receipt.outcomes[1]).toMatchObject({
      kind: "attack", stepIndex: 1, attackRoll: 12, attackTotal: 16, hit: true, damageRolls: [3], damage: 5,
    });
  });

  it("handles natural 1 misses and natural 20 critical damage dice", () => {
    const { steps } = goblinMultiattackPlan();
    const step = steps[0]!;
    const miss = resolveMonsterAttack(step, { armorClass: 13, rng: scriptedRng(1) });
    expect(miss).toMatchObject({ hit: false, damage: 0, damageRolls: [] });
    const critical = resolveMonsterAttack(step, { armorClass: 13, rng: scriptedRng(20, 6, 6) });
    expect(critical).toMatchObject({ hit: true, critical: true, damageRolls: [6, 6], damage: 14 });
  });

  it("reproduces identical receipts for identical injected dice", () => {
    const { plan } = goblinMultiattackPlan();
    const run = () => executeMonsterAction({
      encounterId: "encounter", combatantId: "goblin-1", round: 1, actionId: "action-1", legalActionId: "attack:goblin:multiattack",
      plan, target: { combatantId: "hero", armorClass: 13, saveBonus: 0 }, rng: scriptedRng(10, 5, 12, 3),
    });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });

  it("resolves a recharge range deterministically and restores it only on a start-of-turn success", () => {
    const plan = planMonsterRecharge(RECHARGE) as MonsterRechargePlan;
    expect(plan).toMatchObject({ kind: "recharge", abilityId: RECHARGE, min: 5, max: 6 });
    expect(resolveMonsterRecharge(plan, false, 6)).toMatchObject({ ready: true, restored: false, spentAfter: false });
    expect(resolveMonsterRecharge(plan, true, 3)).toMatchObject({ ready: false, restored: false, spentAfter: true });
    expect(resolveMonsterRecharge(plan, true, 5)).toMatchObject({ ready: true, restored: true, spentAfter: false });
    expect(() => resolveMonsterRecharge(plan, true, 7)).toThrow(/recharge roll/);

    let rolls = 0;
    const countingRng: MonsterRng = { integer: () => { rolls += 1; return 4; } };
    const first = beginMonsterTurn({ plans: [plan], spent: [], rng: countingRng });
    expect(rolls).toBe(0);
    expect(first.ready).toContain(RECHARGE);
    const spent = spendMonsterAbility([], RECHARGE);
    expect(spent).toEqual([RECHARGE]);
    const failed = beginMonsterTurn({ plans: [plan], spent, rng: scriptedRng(4) });
    expect(failed.recharges[0]).toMatchObject({ roll: 4, restored: false, spentAfter: true });
    expect(failed.ready).not.toContain(RECHARGE);
    expect(failed.spent).toEqual([RECHARGE]);
    const restored = beginMonsterTurn({ plans: [plan], spent, rng: scriptedRng(6) });
    expect(restored.recharges[0]).toMatchObject({ roll: 6, restored: true, spentAfter: false });
    expect(restored.ready).toContain(RECHARGE);
    expect(restored.spent).toEqual([]);
  });

  it("does not invent recharge or save metadata for unsupported abilities", () => {
    expect(planMonsterRecharge(GOBLIN_SCIMITAR)).toBeNull();
    expect(planMonsterSave(GOBLIN_SCIMITAR)).toBeNull();
  });

  it("treats the Wolf's knockdown as a save-based on-hit rider with failure and no-op success", () => {
    const wolf = byReference("enemy-template", WOLF);
    const bite = byReference("ability", WOLF_BITE);
    const packTactics = byReference("ability", "srd-5.1:ability:wolf-pack-tactics");
    const knockdown = byReference("ability", WOLF_KNOCKDOWN);
    expect(planMonsterSave(WOLF_KNOCKDOWN)).toMatchObject({
      kind: "save", ability: "strength", dc: 11,
      onFail: [{ kind: "condition", condition: "prone" }], onSuccess: [],
    });
    const plan = monsterActionPlanFromContent(wolf, [bite, packTactics, knockdown]) as MonsterAttackPlan;
    expect(plan.kind).toBe("attack");
    expect(plan.onHit).toMatchObject({ ability: "strength", dc: 11 });

    const failed = executeMonsterAction({
      encounterId: "encounter", combatantId: "wolf-1", round: 2, actionId: "action-2", legalActionId: "attack:wolf:knockdown",
      plan, target: { combatantId: "hero", armorClass: 13, saveBonus: 0 }, rng: scriptedRng(15, 4, 3, 5),
    });
    const failedOutcome = failed.outcomes[0] as MonsterAttackOutcome;
    expect(failedOutcome).toMatchObject({ kind: "attack", hit: true, damage: 9 });
    expect(failedOutcome.rider).toMatchObject({ ability: "strength", dc: 11, roll: 5, total: 5, success: false, outcome: "full" });
    expect(failedOutcome.rider?.applied).toEqual([{ kind: "condition", condition: "prone" }]);

    const saved = executeMonsterAction({
      encounterId: "encounter", combatantId: "wolf-1", round: 2, actionId: "action-2", legalActionId: "attack:wolf:knockdown",
      plan, target: { combatantId: "hero", armorClass: 13, saveBonus: 0 }, rng: scriptedRng(15, 4, 3, 15),
    });
    const savedOutcome = saved.outcomes[0] as MonsterAttackOutcome;
    expect(savedOutcome.rider).toMatchObject({ success: true, outcome: "none" });
    expect(savedOutcome.rider?.applied).toEqual([]);
  });

  it("executes a standalone save action with full failure and partial success riders", () => {
    const plan: MonsterSavePlan = Object.freeze({
      kind: "save", abilityId: "velvet:test-fixture:ability:chilling-howl", ability: "constitution", dc: 12,
      onFail: Object.freeze([Object.freeze({ kind: "damage", damageDie: { count: 2, sides: 6 }, damageModifier: 1, damageType: "cold" })]),
      onSuccess: Object.freeze([Object.freeze({ kind: "damage", damageDie: { count: 1, sides: 6 }, damageModifier: 0, damageType: "cold" })]),
    });
    const failed = executeMonsterAction({
      encounterId: "encounter", combatantId: "hag-1", round: 3, actionId: "action-3", legalActionId: "save:hag:howl",
      plan, target: { combatantId: "hero", armorClass: 15, saveBonus: 2 }, rng: scriptedRng(5, 4, 3),
    });
    const failedOutcome = failed.outcomes[0] as MonsterSaveActionOutcome;
    expect(failedOutcome).toMatchObject({ kind: "save", targetId: "hero", ability: "constitution", dc: 12, roll: 5, total: 7, success: false, outcome: "full" });
    expect(failedOutcome.applied).toEqual([{ kind: "damage", damageType: "cold", damageRolls: [4, 3], damage: 8 }]);

    const saved = executeMonsterAction({
      encounterId: "encounter", combatantId: "hag-1", round: 3, actionId: "action-3", legalActionId: "save:hag:howl",
      plan, target: { combatantId: "hero", armorClass: 15, saveBonus: 2 }, rng: scriptedRng(15, 5),
    });
    const savedOutcome = saved.outcomes[0] as MonsterSaveActionOutcome;
    expect(savedOutcome).toMatchObject({ roll: 15, total: 17, success: true, outcome: "partial" });
    expect(savedOutcome.applied).toEqual([{ kind: "damage", damageType: "cold", damageRolls: [5], damage: 5 }]);
  });

  it("keeps Bandit and Training Dummy on their bounded single-attack plans", () => {
    const bandit = byReference("enemy-template", BANDIT);
    const banditScimitar = byReference("ability", BANDIT_SCIMITAR);
    const banditSteps = monsterAttackStepsFromContent(bandit, [banditScimitar]);
    expect(planMonsterMultiattack(BANDIT, banditSteps)).toBeNull();
    const banditPlan = monsterActionPlanFromContent(bandit, [banditScimitar]) as MonsterAttackPlan;
    expect(banditPlan).toMatchObject({ kind: "attack" });
    expect(banditPlan.onHit).toBeUndefined();

    const dummy = byReference("enemy-template", "velvet:test-fixture:enemy-template:training-dummy");
    const basicAttack = byReference("ability", "srd-5.1:ability:longsword-attack");
    const dummyPlan = monsterActionPlanFromContent(dummy, [basicAttack]) as MonsterAttackPlan;
    expect(dummyPlan).toMatchObject({ kind: "attack" });
    const receipt = executeMonsterAction({
      encounterId: "encounter", combatantId: "dummy-1", round: 1, actionId: "action-4", legalActionId: "attack:basic",
      plan: dummyPlan, target: { combatantId: "hero", armorClass: 10, saveBonus: 0 }, rng: scriptedRng(15, 8),
    });
    expect(receipt.outcomes[0]).toMatchObject({ kind: "attack", hit: true, damageRolls: [8], damageType: "physical" });
  });
});
