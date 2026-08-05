import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ORIGINAL_STARTER_BACKGROUND, ORIGINAL_STARTER_CLASS, ORIGINAL_STARTER_RACE } from "@velvet/contracts";
import { createRepository } from "../src/repo/index.js";
import { removeFutureCharacterBuilderSchema } from "./helpers.js";

const V15_TABLES = ["campaign_checkpoint_attribute_snapshots", "campaign_checkpoint_resource_snapshots",
  "campaign_imported_administration_receipts", "campaign_imported_administration_events",
  "campaign_imported_timeline_events", "campaign_timeline_events", "campaign_import_submissions",
  "campaign_export_manifests", "campaign_imports", "campaign_recaps", "campaign_checkpoints",
  "campaign_administration_receipts", "campaign_administration_events", "campaign_timeline_history",
  "campaign_administration_commands"] as const;
const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "velvet-v15-"));
const file = (dir: string) => path.join(dir, "velvet.sqlite");

function genuineV14(dir: string): void {
  let sequence = 0;
  const repo = createRepository({ dataDir: dir, ids: { nextId: () => `v14-id-${++sequence}` },
    clock: { now: () => new Date("2030-01-02T03:04:05.006Z") }, rng: { integer: (minimum) => minimum } });
  const campaign = repo.createCampaign("local-owner", { name: "Preserved v14" });
  repo.installOriginalStarterContent("local-owner", campaign.id); repo.configureOriginalStarterContent("local-owner", campaign.id);
  const persona = repo.createCharacter({ name: "V14 Hero", age: 22, archetype: "hero", boundaries: "",
    safeWord: "safe", fictionalConfirmed: true });
  const actor = repo.createOriginalStarterCampaignCharacter("local-owner", { campaignId: campaign.id,
    characterId: persona.id, controllerPrincipalId: "local-owner", race: ORIGINAL_STARTER_RACE.reference,
    background: ORIGINAL_STARTER_BACKGROUND.reference, classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }],
    attributes: [], proficiencies: [], choices: [] }).projection;
  const seed = new DatabaseDriver(file(dir));
  seed.prepare(`INSERT INTO rpg_character_attributes (campaign_id,sheet_id,position,attribute_id,value)
    VALUES (?,?,0,'strength',9)`).run(campaign.id, actor.sheet.id);
  seed.exec(`INSERT INTO principals VALUES ('v14-player','V14 Player',0);
    INSERT INTO sessions (id,character_id,title,state,preset_id,created_at)
      VALUES ('v14-room','${persona.id}','V14 Room','active','default','2030-01-02T03:04:05.006Z');
    INSERT INTO session_characters VALUES ('v14-room','${persona.id}',0);`); seed.close();
  repo.addCampaignMembership("local-owner", campaign.id, { principalId: "v14-player", role: "player" });
  repo.attachCampaignSession("local-owner", { campaignId: campaign.id, sessionId: "v14-room" });
  repo.executeSetActorAttribute("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
    actorId: actor.actor.id, commandId: "v14-command", idempotencyKey: "v14-command-key", expectedRevision: 0,
    sourceTurnId: null, command: { type: "set_actor_attribute", payload: { attributeId: "strength", value: 10 } } });
  repo.close();
  const db = new DatabaseDriver(file(dir));
  db.pragma("foreign_keys = OFF");
  removeFutureCharacterBuilderSchema(db);
  db.exec(`DROP TABLE IF EXISTS campaign_catalog_command_provenance_v18;
    DROP TABLE IF EXISTS campaign_catalog_current_pins; DROP TABLE IF EXISTS campaign_catalog_current_selections;
    DROP TABLE IF EXISTS campaign_catalog_receipts; DROP TABLE IF EXISTS campaign_catalog_events; DROP TABLE IF EXISTS campaign_catalog_commands;
    DROP TABLE IF EXISTS rpg_catalog_publication_submissions; DROP TABLE IF EXISTS rpg_catalog_definition_visibility;
    DROP TABLE IF EXISTS rpg_catalog_publication_attestations; DROP TABLE IF EXISTS campaign_content_catalog_pins;
    DROP TABLE IF EXISTS campaign_content_catalog_selections; DROP TABLE IF EXISTS rpg_catalog_definitions;
    DROP TABLE IF EXISTS rpg_content_pack_publications; DROP TRIGGER IF EXISTS rpg_content_packs_prevent_replace_v16;
    DROP TRIGGER IF EXISTS rpg_definitions_prevent_replace_v16;`);
  db.exec(`DROP TRIGGER IF EXISTS campaign_events_link_timeline;
    DROP TRIGGER IF EXISTS campaigns_prevent_updated_at_rewind;
    DROP TRIGGER IF EXISTS campaign_administration_revision_advance;`);
  for (const table of V15_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec(`ALTER TABLE campaigns DROP COLUMN administration_revision;
    ALTER TABLE campaigns DROP COLUMN settings;
    ALTER TABLE campaigns DROP COLUMN lifecycle_status;
    UPDATE meta SET value='14' WHERE key='schemaVersion';`);
  db.close();
}

function schema(fileName: string): unknown[] {
  const db = new DatabaseDriver(fileName, { readonly: true });
  const rows = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all(); db.close(); return rows;
}

describe("genuine additive v14 to v15 migration", () => {
  it("preserves rows and matches fresh DDL exactly", () => {
    const migratedDir = makeDir(); genuineV14(migratedDir);
    const before = new DatabaseDriver(file(migratedDir), { readonly: true });
    const campaign = before.prepare(`SELECT id,name,active_timeline_id,owner_principal_id,owner_role,created_at,updated_at
      FROM campaigns`).get();
    const closedAudit = before.prepare(`SELECT
      (SELECT COUNT(*) FROM campaign_commands) commands,
      (SELECT COUNT(*) FROM campaign_events) events,
      (SELECT COUNT(*) FROM command_receipts) receipts,
      (SELECT COUNT(*) FROM characters) characters,
      (SELECT COUNT(*) FROM sessions) sessions,
      (SELECT COUNT(*) FROM campaign_memberships) memberships,
      (SELECT COUNT(*) FROM campaign_sessions) rooms,
      (SELECT COUNT(*) FROM campaign_content_packs) pins`).get(); before.close();
    expect(closedAudit).toEqual({ commands: 1, events: 1, receipts: 1, characters: 1,
      sessions: 1, memberships: 2, rooms: 1, pins: 1 });
    createRepository({ dataDir: migratedDir }).close();
    const migrated = new DatabaseDriver(file(migratedDir), { readonly: true });
    expect(migrated.prepare(`SELECT id,name,active_timeline_id,owner_principal_id,owner_role,created_at,updated_at
      FROM campaigns`).get()).toEqual(campaign);
    expect(migrated.prepare(`SELECT (SELECT COUNT(*) FROM campaign_commands) commands,
      (SELECT COUNT(*) FROM campaign_events) events,(SELECT COUNT(*) FROM command_receipts) receipts,
      (SELECT COUNT(*) FROM characters) characters,(SELECT COUNT(*) FROM sessions) sessions,
      (SELECT COUNT(*) FROM campaign_memberships) memberships,(SELECT COUNT(*) FROM campaign_sessions) rooms,
      (SELECT COUNT(*) FROM campaign_content_packs) pins`).get()).toEqual(closedAudit);
    expect(migrated.prepare("SELECT revision,event_id,inherited FROM campaign_timeline_events").all())
      .toEqual([{ revision: 1, event_id: "v14-id-7", inherited: 0 }]);
    expect(migrated.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "25" });
    migrated.close();
    const freshDir = makeDir(); createRepository({ dataDir: freshDir }).close();
    expect(schema(file(migratedDir))).toEqual(schema(file(freshDir)));
  });

  it("rolls back a late DDL failure and retries from intact v14", () => {
    const dir = makeDir(); genuineV14(dir);
    const db = new DatabaseDriver(file(dir));
    db.exec("CREATE TABLE campaign_administration_commands (command_id TEXT PRIMARY KEY)"); db.close();
    expect(() => createRepository({ dataDir: dir })).toThrow();
    const failed = new DatabaseDriver(file(dir));
    expect(failed.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "14" });
    expect((failed.prepare("PRAGMA table_info(campaigns)").all() as Array<{ name: string }>).map((column) => column.name))
      .not.toContain("lifecycle_status");
    failed.exec("DROP TABLE campaign_administration_commands"); failed.close();
    createRepository({ dataDir: dir }).close();
    const retried = new DatabaseDriver(file(dir), { readonly: true });
    expect(retried.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "25" });
    retried.close();
  });
});
