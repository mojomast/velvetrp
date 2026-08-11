import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import {
  NPC_PRESENCE_V43_LAYOUT_DIGEST,
  NPC_PRESENCE_V43_MANAGED_OBJECTS,
  assertNpcPresenceLayoutV43,
} from "../src/repo/db/migrations/v43_npc_presence.js";
import { buildCanonicalV42Fixture, SUPPORT_WINDOW } from "./fixtures/migrations/support-window.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const file = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function open(): DatabaseDriver.Database {
  const db = new DatabaseDriver(file());
  db.pragma("foreign_keys=ON");
  return db;
}

function insertHistory(db: DatabaseDriver.Database): void {
  const fixture = buildCanonicalV42Fixture();
  createRepository().close();
  db.close();
  db = open();
  db.prepare("INSERT INTO principals VALUES('non-member-principal','Non-member',0)").run();
  db.prepare("INSERT INTO npc_presence_session_revisions_v43 VALUES(?,?,0,?)")
    .run(fixture.campaignId, fixture.sessionId, SUPPORT_WINDOW.at);
  db.prepare(`INSERT INTO npc_presence_commands_v43
    (campaign_id,session_id,command_id,idempotency_key,principal_id,npc_id,state,location_id,expected_revision,resulting_revision,created_at)
    VALUES(?,?,'presence-command','presence-key','non-member-principal',?,'left',?,0,1,?)`)
    .run(fixture.campaignId, fixture.sessionId, fixture.npcId, fixture.locationId, SUPPORT_WINDOW.at);
  db.prepare("UPDATE npc_presence_session_revisions_v43 SET revision=1,updated_at=? WHERE campaign_id=? AND session_id=?")
    .run(SUPPORT_WINDOW.at, fixture.campaignId, fixture.sessionId);
  db.prepare(`INSERT INTO npc_presence_events_v43
    VALUES('presence-event',?,?,'presence-command',1,?,'left',?,?)`)
    .run(fixture.campaignId, fixture.sessionId, fixture.npcId, fixture.locationId, SUPPORT_WINDOW.at);
  db.prepare(`INSERT INTO npc_presence_receipts_v43
    VALUES(?,?,'presence-command',1,'presence-event',?,'left',?,?)`)
    .run(fixture.campaignId, fixture.sessionId, fixture.npcId, fixture.locationId, SUPPORT_WINDOW.at);
  db.prepare(`INSERT INTO campaign_npc_presence_v43
    VALUES(?,?,?,'left',?,1,?,?,'presence-command')`)
    .run(fixture.campaignId, fixture.sessionId, fixture.npcId, fixture.locationId, SUPPORT_WINDOW.at, SUPPORT_WINDOW.at);
  db.close();
}

describe("schema v43 NPC presence", () => {
  it("creates the exact attested inventory with no backfilled presence rows", () => {
    createRepository().close();
    const db = open();
    const inventory = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v43*' AND sql IS NOT NULL ORDER BY type,name").all();
    expect(inventory).toEqual([...NPC_PRESENCE_V43_MANAGED_OBJECTS]
      .map(([type, name]) => ({ type, name })).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)));
    expect(db.prepare("SELECT layout_digest FROM npc_presence_layout_attestation_v43 WHERE singleton=1").get())
      .toEqual({ layout_digest: NPC_PRESENCE_V43_LAYOUT_DIGEST });
    for (const table of ["npc_presence_session_revisions_v43", "campaign_npc_presence_v43", "npc_presence_commands_v43", "npc_presence_events_v43", "npc_presence_receipts_v43"]) {
      expect(db.prepare(`SELECT count(*) count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("rejects SQL-bearing objects attached to managed tables even without v43 names", () => {
    createRepository().close();
    const db = open();
    db.exec("CREATE INDEX concealed_presence_event_index ON npc_presence_events_v43(event_id)");
    expect(() => assertNpcPresenceLayoutV43(db)).toThrow(/schema v43 NPC-presence inventory is incompatible/);
    expect(db.prepare("SELECT type,tbl_name FROM sqlite_master WHERE name='concealed_presence_event_index'").get())
      .toEqual({ type: "index", tbl_name: "npc_presence_events_v43" });
    db.close();
  });

  it("preserves current state and immutable history when the campaign session detaches", () => {
    let db = open();
    insertHistory(db);
    db = open();
    expect(() => db.prepare("UPDATE npc_presence_commands_v43 SET state='present'").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM npc_presence_events_v43").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM campaign_sessions WHERE session_id='support-window-session'").run()).not.toThrow();
    expect(db.prepare("SELECT state,location_id,state_revision,last_command_id FROM campaign_npc_presence_v43").get()).toEqual({
      state: "left", location_id: "support-window-location", state_revision: 1, last_command_id: "presence-command",
    });
    expect(db.prepare("SELECT count(*) count FROM npc_presence_events_v43").get()).toEqual({ count: 1 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("enforces ancestry, values, and null-safe exact cross-binding only", () => {
    const fixture = buildCanonicalV42Fixture(true) as Required<ReturnType<typeof buildCanonicalV42Fixture>>;
    createRepository().close();
    const db = open();
    expect(() => db.prepare("INSERT INTO npc_presence_session_revisions_v43 VALUES(?,?,0,?)")
      .run(fixture.otherCampaignId, fixture.sessionId, SUPPORT_WINDOW.at)).toThrow(/requires campaign attachment/);
    db.prepare("INSERT INTO npc_presence_session_revisions_v43 VALUES(?,?,0,?)")
      .run(fixture.campaignId, fixture.sessionId, SUPPORT_WINDOW.at);
    expect(() => db.prepare(`INSERT INTO npc_presence_commands_v43
      VALUES(?,?,'bad','bad','local-owner',?,'unknown',NULL,0,1,?)`)
      .run(fixture.campaignId, fixture.sessionId, fixture.npcId, SUPPORT_WINDOW.at)).toThrow(/CHECK constraint/);
    db.prepare(`INSERT INTO npc_presence_commands_v43
      VALUES(?,?,'null-location','null-location-key','local-owner',?,'present',NULL,0,1,?)`)
      .run(fixture.campaignId, fixture.sessionId, fixture.npcId, SUPPORT_WINDOW.at);
    expect(() => db.prepare(`INSERT INTO npc_presence_events_v43
      VALUES('wrong-event',?,?,'null-location',1,?,'left',NULL,?)`)
      .run(fixture.campaignId, fixture.sessionId, fixture.npcId, SUPPORT_WINDOW.at)).toThrow(/exactly match/);
    db.prepare(`INSERT INTO npc_presence_events_v43
      VALUES('presence-event',?,?,'null-location',1,?,'present',NULL,?)`)
      .run(fixture.campaignId, fixture.sessionId, fixture.npcId, SUPPORT_WINDOW.at);
    expect(() => db.prepare(`INSERT INTO npc_presence_receipts_v43
      VALUES(?,?,'null-location',1,'presence-event',?,'present',NULL,'2035-01-01T00:00:01.000Z')`)
      .run(fixture.campaignId, fixture.sessionId, fixture.npcId)).toThrow(/exactly match its event/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("rejects unknown, malformed, and populated future v43 artifacts without changing v42", () => {
    const fixture = buildCanonicalV42Fixture();
    let db = open();
    db.exec("CREATE TABLE unknown_future_v43_artifact(id TEXT PRIMARY KEY)");
    db.close();
    expect(() => createRepository()).toThrow(/unexpected v43 artifact unknown_future_v43_artifact/);
    db = open();
    db.exec("DROP TABLE unknown_future_v43_artifact; CREATE TABLE npc_presence_session_revisions_v43(id TEXT PRIMARY KEY)");
    db.close();
    expect(() => createRepository()).toThrow(/malformed future v43 artifacts/);
    db = open();
    db.exec("DROP TABLE npc_presence_session_revisions_v43");
    db.close();
    createRepository().close();
    db = open();
    db.prepare("INSERT INTO npc_presence_session_revisions_v43 VALUES(?,?,0,?)").run(fixture.campaignId, fixture.sessionId, SUPPORT_WINDOW.at);
    db.prepare("UPDATE meta SET value='42' WHERE key='schemaVersion'").run();
    db.close();
    expect(() => createRepository()).toThrow(/populated future v43 artifact npc_presence_session_revisions_v43/);
    const verify = open();
    expect(verify.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(verify.prepare("SELECT count(*) count FROM npc_presence_session_revisions_v43").get()).toEqual({ count: 1 });
    verify.close();
  });

  it("preflights concealed objects attached to a future v43 shell", () => {
    buildCanonicalV42Fixture();
    createRepository().close();
    let db = open();
    db.prepare("UPDATE meta SET value='42' WHERE key='schemaVersion'").run();
    db.exec(`CREATE TRIGGER concealed_presence_guard BEFORE INSERT ON npc_presence_events_v43
      BEGIN SELECT RAISE(ABORT,'concealed'); END`);
    db.close();

    expect(() => createRepository()).toThrow(/unexpected v43 artifact concealed_presence_guard/);
    db = open();
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "42" });
    expect(db.prepare("SELECT tbl_name FROM sqlite_master WHERE name='concealed_presence_guard'").get())
      .toEqual({ tbl_name: "npc_presence_events_v43" });
    db.close();
  });
});
