import { describe, expect, it } from "vitest";
import { actorPowersResponseSchema } from "../src/powers-http.js";

const ability={kind:"ability" as const,packId:"pack",packVersion:"1.0.0",definitionId:"ability"};
const spell={kind:"spell" as const,packId:"pack",packVersion:"1.0.0",definitionId:"spell"};

describe("actor powers HTTP contract",()=>{
  const valid={known:[ability,spell],prepared:[ability,spell],slots:[{slotId:"slot-1",level:1,current:1,max:2}],
    uses:[{powerRef:ability,current:0,max:1,recovery:"short-rest" as const}],
    legalNow:[{powerRef:ability,legal:false,reasons:["finite-uses-exhausted" as const]},{powerRef:spell,legal:true,reasons:[]}],revision:4};

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
});
