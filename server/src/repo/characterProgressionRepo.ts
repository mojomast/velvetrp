import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  applyCharacterProgressionInputSchema, correctCharacterXpInputSchema, grantCharacterMilestoneInputSchema,
  grantCharacterXpInputSchema, progressionCommandResultSchema, progressionEventSchema, progressionPendingChoiceSchema,
  progressionReceiptSchema, progressionStateSchema, resourceIdSchema, utcIsoTimestampSchema,
  type ApplyCharacterProgressionInput, type CharacterDerivedStats, type CorrectCharacterXpInput,
  type GrantCharacterMilestoneInput, type GrantCharacterXpInput, type ProgressionCommandResult,
  type ProgressionEvent, type ProgressionPreview, type ProgressionReceipt, type ProgressionSelection, type ProgressionState,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../runtime.js";
import { progressionCatalogDigest, progressionReferenceKey, type ExactReference } from "../characterProgressionCatalog.js";
import { canonicalProgressionJson, canonicalStarterProgressionProfile, progressionProfileDigest,
  starterProgressionProfileId } from "../characterProgressionProfile.js";
import { canonicalCatalogJson } from "./contentCatalogRepo.js";
import { calculateAuthoritativeProgressionPreview, expectedKnownPowerSources, loadCanonicalProgressionProfile,
  loadExactProgressionCatalog, readKnownPowerReferences, type ProgressionRootRow } from "./characterProgressionPersistence.js";

type Role="owner"|"gm"|"player"|"observer";
const digest=(value:unknown)=>createHash("sha256").update(canonicalCatalogJson(value)).digest("hex");
const sortReferences=<T extends ExactReference>(values:T[])=>[...values].sort((left,right)=>
  progressionReferenceKey(left).localeCompare(progressionReferenceKey(right)));

export class CharacterProgressionAuthorizationError extends Error { readonly code="CHARACTER_PROGRESSION_FORBIDDEN"; constructor(){super("character progression is unavailable");} }
export class CharacterProgressionUnavailableError extends Error { readonly code="CHARACTER_PROGRESSION_UNAVAILABLE"; constructor(message="character progression is unavailable"){super(message);} }
export class CharacterProgressionConflictError extends Error { readonly code="CHARACTER_PROGRESSION_CONFLICT"; constructor(message="character progression command conflicts with authoritative state"){super(message);} }
export class CharacterProgressionStaleError extends Error { readonly code="CHARACTER_PROGRESSION_STALE"; constructor(){super("character progression revision is stale");} }

function ensureProfiles(db:DatabaseDriver.Database):void{
  if(!db.prepare("SELECT 1 FROM rpg_rules_profiles WHERE rules_profile_id='velvet:rules:starter-v1'").get())throw new CharacterProgressionUnavailableError("unsupported rules profile");
  const insert=db.prepare(`INSERT OR IGNORE INTO rpg_progression_profiles_v23(profile_id,rules_profile_id,mode,max_level,thresholds_json,profile_digest)
    VALUES(?,'velvet:rules:starter-v1',?,3,?,?)`);
  for(const mode of ["xp","milestone"] as const){const profile=canonicalStarterProgressionProfile(mode);
    insert.run(profile.profileId,mode,canonicalProgressionJson(profile.thresholds),progressionProfileDigest(mode));
    loadCanonicalProgressionProfile(db,profile.profileId);}
}

/** Initializes only exact class/race selections with complete profile support. */
export function initializeCharacterProgressionV24(db:DatabaseDriver.Database,input:{campaignCharacterId:string;campaignId:string;sheetId:string;actorId:string;
  classRef:{packId:string;packVersion:string;definitionId:string};derived:CharacterDerivedStats;now:string;mode?:"xp"|"milestone"}):boolean{
  ensureProfiles(db);const mode=input.mode??"xp",candidate:ProgressionRootRow={campaign_character_id:input.campaignCharacterId,campaign_id:input.campaignId,
    sheet_id:input.sheetId,actor_id:input.actorId,profile_id:starterProgressionProfileId(mode),class_pack_id:input.classRef.packId,
    class_pack_version:input.classRef.packVersion,class_definition_id:input.classRef.definitionId,level:1,total_xp:0,milestone_count:0,
    revision:0,derived_json:canonicalCatalogJson(input.derived),created_at:input.now,updated_at:input.now};
  let catalog:ReturnType<typeof loadExactProgressionCatalog>;try{catalog=loadExactProgressionCatalog(db,candidate);}catch{return false;}
  const result=db.prepare(`INSERT OR IGNORE INTO character_progression_v23(campaign_character_id,campaign_id,sheet_id,actor_id,profile_id,
    class_pack_id,class_pack_version,class_kind,class_definition_id,level,total_xp,milestone_count,revision,derived_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'class',?,1,0,0,0,?,?,?)`).run(input.campaignCharacterId,input.campaignId,input.sheetId,input.actorId,candidate.profile_id,
      input.classRef.packId,input.classRef.packVersion,input.classRef.definitionId,candidate.derived_json,input.now,input.now);
  if(result.changes===0)return false;
  const sheet=db.prepare("SELECT race_pack_id,race_pack_version,race_definition_id FROM rpg_campaign_sheets WHERE id=?").get(input.sheetId) as any;
  const levelsJson=canonicalCatalogJson(catalog.levels),powersJson=canonicalCatalogJson(catalog.initialPowers);
  db.prepare(`INSERT INTO character_progression_bootstrap_v24(campaign_character_id,race_pack_id,race_pack_version,race_kind,race_definition_id,
    class_progression_json,class_progression_digest,initial_powers_json,initial_powers_digest,created_at) VALUES(?,?,?,'race',?,?,?,?,?,?)`)
    .run(input.campaignCharacterId,sheet.race_pack_id,sheet.race_pack_version,sheet.race_definition_id,levelsJson,progressionCatalogDigest(catalog.levels),
      powersJson,progressionCatalogDigest(catalog.initialPowers),input.now);
  db.prepare("INSERT INTO character_progression_snapshots_v23(campaign_character_id,revision,command_id,snapshot_json,created_at) VALUES(?,0,NULL,?,?)")
    .run(input.campaignCharacterId,canonicalCatalogJson({campaignCharacterId:input.campaignCharacterId,level:1,totalXp:0,milestoneCount:0,revision:0,derived:input.derived}),input.now);
  const power=db.prepare(`INSERT INTO character_known_powers_v23(campaign_character_id,kind,pack_id,pack_version,definition_id,source_level,source_choice_id,granted_by_command_id,granted_at)
    VALUES(?,?,?,?,?,1,NULL,NULL,?)`),sourceInsert=db.prepare(`INSERT INTO character_known_power_sources_v24(campaign_character_id,kind,pack_id,pack_version,definition_id,source_kind,source_reference_json,source_digest) VALUES(?,?,?,?,?,?,?,?)`);
  for(const source of catalog.initialPowers){const reference=source.reference,sourceJson=canonicalCatalogJson(source.sourceReference);
    power.run(input.campaignCharacterId,reference.kind,reference.packId,reference.packVersion,reference.definitionId,input.now);
    sourceInsert.run(input.campaignCharacterId,reference.kind,reference.packId,reference.packVersion,reference.definitionId,source.source,sourceJson,progressionCatalogDigest(source.sourceReference));}
  const pendingJson=canonicalCatalogJson([]);db.prepare(`INSERT INTO character_progression_pending_snapshots_v24(campaign_character_id,revision,command_id,pending_json,pending_digest,created_at) VALUES(?,0,NULL,?,?,?)`)
    .run(input.campaignCharacterId,pendingJson,progressionCatalogDigest([]),input.now);return true;
}

const rootFor=(db:DatabaseDriver.Database,id:string)=>db.prepare(`SELECT root.* FROM character_progression_v23 root
  JOIN character_progression_bootstrap_v24 bootstrap ON bootstrap.campaign_character_id=root.campaign_character_id WHERE root.campaign_character_id=?`).get(id) as ProgressionRootRow|undefined;
function authority(db:DatabaseDriver.Database,principal:string,row:ProgressionRootRow):Role|null{const membership=db.prepare(`SELECT membership.role,state.controller_principal_id FROM campaign_memberships membership
  JOIN campaign_actor_private_state state ON state.campaign_id=membership.campaign_id AND state.actor_id=? WHERE membership.campaign_id=? AND membership.principal_id=?`)
  .get(row.actor_id,row.campaign_id,principal) as {role:Role;controller_principal_id:string}|undefined;if(!membership||membership.role==="observer")return null;
  if(membership.role==="player"&&membership.controller_principal_id!==principal)return null;return membership.role;}

function pendingFor(db:DatabaseDriver.Database,row:ProgressionRootRow){const stored=db.prepare("SELECT pending_json,pending_digest FROM character_progression_pending_snapshots_v24 WHERE campaign_character_id=? AND revision=?")
  .get(row.campaign_character_id,row.revision) as {pending_json:string;pending_digest:string}|undefined;const expected=calculateAuthoritativeProgressionPreview(db,row).pendingChoices,expectedJson=canonicalCatalogJson(expected);
  if(!stored||stored.pending_json!==expectedJson||stored.pending_digest!==progressionCatalogDigest(expected))throw new Error("progression pending choice provenance is inconsistent");
  return expected.map((choice)=>progressionPendingChoiceSchema.parse(choice));}
function assertPowerProvenance(db:DatabaseDriver.Database,row:ProgressionRootRow):void{const catalog=loadExactProgressionCatalog(db,row),expected=expectedKnownPowerSources(db,row,catalog);
  const actual=db.prepare(`SELECT power.kind,power.pack_id,power.pack_version,power.definition_id,source.source_kind,source.source_reference_json,source.source_digest
    FROM character_known_powers_v23 power LEFT JOIN character_known_power_sources_v24 source ON source.campaign_character_id=power.campaign_character_id
      AND source.kind=power.kind AND source.pack_id=power.pack_id AND source.pack_version=power.pack_version AND source.definition_id=power.definition_id
    WHERE power.campaign_character_id=?`).all(row.campaign_character_id) as Array<any>;
  if(actual.length!==expected.size)throw new Error("known power provenance is incomplete");for(const power of actual){const key=progressionReferenceKey({kind:power.kind,packId:power.pack_id,packVersion:power.pack_version,definitionId:power.definition_id}),source=expected.get(key);
    if(!source||power.source_kind!==source.sourceKind||power.source_reference_json!==canonicalCatalogJson(source.sourceReference)||power.source_digest!==progressionCatalogDigest(source.sourceReference))throw new Error("known power exact source provenance is inconsistent");}}
function stateFor(db:DatabaseDriver.Database,row:ProgressionRootRow,pendingOverride?:ProgressionPreview["pendingChoices"]):ProgressionState{loadCanonicalProgressionProfile(db,row.profile_id);assertPowerProvenance(db,row);
  const refs=readKnownPowerReferences(db,row.campaign_character_id);return progressionStateSchema.parse({campaignCharacterId:row.campaign_character_id,campaignId:row.campaign_id,sheetId:row.sheet_id,actorId:row.actor_id,
    profile:loadCanonicalProgressionProfile(db,row.profile_id),classRef:{kind:"class",packId:row.class_pack_id,packVersion:row.class_pack_version,definitionId:row.class_definition_id},
    level:row.level,totalXp:row.total_xp,milestoneCount:row.milestone_count,revision:row.revision,pendingChoices:pendingOverride??pendingFor(db,row),
    knownAbilities:refs.filter((ref)=>ref.kind==="ability"),knownSpells:refs.filter((ref)=>ref.kind==="spell"),derived:JSON.parse(row.derived_json),updatedAt:row.updated_at});}
const previewFor=(db:DatabaseDriver.Database,row:ProgressionRootRow,selections:ProgressionSelection[]=[])=>calculateAuthoritativeProgressionPreview(db,row,selections);
function retry(db:DatabaseDriver.Database,campaignId:string,actor:string,key:string){return db.prepare(`SELECT command.type,command.requested_json,command.campaign_character_id,receipt.result_json
  FROM character_progression_commands_v23 command JOIN character_progression_receipts_v23 receipt ON receipt.campaign_character_id=command.campaign_character_id AND receipt.command_id=command.command_id
  JOIN character_progression_command_proposals_v24 proposal ON proposal.campaign_character_id=command.campaign_character_id AND proposal.command_id=command.command_id AND proposal.proposed_result_json=receipt.result_json
  JOIN character_progression_events_v24 event ON event.campaign_character_id=command.campaign_character_id AND event.command_id=command.command_id AND event.event_id=proposal.proposed_event_id
  WHERE command.campaign_id=? AND command.actor_principal_id=? AND command.idempotency_key=?`).get(campaignId,actor,key) as any;}
function exactRetry(found:any,type:string,requested:unknown,id:string):ProgressionCommandResult|null{if(!found)return null;if(found.type!==type||found.campaign_character_id!==id||found.requested_json!==canonicalCatalogJson(requested))throw new CharacterProgressionConflictError("idempotency key was reused for a different progression command");return progressionCommandResultSchema.parse(JSON.parse(found.result_json));}
const snapshotJson=(row:ProgressionRootRow)=>canonicalCatalogJson({campaignCharacterId:row.campaign_character_id,level:row.level,totalXp:row.total_xp,milestoneCount:row.milestone_count,revision:row.revision,derived:JSON.parse(row.derived_json)});
function insertCommandProposal(db:DatabaseDriver.Database,values:{row:ProgressionRootRow;actor:string;commandId:string;event:ProgressionEvent;key:string;type:string;expected:number;requested:unknown;now:string;result:ProgressionCommandResult}){const resultJson=canonicalCatalogJson(values.result),requestedJson=canonicalCatalogJson(values.requested);
  db.prepare(`INSERT INTO character_progression_commands_v23(campaign_character_id,command_id,campaign_id,actor_principal_id,idempotency_key,type,expected_revision,requested_json,request_digest,proposed_result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(values.row.campaign_character_id,values.commandId,values.row.campaign_id,values.actor,values.key,values.type,values.expected,requestedJson,digest(values.requested),resultJson,values.now);
  db.prepare(`INSERT INTO character_progression_command_proposals_v24(campaign_character_id,command_id,proposed_event_id,proposed_event_type,proposed_event_json,proposed_result_json) VALUES(?,?,?,?,?,?)`)
    .run(values.row.campaign_character_id,values.commandId,values.event.eventId,values.event.type,canonicalCatalogJson(values.event),resultJson);}
function insertPending(db:DatabaseDriver.Database,row:ProgressionRootRow,commandId:string,pending:ProgressionPreview["pendingChoices"],now:string){const json=canonicalCatalogJson(pending);db.prepare(`INSERT INTO character_progression_pending_snapshots_v24(campaign_character_id,revision,command_id,pending_json,pending_digest,created_at) VALUES(?,?,?,?,?,?)`)
  .run(row.campaign_character_id,row.revision,commandId,json,progressionCatalogDigest(pending),now);}
function finishAudit(db:DatabaseDriver.Database,row:ProgressionRootRow,event:ProgressionEvent,expected:number,now:string,result:ProgressionCommandResult){db.prepare(`INSERT INTO character_progression_events_v24(event_id,campaign_character_id,command_id,type,revision_before,revision,occurred_at,public_data) VALUES(?,?,?,?,?,?,?,?)`)
  .run(event.eventId,row.campaign_character_id,event.commandId,event.type,expected,row.revision,now,canonicalCatalogJson(event.publicData));
  db.prepare("INSERT INTO character_progression_snapshots_v23(campaign_character_id,revision,command_id,snapshot_json,created_at) VALUES(?,?,?,?,?)").run(row.campaign_character_id,row.revision,event.commandId,snapshotJson(row),now);
  db.prepare("INSERT INTO character_progression_receipts_v23(campaign_character_id,command_id,revision_before,revision_after,result_json) VALUES(?,?,?,?,?)").run(row.campaign_character_id,event.commandId,expected,row.revision,canonicalCatalogJson(result));}
function eventFor(values:{eventId:string;commandId:string;characterId:string;type:ProgressionEvent["type"];revision:number;now:string;publicData:ProgressionEvent["publicData"]}){return progressionEventSchema.parse({eventId:values.eventId,commandId:values.commandId,campaignCharacterId:values.characterId,type:values.type,revision:values.revision,occurredAt:values.now,publicData:values.publicData});}

export interface CharacterProgressionRepository{
  getCharacterProgression(actorPrincipalId:string,campaignCharacterId:string):ProgressionState|null;
  previewCharacterProgression(actorPrincipalId:string,campaignCharacterId:string,selections?:ProgressionSelection[]):ProgressionPreview|null;
  grantCharacterXp(actorPrincipalId:string,campaignCharacterId:string,input:GrantCharacterXpInput):ProgressionCommandResult;
  grantCharacterMilestone(actorPrincipalId:string,campaignCharacterId:string,input:GrantCharacterMilestoneInput):ProgressionCommandResult;
  correctCharacterProgressionEntry(actorPrincipalId:string,campaignCharacterId:string,input:CorrectCharacterXpInput):ProgressionCommandResult;
  applyCharacterProgression(actorPrincipalId:string,campaignCharacterId:string,input:ApplyCharacterProgressionInput):ProgressionCommandResult;
  getCharacterProgressionReceipt(actorPrincipalId:string,campaignCharacterId:string,commandId:string):ProgressionReceipt|null;
  listCharacterProgressionEvents(actorPrincipalId:string,campaignCharacterId:string):ProgressionEvent[];
}
export function createCharacterProgressionRepository(db:DatabaseDriver.Database,deps:{clock:Clock;ids:IdGenerator},assertFactoryMutation:()=>void):CharacterProgressionRepository{
  const authorized=(actor:string,id:string)=>{const row=rootFor(db,resourceIdSchema.parse(id));if(!row||!authority(db,resourceIdSchema.parse(actor),row))return null;return row;};
  const ledgerCommand=(kind:"grant-xp"|"grant-milestone",actor:string,id:string,input:GrantCharacterXpInput|GrantCharacterMilestoneInput)=>{assertFactoryMutation();const normalized=(kind==="grant-xp"?grantCharacterXpInputSchema:grantCharacterMilestoneInputSchema).parse(input) as any;
    return db.transaction(()=>{const row=authorized(actor,id);if(!row)throw new CharacterProgressionAuthorizationError();const again=exactRetry(retry(db,row.campaign_id,actor,normalized.idempotencyKey),kind,normalized,id);if(again)return again;
      if(row.revision!==normalized.expectedRevision)throw new CharacterProgressionStaleError();const mode=loadCanonicalProgressionProfile(db,row.profile_id).mode;if((kind==="grant-xp")!==(mode==="xp"))throw new CharacterProgressionConflictError("grant kind does not match progression mode");
      const now=utcIsoTimestampSchema.parse(deps.clock.now().toISOString()),commandId=resourceIdSchema.parse(deps.ids.nextId()),eventId=resourceIdSchema.parse(deps.ids.nextId()),entryId=resourceIdSchema.parse(deps.ids.nextId());
      db.prepare("UPDATE character_progression_v23 SET total_xp=total_xp+?,milestone_count=milestone_count+?,revision=revision+1,updated_at=? WHERE campaign_character_id=?")
        .run(kind==="grant-xp"?normalized.amount:0,kind==="grant-milestone"?1:0,now,id);const updated=rootFor(db,id)!,preview=previewFor(db,updated),state=stateFor(db,updated,preview.pendingChoices);
      const receipt=progressionReceiptSchema.parse({commandId,campaignCharacterId:id,idempotencyKey:normalized.idempotencyKey,type:kind,revisionBefore:row.revision,revisionAfter:updated.revision,occurredAt:now,state,appliedLevels:[]}),result=progressionCommandResultSchema.parse({progression:state,receipt});
      const event=eventFor({eventId,commandId,characterId:id,type:"progress_granted",revision:updated.revision,now,publicData:{kind:"grant",mode,amount:kind==="grant-xp"?normalized.amount:1}});
      insertCommandProposal(db,{row:updated,actor,commandId,event,key:normalized.idempotencyKey,type:kind,expected:row.revision,requested:normalized,now,result});
      db.prepare(`INSERT INTO character_progression_ledger_v23(entry_id,campaign_character_id,command_id,kind,xp_delta,milestone_delta,correction_of_entry_id,reason,occurred_at) VALUES(?,?,?,?,?,?,NULL,?,?)`)
        .run(entryId,id,commandId,kind==="grant-xp"?"xp":"milestone",kind==="grant-xp"?normalized.amount:0,kind==="grant-milestone"?1:0,normalized.reason,now);
      insertPending(db,updated,commandId,preview.pendingChoices,now);finishAudit(db,updated,event,row.revision,now,result);return result;}).immediate();};
  return {
    getCharacterProgression(actor,id){const row=authorized(actor,id);return row?stateFor(db,row):null;},
    previewCharacterProgression(actor,id,selections=[]){const row=authorized(actor,id);return row?previewFor(db,row,selections):null;},
    grantCharacterXp(actor,id,input){return ledgerCommand("grant-xp",actor,id,input);},grantCharacterMilestone(actor,id,input){return ledgerCommand("grant-milestone",actor,id,input);},
    correctCharacterProgressionEntry(actor,id,input){assertFactoryMutation();const normalized=correctCharacterXpInputSchema.parse(input);return db.transaction(()=>{const row=authorized(actor,id);if(!row)throw new CharacterProgressionAuthorizationError();const role=authority(db,actor,row);if(role!=="owner"&&role!=="gm")throw new CharacterProgressionAuthorizationError();
      const again=exactRetry(retry(db,row.campaign_id,actor,normalized.idempotencyKey),"correct-xp",normalized,id);if(again)return again;if(row.revision!==normalized.expectedRevision)throw new CharacterProgressionStaleError();
      const original=db.prepare("SELECT * FROM character_progression_ledger_v23 WHERE entry_id=? AND campaign_character_id=? AND kind IN ('xp','milestone')").get(normalized.entryId,id) as any;if(!original)throw new CharacterProgressionConflictError("corrected entry is unavailable");
      const now=utcIsoTimestampSchema.parse(deps.clock.now().toISOString()),commandId=resourceIdSchema.parse(deps.ids.nextId()),eventId=resourceIdSchema.parse(deps.ids.nextId()),entryId=resourceIdSchema.parse(deps.ids.nextId());
      db.prepare("UPDATE character_progression_v23 SET total_xp=total_xp-?,milestone_count=milestone_count-?,revision=revision+1,updated_at=? WHERE campaign_character_id=?").run(original.xp_delta,original.milestone_delta,now,id);
      const updated=rootFor(db,id)!,preview=previewFor(db,updated),state=stateFor(db,updated,preview.pendingChoices),receipt=progressionReceiptSchema.parse({commandId,campaignCharacterId:id,idempotencyKey:normalized.idempotencyKey,type:"correct-xp",revisionBefore:row.revision,revisionAfter:updated.revision,occurredAt:now,state,appliedLevels:[]}),result=progressionCommandResultSchema.parse({progression:state,receipt});
      const event=eventFor({eventId,commandId,characterId:id,type:"progress_corrected",revision:updated.revision,now,publicData:{kind:"correction",correctedEntryId:original.entry_id,reason:normalized.reason}});
      insertCommandProposal(db,{row:updated,actor,commandId,event,key:normalized.idempotencyKey,type:"correct-xp",expected:row.revision,requested:normalized,now,result});
      db.prepare(`INSERT INTO character_progression_ledger_v23(entry_id,campaign_character_id,command_id,kind,xp_delta,milestone_delta,correction_of_entry_id,reason,occurred_at) VALUES(?,?,?,'correction',?,?,?,?,?)`)
        .run(entryId,id,commandId,-original.xp_delta,-original.milestone_delta,original.entry_id,normalized.reason,now);insertPending(db,updated,commandId,preview.pendingChoices,now);finishAudit(db,updated,event,row.revision,now,result);return result;}).immediate();},
    applyCharacterProgression(actor,id,input){assertFactoryMutation();const normalized=applyCharacterProgressionInputSchema.parse(input);return db.transaction(()=>{const row=authorized(actor,id);if(!row)throw new CharacterProgressionAuthorizationError();const again=exactRetry(retry(db,row.campaign_id,actor,normalized.idempotencyKey),"apply-levels",normalized,id);if(again)return again;
      if(row.revision!==normalized.previewRevision)throw new CharacterProgressionStaleError();const base=previewFor(db,row),selected=previewFor(db,row,normalized.selections);if(base.token!==normalized.previewToken)throw new CharacterProgressionStaleError();if(!base.levels.length)throw new CharacterProgressionConflictError("no eligible levels");
      const required=new Map(base.pendingChoices.map((choice)=>[choice.choiceId,choice]));if(normalized.selections.length!==required.size||new Set(normalized.selections.map((value)=>value.choiceId)).size!==required.size)throw new CharacterProgressionConflictError("every required progression choice must be selected exactly once");
      for(const selection of normalized.selections){const choice=required.get(selection.choiceId);if(!choice||!choice.options.some((option)=>progressionReferenceKey(option)===progressionReferenceKey(selection.ability)))throw new CharacterProgressionConflictError("progression selection is not an exact offered option");}
      const now=utcIsoTimestampSchema.parse(deps.clock.now().toISOString()),commandId=resourceIdSchema.parse(deps.ids.nextId()),eventId=resourceIdSchema.parse(deps.ids.nextId()),final=selected.levels.at(-1)!;
      const advancementIds=selected.levels.map(()=>resourceIdSchema.parse(deps.ids.nextId())),known=stateFor(db,row),newAbilities=[...known.knownAbilities,...selected.levels.flatMap((level)=>[...level.fixedAbilities,...level.selectedAbilities])],newSpells=[...known.knownSpells,...selected.levels.flatMap((level)=>level.spells)];
      if(new Set(newAbilities.map(progressionReferenceKey)).size!==newAbilities.length||new Set(newSpells.map(progressionReferenceKey)).size!==newSpells.length)throw new CharacterProgressionConflictError("advancement contains a duplicate known power");
      const projected=progressionStateSchema.parse({...known,level:final.level,revision:row.revision+1,pendingChoices:[],knownAbilities:sortReferences(newAbilities),knownSpells:sortReferences(newSpells),derived:final.derivedAfter,updatedAt:now});
      const receipt=progressionReceiptSchema.parse({commandId,campaignCharacterId:id,idempotencyKey:normalized.idempotencyKey,type:"apply-levels",revisionBefore:row.revision,revisionAfter:row.revision+1,occurredAt:now,state:projected,appliedLevels:selected.levels}),result=progressionCommandResultSchema.parse({progression:projected,receipt});
      const event=eventFor({eventId,commandId,characterId:id,type:"levels_applied",revision:row.revision+1,now,publicData:{kind:"advancement",levels:selected.levels.map((level)=>level.level)}});insertCommandProposal(db,{row,actor,commandId,event,key:normalized.idempotencyKey,type:"apply-levels",expected:row.revision,requested:normalized,now,result});
      db.prepare("UPDATE rpg_character_classes SET level=? WHERE sheet_id=? AND position=0").run(final.level,row.sheet_id);for(const level of selected.levels){db.prepare("UPDATE rpg_actor_resources SET current=?,max=? WHERE actor_id=? AND name='health'").run(level.hp.currentAfter,level.hp.maxAfter,row.actor_id);for(const resource of level.resources)db.prepare(`INSERT INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?,?,?,?) ON CONFLICT(actor_id,name) DO UPDATE SET current=excluded.current,max=excluded.max`).run(row.campaign_id,row.actor_id,resource.resourceId,resource.currentAfter,resource.maxAfter);}
      db.prepare("UPDATE character_progression_v23 SET level=?,derived_json=?,revision=revision+1,updated_at=? WHERE campaign_character_id=?").run(final.level,canonicalCatalogJson(final.derivedAfter),now,id);
      const power=db.prepare(`INSERT INTO character_known_powers_v23(campaign_character_id,kind,pack_id,pack_version,definition_id,source_level,source_choice_id,granted_by_command_id,granted_at) VALUES(?,?,?,?,?,?,?,?,?)`),source=db.prepare(`INSERT INTO character_known_power_sources_v24(campaign_character_id,kind,pack_id,pack_version,definition_id,source_kind,source_reference_json,source_digest) VALUES(?,?,?,?,?,?,?,?)`);
      for(const [index,level] of selected.levels.entries()){const advancementId=advancementIds[index]!;const levelSelections=normalized.selections.filter((selection)=>required.get(selection.choiceId)?.level===level.level);
        db.prepare("INSERT INTO character_level_advancements_v23(advancement_id,campaign_character_id,command_id,level,position,preview_token,selections_json,changes_json,applied_at) VALUES(?,?,?,?,?,?,?,?,?)").run(advancementId,id,commandId,level.level,index,normalized.previewToken,canonicalCatalogJson(levelSelections),canonicalCatalogJson(level),now);
        for(const reference of [...level.fixedAbilities,...level.spells]){const sourceRef={advancementId,commandId,level:level.level},json=canonicalCatalogJson(sourceRef);power.run(id,reference.kind,reference.packId,reference.packVersion,reference.definitionId,level.level,null,commandId,now);source.run(id,reference.kind,reference.packId,reference.packVersion,reference.definitionId,"advancement-fixed",json,progressionCatalogDigest(sourceRef));}
        for(const reference of level.selectedAbilities){const selection=levelSelections.find((value)=>progressionReferenceKey(value.ability)===progressionReferenceKey(reference))!;const sourceRef={advancementId,choiceId:selection.choiceId,commandId,level:level.level},json=canonicalCatalogJson(sourceRef);power.run(id,reference.kind,reference.packId,reference.packVersion,reference.definitionId,level.level,selection.choiceId,commandId,now);source.run(id,reference.kind,reference.packId,reference.packVersion,reference.definitionId,"advancement-choice",json,progressionCatalogDigest(sourceRef));}}
      const updated=rootFor(db,id)!;insertPending(db,updated,commandId,[],now);const actual=stateFor(db,updated);if(canonicalCatalogJson(actual)!==canonicalCatalogJson(projected))throw new Error("applied progression result does not match inserted authoritative state");finishAudit(db,updated,event,row.revision,now,result);return result;}).immediate();},
    getCharacterProgressionReceipt(actor,id,commandId){const row=authorized(actor,id);if(!row)return null;const receipt=db.prepare(`SELECT receipt.result_json FROM character_progression_receipts_v23 receipt JOIN character_progression_command_proposals_v24 proposal ON proposal.campaign_character_id=receipt.campaign_character_id AND proposal.command_id=receipt.command_id AND proposal.proposed_result_json=receipt.result_json JOIN character_progression_events_v24 event ON event.campaign_character_id=receipt.campaign_character_id AND event.command_id=receipt.command_id AND event.event_id=proposal.proposed_event_id WHERE receipt.campaign_character_id=? AND receipt.command_id=?`).get(id,resourceIdSchema.parse(commandId)) as {result_json:string}|undefined;return receipt?progressionReceiptSchema.parse(JSON.parse(receipt.result_json).receipt):null;},
    listCharacterProgressionEvents(actor,id){const row=authorized(actor,id);if(!row)return [];return (db.prepare("SELECT event_id,command_id,type,revision,occurred_at,public_data FROM character_progression_events_v24 WHERE campaign_character_id=? ORDER BY revision").all(id) as Array<any>).map((event)=>progressionEventSchema.parse({eventId:event.event_id,commandId:event.command_id,campaignCharacterId:id,type:event.type,revision:event.revision,occurredAt:event.occurred_at,publicData:JSON.parse(event.public_data)}));},
  };
}
