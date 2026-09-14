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
