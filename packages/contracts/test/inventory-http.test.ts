import { describe, expect, it } from "vitest";
import {
  inventoryHttpCommandReceiptSchema,
  inventoryHttpCommandRequestSchema,
  inventoryHttpCommandResponseSchema,
  inventoryHttpGetResponseSchema,
} from "../src/inventory-http.js";

const item = { packId: "pack", packVersion: "1", definitionId: "rope", kind: "item" } as const;
const inventory = {
  entries: [{ kind: "stackable" as const, entryId: "rope-stack", item, quantity: 2 }],
  equipment: [], capacity: 5, revision: 4,
};

describe("inventory HTTP contracts", () => {
  it("returns a strict public inventory projection with its revision", () => {
    expect(inventoryHttpGetResponseSchema.parse(inventory)).toEqual(inventory);
    expect(inventoryHttpGetResponseSchema.safeParse({ ...inventory, actorId: "private" }).success).toBe(false);
    expect(inventoryHttpGetResponseSchema.safeParse({ ...inventory, equipment: [{ slot: "hand", entryId: "missing" }] }).success).toBe(false);
  });

  it("accepts only strict route-safe inventory command variants", () => {
    const base = { expectedRevision: 4, idempotencyKey: "inventory-command-1" };
    const requests = [
      { kind: "equip", slot: "hand", entryId: "rope-stack", ...base },
      { kind: "unequip", slot: "hand", ...base },
      { kind: "consume", entryId: "rope-stack", item, quantity: 1, ...base },
      { kind: "drop", entryId: "rope-stack", item, quantity: 1, ...base },
      { kind: "gift", recipientActorId: "recipient", entryId: "rope-stack", item, quantity: 1, ...base },
    ] as const;
    for (const request of requests) expect(inventoryHttpCommandRequestSchema.parse(request)).toEqual(request);
    expect(inventoryHttpCommandRequestSchema.safeParse({ ...requests[0], actorId: "private" }).success).toBe(false);
    expect(inventoryHttpCommandRequestSchema.safeParse({ ...requests[2], quantity: 0 }).success).toBe(false);
    expect(inventoryHttpCommandRequestSchema.safeParse({ ...base, kind: "transfer" }).success).toBe(false);
  });

  it("returns public, revision-advancing receipts", () => {
    const receipt = {
      kind: "gift" as const, recipientActorId: "recipient", entryId: "rope-stack", item, quantity: 1,
      idempotencyKey: "inventory-command-1", revisionBefore: 4, revisionAfter: 5,
      occurredAt: "2030-01-01T00:00:00.000Z",
    };
    expect(inventoryHttpCommandReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(inventoryHttpCommandReceiptSchema.safeParse({ ...receipt, campaignId: "private" }).success).toBe(false);
    expect(inventoryHttpCommandReceiptSchema.safeParse({ ...receipt, actorId: "private" }).success).toBe(false);
    expect(inventoryHttpCommandReceiptSchema.safeParse({ ...receipt, commandId: "private" }).success).toBe(false);
    expect(inventoryHttpCommandReceiptSchema.safeParse({ ...receipt, revisionAfter: 6 }).success).toBe(false);
    expect(inventoryHttpCommandResponseSchema.parse({ inventory, receipt })).toEqual({ inventory, receipt });
  });
});
