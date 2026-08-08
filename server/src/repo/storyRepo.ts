import { createHash, randomUUID } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  campaignStoryHttpResponseSchema, createCampaignStorylineHttpRequestSchema, resourceIdSchema,
  storylineCommandHttpRequestSchema, utcIsoTimestampSchema, type CampaignStoryHttpResponse,
  type CreateCampaignStorylineHttpRequest, type StoryCommandReceiptHttp, type StorylineCommandHttpRequest,
  type StoryStoryline,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../runtime.js";

type Database = DatabaseDriver.Database;
type InternalReceipt = StoryCommandReceiptHttp & { commandId: string };
export type StoryMutationResult = { campaignId: string; storylineId: string; story: CampaignStoryHttpResponse; receipt: InternalReceipt };
export type StorylineCreationResult = { campaignId: string; storyline: StoryStoryline; story: CampaignStoryHttpResponse; receipt: InternalReceipt };
export class StoryAuthorizationError extends Error { readonly code = "STORY_AUTHORIZATION"; }
export class StoryUnavailableError extends Error { readonly code = "STORY_UNAVAILABLE"; }
export class StoryConflictError extends Error { readonly code = "STORY_CONFLICT"; }
export class StoryStaleError extends Error { readonly code = "STORY_STALE"; }

export interface StoryRepository {
  getCampaignStory(principalId: string, campaignId: string): { campaignId: string; revision: number; story: CampaignStoryHttpResponse } | null;
  createCampaignStorylineGraph(principalId: string, campaignId: string, input: CreateCampaignStorylineHttpRequest): StorylineCreationResult;
  executeStorylineCommand(principalId: string, storylineId: string, input: StorylineCommandHttpRequest): StoryMutationResult;
}
const canonicalValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalValue) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalValue(item)])) : value;
const canonical = (value: unknown) => JSON.stringify(canonicalValue(value));
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const normalizeTime = (value: string): string => {
  const parsed = utcIsoTimestampSchema.safeParse(value); if (parsed.success) return parsed.data;
  return utcIsoTimestampSchema.parse(`${value.replace(" ", "T")}${value.includes(".") ? "Z" : ".000Z"}`);
};

export function createStoryRepository(db: Database, dependencies?: { clock: Clock; ids: IdGenerator; guard?: () => void }): StoryRepository {
  const now = () => utcIsoTimestampSchema.parse((dependencies?.clock.now() ?? new Date()).toISOString());
  const nextId = () => resourceIdSchema.parse(dependencies?.ids.nextId() ?? randomUUID());
  const guard = dependencies?.guard ?? (() => undefined);
  const membership = (principalId: string, campaignId: string) => db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
    .get(campaignId, principalId) as { role: string } | undefined;
  const isGm = (role: string) => role === "owner" || role === "gm";
  const revision = (campaignId: string) => (db.prepare("SELECT revision FROM story_campaign_revisions_v34 WHERE campaign_id=?").get(campaignId) as { revision: number } | undefined)?.revision ?? 0;
  const storylineProjection = (row: any): StoryStoryline => ({ storylineId: row.id, campaignId: row.campaign_id, title: row.title,
    summary: row.summary ?? row.description ?? null, status: row.metadata_status ?? row.status, createdAt: normalizeTime(row.created_at),
    updatedAt: normalizeTime(row.updated_at ?? row.created_at) });

  function project(campaignId: string, privileged: boolean): CampaignStoryHttpResponse {
    if (!privileged) {
      // These statements never load secret columns, ancestry, edges, sources, answers, or hidden identifiers.
      const visibleNodes = (db.prepare(`SELECT node.node_id,node.title,node.description,state.status,state.updated_at FROM story_nodes_v34 node
        JOIN story_node_state_v34 state USING(campaign_id,storyline_id,node_id) WHERE node.campaign_id=? AND state.status<>'hidden'
        ORDER BY state.updated_at,node.node_id`).all(campaignId) as any[]).map((row) => ({ nodeId: row.node_id,
          title: row.title, description: row.description, status: row.status, updatedAt: row.updated_at }));
      const discoveredClues = (db.prepare(`SELECT clue.clue_id,clue.title,clue.content,discovery.discovered_at FROM story_clues_v34 clue
        JOIN story_discoveries_v34 discovery USING(campaign_id,storyline_id,clue_id) WHERE clue.campaign_id=? ORDER BY discovery.discovered_at,clue.clue_id`)
        .all(campaignId) as any[]).map((row) => ({ clueId: row.clue_id, title: row.title, content: row.content, discoveredAt: row.discovered_at }));
      return campaignStoryHttpResponseSchema.parse({ visibleNodes, discoveredClues });
    }
    const storylineRows = db.prepare(`SELECT root.*,metadata.summary,metadata.status metadata_status,metadata.updated_at FROM quest_storylines root
      LEFT JOIN story_metadata_v34 metadata ON metadata.campaign_id=root.campaign_id AND metadata.storyline_id=root.id
      WHERE root.campaign_id=? ORDER BY root.created_at,root.id`).all(campaignId) as any[];
    const nodes = (db.prepare(`SELECT node.*,state.status,state.updated_at FROM story_nodes_v34 node JOIN story_node_state_v34 state
      USING(campaign_id,storyline_id,node_id) WHERE node.campaign_id=? ORDER BY node.storyline_id,node.sort_order,node.node_id`).all(campaignId) as any[])
      .map((row) => ({ nodeId: row.node_id, storylineId: row.storyline_id, title: row.title, description: row.description, gmNotes: row.gm_notes,
        status: row.status, revealThreshold: row.reveal_threshold, createdAt: storylineProjection(storylineRows.find((item) => item.id === row.storyline_id)).createdAt, updatedAt: row.updated_at }));
    const edges = (db.prepare("SELECT edge_id,storyline_id,kind,from_node_id,to_node_id FROM story_edges_v34 WHERE campaign_id=? ORDER BY storyline_id,edge_id").all(campaignId) as any[])
      .map((row) => ({ edgeId: row.edge_id, storylineId: row.storyline_id, kind: row.kind, fromNodeId: row.from_node_id, toNodeId: row.to_node_id }));
    const plotPoints = (db.prepare(`SELECT point.*,answer.player_answer,answer.answered_at FROM story_plot_points_v34 point LEFT JOIN story_plot_point_answers_v34 answer
      USING(campaign_id,storyline_id,plot_point_id) WHERE point.campaign_id=? ORDER BY point.storyline_id,point.plot_point_id`).all(campaignId) as any[])
      .map((row) => ({ plotPointId: row.plot_point_id, storylineId: row.storyline_id, nodeId: row.node_id, question: row.question,
        answer: row.answer, gmNotes: row.gm_notes, answered: row.answered_at !== null, playerAnswer: row.player_answer ?? null, answeredAt: row.answered_at ?? null }));
    const sourceStatement = db.prepare("SELECT source_id,source_kind,target_id FROM story_clue_sources_v34 WHERE campaign_id=? AND storyline_id=? AND clue_id=? ORDER BY source_id");
    const clues = (db.prepare(`SELECT clue.*,discovery.discovered_at FROM story_clues_v34 clue LEFT JOIN story_discoveries_v34 discovery
      USING(campaign_id,storyline_id,clue_id) WHERE clue.campaign_id=? ORDER BY clue.storyline_id,clue.clue_id`).all(campaignId) as any[])
      .map((row) => ({ clueId: row.clue_id, storylineId: row.storyline_id, title: row.title, content: row.content, truth: row.truth,
        gmNotes: row.gm_notes, revealThreshold: row.reveal_threshold, revealed: row.discovered_at !== null, revealedAt: row.discovered_at ?? null,
        sources: (sourceStatement.all(campaignId, row.storyline_id, row.clue_id) as any[]).map((source) => ({ sourceId: source.source_id, kind: source.source_kind, targetId: source.target_id })) }));
    return campaignStoryHttpResponseSchema.parse({ storylines: storylineRows.map(storylineProjection), nodes, edges, plotPoints, clues });
  }

  const receipt = (mutation: any): InternalReceipt => ({ commandId: mutation.commandId, idempotencyKey: mutation.key,
    revisionBefore: mutation.before, revisionAfter: mutation.after, occurredAt: mutation.at });
  function begin(principalId: string, campaignId: string, storylineId: string, type: string, value: unknown, expected: number, key: string) {
    const request = canonical(value);
    const old = db.prepare(`SELECT command.principal_id,command.command_type,command.canonical_request_json,receipt.canonical_result_json
      FROM story_commands_v34 command JOIN story_receipts_v34 receipt USING(campaign_id,command_id) WHERE command.campaign_id=? AND command.idempotency_key=?`)
      .get(campaignId, key) as any;
    if (old) {
      if (old.principal_id !== principalId || old.command_type !== type || old.canonical_request_json !== request) throw new StoryConflictError("idempotency key was reused");
      return { replay: JSON.parse(old.canonical_result_json) } as const;
    }
    const before = revision(campaignId); if (before !== expected) throw new StoryStaleError("story revision is stale");
    return { replay: null, principalId, campaignId, storylineId, type, request, key, before, after: before + 1, commandId: nextId(), at: now() } as const;
  }
  function commandRow(mutation: any) {
    if (!db.prepare("SELECT 1 FROM story_campaign_revisions_v34 WHERE campaign_id=?").get(mutation.campaignId)) {
      db.prepare("INSERT INTO story_campaign_revisions_v34 VALUES(?,0,?)").run(mutation.campaignId, mutation.at);
    }
    db.prepare("INSERT INTO story_commands_v34 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(mutation.campaignId, mutation.commandId, mutation.storylineId,
      mutation.principalId, mutation.type, mutation.key, mutation.request, digest(JSON.parse(mutation.request)), mutation.before, mutation.after, mutation.at);
  }
  function finish(mutation: any, result: StoryMutationResult | StorylineCreationResult, eventType: string, event: unknown) {
    db.prepare("INSERT INTO story_receipts_v34 VALUES(?,?,?,?,?,?)").run(mutation.campaignId, mutation.commandId, mutation.after, canonical(result), digest(result), mutation.at);
    db.prepare("INSERT INTO story_events_v34 VALUES(?,?,?,?,?,?,?)").run(nextId(), mutation.campaignId, mutation.commandId, mutation.after, eventType, canonical(event), mutation.at);
    db.prepare("UPDATE story_campaign_revisions_v34 SET revision=?,updated_at=? WHERE campaign_id=?").run(mutation.after, mutation.at, mutation.campaignId);
  }
  function assertGraphIntegrity(edges: CreateCampaignStorylineHttpRequest["storyline"]["edges"], clues: CreateCampaignStorylineHttpRequest["storyline"]["clues"]) {
    const semantics = edges.map((edge) => `${edge.kind}\u0000${edge.fromNodeId}\u0000${edge.toNodeId}`);
    if (new Set(semantics).size !== semantics.length) throw new StoryConflictError("duplicate semantic story edges are not allowed");
    for (const clue of clues) { const sources = clue.sources.map((source) => `${source.kind}\u0000${source.targetId}`);
      if (new Set(sources).size !== sources.length) throw new StoryConflictError("duplicate clue source targets are not allowed"); }
    const graph = new Map<string, string[]>(); for (const edge of edges) graph.set(edge.fromNodeId, [...(graph.get(edge.fromNodeId) ?? []), edge.toNodeId]);
    const active = new Set<string>(), done = new Set<string>(); const visit = (id: string) => { if (active.has(id)) throw new StoryConflictError("story edges contain a cycle");
      if (done.has(id)) return; active.add(id); for (const dependency of graph.get(id) ?? []) visit(dependency); active.delete(id); done.add(id); };
    for (const id of graph.keys()) visit(id);
  }

  return {
    getCampaignStory(principalId, campaignIdInput) { guard(); const campaignId = resourceIdSchema.parse(campaignIdInput); const member = membership(principalId, campaignId);
      return member ? { campaignId, revision: revision(campaignId), story: project(campaignId, isGm(member.role)) } : null; },
    createCampaignStorylineGraph(principalId, campaignIdInput, raw) { guard(); const campaignId = resourceIdSchema.parse(campaignIdInput), input = createCampaignStorylineHttpRequestSchema.parse(raw);
      const member = membership(principalId, campaignId); if (!member || !isGm(member.role)) throw new StoryAuthorizationError("GM authority is required");
      return db.transaction(() => {
        assertGraphIntegrity(input.storyline.edges, input.storyline.clues);
        const incoming = new Map<string, number>(); for (const edge of input.storyline.edges) incoming.set(edge.toNodeId, (incoming.get(edge.toNodeId) ?? 0) + 1);
        for (const node of input.storyline.nodes) if (node.revealThreshold > (incoming.get(node.nodeId) ?? 0)) throw new StoryConflictError("node reveal threshold exceeds incoming edge count");
        const mutation = begin(principalId, campaignId, input.storyline.storylineId, "create-storyline", { campaignId, ...input }, input.expectedRevision, input.idempotencyKey);
        if (mutation.replay) return mutation.replay as StorylineCreationResult;
        if (db.prepare("SELECT 1 FROM quest_storylines WHERE id=?").get(input.storyline.storylineId)) throw new StoryConflictError("storyline ID already exists");
        commandRow(mutation);
        db.prepare("INSERT INTO quest_storylines(id,campaign_id,title,description,status,created_at) VALUES(?,?,?,?,?,?)").run(input.storyline.storylineId, campaignId, input.storyline.title, input.storyline.summary, "active", mutation.at);
        db.prepare("INSERT INTO story_metadata_v34 VALUES(?,?,?,?,?,?)").run(campaignId, input.storyline.storylineId, input.storyline.summary, "active", mutation.commandId, mutation.at);
        const insertNode = db.prepare("INSERT INTO story_nodes_v34 VALUES(?,?,?,?,?,?,?,?,?)");
        input.storyline.nodes.forEach((node, index) => { insertNode.run(campaignId, input.storyline.storylineId, node.nodeId, node.title, node.description, node.gmNotes, node.revealThreshold, index, mutation.commandId);
          db.prepare("INSERT INTO story_node_state_v34 VALUES(?,?,?,?,?,?)").run(campaignId, input.storyline.storylineId, node.nodeId, "hidden", mutation.commandId, mutation.at); });
        for (const edge of input.storyline.edges) db.prepare("INSERT INTO story_edges_v34 VALUES(?,?,?,?,?,?,?)").run(campaignId, input.storyline.storylineId, edge.edgeId, edge.kind, edge.fromNodeId, edge.toNodeId, mutation.commandId);
        for (const point of input.storyline.plotPoints) db.prepare("INSERT INTO story_plot_points_v34 VALUES(?,?,?,?,?,?,?,?)").run(campaignId, input.storyline.storylineId, point.plotPointId, point.nodeId, point.question, point.answer, point.gmNotes, mutation.commandId);
        for (const clue of input.storyline.clues) { db.prepare("INSERT INTO story_clues_v34 VALUES(?,?,?,?,?,?,?,?,?)").run(campaignId, input.storyline.storylineId, clue.clueId, clue.title, clue.content, clue.truth, clue.gmNotes, clue.revealThreshold, mutation.commandId);
          for (const source of clue.sources) db.prepare("INSERT INTO story_clue_sources_v34 VALUES(?,?,?,?,?,?)").run(campaignId, input.storyline.storylineId, clue.clueId, source.sourceId, source.kind, source.targetId); }
        const row = db.prepare(`SELECT root.*,metadata.summary,metadata.status metadata_status,metadata.updated_at FROM quest_storylines root JOIN story_metadata_v34 metadata
          ON metadata.campaign_id=root.campaign_id AND metadata.storyline_id=root.id WHERE root.campaign_id=? AND root.id=?`).get(campaignId, input.storyline.storylineId);
        const result: StorylineCreationResult = { campaignId, storyline: storylineProjection(row), story: project(campaignId, true), receipt: receipt(mutation) };
        finish(mutation, result, "storyline-created", { storylineId: input.storyline.storylineId }); return result;
      }).immediate();
    },
    executeStorylineCommand(principalId, storylineIdInput, raw) { guard(); const storylineId = resourceIdSchema.parse(storylineIdInput), input = storylineCommandHttpRequestSchema.parse(raw);
      return db.transaction(() => {
        const root = db.prepare("SELECT campaign_id FROM story_metadata_v34 WHERE storyline_id=?").get(storylineId) as { campaign_id: string } | undefined;
        if (!root) throw new StoryUnavailableError("storyline is unavailable");
        const member = membership(principalId, root.campaign_id); if (!member || !isGm(member.role)) throw new StoryAuthorizationError("GM authority is required");
        // Target ancestry and authorization are established before replay or stale checks.
        const table = input.kind === "reveal-node" || input.kind === "resolve-node" ? "story_nodes_v34" : input.kind === "reveal-clue" ? "story_clues_v34" : "story_plot_points_v34";
        const column = input.kind === "reveal-node" || input.kind === "resolve-node" ? "node_id" : input.kind === "reveal-clue" ? "clue_id" : "plot_point_id";
        if (!db.prepare(`SELECT 1 FROM ${table} WHERE campaign_id=? AND storyline_id=? AND ${column}=?`).get(root.campaign_id, storylineId, input.targetId)) throw new StoryUnavailableError("story target is unavailable");
        const mutation = begin(principalId, root.campaign_id, storylineId, input.kind, { storylineId, ...input }, input.expectedRevision, input.idempotencyKey);
        if (mutation.replay) return mutation.replay as StoryMutationResult;
        commandRow(mutation); let eventType: "node-revealed" | "node-resolved" | "clue-revealed" | "plot-point-answered";
        if (input.kind === "reveal-node") {
          const state = db.prepare("SELECT status FROM story_node_state_v34 WHERE campaign_id=? AND storyline_id=? AND node_id=?").get(root.campaign_id, storylineId, input.targetId) as { status: string };
          if (state.status !== "hidden") throw new StoryConflictError("node is already visible");
          const unresolvedRequirement = db.prepare(`SELECT 1 FROM story_edges_v34 edge JOIN story_node_state_v34 state
            ON state.campaign_id=edge.campaign_id AND state.storyline_id=edge.storyline_id AND state.node_id=edge.from_node_id
            WHERE edge.campaign_id=? AND edge.storyline_id=? AND edge.to_node_id=? AND edge.kind='requires' AND state.status<>'resolved' LIMIT 1`)
            .get(root.campaign_id, storylineId, input.targetId);
          if (unresolvedRequirement) throw new StoryConflictError("required nodes must be resolved before reveal");
          const threshold = (db.prepare("SELECT reveal_threshold FROM story_nodes_v34 WHERE campaign_id=? AND storyline_id=? AND node_id=?").get(root.campaign_id, storylineId, input.targetId) as any).reveal_threshold;
          // Every resolved incoming sequence or requires predecessor contributes one reveal-threshold point.
          const available = (db.prepare(`SELECT count(*) count FROM story_edges_v34 edge JOIN story_node_state_v34 state ON state.campaign_id=edge.campaign_id
            AND state.storyline_id=edge.storyline_id AND state.node_id=edge.from_node_id WHERE edge.campaign_id=? AND edge.storyline_id=? AND edge.to_node_id=? AND state.status='resolved'`)
            .get(root.campaign_id, storylineId, input.targetId) as any).count;
          if (available < threshold) throw new StoryConflictError("node reveal threshold is not met");
          db.prepare("UPDATE story_node_state_v34 SET status='revealed',last_command_id=?,updated_at=? WHERE campaign_id=? AND storyline_id=? AND node_id=?").run(mutation.commandId, mutation.at, root.campaign_id, storylineId, input.targetId); eventType = "node-revealed";
        } else if (input.kind === "resolve-node") {
          const state = db.prepare("SELECT status FROM story_node_state_v34 WHERE campaign_id=? AND storyline_id=? AND node_id=?").get(root.campaign_id, storylineId, input.targetId) as { status: string };
          if (state.status !== "revealed") throw new StoryConflictError("only revealed nodes can be resolved");
          const blocked = db.prepare(`SELECT 1 FROM story_edges_v34 edge JOIN story_node_state_v34 state ON state.campaign_id=edge.campaign_id AND state.storyline_id=edge.storyline_id
            AND state.node_id=edge.from_node_id WHERE edge.campaign_id=? AND edge.storyline_id=? AND edge.to_node_id=? AND edge.kind='requires' AND state.status<>'resolved' LIMIT 1`).get(root.campaign_id, storylineId, input.targetId);
          if (blocked) throw new StoryConflictError("required nodes are unresolved");
          db.prepare("UPDATE story_node_state_v34 SET status='resolved',last_command_id=?,updated_at=? WHERE campaign_id=? AND storyline_id=? AND node_id=?").run(mutation.commandId, mutation.at, root.campaign_id, storylineId, input.targetId); eventType = "node-resolved";
        } else if (input.kind === "answer-plot-point") {
          if (db.prepare("SELECT 1 FROM story_plot_point_answers_v34 WHERE campaign_id=? AND storyline_id=? AND plot_point_id=?").get(root.campaign_id, storylineId, input.targetId)) throw new StoryConflictError("plot point is already answered");
          db.prepare("INSERT INTO story_plot_point_answers_v34 VALUES(?,?,?,?,?,?)").run(root.campaign_id, storylineId, input.targetId, input.data.answer, mutation.commandId, mutation.at); eventType = "plot-point-answered";
        } else {
          if (db.prepare("SELECT 1 FROM story_discoveries_v34 WHERE campaign_id=? AND storyline_id=? AND clue_id=?").get(root.campaign_id, storylineId, input.targetId)) throw new StoryConflictError("clue is already revealed");
          const clue = db.prepare("SELECT reveal_threshold FROM story_clues_v34 WHERE campaign_id=? AND storyline_id=? AND clue_id=?").get(root.campaign_id, storylineId, input.targetId) as any;
          const available = (db.prepare(`SELECT count(*) count FROM story_clue_sources_v34 source WHERE source.campaign_id=? AND source.storyline_id=? AND source.clue_id=? AND
            ((source.source_kind='node' AND EXISTS(SELECT 1 FROM story_node_state_v34 state WHERE state.campaign_id=source.campaign_id AND state.storyline_id=source.storyline_id AND state.node_id=source.target_id AND state.status<>'hidden')) OR
             (source.source_kind='plot-point' AND EXISTS(SELECT 1 FROM story_plot_point_answers_v34 answer WHERE answer.campaign_id=source.campaign_id AND answer.storyline_id=source.storyline_id AND answer.plot_point_id=source.target_id)))`)
            .get(root.campaign_id, storylineId, input.targetId) as any).count;
          if (available < clue.reveal_threshold) throw new StoryConflictError("clue reveal threshold is not met");
          db.prepare("INSERT INTO story_discoveries_v34 VALUES(?,?,?,?,?)").run(root.campaign_id, storylineId, input.targetId, mutation.commandId, mutation.at); eventType = "clue-revealed";
        }
        const result: StoryMutationResult = { campaignId: root.campaign_id, storylineId, story: project(root.campaign_id, true), receipt: receipt(mutation) };
        finish(mutation, result, eventType, { storylineId, kind: input.kind, targetId: input.targetId }); return result;
      }).immediate();
    },
  };
}
