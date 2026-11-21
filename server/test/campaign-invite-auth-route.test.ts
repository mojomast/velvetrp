import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignInviteHttpRoutes } from "../src/routes/rpg/v1/campaignInvites.js";
import { campaignMembershipHttpRoutes } from "../src/routes/rpg/v1/campaignMemberships.js";
import { campaignPlayHttpRoutes } from "../src/routes/rpg/v1/campaignPlay.js";

const at = "2035-01-01T00:00:00.000Z";
const bootstrap = {
  campaignId: "campaign",
  sessionId: "session",
  expectedRevision: 7,
  session: { attached: true as const, attachedAt: at, active: true, adventureEligible: true },
  principal: { role: "owner" as const, control: "all" as const },
  capabilities: { campaignDice: { canView: true, canRoll: true } },
  playableActors: [{ actorId: "actor", name: "Aria" }],
};

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.VELVET_AUTH_MODE;
  delete process.env.VELVET_SESSION_SECRET;
});

function enable() {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  process.env.VELVET_SESSION_SECRET = "test-session-secret";
}

function playRepo() {
  return {
    getCampaignPlayBootstrap: vi.fn((principalId: string) => ({
      ...bootstrap,
      principal:
        principalId === "local-owner"
          ? { role: "owner" as const, control: "all" as const }
          : { role: "player" as const, control: "controlled" as const },
    })),
  };
}

function membershipRepo() {
  return {
    listCampaignMemberships: vi.fn(),
    addAuditedCampaignMembership: vi.fn(),
    changeAuditedCampaignMembershipRole: vi.fn(),
    removeAuditedCampaignMembership: vi.fn(),
  };
}

function inviteRepo() {
  return {
    createCampaignInvite: vi.fn(() => ({
      inviteId: "invite-1",
      role: "player",
      expiresAt: at,
      token: "invite-token-1",
    })),
    redeemCampaignInvite: vi.fn(() => ({ principalId: "player-orra", role: "player" })),
  };
}

async function app() {
  enable();
  const play = playRepo();
  const memberships = membershipRepo();
  const invites = inviteRepo();
  const server = Fastify({ logger: false });
  await server.register(campaignInviteHttpRoutes, { campaignInviteRepositoryAccessor: () => invites });
  await server.register(campaignPlayHttpRoutes, { campaignPlayRepositoryAccessor: () => play });
  await server.register(campaignMembershipHttpRoutes, { campaignMembershipRepositoryAccessor: () => memberships });
  return { server, play, memberships, invites };
}

describe("campaign invite and authenticated membership", () => {
  it("keeps local single-user mode when no session cookie is present", async () => {
    const { server, play } = await app();
    const result = await server.inject({
      method: "GET",
      url: "/campaigns/campaign/rooms/session/play-bootstrap",
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().principal).toEqual({ role: "owner", control: "all" });
    expect(play.getCampaignPlayBootstrap).toHaveBeenCalledWith("local-owner", "campaign", "session");
    await server.close();
  });

  it("creates an invite, sets an httpOnly session cookie on redeem, and uses that principal on play bootstrap", async () => {
    const { server, play, invites } = await app();
    const created = await server.inject({
      method: "POST",
      url: "/campaigns/campaign/invites",
      headers: { "content-type": "application/json" },
      payload: { role: "player", expectedRevision: 7, idempotencyKey: "key-1" },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().token).toBe("invite-token-1");
    expect(invites.createCampaignInvite).toHaveBeenCalledWith(
      "local-owner",
      "campaign",
      expect.objectContaining({ role: "player" }),
    );

    const redeemed = await server.inject({
      method: "POST",
      url: "/invites/redeem",
      headers: { "content-type": "application/json" },
      payload: { token: "invite-token-1" },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json()).toEqual({ principalId: "player-orra", role: "player" });
    const setCookie = redeemed.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join("\n") : String(setCookie ?? "");
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/velvet_session=/);
    const cookiePair = cookieHeader.split(";").find((part) => part.trim().startsWith("velvet_session="));
    expect(cookiePair).toBeTruthy();

    const result = await server.inject({
      method: "GET",
      url: "/campaigns/campaign/rooms/session/play-bootstrap",
      headers: { cookie: cookiePair!.trim() },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().principal).toEqual({ role: "player", control: "controlled" });
    expect(play.getCampaignPlayBootstrap).toHaveBeenCalledWith("player-orra", "campaign", "session");
    await server.close();
  });

  it("enforces membership writes server-side and requires a cookie in remote mode", async () => {
    const { server, memberships } = await app();
    const redeemed = await server.inject({
      method: "POST",
      url: "/invites/redeem",
      headers: { "content-type": "application/json" },
      payload: { token: "invite-token-1" },
    });
    const setCookie = redeemed.headers["set-cookie"];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join("\n") : String(setCookie ?? "");
    const cookiePair = cookieHeader.split(";").find((part) => part.trim().startsWith("velvet_session="));

    const denied = await server.inject({
      method: "POST",
      url: "/campaigns/campaign/memberships",
      headers: { "content-type": "application/json", cookie: cookiePair!.trim() },
      payload: {
        principalId: "principal-target",
        role: "player",
        expectedRevision: 7,
        idempotencyKey: "key-2",
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(memberships.addAuditedCampaignMembership).not.toHaveBeenCalled();

    process.env.VELVET_AUTH_MODE = "remote";
    const unauthenticated = await server.inject({
      method: "GET",
      url: "/campaigns/campaign/rooms/session/play-bootstrap",
    });
    expect(unauthenticated.statusCode).toBe(401);
    await server.close();
  });
});
