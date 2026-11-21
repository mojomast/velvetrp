import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "../src/http/requestPrincipal.js";
import { combatCommandsHttpRoutes } from "../src/routes/rpg/v1/combatCommands.js";
import { combatReadsHttpRoutes } from "../src/routes/rpg/v1/combatReads.js";

const at = "2035-01-01T00:00:00.000Z";
const clock = {
  currentCombatant: "c-orra",
  currentTurnStartedAt: at,
  timeoutSeconds: 90,
};

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  delete process.env.FEATURE_RPG_COMBAT;
  delete process.env.VELVET_AUTH_MODE;
  delete process.env.VELVET_SESSION_SECRET;
});

function enable() {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  process.env.FEATURE_RPG_COMBAT = "true";
  process.env.VELVET_SESSION_SECRET = "test-session-secret";
}

function repository() {
  return {
    getCombatState: vi.fn(),
    listCombatLogPage: vi.fn(),
    listCombatRewards: vi.fn(),
    resolveCombatAction: vi.fn(),
    executeCombatEnemyTurn: vi.fn(),
    endCombat: vi.fn(),
    getCombatCommandResult: vi.fn(),
    claimCombatReward: vi.fn(),
    getCombatRewardClaimResult: vi.fn(),
    getCombatTurnClock: vi.fn(() => clock),
    skipCurrentTurn: vi.fn(() => ({ currentCombatant: "c-bandit", revision: 8 })),
    commandCombatHandoff: vi.fn(() => ({ playedByGmUntilReturn: [], revision: 8 })),
  };
}

async function app(repo = repository()) {
  enable();
  const server = Fastify({ logger: false });
  const accessor = () => repo;
  await server.register(combatReadsHttpRoutes, { combatRepositoryAccessor: accessor });
  await server.register(combatCommandsHttpRoutes, { combatCommandRepositoryAccessor: accessor });
  return { server, repo };
}

describe("combat routes request principal", () => {
  it("keeps local-owner when no session cookie is present", async () => {
    const { server, repo } = await app();
    const read = await server.inject({ method: "GET", url: "/combats/combat/turn-clock" });
    expect(read.statusCode).toBe(200);
    expect(repo.getCombatTurnClock).toHaveBeenCalledWith("local-owner", "combat");
    await server.close();
  });

  it("forwards the signed session principal to clock, skip, and handoff", async () => {
    const { server, repo } = await app();
    const cookie = createSessionCookie("player-orra");
    const header = cookie.split(";")[0]!;
    const read = await server.inject({
      method: "GET",
      url: "/combats/combat/turn-clock",
      headers: { cookie: header },
    });
    expect(read.statusCode).toBe(200);
    expect(repo.getCombatTurnClock).toHaveBeenCalledWith("player-orra", "combat");

    const skipped = await server.inject({
      method: "POST",
      url: "/combats/combat/skip-turn-commands",
      headers: { "content-type": "application/json", cookie: header },
      payload: { expectedRevision: 7, idempotencyKey: "key-1" },
    });
    expect(skipped.statusCode).toBe(200);
    expect(repo.skipCurrentTurn).toHaveBeenCalledWith("player-orra", "combat", {
      expectedRevision: 7,
      idempotencyKey: "key-1",
    });

    const taken = await server.inject({
      method: "POST",
      url: "/combats/combat/handoff-commands",
      headers: { "content-type": "application/json", cookie: header },
      payload: { action: "take-over", actorId: "orra", expectedRevision: 7, idempotencyKey: "key-2" },
    });
    expect(taken.statusCode).toBe(200);
    expect(repo.commandCombatHandoff).toHaveBeenCalledWith(
      "player-orra",
      "combat",
      expect.objectContaining({ action: "take-over", actorId: "orra" }),
    );
    await server.close();
  });

  it("returns 401 in remote mode when no session cookie is present", async () => {
    const { server, repo } = await app();
    process.env.VELVET_AUTH_MODE = "remote";
    const read = await server.inject({ method: "GET", url: "/combats/combat/turn-clock" });
    expect(read.statusCode).toBe(401);
    expect(read.json().code).toBe("RPG_AUTHENTICATION_REQUIRED");
    expect(repo.getCombatTurnClock).not.toHaveBeenCalled();
    await server.close();
  });
});
