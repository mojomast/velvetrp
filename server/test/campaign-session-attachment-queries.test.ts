import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository, type RepositoryUnitOfWork } from "../src/repo/index.js";
import { deleteCampaignForCorruptionTest, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const campaignA = "attachment-read-campaign-a";
const campaignB = "attachment-read-campaign-b";
const ownerA = "attachment-read-owner-a";
const ownerB = "attachment-read-owner-b";
const gm = "attachment-read-gm";
const applicationOwner = "attachment-read-app-owner";
const firstSession = "session/A opaque";
const stoppedSession = "session/z stopped";
const laterSession = " session/later ";
const otherSession = "session/other-campaign";

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
  db.transaction(() => {
    for (const id of [ownerA, ownerB, gm, applicationOwner]) {
      db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(id, id);
    }
    db.prepare("UPDATE application_owner SET principal_id = ? WHERE singleton = 1").run(applicationOwner);
    db.prepare(`INSERT INTO characters VALUES
      ('attachment-read-character', 'Private character', 30, 'secret archetype',
       'private boundaries', 1, 0, '2031-01-01T00:00:00.000Z')`).run();

    const insertSession = db.prepare(`INSERT INTO sessions
      (id, character_id, title, state, preset_id, active_leaf_id, created_at, stopped_at, stop_reason)
      VALUES (?, 'attachment-read-character', ?, ?, 'private-preset', NULL,
        '2031-01-01T00:00:00.000Z', ?, ?)`);
    for (const [sessionId, state, stoppedAt, reason] of [
      [firstSession, "active", null, null],
      [stoppedSession, "closed", "2031-01-04T00:00:00.000Z", "private stop reason"],
      [laterSession, "setup", null, null],
      [otherSession, "active", null, null],
    ] as const) {
      insertSession.run(sessionId, `Private title ${sessionId}`, state, stoppedAt, reason);
      db.prepare("INSERT INTO session_characters VALUES (?, 'attachment-read-character', 0)").run(sessionId);
    }

    const insertCampaign = db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, '2031-01-01T00:00:00.000Z', '2031-01-01T00:00:00.000Z')`);
    const insertTimeline = db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
      VALUES (?, ?, '2031-01-01T00:00:00.000Z')`);
    for (const [campaignId, ownerId] of [[campaignA, ownerA], [campaignB, ownerB]] as const) {
      insertCampaign.run(campaignId, campaignId, `timeline-${campaignId}`, ownerId);
      insertTimeline.run(`timeline-${campaignId}`, campaignId);
      db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
        VALUES (?, ?, 'owner', '2031-01-01T00:00:00.000Z')`).run(campaignId, ownerId);
    }
    for (const role of ["gm", "player", "observer"] as const) {
      const principalId = role === "gm" ? gm : `attachment-read-${role}`;
      if (role !== "gm") {
        db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)")
          .run(principalId, principalId);
      }
      db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
        VALUES (?, ?, ?, '2031-01-01T00:00:00.000Z')`).run(campaignA, principalId, role);
    }

    const insertAttachment = db.prepare(`INSERT INTO campaign_sessions
      (session_id, campaign_id, attached_at) VALUES (?, ?, ?)`);
    // Deliberately reverse the binary session-ID tie-break order.
    insertAttachment.run(stoppedSession, campaignA, "2031-01-02T00:00:00.000Z");
    insertAttachment.run(firstSession, campaignA, "2031-01-02T00:00:00.000Z");
    insertAttachment.run(laterSession, campaignA, "2031-01-03T00:00:00.000Z");
    insertAttachment.run(otherSession, campaignB, "2031-01-01T00:00:00.000Z");
  })();
  db.close();
}

function corrupt(sql: string): void {
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = OFF");
  db.pragma("ignore_check_constraints = ON");
  db.exec(sql);
  db.close();
}

describe("campaign session attachment queries", () => {
  it("lists metadata for active and stopped sessions by attachment time then binary opaque ID", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const attachments = repository.listCampaignSessionAttachments(ownerA, campaignA);
    expect(attachments).toEqual([
      { campaignId: campaignA, sessionId: firstSession, attachedAt: "2031-01-02T00:00:00.000Z" },
      { campaignId: campaignA, sessionId: stoppedSession, attachedAt: "2031-01-02T00:00:00.000Z" },
      { campaignId: campaignA, sessionId: laterSession, attachedAt: "2031-01-03T00:00:00.000Z" },
    ]);
    for (const attachment of attachments) {
      expect(Object.keys(attachment)).toEqual(["campaignId", "sessionId", "attachedAt"]);
    }
    repository.close();
  });

  it("gets an exact opaque legacy ID, including spaces, without resource-ID normalization", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    expect(repository.getCampaignSessionAttachment(ownerA, campaignA, laterSession)).toEqual({
      campaignId: campaignA,
      sessionId: laterSession,
      attachedAt: "2031-01-03T00:00:00.000Z",
    });
    expect(repository.getCampaignSessionAttachment(ownerA, campaignA, laterSession.trim())).toBeNull();
    expect(repository.getCampaignSessionAttachment(ownerA, campaignA, stoppedSession)?.sessionId).toBe(stoppedSession);
    expect(repository.getCampaignSessionAttachment(ownerA, campaignA, "session/missing")).toBeNull();
    repository.close();
  });

  it("returns empty or null to every non-owner authority, outsiders, and cross-campaign callers", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    for (const actor of [
      gm,
      "attachment-read-player",
      "attachment-read-observer",
      applicationOwner,
      "missing-principal",
    ]) {
      expect(repository.listCampaignSessionAttachments(actor, campaignA)).toEqual([]);
      expect(repository.getCampaignSessionAttachment(actor, campaignA, firstSession)).toBeNull();
    }
    expect(repository.listCampaignSessionAttachments(ownerA, "missing-campaign")).toEqual([]);
    expect(repository.listCampaignSessionAttachments(ownerA, campaignB)).toEqual([]);
    expect(repository.getCampaignSessionAttachment(ownerA, campaignB, otherSession)).toBeNull();
    expect(repository.getCampaignSessionAttachment(ownerA, campaignA, otherSession)).toBeNull();
    repository.close();
  });

  it.each([
    ["owner disagreement", `UPDATE campaigns SET owner_principal_id = '${gm}' WHERE id = '${campaignA}'`],
    ["non-owner actor membership", `UPDATE campaign_memberships SET role = 'observer'
      WHERE campaign_id = '${campaignA}' AND principal_id = '${ownerA}'`],
    ["missing actor principal", `DELETE FROM principals WHERE id = '${ownerA}'`],
    ["duplicate owner", `DROP INDEX idx_campaign_memberships_one_owner;
      UPDATE campaign_memberships SET role = 'owner'
      WHERE campaign_id = '${campaignA}' AND principal_id = '${gm}'`],
  ])("denies invalid campaign-owner authority: %s", (_label, mutation) => {
    seed();
    corrupt(mutation);
    const repository = createRepository({ dataDir: dataDir() });
    expect(repository.listCampaignSessionAttachments(ownerA, campaignA)).toEqual([]);
    expect(repository.getCampaignSessionAttachment(ownerA, campaignA, firstSession)).toBeNull();
    repository.close();
  });

  it.each([
    ["malformed timestamp", `UPDATE campaign_sessions SET attached_at = 'invalid'
      WHERE session_id = '${firstSession}'`],
    ["orphaned session parent", `DELETE FROM sessions WHERE id = '${firstSession}'`],
  ])("fails loudly for an authorized selected %s but masks outsiders", (_label, mutation) => {
    seed();
    corrupt(mutation);
    const repository = createRepository({ dataDir: dataDir() });
    expect(() => repository.listCampaignSessionAttachments(ownerA, campaignA))
      .toThrow("campaign session attachment is malformed");
    expect(() => repository.getCampaignSessionAttachment(ownerA, campaignA, firstSession))
      .toThrow("campaign session attachment is malformed");
    expect(repository.listCampaignSessionAttachments(applicationOwner, campaignA)).toEqual([]);
    expect(repository.getCampaignSessionAttachment(applicationOwner, campaignA, firstSession)).toBeNull();
    expect(repository.listCampaignSessionAttachments(ownerB, campaignA)).toEqual([]);
    repository.close();
  });

  it("rejects malformed owner membership for selected reads while preserving outsider masking", () => {
    seed();
    corrupt(`UPDATE campaign_memberships SET created_at = 'invalid-owner-time'
      WHERE campaign_id = '${campaignA}' AND principal_id = '${ownerA}'`);
    const repository = createRepository({ dataDir: dataDir() });
    expect(() => repository.listCampaignSessionAttachments(ownerA, campaignA))
      .toThrow("campaign session attachment is malformed");
    expect(() => repository.getCampaignSessionAttachment(ownerA, campaignA, firstSession))
      .toThrow("campaign session attachment is malformed");
    expect(repository.listCampaignSessionAttachments(applicationOwner, campaignA)).toEqual([]);
    repository.close();
  });

  it("does not import malformed attachments from another campaign", () => {
    seed();
    corrupt(`UPDATE campaign_sessions SET attached_at = 'invalid'
      WHERE session_id = '${otherSession}'`);
    const repository = createRepository({ dataDir: dataDir() });
    expect(repository.listCampaignSessionAttachments(ownerA, campaignA)).toHaveLength(3);
    expect(repository.getCampaignSessionAttachment(ownerA, campaignA, firstSession)?.sessionId).toBe(firstSession);
    expect(() => repository.listCampaignSessionAttachments(ownerB, campaignB))
      .toThrow("campaign session attachment is malformed");
    expect(repository.listCampaignSessionAttachments(ownerA, campaignB)).toEqual([]);
    repository.close();
  });

  it("reflects the existing session-deletion cascade without writing itself", () => {
    seed();
    const db = new DatabaseDriver(databasePath());
    db.pragma("foreign_keys = ON");
    db.prepare("DELETE FROM sessions WHERE id = ?").run(stoppedSession);
    db.close();
    const repository = createRepository({ dataDir: dataDir() });
    expect(repository.getCampaignSessionAttachment(ownerA, campaignA, stoppedSession)).toBeNull();
    expect(repository.listCampaignSessionAttachments(ownerA, campaignA).map(({ sessionId }) => sessionId))
      .toEqual([firstSession, laterSession]);
    repository.close();
  });

  it("reflects campaign-deletion detach cascading while preserving legacy sessions", () => {
    seed();
    const db = new DatabaseDriver(databasePath());
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      deleteCampaignForCorruptionTest(db,campaignA);db.prepare("DELETE FROM campaigns WHERE id = ?").run(campaignA);
    }).immediate();
    expect(db.prepare("SELECT id FROM sessions WHERE id IN (?, ?, ?) ORDER BY id COLLATE BINARY")
      .all(firstSession, stoppedSession, laterSession)).toEqual([
        { id: laterSession }, { id: firstSession }, { id: stoppedSession },
      ]);
    expect(db.prepare("SELECT campaign_id, session_id FROM campaign_sessions").all()).toEqual([
      { campaign_id: campaignB, session_id: otherSession },
    ]);
    db.close();
    const repository = createRepository({ dataDir: dataDir() });
    expect(repository.listCampaignSessionAttachments(ownerA, campaignA)).toEqual([]);
    expect(repository.getCampaignSessionAttachment(ownerA, campaignA, firstSession)).toBeNull();
    repository.close();
  });

  it("uses one explicit-column membership-rooted statement and selects no session details", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      expect(repository.listCampaignSessionAttachments(ownerA, campaignA)).toHaveLength(3);
      expect(prepare).toHaveBeenCalledOnce();
      const listSql = prepare.mock.calls[0]?.[0] as string;
      expect(listSql).toMatch(/^SELECT\b/);
      expect(listSql).toContain("FROM campaign_memberships actor_membership");
      expect(listSql).toContain("attachment.session_id COLLATE BINARY ASC");
      expect(listSql).not.toMatch(/SELECT\s+\*/i);
      for (const privateColumn of [
        "title", "character_id", "preset_id", "target_session.state", "stopped_at", "stop_reason",
        "session_characters", "messages", "session_context",
      ]) {
        expect(listSql).not.toContain(privateColumn);
      }
      expect(transaction).not.toHaveBeenCalled();

      prepare.mockClear();
      expect(repository.getCampaignSessionAttachment(ownerA, campaignA, firstSession)?.sessionId).toBe(firstSession);
      expect(prepare).toHaveBeenCalledOnce();
      const getSql = prepare.mock.calls[0]?.[0] as string;
      expect(getSql).toContain("FROM campaign_memberships actor_membership");
      expect(getSql).toContain("AND attachment.session_id = ?");
      expect(getSql).not.toMatch(/SELECT\s+\*/i);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
      repository.close();
    }
  });

  it("validates before querying and consumes no clock, ID, RNG, writes, or explicit transaction", () => {
    seed();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn(() => 0);
    const repository = createRepository({
      dataDir: dataDir(), clock: { now }, ids: { nextId }, rng: { integer },
    });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    expect(() => repository.listCampaignSessionAttachments("bad actor", campaignA)).toThrow();
    expect(() => repository.listCampaignSessionAttachments(ownerA, "bad campaign")).toThrow();
    expect(() => repository.getCampaignSessionAttachment(ownerA, campaignA, "")).toThrow();
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    expect(repository.listCampaignSessionAttachments(ownerA, campaignA)).toHaveLength(3);
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    repository.close();
  });

  it("supports factory and active unit-of-work reads with lifecycle guard precedence", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    expect(repository.getCampaignSessionAttachment(ownerA, campaignA, firstSession)?.sessionId).toBe(firstSession);
    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unitOfWork) => {
      expired = unitOfWork;
      expect(unitOfWork.listCampaignSessionAttachments(ownerA, campaignA)).toHaveLength(3);
      expect(unitOfWork.getCampaignSessionAttachment(ownerA, campaignA, stoppedSession)?.sessionId)
        .toBe(stoppedSession);
    });
    expect(() => expired!.listCampaignSessionAttachments("bad actor", "bad campaign"))
      .toThrow("transaction unit of work is no longer active");
    expect(() => expired!.getCampaignSessionAttachment("bad actor", "bad campaign", ""))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
    expect(() => repository.listCampaignSessionAttachments("bad actor", "bad campaign"))
      .toThrow("repository is closed");
    expect(() => repository.getCampaignSessionAttachment("bad actor", "bad campaign", ""))
      .toThrow("repository is closed");
  });
});
