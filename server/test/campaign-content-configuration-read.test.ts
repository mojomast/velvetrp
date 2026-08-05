import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository, type RepositoryUnitOfWork } from "../src/repo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const campaignId = "configuration-read";
const emptyCampaignId = "configuration-empty";
const unconfiguredCampaignId = "configuration-unconfigured";
const applicationOwnerId = "application-owner-read";
const otherCampaignOnlyId = "other-campaign-only";
const members = ["read-owner", "read-gm", "read-player", "read-observer"] as const;

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function dbPath(): string {
  return path.join(dataDir(), "velvet.sqlite");
}

function seed(): void {
  const repository = createRepository({ dataDir: dataDir() });
  repository.close();
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)")
      .run(applicationOwnerId, "Application owner");
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)")
      .run(otherCampaignOnlyId, "Other campaign only");
    for (const member of members) {
      db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(member, member);
    }
    db.prepare("UPDATE application_owner SET principal_id = ? WHERE singleton = 1").run(applicationOwnerId);
    db.prepare(`INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags)
      VALUES ('profile-read', 'Read profile', 'Strict selected profile', '["tag","tag"]')`).run();
    const insertPack = db.prepare(`INSERT INTO rpg_content_packs
      (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
      VALUES (?, ?, 'profile-read', ?, 'Strict exact pack', '[]', 1)`);
    for (const [packId, packVersion] of [["pack-z", "2"], ["pack-A", "10"], ["pack-Aa", "1"]] as const) {
      insertPack.run(packId, packVersion, `${packId} ${packVersion}`);
    }

    const at = "2032-03-04T05:06:07.008Z";
    const insertCampaign = db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, ?, ?, 'read-owner', ?, ?)`);
    const insertTimeline = db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES (?, ?, ?)");
    for (const id of [campaignId, emptyCampaignId, unconfiguredCampaignId]) {
      insertCampaign.run(id, id, `timeline-${id}`, at, at);
      insertTimeline.run(`timeline-${id}`, id, at);
      for (const [index, member] of members.entries()) {
        const role = ["owner", "gm", "player", "observer"][index];
        db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
          VALUES (?, ?, ?, ?)`).run(id, member, role, at);
      }
    }
    for (const id of [campaignId, emptyCampaignId]) {
      db.prepare(`INSERT INTO campaign_rules_profiles (campaign_id, rules_profile_id)
        VALUES (?, 'profile-read')`).run(id);
    }
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES (?, ?, 'observer', ?)`).run(unconfiguredCampaignId, otherCampaignOnlyId, at);
    // Insert opposite to the required binary/code-unit projection order.
    const insertPin = db.prepare(`INSERT INTO campaign_content_packs
      (campaign_id, pack_id, pack_version, rules_profile_id)
      VALUES (?, ?, ?, 'profile-read')`);
    insertPin.run(campaignId, "pack-z", "2");
    insertPin.run(campaignId, "pack-Aa", "1");
    insertPin.run(campaignId, "pack-A", "10");
  })();
  db.close();
}

function read(actorId = "read-owner", id = campaignId) {
  const repository = createRepository({ dataDir: dataDir() });
  try {
    return repository.getCampaignContentConfiguration(actorId, id);
  } finally {
    repository.close();
  }
}

function corrupt(sql: string): void {
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = OFF");
  db.pragma("ignore_check_constraints = ON");
  db.exec(sql);
  db.close();
}

describe("getCampaignContentConfiguration", () => {
  it("returns the same strict deterministic configuration to every intact campaign role", () => {
    seed();
    const expected = {
      campaignId,
      rulesProfileId: "profile-read",
      contentPacks: [
        { packId: "pack-A", packVersion: "10" },
        { packId: "pack-Aa", packVersion: "1" },
        { packId: "pack-z", packVersion: "2" },
      ],
    };
    for (const member of members) expect(read(member)).toEqual(expected);
  });

  it("distinguishes configured zero-pack campaigns from unconfigured, missing, and denied campaigns", () => {
    seed();
    expect(read("read-player", emptyCampaignId)).toEqual({
      campaignId: emptyCampaignId,
      rulesProfileId: "profile-read",
      contentPacks: [],
    });
    expect(read("read-observer", unconfiguredCampaignId)).toBeNull();
    expect(read("missing-principal")).toBeNull();
    expect(read("read-owner", "missing-campaign")).toBeNull();
    expect(read(applicationOwnerId)).toBeNull();
  });

  it("requires exact campaign-owner agreement while preserving the other roles", () => {
    seed();
    corrupt(`PRAGMA foreign_keys = OFF;
      UPDATE campaigns SET owner_principal_id = 'read-gm' WHERE id = '${campaignId}';`);
    expect(read("read-owner")).toBeNull();
    for (const member of ["read-gm", "read-player", "read-observer"]) {
      expect(read(member)?.campaignId).toBe(campaignId);
    }
  });

  it("uses one explicit-column membership-rooted statement and one implicit statement snapshot", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      expect(repository.getCampaignContentConfiguration("read-owner", campaignId)?.contentPacks).toHaveLength(3);
      expect(prepare).toHaveBeenCalledOnce();
      const sql = prepare.mock.calls[0]?.[0] as string;
      expect(sql).toMatch(/^SELECT\b/);
      expect(sql).toMatch(/FROM campaign_memberships membership/);
      expect(sql).toMatch(/membership\.campaign_id AS actor_campaign_id/);
      expect(sql).toMatch(/membership\.principal_id AS actor_principal_id/);
      expect(sql).toMatch(/membership\.role AS actor_role/);
      expect(sql).toMatch(/membership\.created_at AS actor_created_at/);
      expect(sql).toMatch(/COLLATE BINARY/);
      expect(sql).not.toMatch(/SELECT\s+\*/i);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
      repository.close();
    }
  });

  it("consumes no clock, ID, or RNG dependency and performs no writes", () => {
    seed();
    const beforeDb = new DatabaseDriver(dbPath(), { readonly: true });
    const before = beforeDb.prepare("SELECT total_changes() AS changes").get() as { changes: number };
    beforeDb.close();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const integer = vi.fn(() => 0);
    const repository = createRepository({
      dataDir: dataDir(),
      clock: { now },
      ids: { nextId },
      rng: { integer },
    });
    expect(repository.getCampaignContentConfiguration("read-player", campaignId)).not.toBeNull();
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    expect(integer).not.toHaveBeenCalled();
    repository.close();
    const afterDb = new DatabaseDriver(dbPath(), { readonly: true });
    const after = afterDb.prepare("SELECT total_changes() AS changes").get() as { changes: number };
    afterDb.close();
    expect(after).toEqual(before);
  });

  it("is available on active units of work and enforces factory and UoW lifecycle guards before validation", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const factory = repository.getCampaignContentConfiguration("read-gm", campaignId);
    let expired: RepositoryUnitOfWork | undefined;
    repository.transaction((unitOfWork) => {
      expired = unitOfWork;
      expect(unitOfWork.getCampaignContentConfiguration("read-gm", campaignId)).toEqual(factory);
    });
    expect(() => expired!.getCampaignContentConfiguration("bad actor", "bad campaign"))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
    expect(() => repository.getCampaignContentConfiguration("bad actor", "bad campaign"))
      .toThrow("repository is closed");
  });

  it("strictly validates inputs before querying an open repository", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    try {
      expect(() => repository.getCampaignContentConfiguration("bad actor", campaignId)).toThrow();
      expect(() => repository.getCampaignContentConfiguration("read-owner", "bad campaign")).toThrow();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      repository.close();
    }
  });

  it.each(members)("fails loudly for a malformed %s membership timestamp without outsider disclosure", (member) => {
    seed();
    corrupt(`UPDATE campaign_memberships SET created_at = 'not-a-canonical-timestamp'
      WHERE campaign_id = '${campaignId}' AND principal_id = '${member}'`);
    expect(() => read(member)).toThrow("campaign content configuration is malformed");
    expect(read(applicationOwnerId)).toBeNull();
    expect(read(otherCampaignOnlyId)).toBeNull();
    expect(read(member, emptyCampaignId)?.campaignId).toBe(emptyCampaignId);
  });

  it.each(members)("denies a malformed %s authorizing role and keeps cross-campaign membership masked", (member) => {
    seed();
    corrupt(`UPDATE campaign_memberships SET role = 'future-role'
      WHERE campaign_id = '${campaignId}' AND principal_id = '${member}'`);
    expect(read(member)).toBeNull();
    expect(read(otherCampaignOnlyId)).toBeNull();
    expect(read(member, emptyCampaignId)?.campaignId).toBe(emptyCampaignId);
  });

  it.each([
    ["missing selected profile", `DELETE FROM rpg_rules_profiles WHERE rules_profile_id = 'profile-read';`],
    ["malformed selected profile", `DROP TRIGGER rpg_rules_profiles_tags_update;
      DROP TRIGGER rpg_rules_profiles_prevent_referenced_update;
      UPDATE rpg_rules_profiles SET tags = '[1]' WHERE rules_profile_id = 'profile-read';`],
    ["missing exact pack", `DROP TRIGGER rpg_content_packs_prevent_delete;
      DELETE FROM rpg_content_packs WHERE pack_id = 'pack-A';`],
    ["unsealed exact pack", `DROP TRIGGER rpg_content_packs_prevent_update;
      UPDATE rpg_content_packs SET sealed = 0 WHERE pack_id = 'pack-A';`],
    ["profile-incompatible pin", `DROP TRIGGER campaign_content_packs_require_sealed_update;
      UPDATE campaign_content_packs SET rules_profile_id = 'other-profile'
      WHERE campaign_id = '${campaignId}' AND pack_id = 'pack-A';`],
    ["malformed exact identifiers", `DROP TRIGGER rpg_content_packs_prevent_update;
      DROP TRIGGER campaign_content_packs_require_sealed_update;
      UPDATE rpg_content_packs SET pack_id = 'bad pack', pack_version = ' bad'
      WHERE pack_id = 'pack-A';
      UPDATE campaign_content_packs SET pack_id = 'bad pack', pack_version = ' bad'
      WHERE campaign_id = '${campaignId}' AND pack_id = 'pack-A';`],
  ])("fails loudly for authorized %s corruption while masking it from outsiders", (_name, mutation) => {
    seed();
    if (mutation.includes("other-profile")) {
      corrupt(`INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags)
        VALUES ('other-profile', 'Other', 'Other profile', '[]');`);
    }
    corrupt(mutation);
    expect(() => read("read-observer")).toThrow("campaign content configuration is malformed");
    expect(read(applicationOwnerId)).toBeNull();
    expect(read("missing-principal")).toBeNull();
    expect(read(otherCampaignOnlyId)).toBeNull();
  });

  it.each([
    ["pins without a selected profile", `DELETE FROM campaign_rules_profiles
      WHERE campaign_id = '${campaignId}'`],
    ["a partial-null pin", `ALTER TABLE campaign_content_packs RENAME TO campaign_content_packs_strict;
      CREATE TABLE campaign_content_packs (
        campaign_id TEXT, pack_id TEXT, pack_version TEXT, rules_profile_id TEXT
      );
      INSERT INTO campaign_content_packs SELECT * FROM campaign_content_packs_strict;
      UPDATE campaign_content_packs SET pack_version = NULL
        WHERE campaign_id = '${campaignId}' AND pack_id = 'pack-A'`],
    ["duplicate selected-profile rows", `ALTER TABLE campaign_rules_profiles RENAME TO campaign_rules_profiles_strict;
      CREATE TABLE campaign_rules_profiles (campaign_id TEXT, rules_profile_id TEXT);
      INSERT INTO campaign_rules_profiles SELECT * FROM campaign_rules_profiles_strict;
      INSERT INTO campaign_rules_profiles VALUES ('${campaignId}', 'profile-read')`],
    ["malformed pack metadata", `DROP TRIGGER rpg_content_packs_tags_update;
      DROP TRIGGER rpg_content_packs_prevent_update;
      UPDATE rpg_content_packs SET tags = '[1]' WHERE pack_id = 'pack-A'`],
    ["a pack whose own profile mismatches its pin", `INSERT INTO rpg_rules_profiles
        VALUES ('other-profile', 'Other', 'Other', '[]');
      DROP TRIGGER rpg_content_packs_prevent_update;
      UPDATE rpg_content_packs SET rules_profile_id = 'other-profile' WHERE pack_id = 'pack-A'`],
  ])("rejects independently corrupted content configuration with %s", (_name, mutation) => {
    seed();
    corrupt(mutation);
    for (const member of members) {
      expect(() => read(member)).toThrow("campaign content configuration is malformed");
    }
    expect(read(applicationOwnerId)).toBeNull();
    expect(read("missing-principal")).toBeNull();
    expect(read(otherCampaignOnlyId)).toBeNull();
  });

  it("rejects duplicate pack IDs and more than 64 pins from corrupted storage", () => {
    seed();
    corrupt(`ALTER TABLE campaign_content_packs RENAME TO campaign_content_packs_strict;
      CREATE TABLE campaign_content_packs (
        campaign_id TEXT, pack_id TEXT, pack_version TEXT, rules_profile_id TEXT
      );
      INSERT INTO campaign_content_packs SELECT * FROM campaign_content_packs_strict;
      INSERT INTO campaign_content_packs VALUES ('${campaignId}', 'pack-A', '10', 'profile-read');`);
    expect(() => read("read-owner")).toThrow("campaign content configuration is malformed");

    // Re-seed a separate clean database through the per-test fixture is unnecessary: remove
    // the duplicate, then create 65 complete exact packs and pins in the permissive table.
    corrupt(`DELETE FROM campaign_content_packs
      WHERE rowid = (SELECT MAX(rowid) FROM campaign_content_packs WHERE campaign_id = '${campaignId}' AND pack_id = 'pack-A');`);
    const db = new DatabaseDriver(dbPath());
    const insertPack = db.prepare(`INSERT INTO rpg_content_packs
      (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
      VALUES (?, '1', 'profile-read', ?, 'Overflow pack', '[]', 1)`);
    const insertPin = db.prepare(`INSERT INTO campaign_content_packs
      (campaign_id, pack_id, pack_version, rules_profile_id)
      VALUES (?, ?, '1', 'profile-read')`);
    for (let index = 0; index < 65; index += 1) {
      const packId = `overflow-${String(index).padStart(2, "0")}`;
      insertPack.run(packId, packId);
      insertPin.run(campaignId, packId);
    }
    db.close();
    expect(() => read("read-player")).toThrow("campaign content configuration is malformed");
    expect(read(applicationOwnerId)).toBeNull();
  });

  it("does not leak or import a corrupted configuration from another campaign", () => {
    seed();
    corrupt(`DROP TRIGGER rpg_content_packs_prevent_update;
      UPDATE rpg_content_packs SET sealed = 0 WHERE pack_id = 'pack-A';`);
    expect(() => read("read-owner", campaignId)).toThrow("campaign content configuration is malformed");
    expect(read("read-owner", emptyCampaignId)).toEqual({
      campaignId: emptyCampaignId,
      rulesProfileId: "profile-read",
      contentPacks: [],
    });
    expect(read("read-owner", unconfiguredCampaignId)).toBeNull();
  });
});
