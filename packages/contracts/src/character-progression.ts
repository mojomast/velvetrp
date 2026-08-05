import { z } from "zod";
import { abilityCatalogReferenceSchema, classCatalogReferenceSchema, classLevelCatalogDefinitionSchema, spellCatalogReferenceSchema } from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { rulesProfileIdSchema } from "./rpg-content.js";
import { characterDerivedStatsSchema } from "./character-builder.js";

export const PROGRESSION_CALCULATOR_VERSION = "velvet-character-progression-v1" as const;
export const STARTER_PROGRESSION_PROFILE_ID = "velvet:progression:starter-v1" as const;
export const MAX_PROGRESSION_REASON_LENGTH = 500;

export const progressionModeSchema = z.enum(["xp", "milestone"]);
export const progressionReasonSchema = z.string().trim().min(1).max(MAX_PROGRESSION_REASON_LENGTH);
export const progressionThresholdSchema = z.object({ level: z.number().int().min(1).max(20), xp: z.number().int().min(0).max(9_007_199_254_740_991) }).strict();
export const progressionProfileSchema = z.object({
  profileId: resourceIdSchema,
  rulesProfileId: rulesProfileIdSchema,
  mode: progressionModeSchema,
  maxLevel: z.number().int().min(1).max(20),
  thresholds: z.array(progressionThresholdSchema).min(1).max(20),
}).strict().superRefine((value, context) => {
  value.thresholds.forEach((threshold, index) => {
    if (threshold.level !== index + 1 || (index === 0 ? threshold.xp !== 0 : threshold.xp <= value.thresholds[index - 1]!.xp)) {
      context.addIssue({ code: "custom", path: ["thresholds", index], message: "thresholds must be contiguous and strictly ascending from level 1 at zero XP" });
    }
  });
  if (value.maxLevel !== value.thresholds.length) context.addIssue({ code: "custom", path: ["maxLevel"], message: "maxLevel must equal threshold count" });
});

export const progressionSelectionSchema = z.object({ choiceId: resourceIdSchema, ability: abilityCatalogReferenceSchema }).strict();
export const progressionPendingChoiceSchema = z.object({
  level: z.number().int().min(2).max(20), choiceId: resourceIdSchema, kind: z.literal("ability"), required: z.literal(true),
  options: z.array(abilityCatalogReferenceSchema).min(2).max(16),
}).strict();
export const progressionResourceChangeSchema = z.object({ resourceId: resourceIdSchema, currentBefore: z.number().int().min(0), currentAfter: z.number().int().min(0), maxBefore: z.number().int().min(0), maxAfter: z.number().int().min(0) }).strict();
export const progressionLevelChangeSchema = z.object({
  level: z.number().int().min(2).max(20),
  hp: z.object({ maxBefore: z.number().int().min(1), maxAfter: z.number().int().min(1), currentBefore: z.number().int().min(0), currentAfter: z.number().int().min(0), gain: z.number().int().min(1) }).strict(),
  proficiency: z.object({ before: z.number().int().min(1).max(10), after: z.number().int().min(1).max(10) }).strict(),
  resources: z.array(progressionResourceChangeSchema).max(16),
  fixedAbilities: z.array(abilityCatalogReferenceSchema).max(32),
  selectedAbilities: z.array(abilityCatalogReferenceSchema).max(8),
  spells: z.array(spellCatalogReferenceSchema).max(32),
  derivedBefore: characterDerivedStatsSchema,
  derivedAfter: characterDerivedStatsSchema,
}).strict();
export const progressionPreviewSchema = z.object({
  campaignCharacterId: resourceIdSchema, revision: revisionSchema, token: z.string().regex(/^[0-9a-f]{64}$/),
  mode: progressionModeSchema, currentLevel: z.number().int().min(1).max(20), eligibleLevel: z.number().int().min(1).max(20),
  totalXp: z.number().int().min(0).max(9_007_199_254_740_991), milestoneCount: z.number().int().min(0).max(19),
  pendingChoices: z.array(progressionPendingChoiceSchema).max(32), levels: z.array(progressionLevelChangeSchema).max(19),
}).strict().superRefine((value, context) => {
  value.levels.forEach((level, index) => { if (level.level !== value.currentLevel + index + 1) context.addIssue({ code: "custom", path: ["levels", index, "level"], message: "crossed levels must be ascending and contiguous" }); });
});

/** Server-assembled calculator input. It contains observed state and immutable
 * catalog steps, never caller-authored totals, levels, HP, DCs, or modifiers. */
export const progressionCalculatorInputSchema = z.object({
  campaignCharacterId: resourceIdSchema, revision: revisionSchema, profile: progressionProfileSchema,
  selectedClassRef: classCatalogReferenceSchema,
  currentLevel: z.number().int().min(1).max(20), totalXp: z.number().int().min(0).max(9_007_199_254_740_991),
  milestoneCount: z.number().int().min(0).max(19), currentHp: z.number().int().min(0).max(1_000_000),
  currentDerived: characterDerivedStatsSchema,
  derivedBase: z.object({
    scores: z.object({ might: z.number().int(), agility: z.number().int(), resolve: z.number().int(), insight: z.number().int(), presence: z.number().int(), craft: z.number().int() }).strict(),
    raceSpeed: z.number().int().min(1).max(1_000), spellcastingAttribute: z.enum(["might", "agility", "resolve", "insight", "presence", "craft"]),
  }).strict(),
  classLevels: z.array(classLevelCatalogDefinitionSchema).min(1).max(20),
  knownAbilities: z.array(abilityCatalogReferenceSchema).max(128),
  knownSpells: z.array(spellCatalogReferenceSchema).max(128),
  resources: z.array(z.object({ resourceId: resourceIdSchema, current: z.number().int().min(0).max(1_000_000), max: z.number().int().min(0).max(1_000_000) }).strict()).max(32),
  selections: z.array(progressionSelectionSchema).max(32),
}).strict();

export const progressionStateSchema = z.object({
  campaignCharacterId: resourceIdSchema, campaignId: resourceIdSchema, sheetId: resourceIdSchema, actorId: resourceIdSchema,
  profile: progressionProfileSchema, classRef: classCatalogReferenceSchema, level: z.number().int().min(1).max(20),
  totalXp: z.number().int().min(0).max(9_007_199_254_740_991), milestoneCount: z.number().int().min(0).max(19), revision: revisionSchema,
  pendingChoices: z.array(progressionPendingChoiceSchema).max(32), knownAbilities: z.array(abilityCatalogReferenceSchema).max(128),
  knownSpells: z.array(spellCatalogReferenceSchema).max(128), derived: characterDerivedStatsSchema, updatedAt: utcIsoTimestampSchema,
}).strict();

export const grantCharacterXpInputSchema = z.object({ amount: z.number().int().min(1).max(1_000_000), reason: progressionReasonSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema }).strict();
export const grantCharacterMilestoneInputSchema = z.object({ reason: progressionReasonSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema }).strict();
export const correctCharacterXpInputSchema = z.object({ entryId: resourceIdSchema, reason: progressionReasonSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema }).strict();
export const applyCharacterProgressionInputSchema = z.object({ previewRevision: expectedRevisionSchema, previewToken: z.string().regex(/^[0-9a-f]{64}$/), selections: z.array(progressionSelectionSchema).max(32), idempotencyKey: idempotencyKeySchema }).strict();
export const progressionReceiptSchema = z.object({ commandId: resourceIdSchema, campaignCharacterId: resourceIdSchema, idempotencyKey: idempotencyKeySchema, type: z.enum(["grant-xp", "grant-milestone", "correct-xp", "apply-levels"]), revisionBefore: revisionSchema, revisionAfter: revisionSchema, occurredAt: utcIsoTimestampSchema, state: progressionStateSchema, appliedLevels: z.array(progressionLevelChangeSchema).max(19) }).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1, "progression command advances exactly one revision");
export const progressionCommandResultSchema = z.object({ progression: progressionStateSchema, receipt: progressionReceiptSchema }).strict();
export const progressionEventSchema = z.object({
  eventId: resourceIdSchema, commandId: resourceIdSchema, campaignCharacterId: resourceIdSchema,
  type: z.enum(["progress_granted", "progress_corrected", "levels_applied"]), revision: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
  publicData: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("grant"), mode: progressionModeSchema, amount: z.number().int().min(1).max(1_000_000) }).strict(),
    z.object({ kind: z.literal("correction"), correctedEntryId: resourceIdSchema, reason: progressionReasonSchema }).strict(),
    z.object({ kind: z.literal("advancement"), levels: z.array(z.number().int().min(2).max(20)).min(1).max(19) }).strict(),
  ]),
}).strict();

export type ProgressionProfile = z.infer<typeof progressionProfileSchema>;
export type ProgressionPreview = z.infer<typeof progressionPreviewSchema>;
export type ProgressionCalculatorInput = z.infer<typeof progressionCalculatorInputSchema>;
export type ProgressionState = z.infer<typeof progressionStateSchema>;
export type ProgressionLevelChange = z.infer<typeof progressionLevelChangeSchema>;
export type ProgressionSelection = z.infer<typeof progressionSelectionSchema>;
export type GrantCharacterXpInput = z.infer<typeof grantCharacterXpInputSchema>;
export type GrantCharacterMilestoneInput = z.infer<typeof grantCharacterMilestoneInputSchema>;
export type CorrectCharacterXpInput = z.infer<typeof correctCharacterXpInputSchema>;
export type ApplyCharacterProgressionInput = z.infer<typeof applyCharacterProgressionInputSchema>;
export type ProgressionCommandResult = z.infer<typeof progressionCommandResultSchema>;
export type ProgressionReceipt = z.infer<typeof progressionReceiptSchema>;
export type ProgressionEvent = z.infer<typeof progressionEventSchema>;
