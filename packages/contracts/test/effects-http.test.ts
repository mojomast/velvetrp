import { describe, expect, it } from "vitest";
import { actorEffectsResponseSchema } from "../src/index.js";

const source={kind:"ability" as const,packId:"pack",packVersion:"1.0.0",definitionId:"ability"};
const effect=(effectId:string,appliedAt:string,stacking:"coexists"|"concentration"="coexists")=>({
  effectId,source,modifiers:[{kind:"flat" as const,appliesToId:"defense",amount:2}],
  duration:{kind:"until_removed" as const},recovery:"none" as const,stacking,appliedAt,
});

describe("actor effects HTTP contracts",()=>{
  it("accepts only ordered effects and exact ordered concentration bindings",()=>{
    const value={effects:[effect("a","2035-01-01T00:00:00.000Z"),effect("b","2035-01-01T00:00:01.000Z","concentration")],concentration:[{effectId:"b",concentrationId:"focus"}],revision:4};
    expect(actorEffectsResponseSchema.parse(value)).toEqual(value);
    expect(actorEffectsResponseSchema.safeParse({...value,effects:[value.effects[1],value.effects[0]]}).success).toBe(false);
    expect(actorEffectsResponseSchema.safeParse({...value,concentration:[]}).success).toBe(false);
    expect(actorEffectsResponseSchema.safeParse({...value,concentration:[{effectId:"a",concentrationId:"focus"}]}).success).toBe(false);
  });

  it("structurally rejects private provenance and duplicate identities",()=>{
    const base={effects:[effect("a","2035-01-01T00:00:00.000Z")],concentration:[],revision:0};
    for(const privateField of ["campaignId","actorId","commandId","controllerPrincipalId","rawCommand","gmNotes"]){
      expect(actorEffectsResponseSchema.safeParse({...base,effects:[{...base.effects[0],[privateField]:"private"}]}).success).toBe(false);
    }
    expect(actorEffectsResponseSchema.safeParse({...base,effects:[base.effects[0],base.effects[0]]}).success).toBe(false);
    expect(actorEffectsResponseSchema.safeParse({...base,extra:true}).success).toBe(false);
  });
});
