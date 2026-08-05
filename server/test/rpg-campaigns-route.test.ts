import type { Campaign, CampaignAccess, CampaignDetail } from "@velvet/contracts";
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  CampaignCreationAuthorizationError,
  CampaignCreationIdCollisionError,
  CampaignRenameStaleError,
  CampaignRenameUnavailableError,
  createRepository,
} from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const olderCampaign: CampaignAccess = {
  id: "campaign-older",
  name: "Older campaign",
  activeTimelineId: "timeline-older",
  ownerPrincipalId: "local-owner",
  actorRole: "owner",
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-03T00:00:00.000Z",
};

const newerCampaign: CampaignAccess = {
  id: "campaign-newer",
  name: "Newer campaign",
  activeTimelineId: "timeline-newer",
  ownerPrincipalId: "another-owner",
  actorRole: "player",
  createdAt: "2030-01-02T00:00:00.000Z",
  updatedAt: "2030-01-04T00:00:00.000Z",
};

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  vi.restoreAllMocks();
});

function repository(campaigns: CampaignAccess[] = []) {
  return {
    listCampaigns: vi.fn(() => campaigns),
    getCampaignDetail: vi.fn((_actor: string, campaignId: string): CampaignDetail | null => ({
      id: campaignId,
      name: "Campaign detail",
      actorRole: "owner",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-03T00:00:00.000Z",
      content: { status: "unconfigured" },
    })),
    createCampaign: vi.fn((_actor: string, input: { name: string }): Campaign => ({
      id: "campaign-created", name: input.name, activeTimelineId: "timeline-created",
      ownerPrincipalId: "local-owner", createdAt: "2030-01-05T00:00:00.000Z", updatedAt: "2030-01-05T00:00:00.000Z",
    })),
    getCampaignCharacterCreationOptions: vi.fn(() => null),
    getCampaignCharacterRoster: vi.fn(() => null),
    getCampaignCharacterWorkspace: vi.fn(() => null),
    createOriginalStarterCampaignCharacter: vi.fn(() => { throw new Error("unused"); }),
    renameCampaignIfUnchanged: vi.fn((_actor: string, campaignId: string, input: { name: string }): Campaign => ({
      id: campaignId, name: input.name, activeTimelineId: "timeline-created",
      ownerPrincipalId: "local-owner", createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-06T00:00:00.000Z",
    })),
    close: vi.fn(),
  };
}

describe("GET /api/rpg/v1/campaigns", () => {
  it("is feature-gated with the existing structured RPG 404", async () => {
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });

    const response = await app.inject({
      method: "GET",
      url: "/api/rpg/v1/campaigns",
      headers: { "x-request-id": "campaign-disabled" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      code: "RPG_ROUTE_NOT_FOUND",
      requestId: "campaign-disabled",
      error: "RPG route not found",
    });
    expect(repo.listCampaigns).not.toHaveBeenCalled();
    await app.close();
  });

  it("delegates once with literal local-owner and preserves repository order", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository([newerCampaign, olderCampaign]);
    const app = buildApp({ campaignRepositoryFactory: () => repo });

    const response = await app.inject({
      method: "GET",
      url: "/api/rpg/v1/campaigns",
      headers: {
        "x-request-id": "campaign-list",
        authorization: "Bearer remote-principal",
        "x-principal-id": "application_owner",
        "x-user-id": "spoofed-user",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("campaign-list");
    expect(response.json()).toEqual({ campaigns: [newerCampaign, olderCampaign] });
    expect(repo.listCampaigns).toHaveBeenCalledOnce();
    expect(repo.listCampaigns).toHaveBeenCalledWith("local-owner");
    await app.close();
  });

  it("rejects every query parameter before repository access", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });

    for (const url of [
      "/api/rpg/v1/campaigns?principalId=other",
      "/api/rpg/v1/campaigns?actor=local-owner",
      "/api/rpg/v1/campaigns?unused=",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": "invalid-query" } });
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({
        code: "RPG_INVALID_REQUEST",
        requestId: "invalid-query",
        error: "Campaign list does not accept query parameters",
      });
    }
    expect(repo.listCampaigns).not.toHaveBeenCalled();
    await app.close();
  });

  it("redacts repository and response-validation failures behind a generic structured 500", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const secret = "sqlite path /private/velvet.sqlite";
    const repo = repository();
    repo.listCampaigns.mockImplementation(() => { throw new Error(secret); });
    const app = buildApp({ campaignRepositoryFactory: () => repo });

    const response = await app.inject({
      method: "GET",
      url: "/api/rpg/v1/campaigns",
      headers: { "x-request-id": "campaign-failure" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      code: "RPG_INTERNAL_ERROR",
      requestId: "campaign-failure",
      error: "Campaigns could not be loaded",
    });
    expect(response.body).not.toContain(secret);
    await app.close();
  });

  it("redacts malformed repository output as a request-correlated problem response", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const secret = "private malformed repository value";
    const repo = repository([{ ...olderCampaign, actorRole: secret } as unknown as CampaignAccess]);
    const app = buildApp({ campaignRepositoryFactory: () => repo });

    const response = await app.inject({
      method: "GET",
      url: "/api/rpg/v1/campaigns",
      headers: { "x-request-id": "malformed-campaign-output" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.headers["x-request-id"]).toBe("malformed-campaign-output");
    expect(response.json()).toMatchObject({
      code: "RPG_INTERNAL_ERROR",
      requestId: "malformed-campaign-output",
      error: "Campaigns could not be loaded",
    });
    expect(response.body).not.toContain(secret);
    await app.close();
  });

  it("redacts repository factory failures without creating a connection per retry", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => { throw new Error("private factory detail"); });
    const app = buildApp({ campaignRepositoryFactory: factory });

    const first = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" });
    const second = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" });
    expect(first.statusCode).toBe(500);
    expect(second.statusCode).toBe(500);
    expect(first.body).not.toContain("private factory detail");
    expect(second.body).not.toContain("private factory detail");
    expect(first.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR" });
    expect(second.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR" });
    expect(factory).toHaveBeenCalledOnce();
    await app.close();
  });

  it("does not synthesize HEAD or initialize the repository for HEAD requests", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });

    const response = await app.inject({
      method: "HEAD",
      url: "/api/rpg/v1/campaigns",
      headers: { "x-request-id": "campaign-head" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.headers["x-request-id"]).toBe("campaign-head");
    expect(response.json()).toMatchObject({
      status: 404,
      code: "RPG_ROUTE_NOT_FOUND",
      requestId: "campaign-head",
      error: "RPG route not found",
    });
    expect(factory).not.toHaveBeenCalled();
    expect(repo.listCampaigns).not.toHaveBeenCalled();
    await app.close();
  });

  it("creates one app-owned repository and closes it once", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });

    await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" });
    await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" });
    expect(factory).toHaveBeenCalledOnce();

    await app.close();
    expect(repo.close).toHaveBeenCalledOnce();
  });
});

describe("GET /api/rpg/v1/campaigns/:campaignId", () => {
  it("is feature-gated and validates the strict path before repository creation", async () => {
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    const disabled = await app.inject({
      method: "GET", url: "/api/rpg/v1/campaigns/campaign-one", headers: { "x-request-id": "detail-disabled" },
    });
    expect(disabled.statusCode).toBe(404);
    expect(disabled.headers["cache-control"]).toBe("no-store");
    expect(disabled.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", requestId: "detail-disabled" });
    const disabledMalformed = await app.inject({
      method: "GET", url: "/api/rpg/v1/campaigns/%zz", headers: { "x-request-id": "detail-disabled-malformed" },
    });
    expect(disabledMalformed.statusCode).toBe(404);
    expect(disabledMalformed.headers["cache-control"]).toBe("no-store");
    expect(disabledMalformed.headers["content-type"]).toContain("application/problem+json");
    expect(disabledMalformed.headers["x-request-id"]).toBe("detail-disabled-malformed");
    expect(disabledMalformed.json()).toMatchObject({
      code: "RPG_ROUTE_NOT_FOUND", requestId: "detail-disabled-malformed",
    });

    process.env.FEATURE_RPG_CAMPAIGN = "true";
    for (const url of ["/api/rpg/v1/campaigns/invalid%20campaign"]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": "detail-invalid-path" } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ code: "RPG_CAMPAIGN_NOT_FOUND", requestId: "detail-invalid-path" });
    }
    const invalidRouterPaths = [
      [`/api/rpg/v1/campaigns/${"x".repeat(129)}`, "detail-oversized"],
      ["/api/rpg/v1/campaigns/%zz", "detail-invalid-percent"],
    ] as const;
    for (const [url, requestId] of invalidRouterPaths) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": requestId } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["x-request-id"]).toBe(requestId);
      expect(response.json()).toMatchObject({
        status: 404,
        code: "RPG_CAMPAIGN_NOT_FOUND",
        requestId,
        error: "Campaign not found",
      });
    }
    expect(factory).not.toHaveBeenCalled();
    expect(repo.getCampaignDetail).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps router failures raw for legacy and malformed unknown RPG paths", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });

    const legacyLong = `/api/characters/${"x".repeat(129)}`;
    const legacyResponse = await app.inject({
      method: "GET", url: legacyLong, headers: { "x-request-id": "legacy-long" },
    });
    expect(legacyResponse.statusCode).toBe(414);
    expect(legacyResponse.headers["content-type"]).toBe("application/json");
    expect(legacyResponse.headers["x-request-id"]).toBeUndefined();
    expect(legacyResponse.json()).toEqual({
      error: "Bad Request",
      code: "FST_ERR_MAX_PARAM_LENGTH",
      message: "Request URL exceeds the routing limit",
      statusCode: 414,
    });

    const unknownResponse = await app.inject({
      method: "GET", url: "/api/rpg/v1/unknown/%zz", headers: { "x-request-id": "unknown-bad-url" },
    });
    expect(unknownResponse.statusCode).toBe(400);
    expect(unknownResponse.headers["content-type"]).toBe("application/json");
    expect(unknownResponse.headers["x-request-id"]).toBeUndefined();
    expect(unknownResponse.json()).toEqual({
      error: "Bad Request",
      code: "FST_ERR_BAD_URL",
      message: "Request URL is invalid",
      statusCode: 400,
    });
    expect(repo.getCampaignDetail).not.toHaveBeenCalled();
    await app.close();
  });

  it("retains the approved global 128-character router cap for legacy parameters", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });

    for (const length of [101, 128]) {
      const response = await app.inject({ method: "GET", url: `/api/characters/${"x".repeat(length)}` });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "character not found" });
    }
    const validRpgId = "r".repeat(128);
    const validRpg = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${validRpgId}` });
    expect(validRpg.statusCode).toBe(200);
    expect(repo.getCampaignDetail).toHaveBeenCalledWith("local-owner", validRpgId);

    const overCap = await app.inject({ method: "GET", url: `/api/characters/${"x".repeat(129)}` });
    expect(overCap.statusCode).toBe(414);
    expect(overCap.json()).toMatchObject({ code: "FST_ERR_MAX_PARAM_LENGTH", statusCode: 414 });
    await app.close();
  });

  it("prioritizes query rejection for malformed exact resource routes without leaking secrets", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    const secret = "router-query-secret";
    const payload = { name: "Road", expectedUpdatedAt: "2030-01-03T00:00:00.000Z" };
    const routes = [
      ["GET", "/api/rpg/v1/campaigns/%zz", "Campaign detail does not accept query parameters"],
      ["GET", `/api/rpg/v1/campaigns/${"x".repeat(129)}`, "Campaign detail does not accept query parameters"],
      ["PATCH", "/api/rpg/v1/campaigns/%zz", "Campaign rename does not accept query parameters"],
      ["PATCH", `/api/rpg/v1/campaigns/${"x".repeat(129)}`, "Campaign rename does not accept query parameters"],
      ["PUT", "/api/rpg/v1/campaigns/%zz/starter-setup", "Starter setup does not accept query parameters"],
      ["PUT", `/api/rpg/v1/campaigns/${"x".repeat(129)}/starter-setup`, "Starter setup does not accept query parameters"],
      ["GET", "/api/rpg/v1/campaigns/%zz/characters/creation-options", "Campaign character creation options do not accept query parameters"],
      ["GET", `/api/rpg/v1/campaigns/${"x".repeat(129)}/characters/creation-options`, "Campaign character creation options do not accept query parameters"],
      ["GET", "/api/rpg/v1/campaigns/%zz/characters", "Campaign character roster does not accept query parameters"],
      ["GET", `/api/rpg/v1/campaigns/${"x".repeat(129)}/characters`, "Campaign character roster does not accept query parameters"],
    ] as const;

    for (const [method, path, detail] of routes) {
      const response = await app.inject({
        method,
        url: `${path}?token=${secret}`,
        ...(method === "PATCH" || method === "PUT" ? { payload } : {}),
        headers: { "x-request-id": "router-query" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({
        code: "RPG_INVALID_REQUEST",
        requestId: "router-query",
        detail,
        instance: path.replace(/\/campaigns\/[^/]+/, "/campaigns/:campaignId"),
      });
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain("?token=");
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps feature denial first and query-free for malformed exact resource routes", async () => {
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    const secret = "disabled-router-secret";
    const response = await app.inject({
      method: "PATCH",
      url: `/api/rpg/v1/campaigns/${"x".repeat(129)}?token=${secret}`,
      payload: {},
      headers: { "x-request-id": "disabled-router-query" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", requestId: "disabled-router-query" });
    expect(response.body).not.toContain(secret);
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("removes raw query data from fallback malformed-router messages", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    const secret = "raw-router-secret";
    for (const [path, statusCode, code, message] of [
      ["/api/rpg/v1/unknown/%zz", 400, "FST_ERR_BAD_URL", "Request URL is invalid"],
      ["/api/rpg/v1/campaigns/%zz/characters/creation_option", 400, "FST_ERR_BAD_URL",
        "Request URL is invalid"],
      [`/api/characters/${"x".repeat(129)}`, 414, "FST_ERR_MAX_PARAM_LENGTH",
        "Request URL exceeds the routing limit"],
    ] as const) {
      const response = await app.inject({ method: "GET", url: `${path}?token=${secret}` });
      expect(response.statusCode).toBe(statusCode);
      expect(response.headers["content-type"]).toBe("application/json");
      expect(response.json()).toEqual({ error: "Bad Request", code, message, statusCode });
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain("?token=");
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("never reflects campaign IDs or invalid path markers in problem instances or raw messages", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.getCampaignDetail.mockReturnValue(null);
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const markers = {
      valid: "instance-valid-marker-71e9",
      invalid: "instance-invalid-marker-42ad",
      malformed: "instance-malformed-marker-3b6f",
      suffix: "instance-lookalike-marker-8c20",
    };
    const cases = [
      ["GET", `/api/rpg/v1/campaigns/${markers.valid}`, "/api/rpg/v1/campaigns/:campaignId"],
      ["GET", `/api/rpg/v1/campaigns/${markers.invalid}%20invalid`, "/api/rpg/v1/campaigns/:campaignId"],
      ["GET", `/api/rpg/v1/campaigns/%zz-${markers.malformed}`, "/api/rpg/v1/campaigns/:campaignId"],
      ["DELETE", `/api/rpg/v1/campaigns/${markers.valid}/${markers.suffix}`, "/api/rpg/v1/campaigns/:campaignId/*"],
    ] as const;
    for (const [method, url, instance] of cases) {
      const response = await app.inject({ method: method as never, url });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ instance });
      for (const marker of Object.values(markers)) expect(response.body).not.toContain(marker);
    }

    const raw = await app.inject({
      method: "GET",
      url: `/api/rpg/v1/campaigns/%zz-${markers.malformed}/${markers.suffix}?query-marker`,
    });
    expect(raw.statusCode).toBe(400);
    expect(raw.json()).toEqual({
      error: "Bad Request", code: "FST_ERR_BAD_URL", message: "Request URL is invalid", statusCode: 400,
    });
    for (const marker of [...Object.values(markers), "query-marker"]) expect(raw.body).not.toContain(marker);
    await app.close();
  });

  it("uses fixed local-owner despite spoof headers and emits the minimal unconfigured contract", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "GET",
      url: "/api/rpg/v1/campaigns/campaign-detail",
      headers: {
        "x-request-id": "detail-success",
        authorization: "Bearer attacker",
        "x-principal-id": "other-owner",
        "x-user-id": "spoofed-user",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBe("detail-success");
    expect(response.json()).toEqual({
      campaign: {
        id: "campaign-detail",
        name: "Campaign detail",
        actorRole: "owner",
        createdAt: "2030-01-01T00:00:00.000Z",
        updatedAt: "2030-01-03T00:00:00.000Z",
        content: { status: "unconfigured" },
      },
    });
    expect(response.body).not.toContain("ownerPrincipalId");
    expect(response.body).not.toContain("activeTimelineId");
    expect(repo.getCampaignDetail).toHaveBeenCalledOnce();
    expect(repo.getCampaignDetail).toHaveBeenCalledWith("local-owner", "campaign-detail");
    await app.close();
  });

  it("preserves configured exact pack order and rejects every query parameter", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.getCampaignDetail.mockReturnValue({
      id: "campaign-detail",
      name: "Configured",
      actorRole: "player",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-03T00:00:00.000Z",
      content: {
        status: "configured",
        rulesProfileId: "rules-one",
        contentPacks: [
          { packId: "pack-z", packVersion: "2" },
          { packId: "pack-a", packVersion: "1" },
        ],
      },
    });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign-detail" });
    expect(response.statusCode).toBe(200);
    expect(response.json().campaign.content.contentPacks).toEqual([
      { packId: "pack-z", packVersion: "2" },
      { packId: "pack-a", packVersion: "1" },
    ]);

    repo.getCampaignDetail.mockClear();
    const queried = await app.inject({
      method: "GET",
      url: "/api/rpg/v1/campaigns/campaign-detail?principalId=attacker",
      headers: { "x-request-id": "detail-query" },
    });
    expect(queried.statusCode).toBe(400);
    expect(queried.headers["cache-control"]).toBe("no-store");
    expect(queried.json()).toMatchObject({
      code: "RPG_INVALID_REQUEST",
      requestId: "detail-query",
      error: "Campaign detail does not accept query parameters",
    });
    expect(repo.getCampaignDetail).not.toHaveBeenCalled();
    await app.close();
  });

  it("masks denied and missing campaigns with the same request-correlated 404", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.getCampaignDetail.mockReturnValue(null);
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "GET", url: "/api/rpg/v1/campaigns/campaign-missing", headers: { "x-request-id": "detail-missing" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toMatchObject({
      code: "RPG_CAMPAIGN_NOT_FOUND", requestId: "detail-missing", error: "Campaign not found",
    });
    await app.close();
  });

  it.each(["repository", "output"] as const)(
    "redacts %s failures behind a generic request-correlated 500",
    async (kind) => {
      process.env.FEATURE_RPG_CAMPAIGN = "true";
      const secret = `private ${kind} campaign detail`;
      const repo = repository();
      if (kind === "repository") {
        repo.getCampaignDetail.mockImplementation(() => { throw new Error(secret); });
      } else {
        repo.getCampaignDetail.mockReturnValue({
          id: "campaign-detail",
          name: secret,
          actorRole: "administrator",
          content: { status: "unconfigured" },
        } as unknown as CampaignDetail);
      }
      const app = buildApp({ campaignRepositoryFactory: () => repo });
      const response = await app.inject({
        method: "GET", url: "/api/rpg/v1/campaigns/campaign-detail", headers: { "x-request-id": `detail-${kind}` },
      });
      expect(response.statusCode).toBe(500);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.json()).toMatchObject({
        code: "RPG_INTERNAL_ERROR", requestId: `detail-${kind}`, error: "Campaign could not be loaded",
      });
      expect(response.body).not.toContain(secret);
      await app.close();
    },
  );

  it("redacts schema-valid detail output bound to a different campaign", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.getCampaignDetail.mockReturnValue({
      id: "campaign-other", name: "Private other campaign", actorRole: "owner",
      createdAt: "2030-01-01T00:00:00.000Z", updatedAt: "2030-01-03T00:00:00.000Z",
      content: { status: "unconfigured" },
    });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign-detail" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR" });
    expect(response.body).not.toContain("campaign-other");
    await app.close();
  });

  it.each(["HEAD", "POST", "PUT", "DELETE"] as const)("does not expose %s and never initializes the repository", async (method) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    const response = await app.inject({
      method, url: "/api/rpg/v1/campaigns/campaign-detail", headers: { "x-request-id": `detail-${method}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["x-request-id"]).toBe(`detail-${method}`);
    expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", requestId: `detail-${method}` });
    expect(factory).not.toHaveBeenCalled();
    expect(repo.getCampaignDetail).not.toHaveBeenCalled();
    await app.close();
  });

  it("shares one cached repository with collection reads and closes it once", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" });
    await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign-detail" });
    expect(factory).toHaveBeenCalledOnce();
    await app.close();
    expect(repo.close).toHaveBeenCalledOnce();
  });
});

describe("PATCH /api/rpg/v1/campaigns/:campaignId", () => {
  const renamePayload = {
    name: "  Renamed road  ",
    expectedUpdatedAt: "2030-01-03T00:00:00.000Z",
  };

  it("uses fixed local-owner and returns only the strict minimal response", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/rpg/v1/campaigns/campaign-detail",
      payload: renamePayload,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": "rename-success",
        authorization: "Bearer attacker",
        "x-principal-id": "other-owner",
        "x-user-id": "spoofed",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("rename-success");
    expect(response.json()).toEqual({
      campaign: {
        id: "campaign-detail",
        name: "Renamed road",
        updatedAt: "2030-01-06T00:00:00.000Z",
      },
    });
    expect(repo.renameCampaignIfUnchanged).toHaveBeenCalledOnce();
    expect(repo.renameCampaignIfUnchanged).toHaveBeenCalledWith("local-owner", "campaign-detail", {
      name: "Renamed road",
      expectedUpdatedAt: "2030-01-03T00:00:00.000Z",
    });
    await app.close();
  });

  it("feature-gates before body parsing and rejects query/media before repository access", async () => {
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const disabled = await app.inject({
      method: "PATCH", url: "/api/rpg/v1/campaigns/campaign-detail", payload: "{",
      headers: { "content-type": "application/json", "x-request-id": "rename-disabled" },
    });
    expect(disabled.statusCode).toBe(404);
    expect(disabled.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", requestId: "rename-disabled" });

    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const query = await app.inject({
      method: "PATCH", url: "/api/rpg/v1/campaigns/campaign-detail?actor=other", payload: renamePayload,
    });
    expect(query.statusCode).toBe(400);
    expect(query.json()).toMatchObject({
      code: "RPG_INVALID_REQUEST", error: "Campaign rename does not accept query parameters",
    });
    for (const contentType of [undefined, "application/problem+json", "application/json; profile=x", "text/json"]) {
      const media = await app.inject({
        method: "PATCH",
        url: "/api/rpg/v1/campaigns/campaign-detail",
        payload: JSON.stringify(renamePayload),
        headers: contentType ? { "content-type": contentType } : {},
      });
      expect(media.statusCode).toBe(415);
      expect(media.json()).toMatchObject({ code: "RPG_UNSUPPORTED_MEDIA_TYPE" });
    }
    expect(repo.renameCampaignIfUnchanged).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["empty", "", "application/json"],
    ["malformed", "{", "application/json"],
    ["missing timestamp", JSON.stringify({ name: "Road" }), "application/json"],
    ["noncanonical timestamp", JSON.stringify({ name: "Road", expectedUpdatedAt: "2030-01-03T00:00:00Z" }), "application/json"],
    ["unknown field", JSON.stringify({ ...renamePayload, extra: true }), "application/json"],
  ])("normalizes %s request bodies to 400 without a rename", async (_label, payload, contentType) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "PATCH", url: "/api/rpg/v1/campaigns/campaign-detail", payload, headers: { "content-type": contentType },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "RPG_INVALID_REQUEST", error: "Campaign rename request is invalid" });
    expect(repo.renameCampaignIfUnchanged).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes ordinary, overlong, invalid-percent, and lookalike paths without repository access", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const [url, code] of [
      ["/api/rpg/v1/campaigns/invalid%20id", "RPG_CAMPAIGN_NOT_FOUND"],
      [`/api/rpg/v1/campaigns/${"x".repeat(129)}`, "RPG_CAMPAIGN_NOT_FOUND"],
      ["/api/rpg/v1/campaigns/%zz", "RPG_CAMPAIGN_NOT_FOUND"],
      ["/api/rpg/v1/campaigns/campaign-detail/rename", "RPG_ROUTE_NOT_FOUND"],
    ] as const) {
      const response = await app.inject({
        method: "PATCH", url, payload: renamePayload, headers: { "x-request-id": "rename-path" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["x-request-id"]).toBe("rename-path");
      expect(response.json()).toMatchObject({ code, requestId: "rename-path" });
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    [new CampaignRenameUnavailableError(), 404, "RPG_CAMPAIGN_NOT_FOUND"],
    [new CampaignRenameStaleError(), 409, "RPG_CAMPAIGN_RENAME_STALE"],
    [new Error("campaign rename requires the campaign owner"), 500, "RPG_INTERNAL_ERROR"],
    [new Error("campaign rename precondition is stale"), 500, "RPG_INTERNAL_ERROR"],
    [new Error("private sqlite path"), 500, "RPG_INTERNAL_ERROR"],
  ])("maps only typed rename failures without leaking details", async (failure, status, code) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.renameCampaignIfUnchanged.mockImplementation(() => { throw failure; });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "PATCH", url: "/api/rpg/v1/campaigns/campaign-detail", payload: renamePayload,
      headers: { "x-request-id": "rename-failure" },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code, requestId: "rename-failure" });
    expect(response.body).not.toContain(failure.message);
    expect(repo.renameCampaignIfUnchanged).toHaveBeenCalledOnce();
    await app.close();
  });

  it.each([
    { id: "bad id", name: "Road", updatedAt: "2030-01-06T00:00:00.000Z" },
    { id: "campaign-detail", name: "Road", updatedAt: "not-a-time" },
  ])("redacts malformed output IDs and timestamps as 500", async (campaign) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.renameCampaignIfUnchanged.mockReturnValue({
      ...campaign,
      activeTimelineId: "timeline-created",
      ownerPrincipalId: "local-owner",
      createdAt: "2030-01-01T00:00:00.000Z",
    });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "PATCH", url: "/api/rpg/v1/campaigns/campaign-detail", payload: renamePayload,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR", error: "Campaign could not be renamed" });
    expect(response.body).not.toContain(campaign.id === "bad id" ? campaign.id : campaign.updatedAt);
    await app.close();
  });

  it.each([
    ["wrong ID", { id: "private-other-campaign", name: "Renamed road", updatedAt: "2030-01-06T00:00:00.000Z" }, "private-other-campaign"],
    ["wrong name", { id: "campaign-detail", name: "Private repository name", updatedAt: "2030-01-06T00:00:00.000Z" }, "Private repository name"],
    ["older timestamp", { id: "campaign-detail", name: "Renamed road", updatedAt: "2030-01-02T00:00:00.000Z" }, "2030-01-02T00:00:00.000Z"],
  ])("redacts schema-valid %s output as a request-correlated 500", async (_label, campaign, privateDetail) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.renameCampaignIfUnchanged.mockReturnValue({
      ...campaign,
      activeTimelineId: "timeline-created",
      ownerPrincipalId: "local-owner",
      createdAt: "2030-01-01T00:00:00.000Z",
    });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/rpg/v1/campaigns/campaign-detail",
      payload: renamePayload,
      headers: { "x-request-id": "rename-semantic-output" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.headers["x-request-id"]).toBe("rename-semantic-output");
    expect(response.json()).toMatchObject({
      code: "RPG_INTERNAL_ERROR",
      requestId: "rename-semantic-output",
      error: "Campaign could not be renamed",
    });
    expect(response.body).not.toContain(privateDetail);
    await app.close();
  });

  it("rejects an equal timestamp because every success must stale the observed token", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.renameCampaignIfUnchanged.mockReturnValue({
      id: "campaign-detail",
      name: "Renamed road",
      activeTimelineId: "timeline-created",
      ownerPrincipalId: "local-owner",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: renamePayload.expectedUpdatedAt,
    });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "PATCH", url: "/api/rpg/v1/campaigns/campaign-detail", payload: renamePayload,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR" });
    await app.close();
  });

  it("keeps HEAD disabled, rejects unsupported methods, and shares one cached repository", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const method of ["HEAD", "POST", "PUT", "DELETE"] as const) {
      const response = await app.inject({ method, url: "/api/rpg/v1/campaigns/campaign-detail" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND" });
    }
    await app.inject({ method: "PATCH", url: "/api/rpg/v1/campaigns/campaign-detail", payload: renamePayload });
    await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign-detail" });
    expect(factory).toHaveBeenCalledOnce();
    await app.close();
    expect(repo.close).toHaveBeenCalledOnce();
  });
});

describe("POST /api/rpg/v1/campaigns", () => {
  it("creates through literal local-owner, validates strictly, and sends no Location", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "POST", url: "/api/rpg/v1/campaigns", payload: { name: "  New road  " },
      headers: { "content-type": "application/json; charset=utf-8", authorization: "Bearer spoof", "x-principal-id": "spoof" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBeUndefined();
    expect(response.json()).toEqual({ campaign: expect.objectContaining({ name: "New road", ownerPrincipalId: "local-owner" }) });
    expect(repo.createCampaign).toHaveBeenCalledWith("local-owner", { name: "New road" });
    await app.close();
  });

  it("is feature-gated before parsing and rejects query or non-exact JSON before repository access", async () => {
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns", payload: "{" })).statusCode).toBe(404);
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns?actor=x", payload: { name: "Road" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns", payload: "{}", headers: { "content-type": "application/problem+json" } })).statusCode).toBe(415);
    expect(repo.createCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["empty", "", "application/json"],
    ["malformed", "{", "application/json"],
    ["schema-invalid", JSON.stringify({ name: " ", extra: true }), "application/json"],
  ])("normalizes %s bodies to a structured 400", async (_label, payload, contentType) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns", payload, headers: { "content-type": contentType } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "RPG_INVALID_REQUEST", error: "Campaign creation request is invalid" });
    expect(repo.createCampaign).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(["missing", "malformed"] as const)(
    "redacts a %s application-owner invariant as 500 without dependencies or writes",
    async (corruption) => {
      process.env.FEATURE_RPG_CAMPAIGN = "true";
      const dataDir = process.env.VELVET_DATA_DIR as string;
      const initial = createRepository({ dataDir });
      initial.close();
      const dbPath = path.join(dataDir, "velvet.sqlite");
      const db = new DatabaseDriver(dbPath);
      if (corruption === "missing") {
        db.exec("DROP TRIGGER application_owner_prevent_delete; DELETE FROM application_owner;");
      } else {
        db.pragma("foreign_keys = OFF");
        db.prepare("UPDATE application_owner SET principal_id = 'malformed owner' WHERE singleton = 1").run();
      }
      db.close();
      const nextId = vi.fn(() => "unused");
      const clockNow = vi.fn(() => new Date("2030-01-01T00:00:00.000Z"));
      const repository = createRepository({ dataDir, ids: { nextId }, clock: { now: clockNow } });
      const app = buildApp({ campaignRepositoryFactory: () => repository });

      const response = await app.inject({
        method: "POST",
        url: "/api/rpg/v1/campaigns",
        payload: { name: "Road" },
        headers: { "x-request-id": `owner-${corruption}` },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        code: "RPG_INTERNAL_ERROR",
        requestId: `owner-${corruption}`,
        error: "Campaign could not be created",
      });
      expect(response.body).not.toContain("application owner invariant");
      expect(nextId).not.toHaveBeenCalled();
      expect(clockNow).not.toHaveBeenCalled();
      const verify = new DatabaseDriver(dbPath, { readonly: true });
      expect((verify.prepare("SELECT COUNT(*) AS count FROM campaigns").get() as { count: number }).count).toBe(0);
      verify.close();
      await app.close();
    },
  );

  it.each([
    [new CampaignCreationAuthorizationError(), 403, "RPG_CAMPAIGN_CREATE_FORBIDDEN"],
    [new CampaignCreationIdCollisionError(), 409, "RPG_CAMPAIGN_CREATE_CONFLICT"],
    [new Error("campaign creation requires the application owner"), 500, "RPG_INTERNAL_ERROR"],
    [new Error("SQLITE_CONSTRAINT_PRIMARYKEY"), 500, "RPG_INTERNAL_ERROR"],
  ])("maps only typed repository failures without leaking details", async (failure, status, code) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.createCampaign.mockImplementation(() => { throw failure; });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns", payload: { name: "Road" } });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    expect(response.body).not.toContain(failure.message);
    await app.close();
  });

  it("maps malformed repository output to the generic redacted 500", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.createCampaign.mockReturnValue({
      id: "private invalid id", name: "Road", activeTimelineId: "timeline-created",
      ownerPrincipalId: "local-owner", createdAt: "2030-01-05T00:00:00.000Z", updatedAt: "2030-01-05T00:00:00.000Z",
    });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns", payload: { name: "Road" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR", error: "Campaign could not be created" });
    expect(response.body).not.toContain("private invalid id");
    await app.close();
  });

  it("shares the one cached lazy repository with GET and leaves HEAD disabled", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns", payload: { name: "Road" } });
    await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" });
    expect((await app.inject({ method: "HEAD", url: "/api/rpg/v1/campaigns" })).statusCode).toBe(404);
    expect(factory).toHaveBeenCalledOnce();
    await app.close();
    expect(repo.close).toHaveBeenCalledOnce();
  });
});
