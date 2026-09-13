import type DatabaseDriver from "better-sqlite3";
import type { AttackRider } from "./types.js";

/**
 * Declarative on-hit rider catalog. Published starter content intentionally
 * carries these abilities as metadata only, so the executable rider mechanics
 * live here as bounded data rather than as content edits. A rider is attached
 * to an attack when the attacker knows the matching ability definition.
 */
export const SNEAK_ATTACK_ABILITY_ID = "srd-5.1:ability:rogue-sneak-attack";
export const DIVINE_SMITE_ABILITY_ID = "srd-5.1:ability:paladin-divine-smite";
export const KNOCKDOWN_ABILITY_ID = "srd-5.1:ability:wolf-knockdown";

const SNEAK_ATTACK: AttackRider = Object.freeze({
  riderId: "sneak-attack",
  label: "Sneak Attack",
  source: Object.freeze({ kind: "ability", packId: "", packVersion: "", definitionId: SNEAK_ATTACK_ABILITY_ID }),
  requiresAdvantage: true,
  limit: "once-per-turn",
  damage: Object.freeze({ damageType: "physical", dice: Object.freeze([Object.freeze({ count: 1, sides: 6 })]) }),
});

const DIVINE_SMITE: AttackRider = Object.freeze({
  riderId: "divine-smite",
  label: "Divine Smite",
  source: Object.freeze({ kind: "ability", packId: "", packVersion: "", definitionId: DIVINE_SMITE_ABILITY_ID }),
  limit: "once-per-attack",
  damage: Object.freeze({ damageType: "radiant", dice: Object.freeze([Object.freeze({ count: 2, sides: 8 })]) }),
});

const KNOCKDOWN: AttackRider = Object.freeze({
  riderId: "knockdown",
  label: "Knockdown",
  source: Object.freeze({ kind: "ability", packId: "", packVersion: "", definitionId: KNOCKDOWN_ABILITY_ID }),
  condition: Object.freeze({ condition: "prone" }),
  effect: Object.freeze({ kind: "prone", label: "target knocked prone" }),
});

/** Rider templates keyed by the exact immutable ability definition id. */
export const ATTACK_RIDER_CATALOG: Readonly<Record<string, AttackRider>> = Object.freeze({
  [SNEAK_ATTACK_ABILITY_ID]: SNEAK_ATTACK,
  [DIVINE_SMITE_ABILITY_ID]: DIVINE_SMITE,
  [KNOCKDOWN_ABILITY_ID]: KNOCKDOWN,
});

/**
 * Builds the declarative riders currently attached to an actor's attacks from
 * its immutable known-power grants. Unknown abilities contribute no rider.
 */
export function buildAttackRiderPlans(
  db: DatabaseDriver.Database, campaignId: string, actorId: string,
): readonly AttackRider[] {
  const rows = db.prepare(`SELECT power.pack_id,power.pack_version,power.definition_id
    FROM campaign_actors actor JOIN character_known_powers_v23 power
      ON power.campaign_character_id=actor.campaign_character_id
    WHERE actor.campaign_id=? AND actor.id=? ORDER BY power.definition_id`).all(campaignId, actorId) as Array<{
      pack_id: string; pack_version: string; definition_id: string;
    }>;
  const riders: AttackRider[] = [];
  for (const row of rows) {
    const template = ATTACK_RIDER_CATALOG[row.definition_id];
    if (!template) continue;
    riders.push(Object.freeze({
      ...template,
      source: Object.freeze({ kind: "ability", packId: row.pack_id, packVersion: row.pack_version, definitionId: row.definition_id }),
    }));
  }
  return Object.freeze(riders);
}
