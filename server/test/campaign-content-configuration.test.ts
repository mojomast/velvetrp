import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConfigureCampaignContentInput } from "../src/types.js";
import { createRepository } from "../src/repo/index.js";
import { createCorruptionTestRepository, useTmpDataDir } from "./helpers.js";
import { startLockedWrite } from "./lock-worker.js";

useTmpDataDir();

const ownerId = "campaign-owner";
const campaignId = "campaign-one";
const input: ConfigureCampaignContentInput = {
  rulesProfileId: "profile-main",
  contentPacks: [
    { packId: "pack-core", packVersion: "1.0.0" },
    { packId: "pack-extra", packVersion: "2.0.0" },
  ],
};

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function dbPath(dir = dataDir()): string {
  return path.join(dir, "velvet.sqlite");
}

function seed(dir = dataDir()): void {
  const initial = createRepository({ dataDir: dir });
  initial.close();
  const db = new DatabaseDriver(dbPath(dir));
  db.pragma("foreign_keys = ON");
  for (const id of [ownerId, "campaign-gm", "campaign-player", "app-owner", "nonmember"]) {
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(id, id);
  }
  db.prepare("UPDATE application_owner SET principal_id = 'app-owner' WHERE singleton = 1").run();
  db.transaction(() => {
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, 'Campaign', 'timeline-one', ?, '2030-01-01T00:00:00.000Z', '2030-01-02T00:00:00.000Z')`)
      .run(campaignId, ownerId);
    db.prepare(`INSERT INTO campaign_timelines (id, campaign_id, created_at)
      VALUES ('timeline-one', ?, '2030-01-01T00:00:00.000Z')`).run(campaignId);
    for (const [principalId, role] of [[ownerId, "owner"], ["campaign-gm", "gm"], ["campaign-player", "player"]]) {
      db.prepare(`INSERT INTO campaign_memberships
        VALUES (?, ?, ?, '2030-01-01T00:00:00.000Z')`).run(campaignId, principalId, role);
    }
    for (const profile of ["profile-main", "profile-other"]) {
      db.prepare("INSERT INTO rpg_rules_profiles VALUES (?, ?, 'Description', '[]')").run(profile, profile);
    }
    for (const [packId, version, profile, sealed] of [
      ["pack-core", "1.0.0", "profile-main", 1],
      ["pack-extra", "2.0.0", "profile-main", 1],
      ["pack-core", "2.0.0", "profile-main", 1],
      ["other-pack", "1.0.0", "profile-other", 1],
      ["unsealed-pack", "1.0.0", "profile-main", 0],
    ] as const) {
      db.prepare(`INSERT INTO rpg_content_packs
        (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
        VALUES (?, ?, ?, ?, 'Description', '[]', ?)`).run(packId, version, profile, packId, sealed);
    }
  }).immediate();
  db.close();
}

function snapshot(dir = dataDir()): Record<string, unknown> {
  const db = new DatabaseDriver(dbPath(dir), { readonly: true });
  const result = {
    campaign: db.prepare("SELECT * FROM campaigns WHERE id = ?").get(campaignId),
    profiles: db.prepare("SELECT * FROM campaign_rules_profiles ORDER BY rowid").all(),
    pins: db.prepare("SELECT * FROM campaign_content_packs ORDER BY rowid").all(),
  };
  db.close();
  return result;
}

describe("factory campaign content configuration", () => {
  it("selects an existing profile and exact sealed packs in supplied order without dependencies or timestamp changes", () => {
    seed();
    const before = snapshot().campaign;
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({ dataDir: dataDir(), clock: { now }, ids: { nextId } });

    expect(repository.configureCampaignContent(ownerId, campaignId, input)).toEqual({
      campaignId,
      ...input,
      contentPacks: [
        { packId: "pack-core", packVersion: "1.0.0" },
        { packId: "pack-extra", packVersion: "2.0.0" },
      ],
    });
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();

    const after = snapshot();
    expect(after.campaign).toEqual(before);
    expect(after.profiles).toEqual([{ campaign_id: campaignId, rules_profile_id: "profile-main" }]);
    expect(after.pins).toEqual(input.contentPacks.map((pack) => ({
      campaign_id: campaignId,
      pack_id: pack.packId,
      pack_version: pack.packVersion,
      rules_profile_id: "profile-main",
    })));
  });

  it("allows zero packs as a final configuration", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const empty = { rulesProfileId: "profile-main", contentPacks: [] };
    expect(repository.configureCampaignContent(ownerId, campaignId, empty)).toEqual({ campaignId, ...empty });
    expect(repository.configureCampaignContent(ownerId, campaignId, empty)).toEqual({ campaignId, ...empty });
    expect(() => repository.configureCampaignContent(ownerId, campaignId, input)).toThrow("conflicts");
    repository.close();
    expect(snapshot().pins).toEqual([]);
  });

  it("resolves campaigns and exact ownership before inspecting configuration or content", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const corrupt = new DatabaseDriver(dbPath());
    corrupt.pragma("foreign_keys = OFF");
    corrupt.exec("DROP TRIGGER campaign_content_packs_require_sealed_insert");
    corrupt.prepare("INSERT INTO campaign_content_packs VALUES (?, 'orphan', '1', 'missing')").run(campaignId);
    corrupt.close();

    expect(() => repository.configureCampaignContent("nonmember", "missing-campaign", input))
      .toThrow("campaign not found");
    for (const denied of ["campaign-gm", "campaign-player", "app-owner", "nonmember"]) {
      expect(() => repository.configureCampaignContent(denied, campaignId, input))
        .toThrow("requires the campaign owner");
    }
    expect(() => repository.configureCampaignContent(ownerId, campaignId, input)).toThrow("malformed");
    repository.close();
  });

  it("returns retries in canonical lexical order and conflicts on every different valid configuration", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    repository.configureCampaignContent(ownerId, campaignId, input);
    const reversed = { ...input, contentPacks: [...input.contentPacks].reverse() };
    expect(repository.configureCampaignContent(ownerId, campaignId, reversed)).toEqual({
      campaignId,
      ...input,
      contentPacks: [
        { packId: "pack-core", packVersion: "1.0.0" },
        { packId: "pack-extra", packVersion: "2.0.0" },
      ],
    });
    for (const conflict of [
      { ...input, rulesProfileId: "profile-other", contentPacks: [] },
      { ...input, contentPacks: input.contentPacks.slice(0, 1) },
      { ...input, contentPacks: [{ packId: "pack-core", packVersion: "2.0.0" }, input.contentPacks[1]!] },
    ]) {
      expect(() => repository.configureCampaignContent(ownerId, campaignId, conflict)).toThrow("conflicts");
    }
    repository.close();
    expect(snapshot().pins).toHaveLength(2);
  });

  it("uses deterministic code-unit ordering for valid mixed pack IDs", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    for (const packId of ["alpha", "Alpha", "_alpha"]) {
      db.prepare(`INSERT INTO rpg_content_packs
        (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
        VALUES (?, '1', 'profile-main', ?, 'Description', '[]', 1)`).run(packId, packId);
    }
    db.close();
    const repository = createRepository({ dataDir: dataDir() });
    const mixed = {
      rulesProfileId: "profile-main",
      contentPacks: ["alpha", "_alpha", "Alpha"].map((packId) => ({ packId, packVersion: "1" })),
    };
    expect(repository.configureCampaignContent(ownerId, campaignId, mixed).contentPacks.map((pack) => pack.packId))
      .toEqual(["Alpha", "_alpha", "alpha"]);
    repository.close();
  });

  it.each([
    ["missing profile", { rulesProfileId: "missing", contentPacks: [] }],
    ["missing pack", { rulesProfileId: "profile-main", contentPacks: [{ packId: "missing", packVersion: "1" }] }],
    ["wrong profile", { rulesProfileId: "profile-main", contentPacks: [{ packId: "other-pack", packVersion: "1.0.0" }] }],
    ["unsealed pack", { rulesProfileId: "profile-main", contentPacks: [{ packId: "unsealed-pack", packVersion: "1.0.0" }] }],
  ] satisfies Array<[string, ConfigureCampaignContentInput]>)("rejects an unavailable %s without writes", (_label, unavailable) => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    expect(() => repository.configureCampaignContent(ownerId, campaignId, unavailable)).toThrow("unavailable");
    repository.close();
    expect(snapshot().profiles).toEqual([]);
    expect(snapshot().pins).toEqual([]);
  });

  it.each(["pins-without-profile", "missing-profile", "mismatched-pin", "orphan-pin", "unsealed-pin", "invalid-id"])(
    "fails loudly and never repairs malformed existing state: %s",
    (malformation) => {
      seed();
      const repository = createRepository({ dataDir: dataDir() });
      const db = new DatabaseDriver(dbPath());
      db.pragma("foreign_keys = OFF");
      if (malformation === "pins-without-profile") {
        db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'pack-core', '1.0.0', 'profile-main')").run(campaignId);
      } else if (malformation === "missing-profile") {
        db.prepare("INSERT INTO campaign_rules_profiles VALUES (?, 'missing-profile')").run(campaignId);
      } else if (malformation === "mismatched-pin") {
        db.prepare("INSERT INTO campaign_rules_profiles VALUES (?, 'profile-main')").run(campaignId);
        db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'other-pack', '1.0.0', 'profile-other')").run(campaignId);
      } else {
        db.exec("DROP TRIGGER campaign_content_packs_require_sealed_insert");
        db.prepare("INSERT INTO campaign_rules_profiles VALUES (?, 'profile-main')").run(campaignId);
        if (malformation === "orphan-pin") {
          db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'orphan', '1', 'profile-main')").run(campaignId);
        } else if (malformation === "unsealed-pin") {
          db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'unsealed-pack', '1.0.0', 'profile-main')").run(campaignId);
        } else {
          db.pragma("ignore_check_constraints = ON");
          db.prepare("INSERT INTO campaign_content_packs VALUES (?, 'bad/id', '1', 'profile-main')").run(campaignId);
        }
      }
      db.close();
      const before = snapshot();
      expect(() => repository.configureCampaignContent(ownerId, campaignId, input)).toThrow("malformed");
      repository.close();
      expect(snapshot()).toEqual(before);
    },
  );

  it.each([
    ["profile-metadata", "initial"],
    ["pack-metadata", "initial"],
    ["profile-metadata", "retry"],
    ["pack-metadata", "retry"],
  ] as const)("rejects malformed installed %s during %s configuration", (malformation, stage) => {
    seed();
    if (stage === "retry") {
      const configured = createRepository({ dataDir: dataDir() });
      configured.configureCampaignContent(ownerId, campaignId, input);
      configured.close();
    }
    const db = new DatabaseDriver(dbPath());
    db.pragma("ignore_check_constraints = ON");
    if (malformation === "profile-metadata") {
      db.exec("DROP TRIGGER rpg_rules_profiles_prevent_referenced_update");
      db.prepare("UPDATE rpg_rules_profiles SET name = '' WHERE rules_profile_id = 'profile-main'").run();
    } else {
      db.exec("DROP TRIGGER rpg_content_packs_prevent_update");
      db.exec("DROP TRIGGER rpg_content_packs_tags_update");
      db.prepare("UPDATE rpg_content_packs SET tags = 'not-json' WHERE pack_id = 'pack-core' AND pack_version = '1.0.0'").run();
    }
    db.close();
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });
    expect(() => repository.configureCampaignContent(ownerId, campaignId, input)).toThrow();
    repository.close();
    expect(snapshot().profiles).toHaveLength(stage === "retry" ? 1 : 0);
    expect(snapshot().pins).toHaveLength(stage === "retry" ? 2 : 0);
  });

  it("rejects a corrupt campaign owner linkage", () => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM campaign_memberships WHERE campaign_id = ? AND principal_id = ?").run(campaignId, ownerId);
    db.close();
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });
    expect(() => repository.configureCampaignContent(ownerId, campaignId, input)).toThrow("malformed campaign ownership");
    repository.close();
  });

  it.each([
    ["profile", `CREATE TRIGGER fail_configuration BEFORE INSERT ON campaign_rules_profiles
      BEGIN SELECT RAISE(ABORT, 'profile insertion failed'); END`],
    ["mid-pin", `CREATE TRIGGER fail_configuration BEFORE INSERT ON campaign_content_packs
      WHEN NEW.pack_id = 'pack-extra' BEGIN SELECT RAISE(ABORT, 'mid-pin insertion failed'); END`],
  ] as const)("rolls back all writes on %s failure", (stage, trigger) => {
    seed();
    const db = new DatabaseDriver(dbPath());
    db.exec(trigger);
    db.close();
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });
    expect(() => repository.configureCampaignContent(ownerId, campaignId, input)).toThrow(`${stage} insertion failed`);
    repository.close();
    expect(snapshot().profiles).toEqual([]);
    expect(snapshot().pins).toEqual([]);
  });

  it("waits for a competing writer and converges in one immediate transaction", async () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const writer = await startLockedWrite(dbPath(), [
      { sql: "INSERT INTO campaign_rules_profiles VALUES (?, ?)", params: [campaignId, input.rulesProfileId] },
      ...input.contentPacks.map((pack) => ({
        sql: "INSERT INTO campaign_content_packs VALUES (?, ?, ?, ?)",
        params: [campaignId, pack.packId, pack.packVersion, input.rulesProfileId],
      })),
    ]);
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    const started = Date.now();
    expect(repository.configureCampaignContent(ownerId, campaignId, input).contentPacks.map((pack) => pack.packId))
      .toEqual(["pack-core", "pack-extra"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
    expect(transaction).toHaveBeenCalledOnce();
    transaction.mockRestore();
    await writer.done;
    repository.close();
  });

  it("reports conflict after a competing different configuration commits", async () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const writer = await startLockedWrite(dbPath(), [
      { sql: "INSERT INTO campaign_rules_profiles VALUES (?, ?)", params: [campaignId, input.rulesProfileId] },
      { sql: "INSERT INTO campaign_content_packs VALUES (?, ?, ?, ?)", params: [campaignId, "pack-core", "2.0.0", input.rulesProfileId] },
    ]);
    expect(() => repository.configureCampaignContent(ownerId, campaignId, input)).toThrow("conflicts");
    await writer.done;
    repository.close();
  });

  it("enforces lifecycle and validation order, excludes UoW, and consumes no dependencies", () => {
    seed();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({ dataDir: dataDir(), clock: { now }, ids: { nextId } });
    const poison = { get rulesProfileId(): string { throw new Error("input read"); } } as ConfigureCampaignContentInput;
    expect(() => repository.configureCampaignContent("bad actor", campaignId, poison)).not.toThrow("input read");
    expect(() => repository.configureCampaignContent(ownerId, "bad campaign", poison)).not.toThrow("input read");
    expect(() => repository.configureCampaignContent(ownerId, campaignId, { ...input, replacement: true } as never)).toThrow();
    expect(() => repository.transaction(() => repository.configureCampaignContent("bad actor", "bad campaign", poison)))
      .toThrow("cannot run inside a repository transaction");
    repository.transaction((unitOfWork) => {
      expect("configureCampaignContent" in unitOfWork).toBe(false);
      // @ts-expect-error Configuration intentionally is not a unit-of-work operation.
      expect(unitOfWork.configureCampaignContent).toBeUndefined();
    });
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();
    expect(() => repository.configureCampaignContent("bad actor", "bad campaign", poison))
      .toThrow("repository is closed");
  });
});
