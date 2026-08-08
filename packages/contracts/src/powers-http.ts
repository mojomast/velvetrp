import { z } from "zod";
import { recoverySchema } from "./content-catalog.js";
import { actorResourceSchema } from "./actor-resources.js";
import { effectDurationSchema, effectModifierSchema } from "./effects.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { diceRollResultSchema } from "./rpg-dice.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { powerReferenceSchema } from "./powers.js";

const boundedPowerCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** One exact base spell-slot resource. Slot availability here is capacity only. */
export const actorPowerSlotSchema = z.object({
  slotId: z.string().regex(/^slot-(?:[1-9]|1[0-9]|20)$/),
  level: z.number().int().min(1).max(20),
  current: boundedPowerCountSchema,
  max: boundedPowerCountSchema,
}).strict().superRefine((slot, context) => {
  if (slot.slotId !== `slot-${slot.level}`) context.addIssue({ code: "custom", message: "slot identity must match level", path: ["slotId"] });
  if (slot.current > slot.max) context.addIssue({ code: "custom", message: "slot current cannot exceed max", path: ["current"] });
});

/** Remaining finite ability uses derived from authoritative use and recovery history. */
export const actorPowerUseStateSchema = z.object({
  powerRef: powerReferenceSchema.refine((reference) => reference.kind === "ability"),
  current: boundedPowerCountSchema,
  max: z.number().int().min(1).max(100),
  recovery: recoverySchema,
}).strict().refine((state) => state.current <= state.max, { message: "ability uses cannot exceed max", path: ["current"] });

/**
 * Closed availability reasons for the server-owned resource projection.
 * This intentionally does not claim target, encounter-turn, range, action, or
 * effect legality; a future command still performs those authoritative checks.
 */
export const actorPowerAvailabilityReasonSchema = z.enum([
  "execution-pin-unavailable",
  "finite-uses-exhausted",
  "spell-slot-unavailable",
]);

export const actorPowerLegalNowSchema = z.object({
  powerRef: powerReferenceSchema,
  legal: z.boolean(),
  reasons: z.array(actorPowerAvailabilityReasonSchema).max(actorPowerAvailabilityReasonSchema.options.length),
}).strict().superRefine((entry, context) => {
  if (new Set(entry.reasons).size !== entry.reasons.length) context.addIssue({ code: "custom", message: "availability reasons must be unique", path: ["reasons"] });
  if (entry.legal !== (entry.reasons.length === 0)) context.addIssue({ code: "custom", message: "legal must exactly reflect resource availability reasons", path: ["legal"] });
});

export const actorPowerLegalTargetSchema = z.object({
  actorId: resourceIdSchema,
  label: z.string().trim().min(1).max(200).optional(),
}).strict();

/** A complete server-planned command preview; callers select only identities from this projection. */
export const actorPowerLegalCommandSchema = z.object({
  powerRef: powerReferenceSchema,
  targeting: z.enum(["self", "single", "area"]),
  validTargets: z.array(actorPowerLegalTargetSchema).max(128),
  costs: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ability-use"), amount: z.literal(1) }).strict(),
    z.object({ kind: z.literal("slot"), slotId: z.string().regex(/^slot-(?:[1-9])$/), amount: z.literal(1) }).strict(),
  ])).max(1),
  concentration: z.boolean(),
  effectKinds: z.array(z.enum(["damage", "healing", "resource", "modifier", "condition"])).min(1).max(5),
}).strict().superRefine((command, context) => {
  const ids = command.validTargets.map((target) => target.actorId);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && id <= ids[index - 1]!)) {
    context.addIssue({ code: "custom", message: "legal power targets must be unique and stably ordered", path: ["validTargets"] });
  }
  if (command.targeting === "self" ? ids.length !== 1 : ids.length === 0) {
    context.addIssue({ code: "custom", message: "legal power targets must match targeting cardinality", path: ["validTargets"] });
  }
  if (new Set(command.effectKinds).size !== command.effectKinds.length) {
    context.addIssue({ code: "custom", message: "effect kinds must be unique", path: ["effectKinds"] });
  }
});

const referenceKey = (reference: z.infer<typeof powerReferenceSchema>) =>
  `${reference.kind}\0${reference.packId}\0${reference.packVersion}\0${reference.definitionId}`;

/**
 * Current fixed starter projection. Every authoritative known power is
 * prepared; callers cannot select preparation. `legalNow` is deliberately
 * limited to exact execution pins and server-owned finite-use/slot capacity.
 */
export const actorPowersResponseSchema = z.object({
  known: z.array(powerReferenceSchema),
  prepared: z.array(powerReferenceSchema),
  slots: z.array(actorPowerSlotSchema).max(20),
  uses: z.array(actorPowerUseStateSchema),
  legalNow: z.array(actorPowerLegalNowSchema),
  legalCommands: z.array(actorPowerLegalCommandSchema),
  revision: revisionSchema,
}).strict().superRefine((response, context) => {
  const keys = response.known.map(referenceKey);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && key <= keys[index - 1]!)) {
    context.addIssue({ code: "custom", message: "known powers must be unique and stably ordered", path: ["known"] });
  }
  if (JSON.stringify(response.prepared) !== JSON.stringify(response.known)) {
    context.addIssue({ code: "custom", message: "fixed starter rules prepare every known power", path: ["prepared"] });
  }
  if (response.slots.some((slot, index) => index > 0 && slot.level <= response.slots[index - 1]!.level)) {
    context.addIssue({ code: "custom", message: "slots must be uniquely ordered by numeric level", path: ["slots"] });
  }
  const useKeys = response.uses.map((state) => referenceKey(state.powerRef));
  if (new Set(useKeys).size !== useKeys.length || useKeys.some((key, index) => index > 0 && key <= useKeys[index - 1]!)) {
    context.addIssue({ code: "custom", message: "finite uses must be unique and stably ordered", path: ["uses"] });
  }
  if (response.legalNow.length !== response.known.length
      || response.legalNow.some((entry, index) => referenceKey(entry.powerRef) !== keys[index])) {
    context.addIssue({ code: "custom", message: "legalNow must contain exactly one ordered entry per known power", path: ["legalNow"] });
  }
  const legalCommandKeys = response.legalCommands.map((entry) => referenceKey(entry.powerRef));
  if (new Set(legalCommandKeys).size !== legalCommandKeys.length
      || legalCommandKeys.some((key, index) => index > 0 && key <= legalCommandKeys[index - 1]!)
      || legalCommandKeys.some((key) => !keys.includes(key))) {
    context.addIssue({ code: "custom", message: "legalCommands must be unique, ordered known powers", path: ["legalCommands"] });
  }
});

export type ActorPowersResponse = z.infer<typeof actorPowersResponseSchema>;
export type ActorPowerAvailabilityReason = z.infer<typeof actorPowerAvailabilityReasonSchema>;

/** The starter catalog has no caller-selected activation choices. */
export const actorPowerChoicesSchema = z.tuple([]);
export const actorPowerCommandRequestSchema = z.object({
  powerRef: powerReferenceSchema,
  targetIds: z.array(resourceIdSchema).max(32).superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "target IDs must be unique" });
  }),
  choices: actorPowerChoicesSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

/** Costs are derived from the pinned definition, never accepted from a caller. */
export const actorPowerResolvedCostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ability-use"), amount: z.literal(1) }).strict(),
  z.object({ kind: z.literal("slot"), slotId: z.string().regex(/^slot-(?:[1-9])$/), amount: z.literal(1) }).strict(),
]);

export const actorPowerEffectOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("damage"), targetId: resourceIdSchema, damageType: z.enum(["physical", "fire", "frost", "storm", "radiant", "shadow"]), roll: diceRollResultSchema, adjustment: z.enum(["none", "resistance", "vulnerability", "immunity"]), applied: boundedPowerCountSchema }).strict(),
  z.object({ kind: z.literal("healing"), targetId: resourceIdSchema, roll: diceRollResultSchema, applied: boundedPowerCountSchema }).strict(),
  z.object({ kind: z.literal("resource"), targetId: resourceIdSchema, resourceId: resourceIdSchema, requested: z.number().int().min(-10_000).max(10_000), applied: z.number().int().min(-10_000).max(10_000) }).strict(),
  z.object({ kind: z.literal("modifier"), targetId: resourceIdSchema, effectId: resourceIdSchema.nullable(), statistic: resourceIdSchema, amount: z.number().int().min(-10_000).max(10_000), duration: z.enum(["instant", "turn", "round", "encounter", "permanent"]) }).strict(),
  z.object({ kind: z.literal("condition"), targetId: resourceIdSchema, effectId: resourceIdSchema, condition: resourceIdSchema, durationRounds: z.number().int().min(1).max(20) }).strict(),
]);

export const actorPowerStateDeltaSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resource"), actorId: resourceIdSchema, resourceId: resourceIdSchema, before: boundedPowerCountSchema, after: boundedPowerCountSchema }).strict(),
  z.object({ kind: z.literal("effect-applied"), actorId: resourceIdSchema, effectId: resourceIdSchema }).strict(),
  z.object({ kind: z.literal("effect-replaced"), actorId: resourceIdSchema, effectId: resourceIdSchema }).strict(),
]);

export const actorPowerResolutionSchema = z.object({
  powerUseId: resourceIdSchema,
  powerRef: powerReferenceSchema,
  targetIds: z.array(resourceIdSchema).max(32),
  costs: z.array(actorPowerResolvedCostSchema).max(1),
  outcomes: z.array(actorPowerEffectOutcomeSchema).max(512),
  stateDeltas: z.array(actorPowerStateDeltaSchema).max(512),
}).strict().superRefine((resolution, context) => {
  if (new Set(resolution.targetIds).size !== resolution.targetIds.length) {
    context.addIssue({ code: "custom", message: "resolved target IDs must be unique", path: ["targetIds"] });
  }
  resolution.outcomes.forEach((outcome, index) => {
    if (!resolution.targetIds.includes(outcome.targetId)) context.addIssue({ code: "custom", message: "outcome target must be resolved", path: ["outcomes", index, "targetId"] });
    if (outcome.kind === "damage" && outcome.applied > Math.max(0, outcome.roll.total) * 2) {
      context.addIssue({ code: "custom", message: "applied damage cannot exceed bounded vulnerability", path: ["outcomes", index, "applied"] });
    }
    if (outcome.kind === "healing" && outcome.applied > Math.max(0, outcome.roll.total)) {
      context.addIssue({ code: "custom", message: "applied healing cannot exceed the rolled amount", path: ["outcomes", index, "applied"] });
    }
    if (outcome.kind === "resource" && (Math.abs(outcome.applied) > Math.abs(outcome.requested)
      || (outcome.applied !== 0 && Math.sign(outcome.applied) !== Math.sign(outcome.requested)))) {
      context.addIssue({ code: "custom", message: "applied resource change must be a bounded part of the request", path: ["outcomes", index, "applied"] });
    }
  });
});

/** Public effect projection deliberately omits command and campaign provenance. */
export const actorPowerActiveEffectSummarySchema = z.object({
  effectId: resourceIdSchema,
  source: powerReferenceSchema,
  modifiers: z.array(effectModifierSchema).min(1).max(64),
  duration: effectDurationSchema,
  concentration: z.boolean(),
}).strict();
export const actorPowerActorStateSchema = z.object({
  actorId: resourceIdSchema,
  resources: z.array(actorResourceSchema).max(128).superRefine((resources, context) => {
    const ids=resources.map(resource=>resource.resourceId);
    if(new Set(ids).size!==ids.length||ids.some((id,index)=>index>0&&id<=ids[index-1]!))context.addIssue({code:"custom",message:"resources must be unique and stably ordered"});
  }),
  activeEffects: z.array(actorPowerActiveEffectSummarySchema).max(128),
  revision: revisionSchema,
}).strict();
export const actorPowerCommandReceiptSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1, "a power command advances exactly one source revision");
export const actorPowerCommandResponseSchema = z.object({
  resolution: actorPowerResolutionSchema,
  actorStates: z.array(actorPowerActorStateSchema).min(1).max(33),
  receipt: actorPowerCommandReceiptSchema,
}).strict().superRefine((response, context) => {
  const stateIds=response.actorStates.map(state=>state.actorId),selfTarget=response.resolution.targetIds.length===1&&response.resolution.targetIds[0]===stateIds[0];
  if(new Set(stateIds).size!==stateIds.length)context.addIssue({code:"custom",message:"actor states must be unique",path:["actorStates"]});
  if ((!selfTarget && (response.actorStates.length!==response.resolution.targetIds.length+1
      || response.resolution.targetIds.some((id,index)=>id!==stateIds[index+1])))
      || (selfTarget&&response.actorStates.length!==1)) {
    context.addIssue({ code: "custom", message: "changed actor states must follow source and target order", path: ["actorStates"] });
  }
  response.resolution.stateDeltas.forEach((delta,index)=>{
    if(!stateIds.includes(delta.actorId))context.addIssue({code:"custom",message:"state delta actor must have an authoritative projection",path:["resolution","stateDeltas",index,"actorId"]});
  });
});

export type ActorPowerCommandRequest = z.infer<typeof actorPowerCommandRequestSchema>;
export type ActorPowerCommandResponse = z.infer<typeof actorPowerCommandResponseSchema>;
export type ActorPowerResolution = z.infer<typeof actorPowerResolutionSchema>;
export type ActorPowerActorState = z.infer<typeof actorPowerActorStateSchema>;
