import { beforeEach, describe, expect, it } from "vitest";
import {
  FREEFORM_CANDIDATE_KEY,
  FREEFORM_LEGAL_KEY,
  FREEFORM_MATERIALIZATION_CANDIDATE_CAP,
  FREEFORM_MATERIALIZATION_NONE,
  FREEFORM_NEEDS_CONTENT_KEY,
  buildFreeformMaterializationQuestions,
  composeFreeformMaterializationDecision,
  freeformMaterializationSelectionSchema,
  freeformMaterializationStateSchema,
  recordFreeformMaterializationShadowDecision,
  type FreeformMaterializationCandidate,
} from "../src/agent/systemOneFreeformMaterialization.js";
import { SYSTEM_ONE_EXECUTION_CONTRACTS } from "../src/agent/systemOneBinding.js";
import { isLanePromoted, promotionRecord } from "../src/agent/systemOnePromotion.js";
import { defaultSystemOneLaneModes, defaultSystemOneSettings, systemOneLaneMode } from "../src/defaults.js";
import { createFakeSystemOneCaller } from "../src/provider/systemOneFake.js";
import type { SystemOneAnswer } from "../src/provider/systemOneCompletion.js";
import { createRepository, listSystemOneDecisionsByLane, type SystemOneDecisionRecord } from "../src/repo/index.js";
import { SYSTEM_ONE_LANES, type SystemOneSettings } from "../src/types.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const CANDIDATES: FreeformMaterializationCandidate[] = [
  { candidateId: "materialize:glassblower-district", kind: "materialize-location", label: "Glassblower's district" },
  { candidateId: "materialize:glassblower", kind: "materialize-npc", label: "The glassblower" },
];

const INPUT = {
  campaignId: "campaign-shadow",
  sessionId: "session-shadow",
  attempt: "I go to the glassblower's district.",
  candidates: CANDIDATES,
};

function laneSettings(overrides: Partial<SystemOneSettings> = {}): SystemOneSettings {
  return {
    ...defaultSystemOneSettings(),
    enabled: true,
    laneModes: defaultSystemOneLaneModes(),
    apiKey: "test-key",
    ...overrides,
  };
}

/** Deterministic free-form answers: two `noul` gates plus the aggregate `choice`. */
function freeformAnswers(options: {
  needsContent?: number;
  legal?: number;
  choice?: string;
  choiceProbability?: number;
} = {}): Record<string, SystemOneAnswer> {
  const choice = options.choice ?? CANDIDATES[0]!.candidateId;
  const probability = options.choiceProbability ?? 0.95;
  return {
    [FREEFORM_NEEDS_CONTENT_KEY]: { type: "noul", noul: options.needsContent ?? 0.95 },
    [FREEFORM_LEGAL_KEY]: { type: "noul", noul: options.legal ?? 0.95 },
    [FREEFORM_CANDIDATE_KEY]: {
      type: "choice",
      choice,
      confidence: probability,
      probabilities: { [choice]: probability, [FREEFORM_MATERIALIZATION_NONE]: 1 - probability },
    },
  };
}

function selectionOf(row: SystemOneDecisionRecord): Record<string, unknown> {
  return row.selection as Record<string, unknown>;
}

describe("recordFreeformMaterializationShadowDecision", () => {
  beforeEach(() => {
    createRepository();
  });

  it("is shadow-only and carries no execution contract or promotion record", () => {
    expect(SYSTEM_ONE_LANES).toContain("freeform-materialization");
    // Record-only default; System One overall is disabled by default.
    expect(defaultSystemOneLaneModes()["freeform-materialization"]).toBe("shadow");
    expect(systemOneLaneMode(defaultSystemOneSettings(), "freeform-materialization")).toBe("shadow");
    expect(defaultSystemOneSettings().enabled).toBe(false);
    expect(Object.keys(SYSTEM_ONE_EXECUTION_CONTRACTS)).not.toContain("freeform-materialization");
    expect(promotionRecord("freeform-materialization")).toBeUndefined();
    expect(isLanePromoted("freeform-materialization")).toBe(false);
  });

  it("records a typed decision selecting a server-authored candidate in shadow mode", async () => {
    const caller = createFakeSystemOneCaller({ scripted: freeformAnswers(), responseModel: "jev-shadow" });
    await recordFreeformMaterializationShadowDecision(laneSettings(), caller, INPUT);

    expect(caller.calls).toHaveLength(1);
    const rows = listSystemOneDecisionsByLane("freeform-materialization", 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      lane: "freeform-materialization",
      campaignId: "campaign-shadow",
      sessionId: "session-shadow",
      provider: "typesafe",
      model: "jev-shadow",
      confidencePolicyVersion: "system-one-confidence-v1",
      confidenceBand: "act",
      fallbackUsed: true,
      shadow: true,
    });
    expect(selectionOf(row)).toEqual({
      candidateId: CANDIDATES[0]!.candidateId,
      kind: "materialize-location",
      needsContent: true,
      legal: true,
      signals: { needsContent: 0.95, legal: 0.95, candidate: 0.95 },
      topSignal: 0.95,
      reason: "candidate_selected",
    });
    // The model reasoned over exactly the persisted structured state.
    expect(caller.calls[0]!.state).toEqual(row.state);
    const state = row.state as { campaignId: string; sessionId: string; attempt: string; candidates: unknown[] };
    expect(state.attempt).toBe(INPUT.attempt);
    expect(state.candidates).toHaveLength(CANDIDATES.length);
    // The battery is exactly the two gates plus the closed candidate choice.
    const questionKeys = Object.keys(row.questions as Record<string, unknown>);
    expect(questionKeys).toEqual([FREEFORM_NEEDS_CONTENT_KEY, FREEFORM_LEGAL_KEY, FREEFORM_CANDIDATE_KEY]);
    const criteria = (row.questions as Record<string, { criteria: Record<string, unknown> }>)[FREEFORM_CANDIDATE_KEY]!.criteria;
    expect(Object.keys(criteria)).toEqual([...CANDIDATES.map((candidate) => candidate.candidateId), FREEFORM_MATERIALIZATION_NONE]);
  });

  it("fails closed when the choice names a candidate outside the server-authored set", async () => {
    const composed = composeFreeformMaterializationDecision(
      { ...INPUT, candidates: CANDIDATES },
      freeformAnswers({ choice: "materialize:forbidden", choiceProbability: 0.99 }),
      defaultSystemOneSettings().confidencePolicy["freeform-materialization"],
    );
    expect(composed).toMatchObject({ band: "fallback", candidateId: null, kind: null, reason: "missing_or_invalid_answers" });
    expect(composed.signals.candidate).toBeNull();

    const caller = createFakeSystemOneCaller({
      scripted: freeformAnswers({ choice: "materialize:forbidden", choiceProbability: 0.99 }),
    });
    await recordFreeformMaterializationShadowDecision(laneSettings(), caller, INPUT);

    expect(caller.calls).toHaveLength(1);
    const rows = listSystemOneDecisionsByLane("freeform-materialization", 10);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.confidenceBand).toBe("fallback");
    expect(selectionOf(row)).toMatchObject({ candidateId: null, kind: null, reason: "missing_or_invalid_answers" });
  });

  it("fails closed to no action when narration or a hold is sufficient", async () => {
    const caller = createFakeSystemOneCaller({ scripted: freeformAnswers({ needsContent: 0.1 }) });
    await recordFreeformMaterializationShadowDecision(laneSettings(), caller, INPUT);

    const row = listSystemOneDecisionsByLane("freeform-materialization", 10)[0]!;
    expect(row.confidenceBand).toBe("fallback");
    expect(selectionOf(row)).toMatchObject({ candidateId: null, needsContent: false, reason: "narration_or_hold_sufficient" });
  });

  it("fails closed to no action when the legality gate denies the attempt", async () => {
    const caller = createFakeSystemOneCaller({ scripted: freeformAnswers({ legal: 0.1 }) });
    await recordFreeformMaterializationShadowDecision(laneSettings(), caller, INPUT);

    const row = listSystemOneDecisionsByLane("freeform-materialization", 10)[0]!;
    expect(row.confidenceBand).toBe("fallback");
    expect(selectionOf(row)).toMatchObject({ candidateId: null, legal: false, reason: "attempt_not_legal" });
  });

  it("records nothing and never calls when the lane mode is off", async () => {
    const caller = createFakeSystemOneCaller();
    await recordFreeformMaterializationShadowDecision(
      laneSettings({ laneModes: { ...defaultSystemOneLaneModes(), "freeform-materialization": "off" } }),
      caller,
      INPUT,
    );

    expect(caller.calls).toHaveLength(0);
    expect(listSystemOneDecisionsByLane("freeform-materialization", 10)).toHaveLength(0);
  });

  it("stays advisory even when the lane mode is active because no promotion or active path exists", async () => {
    const caller = createFakeSystemOneCaller({ scripted: freeformAnswers() });
    await recordFreeformMaterializationShadowDecision(
      laneSettings({ laneModes: { ...defaultSystemOneLaneModes(), "freeform-materialization": "active" } }),
      caller,
      INPUT,
    );

    const row = listSystemOneDecisionsByLane("freeform-materialization", 10)[0]!;
    expect(row).toMatchObject({ shadow: true, fallbackUsed: true, confidenceBand: "act" });
    expect(isLanePromoted("freeform-materialization")).toBe(false);
  });

  it("records nothing and never throws when the caller fails", async () => {
    const caller = createFakeSystemOneCaller({ failWith: new Error("system one down") });
    await expect(recordFreeformMaterializationShadowDecision(laneSettings(), caller, INPUT)).resolves.toBeUndefined();
    expect(listSystemOneDecisionsByLane("freeform-materialization", 10)).toHaveLength(0);
  });

  it("rejects malformed or out-of-bounds authored state without calling", async () => {
    // Strict state schema: no extra fields, a non-empty bounded closed candidate set, known kinds.
    expect(freeformMaterializationStateSchema.safeParse({ ...INPUT, extra: true }).success).toBe(false);
    expect(freeformMaterializationStateSchema.safeParse({ ...INPUT, candidates: [] }).success).toBe(false);
    expect(freeformMaterializationStateSchema.safeParse({
      ...INPUT,
      candidates: [{ candidateId: "x", kind: "invented-kind", label: "x" }],
    }).success).toBe(false);
    expect(freeformMaterializationStateSchema.safeParse({ ...INPUT, attempt: "x".repeat(4_001) }).success).toBe(false);
    expect(freeformMaterializationStateSchema.safeParse({
      ...INPUT,
      candidates: Array.from({ length: FREEFORM_MATERIALIZATION_CANDIDATE_CAP + 1 }, (_value, index) => ({
        candidateId: `candidate:${index}`,
        kind: "new-clue",
        label: `clue ${index}`,
      })),
    }).success).toBe(false);
    expect(freeformMaterializationStateSchema.safeParse(INPUT).success).toBe(true);

    // Strict selection schema: the recorded top signal and kind stay in bounds.
    const validSelection = {
      candidateId: CANDIDATES[0]!.candidateId,
      kind: "materialize-location",
      needsContent: true,
      legal: true,
      signals: { needsContent: 0.95, legal: 0.95, candidate: 0.95 },
      topSignal: 0.95,
      reason: "candidate_selected",
    };
    expect(freeformMaterializationSelectionSchema.safeParse(validSelection).success).toBe(true);
    expect(freeformMaterializationSelectionSchema.safeParse({ ...validSelection, topSignal: 1.5 }).success).toBe(false);
    expect(freeformMaterializationSelectionSchema.safeParse({ ...validSelection, kind: "invented-kind" }).success).toBe(false);

    const caller = createFakeSystemOneCaller();
    await recordFreeformMaterializationShadowDecision(laneSettings(), caller, { ...INPUT, candidates: [] });
    expect(caller.calls).toHaveLength(0);
    expect(listSystemOneDecisionsByLane("freeform-materialization", 10)).toHaveLength(0);
  });
});

describe("buildFreeformMaterializationQuestions", () => {
  it("embeds the bounded attempt and the closed authored candidate set", () => {
    const questions = buildFreeformMaterializationQuestions({ ...INPUT, candidates: CANDIDATES });
    expect(Object.keys(questions)).toEqual([FREEFORM_NEEDS_CONTENT_KEY, FREEFORM_LEGAL_KEY, FREEFORM_CANDIDATE_KEY]);
    expect(String((questions[FREEFORM_NEEDS_CONTENT_KEY] as { instructions: unknown }).instructions)).toContain(INPUT.attempt);
    expect(String((questions[FREEFORM_LEGAL_KEY] as { instructions: unknown }).instructions)).toContain(INPUT.attempt);
    const criteria = (questions[FREEFORM_CANDIDATE_KEY] as { criteria: Record<string, unknown> }).criteria;
    expect(Object.keys(criteria)).toEqual([...CANDIDATES.map((candidate) => candidate.candidateId), FREEFORM_MATERIALIZATION_NONE]);
    expect(criteria[FREEFORM_MATERIALIZATION_NONE]).toBeTruthy();
  });
});
