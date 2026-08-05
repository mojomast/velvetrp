import { describe, expect, expectTypeOf, it } from "vitest";
import {
  campaignDiceHistoryResponseSchema,
  campaignDiceRollRequestSchema,
  campaignDiceRollResponseSchema,
  MAX_CAMPAIGN_DICE_HISTORY,
  type CampaignDiceRollRequest,
} from "../src/index.js";

const result = {
  expression: "1d20",
  normalized: { count: 1, sides: 20, selection: { type: "all" as const }, modifier: 0 },
  terms: [{ value: 12, kept: true }], modifier: 0, total: 12,
};

describe("campaign dice HTTP contracts", () => {
  it("publishes strict ID-free request and response envelopes", () => {
    const character = { position: 1, name: "Aria" };
    expect(campaignDiceRollRequestSchema.parse({ character, expression: "1d20" }))
      .toEqual({ character, expression: "1d20" });
    const roll = { character, occurredAt: "2030-01-02T03:04:05.006Z", result };
    expect(campaignDiceRollResponseSchema.parse({ roll })).toEqual({ roll });
    for (const technical of ["actorId", "commandId", "revision", "check", "dc", "narration"]) {
      expect(campaignDiceRollRequestSchema.safeParse({ character, expression: "1d20", [technical]: "x" }).success)
        .toBe(false);
      expect(campaignDiceRollResponseSchema.safeParse({ roll: { ...roll, [technical]: "x" } }).success)
        .toBe(false);
    }
    expect(MAX_CAMPAIGN_DICE_HISTORY).toBe(20);
    expectTypeOf<CampaignDiceRollRequest>().toEqualTypeOf<{
      character: { position: number; name: string }; expression: string;
    }>();
  });

  it("requires contiguous visible bindings and bounded array-ordered history", () => {
    const characters = [{ position: 1, name: "Same" }, { position: 2, name: "Same" }];
    const rolls = Array.from({ length: 20 }, (_, index) => ({
      character: characters[index % 2]!,
      // occurredAt is informational: revision/event identity determines array order.
      occurredAt: index % 2 === 0 ? "2030-01-02T03:04:01.000Z" : "2030-01-02T03:04:02.000Z",
      result,
    }));
    expect(campaignDiceHistoryResponseSchema.parse({ characters, rolls }).rolls).toHaveLength(20);
    expect(campaignDiceHistoryResponseSchema.safeParse({ characters: [{ position: 2, name: "Same" }], rolls: [] }).success)
      .toBe(false);
    expect(campaignDiceHistoryResponseSchema.safeParse({ characters, rolls: [{ ...rolls[0]!, character: { position: 1, name: "Other" } }] }).success)
      .toBe(false);
    expect(campaignDiceHistoryResponseSchema.safeParse({ characters, rolls: [rolls[1], rolls[0]] }).success)
      .toBe(true);
    expect(campaignDiceHistoryResponseSchema.safeParse({ characters, rolls: [...rolls, rolls[0]!] }).success)
      .toBe(false);
  });
});
