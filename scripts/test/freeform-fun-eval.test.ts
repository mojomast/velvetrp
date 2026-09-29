import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyNarration,
  computeMetrics,
  detectCoherenceViolations,
  diffMetrics,
  fallbackDistinctness,
  latencyStats,
  narrationClassificationDescriptor,
  probeOutcomes,
  providerSuccess,
  turnExercisesCommerce,
  type DmBeatRecord,
  type NarrationEvent,
  type ProviderCallRecord,
  type TurnRecord,
} from "../freeform-fun-eval.js";

function event(overrides: Partial<NarrationEvent> & Pick<NarrationEvent, "source" | "text">): NarrationEvent {
  return { phase: "initial", ...overrides, class: overrides.class ?? classifyNarration(overrides.text, overrides.source) };
}

function turn(overrides: Partial<TurnRecord>): TurnRecord {
  return {
    index: 0, id: "t", category: "read", declaration: "I look around.", probe: null, status: 200,
    finalState: "completed", outcome: "done", narration: "", narrationSource: "none", narrationClass: "none",
    narrationEvents: [], committed: false, receiptKinds: [], receiptCommandIds: [], proposalToolNames: [],
    confirmed: false, dmBeatIndex: null, providerCalls: 0, latencyMs: 0, coherence: [],
    ...overrides,
  };
}

test("classifyNarration: provider source is provider, regardless of text", () => {
  assert.equal(classifyNarration("Nothing is resolved; but the DM said so", "provider-assisted"), "provider");
  assert.equal(classifyNarration("Suggested next step: Travel to Market.", "provider-assisted"), "provider");
});

test("classifyNarration: deterministic hold lines split from narration failure", () => {
  // A deliberate hold always carries the bounded reason plus a suggested next step.
  assert.equal(classifyNarration("The captain is already there. Suggested next step: Travel to Docks. Nothing is resolved; no movement or other campaign change is established.", "deterministic-fallback"), "deliberate-hold");
  // The "nothing is resolved" close alone is also a hold marker.
  assert.equal(classifyNarration("The scene holds. Nothing is resolved; no movement or other campaign change is established.", "deterministic-fallback"), "deliberate-hold");
  // Generic receipt-free hold prose and receipt-bound composition stay failures.
  assert.equal(classifyNarration("The scene holds. Your intended action remains pending; no movement or other campaign change is established.", "deterministic-fallback"), "narration-failure");
  assert.equal(classifyNarration("The authoritative result is clear. You buy 1 Longsword from Mara.", "deterministic-fallback"), "narration-failure");
  assert.equal(classifyNarration("", "deterministic-fallback"), "narration-failure");
});

test("narrationClassificationDescriptor: documents the split and the probes", () => {
  const descriptor = narrationClassificationDescriptor();
  assert.deepEqual(descriptor.classes, ["provider", "deliberate-hold", "narration-failure"]);
  assert.match(descriptor.fallbackDistinctnessScope, /narration-failure/);
  assert.deepEqual(descriptor.probes.map((probe) => probe.kind), ["declared-purchase", "unknown-npc", "cheating-commerce"]);
});

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

test("turnExercisesCommerce: receipts and vendor proposals both count", () => {
  assert.equal(turnExercisesCommerce({ receiptKinds: ["commerce"], proposalToolNames: [] }), true);
  assert.equal(turnExercisesCommerce({ receiptKinds: [], proposalToolNames: ["vendor_buy"] }), true);
  assert.equal(turnExercisesCommerce({ receiptKinds: [], proposalToolNames: ["vendor_give"] }), true);
  assert.equal(turnExercisesCommerce({ receiptKinds: ["check"], proposalToolNames: ["exact_srd_check.select"] }), false);
});

test("computeMetrics: separates deliberate holds from narration-failure fallbacks", () => {
  const calls: ProviderCallRecord[] = [
    { seq: 1, lane: "adventure-narration-v1", ok: true, finishReason: "tool", detail: "", tools: [], promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: 0, latencyMs: 100, dmCandidates: null },
    { seq: 2, lane: "adventure-narration-v1", ok: false, finishReason: "Error", detail: "boom", tools: [], promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, latencyMs: 50, dmCandidates: null },
  ];
  const turns = [
    turn({ index: 0, narrationSource: "provider-assisted", narrationClass: "provider",
      narrationEvents: [event({ source: "provider-assisted", text: "A" })], committed: true, latencyMs: 1000 }),
    turn({ index: 1, narrationSource: "deterministic-fallback", narrationClass: "deliberate-hold",
      narrationEvents: [event({ source: "deterministic-fallback", text: "Suggested next step: Travel to Docks. Nothing is resolved; no movement or other campaign change is established." })],
      committed: false, latencyMs: 3000 }),
    turn({ index: 2, narrationSource: "deterministic-fallback", narrationClass: "narration-failure",
      narrationEvents: [event({ source: "deterministic-fallback", text: "hold" })], committed: true, latencyMs: 2000 }),
    turn({ index: 3, narrationSource: "deterministic-fallback", narrationClass: "narration-failure",
      narrationEvents: [event({ source: "deterministic-fallback", text: "hold" })], committed: false, latencyMs: 4000 }),
    turn({ index: 4, probe: "declared-purchase", narrationClass: "provider", committed: true,
      receiptKinds: ["commerce"], receiptCommandIds: ["cmd-1"], proposalToolNames: ["vendor_buy"] }),
    turn({ index: 5, probe: "unknown-npc", narrationClass: "deliberate-hold", committed: false,
      narrationEvents: [event({ source: "deterministic-fallback", text: "Suggested next step: Talk to them. Nothing is resolved; no movement or other campaign change is established." })] }),
    turn({ index: 6, probe: "cheating-commerce", narrationClass: "narration-failure", committed: false,
      receiptKinds: [], receiptCommandIds: [], proposalToolNames: [],
      narrationEvents: [event({ source: "deterministic-fallback", text: "That action cannot be established." })] }),
  ];
  const beats: DmBeatRecord[] = [
    { index: 0, intent: "open", state: "completed", receipts: ["advance-time"], candidatesOffered: ["x"], narration: "n", blockers: [], latencyMs: 10, success: true },
    { index: 1, intent: "continue", state: "blocked", receipts: [], candidatesOffered: [], narration: "", blockers: ["no-candidate"], latencyMs: 20, success: false },
  ];
  const metrics = computeMetrics(turns, beats, calls);
  assert.equal(metrics.providerSuccessRate, 0.5);
  assert.equal(metrics.narrationEventsTotal, 6);
  assert.equal(metrics.narrationsProvider, 2);
  assert.equal(metrics.narrationProviderShare, 2 / 7);
  assert.equal(metrics.deliberateHoldTurns, 2);
  assert.equal(metrics.deliberateHoldEvents, 2);
  assert.equal(metrics.deliberateHoldRate, 2 / 7);
  assert.equal(metrics.narrationFailureTurns, 3);
  // The deliberate-hold events (turns 1 and 5) are excluded from the fallback denominator.
  assert.equal(metrics.fallbackCount, 3);
  assert.equal(metrics.fallbackDistinct, 2);
  assert.equal(metrics.fallbackIdentical, 1);
  assert.equal(metrics.fallbackDistinctness, 2 / 3);
  assert.equal(metrics.materializedTurns, 3);
  assert.equal(metrics.materializationRate, 3 / 7);
  assert.equal(metrics.dmBeatSuccessRate, 0.5);
  assert.equal(metrics.latencyAvgMs, Math.round(10000 / 7));
  // Labeled probes.
  assert.equal(metrics.commerceExercised, 1);
  assert.equal(metrics.commerceCommitted, 1);
  assert.equal(metrics.unknownNpcResolvedAsCheck, 0);
  assert.equal(metrics.unknownNpcHeld, 1);
  assert.equal(metrics.cheatingCommerceHeld, 1);
  assert.equal(metrics.cheatingCommerceGiveMisfire, 0);
  assert.equal(metrics.cheatingCommerceReceipts, 0);
});

test("probeOutcomes: declared purchase passes only with a committed commerce receipt", () => {
  const exercisedOnly = probeOutcomes([turn({ probe: "declared-purchase", committed: false,
    proposalToolNames: ["vendor_buy"], receiptKinds: [] })]);
  const purchase = exercisedOnly.find((probe) => probe.kind === "declared-purchase")!;
  assert.equal(purchase.passed, false);
  assert.match(purchase.observed, /commerce proposal surfaced/);

  const committed = probeOutcomes([turn({ probe: "declared-purchase", committed: true,
    proposalToolNames: ["vendor_buy"], receiptKinds: ["commerce"], receiptCommandIds: ["cmd-1"] })]);
  assert.equal(committed.find((probe) => probe.kind === "declared-purchase")!.passed, true);
});

test("probeOutcomes: unknown NPC fails loudly when it resolves as a check", () => {
  const held = probeOutcomes([turn({ probe: "unknown-npc", committed: false, receiptKinds: [] })]);
  assert.equal(held.find((probe) => probe.kind === "unknown-npc")!.passed, true);

  const checked = probeOutcomes([turn({ probe: "unknown-npc", committed: true, receiptKinds: ["check"], receiptCommandIds: ["cmd-1"] })]);
  const probe = checked.find((value) => value.kind === "unknown-npc")!;
  assert.equal(probe.passed, false);
  assert.match(probe.observed, /resolved as a skill check/);
});

test("probeOutcomes: cheating commerce catches the give misfire", () => {
  const held = probeOutcomes([turn({ probe: "cheating-commerce", committed: false, receiptKinds: [], receiptCommandIds: [] })]);
  assert.equal(held.find((probe) => probe.kind === "cheating-commerce")!.passed, true);

  const receiptMisfire = probeOutcomes([turn({ probe: "cheating-commerce", committed: true,
    receiptKinds: ["inventory"], receiptCommandIds: ["cmd-1"] })]);
  assert.equal(receiptMisfire.find((probe) => probe.kind === "cheating-commerce")!.passed, false);

  const proposalMisfire = probeOutcomes([turn({ probe: "cheating-commerce", committed: false,
    receiptKinds: [], proposalToolNames: ["vendor_give"] })]);
  const probe = proposalMisfire.find((value) => value.kind === "cheating-commerce")!;
  assert.equal(probe.passed, false);
  assert.match(probe.observed, /give misfire/);
});

test("probeOutcomes: a missing labeled turn fails instead of silently passing", () => {
  const outcomes = probeOutcomes([turn({ id: "unrelated" })]);
  assert.equal(outcomes.length, 3);
  for (const outcome of outcomes) {
    assert.equal(outcome.passed, false);
    assert.equal(outcome.observed, "no labeled turn ran");
  }
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
