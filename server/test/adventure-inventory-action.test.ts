import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe,expect,it } from "vitest";
import { adventureTurnStreamEventSchema,CHARACTER_BUILDER_STANDARD_ARRAY,type CharacterBuilderAttributeScores } from "@velvet/contracts";
import { defaultHarnessSettings,defaultProviderSettings } from "../src/defaults.js";
import { orchestrateAdventureTurn,type AdventureAgentDependencies } from "../src/agent/adventureOrchestrator.js";
import { buildApp } from "../src/app.js";
import { createRepository,MECHANICS_STARTER_CATALOG } from "../src/repo/index.js";
import type { ProviderCompletionInput,ProviderCompletionResult } from "../src/provider/index.js";
import { narrationFallback } from "../src/routes/rpg/v1/adventureTurns.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const at="2035-01-01T00:00:00.000Z",scores=Object.fromEntries(["might","agility","resolve","insight","presence","craft"].map((key,index)=>[key,CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as CharacterBuilderAttributeScores;
let key=0;
function setWaylampMechanics(db:DatabaseDriver.Database,category:"gear"|"consumable",slot:"hand"|null){const reference=MECHANICS_STARTER_CATALOG.definitions.find(value=>value.reference.kind==="item")!.reference;
  const definitionRow=db.prepare("SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? AND kind='item' AND definition_id=?").get(reference.packId,reference.packVersion,reference.definitionId)as{definition_json:string}|undefined;
  const publicRow=db.prepare("SELECT public_definition_json FROM rpg_catalog_definition_visibility WHERE pack_id=? AND pack_version=? AND kind='item' AND definition_id=?").get(reference.packId,reference.packVersion,reference.definitionId)as{public_definition_json:string}|undefined;
  if(!definitionRow||!publicRow)return;
  const definition=JSON.parse(definitionRow.definition_json),publicDefinition=JSON.parse(publicRow.public_definition_json);definition.mechanics={...definition.mechanics,category,slot};publicDefinition.mechanics={...publicDefinition.mechanics,category,slot};
  db.exec("DROP TRIGGER rpg_catalog_definitions_immutable_update; DROP TRIGGER rpg_catalog_visibility_immutable_update");
  db.prepare("UPDATE rpg_catalog_definitions SET definition_json=? WHERE pack_id=? AND pack_version=? AND kind='item' AND definition_id=?").run(JSON.stringify(definition),reference.packId,reference.packVersion,reference.definitionId);
  db.prepare("UPDATE rpg_catalog_definition_visibility SET public_definition_json=? WHERE pack_id=? AND pack_version=? AND kind='item' AND definition_id=?").run(JSON.stringify(publicDefinition),reference.packId,reference.packVersion,reference.definitionId);
  db.exec("CREATE TRIGGER rpg_catalog_definitions_immutable_update BEFORE UPDATE ON rpg_catalog_definitions BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END; CREATE TRIGGER rpg_catalog_visibility_immutable_update BEFORE UPDATE ON rpg_catalog_definition_visibility BEGIN SELECT RAISE(ABORT,'catalog visibility is immutable'); END;");}
function fixture(){let time=new Date(at);const sessionId=`inventory-session-${++key}`,repo=createRepository({clock:{now:()=>time}}),campaign=repo.createCampaign("local-owner",{name:"Inventory adventure"});
  const repair=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));setWaylampMechanics(repair,"gear","hand");repair.close();repo.installMechanicsStarterCatalog("local-owner");repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:`pins-${++key}`});
  const actor=(name:string)=>{const persona=repo.createCharacter({name,age:25,archetype:"Warden",boundaries:"",fictionalConfirmed:true});
    const draft=repo.createCharacterDraft("local-owner",campaign.id,{personaId:persona.id,controllerPrincipalId:"local-owner",durability:"durable",allocation:{method:"standard-array",scores},idempotencyKey:`draft-${++key}`});
    const definitions=MECHANICS_STARTER_CATALOG.definitions,selected=repo.updateCharacterDraft("local-owner",draft.draft.id,{expectedRevision:0,idempotencyKey:`select-${++key}`,selections:{
      race:definitions.find(x=>x.reference.kind==="race")!.reference as any,background:definitions.find(x=>x.reference.kind==="background")!.reference as any,
      class:definitions.find(x=>x.reference.kind==="class")!.reference as any,starterGrant:"kit"}} as any);
    const result=repo.finalizeCharacterDraft("local-owner",draft.draft.id,{expectedRevision:selected.draft.revision,idempotencyKey:`final-${++key}`});return{actorId:result.receipt.actorId,personaId:persona.id};};
  const source=actor("Aster"),recipient=actor("Briar"),db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,'Room','active','default',?)").run(sessionId,source.personaId,at);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0),(?,?,1)").run(sessionId,source.personaId,sessionId,recipient.personaId);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run(sessionId,campaign.id,at);setWaylampMechanics(db,"consumable","hand");db.close();
  return{repo,campaign,source,recipient,sessionId,setTime:(value:string)=>{time=new Date(value);}};
}
const complete=(candidate:{candidateId:string;digest:string},patch:Record<string,unknown>={}):ProviderCompletionResult=>({message:{role:"assistant",content:null,toolCalls:[{id:`inventory-call-${++key}`,name:"exact_inventory_action.select",arguments:JSON.stringify({candidateId:candidate.candidateId,digest:candidate.digest,...patch})}]},usage:null,model:{requestedModel:"fake",responseModel:"fake"}});
const narration=(text:string):ProviderCompletionResult=>({message:{role:"assistant",content:null,toolCalls:[{id:`narration-call-${++key}`,name:"submit_adventure_narration",arguments:JSON.stringify({narration:text})}]},usage:null,model:{requestedModel:"fake",responseModel:"fake"}});
const deps=(fn:(input:ProviderCompletionInput)=>Promise<ProviderCompletionResult>,now=at):AdventureAgentDependencies=>({complete:fn,getProvider:async()=>({...defaultProviderSettings(),model:"fake"}),getHarness:async()=>defaultHarnessSettings(),now:()=>new Date(now)});
const events=(body:string)=>body.split("\n\n").filter(frame=>frame.startsWith("event: ")).map(frame=>adventureTurnStreamEventSchema.parse(JSON.parse(frame.split("\n").find(line=>line.startsWith("data: "))!.slice(6))));
function makeTurn(f:ReturnType<typeof fixture>,declaration:string){return f.repo.createAdventureTurn("local-owner",{campaignId:f.campaign.id,timelineId:f.campaign.activeTimelineId,sessionId:f.sessionId,actorId:f.source.actorId,declaration,expectedCampaignRevision:1,idempotencyKey:`turn-${++key}`});}
async function select(f:ReturnType<typeof fixture>,action:string){const turn=makeTurn(f,action),candidate=f.repo.generateAdventureInventoryCandidates("local-owner",turn.turnId).find(value=>value.action===action)!;expect(candidate).toBeDefined();let tool:any;
  const result=await orchestrateAdventureTurn(f.repo,turn.turnId,deps(async input=>{tool=input.tools?.find(value=>value.name==="exact_inventory_action.select");return complete(candidate);}));
  expect(tool,JSON.stringify(result)).toBeDefined();expect(tool.parameters.oneOf[0].required).toEqual(["candidateId","digest"]);expect(JSON.stringify(tool.parameters)).not.toMatch(/entryId|itemId|revision|outcome/i);return{turn,candidate,result};}

describe("exact adventure inventory actions",()=>{
  it.each(["equip","unequip"] as const)("executes safe %s without confirmation and replays after restart",async action=>{const f=fixture();
    if(action==="unequip"){const snapshot=f.repo.getActorInventorySnapshot("local-owner",f.campaign.id,f.source.actorId)!;const entry=snapshot.inventory.items[0]!;f.repo.mutateInventoryForActor("local-owner",f.campaign.id,f.source.actorId,{kind:"equip",entryId:entry.entryId,slot:"hand",expectedRevision:snapshot.revision,idempotencyKey:`setup-${++key}`});}
    const done=await select(f,action);expect(done.result.outcome,JSON.stringify(done.result.turn)).toBe("mechanics-committed");expect(done.result.turn.receiptLinks).toHaveLength(1);const command=done.result.turn.receiptLinks[0]!.commandId;
    const narrating=f.repo.updateAdventureTurnNarration("local-owner",{turnId:done.turn.turnId,expectedTurnRevision:done.result.turn.revision,
      expectedCampaignRevision:1,idempotencyKey:`narrating-${++key}`,narrationStatus:"in-progress"});
    expect(narrating).toMatchObject({state:"narrating",narrationStatus:"in-progress",receiptLinks:[{commandId:command}]});
    f.repo.close();const reopened=createRepository({clock:{now:()=>new Date(at)}}),recovered=await orchestrateAdventureTurn(reopened,done.turn.turnId,deps(async()=>{throw new Error("must not redispatch");}));
    expect(recovered.turn.receiptLinks[0]?.commandId).toBe(command);expect(reopened.getAdventureInventoryPublicReceipt("local-owner",f.campaign.id,command)?.action).toBe(action);reopened.close();});
  it.each(["equip","unequip"] as const)("recovers %s narration by HTTP after a committed-mechanics write failure without re-execution",async action=>{const f=fixture();
    process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";
    if(action==="unequip"){const snapshot=f.repo.getActorInventorySnapshot("local-owner",f.campaign.id,f.source.actorId)!;const entry=snapshot.inventory.items[0]!;
      f.repo.mutateInventoryForActor("local-owner",f.campaign.id,f.source.actorId,{kind:"equip",entryId:entry.entryId,slot:"hand",expectedRevision:snapshot.revision,idempotencyKey:`route-setup-${++key}`});}
    const done=await select(f,action),turnId=done.turn.turnId;f.repo.close();let failed=false;
    const failing=buildApp({campaignRepositoryFactory:()=>{const repository=createRepository({clock:{now:()=>new Date(at)}}),update=repository.updateAdventureTurnNarration.bind(repository);
      repository.updateAdventureTurnNarration=((principal:string,input:any)=>{if(!failed&&input.narrationStatus==="in-progress"){failed=true;throw new Error("injected narration write failure");}return update(principal,input);}) as typeof repository.updateAdventureTurnNarration;return repository;}});
    const read=await failing.inject({method:"GET",url:`/api/rpg/v1/adventure-turns/${turnId}`});expect(read.json()).toMatchObject({turn:{state:"mechanics-committed"},resumeToken:expect.stringMatching(/^v1\./),receipts:[expect.any(Object)]});
    const interrupted=await failing.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{resumeToken:read.json().resumeToken}});
    expect(events(interrupted.body).at(-1)).toMatchObject({type:"terminal",payload:{outcome:"error",receipts:[expect.any(Object)]}});await failing.close();
    let calls=0;const restarted=buildApp({campaignRepositoryFactory:()=>createRepository({clock:{now:()=>new Date(at)}}),adventureAgentDependencies:deps(async()=>{calls+=1;return narration(`You ${action} 1 Waylamp in the hand slot.`);})});
    const resumed=await restarted.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{resumeToken:read.json().resumeToken}});
    expect(events(resumed.body).at(-1)).toMatchObject({type:"terminal",payload:{outcome:"done",receipts:[expect.any(Object)],narrationStatus:{status:"completed"}}});expect(calls).toBe(1);
    const audit=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});expect(audit.prepare("SELECT count(*) count FROM adventure_inventory_executions_v55 WHERE turn_id=?").get(turnId)).toEqual({count:1});audit.close();await restarted.close();
    delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;});
  it("resumes a confirmed exact inventory action through HTTP without redispatching planning",async()=>{const f=fixture();process.env.FEATURE_RPG_CAMPAIGN="true";process.env.FEATURE_RPG_MECHANICS="true";
    const selected=await select(f,"drop"),proposal=selected.result.turn.toolCalls[0]!.proposal;
    const app=buildApp({campaignRepositoryFactory:()=>f.repo});const confirmed=await app.inject({method:"POST",url:`/api/rpg/v1/adventure-turns/${selected.turn.turnId}/confirm`,headers:{"content-type":"application/json"},
      payload:{proposalIds:[proposal.proposalId],decision:"approve",expectedRevision:selected.result.turn.revision,idempotencyKey:`route-confirm-${++key}`}});
    expect(confirmed.statusCode).toBe(200);expect(confirmed.json().resumeToken).toMatch(/^v1\./);await app.close();let narrationCalls=0;
    const restarted=buildApp({campaignRepositoryFactory:()=>createRepository({clock:{now:()=>new Date(at)}}),adventureAgentDependencies:deps(async input=>{expect(input.tools?.map(tool=>tool.name)).toEqual(["submit_adventure_narration"]);narrationCalls+=1;
      return narration("You drop 1 Waylamp.");})});
    const resumed=await restarted.inject({method:"POST",url:"/api/rpg/v1/adventure-turns/stream",headers:{"content-type":"application/json"},payload:{resumeToken:confirmed.json().resumeToken}});
    expect(events(resumed.body).at(-1)).toMatchObject({type:"terminal",payload:{outcome:"done",receipts:[expect.any(Object)],narrationStatus:{status:"completed"}}});expect(narrationCalls).toBe(1);
    const audit=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),{readonly:true});expect(audit.prepare("SELECT count(*) count FROM adventure_inventory_executions_v55 WHERE turn_id=?").get(selected.turn.turnId)).toEqual({count:1});audit.close();
    await restarted.close();delete process.env.FEATURE_RPG_CAMPAIGN;delete process.env.FEATURE_RPG_MECHANICS;});
  it.each(["drop","gift","consume"] as const)("requires approval before %s and publishes only safe exact facts",async action=>{const f=fixture(),done=await select(f,action);expect(done.result.outcome).toBe("awaiting-confirmation");expect(done.result.turn.receiptLinks).toHaveLength(0);
    expect(done.result.turn.toolCalls[0]!.proposal.policy.review.summary).toContain("Waylamp");
    const proposal=done.result.turn.toolCalls[0]!.proposal,decided=f.repo.decideToolProposals("local-owner",{turnId:done.turn.turnId,proposalIds:[proposal.proposalId],decision:"approved",expectedTurnRevision:done.result.turn.revision,expectedCampaignRevision:1,idempotencyKey:`approve-${++key}`});
    const resumed=await orchestrateAdventureTurn(f.repo,done.turn.turnId,deps(async()=>{throw new Error("must not redispatch");}));expect(decided.state).toBe("confirmed");expect(resumed.outcome).toBe("completed");
    const receipt=f.repo.getAdventureInventoryPublicReceipt("local-owner",f.campaign.id,resumed.turn.receiptLinks[0]!.commandId)!;expect(receipt).toMatchObject({itemLabel:"Waylamp",action,quantity:1,revisionAfter:receipt.revisionBefore+1});
    expect(JSON.stringify(receipt)).not.toMatch(/candidate|entryId|actorId|principal|provider|digest|packId|definitionId/);f.repo.close();});
  it("honors rejection and expiry without mutating inventory",async()=>{for(const expired of [false,true]){const f=fixture(),done=await select(f,"drop"),before=f.repo.getActorInventorySnapshot("local-owner",f.campaign.id,f.source.actorId);
      if(expired){f.setTime("2035-01-01T00:31:00.000Z");f.repo.expireToolProposals("local-owner",{turnId:done.turn.turnId,expectedTurnRevision:done.result.turn.revision,expectedCampaignRevision:1,idempotencyKey:`expire-${++key}`});}
      else f.repo.decideToolProposals("local-owner",{turnId:done.turn.turnId,proposalIds:[done.result.turn.toolCalls[0]!.proposal.proposalId],decision:"rejected",expectedTurnRevision:done.result.turn.revision,expectedCampaignRevision:1,idempotencyKey:`reject-${++key}`});
      const after=f.repo.getActorInventorySnapshot("local-owner",f.campaign.id,f.source.actorId);expect(after).toEqual(before);f.repo.close();}});
  it("rejects provider tampering, changed candidates, and stale inventory before command mutation",async()=>{for(const mode of ["tamper","changed","stale"]){const f=fixture(),turn=makeTurn(f,mode),candidate=f.repo.generateAdventureInventoryCandidates("local-owner",turn.turnId).find(value=>value.action==="equip")!;
      const result=await orchestrateAdventureTurn(f.repo,turn.turnId,deps(async()=>{if(mode==="stale"){const snapshot=f.repo.getActorInventorySnapshot("local-owner",f.campaign.id,f.source.actorId)!;f.repo.mutateInventoryForActor("local-owner",f.campaign.id,f.source.actorId,{kind:"drop",entryId:snapshot.inventory.items[0]!.entryId,item:snapshot.inventory.items[0]!.item,quantity:1,expectedRevision:snapshot.revision,idempotencyKey:`stale-${++key}`});return complete(candidate);}
        if(mode==="changed"){const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));db.exec("DROP TRIGGER adventure_inventory_candidates_v55_update");db.prepare("UPDATE adventure_inventory_candidates_v55 SET private_command_json='{}' WHERE candidate_id=?").run(candidate.candidateId);
          db.exec("CREATE TRIGGER adventure_inventory_candidates_v55_update BEFORE UPDATE ON adventure_inventory_candidates_v55 BEGIN SELECT RAISE(ABORT,'v55 inventory candidates are immutable'); END;");db.close();return complete(candidate);}
        return complete(candidate,{quantity:99,recipientActorId:"forged",revision:0});}));expect(result.outcome).toBe("fallback");expect(result.turn.receiptLinks).toHaveLength(0);f.repo.close();}});
  it("omits equipped loss actions, occupied slots, and full recipients",()=>{const f=fixture(),snapshot=f.repo.getActorInventorySnapshot("local-owner",f.campaign.id,f.source.actorId)!,entry=snapshot.inventory.items[0]!;
    f.repo.mutateInventoryForActor("local-owner",f.campaign.id,f.source.actorId,{kind:"equip",entryId:entry.entryId,slot:"hand",expectedRevision:snapshot.revision,idempotencyKey:`equip-${++key}`});
    let candidates=f.repo.generateAdventureInventoryCandidates("local-owner",makeTurn(f,"equipped").turnId);expect(candidates.map(value=>value.action)).toEqual(["unequip"]);
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));db.prepare("INSERT OR REPLACE INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?, 'inventory-capacity',0,0)").run(f.campaign.id,f.recipient.actorId);db.close();
    candidates=f.repo.generateAdventureInventoryCandidates("local-owner",makeTurn(f,"capacity").turnId);expect(candidates.some(value=>value.action==="gift")).toBe(false);
    const empty=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));empty.prepare("DELETE FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=?").run(f.campaign.id,f.source.actorId);empty.close();
    expect(f.repo.generateAdventureInventoryCandidates("local-owner",makeTurn(f,"unavailable").turnId)).toEqual([]);f.repo.close();});
  it("omits equip and consume candidates for inert non-consumable gear",()=>{const f=fixture(),db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));setWaylampMechanics(db,"gear",null);db.close();
    const candidates=f.repo.generateAdventureInventoryCandidates("local-owner",makeTurn(f,"inert gear").turnId);expect(candidates.some(value=>value.action==="equip")).toBe(false);expect(candidates.some(value=>value.action==="consume")).toBe(false);expect(candidates.some(value=>value.action==="drop")).toBe(true);f.repo.close();});
  it("narrates verified inventory facts without inventing consume effects",()=>{const text=narrationFallback("heal me fully",[{kind:"inventory",itemLabel:"Waylamp",action:"consume",quantity:1,slot:null,recipient:null}]);
    expect(text).toContain("only its removal from inventory is established");expect(text).not.toMatch(/heal|hit point/i);});
});
