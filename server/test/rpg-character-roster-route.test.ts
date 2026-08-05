import type { Campaign, CampaignAccess, CampaignDetail } from "@velvet/contracts";
import { request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { CampaignCharacterRosterSnapshot } from "../src/repo.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const route = "/api/rpg/v1/campaigns/campaign-one/characters";
const roster: CampaignCharacterRosterSnapshot = {
  campaignId: "campaign-one",
  characters: [
    { id: "cc-z", characterId: "persona-z", name: "Zulu" },
    { id: "cc-a", characterId: "persona-a", name: "Alpha" },
  ],
};

function repository(result: CampaignCharacterRosterSnapshot | null = roster) {
  return {
    listCampaigns: vi.fn((): CampaignAccess[] => []),
    getCampaignDetail: vi.fn((): CampaignDetail | null => null),
    createCampaign: vi.fn((): Campaign => { throw new Error("unused"); }),
    renameCampaignIfUnchanged: vi.fn((): Campaign => { throw new Error("unused"); }),
    getCampaignCharacterCreationOptions: vi.fn(() => null),
    getCampaignCharacterRoster: vi.fn(() => result),
    getCampaignCharacterWorkspace: vi.fn(() => null),
    createOriginalStarterCampaignCharacter: vi.fn(() => { throw new Error("unused"); }),
    close: vi.fn(),
  };
}

afterEach(() => {
  process.env.NODE_ENV = "test";
  delete process.env.FEATURE_RPG_CAMPAIGN;
  vi.restoreAllMocks();
});

describe("GET /api/rpg/v1/campaigns/:campaignId/characters", () => {
  it("feature-gates before query, path parsing, or repository opening", async () => {
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const url of [
      `${route}?principal=attacker`,
      "/api/rpg/v1/campaigns/invalid%20id/characters",
      "/api/rpg/v1/campaigns/%zz/characters",
      `/api/rpg/v1/campaigns/${"x".repeat(129)}/characters`,
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": "roster-disabled" } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["x-request-id"]).toBe("roster-disabled");
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", requestId: "roster-disabled" });
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses only fixed local-owner and returns the strict safe ordered envelope", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "GET", url: route,
      headers: { "x-request-id": "roster-ok", authorization: "Bearer attacker", "x-principal-id": "attacker" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("roster-ok");
    expect(response.json()).toEqual({ characters: roster.characters });
    expect(repo.getCampaignCharacterRoster).toHaveBeenCalledWith("local-owner", "campaign-one");
    expect(response.body).not.toMatch(/campaignId|controller|privateNotes|sheet|actor|command/i);
    await app.close();
  });

  it("returns an authorized empty roster as 200 rather than 404", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const app = buildApp({ campaignRepositoryFactory: () => repository({ campaignId: "campaign-one", characters: [] }) });
    const response = await app.inject({ method: "GET", url: route });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ characters: [] });
    await app.close();
  });

  it("decodes and internally path-binds the campaign ID", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign%2Done/characters" })).statusCode)
      .toBe(200);
    expect(repo.getCampaignCharacterRoster).toHaveBeenCalledWith("local-owner", "campaign-one");
    await app.close();
  });

  it("rejects every query form before path validation and repository access", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const url of [`${route}?x=1`, `${route}?unused=`, `${route}?x=1&x=2`,
      "/api/rpg/v1/campaigns/%zz/characters?secret=value"]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": "roster-query" } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "RPG_INVALID_REQUEST", requestId: "roster-query",
        error: "Campaign character roster does not accept query parameters",
      });
      expect(response.body).not.toContain("secret=value");
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([false, true])("handles a bare raw query delimiter with enabled=%s", async (enabled) => {
    if (enabled) process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: address.port, method: "GET", path: `${route}?`,
        headers: { "x-request-id": `roster-bare-${enabled}` },
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
      requestId: `roster-bare-${enabled}`,
    });
    expect(response.body).not.toContain(`${route}?`);
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes only malformed exact roster paths", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const url of [
      "/api/rpg/v1/campaigns/invalid%20id/characters",
      "/api/rpg/v1/campaigns/%2F/characters",
      "/api/rpg/v1/campaigns/%zz/characters",
      `/api/rpg/v1/campaigns/${"x".repeat(129)}/characters`,
    ]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": "roster-path" } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["x-request-id"]).toBe("roster-path");
      expect(response.json()).toMatchObject({ code: "RPG_CAMPAIGN_NOT_FOUND", requestId: "roster-path" });
    }
    const lookalike = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/%zz/character" });
    expect(lookalike.statusCode).toBe(400);
    expect(lookalike.json()).toMatchObject({ code: "FST_ERR_BAD_URL" });
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps only literal null to the non-disclosing campaign 404", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const app = buildApp({ campaignRepositoryFactory: () => repository(null) });
    const response = await app.inject({ method: "GET", url: route, headers: { "x-request-id": "roster-null" } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "RPG_CAMPAIGN_NOT_FOUND", requestId: "roster-null" });
    await app.close();
  });

  it.each([undefined, false, 0, ""])("redacts malformed falsey output %j as 500", async (value) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.getCampaignCharacterRoster.mockReturnValue(value as unknown as CampaignCharacterRosterSnapshot);
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "GET", url: route, headers: { "x-request-id": "roster-bad" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "RPG_INTERNAL_ERROR", requestId: "roster-bad", error: "Campaign characters could not be loaded",
    });
    await app.close();
  });

  it.each(["repository", "malformed", "wrong-path"] as const)("redacts %s failure", async (kind) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const secret = `private-${kind}`;
    const repo = repository();
    if (kind === "repository") repo.getCampaignCharacterRoster.mockImplementation(() => { throw new Error(secret); });
    else if (kind === "malformed") repo.getCampaignCharacterRoster.mockReturnValue({
      ...roster, characters: [{ ...roster.characters[0]!, privateNotes: secret }],
    } as unknown as CampaignCharacterRosterSnapshot);
    else repo.getCampaignCharacterRoster.mockReturnValue({ ...roster, campaignId: secret });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "GET", url: route, headers: { "x-request-id": "roster-failure" } });
    expect(response.statusCode).toBe(500);
    expect(response.headers["x-request-id"]).toBe("roster-failure");
    expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR", requestId: "roster-failure" });
    expect(response.body).not.toContain(secret);
    await app.close();
  });

  it("redacts a lone-surrogate persona name as malformed strict output", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const marker = "roster-surrogate-marker";
    const repo = repository({
      ...roster,
      characters: [{ ...roster.characters[0]!, name: `${marker}\ud800` }],
    });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "GET", url: route });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR" });
    expect(response.body).not.toContain(marker);
    await app.close();
  });

  it("keeps HEAD and every unsupported method absent without repository access", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const method of ["HEAD", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"] as const) {
      const response = await app.inject({ method: method as never, url: `${route}?secret=value` });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({
        code: "RPG_ROUTE_NOT_FOUND", instance: "/api/rpg/v1/campaigns/:campaignId/characters",
      });
      expect(response.body).not.toContain("secret=value");
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("shares cached repository success/open failure and close lifecycle", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    expect((await app.inject({ method: "GET", url: route })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" })).statusCode).toBe(200);
    expect(factory).toHaveBeenCalledOnce();
    await app.close();
    expect(repo.close).toHaveBeenCalledOnce();

    const failedFactory = vi.fn(() => { throw new Error("private database path"); });
    const failedApp = buildApp({ campaignRepositoryFactory: failedFactory });
    const first = await failedApp.inject({ method: "GET", url: route });
    const second = await failedApp.inject({ method: "GET", url: route });
    expect(first.statusCode).toBe(500);
    expect(second.statusCode).toBe(500);
    expect(first.body).not.toContain("private database path");
    expect(failedFactory).toHaveBeenCalledOnce();
    await failedApp.close();
  });

  it("keeps cached open and caller markers out of production logs and RPG responses", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.NODE_ENV = "production";
    const markers = {
      database: "slice83-db-path-/private/roster-4dc12a.sqlite",
      controller: "slice83-controller-principal-773ca1",
      privateField: "slice83-private-notes-0f91e7",
      sql: "slice83-SQL-SELECT-secret-c5a209",
      schema: "slice83-schema-field-secret-cc7342",
      output: "slice83-output-value-secret-55f193",
      query: "slice83-query-token-a409ee",
      header: "slice83-header-token-b7d113",
    };
    let logged = "";
    const loggerStream = new Writable({
      write(chunk, _encoding, callback) {
        logged += chunk.toString();
        callback();
      },
    });
    const openError = Object.assign(
      new Error(`${markers.database} ${markers.sql}`),
      {
        controllerPrincipalId: markers.controller,
        privateNotes: markers.privateField,
        schemaPath: markers.schema,
        outputValue: markers.output,
        query: markers.query,
      },
    );
    const factory = vi.fn(() => { throw openError; });
    const app = buildApp({ campaignRepositoryFactory: factory, loggerStream });

    const responses = [];
    try {
      responses.push(await app.inject({
        method: "GET",
        url: `${route}?token=${markers.query}`,
        headers: { "x-private": markers.header },
      }));
      for (const url of [route, route, `${route}/creation-options`, "/api/rpg/v1/campaigns"]) {
        responses.push(await app.inject({
          method: "GET",
          url,
          headers: { "x-private": markers.header },
        }));
      }
    } finally {
      await app.close();
    }

    expect(responses.map((response) => response.statusCode)).toEqual([400, 500, 500, 500, 500]);
    expect(factory).toHaveBeenCalledOnce();
    expect(logged).toContain('"operation":"campaign-character-roster"');
    expect(logged).toContain('"operation":"campaign-character-creation-options"');
    expect(logged).toContain('"operation":"campaign-list"');
    const retained = `${logged}\n${responses.map((response) => response.body).join("\n")}`;
    for (const marker of Object.values(markers)) expect(retained).not.toContain(marker);
    expect(retained).not.toMatch(/controllerPrincipalId|privateNotes|Error:|\"stack\"|SELECT secret/);
  });
});
