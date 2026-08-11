import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  activeEffectSchema, actorEffectCommandRequestSchema, effectCommandSchema, effectModifierSchema, resourceIdSchema,
  utcIsoTimestampSchema, type ActiveEffect, type ActorEffectCommandRequest, type EffectCommand, type EffectModifier,
} from "@velvet/contracts";
import type { Clock, IdGenerator, RandomNumberGenerator } from "../runtime.js";
import { m15Authorized } from "./actorResourceRepo.js";

export class M16AuthorizationError extends Error { readonly code="M16_FORBIDDEN"; }
export class M16StaleError extends Error { readonly code="M16_STALE"; }
export class M16ConflictError extends Error { readonly code="M16_CONFLICT"; }
export class EffectUnavailableError extends Error { readonly code="EFFECT_UNAVAILABLE"; }
export class EffectImmuneError extends Error { readonly code="EFFECT_IMMUNE"; }
export type M16Dependencies={clock:Clock;ids:IdGenerator;rng:RandomNumberGenerator};
export type M16Receipt={commandId:string;idempotencyKey:string;revisionBefore:number;revisionAfter:number;occurredAt:string};
export type M16Result<T extends object>=T&{receipt:M16Receipt};
export interface ActorEffectSnapshot { campaignId:string;actorId:string;effects:ActiveEffect[];revision:number; }

const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==="object"&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const digest=(v:unknown)=>createHash("sha256").update(canonical(v)).digest("hex");

/** Shared v26 command protocol. Retry lookup deliberately precedes stale checking. */
export function runM16Mutation<T extends object>(db:DatabaseDriver.Database,deps:M16Dependencies,guard:()=>void,values:{principal:string;campaignId:string;actorId:string;family:"check"|"power"|"effect";type:string;expectedRevision:number;idempotencyKey:string;request:object;eventType:string;authorize?:()=>boolean;build:(after:number,now:string,commandId:string)=>{result:T;persist:()=>void}}):M16Result<T>{
  guard(); const request=canonical(values.request);
  return db.transaction(()=>{
    if(!m15Authorized(db,values.principal,values.campaignId,values.actorId)||values.authorize?.()===false)throw new M16AuthorizationError("M1.6 mutation unavailable");
    const prior=db.prepare("SELECT command_family,command_type,canonical_request_json,receipt.canonical_result_json FROM rpg_m16_commands_v26 command JOIN rpg_m16_receipts_v26 receipt USING(campaign_id,actor_id,command_id) WHERE command.campaign_id=? AND command.actor_id=? AND idempotency_key=?").get(values.campaignId,values.actorId,values.idempotencyKey)as any;
    if(prior){if(prior.command_family!==values.family||prior.command_type!==values.type||prior.canonical_request_json!==request)throw new M16ConflictError("idempotency key was reused");return JSON.parse(prior.canonical_result_json);}
    const root=db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(values.campaignId,values.actorId)as any;
    const before=root?.revision??0;if(before!==values.expectedRevision)throw new M16StaleError("M1.6 revision is stale");
    const now=utcIsoTimestampSchema.parse(deps.clock.now().toISOString()),commandId=resourceIdSchema.parse(deps.ids.nextId()),after=before+1;
    if(!root)db.prepare("INSERT INTO rpg_m16_mutation_revisions_v26 VALUES(?,?,0,?)").run(values.campaignId,values.actorId,now);
    db.prepare("INSERT INTO rpg_m16_commands_v26 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(values.campaignId,values.actorId,commandId,values.family,values.type,values.idempotencyKey,request,digest(values.request),before,after,now);
    const built=values.build(after,now,commandId),result={...built.result,receipt:{commandId,idempotencyKey:values.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:now}} as M16Result<T>,json=canonical(result);
    db.prepare("INSERT INTO rpg_m16_receipts_v26 VALUES(?,?,?,?,?,?,?)").run(values.campaignId,values.actorId,commandId,after,json,digest(result),now);
    built.persist();
    db.prepare("INSERT INTO rpg_m16_events_v26 VALUES(?,?,?,?,?,?,?,?)").run(resourceIdSchema.parse(deps.ids.nextId()),values.campaignId,values.actorId,commandId,after,values.eventType,canonical(result),now);
    db.prepare("UPDATE rpg_m16_mutation_revisions_v26 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=?").run(after,now,values.campaignId,values.actorId);
    return result;
  }).immediate();
}

export interface EffectRepository {
  mutateEffect(principal:string,command:EffectCommand):M16Result<{effects:ActiveEffect[]}>;
  mutateActorEffect(principal:string,actorId:string,input:ActorEffectCommandRequest):M16Result<{campaignId:string;actorId:string;effects:ActiveEffect[]}>;
  listActiveEffects(principal:string,campaignId:string,actorId:string):ActiveEffect[];
  getActorEffectSnapshot(principal:string,actorId:string):ActorEffectSnapshot|null;
}

function stableEffects(effects:ActiveEffect[]):ActiveEffect[]{
  return [...effects].sort((left,right)=>left.appliedAt.localeCompare(right.appliedAt)||left.effectId.localeCompare(right.effectId));
}

/** Only the canonical campaign owner and GMs may use the public effect command lane. */
function canonicalGmAuthorized(db:DatabaseDriver.Database,principal:string,campaignId:string,actorId:string):boolean{
  return Boolean(db.prepare(`SELECT 1 FROM campaign_actors actor
    JOIN campaigns campaign ON campaign.id=actor.campaign_id
    JOIN campaign_memberships membership ON membership.campaign_id=campaign.id AND membership.principal_id=?
    WHERE actor.id=? AND actor.campaign_id=?
      AND (membership.role='gm' OR (membership.role='owner' AND campaign.owner_principal_id=membership.principal_id))
      AND (SELECT COUNT(*) FROM campaign_memberships owners WHERE owners.campaign_id=campaign.id AND owners.role='owner')=1
      AND EXISTS(SELECT 1 FROM campaign_memberships owner WHERE owner.campaign_id=campaign.id
        AND owner.principal_id=campaign.owner_principal_id AND owner.role='owner')`).get(principal,actorId,campaignId));
}

function sourceIsCurrentPublicExecutionPin(db:DatabaseDriver.Database,campaignId:string,source:ActiveEffect["source"]):boolean{
  if(source===null)return true;
  return Boolean(db.prepare(`SELECT 1 FROM campaign_catalog_current_pins pin
    JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
      AND visibility.kind=? AND visibility.definition_id=? AND visibility.publicly_reachable=1
    JOIN rpg_campaign_catalog_definitions_v25 execution ON execution.campaign_id=pin.campaign_id
      AND execution.pack_id=pin.pack_id AND execution.pack_version=pin.pack_version
      AND execution.kind=visibility.kind AND execution.definition_id=visibility.definition_id
    WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?`)
    .get(source.kind,source.definitionId,campaignId,source.packId,source.packVersion));
}

type EffectRow={
  effect_id:string;campaign_id:string;actor_id:string;source_pack_id:string|null;source_pack_version:string|null;
  source_kind:string|null;source_definition_id:string|null;duration_kind:string;remaining_rounds:number|null;
  expires_at:string|null;recovery_kind:string;concentration_key:string|null;applied_at:string;
  command_family:string;command_type:string;canonical_request_json:string;modifier_ordinal:number|null;
  canonical_result_json:string;modifier_kind:string|null;applies_to_id:string|null;amount:number|null;
};

function sidecarModifier(row:EffectRow):EffectModifier {
  if(row.modifier_kind===null||row.applies_to_id===null)throw new Error("incomplete effect modifier sidecar");
  const raw=row.modifier_kind==="flat"?{kind:"flat",appliesToId:row.applies_to_id,amount:row.amount}
    :row.modifier_kind==="proficiency"?{kind:"proficiency",appliesToId:row.applies_to_id,bonus:row.amount}
      :{kind:row.modifier_kind,appliesToId:row.applies_to_id};
  return effectModifierSchema.parse(raw);
}

/** Reconstruct only normalized mechanics and a validated legacy-command fallback. */
export function readActiveEffects(db:DatabaseDriver.Database,campaignId:string,actorId:string,now:string):ActiveEffect[]{
  const rows=db.prepare(`SELECT effect.effect_id,effect.campaign_id,effect.actor_id,effect.source_pack_id,effect.source_pack_version,
    effect.source_kind,effect.source_definition_id,effect.duration_kind,effect.remaining_rounds,effect.expires_at,
    effect.recovery_kind,effect.concentration_key,effect.applied_at,command.command_family,command.command_type,
    command.canonical_request_json,receipt.canonical_result_json,modifier.modifier_ordinal,modifier.modifier_kind,modifier.applies_to_id,modifier.amount
    FROM rpg_active_effects_v26 effect
    JOIN rpg_m16_commands_v26 command ON command.campaign_id=effect.campaign_id AND command.actor_id=effect.actor_id AND command.command_id=effect.command_id
    JOIN rpg_m16_receipts_v26 receipt ON receipt.campaign_id=command.campaign_id AND receipt.actor_id=command.actor_id AND receipt.command_id=command.command_id
    LEFT JOIN rpg_effect_modifiers_v26 modifier ON modifier.effect_id=effect.effect_id
    WHERE effect.campaign_id=? AND effect.actor_id=? AND effect.status='active'
      AND (effect.duration_kind<>'until_timestamp' OR effect.expires_at>?)
      AND (effect.duration_kind<>'rounds' OR effect.remaining_rounds>0)
    ORDER BY effect.applied_at,effect.effect_id,modifier.modifier_ordinal`).all(campaignId,actorId,now) as EffectRow[];
  const grouped=new Map<string,{row:EffectRow;modifiers:EffectModifier[];hasSidecars:boolean}>();
  for(const row of rows){
    let group=grouped.get(row.effect_id);
    if(!group){group={row,modifiers:[],hasSidecars:row.modifier_ordinal!==null};grouped.set(row.effect_id,group);}
    if(row.modifier_ordinal!==null){
      if(row.modifier_ordinal!==group.modifiers.length)throw new Error("effect modifier ordinals are not contiguous");
      group.modifiers.push(sidecarModifier(row));
    }else if(group.hasSidecars)throw new Error("effect sidecars are inconsistent");
  }
  return [...grouped.values()].map(({row,modifiers,hasSidecars})=>{
    if(!hasSidecars){
      if(row.command_family!=="effect"||row.command_type!=="apply_effect")throw new Error("effect has invalid originating command");
      let request:any,result:any;
      try{request=JSON.parse(row.canonical_request_json);result=JSON.parse(row.canonical_result_json);}catch{throw new Error("effect command provenance is malformed");}
      // Legacy commands carried a complete effect. Actor-scoped commands do
      // not, so their immutable canonical result is the validated fallback for
      // modifier kinds that the v26 numeric sidecar cannot represent.
      const original=request?.kind==="apply"
        ?(Array.isArray(result?.effects)?result.effects.filter((value:any)=>value?.effectId===row.effect_id):[])
        :[request?.effect];
      if(original.length!==1)throw new Error("effect command result binding is invalid");
      const validated=activeEffectSchema.parse(original[0]);
      if(validated.effectId!==row.effect_id||validated.campaignId!==campaignId||validated.actorId!==actorId)
        throw new Error("legacy effect command binding is invalid");
      modifiers=validated.modifiers;
    }
    const source=row.source_kind===null?null:{kind:row.source_kind,packId:row.source_pack_id,packVersion:row.source_pack_version,definitionId:row.source_definition_id};
    const duration=row.duration_kind==="rounds"?{kind:"rounds",remaining:row.remaining_rounds}
      :row.duration_kind==="until_timestamp"?{kind:"until_timestamp",expiresAt:row.expires_at}:{kind:"until_removed"};
    return activeEffectSchema.parse({effectId:row.effect_id,campaignId:row.campaign_id,actorId:row.actor_id,source,
      modifiers,duration,recovery:row.recovery_kind,concentration:row.concentration_key===null?{kind:"none"}:{kind:"required",concentrationId:row.concentration_key},appliedAt:row.applied_at});
  });
}

export function createEffectRepository(db:DatabaseDriver.Database,deps:M16Dependencies,guard:()=>void):EffectRepository {
  const list=(principal:string,campaignId:string,actorId:string):ActiveEffect[]=>{
    const p=resourceIdSchema.parse(principal),c=resourceIdSchema.parse(campaignId),a=resourceIdSchema.parse(actorId);
    return db.transaction(()=>m15Authorized(db,p,c,a)
      ?readActiveEffects(db,c,a,utcIsoTimestampSchema.parse(deps.clock.now().toISOString())):[]).deferred();
  };
  const snapshot=(principal:string,actorId:string):ActorEffectSnapshot|null=>{
    const p=resourceIdSchema.parse(principal),a=resourceIdSchema.parse(actorId);
    return db.transaction(()=>{
      const actor=db.prepare("SELECT campaign_id FROM campaign_actors WHERE id=?").get(a) as {campaign_id:string}|undefined;
      if(!actor||!m15Authorized(db,p,actor.campaign_id,a))return null;
      const now=utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
      const effects=readActiveEffects(db,actor.campaign_id,a,now);
      const revision=(db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?")
        .get(actor.campaign_id,a) as {revision:number}|undefined)?.revision??0;
      return {campaignId:actor.campaign_id,actorId:a,effects,revision};
    }).deferred();
  };
  const mutateActorEffect=(principal:string,actorId:string,input:ActorEffectCommandRequest):M16Result<{campaignId:string;actorId:string;effects:ActiveEffect[]}>=>{
    const p=resourceIdSchema.parse(principal),a=resourceIdSchema.parse(actorId),intent=actorEffectCommandRequestSchema.parse(input);
    // The path is actor-only. This lookup supplies an internal binding; the same
    // actor/campaign relation and authority are rechecked under the write lock.
    const actor=db.prepare("SELECT campaign_id FROM campaign_actors WHERE id=?").get(a) as {campaign_id:string}|undefined;
    if(!actor)throw new M16AuthorizationError("M1.6 mutation unavailable");
    const campaignId=actor.campaign_id;
    const type=intent.kind==="apply"?"apply_effect":intent.kind==="remove"?"remove_effect":"advance_effect_duration";
    return runM16Mutation(db,deps,guard,{principal:p,campaignId,actorId:a,family:"effect",type,
      expectedRevision:intent.expectedRevision,idempotencyKey:intent.idempotencyKey,request:intent,
      eventType:intent.kind==="apply"?"effect_applied":intent.kind==="remove"?"effect_removed":"effect_duration_advanced",
      authorize:()=>canonicalGmAuthorized(db,p,campaignId,a),build:(after,now,commandId)=>{
        const beforeEffects=readActiveEffects(db,campaignId,a,now);
        if(intent.kind==="apply"){
          if(!sourceIsCurrentPublicExecutionPin(db,campaignId,intent.effect.source))throw new EffectUnavailableError("effect source unavailable");
          if(intent.effect.duration.kind==="until_timestamp"&&intent.effect.duration.expiresAt<=now)throw new EffectUnavailableError("effect duration unavailable");
          if(intent.effect.modifiers.some(modifier=>beforeEffects.some(active=>active.modifiers.some(existing=>existing.kind==="immunity"&&existing.appliesToId===modifier.appliesToId))))
            throw new EffectImmuneError("effect is immune");
          const concentrationId=intent.effect.stacking.kind==="concentration"?intent.effect.stacking.concentrationId:null;
          // A timestamp-expired effect is absent from the public snapshot but
          // can still occupy the persisted concentration unique key.
          const replacedRow=concentrationId===null?undefined:db.prepare("SELECT effect_id FROM rpg_active_effects_v26 WHERE campaign_id=? AND actor_id=? AND concentration_key=? AND status='active'")
            .get(campaignId,a,concentrationId) as {effect_id:string}|undefined;
          const replacedVisible=replacedRow?beforeEffects.some(effect=>effect.effectId===replacedRow.effect_id):false;
          if(beforeEffects.length-(replacedVisible?1:0)>=128)throw new EffectUnavailableError("active effect capacity unavailable");
          const effectId=resourceIdSchema.parse(deps.ids.nextId());
          const effect=activeEffectSchema.parse({effectId,campaignId,actorId:a,source:intent.effect.source,
            modifiers:intent.effect.modifiers,duration:intent.effect.duration,recovery:intent.effect.recovery,
            concentration:concentrationId===null?{kind:"none"}:{kind:"required",concentrationId},appliedAt:now});
          const effects=stableEffects([...beforeEffects.filter(value=>value.effectId!==replacedRow?.effect_id),effect]);
          return {result:{campaignId,actorId:a,effects},persist:()=>{
            if(replacedRow){
              const lifecycleId=resourceIdSchema.parse(deps.ids.nextId());
              db.prepare("INSERT INTO rpg_effect_lifecycle_events_v26(lifecycle_event_id,effect_id,campaign_id,actor_id,command_id,resulting_revision,lifecycle_kind,remaining_rounds,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)")
                .run(lifecycleId,replacedRow.effect_id,campaignId,a,commandId,after,"concentration_replaced",null,now);
              db.prepare("UPDATE rpg_active_effects_v26 SET status='removed',state_revision=state_revision+1,last_lifecycle_event_id=?,updated_at=?,ended_at=? WHERE effect_id=?")
                .run(lifecycleId,now,now,replacedRow.effect_id);
            }
            const duration=effect.duration;
            db.prepare("INSERT INTO rpg_active_effects_v26(effect_id,campaign_id,actor_id,command_id,resulting_revision,source_pack_id,source_pack_version,source_kind,source_definition_id,status,concentration_key,duration_kind,remaining_rounds,expires_at,recovery_kind,applied_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?)")
              .run(effect.effectId,campaignId,a,commandId,after,effect.source?.packId??null,effect.source?.packVersion??null,effect.source?.kind??null,effect.source?.definitionId??null,
                concentrationId,duration.kind,duration.kind==="rounds"?duration.remaining:null,duration.kind==="until_timestamp"?duration.expiresAt:null,effect.recovery,now,now);
            if(effect.modifiers.every((modifier)=>modifier.kind==="flat"||modifier.kind==="proficiency")){
              const insertModifier=db.prepare("INSERT INTO rpg_effect_modifiers_v26(effect_id,modifier_ordinal,modifier_kind,applies_to_id,amount) VALUES(?,?,?,?,?)");
              effect.modifiers.forEach((modifier,index)=>insertModifier.run(effect.effectId,index,modifier.kind,modifier.appliesToId,
                modifier.kind==="flat"?modifier.amount:modifier.kind==="proficiency"?modifier.bonus:null));
            }
          }};
        }
        const target=beforeEffects.find(effect=>effect.effectId===intent.effectId);
        if(!target)throw new EffectUnavailableError("effect unavailable");
        const row=db.prepare("SELECT * FROM rpg_active_effects_v26 WHERE effect_id=? AND campaign_id=? AND actor_id=? AND status='active'").get(intent.effectId,campaignId,a) as any;
        if(!row)throw new EffectUnavailableError("effect unavailable");
        const advance=intent.kind==="advance-duration";
        const remaining=advance&&target.duration.kind==="rounds"?target.duration.remaining-intent.rounds:null;
        if(advance&&(target.duration.kind!=="rounds"||remaining===null||remaining<0))throw new EffectUnavailableError("effect duration unavailable");
        const effects=stableEffects(advance&&remaining!>0
          ?beforeEffects.map(effect=>effect.effectId===target.effectId?activeEffectSchema.parse({...effect,duration:{kind:"rounds",remaining}}):effect)
          :beforeEffects.filter(effect=>effect.effectId!==target.effectId));
        return {result:{campaignId,actorId:a,effects},persist:()=>{
          const lifecycleId=resourceIdSchema.parse(deps.ids.nextId());
          db.prepare("INSERT INTO rpg_effect_lifecycle_events_v26(lifecycle_event_id,effect_id,campaign_id,actor_id,command_id,resulting_revision,lifecycle_kind,remaining_rounds,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)")
            .run(lifecycleId,target.effectId,campaignId,a,commandId,after,advance?"duration_advanced":"removed",advance?remaining:null,now);
          if(advance)db.prepare("UPDATE rpg_active_effects_v26 SET remaining_rounds=?,state_revision=state_revision+1,last_lifecycle_event_id=?,updated_at=?,status=CASE WHEN ?=0 THEN 'expired' ELSE status END,ended_at=CASE WHEN ?=0 THEN ? ELSE ended_at END WHERE effect_id=?")
            .run(remaining,lifecycleId,now,remaining,remaining,now,target.effectId);
          else db.prepare("UPDATE rpg_active_effects_v26 SET status='removed',state_revision=state_revision+1,last_lifecycle_event_id=?,updated_at=?,ended_at=? WHERE effect_id=?")
            .run(lifecycleId,now,now,target.effectId);
        }};
      }});
  };
  return {listActiveEffects:list,getActorEffectSnapshot:snapshot,mutateActorEffect,mutateEffect(p,input){const command=effectCommandSchema.parse(input);return runM16Mutation(db,deps,guard,{principal:p,campaignId:command.campaignId,actorId:command.actorId,family:'effect',type:command.type,expectedRevision:command.expectedRevision,idempotencyKey:command.idempotencyKey,request:command,eventType:command.type==='apply_effect'?'effect_applied':command.type==='remove_effect'?'effect_removed':'effect_duration_advanced',build:(after,now,id)=>{const beforeEffects=list(p,command.campaignId,command.actorId);let persist=()=>{};
    if(command.type==='apply_effect'){const e=command.effect;const immunity=e.modifiers.some(m=>list(p,command.campaignId,command.actorId).some(active=>active.modifiers.some(modifier=>modifier.kind==='immunity'&&modifier.appliesToId===m.appliesToId)));if(immunity)throw new EffectImmuneError("effect is immune");const replaced=e.concentration.kind==='required'?(db.prepare("SELECT * FROM rpg_active_effects_v26 WHERE campaign_id=? AND actor_id=? AND concentration_key=? AND status='active'").get(command.campaignId,command.actorId,e.concentration.concentrationId)as any):undefined;
      persist=()=>{if(replaced){const life=resourceIdSchema.parse(deps.ids.nextId());db.prepare("INSERT INTO rpg_effect_lifecycle_events_v26(lifecycle_event_id,effect_id,campaign_id,actor_id,command_id,resulting_revision,lifecycle_kind,remaining_rounds,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)").run(life,replaced.effect_id,command.campaignId,command.actorId,id,after,'concentration_replaced',null,now);db.prepare("UPDATE rpg_active_effects_v26 SET status='removed',state_revision=state_revision+1,last_lifecycle_event_id=?,updated_at=?,ended_at=? WHERE effect_id=?").run(life,now,now,replaced.effect_id);}const d=e.duration;db.prepare("INSERT INTO rpg_active_effects_v26(effect_id,campaign_id,actor_id,command_id,resulting_revision,source_pack_id,source_pack_version,source_kind,source_definition_id,status,concentration_key,duration_kind,remaining_rounds,expires_at,recovery_kind,applied_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?)").run(e.effectId,command.campaignId,command.actorId,id,after,e.source?.packId??null,e.source?.packVersion??null,e.source?.kind??null,e.source?.definitionId??null,e.concentration.kind==='required'?e.concentration.concentrationId:null,d.kind,d.kind==='rounds'?d.remaining:null,d.kind==='until_timestamp'?d.expiresAt:null,e.recovery,e.appliedAt,now);};
    }else {const row=db.prepare("SELECT * FROM rpg_active_effects_v26 WHERE effect_id=? AND campaign_id=? AND actor_id=? AND status='active'").get(command.effectId,command.campaignId,command.actorId)as any;if(!row)throw new EffectUnavailableError("effect unavailable");persist=()=>{const life=resourceIdSchema.parse(deps.ids.nextId());const advance=command.type==='advance_effect_duration';const remaining=advance?row.remaining_rounds-command.rounds:row.remaining_rounds;if(advance&&(row.duration_kind!=='rounds'||remaining<0))throw new EffectUnavailableError("duration unavailable");db.prepare("INSERT INTO rpg_effect_lifecycle_events_v26(lifecycle_event_id,effect_id,campaign_id,actor_id,command_id,resulting_revision,lifecycle_kind,remaining_rounds,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)").run(life,row.effect_id,command.campaignId,command.actorId,id,after,advance?'duration_advanced':'removed',advance?remaining:null,now);db.prepare(advance?"UPDATE rpg_active_effects_v26 SET remaining_rounds=?,state_revision=state_revision+1,last_lifecycle_event_id=?,updated_at=?,status=CASE WHEN ?=0 THEN 'expired' ELSE status END,ended_at=CASE WHEN ?=0 THEN ? ELSE ended_at END WHERE effect_id=?":"UPDATE rpg_active_effects_v26 SET status='removed',state_revision=state_revision+1,last_lifecycle_event_id=?,updated_at=?,ended_at=? WHERE effect_id=?").run(...(advance?[remaining,life,now,remaining,remaining,now,row.effect_id]:[life,now,now,row.effect_id]));};}
    const resultEffects=command.type==='apply_effect'?[...beforeEffects.filter(effect=>command.effect.concentration.kind!=='required'||effect.concentration.kind!=='required'||effect.concentration.concentrationId!==command.effect.concentration.concentrationId),command.effect]:command.type==='remove_effect'?beforeEffects.filter(effect=>effect.effectId!==command.effectId):beforeEffects.map(effect=>effect.effectId!==command.effectId?effect:{...effect,duration:{kind:'rounds' as const,remaining:(effect.duration.kind==='rounds'?effect.duration.remaining:0)-command.rounds}}).filter(effect=>effect.duration.kind!=='rounds'||effect.duration.remaining>0);
    return {result:{effects:resultEffects},persist};}});}};
}
