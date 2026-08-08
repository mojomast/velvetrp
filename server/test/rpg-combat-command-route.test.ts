import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { EncounterConflictError, EncounterStaleError } from "../src/repo/index.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

const at="2035-01-01T00:00:00.000Z";
const actor={combatantId:"actor-combatant",kind:"actor" as const,team:"allies" as const,actorId:"actor",hitPoints:10,
  maximumHitPoints:10,status:"active" as const};
const enemy={combatantId:"enemy-combatant",kind:"enemy" as const,team:"enemies" as const,template:null,hitPoints:7,
  maximumHitPoints:8,status:"active" as const};
const combat={campaignId:"campaign",encounterId:"combat",combatId:"combat",round:1,currentCombatant:"enemy-combatant",
  combatants:[actor,enemy],legalActions:[{legalActionId:"end-turn",kind:"end-turn" as const,targetIds:[]}],revision:3};
const resolution={actionId:"action",legalActionId:"attack:basic",kind:"attack" as const,actingCombatantId:"actor-combatant",
  targetIds:["enemy-combatant"],outcomes:[{kind:"damage" as const,targetId:"enemy-combatant",damageType:"physical" as const,
    requested:1 as const,applied:1,hitPointsBefore:8,hitPointsAfter:7,statusBefore:"active" as const,statusAfter:"active" as const}],
  roundBefore:1,roundAfter:1,currentCombatantBefore:"actor-combatant",currentCombatantAfter:"enemy-combatant"};
const encounter={campaignId:"campaign",encounterId:"combat",sessionId:"session",name:"Ambush",status:"completed" as const,
  combatId:"combat",combatants:[{combatantId:"actor-combatant",kind:"actor" as const,team:"allies" as const,actorId:"actor"}],
  revision:4,createdAt:at,updatedAt:at};
const reward={campaignId:"campaign",encounterId:"combat",rewardBundleId:"bundle",recipientActorId:"actor",createdAt:at,
  rewards:[{kind:"currency" as const,currency:{kind:"currency" as const,packId:"pack",packVersion:"1.0.0",definitionId:"glimmer"},amount:1}]};

afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;delete process.env.FEATURE_RPG_COMBAT;});
const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";process.env.FEATURE_RPG_COMBAT="true";};
function repository(overrides:Record<string,unknown>={}){
  return {resolveCombatAction:()=>({campaignId:"campaign",encounterId:"combat",resolution,combat,
    receipt:{commandId:"private",idempotencyKey:"attack",revisionBefore:2,revisionAfter:3,occurredAt:at}}),
  endCombat:()=>({campaignId:"campaign",encounterId:"combat",encounter,rewards:[reward],
    receipt:{commandId:"private",idempotencyKey:"end",revisionBefore:3,revisionAfter:4,occurredAt:at}}),
  getCombatCommandResult:()=>({operation:"action",result:{resolution,combat:Object.fromEntries(Object.entries(combat).filter(([key])=>key!=="campaignId"&&key!=="encounterId")),receipt:{idempotencyKey:"attack",revisionBefore:2,revisionAfter:3,occurredAt:at}}}),
  close(){},listCampaigns:()=>[],...overrides} as unknown as CampaignListRepository;
}

describe("M2.9 combat command routes",()=>{
  it("reads an existing campaign-scoped command result without executing a command",async()=>{
    enable();let reads=0;const app=buildApp({campaignRepositoryFactory:()=>repository({getCombatCommandResult:(...args:any[])=>{reads++;expect(args).toEqual(["local-owner","campaign","combat","attack"]);return {operation:"action",result:{resolution,combat:Object.fromEntries(Object.entries(combat).filter(([key])=>key!=="campaignId"&&key!=="encounterId")),receipt:{idempotencyKey:"attack",revisionBefore:2,revisionAfter:3,occurredAt:at}}};}})});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/combats/combat/command-results/attack"});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");expect(response.json()).toMatchObject({operation:"action",result:{resolution:{actionId:"action"}}});expect(reads).toBe(1);
    expect((await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/combats/combat/command-results/attack?x=1"})).statusCode).toBe(400);await app.close();
  });
  it("uses fixed local ownership and returns strict action and reward projections",async()=>{
    enable();const calls:any[]=[];const app=buildApp({campaignRepositoryFactory:()=>repository({
      resolveCombatAction:(...args:any[])=>{calls.push(["action",...args]);return {campaignId:"campaign",encounterId:"combat",
        resolution,combat,receipt:{commandId:"private",idempotencyKey:"attack",revisionBefore:2,revisionAfter:3,occurredAt:at}};},
      endCombat:(...args:any[])=>{calls.push(["end",...args]);return {campaignId:"campaign",encounterId:"combat",encounter,
        rewards:[reward],receipt:{commandId:"private",idempotencyKey:"end",revisionBefore:3,revisionAfter:4,occurredAt:at}};},
    })});
    const hostile={authorization:"Bearer attacker","x-principal-id":"attacker","content-type":"application/json"};
    const actionBody={legalActionId:"attack:basic",targetIds:["enemy-combatant"],choices:[],expectedRevision:2,idempotencyKey:"attack"};
    const action=await app.inject({method:"POST",url:"/api/rpg/v1/combats/combat/action-commands",headers:hostile,payload:actionBody});
    expect(action.statusCode).toBe(200);expect(action.headers["cache-control"]).toBe("no-store");
    expect(action.json()).toEqual({resolution,combat:Object.fromEntries(Object.entries(combat)
      .filter(([key])=>key!=="campaignId"&&key!=="encounterId")),receipt:{idempotencyKey:"attack",revisionBefore:2,revisionAfter:3,occurredAt:at}});
    const endBody={expectedRevision:3,idempotencyKey:"end"};
    const end=await app.inject({method:"POST",url:"/api/rpg/v1/combats/combat/end-commands",headers:hostile,payload:endBody});
    expect(end.statusCode).toBe(200);expect(end.body).not.toContain("campaignId");expect(end.body).not.toContain("commandId");
    expect(end.json()).toEqual({encounter:Object.fromEntries(Object.entries(encounter).filter(([key])=>key!=="campaignId")),
      rewards:[Object.fromEntries(Object.entries(reward).filter(([key])=>key!=="campaignId"&&key!=="encounterId"))],
      receipt:{idempotencyKey:"end",revisionBefore:3,revisionAfter:4,occurredAt:at}});
    expect(calls).toEqual([["action","local-owner","combat",actionBody],["end","local-owner","combat",endBody]]);await app.close();
  });

  it("gates and normalizes query, media, body, path, stale, conflict, and corrupt output",async()=>{
    let accesses=0,calls=0;const gated=buildApp({campaignRepositoryFactory:()=>{accesses++;return repository({resolveCombatAction:()=>{calls++;throw new Error();}});}});
    const body={legalActionId:"end-turn",targetIds:[],choices:[],expectedRevision:2,idempotencyKey:"turn"};
    expect((await gated.inject({method:"POST",url:"/api/rpg/v1/combats/combat/action-commands",headers:{"content-type":"application/json"},payload:body})).statusCode).toBe(404);
    expect(accesses).toBe(0);enable();
    expect((await gated.inject({method:"POST",url:"/api/rpg/v1/combats/combat/action-commands?x=1",headers:{"content-type":"application/json"},payload:body})).statusCode).toBe(400);
    expect((await gated.inject({method:"POST",url:"/api/rpg/v1/combats/combat/action-commands",payload:JSON.stringify(body)})).statusCode).toBe(415);
    expect((await gated.inject({method:"POST",url:"/api/rpg/v1/combats/combat/action-commands",headers:{"content-type":"application/json"},payload:{...body,damage:99}})).statusCode).toBe(400);
    const overlong=await gated.inject({method:"POST",url:`/api/rpg/v1/combats/${"x".repeat(129)}/end-commands`,
      headers:{"content-type":"application/json"},payload:{expectedRevision:3,idempotencyKey:"end"}});
    expect(overlong.statusCode).toBe(404);expect(overlong.json()).toMatchObject({code:"RPG_COMBAT_NOT_FOUND",
      instance:"/api/rpg/v1/combats/:combatId/end-commands"});expect(calls).toBe(0);await gated.close();
    for(const [failure,code] of [[new EncounterStaleError(),"RPG_COMBAT_STALE"],[new EncounterConflictError(),"RPG_COMBAT_ACTION_CONFLICT"]] as const){
      const app=buildApp({campaignRepositoryFactory:()=>repository({resolveCombatAction:()=>{throw failure;}})});
      const response=await app.inject({method:"POST",url:"/api/rpg/v1/combats/combat/action-commands",
        headers:{"content-type":"application/json"},payload:body});expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({code});await app.close();
    }
    const corrupt=buildApp({campaignRepositoryFactory:()=>repository({endCombat:()=>({campaignId:"campaign",encounterId:"combat",
      encounter:{...encounter,privateState:"secret"},rewards:[reward],receipt:{commandId:"private",idempotencyKey:"end",revisionBefore:3,revisionAfter:4,occurredAt:at}})})});
    const response=await corrupt.inject({method:"POST",url:"/api/rpg/v1/combats/combat/end-commands",
      headers:{"content-type":"application/json"},payload:{expectedRevision:3,idempotencyKey:"end"}});
    expect(response.statusCode).toBe(500);expect(response.body).not.toContain("secret");await corrupt.close();
  });
});
