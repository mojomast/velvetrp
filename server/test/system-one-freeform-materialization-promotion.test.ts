import { afterEach, describe, expect, it } from "vitest";
import {
  FREEFORM_CANDIDATE_KEY,
  FREEFORM_LEGAL_KEY,
  FREEFORM_MATERIALIZATION_ACTION_FAMILY,
  FREEFORM_MATERIALIZATION_NONE,
  FREEFORM_NEEDS_CONTENT_KEY,
  composeFreeformMaterializationDecision,
  freeformMaterializationSelectionSchema,
  type FreeformMaterializationCandidate,
} from "../src/agent/systemOneFreeformMaterialization.js";
import { SYSTEM_ONE_EXECUTION_CONTRACTS, systemOneEvaluationBinding } from "../src/agent/systemOneBinding.js";
import {
  SYSTEM_ONE_PROMOTION_RECORDS,
  isLanePromoted,
  promotionRecord,
} from "../src/agent/systemOnePromotion.js";
import { defaultSystemOneLaneModes, defaultSystemOneSettings } from "../src/defaults.js";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";
import type { SystemOneSettings } from "../src/types.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const LANE = "freeform-materialization" as const;

const CANDIDATES: FreeformMaterializationCandidate[] = [
  { candidateId: "materialize:glassblower-district", kind: "materialize-location", label: "Glassblower's district" },
  { candidateId: "materialize:glassblower", kind: "materialize-npc", label: "The glassblower" },
];

const STATE = {
  campaignId: "campaign-promotion",
  sessionId: "session-promotion",
  attempt: "I go to the glassblower's district.",
  candidates: CANDIDATES,
};

/** Deterministic answers: two `noul` gates plus the aggregate closed-set `choice`. */
function answers(option: {
  choice?: string;
  choiceProbability?: number;
  needsContent?: number;
  legal?: number;
} = {}): Record<string, SystemOneAnswer> {
  const choice = option.choice ?? CANDIDATES[0]!.candidateId;
  const probability = option.choiceProbability ?? 0.95;
  return {
    [FREEFORM_NEEDS_CONTENT_KEY]: { type: "noul", noul: option.needsContent ?? 0.95 },
    [FREEFORM_LEGAL_KEY]: { type: "noul", noul: option.legal ?? 0.95 },
    [FREEFORM_CANDIDATE_KEY]: {
      type: "choice",
      choice,
      confidence: probability,
      probabilities: { [choice]: probability, [FREEFORM_MATERIALIZATION_NONE]: 1 - probability },
    },
  };
}

/** Passes the base gate: >=30 samples, accuracy >=0.9, Wilson lower bound >=0.8, Brier/ECE <=0.1. */
const PASSING_METRICS = { samples: 60, accuracy: 0.98, brier: 0.02, expectedCalibrationError: 0.02 };

/**
 * Test-only promotion override. `isLanePromoted` reads the mutable `SYSTEM_ONE_PROMOTION_RECORDS`
 * map, so a synthetic record reproduces the production promotion mechanism without adding a
 * production record. `afterEach` removes it, so the lane stays unpromoted everywhere else.
 */
function approveFreeformForTest(settings: SystemOneSettings,
  actionFamily: string = FREEFORM_MATERIALIZATION_ACTION_FAMILY): void {
  SYSTEM_ONE_PROMOTION_RECORDS[LANE] = {
    evaluatedBindings: [systemOneEvaluationBinding(LANE, settings, settings.model, actionFamily)],
    metrics: { ...PASSING_METRICS },
    calibration: null,
    promotedAt: "2026-01-01",
    evidence: "test-only",
  };
}

afterEach(() => {
  delete SYSTEM_ONE_PROMOTION_RECORDS[LANE];
});

describe("freeform-materialization promotion path", () => {
  it("declares an execution contract bounded to server-authored candidates", () => {
    expect(SYSTEM_ONE_EXECUTION_CONTRACTS["freeform-materialization"]).toEqual({
      questionVersion: "freeform-materialization-v1",
      compositionVersion: "freeform-materialization-v1",
      candidateStrategy: "server-authored-freeform-candidates-v1",
      stateVersion: "freeform-materialization-state-v1",
    });
    expect(FREEFORM_MATERIALIZATION_ACTION_FAMILY).toBe("freeform.materialize-candidate");
  });

  it("stays unpromoted and inactive by default, even with an exact binding", () => {
    const settings = defaultSystemOneSettings();
    expect(defaultSystemOneLaneModes()[LANE]).toBe("shadow");
    expect(settings.enabled).toBe(false);
    expect(promotionRecord(LANE)).toBeUndefined();
    const binding = systemOneEvaluationBinding(LANE, settings, settings.model, FREEFORM_MATERIALIZATION_ACTION_FAMILY);
    expect(isLanePromoted(LANE, binding)).toBe(false);
    expect(isLanePromoted(LANE)).toBe(false);
  });

  it("promotes only through an exact evaluated binding (test-only record)", () => {
    const settings = defaultSystemOneSettings();
    approveFreeformForTest(settings);
    const binding = systemOneEvaluationBinding(LANE, settings, settings.model, FREEFORM_MATERIALIZATION_ACTION_FAMILY);
    expect(isLanePromoted(LANE, binding)).toBe(true);
    // A record without a current binding never authorizes execution.
    expect(isLanePromoted(LANE)).toBe(false);
    // A different action family is not covered by the record.
    expect(isLanePromoted(LANE,
      systemOneEvaluationBinding(LANE, settings, settings.model, "freeform.other"))).toBe(false);
    // A stale question version is not covered either.
    expect(isLanePromoted(LANE, { ...binding, questionVersion: "freeform-materialization-v2" })).toBe(false);
  });

  it("maps a promoted selection only to a server-authored candidate", () => {
    const settings = defaultSystemOneSettings();
    approveFreeformForTest(settings);
    expect(isLanePromoted(LANE,
      systemOneEvaluationBinding(LANE, settings, settings.model, FREEFORM_MATERIALIZATION_ACTION_FAMILY))).toBe(true);

    const decision = composeFreeformMaterializationDecision(STATE, answers(), settings.confidencePolicy[LANE]);
    expect(decision.band).toBe("act");
    expect(CANDIDATES.map((candidate) => candidate.candidateId)).toContain(decision.candidateId);
    expect(decision.kind).toBe("materialize-location");
    // The decision carries only bounded routing fields: no channel for prose, stats, prices, or state.
    expect(Object.keys(decision).sort()).toEqual(
      ["band", "candidateId", "kind", "legal", "needsContent", "reason", "signals", "topSignal"],
    );
  });

  it("fails closed on out-of-set or malformed answers even with a promoted lane", () => {
    const settings = defaultSystemOneSettings();
    approveFreeformForTest(settings);
    expect(isLanePromoted(LANE,
      systemOneEvaluationBinding(LANE, settings, settings.model, FREEFORM_MATERIALIZATION_ACTION_FAMILY))).toBe(true);

    const outOfSet = composeFreeformMaterializationDecision(
      STATE, answers({ choice: "materialize:invented", choiceProbability: 0.99 }), settings.confidencePolicy[LANE]);
    expect(outOfSet).toMatchObject({ band: "fallback", candidateId: null, kind: null, reason: "missing_or_invalid_answers" });

    const none = composeFreeformMaterializationDecision(
      STATE, answers({ choice: FREEFORM_MATERIALIZATION_NONE, choiceProbability: 0.99 }), settings.confidencePolicy[LANE]);
    expect(none).toMatchObject({ band: "fallback", candidateId: null, kind: null });

    const denied = composeFreeformMaterializationDecision(
      STATE, answers({ legal: 0.1 }), settings.confidencePolicy[LANE]);
    expect(denied).toMatchObject({ band: "fallback", candidateId: null, reason: "attempt_not_legal" });

    // The recorded selection shape rejects prose/stat/state-shaped extras and unknown kinds.
    const base = {
      candidateId: CANDIDATES[0]!.candidateId,
      kind: "materialize-location",
      needsContent: true,
      legal: true,
      signals: { needsContent: 0.95, legal: 0.95, candidate: 0.95 },
      topSignal: 0.95,
      reason: "candidate_selected",
    };
    expect(freeformMaterializationSelectionSchema.safeParse(base).success).toBe(true);
    expect(freeformMaterializationSelectionSchema.safeParse({ ...base, prose: "invented" }).success).toBe(false);
    expect(freeformMaterializationSelectionSchema.safeParse({ ...base, kind: "invented-kind" }).success).toBe(false);
  });
});
