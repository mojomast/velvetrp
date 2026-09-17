import { describe, expect, it } from "vitest";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  buildDirectorQuestions,
  composeDirectorSelection,
  DIRECTOR_BEST_KEY,
  DIRECTOR_HOLD_KEY,
  DIRECTOR_NONE,
  DIRECTOR_PRIORITY_PREFIX,
  DIRECTOR_PROGRESS_PREFIX,
  type DirectorCandidateProjection,
} from "../../src/agent/systemOneDirector.js";
import { defaultSystemOneSettings } from "../../src/defaults.js";
import type { SystemOneAnswer } from "../../src/provider/systemOneCompletion.js";
import { createFakeSystemOneCaller } from "../../src/provider/systemOneFake.js";
import { dmFixture } from "../fixtures/dmCampaign.js";
import { useTmpDataDir } from "../helpers.js";
import { gradeCalibration } from "./dmGraders.js";
import type { DmCalibrationPoint } from "./dmEvalTypes.js";

useTmpDataDir();

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

const DIRECTOR_SECRET = "SECRET_GM_ONLY:the-mayor-is-the-traitor";
const UNSUPPORTED_SIGNAL = 0.1;
const DEFAULT_SUPPORT = 0.9;

/** Deterministic candidate-choice oracle: build a state, then read the exact advertised action set. */
function plan(f: Fixture, key: string) {
  f.repo.setDmControl("local-owner", f.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: `${key}-ai` });
  const run = f.repo.openDmBeat("local-owner", f.campaign.id, f.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: key });
  const work = f.repo.claimDmPlanning("local-owner", run.runId, "eval", "eval");
  const candidates = work?.candidates ?? [];
  const actions = [...new Set(candidates.map((candidate) => candidate.action))].sort();
  return { candidates, actions };
}

async function gmOnlyFixture(key: string) {
  const f = await dmFixture();
  const content = generatedCampaignContentProviderSchema.parse({
    storyNodes: [{ key: "secret", title: "SECRET_TITLE", description: DIRECTOR_SECRET, visibility: "gm" }],
  });
  const context = f.repo.getCampaignGenerationContext("local-owner", f.campaign.id, [])!;
  const draft = f.repo.createGenerationDraft("local-owner", {
    campaignId: f.campaign.id, timelineId: f.campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: f.options.clock.now().toISOString() },
    expectedCampaignRevision: f.repo.getCampaignAdministration("local-owner", f.campaign.id)!.revision, idempotencyKey: `${key}-draft`,
  });
  f.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  f.repo.applyCampaignContentGenerationDraftAtomically("local-owner", {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: `${key}-accept`, selectedArtifactKeys: ["secret"],
  });
  return f;
}

interface StateReadout {
  id: string;
  projection: DirectorCandidateProjection[];
  actions: string[];
}

async function readState(id: string, options: { gmOnly?: boolean; setup?: (fixture: Fixture) => void }): Promise<StateReadout> {
  const fixture = options.gmOnly ? await gmOnlyFixture(id) : await dmFixture();
  options.setup?.(fixture);
  const { candidates, actions } = plan(fixture, id);
  fixture.repo.close();
  const projection = candidates.map((candidate) => ({
    candidateId: candidate.candidateId, digest: candidate.digest, action: candidate.action, label: candidate.label,
  }));
  return { id, projection, actions };
}

const noul = (value: number): SystemOneAnswer => ({ type: "noul", noul: value });
const priority = (score: number): SystemOneAnswer => ({
  type: "score", score, confidence: 0.9,
  legend: { "0": "low priority", "1": "medium priority", "2": "high priority" },
  probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 },
});
function distribution(keys: readonly string[], winner: string, winnerProbability: number): Record<string, number> {
  const probabilities: Record<string, number> = {};
  const others = keys.filter((key) => key !== winner);
  const share = others.length > 0 ? (1 - winnerProbability) / others.length : 0;
  for (const key of keys) probabilities[key] = key === winner ? winnerProbability : share;
  if (others.length === 0) probabilities[winner] = 1;
  return probabilities;
}

interface SelectorSpec {
  id: string;
  state: StateReadout;
  /** The oracle's expected action for this state, or `hold` when it advertises no candidate. */
  expected: string;
  method: "candidates" | "best-pick" | "hold";
  pick?: string;
  support?: number;
}

interface ScenarioOutcome {
  id: string;
  expected: string;
  actions: string[];
  method: string;
  selectedAction: string | null;
  point: DmCalibrationPoint;
}

async function runSelector(spec: SelectorSpec): Promise<ScenarioOutcome> {
  const projection = spec.state.projection;
  const winner = spec.pick ? projection.find((candidate) => candidate.action === spec.pick) : undefined;
  const support = spec.support ?? DEFAULT_SUPPORT;

  const answers: Record<string, SystemOneAnswer> = { [DIRECTOR_HOLD_KEY]: noul(UNSUPPORTED_SIGNAL) };
  for (const candidate of projection) {
    const progressive = spec.method === "candidates" && candidate === winner;
    answers[`${DIRECTOR_PROGRESS_PREFIX}${candidate.candidateId}`] = noul(progressive ? support : UNSUPPORTED_SIGNAL);
    answers[`${DIRECTOR_PRIORITY_PREFIX}${candidate.candidateId}`] = priority(progressive ? 2 : 1);
  }
  if (spec.method === "hold") answers[DIRECTOR_HOLD_KEY] = noul(support);
  if (spec.method === "best-pick") {
    if (!winner) throw new Error(`scenario ${spec.id} requires an advertised pick`);
    answers[DIRECTOR_BEST_KEY] = {
      type: "choice", choice: winner.candidateId, confidence: support,
      probabilities: distribution([...projection.map((candidate) => candidate.candidateId), DIRECTOR_NONE], winner.candidateId, support),
    };
  }

  const questions = buildDirectorQuestions(projection);
  const settings = defaultSystemOneSettings();
  const caller = createFakeSystemOneCaller({ scripted: answers });
  const result = await caller({ settings, state: { scenario: spec.id }, questions });
  const composed = composeDirectorSelection(projection, result.answers, settings.confidencePolicy["director-selection"]);

  const selected = composed.selections[0];
  const selectedAction = selected
    ? projection.find((candidate) => candidate.candidateId === selected.candidateId)?.action ?? null
    : null;
  const correct = spec.expected === "hold" ? composed.hold : selectedAction === spec.expected;
  const predictedProbability = composed.topSignal ?? 0;
  return { id: spec.id, expected: spec.expected, actions: spec.state.actions, method: composed.method, selectedAction,
    point: { predictedProbability, correct } };
}

describe("Director selector calibration through the provider-free oracle", () => {
  it("grades selector probabilities against the advertised candidate set", async () => {
    const empty = await readState("empty-world", {});
    const graph = await readState("story-graph", { setup: (fixture) => fixture.graph() });
    const prepared = await readState("encounter-prep", { setup: (fixture) => fixture.prepare() });
    const gmOnly = await readState("gm-only", { gmOnly: true });

    expect(empty.actions).toEqual(["advance-time", "ambient-beat"]);
    expect(graph.actions).toEqual(["advance-time", "ambient-beat", "reveal-node"]);
    expect(prepared.actions).toEqual(["encounter-start"]);
    expect(gmOnly.actions).toEqual([]);

    const specs: SelectorSpec[] = [
      { id: "empty-world", state: empty, expected: "ambient-beat", method: "candidates", pick: "ambient-beat" },
      { id: "story-graph", state: graph, expected: "reveal-node", method: "candidates", pick: "reveal-node" },
      { id: "encounter-prep", state: prepared, expected: "encounter-start", method: "candidates", pick: "encounter-start" },
      { id: "gm-only", state: gmOnly, expected: "hold", method: "hold" },
      { id: "story-graph-miscalibrated", state: graph, expected: "reveal-node", method: "hold", support: 0.95 },
      { id: "story-graph-best-pick", state: graph, expected: "reveal-node", method: "best-pick", pick: "reveal-node" },
    ];

    const outcomes: ScenarioOutcome[] = [];
    for (const spec of specs) outcomes.push(await runSelector(spec));

    expect(outcomes.map((outcome) => outcome.method)).toEqual(["candidates", "candidates", "candidates", "hold", "hold", "best-pick"]);
    for (const outcome of outcomes) {
      if (outcome.selectedAction !== null) expect(outcome.actions).toContain(outcome.selectedAction);
    }

    const points = outcomes.map((outcome) => outcome.point);
    const report = gradeCalibration(points, 10);

    expect(points).toHaveLength(specs.length);
    expect(report.count).toBe(specs.length);
    expect(points.filter((point) => !point.correct)).toHaveLength(1);
    for (const value of [report.brier, report.expectedCalibrationError]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
    // Four hits at 0.9, one forced-hold hit at 1.0, and one confident miss at 0.95:
    // Brier = (4 * 0.01 + 0 + 0.9025) / 6 = 0.1570833.
    expect(report.brier).toBeCloseTo(0.15708333, 8);
    // All six land in the top bin: mean predicted (3.6 + 1.0 + 0.95) / 6, hit rate 5 / 6 -> ECE = 0.0916667.
    expect(report.expectedCalibrationError).toBeCloseTo(0.09166667, 8);
    expect(report.bins).toBe(10);
  });

  it("reports high Brier and high ECE when every confident answer is wrong", async () => {
    const empty = await readState("wrong-empty", {});
    const graph = await readState("wrong-graph", { setup: (fixture) => fixture.graph() });
    const prepared = await readState("wrong-prepared", { setup: (fixture) => fixture.prepare() });

    const specs: SelectorSpec[] = [
      { id: "wrong-empty", state: empty, expected: "ambient-beat", method: "hold" },
      { id: "wrong-graph", state: graph, expected: "reveal-node", method: "hold" },
      { id: "wrong-prepared", state: prepared, expected: "encounter-start", method: "hold" },
      { id: "wrong-best", state: graph, expected: "reveal-node", method: "best-pick", pick: "advance-time" },
    ];

    const outcomes: ScenarioOutcome[] = [];
    for (const spec of specs) outcomes.push(await runSelector(spec));

    const points = outcomes.map((outcome) => outcome.point);
    expect(points).toHaveLength(specs.length);
    expect(points.every((point) => !point.correct)).toBe(true);
    expect(points.every((point) => point.predictedProbability >= 0.9)).toBe(true);

    const report = gradeCalibration(points, 10);
    expect(report.count).toBe(specs.length);
    // Four misses at 0.9 in the top bin: Brier = 0.81, ECE = 0.9.
    expect(report.brier).toBeCloseTo(0.81, 12);
    expect(report.expectedCalibrationError).toBeCloseTo(0.9, 12);
    expect(report.brier).toBeGreaterThan(0.5);
    expect(report.expectedCalibrationError).toBeGreaterThan(0.5);
  });
});
