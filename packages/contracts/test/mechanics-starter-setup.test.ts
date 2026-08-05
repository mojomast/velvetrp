import { describe, expect, it } from "vitest";
import {
  campaignMechanicsStarterSetupRequestSchema,
  campaignMechanicsStarterSetupResponseSchema,
  MECHANICS_STARTER_ID,
  MECHANICS_STARTER_IDENTITY,
} from "../src/index.js";

describe("mechanics starter setup contracts", () => {
  it("accepts only the exact fixed identity object", () => {
    expect(campaignMechanicsStarterSetupRequestSchema.parse({ starterId: MECHANICS_STARTER_ID }))
      .toEqual({ starterId: MECHANICS_STARTER_ID });
    for (const value of [
      {}, null, [], { starterId: "velvet:mechanics-starter@latest" },
      { starterId: MECHANICS_STARTER_ID, expectedRevision: 0 },
      { starterId: MECHANICS_STARTER_ID, idempotencyKey: "caller-owned" },
    ]) expect(campaignMechanicsStarterSetupRequestSchema.safeParse(value).success).toBe(false);
  });

  it("exports one frozen exact identity and reuses strict campaign detail output", () => {
    expect(Object.isFrozen(MECHANICS_STARTER_IDENTITY)).toBe(true);
    expect(MECHANICS_STARTER_IDENTITY.starterId).toBe(MECHANICS_STARTER_ID);
    const response = { campaign: {
      id: "campaign-one", name: "One", actorRole: "owner",
      createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z",
      content: { status: "configured", rulesProfileId: MECHANICS_STARTER_IDENTITY.rulesProfileId,
        contentPacks: [{ packId: MECHANICS_STARTER_IDENTITY.packId, packVersion: MECHANICS_STARTER_IDENTITY.packVersion }] },
    } };
    expect(campaignMechanicsStarterSetupResponseSchema.parse(response)).toEqual(response);
    expect(campaignMechanicsStarterSetupResponseSchema.safeParse({ ...response, commandId: "private" }).success).toBe(false);
  });
});
