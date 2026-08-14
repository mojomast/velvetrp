import {afterEach,describe,expect,it} from "vitest";
import {buildApp} from "../src/app.js";
import type {CampaignListRepository} from "../src/routes/rpg/v1/features.js";

const at="2035-01-01T00:00:00.000Z";
const world={campaignId:"campaign",sessionId:"session",revision:2,
  currentLocations:[{actorId:"actor",locationId:"origin",revision:0,updatedAt:at}],
  visibleLocations:[{locationId:"origin",parentLocationId:null,name:"Origin",description:""}],visibleConnections:[]};
const travel={campaignId:"campaign",sessionId:"session",
  locations:[{actorId:"actor",locationId:"destination",revision:1,updatedAt:at}],
  discoveries:[{actorId:"actor",locationId:"destination",discoveredAt:at}],
  receipt:{commandId:"private",idempotencyKey:"travel",revisionBefore:2,revisionAfter:3,occurredAt:at}};
afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;});
const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";};
function repository(overrides:Record<string,unknown>={}){return {getCampaignWorld:()=>world,travelActor:()=>travel,
  placeActor:()=>({campaignId:"campaign",sessionId:"session",location:world.currentLocations[0],receipt:travel.receipt}),
  close(){},listCampaigns:()=>[],...overrides} as unknown as CampaignListRepository;}

describe("M2.10 world routes",()=>{
  it("uses fixed local ownership and returns only route-safe world state",async()=>{
    enable();const calls:any[]=[];const app=buildApp({campaignRepositoryFactory:()=>repository({
      getCampaignWorld:(...args:any[])=>{calls.push(["world",...args]);return world;},
      travelActor:(...args:any[])=>{calls.push(["travel",...args]);return travel;},
    })});const hostile={authorization:"Bearer attacker","x-principal-id":"attacker"};
    const read=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/world",headers:hostile});
    expect(read.statusCode).toBe(200);expect(read.headers["cache-control"]).toBe("no-store");expect(read.headers["x-world-revision"]).toBe("2");
    expect(read.json()).toEqual({currentLocations:world.currentLocations,visibleLocations:world.visibleLocations,visibleConnections:[]});
    const body={connectionId:"road",partyActorIds:["actor"],expectedRevision:2,idempotencyKey:"travel"};
    const moved=await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/travel-commands",
      headers:{...hostile,"content-type":"application/json"},payload:body});
    expect(moved.statusCode).toBe(200);expect(moved.body).not.toContain("campaignId");expect(moved.body).not.toContain("commandId");
    expect(moved.json()).toEqual({locations:travel.locations,discoveries:travel.discoveries,
      receipt:{idempotencyKey:"travel",revisionBefore:2,revisionAfter:3,occurredAt:at}});
    expect(calls).toEqual([["world","local-owner","campaign"],["travel","local-owner","actor",body]]);await app.close();
  });
  it("gates and normalizes query, media, body, paths, and methods before mutation",async()=>{
    let accesses=0,calls=0;const app=buildApp({campaignRepositoryFactory:()=>{accesses++;return repository({travelActor:()=>{calls++;throw new Error();}});}});
    const body={connectionId:"road",partyActorIds:["actor"],expectedRevision:0,idempotencyKey:"travel"};
    expect((await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/world"})).statusCode).toBe(404);expect(accesses).toBe(0);enable();
    expect((await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/world?x=1"})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/travel-commands",payload:JSON.stringify(body)})).statusCode).toBe(415);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/travel-commands",headers:{"content-type":"application/json"},payload:{...body,destination:"x"}})).statusCode).toBe(400);
    const overlong=await app.inject({method:"POST",url:`/api/rpg/v1/actors/${"x".repeat(129)}/travel-commands`,
      headers:{"content-type":"application/json"},payload:body});
    expect(overlong.statusCode).toBe(404);expect(overlong.json()).toMatchObject({code:"RPG_ACTOR_WORLD_NOT_FOUND",
      instance:"/api/rpg/v1/actors/:actorId/travel-commands"});expect(calls).toBe(0);await app.close();
  });
  it("treats a mismatched placement projection as commit-ambiguous",async()=>{
    enable();const app=buildApp({campaignRepositoryFactory:()=>repository({placeActor:()=>({campaignId:"other-campaign",sessionId:"session",location:world.currentLocations[0],receipt:{...travel.receipt,idempotencyKey:"place",revisionBefore:2,revisionAfter:3}})})});
    const response=await app.inject({method:"POST",url:"/api/rpg/v1/actors/actor/placement-commands",headers:{"content-type":"application/json"},payload:{campaignId:"campaign",locationId:"origin",expectedRevision:2,idempotencyKey:"place"}});
    expect(response.statusCode).toBe(500);expect(response.body).toContain("do not automatically retry");expect(response.body).not.toContain("other-campaign");await app.close();
  });
});
