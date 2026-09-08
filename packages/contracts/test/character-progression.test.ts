import { describe, expect, it } from "vitest";
import {
  applyCharacterProgressionInputSchema, grantCharacterXpInputSchema, progressionProfileSchema,
  progressionReasonSchema, classLevelCatalogDefinitionSchema, SRD_5_1_STARTER_IDENTITY,
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
  it("keeps level rewards closed to catalog resource capacities",()=>{
    const reference={packId:SRD_5_1_STARTER_IDENTITY.packId,packVersion:SRD_5_1_STARTER_IDENTITY.packVersion,kind:"class-level" as const,definitionId:"srd-5.1:class-level:barbarian-1"};
    const classRef={packId:reference.packId,packVersion:reference.packVersion,kind:"class" as const,definitionId:"srd-5.1:class:barbarian"};
    const ability={packId:reference.packId,packVersion:reference.packVersion,kind:"ability" as const,definitionId:"srd-5.1:ability:barbarian-rage"};
    expect(classLevelCatalogDefinitionSchema.parse({reference,name:"Barbarian Level 1",description:"Bounded",tags:["srd-5.1"],mechanics:{classRef,level:1,proficiencyBonus:2,hpGain:12,abilityRefs:[ability],spellRefs:[],resourceGrants:[{resourceId:"rage",maxIncrease:2,currentIncrease:2}]}}).mechanics.resourceGrants).toEqual([{resourceId:"rage",maxIncrease:2,currentIncrease:2}]);
    expect(()=>classLevelCatalogDefinitionSchema.parse({reference,name:"Forged",description:"Bounded",tags:["srd-5.1"],mechanics:{classRef,level:1,proficiencyBonus:2,hpGain:12,abilityRefs:[ability],spellRefs:[],resourceGrants:[{resourceId:"rage",maxIncrease:1,currentIncrease:2}]}})).toThrow();
  });
});
