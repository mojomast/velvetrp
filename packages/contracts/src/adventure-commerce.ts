import { z } from "zod";
import { canonicalSha256DigestSchema } from "./agent-execution.js";
import { currencyMinorUnitSchema } from "./economy.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { inventoryQuantitySchema } from "./inventory.js";
import { revisionSchema } from "./rpg-commands.js";

export const adventureCommerceActionSchema = z.enum(["buy", "sell", "give"]);
export const adventureCommerceCandidateSchema = z.object({
  candidateId: resourceIdSchema, digest: canonicalSha256DigestSchema, action: adventureCommerceActionSchema,
  vendorLabel: z.string().trim().min(1).max(200), shopLabel: z.string().trim().min(1).max(200),
  itemLabel: z.string().trim().min(1).max(200), quantity: inventoryQuantitySchema,
  currencyLabel: z.string().trim().min(1).max(200), priceMinorUnits: currencyMinorUnitSchema,
  consequence: z.string().trim().min(1).max(500), confirmationRequired: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.action === "give" && value.priceMinorUnits !== 0) context.addIssue({ code: "custom", path: ["priceMinorUnits"], message: "vendor gifts must be free" });
  if (value.action !== "give" && value.priceMinorUnits === 0) context.addIssue({ code: "custom", path: ["priceMinorUnits"], message: "buying and selling require a positive price" });
});
export const adventureCommerceSelectionSchema = z.object({ candidateId: resourceIdSchema, digest: canonicalSha256DigestSchema }).strict();
export const adventureCommercePublicReceiptSchema = z.object({
  action: adventureCommerceActionSchema, vendorLabel: z.string().trim().min(1).max(200), shopLabel: z.string().trim().min(1).max(200),
  itemLabel: z.string().trim().min(1).max(200), quantity: inventoryQuantitySchema,
  currencyLabel: z.string().trim().min(1).max(200), priceMinorUnits: currencyMinorUnitSchema,
  debitMinorUnits: currencyMinorUnitSchema, creditMinorUnits: currencyMinorUnitSchema,
  balanceBefore: currencyMinorUnitSchema, balanceAfter: currencyMinorUnitSchema,
  revisionBefore: revisionSchema, revisionAfter: revisionSchema, occurredAt: utcIsoTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.action === "buy" && (value.debitMinorUnits !== value.priceMinorUnits || value.creditMinorUnits !== 0 || value.balanceAfter !== value.balanceBefore - value.priceMinorUnits)) context.addIssue({ code: "custom", message: "buy receipt balance is inconsistent" });
  if (value.action !== "buy" && (value.debitMinorUnits !== 0 || value.creditMinorUnits !== value.priceMinorUnits || value.balanceAfter !== value.balanceBefore + value.priceMinorUnits)) context.addIssue({ code: "custom", message: "vendor transfer receipt balance is inconsistent" });
  if (value.revisionAfter !== value.revisionBefore + 1) context.addIssue({ code: "custom", path: ["revisionAfter"], message: "commerce revision must advance once" });
});

export type AdventureCommerceCandidate = z.infer<typeof adventureCommerceCandidateSchema>;
export type AdventureCommercePublicReceipt = z.infer<typeof adventureCommercePublicReceiptSchema>;
