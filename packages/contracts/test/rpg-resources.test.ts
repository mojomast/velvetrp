import { describe, expect, expectTypeOf, it } from "vitest";
import {
  actorResourceAmountSchema,
  actorResourceNameSchema,
  actorResourceSchema,
  actorResourceStateSchema,
  type ActorResource,
  type ActorResourceState,
} from "../src/index.js";

const state = { name: "HP.current", current: 7, max: 12 } as const;
const resource = { campaignId: "campaign-one", actorId: "actor-one", ...state } as const;

const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

describe("v13 RPG actor-resource contracts", () => {
  it("uses exact case-sensitive untrimmed safe technical resource names", () => {
    for (const valid of ["a", "HP", "hp", "spell-slot:level_1", "x".repeat(128)]) {
      expect(actorResourceNameSchema.parse(valid)).toBe(valid);
    }
    expect(actorResourceNameSchema.parse("HP")).not.toBe(actorResourceNameSchema.parse("hp"));
    for (const invalid of ["", " hp", "hp ", "two words", "has/slash", "line\nbreak", "x".repeat(129)]) {
      expect(actorResourceNameSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("accepts only integer amounts from zero through one million", () => {
    for (const valid of [0, 1, 1_000_000]) {
      expect(actorResourceAmountSchema.parse(valid)).toBe(valid);
    }
    for (const invalid of [-1, 0.5, 1_000_001, Number.POSITIVE_INFINITY]) {
      expect(actorResourceAmountSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("defines strict state and permits the empty zero-capacity resource", () => {
    expect(actorResourceStateSchema.parse(state)).toEqual(state);
    expect(actorResourceStateSchema.parse({ name: "empty", current: 0, max: 0 })).toEqual({
      name: "empty", current: 0, max: 0,
    });
    for (const field of ["name", "current", "max"] as const) {
      expect(actorResourceStateSchema.safeParse(without(state, field)).success).toBe(false);
    }
    expect(actorResourceStateSchema.safeParse({ ...state, current: 13 }).success).toBe(false);
    expect(actorResourceStateSchema.safeParse({ ...state, resourceId: "resource-one" }).success).toBe(false);
  });

  it("defines the strict campaign/actor projection with no ID or timestamp", () => {
    expect(actorResourceSchema.parse(resource)).toEqual(resource);
    for (const field of ["campaignId", "actorId", "name", "current", "max"] as const) {
      expect(actorResourceSchema.safeParse(without(resource, field)).success).toBe(false);
    }
    expect(actorResourceSchema.safeParse({ ...resource, campaignId: "bad campaign" }).success).toBe(false);
    expect(actorResourceSchema.safeParse({ ...resource, actorId: "bad actor" }).success).toBe(false);
    for (const field of ["id", "resourceId", "createdAt", "updatedAt"] as const) {
      expect(actorResourceSchema.safeParse({ ...resource, [field]: "not-part-of-contract" }).success).toBe(false);
    }
  });

  it("exports exact state and projection types without persistence metadata", () => {
    expectTypeOf<ActorResourceState>().toEqualTypeOf<{ name: string; current: number; max: number }>();
    expectTypeOf<ActorResource>().toEqualTypeOf<{
      campaignId: string;
      actorId: string;
      name: string;
      current: number;
      max: number;
    }>();
  });

  it("does not introduce inventory, currency, effects, or combat fields", () => {
    for (const field of ["inventory", "equipment", "currency", "shop", "effects", "combat"] as const) {
      expect(actorResourceStateSchema.safeParse({ ...state, [field]: [] }).success).toBe(false);
      expect(actorResourceSchema.safeParse({ ...resource, [field]: [] }).success).toBe(false);
    }
  });
});
