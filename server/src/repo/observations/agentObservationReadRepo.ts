import type DatabaseDriver from "better-sqlite3";
import {
  AgentObservationUnavailableError,
  type AgentObservationAuthority,
  type AgentObservationChannel,
  type AgentObservationKind,
} from "./agentObservationRepo.js";

export const NPC_DISCLOSURE_TRUST_THRESHOLD = 0;
export const DEFAULT_AGENT_KNOWLEDGE_LIMIT = 8;
export const MAX_AGENT_KNOWLEDGE_LIMIT = 24;
export const MAX_KNOWLEDGE_QUERY_TERMS = 12;

export interface AgentKnowledgeQuery {
  campaignId: string;
  agentKind: AgentObservationKind;
  agentId: string;
  listenerActorId?: string;
  query?: string;
  limit?: number;
}

export interface AgentKnowledgeEntry {
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
  disclosable: boolean;
}

export interface AgentObservationReadRepository {
  listAgentKnowledge(principalId: string, input: AgentKnowledgeQuery): AgentKnowledgeEntry[];
}

interface AgentKnowledgeRow {
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

interface TrustRow {
  trust: number;
}

const OBSERVATION_COLUMNS = `observation_id,campaign_id,timeline_id,agent_kind,agent_id,source_command_id,
  observed_revision,channel,relayer_agent_id,hop_count,text,authority,created_at`;
const MAX_QUERY_LENGTH = 512;
const MAX_TERM_BYTES = 64;

/** Local mirror of the recall read path's normalization so lexical ranking stays consistent. */
const normalize = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const STOP_WORDS = new Set(
  "a an and are as at be been did do does for from had has have how i in is it me my of on or our recall remember said say that the their them then there these they this to us was we were what when where which who why with you your happened about tell please before after".split(" "),
);

function retainedTerms(query: string | undefined): string[] {
  if (typeof query !== "string") return [];
  const normalized = normalize(query.slice(0, MAX_QUERY_LENGTH));
  const terms: string[] = [];
  for (const term of normalized.split(" ")) {
    if (term.length <= 1 || STOP_WORDS.has(term)) continue;
    if (Buffer.byteLength(term, "utf8") > MAX_TERM_BYTES) continue;
    if (terms.includes(term)) continue;
    terms.push(term);
    if (terms.length >= MAX_KNOWLEDGE_QUERY_TERMS) break;
  }
  return terms;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_AGENT_KNOWLEDGE_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_AGENT_KNOWLEDGE_LIMIT);
}

function requireMembership(db: DatabaseDriver.Database, principalId: string, campaignId: string): void {
  const membership = db.prepare(`SELECT 1 FROM campaign_memberships
    WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')`).get(campaignId, principalId);
  if (!membership) throw new AgentObservationUnavailableError();
}

/**
 * Read-only trust-gated projection of the immutable observation ledger. The
 * caller is authorized in `campaign_memberships` before any observation row is
 * read; rows are scoped to the campaign's active timeline and the requested
 * agent. Disclosure is a classification flag, never a silent row filter.
 */
export function createAgentObservationReadRepository(
  db: DatabaseDriver.Database,
): AgentObservationReadRepository {
  let activeTerms: string[] = [];
  const scoreText = (value: unknown): number => {
    if (typeof value !== "string" || activeTerms.length === 0) return 0;
    const text = ` ${normalize(value)} `;
    let matched = 0;
    for (const term of activeTerms) {
      if (text.includes(` ${term} `)) matched += 1;
    }
    if (matched === 0) return 0;
    return matched * 10 + (text.includes(` ${activeTerms.join(" ")} `) ? 20 : 0);
  };
  db.function("velvet_agent_knowledge_score", { deterministic: true }, scoreText);

  const selectRanked = db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM agent_observations
    WHERE campaign_id=@campaign
      AND timeline_id=(SELECT active_timeline_id FROM campaigns WHERE id=@campaign)
      AND agent_kind=@kind AND agent_id=@agent
      AND velvet_agent_knowledge_score(text)>0
    ORDER BY velvet_agent_knowledge_score(text) DESC,
      CASE authority WHEN 'verified' THEN 0 WHEN 'belief' THEN 1 ELSE 2 END ASC,
      created_at DESC, observation_id ASC
    LIMIT @limit`);
  const selectRecent = db.prepare(`SELECT ${OBSERVATION_COLUMNS} FROM agent_observations
    WHERE campaign_id=@campaign
      AND timeline_id=(SELECT active_timeline_id FROM campaigns WHERE id=@campaign)
      AND agent_kind=@kind AND agent_id=@agent
    ORDER BY created_at DESC, observation_id ASC
    LIMIT @limit`);
  const selectTrust = db.prepare(`SELECT trust FROM campaign_npc_relationships_v32
    WHERE campaign_id=? AND npc_id=? AND actor_id=?`);

  const toEntry = (
    row: AgentKnowledgeRow,
    agentKind: AgentObservationKind,
    listenerActorId: string | null,
  ): AgentKnowledgeEntry => {
    const authority = row.authority as AgentObservationAuthority;
    let disclosable = authority === "verified";
    if (!disclosable && agentKind === "npc" && listenerActorId !== null) {
      // A missing relationship row means no established trust, so it never
      // discloses; an explicit row discloses when trust meets the threshold.
      const relationship = selectTrust.get(row.campaign_id, row.agent_id, listenerActorId) as TrustRow | undefined;
      disclosable = relationship !== undefined && relationship.trust >= NPC_DISCLOSURE_TRUST_THRESHOLD;
    }
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
      authority,
      createdAt: row.created_at,
      disclosable,
    };
  };

  return {
    listAgentKnowledge(principalId, input) {
      requireMembership(db, principalId, input.campaignId);
      const limit = clampLimit(input.limit);
      const terms = retainedTerms(input.query);
      let rows: AgentKnowledgeRow[];
      if (terms.length > 0) {
        activeTerms = terms;
        try {
          rows = selectRanked.all({
            campaign: input.campaignId, kind: input.agentKind, agent: input.agentId, limit,
          }) as AgentKnowledgeRow[];
        } finally {
          activeTerms = [];
        }
      } else {
        rows = selectRecent.all({
          campaign: input.campaignId, kind: input.agentKind, agent: input.agentId, limit,
        }) as AgentKnowledgeRow[];
      }
      const listenerActorId = typeof input.listenerActorId === "string" && input.listenerActorId.length > 0
        ? input.listenerActorId : null;
      return rows.map((row) => toEntry(row, input.agentKind, listenerActorId));
    },
  };
}
