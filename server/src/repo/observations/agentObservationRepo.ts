import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import type { Clock, IdGenerator } from "../../runtime.js";

export type AgentObservationKind = "npc" | "faction" | "companion" | "town";
export type AgentObservationChannel = "witnessed" | "told" | "refuted";
export type AgentObservationAuthority = "rumor" | "verified" | "belief";

export interface AgentObservationInput {
  observationId?: string;
  campaignId: string;
  timelineId: string;
  agentKind: AgentObservationKind;
  agentId: string;
  sourceCommandId: string;
  observedRevision: number;
  channel: AgentObservationChannel;
  relayerAgentId?: string | null;
  hopCount: number;
  text: string;
  authority: AgentObservationAuthority;
}

export interface AgentObservation {
  observationId: string;
  campaignId: string;
  timelineId: string;
  agentKind: AgentObservationKind;
  agentId: string;
  sourceCommandId: string;
  observedRevision: number;
  channel: AgentObservationChannel;
  relayerAgentId: string | null;
  hopCount: number;
  text: string;
  authority: AgentObservationAuthority;
  createdAt: string;
}

export class AgentObservationConflictError extends Error {
  readonly code = "AGENT_OBSERVATION_CONFLICT";
  constructor(message = "agent observation conflicts with a recorded observation") {
    super(message);
    this.name = "AgentObservationConflictError";
  }
}

export class AgentObservationUnavailableError extends Error {
  readonly code = "AGENT_OBSERVATION_UNAVAILABLE";
  constructor(message = "agent observation is unavailable") {
    super(message);
    this.name = "AgentObservationUnavailableError";
  }
}

export interface AgentObservationRepository {
  record(input: AgentObservationInput): AgentObservation;
  recordMany(inputs: AgentObservationInput[]): AgentObservation[];
  getBySource(campaignId: string, sourceCommandId: string): AgentObservation[];
}

interface AgentObservationRow {
  observation_id: string;
  campaign_id: string;
  timeline_id: string;
  agent_kind: string;
  agent_id: string;
  source_command_id: string;
  observed_revision: number;
  channel: string;
  relayer_agent_id: string | null;
  hop_count: number;
  text: string;
  authority: string;
  created_at: string;
}

const KIND_VALUES = ["npc", "faction", "companion", "town"] as const;
const CHANNEL_VALUES = ["witnessed", "told", "refuted"] as const;
const AUTHORITY_VALUES = ["rumor", "verified", "belief"] as const;
const MAX_SAFE_REVISION = 9007199254740991;
const MAX_HOP_COUNT = 8;
const MAX_TEXT_BYTES = 2048;
const MAX_AGENT_ID_LENGTH = 200;

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalizeObservation(input: AgentObservationInput) {
  if (input === null || typeof input !== "object") throw new Error("agent observation is invalid");
  const observationId = input.observationId === undefined
    ? undefined : requiredText(input.observationId, "observationId", 200);
  const campaignId = requiredText(input.campaignId, "campaignId", 200);
  const timelineId = requiredText(input.timelineId, "timelineId", 200);
  if (!KIND_VALUES.includes(input.agentKind)) throw new Error("agent kind is invalid");
  const agentId = requiredText(input.agentId, "agentId", MAX_AGENT_ID_LENGTH);
  const sourceCommandId = requiredText(input.sourceCommandId, "sourceCommandId", 200);
  if (typeof input.observedRevision !== "number" || !Number.isSafeInteger(input.observedRevision)
    || input.observedRevision < 0 || input.observedRevision > MAX_SAFE_REVISION) {
    throw new Error("observed revision is invalid");
  }
  if (!CHANNEL_VALUES.includes(input.channel)) throw new Error("channel is invalid");
  const relayerAgentId = input.relayerAgentId === undefined || input.relayerAgentId === null
    ? null : requiredText(input.relayerAgentId, "relayerAgentId", MAX_AGENT_ID_LENGTH);
  if (typeof input.hopCount !== "number" || !Number.isSafeInteger(input.hopCount)
    || input.hopCount < 0 || input.hopCount > MAX_HOP_COUNT) {
    throw new Error("hop count is invalid");
  }
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length === 0) throw new Error("text is required");
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error("text exceeds the observation budget");
  if (!AUTHORITY_VALUES.includes(input.authority)) throw new Error("authority is invalid");
  if (input.channel === "witnessed") {
    if (input.hopCount !== 0 || relayerAgentId !== null) throw new Error("witnessed observations cannot be relayed");
  } else if (input.hopCount < 1 || relayerAgentId === null) {
    throw new Error("relayed observations require a relayer and a positive hop count");
  }
  return {
    observationId, campaignId, timelineId, agentKind: input.agentKind, agentId, sourceCommandId,
    observedRevision: input.observedRevision, channel: input.channel, relayerAgentId,
    hopCount: input.hopCount, text, authority: input.authority,
  };
}

type NormalizedObservation = ReturnType<typeof normalizeObservation>;

function deriveObservationId(observation: NormalizedObservation): string {
  const canonical = JSON.stringify([
    observation.campaignId, observation.agentKind, observation.agentId,
    observation.sourceCommandId, observation.hopCount, observation.relayerAgentId,
  ]);
  return `agent-observation-${createHash("sha256").update(canonical).digest("hex")}`;
}

function toAgentObservation(row: AgentObservationRow): AgentObservation {
  return {
    observationId: row.observation_id,
    campaignId: row.campaign_id,
    timelineId: row.timeline_id,
    agentKind: row.agent_kind as AgentObservationKind,
    agentId: row.agent_id,
    sourceCommandId: row.source_command_id,
    observedRevision: row.observed_revision,
    channel: row.channel as AgentObservationChannel,
    relayerAgentId: row.relayer_agent_id,
    hopCount: row.hop_count,
    text: row.text,
    authority: row.authority as AgentObservationAuthority,
    createdAt: row.created_at,
  };
}

function isConstraintFailure(error: unknown): boolean {
  return error instanceof Error
    && /SQLITE_CONSTRAINT|constraint failed|immutable|cannot be replaced|unique/i.test(error.message);
}

const OBSERVATION_COLUMNS = `observation_id,campaign_id,timeline_id,agent_kind,agent_id,source_command_id,
  observed_revision,channel,relayer_agent_id,hop_count,text,authority,created_at`;

export function createAgentObservationRepository(
  db: DatabaseDriver.Database,
  dependencies: { ids: IdGenerator; clock: Clock },
): AgentObservationRepository {
  const selectByNaturalKey = db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM agent_observations
    WHERE campaign_id=? AND agent_kind=? AND agent_id=? AND source_command_id=? AND hop_count=?
      AND ifnull(relayer_agent_id,'')=ifnull(?,'')`);
  const selectByObservationId = db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM agent_observations WHERE observation_id=?`);
  const insert = db.prepare(`INSERT INTO agent_observations (${OBSERVATION_COLUMNS})
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  const record = (input: AgentObservationInput): AgentObservation => {
    const observation = normalizeObservation(input);
    const existingRow = selectByNaturalKey.get(
      observation.campaignId, observation.agentKind, observation.agentId,
      observation.sourceCommandId, observation.hopCount, observation.relayerAgentId,
    ) as AgentObservationRow | undefined;
    if (existingRow) {
      const existing = toAgentObservation(existingRow);
      if (existing.text === observation.text
        && existing.authority === observation.authority
        && existing.observedRevision === observation.observedRevision) return existing;
      throw new AgentObservationConflictError();
    }
    const observationId = observation.observationId ?? deriveObservationId(observation);
    const createdAt = dependencies.clock.now().toISOString();
    try {
      insert.run(
        observationId, observation.campaignId, observation.timelineId, observation.agentKind,
        observation.agentId, observation.sourceCommandId, observation.observedRevision,
        observation.channel, observation.relayerAgentId, observation.hopCount,
        observation.text, observation.authority, createdAt,
      );
    } catch (error) {
      if (isConstraintFailure(error)) throw new AgentObservationConflictError();
      throw error;
    }
    const row = selectByObservationId.get(observationId) as AgentObservationRow | undefined;
    if (!row) throw new Error("agent observation write is missing");
    return toAgentObservation(row);
  };

  return {
    record,
    recordMany(inputs) {
      return inputs.map((input) => record(input));
    },
    getBySource(campaignId, sourceCommandId) {
      const campaign = requiredText(campaignId, "campaignId", 200);
      const command = requiredText(sourceCommandId, "sourceCommandId", 200);
      const rows = db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM agent_observations
        WHERE campaign_id=? AND source_command_id=? ORDER BY hop_count ASC, observation_id ASC`)
        .all(campaign, command) as AgentObservationRow[];
      return rows.map(toAgentObservation);
    },
  };
}
