import {afterEach,describe,expect,it,vi} from "vitest";
import {buildApp} from "../src/app.js";
import {EncounterConflictError} from "../src/repo/index.js";
import type {CampaignListRepository} from "../src/routes/rpg/v1/features.js";

const at="2035-01-01T00:00:00.000Z",item={kind:"item" as const,packId:"pack",packVersion:"1",definitionId:"tonic"};
const action={legalActionId:"consume:legal",kind:"use-consumable" as const,actingCombatantId:"actor-combatant",inventoryEntryId:"entry",item,
  quantity:1 as const,actionCost:"action" as const,targetPolicy:"beneficial-only-self-or-ally" as const,
  target:{combatantId:"actor-combatant",relation:"self" as const,actorBacked:true},effectPlan:{effectCount:1,effects:[{effectOrdinal:0,effect:{kind:"healing" as const,dice:{count:1,sides:4 as const,modifier:0}}}]}};
const command={legalActionId:action.legalActionId,inventoryEntryId:"entry",item,quantity:1 as const,targetCombatantId:"actor-combatant",targetActorBacked:true,
  expectedCombatRevision:2,expectedActingM15Revision:4,expectedTargetM15Revision:4,idempotencyKey:"consume-key"};
const result={resolution:{actionId:"resolved",legalActionId:action.legalActionId,kind:"use-consumable" as const,actingCombatantId:"actor-combatant",target:action.target,
  targetPolicy:action.targetPolicy,actionCost:"action" as const,consumed:{inventoryEntryId:"entry",item,quantity:1 as const},effectPlan:action.effectPlan,
  outcome:{targetCombatantId:"actor-combatant",settlements:[{kind:"combat-hp-healing" as const,effectOrdinal:0,roll:{expression:"1d4",normalized:{count:1,sides:4,selection:{type:"all" as const},modifier:0},terms:[{value:2,kept:true}],modifier:0,total:2},requested:2,applied:2,before:5,after:7}]},
  combatRevisionBefore:2,combatRevisionAfter:3,actingM15Revision:{before:4,after:5},targetM15Revision:null},
  requestBinding:{requestEvidence:command,canonicalRequestDigest:"a".repeat(64),idempotencyKey:"consume-key"},receipt:{idempotencyKey:"consume-key",revisionBefore:2,revisionAfter:3,occurredAt:at}};

afterEach(()=>{delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;delete process.env.FEATURE_RPG_COMBAT;vi.restoreAllMocks();});
const enable=()=>{process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";process.env.FEATURE_RPG_COMBAT="true";};
function repository(overrides:Record<string,unknown>={}){return {listCampaigns:()=>[],close(){},getUseConsumableLegalActions:()=>[action],useConsumable:()=>result,
  getUseConsumableCommandResultByKey:()=>null,...overrides} as unknown as CampaignListRepository;}

describe("M5.3 consumable combat routes",()=>{
  it("returns only strict server actions with fixed ownership and no private actor or enemy resource data",async()=>{
    enable();const calls:any[]=[];const app=buildApp({campaignRepositoryFactory:()=>repository({getUseConsumableLegalActions:(...args:any[])=>{calls.push(args);return[action];}})});
    const response=await app.inject({method:"GET",url:"/api/rpg/v1/combats/combat/consumable-actions",headers:{authorization:"Bearer attacker","x-principal-id":"attacker"}});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");expect(response.json()).toEqual([action]);
    expect(response.body).not.toContain("actorId");expect(response.body).not.toContain("hitPoints");expect(response.body).not.toContain("current");
    expect(calls).toEqual([["local-owner","combat"]]);expect((await app.inject({method:"HEAD",url:"/api/rpg/v1/combats/combat/consumable-actions"})).statusCode).toBe(404);
    expect((await app.inject({method:"GET",url:"/api/rpg/v1/combats/combat/consumable-actions?x=1"})).statusCode).toBe(400);await app.close();
  });

  it("executes once, serves immutable replay reads, and rejects action mismatches before mutation",async()=>{
    enable();let executed=false;const use=vi.fn(()=>{executed=true;return result;}),read=vi.fn(()=>executed?result:null);
    const app=buildApp({campaignRepositoryFactory:()=>repository({useConsumable:use,getUseConsumableCommandResultByKey:read})});
    const posted=await app.inject({method:"POST",url:"/api/rpg/v1/combats/combat/consumable-actions/commands",headers:{"content-type":"application/json"},payload:command});
    expect(posted.statusCode).toBe(200);expect(posted.json()).toEqual(result);expect(use).toHaveBeenCalledTimes(1);
    const readResult=await app.inject({method:"GET",url:"/api/rpg/v1/combats/combat/consumable-actions/results/consume-key"});
    expect(readResult.statusCode).toBe(200);expect(readResult.json()).toEqual(result);expect(use).toHaveBeenCalledTimes(1);
    const mismatch=await app.inject({method:"POST",url:"/api/rpg/v1/combats/combat/consumable-actions/commands",headers:{"content-type":"application/json"},payload:{...command,idempotencyKey:"other",inventoryEntryId:"wrong"}});
    expect(mismatch.statusCode).toBe(409);expect(use).toHaveBeenCalledTimes(1);await app.close();
  });

  it("gates access and normalizes media, body, path, replay mismatch, and corrupt output",async()=>{
    const gated=buildApp({campaignRepositoryFactory:()=>repository()});
    expect((await gated.inject({method:"GET",url:"/api/rpg/v1/combats/combat/consumable-actions"})).statusCode).toBe(404);enable();
    expect((await gated.inject({method:"POST",url:"/api/rpg/v1/combats/combat/consumable-actions/commands",payload:JSON.stringify(command)})).statusCode).toBe(415);
    expect((await gated.inject({method:"POST",url:"/api/rpg/v1/combats/combat/consumable-actions/commands",headers:{"content-type":"application/json"},payload:{...command,extra:true}})).statusCode).toBe(400);
    for(const [method,url,code] of [["GET",`/api/rpg/v1/combats/${"x".repeat(129)}/consumable-actions`,"RPG_COMBAT_CONSUMABLE_NOT_FOUND"],
      ["HEAD","/api/rpg/v1/combats/combat/consumable-actions","RPG_ROUTE_NOT_FOUND"],
      ["HEAD","/api/rpg/v1/combats/combat/consumable-actions/results/consume-key","RPG_ROUTE_NOT_FOUND"],
      ["GET","/api/rpg/v1/combats/combat/consumable-actions/commands","RPG_ROUTE_NOT_FOUND"]] as const){
      const value=await gated.inject({method,url});expect(value.statusCode).toBe(404);expect(value.headers["cache-control"]).toBe("no-store");expect(value.json()).toMatchObject({code});
    }
    expect((await gated.inject({method:"GET",url:"/api/rpg/v1/combats/combat/consumable-actions/results/consume-key?x=1"})).json()).toMatchObject({code:"RPG_INVALID_REQUEST"});
    const lookalike=await gated.inject({method:"GET",url:"/api/rpg/v1/combats/combat/consumable-actions/results/consume-key/extra"});expect(lookalike.statusCode).toBe(404);expect(lookalike.json()).not.toMatchObject({code:"RPG_COMBAT_CONSUMABLE_NOT_FOUND"});await gated.close();
    const replay=buildApp({campaignRepositoryFactory:()=>repository({getUseConsumableCommandResultByKey:()=>result,useConsumable:()=>{throw new EncounterConflictError();}})});
    const response=await replay.inject({method:"POST",url:"/api/rpg/v1/combats/combat/consumable-actions/commands",headers:{"content-type":"application/json"},payload:{...command,inventoryEntryId:"other"}});
    expect(response.statusCode).toBe(409);expect(response.body).not.toContain("actorId");await replay.close();
    const uncertain=buildApp({campaignRepositoryFactory:()=>repository({useConsumable:()=>{throw new Error("unknown");}})});
    const failed=await uncertain.inject({method:"POST",url:"/api/rpg/v1/combats/combat/consumable-actions/commands",headers:{"content-type":"application/json"},payload:command});
    expect(failed.statusCode).toBe(500);expect(failed.json()).toMatchObject({code:"RPG_INTERNAL_ERROR"});expect(failed.json().detail).toMatch(/Do not retry POST while unresolved/);await uncertain.close();
  });
});
