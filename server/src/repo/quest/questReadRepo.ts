import type DatabaseDriver from "better-sqlite3";

type Database = DatabaseDriver.Database;

/** A campaign storyline used to group related quests. */
export interface Storyline {
  id: string;
  campaignId: string;
  title: string;
  description: string | null;
  status: "active" | "completed" | "abandoned";
  createdAt: string;
}

/** A campaign quest and its current lifecycle state. */
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

/** A clue associated with a quest. */
export interface QuestClue {
  id: string;
  questId: string;
  campaignId: string;
  content: string;
  discoveredByCharacterId: string | null;
  discoveredAt: string | null;
  createdAt: string;
}

/** A reward associated with a quest. */
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

/** A recorded completion of one quest objective. */
export interface QuestObjectiveCompletion {
  id: string;
  questId: string;
  description: string;
  completedByCharacterId: string | null;
  completedAt: string;
}

/** Input used to create a storyline. */
export interface CreateStorylineInput {
  id?: string;
  title: string;
  description?: string | null;
  status?: Storyline["status"];
}

/** Input used to create a quest. */
export interface CreateQuestInput {
  id?: string;
  title: string;
  description?: string | null;
  status?: Quest["status"];
  sortOrder?: number;
}

/** Input used to create a quest reward. */
export interface CreateRewardInput {
  id?: string;
  kind: QuestReward["kind"];
  amount?: number | null;
  label: string;
}

/** Input used to update a storyline. */
export interface UpdateStorylineInput {
  title?: string;
  description?: string | null;
  status?: Storyline["status"];
}

/** Input used to update a quest. */
export interface UpdateQuestInput {
  title?: string;
  description?: string | null;
  status?: Quest["status"];
  sortOrder?: number;
}

/** Complete non-mutating projection of a quest. */
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

/** Principal-scoped, non-mutating quest operations. */
export interface QuestReadRepository {
  listStorylines(campaignId: string): Promise<Storyline[]>;
  getStoryline(campaignId: string, storylineId: string): Promise<Storyline | null>;
  listQuests(campaignId: string, storylineId?: string): Promise<Quest[]>;
  getQuest(campaignId: string, questId: string): Promise<Quest | null>;
  getQuestDetail(campaignId: string, questId: string): Promise<QuestDetail | null>;
  listClues(campaignId: string, questId: string): Promise<QuestClue[]>;
  getClue(campaignId: string, questId: string, clueId: string): Promise<QuestClue | null>;
  listRewards(campaignId: string, questId: string): Promise<QuestReward[]>;
  getReward(campaignId: string, questId: string, rewardId: string): Promise<QuestReward | null>;
  listObjectiveCompletions(campaignId: string, questId: string): Promise<QuestObjectiveCompletion[]>;
}

const storyline = (row: any): Storyline => ({ id: row.id, campaignId: row.campaign_id, title: row.title, description: row.description, status: row.status, createdAt: row.created_at });
const quest = (row: any): Quest => ({ id: row.id, storylineId: row.storyline_id, campaignId: row.campaign_id, title: row.title, description: row.description, status: row.status, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at });
const clue = (row: any): QuestClue => ({ id: row.id, questId: row.quest_id, campaignId: row.campaign_id, content: row.content, discoveredByCharacterId: row.discovered_by_character_id, discoveredAt: row.discovered_at, createdAt: row.created_at });
const reward = (row: any): QuestReward => ({ id: row.id, questId: row.quest_id, campaignId: row.campaign_id, kind: row.kind, amount: row.amount, label: row.label, grantedToCharacterId: row.granted_to_character_id, grantedAt: row.granted_at, createdAt: row.created_at });
const completion = (row: any): QuestObjectiveCompletion => ({ id: row.id, questId: row.quest_id, description: row.description, completedByCharacterId: row.completed_by_character_id, completedAt: row.completed_at });

/** Low-level storyline listing retained for trusted database callers. */
export async function listStorylines(db: Database, campaignId: string): Promise<Storyline[]> {
  return (db.prepare("SELECT * FROM quest_storylines WHERE campaign_id=? ORDER BY created_at,id").all(campaignId) as any[]).map(storyline);
}

/** Low-level storyline lookup retained for trusted database callers. */
export async function getStoryline(db: Database, storylineId: string): Promise<Storyline | null> {
  const row = db.prepare("SELECT * FROM quest_storylines WHERE id=?").get(storylineId);
  return row ? storyline(row) : null;
}

/** Low-level quest listing retained for trusted database callers. */
export async function listQuests(db: Database, campaignId: string, storylineId?: string): Promise<Quest[]> {
  const rows = storylineId === undefined
    ? db.prepare("SELECT * FROM quests WHERE campaign_id=? ORDER BY sort_order,id").all(campaignId)
    : db.prepare("SELECT * FROM quests WHERE campaign_id=? AND storyline_id=? ORDER BY sort_order,id").all(campaignId, storylineId);
  return (rows as any[]).map(quest);
}

/** Low-level quest lookup retained for trusted database callers. */
export async function getQuest(db: Database, questId: string): Promise<Quest | null> {
  const row = db.prepare("SELECT * FROM quests WHERE id=?").get(questId);
  return row ? quest(row) : null;
}

/** Low-level clue listing retained for trusted database callers. */
export async function listClues(db: Database, questId: string): Promise<QuestClue[]> {
  return (db.prepare("SELECT * FROM quest_clues WHERE quest_id=? ORDER BY created_at,id").all(questId) as any[]).map(clue);
}

/** Low-level reward listing retained for trusted database callers. */
export async function listRewards(db: Database, questId: string): Promise<QuestReward[]> {
  return (db.prepare("SELECT * FROM quest_rewards WHERE quest_id=? ORDER BY created_at,id").all(questId) as any[]).map(reward);
}

/** Low-level objective completion listing retained for trusted database callers. */
export async function listObjectiveCompletions(db: Database, questId: string): Promise<QuestObjectiveCompletion[]> {
  return (db.prepare("SELECT * FROM quest_objective_completions WHERE quest_id=? ORDER BY completed_at,id").all(questId) as any[]).map(completion);
}

/** Creates principal-scoped, non-mutating quest projections. */
export function createQuestReadRepository(
  db: Database,
  principalId: string,
): QuestReadRepository {
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
    async getStoryline(campaignId, storylineId) {
      requireCampaign(campaignId); const row = scopedStoryline(campaignId, storylineId);
      return row ? storyline(row) : null;
    },
    async listQuests(campaignId, storylineId) {
      requireCampaign(campaignId);
      if (storylineId !== undefined) requireStoryline(campaignId, storylineId);
      const rows = storylineId === undefined
        ? db.prepare("SELECT * FROM quests WHERE campaign_id=? ORDER BY sort_order,id").all(campaignId)
        : db.prepare("SELECT * FROM quests WHERE campaign_id=? AND storyline_id=? ORDER BY sort_order,id").all(campaignId, storylineId);
      return (rows as any[]).map(quest);
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
    async listClues(campaignId, questId) { requireCampaign(campaignId); requireQuest(campaignId, questId); return (db.prepare("SELECT * FROM quest_clues WHERE quest_id=? AND campaign_id=? ORDER BY created_at,id").all(questId, campaignId) as any[]).map(clue); },
    async getClue(campaignId, questId, clueId) { requireCampaign(campaignId); requireQuest(campaignId, questId); const row = scopedClue(campaignId, questId, clueId); return row ? clue(row) : null; },
    async listRewards(campaignId, questId) { requireCampaign(campaignId); requireQuest(campaignId, questId); return (db.prepare("SELECT * FROM quest_rewards WHERE quest_id=? AND campaign_id=? ORDER BY created_at,id").all(questId, campaignId) as any[]).map(reward); },
    async getReward(campaignId, questId, rewardId) { requireCampaign(campaignId); requireQuest(campaignId, questId); const row = scopedReward(campaignId, questId, rewardId); return row ? reward(row) : null; },
    async listObjectiveCompletions(campaignId, questId) { requireCampaign(campaignId); requireQuest(campaignId, questId); return (db.prepare("SELECT * FROM quest_objective_completions WHERE quest_id=? ORDER BY completed_at,id").all(questId) as any[]).map(completion); },
  };
}
