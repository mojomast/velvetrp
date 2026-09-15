import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";

/** Trusted-local encounter planning surface: SRD CR/XP budgets over pinned enemy templates. */

export const encounterPlanningDifficultySchema = z.enum(["easy", "medium", "hard", "deadly"]);
export const encounterPlanningResultDifficultySchema = z.enum(["trivial", "easy", "medium", "hard", "deadly"]);

export const encounterPlanningRequestSchema = z.object({
  partyLevels: z.array(z.number().int().min(1).max(20)).min(1).max(12),
  targetDifficulty: encounterPlanningDifficultySchema,
  candidateIds: z.array(resourceIdSchema).max(64).optional(),
  maxMonsters: z.number().int().min(1).max(50).optional(),
}).strict();

export const encounterCandidateSchema = z.object({
  id: resourceIdSchema, name: z.string().trim().min(1).max(200), challengeRating: z.number().min(0).max(30),
}).strict();

export const encounterRosterEntrySchema = z.object({
  id: resourceIdSchema, challengeRating: z.number().min(0).max(30), count: z.number().int().min(1).max(50),
}).strict();

export const encounterPlanSchema = z.object({
  targetDifficulty: encounterPlanningDifficultySchema,
  targetXp: z.number().int().min(0),
  upperBound: z.number().int().min(0).nullable(),
  roster: z.array(encounterRosterEntrySchema).max(64),
  rawXp: z.number().int().min(0),
  adjustedXp: z.number().min(0),
  difficulty: encounterPlanningResultDifficultySchema,
  monsterCount: z.number().int().min(0),
  legal: z.boolean(),
  reasons: z.array(z.string().trim().min(1).max(500)).max(16),
}).strict();

export const encounterPlanResponseSchema = z.object({
  candidates: z.array(encounterCandidateSchema).max(2048),
  plan: encounterPlanSchema,
}).strict();

export type EncounterPlanningRequest = z.infer<typeof encounterPlanningRequestSchema>;
export type EncounterCandidate = z.infer<typeof encounterCandidateSchema>;
export type EncounterPlan = z.infer<typeof encounterPlanSchema>;
export type EncounterPlanResponse = z.infer<typeof encounterPlanResponseSchema>;

/** Trusted-local reward preview: raw SRD XP for defeated pinned monsters plus level-up eligibility. */
export const encounterRewardPreviewRequestSchema = z.object({
  defeatedEnemyIds: z.array(resourceIdSchema).min(1).max(64),
  currentXp: z.number().int().min(0).max(9007199254740991),
  currentLevel: z.number().int().min(1).max(20),
}).strict();

export const encounterRewardPreviewResponseSchema = z.object({
  xpAwarded: z.number().int().min(0),
  totalXp: z.number().int().min(0),
  currentLevel: z.number().int().min(1).max(20),
  nextLevel: z.number().int().min(2).max(20).nullable(),
  nextLevelXp: z.number().int().min(0).nullable(),
  levelUpEligible: z.boolean(),
  levelsGained: z.number().int().min(0).max(19),
  legal: z.boolean(),
  reasons: z.array(z.string().trim().min(1).max(500)).max(16),
}).strict();

/** Trusted-local NPC/stat-block selection over pinned enemy templates. */
export const npcSelectionRequestSchema = z.object({
  role: z.string().trim().min(1).max(64).optional(),
  minChallengeRating: z.number().min(0).max(30).optional(),
  maxChallengeRating: z.number().min(0).max(30).optional(),
  count: z.number().int().min(1).max(32),
  excludeIds: z.array(resourceIdSchema).max(64).optional(),
}).strict();

export const npcSelectionEntrySchema = z.object({
  id: resourceIdSchema, name: z.string().trim().min(1).max(200), challengeRating: z.number().min(0).max(30),
}).strict();

export const npcSelectionResponseSchema = z.object({
  selected: z.array(npcSelectionEntrySchema).max(32),
  legal: z.boolean(),
  reasons: z.array(z.string().trim().min(1).max(500)).max(16),
}).strict();

export type EncounterRewardPreviewRequest = z.infer<typeof encounterRewardPreviewRequestSchema>;
export type EncounterRewardPreviewResponse = z.infer<typeof encounterRewardPreviewResponseSchema>;
export type NpcSelectionRequest = z.infer<typeof npcSelectionRequestSchema>;
export type NpcSelectionResponse = z.infer<typeof npcSelectionResponseSchema>;
