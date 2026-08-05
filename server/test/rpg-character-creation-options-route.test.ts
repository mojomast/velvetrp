import {
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_PACK,
  ORIGINAL_STARTER_RACE,
  ORIGINAL_STARTER_RULES_PROFILE,
} from "@velvet/contracts";
import type {
  Campaign,
  CampaignAccess,
  CampaignCharacterCreationOptionsResponse,
  CampaignDetail,
} from "@velvet/contracts";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const route = "/api/rpg/v1/campaigns/campaign-one/characters/creation-options";

const creationOptions: CampaignCharacterCreationOptionsResponse = {
  campaignId: "campaign-one",
  personas: [
    { characterId: "persona-z", name: "Zulu", alreadyUsed: true },
    { characterId: "persona-a", name: "Alpha", alreadyUsed: false },
  ],
  starter: {
    rulesProfile: ORIGINAL_STARTER_RULES_PROFILE,
    pack: ORIGINAL_STARTER_PACK,
    race: ORIGINAL_STARTER_RACE,
    background: ORIGINAL_STARTER_BACKGROUND,
    class: { ...ORIGINAL_STARTER_CLASS, level: 1 },
  },
};

function repository(result: CampaignCharacterCreationOptionsResponse | null = creationOptions) {
  return {
    listCampaigns: vi.fn((): CampaignAccess[] => []),
    getCampaignDetail: vi.fn((): CampaignDetail | null => null),
    createCampaign: vi.fn((): Campaign => { throw new Error("unused"); }),
    renameCampaignIfUnchanged: vi.fn((): Campaign => { throw new Error("unused"); }),
    getCampaignCharacterCreationOptions: vi.fn(() => result),
    getCampaignCharacterRoster: vi.fn(() => null),
    getCampaignCharacterWorkspace: vi.fn(() => null),
    createOriginalStarterCampaignCharacter: vi.fn(() => { throw new Error("unused"); }),
    close: vi.fn(),
  };
}

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  vi.restoreAllMocks();
});

describe("GET /api/rpg/v1/campaigns/:campaignId/characters/creation-options", () => {
  it("feature-gates before query, path validation, and repository opening", async () => {
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });

    for (const [url, requestId] of [
      [`${route}?principalId=attacker`, "options-disabled-query"],
      ["/api/rpg/v1/campaigns/invalid%20id/characters/creation-options", "options-disabled-path"],
      ["/api/rpg/v1/campaigns/%zz/characters/creation-options", "options-disabled-percent"],
      [`/api/rpg/v1/campaigns/${"x".repeat(129)}/characters/creation-options`, "options-disabled-long"],
    ] as const) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": requestId } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["x-request-id"]).toBe(requestId);
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", requestId });
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects all query variants before path validation or repository access", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });

    for (const url of [
      `${route}?actor=local-owner`,
      `${route}?unused=`,
      `${route}?x=1&x=2`,
      "/api/rpg/v1/campaigns/invalid%20id/characters/creation-options?x=1",
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": "options-query" } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "RPG_INVALID_REQUEST",
        requestId: "options-query",
        error: "Campaign character creation options do not accept query parameters",
      });
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a bare query delimiter only when enabled without opening the repository", async () => {
    for (const enabled of [false, true]) {
      if (enabled) process.env.FEATURE_RPG_CAMPAIGN = "true";
      else delete process.env.FEATURE_RPG_CAMPAIGN;
      const factory = vi.fn(() => repository());
      const app = buildApp({ campaignRepositoryFactory: factory });
      const requestId = `options-bare-query-${enabled}`;
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("no server address");
      const response = await new Promise<{ body: string; statusCode: number }>((resolve, reject) => {
        const request = httpRequest({
          host: "127.0.0.1",
          port: address.port,
          method: "GET",
          path: `${route}?`,
          headers: { "x-request-id": requestId },
        }, (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => { body += chunk; });
          incoming.on("end", () => resolve({ body, statusCode: incoming.statusCode ?? 0 }));
        });
        request.on("error", reject);
        request.end();
      });

      expect(response.statusCode).toBe(enabled ? 400 : 404);
      expect(JSON.parse(response.body)).toMatchObject({
        code: enabled ? "RPG_INVALID_REQUEST" : "RPG_ROUTE_NOT_FOUND",
        requestId,
      });
      expect(response.body).not.toContain(`${route}?`);
      expect(factory).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it("uses only fixed local-owner, preserves exact order, and emits only safe options", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "GET",
      url: route,
      headers: {
        "x-request-id": "options-success",
        authorization: "Bearer attacker",
        "x-principal-id": "spoofed-principal",
        "x-user-id": "spoofed-user",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("options-success");
    expect(response.json()).toEqual(creationOptions);
    expect(response.json().personas.map((persona: { characterId: string }) => persona.characterId))
      .toEqual(["persona-z", "persona-a"]);
    expect(repo.getCampaignCharacterCreationOptions).toHaveBeenCalledOnce();
    expect(repo.getCampaignCharacterCreationOptions).toHaveBeenCalledWith("local-owner", "campaign-one");
    for (const privateField of [
      "age", "archetype", "boundaries", "fictionalConfirmed", "isRealPerson",
      "controllerPrincipalId", "privateNotes", "sheet", "actor", "ownerPrincipalId", "activeTimelineId",
    ]) expect(response.body).not.toContain(privateField);
    await app.close();
  });

  it("decodes a valid encoded resource ID and binds output to the decoded path", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const result = { ...creationOptions, campaignId: "campaign-one" };
    const repo = repository(result);
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "GET",
      url: "/api/rpg/v1/campaigns/campaign%2Done/characters/creation-options",
    });
    expect(response.statusCode).toBe(200);
    expect(repo.getCampaignCharacterCreationOptions).toHaveBeenCalledWith("local-owner", "campaign-one");
    await app.close();
  });

  it("normalizes invalid, encoded-invalid, overlong, and bad-percent exact paths without opening", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const [url, requestId] of [
      ["/api/rpg/v1/campaigns/invalid%20id/characters/creation-options", "options-invalid"],
      ["/api/rpg/v1/campaigns/%2F/characters/creation-options", "options-encoded-slash"],
      [`/api/rpg/v1/campaigns/${"x".repeat(129)}/characters/creation-options`, "options-long"],
      ["/api/rpg/v1/campaigns/%zz/characters/creation-options", "options-percent"],
    ] as const) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": requestId } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["x-request-id"]).toBe(requestId);
      expect(response.json()).toMatchObject({
        status: 404, code: "RPG_CAMPAIGN_NOT_FOUND", requestId, error: "Campaign not found",
      });
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("preserves raw router behavior for unknown, legacy, and lookalike malformed paths", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const [method, url, status, code] of [
      ["GET", "/api/rpg/v1/campaigns/%zz/characters/creation_option", 400, "FST_ERR_BAD_URL"],
      ["GET", "/api/rpg/v1/campaigns/%zz/characters/creation-options/extra", 400, "FST_ERR_BAD_URL"],
      ["GET", "/api/characters/%zz", 400, "FST_ERR_BAD_URL"],
    ] as const) {
      const response = await app.inject({ method, url, headers: { "x-request-id": "must-not-normalize" } });
      expect(response.statusCode).toBe(status);
      expect(response.headers["content-type"]).toBe("application/json");
      expect(response.headers["x-request-id"]).toBeUndefined();
      expect(response.json()).toMatchObject({ code, statusCode: status });
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([false, true])(
    "keeps malformed exact resource shapes absent for unsupported methods when enabled=%s",
    async (enabled) => {
      if (enabled) process.env.FEATURE_RPG_CAMPAIGN = "true";
      const repo = repository();
      const factory = vi.fn(() => repo);
      const app = buildApp({ campaignRepositoryFactory: factory });
      const secret = `unsupported-${enabled}-secret`;
      for (const [method, path] of [
        ["POST", "/api/rpg/v1/campaigns/%zz/characters/creation-options"],
        ["OPTIONS", `/api/rpg/v1/campaigns/${"x".repeat(129)}/starter-setup`],
        ["TRACE", "/api/rpg/v1/campaigns/%zz"],
      ] as const) {
        const requestId = `unsupported-${enabled}-${method}`;
        const response = await app.inject({
          // light-my-request supports TRACE at runtime but omits it from the
          // InjectOptions method union.
          method: method as never,
          url: `${path}?token=${secret}`,
          headers: { "x-request-id": requestId },
        });
        expect(response.statusCode).toBe(404);
        expect(response.headers["content-type"]).toContain("application/problem+json");
        expect(response.headers["x-request-id"]).toBe(requestId);
        expect(response.json()).toMatchObject({
          code: "RPG_ROUTE_NOT_FOUND",
          requestId,
          instance: path.replace(/\/campaigns\/[^/]+/, "/campaigns/:campaignId"),
          error: "RPG route not found",
        });
        expect(response.body).not.toContain(secret);
        expect(response.body).not.toContain("?token=");
      }
      expect(factory).not.toHaveBeenCalled();
      expect(repo.getCampaignCharacterCreationOptions).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("does not reflect queries from absent exact and lookalike methods", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    const secret = "unsupported-route-query-secret";
    for (const [method, path] of [
      ["POST", route],
      ["OPTIONS", `${route}/extra`],
      ["TRACE", "/api/rpg/v1/unknown"],
    ] as const) {
      const response = await app.inject({ method: method as never, url: `${path}?token=${secret}` });
      expect(response.statusCode).toBe(404);
      const instance = path === `${route}/extra`
        ? "/api/rpg/v1/campaigns/:campaignId/*"
        : path.startsWith("/api/rpg/v1/campaigns/")
          ? path.replace(/\/campaigns\/[^/]+/, "/campaigns/:campaignId")
          : path;
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", instance });
      expect(response.body).not.toContain(secret);
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps repository null to the same non-disclosing campaign 404", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository(null);
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "GET", url: route, headers: { "x-request-id": "options-missing" },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: "RPG_CAMPAIGN_NOT_FOUND", requestId: "options-missing", error: "Campaign not found",
    });
    await app.close();
  });

  it.each([undefined, false, 0, ""])(
    "treats malformed falsey repository output %j as a redacted 500",
    async (result) => {
      process.env.FEATURE_RPG_CAMPAIGN = "true";
      const repo = repository();
      repo.getCampaignCharacterCreationOptions.mockReturnValue(
        result as unknown as CampaignCharacterCreationOptionsResponse,
      );
      const app = buildApp({ campaignRepositoryFactory: () => repo });
      const response = await app.inject({
        method: "GET", url: route, headers: { "x-request-id": "options-falsey-output" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        code: "RPG_INTERNAL_ERROR",
        requestId: "options-falsey-output",
        error: "Campaign character creation options could not be loaded",
      });
      await app.close();
    },
  );

  it.each(["repository", "malformed output", "wrong-path output"] as const)(
    "redacts %s as a request-correlated internal error",
    async (kind) => {
      process.env.FEATURE_RPG_CAMPAIGN = "true";
      const secret = `private ${kind} detail`;
      const repo = repository();
      if (kind === "repository") {
        repo.getCampaignCharacterCreationOptions.mockImplementation(() => { throw new Error(secret); });
      } else if (kind === "malformed output") {
        repo.getCampaignCharacterCreationOptions.mockReturnValue({
          ...creationOptions,
          personas: [{ ...creationOptions.personas[0]!, privateNotes: secret }],
        } as unknown as CampaignCharacterCreationOptionsResponse);
      } else {
        repo.getCampaignCharacterCreationOptions.mockReturnValue({
          ...creationOptions, campaignId: "private-other-campaign",
        });
      }
      const app = buildApp({ campaignRepositoryFactory: () => repo });
      const response = await app.inject({
        method: "GET", url: route, headers: { "x-request-id": "options-failure" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.headers["content-type"]).toContain("application/problem+json");
      expect(response.headers["x-request-id"]).toBe("options-failure");
      expect(response.json()).toMatchObject({
        code: "RPG_INTERNAL_ERROR",
        requestId: "options-failure",
        error: "Campaign character creation options could not be loaded",
      });
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain("private-other-campaign");
      await app.close();
    },
  );

  it("redacts a lone-surrogate persona name as malformed strict output", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const marker = "options-surrogate-marker";
    const repo = repository({
      ...creationOptions,
      personas: [{ ...creationOptions.personas[0]!, name: `${marker}\ud800` }],
    });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "GET", url: route });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR" });
    expect(response.body).not.toContain(marker);
    await app.close();
  });

  it("keeps HEAD and unsupported methods absent without repository initialization", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
      const response = await app.inject({ method, url: route, headers: { "x-request-id": `options-${method}` } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["x-request-id"]).toBe(`options-${method}`);
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", requestId: `options-${method}` });
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("shares the exact lazy success cache and closes the app-owned repository once", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    expect((await app.inject({ method: "GET", url: route })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: route })).statusCode).toBe(200);
    expect(factory).toHaveBeenCalledOnce();
    await app.close();
    expect(repo.close).toHaveBeenCalledOnce();
  });

  it("shares and redacts the exact cached repository-open failure without retry or close", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => { throw new Error("private database filename"); });
    const app = buildApp({ campaignRepositoryFactory: factory });
    const first = await app.inject({ method: "GET", url: route, headers: { "x-request-id": "options-open-one" } });
    const second = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns", headers: { "x-request-id": "options-open-two" } });
    const third = await app.inject({ method: "GET", url: route, headers: { "x-request-id": "options-open-three" } });
    for (const [response, requestId] of [
      [first, "options-open-one"], [second, "options-open-two"], [third, "options-open-three"],
    ] as const) {
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR", requestId });
      expect(response.body).not.toContain("private database filename");
    }
    expect(factory).toHaveBeenCalledOnce();
    await app.close();
  });
});
