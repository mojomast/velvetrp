import {describe,expect,it} from "vitest";
import {actorTravelCommandRequestSchema,actorTravelCommandResponseSchema,campaignWorldHttpResponseSchema} from "../src/index.js";

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
});
