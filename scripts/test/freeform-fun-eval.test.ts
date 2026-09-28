import assert from "node:assert/strict";
import test from "node:test";
import {
  computeMetrics,
  detectCoherenceViolations,
  diffMetrics,
  fallbackDistinctness,
  latencyStats,
  providerSuccess,
  type CoherenceProbe,
  type DmBeatRecord,
  type ProviderCallRecord,
  type TurnRecord,
} from "../freeform-fun-eval.js";

function turn(overrides: Partial<TurnRecord>): TurnRecord {
  return {
    index: 0, id: "t", category: "read", declaration: "I look around.", status: 200,
    finalState: "completed", outcome: "done", narration: "", narrationSource: "none",
    narrationEvents: [], committed: false, receiptKinds: [], receiptCommandIds: [],
    confirmed: false, dmBeatIndex: null, providerCalls: 0, latencyMs: 0, coherence: [],
    ...overrides,
  };
}

test("fallbackDistinctness: collapses identical strings and ignores blanks", () => {
  assert.deepEqual(fallbackDistinctness([]), { count: 0, distinct: 0, ratio: 0 });
  const identical = fallbackDistinctness(["hold", "hold", "hold"]);
  assert.equal(identical.count, 3);
  assert.equal(identical.distinct, 1);
  assert.equal(identical.ratio, 1 / 3);
  const distinct = fallbackDistinctness(["hold", "rest holds", ""]);
  assert.equal(distinct.count, 2);
  assert.equal(distinct.distinct, 2);
  assert.equal(distinct.ratio, 1);
});

test("providerSuccess: counts ok/failed and handles the empty case", () => {
  assert.deepEqual(providerSuccess([]), { total: 0, ok: 0, failed: 0, rate: 0 });
  const result = providerSuccess([{ ok: true }, { ok: false }, { ok: true }, { ok: true }]);
  assert.equal(result.total, 4);
  assert.equal(result.ok, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.rate, 0.75);
});

test("latencyStats: avg and percentiles over a sorted sample", () => {
  assert.deepEqual(latencyStats([]), { avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  const stats = latencyStats([100, 200, 300, 400]);
  assert.equal(stats.avgMs, 250);
  assert.equal(stats.p50Ms, 300);
  assert.equal(stats.p95Ms, 400);
  assert.equal(stats.maxMs, 400);
});

test("detectCoherenceViolations: a declared destination resolved elsewhere is a mismatch", () => {
  const known = [{ id: "market", name: "Market" }, { id: "docks", name: "Docks" }, { id: "chapel", name: "Chapel" }];
  const mismatch = detectCoherenceViolations({
    index: 0, turnId: "turn-1", declaration: "I set out for the Docks.",
    actorBeforeId: "market", actorAfterId: "market",
    travelDestinations: [{ id: "chapel", name: "Chapel" }], actionLocations: [], knownLocations: known,
  });
  assert.ok(mismatch.some((value) => value.startsWith("travel-target-mismatch")), mismatch.join(","));
  assert.ok(mismatch.some((value) => value.startsWith("travel-destination-not-reached")), mismatch.join(","));
});

test("detectCoherenceViolations: a coherent travel and unmapped travel do not fire", () => {
  const known = [{ id: "market", name: "Market" }, { id: "docks", name: "Docks" }];
  const coherent = detectCoherenceViolations({
    index: 0, turnId: "turn-1", declaration: "I set out for the Docks.",
    actorBeforeId: "market", actorAfterId: "docks",
    travelDestinations: [{ id: "docks", name: "Docks" }], actionLocations: [], knownLocations: known,
  });
  assert.deepEqual(coherent, []);
  const unmapped = detectCoherenceViolations({
    index: 1, turnId: "turn-2", declaration: "I follow the smugglers' path to the Sunken Cathedral.",
    actorBeforeId: "docks", actorAfterId: "sunken-cathedral",
    travelDestinations: [{ id: null, name: "Sunken Cathedral" }], actionLocations: [], knownLocations: known,
  });
  assert.deepEqual(unmapped, []);
});

test("detectCoherenceViolations: a location-bound action away from the actor fires", () => {
  const known = [{ id: "market", name: "Market" }, { id: "docks", name: "Docks" }];
  const violation = detectCoherenceViolations({
    index: 7, turnId: "turn-8", declaration: "I buy a longsword from the stall.",
    actorBeforeId: "docks", actorAfterId: "docks",
    travelDestinations: [], actionLocations: [{ id: "market", name: "Mara's Goods" }], knownLocations: known,
  });
  assert.equal(violation.length, 1);
  assert.ok(violation[0]!.startsWith("action-location-mismatch"), violation[0]);
  const fine = detectCoherenceViolations({
    index: 8, turnId: "turn-9", declaration: "I buy a longsword from the stall.",
    actorBeforeId: "market", actorAfterId: "market",
    travelDestinations: [], actionLocations: [{ id: "market", name: "Mara's Goods" }], knownLocations: known,
  });
  assert.deepEqual(fine, []);
});

test("computeMetrics: aggregates provider, narration, materialization, beats and latency", () => {
  const calls: ProviderCallRecord[] = [
    { seq: 1, lane: "adventure-narration-v1", ok: true, finishReason: "tool", detail: "", tools: [], promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0, latencyMs: 100, dmCandidates: null },
    { seq: 2, lane: "adventure-narration-v1", ok: false, finishReason: "Error", detail: "boom", tools: [], promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, latencyMs: 50, dmCandidates: null },
  ];
  const turns = [
    turn({ index: 0, narrationSource: "provider-assisted", narrationEvents: [{ phase: "initial", source: "provider-assisted", text: "A" }], committed: true, latencyMs: 1000 }),
    turn({ index: 1, narrationSource: "deterministic-fallback", narrationEvents: [{ phase: "initial", source: "deterministic-fallback", text: "hold" }], committed: false, latencyMs: 3000 }),
    turn({ index: 2, narrationSource: "deterministic-fallback", narrationEvents: [{ phase: "initial", source: "deterministic-fallback", text: "hold" }], committed: true, latencyMs: 2000 }),
  ];
  const beats: DmBeatRecord[] = [
    { index: 0, intent: "open", state: "completed", receipts: ["advance-time"], candidatesOffered: ["x"], narration: "n", blockers: [], latencyMs: 10, success: true },
    { index: 1, intent: "continue", state: "blocked", receipts: [], candidatesOffered: [], narration: "", blockers: ["no-candidate"], latencyMs: 20, success: false },
  ];
  const metrics = computeMetrics(turns, beats, calls);
  assert.equal(metrics.providerSuccessRate, 0.5);
  assert.equal(metrics.narrationsProvider, 1);
  assert.equal(metrics.narrationProviderShare, 1 / 3);
  assert.equal(metrics.fallbackCount, 2);
  assert.equal(metrics.fallbackDistinct, 1);
  assert.equal(metrics.fallbackIdentical, 1);
  assert.equal(metrics.materializedTurns, 2);
  assert.equal(metrics.materializationRate, 2 / 3);
  assert.equal(metrics.dmBeatSuccessRate, 0.5);
  assert.equal(metrics.latencyAvgMs, 2000);
});

test("diffMetrics: computes per-key deltas and direction", () => {
  const diffs = diffMetrics(
    { narrationsProvider: 9, providerFailed: 1, latencyAvgMs: 5000, ignored: 3 },
    { narrationsProvider: 7, providerFailed: 4, latencyAvgMs: 7100, missing: 1 },
  );
  const byKey = new Map(diffs.map((diff) => [diff.key, diff]));
  assert.equal(byKey.size, 3);
  assert.deepEqual(byKey.get("narrationsProvider"), { key: "narrationsProvider", baseline: 7, current: 9, delta: 2, lowerIsBetter: false });
  assert.deepEqual(byKey.get("providerFailed"), { key: "providerFailed", baseline: 4, current: 1, delta: -3, lowerIsBetter: true });
  assert.equal(byKey.get("latencyAvgMs")!.lowerIsBetter, true);
  assert.equal(byKey.has("missing"), false);
  assert.equal(byKey.has("ignored"), false);
});
