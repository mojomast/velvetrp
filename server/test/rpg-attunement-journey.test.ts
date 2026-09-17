import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
} from "@velvet/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { createRepository, SRD_5_1_STARTER_CATALOG, type Repository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";
import { grantSrdEquipment } from "./fixtures/srdEquipment.js";

useTmpDataDir();

const JSON_HEADERS = { "content-type": "application/json" };
const RING = "srd-5.1:item:ring-of-protection";
const CLOAK = "srd-5.1:item:cloak-of-elvenkind";
const BRACERS = "srd-5.1:item:bracers-of-defense";
const EVASION = "srd-5.1:item:ring-of-evasion";
const WAND = "srd-5.1:item:wand-of-magic-missiles";

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  delete process.env.FEATURE_RPG_MECHANICS;
});

function enableRpg(): void {
  process.env.FEATURE_RPG_CAMPAIGN = "true";
  process.env.FEATURE_RPG_MECHANICS = "true";
}

function newRepository(): Repository {
  return createRepository({ clock: { now: () => new Date("2035-01-01T00:00:00.000Z") } });
}

function createActor(repo: Repository, campaignId: string): string {
  const persona = repo.createCharacter({ name: "Aster", age: 30, archetype: "Fighter", boundaries: "", fictionalConfirmed: true });
  const draft = repo.createCharacterDraft("local-owner", campaignId, {
    personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
    allocation: { method: "standard-array", scores: Object.fromEntries(SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, i) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[i]])) as never },
    idempotencyKey: "attunement-draft",
  });
  const definitions = SRD_5_1_STARTER_CATALOG.definitions;
  const race = definitions.find((d) => d.reference.kind === "race")!.reference;
  const background = definitions.find((d) => d.reference.kind === "background")!.reference;
  const klass = definitions.find((d) => d.reference.kind === "class")!.reference;
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, {
    expectedRevision: 0, idempotencyKey: "attunement-select",
    selections: { race, background, class: klass, starterGrant: "kit" },
  } as never);
  return repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "attunement-final" }).receipt.actorId;
}

async function bootstrap() {
  const repo = newRepository();
  const campaign = repo.createCampaign("local-owner", { name: "Attunement Road" });
  repo.installSrdStarterCatalog("local-owner");
  repo.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "attunement-catalog" });
  const actorId = createActor(repo, campaign.id);
  for (const item of ["ring-of-protection", "cloak-of-elvenkind", "bracers-of-defense", "ring-of-evasion", "wand-of-magic-missiles"]) {
    grantSrdEquipment(campaign.id, actorId, item);
  }
  const app = buildApp({ campaignRepositoryFactory: () => repo });
  return { repo, campaign, actorId, app };
}

const url = (campaignId: string, actorId: string) => `/api/rpg/v1/campaigns/${campaignId}/actors/${actorId}/attunements`;

describe("deterministic magic-item attunement journey", () => {
  it("attunes, enforces the SRD limit and prerequisites, survives restart, and drops", async () => {
    enableRpg();
    const { repo, campaign, actorId, app } = await bootstrap();
    const path = url(campaign.id, actorId);

    const empty = await app.inject({ method: "GET", url: path });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toMatchObject({ campaignId: campaign.id, actorId, limit: 3, attunements: [] });

    const attune = (definitionId: string, satisfiedRest: "short-rest" | "long-rest" | null, key = definitionId) =>
      app.inject({ method: "POST", url: path, headers: JSON_HEADERS, payload: { command: "attune", key, definitionId, satisfiedRest } });

    const missingPrerequisite = await attune(RING, null);
    expect(missingPrerequisite.statusCode).toBe(200);
    expect(missingPrerequisite.json()).toMatchObject({ ok: false, code: "prerequisite-missing", snapshot: { attunements: [] } });

    const first = await attune(RING, "short-rest");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, code: null, snapshot: { limit: 3, attunements: [{ key: RING, definition: { definitionId: RING } }] } });

    expect((await attune(CLOAK, "long-rest")).json()).toMatchObject({ ok: true });
    expect((await attune(BRACERS, "short-rest")).json()).toMatchObject({ ok: true });
    const overflow = await attune(EVASION, "short-rest");
    expect(overflow.json()).toMatchObject({ ok: false, code: "capacity-exceeded" });
    expect(overflow.json().snapshot.attunements).toHaveLength(3);

    const notAttunable = await attune(WAND, "short-rest");
    expect(notAttunable.json()).toMatchObject({ ok: false, code: "not-attunable" });

    const unknown = await attune("srd-5.1:item:not-a-real-item", "short-rest");
    expect(unknown.json()).toMatchObject({ ok: false, code: "definition-unavailable" });

    // Restart: the durable set is re-read from the persisted database, not memory.
    repo.close();
    const reopened = newRepository();
    const restarted = buildApp({ campaignRepositoryFactory: () => reopened });
    const afterRestart = await restarted.inject({ method: "GET", url: path });
    expect(afterRestart.statusCode, afterRestart.body).toBe(200);
    expect(afterRestart.json().attunements.map((entry: { key: string }) => entry.key)).toEqual([BRACERS, CLOAK, RING]);

    const drop = await restarted.inject({ method: "POST", url: path, headers: JSON_HEADERS, payload: { command: "drop", key: RING } });
    expect(drop.statusCode, drop.body).toBe(200);
    expect(drop.json()).toMatchObject({ ok: true, snapshot: { attunements: [{ key: BRACERS }, { key: CLOAK }] } });
    const repeatDrop = await restarted.inject({ method: "POST", url: path, headers: JSON_HEADERS, payload: { command: "drop", key: RING } });
    expect(repeatDrop.json()).toMatchObject({ ok: true, snapshot: { attunements: [{ key: BRACERS }, { key: CLOAK }] } });

    await restarted.close();
    await app.close();
    reopened.close();
  }, 180_000); // Load headroom, not an assertion relaxation: the bootstrap plus durable restart can exceed the shared 90s budget under parallel forks.

  it("hides a mismatched campaign and denies an unauthorized actor", async () => {
    enableRpg();
    const { repo, campaign, actorId, app } = await bootstrap();
    const mismatched = await app.inject({ method: "GET", url: url("other-campaign", actorId) });
    expect(mismatched.statusCode).toBe(404);
    expect(mismatched.json()).toMatchObject({ code: "RPG_ATTUNEMENT_NOT_FOUND" });
    const unauthorized = await app.inject({ method: "GET", url: url(campaign.id, "unknown-actor") });
    expect(unauthorized.statusCode).toBe(404);
    await app.close();
    repo.close();
  });
});
