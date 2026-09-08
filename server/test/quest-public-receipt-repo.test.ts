import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SRD_5_1_STARTER_IDENTITY } from "@velvet/contracts";
import { orchestrateAdventureTurn, type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { defaultHarnessSettings, defaultProviderSettings } from "../src/defaults.js";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";

describe("adventure quest public receipt repository", () => {
  it("returns only durable public evidence to campaign members", async () => {
    let repository = createRepository({ clock: { now: () => new Date(at) } });
    const campaign = repository.createCampaign("local-owner", { name: "Quest receipts" });
    repository.installSrdStarterCatalog("local-owner");
    repository.configureSrdStarterCatalog("local-owner", campaign.id, { expectedRevision: 0, idempotencyKey: "srd-pins" });
    repository.createCampaignStorylineGraph("local-owner", campaign.id, { storyline: { storylineId: "story", title: "Story",
      summary: null, nodes: [], edges: [], plotPoints: [], clues: [] }, expectedRevision: 0, idempotencyKey: "story-create" });
    repository.createCampaignQuest("local-owner", campaign.id, { quest: { questId: "quest", storylineId: "story",
      title: "The Sealed Gate", description: null, visibility: "public", journalText: "The seal remains.", objectives: [{
        objectiveId: "seal", description: "Break the final seal", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public",
      }], rewards: [] }, expectedRevision: 0, idempotencyKey: "quest-create" });
    repository.executeQuestCommand("local-owner", "quest", { kind: "accept", expectedRevision: 1, idempotencyKey: "quest-accept" });
    repository.close();

    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.prepare("INSERT INTO characters VALUES ('persona','Hero',30,'hero','',1,0,?)").run(at);
    db.prepare("INSERT INTO campaign_characters VALUES ('cc',?,'persona',?,?)").run(campaign.id, at, at);
    db.prepare("INSERT INTO rpg_campaign_sheets VALUES ('sheet',?,'cc',?,?, 'race','srd-5.1:race:human',?,?, 'background','srd-5.1:background:acolyte',?,?)").run(campaign.id, SRD_5_1_STARTER_IDENTITY.packId, SRD_5_1_STARTER_IDENTITY.packVersion, SRD_5_1_STARTER_IDENTITY.packId, SRD_5_1_STARTER_IDENTITY.packVersion, at, at);
    db.prepare("INSERT INTO campaign_actors VALUES ('actor',?,'cc','sheet','player-character','principal',?,?)").run(campaign.id, at, at);
    db.prepare("INSERT INTO campaign_actor_private_state VALUES ('actor',?,'local-owner',NULL)").run(campaign.id);
    db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('session','persona','Room','active','default',?)").run(at);
    db.prepare("INSERT INTO session_characters VALUES('session','persona',0)").run();
    db.prepare("INSERT INTO campaign_sessions VALUES('session',?,?)").run(campaign.id, at);
    db.close();

    repository = createRepository({ clock: { now: () => new Date(at) } });
    const turn = repository.createAdventureTurn("local-owner", { campaignId: campaign.id, timelineId: campaign.activeTimelineId,
      sessionId: "session", actorId: "actor", declaration: "I break the final seal", expectedCampaignRevision: 1,
      idempotencyKey: "quest-turn" });
    let calls = 0;
    const dependencies: AdventureAgentDependencies = { complete: async (input) => {
      calls += 1;
      if (calls === 1) {
        const tool = input.tools?.find((item) => item.name === "exact_quest_objective.select") as any;
        return { message: { role: "assistant" as const, content: null, toolCalls: [{ id: "quest-choice",
          name: "exact_quest_objective.select", arguments: JSON.stringify({ candidateId: tool.parameters.properties.candidateId.enum[0],
            digest: tool.parameters.properties.digest.enum[0] }) }] }, usage: null, model: { requestedModel: "test", responseModel: "test" } };
      }
      return { message: { role: "assistant" as const, content: null, toolCalls: [{ id: "quest-narration", name: "submit_adventure_narration",
        arguments: '{"narration":"The final seal breaks."}' }] },
        usage: null, model: { requestedModel: "test", responseModel: "test" } };
    }, getProvider: async () => ({ ...defaultProviderSettings(), model: "test" }),
      getHarness: async () => defaultHarnessSettings(), now: () => new Date(at) };
    const committed = await orchestrateAdventureTurn(repository, turn.turnId, dependencies);
    const commandId = committed.turn.receiptLinks[0]!.commandId;

    const mutable = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    mutable.prepare("UPDATE quests SET title='Changed current title' WHERE id='quest'").run();
    mutable.prepare("INSERT INTO principals VALUES('member','Member',0),('observer','Observer',0),('outsider','Outsider',0)").run();
    mutable.prepare("INSERT INTO campaign_memberships VALUES(?,'member','player',?),(?,'observer','observer',?)")
      .run(campaign.id, at, campaign.id, at);
    mutable.close();

    const expected = { questTitle: "The Sealed Gate", objectiveDescription: "Break the final seal", progressBefore: 0,
      progressAfter: 1, targetProgress: 1, objectiveCompleted: true, questCompleted: true,
      revisionBefore: 2, revisionAfter: 3, occurredAt: at };
    const receipt = repository.getAdventureQuestPublicReceipt("local-owner", campaign.id, commandId);
    expect(receipt).toEqual(expected);
    expect(repository.getAdventureQuestPublicReceipt("member", campaign.id, commandId)).toEqual(expected);
    expect(repository.getAdventureQuestPublicReceipt("observer", campaign.id, commandId)).toEqual(expected);
    expect(Object.keys(receipt!)).not.toEqual(expect.arrayContaining(["questId", "objectiveId", "commandId", "campaignId"]));
    expect(repository.getAdventureQuestPublicReceipt("outsider", campaign.id, commandId)).toBeNull();
    expect(repository.getAdventureQuestPublicReceipt("local-owner", "wrong-campaign", commandId)).toBeNull();
    expect(repository.getAdventureQuestPublicReceipt("local-owner", campaign.id, "wrong-command")).toBeNull();
    repository.close();
  });
});
