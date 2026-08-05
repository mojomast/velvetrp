import { afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { buildApp } from "../src/app.js";
import type { CampaignCharacterWorkspaceSnapshot } from "../src/repo/index.js";

process.env.NODE_ENV = "test";

const snapshot: CampaignCharacterWorkspaceSnapshot = {
  campaignId: "campaign-one",
  campaignCharacterId: "character-one",
  character: {
    name: "Aria",
    race: { name: "Human", description: "Adaptable" },
    background: { name: "Sage", description: "Learned" },
    classes: [{ name: "Fighter", description: "Martial", level: 2 }],
    attributes: [{ label: "Attribute 1", value: 12 }],
    proficiencies: [{ category: "skill", label: "Skill proficiency 1" }],
    choices: [{ label: "Choice 1", selection: {
      kind: "ability", name: "Focus", description: "Concentrate",
    } }],
    resources: [{ label: "Resource 1", current: 3, max: 5 }],
  },
};

function repository(result: CampaignCharacterWorkspaceSnapshot | null = snapshot) {
  return {
    listCampaigns: vi.fn(() => []),
    getCampaignDetail: vi.fn(() => null),
    createCampaign: vi.fn(() => { throw new Error("unused"); }),
    getCampaignCharacterCreationOptions: vi.fn(() => null),
    getCampaignCharacterRoster: vi.fn(() => null),
    getCampaignCharacterWorkspace: vi.fn(() => result),
    createOriginalStarterCampaignCharacter: vi.fn(() => { throw new Error("unused"); }),
    renameCampaignIfUnchanged: vi.fn(() => { throw new Error("unused"); }),
    close: vi.fn(),
  };
}

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  vi.restoreAllMocks();
});

describe("GET /api/rpg/v1/campaigns/:campaignId/characters/:campaignCharacterId/workspace", () => {
  it("feature-gates first and delegates once only as fixed local-owner", async () => {
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    const disabled = await app.inject({
      method: "GET", url: "/api/rpg/v1/campaigns/campaign-one/characters/character-one/workspace?secret=x",
    });
    expect(disabled.statusCode).toBe(404);
    expect(disabled.headers["cache-control"]).toBe("no-store");
    expect(disabled.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND" });
    expect(factory).not.toHaveBeenCalled();

    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const response = await app.inject({
      method: "GET",
      url: "/api/rpg/v1/campaigns/campaign-one/characters/character-one/workspace",
      headers: { authorization: "Bearer attacker", "x-principal-id": "attacker", "x-request-id": "workspace-ok" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toBe("workspace-ok");
    expect(response.json()).toEqual({ character: snapshot.character });
    expect(response.body).not.toMatch(/campaign-one|character-one|controller|private/i);
    expect(repo.getCampaignCharacterWorkspace).toHaveBeenCalledOnce();
    expect(repo.getCampaignCharacterWorkspace).toHaveBeenCalledWith(
      "local-owner", "campaign-one", "character-one",
    );
    await app.close();
    expect(repo.close).toHaveBeenCalledOnce();
  });

  it("rejects raw query delimiters and strictly normalizes either malformed ID", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const url of [
      "/api/rpg/v1/campaigns/campaign-one/characters/character-one/workspace?actor=attacker",
      "/api/rpg/v1/campaigns/campaign-one/characters/character-one/workspace?unused=",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "RPG_INVALID_REQUEST",
        detail: "Campaign character workspace does not accept query parameters",
        instance: "/api/rpg/v1/campaigns/:campaignId/characters/:campaignCharacterId/workspace",
      });
    }
    for (const url of [
      "/api/rpg/v1/campaigns/bad%20campaign/characters/character-one/workspace",
      "/api/rpg/v1/campaigns/campaign-one/characters/bad%20character/workspace",
      `/api/rpg/v1/campaigns/campaign-one/characters/${"c".repeat(129)}/workspace`,
      `/api/rpg/v1/campaigns/${"c".repeat(129)}/characters/character-one/workspace`,
      "/api/rpg/v1/campaigns/%zz/characters/character-one/workspace",
      "/api/rpg/v1/campaigns/campaign-one/characters/%zz/workspace",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.headers["cache-control"], url).toBe("no-store");
      expect(response.json()).toMatchObject({
        code: "RPG_CAMPAIGN_CHARACTER_NOT_FOUND",
        detail: "Campaign character not found",
        instance: "/api/rpg/v1/campaigns/:campaignId/characters/:campaignCharacterId/workspace",
      });
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([false, true])("preserves a bare query delimiter over real HTTP with enabled=%s", async (enabled) => {
    if (enabled) process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: address.port, method: "GET",
        path: "/api/rpg/v1/campaigns/campaign-one/characters/character-one/workspace?",
        headers: { "x-request-id": `workspace-bare-${enabled}` },
      }, (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => { body += chunk; });
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
      });
      request.on("error", reject);
      request.end();
    });
    expect(response.status).toBe(enabled ? 400 : 404);
    expect(JSON.parse(response.body)).toMatchObject({
      code: enabled ? "RPG_INVALID_REQUEST" : "RPG_ROUTE_NOT_FOUND",
      requestId: `workspace-bare-${enabled}`,
    });
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps literal null alone to the same non-disclosing character 404", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository(null);
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "GET", url: "/api/rpg/v1/campaigns/campaign-one/characters/missing/workspace",
      headers: { "x-request-id": "workspace-missing" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "RPG_CAMPAIGN_CHARACTER_NOT_FOUND", requestId: "workspace-missing",
      error: "Campaign character not found",
    });
    await app.close();
  });

  it.each(["throw", "falsey", "wrong-campaign", "wrong-character", "private-output"] as const)(
    "redacts %s repository/output failures as neutral 500",
    async (kind) => {
      process.env.FEATURE_RPG_CAMPAIGN = "true";
      const repo = repository();
      if (kind === "throw") repo.getCampaignCharacterWorkspace.mockImplementation(() => {
        throw new Error("private sqlite /secret/path");
      });
      if (kind === "falsey") repo.getCampaignCharacterWorkspace.mockReturnValue(false as never);
      if (kind === "wrong-campaign") repo.getCampaignCharacterWorkspace.mockReturnValue({
        ...snapshot, campaignId: "private-other-campaign",
      });
      if (kind === "wrong-character") repo.getCampaignCharacterWorkspace.mockReturnValue({
        ...snapshot, campaignCharacterId: "private-other-character",
      });
      if (kind === "private-output") repo.getCampaignCharacterWorkspace.mockReturnValue({
        ...snapshot, character: { ...snapshot.character, privateNotes: "private-output-secret" } as never,
      });
      const app = buildApp({ campaignRepositoryFactory: () => repo });
      const response = await app.inject({
        method: "GET", url: "/api/rpg/v1/campaigns/campaign-one/characters/character-one/workspace",
        headers: { "x-request-id": `workspace-${kind}` },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        code: "RPG_INTERNAL_ERROR", requestId: `workspace-${kind}`,
        error: "Campaign character workspace could not be loaded",
      });
      expect(response.body).not.toMatch(/secret|private-other/);
      await app.close();
    },
  );

  it("keeps HEAD and unsupported methods absent and shares the cached repository", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method, url: "/api/rpg/v1/campaigns/campaign-one/characters/character-one/workspace",
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND" });
    }
    expect(factory).not.toHaveBeenCalled();
    await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" });
    await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign-one/characters/character-one/workspace" });
    expect(factory).toHaveBeenCalledOnce();
    await app.close();
    expect(repo.close).toHaveBeenCalledOnce();
  });

  it("does not broaden malformed normalization to workspace lookalikes", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    for (const path of [
      "/api/rpg/v1/campaigns/%zz/characters/character-one/Workspace",
      "/api/rpg/v1/campaigns/%zz/characters/character-one/workspaces",
      "/api/rpg/v1/campaigns/%zz/character/character-one/workspace",
    ]) {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(400);
      expect(response.headers["content-type"]).toBe("application/json");
      expect(response.json()).toEqual({
        error: "Bad Request", code: "FST_ERR_BAD_URL", message: "Request URL is invalid", statusCode: 400,
      });
    }
    await app.close();
  });
});
