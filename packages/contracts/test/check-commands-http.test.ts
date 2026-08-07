import { describe, expect, it } from "vitest";
import {
  actorCheckCommandRequestSchema,
  actorCheckCommandResponseSchema,
} from "../src/check-commands-http.js";

describe("actor check command HTTP contracts", () => {
  const base = { skillOrAttribute: "might", expectedRevision: 3, idempotencyKey: "check-1" };

  it("accepts all five strict intent variants and enforces target semantics", () => {
    const valid = [
      { ...base, kind: "ability", difficultyRef: "easy" },
      { ...base, kind: "skill" },
      { ...base, kind: "save", difficultyRef: "very-hard" },
      { ...base, kind: "attack", targetActorId: "target" },
      { ...base, kind: "opposed", targetActorId: "target" },
    ];
    for (const request of valid) expect(actorCheckCommandRequestSchema.safeParse(request).success).toBe(true);
    for (const request of [
      { ...base, kind: "opposed" },
      { ...base, kind: "opposed", targetActorId: "target", difficultyRef: "hard" },
      { ...base, kind: "ability", targetActorId: "target" },
      { ...base, kind: "ability", difficultyRef: 12 },
      { ...base, kind: "skill", modifier: 9 },
      { ...base, kind: "save", campaignId: "private" },
      { ...base, kind: "attack", resolution: {} },
    ]) expect(actorCheckCommandRequestSchema.safeParse(request).success).toBe(false);
  });

  it("binds response math and exposes only the public check and receipt", () => {
    const response = {
      check: {
        terms: [
          { kind: "roll" as const, roll: {
            expression: "1d20", normalized: { count: 1, sides: 20, selection: { type: "all" as const }, modifier: 0 },
            terms: [{ value: 10, kept: true }], modifier: 0, total: 10,
          } },
          { kind: "flat" as const, sourceId: null, value: 3 },
          { kind: "proficiency" as const, sourceId: "might", value: 2 },
        ],
        modifier: 5,
        total: 15,
        target: { kind: "difficulty_class" as const, value: 12 },
        outcome: "success" as const,
      },
      receipt: { idempotencyKey: "check-1", revisionBefore: 3, revisionAfter: 4, occurredAt: "2035-01-01T00:00:00.000Z" },
    };
    expect(actorCheckCommandResponseSchema.parse(response)).toEqual(response);
    expect(actorCheckCommandResponseSchema.safeParse({ ...response, check: { ...response.check, modifier: 4 } }).success).toBe(false);
    expect(actorCheckCommandResponseSchema.safeParse({ ...response, check: { ...response.check, total: 14 } }).success).toBe(false);
    expect(actorCheckCommandResponseSchema.safeParse({ ...response, receipt: { ...response.receipt, revisionAfter: 5 } }).success).toBe(false);
    expect(actorCheckCommandResponseSchema.safeParse({ ...response, commandId: "private" }).success).toBe(false);
    expect(actorCheckCommandResponseSchema.safeParse({ ...response, receipt: { ...response.receipt, campaignId: "private" } }).success).toBe(false);
  });
});
