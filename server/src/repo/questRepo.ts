import type DatabaseDriver from "better-sqlite3";
import type { Clock, IdGenerator } from "../runtime.js";
import { LOCAL_OWNER_PRINCIPAL_ID } from "./shared.js";
import {
  createQuestReadRepository,
  type QuestReadRepository,
} from "./quest/index.js";
import { createQuestDomainRepository, type QuestDomainRepository } from "./quest/index.js";

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
} from "./quest/index.js";
export {
  QuestAuthorizationError, QuestConflictError, QuestDomainUnavailableError, QuestStaleError,
   type CampaignQuestSnapshot, type QuestMutationResult, type QuestCreateMutationResult,
} from "./quest/index.js";
type Database = DatabaseDriver.Database;

/** Public quest facade: legacy reads plus the sole authoritative mutation lane. */
export interface QuestRepository extends QuestReadRepository, QuestDomainRepository {}

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
  dependencies?: { clock: Clock; ids: IdGenerator },
): QuestRepository {
  const reads = createQuestReadRepository(db, principalId);
  const domain = createQuestDomainRepository(db, dependencies === undefined ? undefined : {
    clock: dependencies.clock, ids: dependencies.ids, guard: assertCanMutate,
  });
  return { ...reads, ...domain };
}
