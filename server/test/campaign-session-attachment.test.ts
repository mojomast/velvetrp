import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CampaignSessionAttachmentConflictError, createRepository } from "../src/repo/index.js";
import type { AttachCampaignSessionInput } from "../src/types.js";
import { deleteCampaignForCorruptionTest, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const fixedAt = "2030-04-05T06:07:08.009Z";

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function databasePath(): string {
  return path.join(dataDir(), "velvet.sqlite");
}

function seed(options: { sessionId?: string; state?: string; stoppedAt?: string | null; secondCampaign?: boolean } = {}): void {
  const repository = createRepository({ dataDir: dataDir() });
  repository.close();
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = ON");
  const sessionId = options.sessionId ?? "session/legacy value";
  db.prepare(`INSERT INTO characters VALUES
    ('character-one', 'Character', 30, 'captain', 'fictional', 1, 0, ?)`).run(fixedAt);
  db.prepare(`INSERT INTO sessions VALUES (?, 'character-one', 'Session', ?, 'default', NULL, ?, ?, ?)`)
    .run(sessionId, options.state ?? "setup", fixedAt,
      options.stoppedAt !== undefined ? options.stoppedAt : options.state === "closed" ? fixedAt : null,
      options.stoppedAt || options.state === "closed" ? "user-stop" : null);
  db.prepare("INSERT INTO session_characters VALUES (?, 'character-one', 0)").run(sessionId);
  const campaigns = options.secondCampaign ? ["campaign-one", "campaign-two"] : ["campaign-one"];
  const insertCampaign = db.transaction((campaignId: string) => {
    const timelineId = `timeline-${campaignId}`;
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, ?, ?, 'local-owner', ?, ?)`).run(campaignId, campaignId, timelineId, fixedAt, fixedAt);
    db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES (?, ?, ?)")
      .run(timelineId, campaignId, fixedAt);
    db.prepare("INSERT INTO campaign_memberships VALUES (?, 'local-owner', 'owner', ?)").run(campaignId, fixedAt);
  });
  for (const campaignId of campaigns) {
    insertCampaign.immediate(campaignId);
  }
  db.close();
}

function attachmentRows(): unknown[] {
  const db = new DatabaseDriver(databasePath(), { readonly: true });
  const rows = db.prepare("SELECT * FROM campaign_sessions").all();
  db.close();
  return rows;
}

function corrupt(sql: string): void {
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = OFF");
  db.pragma("ignore_check_constraints = ON");
  db.exec(sql);
  db.close();
}

describe("factory campaign-session attachment", () => {
  it("returns and persists the exact attachment with one clock and no IDs", () => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date(fixedAt));
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    const attachment = repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-one",
      sessionId: "session/legacy value",
    });

    expect(attachment).toEqual({
      campaignId: "campaign-one",
      sessionId: "session/legacy value",
      attachedAt: fixedAt,
    });
    expect(Object.keys(attachment)).toEqual(["campaignId", "sessionId", "attachedAt"]);
    expect(clockNow).toHaveBeenCalledOnce();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();
    expect(attachmentRows()).toEqual([{
      session_id: "session/legacy value", campaign_id: "campaign-one", attached_at: fixedAt,
    }]);
  });

  it("returns the same attachment idempotently without clock use, including after stop", () => {
    seed();
    const initial = createRepository({ dataDir: dataDir(), clock: { now: () => new Date(fixedAt) } });
    const expected = initial.attachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/legacy value",
    });
    initial.stopSession("session/legacy value", "user-stop");
    initial.close();
    const clockNow = vi.fn(() => { throw new Error("clock must not run"); });
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/legacy value",
    })).toEqual(expected);
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(attachmentRows()).toHaveLength(1);
  });

  it("rejects a different-campaign conflict without clock use", () => {
    seed({ secondCampaign: true });
    const initial = createRepository({ dataDir: dataDir(), clock: { now: () => new Date(fixedAt) } });
    initial.attachCampaignSession("local-owner", { campaignId: "campaign-one", sessionId: "session/legacy value" });
    initial.close();
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-two", sessionId: "session/legacy value",
    })).toThrow("session is already attached to a different campaign");
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(attachmentRows()).toHaveLength(1);
  });

  it("rejects a stopped session only when creating a new attachment", () => {
    seed({ state: "closed" });
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/legacy value",
    })).toThrow("stopped sessions cannot be attached to campaigns");
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(attachmentRows()).toEqual([]);
  });

  it("treats noncanonical stopped provenance as untyped corruption", () => {
    seed({ state: "active", stoppedAt: fixedAt });
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/legacy value",
    })).toThrow("campaign room session graph is malformed");
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(attachmentRows()).toEqual([]);
  });

  it.each([
    ["unknown state", "UPDATE sessions SET state = 'future-state'"],
    ["closed without stopped time", "UPDATE sessions SET state = 'closed', stop_reason = 'user-stop'"],
    ["closed without reason", `UPDATE sessions SET state = 'closed', stopped_at = '${fixedAt}', stop_reason = NULL`],
    ["running with reason", "UPDATE sessions SET stop_reason = 'user-stop'"],
    ["invalid creation time", "UPDATE sessions SET created_at = 'invalid'"],
    ["empty participant set", "DELETE FROM session_characters"],
    ["noncontiguous participant position", "UPDATE session_characters SET position = 2"],
    ["orphan participant character", "DELETE FROM characters WHERE id = 'character-one'"],
  ])("rejects malformed target integrity before clock: %s", (_label, mutation) => {
    seed();
    corrupt(mutation);
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });
    expect(() => repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/legacy value",
    })).toThrow("campaign room session graph is malformed");
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(attachmentRows()).toEqual([]);
  });

  it.each([
    ["healthy", ""],
    ["corrupt lifecycle", `UPDATE sessions SET stopped_at = '${fixedAt}', stop_reason = 'user-stop'
      WHERE id = 'session/legacy value'`],
    ["corrupt participants", "DELETE FROM session_characters WHERE session_id = 'session/legacy value'"],
    ["orphan session", "DELETE FROM sessions WHERE id = 'session/legacy value'"],
    ["malformed foreign attachment", "UPDATE campaign_sessions SET attached_at = 'invalid'"],
    ["orphan foreign campaign", "DELETE FROM campaigns WHERE id = 'campaign-one'"],
  ])("masks a %s foreign graph behind the same typed conflict without dependencies", (_label, mutation) => {
    seed({ secondCampaign: true });
    const initial = createRepository({ dataDir: dataDir(), clock: { now: () => new Date(fixedAt) } });
    initial.attachCampaignSession("local-owner", { campaignId: "campaign-one", sessionId: "session/legacy value" });
    initial.close();
    if (mutation === "DELETE FROM campaigns WHERE id = 'campaign-one'") {
      const damage=new DatabaseDriver(databasePath());damage.pragma("foreign_keys=OFF");deleteCampaignForCorruptionTest(damage,"campaign-one");damage.exec(mutation);damage.close();
    } else if (mutation) corrupt(mutation);
    const clockNow = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow }, ids: { nextId } });
    let thrown: unknown;
    try {
      repository.attachCampaignSession("local-owner", {
        campaignId: "campaign-two", sessionId: "session/legacy value",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CampaignSessionAttachmentConflictError);
    expect((thrown as Error).message).toBe("session is already attached to a different campaign");
    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();
  });

  it("does not type an orphan existing attachment as a missing room", () => {
    seed();
    const initial = createRepository({ dataDir: dataDir(), clock: { now: () => new Date(fixedAt) } });
    initial.attachCampaignSession("local-owner", { campaignId: "campaign-one", sessionId: "session/legacy value" });
    initial.close();
    corrupt("DELETE FROM sessions WHERE id = 'session/legacy value'");
    const repository = createRepository({ dataDir: dataDir(), clock: { now: vi.fn() } });
    expect(() => repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/legacy value",
    })).toThrow("campaign session attachment has no session parent");
    repository.close();
  });

  it.each([
    ["missing campaign", "local-owner", { campaignId: "campaign-missing", sessionId: "session/legacy value" }, "campaign not found"],
    ["non-owner", "principal-other", { campaignId: "campaign-one", sessionId: "session/legacy value" }, "requires the campaign owner"],
    ["missing session", "local-owner", { campaignId: "campaign-one", sessionId: "session-missing" }, "session not found"],
  ])("rejects %s before clock use", (_label, actor, input, message) => {
    seed();
    const db = new DatabaseDriver(databasePath());
    db.prepare("INSERT INTO principals VALUES ('principal-other', 'Other', 0)").run();
    db.close();
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.attachCampaignSession(actor, input)).toThrow(message);
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(attachmentRows()).toEqual([]);
  });

  it("checks campaign existence and ownership before session existence", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });

    expect(() => repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-missing", sessionId: "session-missing",
    })).toThrow("campaign not found");
    expect(() => repository.attachCampaignSession("principal-other", {
      campaignId: "campaign-one", sessionId: "session-missing",
    })).toThrow("requires the campaign owner");
    repository.close();
  });

  it("denies campaign members and a transferred application owner without consuming dependencies", () => {
    seed();
    const db = new DatabaseDriver(databasePath());
    db.pragma("foreign_keys = ON");
    for (const [principalId, role] of [
      ["principal-gm", "gm"],
      ["principal-player", "player"],
      ["principal-observer", "observer"],
    ] as const) {
      db.prepare("INSERT INTO principals VALUES (?, ?, 0)").run(principalId, principalId);
      db.prepare("INSERT INTO campaign_memberships VALUES ('campaign-one', ?, ?, ?)")
        .run(principalId, role, fixedAt);
    }
    db.prepare("INSERT INTO principals VALUES ('principal-app-owner', 'Application owner', 0)").run();
    db.prepare("UPDATE application_owner SET principal_id = 'principal-app-owner' WHERE singleton = 1").run();
    db.close();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date(fixedAt));
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });
    const input = { campaignId: "campaign-one", sessionId: "session/legacy value" };

    for (const actor of ["principal-gm", "principal-player", "principal-observer", "principal-app-owner"]) {
      expect(() => repository.attachCampaignSession(actor, input)).toThrow("requires the campaign owner");
    }
    expect(clockNow).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(attachmentRows()).toEqual([]);

    expect(repository.attachCampaignSession("local-owner", input)).toEqual({
      campaignId: "campaign-one",
      sessionId: "session/legacy value",
      attachedAt: fixedAt,
    });
    expect(clockNow).toHaveBeenCalledOnce();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();
  });

  it.each([
    ["invalid actor", "invalid actor", { campaignId: "campaign-one", sessionId: "session/legacy value" }],
    ["invalid campaign", "local-owner", { campaignId: "invalid campaign", sessionId: "session/legacy value" }],
    ["empty session", "local-owner", { campaignId: "campaign-one", sessionId: "" }],
    ["unknown input", "local-owner", { campaignId: "campaign-one", sessionId: "session/legacy value", unknown: true }],
  ])("rejects %s before dependency consumption", (_label, actor, input) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.attachCampaignSession(actor, input as AttachCampaignSessionInput)).toThrow();
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(attachmentRows()).toEqual([]);
  });

  it.each([
    ["clock failure", vi.fn(() => { throw new Error("clock unavailable"); })],
    ["invalid clock", vi.fn(() => ({ toISOString: () => "not-a-time" }) as Date)],
  ])("rolls back after %s", (_label, clockNow) => {
    seed();
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/legacy value",
    })).toThrow();
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
    expect(attachmentRows()).toEqual([]);
  });

  it("rolls back after insertion failure and does not retry", () => {
    seed();
    const db = new DatabaseDriver(databasePath());
    db.exec(`CREATE TRIGGER reject_attachment BEFORE INSERT ON campaign_sessions
      BEGIN SELECT RAISE(ABORT, 'attachment rejected'); END;`);
    db.close();
    const clockNow = vi.fn(() => new Date(fixedAt));
    const repository = createRepository({ dataDir: dataDir(), clock: { now: clockNow } });

    expect(() => repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/legacy value",
    })).toThrow("attachment rejected");
    expect(clockNow).toHaveBeenCalledOnce();
    repository.close();
    expect(attachmentRows()).toEqual([]);
  });

  it("rejects after close and inside repository transactions before validation or dependencies", () => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.transaction(() => repository.attachCampaignSession("invalid actor", {
      campaignId: "invalid campaign", sessionId: "",
    }))).toThrow("campaign session attachment cannot run inside a repository transaction");
    repository.close();
    expect(() => repository.attachCampaignSession("invalid actor", {
      campaignId: "invalid campaign", sessionId: "",
    })).toThrow("repository is closed");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    expect(attachmentRows()).toEqual([]);
  });

  it("preserves schema cascade behavior", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir(), clock: { now: () => new Date(fixedAt) } });
    repository.attachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/legacy value",
    });
    repository.close();
    const db = new DatabaseDriver(databasePath());
    db.pragma("foreign_keys = ON");
    deleteCampaignForCorruptionTest(db,"campaign-one");db.prepare("DELETE FROM campaigns WHERE id = 'campaign-one'").run();
    expect(db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "session/legacy value" }]);
    expect(db.prepare("SELECT * FROM campaign_sessions").all()).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM campaign_administration_receipts").get()).toEqual({ count: 0 });
    db.close();
  });
});
