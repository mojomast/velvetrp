import type DatabaseDriver from "better-sqlite3";
import { abilityCatalogDefinitionSchema, enemyTemplateCatalogDefinitionSchema } from "@velvet/contracts";
import { actionBlockingConditions, conditionsFor, mayAttackTarget } from "./combatConditionRuntime.js";
import { EncounterConflictError } from "./encounterErrors.js";

export type MonsterTurnPlan = Readonly<{
  enemy: ReturnType<typeof enemyTemplateCatalogDefinitionSchema.parse>;
  ability: ReturnType<typeof abilityCatalogDefinitionSchema.parse>;
  target: any | null;
  attackRollCount: 1 | 2;
  knockdown: boolean;
  legalActionId: string;
  actionEvidence: readonly string[];
}>;

export type MonsterBehavior = Readonly<{
  targetPriority: "lowest-hit-points" | "first-legal";
  packTactics: boolean;
  knockdown: boolean;
  nimbleEscape: boolean;
}>;

const traitRefs: Record<string, readonly string[]> = {
  goblin: ["srd-5.1:ability:goblin-nimble-escape"],
  wolf: ["srd-5.1:ability:wolf-pack-tactics", "srd-5.1:ability:wolf-knockdown"],
};

/** Traits are limited to mechanics represented by the encounter runtime. */
export function monsterBehavior(definitionId: string): MonsterBehavior {
  if (definitionId.endsWith(":wolf")) return { targetPriority: "lowest-hit-points", packTactics: true, knockdown: true, nimbleEscape: false };
  if (definitionId.endsWith(":goblin")) return { targetPriority: "lowest-hit-points", packTactics: false, knockdown: false, nimbleEscape: true };
  if (definitionId.endsWith(":bandit")) return { targetPriority: "lowest-hit-points", packTactics: false, knockdown: false, nimbleEscape: false };
  return { targetPriority: "first-legal", packTactics: false, knockdown: false, nimbleEscape: false };
}

type Provenance = { pack_id: string; pack_version: string; definition_id: string; definition_json: string };

const sameRef = (a: { packId: string; packVersion: string; definitionId: string }, b: { packId: string; packVersion: string; definitionId: string }) =>
  a.packId === b.packId && a.packVersion === b.packVersion && a.definitionId === b.definitionId;

function pinnedEnemy(db: DatabaseDriver.Database, encounterId: string, combatantId: string): ReturnType<typeof enemyTemplateCatalogDefinitionSchema.parse> {
  const row = db.prepare(`SELECT p.pack_id,p.pack_version,p.definition_id,d.definition_json
    FROM encounter_enemy_provenance_v31 p JOIN rpg_catalog_definitions d
      ON d.pack_id=p.pack_id AND d.pack_version=p.pack_version AND d.kind=p.kind AND d.definition_id=p.definition_id
    WHERE p.combatant_id=?`).get(combatantId) as Provenance | undefined;
  if (!row) throw new EncounterConflictError("enemy provenance is unavailable");
  const enemy = enemyTemplateCatalogDefinitionSchema.parse(JSON.parse(row.definition_json));
  const pinned = db.prepare(`SELECT 1 FROM rpg_campaign_catalog_definitions_v25 p
    JOIN combatant c ON c.campaign_id=p.campaign_id
    WHERE c.encounter_id=? AND c.combatant_id=? AND p.pack_id=? AND p.pack_version=?
      AND p.kind='enemy-template' AND p.definition_id=?`).get(encounterId, combatantId,
    row.pack_id, row.pack_version, row.definition_id);
  if (!pinned || !sameRef(enemy.reference, { packId: row.pack_id, packVersion: row.pack_version, definitionId: row.definition_id }))
    throw new EncounterConflictError("enemy catalog pin is invalid");
  return enemy;
}

function abilityFor(db: DatabaseDriver.Database, enemy: ReturnType<typeof enemyTemplateCatalogDefinitionSchema.parse>) {
  const ref = enemy.mechanics.combatProfile?.attack.abilityRef;
  if (!ref || enemy.mechanics.abilityRefs.length === 0 || !enemy.mechanics.abilityRefs.some((value) => sameRef(value, ref)))
    throw new EncounterConflictError("enemy has no authoritative attack ability");
  const row = db.prepare(`SELECT definition_json FROM rpg_catalog_definitions
    WHERE pack_id=? AND pack_version=? AND kind='ability' AND definition_id=?`).get(ref.packId, ref.packVersion, ref.definitionId) as { definition_json: string } | undefined;
  if (!row) throw new EncounterConflictError("enemy attack provenance is unavailable");
  const ability = abilityCatalogDefinitionSchema.parse(JSON.parse(row.definition_json));
  const effect = ability.mechanics.effects[0] as any;
  if (!sameRef(ability.reference, ref) || ability.mechanics.actionCost !== "action" || ability.mechanics.target !== "enemy"
      || ability.mechanics.effects.length !== 1 || effect?.type !== "damage")
    throw new EncounterConflictError("enemy attack ability is not executable");
  return ability;
}

function hasPinnedTraits(enemy: ReturnType<typeof enemyTemplateCatalogDefinitionSchema.parse>, name: "goblin" | "wolf"): boolean {
  return (traitRefs[name] ?? []).every((definitionId) => enemy.mechanics.abilityRefs.some((value) => value.definitionId === definitionId
    && value.packId === enemy.reference.packId && value.packVersion === enemy.reference.packVersion));
}

/** Selects only targets that the combat model can legally attack. No caller input participates. */
export function planMonsterTurn(db: DatabaseDriver.Database, encounterId: string, current: any, round: number): MonsterTurnPlan {
  const enemy = pinnedEnemy(db, encounterId, current.combatant_id);
  const ability = abilityFor(db, enemy);
  const behavior = monsterBehavior(enemy.reference.definitionId);
  const blocked = [...actionBlockingConditions].some((condition) => conditionsFor(db, encounterId, current.combatant_id, round).has(condition));
  const evidence = behavior.nimbleEscape && hasPinnedTraits(enemy, "goblin") ? ["goblin:nimble-escape:short-reposition"]
    : behavior.packTactics && hasPinnedTraits(enemy, "wolf") ? ["wolf:pack-tactics", "wolf:knockdown-on-hit"] : [];
  if (blocked) return { enemy, ability, target: null, attackRollCount: 1, knockdown: false, legalActionId: "end-turn", actionEvidence: evidence };

  const order = behavior.targetPriority === "lowest-hit-points"
    ? "CASE status WHEN 'active' THEN 0 ELSE 1 END, hit_points, combatant_id" : "combatant_id";
  const targets = db.prepare(`SELECT * FROM combatant WHERE encounter_id=?
    AND status IN ('active','unconscious','stable') AND team<>? AND actor_id IS NOT NULL
    ORDER BY ${order}`).all(encounterId, current.team) as any[];
  const target = targets.find((value) => mayAttackTarget(db, encounterId, current.combatant_id, value.combatant_id, round)) ?? null;
  if (!target) return { enemy, ability, target: null, attackRollCount: 1, knockdown: false, legalActionId: "end-turn", actionEvidence: evidence };

  const allies = (db.prepare(`SELECT count(*) AS count FROM combatant WHERE encounter_id=? AND team=? AND status='active'`)
    .get(encounterId, current.team) as { count: number }).count;
  const wolfTraitsPinned = hasPinnedTraits(enemy, "wolf");
  return { enemy, ability, target, attackRollCount: behavior.packTactics && wolfTraitsPinned && allies > 1 ? 2 : 1,
    knockdown: behavior.knockdown && wolfTraitsPinned, legalActionId: behavior.knockdown && wolfTraitsPinned ? "attack:wolf:knockdown" : "attack:basic", actionEvidence: evidence };
}

export function isMonsterKnockdown(plan: MonsterTurnPlan, hit: boolean): boolean {
  return plan.knockdown && hit;
}
