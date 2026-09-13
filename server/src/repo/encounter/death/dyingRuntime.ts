import type DatabaseDriver from "better-sqlite3";
import { dnd5eProficiencyBonus } from "../../../rulesets/index.js";
import {
  dnd5eStabilizationRollMode, planDnd5eDeathSave, planDnd5eStabilization,
} from "../../../rulesets/dnd5e/conditions.js";
import type { EncounterDependencies } from "../encounterWriteRepo.js";
import { setSurvival, survival } from "../actionExecution/survival.js";

export type DeathSaveResolution = Readonly<{
  roll: number;
  successes: number;
  failures: number;
  statusAfter: string;
  hitPointsAfter: number;
}>;

/**
 * Rolls and persists one SRD 5.1 death saving throw for a conscious-free
 * combatant. A natural 20 regains 1 hit point and clears the survival record;
 * three successes stabilize and three failures kill.
 */
export function resolveDeathSave(
  db: DatabaseDriver.Database, deps: EncounterDependencies,
  input: Readonly<{ encounterId: string; combatantId: string; hitPoints: number; status: string }>,
): DeathSaveResolution {
  const roll = deps.rng.integer(1, 21);
  if (!Number.isInteger(roll) || roll < 1 || roll > 20) throw new Error("combat RNG returned an out-of-range d20");
  const prior = survival(db, input.encounterId, input.combatantId);
  const plan = planDnd5eDeathSave({ roll, successes: prior.successes, failures: prior.failures });
  if (plan.regainsHitPoints > 0) {
    db.prepare("DELETE FROM combat_survival_v61 WHERE encounter_id=? AND combatant_id=?").run(input.encounterId, input.combatantId);
    return Object.freeze({ roll, successes: 0, failures: 0, statusAfter: "active", hitPointsAfter: plan.regainsHitPoints });
  }
  setSurvival(db, input.encounterId, input.combatantId, plan.successes, plan.failures, plan.stable);
  return Object.freeze({ roll, successes: plan.successes, failures: plan.failures, statusAfter: plan.status, hitPointsAfter: input.hitPoints });
}

const medicineProficiency = (db: DatabaseDriver.Database, campaignId: string, sheetId: string): boolean =>
  Boolean(db.prepare(`SELECT 1 FROM rpg_character_proficiencies
    WHERE campaign_id=? AND sheet_id=? AND category='skill' AND proficiency_id='medicine'`).get(campaignId, sheetId));

/** Resolves the Wisdom (Medicine) check, or a healer's kit auto-success, and persists stability. */
export function resolveStabilization(
  db: DatabaseDriver.Database, deps: EncounterDependencies,
  input: Readonly<{
    campaignId: string; encounterId: string; stabilizerActorId: string | null; targetCombatantId: string;
    targetStatus: string; healerKit?: boolean; ranged?: boolean; assisted?: boolean;
  }>,
) {
  const healerKit = Boolean(input.healerKit), ranged = Boolean(input.ranged), assisted = Boolean(input.assisted);
  const rollMode = dnd5eStabilizationRollMode({ assisted, ranged });
  let roll: number | null = null;
  let checkInput: { rolls: readonly number[]; wisdomScore: number; proficiencyBonus?: number } | undefined;
  if (!healerKit && input.stabilizerActorId) {
    const actor = db.prepare(`SELECT actor.sheet_id,progression.level,wisdom.value wisdom FROM campaign_actors actor
      JOIN character_progression_v23 progression ON progression.campaign_id=actor.campaign_id AND progression.actor_id=actor.id
      JOIN rpg_character_attributes wisdom ON wisdom.campaign_id=actor.campaign_id AND wisdom.sheet_id=actor.sheet_id AND wisdom.attribute_id='wisdom'
      WHERE actor.campaign_id=? AND actor.id=?`).get(input.campaignId, input.stabilizerActorId) as
      { sheet_id: string; level: number; wisdom: number } | undefined;
    if (actor && Number.isInteger(actor.wisdom) && Number.isInteger(actor.level)) {
      const rolls = [deps.rng.integer(1, 21)];
      if (rollMode !== "normal") rolls.push(deps.rng.integer(1, 21));
      if (rolls.some((value) => !Number.isInteger(value) || value < 1 || value > 20))
        throw new Error("combat RNG returned an out-of-range d20");
      roll = rollMode === "advantage" ? Math.max(...rolls) : rollMode === "disadvantage" ? Math.min(...rolls) : rolls[0]!;
      const proficient = medicineProficiency(db, input.campaignId, actor.sheet_id);
      checkInput = { rolls, wisdomScore: actor.wisdom, proficiencyBonus: proficient ? dnd5eProficiencyBonus(actor.level) : 0 };
    }
  }
  const plan = planDnd5eStabilization({ targetAtZeroHitPoints: true, targetStable: input.targetStatus === "stable",
    healerKit, ranged, assisted, ...(checkInput ? { checkInput } : {}) });
  if (plan.stabilized) setSurvival(db, input.encounterId, input.targetCombatantId, 0, 0, true);
  return Object.freeze({ roll, stabilized: plan.stabilized, statusAfter: plan.stabilized ? "stable" : input.targetStatus,
    healerKit, assisted, ranged, dc: plan.dc, rollMode, ...(plan.check ? { check: plan.check } : {}) });
}
