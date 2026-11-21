import { describe, expect, it } from "vitest";
import {
  campaignInviteCreateRequestSchema,
  campaignInviteCreateResponseSchema,
  campaignInviteRedeemRequestSchema,
  campaignInviteRedeemResponseSchema,
} from "../src/campaign-invite-http.js";

const at = "2035-01-01T00:00:00.000Z";

describe("campaign invite HTTP contract", () => {
  it("accepts a role-scoped invite and a redeem payload that does not include a session secret", () => {
    expect(
      campaignInviteCreateRequestSchema.parse({
        role: "player",
        expectedRevision: 3,
        idempotencyKey: "key-1",
      }),
    ).toEqual({ role: "player", expectedRevision: 3, idempotencyKey: "key-1" });
    const created = campaignInviteCreateResponseSchema.parse({
      inviteId: "invite-1",
      role: "player",
      expiresAt: at,
      token: "invite-token-1",
    });
    expect(created.token).toBe("invite-token-1");
    expect(Object.keys(created).sort()).toEqual(["expiresAt", "inviteId", "role", "token"].sort());
    expect(campaignInviteRedeemRequestSchema.parse({ token: "invite-token-1" })).toEqual({ token: "invite-token-1" });
    const redeemed = campaignInviteRedeemResponseSchema.parse({
      principalId: "player-orra",
      role: "player",
    });
    expect(redeemed).toEqual({ principalId: "player-orra", role: "player" });
    expect(JSON.stringify(redeemed)).not.toMatch(/secret|cookie|signature/i);
  });

  it("rejects owner invites and unknown redeem fields", () => {
    expect(
      campaignInviteCreateRequestSchema.safeParse({
        role: "owner",
        expectedRevision: 3,
        idempotencyKey: "key-1",
      }).success,
    ).toBe(false);
    expect(campaignInviteRedeemRequestSchema.safeParse({ token: "invite-token-1", cookie: "nope" }).success).toBe(
      false,
    );
  });
});
