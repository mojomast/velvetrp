#!/usr/bin/env node
/**
 * Production-path evaluation of the System One adventure-selection lane.
 *
 * The curated benchmark (`evaluate-system-one-adventure-lane.ts`) grades projected candidate sets,
 * and its evidence explicitly cannot authorize production shortlisting. This evaluator measures
 * what the lane actually did on live worlds instead: every recorded `system_one_decisions_v1` row
 * for `lane='adventure-selection'`, whose `state_json.candidates` is the production shortlist the
 * live orchestrator built for that turn and whose `selection_json` is the lane's own composition
 * (confidence band, method, pick, top signal).
 *
 * Read-only and offline: each world database is opened with `node:sqlite` in read-only mode and
 * the runner never calls a provider and never writes to the world. It only writes the optional
 * `--out` markdown report and `--json` sidecar.
 *
 * For each world the evaluator joins:
 * - `adventure_turns` on `turn_id` for the declaration, turn state, and mode;
 * - `adventure_exact_action_proposal_bindings_v56` / `adventure_exact_action_executions_v56`
 *   (`origin='lane'`) and lane-origin `adventure_check_executions_v54` for committed lane actions;
 * - `tool_proposals` / `confirmation_decisions` for the confirmation outcome of lane proposals;
 * - provider candidate calls from `agent_tool_calls_v38.arguments_json`,
 *   `agent_decision_rounds_v38.response_json.calls`, `agent_provider_responses_v39.response_json.calls`,
 *   and provider-origin v56 bindings. The v38 tables are the recorded decision rounds; in the
 *   worlds inspected so far only the v39 response documents carry `arguments.candidateId`, so the
 *   reader accepts candidate ids from every recorded provider surface and keeps the first call per
 *   turn in source precedence order (`tool-call`, `decision-round`, `provider-response`,
 *   `provider-binding`). Extra candidate-naming calls on the same turn are counted, not dropped.
 *
 * Families reuse the harness taxonomy: `resolveMechanicFamily` maps the production candidate kinds
 * (`exact_actor_travel.select`, ...) to the canonical 11 `MECHANIC_FAMILIES`; the v56 action-kind
 * vocabulary and the v54 `check` kind are mapped by an exported table below. Anything a row does
 * not map resolves to `unknown` and is reported, never silently dropped.
 *
 * There are no correctness labels in production evidence. The report measures **reach**
 * (shortlist advertised the family), **decisiveness** (band distribution and defer rate),
 * **commit** (lane picks that produced a lane-origin execution vs advisory act picks with none),
 * **provider alignment** (same candidate id, or same family when ids differ), and
 * **confirmation outcomes** for lane proposals. Agreement with the provider is not ground truth,
 * worlds were recorded under the production (legacy) payload across code versions, and samples are
 * small and uneven; counts are reported beside every rate.
 *
 * Usage:
 *   npx tsx scripts/evaluate-system-one-production-path.ts --world .velvet/synth-srd-1 \
 *     --world .velvet/emberwake-reach-run2 [--out docs/system-one-production-path-evaluation.md] \
 *     [--json <path>]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  MECHANIC_FAMILIES,
  resolveMechanicFamily,
  type MechanicFamily,
} from "./synthetic-player-harness.js";

const SCRIPT = "scripts/evaluate-system-one-production-path.ts";

// -------------------------------------------------------------------------------------------------
// Vocabulary: the production lane, the canonical families, and family resolution
// -------------------------------------------------------------------------------------------------

/** The lane whose decisions this evaluator reads. */
export const PRODUCTION_LANE = "adventure-selection" as const;
/** The row a kind with no canonical mapping counts in. */
export const PRODUCTION_FAMILY_UNKNOWN = "unknown" as const;
/** Every row a per-family table can show: the harness's 11 families, then `unknown` last. */
export type ProductionFamilyKey = MechanicFamily | typeof PRODUCTION_FAMILY_UNKNOWN;
/** The canonical row order used by every per-family table, aggregate included. */
export const PRODUCTION_FAMILY_ORDER: readonly ProductionFamilyKey[] = [
  ...MECHANIC_FAMILIES,
  PRODUCTION_FAMILY_UNKNOWN,
];

/**
 * The production action-kind vocabularies that are not candidate kinds.
 * `adventure_exact_action_*_v56` uses the hyphenated v56 kinds, and lane-origin SRD checks are
 * recorded in `adventure_check_executions_v54` under the bare `check` kind.
 */
export const PRODUCTION_ACTION_KIND_FAMILIES: Readonly<Record<string, MechanicFamily>> = Object.freeze({
  check: "srd-check",
  power: "power",
  rest: "rest",
  "combat-consumable": "combat-consumable",
  "combat-power": "combat-power",
  "quest-accept": "quest-lifecycle",
  "quest-abandon": "quest-lifecycle",
  "quest-reward": "quest-lifecycle",
  progression: "progression",
});

/**
 * Resolves one production candidate kind or action kind to a canonical family, or null.
 * Candidate kinds go through the harness mapper (`KIND_TO_FAMILY`); the v56/v54 action kinds go
 * through the table above.
 */
export function familyForProductionKind(kind: string | null | undefined): MechanicFamily | null {
  if (typeof kind !== "string" || kind.trim() === "") return null;
  return resolveMechanicFamily(kind) ?? PRODUCTION_ACTION_KIND_FAMILIES[kind] ?? null;
}

/** The family row a kind counts in: the canonical family, or `unknown` when nothing maps. */
export function familyKeyForProductionKind(kind: string | null | undefined): ProductionFamilyKey {
  return familyForProductionKind(kind) ?? PRODUCTION_FAMILY_UNKNOWN;
}

/** How the report describes the family resolution; shared by the markdown and JSON sidecar. */
export const PRODUCTION_FAMILY_SOURCE =
  "candidate kinds through `resolveMechanicFamily` (`MECHANIC_FAMILIES` / `KIND_TO_FAMILY` in"
  + " scripts/synthetic-player-harness.ts); v56 action kinds and the v54 `check` kind through"
  + " `PRODUCTION_ACTION_KIND_FAMILIES`; anything unresolved is reported as `unknown`";

// -------------------------------------------------------------------------------------------------
// Tolerant parsers for the two JSON documents a decision carries
// -------------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One candidate the production orchestrator advertised to the lane for a turn. */
export interface ProductionCandidate {
  candidateId: string;
  kind: string | null;
  label: string | null;
}

export interface ParsedDecisionState {
  /** The declaration embedded in the state half, when present (a fallback for an unjoined turn). */
  declaration: string | null;
  candidates: ProductionCandidate[];
  /** True when `state_json` was not a JSON object; candidates are then empty. */
  malformed: boolean;
  /** Candidate entries skipped because they carry no string `candidateId`. */
  skippedCandidates: number;
}

/** Tolerant parse of one decision's `state_json`; a malformed document never throws. */
export function parseDecisionState(stateJson: string | null): ParsedDecisionState {
  const empty: ParsedDecisionState = { declaration: null, candidates: [], malformed: false, skippedCandidates: 0 };
  if (stateJson === null || stateJson.trim() === "") return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stateJson) as unknown;
  } catch {
    return { ...empty, malformed: true };
  }
  if (!isRecord(parsed)) return { ...empty, malformed: true };
  const declaration = asString(parsed["declaration"]);
  const rawCandidates = parsed["candidates"];
  const candidates: ProductionCandidate[] = [];
  let skippedCandidates = 0;
  if (Array.isArray(rawCandidates)) {
    for (const raw of rawCandidates) {
      if (!isRecord(raw)) {
        skippedCandidates += 1;
        continue;
      }
      const candidateId = asString(raw["candidateId"]);
      if (candidateId === null || candidateId === "") {
        skippedCandidates += 1;
        continue;
      }
      candidates.push({
        candidateId,
        kind: asString(raw["kind"]),
        label: asString(raw["label"]),
      });
    }
  }
  return { declaration, candidates, malformed: false, skippedCandidates };
}

export interface ParsedProductionSelection {
  method: string | null;
  candidateId: string | null;
  topSignal: number | null;
  /** True when `selection_json` was not a JSON object; the row then carries no pick. */
  malformed: boolean;
}

/**
 * Tolerant parse of one decision's `selection_json`, mirroring the audit script's
 * `parseLaneSelection` semantics for `method` and `selection.candidateId` and adding `topSignal`.
 */
export function parseProductionSelection(selectionJson: string | null): ParsedProductionSelection {
  const empty: ParsedProductionSelection = { method: null, candidateId: null, topSignal: null, malformed: false };
  if (selectionJson === null || selectionJson.trim() === "") return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(selectionJson) as unknown;
  } catch {
    return { ...empty, malformed: true };
  }
  if (!isRecord(parsed)) return { ...empty, malformed: true };
  const method = asString(parsed["method"]);
  let candidateId: string | null = null;
  const selection = parsed["selection"];
  if (isRecord(selection)) {
    const raw = asString(selection["candidateId"]);
    if (raw !== null && raw !== "") candidateId = raw;
  }
  return {
    method,
    candidateId,
    topSignal: asNumber(parsed["topSignal"]),
    malformed: false,
  };
}

// -------------------------------------------------------------------------------------------------
// Normalized decision rows
// -------------------------------------------------------------------------------------------------

export type ProductionBand = "act" | "confirm" | "fallback" | "unknown";
export type PickResolution = "shortlist-kind" | "unmapped-kind" | "missing-from-shortlist";

/** The candidate a lane decision named, resolved to a family row. */
export interface ProductionPick {
  candidateId: string;
  family: ProductionFamilyKey;
  resolution: PickResolution;
  /** The candidate's kind when the shortlist carried it, else null. */
  kind: string | null;
}

/** One normalized `system_one_decisions_v1` adventure-selection row plus its turn join. */
export interface ProductionDecision {
  world: string;
  decisionId: string;
  turnId: string | null;
  band: ProductionBand;
  method: string | null;
  /** The lane's named candidate (method `choice`), else null. */
  candidateId: string | null;
  /** Signal statistics use this and only this pick, the same candidate `candidateId` names. */
  topSignal: number | null;
  shadow: boolean;
  fallbackUsed: boolean;
  createdAt: string;
  declaration: string | null;
  turnJoined: boolean;
  turnState: string | null;
  turnMode: string | null;
  candidates: ProductionCandidate[];
  /** Distinct shortlisted families in canonical order; `unknown` last when present. */
  families: ProductionFamilyKey[];
  /** Present exactly when `method === "choice"` and a candidate id was recorded. */
  pick: ProductionPick | null;
  stateMalformed: boolean;
  selectionMalformed: boolean;
  skippedCandidates: number;
}

/** One raw decision row before normalization; the DB reader and tests both build this. */
export interface DecisionSourceRow {
  decisionId: string;
  turnId: string | null;
  band: string | null;
  selectionJson: string | null;
  stateJson: string | null;
  shadow: boolean;
  fallbackUsed: boolean;
  createdAt: string;
}

/** The `adventure_turns` fields the report joins; null when the turn row is absent. */
export interface TurnSourceRow {
  declaration: string | null;
  state: string | null;
  mode: string | null;
}

function normalizeBand(value: string | null): ProductionBand {
  return value === "act" || value === "confirm" || value === "fallback" ? value : "unknown";
}

function distinctFamilies(candidates: readonly ProductionCandidate[]): ProductionFamilyKey[] {
  const present = new Set<ProductionFamilyKey>();
  for (const candidate of candidates) present.add(familyKeyForProductionKind(candidate.kind));
  return PRODUCTION_FAMILY_ORDER.filter((family) => present.has(family));
}

/** Pure normalization of one decision row plus its optional turn join. */
export function toProductionDecision(
  world: string,
  row: DecisionSourceRow,
  turn: TurnSourceRow | null,
): ProductionDecision {
  const state = parseDecisionState(row.stateJson);
  const selection = parseProductionSelection(row.selectionJson);
  const candidateId = selection.method === "choice" ? selection.candidateId : null;
  let pick: ProductionPick | null = null;
  if (candidateId !== null) {
    const candidate = state.candidates.find((entry) => entry.candidateId === candidateId) ?? null;
    if (candidate === null) {
      pick = { candidateId, family: PRODUCTION_FAMILY_UNKNOWN, resolution: "missing-from-shortlist", kind: null };
    } else {
      const family = familyKeyForProductionKind(candidate.kind);
      pick = {
        candidateId,
        family,
        resolution: family === PRODUCTION_FAMILY_UNKNOWN ? "unmapped-kind" : "shortlist-kind",
        kind: candidate.kind,
      };
    }
  }
  return {
    world,
    decisionId: row.decisionId,
    turnId: row.turnId,
    band: normalizeBand(row.band),
    method: selection.method,
    candidateId,
    topSignal: selection.topSignal,
    shadow: row.shadow,
    fallbackUsed: row.fallbackUsed,
    createdAt: row.createdAt,
    declaration: turn?.declaration ?? state.declaration,
    turnJoined: turn !== null,
    turnState: turn?.state ?? null,
    turnMode: turn?.mode ?? null,
    candidates: state.candidates,
    families: distinctFamilies(state.candidates),
    pick,
    stateMalformed: state.malformed,
    selectionMalformed: selection.malformed,
    skippedCandidates: state.skippedCandidates,
  };
}

// -------------------------------------------------------------------------------------------------
// Lane-origin evidence: proposals, executions, and provider candidate calls
// -------------------------------------------------------------------------------------------------

export type LaneExecutionSource = "exact-action" | "check";

export interface LaneExecution {
  world: string;
  turnId: string | null;
  decisionId: string | null;
  actionKind: string | null;
  candidateId: string | null;
  source: LaneExecutionSource;
  family: ProductionFamilyKey;
  commandId: string | null;
  occurredAt: string | null;
}

export interface RawLaneExecution {
  turnId: string | null;
  decisionId: string | null;
  actionKind: string | null;
  candidateId: string | null;
  commandId: string | null;
  occurredAt: string | null;
}

/** Pure normalization of one lane-origin execution row (`v56` exact action or `v54` check). */
export function toLaneExecution(world: string, source: LaneExecutionSource, row: RawLaneExecution): LaneExecution {
  return {
    world,
    turnId: row.turnId,
    decisionId: row.decisionId,
    actionKind: row.actionKind,
    candidateId: row.candidateId,
    source,
    family: familyKeyForProductionKind(row.actionKind),
    commandId: row.commandId,
    occurredAt: row.occurredAt,
  };
}

export interface LaneProposal {
  world: string;
  proposalId: string;
  turnId: string | null;
  decisionId: string | null;
  actionKind: string | null;
  candidateId: string | null;
  family: ProductionFamilyKey;
  /** From the joined `tool_proposals` row; null when the join found no proposal. */
  requiresConfirmation: boolean | null;
  toolName: string | null;
  /** `confirmation_decisions.decision`, or null when no decision is recorded yet. */
  confirmation: string | null;
  /** A v56 execution exists for this proposal. */
  executed: boolean;
  boundAt: string | null;
}

export interface RawLaneProposal {
  proposalId: string;
  turnId: string | null;
  decisionId: string | null;
  actionKind: string | null;
  candidateId: string | null;
  requiresConfirmation: boolean | null;
  toolName: string | null;
  confirmation: string | null;
  executed: boolean;
  boundAt: string | null;
}

/** Pure normalization of one lane-origin proposal binding plus its proposal/confirmation join. */
export function toLaneProposal(world: string, row: RawLaneProposal): LaneProposal {
  return {
    world,
    proposalId: row.proposalId,
    turnId: row.turnId,
    decisionId: row.decisionId,
    actionKind: row.actionKind,
    candidateId: row.candidateId,
    family: familyKeyForProductionKind(row.actionKind),
    requiresConfirmation: row.requiresConfirmation,
    toolName: row.toolName,
    confirmation: row.confirmation,
    executed: row.executed,
    boundAt: row.boundAt,
  };
}

/** The provider surfaces a candidate-naming call can come from, in comparison precedence order. */
export const PROVIDER_PICK_SOURCES = [
  "tool-call",
  "decision-round",
  "provider-response",
  "provider-binding",
] as const;
export type ProviderPickSource = (typeof PROVIDER_PICK_SOURCES)[number];

export interface ProviderCandidateCall {
  turnId: string;
  candidateId: string;
  toolName: string | null;
  source: ProviderPickSource;
  /** Position within its source, so ties keep recorded order. */
  order: number;
  /** The v56 action kind when the call is a provider-origin binding without a tool name. */
  actionKind?: string | null;
}

export interface ProviderCandidatePick {
  world: string;
  turnId: string;
  candidateId: string;
  toolName: string | null;
  family: ProductionFamilyKey;
  source: ProviderPickSource;
  /** Additional candidate-naming calls on the same turn beyond the first; counted, not dropped. */
  additionalCalls: number;
}

function providerSourceRank(source: ProviderPickSource): number {
  return PROVIDER_PICK_SOURCES.indexOf(source);
}

/**
 * One provider pick per turn: the first candidate-naming call in source precedence order
 * (`tool-call` > `decision-round` > `provider-response` > `provider-binding`) and recorded order
 * within a source. Later calls are counted in `additionalCalls`.
 */
export function buildProviderPicks(world: string, calls: readonly ProviderCandidateCall[]): ProviderCandidatePick[] {
  const ordered = [...calls].sort((left, right) =>
    left.turnId.localeCompare(right.turnId)
    || providerSourceRank(left.source) - providerSourceRank(right.source)
    || left.order - right.order);
  const byTurn = new Map<string, ProviderCandidateCall[]>();
  for (const call of ordered) {
    const list = byTurn.get(call.turnId) ?? [];
    list.push(call);
    byTurn.set(call.turnId, list);
  }
  const picks: ProviderCandidatePick[] = [];
  for (const turnId of [...byTurn.keys()].sort()) {
    const [first, ...rest] = byTurn.get(turnId)!;
    if (first === undefined) continue;
    picks.push({
      world,
      turnId,
      candidateId: first.candidateId,
      toolName: first.toolName,
      family: familyKeyForProductionKind(first.toolName ?? first.actionKind ?? null),
      source: first.source,
      additionalCalls: rest.length,
    });
  }
  return picks;
}

// -------------------------------------------------------------------------------------------------
// Pick commit classification and provider alignment
// -------------------------------------------------------------------------------------------------

export type PickCommitClass = "committed" | "advisory-act" | "awaiting-confirm" | "other-uncommitted";

/**
 * Classifies one lane pick against the lane-origin executions. An execution commits the pick when
 * it is attached to the pick's decision id and either matches the pick's resolved family (and that
 * family is known) or names the same candidate id. Then:
 * - `committed` — such an execution exists;
 * - `advisory-act` — none exists and the recorded band is `act`;
 * - `awaiting-confirm` — none exists and the recorded band is `confirm`;
 * - `other-uncommitted` — none exists and the band is anything else.
 * Returns null when the decision named no candidate.
 */
export function classifyPickCommit(
  decision: ProductionDecision,
  executions: readonly LaneExecution[],
): PickCommitClass | null {
  if (decision.pick === null) return null;
  const committed = executions.some((execution) => {
    if (execution.decisionId !== decision.decisionId) return false;
    if (execution.family === decision.pick!.family && decision.pick!.family !== PRODUCTION_FAMILY_UNKNOWN) return true;
    return execution.candidateId !== null && execution.candidateId === decision.pick!.candidateId;
  });
  if (committed) return "committed";
  if (decision.band === "act") return "advisory-act";
  if (decision.band === "confirm") return "awaiting-confirm";
  return "other-uncommitted";
}

export type AlignmentRelation = "same-id" | "same-family" | "divergent" | "unknown-family";

/** One comparable (lane pick, provider pick) pair. Only turns with both sides appear. */
export interface ProductionAlignmentPair {
  world: string;
  turnId: string | null;
  decisionId: string;
  laneCandidateId: string;
  laneFamily: ProductionFamilyKey;
  providerCandidateId: string;
  providerFamily: ProductionFamilyKey;
  providerToolName: string | null;
  providerSource: ProviderPickSource;
  relation: AlignmentRelation;
}

/**
 * The alignment comparison, stated precisely: for every decision that named a candidate
 * (`method=choice`) whose turn also has a provider candidate pick, compare the two candidate ids.
 * `same-id` when the ids are equal; otherwise, when both sides resolve to a known family,
 * `same-family` when those families are equal and `divergent` when they differ; `unknown-family`
 * when either side cannot be resolved to a canonical family. Decisions whose turn has no provider
 * candidate call are omitted, and no provider pick is invented for them.
 */
export function computeAlignmentPairs(
  decisions: readonly ProductionDecision[],
  providerPicks: readonly ProviderCandidatePick[],
): ProductionAlignmentPair[] {
  const providerByTurn = new Map(providerPicks.map((pick): [string, ProviderCandidatePick] => [pick.turnId, pick]));
  const pairs: ProductionAlignmentPair[] = [];
  for (const decision of decisions) {
    if (decision.pick === null || decision.turnId === null) continue;
    const provider = providerByTurn.get(decision.turnId);
    if (provider === undefined) continue;
    const laneFamily = decision.pick.family;
    const providerFamily = provider.family;
    let relation: AlignmentRelation;
    if (decision.pick.candidateId === provider.candidateId) {
      relation = "same-id";
    } else if (laneFamily === PRODUCTION_FAMILY_UNKNOWN || providerFamily === PRODUCTION_FAMILY_UNKNOWN) {
      relation = "unknown-family";
    } else if (laneFamily === providerFamily) {
      relation = "same-family";
    } else {
      relation = "divergent";
    }
    pairs.push({
      world: decision.world,
      turnId: decision.turnId,
      decisionId: decision.decisionId,
      laneCandidateId: decision.pick.candidateId,
      laneFamily,
      providerCandidateId: provider.candidateId,
      providerFamily,
      providerToolName: provider.toolName,
      providerSource: provider.source,
      relation,
    });
  }
  return pairs;
}

export interface AlignmentCounts {
  compared: number;
  sameId: number;
  sameFamily: number;
  divergent: number;
  unknownFamily: number;
}

const emptyAlignmentCounts = (): AlignmentCounts => ({
  compared: 0,
  sameId: 0,
  sameFamily: 0,
  divergent: 0,
  unknownFamily: 0,
});

/** Counts the alignment pairs by relation. Rates are derived at render time, never here. */
export function countAlignment(pairs: readonly ProductionAlignmentPair[]): AlignmentCounts {
  const counts = emptyAlignmentCounts();
  counts.compared = pairs.length;
  for (const pair of pairs) {
    if (pair.relation === "same-id") counts.sameId += 1;
    else if (pair.relation === "same-family") counts.sameFamily += 1;
    else if (pair.relation === "divergent") counts.divergent += 1;
    else counts.unknownFamily += 1;
  }
  return counts;
}

export interface ConfirmationCounts {
  approved: number;
  rejected: number;
  pending: number;
  /** A recorded decision value outside approved/rejected. */
  other: number;
  /** A lane proposal whose proposal row (or confirmation flag) was not found. */
  unknown: number;
  /** No confirmation was required. */
  notRequired: number;
  /** Approved proposals with no execution recorded. */
  approvedNotExecuted: number;
  executed: number;
}

const emptyConfirmationCounts = (): ConfirmationCounts => ({
  approved: 0,
  rejected: 0,
  pending: 0,
  other: 0,
  unknown: 0,
  notRequired: 0,
  approvedNotExecuted: 0,
  executed: 0,
});

/**
 * Confirmation outcomes for lane proposals: an `approved`/`rejected` decision value replies to the
 * proposal; no recorded decision is `pending`; a proposal that needs no confirmation is
 * `notRequired`; a missing proposal join is `unknown`.
 */
export function countConfirmations(proposals: readonly LaneProposal[]): ConfirmationCounts {
  const counts = emptyConfirmationCounts();
  for (const proposal of proposals) {
    if (proposal.executed) counts.executed += 1;
    if (proposal.requiresConfirmation === null) counts.unknown += 1;
    else if (!proposal.requiresConfirmation) counts.notRequired += 1;
    else if (proposal.confirmation === "approved") {
      counts.approved += 1;
      if (!proposal.executed) counts.approvedNotExecuted += 1;
    } else if (proposal.confirmation === "rejected") counts.rejected += 1;
    else if (proposal.confirmation === null) counts.pending += 1;
    else counts.other += 1;
  }
  return counts;
}

// -------------------------------------------------------------------------------------------------
// Per-family and per-world aggregation
// -------------------------------------------------------------------------------------------------

export interface FamilyProductionRow {
  family: ProductionFamilyKey;
  /** Every decision in the scope; the reach denominator, shared by every family row. */
  decisionsTotal: number;
  /** Decisions whose shortlist advertised this family (reach numerator). */
  advertised: number;
  /** advertised / total decisions; 0 when the world has no decisions. */
  reachRate: number;
  act: number;
  confirm: number;
  fallback: number;
  unknownBand: number;
  /** Advertised decisions whose method is `defer`. */
  defer: number;
  deferRate: number;
  /** Decisions whose named pick (method `choice`) resolved to this family. */
  picks: number;
  signalMean: number | null;
  signalMedian: number | null;
  committed: number;
  advisoryAct: number;
  awaitingConfirm: number;
  otherUncommitted: number;
  laneProposals: number;
  laneExecutions: number;
  confirmations: ConfirmationCounts;
  alignment: AlignmentCounts;
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export interface FamilyMetricsInput {
  decisions: readonly ProductionDecision[];
  laneExecutions: readonly LaneExecution[];
  laneProposals: readonly LaneProposal[];
  alignmentPairs: readonly ProductionAlignmentPair[];
}

/**
 * The per-family table: for every `PRODUCTION_FAMILY_ORDER` row (zeros included) reach and band
 * distribution over the decisions whose shortlist advertised the family, pick signal statistics
 * and commit classification for the decisions that named a candidate of the family, lane-origin
 * proposal/execution counts, confirmation outcomes of those proposals, and alignment counts for
 * pairs whose lane pick resolved to the family.
 */
export function summarizeFamilyMetrics(input: FamilyMetricsInput): FamilyProductionRow[] {
  const total = input.decisions.length;
  return PRODUCTION_FAMILY_ORDER.map((family): FamilyProductionRow => {
    const advertisedDecisions = input.decisions.filter((decision) => decision.families.includes(family));
    const bands = { act: 0, confirm: 0, fallback: 0, unknown: 0 };
    let defer = 0;
    for (const decision of advertisedDecisions) {
      bands[decision.band] += 1;
      if (decision.method === "defer") defer += 1;
    }
    const picks = input.decisions.filter((decision) => decision.pick !== null && decision.pick.family === family);
    const signals = picks.flatMap((decision) => (decision.topSignal === null ? [] : [decision.topSignal]));
    const commits = picks.map((decision) => classifyPickCommit(decision, input.laneExecutions));
    const proposals = input.laneProposals.filter((proposal) => proposal.family === family);
    const executions = input.laneExecutions.filter((execution) => execution.family === family);
    const pairs = input.alignmentPairs.filter((pair) => pair.laneFamily === family);
    return {
      family,
      decisionsTotal: total,
      advertised: advertisedDecisions.length,
      reachRate: total === 0 ? 0 : advertisedDecisions.length / total,
      act: bands.act,
      confirm: bands.confirm,
      fallback: bands.fallback,
      unknownBand: bands.unknown,
      defer,
      deferRate: advertisedDecisions.length === 0 ? 0 : defer / advertisedDecisions.length,
      picks: picks.length,
      signalMean: meanOf(signals),
      signalMedian: medianOf(signals),
      committed: commits.filter((value) => value === "committed").length,
      advisoryAct: commits.filter((value) => value === "advisory-act").length,
      awaitingConfirm: commits.filter((value) => value === "awaiting-confirm").length,
      otherUncommitted: commits.filter((value) => value === "other-uncommitted").length,
      laneProposals: proposals.length,
      laneExecutions: executions.length,
      confirmations: countConfirmations(proposals),
      alignment: countAlignment(pairs),
    };
  });
}

export interface ProductionPathTotals {
  decisions: number;
  shadowDecisions: number;
  decisionsWithCandidates: number;
  decisionsWithoutCandidates: number;
  decisionsWithUnjoinedTurns: number;
  distinctTurns: number;
  multiDecisionTurns: number;
  malformedStateRows: number;
  malformedSelectionRows: number;
  skippedCandidateEntries: number;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
  picks: number;
  picksUnknownFamily: number;
  picksMissingFromShortlist: number;
  laneProposals: number;
  laneExecutions: number;
  /** Lane proposals whose candidate id differs from the decision's named pick. */
  proposalCandidateMismatches: number;
  /** Lane executions whose candidate id differs from the decision's named pick. */
  executionCandidateMismatches: number;
  providerPickTurns: number;
  providerExtraCalls: number;
  alignment: AlignmentCounts;
  confirmations: ConfirmationCounts;
}

export interface ProductionPathSummary {
  world: string;
  databasePath: string | null;
  totals: ProductionPathTotals;
  families: FamilyProductionRow[];
}

function countMismatches(
  decisions: readonly ProductionDecision[],
  items: readonly { decisionId: string | null; candidateId: string | null }[],
): number {
  const decisionById = new Map(decisions.map((decision): [string, ProductionDecision] => [decision.decisionId, decision]));
  let mismatches = 0;
  for (const item of items) {
    if (item.decisionId === null || item.candidateId === null) continue;
    const decision = decisionById.get(item.decisionId);
    if (decision === undefined || decision.pick === null) continue;
    if (decision.pick.candidateId !== item.candidateId) mismatches += 1;
  }
  return mismatches;
}

/**
 * Aggregates one scope (one world, or the concatenation of several for the report's aggregate
 * section). Every decision contributes to exactly one scope; rates are recomputed over the scope
 * rather than averaged across worlds.
 */
export function summarizeProductionPath(input: {
  world: string;
  databasePath?: string | null;
  decisions: readonly ProductionDecision[];
  laneExecutions: readonly LaneExecution[];
  laneProposals: readonly LaneProposal[];
  providerPicks: readonly ProviderCandidatePick[];
}): ProductionPathSummary {
  const decisions = input.decisions;
  const turns = new Map<string, number>();
  for (const decision of decisions) {
    if (decision.turnId !== null) turns.set(decision.turnId, (turns.get(decision.turnId) ?? 0) + 1);
  }
  const timestamps = decisions.map((decision) => decision.createdAt).filter((value) => value !== "");
  const alignmentPairs = computeAlignmentPairs(decisions, input.providerPicks);
  return {
    world: input.world,
    databasePath: input.databasePath ?? null,
    totals: {
      decisions: decisions.length,
      shadowDecisions: decisions.filter((decision) => decision.shadow).length,
      decisionsWithCandidates: decisions.filter((decision) => decision.candidates.length > 0).length,
      decisionsWithoutCandidates: decisions.filter((decision) => decision.candidates.length === 0).length,
      decisionsWithUnjoinedTurns: decisions.filter((decision) => !decision.turnJoined).length,
      distinctTurns: turns.size,
      multiDecisionTurns: [...turns.values()].filter((count) => count > 1).length,
      malformedStateRows: decisions.filter((decision) => decision.stateMalformed).length,
      malformedSelectionRows: decisions.filter((decision) => decision.selectionMalformed).length,
      skippedCandidateEntries: decisions.reduce((total, decision) => total + decision.skippedCandidates, 0),
      firstRecordedAt: timestamps.length === 0 ? null : [...timestamps].sort()[0]!,
      lastRecordedAt: timestamps.length === 0 ? null : [...timestamps].sort().at(-1)!,
      picks: decisions.filter((decision) => decision.pick !== null).length,
      picksUnknownFamily: decisions.filter(
        (decision) => decision.pick !== null && decision.pick.family === PRODUCTION_FAMILY_UNKNOWN,
      ).length,
      picksMissingFromShortlist: decisions.filter(
        (decision) => decision.pick !== null && decision.pick.resolution === "missing-from-shortlist",
      ).length,
      laneProposals: input.laneProposals.length,
      laneExecutions: input.laneExecutions.length,
      proposalCandidateMismatches: countMismatches(decisions, input.laneProposals),
      executionCandidateMismatches: countMismatches(decisions, input.laneExecutions),
      providerPickTurns: input.providerPicks.length,
      providerExtraCalls: input.providerPicks.reduce((total, pick) => total + pick.additionalCalls, 0),
      alignment: countAlignment(alignmentPairs),
      confirmations: countConfirmations(input.laneProposals),
    },
    families: summarizeFamilyMetrics({
      decisions,
      laneExecutions: input.laneExecutions,
      laneProposals: input.laneProposals,
      alignmentPairs,
    }),
  };
}

const ANOMALY_LIST_LIMIT = 20;

function boundedList(values: readonly string[]): string {
  if (values.length <= ANOMALY_LIST_LIMIT) return values.join(", ");
  return `${values.slice(0, ANOMALY_LIST_LIMIT).join(", ")} (+${values.length - ANOMALY_LIST_LIMIT} more)`;
}

/**
 * Data-integrity signals worth surfacing beside the tables: rows that could not be joined or
 * resolved, unresolved kinds, and lane evidence that disagrees with the decision's own pick.
 * Deterministic order, bounded lists.
 */
export function productionAnomalies(input: {
  decisions: readonly ProductionDecision[];
  laneExecutions: readonly LaneExecution[];
  laneProposals: readonly LaneProposal[];
  providerPicks: readonly ProviderCandidatePick[];
}): string[] {
  const anomalies: string[] = [];
  const unjoined = input.decisions.filter((decision) => !decision.turnJoined).map((decision) => decision.decisionId);
  if (unjoined.length > 0) anomalies.push(`${unjoined.length} decision(s) have no joined adventure_turns row: ${boundedList(unjoined)}`);
  const malformedState = input.decisions.filter((decision) => decision.stateMalformed).map((decision) => decision.decisionId);
  if (malformedState.length > 0) anomalies.push(`${malformedState.length} decision(s) have a malformed state_json: ${boundedList(malformedState)}`);
  const malformedSelection = input.decisions.filter(
    (decision) => decision.selectionMalformed,
  ).map((decision) => decision.decisionId);
  if (malformedSelection.length > 0) {
    anomalies.push(`${malformedSelection.length} decision(s) have a malformed selection_json: ${boundedList(malformedSelection)}`);
  }
  const missingPicks = input.decisions.filter(
    (decision) => decision.pick !== null && decision.pick.resolution === "missing-from-shortlist",
  ).map((decision) => `${decision.decisionId}:${decision.pick!.candidateId}`);
  if (missingPicks.length > 0) {
    anomalies.push(`${missingPicks.length} pick(s) named a candidate that the shortlist did not advertise: ${boundedList(missingPicks)}`);
  }
  const unmapped = [...new Set(input.decisions.flatMap((decision) =>
    decision.pick !== null && decision.pick.resolution === "unmapped-kind" && decision.pick.kind !== null
      ? [decision.pick.kind]
      : []))];
  if (unmapped.length > 0) anomalies.push(`pick kind(s) with no canonical family: ${boundedList(unmapped)}`);
  const decisionById = new Map(input.decisions.map((decision): [string, ProductionDecision] => [decision.decisionId, decision]));
  const proposalMismatches: string[] = [];
  for (const proposal of input.laneProposals) {
    if (proposal.decisionId === null || proposal.candidateId === null) continue;
    const decision = decisionById.get(proposal.decisionId);
    if (decision === undefined || decision.pick === null) continue;
    if (decision.pick.candidateId !== proposal.candidateId) proposalMismatches.push(proposal.proposalId);
  }
  if (proposalMismatches.length > 0) {
    anomalies.push(`${proposalMismatches.length} lane proposal(s) name a candidate other than the decision's pick: ${boundedList(proposalMismatches)}`);
  }
  const executionMismatches: string[] = [];
  for (const execution of input.laneExecutions) {
    if (execution.decisionId === null || execution.candidateId === null) continue;
    const decision = decisionById.get(execution.decisionId);
    if (decision === undefined || decision.pick === null) continue;
    if (decision.pick.candidateId !== execution.candidateId) {
      executionMismatches.push(execution.commandId ?? execution.decisionId);
    }
  }
  if (executionMismatches.length > 0) {
    anomalies.push(`${executionMismatches.length} lane execution(s) name a candidate other than the decision's pick: ${boundedList(executionMismatches)}`);
  }
  const unknownProvider = input.providerPicks.filter((pick) => pick.family === PRODUCTION_FAMILY_UNKNOWN);
  if (unknownProvider.length > 0) {
    anomalies.push(`${unknownProvider.length} provider pick turn(s) have a candidate id with no canonical family: ${boundedList(unknownProvider.map((pick) => pick.turnId))}`);
  }
  return anomalies;
}

// -------------------------------------------------------------------------------------------------
// Report documents and rendering
// -------------------------------------------------------------------------------------------------

export interface ProductionWorldDataset {
  world: string;
  databasePath: string;
  decisions: ProductionDecision[];
  laneExecutions: LaneExecution[];
  laneProposals: LaneProposal[];
  providerPicks: ProviderCandidatePick[];
  /** Database-tolerance notices ("table X is absent; treating it as empty"). */
  notices: string[];
}

export interface ProductionPathWorldReport {
  summary: ProductionPathSummary;
  notices: string[];
  anomalies: string[];
  alignmentPairs: ProductionAlignmentPair[];
}

export interface ProductionPathReport {
  version: 1;
  generatedAt: string;
  script: string;
  familySource: string;
  definitions: readonly string[];
  honestyNotes: readonly string[];
  aggregate: ProductionPathSummary;
  aggregateAnomalies: string[];
  worlds: ProductionPathWorldReport[];
}

/** The precise measurement definitions the report carries so every table is self-describing. */
export const PRODUCTION_PATH_DEFINITIONS: readonly string[] = Object.freeze([
  "**Decision** — one `system_one_decisions_v1` row with `lane='adventure-selection'`; `state_json.candidates` is the production shortlist the live orchestrator built for that turn, and `selection_json` is the lane's composition (band, method, pick, top signal).",
  "**Reach** — a decision's shortlist advertised a family when at least one advertised candidate kind resolves to that family. The reach denominator is every decision; the numerator is decisions that advertised the family.",
  "**Defer rate** — among the decisions that advertised a family, the share whose `selection_json.method` is `defer`. Bands (`act` / `confirm` / `fallback`) are counted as recorded, not as deferrals.",
  "**Pick** — a decision with `method='choice'` and a recorded `selection.candidateId`; the pick's family is the family of that exact candidate in the decision's own shortlist. A pick whose candidate is absent from the shortlist, or whose kind has no canonical mapping, is counted as `unknown`.",
  "**Committed** — the pick's decision id carries a lane-origin execution (`adventure_exact_action_executions_v56` or `adventure_check_executions_v54`, both `origin='lane'`) whose family matches the pick's resolved family or which names the same candidate id. **Advisory act** — no such execution and band `act`. **Awaiting confirm** — no such execution and band `confirm`.",
  "**Provider alignment** — for every decision that named a candidate whose turn also has a provider candidate pick, the two candidate ids are compared: `same-id` when equal, otherwise `same-family` when both resolve to the same canonical family, `divergent` when both resolve and differ, `unknown-family` when either cannot be resolved. Provider picks come from the first candidate-naming provider call per turn (see the source note below). Decisions whose turn has no provider candidate call are omitted, never counted as agreement.",
  "**Lane proposal / execution** — lane-origin rows in the v56 proposal-binding and execution tables (plus lane-origin v54 check executions) attached to a decision id. **Confirmation outcome** — the joined `confirmation_decisions.decision` for the lane proposal's `tool_proposals` row: `approved`, `rejected`, `pending` when no decision is recorded yet, `notRequired` when the proposal needs no confirmation, `unknown` when the proposal join is missing.",
]);

/** The honesty notes every production-path report must carry. */
export const PRODUCTION_PATH_HONESTY_NOTES: readonly string[] = Object.freeze([
  "Production evidence has **no correctness labels**: these are reach, decisiveness, commit, alignment, and confirmation measures, not accuracy.",
  "The worlds were **recorded under the production (legacy) payload across code versions**; record shapes, candidate construction, and lane policy can differ between worlds. Missing tables or columns are treated as empty and reported in notices.",
  "Samples are **small and uneven** across worlds; a rate over a handful of decisions is descriptive only. Counts are reported beside every rate.",
  "**Provider agreement is not ground truth**: the provider and the lane both acted live, agreement measures consistency rather than correctness, and the provider may have used context the lane did not have.",
  "**Shadow / record-only** — `shadow=1` decisions are record-only: the lane never selected, ordered, or committed anything on its own. Check the per-world `Shadow decisions` total; in the worlds evaluated here every decision was shadow.",
]);

export const PRODUCTION_PATH_PROVIDER_SOURCE_NOTE =
  "Provider picks are read from the recorded provider surfaces per turn, in precedence order:"
  + " `agent_tool_calls_v38.arguments_json.candidateId`, `agent_decision_rounds_v38.response_json.calls[].arguments.candidateId`,"
  + " `agent_provider_responses_v39.response_json.calls[].arguments.candidateId`, then provider-origin"
  + " `adventure_exact_action_proposal_bindings_v56.candidate_id`. The first candidate-naming call is the pick;"
  + " extra calls on the same turn are counted (`providerExtraCalls`), never dropped. In the worlds inspected so far"
  + " only the v39 response documents carry candidate selections; the v38 surfaces are read first as specified and are"
  + " empty there.";

function buildWorldReport(dataset: ProductionWorldDataset): ProductionPathWorldReport {
  return {
    summary: summarizeProductionPath({
      world: dataset.world,
      databasePath: dataset.databasePath,
      decisions: dataset.decisions,
      laneExecutions: dataset.laneExecutions,
      laneProposals: dataset.laneProposals,
      providerPicks: dataset.providerPicks,
    }),
    anomalies: productionAnomalies({
      decisions: dataset.decisions,
      laneExecutions: dataset.laneExecutions,
      laneProposals: dataset.laneProposals,
      providerPicks: dataset.providerPicks,
    }),
    notices: [...dataset.notices],
    alignmentPairs: computeAlignmentPairs(dataset.decisions, dataset.providerPicks),
  };
}

/** Builds the report document from the loaded worlds. The aggregate is recomputed over their union. */
export function buildProductionPathReport(input: {
  worlds: readonly ProductionWorldDataset[];
  generatedAt: string;
}): ProductionPathReport {
  const decisions = input.worlds.flatMap((world) => world.decisions);
  const laneExecutions = input.worlds.flatMap((world) => world.laneExecutions);
  const laneProposals = input.worlds.flatMap((world) => world.laneProposals);
  const providerPicks = input.worlds.flatMap((world) => world.providerPicks);
  return {
    version: 1,
    generatedAt: input.generatedAt,
    script: SCRIPT,
    familySource: PRODUCTION_FAMILY_SOURCE,
    definitions: PRODUCTION_PATH_DEFINITIONS,
    honestyNotes: PRODUCTION_PATH_HONESTY_NOTES,
    aggregate: summarizeProductionPath({
      world: `all worlds (${input.worlds.length})`,
      databasePath: null,
      decisions,
      laneExecutions,
      laneProposals,
      providerPicks,
    }),
    aggregateAnomalies: productionAnomalies({ decisions, laneExecutions, laneProposals, providerPicks }),
    worlds: input.worlds.map(buildWorldReport),
  };
}

function percent(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function count(value: number): string {
  return String(value);
}

function signal(value: number | null): string {
  return value === null ? "—" : value.toFixed(3);
}

function alignmentSummaryLine(label: string, counts: AlignmentCounts): string {
  return `${label}: compared ${counts.compared}; same id ${counts.sameId} (${percent(counts.sameId, counts.compared)});`
    + ` same family ${counts.sameFamily} (${percent(counts.sameFamily, counts.compared)});`
    + ` divergent ${counts.divergent} (${percent(counts.divergent, counts.compared)});`
    + ` family unknown ${counts.unknownFamily} (${percent(counts.unknownFamily, counts.compared)})`;
}

const FAMILY_TABLE_HEADER =
  "| Family | Advertised | Reach | Act | Confirm | Fallback | Defer | Defer rate | Picks | Signal mean | Signal median"
  + " | Committed | Advisory act | Awaiting confirm | Other uncommitted | Lane proposals | Lane executions"
  + " | Approved | Rejected | Pending | Approved not executed | Provider compared | Same id | Same family | Divergent | Alignment unknown |";

function familyTableLines(families: readonly FamilyProductionRow[]): string[] {
  const lines: string[] = [FAMILY_TABLE_HEADER, `| ---${" | ---:".repeat(25)} |`];
  for (const row of families) {
    lines.push(
      `| ${row.family} | ${row.advertised} | ${percent(row.advertised, row.decisionsTotal)} `
      + `| ${row.act} | ${row.confirm} | ${row.fallback} | ${row.defer} | ${percent(row.defer, row.advertised)} `
      + `| ${row.picks} | ${signal(row.signalMean)} | ${signal(row.signalMedian)} `
      + `| ${row.committed} | ${row.advisoryAct} | ${row.awaitingConfirm} | ${row.otherUncommitted} `
      + `| ${row.laneProposals} | ${row.laneExecutions} `
      + `| ${row.confirmations.approved} | ${row.confirmations.rejected} | ${row.confirmations.pending} | ${row.confirmations.approvedNotExecuted} `
      + `| ${row.alignment.compared} | ${row.alignment.sameId} | ${row.alignment.sameFamily} | ${row.alignment.divergent} | ${row.alignment.unknownFamily} |`,
    );
  }
  return lines;
}

function totalsTableLines(summary: ProductionPathSummary): string[] {
  const totals = summary.totals;
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["Decisions", count(totals.decisions)],
    ["Shadow decisions", count(totals.shadowDecisions)],
    ["Decisions with a shortlist", count(totals.decisionsWithCandidates)],
    ["Decisions without a shortlist", count(totals.decisionsWithoutCandidates)],
    ["Decisions with an unjoined turn", count(totals.decisionsWithUnjoinedTurns)],
    ["Distinct turns / multi-decision turns", `${totals.distinctTurns} / ${totals.multiDecisionTurns}`],
    ["Malformed state_json / selection_json", `${totals.malformedStateRows} / ${totals.malformedSelectionRows}`],
    ["Skipped candidate entries", count(totals.skippedCandidateEntries)],
    ["First / last recorded", `${totals.firstRecordedAt ?? "—"} … ${totals.lastRecordedAt ?? "—"}`],
    ["Lane picks (method=choice)", count(totals.picks)],
    ["Picks resolved as unknown family", count(totals.picksUnknownFamily)],
    ["Picks missing from the shortlist", count(totals.picksMissingFromShortlist)],
    ["Lane proposals / executions", `${totals.laneProposals} / ${totals.laneExecutions}`],
    ["Proposal / execution candidate mismatches", `${totals.proposalCandidateMismatches} / ${totals.executionCandidateMismatches}`],
    ["Provider pick turns / extra calls", `${totals.providerPickTurns} / ${totals.providerExtraCalls}`],
    ["Alignment compared / same id / same family / divergent / unknown", `${totals.alignment.compared} / ${totals.alignment.sameId} / ${totals.alignment.sameFamily} / ${totals.alignment.divergent} / ${totals.alignment.unknownFamily}`],
    ["Confirmations approved / rejected / pending", `${totals.confirmations.approved} / ${totals.confirmations.rejected} / ${totals.confirmations.pending}`],
    ["Confirmations other / not required / unknown", `${totals.confirmations.other} / ${totals.confirmations.notRequired} / ${totals.confirmations.unknown}`],
    ["Approved but not executed", count(totals.confirmations.approvedNotExecuted)],
  ];
  const lines = ["| Metric | Value |", "| --- | --- |"];
  for (const [label, value] of rows) lines.push(`| ${label} | ${value} |`);
  return lines;
}

/** Deterministic markdown rendering: same document in, same bytes out. */
export function renderProductionPathMarkdown(report: ProductionPathReport): string {
  const lines: string[] = [];
  lines.push("# System One production-path evaluation — adventure-selection");
  lines.push("");
  lines.push(`Generated ${report.generatedAt} by \`${report.script}\` (read-only, offline).`);
  lines.push("");
  lines.push(`Worlds: ${report.worlds.map((world) => `\`${world.summary.world}\``).join(", ")}.`);
  lines.push("");
  lines.push("## What this measures");
  lines.push("");
  lines.push(
    "The curated adventure benchmark grades projected candidate sets; this report measures what the"
    + " lane actually did on live worlds. Each decision's `state_json.candidates` is the production"
    + " shortlist the live orchestrator built for that turn and each `selection_json` is the lane's own"
    + " composition. There are no correctness labels here, so the tables report reach, band/defer"
    + " distribution, pick commit classification, provider alignment, and confirmation outcomes —"
    + " counts with descriptive rates, never accuracy.",
  );
  lines.push("");
  lines.push("## Definitions");
  lines.push("");
  for (const definition of report.definitions) lines.push(`- ${definition}`);
  lines.push("");
  lines.push(PRODUCTION_PATH_PROVIDER_SOURCE_NOTE);
  lines.push("");
  lines.push(`Family resolution: ${report.familySource}.`);
  lines.push("");
  lines.push("## Honesty notes");
  lines.push("");
  for (const note of report.honestyNotes) lines.push(`- ${note}`);
  lines.push("");

  const sections: Array<{ title: string; summary: ProductionPathSummary; anomalies: string[]; notices?: readonly string[] }> = [
    {
      title: "Aggregate (all worlds)",
      summary: report.aggregate,
      anomalies: report.aggregateAnomalies,
    },
    ...report.worlds.map((world) => ({
      title: `World: \`${world.summary.world}\``,
      summary: world.summary,
      anomalies: world.anomalies,
      notices: world.notices,
    })),
  ];
  for (const section of sections) {
    lines.push(`## ${section.title}`);
    lines.push("");
    if (section.summary.databasePath !== null) {
      lines.push(`Database: \`${section.summary.databasePath}\``);
      lines.push("");
    }
    lines.push("### Totals");
    lines.push("");
    lines.push(...totalsTableLines(section.summary));
    lines.push("");
    lines.push("### Per-family table");
    lines.push("");
    lines.push(...familyTableLines(section.summary.families));
    lines.push("");
    lines.push(alignmentSummaryLine("Provider alignment", section.summary.totals.alignment));
    lines.push("");
    if (section.notices !== undefined && section.notices.length > 0) {
      lines.push("### Notices");
      lines.push("");
      for (const notice of section.notices) lines.push(`- ${notice}`);
      lines.push("");
    }
    if (section.anomalies.length > 0) {
      lines.push("### Anomalies");
      lines.push("");
      for (const anomaly of section.anomalies) lines.push(`- ${anomaly}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function serializeProductionPathReport(report: ProductionPathReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

// -------------------------------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------------------------------

export const DEFAULT_PRODUCTION_PATH_OUT = "docs/system-one-production-path-evaluation.md";

export interface ProductionPathCliOptions {
  worlds: string[];
  out: string;
  json: string;
  help: boolean;
}

export const PRODUCTION_PATH_USAGE =
  "usage: evaluate-system-one-production-path.ts --world <path> [--world <path>]..."
  + " [--out <path>] [--json <path>]\n"
  + "\n"
  + "Reads each world's velvet.sqlite read-only and evaluates the recorded adventure-selection"
  + " decisions, lane-origin proposals/executions, and provider candidate calls.\n"
  + `--out defaults to ${DEFAULT_PRODUCTION_PATH_OUT}; --json defaults to the same path with .json\n`;

/** The JSON sidecar path alongside a markdown report. */
export function defaultProductionJsonPath(out: string): string {
  return out.endsWith(".md") ? `${out.slice(0, -3)}.json` : `${out}.json`;
}

export function parseProductionPathArgs(argv: readonly string[]): ProductionPathCliOptions {
  const worlds: string[] = [];
  let out = DEFAULT_PRODUCTION_PATH_OUT;
  let json: string | null = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--world" || arg.startsWith("--world=")) {
      const value = arg === "--world" ? argv[index += 1] : arg.slice("--world=".length);
      if (value === undefined || value.trim() === "") throw new Error("--world requires a path");
      worlds.push(value);
    } else if (arg === "--out" || arg.startsWith("--out=")) {
      const value = arg === "--out" ? argv[index += 1] : arg.slice("--out=".length);
      if (value === undefined || value.trim() === "") throw new Error("--out requires a path");
      out = value;
    } else if (arg === "--json" || arg.startsWith("--json=")) {
      const value = arg === "--json" ? argv[index += 1] : arg.slice("--json=".length);
      if (value === undefined || value.trim() === "") throw new Error("--json requires a path");
      json = value;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
      break;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!help && worlds.length === 0) {
    throw new Error("--world is required (for example --world .velvet/synth-srd-1)");
  }
  return { worlds, out, json: json ?? defaultProductionJsonPath(out), help };
}

/** Resolves `--world` to the SQLite file: a directory gets `/velvet.sqlite`, a file is used as-is. */
export function resolveProductionWorldDatabasePath(worldArg: string, cwd: string): string {
  const resolved = path.isAbsolute(worldArg) ? worldArg : path.resolve(cwd, worldArg);
  return resolved.endsWith(".sqlite") ? resolved : path.join(resolved, "velvet.sqlite");
}

// -------------------------------------------------------------------------------------------------
// Read-only SQLite reader
// -------------------------------------------------------------------------------------------------

type SqlRow = Record<string, unknown>;

function isMissingTableError(error: unknown): boolean {
  return /no such table/i.test(messageOf(error));
}

/** Reads a table, tolerating an absent one as "empty" so older worlds still evaluate. */
function readTable(db: DatabaseSync, table: string, notices: string[]): SqlRow[] {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as unknown as SqlRow[];
  } catch (error) {
    if (isMissingTableError(error)) {
      notices.push(`table ${table} is absent; treating it as empty`);
      return [];
    }
    throw error;
  }
}

function sortRows(rows: readonly SqlRow[], ...keys: readonly string[]): SqlRow[] {
  return [...rows].sort((left, right) => {
    for (const key of keys) {
      const a = left[key];
      const b = right[key];
      if (typeof a === "number" && typeof b === "number" && a !== b) return a - b;
      const as = typeof a === "string" ? a : "";
      const bs = typeof b === "string" ? b : "";
      if (as !== bs) return as < bs ? -1 : 1;
    }
    return 0;
  });
}

interface ProviderCallParse {
  toolName: string | null;
  candidateId: string | null;
}

/** Reads a candidate-naming provider call out of one `calls[]` entry (camel or snake case). */
function parseProviderCallEntry(value: unknown): ProviderCallParse {
  if (!isRecord(value)) return { toolName: null, candidateId: null };
  const toolName = asString(value["toolName"]) ?? asString(value["tool_name"]);
  const args = isRecord(value["arguments"]) ? value["arguments"] : isRecord(value["arguments_json"]) ? value["arguments_json"] : null;
  const rawCandidate = args === null ? null : asString(args["candidateId"]) ?? asString(args["candidate_id"]);
  if (rawCandidate === null || rawCandidate === "") return { toolName, candidateId: null };
  return { toolName, candidateId: rawCandidate };
}

/** Parses every candidate-naming call from one provider response document. */
function parseProviderResponseCalls(responseJson: string | null): ProviderCallParse[] {
  if (responseJson === null || responseJson.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["calls"])) return [];
  const calls: ProviderCallParse[] = [];
  for (const entry of parsed["calls"]) {
    const call = parseProviderCallEntry(entry);
    if (call.candidateId !== null) calls.push(call);
  }
  return calls;
}

function parseArgumentsCandidateId(argumentsJson: string | null): string | null {
  if (argumentsJson === null || argumentsJson.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const raw = asString(parsed["candidateId"]) ?? asString(parsed["candidate_id"]);
  return raw === null || raw === "" ? null : raw;
}

/**
 * Loads one world read-only into normalized rows. Tolerates absent tables (notices, empty) so a
 * world recorded under an older schema still contributes whatever it has.
 */
export function loadProductionPathWorld(databasePath: string, world: string): ProductionWorldDataset {
  const notices: string[] = [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(databasePath, { readOnly: true });

    const decisionRows = sortRows(
      readTable(db, "system_one_decisions_v1", notices).filter((row) => asString(row["lane"]) === PRODUCTION_LANE),
      "created_at",
      "decision_id",
    );
    const turnRows = readTable(db, "adventure_turns", notices);
    const turnById = new Map<string, SqlRow>();
    for (const row of turnRows) {
      const id = asString(row["id"]);
      if (id !== null) turnById.set(id, row);
    }
    const decisions: ProductionDecision[] = [];
    for (const row of decisionRows) {
      const decisionId = asString(row["decision_id"]);
      if (decisionId === null) continue;
      const turnId = asString(row["turn_id"]);
      const turnRow = turnId === null ? null : turnById.get(turnId) ?? null;
      decisions.push(toProductionDecision(world, {
        decisionId,
        turnId,
        band: asString(row["confidence_band"]),
        selectionJson: asString(row["selection_json"]),
        stateJson: asString(row["state_json"]),
        shadow: asBoolean(row["shadow"]),
        fallbackUsed: asBoolean(row["fallback_used"]),
        createdAt: asString(row["created_at"]) ?? "",
      }, turnRow === null ? null : {
        declaration: asString(turnRow["declaration"]),
        state: asString(turnRow["state"]),
        mode: asString(turnRow["mode"]),
      }));
    }

    const proposalRows = readTable(db, "tool_proposals", notices);
    const proposalsById = new Map<string, SqlRow>();
    for (const row of proposalRows) {
      const proposalId = asString(row["proposal_id"]);
      if (proposalId !== null) proposalsById.set(proposalId, row);
    }
    const confirmationRows = readTable(db, "confirmation_decisions", notices);
    const confirmationByProposal = new Map<string, string>();
    for (const row of confirmationRows) {
      const proposalId = asString(row["proposal_id"]);
      const decision = asString(row["decision"]);
      if (proposalId !== null && decision !== null) confirmationByProposal.set(proposalId, decision);
    }

    const executionRows = readTable(db, "adventure_exact_action_executions_v56", notices);
    const executedProposalIds = new Set<string>();
    for (const row of executionRows) {
      const proposalId = asString(row["proposal_id"]);
      if (proposalId !== null) executedProposalIds.add(proposalId);
    }
    const laneExecutions: LaneExecution[] = [];
    for (const row of executionRows) {
      if (asString(row["origin"]) !== "lane") continue;
      laneExecutions.push(toLaneExecution(world, "exact-action", {
        turnId: asString(row["turn_id"]),
        decisionId: asString(row["system_one_decision_id"]),
        actionKind: asString(row["action_kind"]),
        candidateId: asString(row["candidate_id"]),
        commandId: asString(row["command_id"]),
        occurredAt: asString(row["occurred_at"]),
      }));
    }
    const checkRows = readTable(db, "adventure_check_executions_v54", notices);
    for (const row of checkRows) {
      if (asString(row["origin"]) !== "lane") continue;
      laneExecutions.push(toLaneExecution(world, "check", {
        turnId: asString(row["turn_id"]),
        decisionId: asString(row["system_one_decision_id"]),
        actionKind: "check",
        candidateId: asString(row["candidate_id"]),
        commandId: asString(row["command_id"]),
        occurredAt: asString(row["occurred_at"]),
      }));
    }

    const laneProposals: LaneProposal[] = [];
    for (const row of readTable(db, "adventure_exact_action_proposal_bindings_v56", notices)) {
      if (asString(row["origin"]) !== "lane") continue;
      const proposalId = asString(row["proposal_id"]);
      if (proposalId === null) continue;
      const proposal = proposalsById.get(proposalId) ?? null;
      laneProposals.push(toLaneProposal(world, {
        proposalId,
        turnId: asString(row["turn_id"]),
        decisionId: asString(row["system_one_decision_id"]),
        actionKind: asString(row["action_kind"]),
        candidateId: asString(row["candidate_id"]),
        requiresConfirmation: proposal === null ? null : asBoolean(proposal["requires_confirmation"]),
        toolName: proposal === null ? null : asString(proposal["tool_name"]),
        confirmation: confirmationByProposal.get(proposalId) ?? null,
        executed: executedProposalIds.has(proposalId),
        boundAt: asString(row["bound_at"]),
      }));
    }

    // Provider candidate calls, in the documented source precedence order.
    const providerCalls: ProviderCandidateCall[] = [];
    for (const [index, row] of sortRows(
      readTable(db, "agent_tool_calls_v38", notices),
      "round_number",
      "position",
    ).entries()) {
      const turnId = asString(row["turn_id"]);
      const candidateId = parseArgumentsCandidateId(asString(row["arguments_json"]));
      if (turnId === null || candidateId === null) continue;
      providerCalls.push({ turnId, candidateId, toolName: asString(row["tool_name"]), source: "tool-call", order: index });
    }
    for (const [index, row] of sortRows(
      readTable(db, "agent_decision_rounds_v38", notices),
      "round_number",
    ).entries()) {
      const turnId = asString(row["turn_id"]);
      if (turnId === null) continue;
      for (const call of parseProviderResponseCalls(asString(row["response_json"]))) {
        providerCalls.push({ turnId, candidateId: call.candidateId!, toolName: call.toolName, source: "decision-round", order: index });
      }
    }
    for (const [index, row] of sortRows(
      readTable(db, "agent_provider_responses_v39", notices),
      "recorded_at",
      "provider_call_id",
    ).entries()) {
      const turnId = asString(row["turn_id"]);
      if (turnId === null) continue;
      for (const call of parseProviderResponseCalls(asString(row["response_json"]))) {
        providerCalls.push({ turnId, candidateId: call.candidateId!, toolName: call.toolName, source: "provider-response", order: index });
      }
    }
    for (const [index, row] of readTable(db, "adventure_exact_action_proposal_bindings_v56", notices).entries()) {
      if (asString(row["origin"]) !== "provider") continue;
      const turnId = asString(row["turn_id"]);
      const candidateId = asString(row["candidate_id"]);
      if (turnId === null || candidateId === null) continue;
      providerCalls.push({
        turnId,
        candidateId,
        toolName: null,
        source: "provider-binding",
        order: index,
        actionKind: asString(row["action_kind"]),
      });
    }

    return {
      world,
      databasePath,
      decisions,
      laneExecutions,
      laneProposals,
      providerPicks: buildProviderPicks(world, providerCalls),
      notices,
    };
  } finally {
    if (db !== null) {
      try {
        db.close();
      } catch {
        // The read is done; a close failure must not mask the report.
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Entry point
// -------------------------------------------------------------------------------------------------

function renderConsoleSummary(report: ProductionPathReport): string {
  const totals = report.aggregate.totals;
  const alignment = report.aggregate.totals.alignment;
  return [
    `System One production-path evaluation — ${report.worlds.length} world(s)`,
    `Decisions ${totals.decisions} · picks ${totals.picks} · lane proposals ${totals.laneProposals} · lane executions ${totals.laneExecutions}`,
    alignmentSummaryLine("Provider alignment", alignment),
    `Confirmations approved ${totals.confirmations.approved} / rejected ${totals.confirmations.rejected} / pending ${totals.confirmations.pending}`,
  ].join("\n") + "\n";
}

async function main(): Promise<void> {
  const options = parseProductionPathArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(PRODUCTION_PATH_USAGE);
    return;
  }
  const datasets: ProductionWorldDataset[] = [];
  for (const world of options.worlds) {
    const databasePath = resolveProductionWorldDatabasePath(world, process.cwd());
    if (!existsSync(databasePath)) {
      throw new Error(`no Velvet database found at ${databasePath} (--world ${world})`);
    }
    datasets.push(loadProductionPathWorld(databasePath, world));
  }
  const report = buildProductionPathReport({ worlds: datasets, generatedAt: new Date().toISOString() });
  process.stdout.write(renderConsoleSummary(report));

  const out = path.resolve(options.out);
  const json = path.resolve(options.json);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, renderProductionPathMarkdown(report), "utf8");
  process.stdout.write(`wrote ${out}\n`);
  mkdirSync(path.dirname(json), { recursive: true });
  writeFileSync(json, serializeProductionPathReport(report), "utf8");
  process.stdout.write(`wrote ${json}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(messageOf(error));
    process.exitCode = 1;
  });
}
