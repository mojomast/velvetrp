import type { SystemOneConfidenceThresholds, SystemOneLane, SystemOneSettings } from "../types.js";

/** Versioned evaluation contract, not a digest of a particular player's state.
 * Bump the relevant revision whenever its implementation or semantics change.
 * Never derive a historical approval from these current values at startup.
 */
export const SYSTEM_ONE_EXECUTION_CONTRACTS = {
  "speaker-routing": {
    questionVersion: "room-routing-v1", compositionVersion: "room-routing-v2",
    candidateStrategy: "room-participants-v1", stateVersion: "room-routing-v1",
  },
  "adventure-selection": {
    questionVersion: "adventure-grouped-v1", compositionVersion: "adventure-grouped-v1",
    candidateStrategy: "family-round-robin-32-legacy-v1", stateVersion: "adventure-declaration-candidates-v1",
  },
  // The only action this lane may ever authorize is selecting one candidate the server already
  // authored (a location/NPC/encounter/shop/clue/faction/quest/rumor materialization). It can
  // never authorize prose, stats, prices, stock, or a state mutation:
  // `composeFreeformMaterializationDecision` returns a candidate id/kind from the closed authored
  // set or a fallback. This contract declares what a future passing evaluation would bind and
  // grants no authority without a matching promotion record; there is deliberately no production
  // record (see docs/freeform-materialization.md).
  //
  // Version revision: the closed candidate set grew from five to eight families (adding
  // `materialize-faction`, `materialize-quest`, `materialize-rumor`). That changes the `choice`
  // criteria and the accepted `kind` enum in the battery and the persisted state, and it changes
  // the composition's closed-set handling, so the question, composition, and state versions move
  // to `-v2`. The candidate strategy is unchanged (still a server-authored closed set), so it
  // keeps `-v1`. Any evaluation binding recorded before this revision no longer matches.
  "freeform-materialization": {
    questionVersion: "freeform-materialization-v2", compositionVersion: "freeform-materialization-v2",
    candidateStrategy: "server-authored-freeform-candidates-v1", stateVersion: "freeform-materialization-state-v2",
  },
} as const;

export interface SystemOneEvaluationBinding {
  schemaVersion: 1;
  lane: SystemOneLane;
  provider: "typesafe";
  baseUrl: string;
  requestedModel: string;
  responseModel: string;
  questionVersion: string;
  compositionVersion: string;
  candidateStrategy: string;
  stateVersion: string;
  actionFamily: string;
  actionThreshold: number;
  reviewThreshold: number;
  calibrationA: number;
  calibrationB: number;
}

/** Capture this alongside evaluation metrics; capturing alone does NOT approve a lane.
 * Missing response-model metadata fails closed rather than assuming an alias resolved.
 * Optional overrides must describe the actual request path (e.g. shadow shortlist v2).
 */
export function systemOneEvaluationBinding(
  lane: keyof typeof SYSTEM_ONE_EXECUTION_CONTRACTS,
  settings: SystemOneSettings,
  responseModel: string | null | undefined,
  actionFamily: string,
  overrides: Partial<Pick<SystemOneEvaluationBinding,
    "questionVersion" | "compositionVersion" | "candidateStrategy" | "stateVersion">> = {},
  thresholds: SystemOneConfidenceThresholds = settings.confidencePolicy[lane],
): SystemOneEvaluationBinding {
  return {
    schemaVersion: 1, lane, provider: "typesafe", baseUrl: settings.baseUrl,
    requestedModel: settings.model, responseModel: responseModel ?? "",
    ...SYSTEM_ONE_EXECUTION_CONTRACTS[lane], ...overrides, actionFamily,
    actionThreshold: thresholds.actionThreshold, reviewThreshold: thresholds.reviewThreshold,
    calibrationA: settings.confidenceCalibration[lane].a,
    calibrationB: settings.confidenceCalibration[lane].b,
  };
}

const fields = ["schemaVersion", "lane", "provider", "baseUrl", "requestedModel", "responseModel",
  "questionVersion", "compositionVersion", "candidateStrategy", "stateVersion", "actionFamily",
  "actionThreshold", "reviewThreshold", "calibrationA", "calibrationB"] as const;

function valid(binding: SystemOneEvaluationBinding): boolean {
  return binding.schemaVersion === 1 && binding.provider === "typesafe"
    && fields.every(key => typeof binding[key] === "number"
      ? Number.isFinite(binding[key]) : typeof binding[key] === "string" && binding[key].trim().length > 0)
    && binding.reviewThreshold >= 0 && binding.actionThreshold <= 1
    && binding.reviewThreshold <= binding.actionThreshold;
}

/** Exact, order-independent field comparison. No wildcards, cross-family or alias approvals. */
export function matchesSystemOneBinding(evaluated: SystemOneEvaluationBinding,
  current: SystemOneEvaluationBinding): boolean {
  return valid(evaluated) && valid(current) && fields.every(key => evaluated[key] === current[key]);
}
