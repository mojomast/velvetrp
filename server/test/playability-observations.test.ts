import { describe, expect, it } from "vitest";
import { PLAYABILITY_OBSERVATIONS, validatePlayabilityObservations } from "./fixtures/playability-observations.js";

describe("Plan 3 playability observations", () => {
  it("provides stable source-bound recall probes and negatives", () => {
    expect(() => validatePlayabilityObservations()).not.toThrow();
    expect(PLAYABILITY_OBSERVATIONS.map(item => item.id)).toEqual(expect.arrayContaining(["p3-harbor-task-accepted-v1", "p3-harbor-negotiation-failed-v1", "p3-harbor-saltglass-alternate-v1", "p3-harbor-keeper-statement-v1", "p3-harbor-clue-timing-v1", "p3-harbor-reward-unclaimed-v1", "p3-harbor-reward-claimed-v1", "p3-harbor-location-past-v1", "p3-harbor-location-current-v1", "p3-harbor-finale-callback-v1", "p3-harbor-unsupported-retreat-v1"]));
    expect(new Set(PLAYABILITY_OBSERVATIONS.map(item => item.id)).size).toBe(PLAYABILITY_OBSERVATIONS.length);
    expect(PLAYABILITY_OBSERVATIONS.every(item => ["turn-receipt", "dm-receipt", "quest-projection", "world-projection", "reward-projection", "callback"].includes(item.sourceKind) && ["public", "owner"].includes(item.audience) && ["past", "current", "post-finale"].includes(item.timeline) && ["none", "negotiation", "timing", "claim", "location", "callback"].includes(item.failureCategory))).toBe(true);
    expect(JSON.stringify(PLAYABILITY_OBSERVATIONS)).not.toContain("HARBOR-SENTINEL-PRIVATE-7");
  });
});
