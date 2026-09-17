#!/usr/bin/env node
/**
 * Runs the L1 Director selector against the provider-free candidate oracle using the
 * real System One (Jev) adapter, grades the predicted probabilities with Brier/ECE,
 * and evaluates the director-selection promotion gate.
 *
 * This is an opt-in live evaluation: TYPESAFE_API_KEY must be exported. It uses a
 * throwaway data directory and never touches an existing store.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-director.ts [--out docs/system-one-director-calibration.md]
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
import { evaluatePromotionGate } from "../server/src/agent/systemOnePromotion.js";
import { defaultSystemOneSettings } from "../server/src/defaults.js";
import { completeWithSystemOne } from "../server/src/provider/systemOneCompletion.js";
import { gradeCalibration } from "../server/test/evals/dmGraders.js";
import type { DmCalibrationPoint } from "../server/test/evals/dmEvalTypes.js";
import { dmFixture } from "../server/test/fixtures/dmCampaign.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const KEY = process.env.TYPESAFE_API_KEY?.trim() ?? "";
if (!KEY) {
  console.error("TYPESAFE_API_KEY is required for the live Director calibration.");
  process.exit(1);
}
// Each run gets a fresh throwaway store so repeated evaluations never collide.
process.env.VELVET_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "velvet-system-one-director-eval-"));

type Fixture = Awaited<ReturnType<typeof dmFixture>>;
const DIRECTOR_SECRET = "SECRET_GM_ONLY:the-mayor-is-the-traitor";

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
  expected: string;
}

interface LiveOutcome {
  id: string;
  expected: string;
  actions: string[];
  method: string;
  selectedAction: string | null;
  topSignal: number;
  correct: boolean;
  /** Whether the lane actually acted; a deferral hands off to the existing deterministic path. */
  acted: boolean;
}

async function runLive(scenario: Scenario, settings: ReturnType<typeof defaultSystemOneSettings>): Promise<{ outcome: LiveOutcome; point: DmCalibrationPoint; model: string }> {
  const { projection } = scenario;
  const questions = buildDirectorQuestions(projection);
  const result = await completeWithSystemOne({ settings, state: { scenario: scenario.id }, questions });
  const composed = composeDirectorSelection(projection, result.answers, settings.confidencePolicy["director-selection"]);
  const selected = composed.selections[0];
  const selectedAction = selected ? projection.find((candidate) => candidate.candidateId === selected.candidateId)?.action ?? null : null;
  const correct = scenario.expected === "hold" ? composed.hold : selectedAction === scenario.expected;
  const topSignal = composed.topSignal ?? 0;
  return {
    outcome: {
      id: scenario.id, expected: scenario.expected,
      actions: [...new Set(projection.map((candidate) => candidate.action))].sort(),
      method: composed.method, selectedAction, topSignal, correct,
      acted: composed.band === "act",
    },
    point: { predictedProbability: topSignal, correct },
    model: result.model.responseModel ?? settings.model,
  };
}

function render(outcomes: readonly LiveOutcome[], report: ReturnType<typeof gradeCalibration>, gate: ReturnType<typeof evaluatePromotionGate>, model: string): string {
  const acted = outcomes.filter((outcome) => outcome.acted);
  const deferred = outcomes.filter((outcome) => !outcome.acted);
  const coverage = outcomes.length === 0 ? 0 : acted.length / outcomes.length;
  const accuracy = acted.length === 0 ? 0 : acted.filter((outcome) => outcome.correct).length / acted.length;
  const lines: string[] = [];
  lines.push("# System One Director (L1) calibration");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} by \`scripts/evaluate-system-one-director.ts\` using the live System One adapter.`);
  lines.push("");
  lines.push("The L1 selector builds a per-candidate support `noul`, a priority `score`, a `hold` `noul`, and an aggregate `best_candidate` `choice`, then composes hold → grounded-by-priority → best-pick → defer. Correctness is graded against the provider-free candidate oracle (the exact advertised action set per state).");
  lines.push("");
  lines.push(`Live model: \`${model}\`. Samples: ${outcomes.length}.`);
  lines.push("");
  lines.push("## Scenarios");
  lines.push("");
  lines.push("| Scenario | Oracle actions | Expected | Method | Selected | Top signal | Acted | Correct |");
  lines.push("| --- | --- | --- | --- | --- | ---: | :---: | :---: |");
  for (const outcome of outcomes) {
    lines.push(`| ${outcome.id} | ${outcome.actions.join(", ") || "—"} | ${outcome.expected} | ${outcome.method} | ${outcome.selectedAction ?? (outcome.method === "hold" ? "hold" : "—")} | ${outcome.topSignal.toFixed(3)} | ${outcome.acted ? "yes" : "defer"} | ${outcome.correct ? "yes" : "no"} |`);
  }
  lines.push("");
  lines.push("## Calibration");
  lines.push("");
  lines.push("Calibration is measured only on decisions the lane actually acted on. A deferral is not a committed prediction: it hands off to the existing deterministic path and is reported as a coverage signal, not scored as a miss.");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Scenarios | ${outcomes.length} |`);
  lines.push(`| Acted samples | ${report.count} |`);
  lines.push(`| Coverage | ${(coverage * 100).toFixed(1)}% |`);
  lines.push(`| Deferrals | ${deferred.length} (${outcomes.length === 0 ? "0.0" : ((deferred.length / outcomes.length) * 100).toFixed(1)}%) |`);
  lines.push(`| Accuracy vs oracle (acted) | ${report.count === 0 ? "n/a" : `${(accuracy * 100).toFixed(1)}%`} |`);
  lines.push(`| Brier score (acted) | ${report.count === 0 ? "n/a" : report.brier.toFixed(4)} |`);
  lines.push(`| Expected calibration error (acted) | ${report.count === 0 ? "n/a" : report.expectedCalibrationError.toFixed(4)} |`);
  lines.push(`| Bins | ${report.bins} |`);
  lines.push("");
  lines.push("## Promotion gate — `director-selection`");
  lines.push("");
  lines.push(`**${gate.promoted ? "PROMOTE" : "NOT READY"}**`);
  lines.push("");
  if (gate.reasons.length === 0) lines.push("All gates passed.");
  else for (const reason of gate.reasons) lines.push(`- ${reason}`);
  lines.push("");
  lines.push("The gate is a ceiling on confidence, not a guarantee: sample counts and holdout choice still matter, and a not-ready lane keeps its deterministic fallback.");
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf("--out");
  const outPath = path.resolve(ROOT, outIndex >= 0 ? (process.argv[outIndex + 1] ?? "docs/system-one-director-calibration.md") : "docs/system-one-director-calibration.md");
  const settings = { ...defaultSystemOneSettings(), apiKey: KEY };

  const empty = await readState("empty-world", {});
  const graph = await readState("story-graph", { setup: (fixture) => fixture.graph() });
  const prepared = await readState("encounter-prep", { setup: (fixture) => fixture.prepare() });
  const gmOnly = await readState("gm-only", { gmOnly: true });

  const scenarios: Scenario[] = [
    { id: "empty-world", projection: empty, expected: "ambient-beat" },
    { id: "story-graph", projection: graph, expected: "reveal-node" },
    { id: "encounter-prep", projection: prepared, expected: "encounter-start" },
    { id: "gm-only", projection: gmOnly, expected: "hold" },
  ];

  const outcomes: LiveOutcome[] = [];
  const points: DmCalibrationPoint[] = [];
  let model = settings.model;
  for (const scenario of scenarios) {
    const { outcome, point, model: responseModel } = await runLive(scenario, settings);
    outcomes.push(outcome);
    if (outcome.acted) points.push(point);
    model = responseModel;
    console.log(`${scenario.id}: method=${outcome.method} selected=${outcome.selectedAction ?? "hold"} signal=${outcome.topSignal.toFixed(3)} acted=${outcome.acted} correct=${outcome.correct}`);
  }

  const report = gradeCalibration(points, 10);
  const acted = outcomes.filter((outcome) => outcome.acted);
  const accuracy = acted.length === 0 ? 0 : acted.filter((outcome) => outcome.correct).length / acted.length;
  const gate = evaluatePromotionGate("director-selection", {
    samples: report.count, accuracy, brier: report.brier, expectedCalibrationError: report.expectedCalibrationError,
  });

  const markdown = render(outcomes, report, gate, model);
  await writeFile(outPath, markdown, "utf8");
  await writeFile(outPath.replace(/\.md$/, ".json"), JSON.stringify({ model, outcomes, report, gate }, null, 2), "utf8");
  console.log(`accuracy=${(accuracy * 100).toFixed(1)}% brier=${report.brier.toFixed(4)} ece=${report.expectedCalibrationError.toFixed(4)} promoted=${gate.promoted}`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
