import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";
import { abilityCatalogReferenceSchema, spellCatalogReferenceSchema } from "./content-catalog.js";

export const effectIdSchema = resourceIdSchema;
export const effectSourceSchema = z.discriminatedUnion("kind", [abilityCatalogReferenceSchema, spellCatalogReferenceSchema]);

/** This is the complete modifier vocabulary. New mechanics require an explicit contract review. */
export const modifierKindSchema = z.enum(["flat", "proficiency", "advantage", "resistance", "vulnerability", "immunity"]);
export const effectModifierSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("flat"), amount: z.number().int().min(-10_000).max(10_000), appliesToId: resourceIdSchema }).strict(),
  z.object({ kind: z.literal("proficiency"), bonus: z.number().int().min(0).max(10_000), appliesToId: resourceIdSchema }).strict(),
  z.object({ kind: z.literal("advantage"), appliesToId: resourceIdSchema }).strict(),
  z.object({ kind: z.literal("resistance"), appliesToId: resourceIdSchema }).strict(),
  z.object({ kind: z.literal("vulnerability"), appliesToId: resourceIdSchema }).strict(),
  z.object({ kind: z.literal("immunity"), appliesToId: resourceIdSchema }).strict(),
]);

export const effectDurationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("until_removed") }).strict(),
  z.object({ kind: z.literal("rounds"), remaining: z.number().int().min(1).max(100_000) }).strict(),
  z.object({ kind: z.literal("until_timestamp"), expiresAt: utcIsoTimestampSchema }).strict(),
]);
export const effectRecoverySchema = z.enum(["none", "short_rest", "long_rest"]);
export const concentrationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("required"), concentrationId: resourceIdSchema }).strict(),
]);

export const activeEffectSchema = z.object({
  effectId: effectIdSchema,
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  source: effectSourceSchema.nullable(),
  modifiers: z.array(effectModifierSchema).min(1).max(64),
  duration: effectDurationSchema,
  recovery: effectRecoverySchema,
  concentration: concentrationSchema,
  appliedAt: utcIsoTimestampSchema,
}).strict();

const effectCommandBase = { campaignId: campaignIdSchema, actorId: actorIdSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema };
export const applyEffectCommandSchema = z.object({ ...effectCommandBase, type: z.literal("apply_effect"), effect: activeEffectSchema, appliedAt: utcIsoTimestampSchema }).strict().superRefine((command, context) => {
  if (command.effect.campaignId !== command.campaignId) context.addIssue({ code: "custom", message: "effect campaignId must match command", path: ["effect", "campaignId"] });
  if (command.effect.actorId !== command.actorId) context.addIssue({ code: "custom", message: "effect actorId must match command", path: ["effect", "actorId"] });
  if (command.effect.appliedAt !== command.appliedAt) context.addIssue({ code: "custom", message: "effect appliedAt must match command", path: ["effect", "appliedAt"] });
});
export const removeEffectCommandSchema = z.object({ ...effectCommandBase, type: z.literal("remove_effect"), effectId: effectIdSchema, removedAt: utcIsoTimestampSchema }).strict();
export const advanceEffectDurationCommandSchema = z.object({ ...effectCommandBase, type: z.literal("advance_effect_duration"), effectId: effectIdSchema, rounds: z.number().int().min(1).max(100_000), advancedAt: utcIsoTimestampSchema }).strict();
export const effectCommandSchema = z.discriminatedUnion("type", [applyEffectCommandSchema, removeEffectCommandSchema, advanceEffectDurationCommandSchema]);

export type ModifierKind = z.infer<typeof modifierKindSchema>;
export type EffectModifier = z.infer<typeof effectModifierSchema>;
export type EffectDuration = z.infer<typeof effectDurationSchema>;
export type EffectRecovery = z.infer<typeof effectRecoverySchema>;
export type Concentration = z.infer<typeof concentrationSchema>;
export type ActiveEffect = z.infer<typeof activeEffectSchema>;
export type ApplyEffectCommand = z.infer<typeof applyEffectCommandSchema>;
export type RemoveEffectCommand = z.infer<typeof removeEffectCommandSchema>;
export type AdvanceEffectDurationCommand = z.infer<typeof advanceEffectDurationCommandSchema>;
export type EffectCommand = z.infer<typeof effectCommandSchema>;
