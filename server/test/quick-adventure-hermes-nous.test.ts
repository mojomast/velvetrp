// Approved test (Hermes/Nous quick adventure): the quick-adventure builder is no longer hard-wired to the
// Sintermark world and its two heroes (Tessel and Orra). A second bundled adventure, "hermes-nous", builds the
// reviewed Hermes Agent Squad world with its own six-hero party, provider-free, while the default stays Sintermark.
import Database from "better-sqlite3";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import heroesJson from "../src/quickstart/recipes/hermes-nous-party.json" with { type: "json" };
import worldJson from "../src/quickstart/recipes/hermes-nous-world.json" with { type: "json" };
import { listQuickAdventures } from "../src/quickstart/quickAdventureCatalog.js";
import { createQuickAdventure, QUICK_ADVENTURE_CAMPAIGN_NAME } from "../src/quickstart/quickAdventure.js";
import { closeRepo, createRepository } from "../src/repo/index.js";
import { listMessages } from "../src/repo/messageRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
afterEach(() => vi.restoreAllMocks());

const OWNER = "local-owner";
const HERMES_NAME = "Hermes Agent Squad: We Never Surrender";
const HERMES_HEROES = ["Teknium", "Sovthpaw", "Nous Girl", "Don Piedro", "Heartbreaker", "Doge Man"];

function count(sql: string, campaignId: string): number {
  const db = new Database(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
  try {
    return (db.prepare(sql).get(campaignId) as { n: number }).n;
  } finally {
    db.close();
  }
}

describe("quick adventure catalog", () => {
  it("lists Sintermark first (the default) and the Hermes/Nous adventure with its six heroes", () => {
    const adventures = listQuickAdventures();
    expect(adventures.map((adventure) => adventure.id)).toEqual(["sintermark", "hermes-nous"]);
    expect(adventures[0]!.name).toBe(QUICK_ADVENTURE_CAMPAIGN_NAME);
    expect(adventures[0]!.heroes).toEqual(["Tessel Venn", "Orra Staple"]);
    expect(adventures[1]!.name).toBe(HERMES_NAME);
    expect(adventures[1]!.heroes).toEqual(HERMES_HEROES);
  });

  it("bundles the reviewed world and party data unchanged", () => {
    expect((worldJson as { name: string }).name).toBe(HERMES_NAME);
    expect((heroesJson as { heroes: Array<{ name: string }> }).heroes.map((hero) => hero.name)).toEqual(HERMES_HEROES);
  });
});

describe("createQuickAdventure with an adventure id", () => {
  it("builds the Hermes/Nous world with all six heroes into a new published campaign", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const repository = createRepository();
    try {
      const result = await createQuickAdventure({ repository, ownerId: OWNER, adventureId: "hermes-nous" });
      expect(result.campaignName).toBe(HERMES_NAME);
      expect(result.heroes.map((hero) => hero.name)).toEqual(HERMES_HEROES);
      expect(result.actorId).toBe(result.heroes[0]!.actorId);
      expect(repository.listCampaignCharacters(OWNER, result.campaignId)).toHaveLength(6);
      expect(repository.getCampaignAdministration(OWNER, result.campaignId)?.status).toBe("published");
      expect(repository.getSession(result.sessionId)?.state).toBe("active");
      expect(
        count(
          "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=? AND visibility='public'",
          result.campaignId,
        ),
      ).toBe(19);
      expect(count("SELECT count(*) n FROM campaign_npcs_v28 WHERE campaign_id=?", result.campaignId)).toBe(35);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      repository.close();
      closeRepo();
    }
  }, 120_000);

  it("opens the Hermes room with the world's own opening and no Sintermark hero lines", async () => {
    const repository = createRepository();
    try {
      const result = await createQuickAdventure({ repository, ownerId: OWNER, adventureId: "hermes-nous" });
      const messages = await listMessages(result.sessionId);
      expect(messages[0]?.content).toBe((worldJson as { opening: string }).opening);
      const text = messages.map((message) => message.content).join("\n");
      expect(text).not.toMatch(/\bOrra\b|\bTessel\b|Sintermark/);
      expect(messages.some((message) => message.role === "character")).toBe(true);
    } finally {
      repository.close();
      closeRepo();
    }
  }, 120_000);

  it("keeps Sintermark as the default and when asked for explicitly", async () => {
    const repository = createRepository();
    try {
      const implicit = await createQuickAdventure({ repository, ownerId: OWNER });
      const explicit = await createQuickAdventure({ repository, ownerId: OWNER, adventureId: "sintermark" });
      for (const result of [implicit, explicit]) {
        expect(result.campaignName).toBe(QUICK_ADVENTURE_CAMPAIGN_NAME);
        expect(result.heroes.map((hero) => hero.name)).toEqual(["Tessel Venn", "Orra Staple"]);
        expect(
          count(
            "SELECT count(*) n FROM campaign_locations_v28 WHERE campaign_id=? AND visibility='public'",
            result.campaignId,
          ),
        ).toBe(26);
      }
    } finally {
      repository.close();
      closeRepo();
    }
  }, 120_000);

  it("rejects an unknown adventure id before creating any campaign", async () => {
    const repository = createRepository();
    try {
      const before = repository.listCampaigns(OWNER).length;
      await expect(
        createQuickAdventure({ repository, ownerId: OWNER, adventureId: "no-such-world" as never }),
      ).rejects.toThrow(/unknown quick adventure/i);
      expect(repository.listCampaigns(OWNER).length).toBe(before);
    } finally {
      repository.close();
      closeRepo();
    }
  });
});
