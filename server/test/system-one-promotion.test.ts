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
import { SYSTEM_ONE_LANES } from "../src/types.js";

const passingMetrics: CalibrationMetrics = {
  samples: 30,
  accuracy: 0.9,
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
    expect(result.reasons).toEqual(["accuracy below minimum: 0.8000 < 0.9000"]);
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
    expect(result.reasons).toHaveLength(4);
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
    const result = evaluatePromotionGate("memory-reranking", {
      samples: 20,
      accuracy: 0.85,
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
    expect(result.reasons).toContain("insufficient samples: 30 < 100");

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
    const promoted = SYSTEM_ONE_LANES.filter((lane) => isLanePromoted(lane));
    expect([...promoted].sort()).toEqual(["cost-router", "speaker-routing"]);
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
