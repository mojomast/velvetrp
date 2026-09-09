import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { actorRestHttpRoutes } from "../src/routes/rpg/v1/actorRest.js";

const at = "2035-01-01T00:00:00.000Z";

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
});

describe("actor rest HTTP route", () => {
  it("projects a committed repository rest into the strict route-owned response", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const takeRest = vi.fn().mockReturnValue({
      rest: {
        restId: "rest-one",
        campaignId: "campaign-one",
        actorId: "actor-one",
        kind: "short",
        recoveredAt: at,
        recovery: { resources: [{ resourceId: "focus", before: 1, after: 4 }] },
        revisionBefore: 2,
        revisionAfter: 3,
        idempotencyKey: "short-rest-one",
      },
      actorState: { resources: [{ resourceId: "focus", current: 4, capacity: 4 }], revision: 3 },
    });
    const app = Fastify({ logger: false });
    await app.register(actorRestHttpRoutes, { prefix: "/api/rpg/v1", restRepositoryAccessor: () => ({ takeRest }) });

    const response = await app.inject({
      method: "POST",
      url: "/api/rpg/v1/campaigns/campaign-one/actors/actor-one/rest-commands",
      headers: { "content-type": "application/json" },
      payload: { type: "take_short_rest", expectedRevision: 2, idempotencyKey: "short-rest-one" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      actorState: { resources: [{ resourceId: "focus", current: 4, capacity: 4 }], revision: 3 },
      receipt: {
        kind: "short",
        recoveredAt: at,
        recovery: { resources: [{ resourceId: "focus", before: 1, after: 4 }] },
        revisionBefore: 2,
        revisionAfter: 3,
        idempotencyKey: "short-rest-one",
      },
    });
    expect(response.json().receipt).not.toHaveProperty("restId");
    expect(response.json().receipt).not.toHaveProperty("campaignId");
    expect(response.json().receipt).not.toHaveProperty("actorId");
    expect(takeRest).toHaveBeenCalledExactlyOnceWith("local-owner", {
      type: "take_short_rest",
      campaignId: "campaign-one",
      actorId: "actor-one",
      expectedRevision: 2,
      idempotencyKey: "short-rest-one",
    });
    await app.close();
  });
});
