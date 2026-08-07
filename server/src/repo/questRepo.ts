import type DatabaseDriver from "better-sqlite3";
import { LOCAL_OWNER_PRINCIPAL_ID } from "./shared.js";
import {
  createQuestReadRepository,
  type QuestReadRepository,
} from "./quest/questReadRepo.js";
import {
  createQuestWriteRepository,
  type QuestWriteRepository,
} from "./quest/questWriteRepo.js";

export {
  getQuest,
  getStoryline,
  listClues,
  listObjectiveCompletions,
  listQuests,
  listRewards,
  listStorylines,
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
export {
  addClue,
  addReward,
  completeObjective,
  createQuest,
  createStoryline,
  grantReward,
  markClueDiscovered,
  reorderQuests,
  updateQuestStatus,
  updateStorylineStatus,
} from "./quest/questWriteRepo.js";

type Database = DatabaseDriver.Database;

/** Public quest facade combining authorized projections and mutations. */
export interface QuestRepository extends QuestReadRepository, QuestWriteRepository {}

/**
 * Creates the trusted-local quest facade.
 *
 * The default principal and no-op mutation assertion retain the legacy factory
 * contract for local route adapters; production orchestration supplies both.
 */
export function createQuestRepository(
  db: Database,
  principalId = LOCAL_OWNER_PRINCIPAL_ID,
  assertCanMutate: () => void = () => undefined,
): QuestRepository {
  const reads = createQuestReadRepository(db, principalId);
  const writes = createQuestWriteRepository(db, principalId, assertCanMutate);
  return { ...reads, ...writes };
}
