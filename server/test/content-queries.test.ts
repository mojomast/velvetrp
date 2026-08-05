import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import type { RepositoryUnitOfWork } from "../src/repo/index.js";
import { deleteCampaignForCorruptionTest, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

const ownerId = "global-content-owner";
const campaignId = "campaign-content-reads";
const packOne = { packId: "pack-core", packVersion: "1.0.0" } as const;
const packTwo = { packId: "pack-core", packVersion: "2.0.0" } as const;
const classReference = { ...packTwo, kind: "class", definitionId: "fighter" } as const;
const roles = ["campaign-owner", "campaign-gm", "campaign-player", "campaign-observer"] as const;

function dbPath(): string {
  return path.join(dataDir(), "velvet.sqlite");
}

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function seed(): void {
  const initial = createRepository({ dataDir: dataDir() });
  initial.close();
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys = ON");
  db.transaction(() => {
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(ownerId, "Global owner");
    for (const principalId of roles) {
      db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)").run(principalId, principalId);
    }
    db.prepare("UPDATE application_owner SET principal_id = ? WHERE singleton = 1").run(ownerId);

    db.prepare(`INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags)
      VALUES ('profile-z', 'Z rules', 'Secondary rules', '["z"]'),
             ('profile-a', 'A rules', 'Campaign rules', '["ordered","ordered","last"]')`).run();
    db.prepare(`INSERT INTO rpg_content_packs
      (pack_id, pack_version, rules_profile_id, name, description, tags, sealed) VALUES
      ('pack-z', '1', 'profile-a', 'Z pack', 'Z description', '["z"]', 0),
      ('pack-core', '2.0.0', 'profile-a', 'Core two', 'Pinned version', '["two","two"]', 0),
      ('pack-core', '1.0.0', 'profile-a', 'Core one', 'Older exact version', '["one"]', 0)`).run();

    const insertDefinition = db.prepare(`INSERT INTO rpg_definitions
      (pack_id, pack_version, kind, definition_id, name, description, tags)
      VALUES ('pack-core', '2.0.0', ?, ?, ?, 'Definition description', ?)`);
    const definitions = [
      ["enemy", "dragon", "Dragon", '["last"]'],
      ["ability", "action", "Action", "[]"],
      ["spell", "bolt", "Bolt", "[]"],
      ["item", "rope", "Rope", "[]"],
      ["background", "sage", "Sage", "[]"],
      ["race", "human", "Human", "[]"],
      ["class", "wizard", "Wizard", "[]"],
      ["class", "fighter", "Fighter", '["martial","martial"]'],
    ] as const;
    for (const definition of definitions) insertDefinition.run(...definition);
    db.prepare(`INSERT INTO rpg_definitions
      (pack_id, pack_version, kind, definition_id, name, description, tags)
      VALUES ('pack-core', '1.0.0', 'class', 'fighter', 'Old fighter', 'Old exact definition', '[]')`).run();
    db.prepare("UPDATE rpg_content_packs SET sealed = 1 WHERE sealed = 0").run();

    const at = "2030-01-02T03:04:05.006Z";
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, 'Content reads', 'timeline-content-reads', 'campaign-owner', ?, ?)`).run(campaignId, at, at);
    db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES ('timeline-content-reads', ?, ?)")
      .run(campaignId, at);
    db.prepare("INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)")
      .run(campaignId, "campaign-owner", "owner", at);
    for (const role of ["gm", "player", "observer"] as const) {
      db.prepare("INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)")
        .run(campaignId, `campaign-${role}`, role, at);
    }
    db.prepare("INSERT INTO campaign_rules_profiles (campaign_id, rules_profile_id) VALUES (?, 'profile-a')").run(campaignId);
    db.prepare(`INSERT INTO campaign_content_packs
      (campaign_id, pack_id, pack_version, rules_profile_id) VALUES (?, 'pack-core', '2.0.0', 'profile-a')`).run(campaignId);
  })();
  db.close();
}

function snapshot(): unknown {
  const db = new DatabaseDriver(dbPath(), { readonly: true });
  const result = {
    profiles: db.prepare("SELECT rules_profile_id, name, description, tags FROM rpg_rules_profiles ORDER BY rules_profile_id").all(),
    packs: db.prepare("SELECT pack_id, pack_version, rules_profile_id, name, description, tags FROM rpg_content_packs ORDER BY pack_id, pack_version").all(),
    definitions: db.prepare("SELECT pack_id, pack_version, kind, definition_id, name, description, tags FROM rpg_definitions ORDER BY pack_id, pack_version, kind, definition_id").all(),
    selections: db.prepare("SELECT campaign_id, rules_profile_id FROM campaign_rules_profiles ORDER BY campaign_id").all(),
    pins: db.prepare("SELECT campaign_id, pack_id, pack_version, rules_profile_id FROM campaign_content_packs ORDER BY campaign_id, pack_id").all(),
  };
  db.close();
  return result;
}

describe("RPG content queries", () => {
  it("allows only the current application owner to read global profiles, exact packs, and definitions", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });

    expect(repository.listRulesProfiles(ownerId).map((profile) => profile.rulesProfileId)).toEqual(["profile-a", "profile-z"]);
    expect(repository.getRulesProfile(ownerId, { rulesProfileId: "profile-a" })).toEqual({
      rulesProfileId: "profile-a",
      name: "A rules",
      description: "Campaign rules",
      tags: ["ordered", "ordered", "last"],
    });
    expect(repository.listContentPacks(ownerId).map(({ packId, packVersion }) => ({ packId, packVersion }))).toEqual([
      packOne,
      packTwo,
      { packId: "pack-z", packVersion: "1" },
    ]);
    expect(repository.getContentPack(ownerId, packTwo)?.tags).toEqual(["two", "two"]);
    expect(repository.getContentPack(ownerId, packOne)?.name).toBe("Core one");
    expect(repository.listContentPackDefinitions(ownerId, packTwo).map(({ kind, definitionId }) => `${kind}:${definitionId}`))
      .toEqual(["class:fighter", "class:wizard", "race:human", "background:sage", "item:rope", "spell:bolt", "ability:action", "enemy:dragon"]);
    expect(repository.getContentPackDefinition(ownerId, classReference)).toMatchObject({
      kind: "class", definitionId: "fighter", name: "Fighter", tags: ["martial", "martial"],
    });
    expect(repository.getContentPackDefinition(ownerId, { ...classReference, packVersion: "1.0.0" })?.name).toBe("Old fighter");

    for (const denied of ["local-owner", "campaign-owner", "missing-principal"]) {
      expect(repository.listRulesProfiles(denied)).toEqual([]);
      expect(repository.getRulesProfile(denied, { rulesProfileId: "profile-a" })).toBeNull();
      expect(repository.listContentPacks(denied)).toEqual([]);
      expect(repository.getContentPack(denied, packTwo)).toBeNull();
      expect(repository.listContentPackDefinitions(denied, packTwo)).toEqual([]);
      expect(repository.getContentPackDefinition(denied, classReference)).toBeNull();
    }
    repository.close();
  });

  it("gives owner, GM, player, and observer identical pinned campaign reads with no application-owner bypass", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });

    for (const actorId of roles) {
      expect(repository.getCampaignRulesProfile(actorId, campaignId)?.rulesProfileId).toBe("profile-a");
      expect(repository.listCampaignContentPacks(actorId, campaignId).map(({ packId, packVersion }) => ({ packId, packVersion })))
        .toEqual([packTwo]);
      expect(repository.listCampaignContentPackDefinitions(actorId, campaignId, packTwo).map(({ kind, definitionId }) => `${kind}:${definitionId}`))
        .toEqual(["class:fighter", "class:wizard", "race:human", "background:sage", "item:rope", "spell:bolt", "ability:action", "enemy:dragon"]);
      expect(repository.getCampaignContentPackDefinition(actorId, campaignId, classReference)?.name).toBe("Fighter");
    }
    expect(repository.getCampaignRulesProfile(ownerId, campaignId)).toBeNull();
    expect(repository.listCampaignContentPacks(ownerId, campaignId)).toEqual([]);
    expect(repository.listCampaignContentPackDefinitions(ownerId, campaignId, packTwo)).toEqual([]);
    expect(repository.getCampaignContentPackDefinition(ownerId, campaignId, classReference)).toBeNull();
    repository.close();
  });

  it("returns empty lists or null for missing, unconfigured, and unpinned authorized campaign reads", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });

    expect(repository.getCampaignRulesProfile("campaign-owner", "campaign-missing")).toBeNull();
    expect(repository.listCampaignContentPacks("campaign-owner", "campaign-missing")).toEqual([]);
    expect(repository.listCampaignContentPackDefinitions("campaign-owner", campaignId, packOne)).toEqual([]);
    expect(repository.getCampaignContentPackDefinition("campaign-owner", campaignId, { ...classReference, packVersion: "1.0.0" }))
      .toBeNull();
    repository.close();

    const db = new DatabaseDriver(dbPath());
    deleteCampaignForCorruptionTest(db,campaignId);
    db.prepare("DELETE FROM campaign_content_packs WHERE campaign_id = ?").run(campaignId);
    db.prepare("DELETE FROM campaign_rules_profiles WHERE campaign_id = ?").run(campaignId);
    db.close();
    const unconfigured = createRepository({ dataDir: dataDir() });
    expect(unconfigured.getCampaignRulesProfile("campaign-owner", campaignId)).toBeNull();
    expect(unconfigured.listCampaignContentPacks("campaign-owner", campaignId)).toEqual([]);
    unconfigured.close();
  });

  it("validates strict inputs after lifecycle guards and consumes no clock or IDs", () => {
    seed();
    const now = vi.fn(() => new Date());
    const nextId = vi.fn(() => "unused");
    const repository = createRepository({
      dataDir: dataDir(),
      clock: { now },
      ids: { nextId },
    });

    expect(() => repository.getRulesProfile(ownerId, { rulesProfileId: "bad id" })).toThrow();
    expect(() => repository.getContentPack(ownerId, { ...packTwo, extra: true } as never)).toThrow();
    expect(() => repository.getContentPackDefinition(ownerId, { ...classReference, kind: "feat" } as never)).toThrow();
    expect(() => repository.getCampaignRulesProfile("bad actor", "bad campaign")).toThrow();
    expect(repository.listContentPacks(ownerId)).toHaveLength(3);
    expect(now).not.toHaveBeenCalled();
    expect(nextId).not.toHaveBeenCalled();
    repository.close();

    expect(() => repository.getRulesProfile("bad actor", { rulesProfileId: "bad id" }))
      .toThrow("repository is closed");
    expect(() => repository.getCampaignContentPackDefinition("bad actor", "bad campaign", {} as never))
      .toThrow("repository is closed");
  });

  it("supports all reads in an active unit of work, matches factory results, and expires before validation", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const factoryProfiles = repository.listRulesProfiles(ownerId);
    const factoryDefinitions = repository.listCampaignContentPackDefinitions("campaign-player", campaignId, packTwo);
    let expired: RepositoryUnitOfWork | undefined;

    repository.transaction((unitOfWork) => {
      expired = unitOfWork;
      expect(unitOfWork.listRulesProfiles(ownerId)).toEqual(factoryProfiles);
      expect(unitOfWork.getRulesProfile(ownerId, { rulesProfileId: "profile-a" })).toEqual(factoryProfiles[0]);
      expect(unitOfWork.listContentPacks(ownerId)).toEqual(repository.listContentPacks(ownerId));
      expect(unitOfWork.getContentPack(ownerId, packTwo)).toEqual(repository.getContentPack(ownerId, packTwo));
      expect(unitOfWork.listContentPackDefinitions(ownerId, packTwo)).toHaveLength(8);
      expect(unitOfWork.getContentPackDefinition(ownerId, classReference)?.definitionId).toBe("fighter");
      expect(unitOfWork.getCampaignRulesProfile("campaign-player", campaignId)?.rulesProfileId).toBe("profile-a");
      expect(unitOfWork.listCampaignContentPacks("campaign-player", campaignId)).toHaveLength(1);
      expect(unitOfWork.listCampaignContentPackDefinitions("campaign-player", campaignId, packTwo)).toEqual(factoryDefinitions);
      expect(unitOfWork.getCampaignContentPackDefinition("campaign-player", campaignId, classReference)?.name).toBe("Fighter");
    });

    expect(() => expired!.listRulesProfiles("bad actor")).toThrow("transaction unit of work is no longer active");
    expect(() => expired!.getContentPack("bad actor", {} as never)).toThrow("transaction unit of work is no longer active");
    expect(() => expired!.getCampaignContentPackDefinition("bad actor", "bad campaign", {} as never))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
  });

  it("uses one explicit-column authorization query and no explicit factory transaction for every operation", () => {
    seed();
    const repository = createRepository({ dataDir: dataDir() });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    const calls = [
      () => repository.listRulesProfiles(ownerId),
      () => repository.getRulesProfile(ownerId, { rulesProfileId: "profile-a" }),
      () => repository.listContentPacks(ownerId),
      () => repository.getContentPack(ownerId, packTwo),
      () => repository.listContentPackDefinitions(ownerId, packTwo),
      () => repository.getContentPackDefinition(ownerId, classReference),
      () => repository.getCampaignRulesProfile("campaign-owner", campaignId),
      () => repository.listCampaignContentPacks("campaign-owner", campaignId),
      () => repository.listCampaignContentPackDefinitions("campaign-owner", campaignId, packTwo),
      () => repository.getCampaignContentPackDefinition("campaign-owner", campaignId, classReference),
    ];
    try {
      for (const call of calls) {
        prepare.mockClear();
        transaction.mockClear();
        call();
        expect(prepare).toHaveBeenCalledOnce();
        const sql = prepare.mock.calls[0]?.[0] as string;
        expect(sql).toMatch(/^SELECT /);
        expect(sql).not.toMatch(/SELECT\s+\*/i);
        expect(sql).toMatch(/application_owner|campaign_memberships/);
        expect(transaction).not.toHaveBeenCalled();
      }
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
      repository.close();
    }
  });

  it("fails loudly on malformed persisted tags and never mutates content or pins", () => {
    seed();
    const before = snapshot();
    const repository = createRepository({ dataDir: dataDir() });
    repository.listRulesProfiles(ownerId);
    repository.getContentPack(ownerId, packTwo);
    repository.listContentPackDefinitions(ownerId, packTwo);
    repository.getCampaignRulesProfile("campaign-observer", campaignId);
    repository.listCampaignContentPacks("campaign-observer", campaignId);
    repository.getCampaignContentPackDefinition("campaign-observer", campaignId, classReference);
    expect(snapshot()).toEqual(before);
    repository.close();

    const db = new DatabaseDriver(dbPath());
    db.pragma("ignore_check_constraints = ON");
    db.exec(`
      DROP TRIGGER rpg_rules_profiles_tags_update;
      DROP TRIGGER rpg_rules_profiles_prevent_referenced_update;
    `);
    db.prepare("UPDATE rpg_rules_profiles SET tags = 'not-json' WHERE rules_profile_id = 'profile-a'").run();
    db.close();
    const corrupt = createRepository({ dataDir: dataDir() });
    expect(() => corrupt.getRulesProfile(ownerId, { rulesProfileId: "profile-a" })).toThrow();
    expect(() => corrupt.getCampaignRulesProfile("campaign-owner", campaignId)).toThrow();
    corrupt.close();

    const corruptPackDb = new DatabaseDriver(dbPath());
    corruptPackDb.pragma("ignore_check_constraints = ON");
    corruptPackDb.exec(`
      DROP TRIGGER rpg_content_packs_tags_update;
      DROP TRIGGER rpg_content_packs_prevent_update;
    `);
    corruptPackDb.prepare("UPDATE rpg_rules_profiles SET tags = '[]' WHERE rules_profile_id = 'profile-a'").run();
    corruptPackDb.prepare("UPDATE rpg_content_packs SET tags = '[1]' WHERE pack_id = 'pack-core' AND pack_version = '2.0.0'").run();
    corruptPackDb.close();
    const corruptPack = createRepository({ dataDir: dataDir() });
    expect(() => corruptPack.getContentPack(ownerId, packTwo)).toThrow();
    expect(() => corruptPack.listCampaignContentPacks("campaign-owner", campaignId)).toThrow();
    corruptPack.close();

    const corruptDefinitionDb = new DatabaseDriver(dbPath());
    corruptDefinitionDb.pragma("ignore_check_constraints = ON");
    corruptDefinitionDb.exec(`
      DROP TRIGGER rpg_definitions_tags_update;
      DROP TRIGGER rpg_definitions_prevent_update;
    `);
    corruptDefinitionDb.prepare("UPDATE rpg_content_packs SET tags = '[]' WHERE pack_id = 'pack-core' AND pack_version = '2.0.0'").run();
    corruptDefinitionDb.prepare(`UPDATE rpg_definitions SET tags = '["bad tag"]'
      WHERE pack_id = 'pack-core' AND pack_version = '2.0.0' AND kind = 'class' AND definition_id = 'fighter'`).run();
    corruptDefinitionDb.close();
    const corruptDefinition = createRepository({ dataDir: dataDir() });
    expect(() => corruptDefinition.getContentPackDefinition(ownerId, classReference)).toThrow();
    expect(() => corruptDefinition.getCampaignContentPackDefinition("campaign-owner", campaignId, classReference)).toThrow();
    corruptDefinition.close();
  });
});
