import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { campaignIdSchema } from "./rpg-characters.js";

export const storylineIdSchema = resourceIdSchema;
export const questIdSchema = resourceIdSchema;
export const questClueIdSchema = resourceIdSchema;
export const questRewardIdSchema = resourceIdSchema;
export const questObjectiveCompletionIdSchema = resourceIdSchema;

export const MAX_QUEST_NAME_LENGTH = 200;
export const MAX_QUEST_TEXT_LENGTH = 4_000;

const questNameSchema = z.string().min(1).max(MAX_QUEST_NAME_LENGTH).refine((value) => value.trim().length > 0, "name must not be blank");
const questTextSchema = z.string().max(MAX_QUEST_TEXT_LENGTH);

export const storylineStatusSchema = z.enum(["active", "completed", "abandoned"]);
export const questStatusSchema = z.enum(["open", "active", "completed", "failed"]);
export const questRewardKindSchema = z.enum(["xp", "currency", "item", "custom"]);

export const StorylineSchema = z.object({
  id: storylineIdSchema,
  campaignId: campaignIdSchema,
  title: questNameSchema,
  description: questTextSchema.nullable(),
  status: storylineStatusSchema,
  createdAt: utcIsoTimestampSchema,
}).strict();

export const QuestSchema = z.object({
  id: questIdSchema,
  campaignId: campaignIdSchema,
  storylineId: storylineIdSchema,
  title: questNameSchema,
  description: questTextSchema.nullable(),
  status: questStatusSchema,
  sortOrder: z.number().int(),
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict();

export const QuestClueSchema = z.object({
  id: questClueIdSchema,
  campaignId: campaignIdSchema,
  questId: questIdSchema,
  content: questTextSchema,
  discoveredByCharacterId: resourceIdSchema.nullable(),
  discoveredAt: utcIsoTimestampSchema.nullable(),
  createdAt: utcIsoTimestampSchema,
}).strict();

export const QuestRewardSchema = z.object({
  id: questRewardIdSchema,
  campaignId: campaignIdSchema,
  questId: questIdSchema,
  kind: questRewardKindSchema,
  amount: z.number().int().nullable(),
  label: questNameSchema,
  grantedToCharacterId: resourceIdSchema.nullable(),
  grantedAt: utcIsoTimestampSchema.nullable(),
  createdAt: utcIsoTimestampSchema,
}).strict();

export const QuestObjectiveCompletionSchema = z.object({
  id: questObjectiveCompletionIdSchema,
  questId: questIdSchema,
  description: questTextSchema,
  completedByCharacterId: resourceIdSchema.nullable(),
  completedAt: utcIsoTimestampSchema,
}).strict();

export type Storyline = z.infer<typeof StorylineSchema>;
export type Quest = z.infer<typeof QuestSchema>;
export type QuestClue = z.infer<typeof QuestClueSchema>;
export type QuestReward = z.infer<typeof QuestRewardSchema>;
export type QuestObjectiveCompletion = z.infer<typeof QuestObjectiveCompletionSchema>;
