import { describe, expect, it } from "vitest";
import {
  applyCharacterProgressionInputSchema, grantCharacterXpInputSchema, progressionProfileSchema,
  progressionReasonSchema,
} from "../src/index.js";

describe("character progression contracts",()=>{
  it("accepts only contiguous deterministic profiles",()=>{
    expect(progressionProfileSchema.parse({profileId:"velvet:progression:test",rulesProfileId:"velvet:rules:starter-v1",mode:"xp",maxLevel:3,
      thresholds:[{level:1,xp:0},{level:2,xp:300},{level:3,xp:900}]}).thresholds).toHaveLength(3);
    expect(()=>progressionProfileSchema.parse({profileId:"bad",rulesProfileId:"rules",mode:"xp",maxLevel:2,thresholds:[{level:1,xp:0},{level:3,xp:300}]})).toThrow();
  });
  it("rejects caller totals, levels, rewards, HP, DCs, modifiers, and unknown fields",()=>{
    const base={amount:300,reason:"Completed a journey",expectedRevision:0,idempotencyKey:"award"};
    for(const field of ["totalXp","level","reward","hp","saveDc","modifier"]){expect(()=>grantCharacterXpInputSchema.parse({...base,[field]:1})).toThrow();}
    expect(()=>applyCharacterProgressionInputSchema.parse({previewRevision:0,previewToken:"a".repeat(64),selections:[],idempotencyKey:"apply",level:2})).toThrow();
  });
  it("bounds and trims correction reasons",()=>{
    expect(progressionReasonSchema.parse(" A clear reason ")).toBe("A clear reason");
    expect(()=>progressionReasonSchema.parse("x".repeat(501))).toThrow();
  });
});
