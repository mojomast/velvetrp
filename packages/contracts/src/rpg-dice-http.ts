import { z } from "zod";
import { utcIsoTimestampSchema } from "./domain-primitives.js";
import { MAX_CAMPAIGN_CHARACTER_ROSTER, publicCampaignCharacterSummarySchema } from "./rpg-characters.js";
import { diceExpressionSchema, diceRollResultSchema } from "./rpg-dice.js";

/** The trusted-local HTTP history is deliberately fixed and cannot be widened by callers. */
export const MAX_CAMPAIGN_DICE_HISTORY = 20;

export const campaignDiceVisibleCharacterSchema = z.object({
  position: z.number().int().min(1).max(MAX_CAMPAIGN_CHARACTER_ROSTER),
  name: publicCampaignCharacterSummarySchema.shape.name,
}).strict();

export const campaignDiceHistoryRollSchema = z.object({
  character: campaignDiceVisibleCharacterSchema,
  occurredAt: utcIsoTimestampSchema,
  result: diceRollResultSchema,
}).strict();

export const campaignDiceHistoryResponseSchema = z.object({
  characters: z.array(campaignDiceVisibleCharacterSchema).max(MAX_CAMPAIGN_CHARACTER_ROSTER),
  rolls: z.array(campaignDiceHistoryRollSchema).max(MAX_CAMPAIGN_DICE_HISTORY),
}).strict().superRefine(({ characters, rolls }, context) => {
  characters.forEach((character, index) => {
    if (character.position !== index + 1) {
      context.addIssue({
        code: "custom",
        message: "character positions must be contiguous and one-based",
        path: ["characters", index, "position"],
      });
    }
  });
  rolls.forEach((roll, index) => {
    const visible = characters[roll.character.position - 1];
    if (visible === undefined || visible.name !== roll.character.name) {
      context.addIssue({
        code: "custom",
        message: "roll character must bind to the visible character list",
        path: ["rolls", index, "character"],
      });
    }
  });
});

export const campaignDiceRollRequestSchema = z.object({
  character: campaignDiceVisibleCharacterSchema,
  expression: diceExpressionSchema,
}).strict();

export const campaignDiceRollResponseSchema = z.object({
  roll: campaignDiceHistoryRollSchema,
}).strict();

export type CampaignDiceVisibleCharacter = z.infer<typeof campaignDiceVisibleCharacterSchema>;
export type CampaignDiceHistoryRoll = z.infer<typeof campaignDiceHistoryRollSchema>;
export type CampaignDiceHistoryResponse = z.infer<typeof campaignDiceHistoryResponseSchema>;
export type CampaignDiceRollRequest = z.infer<typeof campaignDiceRollRequestSchema>;
export type CampaignDiceRollResponse = z.infer<typeof campaignDiceRollResponseSchema>;
