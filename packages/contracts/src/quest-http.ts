import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";
import { questRewardKindSchema, storylineIdSchema, StorylineSchema } from "./quest.js";

const titleSchema = z.string().trim().min(1).max(200);
const textSchema = z.string().max(4_000);
const visibilitySchema = z.enum(["public", "gm"]);

// Storyline endpoints remain the ancestry-management boundary for quest creation.
export const createStorylineRequestSchema = z.object({
  title: StorylineSchema.shape.title,
  description: StorylineSchema.shape.description.optional(),
  status: StorylineSchema.shape.status.optional(),
}).strict();
export const createStorylineResponseSchema = z.object({ storyline: StorylineSchema }).strict();
export const updateStorylineStatusRequestSchema = z.object({ status: StorylineSchema.shape.status }).strict();
export const updateStorylineStatusResponseSchema = createStorylineResponseSchema;

export const questLifecycleStatusSchema = z.enum(["offered", "active", "completed", "abandoned"]);

export const questRewardDefinitionHttpSchema = z.object({
  rewardId: resourceIdSchema,
  kind: questRewardKindSchema,
  amount: z.number().int().safe().nullable(),
  label: titleSchema,
  claimedByActorId: actorIdSchema.nullable(),
  claimedAt: utcIsoTimestampSchema.nullable(),
}).strict();

export const campaignQuestHttpSchema = z.object({
  questId: resourceIdSchema,
  campaignId: campaignIdSchema,
  storylineId: storylineIdSchema,
  title: titleSchema,
  description: textSchema.nullable(),
  status: questLifecycleStatusSchema,
  rewards: z.array(questRewardDefinitionHttpSchema).max(100),
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict();

/** Player quest projections intentionally omit storyline ancestry. */
export const playerCampaignQuestHttpSchema = campaignQuestHttpSchema.omit({ storylineId: true });
export const campaignQuestProjectionHttpSchema = z.union([campaignQuestHttpSchema, playerCampaignQuestHttpSchema]);

export const questObjectiveHttpSchema = z.object({
  objectiveId: resourceIdSchema,
  questId: resourceIdSchema,
  description: textSchema.refine((value) => value.trim().length > 0, "description must not be blank"),
  targetProgress: z.number().int().min(1).max(1_000_000),
  progress: z.number().int().min(0).max(1_000_000),
  dependencyObjectiveIds: z.array(resourceIdSchema).max(100),
  completedAt: utcIsoTimestampSchema.nullable(),
}).strict().refine((objective) => objective.progress <= objective.targetProgress, "objective progress cannot exceed its target");

export const questJournalEntryHttpSchema = z.object({
  entryId: resourceIdSchema,
  questId: resourceIdSchema,
  text: textSchema.refine((value) => value.trim().length > 0, "journal text must not be blank"),
  occurredAt: utcIsoTimestampSchema,
}).strict();

export const gmCampaignQuestsHttpResponseSchema = z.object({
  quests: z.array(campaignQuestHttpSchema).max(10_000),
  objectives: z.array(questObjectiveHttpSchema).max(100_000),
  journal: z.array(questJournalEntryHttpSchema).max(100_000),
}).strict();
export const playerCampaignQuestsHttpResponseSchema = z.object({
  quests: z.array(playerCampaignQuestHttpSchema).max(10_000),
  objectives: z.array(questObjectiveHttpSchema).max(100_000),
  journal: z.array(questJournalEntryHttpSchema).max(100_000),
}).strict();
export const campaignQuestsHttpResponseSchema = z.union([gmCampaignQuestsHttpResponseSchema, playerCampaignQuestsHttpResponseSchema]);

const newObjectiveSchema = z.object({
  objectiveId: resourceIdSchema,
  description: textSchema.refine((value) => value.trim().length > 0, "description must not be blank"),
  targetProgress: z.number().int().min(1).max(1_000_000),
  dependencyObjectiveIds: z.array(resourceIdSchema).max(100),
  visibility: visibilitySchema,
}).strict();

const newRewardSchema = z.object({
  rewardId: resourceIdSchema,
  kind: questRewardKindSchema,
  amount: z.number().int().safe().nullable(),
  label: titleSchema,
  visibility: visibilitySchema,
}).strict();

export const newCampaignQuestSchema = z.object({
  questId: resourceIdSchema,
  storylineId: storylineIdSchema,
  title: titleSchema,
  description: textSchema.nullable(),
  visibility: visibilitySchema,
  objectives: z.array(newObjectiveSchema).min(1).max(100),
  rewards: z.array(newRewardSchema).max(100),
  journalText: textSchema.refine((value) => value.trim().length > 0, "journal text must not be blank"),
}).strict().superRefine((quest, context) => {
  const objectiveIds = quest.objectives.map((objective) => objective.objectiveId);
  if (new Set(objectiveIds).size !== objectiveIds.length) {
    context.addIssue({ code: "custom", message: "objective IDs must be unique", path: ["objectives"] });
  }
  const ids = new Set(objectiveIds);
  quest.objectives.forEach((objective, index) => {
    if (new Set(objective.dependencyObjectiveIds).size !== objective.dependencyObjectiveIds.length) {
      context.addIssue({ code: "custom", message: "objective dependencies must be unique", path: ["objectives", index, "dependencyObjectiveIds"] });
    }
    if (objective.dependencyObjectiveIds.includes(objective.objectiveId)) {
      context.addIssue({ code: "custom", message: "an objective cannot depend on itself", path: ["objectives", index, "dependencyObjectiveIds"] });
    }
    if (objective.dependencyObjectiveIds.some((dependencyId) => !ids.has(dependencyId))) {
      context.addIssue({ code: "custom", message: "objective dependencies must belong to this quest", path: ["objectives", index, "dependencyObjectiveIds"] });
    }
  });
  const objectiveById = new Map(quest.objectives.map((objective) => [objective.objectiveId, objective]));
  quest.objectives.forEach((objective, index) => {
    if (objective.visibility !== "public") return;
    const pending = [...objective.dependencyObjectiveIds], seen = new Set<string>();
    while (pending.length > 0) {
      const dependencyId = pending.pop()!; if (seen.has(dependencyId)) continue; seen.add(dependencyId);
      const dependency = objectiveById.get(dependencyId); if (!dependency) continue;
      if (dependency.visibility !== "public") {
        context.addIssue({ code: "custom", message: "public objectives cannot depend on GM objectives",
          path: ["objectives", index, "dependencyObjectiveIds"] });
        break;
      }
      pending.push(...dependency.dependencyObjectiveIds);
    }
  });
  const rewardIds = quest.rewards.map((reward) => reward.rewardId);
  if (new Set(rewardIds).size !== rewardIds.length) {
    context.addIssue({ code: "custom", message: "reward IDs must be unique", path: ["rewards"] });
  }
});

export const createCampaignQuestHttpRequestSchema = z.object({
  quest: newCampaignQuestSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const questCommandReceiptHttpSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1, "a quest command advances exactly one revision");

export const createCampaignQuestHttpResponseSchema = z.object({
  quest: campaignQuestHttpSchema,
  receipt: questCommandReceiptHttpSchema,
}).strict();

const commandEnvelope = {
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
};
export const questCommandHttpRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("accept"), ...commandEnvelope }).strict(),
  z.object({ kind: z.literal("advance-objective"), objectiveId: resourceIdSchema, ...commandEnvelope }).strict(),
  z.object({ kind: z.literal("abandon"), ...commandEnvelope }).strict(),
  z.object({ kind: z.literal("claim-reward"), actorId: actorIdSchema, rewardId: resourceIdSchema, ...commandEnvelope }).strict(),
]);

export const questCommandHttpResponseSchema = z.object({
  quest: campaignQuestProjectionHttpSchema,
  receipt: questCommandReceiptHttpSchema,
}).strict();

export type CampaignQuestHttp = z.infer<typeof campaignQuestHttpSchema>;
export type PlayerCampaignQuestHttp = z.infer<typeof playerCampaignQuestHttpSchema>;
export type CampaignQuestProjectionHttp = z.infer<typeof campaignQuestProjectionHttpSchema>;
export type QuestObjectiveHttp = z.infer<typeof questObjectiveHttpSchema>;
export type QuestJournalEntryHttp = z.infer<typeof questJournalEntryHttpSchema>;
export type CampaignQuestsHttpResponse = z.infer<typeof campaignQuestsHttpResponseSchema>;
export type CreateCampaignQuestHttpRequest = z.infer<typeof createCampaignQuestHttpRequestSchema>;
export type QuestCommandHttpRequest = z.infer<typeof questCommandHttpRequestSchema>;
export type QuestCommandReceiptHttp = z.infer<typeof questCommandReceiptHttpSchema>;
