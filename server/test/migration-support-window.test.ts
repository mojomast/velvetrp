import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { makeTmpDir, useTmpDataDir } from "./helpers.js";
import { buildCanonicalV40Fixture, buildCanonicalV41CrossCampaignFixture, buildCanonicalV41Fixture, SUPPORT_WINDOW } from "./fixtures/migrations/support-window.js";

useTmpDataDir();

const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const v41Tables = ["campaign_opening_narratives_v41", "campaign_npc_baseline_stats_v41", "generated_campaign_quests_v41"];
const v42Tables = ["campaign_content_commands_v42", "campaign_content_receipts_v42", "campaign_content_revisions_v42", "campaign_content_layout_attestation_v42"];

function tableNames(db: DatabaseDriver.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name GLOB '*_v41' OR name GLOB '*_v42') ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
}

function schema(databaseFile: string): unknown[] {
  const db = new DatabaseDriver(databaseFile, { readonly: true });
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return rows;
}

function verifyForeignKeys(db: DatabaseDriver.Database): void {
  expect(db.pragma("foreign_key_check")).toEqual([]);
}

describe("supported v40/v41 startup upgrades", () => {
  it("upgrades a populated canonical v40 campaign through v41 to v42", () => {
    const { campaignId, draftId } = buildCanonicalV40Fixture();

    createRepository().close();

    const db = new DatabaseDriver(file(), { readonly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(db.prepare("SELECT id,name FROM campaigns WHERE id=?").get(campaignId)).toEqual({ id: campaignId, name: SUPPORT_WINDOW.campaignName });
    expect(db.prepare("SELECT id FROM generation_drafts WHERE id=?").get(draftId)).toEqual({ id: draftId });
    expect(tableNames(db)).toEqual([...v41Tables, ...v42Tables].sort());
    expect(db.prepare("SELECT layout_digest FROM campaign_content_layout_attestation_v42 WHERE singleton=1").get()).toMatchObject({ layout_digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    verifyForeignKeys(db);
    db.close();
  });

  it("upgrades canonical populated v41 projections to v42 without changing their ancestry", () => {
    const { campaignId, draftId, npcId } = buildCanonicalV41Fixture();

    createRepository().close();

    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(verify.prepare("SELECT id,name FROM campaigns WHERE id=?").get(campaignId)).toEqual({ id: campaignId, name: SUPPORT_WINDOW.campaignName });
    expect(verify.prepare(`SELECT campaign_id,opening_text,campaign_premise,source_draft_id,created_at
      FROM campaign_opening_narratives_v41 WHERE campaign_id=?`).get(campaignId)).toEqual({
      campaign_id: campaignId, opening_text: SUPPORT_WINDOW.opening, campaign_premise: SUPPORT_WINDOW.premise,
      source_draft_id: draftId, created_at: SUPPORT_WINDOW.at,
    });
    expect(verify.prepare("SELECT campaign_id,npc_id,body,mind,presence,source FROM campaign_npc_baseline_stats_v41").get()).toEqual({
      campaign_id: campaignId, npc_id: npcId, body: 9, mind: 11, presence: 12, source: "generated-deterministic-baseline",
    });
    expect(verify.prepare("SELECT campaign_id,quest_id,title,description,source_draft_id FROM generated_campaign_quests_v41").get()).toEqual({
      campaign_id: campaignId, quest_id: "support-window-quest", title: SUPPORT_WINDOW.questTitle,
      description: SUPPORT_WINDOW.questDescription, source_draft_id: draftId,
    });
    expect(tableNames(verify)).toEqual([...v41Tables, ...v42Tables].sort());
    verifyForeignKeys(verify);
    verify.close();
  });

  it("replays a known empty v42 shell from a rewound canonical v41 fixture", () => {
    buildCanonicalV41Fixture();
    createRepository().close();
    const db = new DatabaseDriver(file());
    db.prepare("UPDATE meta SET value='41' WHERE key='schemaVersion'").run();
    db.close();

    createRepository().close();

    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(tableNames(verify)).toEqual([...v41Tables, ...v42Tables].sort());
    for (const table of v42Tables.slice(0, 3)) expect(verify.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    verifyForeignKeys(verify);
    verify.close();
  });

  it("matches a fresh v42 schema after a populated v40 migration", () => {
    buildCanonicalV40Fixture();
    createRepository().close();
    const migrated = schema(file());
    const freshDir = makeTmpDir("velvet-fresh-v42-");
    createRepository({ dataDir: freshDir }).close();
    expect(migrated).toEqual(schema(path.join(freshDir, "velvet.sqlite")));
  });

  it("rejects malformed v41 generation ancestry through its foreign keys", () => {
    const { campaignId } = buildCanonicalV41Fixture();
    const db = new DatabaseDriver(file());
    expect(() => db.prepare("INSERT INTO generated_campaign_quests_v41 VALUES(?,?,?,?,?)")
      .run(campaignId, "orphan-quest", "Orphan quest", "No valid draft ancestry.", "missing-draft")).toThrow(/FOREIGN KEY constraint failed/);
    verifyForeignKeys(db);
    db.close();
  });

  it("rejects persisted foreign-key corruption before changing the v41 marker or artifacts", () => {
    const { campaignId } = buildCanonicalV41Fixture();
    const db = new DatabaseDriver(file());
    db.pragma("foreign_keys=OFF");
    db.prepare("UPDATE generated_campaign_quests_v41 SET source_draft_id='support-window-missing-draft' WHERE campaign_id=?").run(campaignId);
    db.close();

    expect(() => createRepository()).toThrow("schema marker 41 contains foreign-key violation in generated_campaign_quests_v41");

    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "41" });
    expect(tableNames(verify)).toEqual(v41Tables.sort());
    expect(verify.prepare("SELECT source_draft_id FROM generated_campaign_quests_v41 WHERE campaign_id=?").get(campaignId)).toEqual({ source_draft_id: "support-window-missing-draft" });
    expect(verify.pragma("foreign_key_check")).toEqual([{ table: "generated_campaign_quests_v41", rowid: 1, parent: "generation_drafts", fkid: 0 }]);
    verify.close();
  });

  it.each([
    ["campaign_opening_narratives_v41", "source_draft_id"],
    ["generated_campaign_quests_v41", "source_draft_id"],
  ] as const)("rejects SQLite-valid cross-campaign draft ancestry in %s", (table, draftColumn) => {
    const { campaignId, otherDraftId } = buildCanonicalV41CrossCampaignFixture();
    const db = new DatabaseDriver(file());
    db.prepare(`UPDATE ${table} SET ${draftColumn}=? WHERE campaign_id=?`).run(otherDraftId, campaignId);
    verifyForeignKeys(db);
    db.close();

    expect(() => createRepository()).toThrow(`schema marker 41 contains cross-campaign draft ancestry in ${table}`);

    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "41" });
    expect(verify.prepare(`SELECT ${draftColumn} FROM ${table} WHERE campaign_id=?`).get(campaignId)).toEqual({ [draftColumn]: otherDraftId });
    verifyForeignKeys(verify);
    verify.close();
  });

  it.each([
    ["campaign_content_commands_v42", "draft_id"],
    ["campaign_content_receipts_v42", "draft_id"],
    ["campaign_content_revisions_v42", "source_draft_id"],
  ] as const)("rejects SQLite-valid cross-campaign draft ancestry in %s", (table, draftColumn) => {
    const { campaignId, draftId, otherDraftId } = buildCanonicalV41CrossCampaignFixture();
    createRepository().close();
    const db = new DatabaseDriver(file());
    if (table === "campaign_content_commands_v42") {
      db.prepare("INSERT INTO campaign_content_commands_v42 VALUES('support-window-command',?,?, 'support-window-principal', 'support-window-command-key', 0, ?)")
        .run(campaignId, otherDraftId, SUPPORT_WINDOW.at);
    }
    if (table === "campaign_content_receipts_v42") {
      db.prepare("INSERT INTO campaign_content_commands_v42 VALUES('support-window-command',?,?, 'support-window-principal', 'support-window-command-key', 0, ?)")
        .run(campaignId, draftId, SUPPORT_WINDOW.at);
      db.prepare("INSERT INTO campaign_content_receipts_v42 VALUES('support-window-receipt','support-window-command',?,?,?,'{}')")
        .run(campaignId, otherDraftId, SUPPORT_WINDOW.at);
    }
    if (table === "campaign_content_revisions_v42") {
      db.prepare("INSERT INTO campaign_content_revisions_v42 VALUES(?,?,?,?)")
        .run(campaignId, 0, otherDraftId, SUPPORT_WINDOW.at);
    }
    verifyForeignKeys(db);
    db.close();

    expect(() => createRepository()).toThrow(`schema marker 42 contains cross-campaign draft ancestry in ${table}`);

    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(verify.prepare(`SELECT ${draftColumn} FROM ${table} WHERE campaign_id=?`).get(campaignId)).toEqual({ [draftColumn]: otherDraftId });
    verifyForeignKeys(verify);
    verify.close();
  });

  it("rejects an unexpected v42 artifact before cleaning up a rewound empty shell", () => {
    buildCanonicalV41Fixture();
    createRepository().close();
    const db = new DatabaseDriver(file());
    db.prepare("UPDATE meta SET value='41' WHERE key='schemaVersion'").run();
    db.exec("CREATE TABLE unexpected_support_window_v42_artifact (id TEXT PRIMARY KEY)");
    db.close();

    expect(() => createRepository()).toThrow("schema marker 41 contains unexpected v42 artifact unexpected_support_window_v42_artifact");

    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "41" });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='unexpected_support_window_v42_artifact'").get()).toEqual({ name: "unexpected_support_window_v42_artifact" });
    expect(tableNames(verify)).toEqual([...v41Tables, ...v42Tables].sort());
    verify.close();
  });

  it("rolls back v41 artifacts after a v40-to-v41 marker failure and retries", () => {
    const { campaignId, draftId } = buildCanonicalV40Fixture();
    let db = new DatabaseDriver(file());
    db.exec("CREATE TRIGGER reject_v41_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='41' BEGIN SELECT RAISE(ABORT,'reject v41 marker'); END;");
    db.close();

    expect(() => createRepository()).toThrow("reject v41 marker");

    db = new DatabaseDriver(file());
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "40" });
    expect(tableNames(db)).toEqual([]);
    expect(db.prepare("SELECT id FROM campaigns WHERE id=?").get(campaignId)).toEqual({ id: campaignId });
    expect(db.prepare("SELECT id FROM generation_drafts WHERE id=?").get(draftId)).toEqual({ id: draftId });
    verifyForeignKeys(db);
    db.exec("DROP TRIGGER reject_v41_marker");
    db.close();
    createRepository().close();
    db = new DatabaseDriver(file(), { readonly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(tableNames(db)).toEqual([...v41Tables, ...v42Tables].sort());
    expect(db.prepare("SELECT id FROM generation_drafts WHERE id=?").get(draftId)).toEqual({ id: draftId });
    verifyForeignKeys(db);
    db.close();
  });

  it("rolls back v42 artifacts after a v41-to-v42 marker failure and retries", () => {
    const { campaignId, draftId } = buildCanonicalV41Fixture();
    let db = new DatabaseDriver(file());
    db.exec("CREATE TRIGGER reject_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='42' BEGIN SELECT RAISE(ABORT,'reject v42 marker'); END;");
    db.close();

    expect(() => createRepository()).toThrow("reject v42 marker");

    db = new DatabaseDriver(file());
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "41" });
    expect(tableNames(db)).toEqual(v41Tables.sort());
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*_v42'").all()).toEqual([]);
    expect(db.prepare("SELECT source_draft_id FROM campaign_opening_narratives_v41 WHERE campaign_id=?").get(campaignId)).toEqual({ source_draft_id: draftId });
    verifyForeignKeys(db);
    db.exec("DROP TRIGGER reject_marker");
    db.close();
    createRepository().close();
    db = new DatabaseDriver(file(), { readonly: true });
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(tableNames(db)).toEqual([...v41Tables, ...v42Tables].sort());
    expect(db.prepare("SELECT source_draft_id FROM campaign_opening_narratives_v41 WHERE campaign_id=?").get(campaignId)).toEqual({ source_draft_id: draftId });
    verifyForeignKeys(db);
    db.close();
  });
});
