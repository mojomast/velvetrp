import {describe,expect,it} from "vitest";
import {actorTravelCommandRequestSchema,actorTravelCommandResponseSchema,campaignNpcsHttpResponseSchema,
  campaignWorldHttpResponseSchema,createCampaignNpcHttpRequestSchema,createCampaignNpcHttpResponseSchema,
  npcRelationshipCommandHttpRequestSchema,npcRelationshipCommandHttpResponseSchema} from "../src/index.js";

const at="2035-01-01T00:00:00.000Z";
describe("world HTTP contracts",()=>{
  it("keeps campaign world projections strict",()=>{
    const response={currentLocations:[{actorId:"actor",locationId:"origin",revision:0,updatedAt:at}],
      visibleLocations:[{locationId:"origin",parentLocationId:null,name:"Origin",description:""}],
      visibleConnections:[]};
    expect(campaignWorldHttpResponseSchema.parse(response)).toEqual(response);
    expect(campaignWorldHttpResponseSchema.safeParse({...response,gmNotes:"secret"}).success).toBe(false);
  });
  it("accepts only actor-bound travel intent and consistent results",()=>{
    const request={connectionId:"road",partyActorIds:["actor"],expectedRevision:0,idempotencyKey:"travel"};
    expect(actorTravelCommandRequestSchema.parse(request)).toEqual(request);
    expect(actorTravelCommandRequestSchema.safeParse({...request,destinationLocationId:"destination"}).success).toBe(false);
    expect(actorTravelCommandRequestSchema.safeParse({...request,partyActorIds:["actor","actor"]}).success).toBe(false);
    const response={locations:[{actorId:"actor",locationId:"destination",revision:1,updatedAt:at}],
      discoveries:[{actorId:"actor",locationId:"destination",discoveredAt:at}],
      receipt:{idempotencyKey:"travel",revisionBefore:0,revisionAfter:1,occurredAt:at}};
    expect(actorTravelCommandResponseSchema.parse(response)).toEqual(response);
    expect(actorTravelCommandResponseSchema.safeParse({...response,discoveries:[{...response.discoveries[0]!,locationId:"other"}]}).success).toBe(false);
  });
  it("separates GM NPC state from player projections and keeps commands strict",()=>{
    const publicState={name:"Marrow"},privateState={goals:"Trade",gmNotes:"Knows the passphrase",merchantState:{stock:3}};
    const gmNpc={npcId:"npc",personaId:"persona",publicState,privateState,createdAt:at};
    const playerNpc={npcId:"npc",publicState,createdAt:at};
    expect(campaignNpcsHttpResponseSchema.parse({npcs:[gmNpc,playerNpc],relationships:[]})).toBeTruthy();
    expect(campaignNpcsHttpResponseSchema.safeParse({npcs:[{...playerNpc,privateState}],relationships:[]}).success).toBe(false);
    const create={personaId:"persona",publicState,privateState,expectedRevision:0,idempotencyKey:"create-npc"};
    expect(createCampaignNpcHttpRequestSchema.parse(create)).toEqual(create);
    expect(createCampaignNpcHttpRequestSchema.safeParse({...create,gmNotes:"leak"}).success).toBe(false);
    const receipt={idempotencyKey:"create-npc",revisionBefore:0,revisionAfter:1,occurredAt:at};
    expect(createCampaignNpcHttpResponseSchema.parse({npc:gmNpc,receipt})).toBeTruthy();
    const relationship={subjectActorId:"actor",affinityDelta:1,trustDelta:0,fearDelta:0,reason:"Helped",
      expectedRevision:1,idempotencyKey:"relationship"};
    expect(npcRelationshipCommandHttpRequestSchema.parse(relationship)).toEqual(relationship);
    expect(npcRelationshipCommandHttpRequestSchema.safeParse({...relationship,affinityDelta:0}).success).toBe(false);
    expect(npcRelationshipCommandHttpResponseSchema.parse({relationship:{npcId:"npc",subjectActorId:"actor",
      affinity:1,trust:0,fear:0,updatedAt:at},receipt:{...receipt,idempotencyKey:"relationship",revisionBefore:1,revisionAfter:2}})).toBeTruthy();
  });
  it("rejects merchant state that cannot fit durable storage",()=>{
    const request={personaId:"persona",publicState:{name:"Marrow"},privateState:{goals:"",gmNotes:"",
      merchantState:{payload:"x".repeat(16_000)}},expectedRevision:0,idempotencyKey:"create-npc"};
    expect(createCampaignNpcHttpRequestSchema.safeParse(request).success).toBe(false);
  });
});
