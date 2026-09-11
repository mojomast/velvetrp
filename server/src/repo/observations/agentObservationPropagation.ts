import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import type { Clock, IdGenerator } from "../../runtime.js";
import {
  createAgentObservationRepository,
  type AgentObservation,
} from "./agentObservationRepo.js";

export const MAX_WITNESS_FANOUT = 12;
export const MAX_FACTION_WITNESS_FANOUT = 12;
export const MAX_TELL_FANOUT = 12;
export const MAX_TELL_PER_ARRIVAL = 8;
export const MAX_HOP_COUNT = 2;
export const MAX_OBSERVATIONS_PER_AGENT = 256;
export const TOWN_GOSSIP_AGENT_ID = "town-square";
export const MAX_GOSSIP_FANOUT = 12;
export const MAX_GOSSIP_SOURCE_ITEMS = 8;
export const MAX_GOSSIP_PER_NPC = 2;

const MAX_KNOWER_OBSERVATIONS = 8;
/** Membership roles whose NPCs are considered to share observation with their faction. */
const FACTION_SHARING_ROLES = "('member','leader','ally')";

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

export interface GossipSampleInput {
  campaignId: string;
  timelineId: string;
  sessionId: string;
}

interface NpcIdRow { npc_id: string }
interface FactionIdRow { faction_id: string }
interface CountRow { count: number }
interface GossipRow { source_command_id: string; text: string; observed_revision: number }
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
 * Derives faction-level observations from member NPCs that witnessed a
 * committed event. An NPC shares with its faction only when its membership role
 * is member/leader/ally; enemies never leak. Bounded by
 * MAX_FACTION_WITNESS_FANOUT distinct factions and the per-agent write cap.
 * Immutable rows are never deleted; the caller owns the transaction.
 */
export function propagateFactionWitnessObservations(
  db: DatabaseDriver.Database,
  dependencies: PropagationDependencies,
  input: WitnessObservationInput,
): AgentObservation[] {
  const repository = createAgentObservationRepository(db, dependencies);
  const factions = db.prepare(`SELECT DISTINCT membership.faction_id AS faction_id
    FROM campaign_npc_faction_memberships_v28 membership
    JOIN campaign_npc_presence_v43 presence
      ON presence.campaign_id=membership.campaign_id AND presence.npc_id=membership.npc_id
    WHERE membership.campaign_id=? AND presence.session_id=? AND presence.state='present'
      AND membership.membership_role IN ${FACTION_SHARING_ROLES}
    ORDER BY faction_id LIMIT ?`)
    .all(input.campaignId, input.sessionId, MAX_FACTION_WITNESS_FANOUT) as FactionIdRow[];
  const countObservations = db.prepare(`SELECT COUNT(*) AS count FROM agent_observations
    WHERE campaign_id=? AND agent_kind='faction' AND agent_id=?`);
  const selectWitnessed = db.prepare(`SELECT ${KNOWS_ROW} FROM agent_observations
    WHERE campaign_id=? AND agent_kind='faction' AND agent_id=? AND source_command_id=? AND hop_count=0
      AND relayer_agent_id IS NULL`);
  const recorded: AgentObservation[] = [];
  for (const { faction_id: factionId } of factions) {
    const replayed = selectWitnessed.get(input.campaignId, factionId, input.sourceCommandId) !== undefined;
    if (!replayed && (countObservations.get(input.campaignId, factionId) as CountRow).count >= MAX_OBSERVATIONS_PER_AGENT) continue;
    recorded.push(repository.record({
      campaignId: input.campaignId,
      timelineId: input.timelineId,
      agentKind: "faction",
      agentId: factionId,
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
 * Deterministic per-NPC gossip sampling. The same NPC hears the same pool item
 * every time, but roughly half of the present cast hears any given item, so the
 * pool never implies that "everyone knows".
 */
export function gossipSampleIncluded(npcId: string, sourceCommandId: string): boolean {
  const digest = createHash("sha256").update(`${npcId}\u0000${sourceCommandId}`).digest();
  return (digest[0]! & 1) === 0;
}

/**
 * Adds one campaign-scoped `town` gossip row for a public receipt. The row is
 * explicitly `rumor` authority and is never derived from a private receipt;
 * callers must only wire this to public receipt paths. Idempotent per source
 * command and capped per agent.
 */
export function propagateTownGossipObservations(
  db: DatabaseDriver.Database,
  dependencies: PropagationDependencies,
  input: WitnessObservationInput,
): AgentObservation[] {
  const repository = createAgentObservationRepository(db, dependencies);
  const countObservations = db.prepare(`SELECT COUNT(*) AS count FROM agent_observations
    WHERE campaign_id=? AND agent_kind='town' AND agent_id=?`);
  const selectExisting = db.prepare(`SELECT ${KNOWS_ROW} FROM agent_observations
    WHERE campaign_id=? AND agent_kind='town' AND agent_id=? AND source_command_id=? AND hop_count=0
      AND relayer_agent_id IS NULL`);
  if (selectExisting.get(input.campaignId, TOWN_GOSSIP_AGENT_ID, input.sourceCommandId) !== undefined) return [];
  if ((countObservations.get(input.campaignId, TOWN_GOSSIP_AGENT_ID) as CountRow).count >= MAX_OBSERVATIONS_PER_AGENT) return [];
  return [repository.record({
    campaignId: input.campaignId,
    timelineId: input.timelineId,
    agentKind: "town",
    agentId: TOWN_GOSSIP_AGENT_ID,
    sourceCommandId: input.sourceCommandId,
    observedRevision: input.observedRevision,
    channel: "witnessed",
    hopCount: 0,
    text: input.summary,
    authority: "rumor",
  })];
}

/**
 * Lets present NPCs sample the town gossip pool as `told` hop-1 rows attributed
 * to `town-square` ("you heard it around"). Sampling is deterministic, bounded
 * per NPC, capped by the per-agent write cap, and skips NPCs that already
 * witnessed the underlying event. The caller owns the transaction.
 */
export function propagateGossipToPresentNpcs(
  db: DatabaseDriver.Database,
  dependencies: PropagationDependencies,
  input: GossipSampleInput,
): AgentObservation[] {
  const repository = createAgentObservationRepository(db, dependencies);
  const present = db.prepare(`SELECT npc_id FROM campaign_npc_presence_v43
    WHERE campaign_id=? AND session_id=? AND state='present' ORDER BY npc_id LIMIT ?`)
    .all(input.campaignId, input.sessionId, MAX_GOSSIP_FANOUT) as NpcIdRow[];
  const gossip = db.prepare(`SELECT source_command_id,text,observed_revision FROM agent_observations
    WHERE campaign_id=? AND timeline_id=? AND agent_kind='town' AND agent_id=?
    ORDER BY created_at DESC, observation_id DESC LIMIT ?`)
    .all(input.campaignId, input.timelineId, TOWN_GOSSIP_AGENT_ID, MAX_GOSSIP_SOURCE_ITEMS) as GossipRow[];
  const selectWitnessed = db.prepare(`SELECT ${KNOWS_ROW} FROM agent_observations
    WHERE campaign_id=? AND agent_kind='npc' AND agent_id=? AND source_command_id=? AND hop_count=0`);
  const selectTold = db.prepare(`SELECT ${KNOWS_ROW} FROM agent_observations
    WHERE campaign_id=? AND agent_kind='npc' AND agent_id=? AND source_command_id=? AND hop_count=1
      AND relayer_agent_id=?`);
  const countTold = db.prepare(`SELECT COUNT(*) AS count FROM agent_observations
    WHERE campaign_id=? AND agent_kind='npc' AND agent_id=? AND channel='told' AND relayer_agent_id=?`);
  const countObservations = db.prepare(`SELECT COUNT(*) AS count FROM agent_observations
    WHERE campaign_id=? AND agent_kind='npc' AND agent_id=?`);
  const recorded: AgentObservation[] = [];
  for (const { npc_id: npcId } of present) {
    let sampled = (countTold.get(input.campaignId, npcId, TOWN_GOSSIP_AGENT_ID) as CountRow).count;
    for (const item of gossip) {
      if (sampled >= MAX_GOSSIP_PER_NPC) break;
      if (!gossipSampleIncluded(npcId, item.source_command_id)) continue;
      if (selectWitnessed.get(input.campaignId, npcId, item.source_command_id) !== undefined) continue;
      if (selectTold.get(input.campaignId, npcId, item.source_command_id, TOWN_GOSSIP_AGENT_ID) !== undefined) continue;
      if ((countObservations.get(input.campaignId, npcId) as CountRow).count >= MAX_OBSERVATIONS_PER_AGENT) break;
      recorded.push(repository.record({
        campaignId: input.campaignId,
        timelineId: input.timelineId,
        agentKind: "npc",
        agentId: npcId,
        sourceCommandId: item.source_command_id,
        observedRevision: item.observed_revision,
        channel: "told",
        relayerAgentId: TOWN_GOSSIP_AGENT_ID,
        hopCount: 1,
        text: item.text,
        authority: "rumor",
      }));
      sampled += 1;
    }
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
