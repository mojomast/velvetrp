#!/usr/bin/env node
/**
 * Runs the L1 Director selector against the provider-free candidate oracle using the
 * real System One (Jev) adapter, sweeps the action threshold over a dev/holdout split,
 * grades predicted probabilities with Brier/ECE, and evaluates the promotion gate.
 *
 * The run also merges confirmed harvested cases from the parent-owned fixture when one exists
 * (so live-derived labels join the gate with their provenance flagged) and reports a
 * decision-stability roll-up (repeat agreement, conflicts, signal variance) beside accuracy.
 *
 * Opt-in live evaluation: TYPESAFE_API_KEY must be exported. It uses a throwaway data
 * directory and never touches an existing store.
 *
 * Usage:
 *   TYPESAFE_API_KEY=... npx tsx scripts/evaluate-system-one-director.ts [--repeat 8] [--out docs/system-one-director-calibration.md]
 */
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatedCampaignContentProviderSchema } from "@velvet/contracts";
import {
  buildDirectorQuestions, composeDirectorSelection, type DirectorCandidateProjection, type DirectorComposition,
} from "../server/src/agent/systemOneDirector.js";
import { applyCalibration, fitPlattCalibration, type PlattCalibration } from "../server/src/agent/systemOneCalibration.js";
import { evaluatePromotionGate } from "../server/src/agent/systemOnePromotion.js";
import type { HarvestProposal } from "../server/src/agent/systemOneHarvest.js";
import {
  summarizeStability, type StabilitySample, type StabilitySummary,
} from "../server/src/agent/systemOneStability.js";
import {
  aggregateThresholdSamples, selectActionThreshold, type ThresholdPoint, type ThresholdSample,
} from "../server/src/agent/systemOneThreshold.js";
import { defaultSystemOneSettings } from "../server/src/defaults.js";
import { completeWithSystemOne, type SystemOneAnswer } from "../server/src/provider/systemOneCompletion.js";
import { gradeCalibration } from "../server/test/evals/dmGraders.js";
import { dmFixture } from "../server/test/fixtures/dmCampaign.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** The promotion lane id; also the harvest lane tag and the stability decorrelator namespace. */
export const PROMOTION_LANE = "director-selection" as const;

/** The parent-owned confirmed-harvest fixture; absent until a harvest run writes one. */
export const HARVEST_FIXTURE = "server/test/fixtures/system-one-harvested/director-selection.json";
const HARVEST_FIXTURE_PATH = path.resolve(ROOT, HARVEST_FIXTURE);
/** Harvested scenario ids carry this prefix so the report can mark live-derived labels. */
export const HARVEST_ID_PREFIX = "harvested:";

export const DEFAULT_THRESHOLD = 0.75;
export const THRESHOLD_GRID = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90];
const DIRECTOR_SECRET = "SECRET_GM_ONLY:the-mayor-is-the-traitor";

type Fixture = Awaited<ReturnType<typeof dmFixture>>;

function plan(fixture: Fixture, key: string): DirectorCandidateProjection[] {
  fixture.repo.setDmControl("local-owner", fixture.campaign.id, { mode: "ai", expectedRevision: 0, idempotencyKey: `${key}-ai` });
  const run = fixture.repo.openDmBeat("local-owner", fixture.campaign.id, fixture.session.id, { intent: "open", expectedModeRevision: 1, idempotencyKey: key });
  const work = fixture.repo.claimDmPlanning("local-owner", run.runId, "eval", "eval");
  return (work?.candidates ?? []).map((candidate) => ({
    candidateId: candidate.candidateId, digest: candidate.digest, action: candidate.action, label: candidate.label,
    pacing: candidate.action === "ambient-beat" || candidate.action === "advance-time",
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

/** How a scenario row entered this run: the fixed frozen list or a confirmed live harvest. */
export type DirectorCaseProvenance = "frozen" | "harvested";

export interface Scenario {
  id: string;
  projection: DirectorCandidateProjection[];
  /**
   * The oracle's preferred outcome: an action name (frozen scenarios), an exact candidate id
   * (harvested scenarios), or `hold` when no beat should be forced.
   */
  preferred: string;
  /** Other legal-but-not-preferred outcomes for this state; accepting them is not a regression. */
  acceptable?: string[];
  /** Held out from threshold selection so the selected threshold is validated out of sample. */
  holdout: boolean;
  /** `harvested` rows are confirmed live-derived labels included in the run and the gate. */
  provenance: DirectorCaseProvenance;
}

export interface Readout {
  method: string;
  selectedAction: string | null;
  topSignal: number;
  acted: boolean;
  /** The primary metric: held / preferred beat / an accepted alternative. */
  correct: boolean;
  /** The strict quality metric: exactly the preferred beat (or held when `hold` is preferred). */
  exact: boolean;
}

export interface CalibrationMetrics { brier: number; expectedCalibrationError: number }
export interface CalibrationReport {
  fitted: PlattCalibration;
  devSamples: number;
  holdoutSamples: number;
  /** Fit on development, scored on the held-out split: the unbiased estimate. */
  holdout: { raw: CalibrationMetrics; calibrated: CalibrationMetrics };
  /** Scored over every collected decision with the development-fit map. */
  all: { raw: CalibrationMetrics; calibrated: CalibrationMetrics };
}

/**
 * True when the composed first selection is the beat named by `label`. Frozen scenarios label a
 * beat by its action; harvested scenarios label it by its exact candidate id, so a label matches
 * either the selection's candidate id or its action. Ids and action names are disjoint namespaces,
 * so the check is unambiguous.
 */
function selectionMatches(
  selection: { candidateId: string } | undefined,
  projection: readonly DirectorCandidateProjection[],
  label: string,
): boolean {
  if (!selection) return false;
  if (selection.candidateId === label) return true;
  return projection.some((candidate) => candidate.candidateId === selection.candidateId && candidate.action === label);
}

export function readout(scenario: Scenario, answers: Record<string, SystemOneAnswer>, thresholds: { actionThreshold: number; reviewThreshold: number }): Readout {
  const composed = composeDirectorSelection(scenario.projection, answers, thresholds);
  const selected = composed.selections[0];
  const selectedAction = selected ? scenario.projection.find((candidate) => candidate.candidateId === selected.candidateId)?.action ?? null : null;
  const acceptable = new Set([scenario.preferred, ...(scenario.acceptable ?? [])]);
  const correct = scenario.preferred === "hold"
    ? composed.hold
    : [...acceptable].some((label) => selectionMatches(selected, scenario.projection, label));
  const exact = scenario.preferred === "hold" ? composed.hold : selectionMatches(selected, scenario.projection, scenario.preferred);
  return { method: composed.method, selectedAction, topSignal: composed.topSignal ?? 0, acted: composed.band === "act", correct, exact };
}

function actionsOf(scenario: Scenario): string[] {
  return [...new Set(scenario.projection.map((candidate) => candidate.action))].sort();
}

/* ------------------------------------------------------------------------------------------------
 * Harvest loop: confirmed live-derived Director labels merged into the frozen scenario list.
 * ---------------------------------------------------------------------------------------------- */

/** The parent-owned confirmed-harvest fixture shape (`version: 1`). Proposals are validated defensively. */
export interface DirectorHarvestFixture {
  version: number;
  lane: string;
  generatedAt: string;
  proposals: HarvestProposal[];
}

/** The scenarios a confirmed harvest contributes, and how many confirmed proposals could not be mapped. */
export interface HarvestedDirectorMerge {
  scenarios: Scenario[];
  /** Confirmed proposals for this lane found in the input. */
  confirmed: number;
  /** Confirmed proposals skipped because their state or expected value was unusable. */
  skipped: number;
}

/** The merged harvest plus whether the fixture existed and why it may have been unusable. */
export interface HarvestedDirectorCases extends HarvestedDirectorMerge {
  /** True when the fixture file existed (even if malformed). */
  present: boolean;
  /** A clear warning when the fixture existed but was unusable; null when it loaded or was absent. */
  warning: string | null;
}

/** What the report needs to show the gate included live-derived labels. */
export interface DirectorHarvestReport {
  fixture: string;
  present: boolean;
  confirmed: number;
  skipped: number;
  /** Merged harvested scenarios that actually ran. */
  cases: number;
  warning: string | null;
}

const EMPTY_HARVEST: DirectorHarvestReport = {
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

/** The fields a recorded Director projection entry may carry; anything else is a foreign shape. */
const PROJECTION_KEYS = new Set(["candidateId", "digest", "action", "label", "pacing"]);

/**
 * Maps a recorded `state.candidates` array onto a `DirectorCandidateProjection[]`, or null when
 * any entry is malformed or carries unknown fields. `pacing` is recomputed from the action
 * exactly as the live recorder does, so a stale or missing recorded flag cannot change the battery.
 */
function harvestedProjection(value: unknown): DirectorCandidateProjection[] | null {
  if (!Array.isArray(value)) return null;
  const projection: DirectorCandidateProjection[] = [];
  for (const entry of value) {
    const record = isRecord(entry) ? entry : null;
    if (!record) return null;
    if (Object.keys(record).some((key) => !PROJECTION_KEYS.has(key))) return null;
    if (typeof record.candidateId !== "string" || !record.candidateId.trim()
      || typeof record.digest !== "string" || !record.digest.trim()
      || typeof record.action !== "string" || !record.action.trim()
      || typeof record.label !== "string" || !record.label.trim()) return null;
    if ("pacing" in record && typeof record.pacing !== "boolean") return null;
    const action = record.action;
    projection.push({
      candidateId: record.candidateId,
      digest: record.digest,
      action,
      label: record.label,
      pacing: action === "ambient-beat" || action === "advance-time",
    });
  }
  return projection;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === "string") ? [...value] as string[] : null;
}

/**
 * Maps one confirmed Director proposal onto a scenario, or null when its state or expected value
 * is unusable. `expected = { selections }` is the recorded ordered candidate-id list: the first id
 * becomes the preferred beat and the rest are acceptable alternatives, while an empty list is a
 * confirmed hold. Every named id must be advertised by the recorded projection. Harvested digests
 * are the recorded advisory bindings, so these scenarios are evidence only and are never
 * re-validated or executed.
 */
function directorScenarioFromHarvest(proposal: HarvestedProposalShape): Scenario | null {
  const state = isRecord(proposal.state) ? proposal.state : null;
  if (!state) return null;
  const projection = harvestedProjection(state.candidates);
  if (projection === null) return null;
  const expected = isRecord(proposal.expected) ? proposal.expected : null;
  if (!expected) return null;
  const selections = stringArray(expected.selections);
  if (selections === null) return null;
  if (!selections.every((candidateId) => projection.some((candidate) => candidate.candidateId === candidateId))) return null;
  return {
    id: `${HARVEST_ID_PREFIX}${proposal.proposalId.slice(0, 12)}`,
    projection,
    preferred: selections[0] ?? "hold",
    acceptable: selections.slice(1),
    holdout: false,
    provenance: "harvested",
  };
}

/**
 * Merges confirmed Director proposals from a parsed fixture. Non-confirmed and foreign-lane
 * proposals are ignored; confirmed proposals with a null or malformed expected value (or an
 * unusable state) are counted in `skipped`. Duplicate ids keep the first scenario.
 */
export function mergeHarvestedDirectorScenarios(proposals: readonly unknown[]): HarvestedDirectorMerge {
  const scenarios: Scenario[] = [];
  const seen = new Set<string>();
  let confirmed = 0;
  let skipped = 0;
  for (const value of proposals) {
    const proposal = harvestProposalShape(value);
    if (!proposal || proposal.lane !== PROMOTION_LANE || proposal.status !== "confirmed") continue;
    confirmed += 1;
    const scenario = directorScenarioFromHarvest(proposal);
    if (!scenario || seen.has(scenario.id)) {
      skipped += 1;
      continue;
    }
    seen.add(scenario.id);
    scenarios.push(scenario);
  }
  return { scenarios, confirmed, skipped };
}

/**
 * Parses the parent-owned harvest fixture text. A malformed fixture never throws: it yields zero
 * scenarios and a clear warning the caller can print and report.
 */
export function parseHarvestedDirectorScenarios(text: string): HarvestedDirectorCases {
  const unusable = (warning: string): HarvestedDirectorCases => ({
    scenarios: [],
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
  return { ...mergeHarvestedDirectorScenarios(value.proposals), present: true, warning: null };
}

/**
 * Reads the confirmed harvest fixture. Absence is normal (no harvest yet) and yields zero
 * scenarios with no warning; any other read or parse failure is reported as a warning and skipped
 * so the live calibration never fails because of the fixture.
 */
export async function loadHarvestedDirectorScenarios(filePath: string = HARVEST_FIXTURE_PATH): Promise<HarvestedDirectorCases> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return { scenarios: [], confirmed: 0, skipped: 0, present: false, warning: null };
    }
    return {
      scenarios: [],
      confirmed: 0,
      skipped: 0,
      present: true,
      warning: `harvested fixture could not be read: ${messageOf(error)}`,
    };
  }
  return parseHarvestedDirectorScenarios(text);
}

/* ------------------------------------------------------------------------------------------------
 * Decision stability: repeatability of the composed decision across sampled calls.
 * ---------------------------------------------------------------------------------------------- */

/** One sampled call's composition at the shipped default threshold: the input to the stability roll-up. */
export interface DirectorDecisionSample {
  scenarioId: string;
  composition: DirectorComposition;
}

/**
 * The composed decision as a stability string: `candidateId > candidateId` for a committed
 * ordered selection, `hold` when the composition holds, and `defer` when it commits nothing (the
 * lane keeps its existing behavior). Order is significant because Director beats execute in
 * sequence, so a reordered selection is a conflict even when the set is unchanged.
 */
export function directorSelectionDecision(composition: Pick<DirectorComposition, "hold" | "selections">): string {
  if (composition.hold) return "hold";
  if (composition.selections.length === 0) return "defer";
  return composition.selections.map((selection) => selection.candidateId).join(" > ");
}

/** One `StabilitySample` per sampled call: the composed ordered selection (or `hold`/`defer`). */
export function directorStabilitySamples(samples: readonly DirectorDecisionSample[]): StabilitySample[] {
  return samples.map(({ scenarioId, composition }) => ({
    caseId: scenarioId,
    decision: directorSelectionDecision(composition),
    signal: composition.topSignal,
  }));
}

/**
 * Repeatability roll-up over the sampled calls. Pure. Stability is repeatability, not accuracy: a
 * scenario that defers on every repeat is stable and still a coverage miss.
 */
export function summarizeDirectorStability(samples: readonly DirectorDecisionSample[]): StabilitySummary {
  return summarizeStability(directorStabilitySamples(samples));
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function table(points: readonly ThresholdPoint[]): string[] {
  const lines = ["| Action threshold | Acted | Coverage | Acted accuracy |", "| ---: | ---: | ---: | ---: |"];
  for (const point of points) {
    lines.push(`| ${point.threshold.toFixed(2)} | ${point.acted}/${point.total} | ${(point.coverage * 100).toFixed(1)}% | ${point.acted === 0 ? "n/a" : `${(point.actedAccuracy * 100).toFixed(1)}%`} |`);
  }
  return lines;
}

/** Renders the markdown calibration report. Pure. */
export function renderDirectorCalibration(input: {
  scenarios: readonly Scenario[];
  repeats: number;
  model: string;
  defaultOutcomes: readonly Readout[];
  allPoints: ThresholdPoint[];
  devPoints: ThresholdPoint[];
  holdoutPoints: ThresholdPoint[];
  selected: ReturnType<typeof selectActionThreshold>;
  gate: ReturnType<typeof evaluatePromotionGate>;
  samples: number;
  exactAccuracy: number;
  gateStats: Array<{ id: string; acted: number; total: number; accuracy: number; meanPredicted: number }>;
  calibration: CalibrationReport;
  negatives: { acted: number; incorrect: number; inexact: number; lowestIncorrectSignal: number | null };
  /** Confirmed-harvest provenance for the report; omit when no fixture was considered. */
  harvest?: DirectorHarvestReport;
  /** The repeatability roll-up over every sampled call at the default threshold. */
  stability?: StabilitySummary;
}): string {
  const { scenarios, repeats, model, defaultOutcomes, allPoints, devPoints, holdoutPoints, selected, gate, samples, exactAccuracy, gateStats, calibration, negatives } = input;
  const harvest = input.harvest ?? EMPTY_HARVEST;
  const stability = input.stability ?? summarizeStability([]);
  const frozen = scenarios.filter((scenario) => scenario.provenance === "frozen").length;
  const harvested = scenarios.filter((scenario) => scenario.provenance === "harvested").length;
  const stabilityConflicts = stability.cases.filter((entry) => entry.conflicted);
  const stdText = (value: number | null): string => (value === null ? "n/a" : value.toFixed(4));
  const selectedThreshold = selected.selected?.threshold;
  const holdoutAtSelected = selectedThreshold === undefined ? undefined : holdoutPoints.find((point) => point.threshold === selectedThreshold);
  const lines: string[] = [];
  lines.push("# System One Director (L1) calibration");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()} by \`scripts/evaluate-system-one-director.ts\` using the live System One adapter.`);
  lines.push("");
  lines.push("The L1 selector builds two atomic questions per advertised candidate — a `progress` `noul` (is committing this a good, meaningful next step now?) and a priority `score` — plus a `hold` `noul` and an aggregate `best_candidate` `choice`. It composes grounded candidates (progress at the action threshold, ordered by priority) → hold → best-pick → defer. An atomic `legal` question was tried and dropped: the advertised set is server-authorized, so re-asking legality only added hedging (a legal `encounter-start` scored 0.51) without changing decisions. Because Director beats mutate campaign state, the aggregate best-pick must clear the **action** threshold.");
  lines.push("");
  lines.push("Correctness uses a two-tier provider-free candidate oracle. **Acceptable** (the primary, gating metric) means the selected action is the preferred beat or a legal non-regression alternative; **exact** means the single preferred beat. Frozen scenarios label a beat by its action; harvested scenarios label it by its exact candidate id. `hold` is only preferred where no beat should be forced. This grades a trustworthy beat, not one arbitrary label among several legal ones.");
  lines.push("");
  lines.push("## Setup");
  lines.push("");
  lines.push("| Setting | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Model | ${model} |`);
  lines.push(`| Repeats | ${repeats} |`);
  lines.push(`| Scenarios | ${scenarios.length} (${frozen} frozen + ${harvested} harvested) x ${repeats} repeats = ${samples} sampled decisions per threshold |`);
  lines.push(`| Harvested cases | ${harvest.cases} confirmed merged, ${harvest.skipped} skipped — ${harvest.present ? `\`${harvest.fixture}\`` : "fixture absent"} |`);
  lines.push("");
  if (harvest.warning) {
    lines.push(`> **Harvest warning:** ${harvest.warning} Those proposals are skipped; the run continues.`);
    lines.push("");
  }
  lines.push(`## Scenarios at the default threshold (${DEFAULT_THRESHOLD})`);
  lines.push("");
  if (harvest.cases > 0 || harvest.confirmed > 0) {
    lines.push(`${harvest.cases} of ${scenarios.length} scenario(s) are **harvested** rows: confirmed live-derived labels from`);
    lines.push(`\`${harvest.fixture}\` (${harvest.skipped} confirmed proposal(s) skipped). They run through the same composition,`);
    lines.push("calibration, and threshold logic as the frozen scenarios, so the gate metrics below include them.");
    lines.push("");
  }
  lines.push("| Scenario | Provenance | Oracle actions | Preferred | Acceptable | Method | Selected | Top signal | Acted | Accept | Exact |");
  lines.push("| --- | :---: | --- | --- | --- | --- | --- | ---: | :---: | :---: | :---: |");
  scenarios.forEach((scenario, index) => {
    const outcome = defaultOutcomes[index]!;
    lines.push(`| ${scenario.id} | ${scenario.provenance} | ${actionsOf(scenario).join(", ") || "—"} | ${scenario.preferred} | ${(scenario.acceptable ?? []).join(", ") || "—"} | ${outcome.method} | ${outcome.selectedAction ?? (outcome.method === "hold" ? "hold" : "—")} | ${outcome.topSignal.toFixed(3)} | ${outcome.acted ? "yes" : "defer"} | ${outcome.acted ? (outcome.correct ? "yes" : "no") : "n/a"} | ${outcome.acted ? (outcome.exact ? "yes" : "no") : "n/a"} |`);
  });
  lines.push("");
  lines.push("## Decision stability");
  lines.push("");
  lines.push("Repeated draws of the same scenario should produce the same decision. `decision` is the composed");
  lines.push("ordered selection (`candidateId > candidateId`), `hold` when the composition holds, or `defer` when");
  lines.push(`it commits nothing; compositions are taken at the default action threshold (${DEFAULT_THRESHOLD}) and every repeat`);
  lines.push("keeps the production-shaped request (no `uid`). A uid-decorrelated probe moved the selected");
  lines.push("threshold from 0.60 to 0.30 and produced a degenerate negative-slope calibration map");
  lines.push("(calibrated ECE 0.1344 > 0.10), so the gate measurement intentionally omits the decorrelator.");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Mean agreement | ${stability.cases.length === 0 ? "n/a" : pct(stability.meanAgreement)} |`);
  lines.push(`| Conflict cases | ${stability.conflictCases} of ${stability.cases.length} (${stability.cases.length === 0 ? "n/a" : pct(stability.conflictRate)}) |`);
  lines.push(`| Mean signal std dev | ${stdText(stability.meanSignalStdDev)} |`);
  lines.push(`| Max signal std dev | ${stdText(stability.maxSignalStdDev)} |`);
  lines.push("");
  if (stabilityConflicts.length > 0) {
    lines.push("Conflicted scenarios:");
    for (const entry of stabilityConflicts.slice(0, 10)) {
      lines.push(`- \`${entry.caseId}\` (agreement ${pct(entry.agreement)}): ${entry.decisions.join(" / ")}`);
    }
    lines.push("");
  }
  lines.push("Stability is repeatability, not accuracy: a consistently deferred scenario is stable and still a");
  lines.push("coverage miss, and a conflicted scenario may still have every individual pick labeled acceptable.");
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
  lines.push(`Map: \`sigmoid(a * logit(p) + b)\` with a = ${calibration.fitted.a.toFixed(4)}, b = ${calibration.fitted.b.toFixed(4)}. The held-out row is the unbiased estimate.`);
  lines.push("");
  lines.push("## Negative examples");
  lines.push("");
  if (negatives.acted === 0) {
    lines.push("No acted decisions were collected, so the calibrated gate could not be scored at all.");
  } else if (negatives.incorrect === 0) {
    lines.push(`None of the ${negatives.acted} acted decisions was unacceptable, and ${negatives.inexact} of ${negatives.acted} was not the exact preferred beat. The server candidate generator only advertises authorized beats and these frozen states contain no trap, so an acted error requires the model to pick a wrong advertised beat or to act when a player decision is required — neither occurs here. This corpus does not stress-test the calibrated gate, so a pass is a promotion **candidate**, not proof.`);
  } else {
    lines.push(`${negatives.incorrect} of ${negatives.acted} acted decisions were unacceptable (${((negatives.incorrect / negatives.acted) * 100).toFixed(1)}%)${negatives.lowestIncorrectSignal === null ? "" : `, the lowest-signal wrong pick at ${negatives.lowestIncorrectSignal.toFixed(3)}`}, so the calibrated gate is scored against real errors.`);
  }
  lines.push("");
  lines.push(`## Promotion gate — \`${PROMOTION_LANE}\``);
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
  const key = process.env.TYPESAFE_API_KEY?.trim() ?? "";
  if (!key) {
    console.error("TYPESAFE_API_KEY is required for the live Director calibration.");
    process.exitCode = 1;
    return;
  }
  process.env.VELVET_DATA_DIR ??= mkdtempSync(path.join(tmpdir(), "velvet-system-one-director-eval-"));
  const outIndex = process.argv.indexOf("--out");
  const repeatIndex = process.argv.indexOf("--repeat");
  const repeats = Math.max(1, Math.min(25, Number(repeatIndex >= 0 ? process.argv[repeatIndex + 1] : "8") || 8));
  const outPath = path.resolve(ROOT, outIndex >= 0 ? (process.argv[outIndex + 1] ?? "docs/system-one-director-calibration.md") : "docs/system-one-director-calibration.md");
  const settings = { ...defaultSystemOneSettings(), apiKey: key };
  const defaultThresholds = { actionThreshold: DEFAULT_THRESHOLD, reviewThreshold: 0.5 };

  const harvestResult = await loadHarvestedDirectorScenarios();
  if (harvestResult.warning) console.warn(`harvested fixture warning: ${harvestResult.warning}`);
  const harvestReport: DirectorHarvestReport = {
    fixture: HARVEST_FIXTURE,
    present: harvestResult.present,
    confirmed: harvestResult.confirmed,
    skipped: harvestResult.skipped,
    cases: harvestResult.scenarios.length,
    warning: harvestResult.warning,
  };

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
    { id: "empty-world", projection: empty, preferred: "ambient-beat", acceptable: ["advance-time"], holdout: false, provenance: "frozen" },
    { id: "story-graph", projection: graph, preferred: "reveal-node", acceptable: ["ambient-beat", "advance-time"], holdout: false, provenance: "frozen" },
    { id: "encounter-prep", projection: prepared, preferred: "encounter-start", holdout: false, provenance: "frozen" },
    { id: "story-graph-revealed", projection: revealed, preferred: "reveal-clue", acceptable: ["ambient-beat", "advance-time"], holdout: true, provenance: "frozen" },
    { id: "encounter-active", projection: active, preferred: "enemy-turn", holdout: true, provenance: "frozen" },
    { id: "gm-only", projection: gmOnly, preferred: "hold", holdout: true, provenance: "frozen" },
    ...harvestResult.scenarios,
  ];

  console.log(`evaluating ${scenarios.length} director scenarios (${harvestResult.scenarios.length} harvested) x ${repeats} repeats against ${settings.model}`);
  console.log(`harvested cases: ${harvestResult.scenarios.length}${harvestResult.skipped > 0 ? ` (${harvestResult.skipped} confirmed skipped)` : ""}`);

  const samples: ThresholdSample[] = [];
  const devSamples: ThresholdSample[] = [];
  const holdoutSamples: ThresholdSample[] = [];
  const defaultOutcomes: Readout[] = scenarios.map(() => ({ method: "defer", selectedAction: null, topSignal: 0, acted: false, correct: false, exact: false }));
  const collected: Array<{ scenario: Scenario; answers: Record<string, SystemOneAnswer> }> = [];
  let model = settings.model;

  for (const [index, scenario] of scenarios.entries()) {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const questions = buildDirectorQuestions(scenario.projection);
      const result = await completeWithSystemOne({
        settings,
        state: {
          scenario: scenario.id,
          repeat,
          // Gate runs mirror the production request, which carries no `uid`: a deterministic
          // throwaway decorrelator was measured to move the selected threshold from 0.60 to
          // 0.30 and to produce a degenerate negative-slope calibration map
          // (calibrated ECE 0.1344 > 0.10). The finding is recorded in
          // docs/system-one-harvest-loop.md; stability samples are still collected per repeat.
        },
        questions,
      });
      model = result.model.responseModel ?? model;
      collected.push({ scenario, answers: result.answers });
      if (repeat === 0) {
        defaultOutcomes[index] = readout(scenario, result.answers, defaultThresholds);
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

  const stability = summarizeDirectorStability(collected.map(({ scenario, answers }) => ({
    scenarioId: scenario.id,
    composition: composeDirectorSelection(scenario.projection, answers, defaultThresholds),
  })));

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
  const incorrectOutcomes = actedOutcomes.filter((outcome) => !outcome.correct);
  const negatives = {
    acted: actedOutcomes.length,
    incorrect: incorrectOutcomes.length,
    inexact: actedOutcomes.filter((outcome) => !outcome.exact).length,
    lowestIncorrectSignal: incorrectOutcomes.length === 0 ? null : Math.min(...incorrectOutcomes.map((outcome) => outcome.topSignal)),
  };

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
  const gate = evaluatePromotionGate(PROMOTION_LANE, {
    samples: actedOutcomes.length, accuracy, brier: calibration.all.calibrated.brier, expectedCalibrationError: calibration.all.calibrated.expectedCalibrationError,
  });

  const markdown = renderDirectorCalibration({
    scenarios, repeats, model, defaultOutcomes, allPoints, devPoints, holdoutPoints, selected, gate,
    samples: scenarios.length * repeats, exactAccuracy, gateStats, calibration, negatives, harvest: harvestReport, stability,
  });
  await writeFile(outPath, markdown, "utf8");
  await writeFile(outPath.replace(/\.md$/, ".json"), JSON.stringify({
    model, repeats, allPoints, devPoints, holdoutPoints, selected, gate, exactAccuracy, gateStats, calibration, negatives,
    harvestedCases: harvestResult.scenarios.length,
    harvest: harvestReport,
    stability,
  }, null, 2), "utf8");

  console.log(`selected threshold: ${selected.selected ? selected.selected.threshold.toFixed(2) : "none"} (dev coverage ${selected.selected ? (selected.selected.coverage * 100).toFixed(1) : 0}%, dev accuracy ${selected.selected ? (selected.selected.actedAccuracy * 100).toFixed(1) : 0}%)`);
  console.log(`acted: ${actedOutcomes.length} acceptable=${(accuracy * 100).toFixed(1)}% exact=${(exactAccuracy * 100).toFixed(1)}%`);
  console.log(`gate: promoted=${gate.promoted}${gate.reasons.length ? ` reasons=${gate.reasons.join("; ")}` : ""}`);
  console.log(`stability: mean agreement ${pct(stability.meanAgreement)}, ${stability.conflictCases}/${stability.cases.length} conflicted case(s)`);
  console.log(`wrote ${path.relative(ROOT, outPath)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
