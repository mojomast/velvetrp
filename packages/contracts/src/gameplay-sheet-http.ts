import { z } from "zod";
import { characterDerivedStatsSchema } from "./character-builder.js";
import {
  backgroundCatalogReferenceSchema,
  catalogDefinitionReferenceSchema,
  classCatalogReferenceSchema,
  equipmentSlotSchema,
  itemCatalogReferenceSchema,
  raceCatalogReferenceSchema,
} from "./content-catalog.js";
import { progressionModeSchema } from "./character-progression.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { effectDurationSchema, effectModifierSchema, effectRecoverySchema } from "./effects.js";
import { actorPowerAvailabilityReasonSchema } from "./powers-http.js";
import { powerReferenceSchema } from "./powers.js";
import { proficiencyCategorySchema } from "./rpg-characters.js";

const labelSchema = z.string().trim().min(1).max(200);
const amountSchema = z.number().int().min(0).max(1_000_000);

export const gameplaySheetIdentitySchema = z.object({
  actorId: resourceIdSchema,
  name: labelSchema,
}).strict();

const namedReference = <T extends z.ZodType>(reference: T) => z.object({
  reference,
  label: labelSchema,
}).strict();

export const gameplaySheetProgressionSchema = z.object({
  mode: progressionModeSchema,
  level: z.number().int().min(1).max(20),
  totalXp: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  milestoneCount: z.number().int().min(0).max(19),
  pendingChoiceCount: z.number().int().min(0).max(32),
  updatedAt: utcIsoTimestampSchema,
}).strict();

export const gameplaySheetInventoryItemSchema = z.object({
  entryId: resourceIdSchema,
  item: itemCatalogReferenceSchema,
  label: labelSchema,
  quantity: z.number().int().min(1).max(1_000_000),
  equippedSlot: equipmentSlotSchema.nullable(),
}).strict();

export const gameplaySheetKnownPowerSchema = z.object({
  power: powerReferenceSchema,
  label: labelSchema,
  available: z.boolean(),
  unavailableReasons: z.array(actorPowerAvailabilityReasonSchema)
    .max(actorPowerAvailabilityReasonSchema.options.length),
}).strict().refine(
  (power) => power.available === (power.unavailableReasons.length === 0),
  { message: "power availability must match its reasons", path: ["available"] },
);

export const gameplaySheetActiveEffectSchema = z.object({
  effectId: resourceIdSchema,
  source: z.object({ reference: powerReferenceSchema, label: labelSchema }).strict().nullable(),
  modifiers: z.array(effectModifierSchema).min(1).max(64),
  duration: effectDurationSchema,
  recovery: effectRecoverySchema,
  stacking: z.enum(["coexists", "concentration"]),
  appliedAt: utcIsoTimestampSchema,
}).strict();

/** Actor-bound campaign-play projection. Exact catalog references are public domain IDs, not provider IDs. */
export const actorGameplaySheetResponseSchema = z.object({
  rulesetId: resourceIdSchema.optional(),
  rulesetVersion: z.string().trim().min(1).max(100).optional(),
  identity: gameplaySheetIdentitySchema,
  race: namedReference(raceCatalogReferenceSchema),
  background: namedReference(backgroundCatalogReferenceSchema),
  classes: z.array(namedReference(classCatalogReferenceSchema).extend({
    level: z.number().int().min(1).max(100),
  }).strict()).max(16),
  attributes: z.array(z.object({
    attributeId: resourceIdSchema,
    label: labelSchema,
    value: z.number().int().min(-1_000).max(1_000),
  }).strict()).max(64),
  proficiencies: z.array(z.object({
    proficiencyId: resourceIdSchema,
    label: labelSchema,
    category: proficiencyCategorySchema,
  }).strict()).max(128),
  choices: z.array(z.object({
    choiceId: resourceIdSchema,
    label: labelSchema,
    selection: namedReference(catalogDefinitionReferenceSchema),
  }).strict()).max(128),
  derived: characterDerivedStatsSchema,
  progression: gameplaySheetProgressionSchema,
  resources: z.array(z.object({
    resourceId: resourceIdSchema,
    label: labelSchema,
    current: amountSchema,
    capacity: amountSchema,
  }).strict().refine((resource) => resource.current <= resource.capacity, {
    message: "resource current cannot exceed capacity", path: ["current"],
  })).max(128),
  inventory: z.object({
    capacity: z.number().int().min(0).max(1_000),
    items: z.array(gameplaySheetInventoryItemSchema).max(1_000),
  }).strict(),
  knownPowers: z.array(gameplaySheetKnownPowerSchema).max(256),
  activeEffects: z.array(gameplaySheetActiveEffectSchema).max(128),
}).strict().superRefine((sheet, context) => {
  const classLevel = sheet.classes.reduce((total, entry) => total + entry.level, 0);
  if (classLevel !== sheet.progression.level) {
    context.addIssue({ code: "custom", message: "class levels must equal progression level", path: ["progression", "level"] });
  }
});

export type ActorGameplaySheetResponse = z.infer<typeof actorGameplaySheetResponseSchema>;
