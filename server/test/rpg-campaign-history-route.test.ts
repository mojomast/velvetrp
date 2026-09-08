import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { campaignHistoryHttpRoutes } from "../src/routes/rpg/v1/campaignHistory.js";

const at = "2030-01-01T00:00:00.000Z";
const mechanicReceipt = {
  commandId: "command", campaignId: "campaign", revisionBefore: 0, revisionAfter: 1,
  events: [{ eventId: "event", commandId: "command", campaignId: "campaign", timelineId: "timeline",
    actorId: "actor", sourceTurnId: "private-turn", type: "actor_attribute_set" as const,
    revision: 1, occurredAt: at, data: { attributeId: "strength", valueBefore: 10, valueAfter: 12 } }],
};
const administrationReceipt = {
  commandId: "admin-command", campaignId: "campaign", type: "recap_created" as const,
  revisionBefore: 1, revisionAfter: 2, occurredAt: at,
  events: [{ eventId: "admin-event", commandId: "admin-command", campaignId: "campaign",
    type: "recap_created" as const, revision: 2, occurredAt: at,
    data: { timelineId: "timeline", text: "must never cross" } }],
};
function setup() {
  const repo = {
    getAdventureInventoryPublicReceipt:vi.fn(()=>null as any),
    getAdventureCommercePublicReceipt:vi.fn(()=>null as any),
    getAdventureCheckPublicReceipt:vi.fn(()=>null as any),
    getAdventurePowerPublicReceipt:vi.fn(()=>null as any),getAdventureRestPublicReceipt:vi.fn(()=>null as any),
    getAdventureCombatConsumablePublicReceipt:vi.fn(()=>null as any),
    getCommandReceipt: vi.fn(() => mechanicReceipt),
    getAgentCombatReceipt:vi.fn(()=>null as any),
    getExactCandidateTravelPublicReceipt:vi.fn(()=>null as any),
    getAdventureQuestPublicReceipt:vi.fn(()=>null as any),
    getAdventureQuestLifecyclePublicReceipt:vi.fn(()=>null as any),getAdventureProgressionPublicReceipt:vi.fn(()=>null as any),
    getCampaignAdministrationReceipt: vi.fn(() => null as typeof administrationReceipt | null),
    listCampaignTimelineHistory: vi.fn(() => []), listPublicCampaignEvents: vi.fn(),
    createCampaignCheckpoint: vi.fn(), listCampaignCheckpoints: vi.fn(), forkCampaignTimeline: vi.fn(),
    createCampaignRecap: vi.fn(), listCampaignRecaps: vi.fn(),
  };
  const app = Fastify(); app.register(campaignHistoryHttpRoutes, { prefix: "/api/rpg/v1", campaignHistoryRepositoryAccessor: () => repo as never });
  return { app, repo };
}
afterEach(() => { delete process.env.FEATURE_RPG_CAMPAIGN; });

describe("campaign history receipt route", () => {
  it("returns exact combat consumable outcomes without private bindings",async()=>{process.env.FEATURE_RPG_CAMPAIGN="true";const{app,repo}=setup();repo.getAdventureCombatConsumablePublicReceipt.mockReturnValue({itemName:"Fire Tonic",target:"Gloam Mite",quantity:1,actionCost:"action",outcomes:[{kind:"damage",damageType:"fire",roll:{expression:"1d4",normalized:{count:1,sides:4,modifier:0,selection:{type:"all"}},terms:[{value:3,kept:true}],modifier:0,total:3},requested:3,adjustment:"resistance",applied:1,before:8,after:7}],roundBefore:1,roundAfter:1,revisionBefore:2,revisionAfter:3,occurredAt:at,candidateId:"private",combatantId:"private"});const response=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/commands/combat-item-command/receipt"});expect(response.statusCode).toBe(200);expect(response.json().receipt).toMatchObject({kind:"combat-consumable",itemName:"Fire Tonic",target:"Gloam Mite",outcomes:[{roll:{total:3},adjustment:"resistance",applied:1}]});expect(response.body).not.toMatch(/combat-item-command|private|candidateId|combatantId|actorId|entryId|definitionId|digest/);await app.close();});
  it("returns redacted power and rest receipts",async()=>{process.env.FEATURE_RPG_CAMPAIGN="true";for(const kind of ["power","rest"]as const){const{app,repo}=setup();if(kind==="power")repo.getAdventurePowerPublicReceipt.mockReturnValue({powerName:"Sheltering Glow",targets:["Briar"],costs:[{label:"Level 1 spell slot",before:1,after:0}],stateDeltas:[{actor:"Briar",change:"Effect applied",before:null,after:null}],concentration:true,revisionBefore:0,revisionAfter:1,occurredAt:at,actorId:"private"});else repo.getAdventureRestPublicReceipt.mockReturnValue({restKind:"short",restName:"Short rest",recovery:[{label:"Focus",before:0,after:2}],revisionBefore:0,revisionAfter:1,occurredAt:at,resourceId:"private"});const response=await app.inject({method:"GET",url:`/api/rpg/v1/campaigns/campaign/commands/${kind}-command/receipt`});expect(response.statusCode).toBe(200);expect(response.json().receipt.kind).toBe(kind);expect(response.body).not.toMatch(/private|actorId|resourceId|commandId/);await app.close();}});
  it("returns a redacted public inventory receipt",async()=>{process.env.FEATURE_RPG_CAMPAIGN="true";const{app,repo}=setup();
    repo.getAdventureInventoryPublicReceipt.mockReturnValue({itemLabel:"Waylamp",action:"gift",quantity:1,slot:null,recipient:"Briar",revisionBefore:2,revisionAfter:3,occurredAt:at,
      candidateId:"private",entryId:"private",providerCallId:"private"});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/commands/inventory-command/receipt"});expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({receipt:{kind:"inventory",itemLabel:"Waylamp",action:"gift",quantity:1,slot:null,recipient:"Briar",revisionBefore:2,revisionAfter:3,occurredAt:at}});
    expect(response.body).not.toMatch(/inventory-command|candidateId|entryId|providerCallId/);await app.close();});
  it("returns a strict public commerce receipt",async()=>{process.env.FEATURE_RPG_CAMPAIGN="true";const{app,repo}=setup();repo.getAdventureCommercePublicReceipt.mockReturnValue({action:"sell",vendorLabel:"Mara",shopLabel:"Mara's Goods",itemLabel:"Waylamp",quantity:1,currencyLabel:"Glimmer",priceMinorUnits:4,debitMinorUnits:0,creditMinorUnits:4,balanceBefore:30,balanceAfter:34,revisionBefore:0,revisionAfter:1,occurredAt:at,npcId:"private",shopId:"private",entryId:"private",candidateId:"private"});const response=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/commands/commerce-command/receipt"});expect(response.statusCode).toBe(200);expect(response.json()).toEqual({receipt:{kind:"commerce",action:"sell",vendorLabel:"Mara",shopLabel:"Mara's Goods",itemLabel:"Waylamp",quantity:1,currencyLabel:"Glimmer",priceMinorUnits:4,debitMinorUnits:0,creditMinorUnits:4,balanceBefore:30,balanceAfter:34,revisionBefore:0,revisionAfter:1,occurredAt:at}});expect(response.body).not.toMatch(/commerce-command|private|npcId|shopId|entryId|candidateId/);await app.close();});
  it("returns a strict public SRD check receipt without private binding identities",async()=>{
    process.env.FEATURE_RPG_CAMPAIGN="true";const{app,repo}=setup();repo.getAdventureCheckPublicReceipt.mockReturnValue({checkKind:"skill",ability:"Wisdom",skill:"Perception",
      mode:"advantage",difficulty:"Hard",rolls:[{value:7,kept:false},{value:18,kept:true}],abilityModifier:2,proficiencyBonus:3,
      modifier:5,total:23,dc:20,outcome:"success",revisionBefore:0,revisionAfter:1,occurredAt:at,candidateId:"private",actorId:"private"});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/commands/check-command/receipt"});expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({receipt:{kind:"check",checkKind:"skill",ability:"Wisdom",skill:"Perception",mode:"advantage",difficulty:"Hard",
      rolls:[{value:7,kept:false},{value:18,kept:true}],abilityModifier:2,proficiencyBonus:3,modifier:5,total:23,dc:20,outcome:"success",
      revisionBefore:0,revisionAfter:1,occurredAt:at}});expect(response.body).not.toMatch(/check-command|candidateId|actorId|provider|principal|digest/);
    expect(repo.getCommandReceipt).not.toHaveBeenCalled();await app.close();
  });
  it("opens a listed actor mechanic receipt through the authorized command repository", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup();
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/commands/command/receipt" });
    expect(response.statusCode).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ receipt: { kind: "mechanic", revisionBefore: 0, revisionAfter: 1,
      occurredAt: at, event: { type: "actor_attribute_set", data: { valueBefore: 10, valueAfter: 12 } } } });
    expect(response.body).not.toContain("actorId"); expect(response.body).not.toContain("private-turn"); expect(response.body).not.toContain("strength");
    expect(repo.getCommandReceipt).toHaveBeenCalledWith("local-owner", "campaign", "command");
    expect(repo.getCampaignAdministrationReceipt).not.toHaveBeenCalled(); await app.close();
  });

  it("falls back to redacted administration metadata and never returns generic event data", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup();
    repo.getCommandReceipt.mockReturnValue(null as never); repo.getCampaignAdministrationReceipt.mockReturnValue(administrationReceipt);
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/commands/admin-command/receipt" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ receipt: { kind: "administration",
      type: "recap_created", revisionBefore: 1, revisionAfter: 2, occurredAt: at } });
    expect(response.body).not.toContain("must never cross"); await app.close();
  });
  it("returns an exact role-safe generalized combat receipt",async()=>{
    process.env.FEATURE_RPG_CAMPAIGN="true";const{app,repo}=setup();repo.getCommandReceipt.mockReturnValue(null as never);repo.getAgentCombatReceipt.mockReturnValue({revisionBefore:3,revisionAfter:4,occurredAt:at,
      resolution:{actionId:"action",legalActionId:"end-turn",kind:"end-turn",actingCombatantId:"enemy",targetIds:[],outcomes:[],roundBefore:1,roundAfter:2,currentCombatantBefore:"enemy",currentCombatantAfter:"hero"}});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/commands/combat-command/receipt"});expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({receipt:{kind:"combat",revisionBefore:3,revisionAfter:4,occurredAt:at,action:"end-turn",outcome:{kind:"none"},roundBefore:1,roundAfter:2}});expect(response.body).not.toContain("enemy");expect(repo.getCampaignAdministrationReceipt).not.toHaveBeenCalled();await app.close();
  });
  it("returns the exact public travel receipt with no private provider or world identity",async()=>{
    process.env.FEATURE_RPG_CAMPAIGN="true";const{app,repo}=setup();repo.getCommandReceipt.mockReturnValue(null as never);
    repo.getExactCandidateTravelPublicReceipt.mockReturnValue({destination:"Glass Harbor",revisionBefore:5,revisionAfter:6,occurredAt:at});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/commands/travel-command/receipt"});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({receipt:{kind:"travel",destination:"Glass Harbor",revisionBefore:5,revisionAfter:6,occurredAt:at}});
    for(const hidden of ["travel-command","candidate","provider","locationId","connectionId","actorId","principalId","digest"])
      expect(response.body).not.toContain(hidden);
    expect(repo.getExactCandidateTravelPublicReceipt).toHaveBeenCalledWith("local-owner","campaign","travel-command");
    expect(repo.getCampaignAdministrationReceipt).not.toHaveBeenCalled();await app.close();
  });
  it("returns a strict public quest receipt without private quest or provider identities", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup();
    repo.getCommandReceipt.mockReturnValue(null as never);
    repo.getAdventureQuestPublicReceipt.mockReturnValue({ questTitle: "The Sealed Gate", objectiveDescription: "Break the final seal",
      progressBefore: 2, progressAfter: 3, targetProgress: 3, objectiveCompleted: true, questCompleted: true,
      revisionBefore: 8, revisionAfter: 9, occurredAt: at, questId: "private-quest", objectiveId: "private-objective",
      candidateId: "private-candidate", providerCallId: "private-provider", digest: "private-digest" });
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/commands/quest-command/receipt" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ receipt: { kind: "quest", title: "The Sealed Gate",
      objectiveDescription: "Break the final seal", progressBefore: 2, progressAfter: 3, target: 3,
      objectiveCompleted: true, questCompleted: true, revisionBefore: 8, revisionAfter: 9, occurredAt: at } });
    expect(repo.getAdventureQuestPublicReceipt).toHaveBeenCalledWith("local-owner", "campaign", "quest-command");
    for (const hidden of ["quest-command", "questId", "objectiveId", "candidateId", "providerCallId", "digest"]) {
      expect(response.body).not.toContain(hidden);
    }
    expect(repo.getAgentCombatReceipt).not.toHaveBeenCalled();
    expect(repo.getCampaignAdministrationReceipt).not.toHaveBeenCalled();
    await app.close();
  });
  it.each(["quest-lifecycle","progression"]as const)("returns a strict safe %s receipt",async kind=>{process.env.FEATURE_RPG_CAMPAIGN="true";const{app,repo}=setup();if(kind==="quest-lifecycle")repo.getAdventureQuestLifecyclePublicReceipt.mockReturnValue({action:"claim-reward",questTitle:"The Sealed Gate",statusBefore:"completed",statusAfter:"completed",reward:{label:"Bounty",kind:"Currency",amount:12,recipient:"Aster"},revisionBefore:3,revisionAfter:4,occurredAt:at,questId:"private",rewardId:"private"});else repo.getAdventureProgressionPublicReceipt.mockReturnValue({className:"Lantern Warden",levelBefore:1,levelAfter:2,features:["Mending Light"],resources:[{label:"Focus",before:0,after:1}],revisionBefore:2,revisionAfter:3,occurredAt:at,previewToken:"private",actorId:"private"});const response=await app.inject({method:"GET",url:`/api/rpg/v1/campaigns/campaign/commands/${kind}-command/receipt`});expect(response.statusCode).toBe(200);expect(response.json().receipt.kind).toBe(kind);expect(response.body).not.toMatch(/private|commandId|questId|rewardId|actorId|previewToken|candidateId|digest/);await app.close();});
  it("preserves masked not-found semantics when a discovered travel receipt is not authorized",async()=>{
    process.env.FEATURE_RPG_CAMPAIGN="true";const{app,repo}=setup();repo.getCommandReceipt.mockReturnValue(null as never);
    repo.getExactCandidateTravelPublicReceipt.mockReturnValue(null as never);
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/commands/discovered-travel/receipt"});
    expect(response.statusCode).toBe(404);expect(response.body).not.toContain("discovered-travel");
    expect(repo.getExactCandidateTravelPublicReceipt).toHaveBeenCalledWith("local-owner","campaign","discovered-travel");await app.close();
  });

  it("returns not found when neither role-authorized repository exposes the command", async () => {
    process.env.FEATURE_RPG_CAMPAIGN = "true"; const { app, repo } = setup();
    repo.getCommandReceipt.mockReturnValue(null as never);
    const response = await app.inject({ method: "GET", url: "/api/rpg/v1/campaigns/campaign/commands/missing/receipt" });
    expect(response.statusCode).toBe(404); expect(response.body).not.toContain("missing"); await app.close();
  });
});
