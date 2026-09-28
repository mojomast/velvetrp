import {describe,expect,it} from "vitest";
import {actorTravelCommandRequestSchema,actorTravelCommandResponseSchema,campaignNpcsHttpResponseSchema,
  campaignWorldHttpResponseSchema,createCampaignNpcHttpRequestSchema,createCampaignNpcHttpResponseSchema,
  npcRelationshipCommandHttpRequestSchema,npcRelationshipCommandHttpResponseSchema,campaignFactionsHttpResponseSchema,
  createCampaignFactionHttpRequestSchema,factionReputationCommandHttpRequestSchema,
  factionReactionCommandHttpRequestSchema,factionReactionCommandHttpResponseSchema,
  factionRelationCommandHttpRequestSchema,factionRelationCommandHttpResponseSchema,
  factionRelationHttpSchema,actorFactionMembershipCommandHttpRequestSchema,actorFactionMembershipCommandHttpResponseSchema,
  npcFactionMembershipCommandHttpRequestSchema,npcFactionMembershipCommandHttpResponseSchema} from "../src/index.js";
import {gmCampaignNpcsHttpResponseSchema,playerCampaignNpcsHttpResponseSchema,gmCampaignFactionsHttpResponseSchema,playerCampaignFactionsHttpResponseSchema} from "../src/index.js";

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
    expect(gmCampaignNpcsHttpResponseSchema.parse({npcs:[gmNpc],relationships:[]})).toBeTruthy();
    expect(playerCampaignNpcsHttpResponseSchema.parse({npcs:[playerNpc],relationships:[]})).toBeTruthy();
    expect(campaignNpcsHttpResponseSchema.safeParse({npcs:[gmNpc,playerNpc],relationships:[]}).success).toBe(false);
    expect(gmCampaignNpcsHttpResponseSchema.safeParse({npcs:[],relationships:[]}).success).toBe(true);
    expect(playerCampaignNpcsHttpResponseSchema.safeParse({npcs:[],relationships:[]}).success).toBe(true);
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
  it("keeps faction projections and reputation commands strict",()=>{
    const faction={factionId:"guild",name:"Guild",publicState:{description:"Traders"},createdAt:at};
    const gmFaction={...faction,privateState:{gmNotes:"Secret",visibility:"public" as const}};
    expect(playerCampaignFactionsHttpResponseSchema.parse({factions:[faction],standings:[],memberships:[],relations:[]})).toBeTruthy();
    expect(gmCampaignFactionsHttpResponseSchema.parse({factions:[gmFaction],standings:[],memberships:[],relations:[]})).toBeTruthy();
    expect(campaignFactionsHttpResponseSchema.safeParse({factions:[faction,gmFaction],standings:[],memberships:[],relations:[]}).success).toBe(false);
    expect(campaignFactionsHttpResponseSchema.safeParse({factions:[{...faction,gmNotes:"leak"}],standings:[],memberships:[],relations:[]}).success).toBe(false);
    const relation={fromFactionId:"guild",toFactionId:"rivals",disposition:"hostile" as const,updatedAt:at};
    const membership={campaignId:"campaign",factionId:"guild",actorId:"actor",role:"associate" as const,joinedAt:at};
    expect(playerCampaignFactionsHttpResponseSchema.parse({factions:[faction],standings:[],memberships:[membership],relations:[relation]})).toBeTruthy();
    expect(factionRelationHttpSchema.safeParse({...relation,toFactionId:"guild"}).success).toBe(false);
    expect(factionRelationHttpSchema.safeParse({...relation,disposition:"friendly"}).success).toBe(false);
    const relationCommand={toFactionId:"rivals",disposition:"hostile" as const,expectedRevision:1,idempotencyKey:"relation"};
    expect(factionRelationCommandHttpRequestSchema.parse(relationCommand)).toEqual(relationCommand);
    expect(factionRelationCommandHttpResponseSchema.parse({relation,receipt:{idempotencyKey:"relation",revisionBefore:1,revisionAfter:2,occurredAt:at}})).toBeTruthy();
    const actorMembershipCommand={actorId:"actor",role:"leader" as const,expectedRevision:1,idempotencyKey:"actor-membership"};
    expect(actorFactionMembershipCommandHttpRequestSchema.parse(actorMembershipCommand)).toEqual(actorMembershipCommand);
    expect(actorFactionMembershipCommandHttpResponseSchema.parse({membership,receipt:{idempotencyKey:"actor-membership",revisionBefore:1,revisionAfter:2,occurredAt:at}})).toBeTruthy();
    const npcMembershipCommand={npcId:"npc-1",role:"member" as const,expectedRevision:1,idempotencyKey:"npc-membership"};
    expect(npcFactionMembershipCommandHttpRequestSchema.parse(npcMembershipCommand)).toEqual(npcMembershipCommand);
    expect(npcFactionMembershipCommandHttpResponseSchema.parse({membership:{campaignId:"campaign",factionId:"guild",npcId:"npc-1",role:"member",joinedAt:at},
      receipt:{idempotencyKey:"npc-membership",revisionBefore:1,revisionAfter:2,occurredAt:at}})).toBeTruthy();
    expect(actorFactionMembershipCommandHttpRequestSchema.safeParse({...actorMembershipCommand,role:"ruler"}).success).toBe(false);
    const create={name:"Guild",publicState:{description:"Traders"},privateState:{gmNotes:"Secret",visibility:"public" as const},expectedRevision:0,idempotencyKey:"guild"};
    expect(createCampaignFactionHttpRequestSchema.parse(create)).toEqual(create);
    expect(createCampaignFactionHttpRequestSchema.safeParse({...create,privateState:{...create.privateState,visibility:"discovered"}}).success).toBe(false);
    const reputation={subjectActorId:"actor",delta:2,reason:"Helped",expectedRevision:1,idempotencyKey:"standing"};
    expect(factionReputationCommandHttpRequestSchema.parse(reputation)).toEqual(reputation);
    expect(factionReputationCommandHttpRequestSchema.safeParse({...reputation,delta:0}).success).toBe(false);
    const reaction={subjectActorId:"actor",delta:-2,reason:"Reacted",sourceCommandId:"check-command:1",
      expectedRevision:1,idempotencyKey:"reaction"};
    expect(factionReactionCommandHttpRequestSchema.parse(reaction)).toEqual(reaction);
    expect(factionReactionCommandHttpRequestSchema.safeParse({...reaction,delta:0}).success).toBe(false);
    expect(factionReactionCommandHttpRequestSchema.safeParse({...reaction,sourceCommandId:""}).success).toBe(false);
    expect(factionReactionCommandHttpResponseSchema.parse({standing:{factionId:"guild",subjectActorId:"actor",
      reputation:-2,updatedAt:at},receipt:{idempotencyKey:"reaction",revisionBefore:1,revisionAfter:2,occurredAt:at},
      sourceObservationId:"observation"})).toBeTruthy();
  });
});
