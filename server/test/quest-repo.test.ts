import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import {
  addClue, addReward, completeObjective, createQuest, createStoryline, getQuest, getStoryline,
  grantReward, listClues, listObjectiveCompletions, listQuests, listRewards, listStorylines,
  markClueDiscovered, reorderQuests, updateQuestStatus, updateStorylineStatus,
} from "../src/repo/questRepo.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

describe("quest repository", () => {
  it("manages storylines, quests, clues, rewards, and objectives", async () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! });
    const campaign = repo.createCampaign("local-owner", { name: "Quest fixture" });
    const character = repo.createCharacter({ name: "Scout", age: 27, archetype: "Ranger", boundaries: "", fictionalConfirmed: true });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.pragma("foreign_keys = ON");

    const storyline = await createStoryline(db, campaign.id, { id: "storyline", title: "Missing Star", description: "Find it." });
    expect(await listStorylines(db, campaign.id)).toEqual([storyline]);
    expect(await getStoryline(db, storyline.id)).toEqual(storyline);
    await updateStorylineStatus(db, storyline.id, "completed");
    expect((await getStoryline(db, storyline.id))?.status).toBe("completed");

    const first = await createQuest(db, storyline.id, campaign.id, { id: "quest-1", title: "Find chart", sortOrder: 2 });
    const second = await createQuest(db, storyline.id, campaign.id, { id: "quest-2", title: "Visit observatory", status: "active", sortOrder: 1 });
    expect(await listQuests(db, campaign.id, storyline.id)).toMatchObject([{ id: second.id }, { id: first.id }]);
    await updateQuestStatus(db, first.id, "completed");
    expect((await getQuest(db, first.id))?.status).toBe("completed");
    await reorderQuests(db, [first.id, second.id]);
    expect((await listQuests(db, campaign.id)).map((quest) => quest.id)).toEqual([first.id, second.id]);

    const clue = await addClue(db, first.id, campaign.id, "The chart bears a moon seal.");
    expect(await listClues(db, first.id)).toMatchObject([{ id: clue.id, discoveredAt: null }]);
    await markClueDiscovered(db, clue.id, character.id);
    expect((await listClues(db, first.id))[0]).toMatchObject({ discoveredByCharacterId: character.id });

    const reward = await addReward(db, first.id, campaign.id, { id: "reward", kind: "xp", amount: 100, label: "Astronomer XP" });
    expect(await listRewards(db, first.id)).toMatchObject([{ id: reward.id, grantedAt: null }]);
    await grantReward(db, reward.id, character.id);
    expect((await listRewards(db, first.id))[0]).toMatchObject({ grantedToCharacterId: character.id });

    await completeObjective(db, first.id, "Decode the chart", character.id);
    expect(await listObjectiveCompletions(db, first.id)).toMatchObject([{ description: "Decode the chart", completedByCharacterId: character.id }]);

    db.prepare("DELETE FROM quest_storylines WHERE id=?").run(storyline.id);
    expect(await listQuests(db, campaign.id)).toEqual([]);
    expect(await listClues(db, first.id)).toEqual([]);
    expect(await listRewards(db, first.id)).toEqual([]);
    db.close();
    repo.close();
  });
});
