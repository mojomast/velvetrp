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
  byLane: Array<{ lane: string; count: number }>;
  byBand: Array<{ band: "act" | "confirm" | "fallback"; count: number }>;
  fallbackUsed: number;
  shadow: number;
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

/** Aggregates a bounded window of recent decisions for the read-only System One summary route. */
export function summarizeSystemOneDecisions(limit = 1_000): SystemOneDecisionSummary {
  const decisions = listRecentSystemOneDecisions(clampLimit(limit));
  const laneCounts = new Map<string, number>();
  const bandCounts = new Map<SystemOneDecisionRecord["confidenceBand"], number>();
  let fallbackUsed = 0;
  let shadow = 0;
  let latencyTotal = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const record of decisions) {
    laneCounts.set(record.lane, (laneCounts.get(record.lane) ?? 0) + 1);
    bandCounts.set(record.confidenceBand, (bandCounts.get(record.confidenceBand) ?? 0) + 1);
    if (record.fallbackUsed) fallbackUsed += 1;
    if (record.shadow) shadow += 1;
    latencyTotal += record.latencyMs;
    const tokens = usageTokens(record.usage);
    totalInputTokens += tokens.input;
    totalOutputTokens += tokens.output;
  }
  return {
    total: decisions.length,
    byLane: [...laneCounts.entries()]
      .map(([lane, count]) => ({ lane, count }))
      .sort((left, right) => left.lane.localeCompare(right.lane)),
    byBand: CONFIDENCE_BANDS.map((band) => ({ band, count: bandCounts.get(band) ?? 0 })),
    fallbackUsed,
    shadow,
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
