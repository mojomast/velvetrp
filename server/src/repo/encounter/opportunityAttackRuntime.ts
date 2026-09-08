import type DatabaseDriver from "better-sqlite3";
import { opportunityAttackReactionSchema, resourceIdSchema, type MapPoint } from "@velvet/contracts";
import type { IdGenerator, RandomNumberGenerator } from "../../runtime.js";
import { resolveCampaignRuleset } from "../../rulesets/campaignBinding.js";
import { resolveSrdEquipment } from "../srdEquipmentRuntime.js";
import { absorbDamage } from "./combatConditionRuntime.js";
import { EncounterConflictError } from "./encounterErrors.js";

export type OpportunityAttackDeps = { ids: IdGenerator; rng: RandomNumberGenerator };
export type ReactionAvailability = { combatantId: string; round: number; available: boolean; used: boolean };
const adjacent = (a: MapPoint, b: MapPoint) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) <= 1;

export function readReactionAvailability(db: DatabaseDriver.Database, encounterId: string, round: number): ReactionAvailability[] {
  return (db.prepare(`SELECT combatant.combatant_id,reaction.used FROM combatant LEFT JOIN combat_reaction_usage_v63 reaction
    ON reaction.encounter_id=combatant.encounter_id AND reaction.combatant_id=combatant.combatant_id AND reaction.round_number=? WHERE combatant.encounter_id=?
    AND combatant.status='active' ORDER BY combatant.combatant_id`).all(round, encounterId) as any[])
    .map((row) => ({ combatantId: row.combatant_id, round, available: row.used !== 1, used: row.used === 1 }));
}

function armorClass(db: DatabaseDriver.Database, encounterId: string, campaignId: string, target: any): number {
  if (target.actor_id) return resolveSrdEquipment(db, campaignId, target.actor_id).armorClass;
  const row = db.prepare(`SELECT definition.definition_json FROM encounter_enemy_provenance_v31 provenance
    JOIN rpg_catalog_definitions definition ON definition.pack_id=provenance.pack_id AND definition.pack_version=provenance.pack_version
    AND definition.kind=provenance.kind AND definition.definition_id=provenance.definition_id
    WHERE provenance.encounter_id=? AND provenance.combatant_id=?`).get(encounterId, target.combatant_id) as { definition_json: string } | undefined;
  const value = Number(row && JSON.parse(row.definition_json).mechanics.defense);
  if (!Number.isInteger(value)) throw new EncounterConflictError("opportunity attack target reach state is unavailable");
  return value;
}

/** Resolves automatic opportunity attacks. No client command can invoke this function. */
export function resolveOpportunityAttacks(db: DatabaseDriver.Database, deps: OpportunityAttackDeps, input: {
  encounterId: string; campaignId: string; round: number; movingCombatantId: string; from: MapPoint; to: MapPoint;
  transitionId: string; disengaged: boolean; occurredAt: string;
}): unknown[] {
  if (input.disengaged || input.from.x === input.to.x && input.from.y === input.to.y) return [];
  const transition = db.prepare(`SELECT 1 FROM combat_movement_transitions_v63
    WHERE transition_id=? AND encounter_id=? AND combatant_id=? AND round_number=?
      AND from_x=? AND from_y=? AND to_x=? AND to_y=?`).get(input.transitionId, input.encounterId, input.movingCombatantId,
    input.round, input.from.x, input.from.y, input.to.x, input.to.y);
  if (!transition) throw new EncounterConflictError("opportunity attack movement transition is unavailable");
  let binding: ReturnType<typeof resolveCampaignRuleset>;
  try { binding = resolveCampaignRuleset(db, input.campaignId); } catch { throw new EncounterConflictError("opportunity attack ruleset is unavailable"); }
  if (binding.rulesetId !== "dnd-5e") return [];
  const mover = db.prepare("SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'").get(input.encounterId, input.movingCombatantId) as any;
  if (!mover) throw new EncounterConflictError("opportunity attack mover is unavailable");
  const reactors = db.prepare(`SELECT * FROM combatant WHERE encounter_id=? AND status='active' AND team<>? ORDER BY combatant_id`).all(input.encounterId, mover.team) as any[];
  const results: unknown[] = [];
  for (const reactor of reactors) {
    const token = db.prepare("SELECT x,y FROM tactical_map_tokens_v58 WHERE combatant_id=? AND map_id=(SELECT map_id FROM tactical_maps_v58 WHERE encounter_id=? AND active=1)").get(reactor.combatant_id, input.encounterId) as {x:number;y:number}|undefined;
    const moverToken = db.prepare("SELECT x,y FROM tactical_map_tokens_v58 WHERE combatant_id=? AND map_id=(SELECT map_id FROM tactical_maps_v58 WHERE encounter_id=? AND active=1)").get(input.movingCombatantId, input.encounterId) as {x:number;y:number}|undefined;
    // Tactical movement can exist without a combatant token (for example during
    // legacy map setup). In that case there is no authoritative reach proof, so
    // movement succeeds without advertising or resolving an opportunity attack.
    if (!token || !moverToken) return [];
    const before = input.from, after = input.to;
    if (!adjacent(before, {x:token.x,y:token.y}) || adjacent(after, {x:token.x,y:token.y})) continue;
    const used = db.prepare(`INSERT INTO combat_reaction_usage_v63(encounter_id,combatant_id,round_number,used,used_at) VALUES(?,?,?,1,?)
      ON CONFLICT(encounter_id,combatant_id,round_number) DO UPDATE SET used=1,used_at=excluded.used_at WHERE combat_reaction_usage_v63.used=0`).run(input.encounterId, reactor.combatant_id, input.round, input.occurredAt);
    if (used.changes !== 1) continue;
    let attackBonus = 0, damageModifier = 0, proficiencyBonus = 2, die = { count: 1, sides: 6, modifier: 0 }, attackAbility = 10;
    if (reactor.actor_id) {
      const equipment = resolveSrdEquipment(db, input.campaignId, reactor.actor_id);
      if (!equipment.weapon) throw new EncounterConflictError("opportunity attack weapon is unavailable");
      die = { ...equipment.weapon.damage.die, modifier: 0 }; const ability = db.prepare("SELECT value FROM rpg_character_attributes a JOIN campaign_actors c ON c.sheet_id=a.sheet_id WHERE c.campaign_id=? AND c.id=? AND a.attribute_id=?").get(input.campaignId, reactor.actor_id, equipment.weapon.attackAbility) as {value:number}|undefined;
      if (!ability) throw new EncounterConflictError("opportunity attack ability is unavailable"); attackAbility = ability.value; damageModifier = binding.module.abilityModifier(ability.value);
      const sheet = db.prepare("SELECT progression.level FROM campaign_actors actor JOIN character_progression_v23 progression ON progression.actor_id=actor.id WHERE actor.campaign_id=? AND actor.id=?").get(input.campaignId, reactor.actor_id) as {level:number}|undefined;
      proficiencyBonus = binding.module.proficiencyBonus(sheet?.level ?? 1);
    } else {
      const definition = JSON.parse((db.prepare(`SELECT definition.definition_json FROM encounter_enemy_provenance_v31 provenance JOIN rpg_catalog_definitions definition ON definition.pack_id=provenance.pack_id AND definition.pack_version=provenance.pack_version AND definition.kind=provenance.kind AND definition.definition_id=provenance.definition_id WHERE provenance.combatant_id=?`).get(reactor.combatant_id) as any).definition_json);
      const profile = definition.mechanics.combatProfile, effect = definition.mechanics.effects?.[0];
      if (!profile || !effect?.dice) throw new EncounterConflictError("opportunity attack profile is unavailable");
      attackBonus = profile.attack.attackBonus; die = { ...effect.dice, modifier: effect.dice.modifier ?? 0 }; damageModifier = die.modifier;
    }
    const roll = deps.rng.integer(1, 21); if (roll < 1 || roll > 20) throw new Error("combat RNG returned an out-of-range d20");
    const attack = binding.module.mechanics!.resolveAttack({ rolls: [roll], abilityScore: attackAbility, proficiencyBonus, flatBonus: attackBonus - proficiencyBonus, armorClass: armorClass(db, input.encounterId, input.campaignId, mover) });
    const rolls = attack.hit ? Array.from({length: die.count * (attack.critical ? 2 : 1)}, () => deps.rng.integer(1, die.sides + 1)) : [];
    const damage = attack.hit ? binding.module.mechanics!.resolveDamageRoll({ dice: [die], rolls: [rolls], modifier: damageModifier, critical: attack.critical }).total : 0;
    const absorbed = absorbDamage(db, input.encounterId, mover.combatant_id, damage, input.occurredAt); const hp = Math.max(0, mover.hit_points - absorbed.hitPointDamage);
    const status = mover.actor_id ? (mover.hit_points > 0 && hp === 0 ? "unconscious" : mover.status) : (hp === 0 ? "defeated" : mover.status);
    db.prepare("UPDATE combatant SET hit_points=?,status=CASE WHEN ?='unconscious' THEN 'unconscious' ELSE status END,state_revision=state_revision+1,updated_at=? WHERE encounter_id=? AND combatant_id=? AND hit_points=?").run(hp,status,input.occurredAt,input.encounterId,mover.combatant_id,mover.hit_points);
    if (mover.actor_id) db.prepare("UPDATE rpg_actor_resources SET current=? WHERE campaign_id=? AND actor_id=? AND name='health' AND current=?").run(hp,input.campaignId,mover.actor_id,mover.hit_points);
    const reaction = opportunityAttackReactionSchema.parse({reactionId: resourceIdSchema.parse(deps.ids.nextId()),reactorCombatantId:reactor.combatant_id,targetCombatantId:mover.combatant_id,round:input.round,trigger:"left-reach"});
    const result = {...reaction, outcome:{hit:attack.hit,attackRoll:roll,damage,hitPointsBefore:mover.hit_points,hitPointsAfter:hp,statusAfter:status}};
    results.push(result);
    mover.hit_points = hp;
    mover.status = status;
  }
  return results;
}
