import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import type { AddCampaignMembershipInput } from "../src/types.js";
import { createCorruptionTestRepository, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const campaignAt = "2030-04-05T06:07:08.009Z";
const memberAt = "2030-04-05T06:07:09.010Z";

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
    ["principal-target", "Target"],
    ["principal-second", "Second"],
    ["principal-app-owner", "New application owner"],
  ]) {
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(id, name);
  }
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES ('campaign-one', 'Campaign', 'timeline-one', 'local-owner', ?, ?)`).run(campaignAt, campaignAt);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
      VALUES ('timeline-one', 'campaign-one', ?)`).run(campaignAt);
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-one', 'local-owner', 'owner', ?)").run(campaignAt);
  }).immediate();
  db.close();
}

function snapshot(): { campaigns: unknown[]; memberships: unknown[] } {
  const db = new DatabaseDriver(databasePath(), { readonly: true });
  const result = {
    campaigns: db.prepare("SELECT * FROM campaigns ORDER BY id").all(),
    memberships: db.prepare("SELECT * FROM campaign_memberships ORDER BY principal_id").all(),
  };
  db.close();
  return result;
}

describe("factory campaign membership addition", () => {
  it.each(["gm", "player", "observer"] as const)("returns and persists an exact %s membership with one clock and no IDs", (role) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date(memberAt));
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    const membership = repository.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target",
      role,
    });

    expect(membership).toEqual({
      campaignId: "campaign-one",
      principalId: "principal-target",
      role,
      createdAt: memberAt,
    });
    expect(Object.keys(membership)).toEqual(["campaignId", "principalId", "role", "createdAt"]);
    expect(clockNow).toHaveBeenCalledOnce();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();

    const rows = snapshot();
    expect(rows.memberships).toEqual([
      { campaign_id: "campaign-one", principal_id: "local-owner", role: "owner", created_at: campaignAt },
      { campaign_id: "campaign-one", principal_id: "principal-target", role, created_at: memberAt },
    ]);
    expect(rows.campaigns).toEqual([{
      id: "campaign-one",
      name: "Campaign",
      active_timeline_id: "timeline-one",
      owner_principal_id: "local-owner",
      owner_role: "owner",
      created_at: campaignAt,
      updated_at: memberAt,
      lifecycle_status: "draft",
      settings: '{"maxPlayers":6,"allowPlayerDice":true,"safetyMode":"standard","recapVisibility":"members","gmNotes":""}',
      administration_revision: 1,
    }]);
  });

  it("returns a same-role membership idempotently without clock use or another campaign update", () => {
    seed();
    const first = createRepository({ dataDir: dataDir(), clock: { now: () => new Date(memberAt) } });
    const expected = first.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target", role: "player",
    });
    first.close();
    const clockNow = vi.fn(() => { throw new Error("clock must not run"); });
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(repository.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target", role: "player",
    })).toEqual(expected);
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(snapshot().memberships).toHaveLength(2);
    expect((snapshot().campaigns[0] as { updated_at: string }).updated_at).toBe(memberAt);
  });

  it("uses campaign ownership after application-owner transfer and grants no application-owner authority", () => {
    seed();
    const db = new DatabaseDriver(databasePath());
    db.prepare("UPDATE application_owner SET principal_id = 'principal-app-owner' WHERE singleton = 1").run();
    db.close();
    const clockNow = vi.fn(() => new Date(memberAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.addCampaignMembership("principal-app-owner", "campaign-one", {
      principalId: "principal-target", role: "gm",
    })).toThrow("requires the campaign owner");
    expect(repository.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target", role: "gm",
    }).role).toBe("gm");
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
  });

  it.each(["gm", "player", "observer"] as const)("denies a %s actor before target lookup or clock use", (role) => {
    seed();
    const db = new DatabaseDriver(databasePath());
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-one', 'principal-target', ?, ?)").run(role, campaignAt);
    db.close();
    const clockNow = vi.fn(() => new Date(memberAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.addCampaignMembership("principal-target", "campaign-one", {
      principalId: "principal-missing", role: "player",
    })).toThrow("requires the campaign owner");
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
  });

  it("enforces campaign, owner, target, and existing-membership resolution order", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });

    expect(() => repository.addCampaignMembership("principal-target", "campaign-missing", {
      principalId: "principal-missing", role: "player",
    })).toThrow("campaign not found");
    expect(() => repository.addCampaignMembership("principal-target", "campaign-one", {
      principalId: "principal-missing", role: "player",
    })).toThrow("requires the campaign owner");
    expect(() => repository.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-missing", role: "player",
    })).toThrow("target principal not found");
    repository.close();
  });

  it("rejects different-role and owner-target conflicts without clock use", () => {
    seed();
    const db = new DatabaseDriver(databasePath());
    db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-one', 'principal-target', 'gm', ?)").run(campaignAt);
    db.close();
    const clockNow = vi.fn(() => new Date(memberAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target", role: "player",
    })).toThrow("different membership role");
    expect(() => repository.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "local-owner", role: "observer",
    })).toThrow("campaign owner cannot receive a member role");
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
  });

  it.each([
    ["invalid actor", "invalid actor", "campaign-one", { principalId: "principal-target", role: "player" }],
    ["invalid campaign", "local-owner", "invalid campaign", { principalId: "principal-target", role: "player" }],
    ["invalid target", "local-owner", "campaign-one", { principalId: "invalid target", role: "player" }],
    ["owner role", "local-owner", "campaign-one", { principalId: "principal-target", role: "owner" }],
    ["unknown input", "local-owner", "campaign-one", { principalId: "principal-target", role: "gm", unknown: true }],
  ])("rejects %s before dependency consumption", (_label, actor, campaignId, input) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date(memberAt));
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.addCampaignMembership(actor, campaignId, input as AddCampaignMembershipInput)).toThrow();
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(snapshot().memberships).toHaveLength(1);
  });

  it.each([
    ["clock failure", vi.fn(() => { throw new Error("clock unavailable"); }), "clock unavailable"],
    ["malformed clock", vi.fn(() => ({ toISOString: () => "not-a-time" }) as Date), undefined],
    ["backward clock", vi.fn(() => new Date("2030-04-05T06:07:08.008Z")), "cannot precede"],
  ])("rejects %s and leaves both rows unchanged", (_label, clockNow, message) => {
    seed();
    const before = snapshot();
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    const operation = () => repository.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target", role: "player",
    });
    if (message) expect(operation).toThrow(message);
    else expect(operation).toThrow();
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
    expect(snapshot()).toEqual(before);
  });

  it("accepts a timestamp equal to campaign updated_at", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir(), clock: { now: () => new Date(campaignAt) } });

    expect(repository.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target", role: "observer",
    }).createdAt).toBe(campaignAt);
    repository.close();
  });

  it.each(["insert", "update"])("rolls back membership and campaign time after a trigger rejects the %s", (stage) => {
    seed();
    const before = snapshot();
    const db = new DatabaseDriver(databasePath());
    db.exec(stage === "insert"
      ? `CREATE TRIGGER reject_membership BEFORE INSERT ON campaign_memberships
          BEGIN SELECT RAISE(ABORT, 'membership rejected'); END;`
      : `CREATE TRIGGER reject_campaign_update BEFORE UPDATE ON campaigns
          BEGIN SELECT RAISE(ABORT, 'campaign update rejected'); END;`);
    db.close();
    const clockNow = vi.fn(() => new Date(memberAt));
    const repository = createCorruptionTestRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target", role: "gm",
    })).toThrow(stage === "insert" ? "membership rejected" : "campaign update rejected");
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
    expect(snapshot()).toEqual(before);
  });

  it("serializes competing repository instances and neither retries nor reclocks resolved conflicts", () => {
    seed();
    const firstClock = vi.fn(() => new Date(memberAt));
    const secondClock = vi.fn(() => { throw new Error("second clock must not run"); });
    const first = createRepository({ dataDir: dataDir(), clock: { now: firstClock } });
    const second = createRepository({ dataDir: dataDir(), clock: { now: secondClock } });

    const expected = first.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target", role: "player",
    });
    expect(second.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target", role: "player",
    })).toEqual(expected);
    expect(() => second.addCampaignMembership("local-owner", "campaign-one", {
      principalId: "principal-target", role: "gm",
    })).toThrow("different membership role");
    expect(firstClock).toHaveBeenCalledOnce();
    expect(secondClock).not.toHaveBeenCalled();
    first.close();
    second.close();
    expect(snapshot().memberships).toHaveLength(2);
  });

  it("rejects nested and closed calls before validation or dependencies", () => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date(memberAt));
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.transaction(() => repository.addCampaignMembership("invalid actor", "invalid campaign", {
      principalId: "invalid target", role: "player",
    }))).toThrow("campaign membership addition cannot run inside a repository transaction");
    repository.close();
    expect(() => repository.addCampaignMembership("invalid actor", "invalid campaign", {
      principalId: "invalid target", role: "player",
    })).toThrow("repository is closed");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
  });
});
