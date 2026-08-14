import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import type { CampaignRole } from "@velvet/contracts";
import type { RepositoryUnitOfWork } from "../src/repo/index.js";
import { createCorruptionTestRepository, deleteCampaignForCorruptionTest, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

interface SeedCampaign {
  id: string;
  name: string;
  createdAt: string;
  actorRole: CampaignRole;
}

const actorId = "campaign-reader";
const campaigns: SeedCampaign[] = [
  { id: "campaign-z", name: "Owner campaign", createdAt: "2030-01-01T00:00:00.000Z", actorRole: "owner" },
  { id: "campaign-b", name: "GM campaign", createdAt: "2030-02-01T00:00:00.000Z", actorRole: "gm" },
  { id: "campaign-a", name: "Player campaign", createdAt: "2030-02-01T00:00:00.000Z", actorRole: "player" },
  { id: "campaign-c", name: "Observer campaign", createdAt: "2030-03-01T00:00:00.000Z", actorRole: "observer" },
];
const nonOwnerCampaigns = [
  { role: "gm", campaignId: "campaign-b" },
  { role: "player", campaignId: "campaign-a" },
  { role: "observer", campaignId: "campaign-c" },
] as const;
const ownerCorruptions = [
  "missing-membership",
  "duplicate-membership",
  "pointer-mismatch",
  "malformed-membership",
  "missing-principal-parent",
] as const;
const ownerIntegrityCases = nonOwnerCampaigns.flatMap(({ role, campaignId }) =>
  ownerCorruptions.map((corruption) => ({ role, campaignId, corruption })));

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function databasePath(): string {
  return path.join(dataDir(), "velvet.sqlite");
}

function seedCampaigns(): void {
  const initial = createRepository({ dataDir: dataDir() });
  initial.close();
  const db = new DatabaseDriver(databasePath());
  db.pragma("foreign_keys = ON");
  db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, 'Campaign reader', 0)").run(actorId);
  const insert = db.transaction((campaign: SeedCampaign) => {
    const ownerPrincipalId = campaign.actorRole === "owner" ? actorId : "local-owner";
    const timelineId = `timeline-${campaign.id}`;
    db.prepare(`INSERT INTO campaigns
      (id, name, active_timeline_id, owner_principal_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      campaign.id,
      campaign.name,
      timelineId,
      ownerPrincipalId,
      campaign.createdAt,
      campaign.createdAt,
    );
    db.prepare("INSERT INTO campaign_timelines (id, campaign_id, created_at) VALUES (?, ?, ?)")
      .run(timelineId, campaign.id, campaign.createdAt);
    db.prepare("INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at) VALUES (?, ?, 'owner', ?)")
      .run(campaign.id, ownerPrincipalId, campaign.createdAt);
    if (campaign.actorRole !== "owner") {
      db.prepare("INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at) VALUES (?, ?, ?, ?)")
        .run(campaign.id, actorId, campaign.actorRole, campaign.createdAt);
    }
  });
  for (const campaign of campaigns) insert.immediate(campaign);
  db.close();
}

describe("authorized campaign queries", () => {
  it("lists only memberships with every role in created-at and ID order using the exact projection", () => {
    seedCampaigns();
    const repository = createRepository({ dataDir: dataDir() });

    const result = repository.listCampaigns(actorId);

    expect(result.map(({ id, actorRole }) => ({ id, actorRole }))).toEqual([
      { id: "campaign-z", actorRole: "owner" },
      { id: "campaign-a", actorRole: "player" },
      { id: "campaign-b", actorRole: "gm" },
      { id: "campaign-c", actorRole: "observer" },
    ]);
    expect(result[1]).toEqual({
      id: "campaign-a",
      name: "Player campaign",
      activeTimelineId: "timeline-campaign-a",
      ownerPrincipalId: "local-owner",
      createdAt: "2030-02-01T00:00:00.000Z",
      updatedAt: "2030-02-01T00:00:00.000Z",
      actorRole: "player",
    });
    expect(Object.keys(result[1]!)).toEqual([
      "id", "name", "activeTimelineId", "ownerPrincipalId", "createdAt", "updatedAt", "actorRole",
    ]);
    expect(repository.listCampaigns("local-owner").map(({ id }) => id)).toEqual([
      "campaign-a", "campaign-b", "campaign-c",
    ]);
    repository.close();
  });

  it("gets an authorized campaign and returns null for missing or unauthorized campaigns without application-owner bypass", () => {
    seedCampaigns();
    const repository = createRepository({ dataDir: dataDir() });

    expect(repository.getCampaign(actorId, "campaign-b")).toMatchObject({
      id: "campaign-b",
      actorRole: "gm",
    });
    expect(repository.getCampaign(actorId, "campaign-missing")).toBeNull();
    expect(repository.getCampaign("missing-principal", "campaign-b")).toBeNull();
    expect(repository.getCampaign("local-owner", "campaign-z")).toBeNull();
    expect(repository.listCampaigns("missing-principal")).toEqual([]);
    repository.close();
  });

  it("validates actor and campaign IDs without consuming dependencies", () => {
    seedCampaigns();
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId },
      clock: { now: clockNow },
    });

    expect(() => repository.listCampaigns("invalid actor")).toThrow();
    expect(() => repository.getCampaign("invalid actor", "invalid campaign")).toThrow();
    expect(() => repository.getCampaign(actorId, "invalid campaign")).toThrow();
    expect(repository.listCampaigns(actorId)).toHaveLength(4);
    expect(repository.getCampaign(actorId, "campaign-a")?.actorRole).toBe("player");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
  });

  it("uses one exact statement per factory read without opening an explicit transaction", () => {
    seedCampaigns();
    const repository = createRepository({ dataDir: dataDir() });
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    try {
      repository.listCampaigns(actorId);
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare.mock.calls[0]?.[0]).toBe(`SELECT c.id, c.name, c.active_timeline_id, c.owner_principal_id,
  c.created_at, c.updated_at, cm.role AS actor_role, cm.campaign_id AS actor_campaign_id,
  cm.principal_id AS actor_principal_id, cm.created_at AS actor_created_at,
  (SELECT COUNT(*) FROM campaign_memberships owner_membership
    WHERE owner_membership.campaign_id = c.id AND owner_membership.role = 'owner') AS owner_role_count,
  owner_membership.campaign_id AS owner_campaign_id,
  owner_membership.principal_id AS owner_membership_principal_id,
  owner_membership.role AS owner_role,
  owner_membership.created_at AS owner_created_at,
  owner_principal.id AS owner_parent_id
    FROM campaign_memberships cm
    JOIN principals actor_principal ON actor_principal.id = cm.principal_id
    JOIN campaigns c ON c.id = cm.campaign_id
    LEFT JOIN campaign_memberships owner_membership
      ON owner_membership.campaign_id = c.id
      AND owner_membership.principal_id = c.owner_principal_id
      AND owner_membership.role = 'owner'
    LEFT JOIN principals owner_principal ON owner_principal.id = owner_membership.principal_id
    WHERE cm.principal_id = ?
    ORDER BY c.created_at ASC, c.id ASC`);
      expect(transaction).not.toHaveBeenCalled();

      prepare.mockClear();
      repository.getCampaign(actorId, "campaign-a");
      expect(prepare).toHaveBeenCalledOnce();
      expect(prepare.mock.calls[0]?.[0]).toBe(`SELECT c.id, c.name, c.active_timeline_id, c.owner_principal_id,
  c.created_at, c.updated_at, cm.role AS actor_role, cm.campaign_id AS actor_campaign_id,
  cm.principal_id AS actor_principal_id, cm.created_at AS actor_created_at,
  (SELECT COUNT(*) FROM campaign_memberships owner_membership
    WHERE owner_membership.campaign_id = c.id AND owner_membership.role = 'owner') AS owner_role_count,
  owner_membership.campaign_id AS owner_campaign_id,
  owner_membership.principal_id AS owner_membership_principal_id,
  owner_membership.role AS owner_role,
  owner_membership.created_at AS owner_created_at,
  owner_principal.id AS owner_parent_id
    FROM campaign_memberships cm
    JOIN principals actor_principal ON actor_principal.id = cm.principal_id
    JOIN campaigns c ON c.id = cm.campaign_id
    LEFT JOIN campaign_memberships owner_membership
      ON owner_membership.campaign_id = c.id
      AND owner_membership.principal_id = c.owner_principal_id
      AND owner_membership.role = 'owner'
    LEFT JOIN principals owner_principal ON owner_principal.id = owner_membership.principal_id
    WHERE cm.principal_id = ? AND c.id = ?`);
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      transaction.mockRestore();
      repository.close();
    }
  });

  it("performs no writes while reading", () => {
    seedCampaigns();
    const db = new DatabaseDriver(databasePath());
    db.exec(`
      CREATE TRIGGER reject_campaign_update BEFORE UPDATE ON campaigns
        BEGIN SELECT RAISE(ABORT, 'campaign write rejected'); END;
      CREATE TRIGGER reject_membership_update BEFORE UPDATE ON campaign_memberships
        BEGIN SELECT RAISE(ABORT, 'membership write rejected'); END;
    `);
    db.close();
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });

    expect(repository.listCampaigns(actorId)).toHaveLength(4);
    expect(repository.getCampaign(actorId, "campaign-c")?.actorRole).toBe("observer");
    repository.close();
  });

  it("masks a stale purported owner but fails loudly for a non-sole owner after GM authorization", () => {
    seedCampaigns();
    const db = new DatabaseDriver(databasePath());
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE campaigns SET owner_principal_id = 'local-owner' WHERE id = 'campaign-z'").run();
    db.exec("DROP INDEX idx_campaign_memberships_one_owner");
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES ('second-owner', 'Second owner', 0)").run();
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES ('campaign-b', 'second-owner', 'owner', '2030-02-02T00:00:00.000Z')`).run();
    db.close();
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });

    expect(repository.getCampaign(actorId, "campaign-z")).toBeNull();
    expect(() => repository.getCampaign("local-owner", "campaign-b"))
      .toThrow("campaign owner authorization is malformed");
    expect(() => repository.getCampaign(actorId, "campaign-b"))
      .toThrow("campaign owner authorization is malformed");
    expect(() => repository.listCampaigns(actorId)).toThrow("campaign owner authorization is malformed");
    repository.close();
  });

  it.each(ownerIntegrityCases)(
    "fails loudly for $role authorization with $corruption while masking outsiders",
    ({ campaignId, corruption }) => {
      seedCampaigns();
      const db = new DatabaseDriver(databasePath());
      db.pragma("foreign_keys = OFF");
      db.pragma("ignore_check_constraints = ON");
      if (corruption === "missing-membership") {
        db.prepare("DELETE FROM campaign_memberships WHERE campaign_id = ? AND role = 'owner'").run(campaignId);
      } else if (corruption === "duplicate-membership") {
        db.exec("DROP INDEX idx_campaign_memberships_one_owner");
        db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES ('matrix-second-owner', 'Second owner', 0)").run();
        db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
          VALUES (?, 'matrix-second-owner', 'owner', '2030-04-01T00:00:00.000Z')`).run(campaignId);
      } else if (corruption === "pointer-mismatch") {
        db.prepare("UPDATE campaigns SET owner_principal_id = ? WHERE id = ?").run(actorId, campaignId);
      } else if (corruption === "malformed-membership") {
        db.prepare("UPDATE campaign_memberships SET created_at = 'not-canonical' WHERE campaign_id = ? AND role = 'owner'")
          .run(campaignId);
      } else {
        db.prepare("DELETE FROM principals WHERE id = 'local-owner'").run();
      }
      db.close();
      const repository = createCorruptionTestRepository({ dataDir: dataDir() });

      expect(() => repository.getCampaign(actorId, campaignId))
        .toThrow("campaign owner authorization is malformed");
      expect(() => repository.listCampaigns(actorId)).toThrow("campaign owner authorization is malformed");
      expect(repository.getCampaign("missing-principal", campaignId)).toBeNull();
      repository.close();
    },
  );

  it("masks owner corruption when authorization parents are missing", () => {
    seedCampaigns();
    const db = new DatabaseDriver(databasePath());
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM campaign_memberships WHERE campaign_id = 'campaign-b' AND role = 'owner'").run();
    db.prepare("DELETE FROM principals WHERE id = ?").run(actorId);
    db.close();
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });

    expect(repository.getCampaign(actorId, "campaign-b")).toBeNull();
    expect(repository.listCampaigns(actorId)).toEqual([]);
    repository.close();
  });

  it("masks unknown roles and missing principal or campaign parents", () => {
    seedCampaigns();
    const db = new DatabaseDriver(databasePath());
    db.pragma("foreign_keys = OFF");
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE campaign_memberships SET role = 'admin' WHERE campaign_id = 'campaign-c' AND principal_id = ?")
      .run(actorId);
    db.prepare("DELETE FROM principals WHERE id = ?").run(actorId);
    deleteCampaignForCorruptionTest(db,"campaign-c");db.prepare("DELETE FROM campaigns WHERE id = 'campaign-c'").run();
    db.close();
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });

    expect(repository.listCampaigns(actorId)).toEqual([]);
    expect(repository.getCampaign(actorId, "campaign-c")).toBeNull();
    repository.close();
  });

  it("fails loudly for canonical-membership corruption selected by an authorized member", () => {
    seedCampaigns();
    const db = new DatabaseDriver(databasePath());
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`UPDATE campaign_memberships SET created_at = 'not-canonical'
      WHERE campaign_id = 'campaign-b' AND principal_id = ?`).run(actorId);
    db.close();
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });
    expect(() => repository.getCampaign(actorId, "campaign-b")).toThrow();
    expect(() => repository.listCampaigns(actorId)).toThrow();
    repository.close();
  });

  it("fails loudly for selected campaign corruption while masking outsiders", () => {
    seedCampaigns();
    const campaignDb = new DatabaseDriver(databasePath());
    campaignDb.pragma("ignore_check_constraints = ON");
    campaignDb.prepare("UPDATE campaigns SET name = '' WHERE id = 'campaign-c'").run();
    campaignDb.close();
    const campaignRepository = createCorruptionTestRepository({ dataDir: dataDir() });
    expect(() => campaignRepository.getCampaign(actorId, "campaign-c")).toThrow();
    expect(campaignRepository.getCampaign("missing-principal", "campaign-c")).toBeNull();
    campaignRepository.close();
  });

  it("supports active unit-of-work reads and invalidates both methods after callback return", () => {
    seedCampaigns();
    const repository = createRepository({ dataDir: dataDir() });
    let expired: RepositoryUnitOfWork | undefined;

    const result = repository.transaction((unitOfWork) => {
      expired = unitOfWork;
      expect(unitOfWork.listCampaigns(actorId)).toHaveLength(4);
      return unitOfWork.getCampaign(actorId, "campaign-c");
    });

    expect(result?.actorRole).toBe("observer");
    expect(() => expired!.listCampaigns("invalid actor")).toThrow("transaction unit of work is no longer active");
    expect(() => expired!.getCampaign("invalid actor", "invalid campaign"))
      .toThrow("transaction unit of work is no longer active");
    repository.close();
  });

  it("gives closed-repository errors precedence over validation without consuming dependencies", () => {
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({
      dataDir: dataDir(),
      ids: { nextId },
      clock: { now: clockNow },
    });
    repository.close();

    expect(() => repository.listCampaigns("invalid actor")).toThrow("repository is closed");
    expect(() => repository.getCampaign("invalid actor", "invalid campaign")).toThrow("repository is closed");
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
  });
});
