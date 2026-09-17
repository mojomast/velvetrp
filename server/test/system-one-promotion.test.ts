import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYSTEM_ONE_LANE_GATES,
  SYSTEM_ONE_PROMOTION_RECORDS,
  assertPromoted,
  evaluatePromotionGate,
  isLanePromoted,
  promotionRecord,
} from "../src/agent/systemOnePromotion.js";
import type { CalibrationMetrics, SystemOneLaneGate } from "../src/agent/systemOnePromotion.js";
import { wilsonLowerBound } from "../src/agent/systemOneGateStatistics.js";
import { SYSTEM_ONE_LANES } from "../src/types.js";

const passingMetrics: CalibrationMetrics = {
  samples: 60,
  accuracy: 0.95,
  brier: 0.1,
  expectedCalibrationError: 0.1,
};

const gate: SystemOneLaneGate = {
  minSamples: 30,
  minAccuracy: 0.9,
  maxBrier: 0.1,
  maxExpectedCalibrationError: 0.1,
};

describe("System One promotion gate", () => {
  it("promotes a lane that clears every gate", () => {
    const result = evaluatePromotionGate("director-selection", passingMetrics);
    expect(result.promoted).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.lane).toBe("director-selection");
    expect(result.gates).toEqual(DEFAULT_SYSTEM_ONE_LANE_GATES["director-selection"]);
  });

  it("fails on too few samples with a precise reason", () => {
    const result = evaluatePromotionGate("director-selection", { ...passingMetrics, samples: 29 });
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual(["insufficient samples: 29 < 30"]);
  });

  it("fails on low accuracy with a precise reason", () => {
    const result = evaluatePromotionGate("director-selection", {
      ...passingMetrics,
      accuracy: 0.8,
      brier: 0.05,
      expectedCalibrationError: 0.05,
    });
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual([
      "accuracy below minimum: 0.8000 < 0.9000",
      "accuracy lower bound below minimum: 0.6822 < 0.8000",
    ]);
  });

  it("fails on high Brier with a precise reason", () => {
    const result = evaluatePromotionGate("director-selection", {
      ...passingMetrics,
      accuracy: 0.95,
      brier: 0.2,
      expectedCalibrationError: 0.05,
    });
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual(["brier above maximum: 0.2000 > 0.1000"]);
  });

  it("fails on high expected calibration error with a precise reason", () => {
    const result = evaluatePromotionGate("director-selection", {
      ...passingMetrics,
      accuracy: 0.95,
      brier: 0.05,
      expectedCalibrationError: 0.2,
    });
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual(["expected calibration error above maximum: 0.2000 > 0.1000"]);
  });

  it("reports every failed gate, not just the first", () => {
    const result = evaluatePromotionGate("director-selection", {
      samples: 5,
      accuracy: 0.4,
      brier: 0.5,
      expectedCalibrationError: 0.5,
    });
    expect(result.promoted).toBe(false);
    expect(result.reasons).toHaveLength(5);
    expect(result.reasons).toContain("accuracy lower bound below minimum: 0.1176 < 0.8000");
  });

  it("holds guardrails and cost-router to stricter defaults", () => {
    const borderline: CalibrationMetrics = {
      samples: 30,
      accuracy: 0.92,
      brier: 0.08,
      expectedCalibrationError: 0.08,
    };
    for (const lane of ["guardrails", "cost-router"] as const) {
      expect(DEFAULT_SYSTEM_ONE_LANE_GATES[lane].minAccuracy).toBe(0.95);
      expect(DEFAULT_SYSTEM_ONE_LANE_GATES[lane].minAccuracy).toBeGreaterThan(gate.minAccuracy);
      const result = evaluatePromotionGate(lane, borderline);
      expect(result.promoted).toBe(false);
      expect(result.reasons).toContain("accuracy below minimum: 0.9200 < 0.9500");
    }
  });

  it("starts memory-reranking looser than the base gate", () => {
    const rerankingGate = DEFAULT_SYSTEM_ONE_LANE_GATES["memory-reranking"];
    expect(rerankingGate.minSamples).toBeLessThan(gate.minSamples);
    expect(rerankingGate.minAccuracy).toBeLessThan(gate.minAccuracy);
    expect(rerankingGate.maxBrier).toBeGreaterThan(gate.maxBrier);
    expect(rerankingGate.maxExpectedCalibrationError).toBeGreaterThan(gate.maxExpectedCalibrationError);
    expect(rerankingGate.minAccuracyLowerBound).toBe(0.75);
    expect(rerankingGate.minAccuracyLowerBound!).toBeLessThan(DEFAULT_SYSTEM_ONE_LANE_GATES["director-selection"].minAccuracyLowerBound!);
    const result = evaluatePromotionGate("memory-reranking", {
      samples: 20,
      accuracy: 1,
      brier: 0.15,
      expectedCalibrationError: 0.15,
    });
    expect(result.promoted).toBe(true);
  });

  it("honors a per-call gate override", () => {
    const strict: SystemOneLaneGate = {
      minSamples: 100,
      minAccuracy: 0.99,
      maxBrier: 0.01,
      maxExpectedCalibrationError: 0.01,
    };
    const result = evaluatePromotionGate("director-selection", passingMetrics, strict);
    expect(result.promoted).toBe(false);
    expect(result.gates).toBe(strict);
    expect(result.reasons).toContain("insufficient samples: 60 < 100");

    const looser: SystemOneLaneGate = {
      minSamples: 1,
      minAccuracy: 0.1,
      maxBrier: 0.9,
      maxExpectedCalibrationError: 0.9,
    };
    expect(evaluatePromotionGate("director-selection", { ...passingMetrics, samples: 1 }, looser).promoted).toBe(true);
  });

  it("assertPromoted throws for a not-ready lane and is silent for a ready one", () => {
    const notReady = evaluatePromotionGate("guardrails", { ...passingMetrics, samples: 1 });
    expect(notReady.promoted).toBe(false);
    expect(() => assertPromoted(notReady)).toThrow(/guardrails/);
    expect(() => assertPromoted(notReady)).toThrow(/not ready for promotion/);

    const ready = evaluatePromotionGate("director-selection", passingMetrics);
    expect(() => assertPromoted(ready)).not.toThrow();
  });

  it("throws RangeError for invalid metrics", () => {
    expect(() => evaluatePromotionGate("director-selection", { ...passingMetrics, samples: -1 })).toThrow(RangeError);
    expect(() => evaluatePromotionGate("director-selection", { ...passingMetrics, samples: Number.NaN })).toThrow(RangeError);
    expect(() => evaluatePromotionGate("director-selection", { ...passingMetrics, samples: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => evaluatePromotionGate("director-selection", { ...passingMetrics, accuracy: 1.01 })).toThrow(RangeError);
    expect(() => evaluatePromotionGate("director-selection", { ...passingMetrics, accuracy: -0.01 })).toThrow(RangeError);
    expect(() => evaluatePromotionGate("director-selection", { ...passingMetrics, brier: Number.NaN })).toThrow(RangeError);
    expect(() => evaluatePromotionGate("director-selection", { ...passingMetrics, expectedCalibrationError: 2 })).toThrow(RangeError);
  });

  it("throws RangeError for an invalid gate override", () => {
    expect(() => evaluatePromotionGate("director-selection", passingMetrics, { ...gate, minSamples: -1 })).toThrow(RangeError);
    expect(() => evaluatePromotionGate("director-selection", passingMetrics, { ...gate, minAccuracy: 1.5 })).toThrow(RangeError);
  });

  it("records measured promotions that still clear their own gate", () => {
    for (const lane of SYSTEM_ONE_LANES) {
      const record = SYSTEM_ONE_PROMOTION_RECORDS[lane];
      if (!record) continue;
      expect(record.evidence).toMatch(/\.md$/);
      expect(record.promotedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(evaluatePromotionGate(lane, record.metrics).promoted, `${lane} record must clear its gate`).toBe(true);
    }
  });

  it("promotes exactly the lanes with a recorded, passing gate", () => {
    expect(promotionRecord("speaker-routing")).toMatchObject({ evidence: "docs/system-one-benchmark.md" });
    expect(promotionRecord("cost-router")).toMatchObject({ evidence: "docs/system-one-router-benchmark.md" });
    expect(promotionRecord("narration-verification")).toMatchObject({ evidence: "docs/system-one-narration-benchmark.md" });
    expect(promotionRecord("director-selection")).toMatchObject({ evidence: "docs/system-one-director-calibration.md" });
    expect(promotionRecord("memory-reranking")).toMatchObject({ evidence: "docs/system-one-rerank-benchmark.md" });
    expect(promotionRecord("adventure-selection")).toMatchObject({ evidence: "docs/system-one-adventure-benchmark.md" });
    expect(promotionRecord("guardrails")).toMatchObject({ evidence: "docs/system-one-guardrails-benchmark.md" });
    const promoted = SYSTEM_ONE_LANES.filter((lane) => isLanePromoted(lane));
    expect([...promoted].sort()).toEqual(["adventure-selection", "cost-router", "director-selection", "guardrails", "memory-reranking", "narration-verification", "speaker-routing"]);
  });

  it("has a default gate for every System One lane", () => {
    for (const lane of SYSTEM_ONE_LANES) {
      const laneGate = DEFAULT_SYSTEM_ONE_LANE_GATES[lane];
      expect(laneGate).toBeDefined();
      expect(laneGate.minSamples).toBeGreaterThan(0);
      expect(laneGate.minAccuracy).toBeGreaterThan(0);
      expect(laneGate.minAccuracy).toBeLessThanOrEqual(1);
      expect(laneGate.maxBrier).toBeGreaterThanOrEqual(0);
      expect(laneGate.maxBrier).toBeLessThanOrEqual(1);
      expect(laneGate.maxExpectedCalibrationError).toBeGreaterThanOrEqual(0);
      expect(laneGate.maxExpectedCalibrationError).toBeLessThanOrEqual(1);
    }
    expect(Object.keys(DEFAULT_SYSTEM_ONE_LANE_GATES).sort()).toEqual([...SYSTEM_ONE_LANES].sort());
  });
});

describe("System One promotion gate v2 criteria", () => {
  const safetyGateContext = {
    safety: {
      hazardous: { samples: 20, accuracy: 0.9, brier: 0.1, expectedCalibrationError: 0.1 },
      benign: { samples: 10, accuracy: 0.88, brier: 0.1, expectedCalibrationError: 0.1 },
    },
  };

  it("keeps today's decision when the optional fields and context are absent", () => {
    const today = evaluatePromotionGate("director-selection", passingMetrics);
    const explicitUndefined = evaluatePromotionGate(
      "director-selection",
      passingMetrics,
      DEFAULT_SYSTEM_ONE_LANE_GATES["director-selection"],
      undefined,
    );
    expect(today.promoted).toBe(true);
    expect(today.reasons).toEqual([]);
    expect(JSON.stringify(explicitUndefined)).toBe(JSON.stringify(today));

    // Context alone changes nothing unless an opt-in criterion is enabled, even when malformed.
    const ignored = evaluatePromotionGate("director-selection", passingMetrics, gate, {
      coverage: { actedSamples: 5, opportunities: 0 },
    });
    expect(ignored.promoted).toBe(true);
    expect(isLanePromoted("guardrails")).toBe(true);
  });

  it("adopts the accuracy lower bound in the default gates by tier", () => {
    for (const lane of SYSTEM_ONE_LANES) {
      const gate = DEFAULT_SYSTEM_ONE_LANE_GATES[lane];
      expect(gate.minAccuracyLowerBound).toBeDefined();
      // Coverage and safety stay opt-in: they need evaluation context.
      expect(gate.minActedRate).toBeUndefined();
      expect(gate.minHazardousAccuracy).toBeUndefined();
      expect(gate.maxBenignFalsePositiveRate).toBeUndefined();
    }
    expect(DEFAULT_SYSTEM_ONE_LANE_GATES["director-selection"].minAccuracyLowerBound).toBe(0.8);
    expect(DEFAULT_SYSTEM_ONE_LANE_GATES["adventure-selection"].minAccuracyLowerBound).toBe(0.8);
    expect(DEFAULT_SYSTEM_ONE_LANE_GATES["memory-reranking"].minAccuracyLowerBound).toBe(0.75);
    expect(DEFAULT_SYSTEM_ONE_LANE_GATES.guardrails.minAccuracyLowerBound).toBe(0.85);
    expect(DEFAULT_SYSTEM_ONE_LANE_GATES["cost-router"].minAccuracyLowerBound).toBe(0.85);
  });

  it("gates accuracy on the Wilson lower bound when minAccuracyLowerBound is set", () => {
    // 27/30: the same borderline metrics the default gate now rejects at the base tier.
    const borderline: CalibrationMetrics = { samples: 30, accuracy: 0.9, brier: 0.1, expectedCalibrationError: 0.1 };
    const strict: SystemOneLaneGate = { ...gate, minAccuracyLowerBound: 0.75 };
    const result = evaluatePromotionGate("director-selection", borderline, strict);
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual(["accuracy lower bound below minimum: 0.7438 < 0.7500"]);
    expect(wilsonLowerBound(27, 30)).toBeCloseTo(0.7438, 3);

    const lenient: SystemOneLaneGate = { ...gate, minAccuracyLowerBound: 0.74 };
    expect(evaluatePromotionGate("director-selection", borderline, lenient).promoted).toBe(true);
  });

  it("treats a zero-sample holdout as a zero lower bound instead of throwing", () => {
    const empty: CalibrationMetrics = { samples: 0, accuracy: 0, brier: 0, expectedCalibrationError: 0 };
    const lenient: SystemOneLaneGate = {
      minSamples: 0,
      minAccuracy: 0,
      maxBrier: 1,
      maxExpectedCalibrationError: 1,
      minAccuracyLowerBound: 0.5,
    };
    const result = evaluatePromotionGate("director-selection", empty, lenient);
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual(["accuracy lower bound below minimum: 0.0000 < 0.5000"]);
  });

  it("fails a lane below the acted-coverage floor with a precise reason", () => {
    const covered: SystemOneLaneGate = { ...gate, minActedRate: 0.3 };
    const failing = evaluatePromotionGate("director-selection", passingMetrics, covered, {
      coverage: { actedSamples: 28, opportunities: 100 },
    });
    expect(failing.promoted).toBe(false);
    expect(failing.reasons).toEqual(["acted coverage below minimum: 0.2800 < 0.3000"]);

    const passing = evaluatePromotionGate("director-selection", passingMetrics, covered, {
      coverage: { actedSamples: 30, opportunities: 100 },
    });
    expect(passing.promoted).toBe(true);
  });

  it("fails cleanly when an enabled coverage gate has no context", () => {
    const covered: SystemOneLaneGate = { ...gate, minActedRate: 0.3 };
    const result = evaluatePromotionGate("director-selection", passingMetrics, covered, {});
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual(["acted coverage below minimum: missing coverage context < 0.3000"]);
  });

  it("rejects malformed coverage context", () => {
    const covered: SystemOneLaneGate = { ...gate, minActedRate: 0.3 };
    expect(() =>
      evaluatePromotionGate("director-selection", passingMetrics, covered, {
        coverage: { actedSamples: 1, opportunities: 0 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      evaluatePromotionGate("director-selection", passingMetrics, covered, {
        coverage: { actedSamples: 101, opportunities: 100 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      evaluatePromotionGate("director-selection", passingMetrics, covered, {
        coverage: { actedSamples: Number.NaN, opportunities: 100 },
      }),
    ).toThrow(RangeError);
  });

  it("fails a lane below the hazardous-accuracy safety bar", () => {
    const safetyGate: SystemOneLaneGate = { ...gate, minHazardousAccuracy: 0.95 };
    const result = evaluatePromotionGate("guardrails", passingMetrics, safetyGate, safetyGateContext);
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual(["hazardous accuracy below safety minimum: 0.9000 < 0.9500"]);
  });

  it("fails a lane above the benign false-positive ceiling", () => {
    const safetyGate: SystemOneLaneGate = { ...gate, maxBenignFalsePositiveRate: 0.1 };
    const result = evaluatePromotionGate("guardrails", passingMetrics, safetyGate, safetyGateContext);
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual(["benign false-positive rate above maximum: 0.1200 > 0.1000"]);
  });

  it("records no benign reason unless the benign ceiling itself is set", () => {
    const safetyGate: SystemOneLaneGate = { ...gate, minHazardousAccuracy: 0.95 };
    const result = evaluatePromotionGate("guardrails", passingMetrics, safetyGate, safetyGateContext);
    expect(result.reasons.some((reason) => reason.startsWith("benign"))).toBe(false);

    const passing: SystemOneLaneGate = { ...gate, maxBenignFalsePositiveRate: 0.15 };
    expect(evaluatePromotionGate("guardrails", passingMetrics, passing, safetyGateContext).promoted).toBe(true);
  });

  it("fails cleanly when an enabled safety gate has no context", () => {
    const safetyGate: SystemOneLaneGate = { ...gate, minHazardousAccuracy: 0.95, maxBenignFalsePositiveRate: 0.1 };
    const result = evaluatePromotionGate("guardrails", passingMetrics, safetyGate, {});
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual([
      "hazardous accuracy below safety minimum: missing safety context < 0.9500",
      "benign false-positive rate above maximum: missing safety context > 0.1000",
    ]);
  });

  it("validates both safety sub-metrics", () => {
    const safetyGate: SystemOneLaneGate = { ...gate, minHazardousAccuracy: 0.95 };
    expect(() =>
      evaluatePromotionGate("guardrails", passingMetrics, safetyGate, {
        safety: { hazardous: { ...passingMetrics, accuracy: 1.5 }, benign: passingMetrics },
      }),
    ).toThrow(RangeError);
    expect(() =>
      evaluatePromotionGate("guardrails", passingMetrics, safetyGate, {
        safety: { hazardous: passingMetrics, benign: { ...passingMetrics, samples: -1 } },
      }),
    ).toThrow(RangeError);
  });

  it("rejects out-of-range values for the optional gate fields", () => {
    expect(() =>
      evaluatePromotionGate("director-selection", passingMetrics, { ...gate, minAccuracyLowerBound: 1.5 }),
    ).toThrow(RangeError);
    expect(() =>
      evaluatePromotionGate("director-selection", passingMetrics, { ...gate, minActedRate: -0.1 }),
    ).toThrow(RangeError);
    expect(() =>
      evaluatePromotionGate("director-selection", passingMetrics, { ...gate, minHazardousAccuracy: Number.NaN }),
    ).toThrow(RangeError);
    expect(() =>
      evaluatePromotionGate("director-selection", passingMetrics, { ...gate, maxBenignFalsePositiveRate: 2 }),
    ).toThrow(RangeError);
  });

  it("reports every optional criterion failure in a stable order", () => {
    const strict: SystemOneLaneGate = {
      ...gate,
      minAccuracyLowerBound: 0.9,
      minActedRate: 0.5,
      minHazardousAccuracy: 0.99,
      maxBenignFalsePositiveRate: 0.05,
    };
    const result = evaluatePromotionGate("guardrails", passingMetrics, strict, {
      coverage: { actedSamples: 10, opportunities: 100 },
      ...safetyGateContext,
    });
    expect(result.promoted).toBe(false);
    expect(result.reasons).toEqual([
      "accuracy lower bound below minimum: 0.8630 < 0.9000",
      "acted coverage below minimum: 0.1000 < 0.5000",
      "hazardous accuracy below safety minimum: 0.9000 < 0.9900",
      "benign false-positive rate above maximum: 0.1200 > 0.0500",
    ]);
  });
});
