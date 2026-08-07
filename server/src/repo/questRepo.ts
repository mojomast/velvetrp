import { randomUUID } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { LOCAL_OWNER_PRINCIPAL_ID } from "./shared.js";
import {
  createQuestReadRepository,
  QuestUnavailableError,
  type CreateQuestInput,
  type CreateRewardInput,
  type CreateStorylineInput,
  type QuestReadRepository,
  type Storyline,
  type Quest,
  type QuestClue,
  type QuestReward,
  type QuestObjectiveCompletion,
  type UpdateQuestInput,
  type UpdateStorylineInput,
} from "./quest/questReadRepo.js";

export {
  QuestUnavailableError,
  type CreateQuestInput,
  type CreateRewardInput,
  type CreateStorylineInput,
  type Quest,
  type QuestClue,
  type QuestDetail,
  type QuestObjectiveCompletion,
  type QuestReward,
  type Storyline,
  type UpdateQuestInput,
  type UpdateStorylineInput,
} from "./quest/questReadRepo.js";

type Database = DatabaseDriver.Database;

/** Trusted-local quest persistence used by the M2.1 route adapters. */
export interface QuestRepository extends QuestReadRepository {
  createStoryline(campaignId: string, input: CreateStorylineInput): Promise<Storyline>;
  updateStoryline(campaignId: string, storylineId: string, input: UpdateStorylineInput): Promise<Storyline>;
  createQuest(campaignId: string, storylineId: string, input: CreateQuestInput): Promise<Quest>;
  updateQuest(campaignId: string, questId: string, input: UpdateQuestInput): Promise<Quest>;
  reorderQuests(campaignId: string, questIds: string[]): Promise<void>;
  createClue(campaignId: string, questId: string, content: string, discoveredByCharacterId?: string): Promise<QuestClue>;
  markClueDiscovered(campaignId: string, questId: string, clueId: string, characterId: string): Promise<QuestClue>;
  createReward(campaignId: string, questId: string, input: CreateRewardInput): Promise<QuestReward>;
  grantReward(campaignId: string, questId: string, rewardId: string, characterId: string): Promise<QuestReward>;
  completeObjective(campaignId: string, questId: string, description: string, characterId?: string): Promise<QuestObjectiveCompletion>;
}

const now = () => new Date().toISOString();
const id = () => randomUUID();

function storyline(row: any): Storyline {
  return { id: row.id, campaignId: row.campaign_id, title: row.title, description: row.description, status: row.status, createdAt: row.created_at };
}

function quest(row: any): Quest {
  return { id: row.id, storylineId: row.storyline_id, campaignId: row.campaign_id, title: row.title, description: row.description, status: row.status, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at };
}

function clue(row: any): QuestClue {
  return { id: row.id, questId: row.quest_id, campaignId: row.campaign_id, content: row.content, discoveredByCharacterId: row.discovered_by_character_id, discoveredAt: row.discovered_at, createdAt: row.created_at };
}

function reward(row: any): QuestReward {
  return { id: row.id, questId: row.quest_id, campaignId: row.campaign_id, kind: row.kind, amount: row.amount, label: row.label, grantedToCharacterId: row.granted_to_character_id, grantedAt: row.granted_at, createdAt: row.created_at };
}

function completion(row: any): QuestObjectiveCompletion {
  return { id: row.id, questId: row.quest_id, description: row.description, completedByCharacterId: row.completed_by_character_id, completedAt: row.completed_at };
}

export async function createStoryline(db: Database, campaignId: string, input: CreateStorylineInput): Promise<Storyline> {
  const createdAt = now();
  const storylineId = input.id ?? id();
  db.prepare("INSERT INTO quest_storylines(id,campaign_id,title,description,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(storylineId, campaignId, input.title, input.description ?? null, input.status ?? "active", createdAt);
  return storyline(db.prepare("SELECT * FROM quest_storylines WHERE id=?").get(storylineId));
}

export async function listStorylines(db: Database, campaignId: string): Promise<Storyline[]> {
  return (db.prepare("SELECT * FROM quest_storylines WHERE campaign_id=? ORDER BY created_at,id").all(campaignId) as any[]).map(storyline);
}

export async function getStoryline(db: Database, storylineId: string): Promise<Storyline | null> {
  const row = db.prepare("SELECT * FROM quest_storylines WHERE id=?").get(storylineId);
  return row ? storyline(row) : null;
}

export async function updateStorylineStatus(db: Database, storylineId: string, status: Storyline["status"]): Promise<void> {
  db.prepare("UPDATE quest_storylines SET status=? WHERE id=?").run(status, storylineId);
}

export async function createQuest(db: Database, storylineId: string, campaignId: string, input: CreateQuestInput): Promise<Quest> {
  const createdAt = now();
  const questId = input.id ?? id();
  db.prepare("INSERT INTO quests(id,storyline_id,campaign_id,title,description,status,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(questId, storylineId, campaignId, input.title, input.description ?? null, input.status ?? "open", input.sortOrder ?? 0, createdAt, createdAt);
  return quest(db.prepare("SELECT * FROM quests WHERE id=?").get(questId));
}

export async function listQuests(db: Database, campaignId: string, storylineId?: string): Promise<Quest[]> {
  const rows = storylineId === undefined
    ? db.prepare("SELECT * FROM quests WHERE campaign_id=? ORDER BY sort_order,id").all(campaignId)
    : db.prepare("SELECT * FROM quests WHERE campaign_id=? AND storyline_id=? ORDER BY sort_order,id").all(campaignId, storylineId);
  return (rows as any[]).map(quest);
}

export async function getQuest(db: Database, questId: string): Promise<Quest | null> {
  const row = db.prepare("SELECT * FROM quests WHERE id=?").get(questId);
  return row ? quest(row) : null;
}

export async function updateQuestStatus(db: Database, questId: string, status: Quest["status"]): Promise<void> {
  db.prepare("UPDATE quests SET status=?,updated_at=? WHERE id=?").run(status, now(), questId);
}

export async function reorderQuests(db: Database, questIds: string[]): Promise<void> {
  db.transaction(() => {
    const update = db.prepare("UPDATE quests SET sort_order=?,updated_at=? WHERE id=?");
    const updatedAt = now();
    questIds.forEach((questId, sortOrder) => update.run(sortOrder, updatedAt, questId));
  })();
}

export async function addClue(db: Database, questId: string, campaignId: string, content: string, discoveredByCharacterId?: string): Promise<QuestClue> {
  const clueId = id();
  const discoveredAt = discoveredByCharacterId ? now() : null;
  const createdAt = now();
  db.prepare("INSERT INTO quest_clues(id,quest_id,campaign_id,content,discovered_by_character_id,discovered_at,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(clueId, questId, campaignId, content, discoveredByCharacterId ?? null, discoveredAt, createdAt);
  return clue(db.prepare("SELECT * FROM quest_clues WHERE id=?").get(clueId));
}

export async function listClues(db: Database, questId: string): Promise<QuestClue[]> {
  return (db.prepare("SELECT * FROM quest_clues WHERE quest_id=? ORDER BY created_at,id").all(questId) as any[]).map(clue);
}

export async function markClueDiscovered(db: Database, clueId: string, characterId: string): Promise<void> {
  db.prepare("UPDATE quest_clues SET discovered_by_character_id=?,discovered_at=? WHERE id=?").run(characterId, now(), clueId);
}

export async function addReward(db: Database, questId: string, campaignId: string, input: CreateRewardInput): Promise<QuestReward> {
  const rewardId = input.id ?? id();
  const createdAt = now();
  db.prepare("INSERT INTO quest_rewards(id,quest_id,campaign_id,kind,amount,label,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(rewardId, questId, campaignId, input.kind, input.amount ?? null, input.label, createdAt);
  return reward(db.prepare("SELECT * FROM quest_rewards WHERE id=?").get(rewardId));
}

export async function listRewards(db: Database, questId: string): Promise<QuestReward[]> {
  return (db.prepare("SELECT * FROM quest_rewards WHERE quest_id=? ORDER BY created_at,id").all(questId) as any[]).map(reward);
}

export async function grantReward(db: Database, rewardId: string, characterId: string): Promise<void> {
  db.prepare("UPDATE quest_rewards SET granted_to_character_id=?,granted_at=? WHERE id=?").run(characterId, now(), rewardId);
}

export async function completeObjective(db: Database, questId: string, description: string, characterId?: string): Promise<void> {
  db.prepare("INSERT INTO quest_objective_completions(id,quest_id,description,completed_by_character_id,completed_at) VALUES(?,?,?,?,?)")
    .run(id(), questId, description, characterId ?? null, now());
}

export async function listObjectiveCompletions(db: Database, questId: string): Promise<QuestObjectiveCompletion[]> {
  return (db.prepare("SELECT * FROM quest_objective_completions WHERE quest_id=? ORDER BY completed_at,id").all(questId) as any[]).map(completion);
}

export function createQuestRepository(
  db: Database,
  principalId = LOCAL_OWNER_PRINCIPAL_ID,
  assertCanMutate: () => void = () => undefined,
): QuestRepository {
  const reads = createQuestReadRepository(db, principalId);
  const {
    hasCampaignAccess: _hasCampaignAccess,
    requireCampaign,
    scopedStoryline: _scopedStoryline,
    scopedQuest,
    requireStoryline,
    requireQuest,
    scopedClue,
    scopedReward,
    ...readRepository
  } = reads;

  return {
    ...readRepository,
    async createStoryline(campaignId, input) {
      assertCanMutate(); requireCampaign(campaignId);
      return createStoryline(db, campaignId, input);
    },
    async updateStoryline(campaignId, storylineId, input) {
      assertCanMutate(); requireCampaign(campaignId); const current = requireStoryline(campaignId, storylineId);
      db.prepare("UPDATE quest_storylines SET title=?,description=?,status=? WHERE id=? AND campaign_id=?").run(
        input.title ?? current.title, input.description === undefined ? current.description : input.description,
        input.status ?? current.status, storylineId, campaignId,
      );
      return storyline(requireStoryline(campaignId, storylineId));
    },
    async listQuests(campaignId, storylineId) {
      requireCampaign(campaignId);
      if (storylineId !== undefined) requireStoryline(campaignId, storylineId);
      const rows = storylineId === undefined
        ? db.prepare("SELECT * FROM quests WHERE campaign_id=? ORDER BY sort_order,id").all(campaignId)
        : db.prepare("SELECT * FROM quests WHERE campaign_id=? AND storyline_id=? ORDER BY sort_order,id").all(campaignId, storylineId);
      return (rows as any[]).map(quest);
    },
    async createQuest(campaignId, storylineId, input) {
      assertCanMutate(); requireCampaign(campaignId); requireStoryline(campaignId, storylineId);
      return createQuest(db, storylineId, campaignId, input);
    },
    async updateQuest(campaignId, questId, input) {
      assertCanMutate(); requireCampaign(campaignId); const current = requireQuest(campaignId, questId);
      db.prepare("UPDATE quests SET title=?,description=?,status=?,sort_order=?,updated_at=? WHERE id=? AND campaign_id=?").run(
        input.title ?? current.title, input.description === undefined ? current.description : input.description,
        input.status ?? current.status, input.sortOrder ?? current.sort_order, now(), questId, campaignId,
      );
      return quest(requireQuest(campaignId, questId));
    },
    async reorderQuests(campaignId, questIds) {
      assertCanMutate(); requireCampaign(campaignId);
      if (new Set(questIds).size !== questIds.length || questIds.some((questId) => !scopedQuest(campaignId, questId))) throw new QuestUnavailableError();
      db.transaction(() => { const update = db.prepare("UPDATE quests SET sort_order=?,updated_at=? WHERE id=? AND campaign_id=?"); const updatedAt = now(); questIds.forEach((questId, sortOrder) => update.run(sortOrder, updatedAt, questId, campaignId)); })();
    },
    async createClue(campaignId, questId, content, discoveredByCharacterId) { assertCanMutate(); requireCampaign(campaignId); requireQuest(campaignId, questId); return addClue(db, questId, campaignId, content, discoveredByCharacterId); },
    async markClueDiscovered(campaignId, questId, clueId, characterId) { assertCanMutate(); requireCampaign(campaignId); requireQuest(campaignId, questId); if (!scopedClue(campaignId, questId, clueId)) throw new QuestUnavailableError(); await markClueDiscovered(db, clueId, characterId); return clue(scopedClue(campaignId, questId, clueId)!); },
    async createReward(campaignId, questId, input) { assertCanMutate(); requireCampaign(campaignId); requireQuest(campaignId, questId); return addReward(db, questId, campaignId, input); },
    async grantReward(campaignId, questId, rewardId, characterId) { assertCanMutate(); requireCampaign(campaignId); requireQuest(campaignId, questId); if (!scopedReward(campaignId, questId, rewardId)) throw new QuestUnavailableError(); await grantReward(db, rewardId, characterId); return reward(scopedReward(campaignId, questId, rewardId)!); },
    async completeObjective(campaignId, questId, description, characterId) { assertCanMutate(); requireCampaign(campaignId); requireQuest(campaignId, questId); const objectiveId = id(); const completedAt = now(); db.prepare("INSERT INTO quest_objective_completions(id,quest_id,description,completed_by_character_id,completed_at) VALUES(?,?,?,?,?)").run(objectiveId, questId, description, characterId ?? null, completedAt); return completion(db.prepare("SELECT * FROM quest_objective_completions WHERE id=? AND quest_id=?").get(objectiveId, questId)); },
  };
}
