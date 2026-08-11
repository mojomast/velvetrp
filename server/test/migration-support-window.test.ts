import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { makeTmpDir, useTmpDataDir } from "./helpers.js";
import {
  buildCanonicalV41Fixture,
  buildCanonicalV42Fixture,
  SUPPORT_WINDOW,
} from "./fixtures/migrations/support-window.js";

useTmpDataDir();

const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const v43Tables = [
  "campaign_npc_presence_v43",
  "npc_presence_commands_v43",
  "npc_presence_events_v43",
  "npc_presence_layout_attestation_v43",
  "npc_presence_receipts_v43",
  "npc_presence_session_revisions_v43",
];

function schema(databaseFile: string): unknown[] {
  const db = new DatabaseDriver(databaseFile, { readonly: true });
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return rows;
}

function verifyV43(db: DatabaseDriver.Database): void {
  expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "43" });
  expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '*v43*' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(v43Tables);
  for (const table of v43Tables.filter((table) => table !== "npc_presence_layout_attestation_v43")) {
    expect(db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
  }
  expect(db.pragma("foreign_key_check")).toEqual([]);
}

describe("supported v41/v42 startup upgrades", () => {
  it("upgrades canonical populated v41 projections to v43 unchanged", () => {
    const { campaignId, draftId, npcId } = buildCanonicalV41Fixture();
    createRepository().close();

    const db = new DatabaseDriver(file(), { readonly: true });
    expect(db.prepare("SELECT campaign_id,opening_text,campaign_premise,source_draft_id,created_at FROM campaign_opening_narratives_v41").get()).toEqual({
      campaign_id: campaignId,
      opening_text: SUPPORT_WINDOW.opening,
      campaign_premise: SUPPORT_WINDOW.premise,
      source_draft_id: draftId,
      created_at: SUPPORT_WINDOW.at,
    });
    expect(db.prepare("SELECT campaign_id,npc_id,body,mind,presence,source FROM campaign_npc_baseline_stats_v41").get()).toEqual({
      campaign_id: campaignId, npc_id: npcId, body: 9, mind: 11, presence: 12, source: "generated-deterministic-baseline",
    });
    verifyV43(db);
    db.close();
  });

  it("upgrades a genuine populated v42 fixture without changing its audit rows", () => {
    const { campaignId, draftId } = buildCanonicalV42Fixture();
    createRepository().close();

    const db = new DatabaseDriver(file(), { readonly: true });
    expect(db.prepare("SELECT command_id,campaign_id,draft_id,expected_campaign_revision FROM campaign_content_commands_v42").get()).toEqual({
      command_id: "support-window-content-command", campaign_id: campaignId, draft_id: draftId, expected_campaign_revision: 0,
    });
    expect(db.prepare("SELECT receipt_id,command_id,campaign_id,draft_id FROM campaign_content_receipts_v42").get()).toEqual({
      receipt_id: "support-window-content-receipt", command_id: "support-window-content-command", campaign_id: campaignId, draft_id: draftId,
    });
    expect(db.prepare("SELECT campaign_id,revision,source_draft_id FROM campaign_content_revisions_v42").get()).toEqual({
      campaign_id: campaignId, revision: 1, source_draft_id: draftId,
    });
    verifyV43(db);
    db.close();
  });

  it("matches fresh v43 schema after a populated v41 migration", () => {
    buildCanonicalV41Fixture();
    createRepository().close();
    const migrated = schema(file());
    const freshDir = makeTmpDir("velvet-fresh-v43-");
    createRepository({ dataDir: freshDir }).close();
    expect(migrated).toEqual(schema(path.join(freshDir, "velvet.sqlite")));
  });

  it("matches fresh v43 schema after a populated v42 migration", () => {
    buildCanonicalV42Fixture();
    createRepository().close();
    const migrated = schema(file());
    const freshDir = makeTmpDir("velvet-fresh-v43-from-v42-");
    createRepository({ dataDir: freshDir }).close();
    expect(migrated).toEqual(schema(path.join(freshDir, "velvet.sqlite")));
  });

  it("rejects persisted v41 foreign-key corruption before changing marker or artifacts", () => {
    const { campaignId } = buildCanonicalV41Fixture();
    const db = new DatabaseDriver(file());
    db.pragma("foreign_keys=OFF");
    db.prepare("UPDATE generated_campaign_quests_v41 SET source_draft_id='missing-draft' WHERE campaign_id=?").run(campaignId);
    db.close();

    expect(() => createRepository()).toThrow("schema marker 41 contains foreign-key violation in generated_campaign_quests_v41");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "41" });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v43*'").all()).toEqual([]);
    verify.close();
  });

  it("rejects persisted v42 foreign-key corruption before changing marker or artifacts", () => {
    const { campaignId } = buildCanonicalV42Fixture();
    const db = new DatabaseDriver(file());
    db.pragma("foreign_keys=OFF");
    db.prepare(`INSERT INTO campaign_content_commands_v42
      VALUES('corrupt-v42-command',?,'missing-draft','principal','corrupt-v42-key',0,?)`)
      .run(campaignId, SUPPORT_WINDOW.at);
    db.close();

    expect(() => createRepository()).toThrow("schema marker 42 contains foreign-key violation in campaign_content_commands_v42");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(verify.prepare("SELECT draft_id FROM campaign_content_commands_v42 WHERE command_id='corrupt-v42-command'").get())
      .toEqual({ draft_id: "missing-draft" });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name='campaign_content_commands_v42_immutable_update_v42'").get())
      .toEqual({ name: "campaign_content_commands_v42_immutable_update_v42" });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v43*'").all()).toEqual([]);
    verify.close();
  });

  it("rejects SQLite-valid cross-campaign v42 draft ancestry before migration", () => {
    const fixture = buildCanonicalV42Fixture(true) as Required<ReturnType<typeof buildCanonicalV42Fixture>>;
    const db = new DatabaseDriver(file());
    db.exec("DROP TRIGGER campaign_content_commands_v42_immutable_update_v42");
    db.prepare("UPDATE campaign_content_commands_v42 SET draft_id=? WHERE campaign_id=?")
      .run(fixture.otherDraftId, fixture.campaignId);
    db.exec(`CREATE TRIGGER campaign_content_commands_v42_immutable_update_v42
      BEFORE UPDATE ON campaign_content_commands_v42 BEGIN SELECT RAISE(ABORT,'v42 records are immutable'); END`);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();

    expect(() => createRepository()).toThrow("schema marker 42 contains cross-campaign draft ancestry in campaign_content_commands_v42");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v43*'").all()).toEqual([]);
    verify.close();
  });

  it("rolls back v43 artifacts on marker failure and retries", () => {
    const { campaignId } = buildCanonicalV42Fixture();
    let db = new DatabaseDriver(file());
    db.exec("CREATE TRIGGER reject_schema_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='43' BEGIN SELECT RAISE(ABORT,'reject v43 marker'); END;");
    db.close();

    expect(() => createRepository()).toThrow("reject v43 marker");
    db = new DatabaseDriver(file());
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v43*'").all()).toEqual([]);
    expect(db.prepare("SELECT campaign_id FROM campaign_content_commands_v42").get()).toEqual({ campaign_id: campaignId });
    db.exec("DROP TRIGGER reject_schema_marker");
    db.close();

    createRepository().close();
    db = new DatabaseDriver(file(), { readonly: true });
    verifyV43(db);
    db.close();
  });
});
