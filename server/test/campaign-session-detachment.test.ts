import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CampaignAdministrationConflictError,
  CampaignSessionAttachmentConflictError,
  createRepository,
} from "../src/repo/index.js";
import type { DetachCampaignSessionInput } from "../src/types.js";
import { useTmpDataDir } from "./helpers.js";
import { startLockedWrite } from "./lock-worker.js";

useTmpDataDir();

const fixedAt = "2030-04-05T06:07:08.009Z";

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
  db.prepare(`INSERT INTO characters VALUES
    ('character-one', 'Character', 30, 'captain', 'fictional', 1, 0, ?)`)
    .run(fixedAt);
  for (const [sessionId, state, stoppedAt, stopReason] of [
    ["session/attached", "active", null, null],
    ["session/stopped", "closed", fixedAt, "user-stop"],
    ["session/unattached", "setup", null, null],
    ["session/other", "active", null, null],
  ] as const) {
    db.prepare(`INSERT INTO sessions VALUES (?, 'character-one', ?, ?, 'default', NULL, ?, ?, ?)`)
      .run(sessionId, sessionId, state, fixedAt, stoppedAt, stopReason);
    db.prepare("INSERT INTO session_characters VALUES (?, 'character-one', 0)").run(sessionId);
  }
  const insertCampaign = db.transaction((campaignId: string) => {
    const timelineId = `timeline-${campaignId}`;
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, ?, ?, 'local-owner', ?, ?)`)
      .run(campaignId, campaignId, timelineId, fixedAt, fixedAt);
    db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES (?, ?, ?)")
      .run(timelineId, campaignId, fixedAt);
    db.prepare("INSERT INTO campaign_memberships VALUES (?, 'local-owner', 'owner', ?)")
      .run(campaignId, fixedAt);
  });
  for (const campaignId of ["campaign-one", "campaign-two"]) {
    insertCampaign.immediate(campaignId);
  }
  db.prepare("INSERT INTO campaign_sessions VALUES ('session/attached', 'campaign-one', ?)").run(fixedAt);
  db.prepare("INSERT INTO campaign_sessions VALUES ('session/stopped', 'campaign-one', ?)").run(fixedAt);
  db.prepare("INSERT INTO campaign_sessions VALUES ('session/other', 'campaign-two', ?)").run(fixedAt);
  db.close();
}

function snapshot(): { attachments: unknown[]; campaigns: unknown[] } {
  const db = new DatabaseDriver(databasePath(), { readonly: true });
  const result = {
    attachments: db.prepare("SELECT * FROM campaign_sessions ORDER BY session_id").all(),
    campaigns: db.prepare("SELECT id, updated_at FROM campaigns ORDER BY id").all(),
  };
  db.close();
  return result;
}

function seedNpcPresence(sessionId: string, leave = false): void {
  const repository = createRepository({ dataDir: dataDir(), clock: { now: () => new Date("2031-01-01T00:00:00.000Z") } });
  const npc = repository.createCampaignNpc("local-owner", "campaign-one", {
    personaId: "character-one",
    publicState: { name: "Detachment NPC" },
    privateState: { goals: "Stay", gmNotes: "Present", merchantState: null },
    expectedRevision: 0,
    idempotencyKey: "detachment-npc",
  }).npc;
  repository.mutateNpcPresence("local-owner", {
    campaignId: "campaign-one", sessionId, npcId: npc.npcId, expectedRevision: 0,
    idempotencyKey: "presence-place", mutation: { kind: "place", locationId: null },
  });
  if (leave) {
    repository.mutateNpcPresence("local-owner", {
      campaignId: "campaign-one", sessionId, npcId: npc.npcId, expectedRevision: 1,
      idempotencyKey: "presence-leave", mutation: { kind: "remove" },
    });
  }
  repository.close();
}

function seedPresenceSession(sessionId: string): void {
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = ON");
  db.prepare(`INSERT INTO sessions VALUES (?, 'character-one', ?, 'active', 'default', NULL, ?, NULL, NULL)`)
    .run(sessionId, sessionId, fixedAt);
  db.prepare("INSERT INTO session_characters VALUES (?, 'character-one', 0)").run(sessionId);
  db.prepare("INSERT INTO campaign_sessions VALUES (?, 'campaign-one', ?)").run(sessionId, fixedAt);
  db.close();
}

function presenceHistory(sessionId: string): unknown {
  const db = new DatabaseDriver(databasePath(), { readonly: true });
  const result = Object.fromEntries([
    "npc_presence_session_revisions_v43", "campaign_npc_presence_v43", "npc_presence_commands_v43",
    "npc_presence_events_v43", "npc_presence_receipts_v43",
  ].map((table) => [table, db.prepare(`SELECT * FROM ${table} WHERE campaign_id=? AND session_id=? ORDER BY rowid`)
    .all("campaign-one", sessionId)]));
  db.close();
  return result;
}

describe("factory campaign-session detachment", () => {
  it("returns the exact prior attachment, preserves other rows and campaign time, and consumes no dependencies", () => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => { throw new Error("clock must not run"); });
    const before = snapshot();
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    const detached = repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/attached",
    });

    expect(detached).toEqual({
      campaignId: "campaign-one", sessionId: "session/attached", attachedAt: fixedAt,
    });
    expect(Object.keys(detached!)).toEqual(["campaignId", "sessionId", "attachedAt"]);
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    const after = snapshot();
    expect(after.campaigns).toEqual(before.campaigns);
    expect(after.attachments).toEqual(before.attachments.filter((row) =>
      (row as { session_id: string }).session_id !== "session/attached"));
  });

  it("detaches a stopped session without clock or ID use", () => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/stopped",
    })).toEqual({ campaignId: "campaign-one", sessionId: "session/stopped", attachedAt: fixedAt });
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
  });

  it("blocks legacy detach for a running present NPC without writes or dependency use", () => {
    seed();
    seedPresenceSession("session-present");
    seedNpcPresence("session-present");
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const before = { repository: snapshot(), presence: presenceHistory("session-present") };
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session-present",
    })).toThrow(CampaignSessionAttachmentConflictError);
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect({ repository: snapshot(), presence: presenceHistory("session-present") }).toEqual(before);
  });

  it("fails loudly instead of treating malformed lifecycle as stopped during detach", () => {
    seed();
    seedPresenceSession("session-malformed");
    seedNpcPresence("session-malformed");
    const db = new DatabaseDriver(databasePath());
    db.prepare("UPDATE sessions SET state='closed',stopped_at=NULL,stop_reason=NULL WHERE id='session-malformed'").run();
    db.close();
    const before = { repository: snapshot(), presence: presenceHistory("session-malformed") };
    const repository = createRepository({ dataDir: dataDir() });

    expect(() => repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session-malformed",
    })).toThrow("campaign room session graph is malformed");
    repository.close();
    expect({ repository: snapshot(), presence: presenceHistory("session-malformed") }).toEqual(before);
  });

  it("permits legacy detach after the last NPC leaves and preserves all presence history", () => {
    seed();
    seedPresenceSession("session-left");
    seedNpcPresence("session-left", true);
    const before = presenceHistory("session-left");
    const repository = createRepository({ dataDir: dataDir() });

    expect(repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session-left",
    })).toEqual({ campaignId: "campaign-one", sessionId: "session-left", attachedAt: fixedAt });
    repository.close();
    expect(presenceHistory("session-left")).toEqual(before);
  });

  it("permits audited detach with NPCs present at stop, preserves history, and replays exactly", () => {
    seed();
    seedPresenceSession("session-stopped-present");
    seedNpcPresence("session-stopped-present");
    const stopped = new DatabaseDriver(databasePath());
    stopped.prepare("UPDATE sessions SET state='closed',stopped_at=?,stop_reason='done' WHERE id='session-stopped-present'").run(fixedAt);
    stopped.close();
    const before = presenceHistory("session-stopped-present");
    const repository = createRepository({ dataDir: dataDir(), clock: { now: () => new Date("2032-01-01T00:00:00.000Z") } });
    const input = { sessionId: "session-stopped-present", expectedRevision: 0, idempotencyKey: "audited-stopped-detach" };

    const detached = repository.detachAuditedCampaignRoom("local-owner", "campaign-one", input);
    expect(detached.value).toEqual({ campaignId: "campaign-one", sessionId: "session-stopped-present", attachedAt: fixedAt });
    expect(repository.detachAuditedCampaignRoom("local-owner", "campaign-one", input)).toEqual(detached);
    repository.close();
    expect(presenceHistory("session-stopped-present")).toEqual(before);
  });

  it("blocks audited detach before IDs, clock, audit writes, or revision changes", () => {
    seed();
    seedPresenceSession("session-audited-present");
    seedNpcPresence("session-audited-present");
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const before = snapshot();
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.detachAuditedCampaignRoom("local-owner", "campaign-one", {
      sessionId: "session-audited-present", expectedRevision: 0, idempotencyKey: "blocked-audited-detach",
    })).toThrow(CampaignAdministrationConflictError);
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(snapshot()).toEqual(before);
    const audit = new DatabaseDriver(databasePath(), { readonly: true });
    expect(audit.prepare("SELECT 1 FROM campaign_administration_commands WHERE idempotency_key='blocked-audited-detach'").get()).toBeUndefined();
    audit.close();
  });

  it("returns null for unattached, missing, cross-campaign, and repeated requests after authorization", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });

    expect(repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/unattached",
    })).toBeNull();
    expect(repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/missing",
    })).toBeNull();
    expect(repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-two", sessionId: "session/attached",
    })).toBeNull();
    expect(repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/attached",
    })).not.toBeNull();
    expect(repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/attached",
    })).toBeNull();
    repository.close();
    expect(snapshot().attachments).toEqual([
      { session_id: "session/other", campaign_id: "campaign-two", attached_at: fixedAt },
      { session_id: "session/stopped", campaign_id: "campaign-one", attached_at: fixedAt },
    ]);
  });

  it("requires the exact campaign owner and gives no application-owner bypass", () => {
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
    const before = snapshot();
    const repository = createRepository({ dataDir: dataDir() });
    const input = { campaignId: "campaign-one", sessionId: "session/attached" };

    for (const actor of ["principal-gm", "principal-player", "principal-observer", "principal-app-owner"]) {
      expect(() => repository.detachCampaignSession(actor, input)).toThrow("requires the campaign owner");
    }
    expect(() => repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-missing", sessionId: "session/missing",
    })).toThrow("campaign not found");
    repository.close();
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ["invalid actor", "invalid actor", { campaignId: "campaign-one", sessionId: "session/attached" }],
    ["invalid campaign", "local-owner", { campaignId: "invalid campaign", sessionId: "session/attached" }],
    ["empty session", "local-owner", { campaignId: "campaign-one", sessionId: "" }],
    ["unknown input", "local-owner", { campaignId: "campaign-one", sessionId: "session/attached", unknown: true }],
  ])("rejects %s before dependency consumption", (_label, actor, input) => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const before = snapshot();
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.detachCampaignSession(actor, input as DetachCampaignSessionInput)).toThrow();
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(snapshot()).toEqual(before);
  });

  it("rolls back when a delete trigger rejects the detach", () => {
    seed();
    const before = snapshot();
    const db = new DatabaseDriver(databasePath());
    db.exec(`CREATE TRIGGER reject_detachment BEFORE DELETE ON campaign_sessions
      BEGIN SELECT RAISE(ABORT, 'detachment rejected'); END;`);
    db.close();
    const repository = createRepository({ dataDir: dataDir() });

    expect(() => repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/attached",
    })).toThrow("detachment rejected");
    repository.close();
    expect(snapshot()).toEqual(before);
  });

  it("waits for a competing committed detach and returns null", async () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const writer = await startLockedWrite(databasePath(), [{
      sql: "DELETE FROM campaign_sessions WHERE campaign_id = ? AND session_id = ?",
      params: ["campaign-one", "session/attached"],
    }]);
    const started = Date.now();
    expect(repository.detachCampaignSession("local-owner", {
      campaignId: "campaign-one", sessionId: "session/attached",
    })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    await writer.done;
    repository.close();
  });

  it("rejects nested and closed calls before validation or dependencies", () => {
    seed();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });

    expect(() => repository.transaction(() => repository.detachCampaignSession("invalid actor", {
      campaignId: "invalid campaign", sessionId: "",
    }))).toThrow("campaign session detachment cannot run inside a repository transaction");
    repository.close();
    expect(() => repository.detachCampaignSession("invalid actor", {
      campaignId: "invalid campaign", sessionId: "",
    })).toThrow("repository is closed");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
  });
});
