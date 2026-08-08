import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

const at="2035-01-01T00:00:00.000Z";
const combat={campaignId:"campaign",encounterId:"combat",combatId:"combat",round:2,currentCombatant:"combatant",
  combatants:[{combatantId:"combatant",kind:"actor" as const,team:"allies" as const,actorId:"actor",hitPoints:8,
    maximumHitPoints:10,status:"active" as const}],legalActions:[{legalActionId:"defend",kind:"defend" as const,targetIds:[]}],revision:4};
const entry={logEntryId:"log",campaignId:"campaign",encounterId:"combat",sequence:3,occurredAt:at,
  event:{kind:"combatant_state_changed" as const,combatantId:"combatant",hitPoints:8,status:"active" as const}};

afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;delete process.env.FEATURE_RPG_COMBAT;});
const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";process.env.FEATURE_RPG_COMBAT="true";};
function repository(overrides:Record<string,unknown>={}){
  return {getCombatState:()=>combat,listCombatLogPage:()=>({campaignId:"campaign",encounterId:"combat",entries:[entry],nextAfterSequence:3}),
    close(){},listCampaigns:()=>[],...overrides} as unknown as CampaignListRepository;
}

describe("M2.9 combat read routes",()=>{
  it("uses fixed local ownership and strips route and campaign identities",async()=>{
    enable();const calls:any[]=[];const app=buildApp({campaignRepositoryFactory:()=>repository({
      getCombatState:(...args:any[])=>{calls.push(["combat",...args]);return combat;},
      listCombatLogPage:(...args:any[])=>{calls.push(["log",...args]);return {campaignId:"campaign",encounterId:"combat",entries:[entry],nextAfterSequence:3};},
    })});
    const hostile={authorization:"Bearer attacker","x-principal-id":"attacker"};
    const state=await app.inject({method:"GET",url:"/api/rpg/v1/combats/combat",headers:hostile});
    expect(state.statusCode).toBe(200);expect(state.headers["cache-control"]).toBe("no-store");
    expect(state.json()).toEqual({round:2,currentCombatant:"combatant",combatants:combat.combatants,
      legalActions:combat.legalActions,revision:4});expect(state.body).not.toContain("campaignId");expect(state.body).not.toContain("encounterId");
    const log=await app.inject({method:"GET",url:"/api/rpg/v1/combats/combat/log?afterSequence=2&limit=1",headers:hostile});
    expect(log.statusCode).toBe(200);expect(log.headers["cache-control"]).toBe("no-store");
    expect(log.json()).toEqual({entries:[{logEntryId:"log",sequence:3,occurredAt:at,event:entry.event}],nextAfterSequence:3});
    expect(log.body).not.toContain("campaignId");expect(log.body).not.toContain("encounterId");
    expect(calls).toEqual([["combat","local-owner","combat"],["log","local-owner","combat",2,1]]);await app.close();
  });

  it("gates features and normalizes query, paths, methods, absence, and corrupt projections",async()=>{
    let accesses=0;const gated=buildApp({campaignRepositoryFactory:()=>{accesses++;return repository();}});
    expect((await gated.inject({method:"GET",url:"/api/rpg/v1/combats/combat"})).statusCode).toBe(404);expect(accesses).toBe(0);enable();
    expect((await gated.inject({method:"GET",url:"/api/rpg/v1/combats/combat?x=1"})).statusCode).toBe(400);
    expect((await gated.inject({method:"GET",url:"/api/rpg/v1/combats/combat/log?afterSequence=0&limit=101"})).statusCode).toBe(400);
    const overlong=await gated.inject({method:"GET",url:`/api/rpg/v1/combats/${"x".repeat(129)}`});
    expect(overlong.statusCode).toBe(404);expect(overlong.json()).toMatchObject({code:"RPG_COMBAT_NOT_FOUND",instance:"/api/rpg/v1/combats/:combatId"});
    expect((await gated.inject({method:"HEAD",url:"/api/rpg/v1/combats/combat"})).statusCode).toBe(404);await gated.close();
    for(const [method,value,url] of [["getCombatState",null,"/api/rpg/v1/combats/combat"],
      ["getCombatState",{...combat,privateState:"secret"},"/api/rpg/v1/combats/combat"],
      ["listCombatLogPage",{campaignId:"campaign",encounterId:"other",entries:[entry],nextAfterSequence:null},
        "/api/rpg/v1/combats/combat/log?afterSequence=0&limit=10"]] as const){
      const app=buildApp({campaignRepositoryFactory:()=>repository({[method]:()=>value})});const response=await app.inject({method:"GET",url});
      expect(response.statusCode).toBe(value===null?404:500);expect(response.body).not.toContain("secret");await app.close();
    }
  });
});
