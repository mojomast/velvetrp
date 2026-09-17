#!/usr/bin/env node
/**
 * Provider-free, live evaluation of the L2 adventure-selection lane (`adventure-selection`)
 * System One (Jev) lane, its action-threshold sweep, and its promotion-gate verdict.
 *
 * The L2 battery is pure and has no candidate oracle: `buildAdventureSelectionQuestions` builds
 * one `supported` noul, one per-candidate relevance `score`, and one aggregate `best_candidate`
 * choice over the turn's advertised exact candidates; `composeAdventureSelection` composes them
 * into an advisory exact-candidate selection (or a deferral). This script therefore grades a
 * labeled corpus of declaration projections against the exact candidate each case should commit,
 * runs every case `--repeat` times against the real Jev adapter, fits a Platt calibration map on
 * a development split, scores Brier/ECE on the held-out split, and evaluates
 * `evaluatePromotionGate("adventure-selection", ...)` on the calibrated acted signal.
 *
 * The first live run showed systematic under-confidence: the raw model named the right candidate
 * but landed below the server default action threshold, so almost nothing acted and the gate
 * reported insufficient samples. The sweep therefore re-scores the candidate each call actually
 * named at a fixed grid of lower bars and reports a recommended action threshold. The lane's
 * shipped threshold remains the server default; the recommendation is an evaluation finding.
 *
 * The run also merges confirmed harvested cases from the parent-owned fixture when one exists (so
 * live-derived labels join the gate with their provenance flagged) and reports a decision-stability
 * roll-up (repeat agreement, conflicts, signal variance) beside accuracy.
 *
 * The lane is wired in shadow (record-only) behind the `FEATURE_SYSTEM_ONE` flag, the enabled
 * setting, a usable key, and a non-`off` lane mode. It records one immutable shadow decision per
 * fresh adventure turn that advertises candidates and never selects, orders, or commits anything;
 * an `active` lane mode stays record-only because no promoted active path exists. It never adds,
 * drops, or authorizes a candidate; ids and digests are already server-issued, and the existing
 * digest re-validation and command bridge remain authoritative.
 *
 * Opt-in live evaluation: TYPESAFE_API_KEY must be exported. It never touches the store.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-adventure-lane.ts [--repeat 3] [--out docs/system-one-adventure-benchmark.md]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCalibration,
  fitPlattCalibration,
  type PlattCalibration,
} from "../server/src/agent/systemOneCalibration.js";
import {
  ADVENTURE_BEST_KEY,
  ADVENTURE_NONE,
  ADVENTURE_SUPPORTED_KEY,
  buildAdventureSelectionQuestions,
  composeAdventureSelection,
  type AdventureSelectionCandidate,
  type AdventureSelectionComposition,
} from "../server/src/agent/systemOneAdventure.js";
import type { SystemOneBand } from "../server/src/agent/systemOnePolicy.js";
import {
  DEFAULT_SYSTEM_ONE_LANE_GATES,
  evaluatePromotionGate,
  type SystemOnePromotionRecord,
  type SystemOnePromotionResult,
} from "../server/src/agent/systemOnePromotion.js";
import {
  aggregateThresholdSamples,
  selectActionThreshold,
  type ThresholdPoint,
  type ThresholdSample,
  type ThresholdSelection,
} from "../server/src/agent/systemOneThreshold.js";
import type { HarvestProposal } from "../server/src/agent/systemOneHarvest.js";
import {
  summarizeStability,
  type StabilitySample,
  type StabilitySummary,
} from "../server/src/agent/systemOneStability.js";
import { DEFAULT_SYSTEM_ONE_THRESHOLDS, defaultSystemOneSettings } from "../server/src/defaults.js";
import { completeWithSystemOne, type SystemOneAnswer } from "../server/src/provider/systemOneCompletion.js";
import type { SystemOneConfidenceThresholds } from "../server/src/types.js";
import {
  ADVENTURE_EVAL_CASES,
  type AdventureEvalCase,
  type AdventureEvalCategory,
} from "../server/test/fixtures/adventure-evals/corpus.js";
import { gradeCalibration } from "../server/test/evals/dmGraders.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_OUT = "docs/system-one-adventure-benchmark.md";
const PROMOTION_LANE = "adventure-selection" as const;
const EVIDENCE = DEFAULT_OUT;
const LANE_GATE = DEFAULT_SYSTEM_ONE_LANE_GATES[PROMOTION_LANE];

/** The parent-owned confirmed-harvest fixture; absent until a harvest run writes one. */
export const HARVEST_FIXTURE = "server/test/fixtures/system-one-harvested/adventure-selection.json";
const HARVEST_FIXTURE_PATH = path.resolve(ROOT, HARVEST_FIXTURE);
/** Harvested case ids carry this prefix so the report can mark live-derived labels. */
export const HARVEST_ID_PREFIX = "harvested:";

/**
 * The server default action threshold (`DEFAULT_SYSTEM_ONE_THRESHOLDS.actionThreshold`, currently
 * 0.75). It remains the lane's shipped threshold: the sweep below may recommend a lower bar, but
 * the recommendation is an evaluation finding for the parent to configure, never an automatic change.
 */
export const ADVENTURE_DEFAULT_ACTION_THRESHOLD = DEFAULT_SYSTEM_ONE_THRESHOLDS.actionThreshold;

/**
 * The fixed action-threshold sweep. Every grid point is scored against the candidate each call
 * actually named, so the sweep never re-asks the model, and the gate floors stay the lane's own.
 */
export const ADVENTURE_THRESHOLD_GRID: readonly number[] = [
  0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, ADVENTURE_DEFAULT_ACTION_THRESHOLD,
];

/** One graded live composition: the composed outcome plus its label comparison. */
export interface AdventureReadout {
  id: string;
  category: AdventureEvalCategory;
  holdout: boolean;
  band: SystemOneBand;
  method: "choice" | "defer";
  /** The committed selection (band `act` only), or null when the lane deferred. */
  selected: string | null;
  /**
   * The candidate the model actually named, committed or not. For an `act`/`confirm` composition
   * this is the composed selection; for a deferral it is the raw aggregate pick recovered from the
   * answers (see `gradeAdventureCase`). The threshold sweep re-scores this pick at lower bars.
   */
  candidateId: string | null;
  /** The case's acceptable set, copied so the sweep can score the named pick without the corpus. */
  acceptable: readonly (string | null)[];
  /** True when the committed selection (or deferral) equals the case's single preferred call. */
  selectedCorrect: boolean;
  /** True when the lane took no behavior-changing action: anything below `act`. */
  deferred: boolean;
  /** True when the committed selection (or deferral) is in the case's acceptable set. */
  correct: boolean;
  /** The combined confidence signal (raw, pre-calibration), or null when nothing was named. */
  topSignal: number | null;
  reason: string;
}

/**
 * The candidate the model actually named, committed or not.
 *
 * The composition names a candidate whenever it selects or confirms. When the primitive defers it
 * may still have been given a well-formed aggregate pick that only failed the confidence bar, so
 * this recovers the raw `best_candidate` choice — but only when `supported` was answered (the
 * primitive's other independent claim) and the choice is one of the advertised ids. `none_of_these`
 * and undeclared ids are never recovered. This is the pick the threshold sweep re-scores at lower
 * bars without re-asking the model; it is never committed by the lane.
 */
function namedAdventureCandidate(
  candidates: readonly AdventureSelectionCandidate[],
  composition: AdventureSelectionComposition,
  answers: Record<string, SystemOneAnswer>,
): string | null {
  if (composition.selection) return composition.selection.candidateId;
  if (!(ADVENTURE_SUPPORTED_KEY in answers)) return null;
  const best = answers[ADVENTURE_BEST_KEY];
  if (!best || best.type !== "choice" || best.choice === ADVENTURE_NONE) return null;
  return candidates.some((candidate) => candidate.candidateId === best.choice) ? best.choice : null;
}

/**
 * Grades one composed L2 selection against the case's labels. Pure.
 *
 * `confirm` records a selection but changes no behavior, so it is graded as the deferral it is:
 * only `act` commits. `correct` uses the asserted-subset rubric (membership in `acceptable`);
 * `selectedCorrect` is the stricter exact-preferred check. `candidateId` records the pick the
 * model named even when nothing was committed, for the threshold sweep.
 */
export function gradeAdventureCase(
  testCase: Pick<AdventureEvalCase, "id" | "category" | "holdout" | "expected" | "candidates">,
  composition: AdventureSelectionComposition,
  answers: Record<string, SystemOneAnswer> = {},
): AdventureReadout {
  const selected = composition.band === "act" ? composition.selection?.candidateId ?? null : null;
  const candidateId = namedAdventureCandidate(testCase.candidates, composition, answers);
  const deferred = composition.band !== "act";
  const selectedCorrect = selected === testCase.expected.preferred;
  const correct = testCase.expected.acceptable.includes(selected);
  const expectedText = testCase.expected.preferred ?? "defer";
  const verdict = correct ? "acceptable" : "not acceptable";
  const reason = deferred
    ? composition.selection === null
      ? `deferred (${composition.band}); expected ${expectedText}; ${verdict}`
      : `deferred (${composition.band}, recorded ${composition.selection.candidateId}); expected ${expectedText}; ${verdict}`
    : `selected ${selected} (${composition.band}); expected ${expectedText}; ${verdict}`;
  return {
    id: testCase.id,
    category: testCase.category,
    holdout: testCase.holdout,
    band: composition.band,
    method: composition.method,
    selected,
    candidateId,
    acceptable: [...testCase.expected.acceptable],
    selectedCorrect,
    deferred,
    correct,
    topSignal: composition.topSignal,
    reason,
  };
}

/** One calibration point: the raw confidence signal and whether the committed action was correct. */
export interface AdventureSignalPoint {
  predictedProbability: number;
  correct: boolean;
}

/** The gate-shaped metrics plus the accuracy needed to report them. */
export interface AdventureCalibrationMetrics {
  samples: number;
  accuracy: number;
  brier: number;
  expectedCalibrationError: number;
}

export interface AdventureCalibrationReport {
  fitted: PlattCalibration;
  devSamples: number;
  holdoutSamples: number;
  /** All acted decisions, raw and with the development-fit map applied. */
  allRaw: AdventureCalibrationMetrics;
  allCalibrated: AdventureCalibrationMetrics;
  /** Held-out acted decisions: the unbiased calibration estimate. */
  holdoutRaw: AdventureCalibrationMetrics;
  holdoutCalibrated: AdventureCalibrationMetrics;
}

/** The acted decisions with a usable signal, as calibration points. Pure. */
export function actedAdventureSignalPoints(readouts: readonly AdventureReadout[]): AdventureSignalPoint[] {
  const points: AdventureSignalPoint[] = [];
  for (const readout of readouts) {
    if (readout.deferred || readout.topSignal === null || !Number.isFinite(readout.topSignal)) continue;
    points.push({ predictedProbability: readout.topSignal, correct: readout.correct });
  }
  return points;
}

/** Aggregates accuracy, Brier, and ECE over calibration points. Pure. */
export function aggregateAdventureMetrics(points: readonly AdventureSignalPoint[], bins = 10): AdventureCalibrationMetrics {
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
export function calibrateAdventurePoints(
  points: readonly AdventureSignalPoint[],
  calibration: PlattCalibration,
): AdventureSignalPoint[] {
  return points.map((point) => ({
    predictedProbability: applyCalibration(point.predictedProbability, calibration),
    correct: point.correct,
  }));
}

/**
 * Fits the Platt map on the acted development split and scores both splits. The held-out rows
 * are the unbiased estimate; the all rows are what the lane would report at the gate.
 */
export function evaluateAdventureCalibration(readouts: readonly AdventureReadout[]): AdventureCalibrationReport {
  const acted = actedAdventureSignalPoints(readouts);
  const dev = actedAdventureSignalPoints(readouts.filter((readout) => !readout.holdout));
  const holdout = actedAdventureSignalPoints(readouts.filter((readout) => readout.holdout));
  const fitted = fitPlattCalibration(dev);
  return {
    fitted,
    devSamples: dev.length,
    holdoutSamples: holdout.length,
    allRaw: aggregateAdventureMetrics(acted),
    allCalibrated: aggregateAdventureMetrics(calibrateAdventurePoints(acted, fitted)),
    holdoutRaw: aggregateAdventureMetrics(holdout),
    holdoutCalibrated: aggregateAdventureMetrics(calibrateAdventurePoints(holdout, fitted)),
  };
}

/**
 * Threshold samples for one readout: the candidate the model named is scored at every candidate
 * threshold, with `acted = topSignal >= threshold` and `correct` the asserted-subset membership of
 * that named candidate. A readout that named no candidate (or carried no signal) contributes
 * nothing at any threshold. Pure.
 */
export function adventureThresholdSamples(
  readouts: readonly AdventureReadout[],
  thresholds: readonly number[],
): ThresholdSample[] {
  const samples: ThresholdSample[] = [];
  for (const readout of readouts) {
    if (readout.candidateId === null || readout.topSignal === null || !Number.isFinite(readout.topSignal)) continue;
    const correct = readout.acceptable.includes(readout.candidateId);
    for (const threshold of thresholds) {
      samples.push({
        threshold,
        acted: readout.topSignal >= threshold,
        correct,
        predictedProbability: readout.topSignal,
      });
    }
  }
  return samples;
}

function thresholdActedPoints(
  readouts: readonly AdventureReadout[],
  threshold: number,
  holdout?: boolean,
): AdventureSignalPoint[] {
  const points: AdventureSignalPoint[] = [];
  for (const readout of readouts) {
    if (holdout !== undefined && readout.holdout !== holdout) continue;
    if (readout.candidateId === null || readout.topSignal === null || !Number.isFinite(readout.topSignal)) continue;
    if (readout.topSignal < threshold) continue;
    points.push({ predictedProbability: readout.topSignal, correct: readout.acceptable.includes(readout.candidateId) });
  }
  return points;
}

function thresholdCalibration(readouts: readonly AdventureReadout[], threshold: number): AdventureCalibrationReport {
  const all = thresholdActedPoints(readouts, threshold);
  const dev = thresholdActedPoints(readouts, threshold, false);
  const holdout = thresholdActedPoints(readouts, threshold, true);
  const fitted = fitPlattCalibration(dev);
  return {
    fitted,
    devSamples: dev.length,
    holdoutSamples: holdout.length,
    allRaw: aggregateAdventureMetrics(all),
    allCalibrated: aggregateAdventureMetrics(calibrateAdventurePoints(all, fitted)),
    holdoutRaw: aggregateAdventureMetrics(holdout),
    holdoutCalibrated: aggregateAdventureMetrics(calibrateAdventurePoints(holdout, fitted)),
  };
}

/** The gate verdict and proposed record at one action threshold. */
export interface AdventureThresholdVerdict {
  threshold: number;
  calibration: AdventureCalibrationReport;
  gate: SystemOnePromotionResult;
  proposedRecord: SystemOnePromotionRecord | null;
}

function thresholdVerdict(
  readouts: readonly AdventureReadout[],
  threshold: number,
  promotedAt: string,
): AdventureThresholdVerdict {
  const calibration = thresholdCalibration(readouts, threshold);
  const gate = evaluatePromotionGate(PROMOTION_LANE, {
    samples: calibration.allCalibrated.samples,
    accuracy: calibration.allCalibrated.accuracy,
    brier: calibration.allCalibrated.brier,
    expectedCalibrationError: calibration.allCalibrated.expectedCalibrationError,
  });
  return {
    threshold,
    calibration,
    gate,
    proposedRecord: proposeAdventureRecord(gate, calibration.allCalibrated, calibration.fitted, promotedAt),
  };
}

/** The action-threshold sweep, its selection, and the verdicts at the default and recommended bars. */
export interface AdventureThresholdSweep {
  grid: readonly number[];
  /** All labeled samples at every grid threshold. */
  points: ThresholdPoint[];
  devPoints: ThresholdPoint[];
  holdoutPoints: ThresholdPoint[];
  /**
   * Greatest-coverage threshold clearing the lane gate's acted floors. Selection uses every
   * labeled sample (the same corpus the gate scores), so the recommended verdict is descriptive
   * rather than held out; the Platt map is still fit on development acted decisions only.
   */
  selection: ThresholdSelection;
  /** The server-default verdict: the lane as composed, unchanged. */
  defaultVerdict: AdventureThresholdVerdict;
  /** The recommended-threshold verdict, or null when no threshold qualified. */
  recommendedVerdict: AdventureThresholdVerdict | null;
}

/**
 * The proposed promotion record, or null when the gate did not pass. A record is only proposed
 * for a passing gate; a not-ready lane must not be recorded as promoted.
 */
export function proposeAdventureRecord(
  gate: SystemOnePromotionResult,
  metrics: AdventureCalibrationMetrics,
  calibration: PlattCalibration,
  promotedAt: string,
  evidence = EVIDENCE,
): SystemOnePromotionRecord | null {
  if (!gate.promoted) return null;
  return { metrics, calibration, promotedAt, evidence };
}

export interface AdventureEvaluation {
  readouts: AdventureReadout[];
  /** The server-default calibration: fit on development acted decisions, scored on all of them. */
  calibration: AdventureCalibrationReport;
  /** The server-default gate verdict (the lane as composed). */
  gate: SystemOnePromotionResult;
  /**
   * The record from the **recommended-threshold** verdict: what the parent would paste into
   * `SYSTEM_ONE_PROMOTION_RECORDS`. Null when no threshold qualified or its gate did not pass.
   * The server default action threshold is unchanged by this proposal.
   */
  proposedRecord: SystemOnePromotionRecord | null;
  sweep: AdventureThresholdSweep;
}

/**
 * Runs the pure grading, calibration, threshold sweep, and both gate verdicts over collected readouts.
 *
 * The default verdict uses the readout's composed band (existing behavior). The sweep scores the
 * candidate each call named at every grid threshold with the lane gate's own floors, then the
 * recommended verdict re-runs the gate at the selected threshold with a Platt map fit on the
 * development acted decisions at that threshold.
 */
export function evaluateAdventureReadouts(
  readouts: readonly AdventureReadout[],
  promotedAt: string,
  defaultThreshold: number = ADVENTURE_DEFAULT_ACTION_THRESHOLD,
): AdventureEvaluation {
  const calibration = evaluateAdventureCalibration(readouts);
  const defaultGate = evaluatePromotionGate(PROMOTION_LANE, {
    samples: calibration.allCalibrated.samples,
    accuracy: calibration.allCalibrated.accuracy,
    brier: calibration.allCalibrated.brier,
    expectedCalibrationError: calibration.allCalibrated.expectedCalibrationError,
  });
  const defaultVerdict: AdventureThresholdVerdict = {
    threshold: defaultThreshold,
    calibration,
    gate: defaultGate,
    proposedRecord: proposeAdventureRecord(defaultGate, calibration.allCalibrated, calibration.fitted, promotedAt),
  };

  const samples = adventureThresholdSamples(readouts, ADVENTURE_THRESHOLD_GRID);
  const selection = selectActionThreshold(samples, {
    thresholds: ADVENTURE_THRESHOLD_GRID,
    minAccuracy: LANE_GATE.minAccuracy,
    minActed: LANE_GATE.minSamples,
  });
  const recommendedVerdict = selection.selected === null
    ? null
    : thresholdVerdict(readouts, selection.selected.threshold, promotedAt);
  const devSamples = adventureThresholdSamples(readouts.filter((readout) => !readout.holdout), ADVENTURE_THRESHOLD_GRID);
  const holdoutSamples = adventureThresholdSamples(readouts.filter((readout) => readout.holdout), ADVENTURE_THRESHOLD_GRID);

  return {
    readouts: [...readouts],
    calibration,
    gate: defaultGate,
    proposedRecord: recommendedVerdict?.proposedRecord ?? null,
    sweep: {
      grid: ADVENTURE_THRESHOLD_GRID,
      points: selection.points,
      devPoints: aggregateThresholdSamples(devSamples, ADVENTURE_THRESHOLD_GRID),
      holdoutPoints: aggregateThresholdSamples(holdoutSamples, ADVENTURE_THRESHOLD_GRID),
      selection,
      defaultVerdict,
      recommendedVerdict,
    },
  };
}

/** One `StabilitySample` per graded call: the pick the call named (composed or recovered), else `defer`. */
export function adventureStabilitySamples(readouts: readonly AdventureReadout[]): StabilitySample[] {
  return readouts.map((readout) => ({
    caseId: readout.id,
    decision: readout.candidateId ?? "defer",
    signal: readout.topSignal,
  }));
}

/**
 * Repeatability roll-up over the graded calls. Pure. Stability is repeatability, not accuracy: a
 * case that defers on every repeat is stable and still a coverage miss.
 */
export function summarizeAdventureStability(readouts: readonly AdventureReadout[]): StabilitySummary {
  return summarizeStability(adventureStabilitySamples(readouts));
}

/** How a corpus row entered this run: the frozen projection corpus or a confirmed live harvest. */
export type AdventureCaseProvenance = "frozen" | "harvested";

/** The parent-owned confirmed-harvest fixture shape (`version: 1`). Proposals are validated defensively. */
export interface AdventureHarvestFixture {
  version: number;
  lane: string;
  generatedAt: string;
  proposals: HarvestProposal[];
}

/** The cases a confirmed harvest contributes, and how many confirmed proposals could not be mapped. */
export interface HarvestedAdventureMerge {
  cases: AdventureEvalCase[];
  /** Confirmed proposals for this lane found in the input. */
  confirmed: number;
  /** Confirmed proposals skipped because their state or expected value was unusable. */
  skipped: number;
}

/** The merged harvest plus whether the fixture existed and why it may have been unusable. */
export interface HarvestedAdventureCases extends HarvestedAdventureMerge {
  /** True when the fixture file existed (even if malformed). */
  present: boolean;
  /** A clear warning when the fixture existed but was unusable; null when it loaded or was absent. */
  warning: string | null;
}

/** What the report needs to show the gate included live-derived labels. */
export interface AdventureHarvestReport {
  fixture: string;
  present: boolean;
  confirmed: number;
  skipped: number;
  /** Merged harvested cases that actually ran. */
  cases: number;
  warning: string | null;
}

const EMPTY_HARVEST: AdventureHarvestReport = {
  fixture: HARVEST_FIXTURE,
  present: false,
  confirmed: 0,
  skipped: 0,
  cases: 0,
  warning: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The lane-relevant slice of a proposal, defensively validated from parsed JSON. */
interface HarvestedProposalShape {
  proposalId: string;
  lane: string;
  status: string;
  state: unknown;
  expected: unknown;
}

function harvestProposalShape(value: unknown): HarvestedProposalShape | null {
  if (!isRecord(value)) return null;
  if (typeof value.proposalId !== "string" || !value.proposalId.trim()) return null;
  if (typeof value.lane !== "string" || typeof value.status !== "string") return null;
  return {
    proposalId: value.proposalId,
    lane: value.lane,
    status: value.status,
    state: value.state,
    expected: value.expected ?? null,
  };
}

function harvestedCandidates(value: unknown): AdventureSelectionCandidate[] | null {
  if (!Array.isArray(value)) return null;
  const candidates: AdventureSelectionCandidate[] = [];
  for (const entry of value) {
    const record = isRecord(entry) ? entry : null;
    if (!record
      || typeof record.candidateId !== "string" || !record.candidateId.trim()
      || typeof record.digest !== "string" || !record.digest.trim()
      || typeof record.kind !== "string" || !record.kind.trim()
      || typeof record.label !== "string" || !record.label.trim()) return null;
    candidates.push({ candidateId: record.candidateId, digest: record.digest, kind: record.kind, label: record.label });
  }
  return candidates;
}

/**
 * Maps one confirmed adventure-selection proposal onto a corpus case, or null when its state or
 * expected value is unusable. `expected = { candidateId: null }` is a confirmed defer label and
 * becomes a defer-expected case; a non-null id must name an advertised candidate. Harvested
 * digests are the recorded advisory bindings (travel rows are not digest-bound), so these cases
 * are evidence only and are never re-validated or executed.
 */
function adventureCaseFromHarvest(proposal: HarvestedProposalShape): AdventureEvalCase | null {
  const state = isRecord(proposal.state) ? proposal.state : null;
  if (!state || typeof state.declaration !== "string" || !state.declaration.trim()) return null;
  const candidates = harvestedCandidates(state.candidates);
  if (candidates === null) return null;
  const expected = isRecord(proposal.expected) ? proposal.expected : null;
  if (!expected || !("candidateId" in expected)) return null;
  const candidateId = expected.candidateId;
  if (candidateId !== null && typeof candidateId !== "string") return null;
  if (candidateId !== null && !candidates.some((candidate) => candidate.candidateId === candidateId)) return null;
  return {
    id: `${HARVEST_ID_PREFIX}${proposal.proposalId.slice(0, 12)}`,
    category: "harvested",
    declaration: state.declaration.trim(),
    candidates,
    expected: { preferred: candidateId, acceptable: [candidateId] },
    holdout: false,
  };
}

/**
 * Merges confirmed adventure-selection proposals from a parsed fixture. Non-confirmed and
 * foreign-lane proposals are ignored; confirmed proposals with a null or malformed expected value
 * (or an unusable state) are counted in `skipped`. Duplicate ids keep the first case.
 */
export function mergeHarvestedAdventureCases(proposals: readonly unknown[]): HarvestedAdventureMerge {
  const cases: AdventureEvalCase[] = [];
  const seen = new Set<string>();
  let confirmed = 0;
  let skipped = 0;
  for (const value of proposals) {
    const proposal = harvestProposalShape(value);
    if (!proposal || proposal.lane !== PROMOTION_LANE || proposal.status !== "confirmed") continue;
    confirmed += 1;
    const testCase = adventureCaseFromHarvest(proposal);
    if (!testCase || seen.has(testCase.id)) {
      skipped += 1;
      continue;
    }
    seen.add(testCase.id);
    cases.push(testCase);
  }
  return { cases, confirmed, skipped };
}

/**
 * Parses the parent-owned harvest fixture text. A malformed fixture never throws: it yields zero
 * cases and a clear warning the caller can print and report.
 */
export function parseHarvestedAdventureCases(text: string): HarvestedAdventureCases {
  const unusable = (warning: string): HarvestedAdventureCases => ({
    cases: [],
    confirmed: 0,
    skipped: 0,
    present: true,
    warning,
  });
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return unusable(`harvested fixture is not valid JSON: ${messageOf(error)}`);
  }
  if (!isRecord(value) || !Array.isArray(value.proposals)) {
    return unusable("harvested fixture must be an object with a proposals array");
  }
  if (value.version !== 1) {
    return unusable(`unsupported harvested fixture version: ${String(value.version)}`);
  }
  if (value.lane !== PROMOTION_LANE) {
    return unusable(`harvested fixture lane is ${String(value.lane)}, expected ${PROMOTION_LANE}`);
  }
  return { ...mergeHarvestedAdventureCases(value.proposals), present: true, warning: null };
}

/**
 * Reads the confirmed harvest fixture. Absence is normal (no harvest yet) and yields zero cases
 * with no warning; any other read or parse failure is reported as a warning and skipped so the
 * live benchmark never fails because of the fixture.
 */
export async function loadHarvestedAdventureCases(filePath: string = HARVEST_FIXTURE_PATH): Promise<HarvestedAdventureCases> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { cases: [], confirmed: 0, skipped: 0, present: false, warning: null };
    }
    return {
      cases: [],
      confirmed: 0,
      skipped: 0,
      present: true,
      warning: `harvested fixture could not be read: ${messageOf(error)}`,
    };
  }
  return parseHarvestedAdventureCases(text);
}

export interface AdventureCaseSummary {
  id: string;
  category: AdventureEvalCategory;
  /** `harvested` rows are confirmed live-derived labels included in the run and the gate. */
  provenance: AdventureCaseProvenance;
  holdout: boolean;
  /** The case's single preferred call, or null when it should defer. */
  expected: string | null;
  calls: number;
  acted: number;
  /** Calls that committed the exact preferred candidate (including a preferred deferral). */
  exact: number;
  /** Calls whose committed selection or deferral is in the acceptable set. */
  correct: number;
  failed: number;
  bands: Record<SystemOneBand, number>;
  /** Committed outcome counts keyed by candidate id, with `defer` for every non-`act` band. */
  selections: Record<string, number>;
  meanSignal: number;
}

/** Per-case roll-up over repeats, for the report table. `cases` defaults to the frozen corpus. */
export function summarizeAdventureCases(
  readouts: readonly AdventureReadout[],
  failures: readonly { id: string }[] = [],
  cases: readonly AdventureEvalCase[] = ADVENTURE_EVAL_CASES,
): AdventureCaseSummary[] {
  return cases.map((testCase) => {
    const rows = readouts.filter((readout) => readout.id === testCase.id);
    const bands: Record<SystemOneBand, number> = { act: 0, confirm: 0, fallback: 0 };
    const selections: Record<string, number> = {};
    let signalTotal = 0;
    let signalCount = 0;
    for (const row of rows) {
      bands[row.band] += 1;
      const key = row.selected ?? "defer";
      selections[key] = (selections[key] ?? 0) + 1;
      if (row.topSignal !== null && Number.isFinite(row.topSignal)) {
        signalTotal += row.topSignal;
        signalCount += 1;
      }
    }
    return {
      id: testCase.id,
      category: testCase.category,
      provenance: testCase.id.startsWith(HARVEST_ID_PREFIX) ? "harvested" : "frozen",
      holdout: testCase.holdout,
      expected: testCase.expected.preferred,
      calls: rows.length,
      acted: rows.filter((row) => !row.deferred).length,
      exact: rows.filter((row) => row.selectedCorrect).length,
      correct: rows.filter((row) => row.correct).length,
      failed: failures.filter((failure) => failure.id === testCase.id).length,
      bands,
      selections,
      meanSignal: signalCount === 0 ? 0 : signalTotal / signalCount,
    };
  });
}

export interface AdventureBenchmarkFailure {
  id: string;
  repeat: number;
  error: string;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function metricRow(label: string, metrics: AdventureCalibrationMetrics): string {
  return `| ${label} (${metrics.samples}) | ${metrics.samples === 0 ? "n/a" : pct(metrics.accuracy)} | ${metrics.brier.toFixed(4)} | ${metrics.expectedCalibrationError.toFixed(4)} |`;
}

function thresholdTable(points: readonly ThresholdPoint[]): string[] {
  const lines = ["| Action threshold | Acted | Coverage | Acted accuracy |", "| ---: | ---: | ---: | ---: |"];
  for (const point of points) {
    lines.push(`| ${point.threshold.toFixed(2)} | ${point.acted}/${point.total} | ${(point.coverage * 100).toFixed(1)}% | ${point.acted === 0 ? "n/a" : pct(point.actedAccuracy)} |`);
  }
  return lines;
}

function verdictRow(label: string, verdict: AdventureThresholdVerdict): string {
  const metrics = verdict.calibration.allCalibrated;
  return `| ${label} | ${verdict.threshold.toFixed(2)} | ${verdict.gate.promoted ? "PROMOTE" : "NOT READY"} | ${metrics.samples} | ${metrics.samples === 0 ? "n/a" : pct(metrics.accuracy)} | ${metrics.brier.toFixed(4)} | ${metrics.expectedCalibrationError.toFixed(4)} |`;
}

/** Renders the markdown benchmark report. Pure. */
export function renderAdventureBenchmark(input: {
  generatedAt: string;
  model: string;
  baseUrl: string;
  repeats: number;
  thresholds: SystemOneConfidenceThresholds;
  readouts: readonly AdventureReadout[];
  failures: readonly AdventureBenchmarkFailure[];
  evaluation: AdventureEvaluation;
  proposedRecord: SystemOnePromotionRecord | null;
  out: string;
  /** The cases this run evaluated: the frozen corpus plus any merged harvested cases. */
  cases?: readonly AdventureEvalCase[];
  /** Confirmed-harvest provenance for the report; omit when no fixture was considered. */
  harvest?: AdventureHarvestReport;
}): string {
  const { generatedAt, model, baseUrl, repeats, thresholds, readouts, failures, evaluation, proposedRecord, out } = input;
  const cases = input.cases ?? ADVENTURE_EVAL_CASES;
  const harvest = input.harvest ?? EMPTY_HARVEST;
  const { calibration, gate, sweep } = evaluation;
  const summaries = summarizeAdventureCases(readouts, failures, cases);
  const totalCalls = cases.length * repeats;
  const stability = summarizeAdventureStability(readouts);
  const stabilityConflicts = stability.cases.filter((entry) => entry.conflicted);
  const stdText = (value: number | null): string => (value === null ? "n/a" : value.toFixed(4));
  const jsonPath = out.replace(/\.md$/, ".json");
  const bands: Record<SystemOneBand, number> = { act: 0, confirm: 0, fallback: 0 };
  for (const readout of readouts) bands[readout.band] += 1;
  const acted = readouts.filter((readout) => !readout.deferred);
  const actedCorrect = acted.filter((readout) => readout.correct).length;
  const actedExact = acted.filter((readout) => readout.selectedCorrect).length;
  const deferrals = readouts.filter((readout) => readout.deferred);
  const deferralsAcceptable = deferrals.filter((readout) => readout.correct).length;
  const actedMisses = acted.filter((readout) => !readout.correct);
  const actedAlternatives = acted.filter((readout) => !readout.selectedCorrect && readout.correct);
  const holdout = cases.filter((testCase) => testCase.holdout).length;
  const namedReadouts = readouts.filter(
    (readout): readout is AdventureReadout & { candidateId: string; topSignal: number } =>
      readout.candidateId !== null && readout.topSignal !== null && Number.isFinite(readout.topSignal),
  );
  const namedDeferred = namedReadouts.filter((readout) => readout.deferred);
  const namedDeferredAcceptable = namedDeferred.filter((readout) => readout.acceptable.includes(readout.candidateId));
  const namedSignals = namedDeferred.map((readout) => readout.topSignal);
  const namedSignalRange = namedSignals.length === 0
    ? "n/a"
    : `${Math.min(...namedSignals).toFixed(2)}–${Math.max(...namedSignals).toFixed(2)}`;
  const recommended = sweep.recommendedVerdict;
  const defaultThresholdText = sweep.defaultVerdict.threshold.toFixed(2);
  const lines: string[] = [];

  lines.push("# System One (Jev) L2 adventure-selection benchmark");
  lines.push("");
  lines.push(`Generated ${generatedAt} by \`scripts/evaluate-system-one-adventure-lane.ts\` using the live System One adapter.`);
  lines.push("");
  lines.push("## What this measures");
  lines.push("");
  lines.push("The L2 lane is an **advisory exact-candidate selector, wired in shadow (record-only)**. `buildAdventureSelectionQuestions`");
  lines.push("builds one fusion-free single battery over the union of the turn's advertised candidates: a");
  lines.push("`supported` noul (\"does the declaration clearly describe committing exactly one advertised");
  lines.push("candidate?\"), one per-candidate relevance `score`, and one aggregate `best_candidate`");
  lines.push("`choice` over the exact candidate ids with the fail-closed `none_of_these` option.");
  lines.push("`composeAdventureSelection` requires the aggregate choice to name an advertised candidate and");
  lines.push("combines the chosen option's probability with the `supported` noul as the minimum of the two");
  lines.push("independent claims; `act` selects, `confirm` records a lower-confidence selection, and anything");
  lines.push("below defers. The lane is **wired in shadow (record-only)** behind the `FEATURE_SYSTEM_ONE` feature flag,");
  lines.push("the enabled setting, a usable key, and a non-`off` lane mode: it records one immutable shadow decision");
  lines.push("per fresh adventure turn that advertises candidates and never selects, orders, or commits anything. An");
  lines.push("`active` lane mode is still record-only because no promoted active path exists.");
  lines.push("");
  lines.push("The lane **never adds, drops, or authorizes a candidate**: candidate ids and digests are already");
  lines.push("server-issued, selection is exact-candidate only, and the existing digest re-validation and");
  lines.push("command bridge remain authoritative. There is no repository fixture, so the lane is graded");
  lines.push("against a hand-labeled projection corpus of declarations and server-shaped candidate sets.");
  lines.push("");
  lines.push("`act` is the only behavior-changing outcome. `confirm` is a deferral (it records a selection but");
  lines.push("changes no behavior) and is coverage, not a decision, so only acted decisions are calibrated and");
  lines.push("scored by the promotion gate. `correct` uses the case's asserted-subset rubric: the committed");
  lines.push("selection — or the deferral — must be in the case's `acceptable` set.");
  lines.push("");
  lines.push("Because the first live run showed the raw model naming the right candidate below the server");
  lines.push(`default action bar (${defaultThresholdText}), the harness also sweeps a fixed grid of lower thresholds,`);
  lines.push("re-scoring the candidate each call actually named (committed or not) against the case labels.");
  lines.push("That sweep reports a **recommended action threshold**; it does not change the server default.");
  lines.push("");
  lines.push("## Setup");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Model | ${model} |`);
  lines.push(`| Base URL | ${baseUrl} |`);
  lines.push(`| Lane | \`${PROMOTION_LANE}\` (advisory, shadow-wired record-only; no promoted active path) |`);
  lines.push(`| Confidence thresholds (action / review) | ${thresholds.actionThreshold} / ${thresholds.reviewThreshold} |`);
  lines.push(`| Action-threshold sweep grid | ${sweep.grid.map((value) => value.toFixed(2)).join(", ")} |`);
  lines.push("| Battery | single fusion-free battery: 1 `supported` noul + 1 `relevance:<candidateId>` score per candidate + 1 `best_candidate` choice |");
  lines.push(`| Repeats | ${repeats} |`);
  lines.push(`| Corpus | ${cases.length} declarations x ${repeats} repeats = ${totalCalls} calls |`);
  lines.push(`| Holdout | ${holdout} case(s) held out of the Platt fit (${cases.length - holdout} development) |`);
  lines.push(`| Harvested cases | ${harvest.cases} confirmed merged, ${harvest.skipped} skipped — ${harvest.present ? `\`${harvest.fixture}\`` : "fixture absent"} |`);
  lines.push("");
  if (harvest.warning) {
    lines.push(`> **Harvest warning:** ${harvest.warning} Those proposals are skipped; the run continues.`);
    lines.push("");
  }
  lines.push("## Corpus and per-case results");
  lines.push("");
  if (harvest.cases > 0 || harvest.confirmed > 0) {
    lines.push(`${harvest.cases} of ${cases.length} case(s) are **harvested** rows: confirmed live-derived labels from`);
    lines.push(`\`${harvest.fixture}\` (${harvest.skipped} confirmed proposal(s) skipped). They run through the same composition,`);
    lines.push("calibration, and threshold logic as the frozen corpus, so the gate metrics below include them.");
    lines.push("");
  }
  lines.push("| Case | Category | Split | Provenance | Expected | Calls | Acted | Exact | Correct | Errors | Effective outcomes |");
  lines.push("| --- | --- | :---: | :---: | --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const summary of summaries) {
    const outcomes = Object.entries(summary.selections)
      .sort(([left], [right]) => (left === "defer" ? -1 : right === "defer" ? 1 : left.localeCompare(right)))
      .map(([outcome, count]) => `${outcome} ${count}`)
      .join(", ");
    lines.push(`| ${summary.id} | ${summary.category} | ${summary.holdout ? "holdout" : "dev"} | ${summary.provenance} | ${summary.expected ?? "defer"} | ${summary.calls} | ${summary.acted} | ${summary.exact}/${summary.calls} | ${summary.correct}/${summary.calls} | ${summary.failed} | ${outcomes || "—"} |`);
  }
  lines.push("");
  if (failures.length > 0) {
    lines.push(`Adapter failures: ${failures.length}.`);
    for (const failure of failures.slice(0, 10)) lines.push(`- \`${failure.id}\` repeat ${failure.repeat}: ${failure.error}`);
    lines.push("");
  }
  lines.push("## Decision stability");
  lines.push("");
  lines.push("Repeated draws of the same case should produce the same decision. `decision` is the candidate each");
  lines.push("call named (the composed pick, or the raw pick recovered from a deferral), else `defer`; every");
  lines.push("repeat keeps the production-shaped request (no `uid`), so these are same-state draws of the exact");
  lines.push("request the gate scores. A uid-decorrelated probe moved the selected threshold from 0.60 to 0.30");
  lines.push("and produced a degenerate negative-slope calibration map (calibrated ECE 0.1344 > 0.10), so the");
  lines.push("protocol decision is that gate measurements mirror production and the vendor decorrelator is");
  lines.push("reserved for dedicated stability probes.");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Mean agreement | ${stability.cases.length === 0 ? "n/a" : pct(stability.meanAgreement)} |`);
  lines.push(`| Conflict cases | ${stability.conflictCases} of ${stability.cases.length} (${pct(stability.conflictRate)}) |`);
  lines.push(`| Mean signal std dev | ${stdText(stability.meanSignalStdDev)} |`);
  lines.push(`| Max signal std dev | ${stdText(stability.maxSignalStdDev)} |`);
  lines.push("");
  if (stabilityConflicts.length > 0) {
    lines.push("Conflicted cases:");
    for (const entry of stabilityConflicts.slice(0, 10)) {
      lines.push(`- \`${entry.caseId}\` (agreement ${pct(entry.agreement)}): ${entry.decisions.join(" / ")}`);
    }
    lines.push("");
  }
  lines.push("Honesty: stability is repeatability, not accuracy; a consistently deferred case is stable and still");
  lines.push("a coverage miss, and a conflicted case may still have every individual pick labeled acceptable.");
  lines.push("");
  lines.push("## Threshold sweep");
  lines.push("");
  lines.push(`The lane composes at the server default action threshold **${defaultThresholdText}**. The sweep re-scores the`);
  lines.push("candidate each call named — the composed pick, or for a deferral the raw `best_candidate` recovered");
  lines.push("from the answers — against that case's acceptable set at every grid threshold, without re-asking");
  lines.push(`the model. Selection takes the greatest-coverage threshold whose acted count and acted accuracy clear`);
  lines.push(`the lane gate floors (>= ${LANE_GATE.minAccuracy} accuracy over >= ${LANE_GATE.minSamples} acted) over every labeled sample;`);
  lines.push("the Platt map is still fit on development acted decisions only, so the recommended verdict is");
  lines.push(`descriptive rather than held out. The server default remains **${defaultThresholdText}** until configured.`);
  lines.push("");
  lines.push("Rows count only calls that named a candidate: a call that named nothing cannot act at any threshold,");
  lines.push("so `Acted` and `Coverage` are over named calls, not over every graded call.");
  lines.push("");
  lines.push("| Action threshold | Acted | Coverage | Acted accuracy |");
  lines.push("| ---: | ---: | ---: | ---: |");
  for (const point of sweep.points) {
    lines.push(`| ${point.threshold.toFixed(2)} | ${point.acted}/${point.total} | ${(point.coverage * 100).toFixed(1)}% | ${point.acted === 0 ? "n/a" : pct(point.actedAccuracy)} |`);
  }
  lines.push("");
  if (sweep.selection.selected) {
    const selected = sweep.selection.selected;
    lines.push(`Selected recommended action threshold: **${selected.threshold.toFixed(2)}** (coverage ${(selected.coverage * 100).toFixed(1)}%, acted accuracy ${pct(selected.actedAccuracy)} over ${selected.acted} acted).`);
  } else {
    lines.push("No threshold qualified: every grid point failed the acted-count or acted-accuracy floor.");
  }
  for (const reason of sweep.selection.reasons) lines.push(`- ${reason}`);
  lines.push("");
  lines.push("### Development split");
  lines.push("");
  lines.push(...thresholdTable(sweep.devPoints));
  lines.push("");
  lines.push("### Verdict comparison");
  lines.push("");
  lines.push("| Configuration | Threshold | Gate | Samples | Accuracy | Brier | ECE |");
  lines.push("| --- | ---: | :---: | ---: | ---: | ---: | ---: |");
  lines.push(verdictRow("Server default", sweep.defaultVerdict));
  if (recommended) lines.push(verdictRow("Recommended", recommended));
  lines.push("");
  lines.push("## Calibration");
  lines.push("");
  lines.push(`Fit the monotonic Platt map on the acted development decisions at the server default threshold (${defaultThresholdText}) and scored it out of sample on the held-out cases. The recommended-threshold calibration is in the sweep above and the JSON sidecar.`);
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
  lines.push(`## Promotion gate — \`${PROMOTION_LANE}\``);
  lines.push("");
  lines.push(`The server default action threshold remains **${defaultThresholdText}**; a recommended threshold is an evaluation`);
  lines.push("finding for the parent to configure, not an automatic change. The record below is proposed from the");
  lines.push("recommended-threshold verdict, because that is the configuration the evidence supports.");
  lines.push("");
  if (recommended) {
    lines.push(`### Recommended-threshold verdict (${recommended.threshold.toFixed(2)})`);
    lines.push("");
    lines.push(`Metrics scored on the calibrated acted signal at this threshold: samples ${recommended.calibration.allCalibrated.samples}, accuracy ${recommended.calibration.allCalibrated.samples === 0 ? "n/a" : pct(recommended.calibration.allCalibrated.accuracy)}, Brier ${recommended.calibration.allCalibrated.brier.toFixed(4)}, ECE ${recommended.calibration.allCalibrated.expectedCalibrationError.toFixed(4)}.`);
    lines.push("");
    lines.push(`**${recommended.gate.promoted ? "PROMOTE" : "NOT READY"}**`);
    lines.push("");
    if (recommended.gate.reasons.length === 0) lines.push("All gates passed.");
    else for (const reason of recommended.gate.reasons) lines.push(`- ${reason}`);
    lines.push("");
  } else {
    lines.push("No threshold from the sweep qualified, so there is no recommended-threshold verdict to promote.");
    lines.push("");
  }
  lines.push(`### Server-default verdict (${defaultThresholdText})`);
  lines.push("");
  lines.push(`Metrics scored on the calibrated acted signal at the composed default threshold: samples ${calibration.allCalibrated.samples}, accuracy ${calibration.allCalibrated.samples === 0 ? "n/a" : pct(calibration.allCalibrated.accuracy)}, Brier ${calibration.allCalibrated.brier.toFixed(4)}, ECE ${calibration.allCalibrated.expectedCalibrationError.toFixed(4)}.`);
  lines.push("");
  lines.push(`**${gate.promoted ? "PROMOTE" : "NOT READY"}**`);
  lines.push("");
  if (gate.reasons.length === 0) lines.push("All gates passed.");
  else for (const reason of gate.reasons) lines.push(`- ${reason}`);
  lines.push("");
  if (proposedRecord) {
    lines.push(`### Proposed \`${PROMOTION_LANE}\` promotion record (recommended threshold)`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(proposedRecord, null, 2));
    lines.push("```");
  } else if (recommended) {
    lines.push("No promotion record is proposed: the recommended-threshold verdict did not pass its gate.");
  } else {
    lines.push("No promotion record is proposed: no threshold qualified and the lane stays at the server default.");
  }
  lines.push("");
  lines.push("## Observations");
  lines.push("");
  lines.push(`- **Coverage.** ${acted.length} of ${readouts.length} graded calls acted (${bands.act} act / ${bands.confirm} confirm / ${bands.fallback} fallback); the rest deferred. ${deferralsAcceptable} of ${deferrals.length} deferral(s) were in the acceptable set.`);
  lines.push(`- **Decisive accuracy.** Among acted decisions, ${actedCorrect}/${acted.length} (${acted.length === 0 ? "n/a" : pct(actedCorrect / acted.length)}) were in the acceptable set and ${actedExact}/${acted.length} (${acted.length === 0 ? "n/a" : pct(actedExact / acted.length)}) matched the single preferred call.`);
  if (namedDeferred.length > 0) {
    lines.push(`- **Under-confidence.** ${namedReadouts.length} readout(s) named a candidate; ${namedDeferred.length} named one but deferred, with signals ${namedSignalRange}, and ${namedDeferredAcceptable.length} of those named picks were acceptable. The raw model is right but under the ${defaultThresholdText} bar — the same systematic under-confidence the L1 Director lane measured. The sweep recommendation is the lever; the server default stays ${defaultThresholdText}.`);
  } else {
    lines.push(`- **Under-confidence.** No live call named a candidate and then deferred, so this run does not exercise the under-confidence path.`);
  }
  if (actedMisses.length === 0) {
    lines.push("- **Acted errors.** No acted decision fell outside its case's acceptable set.");
  } else {
    lines.push(`- **Acted errors.** ${actedMisses.length} acted decision(s) fell outside the acceptable set: ${actedMisses.slice(0, 8).map((readout) => `\`${readout.id}\` (${readout.reason})`).join("; ")}${actedMisses.length > 8 ? "; …" : ""}.`);
  }
  if (actedAlternatives.length > 0) {
    lines.push(`- **Acceptable alternatives.** ${actedAlternatives.length} acted decision(s) chose a defensible candidate that was not the single preferred call: ${actedAlternatives.slice(0, 8).map((readout) => `\`${readout.id}\` (${readout.selected})`).join(", ")}.`);
  }
  lines.push(`- **Calibration.** Held-out calibrated Brier ${calibration.holdoutCalibrated.brier.toFixed(4)} and ECE ${calibration.holdoutCalibrated.expectedCalibrationError.toFixed(4)}; all-acted calibrated Brier ${calibration.allCalibrated.brier.toFixed(4)} and ECE ${calibration.allCalibrated.expectedCalibrationError.toFixed(4)}. ${acted.length === 0 ? "No acted decisions, so there is nothing to calibrate." : actedMisses.length === 0 ? "The acted subset has no observed errors, so the calibration tail is untested." : ""}`);
  lines.push("");
  lines.push("## Honesty notes");
  lines.push("");
  lines.push("- The corpus is a **hand-labeled projection**, not a repository fixture: candidate ids, digests,");
  lines.push("  and labels are realistic fixtures and the declarations are written, not sampled from real");
  lines.push("  turns. A passing gate is a promotion candidate, not a guarantee.");
  lines.push("- The recommended threshold is selected on the same labeled corpus that scores its verdict, so");
  lines.push("  that verdict is **descriptive, not a held-out guarantee**; the Platt map is still fit on");
  lines.push("  development acted decisions only. The server default stays until the parent decides otherwise.");
  lines.push("- The lane is **wired in shadow (record-only)**: it records one immutable decision per fresh");
  lines.push("  adventure turn that advertises candidates and never selects, orders, or commits. Any promotion");
  lines.push("  record this run justifies is evidence, not activation; an `active` lane mode still stays");
  lines.push("  record-only until a promoted active path exists.");
  lines.push("- Decisive accuracy is an **asserted-subset figure**: it counts membership in the case's");
  lines.push("  acceptable set, which is a judgment call. Exact-preferred agreement and the per-case table are");
  lines.push("  reported alongside it, and the gate is scored only on acted decisions.");
  lines.push("- **Decision stability is repeatability, not accuracy**: a consistently deferred case is stable and");
  lines.push("  still a coverage miss. Harvested rows are live-derived labels and are flagged as such in the");
  lines.push("  corpus table so a reviewer can see the gate includes them.");
  lines.push(`- The \`${PROMOTION_LANE}\` gate is the base lane gate (accuracy >= ${LANE_GATE.minAccuracy}, Brier/ECE <= ${LANE_GATE.maxBrier}). The verdict above is reported as measured, including any failures.`);
  lines.push("- Only schema-valid calls produce compositions; transport failures are reported separately and");
  lines.push("  never counted as acted samples.");
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```bash");
  lines.push("set -a; . /tmp/opencode/jev/jev.env; set +a   # TYPESAFE_API_KEY");
  lines.push(`npx tsx scripts/evaluate-system-one-adventure-lane.ts --repeat ${repeats}`);
  lines.push("```");
  lines.push("");
  lines.push(`Raw per-call data: \`${jsonPath}\`.`);
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

/**
 * The request state a gate run sends for one case: the declaration and the advertised candidate
 * count, mirroring the production shadow request. It deliberately carries no `uid` decorrelator —
 * gate runs must mirror the production request, and the vendor decorrelator is reserved for
 * dedicated stability probes (see the Decision stability section of the report).
 */
export function adventureRequestState(
  testCase: Pick<AdventureEvalCase, "declaration" | "candidates">,
): { declaration: string; candidateCount: number } {
  return { declaration: testCase.declaration, candidateCount: testCase.candidates.length };
}

export function parseAdventureArgs(args: readonly string[]): { repeats: number; out: string } {
  const repeatRaw = Number(parseFlag(args, "--repeat") ?? "3");
  const repeats = Math.max(1, Math.min(25, Number.isFinite(repeatRaw) ? Math.floor(repeatRaw) : 3));
  const out = parseFlag(args, "--out") ?? DEFAULT_OUT;
  return { repeats, out };
}

async function main(): Promise<void> {
  const key = process.env.TYPESAFE_API_KEY?.trim() ?? "";
  if (!key) {
    console.error("TYPESAFE_API_KEY is required for the live adventure-selection evaluation.");
    process.exitCode = 1;
    return;
  }
  const { repeats, out } = parseAdventureArgs(process.argv.slice(2));
  const outPath = path.resolve(ROOT, out);
  const settings = { ...defaultSystemOneSettings(), apiKey: key };
  const thresholds = settings.confidencePolicy[PROMOTION_LANE];
  const promotedAt = new Date().toISOString().slice(0, 10);

  const harvest = await loadHarvestedAdventureCases();
  if (harvest.warning) console.warn(`harvested fixture warning: ${harvest.warning}`);
  const harvestReport: AdventureHarvestReport = {
    fixture: HARVEST_FIXTURE,
    present: harvest.present,
    confirmed: harvest.confirmed,
    skipped: harvest.skipped,
    cases: harvest.cases.length,
    warning: harvest.warning,
  };
  const cases = [...ADVENTURE_EVAL_CASES, ...harvest.cases];

  const readouts: AdventureReadout[] = [];
  const failures: AdventureBenchmarkFailure[] = [];
  let model = settings.model;
  console.log(`evaluating ${cases.length} adventure declarations (${harvest.cases.length} harvested) x ${repeats} repeats against ${settings.model}`);
  console.log(`harvested cases: ${harvest.cases.length}${harvest.skipped > 0 ? ` (${harvest.skipped} confirmed skipped)` : ""}`);

  for (const testCase of cases) {
    const questions = buildAdventureSelectionQuestions(testCase.declaration, testCase.candidates);
    // Gate runs mirror the production request, which carries no `uid`: a uid decorrelator was
    // measured on the Director lane to move the selected threshold and produce a degenerate
    // calibration map, so this lane keeps the same-state production draw and reserves the vendor
    // decorrelator for dedicated stability probes. Stability samples are still collected per repeat.
    const state = adventureRequestState(testCase);
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      try {
        const result = await completeWithSystemOne({
          settings,
          state,
          questions,
        });
        model = result.model.responseModel ?? model;
        readouts.push(gradeAdventureCase(
          testCase,
          composeAdventureSelection(testCase.candidates, result.answers, thresholds),
          result.answers,
        ));
      } catch (error) {
        failures.push({ id: testCase.id, repeat, error: error instanceof Error ? error.message : "error" });
      }
    }
    process.stdout.write(".");
  }
  process.stdout.write("\n");

  if (readouts.length === 0) {
    const first = failures[0];
    throw new Error(
      `no live adventure-selection calls succeeded (${failures.length} failed)${first ? `; first error on \`${first.id}\` repeat ${first.repeat}: ${first.error}` : ""}`,
    );
  }

  const evaluation = evaluateAdventureReadouts(readouts, promotedAt, thresholds.actionThreshold);
  const stability = summarizeAdventureStability(readouts);
  const report = renderAdventureBenchmark({
    generatedAt: new Date().toISOString(),
    model,
    baseUrl: settings.baseUrl,
    repeats,
    thresholds,
    readouts,
    failures,
    evaluation,
    proposedRecord: evaluation.proposedRecord,
    out,
    cases,
    harvest: harvestReport,
  });
  await writeFile(outPath, report, "utf8");
  await writeFile(outPath.replace(/\.md$/, ".json"), `${JSON.stringify({
    model,
    baseUrl: settings.baseUrl,
    repeats,
    thresholds,
    corpus: cases,
    samples: cases.length * repeats,
    harvestedCases: harvest.cases.length,
    harvest: harvestReport,
    failures,
    readouts,
    stability,
    calibration: evaluation.calibration,
    gate: evaluation.gate,
    sweep: evaluation.sweep,
    proposedRecord: evaluation.proposedRecord,
  }, null, 2)}\n`, "utf8");

  const recommended = evaluation.sweep.recommendedVerdict;
  console.log(`acted at default ${evaluation.sweep.defaultVerdict.threshold}: ${evaluation.calibration.allCalibrated.samples}, accuracy ${pct(evaluation.calibration.allCalibrated.accuracy)}`);
  console.log(`sweep recommended threshold: ${recommended ? recommended.threshold.toFixed(2) : "none"}`);
  console.log(`gate default: ${evaluation.gate.promoted ? "PROMOTE" : "NOT READY"}${evaluation.gate.reasons.length ? ` (${evaluation.gate.reasons.join("; ")})` : ""}`);
  console.log(`gate recommended: ${recommended ? `${recommended.gate.promoted ? "PROMOTE" : "NOT READY"}${recommended.gate.reasons.length ? ` (${recommended.gate.reasons.join("; ")})` : ""}` : "n/a"}`);
  console.log(`brier: default ${evaluation.calibration.allCalibrated.brier.toFixed(4)}${recommended ? ` -> recommended ${recommended.calibration.allCalibrated.brier.toFixed(4)}` : ""}`);
  console.log(`stability: mean agreement ${pct(stability.meanAgreement)}, ${stability.conflictCases}/${stability.cases.length} conflicted case(s)`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
