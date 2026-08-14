import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository, type RepositoryUnitOfWork } from "../src/repo/index.js";
import { createCorruptionTestRepository, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const campaignA = "membership-campaign-a";
const campaignB = "membership-campaign-b";
const ownerA = "membership-owner-a";
const ownerB = "membership-owner-b";
const gm = "membership-A-gm";
const player = "membership-z-player";
const observer = "membership-observer";
const applicationOwner = "membership-app-owner";

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
    for (const id of [ownerA, ownerB, gm, player, observer, applicationOwner]) {
      db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(id, id);
    }
    db.prepare("UPDATE application_owner SET principal_id = ? WHERE singleton = 1").run(applicationOwner);

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
    const insertMembership = db.prepare(`INSERT INTO campaign_memberships
      (campaign_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)`);
    // These are deliberately inserted opposite to the required tie-break order.
    insertMembership.run(campaignA, player, "player", "2031-01-02T00:00:00.000Z");
    insertMembership.run(campaignA, gm, "gm", "2031-01-02T00:00:00.000Z");
    insertMembership.run(campaignA, observer, "observer", "2031-01-03T00:00:00.000Z");
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

describe("campaign membership queries", () => {
  it("lists every strict role by creation time then binary principal ID and gets exact targets", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const memberships = repository.listCampaignMemberships(ownerA, campaignA);
    expect(memberships).toEqual([
      { campaignId: campaignA, principalId: ownerA, role: "owner", createdAt: "2031-01-01T00:00:00.000Z" },
      { campaignId: campaignA, principalId: gm, role: "gm", createdAt: "2031-01-02T00:00:00.000Z" },
      { campaignId: campaignA, principalId: player, role: "player", createdAt: "2031-01-02T00:00:00.000Z" },
      { campaignId: campaignA, principalId: observer, role: "observer", createdAt: "2031-01-03T00:00:00.000Z" },
    ]);
    for (const membership of memberships) {
      expect(repository.getCampaignMembership(ownerA, campaignA, membership.principalId)).toEqual(membership);
      expect(Object.keys(membership)).toEqual(["campaignId", "principalId", "role", "createdAt"]);
    }
    repository.close();
  });

  it("returns empty or null for absence and every non-owner authority", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    for (const actor of [gm, player, observer, applicationOwner, "missing-principal"]) {
      expect(repository.listCampaignMemberships(actor, campaignA)).toEqual([]);
      expect(repository.getCampaignMembership(actor, campaignA, ownerA)).toBeNull();
    }
    expect(repository.listCampaignMemberships(ownerA, "missing-campaign")).toEqual([]);
    expect(repository.getCampaignMembership(ownerA, campaignA, "missing-target")).toBeNull();
    expect(repository.getCampaignMembership(ownerA, campaignB, ownerB)).toBeNull();
    repository.close();
  });

  it.each([
    ["owner disagreement", `UPDATE campaigns SET owner_principal_id = '${gm}' WHERE id = '${campaignA}'`],
    ["non-owner actor row", `UPDATE campaign_memberships SET role = 'observer'
      WHERE campaign_id = '${campaignA}' AND principal_id = '${ownerA}'`],
    ["missing actor principal", `DELETE FROM principals WHERE id = '${ownerA}'`],
    ["more than one owner", `DROP INDEX idx_campaign_memberships_one_owner;
      UPDATE campaign_memberships SET role = 'owner'
      WHERE campaign_id = '${campaignA}' AND principal_id = '${gm}'`],
  ])("denies a structurally invalid campaign-owner authority: %s", (_name, mutation) => {
    seed();
    corrupt(mutation);
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });
    expect(repository.listCampaignMemberships(ownerA, campaignA)).toEqual([]);
    expect(repository.getCampaignMembership(ownerA, campaignA, player)).toBeNull();
    repository.close();
  });

  it("uses exactly one explicit-column membership-rooted SQL statement for each operation", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      expect(repository.listCampaignMemberships(ownerA, campaignA)).toHaveLength(4);
      expect(prepare).toHaveBeenCalledOnce();
      const listSql = prepare.mock.calls[0]?.[0] as string;
      expect(listSql).toMatch(/^SELECT\b/);
      expect(listSql).toMatch(/FROM campaign_memberships actor_membership/);
      expect(listSql).toContain("target_membership.principal_id COLLATE BINARY ASC");
      expect(listSql).not.toMatch(/SELECT\s+\*/i);
      expect(transaction).not.toHaveBeenCalled();

      prepare.mockClear();
      expect(repository.getCampaignMembership(ownerA, campaignA, player)?.role).toBe("player");
      expect(prepare).toHaveBeenCalledOnce();
      const getSql = prepare.mock.calls[0]?.[0] as string;
      expect(getSql).toMatch(/^SELECT\b/);
      expect(getSql).toMatch(/FROM campaign_memberships actor_membership/);
      expect(getSql).toContain("AND target_membership.principal_id = ?");
      expect(getSql).not.toMatch(/SELECT\s+\*/i);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
      repository.close();
    }
  });

  it("validates inputs before querying and consumes no clock, ID, RNG, or writes", () => {
    seed();
    const beforeDb = new DatabaseDriver(databasePath(), { readonly: true });
    const before = beforeDb.prepare(`SELECT campaign_id, principal_id, role, created_at
      FROM campaign_memberships ORDER BY campaign_id, principal_id`).all();
    beforeDb.close();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn(() => 0);
    const repository = createRepository({
      dataDir: dataDir(), clock: { now }, ids: { nextId }, rng: { integer },
    });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    expect(() => repository.listCampaignMemberships("bad actor", campaignA)).toThrow();
    expect(() => repository.listCampaignMemberships(ownerA, "bad campaign")).toThrow();
    expect(() => repository.getCampaignMembership(ownerA, campaignA, "bad target")).toThrow();
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    expect(repository.listCampaignMemberships(ownerA, campaignA)).toHaveLength(4);
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    repository.close();
    const afterDb = new DatabaseDriver(databasePath(), { readonly: true });
    const after = afterDb.prepare(`SELECT campaign_id, principal_id, role, created_at
      FROM campaign_memberships ORDER BY campaign_id, principal_id`).all();
    afterDb.close();
    expect(after).toEqual(before);
  });

  it("supports active units of work and gives lifecycle guards precedence over validation", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unitOfWork) => {
      expired = unitOfWork;
      expect(unitOfWork.listCampaignMemberships(ownerA, campaignA)).toHaveLength(4);
      expect(unitOfWork.getCampaignMembership(ownerA, campaignA, observer)?.role).toBe("observer");
    });
    expect(() => expired!.listCampaignMemberships("bad actor", "bad campaign"))
      .toThrow("transaction unit of work is no longer active");
    expect(() => expired!.getCampaignMembership("bad actor", "bad campaign", "bad target"))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
    expect(() => repository.listCampaignMemberships("bad actor", "bad campaign"))
      .toThrow("repository is closed");
    expect(() => repository.getCampaignMembership("bad actor", "bad campaign", "bad target"))
      .toThrow("repository is closed");
  });

  it.each([
    ["unknown role", `UPDATE campaign_memberships SET role = 'admin'
      WHERE campaign_id = '${campaignA}' AND principal_id = '${player}'`],
    ["malformed timestamp", `UPDATE campaign_memberships SET created_at = 'not-a-time'
      WHERE campaign_id = '${campaignA}' AND principal_id = '${player}'`],
    ["malformed principal ID", `INSERT INTO principals (id, display_name, is_local)
        VALUES ('bad principal', 'Bad principal', 0);
      UPDATE campaign_memberships SET principal_id = 'bad principal'
      WHERE campaign_id = '${campaignA}' AND principal_id = '${player}'`],
    ["missing target principal", `DELETE FROM principals WHERE id = '${player}'`],
  ])("fails loudly for authorized selected %s while masking outsiders", (_name, mutation) => {
    seed();
    corrupt(mutation);
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });
    expect(() => repository.listCampaignMemberships(ownerA, campaignA))
      .toThrow("campaign membership is malformed");
    expect(repository.listCampaignMemberships(applicationOwner, campaignA)).toEqual([]);
    expect(repository.getCampaignMembership(applicationOwner, campaignA, player)).toBeNull();
    repository.close();
  });

  it("rejects a malformed owner membership before returning another exact target", () => {
    seed();
    corrupt(`UPDATE campaign_memberships SET created_at = 'invalid-owner-time'
      WHERE campaign_id = '${campaignA}' AND principal_id = '${ownerA}'`);
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });
    expect(() => repository.getCampaignMembership(ownerA, campaignA, player))
      .toThrow("campaign membership is malformed");
    expect(repository.getCampaignMembership(applicationOwner, campaignA, player)).toBeNull();
    repository.close();
  });

  it("makes exact selected get corruption loud without importing cross-campaign corruption", () => {
    seed();
    corrupt(`UPDATE campaign_memberships SET created_at = 'invalid'
      WHERE campaign_id = '${campaignB}' AND principal_id = '${ownerB}'`);
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });
    expect(repository.listCampaignMemberships(ownerA, campaignA)).toHaveLength(4);
    expect(repository.getCampaignMembership(ownerA, campaignA, ownerA)?.role).toBe("owner");
    expect(() => repository.getCampaignMembership(ownerB, campaignB, ownerB))
      .toThrow("campaign membership is malformed");
    expect(repository.listCampaignMemberships(ownerA, campaignB)).toEqual([]);
    expect(repository.getCampaignMembership(ownerA, campaignB, ownerB)).toBeNull();
    repository.close();
  });
});
