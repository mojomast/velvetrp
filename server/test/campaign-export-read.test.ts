import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CampaignAdministrationForbiddenError, createRepository } from "../src/repo/index.js";
import { CampaignExportLimitError } from "../src/repo/campaignAdmin/administrationExportRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-02T03:04:05.006Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR as string, "velvet.sqlite");

function attachRoom(campaignId: string, large = false, messageCount = 0): void {
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  db.prepare(`INSERT INTO characters VALUES
    ('legacy-character', 'Character', 30, 'captain', 'fictional', 1, 0, ?)`).run(at);
  db.prepare(`INSERT INTO sessions VALUES ('legacy/room', 'legacy-character', 'Room', 'running', 'default', NULL, ?, NULL, NULL)`).run(at);
  db.prepare("INSERT INTO campaign_sessions (session_id,campaign_id,attached_at) VALUES ('legacy/room',?,?)").run(campaignId, at);
  const insert = db.prepare(`INSERT INTO messages
    (id,session_id,role,speaker_character_id,content,parent_id,swipe_group_id,swipe_index,seq,status,
      prompt_tokens,completion_tokens,total_tokens,usage_source,usage_model,created_at)
    VALUES (?,'legacy/room',?,?,?,?,?,?,?,?,99,88,187,'provider','secret-model',?)`);
  if (messageCount > 0) {
    db.transaction(() => {
      for (let index = 0; index < messageCount; index += 1) insert.run(`many-${index}`, "user", null,
        "x", null, `many-${index}`, 0, index, "final", at);
    }).immediate();
  } else if (large) {
    for (let index = 0; index < 6; index += 1) insert.run(`large-${index}`, "character", "legacy-character",
      "x".repeat(190_000), null, `large-${index}`, index, index, "final", at);
  } else {
    insert.run("root", "user", null, "question", null, "root", 0, 0, "final", at);
    insert.run("inactive", "character", "legacy-character", "old swipe", "root", "answer", 0, 1, "final", at);
    insert.run("active", "character", "legacy-character", "new swipe", "root", "answer", 1, 1, "final", at);
    insert.run("aborted", "character", "legacy-character", "partial", "active", "aborted", 0, 2, "aborted", at);
    db.prepare("UPDATE sessions SET active_leaf_id='active' WHERE id='legacy/room'").run();
  }
  db.close();
}

describe("side-effect-free campaign export read", () => {
  it("archives every branch without usage and performs no writes or dependency consumption", () => {
    const ids = { nextId: vi.fn(() => "generated") };
    const clock = { now: vi.fn(() => new Date(at)) };
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string, ids, clock });
    const campaign = repo.createCampaign("local-owner", { name: "Read export" });
    attachRoom(campaign.id);
    ids.nextId.mockClear(); clock.now.mockClear();
    const db = new DatabaseDriver(dbPath());
    const before = db.prepare(`SELECT administration_revision revision,updated_at updatedAt,
      (SELECT COUNT(*) FROM campaign_export_manifests) manifests,
      (SELECT COUNT(*) FROM campaign_administration_commands) commands,
      (SELECT COUNT(*) FROM campaign_administration_events) events,
      (SELECT COUNT(*) FROM campaign_administration_receipts) receipts FROM campaigns WHERE id=?`).get(campaign.id);

    const without = repo.readCampaignExport("local-owner", campaign.id, { includeMessages: false });
    expect(without.document.messages).toEqual({ included: false });
    const exported = repo.readCampaignExport("local-owner", campaign.id, { includeMessages: true });
    expect(exported.document.messages).toMatchObject({ included: true, rooms: [{ sessionId: "legacy/room",
      activeLeafId: "active", messages: [{ id: "root" }, { id: "inactive" }, { id: "active" }, { id: "aborted" }] }] });
    expect(JSON.stringify(exported.document.messages)).not.toMatch(/promptTokens|completionTokens|totalTokens|usage|secret-model|price|provider/);
    expect(exported.byteLength).toBe(Buffer.byteLength(JSON.stringify(exported.document)));
    expect(exported.document.package.exportedAt).toBe(at);
    expect(db.prepare(`SELECT administration_revision revision,updated_at updatedAt,
      (SELECT COUNT(*) FROM campaign_export_manifests) manifests,
      (SELECT COUNT(*) FROM campaign_administration_commands) commands,
      (SELECT COUNT(*) FROM campaign_administration_events) events,
      (SELECT COUNT(*) FROM campaign_administration_receipts) receipts FROM campaigns WHERE id=?`).get(campaign.id)).toEqual(before);
    expect(ids.nextId).not.toHaveBeenCalled();
    expect(clock.now).toHaveBeenCalledTimes(2);
    db.close(); repo.close();
  });

  it("requires canonical owner authority", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const campaign = repo.createCampaign("local-owner", { name: "Owner only" });
    const db = new DatabaseDriver(dbPath());
    db.prepare("INSERT INTO principals (id,display_name,is_local) VALUES ('player','Player',0)").run();
    db.prepare("INSERT INTO campaign_memberships VALUES (?,'player','player',?)").run(campaign.id, at);
    db.close();
    expect(() => repo.readCampaignExport("player", campaign.id, { includeMessages: false }))
      .toThrow(CampaignAdministrationForbiddenError);
    expect(() => repo.readCampaignExport("local-owner", "missing", { includeMessages: false }))
      .toThrow(CampaignAdministrationForbiddenError);
    repo.close();
  });

  it("fails rather than truncating a document above the byte limit", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const campaign = repo.createCampaign("local-owner", { name: "Large export" });
    attachRoom(campaign.id, true);
    expect(() => repo.readCampaignExport("local-owner", campaign.id, { includeMessages: true }))
      .toThrow(CampaignExportLimitError);
    repo.close();
  });

  it("fails with the same typed error above the full-document record limit", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR as string });
    const campaign = repo.createCampaign("local-owner", { name: "Many records" });
    attachRoom(campaign.id, false, 10_000);
    expect(() => repo.readCampaignExport("local-owner", campaign.id, { includeMessages: true }))
      .toThrow(CampaignExportLimitError);
    repo.close();
  });
});
