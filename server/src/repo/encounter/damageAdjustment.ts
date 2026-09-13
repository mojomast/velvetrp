import type DatabaseDriver from "better-sqlite3";
import { planDnd5eDamageAdjustment } from "../../rulesets/index.js";

export type CombatDamageTarget = { actor_id: string | null; combatant_id: string };
/** Runtime vocabulary used by combat outcomes; the pure module names "none" as "normal". */
export type CombatDamageAdjustment = "none" | "resistance" | "vulnerability" | "immunity";

/**
 * SRD 5.1 damage-type adjustment for one target. Actor targets read active
 * effect modifiers; enemy targets read the exact pinned enemy definition.
 * Immunity wins, and resistance plus vulnerability cancel.
 */
export function resolveCombatDamageAdjustment(db: DatabaseDriver.Database, campaignId: string, target: CombatDamageTarget,
  type: string, at: string,
): CombatDamageAdjustment {
  const values: CombatDamageAdjustment[] = [];
  if (target.actor_id) {
    const rows = db.prepare(`SELECT modifier_kind kind FROM rpg_active_effects_v26 effect JOIN rpg_effect_modifiers_v26 modifier USING(effect_id)
      WHERE effect.campaign_id=? AND effect.actor_id=? AND effect.status='active'
        AND (effect.duration_kind<>'rounds' OR effect.remaining_rounds>0)
        AND (effect.duration_kind<>'until_timestamp' OR effect.expires_at>?)
        AND modifier.applies_to_id IN (?, 'all')`).all(campaignId, target.actor_id, at, type) as Array<{ kind: CombatDamageAdjustment }>;
    for (const row of rows) values.push(row.kind);
  } else {
    const raw = db.prepare(`SELECT definition.definition_json FROM encounter_enemy_provenance_v31 provenance
      JOIN rpg_catalog_definitions definition ON definition.pack_id=provenance.pack_id AND definition.pack_version=provenance.pack_version
        AND definition.kind=provenance.kind AND definition.definition_id=provenance.definition_id
      WHERE provenance.combatant_id=?`).get(target.combatant_id) as { definition_json: string } | undefined;
    if (raw) {
      const enemy = JSON.parse(raw.definition_json);
      if (enemy.mechanics.immunities.includes(type)) values.push("immunity");
      if (enemy.mechanics.resistances.includes(type)) values.push("resistance");
      if (enemy.mechanics.vulnerabilities.includes(type)) values.push("vulnerability");
    }
  }
  if (values.includes("immunity")) return "immunity";
  const resistant = values.includes("resistance"), vulnerable = values.includes("vulnerability");
  return resistant === vulnerable ? "none" : resistant ? "resistance" : "vulnerability";
}

/** Applies the shared pure SRD adjustment math to one incoming damage amount. */
export function adjustedCombatDamage(incoming: number, adjustment: CombatDamageAdjustment): number {
  return planDnd5eDamageAdjustment(incoming, adjustment === "none" ? "normal" : adjustment).applied;
}
