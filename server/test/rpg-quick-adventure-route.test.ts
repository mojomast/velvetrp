// Approved test for plan 1.6: POST /api/rpg/v1/quick-adventures builds the bundled starter
// world into the owner's database and returns the play room; same key replays, new key builds anew.
import { quickAdventureCreateResponseSchema } from "@velvet/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo, createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const URL = "/api/rpg/v1/quick-adventures";
const FLAGS = ["FEATURE_RPG_CAMPAIGN", "FEATURE_RPG_MECHANICS", "FEATURE_RPG_COMBAT"] as const;

beforeEach(() => { for (const flag of FLAGS) process.env[flag] = "true"; });
afterEach(() => { for (const flag of FLAGS) delete process.env[flag]; });

describe("POST /api/rpg/v1/quick-adventures", () => {
  it("creates a published campaign with an active room, replays the same key, and builds anew for a new key", async () => {
    const app = buildApp();
    try {
      const created = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "first-run-1" } });
      expect(created.statusCode).toBe(201);
      const body = quickAdventureCreateResponseSchema.parse(created.json());
      expect(body.replayed).toBe(false);

      const repository = createRepository();
      try {
        expect(repository.getCampaignAdministration("local-owner", body.campaignId)?.status).toBe("published");
        expect(repository.getSession(body.sessionId)?.state).toBe("active");
        expect(repository.listCampaignCharacters("local-owner", body.campaignId).map((entry) => entry.projection.actor.id))
          .toContain(body.actorId);
      } finally {
        repository.close();
      }

      const replay = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "first-run-1" } });
      expect(replay.statusCode).toBe(200);
      expect(quickAdventureCreateResponseSchema.parse(replay.json())).toEqual({ ...body, replayed: true });

      const another = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "first-run-2" } });
      expect(another.statusCode).toBe(201);
      const second = quickAdventureCreateResponseSchema.parse(another.json());
      expect(second.campaignId).not.toBe(body.campaignId);
      expect(second.sessionId).not.toBe(body.sessionId);

      const library = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" });
      expect(library.statusCode).toBe(200);
      expect(JSON.stringify(library.json())).toContain(body.campaignId);
    } finally {
      await app.close();
      closeRepo();
    }
  });

  it("rejects malformed requests before building anything", async () => {
    const app = buildApp();
    try {
      for (const payload of [{}, { idempotencyKey: "" }, { idempotencyKey: "has spaces" }, { idempotencyKey: "ok", extra: true }]) {
        const response = await app.inject({ method: "POST", url: URL, payload });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ code: "RPG_INVALID_REQUEST" });
      }
      const repository = createRepository();
      try {
        expect(repository.listCampaigns("local-owner")).toEqual([]);
      } finally {
        repository.close();
      }
    } finally {
      await app.close();
      closeRepo();
    }
  });

  it("is not available unless campaign, mechanics and combat are all enabled", async () => {
    for (const disabled of FLAGS) {
      for (const flag of FLAGS) process.env[flag] = flag === disabled ? "false" : "true";
      const app = buildApp();
      try {
        const response = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: `off-${disabled}` } });
        expect(response.statusCode).toBe(404);
      } finally {
        await app.close();
        closeRepo();
      }
    }
  });
});
