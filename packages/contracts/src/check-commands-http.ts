import { z } from "zod";
import { checkOutcomeSchema, checkTargetSchema, checkTermSchema } from "./checks.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";

/** Public names only. The corresponding numeric difficulty class is server-owned. */
export const checkDifficultyRefSchema = z.enum(["easy", "standard", "hard", "very-hard"]);

const requestBase = {
  skillOrAttribute: resourceIdSchema,
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
};

/** Route parameters own the actor identity; the repository derives its campaign. */
export const actorCheckCommandRequestSchema = z.discriminatedUnion("kind", [
  z.object({ ...requestBase, kind: z.literal("ability"), difficultyRef: checkDifficultyRefSchema.optional() }).strict(),
  z.object({ ...requestBase, kind: z.literal("skill"), difficultyRef: checkDifficultyRefSchema.optional() }).strict(),
  z.object({ ...requestBase, kind: z.literal("save"), difficultyRef: checkDifficultyRefSchema.optional() }).strict(),
  z.object({ ...requestBase, kind: z.literal("attack"), targetActorId: resourceIdSchema.optional(), difficultyRef: checkDifficultyRefSchema.optional() }).strict(),
  z.object({ ...requestBase, kind: z.literal("opposed"), targetActorId: resourceIdSchema }).strict(),
]);

export const actorCheckHttpResultSchema = z.object({
  terms: z.array(checkTermSchema).min(1).max(64),
  modifier: z.number().int().min(-10_000).max(10_000),
  total: z.number().int().min(-10_000).max(10_000),
  target: checkTargetSchema,
  outcome: checkOutcomeSchema,
}).strict().superRefine((check, context) => {
  const modifier = check.terms.reduce((sum, term) => sum + (term.kind === "roll" ? 0 : term.value), 0);
  const rollTotal = check.terms.reduce((sum, term) => sum + (term.kind === "roll" ? term.roll.total : 0), 0);
  if (check.modifier !== modifier) {
    context.addIssue({ code: "custom", message: "modifier must equal the non-roll terms", path: ["modifier"] });
  }
  if (check.total !== rollTotal + modifier) {
    context.addIssue({ code: "custom", message: "total must equal the roll and modifier terms", path: ["total"] });
  }
});

export const actorCheckHttpReceiptSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict().refine((receipt) => receipt.revisionAfter === receipt.revisionBefore + 1,
  "a check advances exactly one revision");

export const actorCheckCommandResponseSchema = z.object({
  check: actorCheckHttpResultSchema,
  receipt: actorCheckHttpReceiptSchema,
}).strict();

export type CheckDifficultyRef = z.infer<typeof checkDifficultyRefSchema>;
export type ActorCheckCommandRequest = z.infer<typeof actorCheckCommandRequestSchema>;
export type ActorCheckCommandResponse = z.infer<typeof actorCheckCommandResponseSchema>;
