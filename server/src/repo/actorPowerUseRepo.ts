import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  abilityCatalogDefinitionSchema, actorPowerActorStateSchema, actorPowerCommandRequestSchema,
  actorPowerCommandResponseSchema, actorPowerResolutionSchema, resourceIdSchema,
  spellCatalogDefinitionSchema, utcIsoTimestampSchema, type ActorPowerActorState,
  type ActorPowerCommandRequest, type ActorPowerResolution,
} from "@velvet/contracts";
import { evaluateDiceExpression } from "../dice.js";
import type { M16Dependencies, M16Result } from "./effectRepo.js";
import { M16AuthorizationError, M16ConflictError, M16StaleError } from "./effectRepo.js";
import { m15Authorized } from "./actorResourceRepo.js";

export class ActorPowerNotFoundError extends Error { readonly code="ACTOR_POWER_NOT_FOUND"; }
export class ActorPowerConflictError extends Error { readonly code="ACTOR_POWER_CONFLICT"; }
export class ActorPowerInsufficientError extends Error { readonly code="ACTOR_POWER_INSUFFICIENT"; }

const canonical=(value:unknown)=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");
const refKey=(value:{kind:string;packId:string;packVersion:string;definitionId:string})=>`${value.kind}\0${value.packId}\0${value.packVersion}\0${value.definitionId}`;

type Resource={resourceId:string;current:number;capacity:number};
type NewEffect={effectId:string;actorId:string;modifiers:Array<{kind:"flat";appliesToId:string;amount:number}>;duration:{kind:"rounds";remaining:number}|{kind:"until_removed"};concentration:boolean};

function publicEffects(db:DatabaseDriver.Database,campaignId:string,actorId:string,powerRef:any,newEffect:NewEffect|undefined,replaced:string|undefined,now:string){
  const rows=db.prepare(`SELECT effect.effect_id,effect.source_pack_id,effect.source_pack_version,effect.source_kind,effect.source_definition_id,
    effect.duration_kind,effect.remaining_rounds,effect.expires_at,effect.concentration_key,modifier.modifier_kind,modifier.applies_to_id,modifier.amount,
    command.canonical_request_json
    FROM rpg_active_effects_v26 effect JOIN rpg_m16_commands_v26 command
      ON command.campaign_id=effect.campaign_id AND command.actor_id=effect.actor_id AND command.command_id=effect.command_id
    LEFT JOIN rpg_effect_modifiers_v26 modifier USING(effect_id)
    WHERE effect.campaign_id=? AND effect.actor_id=? AND effect.status='active'
      AND (effect.duration_kind<>'rounds' OR effect.remaining_rounds>0)
      AND (effect.duration_kind<>'until_timestamp' OR effect.expires_at>?)
    ORDER BY effect.applied_at,effect.effect_id,modifier.modifier_ordinal`).all(campaignId,actorId,now) as any[];
  const grouped=new Map<string,any>();
  for(const row of rows){if(row.effect_id===replaced||row.source_kind===null)continue;let effect=grouped.get(row.effect_id);if(!effect){let fallback:any[]=[];try{fallback=JSON.parse(row.canonical_request_json).effect?.modifiers??[];}catch{fallback=[];}effect={effectId:row.effect_id,source:{kind:row.source_kind,packId:row.source_pack_id,packVersion:row.source_pack_version,definitionId:row.source_definition_id},modifiers:fallback,duration:row.duration_kind==="rounds"?{kind:"rounds",remaining:row.remaining_rounds}:row.duration_kind==="until_timestamp"?{kind:"until_timestamp",expiresAt:row.expires_at}:{kind:"until_removed"},concentration:row.concentration_key!==null,hasSidecar:false};grouped.set(row.effect_id,effect);}if(row.modifier_kind!==null){if(!effect.hasSidecar){effect.modifiers=[];effect.hasSidecar=true;}effect.modifiers.push(row.modifier_kind==="flat"?{kind:"flat",appliesToId:row.applies_to_id,amount:row.amount}:row.modifier_kind==="proficiency"?{kind:"proficiency",appliesToId:row.applies_to_id,bonus:row.amount}:{kind:row.modifier_kind,appliesToId:row.applies_to_id});}}
  if(newEffect)grouped.set(newEffect.effectId,{effectId:newEffect.effectId,source:powerRef,modifiers:newEffect.modifiers,duration:newEffect.duration,concentration:newEffect.concentration});
  return [...grouped.values()].map(({hasSidecar:_hasSidecar,...effect})=>effect).filter(effect=>effect.modifiers.length>0);
}

/** Actor-only power execution. All validation and resolution share one IMMEDIATE transaction. */
export function useActorPower(db:DatabaseDriver.Database,deps:M16Dependencies,guard:()=>void,principal:string,actorIdInput:string,input:ActorPowerCommandRequest):M16Result<{resolution:ActorPowerResolution;actorStates:ActorPowerActorState[]}>{
  guard();const actorId=resourceIdSchema.parse(actorIdInput),intent=actorPowerCommandRequestSchema.parse(input),request=canonical(intent);
  const actor=db.prepare("SELECT campaign_id FROM campaign_actors WHERE id=?").get(actorId) as {campaign_id:string}|undefined;
  if(!actor)throw new ActorPowerNotFoundError("actor power state unavailable");
  const campaignId=actor.campaign_id;
  return db.transaction(()=>{
    if(!m15Authorized(db,principal,campaignId,actorId))throw new M16AuthorizationError("actor power state unavailable");
    const prior=db.prepare("SELECT command_type,canonical_request_json,receipt.canonical_result_json FROM rpg_m16_commands_v26 command JOIN rpg_m16_receipts_v26 receipt USING(campaign_id,actor_id,command_id) WHERE command.campaign_id=? AND command.actor_id=? AND command.idempotency_key=?").get(campaignId,actorId,intent.idempotencyKey) as any;
    if(prior){if(prior.command_type!=="use_power"||prior.canonical_request_json!==request)throw new M16ConflictError("idempotency key reused");return JSON.parse(prior.canonical_result_json);}
    const sourceRoot=db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(campaignId,actorId) as {revision:number}|undefined;
    const before=sourceRoot?.revision??0;if(before!==intent.expectedRevision)throw new M16StaleError("actor power revision stale");

    const definitionRow=db.prepare(`SELECT visibility.public_definition_json FROM campaign_actors actor
      JOIN character_known_powers_v23 known ON known.campaign_character_id=actor.campaign_character_id AND known.kind=? AND known.pack_id=? AND known.pack_version=? AND known.definition_id=?
      JOIN campaign_catalog_current_pins pin ON pin.campaign_id=actor.campaign_id AND pin.pack_id=known.pack_id AND pin.pack_version=known.pack_version
      JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=known.pack_id AND visibility.pack_version=known.pack_version AND visibility.kind=known.kind AND visibility.definition_id=known.definition_id AND visibility.publicly_reachable=1
      JOIN rpg_campaign_catalog_definitions_v25 execution ON execution.campaign_id=actor.campaign_id AND execution.pack_id=known.pack_id AND execution.pack_version=known.pack_version AND execution.kind=known.kind AND execution.definition_id=known.definition_id
      WHERE actor.campaign_id=? AND actor.id=?`).get(intent.powerRef.kind,intent.powerRef.packId,intent.powerRef.packVersion,intent.powerRef.definitionId,campaignId,actorId) as {public_definition_json:string}|undefined;
    if(!definitionRow)throw new ActorPowerConflictError("power is not currently known and executable");
    const definition:any=intent.powerRef.kind==="ability"?abilityCatalogDefinitionSchema.parse(JSON.parse(definitionRow.public_definition_json)):spellCatalogDefinitionSchema.parse(JSON.parse(definitionRow.public_definition_json));
    if(refKey(definition.reference)!==refKey(intent.powerRef))throw new ActorPowerConflictError("power identity mismatch");

    const targetKind:string=definition.mechanics.target;
    const targetIds=targetKind==="self"?[actorId]:[...intent.targetIds];
    if((targetKind==="self"&&intent.targetIds.length!==0)||(targetKind==="area"&&targetIds.length===0)
      ||(!["self","area"].includes(targetKind)&&(targetIds.length!==1||targetIds[0]===actorId)))throw new ActorPowerConflictError("illegal power target selection");
    for(const targetId of targetIds){if((targetKind!=="self"&&targetId===actorId)||!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(campaignId,targetId))throw new ActorPowerConflictError("power target unavailable");}
    const persistentCount=definition.mechanics.effects.filter((effect:any)=>effect.type==="condition"||(effect.type==="modifier"&&effect.duration!=="instant")).length;
    if(persistentCount>1)throw new ActorPowerConflictError("catalog effect set cannot be represented atomically");

    const costs:any[]=[];
    if(intent.powerRef.kind==="ability"&&definition.mechanics.uses>0){
      let recoveredAt:string|null=null;const recovery=definition.mechanics.recovery;
      if(recovery==="short-rest"||recovery==="long-rest"){const kinds=recovery==="short-rest"?["short","long"]:["long"];recoveredAt=(db.prepare(`SELECT max(occurred_at) occurred_at FROM rpg_rest_receipts_v25 WHERE campaign_id=? AND actor_id=? AND rest_kind IN (${kinds.map(()=>"?").join(",")})`).get(campaignId,actorId,...kinds) as any).occurred_at;}
      else if(recovery==="encounter")recoveredAt=(db.prepare("SELECT max(encounter.updated_at) occurred_at FROM encounter JOIN combatant ON combatant.encounter_id=encounter.encounter_id AND combatant.campaign_id=encounter.campaign_id WHERE encounter.campaign_id=? AND combatant.actor_id=? AND encounter.status='completed'").get(campaignId,actorId) as any).occurred_at;
      const used=(db.prepare(`SELECT count(*) count FROM rpg_power_uses_v26 power JOIN rpg_m16_receipts_v26 receipt ON receipt.campaign_id=power.campaign_id AND receipt.actor_id=power.actor_id AND receipt.command_id=power.command_id WHERE power.campaign_id=? AND power.actor_id=? AND power.power_kind=? AND power.power_pack_id=? AND power.power_pack_version=? AND power.power_definition_id=? AND (? IS NULL OR receipt.occurred_at>?)`).get(campaignId,actorId,intent.powerRef.kind,intent.powerRef.packId,intent.powerRef.packVersion,intent.powerRef.definitionId,recoveredAt,recoveredAt) as any).count;
      if(used>=definition.mechanics.uses)throw new ActorPowerInsufficientError("finite uses exhausted");costs.push({kind:"ability-use",amount:1});
    }
    if(intent.powerRef.kind==="spell"&&definition.mechanics.level>0){const slotId=`slot-${definition.mechanics.level}`,slot=db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name=?").get(campaignId,actorId,slotId) as any;if(!slot||slot.current<1)throw new ActorPowerInsufficientError("spell slot unavailable");costs.push({kind:"slot",slotId,amount:1});}

    const states=new Map<string,Resource[]>();const load=(id:string)=>{let value=states.get(id);if(!value){value=(db.prepare("SELECT name resourceId,current,max capacity FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? ORDER BY name").all(campaignId,id) as Resource[]).map(row=>({...row}));states.set(id,value);}return value;};
    // Validate every required resource before consuming RNG or allocating IDs.
    for(const id of targetIds)for(const effect of definition.mechanics.effects){const resourceId=effect.type==="damage"||effect.type==="healing"?"health":effect.type==="resource"?(effect.resource==="spell-slot"&&intent.powerRef.kind==="spell"&&definition.mechanics.level>0?`slot-${definition.mechanics.level}`:effect.resource):null;if(resourceId&&(!load(id).some(row=>row.resourceId===resourceId)||resourceId==="spell-slot"))throw new ActorPowerConflictError("effect resource unavailable");}
    const now=utcIsoTimestampSchema.parse(deps.clock.now().toISOString()),commandId=resourceIdSchema.parse(deps.ids.nextId()),powerUseId=resourceIdSchema.parse(deps.ids.nextId());
    const outcomes:any[]=[],deltas:any[]=[],newEffects=new Map<string,NewEffect>(),replacements=new Map<string,string>();
    const change=(id:string,name:string,amount:number)=>{const row=load(id).find(item=>item.resourceId===name)!;const prior=row.current;row.current=Math.max(0,Math.min(row.capacity,prior+amount));if(prior!==row.current)deltas.push({kind:"resource",actorId:id,resourceId:name,before:prior,after:row.current});return row.current-prior;};
    for(const cost of costs)if(cost.kind==="slot")change(actorId,cost.slotId,-1);
    for(const id of targetIds)for(const effect of definition.mechanics.effects){
      if(effect.type==="damage"||effect.type==="healing"){const modifier=effect.dice.modifier,roll=evaluateDiceExpression(`${effect.dice.count}d${effect.dice.sides}${modifier===0?"":modifier>0?`+${modifier}`:modifier}`,deps.rng),amount=Math.max(0,roll.total);if(effect.type==="damage"){const modifiers=publicEffects(db,campaignId,id,intent.powerRef,newEffects.get(id),replacements.get(id),now).flatMap(active=>active.modifiers).filter(active=>active.appliesToId===effect.damageType||active.appliesToId==="all"),immune=modifiers.some(active=>active.kind==="immunity"),resistant=modifiers.some(active=>active.kind==="resistance"),vulnerable=modifiers.some(active=>active.kind==="vulnerability"),adjustment=immune?"immunity":resistant&&!vulnerable?"resistance":vulnerable&&!resistant?"vulnerability":"none",adjusted=immune?0:resistant&&!vulnerable?Math.floor(amount/2):vulnerable&&!resistant?amount*2:amount,applied=Math.abs(change(id,"health",-adjusted));outcomes.push({kind:"damage",targetId:id,damageType:effect.damageType,roll,adjustment,applied});}else{const applied=Math.abs(change(id,"health",amount));outcomes.push({kind:"healing",targetId:id,roll,applied});}}
      else if(effect.type==="resource"){const name=effect.resource==="spell-slot"?`slot-${definition.mechanics.level}`:effect.resource,applied=change(id,name,effect.amount);outcomes.push({kind:"resource",targetId:id,resourceId:name,requested:effect.amount,applied});}
      else if(effect.type==="modifier"&&effect.duration==="instant")outcomes.push({kind:"modifier",targetId:id,effectId:null,statistic:effect.statistic,amount:effect.amount,duration:effect.duration});
      else {const effectId=resourceIdSchema.parse(deps.ids.nextId()),condition=effect.type==="condition",duration=condition?{kind:"rounds" as const,remaining:effect.durationRounds}:effect.duration==="turn"||effect.duration==="round"?{kind:"rounds" as const,remaining:1}:{kind:"until_removed" as const},modifier={kind:"flat" as const,appliesToId:condition?`condition:${effect.condition}`:effect.statistic,amount:condition?1:effect.amount},concentration=definition.mechanics.concentration===true;const active={effectId,actorId:id,modifiers:[modifier],duration,concentration};newEffects.set(id,active);if(concentration){const prior=db.prepare("SELECT effect_id FROM rpg_active_effects_v26 WHERE campaign_id=? AND actor_id=? AND concentration_key='power-concentration' AND status='active' AND (duration_kind<>'rounds' OR remaining_rounds>0) AND (duration_kind<>'until_timestamp' OR expires_at>?)").get(campaignId,id,now) as any;if(prior){replacements.set(id,prior.effect_id);deltas.push({kind:"effect-replaced",actorId:id,effectId:prior.effect_id});}}deltas.push({kind:"effect-applied",actorId:id,effectId});outcomes.push(condition?{kind:"condition",targetId:id,effectId,condition:effect.condition,durationRounds:effect.durationRounds}:{kind:"modifier",targetId:id,effectId,statistic:effect.statistic,amount:effect.amount,duration:effect.duration});}
    }
    const changed=[actorId,...targetIds.filter(id=>id!==actorId)],targetCommands=new Map<string,{id:string;before:number;after:number}>();
    for(const id of changed.slice(1)){const revision=(db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(campaignId,id) as any)?.revision??0;targetCommands.set(id,{id:resourceIdSchema.parse(deps.ids.nextId()),before:revision,after:revision+1});}
    const resolution=actorPowerResolutionSchema.parse({powerUseId,powerRef:intent.powerRef,targetIds,costs,outcomes,stateDeltas:deltas});
    const actorStates=changed.map(id=>actorPowerActorStateSchema.parse({actorId:id,resources:load(id),activeEffects:publicEffects(db,campaignId,id,intent.powerRef,newEffects.get(id),replacements.get(id),now),revision:id===actorId?before+1:targetCommands.get(id)!.after}));
    const receipt={commandId,idempotencyKey:intent.idempotencyKey,revisionBefore:before,revisionAfter:before+1,occurredAt:now};
    actorPowerCommandResponseSchema.parse({resolution,actorStates,receipt:{idempotencyKey:receipt.idempotencyKey,revisionBefore:before,revisionAfter:before+1,occurredAt:now}});
    const result={resolution,actorStates,receipt};
    if(canonical(result).length>32_768)throw new ActorPowerConflictError("resolved public state exceeds the bounded receipt");

    const insertCommand=(id:string,cmd:string,prior:number,type:"use_power"|"apply_effect",key:string,req:object,res:object)=>{if(prior===0&&!db.prepare("SELECT 1 FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(campaignId,id))db.prepare("INSERT INTO rpg_m16_mutation_revisions_v26 VALUES(?,?,0,?)").run(campaignId,id,now);db.prepare("INSERT INTO rpg_m16_commands_v26 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(campaignId,id,cmd,type==="apply_effect"?"effect":"power",type,key,canonical(req),digest(req),prior,prior+1,now);db.prepare("INSERT INTO rpg_m16_receipts_v26 VALUES(?,?,?,?,?,?,?)").run(campaignId,id,cmd,prior+1,canonical(res),digest(res),now);};
    insertCommand(actorId,commandId,before,"use_power",intent.idempotencyKey,intent,result);
    for(const [id,cmd] of targetCommands){const effect=newEffects.get(id),linked={linkedPowerUseId:powerUseId};insertCommand(id,cmd.id,cmd.before,effect?"apply_effect":"use_power",cmd.id,effect?{type:"apply_effect",effect:{...effect,source:intent.powerRef,concentration:effect.concentration?{kind:"required",concentrationId:"power-concentration"}:{kind:"none"},recovery:"none",campaignId,appliedAt:now}}:linked,linked);}
    for(const delta of deltas)if(delta.kind==="resource")db.prepare("UPDATE rpg_actor_resources SET current=? WHERE campaign_id=? AND actor_id=? AND name=?").run(delta.after,campaignId,delta.actorId,delta.resourceId);
    const persistEffect=(id:string,effect:NewEffect,cmd:string,revision:number)=>{const old=replacements.get(id);if(old){const life=resourceIdSchema.parse(deps.ids.nextId());db.prepare("INSERT INTO rpg_effect_lifecycle_events_v26(lifecycle_event_id,effect_id,campaign_id,actor_id,command_id,resulting_revision,lifecycle_kind,remaining_rounds,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)").run(life,old,campaignId,id,cmd,revision,"concentration_replaced",null,now);db.prepare("UPDATE rpg_active_effects_v26 SET status='removed',state_revision=state_revision+1,last_lifecycle_event_id=?,updated_at=?,ended_at=? WHERE effect_id=?").run(life,now,now,old);}db.prepare("INSERT INTO rpg_active_effects_v26(effect_id,campaign_id,actor_id,command_id,resulting_revision,source_pack_id,source_pack_version,source_kind,source_definition_id,status,concentration_key,duration_kind,remaining_rounds,expires_at,recovery_kind,applied_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?)").run(effect.effectId,campaignId,id,cmd,revision,intent.powerRef.packId,intent.powerRef.packVersion,intent.powerRef.kind,intent.powerRef.definitionId,effect.concentration?"power-concentration":null,effect.duration.kind,effect.duration.kind==="rounds"?effect.duration.remaining:null,null,"none",now,now);effect.modifiers.forEach((modifier,index)=>db.prepare("INSERT INTO rpg_effect_modifiers_v26 VALUES(?,?,?,?,?)").run(effect.effectId,index,modifier.kind,modifier.appliesToId,modifier.amount));};
    for(const [id,effect] of newEffects){const cmd=id===actorId?{id:commandId,after:before+1}:targetCommands.get(id)!;persistEffect(id,effect,cmd.id,cmd.after);}
    // v26's nullable slot_level CHECK accidentally rejects SQL NULL. Preserve
    // its established sentinel while the public resolution remains truthful.
    db.prepare("INSERT INTO rpg_power_uses_v26(power_use_id,campaign_id,actor_id,command_id,resulting_revision,power_pack_id,power_pack_version,power_kind,power_definition_id,slot_kind,slot_level,target_actor_id,use_json,used_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(powerUseId,campaignId,actorId,commandId,before+1,intent.powerRef.packId,intent.powerRef.packVersion,intent.powerRef.kind,intent.powerRef.definitionId,"slot",intent.powerRef.kind==="spell"&&definition.mechanics.level>0?definition.mechanics.level:1,targetIds.length===1?targetIds[0]:null,request,now);
    costs.filter(cost=>cost.kind==="slot").forEach((cost:any,index)=>db.prepare("INSERT INTO rpg_power_use_costs_v26 VALUES(?,?,?,?,?)").run(powerUseId,index,"slot",cost.slotId,1));
    db.prepare("INSERT INTO rpg_m16_events_v26 VALUES(?,?,?,?,?,?,?,?)").run(resourceIdSchema.parse(deps.ids.nextId()),campaignId,actorId,commandId,before+1,"power_used",canonical(result),now);
    for(const [id,cmd] of targetCommands){const linked={linkedPowerUseId:powerUseId};db.prepare("INSERT INTO rpg_m16_events_v26 VALUES(?,?,?,?,?,?,?,?)").run(resourceIdSchema.parse(deps.ids.nextId()),campaignId,id,cmd.id,cmd.after,newEffects.has(id)?"effect_applied":"power_used",canonical(linked),now);db.prepare("UPDATE rpg_m16_mutation_revisions_v26 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=?").run(cmd.after,now,campaignId,id);}
    db.prepare("UPDATE rpg_m16_mutation_revisions_v26 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=?").run(before+1,now,campaignId,actorId);
    return result;
  }).immediate();
}
