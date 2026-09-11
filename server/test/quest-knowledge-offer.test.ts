import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentObservationRepository } from "../src/repo/observations/agentObservationRepo.js";
import { QuestDomainUnavailableError, createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at = "2035-01-01T00:00:00.000Z";
const dbPath = () => path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");

function fixture() {
  const repo = createRepository({ dataDir: process.env.VELVET_DATA_DIR!, clock: { now: () => new Date(at) } });
  const campaign = repo.createCampaign("local-owner", { name: "Quest offers" });
  repo.createCampaignStorylineGraph("local-owner", campaign.id, {
    storyline: { storylineId: "story", title: "Rumor arc", summary: null, nodes: [], edges: [], plotPoints: [], clues: [] },
    expectedRevision: 0, idempotencyKey: "story-story",
  });
  return { repo, campaign };
}

const offer = (questId: string) => ({
  quest: {
    questId, storylineId: "story", title: `Quest ${questId}`, description: null, visibility: "public" as const,
    journalText: "Offered", objectives: [{
      objectiveId: `${questId}-objective`, description: "Do it", targetProgress: 1, dependencyObjectiveIds: [], visibility: "public" as const,
    }], rewards: [],
  }, expectedRevision: 0, idempotencyKey: `create-${questId}`,
});

function recordKnowledge(campaign: { id: string; activeTimelineId: string }, sourceCommandId: string) {
  const db = new DatabaseDriver(dbPath());
  db.pragma("foreign_keys=ON");
  let idc = 0;
  createAgentObservationRepository(db, { clock: { now: () => new Date(at) }, ids: { nextId: () => `offer-obs-${++idc}` } })
    .record({
      campaignId: campaign.id, timelineId: campaign.activeTimelineId, agentKind: "faction", agentId: "faction-guild",
      sourceCommandId, observedRevision: 1, channel: "witnessed", hopCount: 0,
      text: "A skirmish broke out at the gate.", authority: "verified",
    });
  db.close();
}

describe("knowledge-gated quest offers", () => {
  it("creates a GM-authored offer only when the named observation exists and durably names it", () => {
    const { repo, campaign } = fixture();
    recordKnowledge(campaign, "check-command:1");
    const knowledgeSource = { agentKind: "faction" as const, agentId: "faction-guild", sourceCommandId: "check-command:1" };
    const input = { offer: offer("gated"), knowledgeSource };
    const result = repo.createKnowledgeGatedQuestOffer("local-owner", campaign.id, input);
    expect(result.quest).toMatchObject({ questId: "gated", status: "offered" });
    expect(result.knowledgeSource).toEqual(knowledgeSource);

    const db = new DatabaseDriver(dbPath());
    const stored = db.prepare(`SELECT canonical_request_json FROM quest_domain_commands_v33
      WHERE campaign_id=? AND quest_id='gated' AND command_type='create'`)
      .get(campaign.id) as { canonical_request_json: string };
    db.close();
    expect(JSON.parse(stored.canonical_request_json).knowledgeSource).toEqual(knowledgeSource);

    expect(repo.createKnowledgeGatedQuestOffer("local-owner", campaign.id, input)).toEqual(result);
    repo.close();
  });

  it("refuses an offer whose knowledge source has no persisted observation", () => {
    const { repo, campaign } = fixture();
    expect(() => repo.createKnowledgeGatedQuestOffer("local-owner", campaign.id, {
      offer: offer("ungated"),
      knowledgeSource: { agentKind: "npc", agentId: "npc-missing", sourceCommandId: "check-command:missing" },
    })).toThrow(QuestDomainUnavailableError);
    const db = new DatabaseDriver(dbPath());
    const quest = db.prepare("SELECT 1 FROM quests WHERE id='ungated'").get();
    db.close();
    expect(quest).toBeUndefined();
    repo.close();
  });
});
