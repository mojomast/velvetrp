import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { QuestUnavailableError, createQuestRepository, getQuest, getStoryline, listClues, listObjectiveCompletions, listQuests, listRewards, listStorylines } from "../src/repo/questRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";

describe("legacy quest read compatibility", () => {
  it("reads preserved v29 rows without exposing a production mutation bypass", async () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    const campaign = repo.createCampaign("local-owner", { name: "Legacy quest fixture" });
    repo.createCampaignStorylineGraph("local-owner", campaign.id, { storyline: { storylineId: "storyline", title: "Missing Star",
      summary: "Find it.", nodes: [], edges: [], plotPoints: [], clues: [] }, expectedRevision: 0, idempotencyKey: "storyline" });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite")); db.pragma("foreign_keys=ON");
    db.prepare("INSERT INTO quests VALUES(?,?,?,?,?,?,?,?,?)").run("quest", "storyline", campaign.id,
      "Find chart", null, "open", 0, at, at);
    db.prepare("INSERT INTO quest_clues VALUES(?,?,?,?,?,?,?)").run("clue", "quest", campaign.id, "Moon seal", null, null, at);
    db.prepare("INSERT INTO quest_rewards(id,quest_id,campaign_id,kind,amount,label,created_at) VALUES(?,?,?,?,?,?,?)")
      .run("reward", "quest", campaign.id, "xp", 100, "Astronomer XP", at);
    db.prepare("INSERT INTO quest_objective_completions VALUES(?,?,?,?,?)").run("completion", "quest", "Decode", null, at);
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('reader','Reader',0)").run();
    repo.addCampaignMembership("local-owner", campaign.id, { principalId: "reader", role: "player" });

    expect(await listStorylines(db, campaign.id)).toMatchObject([{ id: "storyline" }]);
    expect(await getStoryline(db, "storyline")).toMatchObject({ campaignId: campaign.id });
    expect(await listQuests(db, campaign.id)).toMatchObject([{ id: "quest" }]);
    expect(await getQuest(db, "quest")).toMatchObject({ title: "Find chart" });
    expect(await listClues(db, "quest")).toMatchObject([{ id: "clue" }]);
    expect(await listRewards(db, "quest")).toMatchObject([{ id: "reward" }]);
    expect(await listObjectiveCompletions(db, "quest")).toMatchObject([{ id: "completion" }]);
    const playerReads = createQuestRepository(db, "reader");
    await expect(playerReads.listStorylines(campaign.id)).rejects.toBeInstanceOf(QuestUnavailableError);
    await expect(playerReads.getStoryline(campaign.id, "storyline")).rejects.toBeInstanceOf(QuestUnavailableError);
    for (const method of ["createQuest", "updateQuest", "createReward", "grantReward", "completeObjective", "createClue"]) {
      expect(method in repo).toBe(false);
    }
    db.close(); repo.close();
  });
});
