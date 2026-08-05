import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import { CHARACTER_BUILDER_STANDARD_ARRAY } from "@velvet/contracts";
import { removeFutureCharacterProgressionSchema } from "./helpers.js";

const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "velvet-v19-"));
const file = (dir: string) => path.join(dir, "velvet.sqlite");
const v19Tables = [
  "character_starting_grants_v19", "character_derived_snapshots_v19", "character_draft_revisions_v19",
  "character_draft_receipts_v19", "character_draft_events_v19", "character_draft_commands_v19",
  "character_draft_pins_v19", "character_drafts_v19",
];
const v20Tables = ["character_builder_layout_attestation_v22", "character_builder_layout_attestation_v21", "character_draft_command_provenance_v20",
  "character_draft_campaign_deletions_v20", "character_builder_layout_attestation_v20"];
function schema(name: string): unknown[] {
  const db = new DatabaseDriver(name, { readonly: true });
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close(); return rows;
}
function rewindToPopulatedV18(dir: string): { campaignId: string; characterId: string } {
  const repo = createRepository({ dataDir: dir, clock: { now: () => new Date("2031-01-01T00:00:00.000Z") } });
  const persona = repo.createCharacter({ name: "Preserved", age: 30, archetype: "Warden", boundaries: "", fictionalConfirmed: true });
  const campaign = repo.createCampaign("local-owner", { name: "Preserved v18" });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "v18-pin" });
  const scores = Object.fromEntries(["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as any;
  const draft = repo.createCharacterDraft("local-owner", campaign.id, { personaId: persona.id, controllerPrincipalId: "local-owner", durability: "durable",
    allocation: { method: "standard-array", scores }, idempotencyKey: "v18-draft" });
  const race = { ...MECHANICS_STARTER_CATALOG.definitions.find((value) => value.reference.kind === "race")!.reference, kind: "race" as const };
  const background = { ...MECHANICS_STARTER_CATALOG.definitions.find((value) => value.reference.kind === "background")!.reference, kind: "background" as const };
  const klass = { ...MECHANICS_STARTER_CATALOG.definitions.find((value) => value.reference.kind === "class")!.reference, kind: "class" as const };
  const selected = repo.updateCharacterDraft("local-owner", draft.draft.id, { expectedRevision: 0, idempotencyKey: "v18-select",
    selections: { race, background, class: klass, starterGrant: "kit" } });
  const finalized = repo.finalizeCharacterDraft("local-owner", draft.draft.id, { expectedRevision: selected.draft.revision, idempotencyKey: "v18-final" });
  repo.close();
  const db = new DatabaseDriver(file(dir));
  removeFutureCharacterProgressionSchema(db);
  const v20Triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB '*_v20' OR name GLOB '*_v20_*' OR name GLOB '*_v21' OR name GLOB '*_v21_*' OR name GLOB '*_v22' OR name GLOB '*_v22_*')").all() as Array<{name:string}>;
  for (const trigger of v20Triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec("DROP INDEX uq_character_draft_commands_v21_revision; DROP INDEX uq_character_draft_events_v21_revision; DROP INDEX uq_character_draft_receipts_v21_revision; DROP INDEX uq_character_draft_proposals_v21_revision");
  for (const table of v20Tables) db.exec(`DROP TABLE IF EXISTS ${table}`);
  for (const table of v19Tables) db.exec(`DROP TABLE ${table}`);
  db.prepare("UPDATE meta SET value='18' WHERE key='schemaVersion'").run(); db.close();
  return { campaignId: campaign.id, characterId: finalized.receipt.campaignCharacterId };
}

describe("additive schema v19r1 migration", () => {
  it("has fresh/migrated DDL parity, preserves populated aggregates, and creates no implicit drafts", () => {
    const migratedDir = makeDir(), identity = rewindToPopulatedV18(migratedDir);
    const before = new DatabaseDriver(file(migratedDir), { readonly: true });
    const aggregate = {
      character: before.prepare("SELECT * FROM campaign_characters WHERE id=?").get(identity.characterId),
      sheet: before.prepare("SELECT * FROM rpg_campaign_sheets WHERE campaign_character_id=?").get(identity.characterId),
      classes: before.prepare("SELECT * FROM rpg_character_classes ORDER BY sheet_id,position").all(),
      attributes: before.prepare("SELECT * FROM rpg_character_attributes ORDER BY sheet_id,position").all(),
      actors: before.prepare("SELECT * FROM campaign_actors ORDER BY id").all(),
      privateState: before.prepare("SELECT * FROM campaign_actor_private_state ORDER BY actor_id").all(),
      resources: before.prepare("SELECT * FROM rpg_actor_resources ORDER BY actor_id,name").all(),
    }; before.close();
    createRepository({ dataDir: migratedDir }).close();
    const migrated = new DatabaseDriver(file(migratedDir), { readonly: true });
    expect(migrated.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "29" });
    expect({
      character: migrated.prepare("SELECT * FROM campaign_characters WHERE id=?").get(identity.characterId),
      sheet: migrated.prepare("SELECT * FROM rpg_campaign_sheets WHERE campaign_character_id=?").get(identity.characterId),
      classes: migrated.prepare("SELECT * FROM rpg_character_classes ORDER BY sheet_id,position").all(),
      attributes: migrated.prepare("SELECT * FROM rpg_character_attributes ORDER BY sheet_id,position").all(),
      actors: migrated.prepare("SELECT * FROM campaign_actors ORDER BY id").all(),
      privateState: migrated.prepare("SELECT * FROM campaign_actor_private_state ORDER BY actor_id").all(),
      resources: migrated.prepare("SELECT * FROM rpg_actor_resources ORDER BY actor_id,name").all(),
    }).toEqual(aggregate);
    expect(migrated.prepare("SELECT COUNT(*) count FROM character_drafts_v19").get()).toEqual({ count: 0 });
    migrated.close();
    const fresh = makeDir(); createRepository({ dataDir: fresh }).close();
    expect(schema(file(migratedDir))).toEqual(schema(file(fresh)));
  });

  it.each([
    ["catalog index", "DROP INDEX idx_campaign_catalog_command_provenance_v18_event", "schema v18 artifact idx_campaign_catalog_command_provenance_v18_event is missing"],
    ["character columns", "ALTER TABLE rpg_character_attributes ADD COLUMN forged TEXT", "schema v18 character artifact rpg_character_attributes columns are incompatible"],
  ])("strictly rejects damaged v18 %s before creating any v19 artifact", (_label, statement, message) => {
    const dir = makeDir(); rewindToPopulatedV18(dir);
    const damage = new DatabaseDriver(file(dir)); damage.exec(statement); damage.close();
    expect(() => createRepository({ dataDir: dir })).toThrow(message);
    const verify = new DatabaseDriver(file(dir), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "18" });
    expect(verify.prepare("SELECT 1 FROM sqlite_master WHERE name='character_drafts_v19'").get()).toBeUndefined(); verify.close();
  });

  it("rolls back a late DDL failure to the exact populated v18 marker", () => {
    const dir = makeDir(), identity = rewindToPopulatedV18(dir);
    const poison = new DatabaseDriver(file(dir)); poison.exec("CREATE TABLE character_starting_grants_v19 (poison TEXT)"); poison.close();
    expect(() => createRepository({ dataDir: dir })).toThrow();
    const verify = new DatabaseDriver(file(dir), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "18" });
    expect(verify.prepare("SELECT id FROM campaign_characters WHERE id=?").get(identity.characterId)).toEqual({ id: identity.characterId });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name='character_drafts_v19'").get()).toBeUndefined();
    expect(verify.prepare("PRAGMA table_info(character_starting_grants_v19)").all()).toMatchObject([{ name: "poison" }]); verify.close();
  });
});
