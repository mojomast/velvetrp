import { describe, expect, it } from "vitest";
import { actorPowerCommandRequestSchema, actorPowerCommandResponseSchema, actorPowersResponseSchema } from "../src/powers-http.js";

const ability={kind:"ability" as const,packId:"pack",packVersion:"1.0.0",definitionId:"ability"};
const spell={kind:"spell" as const,packId:"pack",packVersion:"1.0.0",definitionId:"spell"};

describe("actor powers HTTP contract",()=>{
  const valid={known:[ability,spell],prepared:[ability,spell],slots:[{slotId:"slot-1",level:1,current:1,max:2}],
    uses:[{powerRef:ability,current:0,max:1,recovery:"short-rest" as const}],
    legalNow:[{powerRef:ability,legal:false,reasons:["finite-uses-exhausted" as const]},{powerRef:spell,legal:true,reasons:[]}],
    legalCommands:[{powerRef:spell,targeting:"single" as const,validTargets:[{actorId:"target",label:"Target"}],costs:[{kind:"slot" as const,slotId:"slot-1",amount:1 as const}],concentration:true,effectKinds:["damage" as const]}],revision:4};

  it("accepts the strict, bound starter projection",()=>{
    expect(actorPowersResponseSchema.parse(valid)).toEqual(valid);
  });

  it("rejects private fields, preparation control, ordering, invalid slots, and dishonest legality",()=>{
    expect(actorPowersResponseSchema.safeParse({...valid,campaignId:"private"}).success).toBe(false);
    expect(actorPowersResponseSchema.safeParse({...valid,prepared:[ability]}).success).toBe(false);
    expect(actorPowersResponseSchema.safeParse({...valid,known:[spell,ability],prepared:[spell,ability]}).success).toBe(false);
    expect(actorPowersResponseSchema.safeParse({...valid,slots:[{slotId:"slot-2",level:1,current:1,max:1}]}).success).toBe(false);
    expect(actorPowersResponseSchema.safeParse({...valid,legalNow:[{powerRef:ability,legal:true,reasons:["finite-uses-exhausted"]},{powerRef:spell,legal:true,reasons:[]}]}).success).toBe(false);
  });

  it("defines strict actor-only command intent and a player-safe resolution",()=>{
    const request={powerRef:ability,targetIds:["target"],choices:[],expectedRevision:2,idempotencyKey:"use"};
    expect(actorPowerCommandRequestSchema.parse(request)).toEqual(request);
    for(const extra of [{...request,costs:[]},{...request,actorId:"actor"},{...request,choices:["authority"]},{...request,targetIds:["target","target"]}])
      expect(actorPowerCommandRequestSchema.safeParse(extra).success).toBe(false);
    const response={resolution:{powerUseId:"use-1",powerRef:ability,targetIds:["target"],costs:[],outcomes:[],stateDeltas:[]},actorStates:[
      {actorId:"actor",resources:[],activeEffects:[],revision:3},{actorId:"target",resources:[],activeEffects:[],revision:1},
    ],receipt:{idempotencyKey:"use",revisionBefore:2,revisionAfter:3,occurredAt:"2035-01-01T00:00:00.000Z"}};
    expect(actorPowerCommandResponseSchema.parse(response)).toEqual(response);
    expect(actorPowerCommandResponseSchema.safeParse({...response,campaignId:"private"}).success).toBe(false);
    expect(actorPowerCommandResponseSchema.safeParse({...response,receipt:{...response.receipt,commandId:"private"}}).success).toBe(false);
  });
});
