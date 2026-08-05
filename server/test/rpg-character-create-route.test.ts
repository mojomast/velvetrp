import DatabaseDriver from "better-sqlite3";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { Writable } from "node:stream";
import {
  ORIGINAL_STARTER_BACKGROUND,
  ORIGINAL_STARTER_CLASS,
  ORIGINAL_STARTER_PACK,
  ORIGINAL_STARTER_RACE,
  ORIGINAL_STARTER_RULES_PROFILE,
  type Campaign,
  type CampaignAccess,
  type CampaignCharacterCreationOptionsResponse,
  type CampaignDetail,
  type CreateCampaignCharacterInput,
  type PrivilegedCampaignCharacterProjection,
} from "@velvet/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  CampaignCharacterCreationConflictError,
  CampaignCharacterCreationUnavailableError,
  CampaignCharacterPersonaUnavailableError,
  createRepository,
} from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const route = "/api/rpg/v1/campaigns/campaign-one/characters";
const UNKNOWN_CREATE_DETAIL = "Campaign character creation status is unknown; reconciliation with authoritative character list and creation options GETs is required; never retry automatically";
const AT = "2036-01-02T03:04:05.006Z";

const options: CampaignCharacterCreationOptionsResponse = {
  campaignId: "campaign-one",
  personas: [{ characterId: "persona-opaque", name: "Persona", alreadyUsed: false }],
  starter: {
    rulesProfile: ORIGINAL_STARTER_RULES_PROFILE,
    pack: ORIGINAL_STARTER_PACK,
    race: ORIGINAL_STARTER_RACE,
    background: ORIGINAL_STARTER_BACKGROUND,
    class: { ...ORIGINAL_STARTER_CLASS, level: 1 },
  },
};

const projection: PrivilegedCampaignCharacterProjection = {
  campaignCharacter: {
    id: "campaign-character", campaignId: "campaign-one", characterId: "persona-opaque",
    createdAt: AT, updatedAt: AT,
  },
  sheet: {
    id: "sheet", campaignId: "campaign-one", campaignCharacterId: "campaign-character",
    race: ORIGINAL_STARTER_RACE.reference, background: ORIGINAL_STARTER_BACKGROUND.reference,
    classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }],
    attributes: [], proficiencies: [], choices: [], createdAt: AT, updatedAt: AT,
  },
  actor: {
    id: "actor", campaignId: "campaign-one", campaignCharacterId: "campaign-character", sheetId: "sheet",
    kind: "player-character", control: "principal", controllerPrincipalId: "local-owner", privateNotes: null,
    createdAt: AT, updatedAt: AT,
  },
};

function repository(optionResult: CampaignCharacterCreationOptionsResponse | null = options) {
  return {
    listCampaigns: vi.fn((): CampaignAccess[] => []),
    getCampaignDetail: vi.fn((): CampaignDetail | null => null),
    createCampaign: vi.fn((): Campaign => { throw new Error("unused"); }),
    renameCampaignIfUnchanged: vi.fn((): Campaign => { throw new Error("unused"); }),
    getCampaignCharacterCreationOptions: vi.fn(() => optionResult),
    getCampaignCharacterRoster: vi.fn(() => null),
    getCampaignCharacterWorkspace: vi.fn(() => null),
    createOriginalStarterCampaignCharacter: vi.fn((_actor: string, _input: CreateCampaignCharacterInput) => ({
      projection, personaDisplayName: "Persona",
    })),
    close: vi.fn(),
  };
}

afterEach(() => {
  process.env.NODE_ENV = "test";
  delete process.env.FEATURE_RPG_CAMPAIGN;
  vi.restoreAllMocks();
});

describe("POST /api/rpg/v1/campaigns/:campaignId/characters", () => {
  it("is disabled before query, malformed path/body, media, or repository opening", async () => {
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const url of [
      `${route}?secret=value`,
      "/api/rpg/v1/campaigns/invalid%20id/characters",
      "/api/rpg/v1/campaigns/%zz/characters",
      `/api/rpg/v1/campaigns/${"x".repeat(129)}/characters`,
    ]) {
      const response = await app.inject({
        method: "POST", url, payload: "{", headers: { "content-type": "text/plain", "x-request-id": "create-disabled" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", requestId: "create-disabled" });
      expect(response.body).not.toContain("secret=value");
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("uses the fixed service boundary once and returns strict 201 without Location", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const opaquePersonaId = "persona:/opaque?body-only=#value";
    const repo = repository({
      ...options, personas: [{ characterId: opaquePersonaId, name: "Opaque Persona", alreadyUsed: false }],
    });
    repo.createOriginalStarterCampaignCharacter.mockImplementation((_actor, input) => ({
      projection: {
        ...projection,
        campaignCharacter: { ...projection.campaignCharacter, characterId: input.characterId },
      },
      personaDisplayName: "Opaque Persona",
    }));
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "POST", url: route, payload: { characterId: opaquePersonaId },
      headers: {
        "content-type": "application/json; charset=utf-8", "x-request-id": "create-ok",
        authorization: "Bearer attacker", "x-principal-id": "attacker", "x-user-id": "attacker",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["x-request-id"]).toBe("create-ok");
    expect(response.json()).toEqual({
      character: { id: "campaign-character", characterId: opaquePersonaId, name: "Opaque Persona" },
    });
    expect(repo.getCampaignCharacterCreationOptions).toHaveBeenCalledOnce();
    expect(repo.getCampaignCharacterCreationOptions).toHaveBeenCalledWith("local-owner", "campaign-one");
    expect(repo.createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
    expect(repo.createOriginalStarterCampaignCharacter).toHaveBeenCalledWith(
      "local-owner",
      expect.objectContaining({
        campaignId: "campaign-one", characterId: opaquePersonaId, controllerPrincipalId: "local-owner",
        race: ORIGINAL_STARTER_RACE.reference, background: ORIGINAL_STARTER_BACKGROUND.reference,
        classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }],
        attributes: [], proficiencies: [], choices: [],
      }),
    );
    expect(response.body).not.toMatch(/controllerPrincipalId|privateNotes|sheet|actor|campaignId|rulesProfile/i);
    await app.close();
  });

  it("rejects every raw query before path/media/body and never opens the repository", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const url of [
      `${route}?x=1`, `${route}?unused=`, `${route}?x=1&x=2`,
      "/api/rpg/v1/campaigns/%zz/characters?private=query",
    ]) {
      const response = await app.inject({ method: "POST", url, payload: "{", headers: { "content-type": "text/plain" } });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: "RPG_INVALID_REQUEST", error: "Campaign character creation does not accept query parameters",
      });
      expect(response.body).not.toContain("private=query");
    }
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([false, true])("handles a bare query delimiter with enabled=%s", async (enabled) => {
    if (enabled) process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({
        host: "127.0.0.1", port: address.port, method: "POST", path: `${route}?`,
        headers: { "content-type": "application/json", "x-request-id": `create-bare-${enabled}` },
      }, (incoming) => {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => { body += chunk; });
        incoming.on("end", () => resolve({ status: incoming.statusCode ?? 0, body }));
      });
      request.on("error", reject);
      request.end(JSON.stringify({ characterId: "persona-opaque" }));
    });
    expect(response.status).toBe(enabled ? 400 : 404);
    expect(JSON.parse(response.body)).toMatchObject({
      code: enabled ? "RPG_INVALID_REQUEST" : "RPG_ROUTE_NOT_FOUND",
      requestId: `create-bare-${enabled}`,
    });
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it("validates strict path before media/body and method-sensitively normalizes exact router failures", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    for (const url of [
      "/api/rpg/v1/campaigns/invalid%20id/characters",
      "/api/rpg/v1/campaigns/%2F/characters",
      "/api/rpg/v1/campaigns/%zz/characters",
      `/api/rpg/v1/campaigns/${"x".repeat(129)}/characters`,
    ]) {
      const response = await app.inject({ method: "POST", url, payload: "{", headers: { "content-type": "text/plain" } });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "RPG_CAMPAIGN_NOT_FOUND" });
    }
    const get = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/%zz/characters?x=1" });
    expect(get.statusCode).toBe(400);
    expect(get.json()).toMatchObject({ detail: "Campaign character roster does not accept query parameters" });
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"] as const) {
      const response = await app.inject({ method: method as never, url: "/api/rpg/v1/campaigns/%zz/characters?x=1" });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND" });
    }
    const lookalike = await app.inject({ method: "POST", url: "/api/rpg/v1/campaigns/%zz/character?secret=x" });
    expect(lookalike.statusCode).toBe(400);
    expect(lookalike.json()).toMatchObject({ code: "FST_ERR_BAD_URL" });
    expect(lookalike.body).not.toContain("secret=x");
    const legacy = await app.inject({ method: "POST", url: "/api/characters/%zz?secret=x" });
    expect(legacy.statusCode).toBe(400);
    expect(legacy.json()).toMatchObject({ code: "FST_ERR_BAD_URL" });
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["application/json", 201],
    ["Application/JSON", 201],
    ["application/json;charset=utf-8", 201],
    ["application/json ; charset = \"UTF-8\"", 201],
    [undefined, 415],
    ["text/json", 415],
    ["application/problem+json", 415],
    ["application/json; profile=x", 415],
    ["application/json; charset=utf-8; charset=utf-8", 415],
    ["application/json, text/plain", 415],
  ])("enforces the exact JSON media contract for %j", async (contentType, status) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({
      method: "POST", url: route, payload: JSON.stringify({ characterId: "persona-opaque" }),
      headers: contentType ? { "content-type": contentType } : {},
    });
    expect(response.statusCode).toBe(status);
    if (status === 415) expect(response.json()).toMatchObject({ code: "RPG_UNSUPPORTED_MEDIA_TYPE" });
    await app.close();
  });

  it.each([
    ["empty", ""], ["malformed", "{"], ["null", "null"], ["missing", "{}"],
    ["blank", JSON.stringify({ characterId: "" })],
    ["extra", JSON.stringify({ characterId: "persona-opaque", campaignId: "caller-owned" })],
  ])("returns the same generic 400 for %s bodies without repository access", async (_label, payload) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const factory = vi.fn(() => repository());
    const app = buildApp({ campaignRepositoryFactory: factory });
    const response = await app.inject({ method: "POST", url: route, payload, headers: { "content-type": "application/json" } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "RPG_INVALID_REQUEST", error: "Campaign character creation request is invalid",
    });
    expect(response.json()).not.toHaveProperty("issues");
    expect(factory).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["campaign", new CampaignCharacterCreationUnavailableError(), 404, "RPG_CAMPAIGN_NOT_FOUND"],
    ["persona", new CampaignCharacterPersonaUnavailableError(), 404, "RPG_CAMPAIGN_CHARACTER_PERSONA_NOT_FOUND"],
    ["conflict", new CampaignCharacterCreationConflictError(), 409, "RPG_CAMPAIGN_CHARACTER_CREATE_CONFLICT"],
  ])("maps only the typed %s service failure", async (_label, failure, status, code) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.createOriginalStarterCampaignCharacter.mockImplementation(() => { throw failure; });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "POST", url: route, payload: { characterId: "persona-opaque" } });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ code });
    expect(response.body).not.toContain(failure.message);
    expect(repo.createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
    await app.close();
  });

  it.each(["repository", "dependency", "SQL", "corruption", "lookalike"])(
    "redacts %s failures as correlated generic 500 without retry",
    async (kind) => {
      process.env.FEATURE_RPG_CAMPAIGN = "true";
      const secret = `private-${kind}-id-header-body-output`;
      const repo = repository();
      const failure = kind === "lookalike"
        ? Object.assign(new Error(secret), { code: "ORIGINAL_STARTER_CHARACTER_CREATION_CONFLICT" })
        : new Error(secret);
      repo.createOriginalStarterCampaignCharacter.mockImplementation(() => { throw failure; });
      const app = buildApp({ campaignRepositoryFactory: () => repo });
      const response = await app.inject({
        method: "POST", url: route, payload: { characterId: "persona-opaque" },
        headers: { "x-request-id": "create-failure", "x-private": secret },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        code: "RPG_INTERNAL_ERROR", requestId: "create-failure", detail: UNKNOWN_CREATE_DETAIL,
        error: UNKNOWN_CREATE_DETAIL,
      });
      expect(response.body).not.toContain(secret);
      expect(repo.getCampaignCharacterCreationOptions).toHaveBeenCalledOnce();
      expect(repo.createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
      await app.close();
    },
  );

  it.each([undefined, false, 0, "", "mismatch"])("redacts malformed/falsey locked output %j", async (value) => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    repo.createOriginalStarterCampaignCharacter.mockReturnValue(
      (value === "mismatch"
        ? { projection: { ...projection, campaignCharacter: { ...projection.campaignCharacter, characterId: "other-persona" } }, personaDisplayName: "Persona" }
        : value) as never,
    );
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const response = await app.inject({ method: "POST", url: route, payload: { characterId: "persona-opaque" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR", detail: UNKNOWN_CREATE_DETAIL });
    expect(response.body).not.toContain("other-persona");
    expect(repo.createOriginalStarterCampaignCharacter).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects a malformed locked persona name generically while preserving valid astral output", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const marker = "slice85-surrogate-persona-marker";
    const repo = repository();
    repo.createOriginalStarterCampaignCharacter.mockReturnValue({
      projection, personaDisplayName: `${marker}\ud800`,
    });
    const app = buildApp({ campaignRepositoryFactory: () => repo });
    const malformed = await app.inject({
      method: "POST", url: route, payload: { characterId: "persona-opaque" },
    });
    expect(malformed.statusCode).toBe(500);
    expect(malformed.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR", detail: UNKNOWN_CREATE_DETAIL });
    expect(malformed.body).not.toContain(marker);

    repo.createOriginalStarterCampaignCharacter.mockReturnValue({
      projection, personaDisplayName: "Astral \u{1F9D9} Persona",
    });
    const valid = await app.inject({
      method: "POST", url: route, payload: { characterId: "persona-opaque" },
    });
    expect(valid.statusCode).toBe(201);
    expect(valid.json().character.name).toBe("Astral \u{1F9D9} Persona");
    await app.close();
  });

  it("shares cached open success/failure and closes a ready repository once", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repo = repository();
    const factory = vi.fn(() => repo);
    const app = buildApp({ campaignRepositoryFactory: factory });
    expect((await app.inject({ method: "POST", url: route, payload: { characterId: "persona-opaque" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" })).statusCode).toBe(200);
    expect(factory).toHaveBeenCalledOnce();
    await app.close();
    expect(repo.close).toHaveBeenCalledOnce();

    const failedFactory = vi.fn(() => { throw new Error("private database path"); });
    const failedApp = buildApp({ campaignRepositoryFactory: failedFactory });
    for (const requestId of ["open-one", "open-two"]) {
      const response = await failedApp.inject({
        method: "POST", url: route, payload: { characterId: "persona-opaque" }, headers: { "x-request-id": requestId },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR", requestId });
      expect(response.body).not.toContain("private database path");
    }
    expect(failedFactory).toHaveBeenCalledOnce();
    await failedApp.close();
  });

  it("logs only safe generic POST context in production", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.NODE_ENV = "production";
    const markers = [
      "slice85-exception-secret", "slice85-body-persona", "slice85-header-secret",
      "slice85-query-secret", "slice85-output-secret", "slice85-request-id-secret",
    ];
    let logged = "";
    const loggerStream = new Writable({
      write(chunk, _encoding, callback) { logged += chunk.toString(); callback(); },
    });
    const repo = repository({
      ...options, personas: [{ characterId: markers[1]!, name: "Persona", alreadyUsed: false }],
    });
    repo.createOriginalStarterCampaignCharacter.mockImplementation(() => {
      throw Object.assign(new Error(markers[0]), { output: markers[4] });
    });
    const app = buildApp({ campaignRepositoryFactory: () => repo, loggerStream });
    const response = await app.inject({
      method: "POST", url: route, payload: { characterId: markers[1] },
      headers: { "x-private": markers[2], "x-request-id": markers[5] },
    });
    await app.inject({ method: "POST", url: `${route}?token=${markers[3]}`, payload: { characterId: markers[1] } });
    await app.close();
    expect(response.statusCode).toBe(500);
    expect(logged).toContain('"operation":"campaign-character-create"');
    for (const marker of markers) expect(logged).not.toContain(marker);
    const retained = `${logged}\n${response.body}`;
    for (const marker of markers.slice(0, 5)) expect(retained).not.toContain(marker);
    expect(retained).not.toMatch(/Error:|"stack"|characterId|authorization|x-private/i);
  });

  it("proves commit ambiguity: malformed output returns 500 after one commit and authoritative GETs reconcile", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const ids = ["campaign-one", "timeline", "campaign-character", "sheet", "actor"];
    const real = createRepository({
      dataDir: process.env.VELVET_DATA_DIR as string,
      ids: { nextId: () => ids.shift()! },
      clock: { now: () => new Date(AT) },
    });
    real.createCampaign("local-owner", { name: "Campaign" });
    real.installOriginalStarterContent("local-owner", "campaign-one");
    real.configureOriginalStarterContent("local-owner", "campaign-one");
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"));
    db.prepare(`INSERT INTO characters
      (id,name,age,archetype,boundaries,safe_word,fictional_confirmed,is_real_person,created_at)
      VALUES ('persona-opaque','Persona',30,'hero','fictional','anchor',1,0,?)`).run(AT);
    db.close();
    const committedCreate = vi.fn((actor: string, input: CreateCampaignCharacterInput) => {
      const committed = real.createOriginalStarterCampaignCharacter(actor, input);
      // Corrupt only the service-facing result after the repository transaction commits.
      return { ...committed, personaDisplayName: "" };
    });
    const close = vi.fn(() => real.close());
    const routeRepository = {
      ...real,
      createOriginalStarterCampaignCharacter: committedCreate,
      close,
    };
    const app = buildApp({ campaignRepositoryFactory: () => routeRepository });

    const first = await app.inject({
      method: "POST", url: route, payload: { characterId: "persona-opaque" }, headers: { "x-request-id": "ambiguous" },
    });
    expect(first.statusCode).toBe(500);
    expect(first.json()).toMatchObject({
      code: "RPG_INTERNAL_ERROR", requestId: "ambiguous", detail: UNKNOWN_CREATE_DETAIL,
    });
    expect(committedCreate).toHaveBeenCalledOnce();

    const roster = await app.inject({ method: "GET", url: route });
    expect(roster.statusCode).toBe(200);
    expect(roster.json()).toEqual({
      characters: [{ id: "campaign-character", characterId: "persona-opaque", name: "Persona" }],
    });
    const creationOptions = await app.inject({ method: "GET", url: `${route}/creation-options` });
    expect(creationOptions.statusCode).toBe(200);
    expect(creationOptions.json().personas).toEqual([
      { characterId: "persona-opaque", name: "Persona", alreadyUsed: true },
    ]);

    const deliberateSecond = await app.inject({ method: "POST", url: route, payload: { characterId: "persona-opaque" } });
    expect(deliberateSecond.statusCode).toBe(409);
    expect(deliberateSecond.json()).toMatchObject({ code: "RPG_CAMPAIGN_CHARACTER_CREATE_CONFLICT" });
    expect(committedCreate).toHaveBeenCalledOnce();
    const verify = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite"), { readonly: true });
    expect((verify.prepare("SELECT COUNT(*) count FROM campaign_characters").get() as { count: number }).count).toBe(1);
    verify.close();
    await app.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
