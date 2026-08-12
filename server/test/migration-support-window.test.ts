import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { makeTmpDir, useTmpDataDir } from "./helpers.js";
import {
  buildCanonicalV43Fixture,
  buildCanonicalPopulatedV44CompanionFixture,
  SUPPORT_WINDOW,
} from "./fixtures/migrations/support-window.js";

useTmpDataDir();

const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
const v45Tables = [
  "campaign_companions_v45",
  "companion_audit_events_v45",
  "companion_commands_v45",
  "companion_decision_receipts_v45",
  "companion_decisions_v45",
  "companion_grant_command_families_v45",
  "companion_grant_revocations_v45",
  "companion_grants_v45",
  "companion_layout_attestation_v45",
  "companion_presence_links_v45",
  "companion_proposals_v45",
  "companion_receipts_v45",
];

function schema(databaseFile: string): unknown[] {
  const db = new DatabaseDriver(databaseFile, { readonly: true });
  const rows = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return rows;
}

function verifyV45(db: DatabaseDriver.Database): void {
  expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "45" });
  expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '*v45*' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(v45Tables);
  for (const table of v45Tables.filter((table) => table !== "companion_layout_attestation_v45")) {
    expect(db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
  }
  expect(db.pragma("foreign_key_check")).toEqual([]);
}

describe("supported v43/v44 startup upgrades", () => {
  it("upgrades genuine populated v43 presence to v45 unchanged", () => {
    const fixture = buildCanonicalV43Fixture();
    createRepository().close();
    const db = new DatabaseDriver(file(), { readonly: true });
    expect(db.prepare("SELECT campaign_id,session_id,npc_id,state,state_revision FROM campaign_npc_presence_v43").get()).toEqual({
      campaign_id: fixture.campaignId, session_id: fixture.sessionId, npc_id: fixture.npcId, state: "present", state_revision: 1,
    });
    expect(db.prepare("SELECT command_id,resulting_revision FROM npc_presence_commands_v43").get())
      .toEqual({ command_id: "support-window-presence-command", resulting_revision: 1 });
    verifyV45(db);
    db.close();
  });

  it("matches fresh v45 schema after a populated v43 migration", () => {
    buildCanonicalV43Fixture();
    createRepository().close();
    const migrated = schema(file());
    const freshDir = makeTmpDir("velvet-fresh-v45-from-v43-");
    createRepository({ dataDir: freshDir }).close();
    expect(migrated).toEqual(schema(path.join(freshDir, "velvet.sqlite")));
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
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v45*'").all()).toEqual([]);
    verify.close();
  });

  it("rolls back v45 artifacts on marker failure and retries", () => {
    const { campaignId } = buildCanonicalV43Fixture();
    let db = new DatabaseDriver(file());
    db.exec("CREATE TRIGGER reject_schema_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='45' BEGIN SELECT RAISE(ABORT,'reject v45 marker'); END;");
    db.close();

    expect(() => createRepository()).toThrow("reject v45 marker");
    db = new DatabaseDriver(file());
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "44" });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v45*'").all()).toEqual([]);
    expect(db.prepare("SELECT campaign_id FROM npc_presence_commands_v43").get()).toEqual({ campaign_id: campaignId });
    db.exec("DROP TRIGGER reject_schema_marker");
    db.close();

    createRepository().close();
    db = new DatabaseDriver(file(), { readonly: true });
    verifyV45(db);
    db.close();
  });

  it("migrates populated v44 principal history and permits membership removal", () => {
    const fixture = buildCanonicalPopulatedV44CompanionFixture();
    const before = new DatabaseDriver(file(), { readonly: true });
    const v44Rows = Object.fromEntries(v45Tables.filter((table) => table !== "companion_layout_attestation_v45")
      .map((table) => [table, before.prepare(`SELECT * FROM ${table.replace(/_v45$/, "_v44")} ORDER BY rowid`).all()]));
    before.close();
    createRepository().close();
    const db = new DatabaseDriver(file());
    db.pragma("foreign_keys=ON");
    for (const table of v45Tables.filter((name) => name !== "companion_layout_attestation_v45")) {
      expect(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(v44Rows[table]);
    }
    expect(db.prepare("SELECT count(*) count FROM companion_commands_v45").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT granted_by_principal_id,grantee_principal_id FROM companion_grants_v45").get()).toEqual({
      granted_by_principal_id: fixture.grantorPrincipalId, grantee_principal_id: fixture.granteePrincipalId,
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v44*'").all()).toEqual([]);
    db.prepare("DELETE FROM campaign_memberships WHERE campaign_id=? AND principal_id IN (?,?)")
      .run(fixture.campaignId, fixture.grantorPrincipalId, fixture.granteePrincipalId);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
    const freshDir = makeTmpDir("velvet-fresh-v45-from-populated-v44-");
    createRepository({ dataDir: freshDir }).close();
    expect(schema(file())).toEqual(schema(path.join(freshDir, "velvet.sqlite")));
    const repo = createRepository();
    expect(repo.getCompanionManagement("local-owner", fixture.campaignId, fixture.npcId)?.grants[0]).toMatchObject({
      grantId: fixture.grantId, grantedByPrincipalId: fixture.grantorPrincipalId,
      granteePrincipalId: fixture.granteePrincipalId,
    });
    repo.close();
  });
});
