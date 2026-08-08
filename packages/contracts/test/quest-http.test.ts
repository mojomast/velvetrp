import { describe, expect, it } from "vitest";
import {
  campaignQuestsHttpResponseSchema,
  createCampaignQuestHttpRequestSchema,
  createCampaignQuestHttpResponseSchema,
  questCommandHttpRequestSchema,
  playerCampaignQuestsHttpResponseSchema,
} from "../src/index.js";

const envelope = { expectedRevision: 0, idempotencyKey: "quest-key" };
const quest = { questId: "quest", storylineId: "story", title: "The Gate", description: null,
  visibility: "public" as const, journalText: "A gate bars the road.",
  objectives: [{ objectiveId: "open", description: "Open it", targetProgress: 1,
    dependencyObjectiveIds: [], visibility: "public" as const }],
  rewards: [{ rewardId: "gold", kind: "currency" as const, amount: 10, label: "Gold", visibility: "public" as const }] };

describe("M2.10 quest HTTP contracts", () => {
  it("accepts strict quest definitions and rejects dependency mistakes", () => {
    expect(createCampaignQuestHttpRequestSchema.parse({ quest, ...envelope })).toEqual({ quest, ...envelope });
    expect(createCampaignQuestHttpRequestSchema.safeParse({ quest, ...envelope, extra: true }).success).toBe(false);
    expect(createCampaignQuestHttpRequestSchema.safeParse({ quest: { ...quest, objectives: [
      { ...quest.objectives[0], dependencyObjectiveIds: ["missing"] },
    ] }, ...envelope }).success).toBe(false);
    expect(createCampaignQuestHttpRequestSchema.safeParse({ quest: { ...quest, objectives: [
      { ...quest.objectives[0], objectiveId: "secret", visibility: "gm" },
      { ...quest.objectives[0], objectiveId: "middle", dependencyObjectiveIds: ["secret"] },
      { ...quest.objectives[0], objectiveId: "public", dependencyObjectiveIds: ["middle"] },
    ] }, ...envelope }).success).toBe(false);
  });

  it("requires command-specific IDs, including actor and reward for claims", () => {
    expect(questCommandHttpRequestSchema.safeParse({ kind: "accept", ...envelope }).success).toBe(true);
    expect(questCommandHttpRequestSchema.safeParse({ kind: "advance-objective", ...envelope }).success).toBe(false);
    expect(questCommandHttpRequestSchema.safeParse({ kind: "claim-reward", rewardId: "gold", ...envelope }).success).toBe(false);
    expect(questCommandHttpRequestSchema.safeParse({ kind: "claim-reward", actorId: "actor", rewardId: "gold", ...envelope }).success).toBe(true);
  });

  it("binds the exact list body and rejects internal provenance", () => {
    expect(campaignQuestsHttpResponseSchema.safeParse({ quests: [], objectives: [], journal: [] }).success).toBe(true);
    expect(campaignQuestsHttpResponseSchema.safeParse({ quests: [], objectives: [], journal: [], revision: 0 }).success).toBe(false);
  });
  it("binds a durable creation projection to its receipt revision",()=>{
    const at="2035-01-01T00:00:00.000Z",projected={questId:"quest",campaignId:"campaign",storylineId:"story",title:"The Gate",description:null,status:"offered",
      rewards:[{rewardId:"gold",kind:"currency",amount:10,label:"Gold",claimedByActorId:null,claimedAt:null}],createdAt:at,updatedAt:at};
    const response={quest:projected,definition:quest,projection:{quests:[projected],objectives:[{objectiveId:"open",questId:"quest",description:"Open it",targetProgress:1,progress:0,dependencyObjectiveIds:[],completedAt:null}],journal:[{entryId:"entry",questId:"quest",text:quest.journalText,occurredAt:at}]},revision:1,receipt:{idempotencyKey:"quest-key",revisionBefore:0,revisionAfter:1,occurredAt:at}};
    expect(createCampaignQuestHttpResponseSchema.safeParse(response).success).toBe(true);
    expect(createCampaignQuestHttpResponseSchema.safeParse({...response,revision:2}).success).toBe(false);
  });
  it("structurally omits storyline ancestry from player quest projections", () => {
    const playerQuest = { questId: "quest", campaignId: "campaign", title: "Gate", description: null, status: "offered",
      rewards: [], createdAt: "2035-01-01T00:00:00.000Z", updatedAt: "2035-01-01T00:00:00.000Z" };
    expect(playerCampaignQuestsHttpResponseSchema.safeParse({ quests: [playerQuest], objectives: [], journal: [] }).success).toBe(true);
    expect(playerCampaignQuestsHttpResponseSchema.safeParse({ quests: [{ ...playerQuest, storylineId: "hidden" }], objectives: [], journal: [] }).success).toBe(false);
  });
});
