import type { SystemOneConfidenceThresholds, SystemOneLane, SystemOneSettings } from "../types.js";

/** Versioned evaluation contract, not a digest of a particular player's state.
 * Bump the relevant revision whenever its implementation or semantics change.
 * Never derive a historical approval from these current values at startup.
 */
export const SYSTEM_ONE_EXECUTION_CONTRACTS = {
  "speaker-routing": {
    questionVersion: "room-routing-v1", compositionVersion: "room-routing-v1",
    candidateStrategy: "room-participants-v1", stateVersion: "room-routing-v1",
  },
  "adventure-selection": {
    questionVersion: "adventure-grouped-v1", compositionVersion: "adventure-grouped-v1",
    candidateStrategy: "family-round-robin-32-legacy-v1", stateVersion: "adventure-declaration-candidates-v1",
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
