#!/usr/bin/env node
/**
 * Runs the L1 Director selector against the provider-free candidate oracle using the
 * real System One (Jev) adapter, sweeps the action threshold over a dev/holdout split,
 * grades predicted probabilities with Brier/ECE, and evaluates the promotion gate.
 *
 * Opt-in live evaluation: TYPESAFE_API_KEY must be exported. It uses a throwaway data
 * directory and never touches an existing store.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-director.ts [--repeat 8] [--out docs/system-one-director-calibration.md]
 */
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  buildDirectorQuestions, composeDirectorSelection, type DirectorCandidateProjection,
} from "../server/src/agent/systemOneDirector.js";
import { applyCalibration, fitPlattCalibration, type PlattCalibration } from "../server/src/agent/systemOneCalibration.js";
import { evaluatePromotionGate } from "../server/src/agent/systemOnePromotion.js";
import {
  aggregateThresholdSamples, selectActionThreshold, type ThresholdPoint, type ThresholdSample,
} from "../server/src/agent/systemOneThreshold.js";
import { defaultSystemOneSettings } from "../server/src/defaults.js";
import { completeWithSystemOne, type SystemOneAnswer } from "../server/src/provider/systemOneCompletion.js";
import { gradeCalibration } from "../server/test/evals/dmGraders.js";
import { dmFixture } from "../server/test/fixtures/dmCampaign.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEY = process.env.TYPESAFE_API_KEY?.trim() ?? "";
if (!KEY) {
  console.error("TYPESAFE_API_KEY is required for the live Director calibration.");
  process.exit(1);
}
process.env.VELVET_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "velvet-system-one-director-eval-"));

const DEFAULT_THRESHOLD = 0.75;
const THRESHOLD_GRID = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90];
const DIRECTOR_SECRET = "SECRET_GM_ONLY:the-mayor-is-the-traitor";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

function plan(fixture: Fixture, key: string): DirectorCandidateProjection[] {
  fixture.repo.setDmControl("local-owner", fixture.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: `${key}-ai` });
  const run = fixture.repo.openDmBeat("local-owner", fixture.campaign.id, fixture.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: key });
  const work = fixture.repo.claimDmPlanning("local-owner", run.runId, "eval", "eval");
  return (work?.candidates ?? []).map((candidate) => ({
    candidateId: candidate.candidateId, digest: candidate.digest, action: candidate.action, label: candidate.label,
  }));
}

async function gmOnlyFixture(): Promise<Fixture> {
  const fixture = await dmFixture();
  const content = generatedCampaignContentProviderSchema.parse({ storyNodes: [{ key: "secret", title: "SECRET_TITLE", description: DIRECTOR_SECRET, visibility: "gm" }] });
  const context = fixture.repo.getCampaignGenerationContext("local-owner", fixture.campaign.id, [])!;
  const draft = fixture.repo.createGenerationDraft("local-owner", {
    campaignId: fixture.campaign.id, timelineId: fixture.campaign.activeTimelineId, kind: "content-pack",
    stagedContent: { kind: "campaign-content", requestDigest: "a".repeat(64), baseContentRevision: context.revision, dependencyDigests: {}, ...content },
    validation: { valid: true, issues: [], validatedAt: fixture.options.clock.now().toISOString() },
    expectedCampaignRevision: fixture.repo.getCampaignAdministration("local-owner", fixture.campaign.id)!.revision, idempotencyKey: "gm-draft",
  });
  fixture.repo.recordCampaignGenerationCandidate(draft.draftId, content, []);
  fixture.repo.applyCampaignContentGenerationDraftAtomically("local-owner", {
    draftId: draft.draftId, expectedDraftRevision: 0, expectedCampaignRevision: draft.campaignRevision,
    idempotencyKey: "gm-accept", selectedArtifactKeys: ["secret"],
  });
  return fixture;
}

async function readState(id: string, options: { gmOnly?: boolean; setup?: (fixture: Fixture) => void }): Promise<DirectorCandidateProjection[]> {
  const fixture = options.gmOnly ? await gmOnlyFixture() : await dmFixture();
  options.setup?.(fixture);
  const projection = plan(fixture, id);
  fixture.repo.close();
  return projection;
}

interface Scenario {
  id: string;
  projection: DirectorCandidateProjection[];
  /** The oracle's preferred outcome: the intended action, or `hold` when no beat should be forced. */
  preferred: string;
  /** Other legal-but-not-preferred actions for this state; accepting them is not a regression. */
  acceptable?: string[];
  /** Held out from threshold selection so the selected threshold is validated out of sample. */
  holdout: boolean;
}

interface Readout {
  method: string;
  selectedAction: string | null;
  topSignal: number;
  acted: boolean;
  /** The primary metric: held / preferred action / an accepted alternative. */
  correct: boolean;
  /** The strict quality metric: exactly the preferred action (or held when `hold` is preferred). */
  exact: boolean;
}

interface CalibrationMetrics { brier: number; expectedCalibrationError: number }
interface CalibrationReport {
  fitted: PlattCalibration;
  devSamples: number;
  holdoutSamples: number;
  /** Fit on development, scored on the held-out split: the unbiased estimate. */
  holdout: { raw: CalibrationMetrics; calibrated: CalibrationMetrics };
  /** Scored over every collected decision with the development-fit map. */
  all: { raw: CalibrationMetrics; calibrated: CalibrationMetrics };
}

function readout(scenario: Scenario, answers: Record<string, SystemOneAnswer>, thresholds: { actionThreshold: number; reviewThreshold: number }): Readout {
  const composed = composeDirectorSelection(scenario.projection, answers, thresholds);
  const selected = composed.selections[0];
  const selectedAction = selected ? scenario.projection.find((candidate) => candidate.candidateId === selected.candidateId)?.action ?? null : null;
  const acceptable = new Set([scenario.preferred, ...(scenario.acceptable ?? [])]);
  const correct = scenario.preferred === "hold" ? composed.hold : selectedAction !== null && acceptable.has(selectedAction);
  const exact = scenario.preferred === "hold" ? composed.hold : selectedAction === scenario.preferred;
  return { method: composed.method, selectedAction, topSignal: composed.topSignal ?? 0, acted: composed.band === "act", correct, exact };
}

function actionsOf(scenario: Scenario): string[] {
  return [...new Set(scenario.projection.map((candidate) => candidate.action))].sort();
}

function table(points: readonly ThresholdPoint[]): string[] {
  const lines = ["| Action threshold | Acted | Coverage | Acted accuracy |", "| ---: | ---: | ---: | ---: |"];
  for (const point of points) {
    lines.push(`| ${point.threshold.toFixed(2)} | ${point.acted}/${point.total} | ${(point.coverage * 100).toFixed(1)}% | ${point.acted === 0 ? "n/a" : `${(point.actedAccuracy * 100).toFixed(1)}%`} |`);
  }
  return lines;
}

function render(input: {
  scenarios: readonly Scenario[];
  repeats: number;
  model: string;
  defaultOutcomes: Readout[];
  allPoints: ThresholdPoint[];
  devPoints: ThresholdPoint[];
  holdoutPoints: ThresholdPoint[];
  selected: ReturnType<typeof selectActionThreshold>;
  gate: ReturnType<typeof evaluatePromotionGate>;
  samples: number;
  exactAccuracy: number;
  gateStats: Array<{ id: string; acted: number; total: number; accuracy: number; meanPredicted: number }>;
  calibration: CalibrationReport;
}): string {
  const { scenarios, repeats, model, defaultOutcomes, allPoints, devPoints, holdoutPoints, selected, gate, samples, exactAccuracy, gateStats, calibration } = input;
  const selectedThreshold = selected.selected?.threshold;
  const holdoutAtSelected = selectedThreshold === undefined ? undefined : holdoutPoints.find((point) => point.threshold === selectedThreshold);
  const lines: string[] = [];
  lines.push("# System One Director (L1) calibration");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} by \`scripts/evaluate-system-one-director.ts\` using the live System One adapter.`);
  lines.push("");
  lines.push("The L1 selector builds three atomic questions per advertised candidate — `legal` (may this be committed now?), `progress` (does it advance an active story objective?), and a priority `score` — plus a `hold` `noul` and an aggregate `best_candidate` `choice`. It composes grounded candidates (legal **and** progress at the action threshold, ordered by priority) → best-pick → hold → defer. Because Director beats mutate campaign state, the aggregate best-pick must clear the **action** threshold and the picked candidate must be legal.");
  lines.push("");
  lines.push("Correctness uses a two-tier provider-free candidate oracle. **Acceptable** (the primary, gating metric) means the selected action is the preferred beat or a legal non-regression alternative; **exact** means the single preferred beat. `hold` is only preferred where no beat should be forced. This grades a trustworthy beat, not one arbitrary label among several legal ones.");
  lines.push("");
  lines.push(`Live model: \`${model}\`. ${scenarios.length} scenarios x ${repeats} repeats = ${samples} sampled decisions per threshold.`);
  lines.push("");
  lines.push(`## Scenarios at the default threshold (${DEFAULT_THRESHOLD})`);
  lines.push("");
  lines.push("| Scenario | Oracle actions | Preferred | Acceptable | Method | Selected | Top signal | Acted | Accept | Exact |");
  lines.push("| --- | --- | --- | --- | --- | --- | ---: | :---: | :---: | :---: |");
  scenarios.forEach((scenario, index) => {
    const outcome = defaultOutcomes[index]!;
    lines.push(`| ${scenario.id} | ${actionsOf(scenario).join(", ") || "—"} | ${scenario.preferred} | ${(scenario.acceptable ?? []).join(", ") || "—"} | ${outcome.method} | ${outcome.selectedAction ?? (outcome.method === "hold" ? "hold" : "—")} | ${outcome.topSignal.toFixed(3)} | ${outcome.acted ? "yes" : "defer"} | ${outcome.acted ? (outcome.correct ? "yes" : "no") : "n/a"} | ${outcome.acted ? (outcome.exact ? "yes" : "no") : "n/a"} |`);
  });
  lines.push("");
  lines.push("## Threshold sweep (all samples)");
  lines.push("");
  lines.push(...table(allPoints));
  lines.push("");
  lines.push("## Threshold selection");
  lines.push("");
  lines.push(`Selection is made on the **development split only** (${scenarios.filter((scenario) => !scenario.holdout).map((scenario) => scenario.id).join(", ") || "none"}), then validated on the held-out split (${scenarios.filter((scenario) => scenario.holdout).map((scenario) => scenario.id).join(", ") || "none"}).`);
  lines.push("");
  if (selected.selected) {
    lines.push(`Selected action threshold: **${selected.selected.threshold.toFixed(2)}** (dev coverage ${(selected.selected.coverage * 100).toFixed(1)}%, dev acted accuracy ${(selected.selected.actedAccuracy * 100).toFixed(1)}% over ${selected.selected.acted} acted decisions).`);
    if (holdoutAtSelected) {
      lines.push(`Held-out coverage ${(holdoutAtSelected.coverage * 100).toFixed(1)}%, held-out acted accuracy ${holdoutAtSelected.acted === 0 ? "n/a" : `${(holdoutAtSelected.actedAccuracy * 100).toFixed(1)}%`} over ${holdoutAtSelected.acted} acted decisions.`);
    }
  } else {
    lines.push("No threshold qualified on the development split.");
  }
  if (selected.reasons.length > 0) for (const reason of selected.reasons) lines.push(`- ${reason}`);
  lines.push("");
  lines.push("## Development sweep");
  lines.push("");
  lines.push(...table(devPoints));
  lines.push("");
  lines.push("## Holdout sweep");
  lines.push("");
  lines.push(...table(holdoutPoints));
  lines.push("");
  lines.push("## Per-scenario at the selected threshold");
  lines.push("");
  lines.push("| Scenario | Acted | Coverage | Acted accuracy | Mean predicted |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const stat of gateStats) {
    lines.push(`| ${stat.id} | ${stat.acted}/${stat.total} | ${((stat.acted / stat.total) * 100).toFixed(1)}% | ${stat.acted === 0 ? "n/a" : `${(stat.accuracy * 100).toFixed(1)}%`} | ${stat.acted === 0 ? "n/a" : stat.meanPredicted.toFixed(3)} |`);
  }
  lines.push("");
  lines.push("## Calibration (fit on development, scored on holdout)");
  lines.push("");
  lines.push(`Fitted a monotonic Platt map on ${calibration.devSamples} acted development decision(s).`);
  lines.push("");
  lines.push("| Split | Signal | Brier | ECE |");
  lines.push("| --- | --- | ---: | ---: |");
  lines.push(`| held-out (${calibration.holdoutSamples} acted) | raw | ${calibration.holdout.raw.brier.toFixed(4)} | ${calibration.holdout.raw.expectedCalibrationError.toFixed(4)} |`);
  lines.push(`| held-out (${calibration.holdoutSamples} acted) | calibrated | ${calibration.holdout.calibrated.brier.toFixed(4)} | ${calibration.holdout.calibrated.expectedCalibrationError.toFixed(4)} |`);
  lines.push(`| all collected | raw | ${calibration.all.raw.brier.toFixed(4)} | ${calibration.all.raw.expectedCalibrationError.toFixed(4)} |`);
  lines.push(`| all collected | calibrated | ${calibration.all.calibrated.brier.toFixed(4)} | ${calibration.all.calibrated.expectedCalibrationError.toFixed(4)} |`);
  lines.push("");
  lines.push(`Map: \`sigmoid(a * logit(p) + b)\` with a = ${calibration.fitted.a.toFixed(4)}, b = ${calibration.fitted.b.toFixed(4)}. The held-out row is the unbiased estimate; because this frozen corpus has no errors, the fit is provisional until the corpus is larger and includes error cases.`);
  lines.push("");
  lines.push("## Promotion gate — `director-selection`");
  lines.push("");
  lines.push(`**${gate.promoted ? "PROMOTE" : "NOT READY"}**`);
  lines.push("");
  if (gate.reasons.length === 0) lines.push("All gates passed.");
  else for (const reason of gate.reasons) lines.push(`- ${reason}`);
  lines.push("");
  lines.push(`Exact (preferred-action) accuracy among acted decisions: ${(exactAccuracy * 100).toFixed(1)}%. The gate uses acceptable accuracy, which counts a legal non-regression beat as a pass.`);
  lines.push("");
  lines.push("The gate scores the **calibrated** signal over every collected decision (the lane would ship with the calibration map); the held-out row above is the unbiased calibration estimate. Calibration is scored only on acted decisions, so deferrals are coverage, not misses.");
  lines.push("");
  lines.push("The gate is a ceiling on confidence, not a guarantee: sample counts and holdout choice still matter, and a not-ready lane keeps its deterministic fallback. A frozen corpus with no error cases cannot stress-test calibration; treat a pass as a promotion candidate until shadow data with negative examples exists.");
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf("--out");
  const repeatIndex = process.argv.indexOf("--repeat");
  const repeats = Math.max(1, Math.min(25, Number(repeatIndex >= 0 ? process.argv[repeatIndex + 1] : "8") || 8));
  const outPath = path.resolve(ROOT, outIndex >= 0 ? (process.argv[outIndex + 1] ?? "docs/system-one-director-calibration.md") : "docs/system-one-director-calibration.md");
  const settings = { ...defaultSystemOneSettings(), apiKey: KEY };

  const empty = await readState("empty-world", {});
  const graph = await readState("story-graph", { setup: (fixture) => fixture.graph() });
  const revealed = await readState("story-graph-revealed", {
    setup: (fixture) => {
      fixture.graph("story-revealed");
      const revision = fixture.repo.getCampaignStory("local-owner", fixture.campaign.id)!.revision;
      fixture.repo.executeStorylineCommand("local-owner", "story-revealed", { kind: "reveal-node", targetId: "gate", data: {}, expectedRevision: revision, idempotencyKey: "revealed-gate" });
    },
  });
  const prepared = await readState("encounter-prep", { setup: (fixture) => fixture.prepare() });
  const active = await readState("encounter-active", {
    setup: (fixture) => {
      // An enemy-only encounter makes the enemy the deterministic current combatant, so the
      // state always advertises `enemy-turn` (an ally would be id-order dependent).
      const encounter = fixture.repo.createEncounter("local-owner", fixture.campaign.id, {
        sessionId: fixture.session.id, name: "Solo ambush",
        combatants: [{ kind: "enemy", template: fixture.enemy, team: "enemies" }],
        idempotencyKey: "active-enemy-only",
      }).encounter;
      fixture.repo.startEncounter("local-owner", encounter.encounterId, { expectedRevision: encounter.revision, idempotencyKey: "active-enemy-start" });
    },
  });
  const gmOnly = await readState("gm-only", { gmOnly: true });

  const scenarios: Scenario[] = [
    { id: "empty-world", projection: empty, preferred: "ambient-beat", acceptable: ["advance-time"], holdout: false },
    { id: "story-graph", projection: graph, preferred: "reveal-node", acceptable: ["ambient-beat", "advance-time"], holdout: false },
    { id: "encounter-prep", projection: prepared, preferred: "encounter-start", holdout: false },
    { id: "story-graph-revealed", projection: revealed, preferred: "reveal-clue", acceptable: ["ambient-beat", "advance-time"], holdout: true },
    { id: "encounter-active", projection: active, preferred: "enemy-turn", holdout: true },
    { id: "gm-only", projection: gmOnly, preferred: "hold", holdout: true },
  ];

  const samples: ThresholdSample[] = [];
  const devSamples: ThresholdSample[] = [];
  const holdoutSamples: ThresholdSample[] = [];
  const defaultOutcomes: Readout[] = scenarios.map(() => ({ method: "defer", selectedAction: null, topSignal: 0, acted: false, correct: false, exact: false }));
  const collected: Array<{ scenario: Scenario; answers: Record<string, SystemOneAnswer> }> = [];
  let model = settings.model;

  for (const [index, scenario] of scenarios.entries()) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const questions = buildDirectorQuestions(scenario.projection);
      const result = await completeWithSystemOne({ settings, state: { scenario: scenario.id, repeat }, questions });
      model = result.model.responseModel ?? model;
      collected.push({ scenario, answers: result.answers });
      if (repeat === 0) {
        defaultOutcomes[index] = readout(scenario, result.answers, { actionThreshold: DEFAULT_THRESHOLD, reviewThreshold: 0.5 });
      }
      for (const threshold of THRESHOLD_GRID) {
        const outcome = readout(scenario, result.answers, { actionThreshold: threshold, reviewThreshold: Math.min(0.5, threshold) });
        const sample: ThresholdSample = { threshold, acted: outcome.acted, correct: outcome.correct, predictedProbability: outcome.topSignal };
        samples.push(sample);
        (scenario.holdout ? holdoutSamples : devSamples).push(sample);
      }
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  const allPoints = aggregateThresholdSamples(samples, THRESHOLD_GRID);
  const devPoints = aggregateThresholdSamples(devSamples, THRESHOLD_GRID);
  const holdoutPoints = aggregateThresholdSamples(holdoutSamples, THRESHOLD_GRID);
  const selected = selectActionThreshold(devSamples, { thresholds: THRESHOLD_GRID, minAccuracy: 0.9, minActed: 4, targetCoverage: 0.4 });

  // The promotion gate is evaluated at the selected threshold, not the default, so it
  // reflects the configuration we would actually ship.
  const selectedThreshold = selected.selected?.threshold ?? DEFAULT_THRESHOLD;
  const gateThresholds = { actionThreshold: selectedThreshold, reviewThreshold: Math.min(0.5, selectedThreshold) };
  const gateOutcomes = collected.map(({ scenario, answers }) => ({ id: scenario.id, ...readout(scenario, answers, gateThresholds) }));
  const actedOutcomes = gateOutcomes.filter((outcome) => outcome.acted);
  const gateStats = scenarios.map((scenario) => {
    const outcomes = gateOutcomes.filter((outcome) => outcome.id === scenario.id);
    const acted = outcomes.filter((outcome) => outcome.acted);
    return {
      id: scenario.id,
      acted: acted.length,
      total: outcomes.length,
      accuracy: acted.length === 0 ? 0 : acted.filter((outcome) => outcome.correct).length / acted.length,
      meanPredicted: acted.length === 0 ? 0 : acted.reduce((sum, outcome) => sum + outcome.topSignal, 0) / acted.length,
    };
  });
  const accuracy = actedOutcomes.length === 0 ? 0 : actedOutcomes.filter((outcome) => outcome.correct).length / actedOutcomes.length;
  const exactAccuracy = actedOutcomes.length === 0 ? 0 : actedOutcomes.filter((outcome) => outcome.exact).length / actedOutcomes.length;

  // Fit the calibration map on the development split and score it on the held-out split, so
  // the reported improvement is out of sample. The same map produces the calibrated signal
  // the gate scores over every collected decision. An empty split yields the identity map.
  const allOutcomes = collected.map(({ scenario, answers }) => ({ holdout: scenario.holdout, ...readout(scenario, answers, gateThresholds) }));
  const devActed = allOutcomes.filter((outcome) => !outcome.holdout && outcome.acted);
  const holdoutActed = allOutcomes.filter((outcome) => outcome.holdout && outcome.acted);
  const fitted = fitPlattCalibration(devActed.map((outcome) => ({ predictedProbability: outcome.topSignal, correct: outcome.correct })));
  const metrics = (outcomes: ReadonlyArray<{ topSignal: number; correct: boolean }>, calibrated: boolean): CalibrationMetrics => {
    const graded = gradeCalibration(outcomes.map((outcome) => ({ predictedProbability: calibrated ? applyCalibration(outcome.topSignal, fitted) : outcome.topSignal, correct: outcome.correct })), 10);
    return { brier: graded.brier, expectedCalibrationError: graded.expectedCalibrationError };
  };
  const calibration: CalibrationReport = {
    fitted,
    devSamples: devActed.length,
    holdoutSamples: holdoutActed.length,
    holdout: { raw: metrics(holdoutActed, false), calibrated: metrics(holdoutActed, true) },
    all: { raw: metrics(actedOutcomes, false), calibrated: metrics(actedOutcomes, true) },
  };
  // The lane ships with the calibration map, so the gate scores the calibrated signal.
  const gate = evaluatePromotionGate("director-selection", {
    samples: actedOutcomes.length, accuracy, brier: calibration.all.calibrated.brier, expectedCalibrationError: calibration.all.calibrated.expectedCalibrationError,
  });

  const markdown = render({ scenarios, repeats, model, defaultOutcomes, allPoints, devPoints, holdoutPoints, selected, gate, samples: scenarios.length * repeats, exactAccuracy, gateStats, calibration });
  await writeFile(outPath, markdown, "utf8");
  await writeFile(outPath.replace(/\.md$/, ".json"), JSON.stringify({ model, repeats, allPoints, devPoints, holdoutPoints, selected, gate, exactAccuracy, gateStats, calibration }, null, 2), "utf8");

  console.log(`selected threshold: ${selected.selected ? selected.selected.threshold.toFixed(2) : "none"} (dev coverage ${selected.selected ? (selected.selected.coverage * 100).toFixed(1) : 0}%, dev accuracy ${selected.selected ? (selected.selected.actedAccuracy * 100).toFixed(1) : 0}%)`);
  console.log(`acted: ${actedOutcomes.length} acceptable=${(accuracy * 100).toFixed(1)}% exact=${(exactAccuracy * 100).toFixed(1)}%`);
  console.log(`gate: promoted=${gate.promoted}${gate.reasons.length ? ` reasons=${gate.reasons.join("; ")}` : ""}`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
