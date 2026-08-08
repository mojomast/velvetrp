import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY, type CharacterBuilderAttributeScores } from "@velvet/contracts";
import {
  EncounterConflictError,
  EncounterStaleError,
  MECHANICS_STARTER_CATALOG,
  createRepository,
  createSession,
} from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at="2035-01-01T00:00:00.000Z";
const scores:CharacterBuilderAttributeScores=Object.fromEntries(
  ["might","agility","resolve","insight","presence","craft"].map((key,index)=>[key,CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
) as CharacterBuilderAttributeScores;

describe("M2.9 combat command repository",()=>{
  it("resolves legal turns, ends once, and creates deterministic replay-safe rewards",async()=>{
    let sequence=0;const repo=createRepository({dataDir:process.env.VELVET_DATA_DIR!,clock:{now:()=>new Date(at)},
      ids:{nextId:()=>`combat-command-${++sequence}`},rng:{integer:(minimum)=>minimum}});
    const campaign=repo.createCampaign("local-owner",{name:"Combat commands"});
    repo.installMechanicsStarterCatalog("local-owner");
    repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"pins"});
    const persona=repo.createCharacter({name:"Aster",age:31,archetype:"Warden",boundaries:"",fictionalConfirmed:true});
    const draft=repo.createCharacterDraft("local-owner",campaign.id,{personaId:persona.id,controllerPrincipalId:"local-owner",
      durability:"durable",allocation:{method:"standard-array",scores},idempotencyKey:"draft"});
    const definitions=MECHANICS_STARTER_CATALOG.definitions;
    const selected=repo.updateCharacterDraft("local-owner",draft.draft.id,{expectedRevision:0,idempotencyKey:"select",selections:{
      race:definitions.find((definition)=>definition.reference.kind==="race")!.reference,
      background:definitions.find((definition)=>definition.reference.kind==="background")!.reference,
      class:definitions.find((definition)=>definition.reference.kind==="class")!.reference,starterGrant:"kit",
    }} as any);
    const actorId=repo.finalizeCharacterDraft("local-owner",draft.draft.id,{expectedRevision:selected.draft.revision,
      idempotencyKey:"final"}).receipt.actorId;
    const session=await createSession({characterId:persona.id,title:"Combat command room"});
    repo.attachCampaignSession("local-owner",{campaignId:campaign.id,sessionId:session.id} as any);
    const enemy={kind:"enemy-template" as const,packId:MECHANICS_STARTER_CATALOG.manifest.packId,
      packVersion:MECHANICS_STARTER_CATALOG.manifest.packVersion,definitionId:"velvet:mechanics:enemy-template:gloam-mite"};
    const created=repo.createEncounter("local-owner",campaign.id,{sessionId:session.id,name:"Mite ambush",combatants:[
      {kind:"actor",actorId,team:"allies"},{kind:"enemy",template:enemy,team:"enemies"}],idempotencyKey:"prepare"});
    let combat=repo.startEncounter("local-owner",created.encounter.encounterId,
      {expectedRevision:1,idempotencyKey:"start"}).combat;
    expect(combat.legalActions.map((action)=>action.legalActionId)).not.toContain("defend");
    const enemyCombatant=combat.combatants.find((combatant)=>combatant.kind==="enemy")!;
    let actionCount=0,firstResult:ReturnType<typeof repo.resolveCombatAction>|null=null,actorActionKey="";
    while(combat.currentCombatant!==null&&actionCount<30){
      const current=combat.combatants.find((combatant)=>combatant.combatantId===combat.currentCombatant)!;
      const body=current.kind==="actor"
        ?{legalActionId:"attack:basic",targetIds:[enemyCombatant.combatantId],choices:[] as [],expectedRevision:combat.revision,
          idempotencyKey:`action-${actionCount}`}
        :{legalActionId:"end-turn",targetIds:[],choices:[] as [],expectedRevision:combat.revision,
          idempotencyKey:`action-${actionCount}`};
      const result=repo.resolveCombatAction("local-owner",combat.combatId,body);
      if(current.kind==="actor"&&!actorActionKey)actorActionKey=body.idempotencyKey;
      if(firstResult===null){
        firstResult=result;expect(repo.resolveCombatAction("local-owner",combat.combatId,body)).toEqual(result);
        expect(()=>repo.resolveCombatAction("local-owner",combat.combatId,{...body,expectedRevision:body.expectedRevision+1}))
          .toThrow(EncounterConflictError);
        expect(()=>repo.resolveCombatAction("local-owner",combat.combatId,{...body,idempotencyKey:"stale-action"}))
          .toThrow(EncounterStaleError);
      }
      if(body.legalActionId==="attack:basic")expect(result.resolution.outcomes[0]).toMatchObject({kind:"damage",requested:1,applied:1});
      combat=result.combat;actionCount+=1;
    }
    expect(actionCount).toBeLessThan(30);expect(combat.currentCombatant).toBeNull();
    expect(combat.combatants.find((combatant)=>combatant.combatantId===enemyCombatant.combatantId)).toMatchObject({hitPoints:0,status:"defeated"});
    expect(repo.listEncounters("local-owner",campaign.id)?.[0]?.status).toBe("active");

    expect(actorActionKey).not.toBe("");
    const authDb=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    for(const [id,role] of [["combat-gm","gm"],["combat-controller","player"],["combat-controller-two","player"],["combat-observer","observer"]] as const){
      authDb.prepare("INSERT INTO principals(id,display_name,is_local) VALUES(?,?,0)").run(id,id);
      authDb.prepare("INSERT INTO campaign_memberships(campaign_id,principal_id,role,created_at) VALUES(?,?,?,?)").run(campaign.id,id,role,at);
    }
    authDb.close();
    const transfer=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));
    const counts=()=>({revision:(transfer.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(combat.combatId) as {revision:number}).revision,
      commands:(transfer.prepare("SELECT count(*) count FROM combat_commands_v27 WHERE encounter_id=?").get(combat.combatId) as {count:number}).count,
      receipts:(transfer.prepare("SELECT count(*) count FROM combat_receipts_v27 WHERE encounter_id=?").get(combat.combatId) as {count:number}).count,
      logs:(transfer.prepare("SELECT count(*) count FROM combat_log WHERE encounter_id=?").get(combat.combatId) as {count:number}).count});
    transfer.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='combat-controller' WHERE campaign_id=? AND actor_id=?").run(campaign.id,actorId);
    const beforeReads=counts();
    expect(repo.getCombatCommandResult("combat-controller",campaign.id,combat.combatId,actorActionKey)).toMatchObject({operation:"action"});
    expect(repo.getCombatCommandResult("combat-gm",campaign.id,combat.combatId,actorActionKey)).toMatchObject({operation:"action"});
    expect(repo.getCombatCommandResult("combat-observer",campaign.id,combat.combatId,actorActionKey)).toBeNull();
    expect(repo.getCombatCommandResult("combat-unrelated",campaign.id,combat.combatId,actorActionKey)).toBeNull();
    transfer.prepare("UPDATE campaign_actor_private_state SET controller_principal_id='combat-controller-two' WHERE campaign_id=? AND actor_id=?").run(campaign.id,actorId);
    expect(repo.getCombatCommandResult("combat-controller",campaign.id,combat.combatId,actorActionKey)).toBeNull();
    expect(repo.getCombatCommandResult("combat-controller-two",campaign.id,combat.combatId,actorActionKey)).toMatchObject({operation:"action"});
    expect(counts()).toEqual(beforeReads);transfer.close();

    const endBody={expectedRevision:combat.revision,idempotencyKey:"end"};
    const ended=repo.endCombat("local-owner",combat.combatId,endBody);
    expect(ended.encounter).toMatchObject({status:"completed",revision:combat.revision+1});
    expect(ended.rewards).toHaveLength(1);
    expect(ended.rewards[0]).toMatchObject({recipientActorId:actorId,rewards:[{kind:"currency",amount:1,
      currency:{kind:"currency",definitionId:"velvet:mechanics:currency:glimmer"}}]});
    expect(repo.getCombatCommandResult("combat-gm",campaign.id,combat.combatId,endBody.idempotencyKey)).toMatchObject({operation:"end"});
    expect(repo.getCombatCommandResult("combat-controller-two",campaign.id,combat.combatId,endBody.idempotencyKey)).toBeNull();
    expect(repo.getCombatCommandResult("combat-observer",campaign.id,combat.combatId,endBody.idempotencyKey)).toBeNull();
    expect(repo.getCombatCommandResult("combat-unrelated",campaign.id,combat.combatId,endBody.idempotencyKey)).toBeNull();
    expect(repo.endCombat("local-owner",combat.combatId,endBody)).toEqual(ended);
    expect(repo.getCombatCommandResult("local-owner",campaign.id,combat.combatId,endBody.idempotencyKey)).toEqual({operation:"end",result:{
      encounter:Object.fromEntries(Object.entries(ended.encounter).filter(([key])=>key!=="campaignId")),
      rewards:ended.rewards.map(({campaignId:_campaignId,encounterId:_encounterId,...reward})=>reward),
      receipt:{idempotencyKey:ended.receipt.idempotencyKey,revisionBefore:ended.receipt.revisionBefore,revisionAfter:ended.receipt.revisionAfter,occurredAt:ended.receipt.occurredAt},
    }});
    expect(repo.getCombatCommandResult("local-owner","other-campaign",combat.combatId,endBody.idempotencyKey)).toBeNull();
    expect(()=>repo.endCombat("local-owner",combat.combatId,{...endBody,expectedRevision:endBody.expectedRevision+1}))
      .toThrow(EncounterConflictError);
    expect(()=>repo.endCombat("local-owner",combat.combatId,{expectedRevision:combat.revision,idempotencyKey:"stale-end"}))
      .toThrow(EncounterStaleError);
    expect(()=>repo.endCombat("local-owner",combat.combatId,{expectedRevision:ended.encounter.revision,idempotencyKey:"second-end"}))
      .toThrow(EncounterConflictError);
    const log=repo.listCombatLogPage("local-owner",combat.combatId,0,100)!;
    expect(log.entries.map((entry)=>entry.event.kind)).toEqual(expect.arrayContaining(["combat_terminal","encounter_completed","rewards_granted"]));
    repo.close();
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});
    expect((db.prepare("SELECT count(*) count FROM reward_bundle WHERE encounter_id=?").get(combat.combatId) as {count:number}).count).toBe(1);
    expect((db.prepare("SELECT count(*) count FROM reward_entry_v27").get() as {count:number}).count).toBe(1);
    expect((db.prepare("SELECT count(*) count FROM combat_commands_v27 WHERE encounter_id=? AND command_type='grant_rewards'")
      .get(combat.combatId) as {count:number}).count).toBe(1);db.close();
  });
});
