import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRepository } from "../src/repo/index.js";
import type { RepositoryUnitOfWork } from "../src/repo/index.js";
import { createCorruptionTestRepository, useTmpDataDir } from "./helpers.js";

useTmpDataDir();

function dataDir(): string {
  return process.env.VELVET_DATA_DIR as string;
}

function seedCampaign(configured: boolean): void {
  const generatedIds = ["campaign-detail", "timeline-detail"];
  const repository = createRepository({
    dataDir: dataDir(),
    ids: { nextId: () => generatedIds.shift() ?? "unexpected-id" },
    clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
  });
  repository.createCampaign("local-owner", { name: "Detail campaign" });
  if (configured) {
    for (const [packId, packVersion] of [["pack-z", "2"], ["pack-a", "1.0.0"]] as const) {
      repository.installContentPack("local-owner", {
        packId,
        packVersion,
        rulesProfileId: "rules-detail",
        name: `Pack ${packId}`,
        description: "Complete detail test pack",
        tags: [],
        rulesProfile: { name: "Detail rules", description: "Rules for detail tests", tags: [] },
        classes: [], races: [], backgrounds: [], items: [], spells: [], abilities: [], enemies: [],
      });
    }
    repository.configureCampaignContent("local-owner", "campaign-detail", {
      rulesProfileId: "rules-detail",
      contentPacks: [
        { packId: "pack-z", packVersion: "2" },
        { packId: "pack-a", packVersion: "1.0.0" },
      ],
    });
  }
  repository.close();
}

function seedDetailReaders(includeStaleOwner = false): void {
  const db = new DatabaseDriver(path.join(dataDir(), "velvet.sqlite"));
  if (includeStaleOwner) {
    db.pragma("foreign_keys = OFF");
    db.exec("DROP INDEX idx_campaign_memberships_one_owner");
  }
  for (const role of ["gm", "player", "observer"] as const) {
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES (?, ?, 0)")
      .run(`detail-${role}`, `Detail ${role}`);
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES ('campaign-detail', ?, ?, '2030-01-02T00:00:00.000Z')`).run(`detail-${role}`, role);
  }
  if (includeStaleOwner) {
    db.prepare("INSERT INTO principals (id, display_name, is_local) VALUES ('detail-stale-owner', 'Stale owner', 0)").run();
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES ('campaign-detail', 'detail-stale-owner', 'owner', '2030-01-02T00:00:00.000Z')`).run();
    db.prepare(`INSERT INTO campaign_memberships (campaign_id, principal_id, role, created_at)
      VALUES ('campaign-detail', 'detail-orphan-reader', 'gm', '2030-01-02T00:00:00.000Z')`).run();
  }
  db.close();
}

describe("campaign detail aggregate query", () => {
  it("distinguishes denied and missing campaigns from an authorized unconfigured campaign", () => {
    seedCampaign(false);
    const repository = createRepository({ dataDir: dataDir() });

    expect(repository.getCampaignDetail("local-owner", "campaign-detail")).toEqual({
      id: "campaign-detail",
      name: "Detail campaign",
      actorRole: "owner",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
      content: { status: "unconfigured" },
    });
    expect(repository.getCampaignDetail("missing-principal", "campaign-detail")).toBeNull();
    expect(repository.getCampaignDetail("local-owner", "campaign-missing")).toBeNull();
    repository.close();
  });

  it("returns only minimal fields with a validated complete configuration in deterministic pack order", () => {
    seedCampaign(true);
    const repository = createRepository({ dataDir: dataDir() });

    const detail = repository.getCampaignDetail("local-owner", "campaign-detail");
    expect(detail).toEqual({
      id: "campaign-detail",
      name: "Detail campaign",
      actorRole: "owner",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:00:00.000Z",
      content: {
        status: "configured",
        rulesProfileId: "rules-detail",
        contentPacks: [
          { packId: "pack-a", packVersion: "1.0.0" },
          { packId: "pack-z", packVersion: "2" },
        ],
      },
    });
    expect(detail).not.toHaveProperty("ownerPrincipalId");
    expect(detail).not.toHaveProperty("activeTimelineId");
    repository.close();
  });

  it("preserves identical detail access for every non-owner membership role", () => {
    seedCampaign(false);
    seedDetailReaders();
    const repository = createRepository({ dataDir: dataDir() });

    for (const role of ["gm", "player", "observer"] as const) {
      expect(repository.getCampaignDetail(`detail-${role}`, "campaign-detail")).toMatchObject({
        id: "campaign-detail",
        actorRole: role,
        content: { status: "unconfigured" },
      });
    }
    repository.close();
  });

  it("fails owner corruption before content composition for every authorized role while masking others", () => {
    seedCampaign(true);
    seedDetailReaders(true);
    const db = new DatabaseDriver(path.join(dataDir(), "velvet.sqlite"));
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`UPDATE campaign_memberships SET created_at = 'not-canonical'
      WHERE campaign_id = 'campaign-detail' AND principal_id = 'local-owner'`).run();
    db.close();
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });

    for (const role of ["gm", "player", "observer"] as const) {
      expect(() => repository.getCampaignDetail(`detail-${role}`, "campaign-detail"))
        .toThrow("campaign owner authorization is malformed");
    }
    expect(repository.getCampaignDetail("missing-principal", "campaign-detail")).toBeNull();
    expect(repository.getCampaignDetail("detail-stale-owner", "campaign-detail")).toBeNull();
    expect(repository.getCampaignDetail("detail-orphan-reader", "campaign-detail")).toBeNull();
    repository.close();
  });

  it("fails loudly when an authorized selected configuration graph is incomplete", () => {
    seedCampaign(true);
    const db = new DatabaseDriver(path.join(dataDir(), "velvet.sqlite"));
    db.pragma("foreign_keys = OFF");
    db.exec("DROP TRIGGER rpg_content_packs_prevent_delete");
    db.prepare("DELETE FROM rpg_content_packs WHERE pack_id = 'pack-a' AND pack_version = '1.0.0'").run();
    db.close();
    const repository = createCorruptionTestRepository({ dataDir: dataDir() });

    expect(() => repository.getCampaignDetail("local-owner", "campaign-detail"))
      .toThrow("campaign content configuration is malformed");
    expect(repository.getCampaignDetail("missing-principal", "campaign-detail")).toBeNull();
    repository.close();
  });

  it("composes authorization and content reads in one factory snapshot and the active unit of work", () => {
    seedCampaign(false);
    const repository = createRepository({ dataDir: dataDir() });
    const transaction = vi.spyOn(DatabaseDriver.prototype, "transaction");
    const prepare = vi.spyOn(DatabaseDriver.prototype, "prepare");
    let expired: RepositoryUnitOfWork | undefined;
    try {
      expect(repository.getCampaignDetail("local-owner", "campaign-detail")?.content)
        .toEqual({ status: "unconfigured" });
      expect(transaction).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledTimes(2);

      transaction.mockClear();
      prepare.mockClear();
      const inside = repository.transaction((unitOfWork) => {
        expired = unitOfWork;
        return unitOfWork.getCampaignDetail("local-owner", "campaign-detail");
      });
      expect(inside?.id).toBe("campaign-detail");
      expect(transaction).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledTimes(2);
      expect(() => expired!.getCampaignDetail("local-owner", "campaign-detail"))
        .toThrow("transaction unit of work is no longer active");
    } finally {
      transaction.mockRestore();
      prepare.mockRestore();
      repository.close();
    }
  });

  it("validates IDs after lifecycle guards without consuming dependencies", () => {
    const nextId = vi.fn(() => "unused");
    const clockNow = vi.fn(() => new Date());
    const repository = createRepository({ dataDir: dataDir(), ids: { nextId }, clock: { now: clockNow } });
    expect(() => repository.getCampaignDetail("invalid actor", "invalid campaign")).toThrow();
    expect(nextId).not.toHaveBeenCalled();
    expect(clockNow).not.toHaveBeenCalled();
    repository.close();
    expect(() => repository.getCampaignDetail("invalid actor", "invalid campaign")).toThrow("repository is closed");
  });
});
