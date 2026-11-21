import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});

function enable() {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
  process.env.FEATURE_RPG_COMBAT = "true";
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
    commandCombatHandoff: vi.fn(
      (_principal: string, _combatId: string, input: { action: string; actorId: string }) => ({
        playedByGmUntilReturn:
          input.action === "take-over" ? [{ actorId: input.actorId, displayName: "Orra Staple" }] : [],
        revision: 8,
      }),
    ),
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

describe("combat turn clock and AFK handoff routes", () => {
  it("reads the 90-second turn clock and lets the GM skip or take over, then the player reclaim", async () => {
    const { server, repo } = await app();
    const read = await server.inject({ method: "GET", url: "/combats/combat/turn-clock" });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toEqual(clock);
    expect(repo.getCombatTurnClock).toHaveBeenCalledWith("local-owner", "combat");

    const skipped = await server.inject({
      method: "POST",
      url: "/combats/combat/skip-turn-commands",
      headers: { "content-type": "application/json" },
      payload: { expectedRevision: 7, idempotencyKey: "key-1" },
    });
    expect(skipped.statusCode).toBe(200);
    expect(repo.skipCurrentTurn).toHaveBeenCalledWith("local-owner", "combat", {
      expectedRevision: 7,
      idempotencyKey: "key-1",
    });

    const taken = await server.inject({
      method: "POST",
      url: "/combats/combat/handoff-commands",
      headers: { "content-type": "application/json" },
      payload: { action: "take-over", actorId: "orra", expectedRevision: 7, idempotencyKey: "key-2" },
    });
    expect(taken.statusCode).toBe(200);
    expect(taken.json().playedByGmUntilReturn).toEqual([{ actorId: "orra", displayName: "Orra Staple" }]);
    expect(repo.commandCombatHandoff).toHaveBeenCalledWith(
      "local-owner",
      "combat",
      expect.objectContaining({ action: "take-over", actorId: "orra" }),
    );

    const resumed = await server.inject({
      method: "POST",
      url: "/combats/combat/handoff-commands",
      headers: { "content-type": "application/json" },
      payload: { action: "reclaim", actorId: "orra", expectedRevision: 8, idempotencyKey: "key-3" },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().playedByGmUntilReturn).toEqual([]);
    await server.close();
  });

  it("gates combat features before repository access", async () => {
    const repo = repository();
    const server = Fastify({ logger: false });
    await server.register(combatReadsHttpRoutes, { combatRepositoryAccessor: () => repo });
    const result = await server.inject({ method: "GET", url: "/combats/combat/turn-clock" });
    expect(result.statusCode).toBe(404);
    expect(repo.getCombatTurnClock).not.toHaveBeenCalled();
    await server.close();
  });
});
