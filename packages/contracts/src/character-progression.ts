import { z } from "zod";
import { abilityCatalogReferenceSchema, attributeIdSchema, catalogDefinitionReferenceSchema, classCatalogReferenceSchema, classLevelCatalogDefinitionSchema, featCatalogReferenceSchema, raceCatalogDefinitionSchema, raceCatalogReferenceSchema, spellCatalogReferenceSchema, subclassCatalogReferenceSchema } from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { rulesProfileIdSchema } from "./rpg-content.js";
import { characterBuilderAttributeScoresSchema, characterDerivedStatsSchema } from "./character-builder.js";

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

const progressionChoiceOptions = (kind: "ability" | "ability-score" | "feat" | "subclass" | "class", bounds: { min: number; max: number }) =>
  z.array(catalogDefinitionReferenceSchema).min(bounds.min).max(bounds.max).superRefine((options, context) => {
    const keys = options.map((option) => `${option.packId}\0${option.packVersion}\0${option.definitionId}`);
    if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "progression choice options must be unique" });
    if (options.some((option) => option.kind !== kind)) context.addIssue({ code: "custom", message: `progression choice options must be ${kind} references` });
  });
const selectionReference = (kind: "ability" | "ability-score" | "feat" | "subclass" | "class") =>
  catalogDefinitionReferenceSchema.refine((reference) => reference.kind === kind, {
    message: `progression selection must be a ${kind} reference`,
  });
/** One bounded ability-score-increase distribution. `amount` is per-ability and the
 * whole distribution must spend one or two points across unique exact targets; the
 * write repo additionally requires the total to equal the pending choice's `points`. */
const abilityScoreIncreaseTargetSchema = z.object({
  ability: selectionReference("ability-score"),
  amount: z.number().int().min(1).max(2),
}).strict();
const abilityScoreIncreasesSchema = z.array(abilityScoreIncreaseTargetSchema).min(1).max(2).superRefine((increases, context) => {
  const keys = increases.map((increase) => `${increase.ability.packId}\0${increase.ability.packVersion}\0${increase.ability.definitionId}`);
  if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", message: "ability score increases must target unique abilities" });
  const total = increases.reduce((sum, increase) => sum + increase.amount, 0);
  if (total < 1 || total > 2) context.addIssue({ code: "custom", message: "ability score increases must total one or two points" });
});
/** Legacy ability selections keep their exact `{ choiceId, ability }` input
 * shape; the preprocessing step supplies the byte-compatible discriminator so
 * the same schema stays a discriminated union over all four kinds. The shared
 * `ability` property carries the selected catalog reference for each kind. */
export const progressionSelectionSchema = z.preprocess(
  (value) => value !== null && typeof value === "object" && !("kind" in value)
    ? { ...(value as Record<string, unknown>), kind: "ability" }
    : value,
  z.discriminatedUnion("kind", [
    z.object({ choiceId: resourceIdSchema, kind: z.literal("ability"),
      ability: selectionReference("ability") }).strict(),
    z.object({ choiceId: resourceIdSchema, kind: z.literal("ability-score-increase"),
      increases: abilityScoreIncreasesSchema }).strict(),
    z.object({ choiceId: resourceIdSchema, kind: z.literal("feat"),
      ability: selectionReference("feat") }).strict(),
    z.object({ choiceId: resourceIdSchema, kind: z.literal("subclass"),
      ability: selectionReference("subclass") }).strict(),
    z.object({ choiceId: resourceIdSchema, kind: z.literal("class"),
      ability: selectionReference("class") }).strict(),
  ]),
);
const progressionPendingChoiceBaseShape = {
  level: z.number().int().min(2).max(20), choiceId: resourceIdSchema, required: z.literal(true),
};
/** Additive generalized pending choices. `kind: "ability"` behavior is unchanged
 * and every variant keeps uniqueness, bounds, and `.strict()` guarantees. */
export const progressionPendingChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ ...progressionPendingChoiceBaseShape, kind: z.literal("ability"),
    options: progressionChoiceOptions("ability", { min: 2, max: 16 }) }).strict(),
  z.object({ ...progressionPendingChoiceBaseShape, kind: z.literal("ability-score-increase"),
    points: z.number().int().min(1).max(2),
    options: progressionChoiceOptions("ability-score", { min: 1, max: 6 }) }).strict(),
  z.object({ ...progressionPendingChoiceBaseShape, kind: z.literal("feat"),
    options: progressionChoiceOptions("feat", { min: 1, max: 16 }) }).strict(),
  z.object({ ...progressionPendingChoiceBaseShape, kind: z.literal("subclass"),
    options: progressionChoiceOptions("subclass", { min: 1, max: 16 }) }).strict(),
  z.object({ ...progressionPendingChoiceBaseShape, kind: z.literal("class"),
    options: progressionChoiceOptions("class", { min: 1, max: 12 }) }).strict(),
]);

/** Additive multiclass representation: one exact current class level. Single-class
 * payloads omit it entirely, so existing calculator inputs and outputs remain
 * byte-compatible. */
export const progressionClassLevelSchema = z.object({
  classRef: classCatalogReferenceSchema,
  level: z.number().int().min(1).max(20),
}).strict();
/** Closed multiclass proficiency vocabulary granted on entering a class. */
export const multiclassProficiencySchema = z.enum([
  "light-armor", "medium-armor", "heavy-armor", "shields", "simple-weapons", "martial-weapons",
]);
const multiclassSpellSlotsSchema = z.record(z.string(), z.number().int().min(0).max(9));
export const progressionResourceChangeSchema = z.object({ resourceId: resourceIdSchema, currentBefore: z.number().int().min(0), currentAfter: z.number().int().min(0), maxBefore: z.number().int().min(0), maxAfter: z.number().int().min(0) }).strict();
export const progressionLevelChangeSchema = z.object({
  level: z.number().int().min(2).max(20),
  hp: z.object({ maxBefore: z.number().int().min(1), maxAfter: z.number().int().min(1), currentBefore: z.number().int().min(0), currentAfter: z.number().int().min(0), gain: z.number().int().min(1) }).strict(),
  proficiency: z.object({ before: z.number().int().min(1).max(10), after: z.number().int().min(1).max(10) }).strict(),
  resources: z.array(progressionResourceChangeSchema).max(16),
  fixedAbilities: z.array(abilityCatalogReferenceSchema).max(32),
  selectedAbilities: z.array(abilityCatalogReferenceSchema).max(8),
  /** Optional so advancement records authored before feats/subclasses landed still parse. */
  selectedFeats: z.array(featCatalogReferenceSchema).max(8).optional(),
  selectedSubclasses: z.array(subclassCatalogReferenceSchema).max(8).optional(),
  /** Exact applied ability-score increases for deterministic persistence and replay. */
  abilityScoreIncreases: z.array(z.object({
    attribute: attributeIdSchema,
    amount: z.number().int().min(1).max(2),
  }).strict()).max(2).optional(),
  spells: z.array(spellCatalogReferenceSchema).max(32),
  /** Additive multiclass routing: which class this total level advanced and its
   * resulting class level. Single-class advancements omit both fields. */
  classRef: classCatalogReferenceSchema.optional(),
  classLevel: z.number().int().min(1).max(20).optional(),
  /** Additive first-entry multiclass proficiency grants; absent when none apply. */
  grantedProficiencies: z.array(multiclassProficiencySchema).max(6).optional(),
  derivedBefore: characterDerivedStatsSchema,
  derivedAfter: characterDerivedStatsSchema,
}).strict();
export const progressionPreviewSchema = z.object({
  campaignCharacterId: resourceIdSchema, revision: revisionSchema, token: z.string().regex(/^[0-9a-f]{64}$/),
  mode: progressionModeSchema, currentLevel: z.number().int().min(1).max(20), eligibleLevel: z.number().int().min(1).max(20),
  totalXp: z.number().int().min(0).max(9_007_199_254_740_991), milestoneCount: z.number().int().min(0).max(19),
  pendingChoices: z.array(progressionPendingChoiceSchema).max(32), levels: z.array(progressionLevelChangeSchema).max(19),
  /** Additive multiclass projections. Absent for single-class characters. */
  classLevelsByClass: z.array(progressionClassLevelSchema).min(1).max(12).optional(),
  spellSlots: multiclassSpellSlotsSchema.optional(),
}).strict().superRefine((value, context) => {
  value.levels.forEach((level, index) => { if (level.level !== value.currentLevel + index + 1) context.addIssue({ code: "custom", path: ["levels", index, "level"], message: "crossed levels must be ascending and contiguous" }); });
});

/** Server-assembled calculator input. It contains observed state and immutable
 * catalog steps, never caller-authored totals, levels, HP, DCs, or modifiers. */
export const progressionCalculatorInputSchema = z.object({
  campaignCharacterId: resourceIdSchema, revision: revisionSchema, profile: progressionProfileSchema,
  selectedClassRef: classCatalogReferenceSchema, raceRef: raceCatalogReferenceSchema,
  currentLevel: z.number().int().min(1).max(20), totalXp: z.number().int().min(0).max(9_007_199_254_740_991),
  milestoneCount: z.number().int().min(0).max(19), currentHp: z.number().int().min(0).max(1_000_000),
  currentDerived: characterDerivedStatsSchema,
  derivedBase: z.object({
    scores: characterBuilderAttributeScoresSchema,
    raceSpeed: z.number().int().min(1).max(1_000), spellcastingAttribute: attributeIdSchema,
  }).strict(),
  classLevels: z.array(classLevelCatalogDefinitionSchema).min(1).max(20),
  /** Additive multiclass catalog steps. When present it includes every class the
   * character holds or may enter; absent means the single `selectedClassRef`. */
  classProgressions: z.array(z.object({
    classRef: classCatalogReferenceSchema,
    classLevels: z.array(classLevelCatalogDefinitionSchema).min(1).max(20),
  }).strict()).min(1).max(12).optional(),
  /** Additive current class levels. Absent means `selectedClassRef` at `currentLevel`. */
  classLevelsByClass: z.array(progressionClassLevelSchema).min(1).max(12).optional(),
  knownAbilities: z.array(abilityCatalogReferenceSchema).max(128),
  knownSpells: z.array(spellCatalogReferenceSchema).max(128),
  resources: z.array(z.object({ resourceId: resourceIdSchema, current: z.number().int().min(0).max(1_000_000), max: z.number().int().min(0).max(1_000_000) }).strict()).max(32),
  selections: z.array(progressionSelectionSchema).max(32),
}).strict();

export const progressionStateSchema = z.object({
  campaignCharacterId: resourceIdSchema, campaignId: resourceIdSchema, sheetId: resourceIdSchema, actorId: resourceIdSchema,
  profile: progressionProfileSchema, classRef: classCatalogReferenceSchema, raceRef: raceCatalogReferenceSchema, race: raceCatalogDefinitionSchema, level: z.number().int().min(1).max(20),
  totalXp: z.number().int().min(0).max(9_007_199_254_740_991), milestoneCount: z.number().int().min(0).max(19), revision: revisionSchema,
  pendingChoices: z.array(progressionPendingChoiceSchema).max(32), knownAbilities: z.array(abilityCatalogReferenceSchema).max(128),
  knownSpells: z.array(spellCatalogReferenceSchema).max(128),
  /** Optional so stored receipts authored before feats/subclasses landed still parse. */
  knownFeats: z.array(featCatalogReferenceSchema).max(128).optional(),
  knownSubclasses: z.array(subclassCatalogReferenceSchema).max(128).optional(),
  /** Additive multiclass projections. Absent for single-class characters. */
  classLevelsByClass: z.array(progressionClassLevelSchema).min(1).max(12).optional(),
  knownProficiencies: z.array(multiclassProficiencySchema).max(6).optional(),
  derived: characterDerivedStatsSchema, updatedAt: utcIsoTimestampSchema,
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
export type ProgressionPendingChoice = z.infer<typeof progressionPendingChoiceSchema>;
export type ProgressionSelection = z.infer<typeof progressionSelectionSchema>;
export type ProgressionClassLevel = z.infer<typeof progressionClassLevelSchema>;
export type MulticlassProficiency = z.infer<typeof multiclassProficiencySchema>;
export type GrantCharacterXpInput = z.infer<typeof grantCharacterXpInputSchema>;
export type GrantCharacterMilestoneInput = z.infer<typeof grantCharacterMilestoneInputSchema>;
export type CorrectCharacterXpInput = z.infer<typeof correctCharacterXpInputSchema>;
export type ApplyCharacterProgressionInput = z.infer<typeof applyCharacterProgressionInputSchema>;
export type ProgressionCommandResult = z.infer<typeof progressionCommandResultSchema>;
export type ProgressionReceipt = z.infer<typeof progressionReceiptSchema>;
export type ProgressionEvent = z.infer<typeof progressionEventSchema>;
