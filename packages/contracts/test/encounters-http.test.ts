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
});
