import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import type { RenameCampaignInput } from "../src/types.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const createdAt = "2030-04-05T06:07:08.009Z";
const renamedAt = "2030-04-05T06:07:09.010Z";

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function databasePath(): string {
  return path.join(dataDir(), "velvet.sqlite");
}

function seed(): void {
  const repository = createRepository({ dataDir: dataDir() });
  repository.close();
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = ON");
  for (const [id, name] of [
    ["principal-gm", "GM"],
    ["principal-player", "Player"],
    ["principal-observer", "Observer"],
    ["principal-nonmember", "Nonmember"],
    ["principal-app-owner", "New application owner"],
  ]) {
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(id, name);
  }
  db.prepare(`INSERT INTO characters VALUES
    ('character-one', 'Character', 30, 'captain', 'fictional', 'anchor', 1, 0, ?)`).run(createdAt);
  db.prepare(`INSERT INTO sessions VALUES
    ('session-one', 'character-one', 'Session', 'setup', 'default', NULL, ?, NULL, NULL)`).run(createdAt);
  db.prepare("INSERT INTO session_characters VALUES ('session-one', 'character-one', 0)").run();
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES ('campaign-one', 'Original', 'timeline-one', 'local-owner', ?, ?)`).run(createdAt, createdAt);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
      VALUES ('timeline-one', 'campaign-one', ?)`).run(createdAt);
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-one', 'local-owner', 'owner', ?)").run(createdAt);
    for (const [principalId, role] of [
      ["principal-gm", "gm"],
      ["principal-player", "player"],
      ["principal-observer", "observer"],
    ]) {
      db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-one', ?, ?, ?)")
        .run(principalId, role, createdAt);
    }
    db.prepare("INSERT INTO campaign_sessions VALUES ('session-one', 'campaign-one', ?)").run(createdAt);
  }).immediate();
  db.close();
}

function snapshot(): Record<string, unknown[]> {
  const db = new DatabaseDriver(databasePath(), { readonly: true });
  const rows = {
    campaigns: db.prepare("SELECT * FROM campaigns ORDER BY id").all(),
    timelines: db.prepare("SELECT * FROM campaign_timelines ORDER BY id").all(),
    memberships: db.prepare("SELECT * FROM campaign_memberships ORDER BY principal_id").all(),
    attachments: db.prepare("SELECT * FROM campaign_sessions ORDER BY session_id").all(),
  };
  db.close();
  return rows;
}

describe("factory campaign rename", () => {
  it("persists the trimmed name and returns the exact Campaign projection with one clock and no IDs", () => {
    seed();
    const before = snapshot();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date(renamedAt));
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    const campaign = repository.renameCampaign("local-owner", "campaign-one", { name: "  Renamed  " });

    expect(campaign).toEqual({
      id: "campaign-one",
      name: "Renamed",
      activeTimelineId: "timeline-one",
      ownerPrincipalId: "local-owner",
      createdAt,
      updatedAt: renamedAt,
    });
    expect(Object.keys(campaign)).toEqual([
      "id", "name", "activeTimelineId", "ownerPrincipalId", "createdAt", "updatedAt",
    ]);
    expect(clockNow).toHaveBeenCalledOnce();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();

    const after = snapshot();
    expect(after.campaigns).toEqual([{
      id: "campaign-one",
      name: "Renamed",
      active_timeline_id: "timeline-one",
      owner_principal_id: "local-owner",
      owner_role: "owner",
      created_at: createdAt,
      updated_at: renamedAt,
    }]);
    expect(after.timelines).toEqual(before.timelines);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.attachments).toEqual(before.attachments);
  });

  it("writes a fresh timestamp when the normalized name is unchanged", () => {
    seed();
    const db = new DatabaseDriver(databasePath());
    db.prepare("UPDATE campaigns SET name = 'Same Name'").run();
    db.close();
    const clockNow = vi.fn(() => new Date(renamedAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    const campaign = repository.renameCampaign("local-owner", "campaign-one", { name: " Same Name " });

    expect(campaign.name).toBe("Same Name");
    expect(campaign.updatedAt).toBe(renamedAt);
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
    expect((snapshot().campaigns![0]! as { updated_at: string }).updated_at).toBe(renamedAt);
  });

  it("uses campaign ownership after application-owner transfer and grants no application-owner authority", () => {
    seed();
    const db = new DatabaseDriver(databasePath());
    db.prepare("UPDATE application_owner SET principal_id = 'principal-app-owner' WHERE singleton = 1").run();
    db.close();
    const clockNow = vi.fn(() => new Date(renamedAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.renameCampaign("principal-app-owner", "campaign-one", { name: "Denied" }))
      .toThrow("requires the campaign owner");
    expect(repository.renameCampaign("local-owner", "campaign-one", { name: "Allowed" }).name).toBe("Allowed");
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
  });

  it.each([
    ["gm", "principal-gm"],
    ["player", "principal-player"],
    ["observer", "principal-observer"],
    ["nonmember", "principal-nonmember"],
  ])("denies a %s actor without clock or ID use", (_role, actor) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date(renamedAt));
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.renameCampaign(actor, "campaign-one", { name: "Denied" }))
      .toThrow("requires the campaign owner");
    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();
    expect((snapshot().campaigns![0]! as { name: string }).name).toBe("Original");
  });

  it("loads the campaign before authorization and consumes dependencies only afterward", () => {
    seed();
    const clockNow = vi.fn(() => new Date(renamedAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.renameCampaign("principal-nonmember", "campaign-missing", { name: "Valid" }))
      .toThrow("campaign not found");
    expect(() => repository.renameCampaign("principal-nonmember", "campaign-one", { name: "Valid" }))
      .toThrow("requires the campaign owner");
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
  });

  it.each([
    ["invalid actor", "invalid actor", "campaign-one", { name: "Valid" }],
    ["invalid campaign", "local-owner", "invalid campaign", { name: "Valid" }],
    ["empty name", "local-owner", "campaign-one", { name: "   " }],
    ["long name", "local-owner", "campaign-one", { name: "x".repeat(201) }],
    ["unknown input", "local-owner", "campaign-one", { name: "Valid", unknown: true }],
  ])("rejects %s before dependencies or SQL changes", (_label, actor, campaignId, input) => {
    seed();
    const before = snapshot();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date(renamedAt));
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.renameCampaign(actor, campaignId, input as RenameCampaignInput)).toThrow();
    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ["clock failure", vi.fn(() => { throw new Error("clock unavailable"); }), "clock unavailable"],
    ["malformed clock", vi.fn(() => ({ toISOString: () => "not-a-time" }) as Date), undefined],
    ["backward clock", vi.fn(() => new Date("2030-04-05T06:07:08.008Z")), "cannot precede"],
  ])("rolls back on %s", (_label, clockNow, message) => {
    seed();
    const before = snapshot();
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });
    const operation = () => repository.renameCampaign("local-owner", "campaign-one", { name: "Renamed" });

    if (message) expect(operation).toThrow(message);
    else expect(operation).toThrow();
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
    expect(snapshot()).toEqual(before);
  });

  it("accepts a timestamp equal to current updated_at", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir(), clock: { now: () => new Date(createdAt) } });
    expect(repository.renameCampaign("local-owner", "campaign-one", { name: "Renamed" }).updatedAt).toBe(createdAt);
    repository.close();
  });

  it("rolls back after SQL update failure without retry", () => {
    seed();
    const before = snapshot();
    const db = new DatabaseDriver(databasePath());
    db.exec(`CREATE TRIGGER reject_campaign_rename BEFORE UPDATE OF name ON campaigns
      BEGIN SELECT RAISE(ABORT, 'rename rejected'); END;`);
    db.close();
    const clockNow = vi.fn(() => new Date(renamedAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.renameCampaign("local-owner", "campaign-one", { name: "Renamed" }))
      .toThrow("rename rejected");
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
    expect(snapshot()).toEqual(before);
  });

  it("rejects nested and closed calls before validation or dependencies", () => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date(renamedAt));
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.transaction(() => repository.renameCampaign("invalid actor", "invalid campaign", {
      name: "",
    }))).toThrow("campaign rename cannot run inside a repository transaction");
    repository.close();
    expect(() => repository.renameCampaign("invalid actor", "invalid campaign", { name: "" }))
      .toThrow("repository is closed");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
  });
});
