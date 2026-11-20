import { describe, expect, it } from "vitest";
import { campaignReadyCheckCommandSchema, campaignReadyCheckStateSchema } from "../src/ready-check-http.js";

const at = "2030-01-01T00:00:00.000Z";

describe("ready-check HTTP contract", () => {
  it("accepts a disabled room with no active check, the default freeform shape", () => {
    expect(
      campaignReadyCheckStateSchema.parse({
        campaignId: "campaign",
        sessionId: "session",
        enabled: false,
        expectedRevision: 3,
        check: null,
      }),
    ).toEqual({
      campaignId: "campaign",
      sessionId: "session",
      enabled: false,
      expectedRevision: 3,
      check: null,
    });
  });

  it("accepts an active check that names who is still waiting", () => {
    const state = campaignReadyCheckStateSchema.parse({
      campaignId: "campaign",
      sessionId: "session",
      enabled: true,
      expectedRevision: 4,
      check: {
        startedAt: at,
        readyActorIds: ["orra"],
        waiting: [{ actorId: "tessel", name: "Tessel Venn" }],
      },
    });
    expect(state.check?.waiting).toEqual([{ actorId: "tessel", name: "Tessel Venn" }]);
    expect(state.enabled).toBe(true);
  });

  it("accepts the closed command set and rejects unknown actions", () => {
    for (const action of ["enable", "disable", "start", "ready", "dismiss"] as const) {
      expect(
        campaignReadyCheckCommandSchema.parse({ action, expectedRevision: 3, idempotencyKey: "key-1" }).action,
      ).toBe(action);
    }
    expect(
      campaignReadyCheckCommandSchema.safeParse({ action: "lock-turns", expectedRevision: 3, idempotencyKey: "key-1" })
        .success,
    ).toBe(false);
  });
});
