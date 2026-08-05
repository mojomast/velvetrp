import { describe, expect, expectTypeOf, it } from "vitest";
import {
  activeEffectSchema, effectCommandSchema, effectDurationSchema, effectModifierSchema, modifierKindSchema,
  type EffectCommand, type ModifierKind,
} from "../src/effects.js";

const timestamp = "2026-08-05T12:00:00.000Z";
const effect = {
  effectId: "bless", campaignId: "campaign", actorId: "actor", source: { kind: "spell", packId: "starter", packVersion: "1", definitionId: "bless-power" },
  modifiers: [{ kind: "flat", amount: 2, appliesToId: "attack" }, { kind: "advantage", appliesToId: "save" }],
  duration: { kind: "rounds", remaining: 10 }, recovery: "none", concentration: { kind: "required", concentrationId: "bless" }, appliedAt: timestamp,
} as const;
const base = { campaignId: "campaign", actorId: "actor", expectedRevision: 4, idempotencyKey: "effect-4" };

describe("M1.6 deterministic effect contracts", () => {
  it("uses precisely the reviewed modifier vocabulary", () => {
    expect(modifierKindSchema.options).toEqual(["flat", "proficiency", "advantage", "resistance", "vulnerability", "immunity"]);
    expect(activeEffectSchema.parse(effect)).toEqual(effect);
    expect(effectModifierSchema.safeParse({ kind: "formula", expression: "damage / 2" }).success).toBe(false);
    expect(effectModifierSchema.safeParse({ kind: "resistance", appliesToId: "fire", script: "x" }).success).toBe(false);
  });

  it("closes duration, recovery, concentration, and mutation variants", () => {
    expect(effectDurationSchema.safeParse({ kind: "rounds", remaining: 0 }).success).toBe(false);
    expect(activeEffectSchema.safeParse({ ...effect, recovery: "daily" }).success).toBe(false);
    const apply = { ...base, type: "apply_effect", effect, appliedAt: timestamp } as const;
    expect(effectCommandSchema.parse(apply)).toEqual(apply);
    expect(effectCommandSchema.parse({ ...base, type: "remove_effect", effectId: "bless", removedAt: timestamp }).type).toBe("remove_effect");
    expect(effectCommandSchema.parse({ ...base, type: "advance_effect_duration", effectId: "bless", rounds: 1, advancedAt: timestamp }).type).toBe("advance_effect_duration");
    expect(effectCommandSchema.safeParse({ ...apply, effect: { ...effect, actorId: "other" } }).success).toBe(false);
    expect(effectCommandSchema.safeParse({ ...base, type: "remove_effect", effectId: "bless", removedAt: timestamp, expectedRevision: -1 }).success).toBe(false);
  });

  it("publishes closed discriminants", () => {
    expectTypeOf<ModifierKind>().toEqualTypeOf<"flat" | "proficiency" | "advantage" | "resistance" | "vulnerability" | "immunity">();
    expectTypeOf<EffectCommand["type"]>().toEqualTypeOf<"apply_effect" | "remove_effect" | "advance_effect_duration">();
  });
});
