import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ORIGINAL_STARTER_BACKGROUND, ORIGINAL_STARTER_CLASS, ORIGINAL_STARTER_RACE } from "@velvet/contracts";
import {
  QuestConflictError, QuestDomainUnavailableError, QuestStaleError, createRepository,
} from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const createStoryRoot = (repo: ReturnType<typeof createRepository>, campaignId: string, storylineId: string, title: string) =>
  repo.createCampaignStorylineGraph("local-owner", campaignId, { storyline: { storylineId, title, summary: null,
    nodes: [], edges: [], plotPoints: [], clues: [] }, expectedRevision: 0, idempotencyKey: `story-${storylineId}` });

describe("M2.10 quest domain repository", () => {
  it("enforces revisioned transitions, dependencies, exact replay, and one reward claim", async () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(at) } });
    const campaign = repo.createCampaign("local-owner", { name: "Quest domain" });
    repo.installOriginalStarterContent("local-owner", campaign.id); repo.configureOriginalStarterContent("local-owner", campaign.id);
    const persona = repo.createCharacter({ name: "Hero", age: 30, archetype: "Scout", boundaries: "", fictionalConfirmed: true });
    const actorId = repo.createOriginalStarterCampaignCharacter("local-owner", { campaignId: campaign.id, characterId: persona.id,
      controllerPrincipalId: "local-owner", race: ORIGINAL_STARTER_RACE.reference, background: ORIGINAL_STARTER_BACKGROUND.reference,
      classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }], attributes: [], proficiencies: [], choices: [] }).projection.actor.id;
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite")); db.pragma("foreign_keys=ON");
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('quest-player','Quest player',0)").run();
    repo.addCampaignMembership("local-owner", campaign.id, { principalId: "quest-player", role: "player" });
    createStoryRoot(repo, campaign.id, "story", "Gate");
    const request = { quest: { questId: "gate", storylineId: "story", title: "Open the Gate", description: "GM-safe public text",
      visibility: "public" as const, journalText: "A sealed gate waits.", objectives: [
        { objectiveId: "sigils", description: "Break sigils", targetProgress: 2, dependencyObjectiveIds: [], visibility: "public" as const },
        { objectiveId: "door", description: "Open door", targetProgress: 1, dependencyObjectiveIds: ["sigils"], visibility: "public" as const },
        { objectiveId: "gm-step", description: "Secret rite", targetProgress: 1, dependencyObjectiveIds: [], visibility: "gm" as const },
      ], rewards: [
        { rewardId: "coin", kind: "currency" as const, amount: 20, label: "Coin", visibility: "public" as const },
        { rewardId: "player-coin", kind: "currency" as const, amount: 5, label: "Player coin", visibility: "public" as const },
        { rewardId: "secret", kind: "custom" as const, amount: null, label: "GM secret", visibility: "gm" as const },
      ] },
      expectedRevision: 0, idempotencyKey: "create-gate" };
    const created = repo.createCampaignQuest("local-owner", campaign.id, request);
    expect(repo.createCampaignQuest("local-owner", campaign.id, request)).toEqual(created);
    expect(() => repo.createCampaignQuest("local-owner", campaign.id, { ...request, expectedRevision: 1 })).toThrow(QuestConflictError);
    expect(created).toMatchObject({ quest: { questId: "gate", status: "offered" }, receipt: { revisionBefore: 0, revisionAfter: 1 } });
    expect(created.definition).toEqual(request.quest);
    expect(created.revision).toBe(created.receipt.revisionAfter);
    expect(created.projection).toMatchObject({ quests:[{questId:"gate"}],objectives:[
      {objectiveId:"sigils",dependencyObjectiveIds:[]},{objectiveId:"door",dependencyObjectiveIds:["sigils"]},{objectiveId:"gm-step",dependencyObjectiveIds:[]}],
      journal:[{questId:"gate",text:"A sealed gate waits."}] });
    const mixedVisibility = { ...request, quest: { ...request.quest, questId: "mixed", objectives: [
      { objectiveId: "secret-dependency", description: "Secret", targetProgress: 1, dependencyObjectiveIds: [], visibility: "gm" as const },
      { objectiveId: "public-middle", description: "Middle", targetProgress: 1, dependencyObjectiveIds: ["secret-dependency"], visibility: "public" as const },
      { objectiveId: "public-target", description: "Public", targetProgress: 1, dependencyObjectiveIds: ["public-middle"], visibility: "public" as const },
    ] }, expectedRevision: 1, idempotencyKey: "mixed" };
    expect(() => repo.createCampaignQuest("local-owner", campaign.id, mixedVisibility)).toThrow("public objectives cannot depend on GM objectives");

    const accept = { kind: "accept" as const, expectedRevision: 1, idempotencyKey: "accept" };
    expect(repo.executeQuestCommand("local-owner", "gate", accept).quest.status).toBe("active");
    expect(() => repo.executeQuestCommand("quest-player", "gate", accept)).toThrow(QuestConflictError);
    expect(() => repo.executeQuestCommand("quest-player", "gate", { kind: "advance-objective", objectiveId: "gm-step", expectedRevision: 0, idempotencyKey: "hidden-stale" }))
      .toThrow(QuestDomainUnavailableError);
    expect(() => repo.executeQuestCommand("local-owner", "gate", { kind: "advance-objective", objectiveId: "door", expectedRevision: 2, idempotencyKey: "blocked" })).toThrow(QuestConflictError);
    repo.executeQuestCommand("local-owner", "gate", { kind: "advance-objective", objectiveId: "sigils", expectedRevision: 2, idempotencyKey: "sigil-1" });
    const second = { kind: "advance-objective" as const, objectiveId: "sigils", expectedRevision: 3, idempotencyKey: "sigil-2" };
    const advanced = repo.executeQuestCommand("local-owner", "gate", second); expect(repo.executeQuestCommand("local-owner", "gate", second)).toEqual(advanced);
    expect(() => repo.executeQuestCommand("local-owner", "gate", { ...second, objectiveId: "door" })).toThrow(QuestConflictError);
    expect(() => repo.executeQuestCommand("local-owner", "gate", { kind: "advance-objective", objectiveId: "door", expectedRevision: 3, idempotencyKey: "stale" })).toThrow(QuestStaleError);
    expect(repo.executeQuestCommand("local-owner", "gate", { kind: "advance-objective", objectiveId: "door", expectedRevision: 4, idempotencyKey: "door" }).quest.status).toBe("active");
    expect(repo.executeQuestCommand("local-owner", "gate", { kind: "advance-objective", objectiveId: "gm-step", expectedRevision: 5, idempotencyKey: "gm-step" }).quest.status).toBe("completed");
    const claim = { kind: "claim-reward" as const, actorId, rewardId: "coin", expectedRevision: 6, idempotencyKey: "claim" };
    const claimed = repo.executeQuestCommand("local-owner", "gate", claim); expect(repo.executeQuestCommand("local-owner", "gate", claim)).toEqual(claimed);
    expect(claimed.quest.rewards[0]).toMatchObject({ rewardId: "coin", claimedByActorId: actorId });
    expect(() => repo.executeQuestCommand("local-owner", "gate", { ...claim, expectedRevision: 7, idempotencyKey: "claim-again" })).toThrow(QuestConflictError);
    expect(() => repo.executeQuestCommand("quest-player", "gate", { kind: "claim-reward", actorId, rewardId: "player-coin", expectedRevision: 0, idempotencyKey: "foreign-control" }))
      .toThrow(QuestDomainUnavailableError);
    db.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='quest-player' WHERE campaign_id=? AND actor_id=?").run(campaign.id, actorId);
    const playerClaim = { kind: "claim-reward" as const, actorId, rewardId: "player-coin", expectedRevision: 7, idempotencyKey: "player-claim" };
    const playerResult = repo.executeQuestCommand("quest-player", "gate", playerClaim);
    expect(playerResult.quest).not.toHaveProperty("storylineId");
    expect(playerResult.quest.rewards.map((item) => item.rewardId)).toEqual(["coin", "player-coin"]);
    expect(repo.executeQuestCommand("quest-player", "gate", playerClaim)).toEqual(playerResult);
    expect(() => repo.executeQuestCommand("local-owner", "gate", playerClaim)).toThrow(QuestConflictError);
    repo.executeQuestCommand("local-owner", "gate", { kind: "claim-reward", actorId, rewardId: "secret", expectedRevision: 8, idempotencyKey: "secret-claim" });
    expect(db.prepare("SELECT principal_id FROM quest_domain_commands_v33 WHERE idempotency_key='player-claim'").get()).toEqual({ principal_id: "quest-player" });
    expect(db.prepare("SELECT count(*) count FROM quest_reward_claims_v33").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT count(*) count FROM quest_domain_commands_v33").get()).toEqual({ count: 9 });
    expect(db.prepare(`SELECT json_extract(event_json,'$.rewardId') reward_id,json_extract(event_json,'$.actorId') actor_id
      FROM quest_domain_events_v33 event JOIN quest_domain_commands_v33 command USING(campaign_id,command_id)
      WHERE command.idempotency_key='secret-claim'`).get()).toEqual({ reward_id: "secret", actor_id: actorId });
    expect(db.prepare(`SELECT json_extract(event_json,'$.objectiveId') objective_id FROM quest_domain_events_v33 event
      JOIN quest_domain_commands_v33 command USING(campaign_id,command_id) WHERE command.idempotency_key='sigil-1'`).get()).toEqual({ objective_id: "sigils" });
    const event = db.prepare(`SELECT event.* FROM quest_domain_events_v33 event JOIN quest_domain_commands_v33 command
      USING(campaign_id,command_id) WHERE command.idempotency_key='secret-claim'`).get() as any;
    expect(() => db.prepare("INSERT INTO quest_domain_events_v33 VALUES(?,?,?,?,?,?,?)")
      .run("duplicate-event", event.campaign_id, event.command_id, event.resulting_revision, event.event_type, event.event_json, event.occurred_at)).toThrow(/UNIQUE/);
    expect(() => db.prepare("UPDATE quest_domain_commands_v33 SET command_type='accept'").run()).toThrow("quest commands are immutable");
    expect(() => db.prepare("DELETE FROM quest_domain_receipts_v33").run()).toThrow("quest receipts are immutable");
    expect(() => db.prepare("DELETE FROM quest_domain_events_v33").run()).toThrow("quest events are immutable");
    db.close(); repo.close();
  });

  it("uses role-safe projections and hides unattested legacy data from players", async () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! }); const campaign = repo.createCampaign("local-owner", { name: "Projection" });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('player','Player',0)").run();
    repo.addCampaignMembership("local-owner", campaign.id, { principalId: "player", role: "player" });
    createStoryRoot(repo, campaign.id, "legacy-story", "Legacy");
    db.prepare("INSERT INTO quests VALUES(?,?,?,?,?,?,?,?,?)").run("legacy", "legacy-story", campaign.id, "GM secret", null, "open", 0, at, at);
    expect(repo.listCampaignQuests("local-owner", campaign.id)?.quests).toHaveLength(1);
    expect(repo.listCampaignQuests("player", campaign.id)).toMatchObject({ quests: [], objectives: [], journal: [] });
    expect(repo.listCampaignQuests("outsider", campaign.id)).toBeNull(); db.close(); repo.close();
  });

  it("hides a GM quest before idempotency and stale evaluation", () => {
    const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR! }); const campaign = repo.createCampaign("local-owner", { name: "Hidden" });
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('player','Player',0)").run();
    repo.addCampaignMembership("local-owner", campaign.id, { principalId: "player", role: "player" });
    createStoryRoot(repo, campaign.id, "story", "Story");
    repo.createCampaignQuest("local-owner", campaign.id, { quest: { questId: "hidden", storylineId: "story", title: "Hidden",
      description: null, visibility: "gm", journalText: "Secret", objectives: [{ objectiveId: "secret", description: "Secret",
        targetProgress: 1, dependencyObjectiveIds: [], visibility: "gm" }], rewards: [] }, expectedRevision: 0, idempotencyKey: "hidden-create" });
    expect(() => repo.executeQuestCommand("player", "hidden", { kind: "accept", expectedRevision: 999, idempotencyKey: "hidden-probe" }))
      .toThrow(QuestDomainUnavailableError);
    expect(db.prepare("SELECT count(*) count FROM quest_domain_commands_v33").get()).toEqual({ count: 1 });
    db.close(); repo.close();
  });
});
