import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { resolveSrdEquipment } from "../../srdEquipmentRuntime.js";
import { resolveCampaignRuleset } from "../../../rulesets/campaignBinding.js";
import { actionBlockingConditions, conditionsFor, mayAttackTarget } from "../combatConditionRuntime.js";
import { buildRangedCombatCandidate } from "./rangedCandidates.js";
import { buildThrownCombatCandidate } from "./thrownCandidates.js";
import { isDndCombat, readCombatTurnEconomy } from "./turnEconomy.js";
import type { CombatActionPlan, RangedTargetEvidence } from "./types.js";

/** One authoritative action planner shared by combat reads and writes. */
export function buildCombatActionPlans(
  db: DatabaseDriver.Database,
  principal: string,
  campaignId: string,
  encounterId: string,
  currentCombatantId: string | null,
): CombatActionPlan[] {
  if (currentCombatantId === null) return [];
  const current = db.prepare(`SELECT combatant_id,combatant_kind,actor_id,team,status FROM combatant
    WHERE encounter_id=? AND combatant_id=? AND status IN ('active','unconscious')`).get(encounterId, currentCombatantId) as any;
  if (!current) return [];
  // Enemy turns are intentionally not caller-planned in D&D combat.
  if (current.combatant_kind === "enemy" && isDndCombat(db, campaignId)) return [];
  const gm = Boolean(db.prepare(`SELECT 1 FROM campaign_memberships
    WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')`).get(campaignId, principal));
  const controls = current.actor_id !== null && Boolean(db.prepare(`SELECT 1 FROM campaign_actor_private_state
    WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`).get(campaignId, current.actor_id, principal));
  if (!gm && !controls) return [];
  let ruleset: ReturnType<typeof resolveCampaignRuleset>;
  try { ruleset = resolveCampaignRuleset(db, campaignId); } catch { return []; }
  const economy = ruleset.rulesetId === "dnd-5e" ? readCombatTurnEconomy(db, encounterId) : null;
  if (ruleset.rulesetId === "dnd-5e" && (!economy || economy.combatantId !== current.combatant_id)) return [];
  if (ruleset.rulesetId === "dnd-5e" && current.status === "unconscious") return [{ legalActionId: "death-save", kind: "death-save" as const,
    actingCombatantId: current.combatant_id, targetIds: [], cost: null }];
  const conditions = conditionsFor(db, encounterId, current.combatant_id, economy?.round ?? 0);
  if (ruleset.rulesetId === "dnd-5e" && [...actionBlockingConditions].some((condition) => conditions.has(condition))) {
    return [{ legalActionId: "end-turn", kind: "end-turn" as const, actingCombatantId: current.combatant_id, targetIds: [], cost: null }];
  }
  const targets = (db.prepare(`SELECT combatant_id FROM combatant WHERE encounter_id=? AND status ${ruleset.rulesetId === "dnd-5e" ? "IN ('active','unconscious','stable')" : "='active'"} AND team<>?
    ORDER BY combatant_id`).all(encounterId, current.team) as Array<{ combatant_id: string }>).map((row) => row.combatant_id);
  let attackSupported = ruleset.rulesetId !== "dnd-5e";
  let attackId = "attack:basic";
  let attackType: "melee" | "ranged" | "thrown" = "melee";
  let targetEvidence: RangedTargetEvidence[] | undefined;
  if (ruleset.rulesetId === "dnd-5e" && current.actor_id) {
    try {
      const equipment = resolveSrdEquipment(db, campaignId, current.actor_id);
      const weapon = equipment.weapon;
      // SRD 5.1: every creature is proficient with unarmed strikes and always
      // has one, so a missing equipped weapon no longer removes the attack.
      attackSupported = true;
      if (weapon?.properties.some((value) => value.property === "thrown")) {
        const thrown = buildThrownCombatCandidate(db, campaignId, encounterId, current.actor_id, targets);
        attackSupported = thrown !== null;
        if (thrown) { attackId = thrown.attackId; attackType = "thrown"; targetEvidence = thrown.targetEvidence; }
      } else if (weapon?.properties.some((value) => value.property === "ammunition")) {
        const ranged = buildRangedCombatCandidate(db, campaignId, encounterId, current.actor_id, targets);
        attackSupported = ranged !== null;
        if (ranged) { attackId = ranged.attackId; attackType = "ranged"; targetEvidence = ranged.targetEvidence; }
      }
      if (attackType === "melee") attackId = weapon
        ? `attack:basic:${createHash("sha256").update(JSON.stringify({ actorId: current.actor_id, revision: equipment.revision, weapon })).digest("hex").slice(0, 48)}`
        : "attack:unarmed";
    } catch { attackSupported = false; }
  }
  const attackTargets = !attackSupported ? [] : (current.combatant_kind === "enemy" ? targets.slice(0, 1) : targets)
    .filter((targetId) => mayAttackTarget(db, encounterId, current.combatant_id, targetId, economy?.round ?? 0));
  const grappleTargets = ruleset.rulesetId === "dnd-5e" && current.actor_id && economy?.action.available
    ? targets.filter((targetId) => mayAttackTarget(db, encounterId, current.combatant_id, targetId, economy.round)
      && ![...actionBlockingConditions].some(condition => conditionsFor(db, encounterId, targetId, economy.round).has(condition))) : [];
  const grappled = conditions.has("grappled");
  // SRD 5.1: standing up from prone costs half your speed but no action.
  const standUpCost = economy === null ? 0 : Math.floor(economy.movement.allowanceFeet / 2);
  const canStand = ruleset.rulesetId === "dnd-5e" && current.actor_id && economy !== null && conditions.has("prone")
    && standUpCost >= 1 && economy.movement.remainingFeet >= standUpCost;
  const utility = ruleset.rulesetId === "dnd-5e" && current.actor_id && economy?.action.available;
  const helpTargets = utility ? (db.prepare(`SELECT combatant_id FROM combatant WHERE encounter_id=? AND team=? AND combatant_kind='actor'
    AND status='active' AND combatant_id<>? ORDER BY combatant_id`).all(encounterId, current.team, current.combatant_id) as Array<{ combatant_id: string }>).map(row => row.combatant_id) : [];
  const stabilizeTargets = ruleset.rulesetId === "dnd-5e" && current.actor_id ? (db.prepare(`SELECT combatant_id FROM combatant WHERE encounter_id=?
    AND team=? AND combatant_kind='actor' AND status='unconscious' ORDER BY combatant_id`).all(encounterId, current.team) as Array<{combatant_id:string}>).map(row=>row.combatant_id) : [];
  return [
    ...(attackTargets.length > 0 && (economy === null || economy.action.available) ? [{ legalActionId: attackId, kind: "attack" as const,
      actingCombatantId: current.combatant_id, targetIds: attackTargets, cost: "action" as const, attackType,
      ...(targetEvidence ? { targetEvidence } : {}) }] : []),
    ...(stabilizeTargets.length && (economy === null || economy.action.available) ? [{ legalActionId: "stabilize", kind: "stabilize" as const,
      actingCombatantId: current.combatant_id, targetIds: stabilizeTargets, cost: "action" as const }] : []),
    ...grappleTargets.map((targetId) => ({ legalActionId: `grapple:${targetId}`, kind: "grapple" as const,
      actingCombatantId: current.combatant_id, targetIds: [targetId], cost: "action" as const })),
    ...grappleTargets.map((targetId) => ({ legalActionId: `shove:${targetId}`, kind: "shove" as const,
      actingCombatantId: current.combatant_id, targetIds: [targetId], cost: "action" as const })),
    ...(grappled && (economy === null || economy.action.available) ? [{ legalActionId: "escape-grapple", kind: "escape-grapple" as const,
      actingCombatantId: current.combatant_id, targetIds: [current.combatant_id], cost: "action" as const }] : []),
    ...(canStand ? [{ legalActionId: "stand-up", kind: "stand-up" as const,
      actingCombatantId: current.combatant_id, targetIds: [current.combatant_id], cost: null }] : []),
    ...(utility ? [{ legalActionId: "dash", kind: "dash" as const, actingCombatantId: current.combatant_id, targetIds: [], cost: "action" as const },
      { legalActionId: "disengage", kind: "disengage" as const, actingCombatantId: current.combatant_id, targetIds: [], cost: "action" as const },
      { legalActionId: "ready", kind: "ready" as const, actingCombatantId: current.combatant_id, targetIds: [], cost: "action" as const },
      ...helpTargets.map(targetId => ({ legalActionId: `help:${targetId}`, kind: "help" as const, actingCombatantId: current.combatant_id, targetIds: [targetId], cost: "action" as const })),
      { legalActionId: "hide", kind: "hide" as const, actingCombatantId: current.combatant_id, targetIds: [], cost: "action" as const }] : []),
    { legalActionId: "flee", kind: "flee", actingCombatantId: current.combatant_id, targetIds: [], cost: null },
    { legalActionId: "end-turn", kind: "end-turn", actingCombatantId: current.combatant_id, targetIds: [], cost: null },
  ];
}
