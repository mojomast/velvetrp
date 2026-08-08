import {afterEach,describe,expect,it} from "vitest";
import {buildApp} from "../src/app.js";
import {WorldConflictError,WorldStaleError} from "../src/repo/index.js";
import type {CampaignListRepository} from "../src/routes/rpg/v1/features.js";

const at="2035-01-01T00:00:00.000Z",publicState={name:"Marrow"},privateState={goals:"Trade",gmNotes:"Secret",merchantState:null};
const npc={npcId:"npc",personaId:"persona",publicState,privateState,createdAt:at};
const created={campaignId:"campaign",npc,receipt:{commandId:"private",idempotencyKey:"create-npc",revisionBefore:0,revisionAfter:1,occurredAt:at}};
const changed={campaignId:"campaign",npcId:"npc",relationship:{npcId:"npc",subjectActorId:"actor",affinity:2,trust:1,fear:0,updatedAt:at},
  receipt:{commandId:"private-2",idempotencyKey:"relationship",revisionBefore:1,revisionAfter:2,occurredAt:at}};
afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;});
const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";};
function repository(overrides:Record<string,unknown>={}){return {listCampaignNpcs:()=>({campaignId:"campaign",revision:1,audience:"gm",npcs:[npc],relationships:[]}),
  createCampaignNpc:()=>created,changeNpcRelationship:()=>changed,close(){},listCampaigns:()=>[],...overrides} as unknown as CampaignListRepository;}

describe("M2.10 NPC routes",()=>{
  it("uses fixed local ownership and returns only reviewed NPC projections",async()=>{
    enable();const calls:any[]=[];const app=buildApp({campaignRepositoryFactory:()=>repository({
       listCampaignNpcs:(...args:any[])=>{calls.push(["list",...args]);return {campaignId:"campaign",revision:1,audience:"gm",npcs:[npc],relationships:[]};},
      createCampaignNpc:(...args:any[])=>{calls.push(["create",...args]);return created;},
      changeNpcRelationship:(...args:any[])=>{calls.push(["relationship",...args]);return changed;},
    })});const hostile={authorization:"Bearer attacker","x-principal-id":"attacker"};
    const read=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/npcs",headers:hostile});
    expect(read.statusCode).toBe(200);expect(read.headers["cache-control"]).toBe("no-store");expect(read.headers["x-world-revision"]).toBe("1");
    expect(read.json()).toEqual({npcs:[npc],relationships:[]});
    const createBody={personaId:"persona",publicState,privateState,expectedRevision:0,idempotencyKey:"create-npc"};
    const create=await app.inject({method:"POST",url:"/api/rpg/v1/campaigns/campaign/npcs",headers:{...hostile,"content-type":"application/json"},payload:createBody});
    expect(create.statusCode).toBe(201);expect(create.body).not.toContain("campaignId");expect(create.body).not.toContain("commandId");
    const relationshipBody={subjectActorId:"actor",affinityDelta:2,trustDelta:1,fearDelta:0,reason:"Helped",
      expectedRevision:1,idempotencyKey:"relationship"};
    const relationship=await app.inject({method:"POST",url:"/api/rpg/v1/npcs/npc/relationship-commands",
      headers:{...hostile,"content-type":"application/json"},payload:relationshipBody});
    expect(relationship.statusCode).toBe(200);expect(relationship.body).not.toContain("commandId");
    expect(calls).toEqual([["list","local-owner","campaign"],["create","local-owner","campaign",createBody],
      ["relationship","local-owner","npc",relationshipBody]]);await app.close();
  });
  it("gates and normalizes invalid NPC requests before mutation",async()=>{
    let accesses=0,calls=0;const app=buildApp({campaignRepositoryFactory:()=>{accesses++;return repository({createCampaignNpc:()=>{calls++;throw new Error();}});}});
    expect((await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/npcs"})).statusCode).toBe(404);expect(accesses).toBe(0);enable();
    expect((await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/npcs?secret=1"})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/campaigns/campaign/npcs",payload:"{}"})).statusCode).toBe(415);
    const invalid=await app.inject({method:"POST",url:"/api/rpg/v1/npcs/npc/relationship-commands",headers:{"content-type":"application/json"},
      payload:{subjectActorId:"actor",affinityDelta:0,trustDelta:0,fearDelta:0,reason:"No change",expectedRevision:0,idempotencyKey:"zero"}});
    expect(invalid.statusCode).toBe(400);expect(calls).toBe(0);await app.close();
  });
  it("normalizes stale, conflict, and corrupt repository outcomes",async()=>{
    enable();const body={subjectActorId:"actor",affinityDelta:1,trustDelta:0,fearDelta:0,reason:"Helped",expectedRevision:1,idempotencyKey:"relationship"};
    for(const [error,code] of [[new WorldStaleError("private stale"),"RPG_WORLD_STALE"],[new WorldConflictError("private conflict"),"RPG_NPC_CONFLICT"]] as const){
      const app=buildApp({campaignRepositoryFactory:()=>repository({changeNpcRelationship:()=>{throw error;}})});
      const response=await app.inject({method:"POST",url:"/api/rpg/v1/npcs/npc/relationship-commands",headers:{"content-type":"application/json"},payload:body});
      expect(response.statusCode).toBe(409);expect(response.json()).toMatchObject({code,instance:"/api/rpg/v1/npcs/:npcId/relationship-commands"});
      expect(response.body).not.toContain("private");await app.close();
    }
    const app=buildApp({campaignRepositoryFactory:()=>repository({listCampaignNpcs:()=>({...repository,secret:"leak"})})});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/npcs"});
    expect(response.statusCode).toBe(500);expect(response.body).not.toContain("leak");await app.close();
  });
});
