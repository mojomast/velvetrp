import { afterEach, describe, expect, it } from "vitest";
import type { ActorEffectSnapshot } from "../src/repo/index.js";
import { buildApp } from "../src/app.js";
import type { CampaignListRepository } from "../src/routes/rpg/v1/features.js";

afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;});
const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";};
const source={kind:"ability" as const,packId:"pack",packVersion:"1.0.0",definitionId:"ability"};
const snapshot:ActorEffectSnapshot={campaignId:"campaign",actorId:"actor",effects:[{
  effectId:"effect",campaignId:"campaign",actorId:"actor",source,
  modifiers:[{kind:"flat",appliesToId:"defense",amount:2}],duration:{kind:"rounds",remaining:2},
  recovery:"none",concentration:{kind:"required",concentrationId:"focus"},appliedAt:"2035-01-01T00:00:00.000Z",
}],revision:3};
function repository(read:(principal:string,actorId:string)=>unknown,mutate:((principal:string,actorId:string,input:unknown)=>unknown)=()=>{throw new Error("not implemented");}){
  return {getActorEffectSnapshot:read,mutateActorEffect:mutate,close(){},listCampaigns:()=>[]} as unknown as CampaignListRepository;
}

describe("GET /api/rpg/v1/actors/:actorId/effects",()=>{
  it("uses fixed local ownership and returns only reviewed no-store mechanics",async()=>{
    enable();const calls:Array<[string,string]>=[];
    const app=buildApp({campaignRepositoryFactory:()=>repository((principal,actorId)=>{calls.push([principal,actorId]);return snapshot;})});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/actors/actor/effects",headers:{authorization:"Bearer attacker","x-principal-id":"attacker"}});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual([["local-owner","actor"]]);
    expect(response.json()).toEqual({effects:[{effectId:"effect",source,modifiers:[{kind:"flat",appliesToId:"defense",amount:2}],duration:{kind:"rounds",remaining:2},recovery:"none",stacking:"concentration",appliedAt:"2035-01-01T00:00:00.000Z"}],concentration:[{effectId:"effect",concentrationId:"focus"}],revision:3});
    for(const hidden of ["campaignId","actorId","commandId","controller","rawCommand","gmNotes"])expect(response.body).not.toContain(hidden);
    await app.close();
  });

  it("gates before access and normalizes query, path, HEAD, missing, corrupt output, and errors",async()=>{
    let accesses=0;const gated=buildApp({campaignRepositoryFactory:()=>{accesses++;return repository(()=>snapshot);}});
    expect((await gated.inject({method:"GET",url:"/api/rpg/v1/actors/actor/effects?"})).statusCode).toBe(404);expect(accesses).toBe(0);
    enable();
    expect((await gated.inject({method:"GET",url:"/api/rpg/v1/actors/actor/effects?x=1"})).statusCode).toBe(400);
    const malformed=await gated.inject({method:"GET",url:`/api/rpg/v1/actors/${"x".repeat(129)}/effects`});
    expect(malformed.statusCode).toBe(404);expect(malformed.json()).toMatchObject({code:"RPG_ACTOR_EFFECTS_NOT_FOUND",instance:"/api/rpg/v1/actors/:actorId/effects"});
    const head=await gated.inject({method:"HEAD",url:"/api/rpg/v1/actors/actor/effects"});expect(head.statusCode).toBe(404);expect(head.headers["cache-control"]).toBe("no-store");
    await gated.close();
    for(const [value,status] of [[null,404],[{...snapshot,actorId:"other"},500],[{...snapshot,privateState:{}},500],[{...snapshot,effects:[{...snapshot.effects[0],gmNotes:"secret"}]},500]] as const){
      const app=buildApp({campaignRepositoryFactory:()=>repository(()=>value)});const response=await app.inject({method:"GET",url:"/api/rpg/v1/actors/actor/effects"});
      expect(response.statusCode).toBe(status);expect(response.headers["cache-control"]).toBe("no-store");expect(response.body).not.toContain("secret");await app.close();
    }
    const failed=buildApp({campaignRepositoryFactory:()=>repository(()=>{throw new Error("private SQL");})});const response=await failed.inject({method:"GET",url:"/api/rpg/v1/actors/actor/effects"});
    expect(response.statusCode).toBe(500);expect(response.body).not.toContain("private SQL");await failed.close();
  });
});

describe("POST /api/rpg/v1/actors/:actorId/effect-commands",()=>{
  const body={kind:"apply",effect:{source:null,modifiers:[{kind:"flat",appliesToId:"defense",amount:2}],duration:{kind:"rounds",remaining:2},recovery:"none",stacking:{kind:"coexists"}},expectedRevision:0,idempotencyKey:"apply"};
  it("uses the fixed principal and returns a strictly projected result",async()=>{
    enable();const calls:any[]=[];
    const app=buildApp({campaignRepositoryFactory:()=>repository(()=>snapshot,(...args)=>{calls.push(args);return {campaignId:"campaign",actorId:"actor",effects:[{...snapshot.effects[0],source:null,concentration:{kind:"none"},appliedAt:"2035-01-01T00:00:01.000Z"}],receipt:{commandId:"private",idempotencyKey:"apply",revisionBefore:0,revisionAfter:1,occurredAt:"2035-01-01T00:00:01.000Z"}};})});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/effect-commands",headers:{"content-type":"application/json",authorization:"Bearer attacker","x-principal-id":"attacker"},payload:body});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual([["local-owner","actor",body]]);
    expect(response.json()).toEqual({effects:[{effectId:"effect",source:null,modifiers:body.effect.modifiers,duration:body.effect.duration,recovery:"none",stacking:"coexists",appliedAt:"2035-01-01T00:00:01.000Z"}],receipt:{idempotencyKey:"apply",revisionBefore:0,revisionAfter:1,occurredAt:"2035-01-01T00:00:01.000Z"}});
    expect(response.body).not.toContain("commandId");await app.close();
  });

  it("applies route gates, media and strict request guards",async()=>{
    let calls=0;const app=buildApp({campaignRepositoryFactory:()=>repository(()=>snapshot,()=>{calls++;throw new Error();})});
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/effect-commands",headers:{"content-type":"application/json"},payload:body})).statusCode).toBe(404);
    enable();
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/effect-commands?x=1",headers:{"content-type":"application/json"},payload:body})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/effect-commands",payload:JSON.stringify(body)})).statusCode).toBe(415);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/effect-commands",headers:{"content-type":"application/json"},payload:{...body,appliedAt:"2035-01-01T00:00:00.000Z"}})).statusCode).toBe(400);
    expect((await app.inject({method:"HEAD",url:"/api/rpg/v1/actors/actor/effect-commands"})).statusCode).toBe(404);
    expect(calls).toBe(0);await app.close();
  });
});
