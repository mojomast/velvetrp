import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignTransferHttpRoutes } from "../src/routes/rpg/v1/campaignTransfer.js";
import { CampaignAdministrationForbiddenError } from "../src/repo/campaignAdministrationRepo.js";
import { CampaignExportLimitError, countCampaignTransferPackageRecords } from "../src/repo/campaignAdmin/administrationExportRepo.js";

const at = "2035-01-02T03:04:05.006Z";
const pkg = {
  formatVersion: 1 as const, exportedAt: at,
  campaign: { name: "Campaign", status: "draft" as const, settings: { maxPlayers: 6, allowPlayerDice: true,
    safetyMode: "standard" as const, recapVisibility: "members" as const, gmNotes: "" }, administrationRevision: 0 },
  timelines: [{ sourceId: "timeline", parentSourceId: null, forkedFromRevision: null, revision: 0, createdAt: at, events: [] }],
  activeTimelineSourceId: "timeline", content: { status: "unconfigured" as const },
  records: { actors: [], checkpoints: [], recaps: [], memberships: [], roomAttachments: [],
    administration: { events: [], receipts: [] } },
  excluded: ["credentials", "localPaths", "usageHistory", "privateActorState"] as
    ["credentials", "localPaths", "usageHistory", "privateActorState"],
};

function result(includeMessages: boolean) {
  const document = { package: pkg, messages: includeMessages ? { included: true as const, rooms: [] }
    : { included: false as const } };
  return { document, campaignId: "campaign", administrationRevision: 0,
    recordCount: countCampaignTransferPackageRecords(pkg), byteLength: Buffer.byteLength(JSON.stringify(document)) };
}

function setup() {
  const repo = { readCampaignExport: vi.fn((_actor: string, _campaign: string, options: { includeMessages: boolean }) =>
    result(options.includeMessages)), dryRunCampaignImport: vi.fn(), applyCampaignImportById: vi.fn() };
  const app = Fastify();
  app.register(campaignTransferHttpRoutes, { prefix: "/api/rpg/v1", campaignTransferRepositoryAccessor: () => repo as never });
  return { app, repo };
}

afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; });

describe("isolated campaign export HTTP lane", () => {
  it.each([true, false])("uses the fixed owner and downloads the strict %s archive", async (includeMessages) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const { app, repo } = setup();
    const response = await app.inject({ method: "GET",
      url: `/api/rpg/v1/campaigns/campaign/export?includeMessages=${includeMessages}`,
      headers: { authorization: "Bearer attacker", "x-principal-id": "attacker" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result(includeMessages).document);
    expect(repo.readCampaignExport).toHaveBeenCalledWith("local-owner", "campaign", { includeMessages });
    expect(response.headers).toMatchObject({ "cache-control": "no-store", "content-type": "application/json",
      "content-disposition": "attachment; filename=\"campaign-campaign-export-v1.json\"",
      "x-content-type-options": "nosniff", "content-length": String(Buffer.byteLength(response.body)) });
    await app.close();
  });

  it("feature-gates before repository access and rejects every non-exact query", async () => {
    const { app, repo } = setup();
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/export" })).statusCode).toBe(404);
    expect(repo.readCampaignExport).not.toHaveBeenCalled();
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    for (const query of ["", "?includeMessages=1", "?includeMessages=true&x=1",
      "?includeMessages=true&includeMessages=false", "?includeMessages%3Dtrue"]) {
      const response = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/campaign/export${query}` });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect((await app.inject({ method: "GET",
      url: "/api/rpg/v1/campaigns/bad%20campaign/export?includeMessages=false" })).json())
      .toMatchObject({ status: 404, code: "RPG_CAMPAIGN_NOT_FOUND",
        instance: "/api/rpg/v1/campaigns/:campaignId/export" });
    expect(repo.readCampaignExport).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [new CampaignAdministrationForbiddenError(), 404, "RPG_CAMPAIGN_NOT_FOUND"],
    [new CampaignExportLimitError(), 422, "RPG_CAMPAIGN_EXPORT_LIMIT_EXCEEDED"],
    [new Error("private path /secret"), 500, "RPG_INTERNAL_ERROR"],
  ])("maps read failures without leaks", async (error, status, code) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const { app, repo } = setup();
    repo.readCampaignExport.mockImplementation(() => { throw error; });
    const response = await app.inject({ method: "GET",
      url: "/api/rpg/v1/campaigns/campaign/export?includeMessages=false" });
    expect(response.json()).toMatchObject({ status, code, instance: "/api/rpg/v1/campaigns/:campaignId/export" });
    expect(response.body).not.toContain("private path");
    expect(response.body).not.toContain("reconcile");
    await app.close();
  });
});
