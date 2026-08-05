import { describe, expect, it } from "vitest";
import {
  actorResourceAmmunitionProjectionSchema,
  actorResourceBindingProjectionSchema,
  actorResourceChargesProjectionSchema,
  actorResourceCommandSchema,
  actorResourceSchema,
  actorResourcesSchema,
} from "../src/actor-resources.js";

describe("M1.5 actor-resource contracts", () => {
  it("accepts bounded resources and rejects duplicate or over-capacity state", () => {
    expect(actorResourceSchema.safeParse({ resourceId: "focus", current: 2, capacity: 3 }).success).toBe(true);
    expect(actorResourceSchema.safeParse({ resourceId: "focus", current: 4, capacity: 3 }).success).toBe(false);
    expect(actorResourcesSchema.safeParse([{ resourceId: "focus", current: 1, capacity: 3 }, { resourceId: "focus", current: 2, capacity: 3 }]).success).toBe(false);
  });

  it("has a closed, revisioned, idempotent resource command union", () => {
    const command = { type: "change_actor_resource", campaignId: "campaign", actorId: "actor", expectedRevision: 2, idempotencyKey: "resource-1", resourceId: "focus", amount: -1 };
    expect(actorResourceCommandSchema.parse(command)).toEqual(command);
    expect(actorResourceCommandSchema.safeParse({ ...command, amount: 0 }).success).toBe(false);
    expect(actorResourceCommandSchema.safeParse({ ...command, extra: true }).success).toBe(false);
  });

  it("supports strict bounded charges and ammunition commands and projections", () => {
    const base = { campaignId: "campaign", actorId: "actor", expectedRevision: 2, idempotencyKey: "resource-2", resourceId: "wand", current: 2, capacity: 3 };
    expect(actorResourceCommandSchema.safeParse({ ...base, type: "set_actor_resource_charges" }).success).toBe(true);
    expect(actorResourceCommandSchema.safeParse({ ...base, type: "set_actor_resource_ammunition" }).success).toBe(true);
    expect(actorResourceCommandSchema.safeParse({ ...base, type: "set_actor_resource_charges", current: 4 }).success).toBe(false);
    expect(actorResourceCommandSchema.safeParse({ ...base, type: "set_actor_resource_ammunition", current: -1 }).success).toBe(false);
    expect(actorResourceChargesProjectionSchema.safeParse({ campaignId: "campaign", actorId: "actor", resourceId: "wand", charges: { current: 2, capacity: 3 } }).success).toBe(true);
    expect(actorResourceAmmunitionProjectionSchema.safeParse({ campaignId: "campaign", actorId: "actor", resourceId: "arrows", ammunition: { current: 4, capacity: 3 } }).success).toBe(false);
  });

  it("allows only bounded closed binding sidecars", () => {
    const command = { type: "set_actor_resource_binding", campaignId: "campaign", actorId: "actor", expectedRevision: 2, idempotencyKey: "resource-3", resourceId: "wand", binding: { kind: "item", recovery: "long-rest" } };
    expect(actorResourceCommandSchema.parse(command)).toEqual(command);
    expect(actorResourceBindingProjectionSchema.safeParse({ campaignId: "campaign", actorId: "actor", resourceId: "wand", binding: command.binding }).success).toBe(true);
    expect(actorResourceCommandSchema.safeParse({ ...command, binding: { kind: "script", recovery: "long-rest" } }).success).toBe(false);
    expect(actorResourceCommandSchema.safeParse({ ...command, binding: { kind: "item", recovery: "long-rest", code: "run()" } }).success).toBe(false);
    expect(actorResourceCommandSchema.safeParse({ ...command, extra: true }).success).toBe(false);
  });

  it("rejects unknown actor-resource command types", () => {
    expect(actorResourceCommandSchema.safeParse({ type: "run_actor_resource", campaignId: "campaign", actorId: "actor", expectedRevision: 2, idempotencyKey: "resource-4", resourceId: "wand" }).success).toBe(false);
  });
});
