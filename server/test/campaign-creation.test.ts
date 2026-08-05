import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CampaignCreationAuthorizationError,
  CampaignCreationIdCollisionError,
  createRepository,
} from "../src/repo/index.js";
import type { CreateCampaignInput } from "../src/types.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const fixedAt = "2030-04-05T06:07:08.009Z";

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function databasePath(): string {
  return path.join(dataDir(), "velvet.sqlite");
}

function campaignCounts(): { campaigns: number; timelines: number; memberships: number } {
  const db = new DatabaseDriver(databasePath(), { readonly: true });
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  const counts = {
    campaigns: count("campaigns"),
    timelines: count("campaign_timelines"),
    memberships: count("campaign_memberships"),
  };
  db.close();
  return counts;
}

describe("factory campaign creation", () => {
  it("returns and persists an exact atomic campaign with two IDs and one timestamp", () => {
    const calls: string[] = [];
    const ids = ["campaign-fixed", "timeline-fixed"];
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId: () => { calls.push("id"); return ids.shift()!; } },
      clock: { now: () => { calls.push("clock"); return new Date(fixedAt); } },
    });

    const campaign = repository.createCampaign("local-owner", { name: "  The Long Road  " });

    expect(campaign).toEqual({
      id: "campaign-fixed",
      name: "The Long Road",
      activeTimelineId: "timeline-fixed",
      ownerPrincipalId: "local-owner",
      createdAt: fixedAt,
      updatedAt: fixedAt,
    });
    expect(Object.keys(campaign)).toEqual([
      "id", "name", "activeTimelineId", "ownerPrincipalId", "createdAt", "updatedAt",
    ]);
    expect(calls).toEqual(["id", "id", "clock"]);
    repository.close();

    const db = new DatabaseDriver(databasePath(), { readonly: true });
    expect(db.prepare("SELECT * FROM campaigns").all()).toEqual([{
      id: "campaign-fixed",
      name: "The Long Road",
      active_timeline_id: "timeline-fixed",
      owner_principal_id: "local-owner",
      owner_role: "owner",
      created_at: fixedAt,
      updated_at: fixedAt,
      lifecycle_status: "draft",
      settings: '{"maxPlayers":6,"allowPlayerDice":true,"safetyMode":"standard","recapVisibility":"members","gmNotes":""}',
      administration_revision: 0,
    }]);
    expect(db.prepare("SELECT * FROM campaign_timelines").all()).toEqual([{
      id: "timeline-fixed", campaign_id: "campaign-fixed", created_at: fixedAt, revision: 0,
    }]);
    expect(db.prepare("SELECT * FROM campaign_timeline_history").all()).toEqual([{
      campaign_id: "campaign-fixed", timeline_id: "timeline-fixed", parent_timeline_id: null,
      source_timeline_id: null, created_by_command_id: null, forked_from_revision: null,
    }]);
    expect(db.prepare("SELECT * FROM campaign_memberships").all()).toEqual([{
      campaign_id: "campaign-fixed", principal_id: "local-owner", role: "owner", created_at: fixedAt,
    }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it.each([
    ["invalid actor", "invalid actor", { name: "Valid" }],
    ["blank name", "local-owner", { name: "   " }],
    ["long name", "local-owner", { name: "x".repeat(201) }],
    ["unknown input", "local-owner", { name: "Valid", unknown: true }],
  ])("rejects %s before consuming dependencies", (_label, actor, input) => {
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId },
      clock: { now: clockNow },
    });

    expect(() => repository.createCampaign(actor, input as CreateCampaignInput)).toThrow();
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(campaignCounts()).toEqual({ campaigns: 0, timelines: 0, memberships: 0 });
  });

  it("authorizes the current application owner relation rather than a hard-coded principal", () => {
    const initial = createRepository({ dataDir: dataDir() });
    initial.close();
    const db = new DatabaseDriver(databasePath());
    db.pragma("foreign_keys = ON");
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES ('remote-owner', 'Remote owner', 0)").run();
    db.prepare("UPDATE application_owner SET principal_id = 'remote-owner' WHERE singleton = 1").run();
    db.close();
    const nextId = vi.fn()
      .mockReturnValueOnce("campaign-remote")
      .mockReturnValueOnce("timeline-remote");
    const clockNow = vi.fn(() => new Date(fixedAt));
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId },
      clock: { now: clockNow },
    });

    expect(() => repository.createCampaign("local-owner", { name: "Denied" }))
      .toThrow(CampaignCreationAuthorizationError);
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    expect(repository.createCampaign("remote-owner", { name: "Authorized" }).ownerPrincipalId).toBe("remote-owner");
    expect(nextId).toHaveBeenCalledTimes(2);
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
  });

  it.each(["missing", "malformed"] as const)(
    "treats a %s application owner as a generic invariant failure without dependencies or writes",
    (corruption) => {
      const initial = createRepository({ dataDir: dataDir() });
      initial.close();
      const db = new DatabaseDriver(databasePath());
      if (corruption === "missing") {
        db.exec("DROP TRIGGER application_owner_prevent_delete; DELETE FROM application_owner;");
      } else {
        db.pragma("foreign_keys = OFF");
        db.prepare("UPDATE application_owner SET principal_id = 'malformed owner' WHERE singleton = 1").run();
      }
      db.close();
      const nextId = vi.fn(() => "unused");
      const clockNow = vi.fn(() => new Date(fixedAt));
      const repository = createRepository({
        dataDir: dataDir(),
        ids: { nextId },
        clock: { now: clockNow },
      });

      let failure: unknown;
      try {
        repository.createCampaign("local-owner", { name: "Invariant check" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(CampaignCreationAuthorizationError);
      expect(nextId).not.toHaveBeenCalled();
      expect(clockNow).not.toHaveBeenCalled();
      repository.close();
      expect(campaignCounts()).toEqual({ campaigns: 0, timelines: 0, memberships: 0 });
    },
  );

  it("stops at the first ID failure", () => {
    const nextId = vi.fn(() => { throw new Error("first ID unavailable"); });
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId },
      clock: { now: clockNow },
    });

    expect(() => repository.createCampaign("local-owner", { name: "Failure" })).toThrow("first ID unavailable");
    expect(nextId).toHaveBeenCalledOnce();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(campaignCounts()).toEqual({ campaigns: 0, timelines: 0, memberships: 0 });
  });

  it("consumes only the campaign ID when the timeline ID fails", () => {
    const nextId = vi.fn()
      .mockReturnValueOnce("campaign-consumed")
      .mockImplementationOnce(() => { throw new Error("second ID unavailable"); });
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId },
      clock: { now: clockNow },
    });

    expect(() => repository.createCampaign("local-owner", { name: "Failure" })).toThrow("second ID unavailable");
    expect(nextId).toHaveBeenCalledTimes(2);
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(campaignCounts()).toEqual({ campaigns: 0, timelines: 0, memberships: 0 });
  });

  it.each([
    ["invalid campaign ID", ["invalid id", "timeline-unused"], vi.fn(() => new Date(fixedAt)), 1, 0],
    ["invalid timeline ID", ["campaign-used", "invalid id"], vi.fn(() => new Date(fixedAt)), 2, 0],
    ["clock failure", ["campaign-used", "timeline-used"], vi.fn(() => { throw new Error("clock unavailable"); }), 2, 1],
    ["invalid clock", ["campaign-used", "timeline-used"], vi.fn(() => ({ toISOString: () => "not-a-time" }) as Date), 2, 1],
  ])("rolls back after %s with exact dependency consumption", (_label, values, clockNow, idCalls, clockCalls) => {
    const ids = [...values];
    const nextId = vi.fn(() => ids.shift()!);
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId },
      clock: { now: clockNow },
    });

    expect(() => repository.createCampaign("local-owner", { name: "Failure" })).toThrow();
    expect(nextId).toHaveBeenCalledTimes(idCalls);
    expect(clockNow).toHaveBeenCalledTimes(clockCalls);
    repository.close();
    expect(campaignCounts()).toEqual({ campaigns: 0, timelines: 0, memberships: 0 });
  });

  it("does not retry collisions and rolls back a campaign inserted before a timeline collision", () => {
    const initialIds = ["campaign-one", "timeline-one"];
    const initial = createRepository({
      dataDir: dataDir(),
      ids: { nextId: () => initialIds.shift()! },
      clock: { now: () => new Date(fixedAt) },
    });
    initial.createCampaign("local-owner", { name: "First" });
    initial.close();

    const campaignCollisionIds = ["campaign-one", "timeline-two"];
    const campaignCollision = createRepository({
      dataDir: dataDir(),
      ids: { nextId: () => campaignCollisionIds.shift()! },
      clock: { now: () => new Date(fixedAt) },
    });
    expect(() => campaignCollision.createCampaign("local-owner", { name: "Campaign collision" }))
      .toThrow(CampaignCreationIdCollisionError);
    campaignCollision.close();

    const timelineCollisionIds = ["campaign-two", "timeline-one"];
    const timelineCollision = createRepository({
      dataDir: dataDir(),
      ids: { nextId: () => timelineCollisionIds.shift()! },
      clock: { now: () => new Date(fixedAt) },
    });
    expect(() => timelineCollision.createCampaign("local-owner", { name: "Timeline collision" }))
      .toThrow(CampaignCreationIdCollisionError);
    timelineCollision.close();

    expect(campaignCounts()).toEqual({ campaigns: 1, timelines: 1, memberships: 1 });
  });

  it("rolls back campaign and timeline when owner membership insertion fails", () => {
    const initial = createRepository({ dataDir: dataDir() });
    initial.close();
    const db = new DatabaseDriver(databasePath());
    db.exec(`CREATE TRIGGER reject_campaign_membership BEFORE INSERT ON campaign_memberships
      BEGIN SELECT RAISE(ABORT, 'membership rejected'); END;`);
    db.close();
    const ids = ["campaign-rolled-back", "timeline-rolled-back"];
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId: () => ids.shift()! },
      clock: { now: () => new Date(fixedAt) },
    });

    expect(() => repository.createCampaign("local-owner", { name: "Rollback" })).toThrow("membership rejected");
    repository.close();
    expect(campaignCounts()).toEqual({ campaigns: 0, timelines: 0, memberships: 0 });
  });

  it("rejects creation after close before validation or dependency consumption", () => {
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId },
      clock: { now: clockNow },
    });
    repository.close();

    expect(() => repository.createCampaign("invalid actor", { name: "   " })).toThrow("repository is closed");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
  });

  it("rejects factory campaign creation inside repository transactions before consuming dependencies", () => {
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId },
      clock: { now: clockNow },
    });

    expect(() => repository.transaction(() => repository.createCampaign("local-owner", { name: "Nested" })))
      .toThrow("campaign creation cannot run inside a repository transaction");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(campaignCounts()).toEqual({ campaigns: 0, timelines: 0, memberships: 0 });
  });
});
