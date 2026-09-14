import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attunementHttpRoutes } from "../src/routes/rpg/v1/attunement.js";

process.env.NODE_ENV = "test";

const AT = "2035-01-01T00:00:00.000Z";
const entry = { key: "ring-1", definition: { packId: "srd-5.1", packVersion: "1.6.0+test", definitionId: "srd-5.1:item:ring" }, attunedAt: AT };
const snapshot = { campaignId: "campaign", actorId: "actor", limit: 3, attunements: [entry] };

function repository(overrides: Partial<Record<"listActorAttunements" | "attuneActorItem" | "dropActorAttunement", unknown>> = {}) {
  return {
    listActorAttunements: vi.fn(() => snapshot),
    attuneActorItem: vi.fn(() => ({ ok: true, code: undefined, snapshot })),
    dropActorAttunement: vi.fn(() => ({ ok: true, code: undefined, snapshot: { ...snapshot, attunements: [] } })),
    ...overrides,
  };
}

function app(repo = repository()) {
  const instance = Fastify({ logger: false });
  instance.register(attunementHttpRoutes, { prefix: "/api/rpg/v1", attunementRepositoryAccessor: () => repo as never });
  return { instance, repo };
}

const GET = "/api/rpg/v1/campaigns/campaign/actors/actor/attunements";

afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; delete process.env.FEATURE_RPG_MECHANICS; });

describe("attunement HTTP lane", () => {
  it("gates before the accessor and requires both campaign and mechanics flags", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const { instance, repo } = app();
    const denied = await instance.inject({ method: "GET", url: GET });
    expect(denied.statusCode).toBe(404);
    expect(repo.listActorAttunements).not.toHaveBeenCalled();
    process.env.FEATURE_RPG_MECHANICS = "true";
    const allowed = await instance.inject({ method: "GET", url: GET });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual(snapshot);
    expect(repo.listActorAttunements).toHaveBeenCalledWith("local-owner", "actor");
    expect(allowed.headers["cache-control"]).toBe("no-store");
    await instance.close();
  });

  it("attunes and drops through the repository and returns the command outcome", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const { instance, repo } = app();
    const attuned = await instance.inject({ method: "POST", url: GET, payload: { command: "attune", key: "ring-1", definitionId: "srd-5.1:item:ring", satisfiedRest: "short-rest" } });
    expect(attuned.statusCode).toBe(200);
    expect(attuned.json()).toEqual({ ok: true, code: null, snapshot });
    expect(repo.attuneActorItem).toHaveBeenCalledWith("local-owner", "actor", { key: "ring-1", definitionId: "srd-5.1:item:ring", satisfiedRest: "short-rest" });
    const dropped = await instance.inject({ method: "POST", url: GET, payload: { command: "drop", key: "ring-1" } });
    expect(dropped.statusCode).toBe(200);
    expect(dropped.json()).toEqual({ ok: true, code: null, snapshot: { ...snapshot, attunements: [] } });
    expect(repo.dropActorAttunement).toHaveBeenCalledWith("local-owner", "actor", "ring-1");
    await instance.close();
  });

  it("surfaces engine rejection as ok:false with the engine code", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const { instance } = app(repository({ attuneActorItem: vi.fn(() => ({ ok: false, code: "capacity-exceeded", snapshot })) }));
    const response = await instance.inject({ method: "POST", url: GET, payload: { command: "attune", key: "fourth", definitionId: "srd-5.1:item:ring", satisfiedRest: null } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: false, code: "capacity-exceeded", snapshot });
    await instance.close();
  });

  it("hides denied actors and campaign mismatches behind one 404", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const deniedApp = app(repository({ listActorAttunements: vi.fn(() => null) }));
    const denied = await deniedApp.instance.inject({ method: "GET", url: GET });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toMatchObject({ code: "RPG_ATTUNEMENT_NOT_FOUND" });
    await deniedApp.instance.close();
    const mismatchApp = app(repository({ listActorAttunements: vi.fn(() => ({ ...snapshot, campaignId: "other" })) }));
    const mismatch = await mismatchApp.instance.inject({ method: "GET", url: GET });
    expect(mismatch.statusCode).toBe(404);
    await mismatchApp.instance.close();
  });

  it("rejects query parameters, non-JSON media, and invalid bodies", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const { instance, repo } = app();
    expect((await instance.inject({ method: "GET", url: `${GET}?x=1` })).statusCode).toBe(400);
    expect((await instance.inject({ method: "POST", url: GET, headers: { "content-type": "text/plain" }, payload: "{}" })).statusCode).toBe(415);
    expect((await instance.inject({ method: "POST", url: GET, payload: { command: "attune", key: "ring-1" } })).statusCode).toBe(400);
    expect((await instance.inject({ method: "POST", url: GET, payload: { command: "drop" } })).statusCode).toBe(400);
    expect(repo.attuneActorItem).not.toHaveBeenCalled();
    expect((await instance.inject({ method: "HEAD", url: GET })).statusCode).toBe(404);
    await instance.close();
  });

  it("masks repository corruption", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const { instance } = app(repository({ listActorAttunements: vi.fn(() => { throw new Error("private attunement corruption"); }) }));
    const response = await instance.inject({ method: "GET", url: GET });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private attunement corruption");
    await instance.close();
  });
});
