import { afterEach, describe, expect, it } from "vitest";
import type { ActorCheckCommandRequest } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import { ActorCheckNotFoundError, CheckUnavailableError, M16ConflictError, M16StaleError } from "../src/repo/index.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
});

const enable = () => {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
};

function result(input: ActorCheckCommandRequest) {
  const terms = [
    { kind: "roll" as const, roll: {
      expression: "1d20", normalized: { count: 1, sides: 20, selection: { type: "all" as const }, modifier: 0 },
      terms: [{ value: 10, kept: true }], modifier: 0, total: 10,
    } },
    { kind: "flat" as const, sourceId: null, value: 3 },
  ];
  return {
    resolution: {
      terms, total: 13,
      target: input.kind === "opposed"
        ? { kind: "opposed_total" as const, actorId: input.targetActorId, value: 14 }
        : { kind: "difficulty_class" as const, value: input.difficultyRef === "hard" ? 12 : 10 },
      outcome: input.kind === "opposed" ? "failure" as const : "success" as const,
    },
    receipt: {
      commandId: "private-command", idempotencyKey: input.idempotencyKey,
      revisionBefore: input.expectedRevision, revisionAfter: input.expectedRevision + 1,
      occurredAt: "2035-01-01T00:00:00.000Z",
    },
  };
}

function fakeRepository(resolveActorCheck: (principal: string, actorId: string, input: ActorCheckCommandRequest) => unknown) {
  return {
    resolveActorCheck,
    close() {},
    listCampaigns: () => [],
  } as unknown as CampaignListRepository;
}

describe("POST /api/rpg/v1/actors/:actorId/check-commands", () => {
  it("uses the fixed local principal and actor-only adapter for all five variants", async () => {
    enable();
    const calls: Array<{ principal: string; actorId: string; input: ActorCheckCommandRequest }> = [];
    const repository = fakeRepository((principal, actorId, input) => {
      calls.push({ principal, actorId, input });
      return result(input);
    });
    const app = buildApp({ campaignRepositoryFactory: () => repository });
    const variants: ActorCheckCommandRequest[] = [
      { kind: "ability", skillOrAttribute: "might", difficultyRef: "hard", expectedRevision: 0, idempotencyKey: "ability" },
      { kind: "skill", skillOrAttribute: "insight", expectedRevision: 1, idempotencyKey: "skill" },
      { kind: "save", skillOrAttribute: "resolve", expectedRevision: 2, idempotencyKey: "save" },
      { kind: "attack", skillOrAttribute: "melee", targetActorId: "target", expectedRevision: 3, idempotencyKey: "attack" },
      { kind: "opposed", skillOrAttribute: "insight", targetActorId: "target", expectedRevision: 4, idempotencyKey: "opposed" },
    ];
    for (const payload of variants) {
      const response = await app.inject({
        method: "POST", url: "/api/rpg/v1/actors/source/check-commands",
        headers: { "content-type": "application/json", authorization: "Bearer caller", "x-principal-id": "attacker" },
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        check: { ...result(payload).resolution, modifier: 3 },
        receipt: {
          idempotencyKey: payload.idempotencyKey, revisionBefore: payload.expectedRevision,
          revisionAfter: payload.expectedRevision + 1, occurredAt: "2035-01-01T00:00:00.000Z",
        },
      });
      expect(JSON.stringify(response.json())).not.toContain("private-command");
    }
    expect(calls).toHaveLength(5);
    expect(calls.every((call) => call.principal === "local-owner" && call.actorId === "source")).toBe(true);
    expect(calls.some((call) => "campaignId" in call.input)).toBe(false);
    await app.close();
  });

  it("normalizes stale, idempotency, unavailable target/difficulty, and missing actor errors", async () => {
    enable();
    const repository = fakeRepository((_principal, _actorId, input) => {
      if (input.idempotencyKey === "stale") throw new M16StaleError();
      if (input.idempotencyKey === "reused") throw new M16ConflictError();
      if (input.idempotencyKey === "target") throw new CheckUnavailableError();
      if (input.idempotencyKey === "missing") throw new ActorCheckNotFoundError();
      throw new Error("private database detail");
    });
    const app = buildApp({ campaignRepositoryFactory: () => repository });
    const post = (idempotencyKey: string) => app.inject({ method: "POST", url: "/api/rpg/v1/actors/source/check-commands",
      headers: { "content-type": "application/json" }, payload: { kind: "ability", skillOrAttribute: "might", expectedRevision: 0, idempotencyKey } });
    expect((await post("stale")).json().code).toBe("RPG_ACTOR_CHECK_STALE");
    expect((await post("reused")).json().code).toBe("RPG_ACTOR_CHECK_CONFLICT");
    expect((await post("target")).json().code).toBe("RPG_ACTOR_CHECK_CONFLICT");
    expect((await post("missing")).json().code).toBe("RPG_ACTOR_CHECK_NOT_FOUND");
    const unknown = await app.inject({ method: "POST", url: "/api/rpg/v1/actors/source/check-commands",
      headers: { "content-type": "application/json" }, payload: { kind: "ability", skillOrAttribute: "might", difficultyRef: "legendary", expectedRevision: 0, idempotencyKey: "difficulty" } });
    expect(unknown.statusCode).toBe(409);
    const internal = await post("unknown-write");
    expect(internal.statusCode).toBe(500);
    expect(internal.json().detail).toContain("do not automatically retry");
    expect(JSON.stringify(internal.json())).not.toContain("database detail");
    await app.close();
  });

  it("gates before repository access and rejects query, media, strict-body, path, and method variants", async () => {
    let accesses = 0;
    const app = buildApp({ campaignRepositoryFactory: () => { accesses += 1; return fakeRepository(() => { throw new Error(); }); } });
    const payload = { kind: "ability", skillOrAttribute: "might", expectedRevision: 0, idempotencyKey: "gate" };
    const gated = await app.inject({ method: "POST", url: "/api/rpg/v1/actors/source/check-commands", headers: { "content-type": "application/json" }, payload });
    expect(gated.statusCode).toBe(404);
    expect(accesses).toBe(0);
    enable();
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/actors/source/check-commands?x=1", headers: { "content-type": "application/json" }, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/actors/source/check-commands", headers: { "content-type": "text/plain" }, payload: JSON.stringify(payload) })).statusCode).toBe(415);
    expect((await app.inject({ method: "POST", url: "/api/rpg/v1/actors/source/check-commands", headers: { "content-type": "application/json" }, payload: { ...payload, total: 99 } })).statusCode).toBe(400);
    const malformedActor = await app.inject({ method: "POST", url: `/api/rpg/v1/actors/${"x".repeat(129)}/check-commands`, headers: { "content-type": "application/json" }, payload });
    expect(malformedActor.statusCode).toBe(404);
    expect(malformedActor.json().instance).toBe("/api/rpg/v1/actors/:actorId/check-commands");
    const method = await app.inject({ method: "GET", url: "/api/rpg/v1/actors/source/check-commands" });
    expect(method.statusCode).toBe(404);
    expect(method.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", instance: "/api/rpg/v1/actors/:actorId/check-commands" });
    await app.close();
  });
});
