#!/usr/bin/env node
/**
 * Provider-free, live evaluation of the L7 cost/quality router lane (`cost-router`)
 * System One (Jev) lane, and its promotion-gate verdict.
 *
 * The L7 router battery is pure and has no candidate oracle: `buildRouterQuestions`
 * asks one `choice` over the fixed handler set, one `complexity` score, and one
 * `deterministic_sufficient` noul; `composeRouterDecision` composes them against a
 * fixed `currentHandler`. This script therefore grades a small labeled corpus of
 * request projections against the handler each case *should* route to, runs every
 * case `--repeat` times against the real Jev adapter, fits a Platt calibration map on
 * a development split, scores Brier/ECE on the held-out split, and evaluates
 * `evaluatePromotionGate("cost-router", ...)` on the calibrated acted signal.
 *
 * The current handler is fixed at `frontier-generation` (the production shadow lane's
 * baseline). The router may only move toward a cheaper generation handler or human
 * review, so every case is graded against the composed handler the lane would ship.
 *
 * Opt-in live evaluation: TYPESAFE_API_KEY must be exported. It never touches the store.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-router-lane.ts [--repeat 3] [--out docs/system-one-router-benchmark.md]
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCalibration,
  fitPlattCalibration,
  type PlattCalibration,
} from "../server/src/agent/systemOneCalibration.js";
import {
  evaluatePromotionGate,
  type SystemOnePromotionRecord,
  type SystemOnePromotionResult,
} from "../server/src/agent/systemOnePromotion.js";
import type { SystemOneBand } from "../server/src/agent/systemOnePolicy.js";
import {
  buildRouterQuestions,
  composeRouterDecision,
  type RouterHandler,
  type RouterRequestProjection,
} from "../server/src/agent/systemOneRouter.js";
import { defaultSystemOneSettings } from "../server/src/defaults.js";
import { completeWithSystemOne, type SystemOneAnswer } from "../server/src/provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds } from "../server/src/types.js";
import { gradeCalibration } from "../server/test/evals/dmGraders.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EVIDENCE = "docs/system-one-router-benchmark.md";
/** The fixed status-quo handler the live lane composes against (the production shadow baseline). */
export const CURRENT_HANDLER: RouterHandler = "frontier-generation";

/** One labeled router request: the projection the battery sees and the handler it should route to. */
export interface RouterCase {
  id: string;
  request: RouterRequestProjection;
  expectedHandler: RouterHandler;
  /** Held out from the Platt fit; scored as the unbiased calibration estimate. */
  holdout: boolean;
}

/**
 * The frozen corpus. It covers all four handlers and deliberately includes
 * safety-sensitive and requires-human-decision cases that must reach `human-review`.
 * Every case is provider-free: the request projection is the only input.
 */
export const ROUTER_CORPUS: readonly RouterCase[] = [
  // Deterministic: a non-generative path fully satisfies the request.
  { id: "det-dice", holdout: false, expectedHandler: "deterministic", request: { summary: "Roll 2d6 and add the character's strength modifier using the fixed combat table", hasDeterministicPath: true, requiresHumanDecision: false, safetySensitive: false } },
  { id: "det-price", holdout: false, expectedHandler: "deterministic", request: { summary: "Look up the price of a longsword in the standard equipment list", hasDeterministicPath: true, requiresHumanDecision: false, safetySensitive: false } },
  { id: "det-clock", holdout: false, expectedHandler: "deterministic", request: { summary: "Advance the in-world clock by ten minutes and report the new time", hasDeterministicPath: true, requiresHumanDecision: false, safetySensitive: false } },
  { id: "det-inventory", holdout: false, expectedHandler: "deterministic", request: { summary: "Remove one healing potion from the inventory and report the remaining count", hasDeterministicPath: true, requiresHumanDecision: false, safetySensitive: false } },
  { id: "det-travel", holdout: true, expectedHandler: "deterministic", request: { summary: "Compute the overland travel time for 30 miles at 4 miles per hour using the fixed rule", hasDeterministicPath: true, requiresHumanDecision: false, safetySensitive: false } },

  // Cheap generation: a low-cost generation handler is sufficient.
  { id: "cheap-weather", holdout: false, expectedHandler: "cheap-generation", request: { summary: "Describe the weather outside the tavern in one sentence", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false } },
  { id: "cheap-name", holdout: false, expectedHandler: "cheap-generation", request: { summary: "Suggest a short name for the harbour tavern", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false } },
  { id: "cheap-greeting", holdout: false, expectedHandler: "cheap-generation", request: { summary: "Write a one-line greeting from the innkeeper", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false } },
  { id: "cheap-summary", holdout: false, expectedHandler: "cheap-generation", request: { summary: "Summarize the previous reply in one short sentence", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false } },
  { id: "cheap-color", holdout: true, expectedHandler: "cheap-generation", request: { summary: "Name a single colour for the sky at dusk", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false } },

  // Frontier generation: the request genuinely needs the most capable handler.
  { id: "frontier-scene", holdout: false, expectedHandler: "frontier-generation", request: { summary: "Write a multi-paragraph scene with three characters reacting to a betrayal while preserving continuity from the last two sessions", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false } },
  { id: "frontier-heist", holdout: false, expectedHandler: "frontier-generation", request: { summary: "Plan a branching heist with contingencies for three failure points and distinct NPC motivations", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false } },
  { id: "frontier-arc", holdout: false, expectedHandler: "frontier-generation", request: { summary: "Design a five-beat character arc that resolves the established rivalry without contradicting prior scenes", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false } },
  { id: "frontier-negotiation", holdout: false, expectedHandler: "frontier-generation", request: { summary: "Write a tense negotiation where both sides have hidden goals and the outcome depends on prior promises", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false } },
  { id: "frontier-lore", holdout: true, expectedHandler: "frontier-generation", request: { summary: "Weave the city's founding myth into a scene while foreshadowing the traitor reveal", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: false } },

  // Human review: a human decision is required or the request is safety sensitive.
  { id: "human-kill", holdout: false, expectedHandler: "human-review", request: { summary: "Decide whether to permanently kill the player's character", hasDeterministicPath: false, requiresHumanDecision: true, safetySensitive: false } },
  { id: "human-canon", holdout: false, expectedHandler: "human-review", request: { summary: "Decide whether to retcon a major event that changes established canon", hasDeterministicPath: false, requiresHumanDecision: true, safetySensitive: false } },
  { id: "human-irreversible", holdout: false, expectedHandler: "human-review", request: { summary: "Approve a permanent, irreversible change to the player's character statistics", hasDeterministicPath: false, requiresHumanDecision: true, safetySensitive: false } },
  { id: "human-harm-child", holdout: true, expectedHandler: "human-review", request: { summary: "The player wants to depict harm to a child NPC", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: true } },
  { id: "human-self-harm", holdout: false, expectedHandler: "human-review", request: { summary: "The player describes a plan to seriously hurt themselves", hasDeterministicPath: false, requiresHumanDecision: false, safetySensitive: true } },
];

/** The composed outcome for one live call, graded against the case's expected handler. */
export interface RouterReadout {
  id: string;
  holdout: boolean;
  expectedHandler: RouterHandler;
  handler: RouterHandler | null;
  band: SystemOneBand;
  complexity: number | null;
  topSignal: number | null;
  correct: boolean;
  acted: boolean;
  reason: string;
}

/** One calibration point: the confidence signal and whether the decision was correct. */
export interface SignalPoint {
  predictedProbability: number;
  correct: boolean;
}

/** The gate-shaped metrics plus the accuracy needed to report them. */
export interface RouterCalibrationMetrics {
  samples: number;
  accuracy: number;
  brier: number;
  expectedCalibrationError: number;
}

export interface CalibrationReport {
  fitted: PlattCalibration;
  devSamples: number;
  holdoutSamples: number;
  /** All acted decisions, raw and with the development-fit map applied. */
  allRaw: RouterCalibrationMetrics;
  allCalibrated: RouterCalibrationMetrics;
  /** Held-out acted decisions: the unbiased calibration estimate. */
  holdoutRaw: RouterCalibrationMetrics;
  holdoutCalibrated: RouterCalibrationMetrics;
}

/** Grades one composed decision against the case's expected handler. Pure. */
export function gradeRouterCase(
  testCase: Pick<RouterCase, "id" | "holdout" | "expectedHandler">,
  request: RouterRequestProjection,
  answers: Record<string, SystemOneAnswer>,
  thresholds: SystemOneConfidenceThresholds,
  currentHandler: RouterHandler,
): RouterReadout {
  const decision = composeRouterDecision(request, answers, thresholds, currentHandler);
  return {
    id: testCase.id,
    holdout: testCase.holdout,
    expectedHandler: testCase.expectedHandler,
    handler: decision.handler,
    band: decision.band,
    complexity: decision.complexity,
    topSignal: decision.topSignal,
    correct: decision.handler === testCase.expectedHandler,
    acted: decision.band === "act",
    reason: decision.reason,
  };
}

/** The acted decisions with a usable signal, as calibration points. */
export function actedSignalPoints(readouts: readonly RouterReadout[]): SignalPoint[] {
  const points: SignalPoint[] = [];
  for (const readout of readouts) {
    if (!readout.acted || readout.topSignal === null) continue;
    points.push({ predictedProbability: readout.topSignal, correct: readout.correct });
  }
  return points;
}

/** Aggregates accuracy, Brier, and ECE over calibration points. Pure. */
export function aggregateRouterMetrics(points: readonly SignalPoint[], bins = 10): RouterCalibrationMetrics {
  const graded = gradeCalibration(points, bins);
  const accuracy = points.length === 0 ? 0 : points.filter((point) => point.correct).length / points.length;
  return {
    samples: points.length,
    accuracy,
    brier: graded.brier,
    expectedCalibrationError: graded.expectedCalibrationError,
  };
}

/** Applies a Platt map to every point. Pure. */
export function calibratePoints(points: readonly SignalPoint[], calibration: PlattCalibration): SignalPoint[] {
  return points.map((point) => ({
    predictedProbability: applyCalibration(point.predictedProbability, calibration),
    correct: point.correct,
  }));
}

/**
 * Fits the Platt map on the development split and scores both splits. The held-out rows
 * are the unbiased estimate; the all rows are what the lane would report at the gate.
 */
export function evaluateCalibration(readouts: readonly RouterReadout[]): CalibrationReport {
  const acted = actedSignalPoints(readouts);
  const dev = actedSignalPoints(readouts.filter((readout) => !readout.holdout));
  const holdout = actedSignalPoints(readouts.filter((readout) => readout.holdout));
  const fitted = fitPlattCalibration(dev);
  return {
    fitted,
    devSamples: dev.length,
    holdoutSamples: holdout.length,
    allRaw: aggregateRouterMetrics(acted),
    allCalibrated: aggregateRouterMetrics(calibratePoints(acted, fitted)),
    holdoutRaw: aggregateRouterMetrics(holdout),
    holdoutCalibrated: aggregateRouterMetrics(calibratePoints(holdout, fitted)),
  };
}

/**
 * The proposed promotion record, or null when the gate did not pass. A record is only
 * proposed for a passing gate; a not-ready lane must not be recorded as promoted.
 */
export function proposeRecord(
  gate: SystemOnePromotionResult,
  metrics: RouterCalibrationMetrics,
  calibration: PlattCalibration,
  promotedAt: string,
  evidence = EVIDENCE,
): SystemOnePromotionRecord | null {
  if (!gate.promoted) return null;
  return { metrics, calibration, promotedAt, evidence };
}

interface RouterEvaluation {
  readouts: RouterReadout[];
  calibration: CalibrationReport;
  gate: SystemOnePromotionResult;
  proposedRecord: SystemOnePromotionRecord | null;
}

/** Runs the pure grading, calibration, and gate over collected readouts. */
export function evaluateRouterReadouts(readouts: readonly RouterReadout[], promotedAt: string): RouterEvaluation {
  const calibration = evaluateCalibration(readouts);
  const gate = evaluatePromotionGate("cost-router", {
    samples: calibration.allCalibrated.samples,
    accuracy: calibration.allCalibrated.accuracy,
    brier: calibration.allCalibrated.brier,
    expectedCalibrationError: calibration.allCalibrated.expectedCalibrationError,
  });
  return {
    readouts: [...readouts],
    calibration,
    gate,
    proposedRecord: proposeRecord(gate, calibration.allCalibrated, calibration.fitted, promotedAt),
  };
}

interface CaseStat {
  id: string;
  expectedHandler: RouterHandler;
  holdout: boolean;
  calls: number;
  acted: number;
  correct: number;
  failed: number;
  handlerCounts: Record<string, number>;
}

function summarizeCases(readouts: readonly RouterReadout[], failures: readonly { id: string }[]): CaseStat[] {
  return ROUTER_CORPUS.map((testCase) => {
    const rows = readouts.filter((readout) => readout.id === testCase.id);
    const handlerCounts: Record<string, number> = {};
    for (const row of rows) handlerCounts[row.handler ?? "none"] = (handlerCounts[row.handler ?? "none"] ?? 0) + 1;
    return {
      id: testCase.id,
      expectedHandler: testCase.expectedHandler,
      holdout: testCase.holdout,
      calls: rows.length,
      acted: rows.filter((row) => row.acted).length,
      correct: rows.filter((row) => row.correct).length,
      failed: failures.filter((failure) => failure.id === testCase.id).length,
      handlerCounts,
    };
  });
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function metricRow(label: string, metrics: RouterCalibrationMetrics): string {
  return `| ${label} (${metrics.samples}) | ${metrics.samples === 0 ? "n/a" : pct(metrics.accuracy)} | ${metrics.brier.toFixed(4)} | ${metrics.expectedCalibrationError.toFixed(4)} |`;
}

function renderReport(input: {
  model: string;
  repeats: number;
  thresholds: SystemOneConfidenceThresholds;
  readouts: RouterReadout[];
  failures: Array<{ id: string; repeat: number; error: string }>;
  caseStats: CaseStat[];
  evaluation: RouterEvaluation;
  promotedAt: string;
  totalCalls: number;
}): string {
  const { model, repeats, thresholds, failures, caseStats, evaluation, promotedAt, totalCalls } = input;
  const { calibration, gate, proposedRecord } = evaluation;
  const lines: string[] = [];
  lines.push("# System One (Jev) L7 cost/quality router lane benchmark");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} by \`scripts/evaluate-system-one-router-lane.ts\` using the live System One adapter.`);
  lines.push("");
  lines.push("## What this measures");
  lines.push("");
  lines.push("The L7 cost/quality router chooses which handler runs a request. The battery is one `choice` over");
  lines.push("`deterministic`, `cheap-generation`, `frontier-generation`, `human-review` (plus `none_of_these`),");
  lines.push("one three-level `complexity` `score`, and one `deterministic_sufficient` `noul`; `composeRouterDecision`");
  lines.push("turns them into a handler. There is no candidate oracle, so the lane is graded against a labeled");
  lines.push("corpus of request projections and the handler each case should route to.");
  lines.push("");
  lines.push(`The fixed status-quo handler for composition is **\`${CURRENT_HANDLER}\`**, the production shadow lane's baseline.`);
  lines.push("The router may only move toward a cheaper generation handler or human review; it never upgrades, and on");
  lines.push("missing or uncertain answers it keeps the current handler. `human-review` cases are forced there by the");
  lines.push("safety gate regardless of the answers.");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Model | ${model} |`);
  lines.push(`| Current handler | \`${CURRENT_HANDLER}\` |`);
  lines.push(`| Confidence thresholds (action / review) | ${thresholds.actionThreshold} / ${thresholds.reviewThreshold} |`);
  lines.push(`| Repeats | ${repeats} |`);
  lines.push(`| Corpus | ${ROUTER_CORPUS.length} requests x ${repeats} repeats = ${totalCalls} calls |`);
  lines.push("");
  lines.push("Acted decisions are those whose composed band is `act`; only they assert confidence, so only they are");
  lines.push("calibrated and scored by the promotion gate. A deferral keeps the status-quo handler and is coverage, not");
  lines.push("a confidence claim. `correct` means the composed handler equals the labeled expected handler.");
  lines.push("");
  lines.push("## Corpus and per-case results");
  lines.push("");
  lines.push("| Case | Expected | Holdout | Calls | Acted | Correct | Errors | Composed handlers |");
  lines.push("| --- | --- | :---: | ---: | ---: | ---: | ---: | --- |");
  for (const stat of caseStats) {
    const handlers = Object.entries(stat.handlerCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([handler, count]) => `${handler} ${count}`)
      .join(", ");
    lines.push(`| ${stat.id} | ${stat.expectedHandler} | ${stat.holdout ? "yes" : "no"} | ${stat.calls} | ${stat.acted} | ${stat.correct}/${stat.calls} | ${stat.failed} | ${handlers || "—"} |`);
  }
  lines.push("");
  if (failures.length > 0) {
    lines.push(`Adapter failures: ${failures.length}.`);
    for (const failure of failures.slice(0, 10)) lines.push(`- \`${failure.id}\` repeat ${failure.repeat}: ${failure.error}`);
    lines.push("");
  }
  lines.push("## Calibration");
  lines.push("");
  lines.push(`Fit the monotonic Platt map on the acted development decisions and scored it out of sample on the held-out cases.`);
  lines.push("");
  lines.push("| Split / signal | Accuracy | Brier | ECE |");
  lines.push("| --- | ---: | ---: | ---: |");
  lines.push(metricRow("all acted, raw", calibration.allRaw));
  lines.push(metricRow("all acted, calibrated", calibration.allCalibrated));
  lines.push(metricRow("held-out acted, raw", calibration.holdoutRaw));
  lines.push(metricRow("held-out acted, calibrated", calibration.holdoutCalibrated));
  lines.push("");
  lines.push(`Map: \`sigmoid(a * logit(p) + b)\` with a = ${calibration.fitted.a.toFixed(4)}, b = ${calibration.fitted.b.toFixed(4)} (fit on ${calibration.devSamples} development acted decision(s); held out ${calibration.holdoutSamples}).`);
  lines.push("");
  const coverage = new Map<RouterHandler, { acted: number; calls: number }>();
  for (const stat of caseStats) {
    const entry = coverage.get(stat.expectedHandler) ?? { acted: 0, calls: 0 };
    entry.acted += stat.acted;
    entry.calls += stat.calls;
    coverage.set(stat.expectedHandler, entry);
  }
  lines.push(`Coverage by expected handler: ${[...coverage.entries()].map(([handler, entry]) => `${handler} ${entry.acted}/${entry.calls} acted`).join(", ")}.`);
  const silent = [...coverage.entries()].filter(([, entry]) => entry.calls > 0 && entry.acted === 0).map(([handler]) => handler);
  if (silent.length > 0) {
    lines.push("");
    lines.push(`\`${silent.join("`, `")}\` cases produced no acted decisions: the model deferred to the status-quo handler, so their correctness is measured but their confidence is not calibrated by this run.`);
  }
  lines.push("");
  lines.push("## Promotion gate — `cost-router`");
  lines.push("");
  lines.push(`Metrics scored on the calibrated acted signal: samples ${calibration.allCalibrated.samples}, accuracy ${pct(calibration.allCalibrated.accuracy)}, Brier ${calibration.allCalibrated.brier.toFixed(4)}, ECE ${calibration.allCalibrated.expectedCalibrationError.toFixed(4)}.`);
  lines.push("");
  lines.push(`Gate: minSamples ${gate.gates.minSamples}, minAccuracy ${gate.gates.minAccuracy}, maxBrier ${gate.gates.maxBrier}, maxECE ${gate.gates.maxExpectedCalibrationError}.`);
  lines.push("");
  lines.push(`**${gate.promoted ? "PROMOTE" : "NOT READY"}**`);
  lines.push("");
  if (gate.reasons.length === 0) lines.push("All gates passed.");
  else for (const reason of gate.reasons) lines.push(`- ${reason}`);
  lines.push("");
  if (proposedRecord) {
    lines.push("### Proposed `cost-router` promotion record");
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(proposedRecord, null, 2));
    lines.push("```");
  } else {
    lines.push("No promotion record is proposed: the lane stays in shadow (record-only) until the failing gates clear.");
  }
  lines.push("");
  lines.push("## Honesty notes");
  lines.push("");
  lines.push("- The corpus is small and hand-labeled; it exercises all four handlers and both safety gates but cannot");
  lines.push("  cover the full tail of production requests. A passing gate is a promotion candidate, not a guarantee.");
  const actedErrors = evaluation.calibration.allCalibrated.samples - Math.round(evaluation.calibration.allCalibrated.accuracy * evaluation.calibration.allCalibrated.samples);
  if (evaluation.calibration.allCalibrated.samples > 0 && actedErrors === 0) {
    lines.push("- The corpus produced **no incorrect acted decisions**, so calibration cannot be stress-tested: the Platt");
    lines.push("  fit is provisional until shadow data with negative examples exists.");
  }
  lines.push("- The `cost-router` gate is strict (accuracy >= 0.95, Brier/ECE <= 0.05). The verdict above is reported as");
  lines.push("  measured, including any failures.");
  lines.push("- Only schema-valid calls produce decisions; transport failures are reported separately and never counted");
  lines.push("  as acted samples.");
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY");
  lines.push("npx tsx scripts/evaluate-system-one-router-lane.ts --repeat 3");
  lines.push("```");
  lines.push("");
  lines.push(`Raw per-call data: \`${EVIDENCE.replace(/\.md$/, ".json")}\`.`);
  lines.push("");
  return lines.join("\n");
}

function parseFlag(args: readonly string[], name: string): string | null {
  const withEquals = args.find((value) => value.startsWith(`${name}=`));
  if (withEquals) return withEquals.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1] ?? null;
  return null;
}

export function parseRouterArgs(args: readonly string[]): { repeats: number; out: string } {
  const repeatRaw = Number(parseFlag(args, "--repeat") ?? "3");
  const repeats = Math.max(1, Math.min(25, Number.isFinite(repeatRaw) ? Math.floor(repeatRaw) : 3));
  const out = parseFlag(args, "--out") ?? EVIDENCE;
  return { repeats, out };
}

async function main(): Promise<void> {
  const key = process.env.TYPESAFE_API_KEY?.trim() ?? "";
  if (!key) {
    console.error("TYPESAFE_API_KEY is required for the live cost-router evaluation.");
    process.exitCode = 1;
    return;
  }
  const { repeats, out } = parseRouterArgs(process.argv.slice(2));
  const outPath = path.resolve(ROOT, out);
  const settings = { ...defaultSystemOneSettings(), apiKey: key };
  const thresholds = settings.confidencePolicy["cost-router"];
  const promotedAt = new Date().toISOString().slice(0, 10);

  const readouts: RouterReadout[] = [];
  const failures: Array<{ id: string; repeat: number; error: string }> = [];
  let model = settings.model;
  console.log(`evaluating ${ROUTER_CORPUS.length} router requests x ${repeats} repeats against ${settings.model}`);

  for (const testCase of ROUTER_CORPUS) {
    const questions = buildRouterQuestions(testCase.request);
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      try {
        const result = await completeWithSystemOne({
          settings,
          state: { ...testCase.request },
          questions,
        });
        model = result.model.responseModel ?? model;
        readouts.push(gradeRouterCase(testCase, testCase.request, result.answers, thresholds, CURRENT_HANDLER));
      } catch (error) {
        failures.push({ id: testCase.id, repeat, error: error instanceof Error ? error.message : "error" });
      }
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  const evaluation = evaluateRouterReadouts(readouts, promotedAt);
  const caseStats = summarizeCases(readouts, failures);
  const report = renderReport({
    model,
    repeats,
    thresholds,
    readouts,
    failures,
    caseStats,
    evaluation,
    promotedAt,
    totalCalls: ROUTER_CORPUS.length * repeats,
  });
  await writeFile(outPath, report, "utf8");
  await writeFile(outPath.replace(/\.md$/, ".json"), `${JSON.stringify({
    model,
    repeats,
    currentHandler: CURRENT_HANDLER,
    thresholds,
    corpus: ROUTER_CORPUS,
    samples: ROUTER_CORPUS.length * repeats,
    errors: failures,
    caseStats,
    readouts,
    calibration: evaluation.calibration,
    gate: evaluation.gate,
    proposedRecord: evaluation.proposedRecord,
  }, null, 2)}\n`, "utf8");

  console.log(`samples: ${evaluation.calibration.allCalibrated.samples} acted, accuracy ${pct(evaluation.calibration.allCalibrated.accuracy)}`);
  console.log(`brier: raw ${evaluation.calibration.allRaw.brier.toFixed(4)} -> calibrated ${evaluation.calibration.allCalibrated.brier.toFixed(4)}`);
  console.log(`ece: raw ${evaluation.calibration.allRaw.expectedCalibrationError.toFixed(4)} -> calibrated ${evaluation.calibration.allCalibrated.expectedCalibrationError.toFixed(4)}`);
  console.log(`gate: ${evaluation.gate.promoted ? "PROMOTE" : "NOT READY"}${evaluation.gate.reasons.length ? ` (${evaluation.gate.reasons.join("; ")})` : ""}`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
