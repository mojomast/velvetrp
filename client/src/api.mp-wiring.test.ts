import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandCampaignReadyCheck,
  getCampaignReadyCheck,
  getCombatTurnClock,
  commandCombatSkipTurn,
  commandCombatHandoff,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("multiplayer play wiring HTTP clients", () => {
  it("reads and commands a ready check on the room path", async () => {
    const state = {
      campaignId: "campaign",
      sessionId: "session",
      enabled: true,
      expectedRevision: 7,
      check: null,
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(state), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCampaignReadyCheck("campaign", "session")).resolves.toEqual(state);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/rpg/v1/campaigns/campaign/rooms/session/ready-check");
  });

  it("posts a ready-check command and returns the receipt payload", async () => {
    const body = { action: "start" as const, expectedRevision: 7, idempotencyKey: "key-1" };
    const payload = {
      campaignId: "campaign",
      sessionId: "session",
      enabled: true,
      expectedRevision: 8,
      check: { startedAt: "2030-01-01T00:00:00.000Z", readyActorIds: [], waiting: [] },
      receipt: { idempotencyKey: "key-1", occurredAt: "2030-01-01T00:00:00.000Z" },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(commandCampaignReadyCheck("campaign", "session", body)).resolves.toEqual(payload);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/rpg/v1/campaigns/campaign/rooms/session/ready-check/commands",
    );
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
  });

  it("reads the turn clock and posts skip and handoff commands", async () => {
    const clock = {
      currentCombatant: "c-orra",
      currentTurnStartedAt: "2030-01-01T00:00:00.000Z",
      timeoutSeconds: 90,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(clock), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ currentCombatant: "c-bandit", revision: 8 }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ playedByGmUntilReturn: [{ actorId: "orra", displayName: "Orra Staple" }], revision: 9 }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(getCombatTurnClock("combat")).resolves.toEqual(clock);
    await expect(commandCombatSkipTurn("combat", { expectedRevision: 7, idempotencyKey: "skip-1" })).resolves.toEqual({
      currentCombatant: "c-bandit",
      revision: 8,
    });
    await expect(
      commandCombatHandoff("combat", {
        action: "take-over",
        actorId: "orra",
        expectedRevision: 8,
        idempotencyKey: "hand-1",
      }),
    ).resolves.toMatchObject({ revision: 9 });
    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), (init as RequestInit).method ?? "GET"])).toEqual([
      ["/api/rpg/v1/combats/combat/turn-clock", "GET"],
      ["/api/rpg/v1/combats/combat/skip-turn-commands", "POST"],
      ["/api/rpg/v1/combats/combat/handoff-commands", "POST"],
    ]);
  });
});
