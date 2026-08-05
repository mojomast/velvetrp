import {
  MECHANICS_STARTER_ID,
  MECHANICS_STARTER_IDENTITY,
  type CampaignAdministration,
  type CampaignCatalogResolutionReport,
  type CampaignDetail,
} from "@velvet/contracts";
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";
import {
  createMechanicsStarterSetupService,
  MechanicsStarterSetupConflictError,
  MechanicsStarterSetupUnavailableError,
  MECHANICS_STARTER_SETUP_IDEMPOTENCY_KEY,
} from "../src/content/mechanicsStarterSetup.js";
import { createOriginalStarterSetupService } from "../src/content/originalStarterSetup.js";
import {
  ContentCatalogStaleError,
  createRepository,
  MECHANICS_STARTER_CATALOG,
} from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const unconfigured: CampaignDetail = {
  id: "campaign-one", name: "One", actorRole: "owner",
  createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-01T00:00:00.000Z",
  content: { status: "unconfigured" },
};
const exact: CampaignDetail = {
  ...unconfigured,
  updatedAt: "2030-01-01T00:00:01.000Z",
  content: {
    status: "configured",
    rulesProfileId: MECHANICS_STARTER_IDENTITY.rulesProfileId,
    contentPacks: [{
      packId: MECHANICS_STARTER_IDENTITY.packId,
      packVersion: MECHANICS_STARTER_IDENTITY.packVersion,
    }],
  },
};
const resolution: CampaignCatalogResolutionReport = {
  campaignId: exact.id, compatible: true,
  rulesProfileId: MECHANICS_STARTER_IDENTITY.rulesProfileId,
  contentPacks: [{
    packId: MECHANICS_STARTER_IDENTITY.packId,
    packVersion: MECHANICS_STARTER_IDENTITY.packVersion,
    digest: MECHANICS_STARTER_CATALOG.manifest.digest,
  }],
  issues: [],
};

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
  vi.restoreAllMocks();
});

function serviceRepository(details: CampaignDetail[] = [exact]) {
  let position = 0;
  const calls: string[] = [];
  const snapshot = {
    getCampaignDetail: vi.fn(() => details[Math.min(position++, details.length - 1)]!),
    getCampaignAdministration: vi.fn((): CampaignAdministration => ({
      id: exact.id, actorRole: "owner", revision: 7, status: "draft",
      activeTimelineId: "timeline-one", updatedAt: unconfigured.updatedAt,
      settings: { maxPlayers: 6, allowPlayerDice: true, safetyMode: "standard", recapVisibility: "members", gmNotes: "" },
    })),
    resolveCampaignCatalog: vi.fn(() => details[Math.min(Math.max(position - 1, 0), details.length - 1)]?.content.status === "configured"
      ? resolution : null),
  };
  const repository = {
    snapshot,
    calls,
    transaction: vi.fn(<T>(callback: (value: typeof snapshot) => T) => {
      calls.push("snapshot:start");
      try { return callback(snapshot); } finally { calls.push("snapshot:end"); }
    }),
    installMechanicsStarterCatalog: vi.fn(() => { calls.push("install"); return {} as never; }),
    configureMechanicsStarterCatalog: vi.fn(() => { calls.push("configure"); return {} as never; }),
  };
  return repository as typeof repository & import("../src/content/mechanicsStarterSetup.js").MechanicsStarterSetupRepository;
}

describe("mechanics starter setup service", () => {
  it("converges exact active state without writes", () => {
    const repository = serviceRepository();
    expect(createMechanicsStarterSetupService(repository).setup(exact.id)).toEqual(exact);
    expect(repository.installMechanicsStarterCatalog).not.toHaveBeenCalled();
    expect(repository.configureMechanicsStarterCatalog).not.toHaveBeenCalled();
  });

  it("owns observed revision/idempotency and performs install then configure then proof", () => {
    const repository = serviceRepository([unconfigured, exact]);
    expect(createMechanicsStarterSetupService(repository).setup(exact.id)).toEqual(exact);
    expect(repository.installMechanicsStarterCatalog).toHaveBeenCalledWith("local-owner");
    expect(repository.configureMechanicsStarterCatalog).toHaveBeenCalledWith("local-owner", exact.id, {
      expectedRevision: 7,
      idempotencyKey: MECHANICS_STARTER_SETUP_IDEMPOTENCY_KEY,
    });
    expect(repository.installMechanicsStarterCatalog).toHaveBeenCalledOnce();
    expect(repository.configureMechanicsStarterCatalog).toHaveBeenCalledOnce();
    expect(repository.snapshot.getCampaignDetail).toHaveBeenCalledTimes(2);
    expect(repository.transaction).toHaveBeenCalledTimes(2);
    expect(repository.calls).toEqual([
      "snapshot:start", "snapshot:end", "install", "configure", "snapshot:start", "snapshot:end",
    ]);
  });

  it("classifies authoritative final state after failures and never retries", () => {
    const committed = serviceRepository([unconfigured, exact]);
    vi.mocked(committed.configureMechanicsStarterCatalog).mockImplementation(() => { throw new Error("lost response"); });
    expect(createMechanicsStarterSetupService(committed).setup(exact.id)).toEqual(exact);
    expect(committed.configureMechanicsStarterCatalog).toHaveBeenCalledOnce();

    const stale = serviceRepository([unconfigured, unconfigured]);
    vi.mocked(stale.configureMechanicsStarterCatalog).mockImplementation(() => { throw new ContentCatalogStaleError(); });
    expect(() => createMechanicsStarterSetupService(stale).setup(exact.id)).toThrow(MechanicsStarterSetupConflictError);
    expect(stale.configureMechanicsStarterCatalog).toHaveBeenCalledOnce();
  });

  it("keeps unavailable and every other configuration stable without writes", () => {
    const unavailable = serviceRepository([{ ...unconfigured, actorRole: "gm" }]);
    expect(() => createMechanicsStarterSetupService(unavailable).setup(exact.id))
      .toThrow(MechanicsStarterSetupUnavailableError);
    const other = serviceRepository([{ ...exact, content: { status: "configured", rulesProfileId: "other:rules",
      contentPacks: [{ packId: "other:pack", packVersion: "1" }] } }]);
    expect(() => createMechanicsStarterSetupService(other).setup(exact.id))
      .toThrow(MechanicsStarterSetupConflictError);
    expect(unavailable.installMechanicsStarterCatalog).not.toHaveBeenCalled();
    expect(other.installMechanicsStarterCatalog).not.toHaveBeenCalled();
  });
});

describe("mechanics starter setup repository integration", () => {
  it("activates a fresh campaign through the real HTTP route", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const repository = createRepository();
    const campaign = repository.createCampaign("local-owner", { name: "HTTP mechanics" });
    const app = buildApp({ campaignRepositoryFactory: () => repository });
    const response = await app.inject({
      method: "PUT",
      url: `/api/rpg/v1/campaigns/${campaign.id}/mechanics-starter-setup`,
      headers: { "content-type": "application/json", "x-request-id": "mechanics-real-route" },
      payload: { starterId: MECHANICS_STARTER_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().campaign).toMatchObject({
      id: campaign.id,
      actorRole: "owner",
      content: {
        status: "configured",
        rulesProfileId: MECHANICS_STARTER_IDENTITY.rulesProfileId,
        contentPacks: [{ packId: MECHANICS_STARTER_IDENTITY.packId, packVersion: MECHANICS_STARTER_IDENTITY.packVersion }],
      },
    });
    await app.close();
  });

  it("activates only a fresh campaign, persists one revision, and then converges", () => {
    const repository = createRepository();
    const campaign = repository.createCampaign("local-owner", { name: "Mechanics" });
    const service = createMechanicsStarterSetupService(repository);
    expect(service.setup(campaign.id).content).toEqual(exact.content);
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    expect(db.prepare("SELECT administration_revision FROM campaigns WHERE id=?").get(campaign.id))
      .toEqual({ administration_revision: 1 });
    const counts = db.prepare(`SELECT
      (SELECT count(*) FROM rpg_content_pack_publications) publications,
      (SELECT count(*) FROM campaign_catalog_commands WHERE campaign_id=?) commands`).get(campaign.id);
    expect(service.setup(campaign.id).content).toEqual(exact.content);
    expect(db.prepare(`SELECT
      (SELECT count(*) FROM rpg_content_pack_publications) publications,
      (SELECT count(*) FROM campaign_catalog_commands WHERE campaign_id=?) commands`).get(campaign.id)).toEqual(counts);
    db.close();
    repository.close();
  });

  it("does not replace either original-starter or mechanics configuration", () => {
    const repository = createRepository();
    const originalCampaign = repository.createCampaign("local-owner", { name: "Original" });
    createOriginalStarterSetupService(repository).setup(originalCampaign.id);
    expect(() => createMechanicsStarterSetupService(repository).setup(originalCampaign.id))
      .toThrow(MechanicsStarterSetupConflictError);

    const mechanicsCampaign = repository.createCampaign("local-owner", { name: "Mechanics" });
    createMechanicsStarterSetupService(repository).setup(mechanicsCampaign.id);
    expect(repository.inspectOriginalStarterSetup("local-owner", mechanicsCampaign.id)).toEqual({ status: "conflict" });
    repository.close();
  });
});

function routeRepository() {
  const repository = {
    listCampaigns: vi.fn(() => []),
    getCampaignDetail: vi.fn(() => exact),
    getCampaignAdministration: vi.fn(),
    resolveCampaignCatalog: vi.fn(() => resolution),
    installMechanicsStarterCatalog: vi.fn(),
    configureMechanicsStarterCatalog: vi.fn(),
    createCampaign: vi.fn(() => ({} as never)),
    getCampaignCharacterCreationOptions: vi.fn(() => null),
    getCampaignCharacterRoster: vi.fn(() => null),
    getCampaignCharacterWorkspace: vi.fn(() => null),
    createOriginalStarterCampaignCharacter: vi.fn(() => ({} as never)),
    renameCampaignIfUnchanged: vi.fn(() => ({} as never)),
    close: vi.fn(),
  } satisfies CampaignListRepository;
  return Object.assign(repository, {
    transaction<T>(callback: (snapshot: any) => T): T { return callback(repository); },
  });
}

describe("PUT /api/rpg/v1/campaigns/:id/mechanics-starter-setup", () => {
  it("requires both flags before validation or lazy repository opening", async () => {
    const repository = routeRepository();
    const factory = vi.fn(() => repository);
    const invalid = "/api/rpg/v1/campaigns/invalid%20id/mechanics-starter-setup?";
    let app = buildApp({ campaignRepositoryFactory: factory });
    let denied = await app.inject({ method: "PUT", url: invalid, payload: "{", headers: { "content-type": "text/plain" } });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().instance).toBe("/api/rpg/v1/campaigns/:campaignId/mechanics-starter-setup");
    await app.close();
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    app = buildApp({ campaignRepositoryFactory: factory });
    denied = await app.inject({ method: "PUT", url: invalid, payload: "{", headers: { "content-type": "text/plain" } });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().instance).toBe("/api/rpg/v1/campaigns/:campaignId/mechanics-starter-setup");
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("is strict, query-free including bare ?, fixed-local, no-store, correlated, and HEAD-disabled", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const repository = routeRepository();
    const factory = vi.fn(() => repository);
    const app = buildApp({ campaignRepositoryFactory: factory });
    const url = "/api/rpg/v1/campaigns/campaign-one/mechanics-starter-setup";
    const success = await app.inject({ method: "PUT", url, headers: {
      "content-type": "application/json", "x-request-id": "mechanics-setup-request", "x-principal-id": "spoof",
    }, payload: { starterId: MECHANICS_STARTER_ID } });
    expect(success.statusCode).toBe(200);
    expect(success.headers).toMatchObject({
      "cache-control": "no-store", "x-request-id": "mechanics-setup-request",
    });
    expect(success.headers.location).toBeUndefined();
    expect(success.json()).toEqual({ campaign: exact });
    expect(repository.getCampaignDetail).toHaveBeenCalledWith("local-owner", "campaign-one");

    // Fastify's in-process injector normalizes a bare trailing `?` away. The
    // route deliberately checks raw.url.includes("?") for real HTTP targets;
    // exercise the equivalent non-empty raw query here.
    for (const suffix of ["?x=1"]) {
      const response = await app.inject({ method: "PUT", url: url + suffix,
        headers: { "content-type": "application/json" }, payload: { starterId: MECHANICS_STARTER_ID } });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json().instance).toBe("/api/rpg/v1/campaigns/:campaignId/mechanics-starter-setup");
    }
    for (const body of [{}, { starterId: "other" }, { starterId: MECHANICS_STARTER_ID, expectedRevision: 0 }]) {
      expect((await app.inject({ method: "PUT", url, headers: { "content-type": "application/json" }, payload: body })).statusCode)
        .toBe(400);
    }
    expect((await app.inject({ method: "HEAD", url })).statusCode).toBe(404);
    expect(factory).toHaveBeenCalledOnce();
    await app.close();
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it("enforces query, path, media, then body order and redacts failures", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const repository = routeRepository();
    const factory = vi.fn(() => repository);
    const app = buildApp({ campaignRepositoryFactory: factory });
    const base = "/api/rpg/v1/campaigns/campaign-one/mechanics-starter-setup";
    const query = await app.inject({ method: "PUT", url: `${base}?x=1`, payload: "{", headers: { "content-type": "text/plain" } });
    expect(query.statusCode).toBe(400);
    expect(query.json().instance).toBe("/api/rpg/v1/campaigns/:campaignId/mechanics-starter-setup");
    const invalidPath = await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/invalid%20id/mechanics-starter-setup",
      payload: "{", headers: { "content-type": "text/plain" } });
    expect(invalidPath.statusCode).toBe(404);
    expect(invalidPath.json().instance).toBe("/api/rpg/v1/campaigns/:campaignId/mechanics-starter-setup");
    expect((await app.inject({ method: "PUT", url: base, payload: "{", headers: { "content-type": "text/plain" } })).statusCode).toBe(415);
    const invalidBody = await app.inject({ method: "PUT", url: base, payload: "{", headers: { "content-type": "application/json" } });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json().instance).toBe("/api/rpg/v1/campaigns/:campaignId/mechanics-starter-setup");
    expect(factory).not.toHaveBeenCalled();
    expect(repository.installMechanicsStarterCatalog).not.toHaveBeenCalled();
    expect(repository.configureMechanicsStarterCatalog).not.toHaveBeenCalled();
    repository.getCampaignDetail.mockImplementation(() => { throw new Error("private /tmp/velvet.sqlite"); });
    const failed = await app.inject({ method: "PUT", url: base, payload: { starterId: MECHANICS_STARTER_ID },
      headers: { "content-type": "application/json", "x-request-id": "mechanics-redacted" } });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR", requestId: "mechanics-redacted",
      instance: "/api/rpg/v1/campaigns/:campaignId/mechanics-starter-setup" });
    expect(failed.body).not.toContain("sqlite");
    await app.close();
  });
});
