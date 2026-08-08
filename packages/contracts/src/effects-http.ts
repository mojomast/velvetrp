import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { effectDurationSchema, effectModifierSchema, effectRecoverySchema, effectSourceSchema } from "./effects.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

/** Reviewed public effect mechanics. Persistence and command provenance are intentionally absent. */
export const actorEffectPublicSchema = z.object({
  effectId: resourceIdSchema,
  source: effectSourceSchema.nullable(),
  modifiers: z.array(effectModifierSchema).min(1).max(64),
  duration: effectDurationSchema,
  recovery: effectRecoverySchema,
  stacking: z.enum(["coexists", "concentration"]),
  appliedAt: utcIsoTimestampSchema,
}).strict();

export const actorEffectConcentrationBindingSchema = z.object({
  effectId: resourceIdSchema,
  concentrationId: resourceIdSchema,
}).strict();

export const actorEffectsResponseSchema = z.object({
  effects: z.array(actorEffectPublicSchema).max(128),
  concentration: z.array(actorEffectConcentrationBindingSchema).max(128),
  revision: revisionSchema,
}).strict().superRefine((response, context) => {
  const effectIds = response.effects.map((effect) => effect.effectId);
  if (new Set(effectIds).size !== effectIds.length
      || response.effects.some((effect, index) => index > 0
        && `${effect.appliedAt}\0${effect.effectId}` <= `${response.effects[index - 1]!.appliedAt}\0${response.effects[index - 1]!.effectId}`)) {
    context.addIssue({ code: "custom", message: "effects must be unique and stably ordered", path: ["effects"] });
  }

  const bindingIds = response.concentration.map((binding) => binding.effectId);
  const concentrationIds = response.concentration.map((binding) => binding.concentrationId);
  if (new Set(bindingIds).size !== bindingIds.length
      || new Set(concentrationIds).size !== concentrationIds.length
      || bindingIds.some((id, index) => index > 0 && id <= bindingIds[index - 1]!)) {
    context.addIssue({ code: "custom", message: "concentration bindings must be unique and stably ordered", path: ["concentration"] });
  }
  const expected = response.effects.filter((effect) => effect.stacking === "concentration")
    .map((effect) => effect.effectId).sort();
  if (JSON.stringify(bindingIds) !== JSON.stringify(expected)) {
    context.addIssue({ code: "custom", message: "concentration must bind exactly the concentration effects", path: ["concentration"] });
  }
});

const actorEffectCommandBase = {
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
};

/** Actor-scoped public intent. Identity, bindings, and audit times are server-owned. */
export const actorEffectApplyCommandRequestSchema = z.object({
  ...actorEffectCommandBase,
  kind: z.literal("apply"),
  effect: z.object({
    source: effectSourceSchema.nullable(),
    modifiers: z.array(effectModifierSchema).min(1).max(64),
    duration: effectDurationSchema,
    recovery: effectRecoverySchema,
    stacking: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("coexists") }).strict(),
      z.object({ kind: z.literal("concentration"), concentrationId: resourceIdSchema }).strict(),
    ]),
  }).strict(),
}).strict();

export const actorEffectRemoveCommandRequestSchema = z.object({
  ...actorEffectCommandBase,
  kind: z.literal("remove"),
  effectId: resourceIdSchema,
}).strict();

export const actorEffectAdvanceDurationCommandRequestSchema = z.object({
  ...actorEffectCommandBase,
  kind: z.literal("advance-duration"),
  effectId: resourceIdSchema,
  rounds: z.number().int().min(1).max(100_000),
}).strict();

export const actorEffectCommandRequestSchema = z.discriminatedUnion("kind", [
  actorEffectApplyCommandRequestSchema,
  actorEffectRemoveCommandRequestSchema,
  actorEffectAdvanceDurationCommandRequestSchema,
]);

export const actorEffectCommandReceiptSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1,
  "an effect command advances exactly one revision");

export const actorEffectCommandResponseSchema = z.object({
  effects: z.array(actorEffectPublicSchema).max(128),
  receipt: actorEffectCommandReceiptSchema,
}).strict().superRefine((response, context) => {
  const identities = response.effects.map((effect) => effect.effectId);
  if (new Set(identities).size !== identities.length
    || response.effects.some((effect, index) => index > 0
      && `${effect.appliedAt}\0${effect.effectId}` <= `${response.effects[index - 1]!.appliedAt}\0${response.effects[index - 1]!.effectId}`)) {
    context.addIssue({ code: "custom", message: "effects must be unique and stably ordered", path: ["effects"] });
  }
});

export type ActorEffectPublic = z.infer<typeof actorEffectPublicSchema>;
export type ActorEffectConcentrationBinding = z.infer<typeof actorEffectConcentrationBindingSchema>;
export type ActorEffectsResponse = z.infer<typeof actorEffectsResponseSchema>;
export type ActorEffectCommandRequest = z.infer<typeof actorEffectCommandRequestSchema>;
export type ActorEffectCommandResponse = z.infer<typeof actorEffectCommandResponseSchema>;
