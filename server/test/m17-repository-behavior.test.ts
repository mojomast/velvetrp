import { describe, expect, it } from "vitest";
import { EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, createRepository, createSession } from "../src/repo/index.js";
import { MECHANICS_STARTER_IDENTITY, ORIGINAL_STARTER_BACKGROUND, ORIGINAL_STARTER_CLASS, ORIGINAL_STARTER_RACE } from "@velvet/contracts";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at="2035-01-01T00:00:00.000Z";

describe("M1.7 encounter repository",()=>{
  it("authorizes before replay and has exact retry, stale, and active-session behavior",async()=>{
    let n=0; const repo=createRepository({dataDir:process.env.VELVET_DATA_DIR!,clock:{now:()=>new Date(at)},ids:{nextId:()=>`m17-${++n}`},rng:{integer:()=>10}});
    const campaign=repo.createCampaign("local-owner",{name:"Encounter fixture"});
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"pins"});
    const character=repo.createCharacter({name:"Session character",age:30,archetype:"Scout",boundaries:"",fictionalConfirmed:true});
    const session=await createSession({characterId:character.id,title:"Combat"});
    repo.attachCampaignSession("local-owner",{campaignId:campaign.id,sessionId:session.id} as any);
    const command:any={type:"create_encounter",campaignId:campaign.id,encounterId:"encounter",sessionId:session.id,kind:"improvised",enemySpawns:[],expectedRevision:0,idempotencyKey:"create",createdAt:at};
    const first=repo.executeEncounterCommand("local-owner",command);
    expect(repo.executeEncounterCommand("local-owner",command)).toEqual(first);
    expect(()=>repo.executeEncounterCommand("not-a-member",command)).toThrow(EncounterAuthorizationError);
    expect(()=>repo.executeEncounterCommand("local-owner",{...command,expectedRevision:1})).toThrow(EncounterConflictError);
    expect(()=>repo.executeEncounterCommand("local-owner",{...command,encounterId:"other",idempotencyKey:"stale",expectedRevision:1})).toThrow(EncounterStaleError);
    expect(()=>repo.executeEncounterCommand("local-owner",{...command,encounterId:"other",idempotencyKey:"other"})).toThrow();
    repo.close();
  });

  it("prepares and starts an HTTP lifecycle encounter atomically with exact replay",async()=>{
    let n=0;const repo=createRepository({dataDir:process.env.VELVET_DATA_DIR!,clock:{now:()=>new Date(at)},
      ids:{nextId:()=>`lifecycle-${++n}`},rng:{integer:(minimum)=>minimum}});
    const campaign=repo.createCampaign("local-owner",{name:"Lifecycle fixture"});
    repo.installOriginalStarterContent("local-owner",campaign.id);
    repo.configureOriginalStarterContent("local-owner",campaign.id);
    const persona=repo.createCharacter({name:"Lifecycle hero",age:30,archetype:"Scout",boundaries:"",fictionalConfirmed:true});
    const actor=repo.createOriginalStarterCampaignCharacter("local-owner",{campaignId:campaign.id,
      characterId:persona.id,controllerPrincipalId:"local-owner",race:ORIGINAL_STARTER_RACE.reference,
      background:ORIGINAL_STARTER_BACKGROUND.reference,classes:[{class:ORIGINAL_STARTER_CLASS.reference,level:1}],
      attributes:[],proficiencies:[],choices:[]}).projection.actor.id;
    repo.executeInitializeActorResource("local-owner",{campaignId:campaign.id,timelineId:campaign.activeTimelineId,
      actorId:actor,commandId:"lifecycle-health",idempotencyKey:"lifecycle-health",expectedRevision:0,sourceTurnId:null,
      command:{type:"initialize_actor_resource",payload:{name:"health",current:10,max:10}}});
    const session=await createSession({characterId:persona.id,title:"Lifecycle combat"});
    repo.attachCampaignSession("local-owner",{campaignId:campaign.id,sessionId:session.id} as any);
    const request={sessionId:session.id,name:"Bridge ambush",combatants:[{kind:"actor" as const,actorId:actor,
      team:"allies" as const}],idempotencyKey:"prepare-encounter"};
    const created=repo.createEncounter("local-owner",campaign.id,request);
    expect(created.encounter).toMatchObject({campaignId:campaign.id,name:"Bridge ambush",status:"preparing",
      combatId:null,revision:1,combatants:[{kind:"actor",actorId:actor,team:"allies"}]});
    expect(repo.createEncounter("local-owner",campaign.id,request)).toEqual(created);
    expect(repo.listEncounters("local-owner",campaign.id)).toEqual([created.encounter]);
    expect(()=>repo.createEncounter("local-owner",campaign.id,{...request,name:"Changed"})).toThrow(EncounterConflictError);
    expect(()=>repo.createEncounter("not-a-member",campaign.id,request)).toThrow(EncounterAuthorizationError);

    const start={expectedRevision:1,idempotencyKey:"start-encounter"};
    const started=repo.startEncounter("local-owner",created.encounter.encounterId,start);
    expect(started.combat).toMatchObject({campaignId:campaign.id,encounterId:created.encounter.encounterId,
      combatId:created.encounter.encounterId,round:1,currentCombatant:created.encounter.combatants[0]!.combatantId,
      revision:2});
    expect(repo.startEncounter("local-owner",created.encounter.encounterId,start)).toEqual(started);
    expect(repo.listCombatLogPage("local-owner",created.encounter.encounterId,0,1)).toMatchObject({
      campaignId:campaign.id,encounterId:created.encounter.encounterId,entries:[{sequence:1,event:{kind:"encounter_created"}}],
      nextAfterSequence:1,
    });
    expect(repo.listCombatLogPage("local-owner",created.encounter.encounterId,1,1)).toMatchObject({
      entries:[{sequence:2,event:{kind:"initiative_resolved"}}],nextAfterSequence:null,
    });
    expect(repo.listEncounters("local-owner",campaign.id)?.[0]).toMatchObject({status:"active",
      combatId:created.encounter.encounterId,revision:2});
    expect(()=>repo.startEncounter("local-owner",created.encounter.encounterId,
      {expectedRevision:1,idempotencyKey:"fresh-start"})).toThrow(EncounterStaleError);
    repo.close();
  });

  it("pins public enemy provenance and derives enemy health from the server catalog",async()=>{
    let n=0;const repo=createRepository({dataDir:process.env.VELVET_DATA_DIR!,clock:{now:()=>new Date(at)},
      ids:{nextId:()=>`enemy-lifecycle-${++n}`},rng:{integer:(minimum)=>minimum}});
    const campaign=repo.createCampaign("local-owner",{name:"Enemy lifecycle fixture"});
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"enemy-pins"});
    const persona=repo.createCharacter({name:"Session persona",age:30,archetype:"Scout",boundaries:"",fictionalConfirmed:true});
    const session=await createSession({characterId:persona.id,title:"Enemy combat"});
    repo.attachCampaignSession("local-owner",{campaignId:campaign.id,sessionId:session.id} as any);
    const enemy={kind:"enemy-template" as const,packId:MECHANICS_STARTER_IDENTITY.packId,
      packVersion:MECHANICS_STARTER_IDENTITY.packVersion,definitionId:"velvet:mechanics:enemy-template:gloam-mite"};
    const created=repo.createEncounter("local-owner",campaign.id,{sessionId:session.id,name:"Mite patrol",
      combatants:[{kind:"enemy",template:enemy,team:"enemies"}],idempotencyKey:"prepare-enemy"});
    expect(created.encounter.combatants).toEqual([{combatantId:created.encounter.combatants[0]!.combatantId,
      kind:"enemy",team:"enemies",template:enemy}]);
    const started=repo.startEncounter("local-owner",created.encounter.encounterId,
      {expectedRevision:1,idempotencyKey:"start-enemy"});
    expect(started.combat.combatants).toEqual([{combatantId:created.encounter.combatants[0]!.combatantId,
      kind:"enemy",team:"enemies",template:enemy,hitPoints:8,maximumHitPoints:8,status:"active"}]);
    repo.close();
  });
});
