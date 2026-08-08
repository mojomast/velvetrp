import { describe, expect, it } from "vitest";
import { actorEffectCommandRequestSchema, actorEffectCommandResponseSchema, actorEffectsResponseSchema } from "../src/index.js";

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

  it("accepts only the three actor-scoped effect intents",()=>{
    const base={expectedRevision:2,idempotencyKey:"effect-command"};
    const apply={...base,kind:"apply",effect:{source,modifiers:[{kind:"flat",appliesToId:"defense",amount:2}],duration:{kind:"rounds",remaining:2},recovery:"none",stacking:{kind:"concentration",concentrationId:"focus"}}};
    const remove={...base,kind:"remove",effectId:"effect"};
    const advance={...base,kind:"advance-duration",effectId:"effect",rounds:1};
    for(const value of [apply,remove,advance])expect(actorEffectCommandRequestSchema.parse(value)).toEqual(value);
    for(const privateField of ["effectId","campaignId","actorId","appliedAt","commandId","stateRevision","script","description"])
      expect(actorEffectCommandRequestSchema.safeParse({...apply,effect:{...apply.effect,[privateField]:"caller-owned"}}).success).toBe(false);
    expect(actorEffectCommandRequestSchema.safeParse({...remove,removedAt:"2035-01-01T00:00:00.000Z"}).success).toBe(false);
    expect(actorEffectCommandRequestSchema.safeParse({...advance,advancedAt:"2035-01-01T00:00:00.000Z"}).success).toBe(false);
  });

  it("returns only effects and a public one-revision receipt",()=>{
    const value={effects:[effect("a","2035-01-01T00:00:00.000Z")],receipt:{idempotencyKey:"key",revisionBefore:2,revisionAfter:3,occurredAt:"2035-01-01T00:00:00.000Z"}};
    expect(actorEffectCommandResponseSchema.parse(value)).toEqual(value);
    expect(actorEffectCommandResponseSchema.safeParse({...value,receipt:{...value.receipt,commandId:"private"}}).success).toBe(false);
    expect(actorEffectCommandResponseSchema.safeParse({...value,receipt:{...value.receipt,revisionAfter:4}}).success).toBe(false);
  });
});
