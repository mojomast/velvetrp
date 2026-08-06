import { z } from "zod";
import { utcIsoTimestampSchema } from "./domain-primitives.js";
import {
  equipmentSchema,
  inventoryCapacitySchema,
  inventoryEntryIdSchema,
  inventoryItemSchema,
  inventoryQuantitySchema,
} from "./inventory.js";
import { equipmentSlotSchema, itemCatalogReferenceSchema } from "./content-catalog.js";
import { expectedRevisionSchema, idempotencyKeySchema, revisionSchema } from "./rpg-commands.js";
import { actorIdSchema } from "./rpg-characters.js";

/** Route-owned inventory state omits the campaign and actor identities. */
export const inventoryHttpGetResponseSchema = z.object({
  entries: z.array(inventoryItemSchema).max(1_000),
  equipment: equipmentSchema,
  capacity: inventoryCapacitySchema,
  revision: revisionSchema,
}).strict().superRefine((inventory, context) => {
  if (inventory.entries.length > inventory.capacity) {
    context.addIssue({ code: "custom", message: "inventory entries exceed capacity", path: ["entries"] });
  }
  const entryIds = new Set<string>();
  inventory.entries.forEach((entry, index) => {
    if (entryIds.has(entry.entryId)) {
      context.addIssue({ code: "custom", message: "inventory entry IDs must be unique", path: ["entries", index, "entryId"] });
    }
    entryIds.add(entry.entryId);
  });
  inventory.equipment.forEach((item, index) => {
    if (!entryIds.has(item.entryId)) {
      context.addIssue({ code: "custom", message: "equipped entry must be in inventory", path: ["equipment", index, "entryId"] });
    }
  });
});

const commandBase = {
  expectedRevision: expectedRevisionSchema,
  idempotencyKey: idempotencyKeySchema,
};

export const inventoryHttpEquipCommandRequestSchema = z.object({
  kind: z.literal("equip"),
  slot: equipmentSlotSchema,
  entryId: inventoryEntryIdSchema,
  ...commandBase,
}).strict();
export const inventoryHttpUnequipCommandRequestSchema = z.object({
  kind: z.literal("unequip"),
  slot: equipmentSlotSchema,
  ...commandBase,
}).strict();
export const inventoryHttpConsumeCommandRequestSchema = z.object({
  kind: z.literal("consume"),
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
  ...commandBase,
}).strict();
export const inventoryHttpDropCommandRequestSchema = z.object({
  kind: z.literal("drop"),
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
  ...commandBase,
}).strict();
export const inventoryHttpGiftCommandRequestSchema = z.object({
  kind: z.literal("gift"),
  recipientActorId: actorIdSchema,
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
  ...commandBase,
}).strict();

/** Commands are route-safe: source actor and campaign identities come from the route. */
export const inventoryHttpCommandRequestSchema = z.discriminatedUnion("kind", [
  inventoryHttpEquipCommandRequestSchema,
  inventoryHttpUnequipCommandRequestSchema,
  inventoryHttpConsumeCommandRequestSchema,
  inventoryHttpDropCommandRequestSchema,
  inventoryHttpGiftCommandRequestSchema,
]);

const receiptBase = {
  idempotencyKey: idempotencyKeySchema,
  revisionBefore: revisionSchema,
  revisionAfter: revisionSchema,
  occurredAt: utcIsoTimestampSchema,
};
const receiptRevision = (receipt: { revisionBefore: number; revisionAfter: number }) => receipt.revisionAfter === receipt.revisionBefore + 1;

export const inventoryHttpEquipCommandReceiptSchema = z.object({
  kind: z.literal("equip"),
  slot: equipmentSlotSchema,
  entryId: inventoryEntryIdSchema,
  ...receiptBase,
}).strict().refine(receiptRevision, "inventory command advances exactly one revision");
export const inventoryHttpUnequipCommandReceiptSchema = z.object({
  kind: z.literal("unequip"),
  slot: equipmentSlotSchema,
  ...receiptBase,
}).strict().refine(receiptRevision, "inventory command advances exactly one revision");
export const inventoryHttpConsumeCommandReceiptSchema = z.object({
  kind: z.literal("consume"),
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
  ...receiptBase,
}).strict().refine(receiptRevision, "inventory command advances exactly one revision");
export const inventoryHttpDropCommandReceiptSchema = z.object({
  kind: z.literal("drop"),
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
  ...receiptBase,
}).strict().refine(receiptRevision, "inventory command advances exactly one revision");
export const inventoryHttpGiftCommandReceiptSchema = z.object({
  kind: z.literal("gift"),
  recipientActorId: actorIdSchema,
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
  ...receiptBase,
}).strict().refine(receiptRevision, "inventory command advances exactly one revision");

/** Receipts retain public command proof without command, campaign, or source actor IDs. */
export const inventoryHttpCommandReceiptSchema = z.discriminatedUnion("kind", [
  inventoryHttpEquipCommandReceiptSchema,
  inventoryHttpUnequipCommandReceiptSchema,
  inventoryHttpConsumeCommandReceiptSchema,
  inventoryHttpDropCommandReceiptSchema,
  inventoryHttpGiftCommandReceiptSchema,
]);
export const inventoryHttpCommandResponseSchema = z.object({
  inventory: inventoryHttpGetResponseSchema,
  receipt: inventoryHttpCommandReceiptSchema,
}).strict();

export type InventoryHttpGetResponse = z.infer<typeof inventoryHttpGetResponseSchema>;
export type InventoryHttpCommandRequest = z.infer<typeof inventoryHttpCommandRequestSchema>;
export type InventoryHttpCommandReceipt = z.infer<typeof inventoryHttpCommandReceiptSchema>;
export type InventoryHttpCommandResponse = z.infer<typeof inventoryHttpCommandResponseSchema>;
