import type DatabaseDriver from "better-sqlite3";
import type { Clock, IdGenerator } from "../../runtime.js";
import {
  createAgentObservationRepository,
  type AgentObservation,
} from "./agentObservationRepo.js";

export const MAX_WITNESS_FANOUT = 12;
export const MAX_TELL_FANOUT = 12;
export const MAX_TELL_PER_ARRIVAL = 8;
export const MAX_HOP_COUNT = 2;
export const MAX_OBSERVATIONS_PER_AGENT = 256;

const MAX_KNOWER_OBSERVATIONS = 8;

export interface PropagationDependencies {
  ids: IdGenerator;
  clock: Clock;
}

export interface WitnessObservationInput {
  campaignId: string;
  timelineId: string;
  sessionId: string;
  sourceCommandId: string;
  observedRevision: number;
  summary: string;
  authority?: "verified" | "rumor";
}

export interface ToldOnArrivalInput {
  campaignId: string;
  timelineId: string;
  sessionId: string;
  arrivingNpcId: string;
  /** Advisory only: told rows inherit the source event's observed revision so re-telling is idempotent. */
  observedRevision: number;
}

interface NpcIdRow { npc_id: string }
interface CountRow { count: number }
interface KnowerObservationRow { source_command_id: string; hop_count: number; text: string; observed_revision: number }

const KNOWS_ROW = "observation_id";

/**
 * Records a witnessed hop-0 observation for every NPC present in the session.
 * Bounded by MAX_WITNESS_FANOUT and skipped when the agent is at the write cap.
 * The caller owns the transaction; this function never opens its own.
 */
export function propagateWitnessObservations(
  db: DatabaseDriver.Database,
  dependencies: PropagationDependencies,
  input: WitnessObservationInput,
): AgentObservation[] {
  const repository = createAgentObservationRepository(db, dependencies);
  const present = db.prepare(`SELECT npc_id FROM campaign_npc_presence_v43
    WHERE campaign_id=? AND session_id=? AND state='present' ORDER BY npc_id LIMIT ?`)
    .all(input.campaignId, input.sessionId, MAX_WITNESS_FANOUT) as NpcIdRow[];
  const countObservations = db.prepare(`SELECT COUNT(*) AS count FROM agent_observations
    WHERE campaign_id=? AND agent_kind='npc' AND agent_id=?`);
  const selectWitnessed = db.prepare(`SELECT ${KNOWS_ROW} FROM agent_observations
    WHERE campaign_id=? AND agent_kind='npc' AND agent_id=? AND source_command_id=? AND hop_count=0
      AND relayer_agent_id IS NULL`);
  const recorded: AgentObservation[] = [];
  for (const { npc_id: npcId } of present) {
    const replayed = selectWitnessed.get(input.campaignId, npcId, input.sourceCommandId) !== undefined;
    if (!replayed && (countObservations.get(input.campaignId, npcId) as CountRow).count >= MAX_OBSERVATIONS_PER_AGENT) continue;
    recorded.push(repository.record({
      campaignId: input.campaignId,
      timelineId: input.timelineId,
      agentKind: "npc",
      agentId: npcId,
      sourceCommandId: input.sourceCommandId,
      observedRevision: input.observedRevision,
      channel: "witnessed",
      hopCount: 0,
      text: input.summary,
      authority: input.authority ?? "verified",
    }));
  }
  return recorded;
}

/**
 * Spreads the newest observations held by present NPCs to an arriving NPC as
 * `told` rows. Bounded by MAX_TELL_FANOUT knowers, MAX_TELL_PER_ARRIVAL rows,
 * MAX_HOP_COUNT hops, and the per-agent write cap. Immutable rows are never
 * deleted; the caller owns the transaction.
 */
export function propagateToldOnArrival(
  db: DatabaseDriver.Database,
  dependencies: PropagationDependencies,
  input: ToldOnArrivalInput,
): AgentObservation[] {
  const repository = createAgentObservationRepository(db, dependencies);
  const knowers = db.prepare(`SELECT npc_id FROM campaign_npc_presence_v43
    WHERE campaign_id=? AND session_id=? AND state='present' AND npc_id<>? ORDER BY npc_id LIMIT ?`)
    .all(input.campaignId, input.sessionId, input.arrivingNpcId, MAX_TELL_FANOUT) as NpcIdRow[];
  const knowerObservations = db.prepare(`SELECT source_command_id,hop_count,text,observed_revision FROM agent_observations
    WHERE campaign_id=? AND agent_kind='npc' AND agent_id=?
    ORDER BY created_at DESC, observation_id DESC LIMIT ?`);
  const countObservations = db.prepare(`SELECT COUNT(*) AS count FROM agent_observations
    WHERE campaign_id=? AND agent_kind='npc' AND agent_id=?`);
  const selectTold = db.prepare(`SELECT ${KNOWS_ROW} FROM agent_observations
    WHERE campaign_id=? AND agent_kind='npc' AND agent_id=? AND source_command_id=? AND hop_count=?
      AND relayer_agent_id=?`);
  let arrivingCount = (countObservations.get(input.campaignId, input.arrivingNpcId) as CountRow).count;
  const recorded: AgentObservation[] = [];
  for (const { npc_id: knowerId } of knowers) {
    const observations = knowerObservations.all(input.campaignId, knowerId, MAX_KNOWER_OBSERVATIONS) as KnowerObservationRow[];
    for (const observation of observations) {
      const hopCount = observation.hop_count + 1;
      if (hopCount > MAX_HOP_COUNT) continue;
      const replayed = selectTold.get(
        input.campaignId, input.arrivingNpcId, observation.source_command_id, hopCount, knowerId,
      ) !== undefined;
      if (!replayed && arrivingCount >= MAX_OBSERVATIONS_PER_AGENT) continue;
      recorded.push(repository.record({
        campaignId: input.campaignId,
        timelineId: input.timelineId,
        agentKind: "npc",
        agentId: input.arrivingNpcId,
        sourceCommandId: observation.source_command_id,
        observedRevision: observation.observed_revision,
        channel: "told",
        relayerAgentId: knowerId,
        hopCount,
        text: observation.text,
        authority: "rumor",
      }));
      if (!replayed) arrivingCount += 1;
      if (recorded.length >= MAX_TELL_PER_ARRIVAL) return recorded;
    }
  }
  return recorded;
}
