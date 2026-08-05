import { describe, expect, expectTypeOf, it } from "vitest";
import {
  checkCommandSchema, checkResolutionSchema, checkTargetSchema, checkTermSchema,
  type CheckCommand, type CheckKind,
} from "../src/checks.js";

const resolution = {
  terms: [{ kind: "flat", sourceId: null, value: 12 }, { kind: "proficiency", sourceId: "prof", value: 2 }],
  total: 14,
  target: { kind: "difficulty_class", value: 13 },
  outcome: "success",
} as const;
const base = { campaignId: "campaign", actorId: "actor", expectedRevision: 0, idempotencyKey: "check-1" };

describe("M1.6 check contracts", () => {
  it("closes check kinds and their discriminated command shapes", () => {
    const commands = [
      { ...base, kind: "ability", abilityId: "str" },
      { ...base, kind: "skill", skillId: "stealth" },
      { ...base, kind: "save", abilityId: "dex" },
      { ...base, kind: "attack", attackId: "sword", targetActorId: "target" },
      { ...base, kind: "attack", attackId: "sword" },
      { ...base, kind: "opposed", opponentActorId: "opponent" },
    ] as const;
    commands.forEach((command) => expect(checkCommandSchema.parse(command)).toEqual(command));
    expect(checkCommandSchema.safeParse({ ...base, kind: "spell", abilityId: "int" }).success).toBe(false);
    expect(checkCommandSchema.safeParse({ ...base, kind: "ability", abilityId: "int", unknown: true }).success).toBe(false);
  });

  it("requires bounded structured terms, total, target, and outcome", () => {
    expect(checkResolutionSchema.parse(resolution)).toEqual(resolution);
    expect(checkTermSchema.safeParse({ kind: "formula", expression: "1+1" }).success).toBe(false);
    expect(checkTargetSchema.safeParse({ kind: "difficulty_class", value: 0 }).success).toBe(false);
    for (const invalid of [
      { ...resolution, total: 13 },
      { ...resolution, outcome: "maybe" },
      { ...resolution, terms: [] },
      { ...resolution, target: { kind: "difficulty_class", value: 13, script: "x" } },
    ]) expect(checkResolutionSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects caller-provided resolutions and enforces concurrency keys", () => {
    expect(checkCommandSchema.safeParse({ ...base, kind: "ability", abilityId: "int", expectedRevision: -1 }).success).toBe(false);
    expect(checkCommandSchema.safeParse({ ...base, kind: "ability", abilityId: "int", idempotencyKey: "" }).success).toBe(false);
    for (const callerResult of [
      { resolution }, { terms: resolution.terms }, { total: resolution.total }, { target: resolution.target },
      { outcome: resolution.outcome }, { resolvedAt: "2026-08-05T12:00:00.000Z" },
    ]) {
      expect(checkCommandSchema.safeParse({ ...base, kind: "ability", abilityId: "int", ...callerResult }).success).toBe(false);
    }
  });

  it("publishes a narrow closed kind union", () => {
    expectTypeOf<CheckKind>().toEqualTypeOf<"ability" | "skill" | "save" | "attack" | "opposed">();
    expectTypeOf<CheckCommand["kind"]>().toEqualTypeOf<CheckKind>();
  });
});
