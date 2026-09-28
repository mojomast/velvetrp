import {afterEach,describe,expect,it} from "vitest";import {buildApp} from "../src/app.js";
import type {CampaignListRepository} from "../src/routes/rpg/v1/features.js";
const at="2035-01-01T00:00:00.000Z",state={description:"Road wardens"},privateState={gmNotes:"Secret",visibility:"public" as const};
const faction={factionId:"guild",name:"Guild",publicState:state,privateState,createdAt:at};
const receipt={commandId:"private",idempotencyKey:"guild",revisionBefore:0,revisionAfter:1,occurredAt:at};
afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;});const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";};
function repo(overrides:Record<string,unknown>={}){return {listCampaignFactions:()=>({campaignId:"campaign",revision:1,audience:"gm",factions:[faction],standings:[],memberships:[],relations:[]}),
  createCampaignFaction:()=>({campaignId:"campaign",faction,receipt}),changeFactionReputation:()=>({campaignId:"campaign",factionId:"guild",
    standing:{factionId:"guild",subjectActorId:"actor",reputation:4,updatedAt:at},receipt:{...receipt,idempotencyKey:"rep",revisionBefore:1,revisionAfter:2}}),
  resolveFactionReaction:()=>({campaignId:"campaign",factionId:"guild",standing:{factionId:"guild",subjectActorId:"actor",reputation:4,updatedAt:at},
    receipt:{...receipt,idempotencyKey:"react",revisionBefore:1,revisionAfter:2},sourceObservationId:"observation:1"}),
  setFactionRelation:()=>({campaignId:"campaign",fromFactionId:"guild",relation:{fromFactionId:"guild",toFactionId:"rivals",disposition:"hostile",updatedAt:at},
    receipt:{...receipt,idempotencyKey:"rel",revisionBefore:1,revisionAfter:2}}),
  changeActorFactionMembership:()=>({campaignId:"campaign",factionId:"guild",membership:{campaignId:"campaign",factionId:"guild",actorId:"actor",role:"member",joinedAt:at},
    receipt:{...receipt,idempotencyKey:"amem",revisionBefore:1,revisionAfter:2}}),
  changeNpcFactionMembership:()=>({campaignId:"campaign",factionId:"guild",membership:{campaignId:"campaign",factionId:"guild",npcId:"npc-1",role:"member",joinedAt:at},
    receipt:{...receipt,idempotencyKey:"nmem",revisionBefore:1,revisionAfter:2}}),
  close(){},listCampaigns:()=>[],...overrides} as unknown as CampaignListRepository;}
describe("M2.10 faction routes",()=>{
  it("uses local ownership and strips internal faction provenance",async()=>{enable();const calls:any[]=[];const app=buildApp({campaignRepositoryFactory:()=>repo({
    listCampaignFactions:(...args:any[])=>{calls.push(["list",...args]);return {campaignId:"campaign",revision:1,audience:"gm",factions:[faction],standings:[],memberships:[],relations:[]};},
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
  it("routes relation, membership, and reaction commands with exact receipts",async()=>{enable();const captured:any[]=[];
    const echo=(lane:string)=>(_owner:string,id:string,input:any)=>{captured.push([lane,id,input]);return lane==="rel"
      ?{campaignId:"campaign",fromFactionId:id,relation:{fromFactionId:id,toFactionId:input.toFactionId,disposition:input.disposition,updatedAt:at},receipt:{...receipt,idempotencyKey:input.idempotencyKey,revisionBefore:input.expectedRevision,revisionAfter:input.expectedRevision+1}}
      :lane==="react"?{campaignId:"campaign",factionId:id,standing:{factionId:id,subjectActorId:input.subjectActorId,reputation:input.delta,updatedAt:at},receipt:{...receipt,idempotencyKey:input.idempotencyKey,revisionBefore:input.expectedRevision,revisionAfter:input.expectedRevision+1},sourceObservationId:"observation:1"}
      :{campaignId:"campaign",factionId:id,membership:lane==="amem"?{campaignId:"campaign",factionId:id,actorId:input.actorId,role:input.role,joinedAt:at}:{campaignId:"campaign",factionId:id,npcId:input.npcId,role:input.role,joinedAt:at},receipt:{...receipt,idempotencyKey:input.idempotencyKey,revisionBefore:input.expectedRevision,revisionAfter:input.expectedRevision+1}};};
    const app=buildApp({campaignRepositoryFactory:()=>repo({setFactionRelation:echo("rel"),changeActorFactionMembership:echo("amem"),changeNpcFactionMembership:echo("nmem"),resolveFactionReaction:echo("react")})});
    const rel=await app.inject({method:"POST",url:"/api/rpg/v1/factions/guild/relation-commands",headers:{"content-type":"application/json"},payload:{toFactionId:"rivals",disposition:"hostile",expectedRevision:0,idempotencyKey:"rel1"}});
    expect(rel.statusCode).toBe(200);expect(rel.body).not.toContain("commandId");expect(rel.json()).toMatchObject({relation:{fromFactionId:"guild",toFactionId:"rivals",disposition:"hostile"}});
    const amem=await app.inject({method:"POST",url:"/api/rpg/v1/factions/guild/actor-membership-commands",headers:{"content-type":"application/json"},payload:{actorId:"actor",role:"member",expectedRevision:1,idempotencyKey:"amem1"}});
    expect(amem.statusCode).toBe(200);expect(amem.body).not.toContain("commandId");expect(amem.json()).toMatchObject({membership:{factionId:"guild",actorId:"actor",role:"member"}});
    const nmem=await app.inject({method:"POST",url:"/api/rpg/v1/factions/guild/npc-membership-commands",headers:{"content-type":"application/json"},payload:{npcId:"npc-1",role:"leader",expectedRevision:2,idempotencyKey:"nmem1"}});
    expect(nmem.statusCode).toBe(200);expect(nmem.body).not.toContain("commandId");expect(nmem.json()).toMatchObject({membership:{factionId:"guild",npcId:"npc-1",role:"leader"}});
    const react=await app.inject({method:"POST",url:"/api/rpg/v1/factions/guild/reaction-commands",headers:{"content-type":"application/json"},payload:{subjectActorId:"actor",delta:-3,reason:"Heard the news",sourceCommandId:"check:1",expectedRevision:3,idempotencyKey:"react1"}});
    expect(react.statusCode).toBe(200);expect(react.body).not.toContain("commandId");expect(react.json()).toMatchObject({standing:{factionId:"guild",subjectActorId:"actor",reputation:-3},sourceObservationId:"observation:1"});
    expect(captured.map((entry)=>entry[0])).toEqual(["rel","amem","nmem","react"]);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/factions/guild/relation-commands",headers:{"content-type":"application/json"},payload:{toFactionId:"guild",disposition:"friendly",expectedRevision:0,idempotencyKey:"bad"}})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/api/rpg/v1/factions/guild/actor-membership-commands",headers:{"content-type":"text/plain"},payload:"x"})).statusCode).toBe(415);
    await app.close();});
});
