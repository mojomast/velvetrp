import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema, spellCatalogDefinitionSchema } from "@velvet/contracts";
import type { EncounterDependencies } from "../encounterWriteRepo.js";
import { applyEffectRecord } from "../effectHandlers/index.js";
import type { CombatPowerLegalAction, EffectContext, Row } from "../effectHandlers/types.js";
import { claimReactionBudget, releaseReactionBudget, readReactionBudget, buildReactionReceipt, selectReactionWindow } from "./engine.js";
import { buildReadyCandidates, consumeReadyAction } from "./readyActionRuntime.js";
import type { ReactionReceipt, ReactionEvent, ReactionResponseKind } from "./types.js";

export const DND_5E_SHIELD_RESPONSE_ID = "srd-5.1:spell:shield";
export const DND_5E_SHIELD_RESPONSE_KIND: ReactionResponseKind = "spell";

export type HitTimeShieldPlan = Readonly<{
  applies: boolean;
  reason: "applied" | "not-hit" | "unavailable";
  armorClass: number;
  hit: boolean;
  critical: boolean;
}>;

/**
 * The pure true hit-time Shield rule. When the target can react and the attack
 * already hit, +5 applies before finalization and the hit becomes a miss when
 * the raised armor class exceeds the attack total. A critical hit is never
 * negated by Shield.
 */
export function planHitTimeShield(input: Readonly<{
  hit: boolean;
  critical: boolean;
  attackTotal: number;
  armorClass: number;
  reactionAvailable: boolean;
  slotAvailable: boolean;
}>): HitTimeShieldPlan {
  if (!input.hit) {
    return Object.freeze({ applies: false, reason: "not-hit", armorClass: input.armorClass, hit: false, critical: input.critical });
  }
  if (!input.reactionAvailable || !input.slotAvailable) {
    return Object.freeze({ applies: false, reason: "unavailable", armorClass: input.armorClass, hit: true, critical: input.critical });
  }
  const armorClass = input.armorClass + 5;
  const hit = input.critical ? true : input.attackTotal >= armorClass;
  return Object.freeze({ applies: true, reason: "applied", armorClass, hit, critical: input.critical && hit });
}

export type HitTimeShieldOutcome = Readonly<{
  hitBefore: boolean;
  hitAfter: boolean;
  attackTotal: number;
  armorClassBefore: number;
  armorClassAfter: number;
  slotBefore: number;
  slotAfter: number;
  defenseBonus: number;
}>;

export type HitTimeShieldResolution = Readonly<{
  receipt: ReactionReceipt<HitTimeShieldOutcome>;
  plan: HitTimeShieldPlan;
  slotResourceId: string;
}>;

type ShieldDefinition = ReturnType<typeof spellCatalogDefinitionSchema.parse>;

function readShieldDefinition(db: DatabaseDriver.Database, campaignId: string, actorId: string): ShieldDefinition | null {
  const row = db.prepare(`SELECT definition.definition_json FROM campaign_actors actor
    JOIN character_known_powers_v23 known ON known.campaign_character_id=actor.campaign_character_id
    JOIN campaign_catalog_current_pins pin ON pin.campaign_id=actor.campaign_id AND pin.pack_id=known.pack_id AND pin.pack_version=known.pack_version
    JOIN rpg_campaign_catalog_definitions_v25 execution ON execution.campaign_id=actor.campaign_id AND execution.pack_id=known.pack_id
      AND execution.pack_version=known.pack_version AND execution.kind=known.kind AND execution.definition_id=known.definition_id
    JOIN rpg_catalog_definitions definition ON definition.pack_id=known.pack_id AND definition.pack_version=known.pack_version
      AND definition.kind=known.kind AND definition.definition_id=known.definition_id
    WHERE actor.campaign_id=? AND actor.id=? AND known.kind='spell' AND known.definition_id=?`)
    .get(campaignId, actorId, DND_5E_SHIELD_RESPONSE_ID) as { definition_json: string } | undefined;
  if (!row) return null;
  try {
    const definition = spellCatalogDefinitionSchema.parse(JSON.parse(row.definition_json));
    return definition.reference.definitionId === DND_5E_SHIELD_RESPONSE_ID ? definition : null;
  } catch {
    return null;
  }
}

function applyShieldDefense(
  db: DatabaseDriver.Database, deps: EncounterDependencies, input: {
    encounterId: string; campaignId: string; reactorCombatantId: string; occurredAt: string;
  }, target: Row, definition: ShieldDefinition,
): void {
  const effects = definition.mechanics.effects as any[];
  const effect = effects[0];
  if (!effect || effect.type !== "modifier" || effect.statistic !== "defense") throw new Error("Shield reaction effect is unavailable");
  const level = (definition.mechanics as any).level ?? 1;
  const action: CombatPowerLegalAction = {
    legalActionId: `reaction:${DND_5E_SHIELD_RESPONSE_ID}:${input.reactorCombatantId}`,
    encounterId: input.encounterId,
    campaignId: input.campaignId,
    actingCombatantId: input.reactorCombatantId,
    sourceActorId: target.actor_id!,
    targetCombatantId: input.reactorCombatantId,
    targetActorId: target.actor_id,
    powerRef: definition.reference,
    definition,
    cost: { kind: "slot", id: `slot-${level}` },
  };
  const context: EffectContext = {
    db, deps, action, target, dnd: true, at: input.occurredAt, hp: target.hit_points,
    outcomes: [], tempHitPointGrants: [], effects, rage: false, layOnHands: false,
  };
  applyEffectRecord(context, effect, resourceIdSchema.parse(deps.ids.nextId()));
}

/**
 * Resolves a true hit-time Shield response for an actor-backed target. Returns
 * `null` when the target cannot react (no Shield, no slot, or no reaction
 * budget). The caller finalizes the triggering attack with the returned plan.
 */
export function resolveHitTimeShield(
  db: DatabaseDriver.Database, deps: EncounterDependencies, input: Readonly<{
    encounterId: string; campaignId: string; round: number; reactorCombatantId: string;
    sourceCombatantId: string | null; attackTotal: number; armorClass: number; hit: boolean; critical: boolean; occurredAt: string;
  }>,
): HitTimeShieldResolution | null {
  if (!input.hit) return null;
  const target = db.prepare(`SELECT combatant_id,actor_id,team,hit_points,maximum_hit_points,status,state_revision
    FROM combatant WHERE encounter_id=? AND combatant_id=?`).get(input.encounterId, input.reactorCombatantId) as Row | undefined;
  if (!target?.actor_id) return null;
  const budget = readReactionBudget(db, input.encounterId, input.reactorCombatantId, input.round);
  if (!budget.available) return null;
  const definition = readShieldDefinition(db, input.campaignId, target.actor_id);
  if (!definition) return null;
  // A readied Shield declaration takes precedence over the standing Shield
  // response; firing it consumes the held ready action and reports `ready`.
  const event: ReactionEvent = { kind: "hit", encounterId: input.encounterId, campaignId: input.campaignId,
    round: input.round, occurredAt: input.occurredAt, subjectCombatantId: input.reactorCombatantId,
    sourceCombatantId: input.sourceCombatantId, hit: true, attackTotal: input.attackTotal, armorClass: input.armorClass, critical: input.critical };
  const readyWindow = selectReactionWindow(event, buildReadyCandidates(db, event, { x: 0, y: 0 }))
    .filter((entry) => entry.reactorCombatantId === input.reactorCombatantId && entry.responseId === DND_5E_SHIELD_RESPONSE_ID);
  const readiness: "declared" | "ready" = readyWindow.length > 0 ? "ready" : "declared";
  const slotResourceId = `slot-${(definition.mechanics as any).level ?? 1}`;
  const slot = db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name=?")
    .get(input.campaignId, target.actor_id, slotResourceId) as { current: number } | undefined;
  if (!slot || slot.current < 1) return null;
  if (!claimReactionBudget(db, input.encounterId, input.reactorCombatantId, input.round, input.occurredAt)) return null;
  if (readiness === "ready" && !consumeReadyAction(db, input.encounterId, input.reactorCombatantId, readyWindow[0]!.readyId!)) {
    releaseReactionBudget(db, input.encounterId, input.reactorCombatantId, input.round);
    return null;
  }
  const spent = db.prepare("UPDATE rpg_actor_resources SET current=current-1 WHERE campaign_id=? AND actor_id=? AND name=? AND current=?")
    .run(input.campaignId, target.actor_id, slotResourceId, slot.current);
  if (spent.changes !== 1) {
    releaseReactionBudget(db, input.encounterId, input.reactorCombatantId, input.round);
    return null;
  }
  const plan = planHitTimeShield({
    hit: input.hit, critical: input.critical, attackTotal: input.attackTotal, armorClass: input.armorClass,
    reactionAvailable: true, slotAvailable: true,
  });
  applyShieldDefense(db, deps, input, target, definition);
  const receipt = buildReactionReceipt(deps.ids, {
    event: "hit",
    reactorCombatantId: input.reactorCombatantId,
    sourceCombatantId: input.sourceCombatantId,
    round: input.round,
    responseKind: DND_5E_SHIELD_RESPONSE_KIND,
    responseId: DND_5E_SHIELD_RESPONSE_ID,
    readiness,
    outcome: {
      hitBefore: true, hitAfter: plan.hit, attackTotal: input.attackTotal,
      armorClassBefore: input.armorClass, armorClassAfter: plan.armorClass,
      slotBefore: slot.current, slotAfter: slot.current - 1, defenseBonus: 5,
    },
  });
  return Object.freeze({ receipt, plan, slotResourceId });
}
