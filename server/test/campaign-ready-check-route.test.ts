import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignReadyCheckHttpRoutes } from "../src/routes/rpg/v1/campaignReadyCheck.js";

const at = "2030-01-01T00:00:00.000Z";
afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
});

function repo(state: unknown) {
  return {
    getReadyCheck: vi.fn(() => state),
    commandReadyCheck: vi.fn((_principal: string, _campaign: string, _session: string, input: { action: string }) => ({
      campaignId: "campaign",
      sessionId: "session",
      enabled: input.action !== "disable",
      expectedRevision: 4,
      check:
        input.action === "start"
          ? { startedAt: at, readyActorIds: [], waiting: [{ actorId: "orra", name: "Orra Staple" }] }
          : null,
      receipt: { idempotencyKey: "key-1", occurredAt: at },
    })),
  };
}

const disabled = {
  campaignId: "campaign",
  sessionId: "session",
  enabled: false,
  expectedRevision: 3,
  check: null,
};

async function app(repository = repo(disabled)) {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  const server = Fastify({ logger: false });
  await server.register(campaignReadyCheckHttpRoutes, { readyCheckRepositoryAccessor: () => repository });
  return { server, repository };
}

describe("campaign ready-check routes", () => {
  it("returns a disabled ready-check by default without starting one", async () => {
    const { server, repository } = await app();
    const result = await server.inject({
      method: "GET",
      url: "/api/rpg/v1/campaigns/campaign/rooms/session/ready-check",
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(disabled);
    expect(repository.getReadyCheck).toHaveBeenCalledWith("local-owner", "campaign", "session");
    await server.close();
  });

  it("lets an owner start a named ready check and a player mark ready", async () => {
    const { server, repository } = await app();
    const started = await server.inject({
      method: "POST",
      url: "/api/rpg/v1/campaigns/campaign/rooms/session/ready-check/commands",
      headers: { "content-type": "application/json" },
      payload: { action: "start", expectedRevision: 3, idempotencyKey: "key-1" },
    });
    expect(started.statusCode).toBe(200);
    expect(started.json().check.waiting[0].name).toBe("Orra Staple");
    expect(repository.commandReadyCheck).toHaveBeenCalledWith(
      "local-owner",
      "campaign",
      "session",
      expect.objectContaining({ action: "start" }),
    );
    await server.close();
  });

  it("gates campaign and mechanics features before repository access", async () => {
    const repository = repo(disabled);
    const server = Fastify({ logger: false });
    await server.register(campaignReadyCheckHttpRoutes, { readyCheckRepositoryAccessor: () => repository });
    const result = await server.inject({
      method: "GET",
      url: "/api/rpg/v1/campaigns/campaign/rooms/session/ready-check",
    });
    expect(result.statusCode).toBe(404);
    expect(repository.getReadyCheck).not.toHaveBeenCalled();
    await server.close();
  });
});
