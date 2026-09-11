import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  canonicalAgentJson, campaignDmBeatRequestSchema, campaignDmControlSchema, campaignDmDecisionRequestSchema,
  campaignDmModeRequestSchema, campaignDmRunSchema, campaignDmSelectionSchema, campaignDmCompositionSchema, encounterCreateRequestSchema, enemyTemplateCatalogDefinitionSchema,
  type CampaignDmBeatRequest, type CampaignDmCandidate, type CampaignDmControl, type CampaignDmDecisionRequest,
  type CampaignDmModeRequest, type CampaignDmRun, type CampaignDmSelection,
  campaignDmSceneBindingRequestSchema, type CampaignDmSceneBindingRequest,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../runtime.js";
import type { CampaignAgentContextReadRepository } from "./campaign/campaignAgentContextReadRepo.js";
import type { EncounterRepository } from "./encounterRepo.js";
import type { StoryRepository } from "./storyRepo.js";
import type { CampaignGenerationRepository } from "./campaignGenerationRepo.js";
import type { AdventureTurnRepository } from "./adventureTurnRepo.js";
import type { CampaignAdministrationIntegrationRepository } from "./campaignAdministrationIntegrationRepo.js";
import type { AdventureCheckRepository } from "./adventureCheckRepo.js";
import { boundAdventureQuestReceipts } from "./quest/adventureQuestBinding.js";
import { validDmScene, DM_SCENE_DESCRIPTION_PREFIX } from "../agent/dmNarration.js";
import { publicStorySourceSql, publicStoryResourceSql } from "./storyDisclosure.js";
import { CAMPAIGN_RECALL_MAX_BYTES, type CampaignRecallReadRepository } from "./campaign/campaignRecallReadRepo.js";
import type { DmReadToolRequest, DmReadToolTopic } from "../agent/dmReadTools.js";
import { recordContextInspectionProvenance, type ContextInspectionProvenanceMode } from "./campaign/campaignContextInspectionProvenanceWrite.js";
import { NPC_DISCLOSURE_TRUST_THRESHOLD } from "./observations/agentObservationReadRepo.js";

export class CampaignDmUnavailableError extends Error {}
export class CampaignDmConflictError extends Error {}
const json = (value: unknown) => canonicalAgentJson(value as never);
const hash = (value: unknown) => createHash("sha256").update(json(value)).digest("hex");
const privileged = (role: string | undefined) => role === "owner" || role === "gm";
const MAX_KNOWLEDGE_NPCS = 4;
const MAX_KNOWLEDGE_ENTRIES_PER_NPC = 4;
const MAX_KNOWLEDGE_TEXT_LENGTH = 300;
/** One bounded provider-call deadline for Director planning and narration. */
export const DM_PROVIDER_DEADLINE_MS = 120_000;
type Binding = { candidate: CampaignDmCandidate; target: string; revision: number; data?: any };
type RunRow = {
  run_id: string; campaign_id: string; session_id: string; timeline_id: string;
  principal_id: string; gm_principal_id: string; mode: "human" | "ai"; mode_revision: number;
  intent: "open" | "continue"; request_json: string; context_json: string; candidates_json: string;
  freshness_digest: string; state: CampaignDmRun["state"]; revision: number; proposal_json: string | null;
  blockers_json: string; created_at: string; expires_at: string;
};
export type DmPlanningWork = { runId: string; claimId: string; context: unknown; candidates: CampaignDmCandidate[] };
export type DmNarrationWork = { context: unknown; fallback: string;
  planning: { tokens: number; costUsd: number | null; maxTotalTokens: number; maxCostUsd: number | null } };
export type DmProviderUsage = {source:'provider'|'reserved';promptTokens:number;completionTokens:number;totalTokens:number;costUsd:number|null};
export interface CampaignDmRepository {
  bindDmSceneEvidence(principal: string, campaignId: string, input: CampaignDmSceneBindingRequest): CampaignDmSceneBindingRequest;
  recordDmProviderUsage(principal:string,runId:string,phase:'planning'|'narration',usage:DmProviderUsage):void;
  getDmControl(principal: string, campaignId: string): CampaignDmControl;
  setDmControl(principal: string, campaignId: string, input: CampaignDmModeRequest): CampaignDmControl;
  openDmBeat(principal: string, campaignId: string, sessionId: string, input: CampaignDmBeatRequest): CampaignDmRun;
  getDmRun(principal: string, campaignId: string, sessionId: string, runId: string): CampaignDmRun;
  getDmHistory(principal: string, campaignId: string, sessionId: string): { control: CampaignDmControl; runs: CampaignDmRun[] };
  getDmProposal(principal: string, campaignId: string, sessionId: string, runId: string):
    { run: CampaignDmRun; proposal: CampaignDmCandidate | null; composition: CampaignDmCandidate[] };
  claimDmPlanning(principal: string, runId: string, provider: string, model: string): DmPlanningWork | null;
  bindDmProviderRequest(principal: string, runId: string, claimId: string, request: unknown, promptTokens: number, completionTokens: number): boolean;
  settleDmPlanning(principal: string, runId: string, claimId: string,
    selection: CampaignDmSelection | CampaignDmSelection[] | null,
    usage: { promptTokens: number; completionTokens: number } | null, failed?: boolean): void;
  readDmPlanningGrounding(principal: string, runId: string, request: DmReadToolRequest): { tool: string; summary: string; data: unknown };
  claimDmPlanningRound(principal: string, runId: string, round: 1 | 2, provider: string, model: string, request: unknown,
    promptTokens: number, completionTokens: number): { claimId: string } | null;
  settleDmPlanningRound(principal: string, runId: string, claimId: string, response: unknown,
    usage: { promptTokens: number; completionTokens: number } | null, failed?: boolean): void;
  executeDmBeat(principal: string, runId: string): CampaignDmRun;
  decideDmBeat(principal: string, campaignId: string, sessionId: string, runId: string, input: CampaignDmDecisionRequest): CampaignDmRun;
  blockDmBeat(principal: string, runId: string, code: string): void;
  getDmNarrationWork(principal: string, runId: string): DmNarrationWork | null;
  hasDmNarrationJob(principal: string, runId: string): boolean;
  claimDmNarration(principal: string, runId: string, provider: string, model: string, request: unknown,
    promptTokens: number, completionTokens: number): string | null;
  settleDmNarration(principal: string, runId: string, claimId: string | null, scene: string | null, outcome: string): void;
}
type Services = CampaignAgentContextReadRepository & CampaignRecallReadRepository & Pick<EncounterRepository,
  "listEncounters" | "getCombatState" | "createEncounter" | "startEncounter" | "endCombat" | "executeCombatEnemyTurn" | "resolveCombatAction" | "getEncounterSetupCandidates">
  & StoryRepository & Pick<CampaignGenerationRepository, "getCampaignGeneratedPlanning">
  & Pick<AdventureTurnRepository, "getAdventureTurn" | "getAdventureTurnNarration" | "getAgentCombatReceipt">
  & Pick<AdventureCheckRepository, "getAdventureCheckPublicReceipt">
  & Pick<CampaignAdministrationIntegrationRepository, "getSessionZeroSafetyPolicy">;

/** Private director aggregate. No player-turn proposal or transcript is used for GM state. */
export function createCampaignDmRepository(db: DatabaseDriver.Database, deps: { clock: Clock; ids: IdGenerator; contextInspectionProvenance: ContextInspectionProvenanceMode }, services: Services,
  guard: () => void): CampaignDmRepository {
  const now = () => deps.clock.now().toISOString();
  const role = (p: string, c: string) => (db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(c, p) as { role: string } | undefined)?.role;
  const member = (p: string, c: string) => { if (!role(p, c)) throw new CampaignDmUnavailableError(); };
  const gm = (p: string, c: string) => { if (!privileged(role(p, c))) throw new CampaignDmUnavailableError(); };
  const publicSource = (c:string,id:string) => Boolean(db.prepare(`SELECT 1 WHERE ${publicStoryResourceSql('$campaignId','$resourceId')}`)
    .get({campaignId:c,resourceId:id}));
  /** Normalizes a stored proposal (legacy single object or ordered array) to a composition. */
  const compositionOf = (value: unknown): CampaignDmSelection[] => value === null || value === undefined ? []
    : Array.isArray(value) ? campaignDmCompositionSchema.parse(value) : [campaignDmSelectionSchema.parse(value)];
  const receiptList = (value: string): any[] => {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  };
  /** Ordered committed receipts for a run; composition table first, legacy single row as fallback. */
  const receiptsFor = (runId: string): any[] => {
    const rows = db.prepare("SELECT public_json FROM dm_composition_receipts WHERE run_id=? ORDER BY ordinal").all(runId) as { public_json: string }[];
    if (rows.length) return rows.map(row => JSON.parse(row.public_json));
    const legacy = db.prepare("SELECT public_json FROM dm_receipts WHERE run_id=?").get(runId) as { public_json: string } | undefined;
    return legacy ? receiptList(legacy.public_json) : [];
  };
  const safePublicRun = (r:RunRow) => {
    if(!r.proposal_json)return true;
    const bindings=JSON.parse(r.candidates_json) as Binding[];
    return compositionOf(JSON.parse(r.proposal_json)).every(selection=>{
      const binding=bindings.find(item=>item.candidate.candidateId===selection.candidateId);
      return !binding||!['reveal-node','resolve-node','reveal-clue'].includes(binding.candidate.action)||publicSource(r.campaign_id,binding.target);
    });
  };
  const control = (c: string) => (db.prepare("SELECT mode,revision,delegator FROM dm_control WHERE campaign_id=?").get(c) as
    { mode: "human" | "ai"; revision: number; delegator: string | null } | undefined) ?? { mode: "human" as const, revision: 0, delegator: null };
  const room = (p: string, c: string, s: string) => {
    member(p, c);
    if (!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(c, s)) throw new CampaignDmUnavailableError();
  };
  const row = (id: string) => {
    const value = db.prepare("SELECT * FROM dm_runs WHERE run_id=?").get(id) as RunRow | undefined;
    if (!value) throw new CampaignDmUnavailableError(); return value;
  };
  const triggerAuthority = (p: string, r: RunRow) => {
    room(p, r.campaign_id, r.session_id);
    if (!privileged(role(p, r.campaign_id)) && p !== r.principal_id) throw new CampaignDmUnavailableError();
  };
  const pathRow = (p: string, c: string, s: string, id: string) => {
    room(p, c, s); const r = row(id);
    if (r.campaign_id !== c || r.session_id !== s) throw new CampaignDmUnavailableError(); return r;
  };
  const project = (r: RunRow): CampaignDmRun => {
    const safe=safePublicRun(r);
    const history = db.prepare("SELECT narration FROM dm_public_history WHERE run_id=?").get(r.run_id) as { narration: string } | undefined;
    const narrating = db.prepare("SELECT 1 FROM dm_narration_jobs WHERE run_id=?").get(r.run_id);
    return campaignDmRunSchema.parse({ runId: r.run_id, campaignId: r.campaign_id, sessionId: r.session_id,
      mode: r.mode, modeRevision: r.mode_revision, intent: r.intent, revision: r.revision,
      state: !safe ? 'blocked' : narrating && r.state === "awaiting-approval" ? "planning" : r.state,
      narration: safe ? history?.narration ?? null : null, receipts: safe ? receiptsFor(r.run_id) : [],
      blockers: safe ? JSON.parse(r.blockers_json) : ['story-public-rendering-required'], createdAt: r.created_at });
  };
  const stop = (r: RunRow, state: "blocked" | "cancelled" | "unknown", code: string) => {
    db.prepare("UPDATE dm_runs SET state=?,blockers_json=?,revision=revision+1 WHERE run_id=? AND state IN ('planning','awaiting-approval')")
      .run(state, json([code]), r.run_id);
  };
  const holdNarration = (r: RunRow) => {
    const visible = db.prepare(`SELECT node.title,node.description FROM story_nodes_v34 node
      JOIN story_node_state_v34 state USING(campaign_id,storyline_id,node_id)
      WHERE node.campaign_id=? AND state.status='revealed' AND ${publicStorySourceSql('node','node_id')}
      ORDER BY state.updated_at DESC,node.node_id LIMIT 1`).get(r.campaign_id) as
      { title: string; description: string | null } | undefined;
    return `${visible ? `${visible.title}. ${visible.description ?? ""} ` : "The scene holds. "}Choose your next action. No campaign change is established by this beat.`.slice(0,8000);
  };
  function active(r: RunRow): boolean {
    const current = control(r.campaign_id);
    const session = db.prepare("SELECT state,stopped_at FROM sessions WHERE id=?").get(r.session_id) as any;
    const campaign = db.prepare("SELECT active_timeline_id,lifecycle_status FROM campaigns WHERE id=?").get(r.campaign_id) as any;
    return current.mode === r.mode && current.revision === r.mode_revision && privileged(role(r.gm_principal_id, r.campaign_id))
      && (r.mode === "human" || current.delegator === r.gm_principal_id)
      && ["owner", "gm", "player"].includes(role(r.principal_id, r.campaign_id) ?? "")
      && Boolean(db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(r.campaign_id, r.session_id))
      && campaign?.active_timeline_id === r.timeline_id && ["draft", "published"].includes(campaign.lifecycle_status)
      && session?.state === "active" && session.stopped_at === null
      && services.getSessionZeroSafetyPolicy(r.gm_principal_id, r.campaign_id)?.paused === false;
  }
  function recordedUsageAllowed(id:string,phase:'planning'|'narration'):boolean {
    const usage=db.prepare('SELECT * FROM dm_review_provider_usage WHERE run_id=? AND phase=?').get(id,phase) as any;
    if(!usage)return true;
    const request=db.prepare(phase==='planning'?'SELECT * FROM dm_provider_requests WHERE run_id=?':'SELECT * FROM dm_narration_dispatches WHERE run_id=?').get(id) as any;
    const budget=request?JSON.parse(request.request_json).budget:undefined;
    if(usage.total_tokens!==usage.prompt_tokens+usage.completion_tokens
      ||usage.prompt_tokens>(request?.reserved_prompt_tokens??23744)||usage.completion_tokens>(request?.reserved_completion_tokens??256))return false;
    const previous=phase==='narration'?db.prepare("SELECT * FROM dm_review_provider_usage WHERE run_id=? AND phase='planning'").get(id) as any:null;
    if(usage.total_tokens+(previous?.total_tokens??0)>(budget?.maxTotalTokens??24000))return false;
    return budget?.maxCostUsd==null||(usage.cost_usd!==null&&(!previous||previous.cost_usd!==null)&&usage.cost_usd+(previous?.cost_usd??0)<=budget.maxCostUsd);
  }
  const boundedSummary = (value: string): string => {
    let text = value;
    while (Buffer.byteLength(text, "utf8") > 6000) text = text.slice(0, Math.max(0, text.length - 256));
    return text;
  };
  const requestBudget = (value: string | null | undefined): any => {
    try { return JSON.parse(value ?? "{}").budget; } catch { return undefined; }
  };
  const roundTokens = (row: any) => row.prompt_tokens !== null && row.completion_tokens !== null
    ? row.prompt_tokens + row.completion_tokens : row.reserved_prompt_tokens + row.reserved_completion_tokens;
  const roundCost = (row: any): number | null => row.cost_usd ?? (requestBudget(row.request_json)?.costUsd ?? null);
  /** Aggregate round-0 usage plus every stored planning round; excludes one claim when settling it. */
  const planningAggregate = (id: string, excludeClaim?: string) => {
    const usage = db.prepare("SELECT * FROM dm_review_provider_usage WHERE run_id=? AND phase='planning'").get(id) as any;
    const request = db.prepare("SELECT reserved_prompt_tokens,reserved_completion_tokens,request_json FROM dm_provider_requests WHERE run_id=?").get(id) as any;
    const budget = request ? requestBudget(request.request_json) : undefined;
    const reservedTokens = request ? request.reserved_prompt_tokens + request.reserved_completion_tokens : 0;
    const reservedCost = request ? (budget?.costUsd ?? null) : null;
    // Known actual usage is charged as-is; an unknown or in-flight round charges its full reservation.
    let tokens = usage?.total_tokens ?? reservedTokens;
    let cost: number | null = usage ? (usage.cost_usd ?? null) : reservedCost;
    for (const row of db.prepare("SELECT * FROM dm_planning_rounds WHERE run_id=? ORDER BY round").all(id) as any[]) {
      if (excludeClaim && row.claim_id === excludeClaim) continue;
      tokens += roundTokens(row);
      const value = roundCost(row);
      if (value === null) cost = null; else if (cost !== null) cost += value;
    }
    return { tokens, cost, budget };
  };
  /** A server-fixed query per closed recall topic; model text never enters this string. */
  const recallTopicQuery = (r: RunRow, topic: DmReadToolTopic): string => {
    if (topic === "recent-outcomes") return "recent committed outcomes";
    if (topic === "public-locations") return (db.prepare(`SELECT DISTINCT location.public_name name FROM campaign_actor_locations_v28 current
      JOIN campaign_locations_v28 location ON location.campaign_id=current.campaign_id AND location.location_id=current.location_id
      WHERE current.campaign_id=? AND current.session_id=? AND location.visibility='public'
      ORDER BY location.public_name LIMIT 12`).all(r.campaign_id, r.session_id) as { name: string }[]).map(row => row.name).join(" ");
    if (topic === "present-cast") return (db.prepare(`SELECT npc.public_name name FROM campaign_npc_presence_v43 presence JOIN campaign_npcs_v28 npc USING(campaign_id,npc_id)
      WHERE presence.campaign_id=? AND presence.session_id=? AND presence.state='present'
        AND NOT EXISTS(SELECT 1 FROM campaign_generation_accepted_artifacts_v52 hidden WHERE hidden.campaign_id=npc.campaign_id
          AND hidden.server_resource_id=npc.npc_id AND hidden.visibility='gm')
        AND (presence.location_id IS NULL OR EXISTS(SELECT 1 FROM campaign_actor_locations_v28 current
          JOIN campaign_locations_v28 location ON location.campaign_id=current.campaign_id AND location.location_id=current.location_id
          WHERE current.campaign_id=presence.campaign_id AND current.session_id=presence.session_id
            AND current.location_id=presence.location_id AND location.visibility='public'))
      ORDER BY npc.npc_id LIMIT 12`).all(r.campaign_id, r.session_id) as { name: string }[]).map(row => row.name).join(" ");
    const context = JSON.parse(r.context_json) as { context?: { visibleWorld?: unknown } } | null;
    const visible = Array.isArray(context?.context?.visibleWorld) ? context!.context!.visibleWorld.filter((value): value is string => typeof value === "string") : [];
    const titles = (db.prepare(`SELECT node.title FROM story_nodes_v34 node JOIN story_node_state_v34 state USING(campaign_id,storyline_id,node_id)
      WHERE node.campaign_id=? AND state.status='revealed' AND ${publicStorySourceSql("node","node_id")}
      ORDER BY state.updated_at DESC,node.node_id LIMIT 8`).all(r.campaign_id) as { title: string }[]).map(row => row.title);
    return [...titles, ...visible].join(" ").slice(0, 512);
  };
  const boundRecall = (hits: { sourceKind: string; text: string }[], incomplete: boolean, query: string) => {
    const payload: { query: string; hits: { sourceKind: string; text: string }[]; incomplete: boolean } = { query, hits: [], incomplete };
    for (const hit of hits.slice(0, 8)) {
      const entry = { sourceKind: hit.sourceKind, text: hit.text.slice(0, 2048) };
      payload.hits.push(entry);
      while (Buffer.byteLength(json(payload), "utf8") > CAMPAIGN_RECALL_MAX_BYTES && entry.text.length) {
        entry.text = entry.text.slice(0, Math.max(0, entry.text.length - 128));
      }
      if (Buffer.byteLength(json(payload), "utf8") > CAMPAIGN_RECALL_MAX_BYTES) payload.hits.pop();
    }
    return payload;
  };
  const decisionSelection = (response: unknown): CampaignDmSelection[] | null | undefined => {
    if (response === null || typeof response !== "object" || Array.isArray(response) || !("selection" in response)) return undefined;
    const selection = (response as { selection?: unknown }).selection;
    return selection === null || selection === undefined ? null : campaignDmCompositionSchema.parse(selection);
  };
  /** Run-level planning settlement shared by grounded rounds; round 0 keeps its own dispatch path. */
  function finalizePlanning(r: RunRow, normalized: CampaignDmSelection[] | null): void {
    if (r.state !== "planning") return;
    if (!active(r)) { stop(r, "cancelled", "authority-safety-or-mode-changed"); return; }
    if (snapshot(r.gm_principal_id, r.campaign_id, r.session_id, JSON.parse(r.request_json)).freshness !== r.freshness_digest) {
      stop(r, "blocked", "proposal-stale-request-new-beat"); return;
    }
    if (normalized) {
      const bindings = JSON.parse(r.candidates_json) as Binding[];
      if (!normalized.every(selection => bindings.some(b => b.candidate.candidateId === selection.candidateId && b.candidate.digest === selection.digest)))
        throw new CampaignDmConflictError("unadvertised candidate");
    }
    if (!normalized) { queueNarration(r, holdNarration(r)); db.prepare("UPDATE dm_runs SET revision=revision+1 WHERE run_id=?").run(r.run_id); return; }
    db.prepare("UPDATE dm_runs SET state='awaiting-approval',proposal_json=?,revision=revision+1 WHERE run_id=?").run(json(normalized), r.run_id);
  }
  function publicScene(r: RunRow) {
    // Explicit public columns only. Never load a DM snapshot or an artifact's full JSON here.
    const locations = db.prepare(`SELECT DISTINCT location.public_name name,location.public_description description,
      (SELECT json_extract(artifact.canonical_json,'$.atmosphere') FROM campaign_generation_accepted_artifacts_v52 artifact
       WHERE artifact.campaign_id=location.campaign_id AND artifact.server_resource_id=location.location_id
         AND artifact.artifact_kind='location' AND artifact.visibility='public' LIMIT 1) atmosphere
      FROM campaign_actor_locations_v28 current JOIN campaign_locations_v28 location
        ON location.campaign_id=current.campaign_id AND location.location_id=current.location_id
      WHERE current.campaign_id=? AND current.session_id=? AND location.visibility='public'
      ORDER BY location.public_name LIMIT 4`).all(r.campaign_id,r.session_id);
    const cast = db.prepare(`SELECT npc.public_name name,json_extract(metadata.public_state_json,'$.description') description,
      (SELECT json_extract(artifact.canonical_json,'$.archetype') FROM campaign_generation_accepted_artifacts_v52 artifact
        WHERE artifact.campaign_id=npc.campaign_id AND artifact.server_resource_id=npc.npc_id
          AND artifact.artifact_kind='npc' AND artifact.visibility='public' LIMIT 1) portrayal
      FROM campaign_npc_presence_v43 presence JOIN campaign_npcs_v28 npc USING(campaign_id,npc_id)
      LEFT JOIN campaign_npc_metadata_v32 metadata ON metadata.campaign_id=npc.campaign_id AND metadata.npc_id=npc.npc_id
      WHERE presence.campaign_id=? AND presence.session_id=? AND presence.state='present'
        AND NOT EXISTS(SELECT 1 FROM campaign_generation_accepted_artifacts_v52 hidden WHERE hidden.campaign_id=npc.campaign_id
          AND hidden.server_resource_id=npc.npc_id AND hidden.visibility='gm')
        AND (presence.location_id IS NULL OR EXISTS(SELECT 1 FROM campaign_actor_locations_v28 current
          JOIN campaign_locations_v28 location ON location.campaign_id=current.campaign_id AND location.location_id=current.location_id
          WHERE current.campaign_id=presence.campaign_id AND current.session_id=presence.session_id
            AND current.location_id=presence.location_id AND location.visibility='public'))
      ORDER BY npc.npc_id LIMIT 6`).all(r.campaign_id,r.session_id);
    const scenes = db.prepare(`SELECT node.title,node.description,state.status FROM story_nodes_v34 node
      JOIN story_node_state_v34 state USING(campaign_id,storyline_id,node_id)
      WHERE node.campaign_id=? AND state.status<>'hidden' AND ${publicStorySourceSql('node','node_id')}
      ORDER BY state.updated_at DESC,node.node_id LIMIT 6`).all(r.campaign_id);
    const clues = db.prepare(`SELECT clue.title,clue.content FROM story_clues_v34 clue
      JOIN story_discoveries_v34 discovery USING(campaign_id,storyline_id,clue_id)
      WHERE clue.campaign_id=? AND ${publicStorySourceSql('clue','clue_id')}
      ORDER BY discovery.discovered_at DESC,clue.clue_id LIMIT 6`).all(r.campaign_id);
    const materials = db.prepare(`SELECT json_extract(artifact.canonical_json,'$.title') title,
      CASE artifact.artifact_kind WHEN 'handout' THEN json_extract(artifact.canonical_json,'$.content')
        ELSE json_extract(artifact.canonical_json,'$.prompt') END content
      FROM campaign_material_deliveries_v53 delivery JOIN campaign_generation_accepted_artifacts_v52 artifact USING(campaign_id,artifact_key)
      WHERE artifact.campaign_id=? AND artifact.visibility='public' AND artifact.artifact_kind IN ('handout','scene-prompt')
      ORDER BY delivery.published_at DESC,artifact.artifact_key LIMIT 2`).all(r.campaign_id);
    // Generated prose is presentation, not canonical memory. Only verified receipt summaries recur.
    const history = (db.prepare(`SELECT COALESCE(
        (SELECT json_extract(json_group_array(json_extract(composition.public_json,'$.summary')),'$[#-1]')
          FROM dm_composition_receipts composition WHERE composition.run_id=run.run_id),
        json_extract(receipt.public_json,'$.summary')) narration
      FROM dm_public_history history JOIN dm_runs run USING(run_id) JOIN dm_receipts receipt USING(run_id)
      WHERE run.campaign_id=? AND run.session_id=? AND run.timeline_id=? AND run.run_id<>?
      AND NOT EXISTS(SELECT 1 FROM json_each(run.candidates_json) binding
        JOIN json_each(CASE WHEN json_type(run.proposal_json)='array' THEN run.proposal_json ELSE json_array(run.proposal_json) END) selection
          ON json_extract(selection.value,'$.candidateId')=json_extract(binding.value,'$.candidate.candidateId')
        WHERE json_extract(binding.value,'$.candidate.action') IN ('reveal-node','resolve-node','reveal-clue')
          AND NOT (${publicStoryResourceSql('run.campaign_id',"json_extract(binding.value,'$.target')")}))
      ORDER BY history.rowid DESC LIMIT 4`).all(r.campaign_id,r.session_id,r.timeline_id,r.run_id) as {narration:string|null}[])
      .filter((item):item is {narration:string}=>typeof item.narration==="string")
      .reverse().map(item=>item.narration.slice(0,2000));
    const players=db.prepare(`SELECT DISTINCT persona.name FROM session_characters participant JOIN characters persona ON persona.id=participant.character_id
      JOIN campaign_characters character ON character.character_id=persona.id AND character.campaign_id=?
      JOIN campaign_actors actor ON actor.campaign_character_id=character.id AND actor.campaign_id=character.campaign_id
      WHERE participant.session_id=? ORDER BY persona.name LIMIT 12`).all(r.campaign_id,r.session_id);
    const safety = services.getSessionZeroSafetyPolicy(r.gm_principal_id,r.campaign_id);
    const facts = (values: unknown[]) => values.map(value=>Object.fromEntries(Object.entries(value as Record<string,unknown>)
      .map(([key,text])=>[key,typeof text==='string'?text.slice(0,1000):text])));
    const historicalRecall = services.getCampaignRecall(r.gm_principal_id, { campaignId: r.campaign_id, sessionId: r.session_id,
      audience: { kind: "dm" }, purpose: "dm-narration", query: JSON.stringify({ scenes, locations }).slice(0, 512) });
    if (!historicalRecall) throw new CampaignDmConflictError("public recall authority unavailable");
    // Same present public cast source as above: present, public location-gated, and not GM-hidden.
    const npcKnowledge = (db.prepare(`SELECT npc.npc_id npcId,npc.public_name npcName
      FROM campaign_npc_presence_v43 presence JOIN campaign_npcs_v28 npc USING(campaign_id,npc_id)
      WHERE presence.campaign_id=? AND presence.session_id=? AND presence.state='present'
        AND NOT EXISTS(SELECT 1 FROM campaign_generation_accepted_artifacts_v52 hidden WHERE hidden.campaign_id=npc.campaign_id
          AND hidden.server_resource_id=npc.npc_id AND hidden.visibility='gm')
        AND (presence.location_id IS NULL OR EXISTS(SELECT 1 FROM campaign_actor_locations_v28 current
          JOIN campaign_locations_v28 location ON location.campaign_id=current.campaign_id AND location.location_id=current.location_id
          WHERE current.campaign_id=presence.campaign_id AND current.session_id=presence.session_id
            AND current.location_id=presence.location_id AND location.visibility='public'))
      ORDER BY npc.npc_id LIMIT ?`).all(r.campaign_id,r.session_id,MAX_KNOWLEDGE_NPCS) as {npcId:string;npcName:string}[])
      .map(({npcId,npcName})=>{
        // A missing relationship row never qualifies; any session-participating actor at or
        // above the disclosure threshold authorizes this NPC's hearsay for the narrator.
        const trusted = Boolean(db.prepare(`SELECT 1 FROM campaign_npc_relationships_v32 relationship
          WHERE relationship.campaign_id=? AND relationship.npc_id=? AND relationship.trust>=?
            AND relationship.actor_id IN (SELECT actor.id FROM session_characters participant
              JOIN campaign_characters character ON character.character_id=participant.character_id AND character.campaign_id=?
              JOIN campaign_actors actor ON actor.campaign_character_id=character.id AND actor.campaign_id=character.campaign_id
              WHERE participant.session_id=?) LIMIT 1`).get(r.campaign_id,npcId,NPC_DISCLOSURE_TRUST_THRESHOLD,r.campaign_id,r.session_id));
        const entries = (db.prepare(`SELECT text,channel,authority,relayer_agent_id relayerNpcId FROM agent_observations
          WHERE campaign_id=? AND agent_kind='npc' AND agent_id=?
            AND timeline_id=(SELECT active_timeline_id FROM campaigns WHERE id=?)
          ORDER BY created_at DESC, observation_id ASC`).all(r.campaign_id,npcId,r.campaign_id) as
          {text:string;channel:string;authority:string;relayerNpcId:string|null}[])
          .filter(entry=>entry.authority==='verified'||trusted)
          .slice(0,MAX_KNOWLEDGE_ENTRIES_PER_NPC)
          .map(entry=>({...entry,text:entry.text.slice(0,MAX_KNOWLEDGE_TEXT_LENGTH)}));
        return { npcId, npcName, entries };
      })
      .filter(({entries})=>entries.length>0);
    return { locations:facts(locations),cast:facts(cast),players:facts(players),scenes:facts(scenes),clues:facts(clues),materials:facts(materials),history,historicalRecall,npcKnowledge,
      receipts:receiptsFor(r.run_id),safety };
  }
  const narrationGuard = (r:RunRow, context:unknown) => hash({context,
    campaign:db.prepare("SELECT administration_revision,active_timeline_id,lifecycle_status FROM campaigns WHERE id=?").get(r.campaign_id),
    timeline:db.prepare("SELECT revision FROM campaign_timelines WHERE id=? AND campaign_id=?").get(r.timeline_id,r.campaign_id),
    combat:db.prepare("SELECT encounter_id,state_revision,status FROM encounter WHERE campaign_id=? AND session_id=? ORDER BY encounter_id").all(r.campaign_id,r.session_id),
  });
  const queueNarration = (r:RunRow,fallback:string) => {
    const context=publicScene(r);
    db.prepare("INSERT INTO dm_narration_jobs VALUES(?,?,?,?)").run(r.run_id,json(context),narrationGuard(r,context),fallback);
  };
  function publishNarration(r:RunRow, job:any, dispatch:any) {
    if(!["planning","awaiting-approval"].includes(r.state))return;
    if(!active(r)){stop(r,"cancelled","authority-safety-or-mode-changed");return;}
    if(narrationGuard(r,publicScene(r))!==job.guard_digest){stop(r,"blocked","public-scene-changed-before-narration");return;}
    // Recheck previously sealed provider prose on recovery too; a sealed model result is not canon.
    const prefix=`${job.fallback}\n\n`;
    const addition=dispatch.narration.startsWith(prefix)?dispatch.narration.slice(prefix.length).replace(DM_SCENE_DESCRIPTION_PREFIX,''):'';
    const text=dispatch.source==='provider-assisted'&&validDmScene(addition,JSON.parse(job.public_context_json))
      ?`${prefix}${DM_SCENE_DESCRIPTION_PREFIX}${addition}`:job.fallback;
    db.prepare("INSERT INTO dm_public_history VALUES(?,?,?)").run(r.run_id,text,now());
    db.prepare("UPDATE dm_runs SET state='completed',revision=revision+1 WHERE run_id=?").run(r.run_id);
  }
  function snapshot(g: string, c: string, s: string, input: CampaignDmBeatRequest) {
    const context = services.getCampaignAgentContextSnapshot(g, c, s, { kind: "dm" });
    if (!context?.ruleset) throw new CampaignDmConflictError("room context unavailable");
    const story = services.getCampaignStory(g, c);
    const graph = story?.story && "nodes" in story.story ? story.story : null;
    const safety = services.getSessionZeroSafetyPolicy(g, c);
    const encounters = (services.listEncounters(g, c) ?? []).filter(e => e.sessionId === s);
    const open = encounters.find(e => e.status === "preparing" || e.status === "active");
    const bindings: Binding[] = [], blockers: string[] = [];
    const add = (action: CampaignDmCandidate["action"], label: string, target: string, revision: number, data?: any) => {
      const command = { campaignId: c, sessionId: s, timelineId: context.timelineId, modeRevision: control(c).revision,
        action, target, revision, data: data ?? null };
      const digest = hash(command);
      bindings.push({ candidate: { candidateId: `dm-candidate:${digest.slice(0,40)}`, digest, action, label: label.slice(0,500) }, target, revision, ...(data === undefined ? {} : { data }) });
    };
    let evidence: { turnId: string; intent: string; facts: unknown[]; receiptIds: string[]; sources:Array<{kind:string;targetId:string}> } | null = null;
    if (input.evidenceTurnId) {
      const turn = services.getAdventureTurn(g, input.evidenceTurnId);
      if (turn && turn.campaignId === c && turn.sessionId === s && turn.timelineId === context.timelineId
        && turn.mode === "original" && turn.state === "completed" && turn.receiptLinks.length
        && !db.prepare("SELECT 1 FROM dm_story_evidence WHERE campaign_id=? AND turn_id=?").get(c, turn.turnId)) {
        const checks = turn.receiptLinks.flatMap(link => {
          const check = services.getAdventureCheckPublicReceipt(g, c, link.commandId);
          return check?.outcome === "success" ? [check] : [];
        });
        const completedObjectives = boundAdventureQuestReceipts(db, c, turn.turnId).filter(receipt => receipt.progressAfter >= receipt.targetProgress);
        const quests = completedObjectives.map(receipt => ({ quest: receipt.questTitle, objective: receipt.objectiveDescription, progress: receipt.progressAfter }));
        const completedEncounters:string[]=[];
        const victories = turn.receiptLinks.flatMap(link => {
          const combatReceipt = services.getAgentCombatReceipt(g, c, link.commandId);
          const resolution = combatReceipt?.resolution as any;
          if(!resolution?.outcomes?.some((outcome: any) => outcome.kind === "damage" && outcome.statusAfter === "defeated"))return [];
          const encounter=db.prepare(`SELECT encounter.encounter_id FROM combat_commands_v27 command JOIN encounter USING(encounter_id)
            WHERE command.command_id=? AND encounter.campaign_id=? AND encounter.session_id=? AND encounter.status='completed'`).get(link.commandId,c,s) as {encounter_id:string}|undefined;
          if(encounter)completedEncounters.push(encounter.encounter_id);
          return [resolution];
        });
        const facts = [...checks, ...quests, ...victories];
        if (facts.length) evidence = { turnId: turn.turnId, intent: "declaration" in turn ? turn.declaration : "", facts,
          receiptIds: turn.receiptLinks.map(link => link.commandId),sources:[
            ...(checks.length?[{kind:'check-turn',targetId:turn.turnId}]:[]),
            ...completedObjectives.map(receipt=>({kind:'quest-objective',targetId:receipt.objectiveId})),
            ...completedEncounters.map(targetId=>({kind:'encounter',targetId})),
          ] };
        else blockers.push("evidence-needs-successful-check-objective-or-defeat");
      } else blockers.push("evidence-unavailable-or-already-used");
    }
    let combat = null;
    if (open?.status === "preparing") add("encounter-start", `Start prepared encounter: ${open.name}`, open.encounterId, open.revision);
    if (open?.status === "active") {
      combat = services.getCombatState(g, open.encounterId);
      if (combat?.currentCombatant === null) add("encounter-complete", "Complete terminal encounter; rewards become available, not claimed", open.encounterId, combat.revision);
      else if (combat?.combatants.find(item => item.combatantId === combat!.currentCombatant)?.kind === "enemy") {
        const legacyAction = context.ruleset.id === "dnd-5e" ? null : combat.legalActions.find(action => action.kind === "attack") ?? combat.legalActions.find(action => action.kind === "end-turn");
        add("enemy-turn", "Resolve the current enemy's authoritative turn", open.encounterId, combat.revision,
          { ruleset: context.ruleset.id, legacyAction: legacyAction ?? null });
      } else blockers.push("waiting-for-player-combat-action");
    }
    const planning = services.getCampaignGeneratedPlanning(g, c);
    const locations = db.prepare("SELECT actor_id,location_id,state_revision FROM campaign_actor_locations_v28 WHERE campaign_id=? AND session_id=? ORDER BY actor_id").all(c, s);
    if (!open) {
      const setup = services.getEncounterSetupCandidates(g, c);
      for (const plan of planning?.encounters ?? []) {
        if (db.prepare("SELECT 1 FROM dm_encounter_bindings WHERE campaign_id=? AND artifact_key=?").get(c, plan.artifactKey)) continue;
        const actors = (db.prepare(`SELECT actor.id FROM campaign_actors actor JOIN campaign_characters cc ON cc.id=actor.campaign_character_id
          JOIN session_characters sc ON sc.character_id=cc.character_id AND sc.session_id=?
          JOIN campaign_actor_locations_v28 location ON location.actor_id=actor.id AND location.campaign_id=actor.campaign_id AND location.session_id=?
          WHERE actor.campaign_id=? AND location.location_id=? ORDER BY actor.id`).all(s, s, c, plan.locationId) as { id: string }[]).map(a => a.id);
        if (!plan.locationId || !actors.length) continue;
        if (!plan.enemyReferences.length || plan.monsterConceptIds.length || plan.participantNpcIds.length
          || actors.some(actorId => !setup?.actors.some(actor => actor.actorId === actorId))
          || plan.enemyReferences.some(ref => {
            // GM preparation may reference private catalog enemies absent from the public setup picker.
            const definition = db.prepare(`SELECT definition.definition_json FROM rpg_catalog_definitions definition
              JOIN campaign_catalog_current_pins pin ON pin.pack_id=definition.pack_id AND pin.pack_version=definition.pack_version
              WHERE pin.campaign_id=? AND definition.pack_id=? AND definition.pack_version=? AND definition.kind='enemy-template' AND definition.definition_id=?`)
              .get(c, ref.packId, ref.packVersion, ref.definitionId) as { definition_json: string } | undefined;
            if (!definition) return true;
            const parsed = enemyTemplateCatalogDefinitionSchema.safeParse(JSON.parse(definition.definition_json));
            return !parsed.success || json(parsed.data.reference) !== json(ref);
          })) {
          blockers.push("encounter-preparation-requires-exact-catalog-roster"); continue;
        }
        const prepared = encounterCreateRequestSchema.safeParse({ sessionId: s, name: "Campaign encounter",
          combatants: [...actors.map(actorId => ({ kind: "actor", actorId, team: "allies" })),
            ...plan.enemyReferences.map(template => ({ kind: "enemy", template, team: "enemies" }))], idempotencyKey: "director-preview" });
        if (prepared.success) add("encounter-materialize", `Prepare and start accepted encounter: ${plan.title}`, plan.artifactKey, 0, prepared.data);
        else blockers.push("encounter-preparation-requires-exact-catalog-roster");
      }
      for (const node of graph?.nodes ?? []) {
        if(!publicSource(c,node.nodeId)){blockers.push('story-public-rendering-required');continue;}
        const incoming = graph!.edges.filter(edge => edge.toNodeId === node.nodeId);
        const unresolved = incoming.some(edge => edge.kind === "requires" && (!publicSource(c,edge.fromNodeId)||graph!.nodes.find(n => n.nodeId === edge.fromNodeId)?.status !== "resolved"));
        const resolved = incoming.filter(edge => publicSource(c,edge.fromNodeId)&&graph!.nodes.find(n => n.nodeId === edge.fromNodeId)?.status === "resolved").length;
        if (unresolved) continue;
        if (node.status === "hidden" && resolved >= node.revealThreshold) add("reveal-node", `Reveal scene: ${node.title}`, node.nodeId, story!.revision, { storylineId: node.storylineId });
        // A declaration alone is not evidence. One committed turn can adjudicate at most one resolution.
        const evidenceTurn = evidence ? services.getAdventureTurn(g, evidence.turnId) : null;
        if(node.status==='revealed'){
          const freshEvidence=evidence&&evidenceTurn&&evidenceTurn.createdAt>node.updatedAt?evidence:null;
          const bound=freshEvidence&&freshEvidence.sources.some(source=>db.prepare(`SELECT 1 FROM dm_review_scene_bindings
            WHERE campaign_id=? AND node_id=? AND evidence_kind=? AND target_id=?`).get(c,node.nodeId,source.kind,source.targetId));
          if(control(c).mode==='human'||bound)add('resolve-node',`${bound?'Resolve bound scene':'Human adjudication required for scene'}: ${node.title}`,node.nodeId,story!.revision,
            {storylineId:node.storylineId,...(freshEvidence?{evidenceTurnId:freshEvidence.turnId}:{}),boundEvidence:Boolean(bound)});
          else blockers.push('scene-resolution-requires-gm-binding-or-human-adjudication');
        }
      }
      for (const clue of graph?.clues ?? []) {
        if(!publicSource(c,clue.clueId)){blockers.push('story-public-rendering-required');continue;}
        const available = clue.sources.filter(source => source.kind === "node"
          ? publicSource(c,source.targetId)&&graph!.nodes.some(node => node.nodeId === source.targetId && node.status !== "hidden")
          : graph!.plotPoints.some(point => point.plotPointId === source.targetId && point.answered)).length;
        if (!clue.revealed && available >= clue.revealThreshold && (available > 0 || evidence))
          add("reveal-clue", `Reveal eligible clue: ${clue.title}`, clue.clueId, story!.revision, { storylineId: clue.storylineId });
      }
    }
    const bounded = bindings.slice(0, 24);
    const historicalRecall = services.getCampaignRecall(g, { campaignId: c, sessionId: s, audience: { kind: "dm" }, purpose: "dm-planning",
      query: evidence?.intent || graph?.nodes.filter(node => node.status === "revealed").map(node => node.title).join(" ") || context.visibleWorld.join(" ") });
    if (!historicalRecall) throw new CampaignDmConflictError("director recall authority unavailable");
    const privateContext = { context, story: graph, preparation: planning, evidence, safety, historicalRecall };
    // A changing domain snapshot invalidates approvals, including actor health and catalog changes.
    const health = db.prepare("SELECT actor_id,name,current,max FROM rpg_actor_resources WHERE campaign_id=? ORDER BY actor_id,name").all(c);
    const freshness = hash({ context, story, planning, locations, health, combat, candidates: bounded, evidence, safety, historicalRecall });
    if (json(privateContext).length + json(bounded).length > 60000) throw new CampaignDmConflictError("director context exceeds bounded preparation");
    return { context: privateContext, bindings: bounded, blockers: [...new Set(blockers)].slice(0,16), freshness, timelineId: context.timelineId };
  }
  /** Applies one exact candidate's mechanics. Caller owns the transaction. */
  function runCandidate(r: RunRow, binding: Binding, key: string): { receipt: unknown; summary: string } {
    const command = { expectedRevision: binding.revision, idempotencyKey: key };
    const action = binding.candidate.action;
    let receipt: unknown, summary: string;
    if (action === "encounter-start" || action === "encounter-materialize") {
      let encounterId = binding.target, expectedRevision = binding.revision;
      let preparationReceipt: unknown = null;
      if (action === "encounter-materialize") {
        const created = services.createEncounter(r.gm_principal_id, r.campaign_id, { ...binding.data, idempotencyKey: `${key}:prepare` });
        encounterId = created.encounter.encounterId; expectedRevision = created.encounter.revision;
        preparationReceipt = created.receipt;
        db.prepare("INSERT INTO dm_encounter_bindings VALUES(?,?,?,?)").run(r.campaign_id, binding.target, encounterId, r.run_id);
      }
      const startReceipt = services.startEncounter(r.gm_principal_id, encounterId, { expectedRevision, idempotencyKey: key }).receipt;
      receipt = preparationReceipt ? { preparation: preparationReceipt, start: startReceipt } : startReceipt;
      summary = "The encounter begins. Initiative is established; consult the combat tracker for the current turn.";
    } else if (action === "encounter-complete") {
      const result = services.endCombat(r.gm_principal_id, binding.target, command); receipt = result.receipt;
      summary = `The encounter is complete. ${result.rewards.length} reward bundles are available for their recipients to claim. No reward has been claimed by this beat.`;
    } else if (action === "enemy-turn") {
      const legacy = binding.data?.legacyAction;
      const result = binding.data?.ruleset === "dnd-5e"
        ? services.executeCombatEnemyTurn(r.gm_principal_id, binding.target, command)
        : legacy ? services.resolveCombatAction(r.gm_principal_id, binding.target, { ...command, legalActionId: legacy.legalActionId,
          targetIds: legacy.targetIds.slice(0,1), choices: [] }) : null;
      if (!result) throw new CampaignDmConflictError("enemy mechanics unavailable");
      receipt = result.receipt;
      summary = `The enemy's ${result.resolution.kind} is resolved. ${result.resolution.outcomes.flatMap(outcome => outcome.kind === "damage"
        ? [`${outcome.applied} damage applied; the target has ${outcome.hitPointsAfter} HP.`] : []).join(" ")} Combat is now in round ${result.combat.round}.`;
    } else {
      if(!publicSource(r.campaign_id,binding.target))throw new CampaignDmConflictError('story requires a reviewed public rendering');
      if(action==='resolve-node'&&r.mode==='ai'&&!binding.data.boundEvidence)throw new CampaignDmConflictError('scene evidence is not bound');
      const result = services.executeStorylineCommand(r.gm_principal_id, binding.data.storylineId,
        { ...command, kind: action, targetId: binding.target, data: {} }); receipt = result.receipt;
      if (action === "resolve-node" && binding.data.evidenceTurnId) db.prepare("INSERT INTO dm_story_evidence VALUES(?,?,?)").run(r.campaign_id, binding.data.evidenceTurnId, r.run_id);
      // Select only public columns AFTER the reveal commits; never use the privileged domain result.
      const visible = action === "reveal-clue"
        ? db.prepare("SELECT title,content text FROM story_clues_v34 JOIN story_discoveries_v34 USING(campaign_id,storyline_id,clue_id) WHERE campaign_id=? AND clue_id=?").get(r.campaign_id, binding.target) as any
        : db.prepare("SELECT title,description text FROM story_nodes_v34 JOIN story_node_state_v34 USING(campaign_id,storyline_id,node_id) WHERE campaign_id=? AND node_id=? AND status<>'hidden'").get(r.campaign_id, binding.target) as any;
      if (!visible) throw new CampaignDmConflictError("public story result unavailable");
      summary = `${action === "resolve-node" ? "Scene resolved" : action === "reveal-clue" ? "Clue discovered" : "Scene revealed"}: ${visible.title}. ${visible.text ?? ""}`.slice(0,4000);
    }
    return { receipt, summary };
  }
  /** Writes one committed candidate receipt atomically with its mechanics. Caller owns the transaction. */
  function writeReceipt(r: RunRow, binding: Binding, receipt: unknown, summary: string, ordinal: number, key: string) {
    const action = binding.candidate.action, publicJson = json({ action, summary }), domainJson = json(receipt);
    db.prepare("INSERT INTO dm_composition_receipts VALUES(?,?,?,?,?,?)").run(r.run_id, ordinal, key, action, domainJson, publicJson);
    // The first candidate also records the run's primary credential receipt required by publication.
    if (ordinal === 0) db.prepare("INSERT INTO dm_receipts VALUES(?,?,?,?,?)").run(r.run_id, key, action, domainJson, publicJson);
  }
  function execute(r: RunRow) {
    if(db.prepare("SELECT 1 FROM dm_narration_jobs WHERE run_id=?").get(r.run_id))return;
    if (r.state !== "awaiting-approval" || !r.proposal_json) return;
    if (!active(r) || now() >= r.expires_at) { stop(r, "cancelled", "authority-safety-or-mode-changed"); return; }
    const input = JSON.parse(r.request_json) as CampaignDmBeatRequest;
    if (snapshot(r.gm_principal_id, r.campaign_id, r.session_id, input).freshness !== r.freshness_digest) {
      stop(r, "blocked", "proposal-stale-request-new-beat"); return;
    }
    const composition = compositionOf(JSON.parse(r.proposal_json));
    const bindings = JSON.parse(r.candidates_json) as Binding[];
    const targets = composition.map(selection => {
      const binding = bindings.find(b => b.candidate.candidateId === selection.candidateId && b.candidate.digest === selection.digest);
      if (!binding) throw new CampaignDmConflictError("candidate unavailable");
      return binding;
    });
    const decision = db.prepare("SELECT kind FROM dm_decisions WHERE run_id=?").get(r.run_id) as { kind: string } | undefined;
    if (r.mode === "human" && decision?.kind !== "human-approved") return;
    if (r.mode === "ai" && !decision) db.prepare("INSERT INTO dm_decisions VALUES(?,?,?,?,?)").run(r.run_id, r.gm_principal_id,
      "ai-policy-v1", json({ modeRevision: r.mode_revision, selection: composition }), now());
    // Each candidate commits independently so a later failure never rolls back an earlier receipt.
    let executed = 0;
    for (const [index, binding] of targets.entries()) {
      // The first candidate keeps the established run-level command key required by the credential trigger.
      const key = index === 0 ? `dm-command:${r.run_id}` : `dm-command:${r.run_id}:${index}`;
      try {
        db.transaction(() => { const { receipt, summary } = runCandidate(r, binding, key); writeReceipt(r, binding, receipt, summary, index, key); }).immediate();
        executed += 1;
      } catch {
        if (executed > 0) stop(r, "blocked", `composition-partial-after-${executed}`);
        else throw new CampaignDmConflictError("domain-preconditions-changed");
        return;
      }
    }
    if (!active(r)) throw new CampaignDmConflictError("publication authority changed");
    db.transaction(() => {
      queueNarration(r, receiptsFor(r.run_id).map((item: any) => item.summary).join(" ").slice(0, 8000));
      db.prepare("UPDATE dm_runs SET revision=revision+1 WHERE run_id=?").run(r.run_id);
    }).immediate();
  }
  const api: CampaignDmRepository = {
    recordDmProviderUsage(p,id,phase,usage){guard();db.transaction(()=>{
      const r=row(id);if(p!==r.principal_id&&!privileged(role(p,r.campaign_id)))throw new CampaignDmUnavailableError();
      if(![usage.promptTokens,usage.completionTokens,usage.totalTokens].every(value=>Number.isSafeInteger(value)&&value>=0)
        ||(usage.costUsd!==null&&(!Number.isFinite(usage.costUsd)||usage.costUsd<0)))throw new CampaignDmConflictError('invalid provider accounting');
      const old=db.prepare('SELECT * FROM dm_review_provider_usage WHERE run_id=? AND phase=?').get(id,phase) as any;
      if(old){if(old.source!==usage.source||old.prompt_tokens!==usage.promptTokens||old.completion_tokens!==usage.completionTokens
        ||old.total_tokens!==usage.totalTokens||old.cost_usd!==usage.costUsd)throw new CampaignDmConflictError('provider accounting replay changed');return;}
      const table=phase==='planning'?'dm_dispatches':'dm_narration_dispatches';
      if(!db.prepare(`SELECT 1 FROM ${table} WHERE run_id=?`).get(id))throw new CampaignDmUnavailableError();
      db.prepare('INSERT INTO dm_review_provider_usage VALUES(?,?,?,?,?,?,?)').run(id,phase,usage.source,usage.promptTokens,usage.completionTokens,usage.totalTokens,usage.costUsd);
    }).immediate();},
    bindDmSceneEvidence(p,c,raw){guard();const input=campaignDmSceneBindingRequestSchema.parse(raw);return db.transaction(()=>{
      gm(p,c);const old=db.prepare('SELECT principal_id,request_json FROM dm_review_scene_bindings WHERE campaign_id=? AND idempotency_key=?').get(c,input.idempotencyKey) as any;
      if(old){if(old.principal_id!==p||old.request_json!==json(input))throw new CampaignDmConflictError('binding idempotency conflict');return input;}
      const story=services.getCampaignStory(p,c);if(story?.revision!==input.expectedStoryRevision)throw new CampaignDmConflictError('story revision stale');
      const node=db.prepare('SELECT storyline_id FROM story_nodes_v34 WHERE campaign_id=? AND node_id=?').get(c,input.nodeId) as {storyline_id:string}|undefined;
      if(!node||!publicSource(c,input.nodeId))throw new CampaignDmUnavailableError();
      const [table,column]=input.evidence.kind==='check-turn'?['adventure_turns','id']:input.evidence.kind==='quest-objective'?['quest_objectives_v33','objective_id']:['encounter','encounter_id'];
      if(!db.prepare(`SELECT 1 FROM ${table} WHERE campaign_id=? AND ${column}=?`).get(c,input.evidence.targetId))throw new CampaignDmUnavailableError();
      db.prepare('INSERT INTO dm_review_scene_bindings VALUES(?,?,?,?,?,?,?,?,?)').run(c,input.nodeId,node.storyline_id,input.evidence.kind,input.evidence.targetId,p,input.idempotencyKey,json(input),now());
      return input;
    }).immediate();},
    getDmControl(p, c) { guard(); member(p,c); const value=control(c); return campaignDmControlSchema.parse({campaignId:c,mode:value.mode,revision:value.revision}); },
    setDmControl(p,c,raw) { guard(); const input=campaignDmModeRequestSchema.parse(raw); return db.transaction(() => {
      gm(p,c); const old=db.prepare("SELECT principal_id,request_json,result_json FROM dm_mode_commands WHERE campaign_id=? AND idempotency_key=?").get(c,input.idempotencyKey) as any;
      if(old) { if(old.principal_id!==p||old.request_json!==json(input))throw new CampaignDmConflictError("idempotency conflict");return campaignDmControlSchema.parse(JSON.parse(old.result_json)); }
      const before=control(c);if(before.revision!==input.expectedRevision)throw new CampaignDmConflictError("mode revision stale");
      const result={campaignId:c,mode:input.mode,revision:before.revision+1};
      db.prepare("INSERT INTO dm_control VALUES(?,?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET mode=excluded.mode,revision=excluded.revision,delegator=excluded.delegator")
        .run(c,input.mode,result.revision,input.mode==="ai"?p:null);
      db.prepare("INSERT INTO dm_mode_commands VALUES(?,?,?,?,?,?)").run(c,input.idempotencyKey,p,json(input),json(result),now());
      db.prepare("UPDATE dm_runs SET state='cancelled',revision=revision+1,blockers_json='[\"dm-mode-changed\"]' WHERE campaign_id=? AND state IN ('planning','awaiting-approval')").run(c);
      return result;
    }).immediate(); },
    openDmBeat(p,c,s,raw) { guard(); const input=campaignDmBeatRequestSchema.parse(raw);return db.transaction(() => {
      room(p,c,s);const mode=control(c);
      if (!privileged(role(p,c)) && (mode.mode!=="ai" || role(p,c)!=="player")) throw new CampaignDmUnavailableError();
      const old=db.prepare("SELECT * FROM dm_runs WHERE campaign_id=? AND session_id=? AND principal_id=? AND idempotency_key=?").get(c,s,p,input.idempotencyKey) as RunRow|undefined;
      if(old){if(old.request_json!==json(input))throw new CampaignDmConflictError("idempotency conflict");return project(old);}
      if(mode.revision!==input.expectedModeRevision)throw new CampaignDmConflictError("mode revision stale");
      const delegated=mode.mode==="ai"?mode.delegator:p;if(!delegated)throw new CampaignDmUnavailableError();gm(delegated,c);
      const prior=db.prepare("SELECT * FROM dm_runs WHERE campaign_id=? AND session_id=? AND state IN ('planning','awaiting-approval')").get(c,s) as RunRow|undefined;
      if(prior){const dispatch=db.prepare("SELECT deadline_at FROM dm_dispatches WHERE run_id=? AND status='claimed'").get(prior.run_id) as any;
        if(!active(prior))stop(prior,"cancelled","authority-safety-or-mode-changed");
        else if(dispatch&&now()>=dispatch.deadline_at){stop(prior,"unknown","provider-outcome-unknown-no-automatic-retry");db.prepare("UPDATE dm_dispatches SET status='unknown' WHERE run_id=? AND status='claimed'").run(prior.run_id);}
        else if(now()>=prior.expires_at)stop(prior,"cancelled","beat-expired");
        else throw new CampaignDmConflictError("room already has an outstanding beat");}
      const snap=snapshot(delegated,c,s,input),at=now(),id=deps.ids.nextId();
      if(input.intent==="open"&&db.prepare("SELECT 1 FROM dm_runs WHERE campaign_id=? AND session_id=? AND timeline_id=? AND intent='open' AND state='completed'").get(c,s,snap.timelineId))throw new CampaignDmConflictError("room already opened; continue instead");
      db.prepare(`INSERT INTO dm_runs(run_id,campaign_id,session_id,timeline_id,principal_id,gm_principal_id,mode,mode_revision,intent,idempotency_key,
        request_json,context_json,candidates_json,freshness_digest,state,revision,proposal_json,blockers_json,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'planning',0,NULL,?,?,?)`).run(id,c,s,snap.timelineId,p,delegated,mode.mode,mode.revision,input.intent,input.idempotencyKey,
          json(input),json(snap.context),json(snap.bindings),snap.freshness,json(snap.blockers),at,new Date(deps.clock.now().getTime()+30*60_000).toISOString());
      const created=row(id);if(!active(created))stop(created,"blocked","campaign-or-room-paused");
      return project(row(id));
    }).immediate(); },
    getDmRun(p,c,s,id){guard();return project(pathRow(p,c,s,id));},
    getDmHistory(p,c,s){guard();room(p,c,s);return {control:api.getDmControl(p,c),runs:(db.prepare("SELECT * FROM dm_runs WHERE campaign_id=? AND session_id=? ORDER BY rowid DESC LIMIT 50").all(c,s) as RunRow[]).reverse().map(project)};},
    getDmProposal(p,c,s,id){guard();gm(p,c);const r=pathRow(p,c,s,id);
      const composition=compositionOf(r.proposal_json?JSON.parse(r.proposal_json):null);
      const bindings=JSON.parse(r.candidates_json) as Binding[];
      const candidates=composition.map(selection=>bindings.find(b=>b.candidate.candidateId===selection.candidateId&&b.candidate.digest===selection.digest)?.candidate)
        .filter((candidate):candidate is CampaignDmCandidate=>candidate!==undefined);
      return {run:project(r),proposal:candidates[0]??null,composition:candidates};},
    claimDmPlanning(p,id,provider,model){guard();return db.transaction(()=>{
      const r=row(id);triggerAuthority(p,r);if(r.state!=="planning")return null;
      if(db.prepare("SELECT 1 FROM dm_narration_jobs WHERE run_id=?").get(id))return null;
      if(!active(r)||now()>=r.expires_at){stop(r,"cancelled","authority-safety-or-mode-changed");return null;}
      const existing=db.prepare("SELECT * FROM dm_dispatches WHERE run_id=?").get(id) as any;
      if(existing){if(existing.status==="claimed"&&now()>=existing.deadline_at){db.prepare("UPDATE dm_dispatches SET status='unknown' WHERE run_id=?").run(id);stop(r,"unknown","provider-outcome-unknown-no-automatic-retry");}return null;}
      const bindings=JSON.parse(r.candidates_json) as Binding[];
      if(!bindings.length){
        const blockers=JSON.parse(r.blockers_json) as string[];
        if(blockers.some(code=>code!=="waiting-for-player-combat-action")){
          db.prepare("UPDATE dm_runs SET state='blocked',revision=revision+1 WHERE run_id=?").run(id);return null;
        }
        queueNarration(r,holdNarration(r));
        db.prepare("UPDATE dm_runs SET revision=revision+1 WHERE run_id=?").run(id);return null;
      }
      const claimId=deps.ids.nextId(),context=JSON.parse(r.context_json),candidates=bindings.map(b=>b.candidate);
       db.prepare("INSERT INTO dm_dispatches VALUES(?,?,?,?,?,?,'claimed',NULL,23744,256)").run(id,claimId,
         json({version:"campaign-dm-v1",context,candidates,budget:{providerCalls:1,maxPromptTokens:23744,maxCompletionTokens:256,durationMs:DM_PROVIDER_DEADLINE_MS}}),provider,model,
         new Date(deps.clock.now().getTime()+DM_PROVIDER_DEADLINE_MS).toISOString());
       recordContextInspectionProvenance(db,{dispatchId:claimId,campaignId:r.campaign_id,sessionId:r.session_id,lane:"director-planning",recordedPhase:"planned",createdAt:now()},deps.contextInspectionProvenance);
       return {runId:id,claimId,context,candidates};
    }).immediate();},
    bindDmProviderRequest(p,id,claimId,request,promptTokens,completionTokens){guard();return db.transaction(()=>{
      const r=row(id);triggerAuthority(p,r);
      const dispatch=db.prepare("SELECT deadline_at FROM dm_dispatches WHERE run_id=? AND claim_id=? AND status='claimed'").get(id,claimId) as {deadline_at:string}|undefined;
      if(!dispatch||r.state!=="planning"||!active(r)||now()>=dispatch.deadline_at){stop(r,"cancelled","authority-safety-or-mode-changed");return false;}
      const requestJson=json(request),old=db.prepare("SELECT * FROM dm_provider_requests WHERE run_id=?").get(id) as any;
      if(old){if(old.request_json!==requestJson||old.reserved_prompt_tokens!==promptTokens||old.reserved_completion_tokens!==completionTokens)throw new CampaignDmConflictError("provider request changed");return true;}
      db.prepare("INSERT INTO dm_provider_requests VALUES(?,?,?,?)").run(id,requestJson,promptTokens,completionTokens);return true;
    }).immediate();},
    settleDmPlanning(p,id,claimId,selection,usage,failed=false){guard();db.transaction(()=>{
      const r=row(id);triggerAuthority(p,r);const dispatch=db.prepare("SELECT * FROM dm_dispatches WHERE run_id=? AND claim_id=?").get(id,claimId) as any;
      if(!dispatch)throw new CampaignDmConflictError("dispatch unavailable");
      const normalized=selection===null?null:campaignDmCompositionSchema.parse(Array.isArray(selection)?selection:[selection]);
      if(usage&&!db.prepare("SELECT 1 FROM dm_review_provider_usage WHERE run_id=? AND phase='planning'").get(id)){
        const request=db.prepare('SELECT request_json FROM dm_provider_requests WHERE run_id=?').get(id) as {request_json:string}|undefined;
        const pricing=request?JSON.parse(request.request_json).budget?.pricing:undefined;
        api.recordDmProviderUsage(p,id,'planning',{source:'provider',...usage,totalTokens:usage.promptTokens+usage.completionTokens,
          costUsd:pricing?.promptPerMillion!=null&&pricing?.completionPerMillion!=null?(usage.promptTokens*pricing.promptPerMillion+usage.completionTokens*pricing.completionPerMillion)/1_000_000:null});
      }
      failed ||= !recordedUsageAllowed(id,'planning');
      if(dispatch.status!=="claimed"){
        if(dispatch.status==="settled" && (dispatch.response_json!==json({selection:normalized}) || dispatch.prompt_tokens!==(usage?.promptTokens??null)
          || dispatch.completion_tokens!==(usage?.completionTokens??null)))throw new CampaignDmConflictError("settlement replay changed");
        return;
      }
      if(failed||now()>=dispatch.deadline_at){db.prepare("UPDATE dm_dispatches SET status='unknown',prompt_tokens=?,completion_tokens=? WHERE run_id=?").run(usage?.promptTokens??null,usage?.completionTokens??null,id);stop(r,"unknown","provider-outcome-unknown-no-automatic-retry");return;}
      if(normalized){const bindings=JSON.parse(r.candidates_json) as Binding[];
        if(!normalized.every(selection=>bindings.some(b=>b.candidate.candidateId===selection.candidateId&&b.candidate.digest===selection.digest)))throw new CampaignDmConflictError("unadvertised candidate");}
      db.prepare("UPDATE dm_dispatches SET status='settled',response_json=?,prompt_tokens=?,completion_tokens=? WHERE run_id=?").run(json({selection:normalized}),usage?.promptTokens??null,usage?.completionTokens??null,id);
      if(r.state!=="planning")return;
      if(!active(r)){stop(r,"cancelled","authority-safety-or-mode-changed");return;}
      if(snapshot(r.gm_principal_id,r.campaign_id,r.session_id,JSON.parse(r.request_json)).freshness!==r.freshness_digest){stop(r,"blocked","proposal-stale-request-new-beat");return;}
      if(!normalized){queueNarration(r,holdNarration(r));db.prepare("UPDATE dm_runs SET revision=revision+1 WHERE run_id=?").run(id);return;}
      db.prepare("UPDATE dm_runs SET state='awaiting-approval',proposal_json=?,revision=revision+1 WHERE run_id=?").run(json(normalized),id);
    }).immediate();},
    readDmPlanningGrounding(p,id,request){guard();return db.transaction(()=>{
      const r=row(id);triggerAuthority(p,r);
      if(r.state!=="planning")throw new CampaignDmUnavailableError();
      if(request.tool==="read_campaign_recall"){
        const query=recallTopicQuery(r,request.topic);
        const recall=services.getCampaignRecall(r.gm_principal_id,{campaignId:r.campaign_id,sessionId:r.session_id,
          audience:{kind:"dm"},purpose:"dm-planning",query});
        if(!recall)throw new CampaignDmConflictError("planning recall authority unavailable");
        const data=boundRecall(recall.hits.map(hit=>({sourceKind:hit.sourceKind,text:typeof hit.text==="string"?hit.text:""})),recall.incomplete,recall.query);
        return {tool:request.tool,summary:boundedSummary(`Campaign recall (${request.topic}): ${data.hits.length} hit(s).${recall.incomplete?" More history exists.":""}`),data};
      }
      if(request.tool==="read_quest_summary"){
        const rows=db.prepare(`SELECT quest.title title,objective.description description,objective.target_progress target,COALESCE(progress.progress,0) progress
          FROM quest_definitions_v33 definition JOIN quests quest ON quest.campaign_id=definition.campaign_id AND quest.id=definition.quest_id
          JOIN quest_objectives_v33 objective ON objective.campaign_id=definition.campaign_id AND objective.quest_id=definition.quest_id
          LEFT JOIN quest_objective_progress_v33 progress ON progress.campaign_id=objective.campaign_id AND progress.quest_id=objective.quest_id AND progress.objective_id=objective.objective_id
          WHERE definition.campaign_id=? AND definition.visibility='public' AND objective.visibility='public'
          ORDER BY quest.sort_order,quest.id,objective.sort_order,objective.objective_id LIMIT 16`).all(r.campaign_id) as { title:string;description:string;target:number;progress:number }[];
        const data=rows.map(row=>({title:row.title.slice(0,300),description:row.description.slice(0,1000),progress:row.progress,target:row.target}));
        return {tool:request.tool,summary:boundedSummary(`Public quest objectives: ${data.length} row(s).`),data};
      }
      if(request.tool==="read_public_world"){
        const locations=db.prepare(`SELECT location_id locationId,public_name name,public_description description FROM campaign_locations_v28
          WHERE campaign_id=? AND visibility='public' ORDER BY public_name LIMIT 16`).all(r.campaign_id) as { locationId:string;name:string;description:string }[];
        const connections=db.prepare(`SELECT connection_id connectionId,from_location_id fromLocationId,to_location_id toLocationId,route_state routeState
          FROM campaign_location_connections_v28 WHERE campaign_id=? AND visibility='public' ORDER BY connection_id LIMIT 16`).all(r.campaign_id) as { connectionId:string;fromLocationId:string;toLocationId:string;routeState:string }[];
        const data={locations:locations.map(row=>({locationId:row.locationId,name:row.name.slice(0,200),description:(row.description??"").slice(0,1000)})),
          connections:connections.map(row=>({connectionId:row.connectionId,fromLocationId:row.fromLocationId,toLocationId:row.toLocationId,routeState:row.routeState}))};
        return {tool:request.tool,summary:boundedSummary(`Public world: ${data.locations.length} location(s), ${data.connections.length} connection(s).`),data};
      }
      const npcs=db.prepare(`SELECT npc.npc_id npcId,npc.public_name name,json_extract(metadata.public_state_json,'$.description') description
        FROM campaign_npc_presence_v43 presence JOIN campaign_npcs_v28 npc USING(campaign_id,npc_id)
        LEFT JOIN campaign_npc_metadata_v32 metadata ON metadata.campaign_id=npc.campaign_id AND metadata.npc_id=npc.npc_id
        WHERE presence.campaign_id=? AND presence.session_id=? AND presence.state='present'
          AND NOT EXISTS(SELECT 1 FROM campaign_generation_accepted_artifacts_v52 hidden WHERE hidden.campaign_id=npc.campaign_id
            AND hidden.server_resource_id=npc.npc_id AND hidden.visibility='gm')
          AND (presence.location_id IS NULL OR EXISTS(SELECT 1 FROM campaign_actor_locations_v28 current
            JOIN campaign_locations_v28 location ON location.campaign_id=current.campaign_id AND location.location_id=current.location_id
            WHERE current.campaign_id=presence.campaign_id AND current.session_id=presence.session_id
              AND current.location_id=presence.location_id AND location.visibility='public'))
        ORDER BY npc.npc_id LIMIT 12`).all(r.campaign_id,r.session_id) as { npcId:string;name:string;description:string|null }[];
      const data=npcs.map(row=>({npcId:row.npcId,name:row.name.slice(0,200),description:row.description===null?null:row.description.slice(0,1000)}));
      return {tool:request.tool,summary:boundedSummary(`Present public NPCs: ${data.length}.`),data};
    }).deferred();},
    claimDmPlanningRound(p,id,round,provider,model,request,promptTokens,completionTokens){guard();return db.transaction(()=>{
      const r=row(id);triggerAuthority(p,r);
      if(r.state!=="planning")return null;
      if(db.prepare("SELECT 1 FROM dm_narration_jobs WHERE run_id=?").get(id))return null;
      if(db.prepare("SELECT 1 FROM dm_planning_rounds WHERE run_id=? AND round=?").get(id,round))return null;
      if(!active(r)||now()>=r.expires_at){stop(r,"cancelled","authority-safety-or-mode-changed");return null;}
      if(!Number.isSafeInteger(promptTokens)||!Number.isSafeInteger(completionTokens)||promptTokens<1||promptTokens>23744||completionTokens<1||completionTokens>256)
        throw new CampaignDmConflictError("planning round reservation invalid");
      const aggregate=planningAggregate(id),budget=aggregate.budget;
      if(aggregate.tokens+promptTokens+completionTokens>Math.min(24000,budget?.maxTotalTokens??24000))return null;
      const reservedCost=budget?.costUsd;
      if(budget?.maxCostUsd!=null&&(reservedCost==null||aggregate.cost==null||aggregate.cost+reservedCost>budget.maxCostUsd))return null;
      const claimId=deps.ids.nextId();
      db.prepare("INSERT INTO dm_planning_rounds(run_id,round,claim_id,status,request_json,response_json,reserved_prompt_tokens,reserved_completion_tokens,prompt_tokens,completion_tokens,cost_usd,deadline_at) VALUES(?,?,?,'claimed',?,NULL,?,?,NULL,NULL,NULL,?)")
        .run(id,round,claimId,json(request),promptTokens,completionTokens,new Date(deps.clock.now().getTime()+DM_PROVIDER_DEADLINE_MS).toISOString());
      recordContextInspectionProvenance(db,{dispatchId:claimId,campaignId:r.campaign_id,sessionId:r.session_id,lane:"director-planning",recordedPhase:"planned",createdAt:now()},deps.contextInspectionProvenance);
      return {claimId};
    }).immediate();},
    settleDmPlanningRound(p,id,claimId,response,usage,failed=false){guard();db.transaction(()=>{
      const r=row(id);triggerAuthority(p,r);
      const responseJson=json(response);
      if(responseJson.length>64000)throw new CampaignDmConflictError("planning round response exceeds bound");
      const roundRow=db.prepare("SELECT * FROM dm_planning_rounds WHERE run_id=? AND claim_id=?").get(id,claimId) as any;
      if(roundRow){
        if(roundRow.status!=="claimed"){
          if(roundRow.status==="settled"&&roundRow.response_json!==responseJson)throw new CampaignDmConflictError("planning round settlement replay changed");
          return;
        }
        const budget=requestBudget(roundRow.request_json),pricing=budget?.pricing;
        const cost=usage&&pricing?.promptPerMillion!=null&&pricing?.completionPerMillion!=null
          ?(usage.promptTokens*pricing.promptPerMillion+usage.completionTokens*pricing.completionPerMillion)/1_000_000:null;
        if(usage&&(![usage.promptTokens,usage.completionTokens].every(value=>Number.isSafeInteger(value)&&value>=0)
          ||usage.promptTokens>roundRow.reserved_prompt_tokens||usage.completionTokens>roundRow.reserved_completion_tokens))failed=true;
        const aggregate=planningAggregate(id,claimId);
        if(usage&&aggregate.tokens+usage.promptTokens+usage.completionTokens>Math.min(24000,budget?.maxTotalTokens??24000))failed=true;
        if(usage&&budget?.maxCostUsd!=null&&(cost==null||aggregate.cost==null||aggregate.cost+cost>budget.maxCostUsd))failed=true;
        if(failed||now()>=roundRow.deadline_at){
          db.prepare("UPDATE dm_planning_rounds SET status='unknown',prompt_tokens=?,completion_tokens=?,cost_usd=? WHERE run_id=? AND claim_id=?")
            .run(usage?.promptTokens??null,usage?.completionTokens??null,cost,id,claimId);
          stop(r,"unknown","provider-outcome-unknown-no-automatic-retry");return;
        }
        db.prepare("UPDATE dm_planning_rounds SET status='settled',response_json=?,prompt_tokens=?,completion_tokens=?,cost_usd=? WHERE run_id=? AND claim_id=?")
          .run(responseJson,usage?.promptTokens??null,usage?.completionTokens??null,cost,id,claimId);
        const normalized=decisionSelection(response);
        if(normalized!==undefined)finalizePlanning(r,normalized);
        return;
      }
      const dispatch=db.prepare("SELECT * FROM dm_dispatches WHERE run_id=? AND claim_id=?").get(id,claimId) as any;
      if(!dispatch)throw new CampaignDmConflictError("planning round unavailable");
      if(dispatch.status!=="claimed")return;
      if(usage&&!recordedUsageAllowed(id,'planning'))failed=true;
      if(failed||now()>=dispatch.deadline_at){db.prepare("UPDATE dm_dispatches SET status='unknown',prompt_tokens=?,completion_tokens=? WHERE run_id=?").run(usage?.promptTokens??null,usage?.completionTokens??null,id);stop(r,"unknown","provider-outcome-unknown-no-automatic-retry");return;}
      db.prepare("UPDATE dm_dispatches SET status='settled',response_json=?,prompt_tokens=?,completion_tokens=? WHERE run_id=?").run(responseJson,usage?.promptTokens??null,usage?.completionTokens??null,id);
    }).immediate();},
    executeDmBeat(p,id){guard();const r=row(id);triggerAuthority(p,r);
      try{execute(r);}catch{stop(row(id),"blocked","domain-preconditions-changed-request-new-beat");}
      return project(row(id));},
    decideDmBeat(p,c,s,id,raw){guard();const input=campaignDmDecisionRequestSchema.parse(raw);return db.transaction(()=>{
      gm(p,c);const r=pathRow(p,c,s,id);const old=db.prepare("SELECT principal_id,request_json FROM dm_decisions WHERE run_id=?").get(id) as any;
      if(old){if(old.principal_id!==p||old.request_json!==json(input))throw new CampaignDmConflictError("decision conflict");return project(r);}
      if(r.mode!=="human"||r.state!=="awaiting-approval"||r.revision!==input.expectedRevision)throw new CampaignDmConflictError("proposal revision stale");
      if(!active(r)||now()>=r.expires_at){stop(r,"cancelled","authority-safety-or-mode-changed");return project(row(id));}
      db.prepare("INSERT INTO dm_decisions VALUES(?,?,?,?,?)").run(id,p,input.decision==="approved"?"human-approved":"human-rejected",json(input),now());
      if(input.decision==="rejected")stop(r,"cancelled","gm-rejected");else api.executeDmBeat(p,id);
      return project(row(id));
    }).immediate();},
    hasDmNarrationJob(p,id){guard();triggerAuthority(p,row(id));return Boolean(db.prepare("SELECT 1 FROM dm_narration_jobs WHERE run_id=?").get(id));},
    getDmNarrationWork(p,id){guard();return db.transaction(()=>{
      const r=row(id);triggerAuthority(p,r);
      const job=db.prepare("SELECT * FROM dm_narration_jobs WHERE run_id=?").get(id) as any;
      if(!job||!["planning","awaiting-approval"].includes(r.state))return null;
      if(!active(r)){stop(r,"cancelled","authority-safety-or-mode-changed");return null;}
      if(narrationGuard(r,publicScene(r))!==job.guard_digest){stop(r,"blocked","public-scene-changed-before-narration");return null;}
      let dispatch=db.prepare("SELECT * FROM dm_narration_dispatches WHERE run_id=?").get(id) as any;
      if(dispatch){
        if(dispatch.status==='claimed'&&now()>=dispatch.deadline_at){
          db.prepare("UPDATE dm_narration_dispatches SET status='settled',source='deterministic-fallback',narration=?,outcome_code='unknown-paid-outcome' WHERE run_id=?").run(job.fallback,id);
          dispatch=db.prepare("SELECT * FROM dm_narration_dispatches WHERE run_id=?").get(id);
        }
        if(dispatch.status==='settled')publishNarration(r,job,dispatch);
        return null;
      }
      const reservation=db.prepare("SELECT reserved_prompt_tokens,reserved_completion_tokens,request_json FROM dm_provider_requests WHERE run_id=?").get(id) as any;
      const budget=reservation?JSON.parse(reservation.request_json).budget:undefined;
      const actual=db.prepare("SELECT * FROM dm_review_provider_usage WHERE run_id=? AND phase='planning'").get(id) as any;
      const rounds=db.prepare("SELECT COUNT(*) n,COUNT(cost_usd) priced,COALESCE(SUM(cost_usd),0) cost,COALESCE(SUM(CASE WHEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN prompt_tokens+completion_tokens ELSE reserved_prompt_tokens+reserved_completion_tokens END),0) tokens FROM dm_planning_rounds WHERE run_id=?").get(id) as { n:number;priced:number;cost:number;tokens:number };
      return {context:JSON.parse(job.public_context_json),fallback:job.fallback,planning:{
        tokens:Math.max(reservation?reservation.reserved_prompt_tokens+reservation.reserved_completion_tokens:0,actual?.total_tokens??0)+rounds.tokens,
        costUsd:(reservation&&budget?.costUsd==null)||rounds.n>rounds.priced?null:Math.max(budget?.costUsd??0,actual?.cost_usd??0)+rounds.cost,maxTotalTokens:budget?.maxTotalTokens??24000,maxCostUsd:budget?.maxCostUsd??null}};
    }).immediate();},
    claimDmNarration(p,id,provider,model,request,promptTokens,completionTokens){guard();return db.transaction(()=>{
      const work=api.getDmNarrationWork(p,id);if(!work)return null;
      if(!Number.isSafeInteger(promptTokens)||!Number.isSafeInteger(completionTokens)||promptTokens<1||completionTokens<1||completionTokens>768
        ||work.planning.tokens+promptTokens+completionTokens>Math.min(24000,work.planning.maxTotalTokens))throw new CampaignDmConflictError("narration budget exceeded");
       const claimId=deps.ids.nextId();
       db.prepare("INSERT INTO dm_narration_dispatches VALUES(?,?,?,?,?,?,?,?,'claimed',NULL,NULL,NULL)").run(id,claimId,provider,model,json(request),
         new Date(deps.clock.now().getTime()+DM_PROVIDER_DEADLINE_MS).toISOString(),promptTokens,completionTokens);
       const r=row(id);recordContextInspectionProvenance(db,{dispatchId:claimId,campaignId:r.campaign_id,sessionId:r.session_id,lane:"director-narration",recordedPhase:"narrated",createdAt:now()},deps.contextInspectionProvenance);
       return claimId;
    }).immediate();},
    settleDmNarration(p,id,claimId,scene,outcome){guard();db.transaction(()=>{
      const r=row(id);triggerAuthority(p,r);const job=db.prepare("SELECT * FROM dm_narration_jobs WHERE run_id=?").get(id) as any;
      if(!job)throw new CampaignDmUnavailableError();
      const dispatch=db.prepare("SELECT * FROM dm_narration_dispatches WHERE run_id=?").get(id) as any;
      if(dispatch?.status==='settled')return;
      if(dispatch&&claimId===null)return;
      if(dispatch && dispatch.claim_id!==claimId)throw new CampaignDmConflictError("narration claim changed");
      if(!dispatch&&claimId!==null)throw new CampaignDmConflictError("narration claim unavailable");
      const valid=scene!==null&&dispatch&&now()<dispatch.deadline_at&&active(r)&&recordedUsageAllowed(id,'narration')&&validDmScene(scene,JSON.parse(job.public_context_json))
        &&job.fallback.length+scene.length+2+DM_SCENE_DESCRIPTION_PREFIX.length<=8000;
      const narration=valid?`${job.fallback}\n\n${DM_SCENE_DESCRIPTION_PREFIX}${scene!.trim()}`:job.fallback;
      if(dispatch)db.prepare("UPDATE dm_narration_dispatches SET status='settled',source=?,narration=?,outcome_code=? WHERE run_id=?")
        .run(valid?'provider-assisted':'deterministic-fallback',narration,valid?'ok':outcome,id);
      else db.prepare("INSERT INTO dm_narration_dispatches VALUES(?,?, 'none','none','{}',?,0,0,'settled','deterministic-fallback',?,?)")
        .run(id,deps.ids.nextId(),now(),narration,outcome);
    }).immediate();},
    blockDmBeat(p,id,code){guard();db.transaction(()=>{const r=row(id);triggerAuthority(p,r);stop(r,"blocked",code);
      if(code==="director-budget-exceeded-before-dispatch")db.prepare("UPDATE dm_dispatches SET status='settled',response_json=?,prompt_tokens=0,completion_tokens=0 WHERE run_id=? AND status='claimed'")
        .run(json({notDispatched:"budget"}),id);
    }).immediate();},
  };
  return api;
}
