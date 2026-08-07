import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignTransferHttpRoutes } from "../src/routes/rpg/v1/campaignTransfer.js";
import {
  CampaignAdministrationConflictError,
  CampaignAdministrationForbiddenError,
} from "../src/repo/campaignAdministrationRepo.js";

const at = "2035-01-02T03:04:05.006Z";
const campaign = { id: "campaign", actorRole: "owner" as const, status: "draft" as const,
  activeTimelineId: "timeline", revision: 1, updatedAt: at, settings: { maxPlayers: 6,
    allowPlayerDice: true, safetyMode: "standard" as const, recapVisibility: "members" as const, gmNotes: "" } };
const event = { eventId: "event", commandId: "command", campaignId: "campaign", type: "import_applied" as const,
  revision: 1, occurredAt: at, data: {} };
const receipt = { commandId: "command", campaignId: "campaign", type: "import_applied" as const,
  revisionBefore: 0, revisionAfter: 1, occurredAt: at, events: [event] as [typeof event] };

function setup() {
  const repo = {
    dryRunCampaignImport: vi.fn(),
    applyCampaignImportById: vi.fn(() => ({ value: campaign, receipt })),
  };
  const app = Fastify();
  app.register(campaignTransferHttpRoutes, { prefix: "/api/rpg/v1",
    campaignTransferRepositoryAccessor: () => repo as never });
  return { app, repo };
}

afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; });

describe("isolated campaign import apply HTTP lane", () => {
  it("feature-gates before media validation or repository access", async () => {
    const { app, repo } = setup();
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaign-imports/import-id/apply",
      headers: { "content-type": "text/plain" }, payload: "secret" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(repo.applyCampaignImportById).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses fixed local ownership, ignores identity headers, and returns a bound envelope", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const { app, repo } = setup();
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaign-imports/import-id/apply",
      headers: { authorization: "Bearer attacker", "x-principal-id": "attacker" },
      payload: { idempotencyKey: "apply-key", conflictResolutions: [] } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ campaign, receipt });
    expect(repo.applyCampaignImportById).toHaveBeenCalledWith("local-owner", "import-id",
      { idempotencyKey: "apply-key", conflictResolutions: [] });
    await app.close();
  });

  it("rejects query, media, malformed ids and non-empty human-readable resolutions", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const { app, repo } = setup();
    const base = "/api/rpg/v1/campaign-imports/import-id/apply";
    expect((await app.inject({ method: "POST", url: `${base}?x=1`, payload: {
      idempotencyKey: "key", conflictResolutions: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: base, headers: { "content-type": "text/plain" },
      payload: "x" })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/campaign-imports/bad%20id/apply",
      payload: { idempotencyKey: "key", conflictResolutions: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: base,
      payload: { idempotencyKey: "key", conflictResolutions: ["ignore conflict"] } })).statusCode).toBe(400);
    expect(repo.applyCampaignImportById).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [new CampaignAdministrationForbiddenError(), 404, "RPG_CAMPAIGN_IMPORT_NOT_FOUND"],
    [new CampaignAdministrationConflictError("private hash"), 409, "RPG_CAMPAIGN_IMPORT_CONFLICT"],
  ])("maps typed failures without disclosure", async (error, status, code) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const { app, repo } = setup(); repo.applyCampaignImportById.mockImplementation(() => { throw error; });
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaign-imports/import-secret/apply",
      payload: { idempotencyKey: "key", conflictResolutions: [] } });
    expect(response.statusCode).toBe(status);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ status, code,
      instance: "/api/rpg/v1/campaign-imports/:importId/apply" });
    expect(response.body).not.toContain("private hash");
    await app.close();
  });

  it("rejects unbound repository output as an unknown write outcome", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const { app, repo } = setup();
    repo.applyCampaignImportById.mockReturnValue({ value: campaign,
      receipt: { ...receipt, campaignId: "other", events: [{ ...event, campaignId: "other" }] } });
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaign-imports/import-id/apply",
      payload: { idempotencyKey: "key", conflictResolutions: [] } });
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("reconcile");
    expect(response.body).not.toContain("other");
    await app.close();
  });
});
