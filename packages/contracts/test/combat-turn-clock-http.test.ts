import { describe, expect, it } from "vitest";
import {
  combatHandoffCommandRequestSchema,
  combatSkipTurnCommandRequestSchema,
  combatTurnClockResponseSchema,
} from "../src/encounters-http.js";

const at = "2035-01-01T00:00:00.000Z";

describe("combat turn clock HTTP contract", () => {
  it("accepts a 90-second clock, a skip command, and a take-over or reclaim", () => {
    expect(
      combatTurnClockResponseSchema.parse({
        currentCombatant: "c-orra",
        currentTurnStartedAt: at,
        timeoutSeconds: 90,
      }),
    ).toEqual({
      currentCombatant: "c-orra",
      currentTurnStartedAt: at,
      timeoutSeconds: 90,
    });
    expect(
      combatTurnClockResponseSchema.parse({
        currentCombatant: "c-orra",
        currentTurnStartedAt: at,
        timeoutSeconds: 90,
        playedByGmUntilReturn: [{ actorId: "orra", displayName: "Orra Staple" }],
      }).playedByGmUntilReturn,
    ).toEqual([{ actorId: "orra", displayName: "Orra Staple" }]);
    expect(combatSkipTurnCommandRequestSchema.parse({ expectedRevision: 7, idempotencyKey: "key-1" })).toEqual({
      expectedRevision: 7,
      idempotencyKey: "key-1",
    });
    expect(
      combatHandoffCommandRequestSchema.parse({
        action: "take-over",
        actorId: "orra",
        expectedRevision: 7,
        idempotencyKey: "key-2",
      }).action,
    ).toBe("take-over");
    expect(
      combatHandoffCommandRequestSchema.parse({
        action: "reclaim",
        actorId: "orra",
        expectedRevision: 7,
        idempotencyKey: "key-3",
      }).action,
    ).toBe("reclaim");
  });

  it("rejects an auto-skip action and a non-90-second timeout", () => {
    expect(combatHandoffCommandRequestSchema.safeParse({ action: "auto-skip", actorId: "orra" }).success).toBe(false);
    expect(
      combatTurnClockResponseSchema.safeParse({
        currentCombatant: "c-orra",
        currentTurnStartedAt: at,
        timeoutSeconds: 30,
      }).success,
    ).toBe(false);
  });
});
