import { afterEach, describe, expect, it } from "vitest";
import type { ActorPowerSnapshot } from "../src/repo/powerRepo.js";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;});
const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";};
const ability={kind:"ability" as const,packId:"pack",packVersion:"1.0.0",definitionId:"ability"};
const snapshot:ActorPowerSnapshot={campaignId:"campaign",actorId:"actor",known:[ability],prepared:[ability],slots:[],uses:[],legalNow:[{powerRef:ability,legal:true,reasons:[]}],revision:2};
function repository(read:(principal:string,actorId:string)=>unknown){return {getActorPowerSnapshot:read,close(){},listCampaigns:()=>[]} as unknown as CampaignListRepository;}

describe("GET /api/rpg/v1/actors/:actorId/powers",()=>{
  it("uses fixed local ownership and emits only the strict no-store response",async()=>{
    enable();const calls:Array<[string,string]>=[];
    const app=buildApp({campaignRepositoryFactory:()=>repository((principal,actorId)=>{calls.push([principal,actorId]);return snapshot;})});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/actors/actor/powers",headers:{authorization:"Bearer caller","x-principal-id":"attacker"}});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({known:[ability],prepared:[ability],slots:[],uses:[],legalNow:[{powerRef:ability,legal:true,reasons:[]}],revision:2});
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
