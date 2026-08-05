import { randomUUID } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { LOCAL_OWNER_PRINCIPAL_ID } from "./shared.js";

type Database = DatabaseDriver.Database;

export interface Storyline {
  id: string;
  campaignId: string;
  title: string;
  description: string | null;
  status: "active" | "completed" | "abandoned";
  createdAt: string;
}

export interface Quest {
  id: string;
  storylineId: string;
  campaignId: string;
  title: string;
  description: string | null;
  status: "open" | "active" | "completed" | "failed";
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuestClue {
  id: string;
  questId: string;
  campaignId: string;
  content: string;
  discoveredByCharacterId: string | null;
  discoveredAt: string | null;
  createdAt: string;
}

export interface QuestReward {
  id: string;
  questId: string;
  campaignId: string;
  kind: "xp" | "currency" | "item" | "custom";
  amount: number | null;
  label: string;
  grantedToCharacterId: string | null;
  grantedAt: string | null;
  createdAt: string;
}

export interface QuestObjectiveCompletion {
  id: string;
  questId: string;
  description: string;
  completedByCharacterId: string | null;
  completedAt: string;
}

export interface CreateStorylineInput {
  id?: string;
  title: string;
  description?: string | null;
  status?: Storyline["status"];
}

export interface CreateQuestInput {
  id?: string;
  title: string;
  description?: string | null;
  status?: Quest["status"];
  sortOrder?: number;
}

export interface CreateRewardInput {
  id?: string;
  kind: QuestReward["kind"];
  amount?: number | null;
  label: string;
}

export interface UpdateStorylineInput {
  title?: string;
  description?: string | null;
  status?: Storyline["status"];
}

export interface UpdateQuestInput {
  title?: string;
  description?: string | null;
  status?: Quest["status"];
  sortOrder?: number;
}

export interface QuestDetail {
  quest: Quest;
  clues: QuestClue[];
  rewards: QuestReward[];
  objectiveCompletions: QuestObjectiveCompletion[];
}

/** A scoped ID was missing or belongs to another campaign. */
export class QuestUnavailableError extends Error {
  readonly code = "QUEST_UNAVAILABLE";

  constructor() {
    super("quest resource is unavailable");
    this.name = "QuestUnavailableError";
  }
}

/** Trusted-local quest persistence used by the M2.1 route adapters. */
export interface QuestRepository {
  listStorylines(campaignId: string): Promise<Storyline[]>;
  createStoryline(campaignId: string, input: CreateStorylineInput): Promise<Storyline>;
  getStoryline(campaignId: string, storylineId: string): Promise<Storyline | null>;
  updateStoryline(campaignId: string, storylineId: string, input: UpdateStorylineInput): Promise<Storyline>;
  listQuests(campaignId: string, storylineId?: string): Promise<Quest[]>;
  createQuest(campaignId: string, storylineId: string, input: CreateQuestInput): Promise<Quest>;
  getQuest(campaignId: string, questId: string): Promise<Quest | null>;
  getQuestDetail(campaignId: string, questId: string): Promise<QuestDetail | null>;
  updateQuest(campaignId: string, questId: string, input: UpdateQuestInput): Promise<Quest>;
  reorderQuests(campaignId: string, questIds: string[]): Promise<void>;
  listClues(campaignId: string, questId: string): Promise<QuestClue[]>;
  createClue(campaignId: string, questId: string, content: string, discoveredByCharacterId?: string): Promise<QuestClue>;
  getClue(campaignId: string, questId: string, clueId: string): Promise<QuestClue | null>;
  markClueDiscovered(campaignId: string, questId: string, clueId: string, characterId: string): Promise<QuestClue>;
  listRewards(campaignId: string, questId: string): Promise<QuestReward[]>;
  createReward(campaignId: string, questId: string, input: CreateRewardInput): Promise<QuestReward>;
  getReward(campaignId: string, questId: string, rewardId: string): Promise<QuestReward | null>;
  grantReward(campaignId: string, questId: string, rewardId: string, characterId: string): Promise<QuestReward>;
  completeObjective(campaignId: string, questId: string, description: string, characterId?: string): Promise<QuestObjectiveCompletion>;
  listObjectiveCompletions(campaignId: string, questId: string): Promise<QuestObjectiveCompletion[]>;
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
  const hasCampaignAccess = (campaignId: string) => Boolean(db.prepare(
    "SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?",
  ).get(campaignId, principalId));
  const requireCampaign = (campaignId: string) => {
    if (!hasCampaignAccess(campaignId)) throw new QuestUnavailableError();
  };
  const scopedStoryline = (campaignId: string, storylineId: string) => db.prepare(
    "SELECT * FROM quest_storylines WHERE id=? AND campaign_id=?",
  ).get(storylineId, campaignId) as any | undefined;
  const scopedQuest = (campaignId: string, questId: string) => db.prepare(
    "SELECT * FROM quests WHERE id=? AND campaign_id=?",
  ).get(questId, campaignId) as any | undefined;
  const requireStoryline = (campaignId: string, storylineId: string) => {
    const row = scopedStoryline(campaignId, storylineId);
    if (!row) throw new QuestUnavailableError();
    return row;
  };
  const requireQuest = (campaignId: string, questId: string) => {
    const row = scopedQuest(campaignId, questId);
    if (!row) throw new QuestUnavailableError();
    return row;
  };
  const scopedClue = (campaignId: string, questId: string, clueId: string) => db.prepare(
    "SELECT * FROM quest_clues WHERE id=? AND quest_id=? AND campaign_id=?",
  ).get(clueId, questId, campaignId) as any | undefined;
  const scopedReward = (campaignId: string, questId: string, rewardId: string) => db.prepare(
    "SELECT * FROM quest_rewards WHERE id=? AND quest_id=? AND campaign_id=?",
  ).get(rewardId, questId, campaignId) as any | undefined;

  return {
    async listStorylines(campaignId) {
      requireCampaign(campaignId);
      return (db.prepare("SELECT * FROM quest_storylines WHERE campaign_id=? ORDER BY created_at,id").all(campaignId) as any[]).map(storyline);
    },
    async createStoryline(campaignId, input) {
      assertCanMutate(); requireCampaign(campaignId);
      return createStoryline(db, campaignId, input);
    },
    async getStoryline(campaignId, storylineId) {
      requireCampaign(campaignId); const row = scopedStoryline(campaignId, storylineId);
      return row ? storyline(row) : null;
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
    async getQuest(campaignId, questId) {
      requireCampaign(campaignId); const row = scopedQuest(campaignId, questId);
      return row ? quest(row) : null;
    },
    async getQuestDetail(campaignId, questId) {
      requireCampaign(campaignId); const row = scopedQuest(campaignId, questId);
      if (!row) return null;
      return { quest: quest(row), clues: (db.prepare("SELECT * FROM quest_clues WHERE quest_id=? AND campaign_id=? ORDER BY created_at,id").all(questId, campaignId) as any[]).map(clue), rewards: (db.prepare("SELECT * FROM quest_rewards WHERE quest_id=? AND campaign_id=? ORDER BY created_at,id").all(questId, campaignId) as any[]).map(reward), objectiveCompletions: (db.prepare("SELECT * FROM quest_objective_completions WHERE quest_id=? ORDER BY completed_at,id").all(questId) as any[]).map(completion) };
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
    async listClues(campaignId, questId) { requireCampaign(campaignId); requireQuest(campaignId, questId); return (db.prepare("SELECT * FROM quest_clues WHERE quest_id=? AND campaign_id=? ORDER BY created_at,id").all(questId, campaignId) as any[]).map(clue); },
    async createClue(campaignId, questId, content, discoveredByCharacterId) { assertCanMutate(); requireCampaign(campaignId); requireQuest(campaignId, questId); return addClue(db, questId, campaignId, content, discoveredByCharacterId); },
    async getClue(campaignId, questId, clueId) { requireCampaign(campaignId); requireQuest(campaignId, questId); const row = scopedClue(campaignId, questId, clueId); return row ? clue(row) : null; },
    async markClueDiscovered(campaignId, questId, clueId, characterId) { assertCanMutate(); requireCampaign(campaignId); requireQuest(campaignId, questId); if (!scopedClue(campaignId, questId, clueId)) throw new QuestUnavailableError(); await markClueDiscovered(db, clueId, characterId); return clue(scopedClue(campaignId, questId, clueId)!); },
    async listRewards(campaignId, questId) { requireCampaign(campaignId); requireQuest(campaignId, questId); return (db.prepare("SELECT * FROM quest_rewards WHERE quest_id=? AND campaign_id=? ORDER BY created_at,id").all(questId, campaignId) as any[]).map(reward); },
    async createReward(campaignId, questId, input) { assertCanMutate(); requireCampaign(campaignId); requireQuest(campaignId, questId); return addReward(db, questId, campaignId, input); },
    async getReward(campaignId, questId, rewardId) { requireCampaign(campaignId); requireQuest(campaignId, questId); const row = scopedReward(campaignId, questId, rewardId); return row ? reward(row) : null; },
    async grantReward(campaignId, questId, rewardId, characterId) { assertCanMutate(); requireCampaign(campaignId); requireQuest(campaignId, questId); if (!scopedReward(campaignId, questId, rewardId)) throw new QuestUnavailableError(); await grantReward(db, rewardId, characterId); return reward(scopedReward(campaignId, questId, rewardId)!); },
    async completeObjective(campaignId, questId, description, characterId) { assertCanMutate(); requireCampaign(campaignId); requireQuest(campaignId, questId); const objectiveId = id(); const completedAt = now(); db.prepare("INSERT INTO quest_objective_completions(id,quest_id,description,completed_by_character_id,completed_at) VALUES(?,?,?,?,?)").run(objectiveId, questId, description, characterId ?? null, completedAt); return completion(db.prepare("SELECT * FROM quest_objective_completions WHERE id=? AND quest_id=?").get(objectiveId, questId)); },
    async listObjectiveCompletions(campaignId, questId) { requireCampaign(campaignId); requireQuest(campaignId, questId); return (db.prepare("SELECT * FROM quest_objective_completions WHERE quest_id=? ORDER BY completed_at,id").all(questId) as any[]).map(completion); },
  };
}
