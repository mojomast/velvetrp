import { ORIGINAL_STARTER_ID, type CampaignDetail } from "@velvet/contracts";
import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import {
  createOriginalStarterSetupService,
  OriginalStarterSetupConflictError,
  OriginalStarterSetupUnavailableError,
  type OriginalStarterSetupRepository,
} from "../src/content/originalStarterSetup.js";
import {
  ORIGINAL_STARTER_MANIFEST,
  ORIGINAL_STARTER_PACK_ID,
  ORIGINAL_STARTER_PACK_VERSION,
  ORIGINAL_STARTER_RULES_PROFILE_ID,
} from "../src/content/originalStarterManifest.js";
import { createRepository } from "../src/repo/index.js";
import {
  CampaignContentConfigurationAuthorizationError,
  CampaignContentConfigurationConflictError,
} from "../src/repo/index.js";
import { createCorruptionTestRepository, makeTmpDataDir, useTmpDataDir } from "./helpers.js";
import { startLockedWrite } from "./lock-worker.js";

process.env.NODE_ENV = "test";
useTmpDataDir();

const exactDetail: CampaignDetail = {
  id: "campaign-one",
  name: "One",
  actorRole: "owner",
  createdAt: "2030-01-01T00:00:00.000Z",
  updatedAt: "2030-01-01T00:00:00.000Z",
  content: {
    status: "configured",
    rulesProfileId: ORIGINAL_STARTER_RULES_PROFILE_ID,
    contentPacks: [{ packId: ORIGINAL_STARTER_PACK_ID, packVersion: ORIGINAL_STARTER_PACK_VERSION }],
  },
};

afterEach(() => {
  delete process.env.FEATURE_RPG_CAMPAIGN;
  vi.restoreAllMocks();
});

function createCampaign() {
  const repository = createRepository();
  repository.createCampaign("local-owner", { name: "One" });
  const campaign = repository.listCampaigns("local-owner")[0]!;
  return { repository, campaign };
}

describe("original starter setup service", () => {
  it("returns an exact configured snapshot without invoking either write", () => {
    const repository: OriginalStarterSetupRepository = {
      inspectOriginalStarterSetup: vi.fn(() => ({ status: "exact" as const, campaign: exactDetail })),
      installOriginalStarterContent: vi.fn(),
      configureOriginalStarterContent: vi.fn(),
    };
    expect(createOriginalStarterSetupService(repository).setup("campaign-one")).toEqual(exactDetail);
    expect(repository.inspectOriginalStarterSetup).toHaveBeenCalledOnce();
    expect(repository.installOriginalStarterContent).not.toHaveBeenCalled();
    expect(repository.configureOriginalStarterContent).not.toHaveBeenCalled();
  });

  it("uses install then configure then proof once, with no hidden retry", () => {
    const inspect = vi.fn()
      .mockReturnValueOnce({ status: "unconfigured", campaign: { ...exactDetail, content: { status: "unconfigured" } } })
      .mockReturnValueOnce({ status: "exact", campaign: exactDetail });
    const calls: string[] = [];
    const repository: OriginalStarterSetupRepository = {
      inspectOriginalStarterSetup: inspect,
      installOriginalStarterContent: vi.fn(() => { calls.push("install"); return {} as never; }),
      configureOriginalStarterContent: vi.fn(() => { calls.push("configure"); return {} as never; }),
    };
    expect(createOriginalStarterSetupService(repository).setup("campaign-one")).toEqual(exactDetail);
    expect(calls).toEqual(["install", "configure"]);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("maps non-disclosing and conflict inspections before writes", () => {
    for (const [status, error] of [
      ["unavailable", OriginalStarterSetupUnavailableError],
      ["conflict", OriginalStarterSetupConflictError],
    ] as const) {
      const repository: OriginalStarterSetupRepository = {
        inspectOriginalStarterSetup: vi.fn(() => ({ status })),
        installOriginalStarterContent: vi.fn(),
        configureOriginalStarterContent: vi.fn(),
      };
      expect(() => createOriginalStarterSetupService(repository).setup("campaign-one")).toThrow(error);
      expect(repository.installOriginalStarterContent).not.toHaveBeenCalled();
    }
  });

  it("does not retry when a competing configuration or ownership transfer wins", () => {
    for (const [failure, expected] of [
      [new CampaignContentConfigurationConflictError(), OriginalStarterSetupConflictError],
      [new CampaignContentConfigurationAuthorizationError(), OriginalStarterSetupUnavailableError],
    ] as const) {
      const repository: OriginalStarterSetupRepository = {
        inspectOriginalStarterSetup: vi.fn(() => ({
          status: "unconfigured" as const,
          campaign: { ...exactDetail, content: { status: "unconfigured" as const } },
        })),
        installOriginalStarterContent: vi.fn(() => ({} as never)),
        configureOriginalStarterContent: vi.fn(() => { throw failure; }),
      };
      expect(() => createOriginalStarterSetupService(repository).setup("campaign-one")).toThrow(expected);
      expect(repository.installOriginalStarterContent).toHaveBeenCalledOnce();
      expect(repository.configureOriginalStarterContent).toHaveBeenCalledOnce();
      expect(repository.inspectOriginalStarterSetup).toHaveBeenCalledOnce();
    }
  });
});

describe("original starter setup repository integration", () => {
  it("installs and configures exact metadata, then converges with no additional writes", () => {
    const { repository, campaign } = createCampaign();
    expect(repository.inspectOriginalStarterSetup("local-owner", campaign.id).status).toBe("unconfigured");
    const service = createOriginalStarterSetupService(repository);
    expect(service.setup(campaign.id).content).toEqual(exactDetail.content);

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    const before = db.prepare(`SELECT
      (SELECT count(*) FROM rpg_rules_profiles) AS profiles,
      (SELECT count(*) FROM rpg_content_packs) AS packs,
      (SELECT count(*) FROM rpg_definitions) AS definitions,
      (SELECT count(*) FROM campaign_rules_profiles) AS configurations`).get();
    expect(service.setup(campaign.id).content).toEqual(exactDetail.content);
    expect(db.prepare(`SELECT
      (SELECT count(*) FROM rpg_rules_profiles) AS profiles,
      (SELECT count(*) FROM rpg_content_packs) AS packs,
      (SELECT count(*) FROM rpg_definitions) AS definitions,
      (SELECT count(*) FROM campaign_rules_profiles) AS configurations`).get()).toEqual(before);
    expect(db.prepare("SELECT count(*) AS count FROM rpg_definitions").get()).toEqual({ count: 3 });
    db.close();
    repository.close();
  });

  it("preserves an installed partial result and a later call completes configuration", () => {
    const { repository, campaign } = createCampaign();
    let fail = true;
    const wrapper: OriginalStarterSetupRepository = {
      inspectOriginalStarterSetup: repository.inspectOriginalStarterSetup.bind(repository),
      installOriginalStarterContent: repository.installOriginalStarterContent.bind(repository),
      configureOriginalStarterContent: (...args) => {
        if (fail) { fail = false; throw new Error("injected configuration failure"); }
        return repository.configureOriginalStarterContent(...args);
      },
    };
    expect(() => createOriginalStarterSetupService(wrapper).setup(campaign.id)).toThrow("injected configuration failure");
    expect(repository.getContentPack("local-owner", {
      packId: ORIGINAL_STARTER_PACK_ID, packVersion: ORIGINAL_STARTER_PACK_VERSION,
    })).not.toBeNull();
    expect(repository.getCampaignDetail("local-owner", campaign.id)?.content.status).toBe("unconfigured");
    expect(createOriginalStarterSetupService(wrapper).setup(campaign.id).content.status).toBe("configured");
    repository.close();
  });

  it("rechecks campaign-owner pointer and membership after waiting for the install lock", async () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    const campaign = repository.createCampaign("local-owner", { name: "Authority race" });
    expect(repository.inspectOriginalStarterSetup("local-owner", campaign.id).status).toBe("unconfigured");

    const writer = await startLockedWrite(path.join(dir, "velvet.sqlite"), [
      { sql: "INSERT INTO principals (id, display_name, is_local) VALUES ('next-owner', 'Next owner', 0)" },
      { sql: "UPDATE campaign_memberships SET role = 'gm' WHERE campaign_id = ? AND principal_id = 'local-owner'", params: [campaign.id] },
      { sql: `INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
          SELECT ?, 'next-owner', 'owner', created_at FROM campaigns WHERE id = ?`, params: [campaign.id, campaign.id] },
      { sql: "UPDATE campaigns SET owner_principal_id = 'next-owner' WHERE id = ?", params: [campaign.id] },
    ]);
    expect(() => repository.installOriginalStarterContent("local-owner", campaign.id))
      .toThrow("content pack installation requires the application owner");
    await writer.done;

    const verify = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    expect(verify.prepare(`SELECT
      (SELECT count(*) FROM rpg_rules_profiles) AS profiles,
      (SELECT count(*) FROM rpg_content_packs) AS packs,
      (SELECT count(*) FROM rpg_definitions) AS definitions,
      (SELECT count(*) FROM campaign_rules_profiles) AS configurations,
      (SELECT count(*) FROM campaign_content_packs) AS pins`).get()).toEqual({
      profiles: 0, packs: 0, definitions: 0, configurations: 0, pins: 0,
    });
    verify.transaction(() => {
      verify.prepare("UPDATE campaign_memberships SET role = 'gm' WHERE campaign_id = ? AND principal_id = 'next-owner'").run(campaign.id);
      verify.prepare("UPDATE campaign_memberships SET role = 'owner' WHERE campaign_id = ? AND principal_id = 'local-owner'").run(campaign.id);
      verify.prepare("UPDATE campaigns SET owner_principal_id = 'local-owner' WHERE id = ?").run(campaign.id);
    }).immediate();
    verify.close();
    expect(createOriginalStarterSetupService(repository).setup(campaign.id).content).toEqual(exactDetail.content);
    repository.close();
  });

  it.each(["application owner pointer", "application owner is_local"] as const)(
    "never configures after %s changes between the two transactions, then converges",
    async (change) => {
      const dir = makeTmpDataDir();
      const repository = createRepository({ dataDir: dir });
      const campaign = repository.createCampaign("local-owner", { name: "Application authority race" });
      repository.installOriginalStarterContent("local-owner", campaign.id);
      const statements = change === "application owner pointer"
        ? [
            { sql: "INSERT INTO principals (id, display_name, is_local) VALUES ('next-local', 'Next local', 0)" },
            { sql: "UPDATE principals SET is_local = 0 WHERE id = 'local-owner'" },
            { sql: "UPDATE principals SET is_local = 1 WHERE id = 'next-local'" },
            { sql: "UPDATE application_owner SET principal_id = 'next-local' WHERE singleton = 1" },
          ]
        : [{ sql: "UPDATE principals SET is_local = 0 WHERE id = 'local-owner'" }];
      const writer = await startLockedWrite(path.join(dir, "velvet.sqlite"), statements);
      expect(() => repository.configureOriginalStarterContent("local-owner", campaign.id))
        .toThrow(CampaignContentConfigurationAuthorizationError);
      await writer.done;

      const verify = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
      expect(verify.prepare(`SELECT
        (SELECT count(*) FROM rpg_rules_profiles) AS profiles,
        (SELECT count(*) FROM rpg_content_packs) AS packs,
        (SELECT count(*) FROM rpg_definitions) AS definitions,
        (SELECT count(*) FROM campaign_rules_profiles) AS configurations,
        (SELECT count(*) FROM campaign_content_packs) AS pins`).get()).toEqual({
        profiles: 1, packs: 1, definitions: 3, configurations: 0, pins: 0,
      });
      if (change === "application owner pointer") {
        verify.transaction(() => {
          verify.prepare("UPDATE principals SET is_local = 0 WHERE id = 'next-local'").run();
          verify.prepare("UPDATE principals SET is_local = 1 WHERE id = 'local-owner'").run();
          verify.prepare("UPDATE application_owner SET principal_id = 'local-owner' WHERE singleton = 1").run();
        }).immediate();
      } else {
        verify.prepare("UPDATE principals SET is_local = 1 WHERE id = 'local-owner'").run();
      }
      verify.close();
      expect(createOriginalStarterSetupService(repository).setup(campaign.id).content).toEqual(exactDetail.content);
      repository.close();
    },
  );

  it.each(["campaign owner loss", "duplicate owner lock", "malformed owner lock"] as const)(
    "revalidates complete campaign authority after the config lock: %s",
    async (change) => {
      const dir = makeTmpDataDir();
      const repository = createRepository({ dataDir: dir });
      const campaign = repository.createCampaign("local-owner", { name: "Campaign authority config race" });
      repository.installOriginalStarterContent("local-owner", campaign.id);
      const statements = change === "campaign owner loss" ? [
        { sql: "INSERT INTO principals (id, display_name, is_local) VALUES ('next-owner', 'Next', 0)" },
        { sql: "UPDATE campaign_memberships SET role = 'gm' WHERE campaign_id = ? AND principal_id = 'local-owner'", params: [campaign.id] },
        { sql: `INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
            SELECT ?, 'next-owner', 'owner', created_at FROM campaigns WHERE id = ?`, params: [campaign.id, campaign.id] },
        { sql: "UPDATE campaigns SET owner_principal_id = 'next-owner' WHERE id = ?", params: [campaign.id] },
      ] : change === "duplicate owner lock" ? [
        { sql: "DROP INDEX idx_campaign_memberships_one_owner" },
        { sql: "INSERT INTO principals (id, display_name, is_local) VALUES ('duplicate-owner', 'Duplicate', 0)" },
        { sql: `INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
            SELECT ?, 'duplicate-owner', 'owner', created_at FROM campaigns WHERE id = ?`, params: [campaign.id, campaign.id] },
      ] : [
        { sql: "PRAGMA ignore_check_constraints = ON" },
        { sql: "UPDATE campaign_memberships SET created_at = 'malformed' WHERE campaign_id = ? AND role = 'owner'", params: [campaign.id] },
      ];
      const writer = await startLockedWrite(path.join(dir, "velvet.sqlite"), statements);
      expect(() => repository.configureOriginalStarterContent("local-owner", campaign.id))
        .toThrow(CampaignContentConfigurationAuthorizationError);
      await writer.done;
      const verify = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
      expect(verify.prepare("SELECT COUNT(*) AS count FROM campaign_rules_profiles").get()).toEqual({ count: 0 });
      expect(verify.prepare("SELECT COUNT(*) AS count FROM campaign_content_packs").get()).toEqual({ count: 0 });
      verify.close();
      repository.close();
    },
  );

  it("revalidates application-owner loss after the install lock before any namespace write", async () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    const campaign = repository.createCampaign("local-owner", { name: "Application authority install race" });
    const writer = await startLockedWrite(path.join(dir, "velvet.sqlite"), [
      { sql: "INSERT INTO principals (id, display_name, is_local) VALUES ('next-local', 'Next', 0)" },
      { sql: "UPDATE principals SET is_local = 0 WHERE id = 'local-owner'" },
      { sql: "UPDATE principals SET is_local = 1 WHERE id = 'next-local'" },
      { sql: "UPDATE application_owner SET principal_id = 'next-local' WHERE singleton = 1" },
    ]);
    expect(() => repository.installOriginalStarterContent("local-owner", campaign.id)).toThrow();
    await writer.done;
    const verify = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM rpg_rules_profiles").get()).toEqual({ count: 0 });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM rpg_content_packs").get()).toEqual({ count: 0 });
    verify.close();
    repository.close();
  });

  it("rejects a foreign reserved pack version that wins the install lock without writing starter rows", async () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    const campaign = repository.createCampaign("local-owner", { name: "Reserved version race" });
    const writer = await startLockedWrite(path.join(dir, "velvet.sqlite"), [
      { sql: `INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags) VALUES (?, ?, ?, ?)`,
        params: [ORIGINAL_STARTER_RULES_PROFILE_ID, ORIGINAL_STARTER_MANIFEST.rulesProfile.name,
          ORIGINAL_STARTER_MANIFEST.rulesProfile.description, JSON.stringify(ORIGINAL_STARTER_MANIFEST.rulesProfile.tags)] },
      { sql: `INSERT INTO rpg_content_packs
          (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
          VALUES (?, 'foreign-version', ?, 'Foreign', 'Reserved collision', '[]', 1)`,
        params: [ORIGINAL_STARTER_PACK_ID, ORIGINAL_STARTER_RULES_PROFILE_ID] },
    ]);
    expect(() => repository.installOriginalStarterContent("local-owner", campaign.id)).toThrow();
    await writer.done;
    const verify = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(verify.prepare("SELECT pack_version FROM rpg_content_packs WHERE pack_id = ?")
      .all(ORIGINAL_STARTER_PACK_ID)).toEqual([{ pack_version: "foreign-version" }]);
    expect(verify.prepare("SELECT COUNT(*) AS count FROM rpg_definitions").get()).toEqual({ count: 0 });
    verify.close();
    repository.close();
  });

  it("rejects a foreign reserved version inserted between setup transactions and leaves configuration empty", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    const campaign = repository.createCampaign("local-owner", { name: "Between transaction race" });
    const wrapper: OriginalStarterSetupRepository = {
      inspectOriginalStarterSetup: repository.inspectOriginalStarterSetup.bind(repository),
      installOriginalStarterContent: (...args) => {
        const result = repository.installOriginalStarterContent(...args);
        const db = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
        db.prepare(`INSERT INTO rpg_content_packs
          (pack_id, pack_version, rules_profile_id, name, description, tags, sealed)
          VALUES (?, 'foreign-version', ?, 'Foreign', 'Reserved collision', '[]', 1)`)
          .run(ORIGINAL_STARTER_PACK_ID, ORIGINAL_STARTER_RULES_PROFILE_ID);
        db.close();
        return result;
      },
      configureOriginalStarterContent: repository.configureOriginalStarterContent.bind(repository),
    };
    expect(() => createOriginalStarterSetupService(wrapper).setup(campaign.id))
      .toThrow(OriginalStarterSetupConflictError);
    const verify = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM campaign_rules_profiles").get()).toEqual({ count: 0 });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM campaign_content_packs").get()).toEqual({ count: 0 });
    verify.close();
    repository.close();
  });

  it.each([
    ["missing profile", (db: DatabaseDriver.Database) => {
      db.pragma("foreign_keys = OFF");
      db.exec("DROP TRIGGER rpg_rules_profiles_prevent_referenced_update");
      db.prepare("DELETE FROM rpg_rules_profiles WHERE rules_profile_id = ?").run(ORIGINAL_STARTER_RULES_PROFILE_ID);
    }],
    ["extra definition", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER rpg_definitions_prevent_sealed_insert");
      db.prepare(`INSERT INTO rpg_definitions
        (pack_id, pack_version, kind, definition_id, name, description, tags)
        VALUES (?, ?, 'item', 'velvet:extra', 'Extra', 'Extra', '[]')`)
        .run(ORIGINAL_STARTER_PACK_ID, ORIGINAL_STARTER_PACK_VERSION);
    }],
    ["malformed definition", (db: DatabaseDriver.Database) => {
      db.pragma("ignore_check_constraints = ON");
      db.exec("DROP TRIGGER rpg_definitions_prevent_update; DROP TRIGGER rpg_definitions_tags_update");
      db.prepare("UPDATE rpg_definitions SET tags = 'not-json' WHERE pack_id = ? LIMIT 1")
        .run(ORIGINAL_STARTER_PACK_ID);
    }],
    ["captured definition", (db: DatabaseDriver.Database) => {
      db.pragma("foreign_keys = OFF");
      db.exec("DROP TRIGGER rpg_definitions_prevent_update");
      db.prepare("UPDATE rpg_definitions SET pack_id = 'foreign-pack' WHERE pack_id = ? LIMIT 1")
        .run(ORIGINAL_STARTER_PACK_ID);
    }],
    ["wrong definition version", (db: DatabaseDriver.Database) => {
      db.pragma("foreign_keys = OFF");
      db.exec("DROP TRIGGER rpg_definitions_prevent_update");
      db.prepare("UPDATE rpg_definitions SET pack_version = 'wrong-version' WHERE pack_id = ? LIMIT 1")
        .run(ORIGINAL_STARTER_PACK_ID);
    }],
    ["unsealed pack", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER rpg_content_packs_prevent_update");
      db.prepare("UPDATE rpg_content_packs SET sealed = 0 WHERE pack_id = ?").run(ORIGINAL_STARTER_PACK_ID);
    }],
    ["incomplete definitions", (db: DatabaseDriver.Database) => {
      db.exec("DROP TRIGGER rpg_definitions_prevent_delete");
      db.prepare("DELETE FROM rpg_definitions WHERE pack_id = ? AND kind = 'class'").run(ORIGINAL_STARTER_PACK_ID);
    }],
  ] as const)("does not overwrite or repair %s reserved namespace state", (_label, corrupt) => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    const campaign = repository.createCampaign("local-owner", { name: "Namespace matrix" });
    repository.installOriginalStarterContent("local-owner", campaign.id);
    repository.close();
    const db = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    corrupt(db);
    const before = JSON.stringify({
      profiles: db.prepare("SELECT * FROM rpg_rules_profiles ORDER BY rules_profile_id").all(),
      packs: db.prepare("SELECT * FROM rpg_content_packs ORDER BY pack_id, pack_version").all(),
      definitions: db.prepare("SELECT * FROM rpg_definitions ORDER BY pack_id, pack_version, kind, definition_id").all(),
    });
    db.close();
    const reopened = createCorruptionTestRepository({ dataDir: dir });
    expect(reopened.inspectOriginalStarterSetup("local-owner", campaign.id)).toEqual({ status: "conflict" });
    expect(() => createOriginalStarterSetupService(reopened).setup(campaign.id))
      .toThrow(OriginalStarterSetupConflictError);
    reopened.close();
    const verify = new DatabaseDriver(path.join(dir, "velvet.sqlite"), { readonly: true });
    expect(JSON.stringify({
      profiles: verify.prepare("SELECT * FROM rpg_rules_profiles ORDER BY rules_profile_id").all(),
      packs: verify.prepare("SELECT * FROM rpg_content_packs ORDER BY pack_id, pack_version").all(),
      definitions: verify.prepare("SELECT * FROM rpg_definitions ORDER BY pack_id, pack_version, kind, definition_id").all(),
    })).toBe(before);
    expect(verify.prepare("SELECT COUNT(*) AS count FROM campaign_rules_profiles").get()).toEqual({ count: 0 });
    verify.close();
  });

  it("rejects a reserved-pack definition superset including an extra kind", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    const campaign = repository.createCampaign("local-owner", { name: "Definition superset" });
    createOriginalStarterSetupService(repository).setup(campaign.id);
    repository.close();

    const db = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    db.exec("DROP TRIGGER rpg_definitions_prevent_sealed_insert");
    db.prepare(`INSERT INTO rpg_definitions
      (pack_id, pack_version, kind, definition_id, name, description, tags)
      VALUES (?, ?, 'item', 'velvet:original-starter:item:extra', 'Extra', 'Unexpected definition.', '[]')`)
      .run(ORIGINAL_STARTER_PACK_ID, ORIGINAL_STARTER_PACK_VERSION);
    db.close();

    const reopened = createCorruptionTestRepository({ dataDir: dir });
    expect(reopened.inspectOriginalStarterSetup("local-owner", campaign.id)).toEqual({ status: "conflict" });
    expect(() => createOriginalStarterSetupService(reopened).setup(campaign.id))
      .toThrow(OriginalStarterSetupConflictError);
    reopened.close();
  });

  it("reports different configuration, reserved metadata, and transferred authority as typed states", () => {
    const { repository, campaign } = createCampaign();
    repository.installContentPack("local-owner", {
      packId: "other:pack", packVersion: "1", rulesProfileId: "other:rules",
      rulesProfile: { name: "Other", description: "Other profile", tags: [] },
      name: "Other", description: "Other pack", tags: [], classes: [], races: [], backgrounds: [],
      items: [], spells: [], abilities: [], enemies: [],
    });
    repository.configureCampaignContent("local-owner", campaign.id, {
      rulesProfileId: "other:rules", contentPacks: [{ packId: "other:pack", packVersion: "1" }],
    });
    expect(repository.inspectOriginalStarterSetup("local-owner", campaign.id)).toEqual({ status: "conflict" });
    repository.close();

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES ('next-local', 'Next', 0)").run();
    db.prepare("UPDATE application_owner SET principal_id = 'next-local' WHERE singleton = 1").run();
    db.close();
    const reopened = createRepository();
    expect(reopened.inspectOriginalStarterSetup("local-owner", campaign.id)).toEqual({ status: "unavailable" });
    reopened.close();
  });

  it("classifies a valid reserved profile collision before installation without overwriting it", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    const campaign = repository.createCampaign("local-owner", { name: "Reserved" });
    repository.close();
    const db = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    db.prepare(`INSERT INTO rpg_rules_profiles (rules_profile_id, name, description, tags)
      VALUES (?, 'Collision', 'Different reserved metadata.', '[]')`).run(ORIGINAL_STARTER_RULES_PROFILE_ID);
    db.close();
    const reopened = createRepository({ dataDir: dir });
    expect(reopened.inspectOriginalStarterSetup("local-owner", campaign.id)).toEqual({ status: "conflict" });
    expect(() => createOriginalStarterSetupService(reopened).setup(campaign.id))
      .toThrow(OriginalStarterSetupConflictError);
    const verify = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    expect(verify.prepare("SELECT name FROM rpg_rules_profiles WHERE rules_profile_id = ?")
      .get(ORIGINAL_STARTER_RULES_PROFILE_ID)).toEqual({ name: "Collision" });
    expect(verify.prepare("SELECT count(*) AS count FROM rpg_content_packs").get()).toEqual({ count: 0 });
    verify.close();
    reopened.close();
  });

  it.each(["profile", "pack"] as const)(
    "returns a redacted typed conflict without writes when configured starter %s is missing",
    async (missing) => {
      const dir = makeTmpDataDir();
      const repository = createRepository({ dataDir: dir });
      const campaign = repository.createCampaign("local-owner", { name: "Configured missing reserved row" });
      createOriginalStarterSetupService(repository).setup(campaign.id);
      repository.close();

      const dbPath = path.join(dir, "velvet.sqlite");
      const db = new DatabaseDriver(dbPath);
      db.pragma("foreign_keys = OFF");
      if (missing === "profile") {
        db.exec("DROP TRIGGER rpg_rules_profiles_prevent_referenced_update");
        db.prepare("DELETE FROM rpg_rules_profiles WHERE rules_profile_id = ?")
          .run(ORIGINAL_STARTER_RULES_PROFILE_ID);
      } else {
        db.exec("DROP TRIGGER rpg_content_packs_prevent_delete");
        db.prepare("DELETE FROM rpg_content_packs WHERE pack_id = ? AND pack_version = ?")
          .run(ORIGINAL_STARTER_PACK_ID, ORIGINAL_STARTER_PACK_VERSION);
      }
      const snapshot = () => JSON.stringify({
        profiles: db.prepare("SELECT * FROM rpg_rules_profiles ORDER BY rules_profile_id").all(),
        packs: db.prepare("SELECT * FROM rpg_content_packs ORDER BY pack_id, pack_version").all(),
        definitions: db.prepare("SELECT * FROM rpg_definitions ORDER BY pack_id, pack_version, kind, definition_id").all(),
        configurations: db.prepare("SELECT * FROM campaign_rules_profiles ORDER BY campaign_id").all(),
        pins: db.prepare("SELECT * FROM campaign_content_packs ORDER BY campaign_id, pack_id, pack_version").all(),
      });
      const before = snapshot();
      db.close();

      process.env.FEATURE_RPG_CAMPAIGN = "true";
      const app = buildApp({ campaignRepositoryFactory: () => createCorruptionTestRepository({ dataDir: dir }) });
      const response = await app.inject({
        method: "PUT",
        url: `/api/rpg/v1/campaigns/${campaign.id}/starter-setup`,
        headers: { "content-type": "application/json", "x-request-id": `missing-${missing}` },
        payload: { starterId: ORIGINAL_STARTER_ID },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        status: 409,
        code: "RPG_CAMPAIGN_STARTER_SETUP_CONFLICT",
        requestId: `missing-${missing}`,
      });
      expect(response.body).not.toContain("rpg_");
      expect(response.body).not.toContain("sqlite");
      expect(response.body).not.toContain(missing === "profile" ? ORIGINAL_STARTER_RULES_PROFILE_ID : ORIGINAL_STARTER_PACK_ID);
      await app.close();

      const verify = new DatabaseDriver(dbPath, { readonly: true });
      const after = JSON.stringify({
        profiles: verify.prepare("SELECT * FROM rpg_rules_profiles ORDER BY rules_profile_id").all(),
        packs: verify.prepare("SELECT * FROM rpg_content_packs ORDER BY pack_id, pack_version").all(),
        definitions: verify.prepare("SELECT * FROM rpg_definitions ORDER BY pack_id, pack_version, kind, definition_id").all(),
        configurations: verify.prepare("SELECT * FROM campaign_rules_profiles ORDER BY campaign_id").all(),
        pins: verify.prepare("SELECT * FROM campaign_content_packs ORDER BY campaign_id, pack_id, pack_version").all(),
      });
      expect(after).toBe(before);
      verify.close();
    },
  );

  it("does not let a missing reserved row mask unrelated authorized campaign corruption", () => {
    const dir = makeTmpDataDir();
    const repository = createRepository({ dataDir: dir });
    const campaign = repository.createCampaign("local-owner", { name: "Corrupt campaign" });
    createOriginalStarterSetupService(repository).setup(campaign.id);
    repository.close();
    const db = new DatabaseDriver(path.join(dir, "velvet.sqlite"));
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.exec("DROP TRIGGER rpg_content_packs_prevent_delete");
    db.prepare("DELETE FROM rpg_content_packs WHERE pack_id = ? AND pack_version = ?")
      .run(ORIGINAL_STARTER_PACK_ID, ORIGINAL_STARTER_PACK_VERSION);
    db.prepare("UPDATE campaigns SET name = '' WHERE id = ?").run(campaign.id);
    db.close();

    const reopened = createCorruptionTestRepository({ dataDir: dir });
    expect(() => reopened.inspectOriginalStarterSetup("local-owner", campaign.id)).toThrow();
    reopened.close();
  });
});

function routeRepository(status: "exact" | "unavailable" | "conflict" = "exact") {
  return {
    listCampaigns: vi.fn(() => []),
    getCampaignDetail: vi.fn(() => null),
    createCampaign: vi.fn(),
    getCampaignCharacterCreationOptions: vi.fn(() => null),
    getCampaignCharacterRoster: vi.fn(() => null),
    getCampaignCharacterWorkspace: vi.fn(() => null),
    createOriginalStarterCampaignCharacter: vi.fn(() => { throw new Error("unused"); }),
    renameCampaignIfUnchanged: vi.fn(),
    inspectOriginalStarterSetup: vi.fn(() => status === "exact" ? { status, campaign: exactDetail } : { status }),
    installOriginalStarterContent: vi.fn(),
    configureOriginalStarterContent: vi.fn(),
    close: vi.fn(),
  };
}

describe("PUT /api/rpg/v1/campaigns/:id/starter-setup", () => {
  it("is gated, strict, fixed-local, query-free, correlated, and HEAD-disabled", async () => {
    const repository = routeRepository();
    let app = buildApp({ campaignRepositoryFactory: () => repository });
    expect((await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/campaign-one/starter-setup",
      headers: { "content-type": "application/json" }, payload: { starterId: ORIGINAL_STARTER_ID } })).statusCode).toBe(404);
    await app.close();

    process.env.FEATURE_RPG_CAMPAIGN = "true";
    app = buildApp({ campaignRepositoryFactory: () => repository });
    const response = await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/campaign-one/starter-setup",
      headers: { "content-type": "application/json", "x-request-id": "starter-request", "x-principal-id": "spoof" },
      payload: { starterId: ORIGINAL_STARTER_ID } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("starter-request");
    expect(response.json()).toEqual({ campaign: exactDetail });
    expect(repository.inspectOriginalStarterSetup).toHaveBeenCalledWith("local-owner", "campaign-one");
    expect((await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/campaign-one/starter-setup?x=1",
      headers: { "content-type": "application/json" }, payload: { starterId: ORIGINAL_STARTER_ID } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/campaign-one/starter-setup",
      headers: { "content-type": "application/json" }, payload: { starterId: "other" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/campaign-one/starter-setup",
      headers: { "content-type": "application/json" },
      payload: { starterId: ORIGINAL_STARTER_ID, content: {} } })).statusCode).toBe(400);
    expect((await app.inject({ method: "HEAD", url: "/api/rpg/v1/campaigns/campaign-one/starter-setup" })).statusCode).toBe(404);
    await app.close();
  });

  it("enforces the complete media, body, method, path, correlation, and cache matrix", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    const repository = routeRepository();
    const factory = vi.fn(() => repository);
    const app = buildApp({ campaignRepositoryFactory: factory });
    const url = "/api/rpg/v1/campaigns/campaign-one/starter-setup";
    const payload = JSON.stringify({ starterId: ORIGINAL_STARTER_ID });

    for (const contentType of [undefined, "text/json", "application/problem+json", "application/json; profile=starter",
      "application/json; charset=utf-8; profile=starter"]) {
      const response = await app.inject({
        method: "PUT", url, payload,
        headers: { ...(contentType ? { "content-type": contentType } : {}), "x-request-id": "starter-media" },
      });
      expect(response.statusCode).toBe(415);
      expect(response.headers["x-request-id"]).toBe("starter-media");
      expect(response.json()).toMatchObject({
        status: 415, code: "RPG_UNSUPPORTED_MEDIA_TYPE", requestId: "starter-media",
      });
    }
    for (const contentType of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON; CHARSET=\"utf-8\""]) {
      const response = await app.inject({
        method: "PUT", url, payload, headers: { "content-type": contentType, "x-request-id": "starter-json" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ campaign: exactDetail });
    }
    for (const body of ["", "{", "null", "{}", "[]"]) {
      const response = await app.inject({
        method: "PUT", url, payload: body,
        headers: { "content-type": "application/json", "x-request-id": "starter-body" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        status: 400, code: "RPG_INVALID_REQUEST", requestId: "starter-body",
      });
    }

    for (const method of ["GET", "POST", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const) {
      const response = await app.inject({ method, url, headers: { "x-request-id": `starter-${method}` } });
      expect(response.statusCode).toBe(404);
      expect(response.headers["x-request-id"]).toBe(`starter-${method}`);
      expect(response.json()).toMatchObject({ code: "RPG_ROUTE_NOT_FOUND", requestId: `starter-${method}` });
    }
    for (const [invalidUrl, code] of [
      ["/api/rpg/v1/campaigns/invalid%20campaign/starter-setup", "RPG_CAMPAIGN_NOT_FOUND"],
      [`/api/rpg/v1/campaigns/${"x".repeat(129)}/starter-setup`, "RPG_CAMPAIGN_NOT_FOUND"],
      ["/api/rpg/v1/campaigns/%zz/starter-setup", "RPG_CAMPAIGN_NOT_FOUND"],
      ["/api/rpg/v1/campaigns/campaign-one/starter-setup/extra", "RPG_ROUTE_NOT_FOUND"],
      ["/api/rpg/v1/campaigns/campaign-one/starter_setup", "RPG_ROUTE_NOT_FOUND"],
    ] as const) {
      const response = await app.inject({
        method: "PUT", url: invalidUrl, payload,
        headers: { "content-type": "application/json", "x-request-id": "starter-path" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers["x-request-id"]).toBe("starter-path");
      expect(response.json()).toMatchObject({ status: 404, code, requestId: "starter-path" });
    }

    const invalidRequestId = await app.inject({
      method: "PUT", url: `${url}?invalid=1`, payload,
      headers: { "content-type": "application/json", "x-request-id": "bad request id" },
    });
    const generatedId = invalidRequestId.headers["x-request-id"];
    expect(invalidRequestId.statusCode).toBe(400);
    expect(invalidRequestId.json()).toMatchObject({ code: "RPG_INVALID_REQUEST", requestId: generatedId });
    expect(generatedId).not.toBe("bad request id");
    expect(generatedId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);

    expect(factory).toHaveBeenCalledOnce();
    await app.close();
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it("maps unavailable and conflicts and redacts unexpected/output failures", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    for (const [status, expected] of [["unavailable", 404], ["conflict", 409]] as const) {
      const app = buildApp({ campaignRepositoryFactory: () => routeRepository(status) });
      const response = await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/campaign-one/starter-setup",
        headers: { "content-type": "application/json" }, payload: { starterId: ORIGINAL_STARTER_ID } });
      expect(response.statusCode).toBe(expected);
      await app.close();
    }
    const repository = routeRepository();
    repository.inspectOriginalStarterSetup.mockImplementation(() => { throw new Error("private sqlite path"); });
    const app = buildApp({ campaignRepositoryFactory: () => repository });
    const response = await app.inject({ method: "PUT", url: "/api/rpg/v1/campaigns/campaign-one/starter-setup",
      headers: { "content-type": "application/json", "x-request-id": "redacted" }, payload: { starterId: ORIGINAL_STARTER_ID } });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("private sqlite path");
    expect(response.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR", requestId: "redacted" });
    await app.close();

    const malformed = routeRepository();
    malformed.inspectOriginalStarterSetup.mockReturnValue({
      status: "exact", campaign: { ...exactDetail, id: "wrong-campaign" },
    });
    const malformedApp = buildApp({ campaignRepositoryFactory: () => malformed });
    const malformedResponse = await malformedApp.inject({ method: "PUT",
      url: "/api/rpg/v1/campaigns/campaign-one/starter-setup",
      headers: { "content-type": "application/json" }, payload: { starterId: ORIGINAL_STARTER_ID } });
    expect(malformedResponse.statusCode).toBe(500);
    expect(malformedResponse.json()).toMatchObject({ code: "RPG_INTERNAL_ERROR" });
    await malformedApp.close();
  });

  it("maps only genuine typed setup failures, never lookalikes", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true";
    for (const [failure, status, code] of [
      [new OriginalStarterSetupUnavailableError(), 404, "RPG_CAMPAIGN_NOT_FOUND"],
      [new OriginalStarterSetupConflictError(), 409, "RPG_CAMPAIGN_STARTER_SETUP_CONFLICT"],
      [new Error("campaign starter setup is unavailable"), 500, "RPG_INTERNAL_ERROR"],
      [new Error("campaign starter setup conflicts with current state"), 500, "RPG_INTERNAL_ERROR"],
    ] as const) {
      const repository = routeRepository();
      repository.inspectOriginalStarterSetup.mockImplementation(() => { throw failure; });
      const app = buildApp({ campaignRepositoryFactory: () => repository });
      const response = await app.inject({
        method: "PUT", url: "/api/rpg/v1/campaigns/campaign-one/starter-setup",
        payload: { starterId: ORIGINAL_STARTER_ID }, headers: { "x-request-id": "starter-failure" },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code, requestId: "starter-failure" });
      if (status === 500) expect(response.body).not.toContain(failure.message);
      await app.close();
    }
  });
});
