import { z } from "zod";
import { resourceIdSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";
import { diceRollResultSchema } from "./rpg-dice.js";

/** A deliberately small, non-executable description of a resolved check. */
export const checkKindSchema = z.enum(["ability", "skill", "save", "attack", "opposed"]);
export const checkOutcomeSchema = z.enum(["success", "failure", "critical_success", "critical_failure"]);
export const checkTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("difficulty_class"), value: z.number().int().min(1).max(10_000) }).strict(),
  z.object({ kind: z.literal("opposed_total"), actorId: actorIdSchema, value: z.number().int().min(-10_000).max(10_000) }).strict(),
]);

const checkTermValueSchema = z.number().int().min(-10_000).max(10_000);
export const checkTermSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("roll"), roll: diceRollResultSchema }).strict(),
  z.object({ kind: z.literal("flat"), sourceId: resourceIdSchema.nullable(), value: checkTermValueSchema }).strict(),
  z.object({ kind: z.literal("proficiency"), sourceId: resourceIdSchema, value: z.number().int().min(0).max(10_000) }).strict(),
]);

export const checkResolutionSchema = z.object({
  terms: z.array(checkTermSchema).min(1).max(64),
  total: checkTermValueSchema,
  target: checkTargetSchema,
  outcome: checkOutcomeSchema,
}).strict().superRefine((resolution, context) => {
  const computedTotal = resolution.terms.reduce((sum, term) => sum + (term.kind === "roll" ? term.roll.total : term.value), 0);
  if (resolution.total !== computedTotal) {
    context.addIssue({ code: "custom", message: "total must equal the structured terms", path: ["total"] });
  }
});

const checkCommandBase = {
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
};

export const abilityCheckCommandSchema = z.object({ ...checkCommandBase, kind: z.literal("ability"), abilityId: resourceIdSchema }).strict();
export const skillCheckCommandSchema = z.object({ ...checkCommandBase, kind: z.literal("skill"), skillId: resourceIdSchema }).strict();
export const saveCheckCommandSchema = z.object({ ...checkCommandBase, kind: z.literal("save"), abilityId: resourceIdSchema }).strict();
export const attackCheckCommandSchema = z.object({ ...checkCommandBase, kind: z.literal("attack"), attackId: resourceIdSchema, targetActorId: actorIdSchema.optional() }).strict();
export const opposedCheckCommandSchema = z.object({ ...checkCommandBase, kind: z.literal("opposed"), opponentActorId: actorIdSchema }).strict();

/** Closed mutation boundary; it intentionally contains no formulas or scripts. */
export const checkCommandSchema = z.discriminatedUnion("kind", [
  abilityCheckCommandSchema, skillCheckCommandSchema, saveCheckCommandSchema, attackCheckCommandSchema, opposedCheckCommandSchema,
]);

export type CheckKind = z.infer<typeof checkKindSchema>;
export type CheckOutcome = z.infer<typeof checkOutcomeSchema>;
export type CheckTarget = z.infer<typeof checkTargetSchema>;
export type CheckTerm = z.infer<typeof checkTermSchema>;
export type CheckResolution = z.infer<typeof checkResolutionSchema>;
export type AbilityCheckCommand = z.infer<typeof abilityCheckCommandSchema>;
export type SkillCheckCommand = z.infer<typeof skillCheckCommandSchema>;
export type SaveCheckCommand = z.infer<typeof saveCheckCommandSchema>;
export type AttackCheckCommand = z.infer<typeof attackCheckCommandSchema>;
export type OpposedCheckCommand = z.infer<typeof opposedCheckCommandSchema>;
export type CheckCommand = z.infer<typeof checkCommandSchema>;
