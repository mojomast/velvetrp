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
  type CreateCampaignQuestHttpRequest,
  type QuestCommandHttpRequest,
  type QuestCommandReceiptHttp,
  type QuestJournalEntryHttp,
  type QuestObjectiveHttp,
} from "@velvet/contracts";

type Database = DatabaseDriver.Database;
type InternalReceipt = QuestCommandReceiptHttp & { commandId: string };

export class QuestAuthorizationError extends Error { readonly code = "QUEST_AUTHORIZATION"; }
export class QuestStaleError extends Error { readonly code = "QUEST_STALE"; }
export class QuestConflictError extends Error { readonly code = "QUEST_CONFLICT"; }
export class QuestDomainUnavailableError extends Error { readonly code = "QUEST_DOMAIN_UNAVAILABLE"; }

export interface CampaignQuestSnapshot {
  campaignId: string;
  revision: number;
  quests: CampaignQuestHttp[];
  objectives: QuestObjectiveHttp[];
  journal: QuestJournalEntryHttp[];
}
export interface QuestMutationResult { campaignId: string; quest: CampaignQuestHttp; receipt: InternalReceipt }

export interface QuestDomainRepository {
  listCampaignStorylines(principalId: string, campaignId: string): Array<{ id: string; campaignId: string; title: string; description: string | null; status: "active" | "completed" | "abandoned"; createdAt: string }> | null;
  createCampaignStoryline(principalId: string, campaignId: string, input: { title: string; description?: string | null; status?: "active" | "completed" | "abandoned" }): { id: string; campaignId: string; title: string; description: string | null; status: "active" | "completed" | "abandoned"; createdAt: string };
  getCampaignStoryline(principalId: string, campaignId: string, storylineId: string): { id: string; campaignId: string; title: string; description: string | null; status: "active" | "completed" | "abandoned"; createdAt: string } | null;
  updateCampaignStoryline(principalId: string, campaignId: string, storylineId: string, input: { status: "active" | "completed" | "abandoned" }): { id: string; campaignId: string; title: string; description: string | null; status: "active" | "completed" | "abandoned"; createdAt: string };
  listCampaignQuests(principalId: string, campaignId: string): CampaignQuestSnapshot | null;
  createCampaignQuest(principalId: string, campaignId: string, input: CreateCampaignQuestHttpRequest): QuestMutationResult;
  executeQuestCommand(principalId: string, questId: string, input: QuestCommandHttpRequest): QuestMutationResult;
}
export interface QuestDomainContext { clock: { now(): Date }; ids: { nextId(): string }; guard(): void }

const canonicalValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalValue)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalValue(item)]))
    : value;
const canonical = (value: unknown): string => JSON.stringify(canonicalValue(value));
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
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
  const storyline = (row: any) => ({ id: row.id, campaignId: row.campaign_id, title: row.title,
    description: row.description, status: row.status as "active" | "completed" | "abandoned", createdAt: timestamp(row.created_at) });
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

  function projectQuest(row: any, privileged: boolean): CampaignQuestHttp {
    return campaignQuestHttpSchema.parse({ questId: row.id, campaignId: row.campaign_id,
      storylineId: row.storyline_id, title: row.title, description: row.description, status: status(row.status),
      rewards: rewards(row.campaign_id, row.id, privileged), createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) });
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

  function roleSafeResult(result: QuestMutationResult, privileged: boolean): QuestMutationResult {
    if (privileged) return result;
    const visibleRewardIds = new Set((db.prepare(`SELECT reward_id FROM quest_reward_definitions_v33
      WHERE campaign_id=? AND quest_id=? AND visibility='public'`).all(result.campaignId, result.quest.questId) as Array<{ reward_id: string }>)
      .map((row) => row.reward_id));
    return { ...result, quest: { ...result.quest, rewards: result.quest.rewards.filter((reward) => visibleRewardIds.has(reward.rewardId)) } };
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

  return {
    listCampaignStorylines(principalId, campaignIdInput) { context.guard(); const campaignId = resourceIdSchema.parse(campaignIdInput);
      if (!membership(principalId, campaignId)) return null;
      return (db.prepare("SELECT * FROM quest_storylines WHERE campaign_id=? ORDER BY created_at,id").all(campaignId) as any[]).map(storyline); },
    createCampaignStoryline(principalId, campaignIdInput, input) { context.guard(); const campaignId = resourceIdSchema.parse(campaignIdInput);
      const member = membership(principalId, campaignId); if (!member || !isGm(member.role)) throw new QuestAuthorizationError("GM authority is required");
      const storylineId = id(), createdAt = now(); db.prepare("INSERT INTO quest_storylines(id,campaign_id,title,description,status,created_at) VALUES(?,?,?,?,?,?)")
        .run(storylineId, campaignId, input.title, input.description ?? null, input.status ?? "active", createdAt);
      return storyline(db.prepare("SELECT * FROM quest_storylines WHERE id=? AND campaign_id=?").get(storylineId, campaignId)); },
    getCampaignStoryline(principalId, campaignIdInput, storylineIdInput) { context.guard(); const campaignId = resourceIdSchema.parse(campaignIdInput), storylineId = resourceIdSchema.parse(storylineIdInput);
      if (!membership(principalId, campaignId)) return null; const row = db.prepare("SELECT * FROM quest_storylines WHERE id=? AND campaign_id=?").get(storylineId, campaignId);
      return row ? storyline(row) : null; },
    updateCampaignStoryline(principalId, campaignIdInput, storylineIdInput, input) { context.guard(); const campaignId = resourceIdSchema.parse(campaignIdInput), storylineId = resourceIdSchema.parse(storylineIdInput);
      const member = membership(principalId, campaignId); if (!member || !isGm(member.role)) throw new QuestAuthorizationError("GM authority is required");
      const result = db.prepare("UPDATE quest_storylines SET status=? WHERE id=? AND campaign_id=?").run(input.status, storylineId, campaignId);
      if (result.changes !== 1) throw new QuestDomainUnavailableError("storyline is unavailable");
      return storyline(db.prepare("SELECT * FROM quest_storylines WHERE id=? AND campaign_id=?").get(storylineId, campaignId)); },
    listCampaignQuests(principalId, campaignId) { context.guard(); return snapshot(principalId, campaignId); },
    createCampaignQuest(principalId, campaignIdInput, raw) {
      context.guard();
      const campaignId = resourceIdSchema.parse(campaignIdInput), input = createCampaignQuestHttpRequestSchema.parse(raw);
      const member = membership(principalId, campaignId); if (!member || !isGm(member.role)) throw new QuestAuthorizationError("GM authority is required");
      return db.transaction(() => {
        const requestValue = { type: "create", campaignId, ...input };
        assertAcyclic(input.quest.objectives); assertVisibilityDependencies(input.quest.objectives);
        if (!db.prepare("SELECT 1 FROM quest_storylines WHERE campaign_id=? AND id=?").get(campaignId, input.quest.storylineId))
          throw new QuestDomainUnavailableError("storyline is unavailable");
        const mutation = begin(principalId, campaignId, input.quest.questId, "create", requestValue, input.expectedRevision, input.idempotencyKey, true);
        if (mutation.replay) return mutation.replay;
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
        const result: QuestMutationResult = { campaignId, quest: projectQuest(db.prepare("SELECT * FROM quests WHERE id=?").get(input.quest.questId), true), receipt: receipt(mutation) };
        db.prepare("INSERT INTO quest_domain_receipts_v33 VALUES(?,?,?,?,?,?)").run(campaignId, mutation.commandId, mutation.after, canonical(result), digest(result), mutation.at);
        db.prepare("INSERT INTO quest_domain_events_v33 VALUES(?,?,?,?,?,?,?)").run(id(), campaignId, mutation.commandId,
          mutation.after, "quest-created", canonical({ questId: input.quest.questId, kind: "create" }), mutation.at);
        db.prepare("UPDATE quest_domain_revisions_v33 SET revision=?,updated_at=? WHERE campaign_id=?").run(mutation.after, mutation.at, campaignId);
        return result;
      }).immediate();
    },
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
  };
}
