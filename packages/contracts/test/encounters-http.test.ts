import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encounterCreateRequestSchema,
  encounterCreateResponseSchema,
  encounterStartCommandResponseSchema,
  combatLogQuerySchema,
  combatLogResponseSchema,
  combatActionCommandRequestSchema,
  combatActionCommandResponseSchema,
  combatEndCommandRequestSchema,
  combatEndCommandResponseSchema,
  combatCommandResultResponseSchema,
  evaluateUseConsumableEligibility,
  canonicalUseConsumableRequestFrame,
  deriveUseConsumableEffectPlan,
  useConsumableCommandRequestSchema,
  useConsumableCommandResultSchema,
  useConsumableLegalActionSchema,
  useConsumableResolutionSchema,
  useConsumableSettlementSchema,
  verifyUseConsumableCommandResultBinding,
  verifyUseConsumableEffectPlan,
  verifyUseConsumableRequestDigest,
} from "../src/index.js";

const at="2035-01-01T00:00:00.000Z";
const combatant={combatantId:"combatant",kind:"actor" as const,team:"allies" as const,actorId:"actor"};

describe("encounter HTTP contracts",()=>{
  it("accepts preparation intent while rejecting caller-authored mechanics",()=>{
    const request={sessionId:"session",name:"Bridge ambush",combatants:[{kind:"actor",actorId:"actor",team:"allies"}],
      idempotencyKey:"prepare"};
    expect(encounterCreateRequestSchema.parse(request)).toEqual(request);
    for(const authoritative of ["encounterId","initiative","hitPoints","tactic","createdAt"]){
      expect(encounterCreateRequestSchema.safeParse({...request,[authoritative]:authoritative}).success).toBe(false);
    }
    expect(encounterCreateRequestSchema.safeParse({...request,combatants:[...request.combatants,request.combatants[0]]}).success).toBe(false);
  });

  it("keeps lifecycle and combat projections strict and revision-bound",()=>{
    const encounter={encounterId:"encounter",sessionId:"session",name:"Bridge ambush",status:"preparing" as const,
      combatId:null,combatants:[combatant],revision:1,createdAt:at,updatedAt:at};
    expect(encounterCreateResponseSchema.parse({encounter})).toEqual({encounter});
    expect(encounterCreateResponseSchema.safeParse({encounter:{...encounter,gmNotes:"secret"}}).success).toBe(false);
    const combat={combatId:"encounter",round:1,currentCombatant:"combatant",combatants:[{...combatant,hitPoints:10,
      maximumHitPoints:10,status:"active"}],legalActions:[{legalActionId:"defend",kind:"defend",targetIds:[]}],revision:2};
    const response={combat,receipt:{idempotencyKey:"start",revisionBefore:1,revisionAfter:2,occurredAt:at}};
    expect(encounterStartCommandResponseSchema.parse(response)).toEqual(response);
    expect(encounterStartCommandResponseSchema.safeParse({...response,receipt:{...response.receipt,revisionAfter:3}}).success).toBe(false);
    expect(encounterStartCommandResponseSchema.safeParse({...response,combat:{...combat,currentCombatant:"other"}}).success).toBe(false);
  });

  it("validates bounded append-only combat log pages",()=>{
    expect(combatLogQuerySchema.parse({afterSequence:"0",limit:"50"})).toEqual({afterSequence:0,limit:50});
    expect(combatLogQuerySchema.safeParse({afterSequence:0,limit:101}).success).toBe(false);
    const entries=[{logEntryId:"log-1",sequence:1,occurredAt:at,event:{kind:"encounter_created" as const}},
      {logEntryId:"log-2",sequence:2,occurredAt:at,event:{kind:"combatant_state_changed" as const,
        combatantId:"combatant",hitPoints:8,status:"active" as const}}];
    expect(combatLogResponseSchema.parse({entries,nextAfterSequence:2})).toEqual({entries,nextAfterSequence:2});
    expect(combatLogResponseSchema.safeParse({entries:[...entries].reverse(),nextAfterSequence:null}).success).toBe(false);
    expect(combatLogResponseSchema.safeParse({entries,nextAfterSequence:1}).success).toBe(false);
  });

  it("accepts action intent without caller-authored mechanics and validates resolution bindings",()=>{
    const request={legalActionId:"attack:basic",targetIds:["enemy"],choices:[],expectedRevision:2,idempotencyKey:"attack"};
    expect(combatActionCommandRequestSchema.parse(request)).toEqual(request);
    expect(combatActionCommandRequestSchema.safeParse({...request,damage:99}).success).toBe(false);
    expect(combatActionCommandRequestSchema.safeParse({...request,choices:["critical"]}).success).toBe(false);
    const enemy={combatantId:"enemy",kind:"enemy" as const,team:"enemies" as const,template:null,hitPoints:7,
      maximumHitPoints:8,status:"active" as const};
    const combat={combatId:"encounter",round:1,currentCombatant:"enemy",combatants:[{...combatant,hitPoints:10,
      maximumHitPoints:10,status:"active" as const},enemy],legalActions:[{legalActionId:"end-turn",kind:"end-turn" as const,targetIds:[]}],revision:3};
    const resolution={actionId:"action",legalActionId:"attack:basic",kind:"attack" as const,actingCombatantId:"combatant",
      targetIds:["enemy"],outcomes:[{kind:"damage" as const,targetId:"enemy",damageType:"physical" as const,requested:1 as const,
        applied:1,hitPointsBefore:8,hitPointsAfter:7,statusBefore:"active" as const,statusAfter:"active" as const}],roundBefore:1,
      roundAfter:1,currentCombatantBefore:"combatant",currentCombatantAfter:"enemy"};
    const response={resolution,combat,receipt:{idempotencyKey:"attack",revisionBefore:2,revisionAfter:3,occurredAt:at}};
    expect(combatActionCommandResponseSchema.parse(response)).toEqual(response);
    expect(combatActionCommandResponseSchema.safeParse({...response,combat:{...combat,revision:4}}).success).toBe(false);
  });

  it("keeps rewards server-owned and requires completed end projections",()=>{
    const request={expectedRevision:5,idempotencyKey:"end"};
    expect(combatEndCommandRequestSchema.parse(request)).toEqual(request);
    expect(combatEndCommandRequestSchema.safeParse({...request,rewards:[]}).success).toBe(false);
    const completed={encounterId:"encounter",sessionId:"session",name:"Bridge ambush",status:"completed" as const,
      combatId:"encounter",combatants:[combatant],revision:6,createdAt:at,updatedAt:at};
    const reward={rewardBundleId:"bundle",recipientActorId:"actor",createdAt:at,rewards:[{kind:"currency" as const,
      currency:{kind:"currency" as const,packId:"pack",packVersion:"1.0.0",definitionId:"glimmer"},amount:1}]};
    const response={encounter:completed,rewards:[reward],receipt:{idempotencyKey:"end",revisionBefore:5,revisionAfter:6,occurredAt:at}};
    expect(combatEndCommandResponseSchema.parse(response)).toEqual(response);
    expect(combatEndCommandResponseSchema.safeParse({...response,encounter:{...completed,status:"active"}}).success).toBe(false);
    expect(combatEndCommandResponseSchema.safeParse({...response,rewards:[reward,reward]}).success).toBe(false);
  });

  describe("standalone M5.3 consumable prerequisite",()=>{
    const itemReference={kind:"item" as const,packId:"starter",packVersion:"1.0.0",definitionId:"tonic"};
    const currency={kind:"currency" as const,packId:"starter",packVersion:"1.0.0",definitionId:"glimmer"};
    const item=(effects: Array<Record<string, unknown>>, category="consumable")=>({
      reference:itemReference,name:"Tonic",description:"A fixed tonic.",tags:[],
      mechanics:{category,stackable:true,slot:null,price:{currency,amount:1},effects},
    });
    const roll={expression:"1d6",normalized:{count:1,sides:6,selection:{type:"all" as const},modifier:0},
      terms:[{value:4,kept:true}],modifier:0,total:4};

    const sha256=(value:string)=>createHash("sha256").update(value,"utf8").digest("hex");
    const damageEffect={type:"damage",damageType:"fire",dice:{count:1,sides:6,modifier:0}};
    const guardEffect={type:"resource",resource:"guard",amount:-2};
    const catalogItem=item([damageEffect,guardEffect]);
    const effectPlan={effectCount:2,effects:[
      {effectOrdinal:0,effect:{kind:"damage",damageType:"fire",dice:{count:1,sides:6,modifier:0}}},
      {effectOrdinal:1,effect:{kind:"resource",resource:"guard",amount:-2}},
    ]};

    it("freezes eligibility and target policy without rejecting no-ops or mixed effects",()=>{
      expect(evaluateUseConsumableEligibility(item([{type:"damage",damageType:"fire",dice:{count:1,sides:6,modifier:0}}]) as never))
        .toEqual({eligible:true,targetPolicy:"damage-only-enemy"});
      expect(evaluateUseConsumableEligibility(item([{type:"healing",dice:{count:1,sides:6,modifier:0}},
        {type:"resource",resource:"guard",amount:2},{type:"modifier",statistic:"defense",amount:1,duration:"instant"}]) as never))
        .toEqual({eligible:true,targetPolicy:"beneficial-only-self-or-ally"});
      expect(evaluateUseConsumableEligibility(item([{type:"resource",resource:"focus",amount:0},
        {type:"modifier",statistic:"defense",amount:0,duration:"instant"}]) as never))
        .toEqual({eligible:true,targetPolicy:"beneficial-only-self-or-ally"});
      expect(evaluateUseConsumableEligibility(item([{type:"damage",damageType:"fire",dice:{count:1,sides:6,modifier:0}},
        {type:"resource",resource:"focus",amount:0}]) as never))
        .toEqual({eligible:true,targetPolicy:"damage-only-enemy"});
      expect(evaluateUseConsumableEligibility(item([{type:"damage",damageType:"fire",dice:{count:1,sides:6,modifier:0}},
        {type:"healing",dice:{count:1,sides:6,modifier:0}}]) as never))
        .toEqual({eligible:true,targetPolicy:"single-target"});

      const rejected=[
        item([],"consumable"),
        item([{type:"modifier",statistic:"defense",amount:1,duration:"encounter"}],"gear"),
        item([{type:"condition",condition:"guarded",durationRounds:1}]),
        item([{type:"resource",resource:"spell-slot",amount:1}]),
      ];
      for(const candidate of rejected)expect(evaluateUseConsumableEligibility(candidate as never).eligible).toBe(false);
      expect(evaluateUseConsumableEligibility(rejected[1] as never)).toEqual({
        eligible:false,reasons:["not-consumable","noninstant-modifier"],
      });
      expect(evaluateUseConsumableEligibility(rejected[3] as never)).toEqual({
        eligible:false,reasons:["spell-slot-level-identity-unavailable"],
      });
    });

    it("derives and verifies an exact immutable plan from pinned catalog mechanics",()=>{
      expect(deriveUseConsumableEffectPlan(catalogItem,itemReference)).toEqual(effectPlan);
      expect(verifyUseConsumableEffectPlan(catalogItem,itemReference,effectPlan)).toBe(true);
      expect(verifyUseConsumableEffectPlan(catalogItem,{...itemReference,definitionId:"other"},effectPlan)).toBe(false);
      expect(verifyUseConsumableEffectPlan(item([{...damageEffect,damageType:"frost"},guardEffect]),itemReference,effectPlan)).toBe(false);
      expect(verifyUseConsumableEffectPlan(catalogItem,itemReference,{...effectPlan,effects:[...effectPlan.effects].reverse()})).toBe(false);
      expect(verifyUseConsumableEffectPlan(catalogItem,itemReference,{...effectPlan,effects:[effectPlan.effects[0]]})).toBe(false);
      expect(verifyUseConsumableEffectPlan({},itemReference,effectPlan)).toBe(false);

      const action={legalActionId:"consume:tonic:enemy",kind:"use-consumable",actingCombatantId:"actor-combatant",
        inventoryEntryId:"entry-1",item:itemReference,quantity:1,actionCost:"action",targetPolicy:"damage-only-enemy",
        target:{combatantId:"enemy-combatant",relation:"enemy",actorBacked:true},effectPlan};
      expect(useConsumableLegalActionSchema.parse(action)).toEqual(action);
      expect(useConsumableLegalActionSchema.safeParse({...action,quantity:2}).success).toBe(false);
      expect(useConsumableLegalActionSchema.safeParse({...action,actionCost:"bonus-action"}).success).toBe(false);
      expect(useConsumableLegalActionSchema.safeParse({...action,target:{combatantId:"ally",relation:"ally",actorBacked:true}}).success).toBe(false);
      expect(useConsumableLegalActionSchema.safeParse({...action,effectPlan:{...action.effectPlan,effectCount:1}}).success).toBe(false);
      expect(useConsumableLegalActionSchema.safeParse({...action,effectPlan:{...effectPlan,effects:[...effectPlan.effects].reverse()}}).success).toBe(false);
      expect(useConsumableLegalActionSchema.safeParse({...action,target:{combatantId:"actor-combatant",relation:"ally",actorBacked:true}}).success).toBe(false);
      expect(combatCommandResultResponseSchema.safeParse({operation:"use-consumable",result:{}}).success).toBe(false);
    });

    it("requires target M1.5 concurrency exactly when the target is actor-backed",()=>{
      const request={legalActionId:"consume:tonic:enemy",inventoryEntryId:"entry-1",item:itemReference,quantity:1,
        targetCombatantId:"enemy-combatant",targetActorBacked:true,expectedCombatRevision:7,
        expectedActingM15Revision:11,expectedTargetM15Revision:4,idempotencyKey:"consume-1"};
      expect(useConsumableCommandRequestSchema.parse(request)).toEqual(request);
      expect(useConsumableCommandRequestSchema.safeParse({...request,targetActorBacked:false,expectedTargetM15Revision:null}).success).toBe(true);
      expect(useConsumableCommandRequestSchema.safeParse({...request,expectedTargetM15Revision:null}).success).toBe(false);
      expect(useConsumableCommandRequestSchema.safeParse({...request,targetActorBacked:false}).success).toBe(false);
      expect(useConsumableCommandRequestSchema.safeParse({...request,targetActorId:"private"}).success).toBe(false);
      for(const extra of [
        {...request,quantity:2},{...request,effects:[]},{...request,roll},{...request,amount:4},
        {...request,actionCost:"action"},{...request,targetCombatantIds:["enemy-combatant"]},{...request,effectKinds:["damage"]},
      ])expect(useConsumableCommandRequestSchema.safeParse(extra).success).toBe(false);
    });

    it("freezes roll binding and exact damage adjustment ceilings",()=>{
      const damage={kind:"combat-hp-damage",effectOrdinal:0,damageType:"fire",roll,requested:4,
        adjustment:"none",applied:4,before:8,after:4};
      for(const valid of [damage,{...damage,adjustment:"immunity",applied:0,after:8},
        {...damage,adjustment:"resistance",applied:2,after:6},{...damage,adjustment:"vulnerability",applied:8,after:0},
        {...damage,adjustment:"vulnerability",applied:3,before:3,after:0}])
        expect(useConsumableSettlementSchema.safeParse(valid).success).toBe(true);
      for(const invalid of [{...damage,requested:5},{...damage,applied:3,after:5},
        {...damage,adjustment:"immunity",applied:1,after:7},{...damage,adjustment:"resistance",applied:3,after:5},
        {...damage,adjustment:"vulnerability",applied:2,before:3,after:1}])
        expect(useConsumableSettlementSchema.safeParse(invalid).success).toBe(false);
    });

    it("freezes a versioned canonical request frame and fails digest verification closed",()=>{
      const request={legalActionId:"consume:tonic:enemy",inventoryEntryId:"entry-1",item:itemReference,quantity:1,
        targetCombatantId:"enemy-combatant",targetActorBacked:true,expectedCombatRevision:7,
        expectedActingM15Revision:11,expectedTargetM15Revision:4,idempotencyKey:"consume-1"};
      const frame=canonicalUseConsumableRequestFrame(request);
      expect(frame).toBe("{\"version\":\"velvet.use-consumable-request.v1\",\"legalActionId\":\"consume:tonic:enemy\",\"inventoryEntryId\":\"entry-1\",\"item\":{\"kind\":\"item\",\"packId\":\"starter\",\"packVersion\":\"1.0.0\",\"definitionId\":\"tonic\"},\"quantity\":1,\"targetCombatantId\":\"enemy-combatant\",\"targetActorBacked\":true,\"expectedCombatRevision\":7,\"expectedActingM15Revision\":11,\"expectedTargetM15Revision\":4,\"idempotencyKey\":\"consume-1\"}");
      expect(sha256(frame)).toBe("cba071d5861928db6db08406970a42e3b3494d6514b25e257cac342c4500551c");
      expect(verifyUseConsumableRequestDigest(request,sha256(frame),sha256)).toBe(true);
      expect(verifyUseConsumableRequestDigest({...request,targetCombatantId:"other"},sha256(frame),sha256)).toBe(false);
      expect(verifyUseConsumableRequestDigest(request,"BAD",sha256)).toBe(false);
      expect(verifyUseConsumableRequestDigest(request,sha256(frame),()=>"malformed")).toBe(false);
      expect(verifyUseConsumableRequestDigest(request,sha256(frame),()=>{throw new Error("failed");})).toBe(false);
    });

    it("separates combat HP evidence from nondisclosing actor resource deltas",()=>{
      const healing={kind:"combat-hp-healing",effectOrdinal:0,roll,requested:4,applied:4,before:2,after:6};
      const health={kind:"combat-hp-resource",effectOrdinal:0,resource:"health",requested:3,applied:2,before:1,after:3};
      const guard={kind:"actor-resource-delta",effectOrdinal:0,resource:"guard",requested:3,applied:2};
      const modifier={kind:"instant-modifier",effectOrdinal:0,statistic:"defense",requested:0,applied:0,duration:"instant"};
      for(const settlement of [healing,health,guard,modifier])expect(useConsumableSettlementSchema.safeParse(settlement).success).toBe(true);
      for(const invalid of [{...healing,requested:3},{...health,resource:"guard"},{...guard,before:1},
        {...guard,after:3},{...guard,resource:"spell-slot"},{...modifier,duration:"round"},{...guard,applied:4}])
        expect(useConsumableSettlementSchema.safeParse(invalid).success).toBe(false);
    });

    it("enforces actor-backed enemy revision, effect ordinal bijection, and request binding",()=>{
      const resolution={actionId:"action-1",legalActionId:"consume:tonic:enemy",kind:"use-consumable",
        actingCombatantId:"actor-combatant",target:{combatantId:"enemy-combatant",relation:"enemy",actorBacked:true},
        targetPolicy:"damage-only-enemy",actionCost:"action",consumed:{inventoryEntryId:"entry-1",item:itemReference,quantity:1},
        effectPlan,outcome:{targetCombatantId:"enemy-combatant",settlements:[
          {kind:"combat-hp-damage",effectOrdinal:0,damageType:"fire",roll,requested:4,adjustment:"none",applied:4,before:8,after:4},
          {kind:"actor-resource-delta",effectOrdinal:1,resource:"guard",requested:-2,applied:-1},
        ]},combatRevisionBefore:7,combatRevisionAfter:8,actingM15Revision:{before:11,after:12},
        targetM15Revision:{before:4,after:5}};
      const request={legalActionId:"consume:tonic:enemy",inventoryEntryId:"entry-1",item:itemReference,quantity:1,
        targetCombatantId:"enemy-combatant",targetActorBacked:true,expectedCombatRevision:7,
        expectedActingM15Revision:11,expectedTargetM15Revision:4,idempotencyKey:"consume-1"};
      const digest=sha256(canonicalUseConsumableRequestFrame(request));
      const result={resolution,requestBinding:{requestEvidence:request,canonicalRequestDigest:digest,idempotencyKey:"consume-1"},
        receipt:{idempotencyKey:"consume-1",revisionBefore:7,revisionAfter:8,occurredAt:at}};
      expect(useConsumableCommandResultSchema.parse(result)).toEqual(result);
      expect(verifyUseConsumableCommandResultBinding(request,result,sha256)).toBe(true);
      expect(verifyUseConsumableCommandResultBinding({...request,expectedCombatRevision:6},result,sha256)).toBe(false);
      expect(verifyUseConsumableCommandResultBinding(request,result,()=>{throw new Error("failed");})).toBe(false);
      expect(useConsumableCommandResultSchema.safeParse({...result,receipt:{...result.receipt,revisionBefore:6}}).success).toBe(false);
      expect(useConsumableCommandResultSchema.safeParse({...result,requestBinding:{...result.requestBinding,canonicalRequestDigest:digest.toUpperCase()}}).success).toBe(false);
      expect(useConsumableCommandResultSchema.safeParse({...result,requestBinding:{...result.requestBinding,idempotencyKey:"other"}}).success).toBe(false);
      expect(useConsumableCommandResultSchema.safeParse({...result,resolution:{...resolution,targetM15Revision:null}}).success).toBe(false);
      expect(useConsumableCommandResultSchema.safeParse({...result,resolution:{...resolution,
        actingM15Revision:{before:10,after:11}}}).success).toBe(false);
      expect(useConsumableCommandResultSchema.safeParse({...result,resolution:{...resolution,
        targetM15Revision:{before:3,after:4}}}).success).toBe(false);
      expect(useConsumableCommandResultSchema.safeParse({...result,resolution:{...resolution,
        outcome:{...resolution.outcome,targetCombatantId:"other"}}}).success).toBe(false);
      const unrelatedResolution={...resolution,legalActionId:"other-action",consumed:{...resolution.consumed,
        inventoryEntryId:"other-entry",item:{...itemReference,definitionId:"other"}},
        target:{...resolution.target,combatantId:"other-target"},outcome:{...resolution.outcome,targetCombatantId:"other-target"}};
      expect(useConsumableResolutionSchema.safeParse(unrelatedResolution).success).toBe(true);
      expect(useConsumableCommandResultSchema.safeParse({...result,resolution:unrelatedResolution}).success).toBe(false);
      const settlements=resolution.outcome.settlements;
      for(const invalidSettlements of [[settlements[0]],[settlements[0],settlements[0]],
        [settlements[1],settlements[0]],[settlements[0],{...settlements[1],effectOrdinal:0}]])
        expect(useConsumableCommandResultSchema.safeParse({...result,resolution:{...resolution,
          outcome:{...resolution.outcome,settlements:invalidSettlements}}}).success).toBe(false);

      expect(JSON.stringify(result)).not.toContain("actorId");
      const privateEnemy={...resolution,target:{...resolution.target,actorBacked:false},targetM15Revision:null};
      expect(useConsumableCommandResultSchema.safeParse({...result,resolution:privateEnemy}).success).toBe(false);
      const publicEnemy={...privateEnemy,effectPlan:{effectCount:1,effects:[effectPlan.effects[0]]},
        outcome:{...privateEnemy.outcome,settlements:[settlements[0]]}};
      expect(useConsumableResolutionSchema.safeParse(publicEnemy).success).toBe(true);
      expect(useConsumableCommandResultSchema.safeParse({...result,resolution:publicEnemy}).success).toBe(false);
      expect(useConsumableCommandResultSchema.safeParse({...result,resolution:{...publicEnemy,
        outcome:{...publicEnemy.outcome,settlements:[{kind:"actor-resource-delta",effectOrdinal:0,
          resource:"guard",requested:-2,applied:-1}]},effectPlan:{effectCount:1,effects:[{...effectPlan.effects[1],effectOrdinal:0}]}}}).success).toBe(false);
      expect(useConsumableCommandResultSchema.safeParse({...result,resolution:{...resolution,effectPlan:{...effectPlan,
        effects:[effectPlan.effects[0],{...effectPlan.effects[1]!,effect:{...effectPlan.effects[1]!.effect,amount:-3}}]}}}).success).toBe(false);
    });

    it("uses one acting M1.5 delta for an actor-backed self target",()=>{
      const selfItem=item([{type:"resource",resource:"guard",amount:2}]);
      const selfPlan=deriveUseConsumableEffectPlan(selfItem,itemReference)!;
      const request={legalActionId:"consume:self",inventoryEntryId:"entry-1",item:itemReference,quantity:1,
        targetCombatantId:"actor-combatant",targetActorBacked:true,expectedCombatRevision:7,
        expectedActingM15Revision:11,expectedTargetM15Revision:11,idempotencyKey:"consume-self"};
      const resolution={actionId:"action-self",legalActionId:"consume:self",kind:"use-consumable",
        actingCombatantId:"actor-combatant",target:{combatantId:"actor-combatant",relation:"self",actorBacked:true},
        targetPolicy:"beneficial-only-self-or-ally",actionCost:"action",consumed:{inventoryEntryId:"entry-1",item:itemReference,quantity:1},
        effectPlan:selfPlan,outcome:{targetCombatantId:"actor-combatant",settlements:[{kind:"actor-resource-delta",
          effectOrdinal:0,resource:"guard",requested:2,applied:2}]},combatRevisionBefore:7,combatRevisionAfter:8,
        actingM15Revision:{before:11,after:12},targetM15Revision:null};
      const digest=sha256(canonicalUseConsumableRequestFrame(request));
      const result={resolution,requestBinding:{requestEvidence:request,canonicalRequestDigest:digest,idempotencyKey:"consume-self"},
        receipt:{idempotencyKey:"consume-self",revisionBefore:7,revisionAfter:8,occurredAt:at}};
      expect(useConsumableCommandResultSchema.safeParse(result).success).toBe(true);
      expect(verifyUseConsumableCommandResultBinding(request,result,sha256)).toBe(true);
      expect(useConsumableCommandResultSchema.safeParse({...result,resolution:{...resolution,
        targetM15Revision:{before:11,after:12}}}).success).toBe(false);
      expect(useConsumableCommandResultSchema.safeParse({...result,requestBinding:{...result.requestBinding,
        requestEvidence:{...request,expectedTargetM15Revision:10}}}).success).toBe(false);
    });
  });
});
