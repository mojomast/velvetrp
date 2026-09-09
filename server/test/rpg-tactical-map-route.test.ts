import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";
import { TacticalMapConflictError, TacticalMapLocationMismatchError } from "../src/repo/tacticalMapRepo.js";

afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });
const enable = () => { process.env.FEATURE_RPG_CAMPAIGN = "true"; process.env.FEATURE_RPG_MECHANICS = "true"; };
const snapshot = { campaignId: "campaign", sessionId: "session", encounterId: null, mode: "exploration" as const, mapRevision: 0, tokenRevision: 0, controlledTokenId: "token",
  movement: { policy: "exploration-60-feet" as const, budgetFeet: 60 }, projection: { mapId: "map", width: 5, height: 5, grid: { kind: "square" as const, feetPerCell: 5 as const },
    tiles: [{ position: { x: 1, y: 1 }, terrain: "floor" as const, visibility: "visible" as const }], tokens: [{ tokenId: "token", label: "Hero", position: { x: 1, y: 1 }, footprint: { width: 1, height: 1 }, disposition: "friendly" as const }], authoritativePath: null, reachable: [{ x: 1, y: 1 }] } };
function repository(overrides: Record<string, unknown> = {}): CampaignListRepository { return { close() {}, listCampaigns: () => [], generateTacticalMapForSession: vi.fn(() => snapshot), getTacticalMap: vi.fn(() => snapshot),
  previewTacticalMapMove: vi.fn((_p, _c, _s, _m, input: { destination: { x: number; y: number } }) => ({ ...snapshot, previewId: "preview", pathCostFeet: 5, projection: { ...snapshot.projection, authoritativePath: [{ x: 1, y: 1 }, input.destination] } })),
  moveTacticalMapToken: vi.fn((_p, _c, _s, _m, input: { previewId: string; idempotencyKey: string }) => ({ receipt: { mapId: "map", tokenId: "token", previewId: input.previewId, idempotencyKey: input.idempotencyKey, mapRevision: 0, tokenRevisionBefore: 0, tokenRevisionAfter: 1, destination: { x: 2, y: 1 }, occurredAt: "2030-01-01T00:00:00.000Z" }, snapshot: { ...snapshot, tokenRevision: 1 } })), ...overrides } as unknown as CampaignListRepository; }

describe("tactical map HTTP routes", () => {
  it("returns a safe actionable location mismatch instead of a missing-map response", async () => {
    enable();
    const app = buildApp({ campaignRepositoryFactory: () => repository({ getTacticalMap: () => { throw new TacticalMapLocationMismatchError("private location or seed"); } }) });
    try {
      const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/exploration/actors/actor" });
      expect(response.statusCode).toBe(409);
      expect(response.body).toContain("RPG_TACTICAL_MAP_LOCATION_MISMATCH");
      expect(response.body).not.toContain("private location or seed");
    } finally { await app.close(); }
  });
  it("returns combat movement authority conflicts without exposing internal errors", async () => {
    enable();
    const repo = repository({ previewTacticalMapMove: vi.fn(() => { throw new TacticalMapConflictError("private authority details"); }),
      moveTacticalMapToken: vi.fn(() => { throw new TacticalMapConflictError("private authority details"); }) });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    try {
      const request = { actorId: "actor", destination: { x: 2, y: 1 }, expectedMapRevision: 0, expectedTokenRevision: 0 };
      for (const endpoint of ["previews", "move-commands"]) {
        const response = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/combat/${endpoint}`,
          payload: endpoint === "previews" ? request : { ...request, previewId: "old-turn", idempotencyKey: "move" } });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.body).not.toContain("private authority details");
      }
    } finally { await app.close(); }
  });
  it("gates before repository access and rejects queries, media types, and malformed bodies", async () => {
    let opens = 0; const gated = buildApp({ campaignRepositoryFactory: () => { opens += 1; return repository(); } });
    expect((await gated.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/exploration/actors/actor" })).statusCode).toBe(404); expect(opens).toBe(0); await gated.close();
    enable(); const app = buildApp({ campaignRepositoryFactory: () => repository() });
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/exploration/actors/actor?x=1" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/exploration/previews", headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/exploration/previews", headers: { "content-type": "application/json" }, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "HEAD", url: "/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/exploration/actors/actor" })).statusCode).toBe(404); await app.close();
  });

  it("binds fixed authority and returns only strict projection, preview, and receipt shapes", async () => {
    enable(); const repo = repository(); const app = buildApp({ campaignRepositoryFactory: () => repo });
    const read = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/exploration/actors/actor", headers: { "x-principal-id": "outsider" } });
    expect(read.statusCode, read.body).toBe(200); expect(read.headers["cache-control"]).toBe("private, no-store"); expect(read.body).not.toMatch(/blocksMovement|hidden|seed/); expect(repo.getTacticalMap).toHaveBeenCalledWith("local-owner", "campaign", "session", "exploration", "actor");
    const previewBody = { actorId: "actor", destination: { x: 2, y: 1 }, expectedMapRevision: 0, expectedTokenRevision: 0 };
    const preview = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/exploration/previews", headers: { "content-type": "application/json" }, payload: previewBody }); expect(preview.statusCode, preview.body).toBe(200);
    const move = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/campaign/rooms/session/tactical-maps/exploration/move-commands", headers: { "content-type": "application/json" }, payload: { ...previewBody, previewId: "preview", idempotencyKey: "move" } }); expect(move.statusCode, move.body).toBe(200); expect(move.json().receipt.tokenRevisionAfter).toBe(1); await app.close();
  });
});
