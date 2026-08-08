import { afterEach, describe, expect, it } from "vitest";
import type { ActorPowerSnapshot } from "../src/repo/powerRepo.js";
import { ActorPowerConflictError, ActorPowerNotFoundError, M16StaleError } from "../src/repo/index.js";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;});
const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";};
const ability={kind:"ability" as const,packId:"pack",packVersion:"1.0.0",definitionId:"ability"};
const legalCommand={powerRef:ability,targeting:"single" as const,validTargets:[{actorId:"target",label:"Target"}],costs:[],concentration:false,effectKinds:["damage" as const]};
const snapshot:ActorPowerSnapshot={campaignId:"campaign",actorId:"actor",known:[ability],prepared:[ability],slots:[],uses:[],legalNow:[{powerRef:ability,legal:true,reasons:[]}],legalCommands:[legalCommand],revision:2};
function repository(read:(principal:string,actorId:string)=>unknown,use:((principal:string,actorId:string,input:unknown)=>unknown)=()=>{throw new Error("unsupported");}){return {getActorPowerSnapshot:read,useActorPower:use,close(){},listCampaigns:()=>[]} as unknown as CampaignListRepository;}

describe("GET /api/rpg/v1/actors/:actorId/powers",()=>{
  it("uses fixed local ownership and emits only the strict no-store response",async()=>{
    enable();const calls:Array<[string,string]>=[];
    const app=buildApp({campaignRepositoryFactory:()=>repository((principal,actorId)=>{calls.push([principal,actorId]);return snapshot;})});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/actors/actor/powers",headers:{authorization:"Bearer caller","x-principal-id":"attacker"}});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({known:[ability],prepared:[ability],slots:[],uses:[],legalNow:[{powerRef:ability,legal:true,reasons:[]}],legalCommands:[legalCommand],revision:2});
    expect(calls).toEqual([["local-owner","actor"]]);expect(response.body).not.toContain("campaign");
    await app.close();
  });

  it("gates first and normalizes query, path, method, missing, malformed output, and failures",async()=>{
    let accesses=0;const gated=buildApp({campaignRepositoryFactory:()=>{accesses++;return repository(()=>snapshot);}});
    expect((await gated.inject({method:"GET",url:"/api/rpg/v1/actors/actor/powers?x=1"})).statusCode).toBe(404);expect(accesses).toBe(0);
    enable();
    expect((await gated.inject({method:"GET",url:"/api/rpg/v1/actors/actor/powers?x=1"})).statusCode).toBe(400);
    const path=await gated.inject({method:"GET",url:`/api/rpg/v1/actors/${"x".repeat(129)}/powers`});
    expect(path.json()).toMatchObject({code:"RPG_ACTOR_POWERS_NOT_FOUND",instance:"/api/rpg/v1/actors/:actorId/powers"});
    const head=await gated.inject({method:"HEAD",url:"/api/rpg/v1/actors/actor/powers"});
    expect(head.statusCode).toBe(404);expect(head.headers["cache-control"]).toBe("no-store");
    await gated.close();

    for(const value of [null,{...snapshot,actorId:"other"},{...snapshot,privateDefinition:{}}]){
      const app=buildApp({campaignRepositoryFactory:()=>repository(()=>value)});const response=await app.inject({method:"GET",url:"/api/rpg/v1/actors/actor/powers"});
      expect(response.statusCode).toBe(value===null?404:500);expect(response.headers["cache-control"]).toBe("no-store");await app.close();
    }
    const app=buildApp({campaignRepositoryFactory:()=>repository(()=>{throw new Error("private SQL");})});
    const failed=await app.inject({method:"GET",url:"/api/rpg/v1/actors/actor/powers"});
    expect(failed.statusCode).toBe(500);expect(failed.body).not.toContain("private SQL");await app.close();
  });
});

describe("POST /api/rpg/v1/actors/:actorId/power-commands",()=>{
  const request={powerRef:ability,targetIds:["target"],choices:[],expectedRevision:2,idempotencyKey:"use"};
  const result={resolution:{powerUseId:"power-use",powerRef:ability,targetIds:["target"],costs:[],outcomes:[],stateDeltas:[]},actorStates:[
    {actorId:"actor",resources:[],activeEffects:[],revision:3},{actorId:"target",resources:[],activeEffects:[],revision:1},
  ],receipt:{commandId:"private-command",idempotencyKey:"use",revisionBefore:2,revisionAfter:3,occurredAt:"2035-01-01T00:00:00.000Z"}};

  it("uses fixed ownership, JSON-only intent, no-store, and strips private receipt identity",async()=>{
    enable();const calls:any[]=[];const app=buildApp({campaignRepositoryFactory:()=>repository(()=>snapshot,(...args)=>{calls.push(args);return result;})});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/power-commands",headers:{"content-type":"application/json",authorization:"Bearer attacker","x-principal-id":"attacker"},payload:request});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual([["local-owner","actor",request]]);expect(response.json()).toEqual({...result,receipt:{idempotencyKey:"use",revisionBefore:2,revisionAfter:3,occurredAt:"2035-01-01T00:00:00.000Z"}});
    expect(response.body).not.toContain("commandId");await app.close();
  });

  it("normalizes guards, strict caller authority, and typed repository conflicts",async()=>{
    enable();const app=buildApp({campaignRepositoryFactory:()=>repository(()=>snapshot,()=>result)});
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/power-commands",headers:{"content-type":"text/plain"},payload:JSON.stringify(request)})).statusCode).toBe(415);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/power-commands?x=1",headers:{"content-type":"application/json"},payload:request})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/power-commands",headers:{"content-type":"application/json"},payload:{...request,costs:[]}})).statusCode).toBe(400);
    expect((await app.inject({method:"HEAD",url:"/api/rpg/v1/actors/actor/power-commands"})).statusCode).toBe(404);await app.close();
    for(const [error,status,code] of [[new ActorPowerNotFoundError("private missing"),404,"RPG_ACTOR_POWERS_NOT_FOUND"],[new M16StaleError("private stale"),409,"RPG_ACTOR_POWER_STALE"],[new ActorPowerConflictError("private conflict"),409,"RPG_ACTOR_POWER_CONFLICT"]] as const){const failed=buildApp({campaignRepositoryFactory:()=>repository(()=>snapshot,()=>{throw error;})});const response=await failed.inject({method:"POST",url:"/api/rpg/v1/actors/actor/power-commands",headers:{"content-type":"application/json"},payload:request});expect(response.statusCode).toBe(status);expect(response.json()).toMatchObject({code});expect(response.body).not.toContain(error.message);await failed.close();}
  });
});
