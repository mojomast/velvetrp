import type DatabaseDriver from "better-sqlite3";
import {
  abilityCatalogDefinitionSchema, actorPowerLegalCommandSchema, powerReferenceSchema,
  spellCatalogDefinitionSchema, type ActorPowerCommandRequest, type PowerReference,
} from "@velvet/contracts";

type Definition = any;
export type ActorPowerCommandPlan = ReturnType<typeof actorPowerLegalCommandSchema.parse> & { definition: Definition };
const key = (value: PowerReference) => `${value.kind}\0${value.packId}\0${value.packVersion}\0${value.definitionId}`;
const MAGIC_MISSILE = "srd-5.1:spell:magic-missile";

/** Only effects whose actor-power runtime has complete hit semantics may be exposed at range. */
export function isSupportedRangedSpell(definition: Definition): boolean {
  const mechanics = definition.mechanics;
  return definition.reference.kind === "spell" && mechanics.range > 5
    && (mechanics.target === "enemy" || mechanics.target === "single" || mechanics.target === "ally")
    && (mechanics.attackType ?? "none") === "none" && (mechanics.saveType ?? "none") === "none"
    && mechanics.effects.length > 0
    && mechanics.effects.every((effect: any) => effect.type === "damage" || effect.type === "healing");
}

/** The starter catalog carries the range/target contract for these spells but
 * intentionally omits effects until a runtime opts into them. */
function executableSpellDefinition(definition: Definition): Definition {
  if (definition.reference.kind !== "spell" || definition.reference.definitionId !== MAGIC_MISSILE
    || (definition.mechanics.attackType ?? "none") !== "none" || (definition.mechanics.saveType ?? "none") !== "none") return definition;
  return { ...definition, mechanics: { ...definition.mechanics, effects: Array.from({ length: 3 }, () => ({
    type: "damage", damageType: "force", dice: { count: 1, sides: 4, modifier: 1 },
  })) } };
}

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

function preparedSpellReferences(db: DatabaseDriver.Database, campaignId: string, actorId: string): PowerReference[] {
  const actor = db.prepare(`SELECT actor.sheet_id, class.pack_id, class.pack_version, class.definition_id, class.level
    FROM campaign_actors actor JOIN rpg_character_classes class
      ON class.campaign_id=actor.campaign_id AND class.sheet_id=actor.sheet_id AND class.position=0
    WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId, actorId) as {
      sheet_id: string; pack_id: string; pack_version: string; definition_id: string; level: number;
    } | undefined;
  if (!actor) return [];
  const rows = db.prepare(`SELECT definition.definition_json FROM campaign_catalog_current_pins pin
    JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
    WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=? AND definition.kind='class-level'`)
    .all(campaignId, actor.pack_id, actor.pack_version) as Array<{ definition_json: string }>;
  for (const row of rows) {
    try {
      const value = JSON.parse(row.definition_json);
      if (value.mechanics?.level === actor.level
        && value.mechanics.classRef?.definitionId === actor.definition_id
        && value.mechanics.classRef?.packId === actor.pack_id
        && value.mechanics.classRef?.packVersion === actor.pack_version) {
        return (value.mechanics.preparedSpellRefs ?? []) as PowerReference[];
      }
    } catch { /* malformed catalog rows are ignored by the normal planner */ }
  }
  return [];
}

/** Shared read/write planner. It performs no mutation and is safe inside either transaction mode. */
export function planActorPowerCommands(db: DatabaseDriver.Database, campaignId: string, actorId: string, includePreparedSpells = false): ActorPowerCommandPlan[] {
  const rows = db.prepare(`SELECT known.kind,known.pack_id,known.pack_version,known.definition_id,visibility.public_definition_json
    FROM campaign_actors actor JOIN character_known_powers_v23 known ON known.campaign_character_id=actor.campaign_character_id
    JOIN campaign_catalog_current_pins pin ON pin.campaign_id=actor.campaign_id AND pin.pack_id=known.pack_id AND pin.pack_version=known.pack_version
    JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=known.pack_id AND visibility.pack_version=known.pack_version
      AND visibility.kind=known.kind AND visibility.definition_id=known.definition_id AND visibility.publicly_reachable=1
    JOIN rpg_campaign_catalog_definitions_v25 execution ON execution.campaign_id=actor.campaign_id
      AND execution.pack_id=known.pack_id AND execution.pack_version=known.pack_version AND execution.kind=known.kind AND execution.definition_id=known.definition_id
    WHERE actor.campaign_id=? AND actor.id=? ORDER BY known.kind,known.pack_id,known.pack_version,known.definition_id`)
    .all(campaignId, actorId) as Array<{ kind: "ability" | "spell"; pack_id: string; pack_version: string; definition_id: string; public_definition_json: string }>;
  const targetRows = db.prepare(`SELECT actor.id actor_id,actor.kind actor_kind,persona.name label FROM campaign_actors actor
    LEFT JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
    LEFT JOIN characters persona ON persona.id=character.character_id
    WHERE actor.campaign_id=? ORDER BY actor.id`).all(campaignId) as Array<{ actor_id: string; actor_kind:string; label: string | null }>;
  const publicTarget = (row: typeof targetRows[number]) => ({ actorId: row.actor_id,
    ...(typeof row.label === "string" && row.label.trim().length > 0 && row.label.trim().length <= 200 ? { label: row.label.trim() } : {}) });
  const prepared = includePreparedSpells ? preparedSpellReferences(db, campaignId, actorId) : [];
  const knownKeys = new Set(rows.map((row) => `${row.kind}\0${row.pack_id}\0${row.pack_version}\0${row.definition_id}`));
  const preparedRows = prepared.filter((reference) => !knownKeys.has(key(reference))).map((reference) => ({
    kind: reference.kind, pack_id: reference.packId, pack_version: reference.packVersion, definition_id: reference.definitionId,
    public_definition_json: (db.prepare(`SELECT visibility.public_definition_json FROM campaign_catalog_current_pins pin
      JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
        AND visibility.kind=? AND visibility.definition_id=? AND visibility.publicly_reachable=1
      WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?`).get(
        reference.kind, reference.definitionId,
        campaignId, reference.packId, reference.packVersion) as { public_definition_json: string } | undefined)?.public_definition_json ?? "",
  }));
  const plans: ActorPowerCommandPlan[] = [];
  for (const row of [...rows, ...preparedRows]) {
    const reference = powerReferenceSchema.parse({ kind: row.kind, packId: row.pack_id, packVersion: row.pack_version, definitionId: row.definition_id });
    if (!row.public_definition_json) continue;
    const definition: Definition = executableSpellDefinition(row.kind === "ability" ? abilityCatalogDefinitionSchema.parse(JSON.parse(row.public_definition_json)) : spellCatalogDefinitionSchema.parse(JSON.parse(row.public_definition_json)));
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
      const slot = db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name IN (?,?) ORDER BY CASE name WHEN ? THEN 0 ELSE 1 END LIMIT 1").get(campaignId, actorId, slotId, `spell-${slotId}`, slotId) as { current: number } | undefined;
      if (!slot || slot.current < 1) continue;
      costs.push({ kind: "slot", slotId, amount: 1 });
    }
    const targeting = definition.mechanics.target;
    // Outside combat, campaign player characters are the only authoritative ally set.
    // Enemy powers remain unavailable until the combat command path supports powers.
    if (targeting === "enemy" && reference.definitionId !== MAGIC_MISSILE && !isSupportedRangedSpell(definition)) continue;
    const validRows = (targeting === "self" ? targetRows.filter((target) => target.actor_id === actorId)
      : targetRows.filter((target) => target.actor_id !== actorId && (targeting !== "ally" || target.actor_kind === "player-character")
        && hasRequiredResources(db, campaignId, target.actor_id, definition))).slice(0,32);
    if (targeting === "self" && !hasRequiredResources(db, campaignId, actorId, definition)) continue;
    if (validRows.length === 0) continue;
    const effectKinds = [...new Set(definition.mechanics.effects.map((effect: any) => effect.type))];
    const publicTargeting=targeting==="ally"||targeting==="enemy"?"single":targeting;
    const maxTargets=publicTargeting==="self"?0:publicTargeting==="single"?1:validRows.length;
    const command = actorPowerLegalCommandSchema.parse({ powerRef: reference, targeting:publicTargeting, validTargets: validRows.map(publicTarget), maxTargets,costs,
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
  return intent.targetIds.length > 0 && intent.targetIds.length <= plan.maxTargets
    && intent.targetIds.every((id: string) => valid.has(id)) ? [...intent.targetIds] : null;
}
