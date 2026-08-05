import { z } from "zod";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";
import { abilityCatalogReferenceSchema, spellCatalogReferenceSchema } from "./content-catalog.js";

/** A power is an exact, campaign-pinned ability or spell; there is no `power` catalog kind. */
export const powerReferenceSchema = z.discriminatedUnion("kind", [abilityCatalogReferenceSchema, spellCatalogReferenceSchema]);
export const powerCostAmountSchema = z.number().int().min(1).max(1_000_000);

/** Costs name state to spend; they do not embed resource arithmetic or formulas. */
export const powerCostSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resource"), resourceId: resourceIdSchema, amount: powerCostAmountSchema }).strict(),
  z.object({ kind: z.literal("slot"), slotId: resourceIdSchema, amount: powerCostAmountSchema }).strict(),
  z.object({ kind: z.literal("charge"), chargeId: resourceIdSchema, amount: powerCostAmountSchema }).strict(),
]);

export const powerUseCommandSchema = z.object({
  type: z.literal("use_power"),
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  power: powerReferenceSchema,
  targetActorId: actorIdSchema.nullable(),
  costs: z.array(powerCostSchema).max(32),
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
  usedAt: utcIsoTimestampSchema,
}).strict().superRefine((command, context) => {
  const bindings = new Set<string>();
  command.costs.forEach((cost, index) => {
    const id = cost.kind === "resource" ? cost.resourceId : cost.kind === "slot" ? cost.slotId : cost.chargeId;
    const key = `${cost.kind}:${id}`;
    if (bindings.has(key)) context.addIssue({ code: "custom", message: "power costs must not repeat a binding", path: ["costs", index] });
    bindings.add(key);
  });
});

export type PowerCost = z.infer<typeof powerCostSchema>;
export type PowerReference = z.infer<typeof powerReferenceSchema>;
export type PowerUseCommand = z.infer<typeof powerUseCommandSchema>;
