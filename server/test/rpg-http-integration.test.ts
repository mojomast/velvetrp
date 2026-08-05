import { afterEach, describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY } from "@velvet/contracts";
import { buildApp } from "../src/app.js";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
});

describe("integrated RPG HTTP lanes", () => {
  it("shares the lazy real repository across draft, progression, and administration lanes", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    process.env.FEATURE_RPG_MECHANICS = "true";
    const repository = createRepository();
    const persona = repository.createCharacter({ name: "HTTP Persona", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
    const campaign = repository.createCampaign("local-owner", { name: "HTTP RPG" });
    repository.installMechanicsStarterCatalog("local-owner");
    repository.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "http-configure" });
    const app = buildApp({ campaignRepositoryFactory: () => repository });
    const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"]
      .map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]));

    const created = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/character-drafts`,
      headers: { "content-type": "application/json" }, payload: {
        personaId: persona.id, durability: "durable", allocation: { method: "standard-array", scores }, idempotencyKey: "http-draft",
      } });
    expect(created.statusCode).toBe(201);
    const draft = created.json().draft;
    const read = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/character-drafts/${draft.id}` });
    expect(read.statusCode).toBe(200);
    const race = MECHANICS_STARTER_CATALOG.definitions.find((value) => value.reference.kind === "race")!.reference;
    const background = MECHANICS_STARTER_CATALOG.definitions.find((value) => value.reference.kind === "background")!.reference;
    const klass = MECHANICS_STARTER_CATALOG.definitions.find((value) => value.reference.kind === "class")!.reference;
    const updated = await app.inject({ method: "PATCH", url: `/api/rpg/v1/campaigns/${campaign.id}/character-drafts/${draft.id}`,
      headers: { "content-type": "application/json" }, payload: {
        expectedRevision: 0, idempotencyKey: "http-draft-update", selections: { race, background, class: klass, starterGrant: "kit" },
      } });
    expect(updated.statusCode).toBe(200);
    const finalized = repository.finalizeCharacterDraft("local-owner", draft.id, { expectedRevision: 1, idempotencyKey: "http-finalize" });
    const characterId = finalized.receipt.campaignCharacterId;

    const progression = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/characters/${characterId}/progression` });
    expect(progression.statusCode).toBe(200);
    const preview = await app.inject({ method: "POST", url: `/api/rpg/v1/campaigns/${campaign.id}/characters/${characterId}/progression/preview`,
      headers: { "content-type": "application/json" }, payload: { selections: [] } });
    expect(preview.statusCode).toBe(200);
    const administration = await app.inject({ method: "GET", url: `/api/rpg/v1/campaigns/${campaign.id}/administration` });
    expect(administration.statusCode).toBe(200);
    const patched = await app.inject({ method: "PATCH", url: `/api/rpg/v1/campaigns/${campaign.id}/administration`,
      headers: { "content-type": "application/json" }, payload: { expectedRevision: 1, idempotencyKey: "http-admin", status: "published" } });
    expect(patched.statusCode).toBe(200);
    await app.close();
  });
});
