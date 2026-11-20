// Approved test (round-2 playtest kink 2): rests were unreachable. Over HTTP a short rest could not
// carry hitDiceToSpend, every refusal was the same bare 409 ("conflicts with current state") that hid
// the reason, and a Quick adventure could never take a long rest (dnd-5e without an expedition always
// refused). Live: Orra at 992/1000 after a fight got 409 for both rests.
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorRestHttpRoutes } from "../src/routes/rpg/v1/actorRest.js";
import { RestIllegalStateError } from "../src/repo/restRepo.js";
import { buildApp } from "../src/app.js";
import { closeRepo, createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();
const FLAGS = ["FEATURE_RPG_CAMPAIGN", "FEATURE_RPG_MECHANICS", "FEATURE_RPG_COMBAT"] as const;
beforeEach(() => {
  for (const flag of FLAGS) process.env[flag] = "true";
});
afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
  closeRepo();
});

async function routeApp(takeRest: ReturnType<typeof vi.fn>) {
  const app = Fastify({ logger: false });
  await app.register(actorRestHttpRoutes, { prefix: "/api/rpg/v1", restRepositoryAccessor: () => ({ takeRest }) as never });
  return app;
}

describe("actor rest route", () => {
  it("passes hitDiceToSpend through to the repository", async () => {
    const takeRest = vi.fn().mockImplementation(() => {
      throw new RestIllegalStateError("no resource can recover");
    });
    const app = await routeApp(takeRest);
    await app.inject({
      method: "POST",
      url: "/api/rpg/v1/campaigns/campaign-one/actors/actor-one/rest-commands",
      headers: { "content-type": "application/json" },
      payload: { type: "take_short_rest", hitDiceToSpend: 1, expectedRevision: 2, idempotencyKey: "short-dice" },
    });
    expect(takeRest).toHaveBeenCalledExactlyOnceWith("local-owner", {
      type: "take_short_rest",
      hitDiceToSpend: 1,
      campaignId: "campaign-one",
      actorId: "actor-one",
      expectedRevision: 2,
      idempotencyKey: "short-dice",
    });
    await app.close();
  });

  it("returns the real refusal reason instead of a bare conflict", async () => {
    for (const reason of [
      "long rest requires 24 hours since the prior long rest",
      "SRD short rest requires selected hit dice",
      "no resource can recover",
    ]) {
      const takeRest = vi.fn().mockImplementation(() => {
        throw new RestIllegalStateError(reason);
      });
      const app = await routeApp(takeRest);
      const response = await app.inject({
        method: "POST",
        url: "/api/rpg/v1/campaigns/campaign-one/actors/actor-one/rest-commands",
        headers: { "content-type": "application/json" },
        payload: { type: "take_long_rest", expectedRevision: 2, idempotencyKey: `long-${reason.length}` },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("RPG_ACTOR_REST_CONFLICT");
      expect(response.json().detail).toContain(reason);
      await app.close();
    }
  });
});

describe("rests in a Quick adventure", () => {
  async function hurtQuickHero() {
    const app = buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/rpg/v1/quick-adventures",
      payload: { idempotencyKey: `quick-rest-${Math.random()}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { campaignId, actorId } = created.json() as { campaignId: string; actorId: string };
    const repository = createRepository();
    try {
      const snapshot = repository.getActorResourceSnapshot("local-owner", campaignId, actorId)!;
      const health = repository.getM15ActorResources("local-owner", campaignId, actorId).find((r) => r.resourceId === "health")!;
      repository.mutateActorResource("local-owner", {
        type: "set_actor_resource",
        campaignId,
        actorId,
        resourceId: "health",
        current: Math.max(1, Math.floor(((health as { max?: number; capacity?: number }).max ?? (health as { capacity?: number }).capacity ?? 2) / 2)),
        expectedRevision: snapshot.revision,
        idempotencyKey: `hurt-${Math.random()}`,
      } as never);
    } finally {
      repository.close();
    }
    const read = async () =>
      (await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaignId}/actors/${actorId}/resources` })).json() as {
        revision: number;
        resources: Array<{ resourceId: string; current: number; max: number }>;
      };
    return { app, campaignId, actorId, read };
  }

  it("lets a hurt Quick adventure hero take a short rest spending one hit die", async () => {
    const { app, campaignId, actorId, read } = await hurtQuickHero();
    try {
      const before = await read();
      const hp = before.resources.find((r) => r.resourceId === "health")!;
      const rest = await app.inject({
        method: "POST",
        url: `/api/rpg/v1/campaigns/${campaignId}/actors/${actorId}/rest-commands`,
        headers: { "content-type": "application/json" },
        payload: { type: "take_short_rest", hitDiceToSpend: 1, expectedRevision: before.revision, idempotencyKey: "quick-short" },
      });
      expect(rest.statusCode, rest.body).toBe(200);
      const after = (await read()).resources.find((r) => r.resourceId === "health")!;
      expect(after.current).toBeGreaterThan(hp.current);
      expect(after.current).toBeLessThanOrEqual(after.max);
    } finally {
      await app.close();
    }
  });

  it("lets a hurt Quick adventure hero take a long rest back to full health", async () => {
    const { app, campaignId, actorId, read } = await hurtQuickHero();
    try {
      const before = await read();
      const rest = await app.inject({
        method: "POST",
        url: `/api/rpg/v1/campaigns/${campaignId}/actors/${actorId}/rest-commands`,
        headers: { "content-type": "application/json" },
        payload: { type: "take_long_rest", expectedRevision: before.revision, idempotencyKey: "quick-long" },
      });
      expect(rest.statusCode, rest.body).toBe(200);
      const after = (await read()).resources.find((r) => r.resourceId === "health")!;
      expect(after.current).toBe(after.max);
    } finally {
      await app.close();
    }
  });
});
