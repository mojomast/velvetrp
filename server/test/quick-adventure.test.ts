// Approved test for plan 1.6 (Quick adventure, option A): the provider-free Sintermark world
// builder runs into the owner's real, non-empty database as a new campaign, never touches
// existing data, can run any number of times, never calls a model provider, and is fast.
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeRepo, createCharacter, createRepository, listCharacters } from "../src/repo/index.js";
import {
  createQuickAdventure,
  QUICK_ADVENTURE_CAMPAIGN_NAME,
  QuickAdventureError,
} from "../src/quickstart/quickAdventure.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
afterEach(() => vi.restoreAllMocks());

const OWNER = "local-owner";

function openRaw(): Database.Database {
  return new Database(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
}

/** Every row of every table that is scoped to one campaign, plus the campaign row itself. */
function campaignSnapshot(campaignId: string): Record<string, unknown[]> {
  const db = openRaw();
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const snapshot: Record<string, unknown[]> = {};
    for (const { name } of tables) {
      const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      );
      if (columns.includes("campaign_id")) {
        const rows = db.prepare(`SELECT * FROM "${name}" WHERE campaign_id=? ORDER BY rowid`).all(campaignId);
        if (rows.length > 0) snapshot[name] = rows;
      }
    }
    snapshot.campaigns = db.prepare("SELECT * FROM campaigns WHERE id=?").all(campaignId);
    return snapshot;
  } finally {
    db.close();
  }
}

function integrity(): { quick: unknown; foreignKeys: unknown[] } {
  const db = openRaw();
  try {
    return {
      quick: db.pragma("quick_check", { simple: true }),
      foreignKeys: db.pragma("foreign_key_check") as unknown[],
    };
  } finally {
    db.close();
  }
}

function publicLocations(campaignId: string): number {
  const db = openRaw();
  try {
    return (
      db
        .prepare("SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=? AND visibility='public'")
        .get(campaignId) as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

describe("createQuickAdventure", () => {
  it("builds a new, playable campaign next to existing user data without modifying it", async () => {
    const repository = createRepository();
    try {
      const existing = repository.createCampaign(OWNER, { name: "My own campaign" });
      repository.installSrdStarterCatalog(OWNER);
      repository.configureSrdStarterCatalog(OWNER, existing.id, {
        expectedRevision: 0,
        idempotencyKey: "user-catalog",
      });
      await createCharacter({
        name: "Existing Hero",
        age: 30,
        archetype: "ranger",
        boundaries: "",
        fictionalConfirmed: true,
      });
      const charactersBefore = await listCharacters();
      const before = campaignSnapshot(existing.id);

      const started = performance.now();
      const result = await createQuickAdventure({ repository, ownerId: OWNER });
      expect(performance.now() - started).toBeLessThan(15_000);

      expect(result.campaignId).not.toBe(existing.id);
      expect(result.campaignName).toBe(QUICK_ADVENTURE_CAMPAIGN_NAME);
      expect(repository.getCampaignAdministration(OWNER, result.campaignId)?.status).toBe("published");
      expect(repository.getSession(result.sessionId)?.state).toBe("active");
      const party = repository.listCampaignCharacters(OWNER, result.campaignId);
      expect(party).toHaveLength(2);
      expect(result.heroes.map((hero) => hero.actorId)).toContain(result.actorId);
      expect(publicLocations(result.campaignId)).toBe(26);

      expect(campaignSnapshot(existing.id)).toEqual(before);
      const charactersAfter = await listCharacters();
      for (const character of charactersBefore) expect(charactersAfter).toContainEqual(character);
      expect(integrity()).toEqual({ quick: "ok", foreignKeys: [] });
    } finally {
      repository.close();
      closeRepo();
    }
  });

  it("creates a separate, independent adventure each time it runs", async () => {
    const repository = createRepository();
    try {
      const first = await createQuickAdventure({ repository, ownerId: OWNER });
      const firstSnapshot = campaignSnapshot(first.campaignId);
      const second = await createQuickAdventure({ repository, ownerId: OWNER });

      expect(second.campaignId).not.toBe(first.campaignId);
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.heroes.map((hero) => hero.actorId)).not.toEqual(first.heroes.map((hero) => hero.actorId));
      for (const result of [first, second]) {
        expect(repository.getCampaignAdministration(OWNER, result.campaignId)?.status).toBe("published");
        expect(repository.getSession(result.sessionId)?.state).toBe("active");
        expect(publicLocations(result.campaignId)).toBe(26);
      }
      expect(campaignSnapshot(first.campaignId)).toEqual(firstSnapshot);
      expect(integrity()).toEqual({ quick: "ok", foreignKeys: [] });
    } finally {
      repository.close();
      closeRepo();
    }
  });

  it("never contacts a model provider and leaves process state alone", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const dataDir = process.env.VELVET_DATA_DIR;
    const filesBefore = new Set(readdirSync(dataDir!));
    const repository = createRepository();
    try {
      await createQuickAdventure({ repository, ownerId: OWNER });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(process.env.VELVET_DATA_DIR).toBe(dataDir);
      // No report or scratch files are written next to the user's database.
      const added = readdirSync(dataDir!).filter(
        (name) => !filesBefore.has(name) && !/^velvet\.sqlite(-wal|-shm|-journal)?$/.test(name),
      );
      expect(added).toEqual([]);
    } finally {
      repository.close();
      closeRepo();
    }
  });

  it("fails with a clear, step-named error and leaves no half-built campaign visible", async () => {
    const repository = createRepository();
    try {
      const existing = repository.createCampaign(OWNER, { name: "Keep me" });
      const visible = () =>
        repository
          .listCampaigns(OWNER)
          .map((campaign) => campaign.id)
          .filter((id) => repository.getCampaignAdministration(OWNER, id)?.status !== "archived");
      const listedBefore = visible();
      vi.spyOn(repository, "activateCampaignRoom").mockImplementation(() => {
        throw new Error("simulated storage failure");
      });

      const failure = await createQuickAdventure({ repository, ownerId: OWNER }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(QuickAdventureError);
      expect((failure as QuickAdventureError).step).toMatch(/^[a-z][a-z-]+$/);
      expect((failure as QuickAdventureError).message).toContain((failure as QuickAdventureError).step);
      expect((failure as QuickAdventureError).message).toContain("simulated storage failure");

      // The partial campaign is archived, so the library shows exactly what it showed before.
      expect(visible()).toEqual(listedBefore);
      expect(repository.listCampaigns(OWNER).length).toBe(listedBefore.length + 1);
      expect(repository.getCampaignAdministration(OWNER, existing.id)?.status).not.toBe("archived");
      expect(integrity()).toEqual({ quick: "ok", foreignKeys: [] });
    } finally {
      repository.close();
      closeRepo();
    }
  });
});
