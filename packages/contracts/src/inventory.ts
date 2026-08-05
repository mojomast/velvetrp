import { z } from "zod";
import { equipmentSlotSchema, itemCatalogReferenceSchema } from "./content-catalog.js";
import { resourceIdSchema } from "./domain-primitives.js";
import { expectedRevisionSchema, idempotencyKeySchema } from "./rpg-commands.js";
import { actorIdSchema, campaignIdSchema } from "./rpg-characters.js";

export const inventoryEntryIdSchema = resourceIdSchema;
export const inventoryQuantitySchema = z.number().int().min(1).max(1_000_000);
export const inventoryCapacitySchema = z.number().int().min(0).max(1_000);

/**
 * The immutable identity of an inventory row.  Catalog identity describes what
 * an item is; entry identity describes the particular possession being moved.
 */
export const inventoryEntryReferenceSchema = z.object({
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
}).strict();

/** Stackable entries represent fungible copies of exactly one catalog item. */
export const stackableInventoryItemSchema = z.object({
  kind: z.literal("stackable"),
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
}).strict();

/** Instanced entries retain their own identity and cannot be merged. */
export const instancedInventoryItemSchema = z.object({
  kind: z.literal("instanced"),
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
}).strict();

export const inventoryItemSchema = z.discriminatedUnion("kind", [stackableInventoryItemSchema, instancedInventoryItemSchema]);

export const inventorySchema = z.object({
  capacity: inventoryCapacitySchema,
  items: z.array(inventoryItemSchema).max(1_000),
}).strict().superRefine((inventory, context) => {
  if (inventory.items.length > inventory.capacity) context.addIssue({ code: "custom", message: "inventory entries exceed capacity", path: ["items"] });
  const ids = new Set<string>();
  inventory.items.forEach((item, index) => {
    if (ids.has(item.entryId)) context.addIssue({ code: "custom", message: "inventory entry IDs must be unique", path: ["items", index, "entryId"] });
    ids.add(item.entryId);
  });
});

export const equippedItemSchema = z.object({
  slot: equipmentSlotSchema,
  entryId: inventoryEntryIdSchema,
}).strict();
export const equipmentSchema = z.array(equippedItemSchema).max(equipmentSlotSchema.options.length).superRefine((equipment, context) => {
  const slots = new Set<string>();
  const entries = new Set<string>();
  equipment.forEach((item, index) => {
    if (slots.has(item.slot)) context.addIssue({ code: "custom", message: "equipment slots must be unique", path: [index, "slot"] });
    if (entries.has(item.entryId)) context.addIssue({ code: "custom", message: "equipped entries must be unique", path: [index, "entryId"] });
    slots.add(item.slot); entries.add(item.entryId);
  });
});

export const actorInventorySchema = z.object({
  campaignId: campaignIdSchema,
  actorId: actorIdSchema,
  inventory: inventorySchema,
  equipment: equipmentSchema,
}).strict().superRefine((value, context) => {
  const inventoryIds = new Set(value.inventory.items.map((item) => item.entryId));
  value.equipment.forEach((item, index) => {
    if (!inventoryIds.has(item.entryId)) context.addIssue({ code: "custom", message: "equipped entry must be in inventory", path: ["equipment", index, "entryId"] });
  });
});

const inventoryCommandBase = { campaignId: campaignIdSchema, actorId: actorIdSchema, expectedRevision: expectedRevisionSchema, idempotencyKey: idempotencyKeySchema };
export const addInventoryItemCommandSchema = z.object({ ...inventoryCommandBase, type: z.literal("add_inventory_item"), item: inventoryItemSchema }).strict();
export const removeInventoryItemCommandSchema = z.object({ ...inventoryCommandBase, type: z.literal("remove_inventory_item"), entryId: inventoryEntryIdSchema, quantity: inventoryQuantitySchema.optional() }).strict();
export const consumeInventoryItemCommandSchema = z.object({
  ...inventoryCommandBase,
  type: z.literal("consume_inventory_item"),
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
}).strict();
export const dropInventoryItemCommandSchema = z.object({
  ...inventoryCommandBase,
  type: z.literal("drop_inventory_item"),
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
}).strict();
export const transferInventoryItemCommandSchema = z.object({
  ...inventoryCommandBase,
  type: z.literal("transfer_inventory_item"),
  recipientActorId: actorIdSchema,
  entryId: inventoryEntryIdSchema,
  item: itemCatalogReferenceSchema,
  quantity: inventoryQuantitySchema,
}).strict().refine((command) => command.actorId !== command.recipientActorId, {
  message: "transfer parties must differ", path: ["recipientActorId"],
});
export const equipInventoryItemCommandSchema = z.object({ ...inventoryCommandBase, type: z.literal("equip_inventory_item"), slot: equipmentSlotSchema, entryId: inventoryEntryIdSchema }).strict();
export const unequipInventoryItemCommandSchema = z.object({ ...inventoryCommandBase, type: z.literal("unequip_inventory_item"), slot: equipmentSlotSchema }).strict();
export const setInventoryCapacityCommandSchema = z.object({ ...inventoryCommandBase, type: z.literal("set_inventory_capacity"), capacity: inventoryCapacitySchema }).strict();
export const inventoryCommandSchema = z.discriminatedUnion("type", [addInventoryItemCommandSchema, removeInventoryItemCommandSchema, consumeInventoryItemCommandSchema, dropInventoryItemCommandSchema, transferInventoryItemCommandSchema, equipInventoryItemCommandSchema, unequipInventoryItemCommandSchema, setInventoryCapacityCommandSchema]);

export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export type InventoryEntryReference = z.infer<typeof inventoryEntryReferenceSchema>;
export type Inventory = z.infer<typeof inventorySchema>;
export type Equipment = z.infer<typeof equipmentSchema>;
export type ActorInventory = z.infer<typeof actorInventorySchema>;
export type ConsumeInventoryItemCommand = z.infer<typeof consumeInventoryItemCommandSchema>;
export type DropInventoryItemCommand = z.infer<typeof dropInventoryItemCommandSchema>;
export type TransferInventoryItemCommand = z.infer<typeof transferInventoryItemCommandSchema>;
export type InventoryCommand = z.infer<typeof inventoryCommandSchema>;
