import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { makeTmpDir, useTmpDataDir } from "./helpers.js";
import {
  buildCanonicalV42Fixture,
  buildCanonicalV43Fixture,
  SUPPORT_WINDOW,
} from "./fixtures/migrations/support-window.js";

useTmpDataDir();

const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const v44Tables = [
  "campaign_companions_v44",
  "companion_audit_events_v44",
  "companion_commands_v44",
  "companion_decision_receipts_v44",
  "companion_decisions_v44",
  "companion_grant_command_families_v44",
  "companion_grant_revocations_v44",
  "companion_grants_v44",
  "companion_layout_attestation_v44",
  "companion_presence_links_v44",
  "companion_proposals_v44",
  "companion_receipts_v44",
];

function schema(databaseFile: string): unknown[] {
  const db = new DatabaseDriver(databaseFile, { readonly: true });
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return rows;
}

function verifyV44(db: DatabaseDriver.Database): void {
  expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "44" });
  expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '*v44*' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(v44Tables);
  for (const table of v44Tables.filter((table) => table !== "companion_layout_attestation_v44")) {
    expect(db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
  }
  expect(db.pragma("foreign_key_check")).toEqual([]);
}

describe("supported v42/v43 startup upgrades", () => {
  it("upgrades a genuine populated v42 fixture to v44 without changing its audit rows", () => {
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
    verifyV44(db);
    db.close();
  });

  it("upgrades genuine populated v43 presence to v44 unchanged", () => {
    const fixture = buildCanonicalV43Fixture();
    createRepository().close();
    const db = new DatabaseDriver(file(), { readonly: true });
    expect(db.prepare("SELECT campaign_id,session_id,npc_id,state,state_revision FROM campaign_npc_presence_v43").get()).toEqual({
      campaign_id: fixture.campaignId, session_id: fixture.sessionId, npc_id: fixture.npcId, state: "present", state_revision: 1,
    });
    expect(db.prepare("SELECT command_id,resulting_revision FROM npc_presence_commands_v43").get())
      .toEqual({ command_id: "support-window-presence-command", resulting_revision: 1 });
    verifyV44(db);
    db.close();
  });

  it("matches fresh v44 schema after a populated v42 migration", () => {
    buildCanonicalV42Fixture();
    createRepository().close();
    const migrated = schema(file());
    const freshDir = makeTmpDir("velvet-fresh-v44-from-v42-");
    createRepository({ dataDir: freshDir }).close();
    expect(migrated).toEqual(schema(path.join(freshDir, "velvet.sqlite")));
  });

  it("matches fresh v44 schema after a populated v43 migration", () => {
    buildCanonicalV43Fixture();
    createRepository().close();
    const migrated = schema(file());
    const freshDir = makeTmpDir("velvet-fresh-v44-from-v43-");
    createRepository({ dataDir: freshDir }).close();
    expect(migrated).toEqual(schema(path.join(freshDir, "velvet.sqlite")));
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
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v44*'").all()).toEqual([]);
    verify.close();
  });

  it("rejects persisted v43 foreign-key corruption before changing marker or artifacts", () => {
    const fixture = buildCanonicalV43Fixture();
    const db = new DatabaseDriver(file());
    db.pragma("foreign_keys=OFF");
    db.exec("DROP TRIGGER npc_presence_session_revisions_v43_attached_insert_v43");
    db.prepare("INSERT INTO npc_presence_session_revisions_v43 VALUES(?,'missing-session',0,?)")
      .run(fixture.campaignId, SUPPORT_WINDOW.at);
    db.close();
    expect(() => createRepository()).toThrow("schema marker 43 contains foreign-key violation in npc_presence_session_revisions_v43");
    const verify = new DatabaseDriver(file(), { readonly: true });
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "43" });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v44*'").all()).toEqual([]);
    verify.close();
  });

  it("rolls back v44 artifacts on marker failure and retries", () => {
    const { campaignId } = buildCanonicalV43Fixture();
    let db = new DatabaseDriver(file());
    db.exec("CREATE TRIGGER reject_schema_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='44' BEGIN SELECT RAISE(ABORT,'reject v44 marker'); END;");
    db.close();

    expect(() => createRepository()).toThrow("reject v44 marker");
    db = new DatabaseDriver(file());
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "43" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v44*'").all()).toEqual([]);
    expect(db.prepare("SELECT campaign_id FROM npc_presence_commands_v43").get()).toEqual({ campaign_id: campaignId });
    db.exec("DROP TRIGGER reject_schema_marker");
    db.close();

    createRepository().close();
    db = new DatabaseDriver(file(), { readonly: true });
    verifyV44(db);
    db.close();
  });
});
