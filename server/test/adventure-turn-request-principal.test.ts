import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "../src/http/requestPrincipal.js";
import { adventureTurnsHttpRoutes } from "../src/routes/rpg/v1/adventureTurns.js";

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

function repository() {
  return {
    getAdventureTurnTranscript: vi.fn(() => []),
    getAdventureTurn: vi.fn(),
    getAdventureTurnNarration: vi.fn(),
    waitForToolConfirmation: vi.fn(),
    getAdventureTurnByInitialIdempotencyKey: vi.fn(),
    decideToolProposals: vi.fn(),
    expireToolProposals: vi.fn(),
    reconcileAdventureTurnMechanics: vi.fn(),
    updateAdventureTurnNarration: vi.fn(),
    recordProviderCallStart: vi.fn(),
    recordProviderCallOutcome: vi.fn(),
    claimNarrationProviderDispatch: vi.fn(),
    settleNarrationProviderDispatch: vi.fn(),
    getNarrationProviderDispatch: vi.fn(),
    getAdventureTurnNarrationSource: vi.fn(),
    createAdventureTurn: vi.fn(),
    getCampaign: vi.fn(),
  };
}

async function app(repo = repository()) {
  enable();
  const server = Fastify({ logger: false });
  await server.register(adventureTurnsHttpRoutes, { adventureTurnRepositoryAccessor: () => repo as never });
  return { server, repo };
}

describe("adventure-turn routes request principal", () => {
  it("keeps local-owner on the transcript read when no session cookie is present", async () => {
    const { server, repo } = await app();
    const result = await server.inject({
      method: "GET",
      url: "/adventure-turns/transcript?campaignId=campaign&sessionId=session",
    });
    expect(result.statusCode).toBe(200);
    expect(repo.getAdventureTurnTranscript).toHaveBeenCalledWith("local-owner", "campaign", "session");
    await server.close();
  });

  it("forwards the signed session principal to the transcript read", async () => {
    const { server, repo } = await app();
    const cookie = createSessionCookie("player-orra");
    const result = await server.inject({
      method: "GET",
      url: "/adventure-turns/transcript?campaignId=campaign&sessionId=session",
      headers: { cookie: cookie.split(";")[0]! },
    });
    expect(result.statusCode).toBe(200);
    expect(repo.getAdventureTurnTranscript).toHaveBeenCalledWith("player-orra", "campaign", "session");
    await server.close();
  });

  it("returns 401 in remote mode when no session cookie is present", async () => {
    const { server, repo } = await app();
    process.env.VELVET_AUTH_MODE = "remote";
    const result = await server.inject({
      method: "GET",
      url: "/adventure-turns/transcript?campaignId=campaign&sessionId=session",
    });
    expect(result.statusCode).toBe(401);
    expect(result.json().code).toBe("RPG_AUTHENTICATION_REQUIRED");
    expect(repo.getAdventureTurnTranscript).not.toHaveBeenCalled();
    await server.close();
  });
});
