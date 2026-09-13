import type {
  DamageAdjustment, DamageAdjustmentPlan, DamageRollInput, DamageRollResolution,
} from "../types.js";
import { frozenList, requireInteger, requireNonNegativeInteger } from "./internal.js";

export function resolveDnd5eDamageRoll(input: DamageRollInput): DamageRollResolution {
  if (input.rolls.length !== input.dice.length) throw new RangeError("damage roll groups must match dice terms");
  const critical = input.critical ?? false;
  const evidence = input.dice.map((term, index) => {
    requireNonNegativeInteger(term.count, "die count");
    requireInteger(term.sides, "die sides");
    if (term.sides < 2) throw new RangeError("die sides must be at least 2");
    const rolls = input.rolls[index]!;
    const expected = term.count * (critical ? 2 : 1);
    if (rolls.length !== expected) throw new RangeError(`damage term requires exactly ${expected} rolls`);
    rolls.forEach((roll) => {
      requireInteger(roll, "damage die");
      if (roll < 1 || roll > term.sides) throw new RangeError(`damage die must be between 1 and ${term.sides}`);
    });
    return Object.freeze({ ...term, rolls: frozenList(rolls), subtotal: rolls.reduce((sum, roll) => sum + roll, 0) });
  });
  const modifier = input.modifier ?? 0;
  requireInteger(modifier, "damage modifier");
  return Object.freeze({ critical, evidence: frozenList(evidence), modifier, total: Math.max(0, evidence.reduce((sum, term) => sum + term.subtotal, 0) + modifier) });
}

export function planDnd5eDamageAdjustment(incoming: number, adjustment: DamageAdjustment): DamageAdjustmentPlan {
  requireNonNegativeInteger(incoming, "incoming damage");
  const applied = adjustment === "immunity" ? 0 : adjustment === "resistance" ? Math.floor(incoming / 2) : adjustment === "vulnerability" ? incoming * 2 : incoming;
  return Object.freeze({ incoming, adjustment, applied, hitPointDelta: applied === 0 ? 0 : -applied });
}
