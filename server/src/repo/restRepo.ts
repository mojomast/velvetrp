import type DatabaseDriver from "better-sqlite3";
import { SRD_5_1_STARTER_RULES_PROFILE_ID, actorResourcesSchema, restCommandSchema, restReceiptSchema, resourceIdSchema, utcIsoTimestampSchema, type RestCommand, type RestHitDiceResolution, type RestReceipt } from "@velvet/contracts";
import { ActorResourceConflictError, m15Authorized, runM15Mutation, type M15Dependencies, type M15Result } from "./actorResourceRepo.js";
import { actorHasActiveEncounter } from "./encounter/activeEncounterPolicy.js";
import { resolveCampaignRuleset } from "../rulesets/campaignBinding.js";
import type { RandomNumberGenerator } from "../runtime.js";

export class RestAuthorizationError extends Error { readonly code="REST_FORBIDDEN"; }
export class RestStaleError extends Error { readonly code="REST_STALE"; }
export class RestIllegalStateError extends Error { readonly code="REST_ILLEGAL_STATE"; }

const LONG_REST_INTERVAL_MINUTES=24*60;

export type RestPreview={kind:"short"|"long";revision:number;hitDiceToSpend?:number;recovery:{resources:Array<{resourceId:string;before:number;after:number}>}};
export interface RestRepository { previewRests(principal:string,campaignId:string,actorId:string):RestPreview[]; takeRest(principal:string,command:RestCommand):M15Result<{rest:RestReceipt;actorState:{resources:ReturnType<typeof actorResourcesSchema.parse>;revision:number}}>; listRestReceipts(principal:string,campaignId:string,actorId:string):RestReceipt[]; }
// Long rests use only the durable expedition clock and GM-established camp;
// wall-clock time is deliberately not an eligibility input.
export function createRestRepository(db:DatabaseDriver.Database,deps:M15Dependencies&{rng:RandomNumberGenerator},assertMutation:()=>void):RestRepository {
  const longRestAvailable=(campaignId:string,actorId:string)=>{const sessions=db.prepare(`SELECT attached.session_id FROM campaign_sessions attached
      JOIN sessions session ON session.id=attached.session_id WHERE attached.campaign_id=? AND session.state='active' AND session.stopped_at IS NULL`).all(campaignId) as Array<{session_id:string}>;
    if(sessions.length!==1)return false;const sessionId=sessions[0]!.session_id;
    const expedition=db.prepare(`SELECT elapsed_minutes,camp_location_id FROM world_expeditions_v60 WHERE campaign_id=? AND session_id=?`)
      .get(campaignId,sessionId)as {elapsed_minutes:number;camp_location_id:string|null}|undefined;
    const location=db.prepare("SELECT location_id FROM campaign_actor_locations_v28 WHERE campaign_id=? AND session_id=? AND actor_id=?")
      .get(campaignId,sessionId,actorId)as {location_id:string}|undefined;
    if(!expedition?.camp_location_id||expedition.camp_location_id!==location?.location_id)return false;
    const prior=db.prepare(`SELECT elapsed_after FROM rpg_rest_elapsed_v60 WHERE campaign_id=? AND actor_id=?
      ORDER BY rowid DESC LIMIT 1`).get(campaignId,actorId)as {elapsed_after:number}|undefined;
    return prior===undefined||expedition.elapsed_minutes-prior.elapsed_after>=LONG_REST_INTERVAL_MINUTES;};
  const list=(principal:string,campaign:string,actor:string):RestReceipt[]=>{resourceIdSchema.parse(principal);resourceIdSchema.parse(campaign);resourceIdSchema.parse(actor);if(!m15Authorized(db,principal,campaign,actor))return [];
    return (db.prepare(`SELECT receipt.canonical_result_json FROM rpg_rest_receipts_v25 rest
      JOIN rpg_m15_receipts_v25 receipt ON receipt.campaign_id=rest.campaign_id AND receipt.actor_id=rest.actor_id AND receipt.command_id=rest.receipt_id
      WHERE rest.campaign_id=? AND rest.actor_id=? ORDER BY rest.occurred_at,rest.receipt_id`).all(campaign,actor)as any[])
      .map(row=>restReceiptSchema.parse(JSON.parse(row.canonical_result_json).rest));};
  const recovery=(campaignId:string,actorId:string,kind:"short"|"long",hitDiceToSpend?:number)=>{let ruleset:ReturnType<typeof resolveCampaignRuleset>;
    try{ruleset=resolveCampaignRuleset(db,campaignId);}catch{return{changes:[],chargeChanges:[],ammunitionChanges:[]};}
    if(ruleset.rulesProfileId===SRD_5_1_STARTER_RULES_PROFILE_ID){
      const rows=db.prepare("SELECT name,current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name IN ('health','hit-dice-d10','exhaustion') ORDER BY name").all(campaignId,actorId)as Array<{name:string;current:number;max:number}>;
      const resources=new Map(rows.map(row=>[row.name,row])),character=db.prepare(`SELECT COUNT(*) classCount,COALESCE(SUM(character_class.level),0) level,MIN(character_class.definition_id) definitionId,
          (SELECT attribute.value FROM rpg_character_attributes attribute WHERE attribute.campaign_id=actor.campaign_id AND attribute.sheet_id=actor.sheet_id AND attribute.attribute_id='constitution') constitution
        FROM campaign_actors actor JOIN rpg_character_classes character_class ON character_class.campaign_id=actor.campaign_id AND character_class.sheet_id=actor.sheet_id
        WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId,actorId)as {classCount:number;level:number;definitionId:string|null;constitution:number|null};
      const health=resources.get('health'),hitDice=resources.get('hit-dice-d10'),exhaustion=resources.get('exhaustion');
      const valid=rows.length===3&&character.classCount===1&&character.level>=1&&character.level<=2&&character.definitionId==='srd-5.1:class:fighter'
        &&Number.isInteger(character.constitution)&&character.constitution!>=1&&character.constitution!<=30&&health&&hitDice&&exhaustion
        &&Number.isInteger(health.current)&&Number.isInteger(health.max)&&health.max>0&&health.current>=0&&health.current<=health.max
        &&hitDice.max===character.level&&Number.isInteger(hitDice.current)&&hitDice.current>=0&&hitDice.current<=hitDice.max
        &&exhaustion.max===6&&Number.isInteger(exhaustion.current)&&exhaustion.current>=0&&exhaustion.current<=6;
      if(!valid||!ruleset.module.mechanics)return{changes:[],chargeChanges:[],ammunitionChanges:[],srdMalformed:true};
      if(kind==='short'){
        if(hitDiceToSpend===undefined)return{changes:[],chargeChanges:[],ammunitionChanges:[],srd:{health,hitDice,exhaustion,constitution:character.constitution!}};
        if(!Number.isInteger(hitDiceToSpend)||hitDiceToSpend<1||hitDiceToSpend>hitDice.current)return{changes:[],chargeChanges:[],ammunitionChanges:[],srdMalformed:true};
        return{changes:[{resourceId:'hit-dice-d10',before:hitDice.current,after:hitDice.current-hitDiceToSpend}],chargeChanges:[],ammunitionChanges:[],srd:{health,hitDice,exhaustion,constitution:character.constitution!}};
      }
      const recoveredDice=Math.min(hitDice.max-hitDice.current,Math.max(1,Math.floor(character.level/2))),changes=[] as Array<{resourceId:string;before:number;after:number}>;
      if(health.current<health.max)changes.push({resourceId:'health',before:health.current,after:health.max});
      if(recoveredDice>0)changes.push({resourceId:'hit-dice-d10',before:hitDice.current,after:hitDice.current+recoveredDice});
      if(exhaustion.current>0)changes.push({resourceId:'exhaustion',before:exhaustion.current,after:exhaustion.current-1});
      return{changes,chargeChanges:[],ammunitionChanges:[],srd:{health,hitDice,exhaustion,constitution:character.constitution!}};
    }
    if(ruleset.rulesetId==='dnd-5e')return{changes:[],chargeChanges:[],ammunitionChanges:[],srdMalformed:true};
    const resources=db.prepare(`SELECT resource.name,resource.current,resource.max,binding.binding_json
       FROM rpg_actor_resources resource LEFT JOIN rpg_actor_resource_bindings_v25 binding
       ON binding.campaign_id=resource.campaign_id AND binding.actor_id=resource.actor_id AND binding.resource_name=resource.name
       WHERE resource.campaign_id=? AND resource.actor_id=? ORDER BY resource.name`).all(campaignId,actorId)as any[];
    const changes=resources.filter(row=>{const value=row.binding_json?JSON.parse(row.binding_json).recovery:undefined;
      return row.current<row.max&&(value==='short-rest'||(kind==='long'&&value==='long-rest'));}).map(row=>({resourceId:row.name,before:row.current,after:row.max}));
    const sidecars=(table:string,current:string,maximum:string,suffix:string)=>(db.prepare(`SELECT sidecar.resource_name,sidecar.${current} current,sidecar.${maximum} maximum,binding.binding_json
      FROM ${table} sidecar JOIN rpg_actor_resource_bindings_v25 binding ON binding.campaign_id=sidecar.campaign_id AND binding.actor_id=sidecar.actor_id AND binding.resource_name=sidecar.resource_name
      WHERE sidecar.campaign_id=? AND sidecar.actor_id=?`).all(campaignId,actorId)as any[]).filter(row=>{const value=JSON.parse(row.binding_json).recovery;
      return row.current<row.maximum&&(value==='short-rest'||(kind==='long'&&value==='long-rest'));}).map(row=>({resourceId:`${row.resource_name}:${suffix}`,before:row.current,after:row.maximum,resourceName:row.resource_name}));
    const chargeChanges=sidecars('rpg_actor_resource_charges_v25','current_charges','maximum_charges','charges');
    const ammunitionChanges=sidecars('rpg_actor_resource_ammunition_v25','current_ammunition','maximum_ammunition','ammunition');
    changes.push(...chargeChanges.map(({resourceId,before,after})=>({resourceId,before,after})),...ammunitionChanges.map(({resourceId,before,after})=>({resourceId,before,after})));
    return{changes,chargeChanges,ammunitionChanges};};
  return {listRestReceipts:list,previewRests(principal,campaignId,actorId){resourceIdSchema.parse(principal);resourceIdSchema.parse(campaignId);resourceIdSchema.parse(actorId);
    if(!m15Authorized(db,principal,campaignId,actorId)||actorHasActiveEncounter(db,campaignId,actorId))return[];
    const revision=(db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?").get(campaignId,actorId)as any)?.revision??0;
    let ruleset:ReturnType<typeof resolveCampaignRuleset>;try{ruleset=resolveCampaignRuleset(db,campaignId);}catch{return[];}
    const canLongRest=longRestAvailable(campaignId,actorId);
    if(ruleset.rulesProfileId===SRD_5_1_STARTER_RULES_PROFILE_ID){const base=recovery(campaignId,actorId,'short');if(base.srdMalformed||!base.srd)return[];
      const short=base.srd.health.current<base.srd.health.max?Array.from({length:base.srd.hitDice.current},(_,index)=>{const spend=index+1,value=recovery(campaignId,actorId,'short',spend);return{kind:'short' as const,revision,hitDiceToSpend:spend,recovery:{resources:value.changes}};}):[];
      const long=recovery(campaignId,actorId,'long');return !canLongRest||long.srdMalformed||!long.changes.length?short:[...short,{kind:'long' as const,revision,recovery:{resources:long.changes}}];}
    return(["short","long"]as const).flatMap(kind=>{if(kind==='long'&&!canLongRest)return[];const value=recovery(campaignId,actorId,kind);return value.changes.length?[{kind,revision,recovery:{resources:value.changes}}]:[];});},
    takeRest(principal,input){const command=restCommandSchema.parse(input);return runM15Mutation(db,deps,assertMutation,{principal,campaignId:command.campaignId,actorId:command.actorId,family:'rest',type:command.type,expectedRevision:command.expectedRevision,idempotencyKey:command.idempotencyKey,request:command,changedKeys:[`rest:${command.actorId}`],apply:(after,now,commandId)=>{
    if(!m15Authorized(db,principal,command.campaignId,command.actorId))throw new RestAuthorizationError('rest unavailable');
        if(actorHasActiveEncounter(db,command.campaignId,command.actorId))throw new ActorResourceConflictError('rest is unavailable during an active encounter');
      // Legacy recovery is opt-in and pinned to the resource binding. The bounded
     // vocabulary intentionally mirrors catalog mechanics: short-rest pools
     // recover on either rest, long-rest pools only on a long rest, and every
     // other resource is untouched.
       const planned=recovery(command.campaignId,command.actorId,command.type==='take_short_rest'?'short':'long',command.type==='take_short_rest'?command.hitDiceToSpend:undefined);
       const {chargeChanges,ammunitionChanges}=planned;
        const changes:Array<{resourceId:string;before:number;after:number}>=[...planned.changes];
        let hitDice:RestHitDiceResolution|undefined;
        if(planned.srdMalformed)throw new RestIllegalStateError('SRD rest state is unavailable');
        if(command.type==='take_long_rest'&&!longRestAvailable(command.campaignId,command.actorId))throw new RestIllegalStateError('long rest requires an active GM-established camp and 1,440 elapsed in-game minutes since the prior long rest');
       if(planned.srd&&command.type==='take_short_rest'){
         if(command.hitDiceToSpend===undefined)throw new RestIllegalStateError('SRD short rest requires selected hit dice');
         const rolls=Array.from({length:command.hitDiceToSpend},()=>{const roll=deps.rng.integer(1,11);if(!Number.isSafeInteger(roll)||roll<1||roll>10)throw new Error('rest RNG returned an out-of-range d10');return roll;});
         const constitutionModifier=Math.floor((planned.srd.constitution-10)/2),requested=rolls.reduce((sum,roll)=>sum+Math.max(0,roll+constitutionModifier),0),before=planned.srd.health.current,afterHealth=Math.min(planned.srd.health.max,before+requested);
         if(afterHealth!==before)changes.unshift({resourceId:'health',before,after:afterHealth});
         hitDice={dieSize:10,spent:command.hitDiceToSpend,rolls,constitutionModifier,hitPointsRecovered:afterHealth-before};
       }
    if(!changes.length)throw new RestIllegalStateError('no resource can recover');
     for(const delta of changes)db.prepare("UPDATE rpg_actor_resources SET current=? WHERE campaign_id=? AND actor_id=? AND name=?").run(delta.after,command.campaignId,command.actorId,delta.resourceId);
     for(const delta of chargeChanges)db.prepare("UPDATE rpg_actor_resource_charges_v25 SET current_charges=? WHERE campaign_id=? AND actor_id=? AND resource_name=?").run(delta.after,command.campaignId,command.actorId,delta.resourceName);
     for(const delta of ammunitionChanges)db.prepare("UPDATE rpg_actor_resource_ammunition_v25 SET current_ammunition=? WHERE campaign_id=? AND actor_id=? AND resource_name=?").run(delta.after,command.campaignId,command.actorId,delta.resourceName);
    // The v25 rest receipt is the immutable domain receipt; generic M1.5 receipt retains retry data.
      db.prepare("INSERT INTO rpg_rest_receipts_v25 VALUES(?,?,?,?,?,?,?,?)").run(commandId,command.campaignId,command.actorId,commandId,after,command.type==='take_short_rest'?'short':'long',JSON.stringify(changes),now);
      if(command.type==='take_long_rest'){
        const session=db.prepare(`SELECT attached.session_id FROM campaign_sessions attached JOIN sessions session ON session.id=attached.session_id
          WHERE attached.campaign_id=? AND session.state='active' AND session.stopped_at IS NULL`).get(command.campaignId)as {session_id:string};
        const expedition=db.prepare("SELECT elapsed_minutes FROM world_expeditions_v60 WHERE campaign_id=? AND session_id=?")
          .get(command.campaignId,session.session_id)as {elapsed_minutes:number};
        db.prepare("INSERT INTO rpg_rest_elapsed_v60 VALUES(?,?,?,?,?,?)").run(commandId,command.campaignId,command.actorId,session.session_id,expedition.elapsed_minutes,expedition.elapsed_minutes+480);
        db.prepare("UPDATE world_expeditions_v60 SET elapsed_minutes=? WHERE campaign_id=? AND session_id=?")
          .run(expedition.elapsed_minutes+480,command.campaignId,session.session_id);
      }
     return {rest:restReceiptSchema.parse({restId:commandId,campaignId:command.campaignId,actorId:command.actorId,kind:command.type==='take_short_rest'?'short':'long',recoveredAt:now,recovery:{resources:changes},...(hitDice?{hitDice}:{}),revisionBefore:command.expectedRevision,revisionAfter:after,idempotencyKey:command.idempotencyKey}),actorState:{resources:actorResourcesSchema.parse((db.prepare("SELECT name resourceId,current,max capacity FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? ORDER BY name").all(command.campaignId,command.actorId)as any[])),revision:after}};
  }});}};
}
