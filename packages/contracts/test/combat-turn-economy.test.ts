import { describe, expect, it } from "vitest";
import { combatStateSchema, combatTurnEconomySchema } from "../src/encounters-http.js";
import { currencyCodeSchema } from "../src/economy.js";

describe("turn economy and currency boundaries",()=>{
  const economy={turnId:"turn",combatantId:"hero",round:1,action:{available:false,used:true},
    bonusAction:{available:true,used:false},reaction:{available:true,used:false},
    movement:{allowanceFeet:30,usedFeet:10,remainingFeet:20}};
  it("validates safe remaining resources and exact turn binding",()=>{
    expect(combatTurnEconomySchema.parse(economy)).toEqual(economy);
    expect(combatTurnEconomySchema.safeParse({...economy,movement:{...economy.movement,remainingFeet:30}}).success).toBe(false);
    expect(combatTurnEconomySchema.safeParse({...economy,action:{available:true,used:true}}).success).toBe(false);
    const combat={combatId:"combat",round:1,currentCombatant:"hero",combatants:[{combatantId:"hero",kind:"actor",actorId:"actor",team:"allies",hitPoints:10,maximumHitPoints:10,status:"active"}],revision:3,turnEconomy:economy,legalActions:[]};
    expect(combatStateSchema.safeParse(combat).success).toBe(true);
    expect(combatStateSchema.safeParse({...combat,round:2}).success).toBe(false);
    expect(combatStateSchema.safeParse({...combat,legalActions:[{legalActionId:"attack:basic",kind:"attack",targetIds:[],cost:"action"}]}).success).toBe(false);
  });
  it("accepts GP without permitting lowercase or unsafe currency codes",()=>{
    for(const code of ["GP","SP","CP","GLM","A._:-9"])expect(currencyCodeSchema.parse(code)).toBe(code);
    for(const code of ["G","gp","GP ","GP/","A".repeat(17)])expect(currencyCodeSchema.safeParse(code).success).toBe(false);
  });
});
