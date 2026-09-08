import { z } from "zod";
import { canonicalSha256DigestSchema } from "./agent-execution.js";
import { equipmentSlotSchema } from "./content-catalog.js";
import { resourceIdSchema, utcIsoTimestampSchema } from "./domain-primitives.js";
import { inventoryQuantitySchema } from "./inventory.js";
import { revisionSchema } from "./rpg-commands.js";

export const adventureInventoryActionSchema = z.enum(["equip", "unequip", "drop", "gift", "consume"]);

/** Provider-visible exact option. IDs needed by the command remain server-private. */
export const adventureInventoryCandidateSchema = z.object({
  candidateId: resourceIdSchema,
  digest: canonicalSha256DigestSchema,
  itemLabel: z.string().trim().min(1).max(200),
  action: adventureInventoryActionSchema,
  quantity: inventoryQuantitySchema,
  slot: equipmentSlotSchema.nullable(),
  recipient: z.string().trim().min(1).max(200).nullable(),
  confirmationRequired: z.boolean(),
  effect: z.enum(["inventory-only", "none"]),
}).strict().superRefine((value, context) => {
  if ((value.action === "equip" || value.action === "unequip") !== (value.slot !== null)) {
    context.addIssue({ code: "custom", path: ["slot"], message: "equipment actions require exactly one slot" });
  }
  if ((value.action === "gift") !== (value.recipient !== null)) {
    context.addIssue({ code: "custom", path: ["recipient"], message: "gift requires exactly one recipient" });
  }
  if (value.confirmationRequired !== ["drop", "gift", "consume"].includes(value.action)) {
    context.addIssue({ code: "custom", path: ["confirmationRequired"], message: "confirmation policy must match action" });
  }
  if (value.effect !== (value.action === "consume" ? "none" : "inventory-only")) {
    context.addIssue({ code: "custom", path: ["effect"], message: "consume is explicitly non-effectful" });
  }
});

/** The provider can select only one opaque server candidate and its digest. */
export const adventureInventorySelectionSchema = z.object({
  candidateId: resourceIdSchema,
  digest: canonicalSha256DigestSchema,
}).strict();

export const adventureInventoryPublicReceiptSchema = z.object({
  itemLabel: z.string().trim().min(1).max(200),
  action: adventureInventoryActionSchema,
  quantity: inventoryQuantitySchema,
  slot: equipmentSlotSchema.nullable(),
  recipient: z.string().trim().min(1).max(200).nullable(),
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
}).strict().refine((value) => value.revisionAfter === value.revisionBefore + 1,
  "inventory receipt revision must advance once");

export type AdventureInventoryCandidate = z.infer<typeof adventureInventoryCandidateSchema>;
export type AdventureInventorySelection = z.infer<typeof adventureInventorySelectionSchema>;
export type AdventureInventoryPublicReceipt = z.infer<typeof adventureInventoryPublicReceiptSchema>;
