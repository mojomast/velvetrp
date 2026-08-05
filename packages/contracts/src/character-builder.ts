import { z } from "zod";
import {
  attributeIdSchema,
  backgroundCatalogReferenceSchema,
  classCatalogReferenceSchema,
  contentDigestSchema,
  currencyCatalogReferenceSchema,
  itemCatalogReferenceSchema,
  raceCatalogReferenceSchema,
} from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { contentPackIdSchema, contentPackVersionSchema, rulesProfileIdSchema } from "./rpg-content.js";

/** M1.3 is intentionally one closed six-attribute, single-class builder. */
export const CHARACTER_BUILDER_ATTRIBUTE_IDS = [
  "might", "agility", "resolve", "insight", "presence", "craft",
] as const;
export const CHARACTER_BUILDER_STANDARD_ARRAY = [15, 14, 13, 12, 10, 8] as const;
export const CHARACTER_BUILDER_POINT_BUY_BUDGET = 27 as const;
export const CHARACTER_DRAFT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
export const CHARACTER_BUILDER_ROLL_DICE = 4 as const;
export const CHARACTER_BUILDER_ROLL_SIDES = 6 as const;

export const characterBuilderAttributeScoresSchema = z.object({
  might: z.number().int().min(3).max(20),
  agility: z.number().int().min(3).max(20),
  resolve: z.number().int().min(3).max(20),
  insight: z.number().int().min(3).max(20),
  presence: z.number().int().min(3).max(20),
  craft: z.number().int().min(3).max(20),
}).strict();

const standardArrayAllocationSchema = z.object({
  method: z.literal("standard-array"),
  scores: characterBuilderAttributeScoresSchema,
}).strict().superRefine((value, context) => {
  const sorted = Object.values(value.scores).sort((a, b) => b - a);
  if (JSON.stringify(sorted) !== JSON.stringify(CHARACTER_BUILDER_STANDARD_ARRAY)) {
    context.addIssue({ code: "custom", path: ["scores"], message: "scores must assign the exact standard array once" });
  }
});

const pointBuyCosts = new Map([[8, 0], [9, 1], [10, 2], [11, 3], [12, 4], [13, 5], [14, 7], [15, 9]]);
export function characterBuilderPointBuyCost(scores: z.infer<typeof characterBuilderAttributeScoresSchema>): number | null {
  let total = 0;
  for (const score of Object.values(scores)) {
    const cost = pointBuyCosts.get(score);
    if (cost === undefined) return null;
    total += cost;
  }
  return total;
}

const pointBuyAllocationSchema = z.object({
  method: z.literal("point-buy"),
  scores: characterBuilderAttributeScoresSchema,
}).strict().superRefine((value, context) => {
  if (characterBuilderPointBuyCost(value.scores) !== CHARACTER_BUILDER_POINT_BUY_BUDGET) {
    context.addIssue({ code: "custom", path: ["scores"], message: "point buy must spend exactly 27 points on scores from 8 through 15" });
  }
});

const manualAllocationSchema = z.object({
  method: z.literal("manual"),
  scores: characterBuilderAttributeScoresSchema,
}).strict();

/** Callers choose the method only; roll values and terms are server output. */
const serverRollRequestSchema = z.object({ method: z.literal("server-roll") }).strict();
export const characterBuilderAllocationRequestSchema = z.discriminatedUnion("method", [
  standardArrayAllocationSchema, pointBuyAllocationSchema, manualAllocationSchema, serverRollRequestSchema,
]);

export const characterBuilderRollTermSchema = z.object({
  attributeId: attributeIdSchema,
  dice: z.array(z.number().int().min(1).max(CHARACTER_BUILDER_ROLL_SIDES)).length(CHARACTER_BUILDER_ROLL_DICE),
  droppedIndex: z.number().int().min(0).max(CHARACTER_BUILDER_ROLL_DICE - 1),
  score: z.number().int().min(3).max(18),
}).strict().superRefine((term, context) => {
  const minimum = Math.min(...term.dice);
  if (term.dice[term.droppedIndex] !== minimum) context.addIssue({ code: "custom", path: ["droppedIndex"], message: "the first lowest die must be dropped" });
  const firstMinimum = term.dice.indexOf(minimum);
  if (term.droppedIndex !== firstMinimum) context.addIssue({ code: "custom", path: ["droppedIndex"], message: "ties drop the first lowest die" });
  if (term.score !== term.dice.reduce((sum, die) => sum + die, 0) - minimum) context.addIssue({ code: "custom", path: ["score"], message: "score must equal kept dice" });
});
export const characterBuilderAllocationSchema = z.discriminatedUnion("method", [
  standardArrayAllocationSchema, pointBuyAllocationSchema, manualAllocationSchema,
  z.object({
    method: z.literal("server-roll"),
    algorithm: z.literal("velvet-4d6-drop-first-lowest-v1"),
    scores: characterBuilderAttributeScoresSchema,
    terms: z.array(characterBuilderRollTermSchema).length(CHARACTER_BUILDER_ATTRIBUTE_IDS.length),
  }).strict().superRefine((value, context) => {
    value.terms.forEach((term, index) => {
      if (term.attributeId !== CHARACTER_BUILDER_ATTRIBUTE_IDS[index]) context.addIssue({ code: "custom", path: ["terms", index, "attributeId"], message: "roll terms must use canonical attribute order" });
      if (value.scores[term.attributeId] !== term.score) context.addIssue({ code: "custom", path: ["scores", term.attributeId], message: "score must match persisted roll term" });
    });
  }),
]);

export const characterDraftDurabilitySchema = z.enum(["durable", "expiring"]);
export const characterDraftStatusSchema = z.enum(["active", "abandoned", "finalized"]);
export const characterBuilderStarterGrantChoiceSchema = z.enum(["kit", "currency"]);
export const characterBuilderSelectionsSchema = z.object({
  race: raceCatalogReferenceSchema.nullable(),
  background: backgroundCatalogReferenceSchema.nullable(),
  class: classCatalogReferenceSchema.nullable(),
  starterGrant: characterBuilderStarterGrantChoiceSchema.nullable(),
}).strict();
export const characterBuilderSelectionPatchSchema = z.object({
  race: raceCatalogReferenceSchema.optional(),
  background: backgroundCatalogReferenceSchema.optional(),
  class: classCatalogReferenceSchema.optional(),
  starterGrant: characterBuilderStarterGrantChoiceSchema.optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "at least one selection is required");

export const characterDraftPinSchema = z.object({
  packId: contentPackIdSchema,
  packVersion: contentPackVersionSchema,
  publicationDigest: contentDigestSchema,
}).strict();
export const characterBuilderIssueSchema = z.object({
  code: z.enum(["missing-race", "missing-background", "missing-class", "missing-starter-grant", "expired", "pins-changed", "persona-unavailable", "controller-unavailable", "definition-unavailable"]),
  path: z.string().min(1).max(200),
  message: z.string().min(1).max(500),
}).strict();
export const characterBuilderCompletionSchema = z.object({
  complete: z.boolean(),
  issues: z.array(characterBuilderIssueSchema).max(32),
}).strict().superRefine((value, context) => {
  if (value.complete !== (value.issues.length === 0)) context.addIssue({ code: "custom", path: ["complete"], message: "complete must exactly reflect issues" });
});

export const characterBuilderOptionSchema = z.object({
  reference: z.union([raceCatalogReferenceSchema, backgroundCatalogReferenceSchema, classCatalogReferenceSchema]),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4_000),
}).strict();
export const characterBuilderChoiceGroupSchema = z.discriminatedUnion("id", [
  z.object({ id: z.literal("race"), required: z.literal(true), options: z.array(characterBuilderOptionSchema).min(1).max(256) }).strict(),
  z.object({ id: z.literal("background"), required: z.literal(true), options: z.array(characterBuilderOptionSchema).min(1).max(256) }).strict(),
  z.object({ id: z.literal("class"), required: z.literal(true), options: z.array(characterBuilderOptionSchema).min(1).max(256) }).strict(),
  z.object({ id: z.literal("starter-grant"), required: z.literal(true), options: z.tuple([z.literal("kit"), z.literal("currency")]) }).strict(),
]);

export const characterDerivedStatisticSchema = z.enum([
  "max-hp", "defense-guard", "defense-evasion", "defense-will", "initiative", "speed", "carrying-limit", "spell-attack", "save-dc",
]);
export const characterDerivedExplanationSchema = z.object({
  statistic: characterDerivedStatisticSchema,
  formula: z.string().min(1).max(200),
  inputs: z.record(z.string(), z.number().int()).refine((value) => Object.keys(value).length <= 8),
  result: z.number().int(),
}).strict();
export const characterDerivedStatsSchema = z.object({
  maxHp: z.number().int().min(1).max(1_000_000),
  defenses: z.object({ guard: z.number().int(), evasion: z.number().int(), will: z.number().int() }).strict(),
  initiative: z.number().int(),
  speed: z.number().int().min(1).max(1_000),
  carryingLimit: z.number().int().min(0).max(1_000_000),
  spellAttack: z.number().int(),
  saveDc: z.number().int(),
  explanations: z.array(characterDerivedExplanationSchema).length(9),
}).strict();
export const characterDerivedCalculatorInputSchema = z.object({
  scores: characterBuilderAttributeScoresSchema,
  racialBonuses: z.partialRecord(attributeIdSchema, z.number().int().min(-5).max(5)),
  classHp: z.number().int().min(1).max(100),
  raceSpeed: z.number().int().min(1).max(100),
  proficiencyBonus: z.number().int().min(1).max(10),
  spellcastingAttribute: attributeIdSchema,
}).strict();

export const characterStartingGrantSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("item"), reference: itemCatalogReferenceSchema, quantity: z.number().int().min(1).max(100), source: z.literal("background-kit") }).strict(),
  z.object({ kind: z.literal("currency"), reference: currencyCatalogReferenceSchema, amount: z.number().int().min(0).max(1_000_000), source: z.literal("background-currency") }).strict(),
]);

export const characterDraftViewSchema = z.object({
  id: resourceIdSchema,
  campaignId: resourceIdSchema,
  personaId: resourceIdSchema,
  controllerPrincipalId: resourceIdSchema,
  role: z.enum(["owner", "gm", "player", "observer"]),
  status: characterDraftStatusSchema,
  durability: characterDraftDurabilitySchema,
  expiresAt: utcIsoTimestampSchema.nullable(),
  effectivelyExpired: z.boolean(),
  revision: revisionSchema,
  rulesProfileId: rulesProfileIdSchema,
  pins: z.array(characterDraftPinSchema).min(1).max(32),
  allocation: characterBuilderAllocationSchema,
  selections: characterBuilderSelectionsSchema,
  choiceGroups: z.array(characterBuilderChoiceGroupSchema).length(4),
  completion: characterBuilderCompletionSchema,
  derivedPreview: characterDerivedStatsSchema.nullable(),
  startingGrants: z.array(characterStartingGrantSchema).max(64),
  createdAt: utcIsoTimestampSchema,
  updatedAt: utcIsoTimestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.durability === "durable") !== (value.expiresAt === null)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "only expiring drafts have expiry" });
  if (value.updatedAt < value.createdAt) context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt cannot precede createdAt" });
});

export const createCharacterDraftInputSchema = z.object({
  personaId: resourceIdSchema,
  controllerPrincipalId: resourceIdSchema,
  durability: characterDraftDurabilitySchema,
  allocation: characterBuilderAllocationRequestSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();
export const updateCharacterDraftInputSchema = z.object({
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  selections: characterBuilderSelectionPatchSchema,
}).strict();
export const abandonCharacterDraftInputSchema = z.object({ expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema }).strict();
export const finalizeCharacterDraftInputSchema = z.object({ expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema,
  progressionMode: z.enum(["xp", "milestone"]).optional() }).strict();

export const characterDraftMutationReceiptSchema = z.object({
  draftId: resourceIdSchema,
  commandId: resourceIdSchema,
  idempotencyKey: idempotencyKeySchema,
  type: z.enum(["create", "update", "abandon"]),
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
  draft: characterDraftViewSchema,
}).strict().superRefine((value, context) => {
  const expected = value.type === "create" ? 0 : value.revisionBefore + 1;
  if (value.revisionAfter !== expected) context.addIssue({ code: "custom", path: ["revisionAfter"], message: "draft receipt revision is invalid" });
});
export const characterFinalizationReceiptSchema = z.object({
  draftId: resourceIdSchema,
  commandId: resourceIdSchema,
  eventId: resourceIdSchema,
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
  campaignCharacterId: resourceIdSchema,
  sheetId: resourceIdSchema,
  actorId: resourceIdSchema,
  derived: characterDerivedStatsSchema,
  startingGrants: z.array(characterStartingGrantSchema).max(64),
}).strict().superRefine((value, context) => {
  if (value.revisionAfter !== value.revisionBefore + 1) context.addIssue({ code: "custom", path: ["revisionAfter"], message: "finalization must advance once" });
});
export const characterDraftMutationResultSchema = z.object({ draft: characterDraftViewSchema, receipt: characterDraftMutationReceiptSchema }).strict();
export const characterDraftFinalizationResultSchema = z.object({ draft: characterDraftViewSchema, receipt: characterFinalizationReceiptSchema }).strict();

export type CharacterBuilderAttributeScores = z.infer<typeof characterBuilderAttributeScoresSchema>;
export type CharacterBuilderAllocationRequest = z.infer<typeof characterBuilderAllocationRequestSchema>;
export type CharacterBuilderAllocation = z.infer<typeof characterBuilderAllocationSchema>;
export type CharacterDerivedCalculatorInput = z.infer<typeof characterDerivedCalculatorInputSchema>;
export type CharacterDerivedStats = z.infer<typeof characterDerivedStatsSchema>;
export type CharacterDraftView = z.infer<typeof characterDraftViewSchema>;
export type CharacterDraftPin = z.infer<typeof characterDraftPinSchema>;
export type CreateCharacterDraftInput = z.infer<typeof createCharacterDraftInputSchema>;
export type UpdateCharacterDraftInput = z.infer<typeof updateCharacterDraftInputSchema>;
export type AbandonCharacterDraftInput = z.infer<typeof abandonCharacterDraftInputSchema>;
export type FinalizeCharacterDraftInput = z.infer<typeof finalizeCharacterDraftInputSchema>;
export type CharacterDraftMutationReceipt = z.infer<typeof characterDraftMutationReceiptSchema>;
export type CharacterFinalizationReceipt = z.infer<typeof characterFinalizationReceiptSchema>;
export type CharacterDraftMutationResult = z.infer<typeof characterDraftMutationResultSchema>;
export type CharacterDraftFinalizationResult = z.infer<typeof characterDraftFinalizationResultSchema>;
export type CharacterStartingGrant = z.infer<typeof characterStartingGrantSchema>;
