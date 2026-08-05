import { z } from "zod";
import {
  QuestClueSchema,
  QuestObjectiveCompletionSchema,
  QuestRewardSchema,
  QuestSchema,
  StorylineSchema,
} from "./quest.js";

export const createStorylineRequestSchema = z.object({
  title: StorylineSchema.shape.title,
  description: StorylineSchema.shape.description.optional(),
  status: StorylineSchema.shape.status.optional(),
}).strict();

export const createStorylineResponseSchema = z.object({
  storyline: StorylineSchema,
}).strict();

export const updateStorylineStatusRequestSchema = z.object({
  status: StorylineSchema.shape.status,
}).strict();

export const updateStorylineStatusResponseSchema = createStorylineResponseSchema;

export const createQuestRequestSchema = z.object({
  storylineId: QuestSchema.shape.storylineId,
  title: QuestSchema.shape.title,
  description: QuestSchema.shape.description.optional(),
  status: QuestSchema.shape.status.optional(),
  sortOrder: QuestSchema.shape.sortOrder.optional(),
}).strict();

export const createQuestResponseSchema = z.object({
  quest: QuestSchema,
}).strict();

export const updateQuestStatusRequestSchema = z.object({
  status: QuestSchema.shape.status,
}).strict();

export const updateQuestStatusResponseSchema = createQuestResponseSchema;

export const listQuestsQuerySchema = z.object({
  storylineId: QuestSchema.shape.storylineId.optional(),
}).strict();

export const listQuestsResponseSchema = z.object({
  quests: z.array(QuestSchema),
}).strict();

export const questDetailResponseSchema = z.object({
  quest: QuestSchema,
  clues: z.array(QuestClueSchema),
  rewards: z.array(QuestRewardSchema),
  objectiveCompletions: z.array(QuestObjectiveCompletionSchema),
}).strict();

export const createQuestClueRequestSchema = z.object({
  content: QuestClueSchema.shape.content,
  discoveredByCharacterId: QuestClueSchema.shape.discoveredByCharacterId.unwrap().optional(),
}).strict();

export const createQuestClueResponseSchema = z.object({
  clue: QuestClueSchema,
}).strict();

export const discoverQuestClueRequestSchema = z.object({
  characterId: QuestClueSchema.shape.discoveredByCharacterId.unwrap(),
}).strict();

export const discoverQuestClueResponseSchema = createQuestClueResponseSchema;

export const createQuestRewardRequestSchema = z.object({
  kind: QuestRewardSchema.shape.kind,
  amount: QuestRewardSchema.shape.amount.optional(),
  label: QuestRewardSchema.shape.label,
}).strict();

export const createQuestRewardResponseSchema = z.object({
  reward: QuestRewardSchema,
}).strict();

export const grantQuestRewardRequestSchema = z.object({
  characterId: QuestRewardSchema.shape.grantedToCharacterId.unwrap(),
}).strict();

export const grantQuestRewardResponseSchema = createQuestRewardResponseSchema;

export const completeQuestObjectiveRequestSchema = z.object({
  description: QuestObjectiveCompletionSchema.shape.description,
  characterId: QuestObjectiveCompletionSchema.shape.completedByCharacterId.unwrap().optional(),
}).strict();

export const completeQuestObjectiveResponseSchema = z.object({
  objectiveCompletion: QuestObjectiveCompletionSchema,
}).strict();

export type CreateStorylineRequest = z.infer<typeof createStorylineRequestSchema>;
export type CreateStorylineResponse = z.infer<typeof createStorylineResponseSchema>;
export type UpdateStorylineStatusRequest = z.infer<typeof updateStorylineStatusRequestSchema>;
export type CreateQuestRequest = z.infer<typeof createQuestRequestSchema>;
export type CreateQuestResponse = z.infer<typeof createQuestResponseSchema>;
export type UpdateQuestStatusRequest = z.infer<typeof updateQuestStatusRequestSchema>;
export type ListQuestsQuery = z.infer<typeof listQuestsQuerySchema>;
export type ListQuestsResponse = z.infer<typeof listQuestsResponseSchema>;
export type QuestDetailResponse = z.infer<typeof questDetailResponseSchema>;
export type CreateQuestClueRequest = z.infer<typeof createQuestClueRequestSchema>;
export type CreateQuestClueResponse = z.infer<typeof createQuestClueResponseSchema>;
export type DiscoverQuestClueRequest = z.infer<typeof discoverQuestClueRequestSchema>;
export type CreateQuestRewardRequest = z.infer<typeof createQuestRewardRequestSchema>;
export type CreateQuestRewardResponse = z.infer<typeof createQuestRewardResponseSchema>;
export type GrantQuestRewardRequest = z.infer<typeof grantQuestRewardRequestSchema>;
export type CompleteQuestObjectiveRequest = z.infer<typeof completeQuestObjectiveRequestSchema>;
export type CompleteQuestObjectiveResponse = z.infer<typeof completeQuestObjectiveResponseSchema>;
