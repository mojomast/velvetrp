export const DM_EVAL_CATEGORIES = [
  "injection-declaration", "injection-canon", "injection-history", "injection-tool-result", "injection-preference",
  "abstention", "exact-tool-selection", "authorization", "confirmation", "hidden-data", "receipt-grounding",
  "replay", "continuity", "temporal", "contradictory-recap", "npc-knowledge", "player-agency", "limits",
] as const;

export type DmEvalCategory = typeof DM_EVAL_CATEGORIES[number];
export type DmOutcome = "completed" | "awaiting-confirmation" | "mechanics-committed" | "fallback" | "in-progress" | "refused";

export interface DmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface DmEvalObservation {
  outcome: DmOutcome;
  toolCalls: DmToolCall[];
  confirmation: { required: boolean; decision: "pending" | "approved" | "rejected" | "expired" | null };
  receipts: Array<{ commandId: string; facts: string[] }>;
  narration: { text: string; claims: string[] };
  disclosures: string[];
  mechanicsApplications: Array<{ idempotencyKey: string; commandId: string }>;
  lateResponsesApplied: number;
  metrics: {
    decisionRounds: number;
    providerCalls: number;
    toolCalls: number;
    mutationCalls: number;
    durationMs: number;
    costUsd: number;
  };
}

export interface DmEvalExpectation {
  allowedOutcomes: DmOutcome[];
  toolPolicy: "none" | "exact" | "bounded";
  exactToolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
  allowedToolNames?: string[];
  requiredConfirmation?: boolean;
  requiredFacts?: string[];
  forbiddenFacts?: string[];
  allowedNarrativeFacts?: string[];
  forbiddenDisclosures?: string[];
  requiredNarrationIncludes?: string[];
  forbiddenNarrationIncludes?: string[];
  deduplicateMechanics?: boolean;
  rejectLateResponses?: boolean;
  limits?: Partial<DmEvalObservation["metrics"]>;
}

export interface DmEvalCase {
  id: string;
  categories: DmEvalCategory[];
  stage: "planning" | "narration" | "recovery";
  input: {
    declaration: string;
    canon?: string[];
    history?: string[];
    toolResults?: string[];
    preferences?: string[];
    notes?: string;
  };
  expected: DmEvalExpectation;
  baseline: DmEvalObservation;
}

export interface DmEvalCorpus {
  version: "v1";
  cases: DmEvalCase[];
}

export type DmGradeFailureCode =
  | "outcome" | "tool-policy" | "tool-arguments" | "duplicate-tool-call" | "confirmation-bypass"
  | "missing-fact" | "forbidden-fact" | "unreceipted-mechanic" | "hidden-data-leak" | "narration"
  | "duplicate-mechanics" | "late-response" | "limit";

export interface DmGradeResult {
  passed: boolean;
  failures: Array<{ code: DmGradeFailureCode; detail: string }>;
}

/** One probabilistic prediction paired with its observed binary outcome. */
export interface DmCalibrationPoint {
  predictedProbability: number;
  correct: boolean;
}

/** Aggregate discrimination/calibration summary for a set of predictions. */
export interface DmCalibrationReport {
  count: number;
  brier: number;
  expectedCalibrationError: number;
  bins: number;
}
