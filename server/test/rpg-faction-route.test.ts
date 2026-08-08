import {afterEach,describe,expect,it} from "vitest";import {buildApp} from "../src/app.js";
import type {CampaignListRepository} from "../src/routes/rpg/v1/features.js";
const at="2035-01-01T00:00:00.000Z",state={description:"Road wardens"},privateState={gmNotes:"Secret",visibility:"public" as const};
const faction={factionId:"guild",name:"Guild",publicState:state,privateState,createdAt:at};
const receipt={commandId:"private",idempotencyKey:"guild",revisionBefore:0,revisionAfter:1,occurredAt:at};
afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;});const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";};
function repo(overrides:Record<string,unknown>={}){return {listCampaignFactions:()=>({campaignId:"campaign",revision:1,factions:[faction],standings:[]}),
  createCampaignFaction:()=>({campaignId:"campaign",faction,receipt}),changeFactionReputation:()=>({campaignId:"campaign",factionId:"guild",
    standing:{factionId:"guild",subjectActorId:"actor",reputation:4,updatedAt:at},receipt:{...receipt,idempotencyKey:"rep",revisionBefore:1,revisionAfter:2}}),
  close(){},listCampaigns:()=>[],...overrides} as unknown as CampaignListRepository;}
describe("M2.10 faction routes",()=>{
  it("uses local ownership and strips internal faction provenance",async()=>{enable();const calls:any[]=[];const app=buildApp({campaignRepositoryFactory:()=>repo({
    listCampaignFactions:(...args:any[])=>{calls.push(["list",...args]);return {campaignId:"campaign",revision:1,factions:[faction],standings:[]};},
    createCampaignFaction:(...args:any[])=>{calls.push(["create",...args]);return {campaignId:"campaign",faction,receipt};},
    changeFactionReputation:(...args:any[])=>{calls.push(["rep",...args]);return {campaignId:"campaign",factionId:"guild",standing:{factionId:"guild",subjectActorId:"actor",reputation:4,updatedAt:at},receipt:{...receipt,idempotencyKey:"rep",revisionBefore:1,revisionAfter:2}};}})});
    const read=await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/factions",headers:{authorization:"attacker"}});expect(read.statusCode).toBe(200);expect(read.headers["x-world-revision"]).toBe("1");
    const createBody={name:"Guild",publicState:state,privateState,expectedRevision:0,idempotencyKey:"guild"};
    const created=await app.inject({method:"POST",url:"/api/rpg/v1/campaigns/campaign/factions",headers:{"content-type":"application/json"},payload:createBody});expect(created.statusCode).toBe(201);expect(created.body).not.toContain("commandId");
    const repBody={subjectActorId:"actor",delta:4,reason:"Helped",expectedRevision:1,idempotencyKey:"rep"};const changed=await app.inject({method:"POST",url:"/api/rpg/v1/factions/guild/reputation-commands",headers:{"content-type":"application/json"},payload:repBody});expect(changed.statusCode).toBe(200);expect(changed.body).not.toContain("commandId");
    expect(calls).toEqual([["list","local-owner","campaign"],["create","local-owner","campaign",createBody],["rep","local-owner","guild",repBody]]);await app.close();});
  it("gates and rejects invalid faction intent before repository access",async()=>{let access=0;const app=buildApp({campaignRepositoryFactory:()=>{access++;return repo();}});
    expect((await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/factions"})).statusCode).toBe(404);expect(access).toBe(0);enable();
    expect((await app.inject({method:"GET",url:"/api/rpg/v1/campaigns/campaign/factions?x=1"})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/factions/guild/reputation-commands",headers:{"content-type":"application/json"},payload:{subjectActorId:"actor",delta:0,reason:"none",expectedRevision:0,idempotencyKey:"zero"}})).statusCode).toBe(400);await app.close();});
});
