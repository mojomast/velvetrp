/**
 * Public barrel for the combat action planner surface.
 * Implementation is split into per-action-kind modules under ./actionPlanners/.
 */
export { buildRangedCombatCandidate } from "./actionPlanners/rangedCandidates.js";
export { buildThrownCombatCandidate } from "./actionPlanners/thrownCandidates.js";
export {
  beginDndCombatTurn,
  consumeDndTurnCost,
  endDndCombatTurn,
  isDndCombat,
  readCombatTurnEconomy,
} from "./actionPlanners/turnEconomy.js";
export { coverArmorClassBonus, hostileWithinFiveFeet } from "./actionPlanners/targeting.js";
export { buildCombatActionPlans } from "./actionPlanners/buildPlans.js";
export type {
  CombatActionPlan,
  CombatSpellCandidateProvider,
  CombatSpellRangedCandidate,
  PersistedCombatTurnEconomy,
  RangedCombatCandidate,
  RangedTargetEvidence,
  ThrownCombatCandidate,
} from "./actionPlanners/types.js";
