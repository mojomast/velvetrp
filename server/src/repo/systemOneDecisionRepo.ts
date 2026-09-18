import { createHash } from "node:crypto";
import { canonicalAgentJson } from "@velvet/contracts";
import { getRepositoryDatabase } from "./repoContext.js";

export interface RecordSystemOneDecisionInput {
  decisionId: string; lane: string;
  campaignId?: string | null; sessionId?: string | null; turnId?: string | null;
  provider: string; model: string; confidencePolicyVersion: string;
  state: unknown; questions: unknown; answers: unknown; selection: unknown;
  confidenceBand: "act" | "confirm" | "fallback";
  fallbackUsed: boolean; shadow: boolean;
  usage: unknown | null; latencyMs: number; createdAt: string;
}

export interface SystemOneDecisionRecord {
  decisionId: string; lane: string;
  campaignId: string | null; sessionId: string | null; turnId: string | null;
  provider: string; model: string; confidencePolicyVersion: string;
  requestDigest: string; questionsDigest: string; stateDigest: string;
  request: unknown; questions: unknown; state: unknown; answers: unknown; selection: unknown;
  confidenceBand: "act" | "confirm" | "fallback";
  fallbackUsed: boolean; shadow: boolean; usage: unknown | null;
  latencyMs: number; createdAt: string;
  /**
   * True when an `adventure_check_executions_v54` row with `origin='lane'` links this decision as
   * `system_one_decision_id`. Only joined reads (`listRecentSystemOneDecisionsWithLaneCommits`,
   * `summarizeSystemOneDecisions`) populate it; undefined means the read did not join. The
   * insert-only decision log cannot rewrite `shadow`, so this flag is the read-side proof of a
   * lane commit.
   */
  committedByLane?: boolean;
}

interface SystemOneDecisionRow {
  decision_id: string; lane: string;
  campaign_id: string | null; session_id: string | null; turn_id: string | null;
  provider: string; model: string; confidence_policy_version: string;
  request_digest: string; questions_digest: string; state_digest: string;
  request_json: string; questions_json: string; state_json: string; answers_json: string; selection_json: string;
  confidence_band: "act" | "confirm" | "fallback";
  fallback_used: number; shadow: number; usage_json: string | null;
  latency_ms: number; created_at: string;
}

export interface SystemOneDecisionSummary {
  total: number;
  byLane: Array<{ lane: string; count: number; laneCommits: number }>;
  byBand: Array<{ band: "act" | "confirm" | "fallback"; count: number }>;
  fallbackUsed: number;
  shadow: number;
  /** Decisions in the window with at least one lane-origin check execution. */
  laneCommits: number;
  /** Shadow (recorded advisory) decisions in the window that still have a lane-origin execution. */
  shadowLaneCommits: number;
  meanLatencyMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

const CONFIDENCE_BANDS: ReadonlyArray<SystemOneDecisionRecord["confidenceBand"]> = ["act", "confirm", "fallback"];

const sha = (value: unknown): string => createHash("sha256").update(canonicalAgentJson(value as never)).digest("hex");
const parseJson = (value: string): unknown => JSON.parse(value) as unknown;
const clampLimit = (limit: number): number => Math.max(1, Math.min(1_000, Math.trunc(limit)));

function usageTokens(usage: unknown): { input: number; output: number } {
  if (usage === null || typeof usage !== "object") return { input: 0, output: 0 };
  const value = usage as { inputTokens?: unknown; outputTokens?: unknown };
  const input = typeof value.inputTokens === "number" && Number.isFinite(value.inputTokens) ? value.inputTokens : 0;
  const output = typeof value.outputTokens === "number" && Number.isFinite(value.outputTokens) ? value.outputTokens : 0;
  return { input, output };
}

function toRecord(row: SystemOneDecisionRow): SystemOneDecisionRecord {
  return {
    decisionId: row.decision_id, lane: row.lane,
    campaignId: row.campaign_id, sessionId: row.session_id, turnId: row.turn_id,
    provider: row.provider, model: row.model, confidencePolicyVersion: row.confidence_policy_version,
    requestDigest: row.request_digest, questionsDigest: row.questions_digest, stateDigest: row.state_digest,
    request: parseJson(row.request_json), questions: parseJson(row.questions_json), state: parseJson(row.state_json),
    answers: parseJson(row.answers_json), selection: parseJson(row.selection_json),
    confidenceBand: row.confidence_band,
    fallbackUsed: row.fallback_used === 1, shadow: row.shadow === 1,
    usage: row.usage_json === null ? null : parseJson(row.usage_json),
    latencyMs: row.latency_ms, createdAt: row.created_at,
  };
}

/** Persists one immutable System One decision. Digests are always derived from the raw values. */
export function recordSystemOneDecision(input: RecordSystemOneDecisionInput): void {
  const stateDigest = sha(input.state);
  const questionsDigest = sha(input.questions);
  const requestDigest = sha({ state: input.state, model: input.model, questions: input.questions });
  getRepositoryDatabase().prepare(`INSERT INTO system_one_decisions_v1
    (decision_id,lane,campaign_id,session_id,turn_id,provider,model,confidence_policy_version,
      request_digest,questions_digest,state_digest,request_json,questions_json,state_json,answers_json,
      selection_json,confidence_band,fallback_used,shadow,usage_json,latency_ms,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.decisionId, input.lane, input.campaignId ?? null, input.sessionId ?? null, input.turnId ?? null,
    input.provider, input.model, input.confidencePolicyVersion,
    requestDigest, questionsDigest, stateDigest,
    JSON.stringify({ state: input.state, model: input.model, questions: input.questions }),
    JSON.stringify(input.questions), JSON.stringify(input.state), JSON.stringify(input.answers), JSON.stringify(input.selection),
    input.confidenceBand, input.fallbackUsed ? 1 : 0, input.shadow ? 1 : 0,
    input.usage === null ? null : JSON.stringify(input.usage), input.latencyMs, input.createdAt,
  );
}

export function getSystemOneDecision(decisionId: string): SystemOneDecisionRecord | null {
  const row = getRepositoryDatabase()
    .prepare("SELECT * FROM system_one_decisions_v1 WHERE decision_id=?")
    .get(decisionId) as SystemOneDecisionRow | undefined;
  return row ? toRecord(row) : null;
}

export function listSystemOneDecisions(limit: number): SystemOneDecisionRecord[] {
  const bounded = clampLimit(limit);
  const rows = getRepositoryDatabase()
    .prepare("SELECT * FROM system_one_decisions_v1 ORDER BY created_at,decision_id LIMIT ?")
    .all(bounded) as SystemOneDecisionRow[];
  return rows.map(toRecord);
}

/** Lists decisions for one lane in ascending created-at order, bounded to 1..1000 rows. */
export function listSystemOneDecisionsByLane(lane: string, limit: number): SystemOneDecisionRecord[] {
  const bounded = clampLimit(limit);
  const rows = getRepositoryDatabase()
    .prepare("SELECT * FROM system_one_decisions_v1 WHERE lane=? ORDER BY created_at,decision_id LIMIT ?")
    .all(lane, bounded) as SystemOneDecisionRow[];
  return rows.map(toRecord);
}

/** Lists the most recent decisions across every lane, newest first, bounded to 1..1000 rows. */
export function listRecentSystemOneDecisions(limit: number): SystemOneDecisionRecord[] {
  const bounded = clampLimit(limit);
  const rows = getRepositoryDatabase()
    .prepare("SELECT * FROM system_one_decisions_v1 ORDER BY created_at DESC,decision_id DESC LIMIT ?")
    .all(bounded) as SystemOneDecisionRow[];
  return rows.map(toRecord);
}

/** Conservative SQLite parameter bound for the read-only lane-commit join. */
const LANE_COMMIT_ID_BATCH = 400;

/**
 * Read-only join against the authoritative lane-commit evidence. Returns the subset of the
 * supplied decision ids that appear as `system_one_decision_id` on an
 * `adventure_check_executions_v54` row with `origin='lane'`. The insert-only decision log cannot
 * rewrite `shadow` once a lane actually commits, so this join is how operators see that a decision
 * recorded as advisory acted. Degrades to an empty set when the execution table is absent; inserts
 * nothing and mutates nothing.
 */
export function listLaneCommittedSystemOneDecisionIds(decisionIds: readonly string[]): Set<string> {
  const unique = [...new Set(decisionIds)].filter((decisionId) => decisionId.length > 0);
  const committed = new Set<string>();
  if (unique.length === 0) return committed;
  const db = getRepositoryDatabase();
  try {
    for (let offset = 0; offset < unique.length; offset += LANE_COMMIT_ID_BATCH) {
      const batch = unique.slice(offset, offset + LANE_COMMIT_ID_BATCH);
      const rows = db.prepare(`SELECT DISTINCT system_one_decision_id AS decision_id
        FROM adventure_check_executions_v54
        WHERE origin='lane' AND system_one_decision_id IN (${batch.map(() => "?").join(",")})`)
        .all(...batch) as Array<{ decision_id: string }>;
      for (const row of rows) committed.add(row.decision_id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return new Set();
    throw error;
  }
  return committed;
}

/**
 * `listRecentSystemOneDecisions` plus the lane-commit flag from the read-only execution join.
 * A decision with `committedByLane: true` was recorded in the decision log (possibly `shadow: true`)
 * and then committed by a lane-origin check execution; the execution row is the authoritative
 * evidence.
 */
export function listRecentSystemOneDecisionsWithLaneCommits(limit: number): SystemOneDecisionRecord[] {
  const decisions = listRecentSystemOneDecisions(limit);
  const committed = listLaneCommittedSystemOneDecisionIds(decisions.map((record) => record.decisionId));
  return decisions.map((record) => ({ ...record, committedByLane: committed.has(record.decisionId) }));
}

/** One Director decision paired with the authoritative provider composition for its turn. */
export interface DirectorDecisionAuthority {
  decision: SystemOneDecisionRecord;
  /** Candidate ids the authoritative provider composition selected, in order; null when it held. */
  authoritativeCandidateIds: string[] | null;
  /** True when no run exists for the decision's turn id (or the run table is absent). */
  authoritativeMissing: boolean;
}

/** Normalizes a stored composition (ordered array, or a legacy single object) to candidate ids. */
function proposalCandidateIds(proposalJson: string | null): string[] | null {
  if (proposalJson === null) return null;
  try {
    const parsed = JSON.parse(proposalJson) as unknown;
    if (parsed === null || parsed === undefined) return null;
    const composition = Array.isArray(parsed) ? parsed : [parsed];
    return composition.flatMap((item) => item && typeof item === "object" && typeof (item as { candidateId?: unknown }).candidateId === "string"
      ? [(item as { candidateId: string }).candidateId]
      : []);
  } catch {
    return null;
  }
}

/**
 * Lists recent Director decisions, newest first, each paired with the authoritative composition
 * the provider settled for the same run. The Director record is shadow-only evidence, so this is
 * the read side that lets a reviewer see where the would-be call matched or diverged from the
 * committed one. Missing runs or run tables degrade to `authoritativeMissing` rather than throwing.
 */
export function listDirectorDecisionsWithAuthority(limit: number): DirectorDecisionAuthority[] {
  const bounded = clampLimit(limit);
  let rows: SystemOneDecisionRow[];
  try {
    rows = getRepositoryDatabase()
      .prepare("SELECT * FROM system_one_decisions_v1 WHERE lane='director-selection' ORDER BY created_at DESC,decision_id DESC LIMIT ?")
      .all(bounded) as SystemOneDecisionRow[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return [];
    throw error;
  }
  return rows.map((row) => {
    const decision = toRecord(row);
    if (decision.turnId === null) return { decision, authoritativeCandidateIds: null, authoritativeMissing: true };
    try {
      const run = getRepositoryDatabase()
        .prepare("SELECT proposal_json FROM dm_runs WHERE run_id=?")
        .get(decision.turnId) as { proposal_json: string | null } | undefined;
      if (!run) return { decision, authoritativeCandidateIds: null, authoritativeMissing: true };
      return { decision, authoritativeCandidateIds: proposalCandidateIds(run.proposal_json), authoritativeMissing: false };
    } catch {
      return { decision, authoritativeCandidateIds: null, authoritativeMissing: true };
    }
  });
}

/** Aggregates a bounded window of recent decisions for the read-only System One summary route. */
export function summarizeSystemOneDecisions(limit = 1_000): SystemOneDecisionSummary {
  const decisions = listRecentSystemOneDecisions(clampLimit(limit));
  const committedIds = listLaneCommittedSystemOneDecisionIds(decisions.map((record) => record.decisionId));
  const laneCounts = new Map<string, number>();
  const laneCommitCounts = new Map<string, number>();
  const bandCounts = new Map<SystemOneDecisionRecord["confidenceBand"], number>();
  let fallbackUsed = 0;
  let shadow = 0;
  let laneCommits = 0;
  let shadowLaneCommits = 0;
  let latencyTotal = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const record of decisions) {
    laneCounts.set(record.lane, (laneCounts.get(record.lane) ?? 0) + 1);
    bandCounts.set(record.confidenceBand, (bandCounts.get(record.confidenceBand) ?? 0) + 1);
    if (record.fallbackUsed) fallbackUsed += 1;
    if (record.shadow) shadow += 1;
    if (committedIds.has(record.decisionId)) {
      laneCommits += 1;
      laneCommitCounts.set(record.lane, (laneCommitCounts.get(record.lane) ?? 0) + 1);
      if (record.shadow) shadowLaneCommits += 1;
    }
    latencyTotal += record.latencyMs;
    const tokens = usageTokens(record.usage);
    totalInputTokens += tokens.input;
    totalOutputTokens += tokens.output;
  }
  return {
    total: decisions.length,
    byLane: [...laneCounts.entries()]
      .map(([lane, count]) => ({ lane, count, laneCommits: laneCommitCounts.get(lane) ?? 0 }))
      .sort((left, right) => left.lane.localeCompare(right.lane)),
    byBand: CONFIDENCE_BANDS.map((band) => ({ band, count: bandCounts.get(band) ?? 0 })),
    fallbackUsed,
    shadow,
    laneCommits,
    shadowLaneCommits,
    meanLatencyMs: decisions.length === 0 ? 0 : latencyTotal / decisions.length,
    totalInputTokens,
    totalOutputTokens,
  };
}

/** Re-derives every digest from the stored JSON and rejects any tampered or malformed record. */
export function assertSystemOneDecisionIntegrity(decisionId: string): void {
  const record = getSystemOneDecision(decisionId);
  if (!record) throw new Error("system one decision is missing");
  if (sha(record.state) !== record.stateDigest
    || sha(record.questions) !== record.questionsDigest
    || sha({ state: record.state, model: record.model, questions: record.questions }) !== record.requestDigest) {
    throw new Error("system one decision digest mismatch");
  }
  if (!CONFIDENCE_BANDS.includes(record.confidenceBand)) throw new Error("system one decision confidence band is invalid");
}
