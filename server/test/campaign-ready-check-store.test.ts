import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCampaignReadyCheckRepository } from "../src/repo/campaignReadyCheckRepo.js";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const at = "2035-01-01T00:00:00.000Z";
const databasePath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function seed(): void {
  const repository = createRepository({ dataDir: path.dirname(databasePath()), clock: { now: () => new Date(at) } });
  repository.close();
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = ON");
  db.prepare(
    `INSERT INTO characters VALUES
    ('orra', 'Orra Staple', 30, 'warden', 'fictional', 1, 0, ?),
    ('tessel', 'Tessel Venn', 30, 'warden', 'fictional', 1, 0, ?)`,
  ).run(at, at);
  db.prepare(
    `INSERT INTO sessions VALUES ('session-one', 'orra', 'Dockside', 'active', 'default', NULL, ?, NULL, NULL)`,
  ).run(at);
  db.prepare("INSERT INTO session_characters VALUES ('session-one', 'orra', 0), ('session-one', 'tessel', 1)").run();
  const insertCampaign = db.transaction(() => {
    db.prepare(
      `INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES ('campaign-one', 'Ready', 'timeline-one', 'local-owner', ?, ?)`,
    ).run(at, at);
    db.prepare(
      "INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES ('timeline-one', 'campaign-one', ?)",
    ).run(at);
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-one', 'local-owner', 'owner', ?)").run(at);
  });
  insertCampaign();
  db.close();
}

describe("campaign ready-check persistence", () => {
  it("declares a dedicated ready-check table in the schema", () => {
    seed();
    const db = new DatabaseDriver(databasePath(), { readonly: true });
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaign_ready_check_state'")
      .get();
    db.close();
    expect(table).toEqual({ name: "campaign_ready_check_state" });
  });

  it("persists enable and start in that table and never writes consent_events", () => {
    seed();
    const campaigns = createRepository({ dataDir: path.dirname(databasePath()), clock: { now: () => new Date(at) } });
    const ready = createCampaignReadyCheckRepository({
      getSession: (id) => campaigns.getSession(id),
      addConsentEvent: (sessionId, scope, granted, note) => campaigns.addConsentEvent(sessionId, scope, granted, note),
    });
    const enabled = ready.commandReadyCheck("local-owner", "campaign-one", "session-one", {
      action: "enable",
      expectedRevision: 0,
      idempotencyKey: "key-enable",
    });
    expect(enabled.enabled).toBe(true);
    const started = ready.commandReadyCheck("local-owner", "campaign-one", "session-one", {
      action: "start",
      expectedRevision: 1,
      idempotencyKey: "key-start",
    });
    expect(started.check?.waiting.map((actor) => actor.name)).toEqual(["Orra Staple", "Tessel Venn"]);
    campaigns.close();

    const db = new DatabaseDriver(databasePath(), { readonly: true });
    const consent = db.prepare("SELECT scope FROM consent_events WHERE scope = 'campaign-ready-check:v1'").all();
    const row = db
      .prepare(
        "SELECT enabled, revision, check_json IS NOT NULL AS has_check FROM campaign_ready_check_state WHERE campaign_id='campaign-one' AND session_id='session-one'",
      )
      .get();
    db.close();
    expect(consent).toEqual([]);
    expect(row).toEqual({ enabled: 1, revision: 2, has_check: 1 });
  });
});
