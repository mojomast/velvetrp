import { describe, expect, it } from "vitest";
import { actorInventorySchema, inventoryCommandSchema, inventoryItemSchema, inventorySchema } from "../src/inventory.js";

const item = { packId: "pack", packVersion: "1", definitionId: "rope", kind: "item" } as const;

describe("M1.5 inventory contracts", () => {
  it("distinguishes stackable and instanced catalog items", () => {
    expect(inventoryItemSchema.safeParse({ kind: "stackable", entryId: "rope-stack", item, quantity: 2 }).success).toBe(true);
    expect(inventoryItemSchema.safeParse({ kind: "instanced", entryId: "sword-1", item }).success).toBe(true);
    expect(inventoryItemSchema.safeParse({ kind: "instanced", entryId: "sword-1", item, quantity: 1 }).success).toBe(false);
  });

  it("enforces bounded entries and equipment ownership", () => {
    const inventory = { capacity: 1, items: [{ kind: "instanced", entryId: "sword-1", item }] } as const;
    expect(inventorySchema.parse(inventory)).toEqual(inventory);
    expect(inventorySchema.safeParse({ ...inventory, capacity: 0 }).success).toBe(false);
    expect(actorInventorySchema.safeParse({ campaignId: "campaign", actorId: "actor", inventory, equipment: [{ slot: "hand", entryId: "missing" }] }).success).toBe(false);
  });

  it("supports strict, bounded consume, drop, and transfer commands", () => {
    const base = { campaignId: "campaign", actorId: "actor", expectedRevision: 1, idempotencyKey: "inventory-1", entryId: "rope-stack", item, quantity: 1 };
    expect(inventoryCommandSchema.safeParse({ ...base, type: "consume_inventory_item" }).success).toBe(true);
    expect(inventoryCommandSchema.safeParse({ ...base, type: "drop_inventory_item" }).success).toBe(true);
    expect(inventoryCommandSchema.safeParse({ ...base, type: "transfer_inventory_item", recipientActorId: "recipient" }).success).toBe(true);
    expect(inventoryCommandSchema.safeParse({ ...base, type: "consume_inventory_item", quantity: 0 }).success).toBe(false);
    expect(inventoryCommandSchema.safeParse({ ...base, type: "transfer_inventory_item", recipientActorId: "actor" }).success).toBe(false);
    expect(inventoryCommandSchema.safeParse({ ...base, type: "drop_inventory_item", extra: true }).success).toBe(false);
  });

  it("rejects unknown inventory command variants", () => {
    expect(inventoryCommandSchema.safeParse({ type: "destroy_inventory_item", campaignId: "campaign", actorId: "actor", expectedRevision: 1, idempotencyKey: "inventory-1" }).success).toBe(false);
  });
});
