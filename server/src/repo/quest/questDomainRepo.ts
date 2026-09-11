import { createHash, randomUUID } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  campaignQuestHttpSchema,
  createCampaignQuestHttpRequestSchema,
  questCommandHttpRequestSchema,
  questJournalEntryHttpSchema,
  questObjectiveHttpSchema,
  resourceIdSchema,
  utcIsoTimestampSchema,
  type CampaignQuestHttp,
  type CampaignQuestProjectionHttp,
  type CreateCampaignQuestHttpRequest,
  type QuestCommandHttpRequest,
  type QuestCommandReceiptHttp,
  type QuestJournalEntryHttp,
  type QuestObjectiveHttp,
} from "@velvet/contracts";
import { boundAdventureQuestReceipts, makeAdventureQuestCandidate } from "./adventureQuestBinding.js";

type Database = DatabaseDriver.Database;
type InternalReceipt = QuestCommandReceiptHttp & { commandId: string };

export class QuestAuthorizationError extends Error { readonly code = "QUEST_AUTHORIZATION"; }
export class QuestStaleError extends Error { readonly code = "QUEST_STALE"; }
export class QuestConflictError extends Error { readonly code = "QUEST_CONFLICT"; }
export class QuestDomainUnavailableError extends Error { readonly code = "QUEST_DOMAIN_UNAVAILABLE"; }

export interface CampaignQuestSnapshot {
  campaignId: string;
  revision: number;
  quests: CampaignQuestProjectionHttp[];
  objectives: QuestObjectiveHttp[];
  journal: QuestJournalEntryHttp[];
}
export interface QuestMutationResult { campaignId: string; quest: CampaignQuestProjectionHttp; receipt: InternalReceipt }
export interface AdventureQuestObjectiveCandidate {
  candidateId: string; digest: string; questTitle: string; objectiveDescription: string;
  progress: number; targetProgress: number; questId: string; objectiveId: string; questRevision: number;
}
export interface AdventureQuestNarrationReceipt {
  questTitle: string; objectiveDescription: string; progressBefore: number; progressAfter: number; targetProgress: number;
  objectiveCompleted: boolean; questCompleted: boolean;
}
export interface AdventureQuestPublicReceipt extends AdventureQuestNarrationReceipt {
  revisionBefore: number; revisionAfter: number; occurredAt: string;
}
export interface QuestCreateMutationResult extends QuestMutationResult {
  definition: CreateCampaignQuestHttpRequest["quest"];
  projection: Omit<CampaignQuestSnapshot, "campaignId" | "revision">;
  revision: number;
}

/** A persisted observation an authored quest offer is allowed to reference. */
export interface QuestOfferKnowledgeSource {
  agentKind: "npc" | "faction" | "companion" | "town";
  agentId: string;
  sourceCommandId: string;
}
export interface KnowledgeGatedQuestOfferInput {
  offer: CreateCampaignQuestHttpRequest;
  knowledgeSource: QuestOfferKnowledgeSource;
}
export interface KnowledgeGatedQuestOfferResult extends QuestCreateMutationResult {
  knowledgeSource: QuestOfferKnowledgeSource;
}

export interface QuestDomainRepository {
  listCampaignQuests(principalId: string, campaignId: string): CampaignQuestSnapshot | null;
  createCampaignQuest(principalId: string, campaignId: string, input: CreateCampaignQuestHttpRequest): QuestCreateMutationResult;
  /** Creates a GM-authored offer only when the referenced observation already exists. */
  createKnowledgeGatedQuestOffer(principalId: string, campaignId: string, input: KnowledgeGatedQuestOfferInput): KnowledgeGatedQuestOfferResult;
  executeQuestCommand(principalId: string, questId: string, input: QuestCommandHttpRequest): QuestMutationResult;
  listAdventureQuestObjectiveCandidates(principalId: string, turnId: string): AdventureQuestObjectiveCandidate[];
  executeAdventureQuestObjectiveCandidate(principalId: string, input: { turnId: string; providerCallId: string; candidateId: string; digest: string }): QuestMutationResult;
  getAdventureQuestNarrationReceipt(principalId: string, turnId: string, commandId: string): AdventureQuestNarrationReceipt | null;
  getAdventureQuestPublicReceipt(principalId: string, campaignId: string, commandId: string): AdventureQuestPublicReceipt | null;
}
export interface QuestDomainContext { clock: { now(): Date }; ids: { nextId(): string }; guard(): void }

const canonicalValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalValue)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalValue(item)]))
    : value;
const canonical = (value: unknown): string => JSON.stringify(canonicalValue(value));
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const adventureQuestKey = (providerCallId: string,candidateId:string): string =>
  resourceIdSchema.parse(`adventure-quest:${providerCallId.slice(-32)}:${candidateId.slice(-32)}`);
const status = (value: string): CampaignQuestHttp["status"] => value === "active" ? "active"
  : value === "completed" ? "completed" : value === "failed" ? "abandoned" : "offered";
const timestamp = (value: string): string => {
  const direct = utcIsoTimestampSchema.safeParse(value); if (direct.success) return direct.data;
  const legacy = `${value.replace(" ", "T")}${value.endsWith("Z") ? "" : value.includes(".") ? "Z" : ".000Z"}`;
  return utcIsoTimestampSchema.parse(legacy);
};

/** Authoritative v33 quest aggregate layered over preserved v29 quest rows. */
export function createQuestDomainRepository(db: Database, context: QuestDomainContext = {
  clock: { now: () => new Date() }, ids: { nextId: () => randomUUID() }, guard: () => undefined,
}): QuestDomainRepository {
  const now = () => utcIsoTimestampSchema.parse(context.clock.now().toISOString());
  const id = () => resourceIdSchema.parse(context.ids.nextId());
  const membership = (principalId: string, campaignId: string) => db.prepare(
    "SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?",
  ).get(campaignId, principalId) as { role: string } | undefined;
  const isGm = (role: string) => role === "owner" || role === "gm";
  const revision = (campaignId: string): number => (db.prepare(
    "SELECT revision FROM quest_domain_revisions_v33 WHERE campaign_id=?",
  ).get(campaignId) as { revision: number } | undefined)?.revision ?? 0;

  function rewards(campaignId: string, questId: string, privileged: boolean): CampaignQuestHttp["rewards"] {
    const rows = db.prepare(`SELECT reward.id, reward.kind, reward.amount, reward.label,
      definition.visibility, claim.actor_id, claim.claimed_at, reward.granted_to_character_id, reward.granted_at
      FROM quest_rewards reward LEFT JOIN quest_reward_definitions_v33 definition
        ON definition.campaign_id=reward.campaign_id AND definition.quest_id=reward.quest_id AND definition.reward_id=reward.id
      LEFT JOIN quest_reward_claims_v33 claim
        ON claim.campaign_id=reward.campaign_id AND claim.quest_id=reward.quest_id AND claim.reward_id=reward.id
      WHERE reward.campaign_id=? AND reward.quest_id=? ORDER BY reward.created_at,reward.id`).all(campaignId, questId) as any[];
    return rows.filter((row) => privileged || row.visibility === "public").map((row) => ({
      rewardId: row.id, kind: row.kind, amount: row.amount, label: row.label,
      claimedByActorId: row.actor_id ?? null,
      // A legacy character ID is not a campaign actor ID and must never cross the new HTTP boundary.
      claimedAt: row.actor_id ? row.claimed_at : null,
    }));
  }

  function projectQuest(row: any, privileged: boolean): CampaignQuestProjectionHttp {
    const projected = campaignQuestHttpSchema.parse({ questId: row.id, campaignId: row.campaign_id,
      storylineId: row.storyline_id, title: row.title, description: row.description, status: status(row.status),
      rewards: rewards(row.campaign_id, row.id, privileged), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });
    if (privileged) return projected;
    const { storylineId: _hiddenStorylineId, ...player } = projected;
    return player;
  }

  function snapshot(principalId: string, campaignId: string): CampaignQuestSnapshot | null {
    const member = membership(principalId, campaignId); if (!member) return null;
    const privileged = isGm(member.role);
    const questRows = db.prepare(`SELECT quest.* FROM quests quest LEFT JOIN quest_definitions_v33 definition
      ON definition.campaign_id=quest.campaign_id AND definition.quest_id=quest.id
      WHERE quest.campaign_id=? AND (?=1 OR definition.visibility='public') ORDER BY quest.sort_order,quest.id`)
      .all(campaignId, privileged ? 1 : 0) as any[];
    const visibleQuestIds = new Set(questRows.map((row) => row.id));
    const objectiveRows = db.prepare(`SELECT objective.*,progress.progress,progress.completed_at FROM quest_objectives_v33 objective
      JOIN quest_objective_progress_v33 progress USING(campaign_id,quest_id,objective_id)
      WHERE objective.campaign_id=? AND (?=1 OR objective.visibility='public') ORDER BY objective.quest_id,objective.sort_order,objective.objective_id`)
      .all(campaignId, privileged ? 1 : 0) as any[];
    const visibleObjectiveIds = new Set(objectiveRows.map((row) => row.objective_id));
    const dependency = db.prepare(`SELECT dependency_objective_id FROM quest_objective_dependencies_v33
      WHERE campaign_id=? AND quest_id=? AND objective_id=? ORDER BY dependency_objective_id`);
    const objectives = objectiveRows.filter((row) => visibleQuestIds.has(row.quest_id)).map((row) => questObjectiveHttpSchema.parse({
      objectiveId: row.objective_id, questId: row.quest_id, description: row.description,
      targetProgress: row.target_progress, progress: row.progress,
      dependencyObjectiveIds: (dependency.all(campaignId, row.quest_id, row.objective_id) as any[])
        .map((item) => item.dependency_objective_id).filter((dependencyId) => privileged || visibleObjectiveIds.has(dependencyId)),
      completedAt: row.completed_at,
    }));
    // Legacy completions are owner/GM-only fallback projections because v29 carried no visibility attestation.
    if (privileged) {
      const legacy = db.prepare(`SELECT completion.* FROM quest_objective_completions completion JOIN quests quest ON quest.id=completion.quest_id
        WHERE quest.campaign_id=? AND NOT EXISTS(SELECT 1 FROM quest_definitions_v33 definition WHERE definition.campaign_id=quest.campaign_id AND definition.quest_id=quest.id)
        ORDER BY completion.completed_at,completion.id`).all(campaignId) as any[];
      objectives.push(...legacy.map((row) => questObjectiveHttpSchema.parse({ objectiveId: row.id, questId: row.quest_id,
        description: row.description, targetProgress: 1, progress: 1, dependencyObjectiveIds: [], completedAt: timestamp(row.completed_at) })));
    }
    const journalRows = db.prepare(`SELECT * FROM quest_journal_v33 WHERE campaign_id=? AND (?=1 OR visibility='public') ORDER BY occurred_at,entry_id`)
      .all(campaignId, privileged ? 1 : 0) as any[];
    const journal = journalRows.filter((row) => visibleQuestIds.has(row.quest_id)).map((row) => questJournalEntryHttpSchema.parse({
      entryId: row.entry_id, questId: row.quest_id, text: row.text, occurredAt: row.occurred_at,
    }));
    if (privileged) {
      const legacyClues = db.prepare(`SELECT clue.* FROM quest_clues clue JOIN quests quest ON quest.id=clue.quest_id
        WHERE quest.campaign_id=? AND NOT EXISTS(SELECT 1 FROM quest_definitions_v33 definition WHERE definition.campaign_id=quest.campaign_id AND definition.quest_id=quest.id)
        ORDER BY clue.created_at,clue.id`).all(campaignId) as any[];
      journal.push(...legacyClues.map((row) => questJournalEntryHttpSchema.parse({ entryId: row.id, questId: row.quest_id,
        text: row.content, occurredAt: timestamp(row.discovered_at ?? row.created_at) })));
    }
    return { campaignId, revision: revision(campaignId), quests: questRows.map((row) => projectQuest(row, privileged)), objectives, journal };
  }

  /** Reconstructs the immutable creation definition exclusively from durable v29/v33 rows. */
  function durableDefinition(campaignId: string, questId: string): CreateCampaignQuestHttpRequest["quest"] {
    const quest = db.prepare(`SELECT quest.*,definition.visibility,definition.created_command_id FROM quests quest
      JOIN quest_definitions_v33 definition ON definition.campaign_id=quest.campaign_id AND definition.quest_id=quest.id
      WHERE quest.campaign_id=? AND quest.id=?`).get(campaignId, questId) as any;
    if (!quest) throw new QuestDomainUnavailableError("persisted quest definition is unavailable");
    const objectiveRows = db.prepare(`SELECT * FROM quest_objectives_v33 WHERE campaign_id=? AND quest_id=? ORDER BY sort_order,objective_id`)
      .all(campaignId, questId) as any[];
    const dependency = db.prepare(`SELECT dependency_objective_id FROM quest_objective_dependencies_v33
      WHERE campaign_id=? AND quest_id=? AND objective_id=? ORDER BY dependency_objective_id`);
    const rewardRows = db.prepare(`SELECT reward.id,reward.kind,reward.amount,reward.label,definition.visibility
      FROM quest_rewards reward JOIN quest_reward_definitions_v33 definition
        ON definition.campaign_id=reward.campaign_id AND definition.quest_id=reward.quest_id AND definition.reward_id=reward.id
      WHERE reward.campaign_id=? AND reward.quest_id=? ORDER BY reward.created_at,reward.id`).all(campaignId, questId) as any[];
    const journal = db.prepare(`SELECT text FROM quest_journal_v33 WHERE campaign_id=? AND quest_id=? AND command_id=?
      ORDER BY occurred_at,entry_id LIMIT 1`).get(campaignId, questId, quest.created_command_id) as { text: string } | undefined;
    return createCampaignQuestHttpRequestSchema.shape.quest.parse({ questId, storylineId:quest.storyline_id,title:quest.title,
      description:quest.description,visibility:quest.visibility,
      objectives:objectiveRows.map((objective)=>({objectiveId:objective.objective_id,description:objective.description,
        targetProgress:objective.target_progress,visibility:objective.visibility,
        dependencyObjectiveIds:(dependency.all(campaignId,questId,objective.objective_id) as Array<{dependency_objective_id:string}>).map((row)=>row.dependency_objective_id)})),
      rewards:rewardRows.map((reward)=>({rewardId:reward.id,kind:reward.kind,amount:reward.amount,label:reward.label,visibility:reward.visibility})),
      journalText:journal?.text });
  }

  function roleSafeResult(result: QuestMutationResult, privileged: boolean): QuestMutationResult {
    if (privileged) return result;
    const visibleRewardIds = new Set((db.prepare(`SELECT reward_id FROM quest_reward_definitions_v33
      WHERE campaign_id=? AND quest_id=? AND visibility='public'`).all(result.campaignId, result.quest.questId) as Array<{ reward_id: string }>)
      .map((row) => row.reward_id));
    const { storylineId: _hiddenStorylineId, ...playerQuest } = result.quest as CampaignQuestHttp;
    return { ...result, quest: { ...playerQuest, rewards: result.quest.rewards.filter((reward) => visibleRewardIds.has(reward.rewardId)) } };
  }

  function replay(principalId: string, campaignId: string, type: string, request: string, key: string, privileged: boolean): QuestMutationResult | null {
    const row = db.prepare(`SELECT command.command_type,command.principal_id,command.canonical_request_json,receipt.canonical_result_json
      FROM quest_domain_commands_v33 command JOIN quest_domain_receipts_v33 receipt USING(campaign_id,command_id)
      WHERE command.campaign_id=? AND command.idempotency_key=?`).get(campaignId, key) as any;
    if (!row) return null;
    if (row.principal_id !== principalId || row.command_type !== type || row.canonical_request_json !== request)
      throw new QuestConflictError("idempotency key was reused");
    return roleSafeResult(JSON.parse(row.canonical_result_json) as QuestMutationResult, privileged);
  }

  function begin(principalId: string, campaignId: string, questId: string, type: string, requestValue: unknown,
    expectedRevision: number, key: string, privileged: boolean) {
    const request = canonical(requestValue); const repeated = replay(principalId, campaignId, type, request, key, privileged);
    if (repeated) return { replay: repeated } as const;
    const before = revision(campaignId); if (before !== expectedRevision) throw new QuestStaleError("quest revision is stale");
    return { replay: null, request, before, after: before + 1, commandId: id(), at: now(), principalId, campaignId, questId, type, key } as const;
  }

  function record(mutation: Exclude<ReturnType<typeof begin>, { replay: QuestMutationResult }>, result: QuestMutationResult,
    eventType: string, event: unknown): void {
    if (!db.prepare("SELECT 1 FROM quest_domain_revisions_v33 WHERE campaign_id=?").get(mutation.campaignId)) {
      db.prepare("INSERT INTO quest_domain_revisions_v33 VALUES(?,0,?)").run(mutation.campaignId, mutation.at);
    }
    db.prepare("INSERT INTO quest_domain_commands_v33 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(mutation.campaignId,
      mutation.commandId, mutation.questId, mutation.principalId, mutation.type, mutation.key, mutation.request, digest(JSON.parse(mutation.request)),
      mutation.before, mutation.after, mutation.at);
    db.prepare("INSERT INTO quest_domain_receipts_v33 VALUES(?,?,?,?,?,?)").run(mutation.campaignId, mutation.commandId,
      mutation.after, canonical(result), digest(result), mutation.at);
    db.prepare("INSERT INTO quest_domain_events_v33 VALUES(?,?,?,?,?,?,?)").run(id(), mutation.campaignId,
      mutation.commandId, mutation.after, eventType, canonical(event), mutation.at);
    db.prepare("UPDATE quest_domain_revisions_v33 SET revision=?,updated_at=? WHERE campaign_id=?")
      .run(mutation.after, mutation.at, mutation.campaignId);
  }

  function receipt(mutation: any): InternalReceipt { return { commandId: mutation.commandId, idempotencyKey: mutation.key,
    revisionBefore: mutation.before, revisionAfter: mutation.after, occurredAt: mutation.at }; }
  function addJournal(mutation: any, text: string, visibility: "public" | "gm") {
    db.prepare("INSERT INTO quest_journal_v33 VALUES(?,?,?,?,?,?,?)").run(mutation.campaignId, mutation.questId,
      id(), text, visibility, mutation.commandId, mutation.at);
  }
  function assertAcyclic(objectives: CreateCampaignQuestHttpRequest["quest"]["objectives"]): void {
    const graph = new Map(objectives.map((objective) => [objective.objectiveId, objective.dependencyObjectiveIds]));
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (objectiveId: string) => { if (visiting.has(objectiveId)) throw new QuestConflictError("objective dependencies contain a cycle");
      if (visited.has(objectiveId)) return; visiting.add(objectiveId); for (const dependency of graph.get(objectiveId) ?? []) visit(dependency);
      visiting.delete(objectiveId); visited.add(objectiveId); };
    for (const objectiveId of graph.keys()) visit(objectiveId);
  }
  function assertVisibilityDependencies(objectives: CreateCampaignQuestHttpRequest["quest"]["objectives"]): void {
    const definitions = new Map(objectives.map((objective) => [objective.objectiveId, objective]));
    const inspect = (rootId: string, objectiveId: string, seen: Set<string>) => {
      if (seen.has(objectiveId)) return; seen.add(objectiveId);
      for (const dependencyId of definitions.get(objectiveId)?.dependencyObjectiveIds ?? []) {
        const dependency = definitions.get(dependencyId)!;
        if (definitions.get(rootId)?.visibility === "public" && dependency.visibility !== "public")
          throw new QuestConflictError("public objectives cannot depend on GM objectives");
        inspect(rootId, dependencyId, seen);
      }
    };
    for (const objective of objectives) if (objective.visibility === "public") inspect(objective.objectiveId, objective.objectiveId, new Set());
  }

  function adventureCandidates(principalId: string, turnId: string): AdventureQuestObjectiveCandidate[] {
    const turn = db.prepare(`SELECT turn.campaign_id,turn.actor_id,turn.session_id FROM adventure_turns turn
      JOIN campaign_memberships member ON member.campaign_id=turn.campaign_id AND member.principal_id=?
      JOIN campaign_sessions attached ON attached.campaign_id=turn.campaign_id AND attached.session_id=turn.session_id
      JOIN sessions session ON session.id=attached.session_id
      LEFT JOIN campaign_actor_private_state control ON control.campaign_id=turn.campaign_id AND control.actor_id=turn.actor_id
        AND control.controller_principal_id=?
      JOIN campaigns campaign ON campaign.id=turn.campaign_id AND campaign.active_timeline_id=turn.timeline_id
        AND campaign.administration_revision=turn.campaign_revision AND campaign.lifecycle_status IN ('draft','published')
      WHERE turn.id=? AND turn.principal_id=? AND turn.mode='original' AND turn.state='declared'
        AND session.state='active' AND session.stopped_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM encounter WHERE encounter.campaign_id=turn.campaign_id
          AND encounter.session_id=turn.session_id AND encounter.status='active')
        AND member.role<>'observer' AND (member.role IN ('owner','gm') OR control.actor_id IS NOT NULL)`)
      .get(principalId, principalId, turnId, principalId) as { campaign_id: string; actor_id: string; session_id: string } | undefined;
    if (!turn) throw new QuestAuthorizationError("adventure quest authority is unavailable");
    const questRevision = revision(turn.campaign_id);
    const rows = db.prepare(`SELECT quest.id quest_id,quest.title,objective.objective_id,objective.description,
        objective.target_progress,progress.progress
      FROM quests quest JOIN quest_definitions_v33 quest_definition
        ON quest_definition.campaign_id=quest.campaign_id AND quest_definition.quest_id=quest.id
      JOIN quest_objectives_v33 objective ON objective.campaign_id=quest.campaign_id AND objective.quest_id=quest.id
      JOIN quest_objective_progress_v33 progress USING(campaign_id,quest_id,objective_id)
      WHERE quest.campaign_id=? AND quest.status='active' AND quest_definition.visibility='public'
        AND objective.visibility='public' AND progress.progress<objective.target_progress
        AND NOT EXISTS(SELECT 1 FROM quest_objective_dependencies_v33 dependency
          JOIN quest_objective_progress_v33 dependency_progress ON dependency_progress.campaign_id=dependency.campaign_id
            AND dependency_progress.quest_id=dependency.quest_id AND dependency_progress.objective_id=dependency.dependency_objective_id
          JOIN quest_objectives_v33 dependency_definition ON dependency_definition.campaign_id=dependency_progress.campaign_id
            AND dependency_definition.quest_id=dependency_progress.quest_id AND dependency_definition.objective_id=dependency_progress.objective_id
          WHERE dependency.campaign_id=objective.campaign_id AND dependency.quest_id=objective.quest_id
            AND dependency.objective_id=objective.objective_id AND dependency_progress.progress<dependency_definition.target_progress)
      ORDER BY quest.sort_order,quest.id COLLATE BINARY,objective.sort_order,objective.objective_id COLLATE BINARY LIMIT 33`)
      .all(turn.campaign_id) as Array<{ quest_id: string; title: string; objective_id: string; description: string;
        target_progress: number; progress: number }>;
    if (rows.length > 32) throw new QuestConflictError("adventure quest candidate limit exceeded");
    return rows.map((row) => {
      const evidence = { version: "v1" as const, turnId, campaignId: turn.campaign_id, questRevision, questId: row.quest_id,
        objectiveId: row.objective_id, progress: row.progress, targetProgress: row.target_progress,
        questTitle: row.title, objectiveDescription: row.description };
      const candidate=makeAdventureQuestCandidate(evidence);
      return { ...candidate, questTitle: row.title, objectiveDescription: row.description, progress: row.progress,
        targetProgress: row.target_progress, questId: row.quest_id, objectiveId: row.objective_id, questRevision };
    });
  }

  function historicalCandidate(turnId:string,command:{campaign_id:string;quest_id:string;expected_revision:number;resulting_revision:number;
    canonical_request_json:string}):AdventureQuestObjectiveCandidate|null {
    const request=JSON.parse(command.canonical_request_json) as {objectiveId?:string};if(!request.objectiveId)return null;
    const row=db.prepare(`SELECT quest.title,objective.description,objective.target_progress FROM quests quest
      JOIN quest_objectives_v33 objective ON objective.campaign_id=quest.campaign_id AND objective.quest_id=quest.id
      WHERE quest.campaign_id=? AND quest.id=? AND objective.objective_id=?`).get(command.campaign_id,command.quest_id,request.objectiveId) as
      {title:string;description:string;target_progress:number}|undefined;if(!row)return null;
    const progress=(db.prepare(`SELECT count(*) count FROM quest_domain_commands_v33 prior
      WHERE prior.campaign_id=? AND prior.quest_id=? AND prior.command_type='advance-objective' AND prior.resulting_revision<?
        AND json_extract(prior.canonical_request_json,'$.objectiveId')=?`).get(command.campaign_id,command.quest_id,command.resulting_revision,request.objectiveId) as {count:number}).count;
    const evidence={version:"v1" as const,turnId,campaignId:command.campaign_id,questRevision:command.expected_revision,questId:command.quest_id,
      objectiveId:request.objectiveId,progress,targetProgress:row.target_progress,questTitle:row.title,objectiveDescription:row.description};
    return{...makeAdventureQuestCandidate(evidence),questTitle:row.title,objectiveDescription:row.description,progress,targetProgress:row.target_progress,
      questId:command.quest_id,objectiveId:request.objectiveId,questRevision:command.expected_revision};
  }

  const createQuest = (principalId: string, campaignIdInput: string, raw: CreateCampaignQuestHttpRequest,
    knowledgeSource?: QuestOfferKnowledgeSource): QuestCreateMutationResult => {
      context.guard();
      const campaignId = resourceIdSchema.parse(campaignIdInput), input = createCampaignQuestHttpRequestSchema.parse(raw);
      const member = membership(principalId, campaignId); if (!member || !isGm(member.role)) throw new QuestAuthorizationError("GM authority is required");
      return db.transaction(() => {
        const requestValue = knowledgeSource ? { type: "create", campaignId, ...input, knowledgeSource } : { type: "create", campaignId, ...input };
        if (knowledgeSource) {
          const known = db.prepare(`SELECT 1 FROM agent_observations
            WHERE campaign_id=? AND timeline_id=(SELECT active_timeline_id FROM campaigns WHERE id=?)
              AND agent_kind=? AND agent_id=? AND source_command_id=? LIMIT 1`)
            .get(campaignId, campaignId, knowledgeSource.agentKind, knowledgeSource.agentId, knowledgeSource.sourceCommandId);
          if (!known) throw new QuestDomainUnavailableError("quest offer knowledge source is unavailable");
        }
        assertAcyclic(input.quest.objectives); assertVisibilityDependencies(input.quest.objectives);
        if (!db.prepare("SELECT 1 FROM quest_storylines WHERE campaign_id=? AND id=?").get(campaignId, input.quest.storylineId))
          throw new QuestDomainUnavailableError("storyline is unavailable");
        const mutation = begin(principalId, campaignId, input.quest.questId, "create", requestValue, input.expectedRevision, input.idempotencyKey, true);
        if (mutation.replay) return mutation.replay as QuestCreateMutationResult;
        if (db.prepare("SELECT 1 FROM quests WHERE id=?").get(input.quest.questId)) throw new QuestConflictError("quest ID already exists");
        db.prepare("INSERT INTO quest_domain_revisions_v33 VALUES(?,0,?) ON CONFLICT DO NOTHING").run(campaignId, mutation.at);
        db.prepare("INSERT INTO quest_domain_commands_v33 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(campaignId, mutation.commandId,
          input.quest.questId, principalId, "create", input.idempotencyKey, mutation.request, digest(JSON.parse(mutation.request)), mutation.before, mutation.after, mutation.at);
        db.prepare("INSERT INTO quests VALUES(?,?,?,?,?,?,?,?,?)").run(input.quest.questId, input.quest.storylineId, campaignId,
          input.quest.title, input.quest.description, "open", 0, mutation.at, mutation.at);
        db.prepare("INSERT INTO quest_definitions_v33 VALUES(?,?,?,?)").run(campaignId, input.quest.questId, input.quest.visibility, mutation.commandId);
        const objectiveInsert = db.prepare("INSERT INTO quest_objectives_v33 VALUES(?,?,?,?,?,?,?,?)");
        input.quest.objectives.forEach((objective, order) => {
          objectiveInsert.run(campaignId, input.quest.questId, objective.objectiveId, objective.description,
            objective.targetProgress, order, objective.visibility, mutation.commandId);
          db.prepare("INSERT INTO quest_objective_progress_v33 VALUES(?,?,?,?,?,?,?)").run(campaignId, input.quest.questId,
            objective.objectiveId, 0, null, mutation.commandId, mutation.at);
        });
        const dependencyInsert = db.prepare("INSERT INTO quest_objective_dependencies_v33 VALUES(?,?,?,?)");
        input.quest.objectives.forEach((objective) => objective.dependencyObjectiveIds.forEach((dependencyId) =>
          dependencyInsert.run(campaignId, input.quest.questId, objective.objectiveId, dependencyId)));
        input.quest.rewards.forEach((reward) => {
          db.prepare("INSERT INTO quest_rewards(id,quest_id,campaign_id,kind,amount,label,created_at) VALUES(?,?,?,?,?,?,?)")
            .run(reward.rewardId, input.quest.questId, campaignId, reward.kind, reward.amount, reward.label, mutation.at);
          db.prepare("INSERT INTO quest_reward_definitions_v33 VALUES(?,?,?,?,?)")
            .run(campaignId, input.quest.questId, reward.rewardId, reward.visibility, mutation.commandId);
        });
        addJournal(mutation, input.quest.journalText, input.quest.visibility);
        db.prepare("INSERT INTO quest_domain_events_v33 VALUES(?,?,?,?,?,?,?)").run(id(), campaignId, mutation.commandId,
          mutation.after, "quest-created", canonical({ questId: input.quest.questId, kind: "create" }), mutation.at);
        db.prepare("UPDATE quest_domain_revisions_v33 SET revision=?,updated_at=? WHERE campaign_id=?").run(mutation.after, mutation.at, campaignId);
        const durableSnapshot=snapshot(principalId,campaignId);if(!durableSnapshot)throw new QuestAuthorizationError("campaign membership is required");
        const {campaignId:_campaignId,revision:durableRevision,...projection}=durableSnapshot;
        const result: QuestCreateMutationResult = { campaignId, quest: projectQuest(db.prepare("SELECT * FROM quests WHERE id=?").get(input.quest.questId), true),
          definition:durableDefinition(campaignId,input.quest.questId),projection,revision:durableRevision,receipt:receipt(mutation) };
        if(result.revision!==result.receipt.revisionAfter)throw new QuestConflictError("persisted quest projection revision is inconsistent");
        db.prepare("INSERT INTO quest_domain_receipts_v33 VALUES(?,?,?,?,?,?)").run(campaignId, mutation.commandId, mutation.after, canonical(result), digest(result), mutation.at);
        return result;
      }).immediate();
  };
  const createKnowledgeGatedQuestOffer = (principalId: string, campaignId: string,
    input: KnowledgeGatedQuestOfferInput): KnowledgeGatedQuestOfferResult => ({
    ...createQuest(principalId, campaignId, input.offer, input.knowledgeSource),
    knowledgeSource: input.knowledgeSource,
  });
  const repository: QuestDomainRepository = {
    listCampaignQuests(principalId, campaignId) { context.guard(); return snapshot(principalId, campaignId); },
    createCampaignQuest: createQuest,
    createKnowledgeGatedQuestOffer,
    executeQuestCommand(principalId, questIdInput, raw) {
      context.guard();
      const questId = resourceIdSchema.parse(questIdInput), input = questCommandHttpRequestSchema.parse(raw);
      return db.transaction(() => {
        const row = db.prepare("SELECT * FROM quests WHERE id=?").get(questId) as any;
        if (!row) throw new QuestDomainUnavailableError("quest is unavailable");
        const member = membership(principalId, row.campaign_id); if (!member) throw new QuestAuthorizationError("campaign membership is required");
        const privileged = isGm(member.role);
        const questDefinition = db.prepare("SELECT visibility FROM quest_definitions_v33 WHERE campaign_id=? AND quest_id=?")
          .get(row.campaign_id, questId) as { visibility: "public" | "gm" } | undefined;
        if (!questDefinition) throw new QuestDomainUnavailableError("quest is unavailable");
        const questVisibility = questDefinition.visibility;
        if (!privileged && questVisibility !== "public") throw new QuestDomainUnavailableError("quest is unavailable");
        let objective: { target_progress: number; visibility: "public" | "gm"; progress: number } | undefined;
        let rewardDefinition: { visibility: "public" | "gm" } | undefined;
        if (input.kind === "advance-objective") {
          objective = db.prepare(`SELECT objective.target_progress,objective.visibility,progress.progress FROM quest_objectives_v33 objective
            JOIN quest_objective_progress_v33 progress USING(campaign_id,quest_id,objective_id)
            WHERE objective.campaign_id=? AND objective.quest_id=? AND objective.objective_id=?`)
            .get(row.campaign_id, questId, input.objectiveId) as typeof objective;
          if (!objective || (!privileged && objective.visibility !== "public")) throw new QuestDomainUnavailableError("objective is unavailable");
        } else if (input.kind === "claim-reward") {
          if (!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(row.campaign_id, input.actorId))
            throw new QuestDomainUnavailableError("reward actor is unavailable");
          if (!privileged && !db.prepare(`SELECT 1 FROM campaign_actor_private_state
            WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`).get(row.campaign_id, input.actorId, principalId))
            throw new QuestDomainUnavailableError("reward actor is unavailable");
          rewardDefinition = db.prepare("SELECT visibility FROM quest_reward_definitions_v33 WHERE campaign_id=? AND quest_id=? AND reward_id=?")
            .get(row.campaign_id, questId, input.rewardId) as typeof rewardDefinition;
          if (!rewardDefinition || (!privileged && rewardDefinition.visibility !== "public")) throw new QuestDomainUnavailableError("reward is unavailable");
        }
        const requestValue = { type: input.kind, questId, ...input };
        const mutation = begin(principalId, row.campaign_id, questId, input.kind, requestValue,
          input.expectedRevision, input.idempotencyKey, privileged);
        if (mutation.replay) return mutation.replay;
        let eventType = "quest-accepted", journalText = "Quest accepted.", journalVisibility = questVisibility;
        if (input.kind === "accept") {
          if (row.status !== "open") throw new QuestConflictError("only offered quests can be accepted");
          db.prepare("UPDATE quests SET status='active',updated_at=? WHERE id=? AND campaign_id=?").run(mutation.at, questId, row.campaign_id);
        } else if (input.kind === "abandon") {
          if (row.status !== "open" && row.status !== "active") throw new QuestConflictError("quest cannot be abandoned");
          db.prepare("UPDATE quests SET status='failed',updated_at=? WHERE id=? AND campaign_id=?").run(mutation.at, questId, row.campaign_id);
          eventType = "quest-abandoned"; journalText = "Quest abandoned.";
        } else if (input.kind === "advance-objective") {
          if (row.status !== "active") throw new QuestConflictError("only active quests can advance");
          const targetObjective = objective!;
          if (targetObjective.progress >= targetObjective.target_progress) throw new QuestConflictError("objective is already complete");
          const blocked = db.prepare(`SELECT 1 FROM quest_objective_dependencies_v33 dependency
            JOIN quest_objective_progress_v33 progress ON progress.campaign_id=dependency.campaign_id
              AND progress.quest_id=dependency.quest_id AND progress.objective_id=dependency.dependency_objective_id
            JOIN quest_objectives_v33 definition ON definition.campaign_id=progress.campaign_id
              AND definition.quest_id=progress.quest_id AND definition.objective_id=progress.objective_id
            WHERE dependency.campaign_id=? AND dependency.quest_id=? AND dependency.objective_id=? AND progress.progress<definition.target_progress LIMIT 1`)
            .get(row.campaign_id, questId, input.objectiveId);
          if (blocked) throw new QuestConflictError("objective dependencies are incomplete");
          const next = targetObjective.progress + 1, completedAt = next === targetObjective.target_progress ? mutation.at : null;
          db.prepare(`UPDATE quest_objective_progress_v33 SET progress=?,completed_at=?,last_command_id=?,updated_at=?
            WHERE campaign_id=? AND quest_id=? AND objective_id=?`).run(next, completedAt, mutation.commandId, mutation.at,
              row.campaign_id, questId, input.objectiveId);
          const incomplete = db.prepare(`SELECT 1 FROM quest_objectives_v33 objective JOIN quest_objective_progress_v33 progress
            USING(campaign_id,quest_id,objective_id) WHERE objective.campaign_id=? AND objective.quest_id=?
            AND progress.progress<objective.target_progress LIMIT 1`).get(row.campaign_id, questId);
          if (!incomplete) { db.prepare("UPDATE quests SET status='completed',updated_at=? WHERE id=? AND campaign_id=?")
            .run(mutation.at, questId, row.campaign_id); eventType = "quest-completed"; journalText = "Quest completed."; }
          else { eventType = "objective-advanced"; journalText = `Objective advanced: ${input.objectiveId}.`; journalVisibility = targetObjective.visibility; }
        } else {
          const targetReward = rewardDefinition!;
          if (row.status !== "completed") throw new QuestConflictError("rewards require a completed quest");
          if (db.prepare("SELECT 1 FROM quest_reward_claims_v33 WHERE campaign_id=? AND quest_id=? AND reward_id=?")
            .get(row.campaign_id, questId, input.rewardId)) throw new QuestConflictError("reward is already claimed");
          db.prepare("INSERT INTO quest_reward_claims_v33 VALUES(?,?,?,?,?,?)").run(row.campaign_id, questId,
            input.rewardId, input.actorId, mutation.commandId, mutation.at);
          eventType = "reward-claimed"; journalText = `Reward claimed: ${input.rewardId}.`; journalVisibility = targetReward.visibility;
        }
        addJournal(mutation, journalText, journalVisibility);
        const current = db.prepare("SELECT * FROM quests WHERE id=? AND campaign_id=?").get(questId, row.campaign_id);
        const result: QuestMutationResult = { campaignId: row.campaign_id, quest: projectQuest(current, privileged), receipt: receipt(mutation) };
        const event = input.kind === "advance-objective" ? { questId, kind: input.kind, objectiveId: input.objectiveId }
          : input.kind === "claim-reward" ? { questId, kind: input.kind, rewardId: input.rewardId, actorId: input.actorId }
            : { questId, kind: input.kind };
        record(mutation, result, eventType, event); return result;
      }).immediate();
    },
    listAdventureQuestObjectiveCandidates(principalId, turnIdInput) {
      context.guard(); return adventureCandidates(resourceIdSchema.parse(principalId), resourceIdSchema.parse(turnIdInput));
    },
    executeAdventureQuestObjectiveCandidate(principalId, input) {
      context.guard(); const turnId = resourceIdSchema.parse(input.turnId), providerCallId=resourceIdSchema.parse(input.providerCallId),
        candidateId = resourceIdSchema.parse(input.candidateId),key=adventureQuestKey(providerCallId,candidateId);
      return db.transaction(()=>{
        const provider=db.prepare(`SELECT response.response_json,provider_request.request_json,provider_request.timeline_id,
            provider_request.timeline_revision,provider_request.campaign_revision,provider_request.turn_revision
          FROM agent_provider_responses_v39 response
          JOIN agent_provider_contexts_v39 provider_request ON provider_request.context_id=response.context_id
          WHERE response.turn_id=? AND response.provider_call_id=? AND response.status='succeeded'`).get(turnId,providerCallId) as
          {response_json:string;request_json:string;timeline_id:string;timeline_revision:number;campaign_revision:number;turn_revision:number}|undefined;
        if(!provider)throw new QuestConflictError("settled adventure quest selection is unavailable");
        const response=JSON.parse(provider.response_json) as any,request=JSON.parse(provider.request_json) as any;
        const call=Array.isArray(response?.calls)&&response.calls.length===1?response.calls[0]:null;
        const advertised=Array.isArray(request?.questCandidateProjection?.candidates)?request.questCandidateProjection.candidates:[];
        if(call?.toolName!=="exact_quest_objective.select"||call?.arguments?.candidateId!==candidateId||call?.arguments?.digest!==input.digest
          ||!advertised.some((candidate:any)=>candidate?.candidateId===candidateId&&candidate?.digest===input.digest))
          throw new QuestConflictError("adventure quest selection is not bound to its provider decision");
        const existing=db.prepare(`SELECT campaign_id,quest_id,expected_revision,resulting_revision,canonical_request_json FROM quest_domain_commands_v33
          WHERE idempotency_key=?`).get(key) as {campaign_id:string;quest_id:string;expected_revision:number;resulting_revision:number;canonical_request_json:string}|undefined;
        if(existing){const bound=historicalCandidate(turnId,existing);if(bound?.candidateId!==candidateId||bound.digest!==input.digest)
            throw new QuestConflictError("committed quest command does not match the selected candidate");
          const requestValue=JSON.parse(existing.canonical_request_json) as {objectiveId:string;expectedRevision:number};
          return repository.executeQuestCommand(principalId,existing.quest_id,{kind:"advance-objective",objectiveId:requestValue.objectiveId,
            expectedRevision:requestValue.expectedRevision,idempotencyKey:key});}
        const fresh=db.prepare(`SELECT 1 FROM adventure_turns turn JOIN campaigns campaign ON campaign.id=turn.campaign_id
          JOIN campaign_timelines timeline ON timeline.campaign_id=turn.campaign_id AND timeline.id=turn.timeline_id
          WHERE turn.id=? AND turn.mode='original' AND turn.state='declared' AND turn.timeline_id=?
            AND turn.revision=? AND turn.campaign_revision=? AND campaign.administration_revision=?
            AND campaign.active_timeline_id=turn.timeline_id AND timeline.revision=?`).get(turnId,provider.timeline_id,
              provider.turn_revision,provider.campaign_revision,provider.campaign_revision,provider.timeline_revision);
        if(!fresh)throw new QuestConflictError("adventure quest decision context is stale");
        const selected = adventureCandidates(resourceIdSchema.parse(principalId), turnId)
          .find((candidate) => candidate.candidateId === candidateId && candidate.digest === input.digest);
        if (!selected) throw new QuestConflictError("adventure quest candidate is stale or unavailable");
        return repository.executeQuestCommand(principalId, selected.questId, { kind: "advance-objective", objectiveId: selected.objectiveId,
          expectedRevision: selected.questRevision, idempotencyKey:key });
      }).immediate();
    },
    getAdventureQuestNarrationReceipt(principalId, turnIdInput, commandIdInput) {
      context.guard(); const turnId = resourceIdSchema.parse(turnIdInput), commandId = resourceIdSchema.parse(commandIdInput);
      let rootTurnId=turnId;const visited=new Set<string>();
      while(true){if(visited.has(rootTurnId))throw new QuestConflictError("adventure turn ancestry contains a cycle");visited.add(rootTurnId);
        const ancestor=db.prepare("SELECT mode,prior_turn_id FROM adventure_turns WHERE id=?").get(rootTurnId) as {mode:string;prior_turn_id:string|null}|undefined;
        if(!ancestor)return null;if(ancestor.mode==="original")break;if(!ancestor.prior_turn_id)return null;rootTurnId=ancestor.prior_turn_id;}
      const campaign=db.prepare("SELECT campaign_id FROM adventure_turns WHERE id=?").get(rootTurnId) as {campaign_id:string}|undefined;
      if(!campaign||!membership(principalId,campaign.campaign_id))return null;
      const bound=boundAdventureQuestReceipts(db,campaign.campaign_id,rootTurnId).find((item)=>item.commandId===commandId);if(!bound)return null;
      const result=JSON.parse(bound.resultJson) as QuestMutationResult;
      return { questTitle:bound.questTitle,objectiveDescription:bound.objectiveDescription,progressBefore:bound.progressBefore,
        progressAfter:bound.progressAfter,targetProgress:bound.targetProgress,objectiveCompleted:bound.progressAfter>=bound.targetProgress,
        questCompleted:result.quest.status==="completed" };
    },
    getAdventureQuestPublicReceipt(principalIdInput, campaignIdInput, commandIdInput) {
      context.guard();const principalId=resourceIdSchema.parse(principalIdInput),campaignId=resourceIdSchema.parse(campaignIdInput),
        commandId=resourceIdSchema.parse(commandIdInput);
      if(!membership(principalId,campaignId))return null;
      const turns=db.prepare(`SELECT response.turn_id FROM quest_domain_commands_v33 command
        JOIN agent_provider_responses_v39 response ON response.campaign_id=command.campaign_id AND response.status='succeeded'
          AND command.idempotency_key='adventure-quest:'||substr(response.provider_call_id,-32)||':'
            ||substr(json_extract(response.response_json,'$.calls[0].arguments.candidateId'),-32)
        WHERE command.campaign_id=? AND command.command_id=? ORDER BY response.turn_id`).all(campaignId,commandId) as Array<{turn_id:string}>;
      for(const turn of turns){const bound=boundAdventureQuestReceipts(db,campaignId,turn.turn_id).find((item)=>item.commandId===commandId);
        if(!bound)continue;
        const result=JSON.parse(bound.resultJson) as QuestMutationResult;
        if(result.campaignId!==campaignId||result.receipt.commandId!==commandId
          ||result.receipt.revisionBefore!==bound.revisionBefore||result.receipt.revisionAfter!==bound.revisionAfter
          ||result.receipt.occurredAt!==bound.linkedAt)throw new QuestConflictError("adventure quest receipt ancestry is invalid");
        return{questTitle:bound.questTitle,objectiveDescription:bound.objectiveDescription,progressBefore:bound.progressBefore,
          progressAfter:bound.progressAfter,targetProgress:bound.targetProgress,objectiveCompleted:bound.progressAfter>=bound.targetProgress,
          questCompleted:result.quest.status==="completed",revisionBefore:bound.revisionBefore,revisionAfter:bound.revisionAfter,
          occurredAt:bound.linkedAt};
      }
      return null;
    },
  };
  return repository;
}
