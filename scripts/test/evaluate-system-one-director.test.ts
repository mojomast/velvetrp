import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DIRECTOR_HOLD_KEY,
  DIRECTOR_PRIORITY_PREFIX,
  DIRECTOR_PROGRESS_PREFIX,
  type DirectorComposition,
} from "../../server/src/agent/systemOneDirector.js";
import { evaluatePromotionGate } from "../../server/src/agent/systemOnePromotion.js";
import { selectActionThreshold } from "../../server/src/agent/systemOneThreshold.js";
import type { SystemOneAnswer } from "../../server/src/provider/systemOneCompletion.js";
import {
  DEFAULT_THRESHOLD,
  HARVEST_FIXTURE,
  HARVEST_ID_PREFIX,
  THRESHOLD_GRID,
  directorSelectionDecision,
  directorStabilitySamples,
  loadHarvestedDirectorScenarios,
  mergeHarvestedDirectorScenarios,
  parseHarvestedDirectorScenarios,
  readout,
  renderDirectorCalibration,
  summarizeDirectorStability,
  type DirectorDecisionSample,
  type Scenario,
} from "../evaluate-system-one-director.js";

const digestOf = (value: string): string => value.padEnd(64, "f");

const score = (value: number): SystemOneAnswer => ({
  type: "score",
  score: value,
  confidence: 1,
  legend: { "0": "low priority", "1": "medium priority" },
  probabilities: { [`${value}`]: 1 },
});

const thresholds = { actionThreshold: DEFAULT_THRESHOLD, reviewThreshold: 0.5 };

/** A synthetic confirmed-harvest proposal; the merge validates it defensively at runtime. */
const harvestProposal = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  proposalId: "1".repeat(64),
  lane: "director-selection",
  sourceDecisionId: "decision-1",
  createdAt: "2026-09-17T00:00:00.000Z",
  provenance: "review-annotated",
  status: "confirmed",
  state: {
    private_context: { summary: "a quiet road" },
    candidates: [
      { candidateId: "beat:a", digest: "a".repeat(64), action: "ambient-beat", label: "An ambient moment", pacing: true },
      { candidateId: "beat:b", digest: "b".repeat(64), action: "reveal-node", label: "Reveal the gate", pacing: false },
      { candidateId: "beat:c", digest: "c".repeat(64), action: "advance-time", label: "Time passes", pacing: false },
    ],
  },
  expected: { selections: ["beat:b", "beat:a"] },
  reason: "human review confirmed the recorded director-selection decision",
  ...overrides,
});

const projectionCandidate = (
  candidateId: string,
  action: string,
  pacing?: boolean,
): { candidateId: string; digest: string; action: string; label: string; pacing?: boolean } => ({
  candidateId,
  digest: digestOf(candidateId),
  action,
  label: `${candidateId} (${action})`,
  ...(pacing === undefined ? {} : { pacing }),
});

const composition = (overrides: Partial<DirectorComposition> = {}): DirectorComposition => ({
  band: "act",
  method: "candidates",
  hold: false,
  selections: [{ candidateId: "beat:a", digest: digestOf("beat:a") }],
  topSignal: 0.8,
  ...overrides,
});

const selection = (candidateId: string): { candidateId: string; digest: string } => ({
  candidateId,
  digest: digestOf(candidateId),
});

test("merges confirmed harvested proposals into ordered candidate-id scenarios", () => {
  const merged = mergeHarvestedDirectorScenarios([
    harvestProposal(),
    harvestProposal({ proposalId: "2".repeat(64), expected: { selections: [] } }),
    // beat:y is not advertised, so this confirmed proposal is skipped.
    harvestProposal({ proposalId: "3".repeat(64), expected: { selections: ["beat:x", "beat:y"] } }),
    harvestProposal({ proposalId: "4".repeat(64), lane: "adventure-selection" }),
    harvestProposal({ proposalId: "5".repeat(64), status: "proposed" }),
  ]);

  assert.equal(merged.confirmed, 3, "confirmed lane-matching proposals are counted before skips");
  assert.equal(merged.skipped, 1);
  assert.equal(merged.scenarios.length, 2);

  const primary = merged.scenarios.find((scenario) => scenario.id === `${HARVEST_ID_PREFIX}${"1".repeat(12)}`);
  assert.ok(primary);
  assert.equal(primary.provenance, "harvested");
  assert.equal(primary.holdout, false, "harvested scenarios are development scenarios");
  assert.equal(primary.preferred, "beat:b", "the first ordered selection is the preferred beat");
  assert.deepEqual(primary.acceptable, ["beat:a"], "the remaining ordered selections are acceptable");
  assert.deepEqual(
    primary.projection.map((candidate) => [candidate.candidateId, candidate.action, candidate.pacing]),
    [
      ["beat:a", "ambient-beat", true],
      ["beat:b", "reveal-node", false],
      // The recorded `pacing: false` is stale; pacing is recomputed from the action like the recorder.
      ["beat:c", "advance-time", true],
    ],
  );

  const hold = merged.scenarios.find((scenario) => scenario.id === `${HARVEST_ID_PREFIX}${"2".repeat(12)}`);
  assert.ok(hold);
  assert.equal(hold.preferred, "hold", "an empty selection list is a confirmed hold");
  assert.deepEqual(hold.acceptable, []);
});

test("skips unusable harvested states, expectations, and duplicate ids", () => {
  const merged = mergeHarvestedDirectorScenarios([
    harvestProposal(),
    harvestProposal({ proposalId: `${"1".repeat(12)}${"9".repeat(52)}` }), // same id prefix as the first
    harvestProposal({ proposalId: "6".repeat(64), expected: null }),
    harvestProposal({ proposalId: "7".repeat(64), expected: { selections: "beat:a" } }),
    harvestProposal({ proposalId: "8".repeat(64), expected: { selections: [42] } }),
    harvestProposal({ proposalId: "9".repeat(64), state: "not-an-object" }),
    harvestProposal({ proposalId: "a".repeat(64), state: { candidates: "nope" } }),
    harvestProposal({
      proposalId: "b".repeat(64),
      state: { candidates: [{ candidateId: "beat:a", digest: "a".repeat(64), action: "ambient-beat" }] },
    }),
    harvestProposal({
      proposalId: "c".repeat(64),
      state: { candidates: [{ candidateId: "beat:a", digest: "a".repeat(64), action: "ambient-beat", label: "Beat", extra: true }] },
    }),
    harvestProposal({
      proposalId: "d".repeat(64),
      state: { candidates: [{ candidateId: "beat:a", digest: "a".repeat(64), action: "ambient-beat", label: "Beat", pacing: "yes" }] },
    }),
  ]);

  assert.equal(merged.confirmed, 10);
  assert.equal(merged.skipped, 9, "duplicate, null, malformed, unadvertised, and unusable states are skipped");
  assert.equal(merged.scenarios.length, 1);
  assert.equal(merged.scenarios[0]?.id, `${HARVEST_ID_PREFIX}${"1".repeat(12)}`);
});

test("grades harvested scenarios by exact candidate id and holds by the composed hold", () => {
  const scenario: Scenario = {
    id: `${HARVEST_ID_PREFIX}${"a".repeat(12)}`,
    projection: [
      projectionCandidate("beat:a", "ambient-beat", true),
      projectionCandidate("beat:b", "reveal-node"),
    ],
    preferred: "beat:b",
    acceptable: ["beat:a"],
    holdout: false,
    provenance: "harvested",
  };
  const answers: Record<string, SystemOneAnswer> = {
    [`${DIRECTOR_PROGRESS_PREFIX}beat:a`]: { type: "noul", noul: 0.2 },
    [`${DIRECTOR_PROGRESS_PREFIX}beat:b`]: { type: "noul", noul: 0.9 },
    [`${DIRECTOR_PRIORITY_PREFIX}beat:a`]: score(0),
    [`${DIRECTOR_PRIORITY_PREFIX}beat:b`]: score(1),
    [DIRECTOR_HOLD_KEY]: { type: "noul", noul: 0.1 },
  };

  const preferred = readout(scenario, answers, thresholds);
  assert.equal(preferred.method, "candidates");
  assert.equal(preferred.selectedAction, "reveal-node");
  assert.equal(preferred.correct, true);
  assert.equal(preferred.exact, true, "the preferred candidate id is an exact pick");

  const alternative = readout(scenario, {
    ...answers,
    [`${DIRECTOR_PROGRESS_PREFIX}beat:a`]: { type: "noul", noul: 0.9 },
    [`${DIRECTOR_PROGRESS_PREFIX}beat:b`]: { type: "noul", noul: 0.2 },
    [`${DIRECTOR_PRIORITY_PREFIX}beat:a`]: score(1),
  }, thresholds);
  assert.equal(alternative.selectedAction, "ambient-beat");
  assert.equal(alternative.correct, true, "an acceptable harvested candidate is not a regression");
  assert.equal(alternative.exact, false, "an acceptable harvested candidate is not the preferred pick");

  const holdScenario: Scenario = { ...scenario, preferred: "hold", acceptable: [] };
  const held = readout(holdScenario, {
    ...answers,
    [`${DIRECTOR_PROGRESS_PREFIX}beat:a`]: { type: "noul", noul: 0.1 },
    [`${DIRECTOR_PROGRESS_PREFIX}beat:b`]: { type: "noul", noul: 0.1 },
    [DIRECTOR_HOLD_KEY]: { type: "noul", noul: 0.9 },
  }, thresholds);
  assert.equal(held.method, "hold");
  assert.equal(held.selectedAction, null);
  assert.equal(held.correct, true);
  assert.equal(held.exact, true);
});

test("treats an absent or malformed harvest fixture as zero scenarios without failing", async () => {
  const missing = await loadHarvestedDirectorScenarios(path.join(tmpdir(), `velvet-director-harvest-missing-${process.pid}.json`));
  assert.deepEqual(
    { scenarios: missing.scenarios.length, present: missing.present, warning: missing.warning },
    { scenarios: 0, present: false, warning: null },
  );

  const notJson = parseHarvestedDirectorScenarios("{not json");
  assert.equal(notJson.scenarios.length, 0);
  assert.equal(notJson.present, true);
  assert.ok(notJson.warning?.includes("not valid JSON"));

  const noProposals = parseHarvestedDirectorScenarios(JSON.stringify({ version: 1, lane: "director-selection", generatedAt: "2026-09-17T00:00:00.000Z" }));
  assert.equal(noProposals.scenarios.length, 0);
  assert.ok(noProposals.warning?.includes("proposals"));

  const wrongVersion = parseHarvestedDirectorScenarios(JSON.stringify({ version: 2, lane: "director-selection", generatedAt: "x", proposals: [] }));
  assert.equal(wrongVersion.scenarios.length, 0);
  assert.ok(wrongVersion.warning?.includes("version"));

  const wrongLane = parseHarvestedDirectorScenarios(JSON.stringify({ version: 1, lane: "adventure-selection", generatedAt: "x", proposals: [harvestProposal()] }));
  assert.equal(wrongLane.scenarios.length, 0);
  assert.ok(wrongLane.warning?.includes("adventure-selection"));

  const fixture = { version: 1, lane: "director-selection", generatedAt: "2026-09-17T00:00:00.000Z", proposals: [harvestProposal()] };
  const parsed = parseHarvestedDirectorScenarios(JSON.stringify(fixture));
  assert.equal(parsed.warning, null);
  assert.equal(parsed.scenarios.length, 1);
  assert.equal(parsed.scenarios[0]?.provenance, "harvested");

  const directory = await mkdtemp(path.join(tmpdir(), "velvet-director-harvest-"));
  try {
    const file = path.join(directory, "director-selection.json");
    await writeFile(file, JSON.stringify(fixture), "utf8");
    const loaded = await loadHarvestedDirectorScenarios(file);
    assert.equal(loaded.present, true);
    assert.equal(loaded.warning, null);
    assert.equal(loaded.scenarios.length, 1);

    const unreadable = await loadHarvestedDirectorScenarios(directory);
    assert.equal(unreadable.scenarios.length, 0);
    assert.equal(unreadable.present, true);
    assert.ok(unreadable.warning?.includes("could not be read"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("joins the composed ordered selection into a stable decision string", () => {
  assert.equal(
    directorSelectionDecision({ hold: false, selections: [selection("beat:b"), selection("beat:a")] }),
    "beat:b > beat:a",
    "the join preserves the composed order",
  );
  assert.equal(
    directorSelectionDecision({ hold: false, selections: [selection("beat:a"), selection("beat:b")] }),
    "beat:a > beat:b",
  );
  assert.notEqual(
    directorSelectionDecision({ hold: false, selections: [selection("beat:b"), selection("beat:a")] }),
    directorSelectionDecision({ hold: false, selections: [selection("beat:a"), selection("beat:b")] }),
    "a reordered selection is a different decision",
  );
  assert.equal(directorSelectionDecision({ hold: true, selections: [] }), "hold");
  assert.equal(directorSelectionDecision({ hold: false, selections: [] }), "defer", "a composition that commits nothing defers");
});

test("rolls up decision stability with one consistent case and one conflict", () => {
  const samples: DirectorDecisionSample[] = [
    { scenarioId: "stable", composition: composition() },
    { scenarioId: "stable", composition: composition({ topSignal: 0.6 }) },
    { scenarioId: "conflicted", composition: composition() },
    { scenarioId: "conflicted", composition: composition({ selections: [selection("beat:b")], topSignal: 0.7 }) },
  ];
  const summary = summarizeDirectorStability(samples);

  assert.equal(summary.cases.length, 2);
  assert.equal(summary.repeats, 4);
  assert.equal(summary.conflictCases, 1);
  assert.equal(summary.conflictRate, 0.5);
  assert.equal(summary.meanAgreement, 0.75);

  const stable = summary.cases[0]!;
  assert.equal(stable.agreement, 1);
  assert.equal(stable.conflicted, false);
  assert.deepEqual(stable.decisions, ["beat:a"]);
  assert.ok(stable.signalStdDev !== null && Math.abs(stable.signalStdDev - 0.1) < 1e-9);

  const conflicted = summary.cases[1]!;
  assert.equal(conflicted.agreement, 0.5);
  assert.deepEqual(conflicted.decisions, ["beat:a", "beat:b"]);
  assert.ok(conflicted.signalStdDev !== null && Math.abs(conflicted.signalStdDev - 0.05) < 1e-9);

  assert.ok(summary.meanSignalStdDev !== null && Math.abs(summary.meanSignalStdDev - 0.075) < 1e-9);
  assert.ok(summary.maxSignalStdDev !== null && Math.abs(summary.maxSignalStdDev - 0.1) < 1e-9);

  assert.deepEqual(
    directorStabilitySamples([
      { scenarioId: "hold", composition: composition({ hold: true, selections: [] }) },
      { scenarioId: "defer", composition: composition({ selections: [], topSignal: null }) },
    ]),
    [
      { caseId: "hold", decision: "hold", signal: 0.8 },
      { caseId: "defer", decision: "defer", signal: null },
    ],
  );
});

test("renders the stability roll-up, harvest provenance, and the absent-fixture row", () => {
  const scenario: Scenario = {
    id: "frozen",
    projection: [projectionCandidate("beat:a", "ambient-beat", true)],
    preferred: "ambient-beat",
    holdout: false,
    provenance: "frozen",
  };
  const base = {
    scenarios: [scenario],
    repeats: 1,
    model: "jev-test",
    defaultOutcomes: [{ method: "defer", selectedAction: null, topSignal: 0, acted: false, correct: false, exact: false }],
    allPoints: [],
    devPoints: [],
    holdoutPoints: [],
    selected: selectActionThreshold([], { thresholds: THRESHOLD_GRID, minAccuracy: 0.9, minActed: 4, targetCoverage: 0.4 }),
    gate: evaluatePromotionGate("director-selection", { samples: 0, accuracy: 0, brier: 1, expectedCalibrationError: 1 }),
    samples: 1,
    exactAccuracy: 0,
    gateStats: [{ id: "frozen", acted: 0, total: 1, accuracy: 0, meanPredicted: 0 }],
    calibration: {
      fitted: { a: 1, b: 0 },
      devSamples: 0,
      holdoutSamples: 0,
      holdout: { raw: { brier: 0, expectedCalibrationError: 0 }, calibrated: { brier: 0, expectedCalibrationError: 0 } },
      all: { raw: { brier: 0, expectedCalibrationError: 0 }, calibrated: { brier: 0, expectedCalibrationError: 0 } },
    },
    negatives: { acted: 0, incorrect: 0, inexact: 0, lowestIncorrectSignal: null },
    stability: summarizeDirectorStability([{ scenarioId: "frozen", composition: composition() }]),
  };
  const report = renderDirectorCalibration({
    ...base,
    harvest: { fixture: HARVEST_FIXTURE, present: false, confirmed: 0, skipped: 0, cases: 0, warning: null },
  });

  assert.ok(report.startsWith("# System One Director (L1) calibration"));
  assert.ok(report.includes("## Setup"));
  assert.ok(report.includes("| Harvested cases | 0 confirmed merged, 0 skipped — fixture absent |"));
  assert.ok(report.includes("| frozen | frozen |"), "the scenarios table marks provenance");
  assert.ok(report.includes("## Decision stability"));
  assert.ok(report.includes("| Mean agreement | 100.0% |"));
  assert.ok(report.includes("| Conflict cases | 0 of 1 (0.0%) |"));
  assert.ok(report.includes("repeatability, not accuracy"));
  assert.ok(!report.includes("Harvest warning"), "an absent fixture produces no warning");
  assert.ok(!report.includes("are **harvested** rows"), "an absent fixture adds no harvested note");

  const warningReport = renderDirectorCalibration({
    ...base,
    harvest: { fixture: HARVEST_FIXTURE, present: true, confirmed: 0, skipped: 0, cases: 0, warning: "harvested fixture is not valid JSON: boom" },
  });
  assert.ok(warningReport.includes("> **Harvest warning:** harvested fixture is not valid JSON: boom"));
  assert.ok(warningReport.includes("Those proposals are skipped; the run continues."));
});
