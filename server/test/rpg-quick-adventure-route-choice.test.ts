// Approved test (Hermes/Nous quick adventure): POST /api/rpg/v1/quick-adventures builds the requested bundled
// world; without an id it still builds Sintermark, and an unknown id is a 400 that builds nothing.
import { quickAdventureCreateResponseSchema } from "@velvet/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { closeRepo, createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const URL = "/api/rpg/v1/quick-adventures";
const FLAGS = ["FEATURE_RPG_CAMPAIGN", "FEATURE_RPG_MECHANICS", "FEATURE_RPG_COMBAT"] as const;

beforeEach(() => {
  for (const flag of FLAGS) process.env[flag] = "true";
});
afterEach(() => {
  for (const flag of FLAGS) delete process.env[flag];
});

describe("POST /api/rpg/v1/quick-adventures adventure choice", () => {
  it("builds the Hermes/Nous world with six heroes when asked, and Sintermark by default", async () => {
    const app = buildApp();
    try {
      const hermes = await app.inject({
        method: "POST",
        url: URL,
        payload: { idempotencyKey: "hermes-run-1", adventureId: "hermes-nous" },
      });
      expect(hermes.statusCode).toBe(201);
      const body = quickAdventureCreateResponseSchema.parse(hermes.json());
      expect(body.campaignName).toBe("Hermes Agent Squad: We Never Surrender");

      const fallback = await app.inject({ method: "POST", url: URL, payload: { idempotencyKey: "default-run-1" } });
      expect(fallback.statusCode).toBe(201);
      const sintermark = quickAdventureCreateResponseSchema.parse(fallback.json());
      expect(sintermark.campaignName).toMatch(/Sintermark/);

      const repository = createRepository();
      try {
        expect(repository.listCampaignCharacters("local-owner", body.campaignId)).toHaveLength(6);
        expect(repository.listCampaignCharacters("local-owner", sintermark.campaignId)).toHaveLength(2);
        expect(repository.getSession(body.sessionId)?.state).toBe("active");
      } finally {
        repository.close();
      }
    } finally {
      await app.close();
      closeRepo();
    }
  }, 180_000);

  it("rejects an unknown adventure id without building anything", async () => {
    const app = buildApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: URL,
        payload: { idempotencyKey: "bad-run-1", adventureId: "no-such-world" },
      });
      expect(response.statusCode).toBe(400);
      const library = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns" });
      expect(JSON.stringify(library.json())).not.toMatch(/Hermes Agent Squad|Sintermark/);
    } finally {
      await app.close();
      closeRepo();
    }
  });
});
