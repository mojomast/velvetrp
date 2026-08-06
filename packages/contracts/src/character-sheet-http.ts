import { z } from "zod";
import { characterDerivedStatsSchema } from "./character-builder.js";
import { progressionModeSchema } from "./character-progression.js";
import { utcIsoTimestampSchema } from "./domain-primitives.js";
import { campaignCharacterWorkspaceSchema } from "./rpg-characters.js";

/** Public progression details that do not disclose identities, revisions, or choices. */
export const characterSheetHttpProgressionSchema = z.object({
  mode: progressionModeSchema,
  level: z.number().int().min(1).max(20),
  totalXp: z.number().int().min(0).max(9_007_199_254_740_991),
  milestoneCount: z.number().int().min(0).max(19),
  updatedAt: utcIsoTimestampSchema,
}).strict();

/** Display-only character sheet read model for the route-bound character. */
export const characterSheetHttpResponseSchema = z.object({
  sheet: campaignCharacterWorkspaceSchema,
  derived: characterDerivedStatsSchema,
  progression: characterSheetHttpProgressionSchema,
}).strict().superRefine((response, context) => {
  const sheetLevel = response.sheet.classes.reduce((total, characterClass) => total + characterClass.level, 0);
  if (sheetLevel !== response.progression.level) {
    context.addIssue({
      code: "custom",
      message: "sheet class levels must equal progression level",
      path: ["progression", "level"],
    });
  }
});

export type CharacterSheetHttpProgression = z.infer<typeof characterSheetHttpProgressionSchema>;
export type CharacterSheetHttpResponse = z.infer<typeof characterSheetHttpResponseSchema>;
