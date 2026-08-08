import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

const at="2035-01-01T00:00:00.000Z";
const combatant={combatantId:"combatant",kind:"actor" as const,team:"allies" as const,actorId:"actor"};
const encounter={campaignId:"campaign",encounterId:"encounter",sessionId:"session",name:"Bridge ambush",
  status:"preparing" as const,combatId:null,combatants:[combatant],revision:1,createdAt:at,updatedAt:at};
const combat={campaignId:"campaign",encounterId:"encounter",combatId:"encounter",round:1,
  currentCombatant:"combatant",combatants:[{...combatant,hitPoints:10,maximumHitPoints:10,status:"active" as const}],
  legalActions:[{legalActionId:"defend",kind:"defend" as const,targetIds:[]}],revision:2};

afterEach(()=>{
  delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;delete process.env.FEATURE_RPG_COMBAT;
});
const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";process.env.FEATURE_RPG_COMBAT="true";};
function repository(overrides:Record<string,unknown>={}){
  return {listEncounters:()=>[encounter],createEncounter:()=>({campaignId:"campaign",encounter,
    receipt:{commandId:"private",idempotencyKey:"prepare",revisionBefore:0,revisionAfter:1,occurredAt:at}}),
  startEncounter:()=>({campaignId:"campaign",encounterId:"encounter",combat,
    receipt:{commandId:"private",idempotencyKey:"start",revisionBefore:1,revisionAfter:2,occurredAt:at}}),
  close(){},listCampaigns:()=>[],...overrides} as unknown as CampaignListRepository;
}

describe("M2.9 encounter lifecycle routes",()=>{
  it("uses fixed local ownership and returns only reviewed no-store projections",async()=>{
    enable();const calls:any[]=[];
    const app=buildApp({campaignRepositoryFactory:()=>repository({
      listEncounters:(...args:any[])=>{calls.push(["list",...args]);return [encounter];},
      createEncounter:(...args:any[])=>{calls.push(["create",...args]);return {campaignId:"campaign",encounter,
        receipt:{commandId:"private",idempotencyKey:"prepare",revisionBefore:0,revisionAfter:1,occurredAt:at}};},
      startEncounter:(...args:any[])=>{calls.push(["start",...args]);return {campaignId:"campaign",encounterId:"encounter",combat,
        receipt:{commandId:"private",idempotencyKey:"start",revisionBefore:1,revisionAfter:2,occurredAt:at}};},
    })});
    const hostile={authorization:"Bearer attacker","x-principal-id":"attacker"};
    const list=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/encounters",headers:hostile});
    expect(list.statusCode).toBe(200);expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.json()).toEqual({encounters:[Object.fromEntries(Object.entries(encounter).filter(([key])=>key!=="campaignId"))]});
    const createBody={sessionId:"session",name:"Bridge ambush",combatants:[{kind:"actor",actorId:"actor",team:"allies"}],idempotencyKey:"prepare"};
    const created=await app.inject({method:"POST",url:"/api/rpg/v1/campaigns/campaign/encounters",
      headers:{...hostile,"content-type":"application/json"},payload:createBody});
    expect(created.statusCode).toBe(201);expect(created.body).not.toContain("commandId");expect(created.body).not.toContain("campaignId");
    const started=await app.inject({method:"POST",url:"/api/rpg/v1/encounters/encounter/start-commands",
      headers:{...hostile,"content-type":"application/json"},payload:{expectedRevision:1,idempotencyKey:"start"}});
    expect(started.statusCode).toBe(200);expect(started.json()).toEqual({combat:Object.fromEntries(Object.entries(combat)
      .filter(([key])=>key!=="campaignId"&&key!=="encounterId")),receipt:{idempotencyKey:"start",revisionBefore:1,revisionAfter:2,occurredAt:at}});
    expect(calls).toEqual([["list","local-owner","campaign"],["create","local-owner","campaign",createBody],
      ["start","local-owner","encounter",{expectedRevision:1,idempotencyKey:"start"}]]);
    await app.close();
  });

  it("gates features and rejects invalid query, media, body, paths, and methods before mutation",async()=>{
    let accesses=0,calls=0;const app=buildApp({campaignRepositoryFactory:()=>{accesses++;return repository({
      createEncounter:()=>{calls++;throw new Error();},startEncounter:()=>{calls++;throw new Error();},
    });}});
    expect((await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/encounters"})).statusCode).toBe(404);
    expect(accesses).toBe(0);enable();
    expect((await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/encounters?x=1"})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/campaigns/campaign/encounters",payload:"{}"})).statusCode).toBe(415);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/campaigns/campaign/encounters",headers:{"content-type":"application/json"},
      payload:{sessionId:"session",name:"Name",combatants:[{kind:"actor",actorId:"actor",team:"allies",hitPoints:10}],idempotencyKey:"prepare"}})).statusCode).toBe(400);
    const overlong=await app.inject({method:"POST",url:`/api/rpg/v1/encounters/${"x".repeat(129)}/start-commands`,
      headers:{"content-type":"application/json"},payload:{expectedRevision:1,idempotencyKey:"start"}});
    expect(overlong.statusCode).toBe(404);expect(overlong.json()).toMatchObject({code:"RPG_ENCOUNTER_NOT_FOUND",
      instance:"/api/rpg/v1/encounters/:encounterId/start-commands"});
    expect((await app.inject({method:"HEAD",url:"/api/rpg/v1/campaigns/campaign/encounters"})).statusCode).toBe(404);
    expect(calls).toBe(0);await app.close();
  });
});
