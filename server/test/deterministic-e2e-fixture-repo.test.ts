import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { describe, expect, it, vi } from "vitest";
import { createSession, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import {
  createDeterministicE2EFixturesForOwnedRepository,
  createDeterministicE2ERepository,
  DeterministicE2EFixtureAuthorizationError,
  DeterministicE2EFixtureConflictError,
  DeterministicE2EFixtureStaleError,
} from "../src/repo/testing/deterministicE2EFixtureRepo.js";
import { createRepositoryTestingComposition } from "../src/repo/campaignRepositoryOrchestration.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const OWNER = "local-owner";
const WAYLAMP = {
  kind: "item" as const,
  packId: MECHANICS_STARTER_CATALOG.manifest.packId,
  packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
  definitionId: "velvet:mechanics:item:waylamp",
};
const scores = Object.fromEntries(
  ["might", "agility", "resolve", "insight", "presence", "craft"]
    .map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
) as CharacterBuilderAttributeScores;

function setup() {
  let generatedId = 0;
  const clock = vi.fn(() => new Date("2035-01-01T00:00:00.000Z"));
  const ids = { nextId: vi.fn(() => `deterministic-fixture-${++generatedId}`) };
  const composition = createDeterministicE2ERepository({
    dataDir: process.env.VELVET_DATA_DIR!,
    clock: { now: clock },
    ids,
  });
  const { repository } = composition;
  const campaign = repository.createCampaign(OWNER, { name: "Deterministic fixture seam" });
  repository.installMechanicsStarterCatalog(OWNER);
  repository.configureMechanicsStarterCatalog(OWNER, campaign.id, { expectedRevision: 0, idempotencyKey: "fixture-pins" });
  const makeActor = (name: string, key: string) => {
    const persona = repository.createCharacter({ name, age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
    const draft = repository.createCharacterDraft(OWNER, campaign.id, {
      personaId: persona.id,
      controllerPrincipalId: OWNER,
      durability: "durable",
      allocation: { method: "standard-array", scores },
      idempotencyKey: `${key}-draft`,
    });
    const definition = (kind: "race" | "background" | "class") =>
      MECHANICS_STARTER_CATALOG.definitions.find((candidate) => candidate.reference.kind === kind)!.reference;
    const selected = repository.updateCharacterDraft(OWNER, draft.draft.id, {
      expectedRevision: 0,
      idempotencyKey: `${key}-select`,
      selections: { race: definition("race"), background: definition("background"), class: definition("class"), starterGrant: "kit" },
    } as never);
    return repository.finalizeCharacterDraft(OWNER, draft.draft.id, {
      expectedRevision: selected.draft.revision,
      idempotencyKey: `${key}-finalize`,
    }).receipt.actorId;
  };
  return { ...composition, campaignId: campaign.id, actorId: makeActor("Aster", "aster"),
    otherActorId: makeActor("Briar", "briar"), clock, ids };
}

function inspect() {
  return new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
}

describe("deterministic E2E fixture repository", () => {
  it("keeps the testing composition connection out of its callback and result types", () => {
    if (false) {
      createRepositoryTestingComposition({}, (fixtureDatabase) => {
        // @ts-expect-error The testing callback receives a narrow capability, not the owned driver.
        const leakedDriver: DatabaseDriver.Database = fixtureDatabase;
        void leakedDriver;
        return createDeterministicE2EFixturesForOwnedRepository(fixtureDatabase);
      });
      createRepositoryTestingComposition(
        {},
        // @ts-expect-error The testing composition result is exactly the fixture interface.
        (fixtureDatabase) => fixtureDatabase,
      );
    }
  });

  it("requires campaign ownership and the current M1.5 actor revision", () => {
    const fixture = setup();
    expect(() => fixture.fixtures.materializeWaylamp({
      principalId: "not-owner", campaignId: fixture.campaignId, actorId: fixture.actorId,
      entryId: "forbidden-waylamp", expectedRevision: 0,
    })).toThrow(DeterministicE2EFixtureAuthorizationError);
    expect(() => fixture.fixtures.materializeShortRestFocus({
      principalId: OWNER, campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 1,
    })).toThrow(DeterministicE2EFixtureStaleError);

    fixture.fixtures.materializeWaylamp({
      principalId: OWNER, campaignId: fixture.campaignId, actorId: fixture.actorId,
      entryId: "owned-waylamp", expectedRevision: 0,
    });
    fixture.repository.mutateInventoryForActor(OWNER, fixture.campaignId, fixture.actorId, {
      kind: "equip", entryId: "owned-waylamp", slot: "hand", expectedRevision: 0, idempotencyKey: "equip-waylamp",
    });
    expect(() => fixture.fixtures.materializeShortRestFocus({
      principalId: OWNER, campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0,
    })).toThrow(DeterministicE2EFixtureStaleError);
    expect(() => fixture.fixtures.materializeShortRestFocus({
      principalId: OWNER, campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 1,
    })).toThrow(DeterministicE2EFixtureStaleError);
    fixture.repository.close();
  });

  it("replays exact state, conflicts on reused identity, and writes no revision or receipt", () => {
    const fixture = setup();
    const target = { principalId: OWNER, campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0 };
    expect(fixture.fixtures.materializeWaylamp({ ...target, entryId: "exact-waylamp" })).toBeUndefined();
    expect(fixture.fixtures.materializeWaylamp({ ...target, entryId: "exact-waylamp" })).toBeUndefined();
    expect(fixture.fixtures.materializeShortRestFocus(target)).toBeUndefined();
    expect(fixture.fixtures.materializeShortRestFocus(target)).toBeUndefined();
    expect(fixture.fixtures.materializeEconomyGraph(target)).toBeUndefined();
    expect(fixture.fixtures.materializeEconomyGraph(target)).toBeUndefined();
    expect(() => fixture.fixtures.materializeWaylamp({ ...target, actorId: fixture.otherActorId, entryId: "exact-waylamp" }))
      .toThrow(DeterministicE2EFixtureConflictError);

    const db = inspect();
    expect(db.prepare("SELECT count(*) count FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=?").get(fixture.campaignId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM rpg_m15_receipts_v25 WHERE campaign_id=?").get(fixture.campaignId)).toEqual({ count: 0 });
    db.close();
    fixture.repository.close();
  });

  it("rolls back the entire economy graph when a real database constraint aborts", () => {
    const fixture = setup();
    const db = inspect();
    db.exec(`CREATE TRIGGER deterministic_fixture_test_abort BEFORE INSERT ON rpg_shop_stock_v25
      BEGIN SELECT RAISE(ABORT,'test stock rejection'); END;`);
    expect(() => fixture.fixtures.materializeEconomyGraph({
      principalId: OWNER, campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0,
    })).toThrow("test stock rejection");
    for (const table of ["rpg_currency_references_v25", "rpg_wallets_v25", "rpg_shop_definitions_v25", "rpg_shop_stock_v25"]) {
      expect(db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    db.exec("DROP TRIGGER deterministic_fixture_test_abort");
    fixture.fixtures.materializeEconomyGraph({
      principalId: OWNER, campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0,
    });
    expect(fixture.repository.getWallet(OWNER, fixture.campaignId, fixture.actorId)?.balances[0]?.minorUnits).toBe(20);
    db.close();
    fixture.repository.close();
  });

  it("makes fixture state visible to normal commands on the shared connection", () => {
    const fixture = setup();
    const target = { principalId: OWNER, campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0 };
    fixture.fixtures.materializeWaylamp({ ...target, entryId: "command-waylamp" });
    fixture.fixtures.materializeShortRestFocus(target);
    fixture.fixtures.materializeEconomyGraph(target);

    expect(fixture.repository.getActorInventorySnapshot(OWNER, fixture.campaignId, fixture.actorId)?.inventory.items)
      .toMatchObject([{ entryId: "command-waylamp", item: WAYLAMP }]);
    expect(fixture.repository.getActorResourceSnapshot(OWNER, fixture.campaignId, fixture.actorId)?.resources)
      .toContainEqual({ resourceId: "focus", current: 1, capacity: 4 });
    expect(fixture.repository.getShop(OWNER, fixture.campaignId, "e2e-waylamp-shop")?.stock[0]?.quantity).toBe(2);
    expect(fixture.repository.mutateInventoryForActor(OWNER, fixture.campaignId, fixture.actorId, {
      kind: "equip", entryId: "command-waylamp", slot: "hand", expectedRevision: 0, idempotencyKey: "normal-equip",
    }).receipt.revisionAfter).toBe(1);
    expect(fixture.repository.takeRest(OWNER, {
      type: "take_short_rest", campaignId: fixture.campaignId, actorId: fixture.actorId,
      expectedRevision: 1, idempotencyKey: "normal-rest",
    }).rest.recovery.resources).toEqual([{ resourceId: "focus", before: 1, after: 4 }]);
    fixture.repository.close();
  });

  it("fails fixture operations after the shared repository closes", () => {
    const fixture = setup();
    fixture.repository.close();
    expect(() => fixture.fixtures.materializeShortRestFocus({
      principalId: OWNER, campaignId: fixture.campaignId, actorId: fixture.actorId, expectedRevision: 0,
    })).toThrow("repository is closed");
    fixture.repository.close();
  });

  it("requires exact local ownership and replays only the exact public location", () => {
    const fixture = setup();
    const input = { campaignId: fixture.campaignId, locationId: "fixture-harbor", parentLocationId: null,
      name: "Fixture Harbor", description: "A deterministic public harbor." };
    const clockCalls = fixture.clock.mock.calls.length;
    const idCalls = fixture.ids.nextId.mock.calls.length;
    expect(fixture.fixtures.materializeCampaignLocation(input)).toBeUndefined();
    expect(fixture.fixtures.materializeCampaignLocation(input)).toBeUndefined();
    expect(fixture.clock).toHaveBeenCalledTimes(clockCalls);
    expect(fixture.ids.nextId).toHaveBeenCalledTimes(idCalls);

    const db = inspect();
    expect(db.prepare("SELECT * FROM campaign_locations_v28 WHERE location_id=?").get(input.locationId)).toMatchObject({
      campaign_id: fixture.campaignId, parent_location_id: null, public_name: input.name,
      public_description: input.description, visibility: "public", created_at: "2035-01-01T00:00:00.000Z",
    });
    expect(db.prepare("SELECT count(*) count FROM world_mutation_revisions_v28").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM world_narrative_revisions_v32").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM world_commands_v28").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM world_receipts_v28").get()).toEqual({ count: 0 });
    expect(() => fixture.fixtures.materializeCampaignLocation({ ...input, description: "Different" }))
      .toThrow(DeterministicE2EFixtureConflictError);

    expect(() => fixture.fixtures.materializeCampaignLocation({ ...input,
      campaignId: "unavailable-campaign", locationId: "not-owned" }))
      .toThrow(DeterministicE2EFixtureAuthorizationError);
    db.close();
    fixture.repository.close();
  });

  it("requires a parent in the same campaign and rolls back an aborted insert", () => {
    const fixture = setup();
    const otherCampaign = fixture.repository.createCampaign(OWNER, { name: "Other fixture campaign" });
    fixture.fixtures.materializeCampaignLocation({ campaignId: otherCampaign.id, locationId: "foreign-parent",
      parentLocationId: null, name: "Foreign Parent", description: "" });
    expect(() => fixture.fixtures.materializeCampaignLocation({ campaignId: fixture.campaignId,
      locationId: "wrong-child", parentLocationId: "foreign-parent", name: "Wrong Child", description: "" }))
      .toThrow(DeterministicE2EFixtureAuthorizationError);

    const db = inspect();
    db.exec(`CREATE TABLE deterministic_location_audit(value TEXT NOT NULL);
      CREATE TRIGGER deterministic_location_abort BEFORE INSERT ON campaign_locations_v28
      WHEN NEW.location_id='aborted-location' BEGIN
        INSERT INTO deterministic_location_audit VALUES(NEW.location_id);
        SELECT RAISE(ABORT,'test location rejection');
      END;`);
    expect(() => fixture.fixtures.materializeCampaignLocation({ campaignId: fixture.campaignId,
      locationId: "aborted-location", parentLocationId: null, name: "Aborted", description: "" }))
      .toThrow("test location rejection");
    expect(db.prepare("SELECT count(*) count FROM campaign_locations_v28 WHERE location_id='aborted-location'").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT count(*) count FROM deterministic_location_audit").get()).toEqual({ count: 0 });
    db.close();
    fixture.repository.close();
  });

  it("makes locations visible through production world reads and rejects use after close", async () => {
    const fixture = setup();
    const persona = fixture.repository.createCharacter({ name: "World reader", age: 30, archetype: "Guide",
      boundaries: "", fictionalConfirmed: true });
    const session = await createSession({ characterId: persona.id, title: "Fixture world" });
    fixture.repository.attachCampaignSession(OWNER, { campaignId: fixture.campaignId, sessionId: session.id });
    fixture.fixtures.materializeCampaignLocation({ campaignId: fixture.campaignId, locationId: "visible-fixture",
      parentLocationId: null, name: "Visible Fixture", description: "Seen by production." });
    expect(fixture.repository.getCampaignWorld(OWNER, fixture.campaignId)?.visibleLocations).toContainEqual({
      locationId: "visible-fixture", parentLocationId: null, name: "Visible Fixture", description: "Seen by production.",
    });
    fixture.repository.close();
    expect(() => fixture.fixtures.materializeCampaignLocation({ campaignId: fixture.campaignId,
      locationId: "after-close", parentLocationId: null, name: "After Close", description: "" }))
      .toThrow("repository is closed");
  });
});
