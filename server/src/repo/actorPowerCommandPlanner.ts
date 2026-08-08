import type DatabaseDriver from "better-sqlite3";
import {
  abilityCatalogDefinitionSchema, actorPowerLegalCommandSchema, powerReferenceSchema,
  spellCatalogDefinitionSchema, type ActorPowerCommandRequest, type PowerReference,
} from "@velvet/contracts";

type Definition = any;
export type ActorPowerCommandPlan = ReturnType<typeof actorPowerLegalCommandSchema.parse> & { definition: Definition };
const key = (value: PowerReference) => `${value.kind}\0${value.packId}\0${value.packVersion}\0${value.definitionId}`;

function recoveredAt(db: DatabaseDriver.Database, campaignId: string, actorId: string, recovery: string): string | null {
  if (recovery === "short-rest" || recovery === "long-rest") {
    const kinds = recovery === "short-rest" ? ["short", "long"] : ["long"];
    return (db.prepare(`SELECT max(occurred_at) occurred_at FROM rpg_rest_receipts_v25
      WHERE campaign_id=? AND actor_id=? AND rest_kind IN (${kinds.map(() => "?").join(",")})`)
      .get(campaignId, actorId, ...kinds) as { occurred_at: string | null }).occurred_at;
  }
  if (recovery === "encounter") return (db.prepare(`SELECT max(encounter.updated_at) occurred_at FROM encounter
    JOIN combatant ON combatant.encounter_id=encounter.encounter_id AND combatant.campaign_id=encounter.campaign_id
    WHERE encounter.campaign_id=? AND combatant.actor_id=? AND encounter.status='completed'`)
    .get(campaignId, actorId) as { occurred_at: string | null }).occurred_at;
  return null;
}

function hasRequiredResources(db: DatabaseDriver.Database, campaignId: string, actorId: string, definition: Definition): boolean {
  const resources = new Set((db.prepare("SELECT name FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=?")
    .all(campaignId, actorId) as Array<{ name: string }>).map((row) => row.name));
  return definition.mechanics.effects.every((effect: any) => {
    const resource = effect.type === "damage" || effect.type === "healing" ? "health"
      : effect.type === "resource" ? (effect.resource === "spell-slot" && definition.reference.kind === "spell" && definition.mechanics.level > 0 ? `slot-${definition.mechanics.level}` : effect.resource) : null;
    return resource === null || (resource !== "spell-slot" && resources.has(resource));
  });
}

/** Shared read/write planner. It performs no mutation and is safe inside either transaction mode. */
export function planActorPowerCommands(db: DatabaseDriver.Database, campaignId: string, actorId: string): ActorPowerCommandPlan[] {
  const rows = db.prepare(`SELECT known.kind,known.pack_id,known.pack_version,known.definition_id,visibility.public_definition_json
    FROM campaign_actors actor JOIN character_known_powers_v23 known ON known.campaign_character_id=actor.campaign_character_id
    JOIN campaign_catalog_current_pins pin ON pin.campaign_id=actor.campaign_id AND pin.pack_id=known.pack_id AND pin.pack_version=known.pack_version
    JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=known.pack_id AND visibility.pack_version=known.pack_version
      AND visibility.kind=known.kind AND visibility.definition_id=known.definition_id AND visibility.publicly_reachable=1
    JOIN rpg_campaign_catalog_definitions_v25 execution ON execution.campaign_id=actor.campaign_id
      AND execution.pack_id=known.pack_id AND execution.pack_version=known.pack_version AND execution.kind=known.kind AND execution.definition_id=known.definition_id
    WHERE actor.campaign_id=? AND actor.id=? ORDER BY known.kind,known.pack_id,known.pack_version,known.definition_id`)
    .all(campaignId, actorId) as Array<{ kind: "ability" | "spell"; pack_id: string; pack_version: string; definition_id: string; public_definition_json: string }>;
  const targetRows = db.prepare(`SELECT actor.id actor_id,persona.name label FROM campaign_actors actor
    LEFT JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
    LEFT JOIN characters persona ON persona.id=character.character_id
    WHERE actor.campaign_id=? ORDER BY actor.id`).all(campaignId) as Array<{ actor_id: string; label: string | null }>;
  const publicTarget = (row: typeof targetRows[number]) => ({ actorId: row.actor_id,
    ...(typeof row.label === "string" && row.label.trim().length > 0 && row.label.trim().length <= 200 ? { label: row.label.trim() } : {}) });
  const plans: ActorPowerCommandPlan[] = [];
  for (const row of rows) {
    const reference = powerReferenceSchema.parse({ kind: row.kind, packId: row.pack_id, packVersion: row.pack_version, definitionId: row.definition_id });
    const definition: Definition = row.kind === "ability" ? abilityCatalogDefinitionSchema.parse(JSON.parse(row.public_definition_json)) : spellCatalogDefinitionSchema.parse(JSON.parse(row.public_definition_json));
    if (key(definition.reference) !== key(reference)) continue;
    const persistent = definition.mechanics.effects.filter((effect: any) => effect.type === "condition" || (effect.type === "modifier" && effect.duration !== "instant")).length;
    if (persistent > 1) continue;
    const costs: Array<{ kind: "ability-use"; amount: 1 } | { kind: "slot"; slotId: string; amount: 1 }> = [];
    if (reference.kind === "ability" && definition.reference.kind === "ability" && definition.mechanics.uses > 0) {
      const recovered = recoveredAt(db, campaignId, actorId, definition.mechanics.recovery);
      const used = (db.prepare(`SELECT count(*) count FROM rpg_power_uses_v26 power JOIN rpg_m16_receipts_v26 receipt
        ON receipt.campaign_id=power.campaign_id AND receipt.actor_id=power.actor_id AND receipt.command_id=power.command_id
        WHERE power.campaign_id=? AND power.actor_id=? AND power.power_kind=? AND power.power_pack_id=?
          AND power.power_pack_version=? AND power.power_definition_id=? AND (? IS NULL OR receipt.occurred_at>?)`)
        .get(campaignId, actorId, reference.kind, reference.packId, reference.packVersion, reference.definitionId, recovered, recovered) as { count: number }).count;
      if (used >= definition.mechanics.uses) continue;
      costs.push({ kind: "ability-use", amount: 1 });
    }
    if (reference.kind === "spell" && definition.reference.kind === "spell" && definition.mechanics.level > 0) {
      const slotId = `slot-${definition.mechanics.level}`;
      const slot = db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name=?").get(campaignId, actorId, slotId) as { current: number } | undefined;
      if (!slot || slot.current < 1) continue;
      costs.push({ kind: "slot", slotId, amount: 1 });
    }
    const targeting = definition.mechanics.target === "self" || definition.mechanics.target === "area" ? definition.mechanics.target : "single";
    const validRows = targeting === "self" ? targetRows.filter((target) => target.actor_id === actorId)
      : targetRows.filter((target) => target.actor_id !== actorId && hasRequiredResources(db, campaignId, target.actor_id, definition));
    if (targeting === "self" && !hasRequiredResources(db, campaignId, actorId, definition)) continue;
    if (validRows.length === 0) continue;
    const effectKinds = [...new Set(definition.mechanics.effects.map((effect: any) => effect.type))];
    const command = actorPowerLegalCommandSchema.parse({ powerRef: reference, targeting, validTargets: validRows.map(publicTarget), costs,
      concentration: definition.reference.kind === "spell" ? definition.mechanics.concentration : false, effectKinds });
    plans.push({ ...command, definition });
  }
  return plans;
}

export function plannedPowerSelection(plan: ActorPowerCommandPlan, actorId: string, intent: ActorPowerCommandRequest): string[] | null {
  if (key(plan.powerRef) !== key(intent.powerRef)) return null;
  const valid = new Set(plan.validTargets.map((target: { actorId: string }) => target.actorId));
  if (plan.targeting === "self") return intent.targetIds.length === 0 && valid.has(actorId) ? [actorId] : null;
  if (plan.targeting === "single") return intent.targetIds.length === 1 && valid.has(intent.targetIds[0]!) ? [...intent.targetIds] : null;
  return intent.targetIds.length > 0 && intent.targetIds.every((id: string) => valid.has(id)) ? [...intent.targetIds] : null;
}
