import type DatabaseDriver from "better-sqlite3";
import { starterEffectV2Schema, type StarterEffectV2, type StarterOngoingEffect } from "@velvet/contracts";
import { EncounterConflictError } from "../encounterErrors.js";
import { canonical, nextId, revision, sha } from "./util.js";
import type { EffectApplier, EffectContext } from "./types.js";

/** The repeated-save rider persisted alongside an ongoing entry. */
export type OngoingRepeatSave = NonNullable<StarterOngoingEffect["repeatSave"]>;

export interface OngoingEffectRecord {
  effectId: string;
  effect: StarterEffectV2;
  durationRounds: number;
  remainingRounds: number;
  timing: StarterOngoingEffect["timing"];
  repeatSave: OngoingRepeatSave | null;
  status: "active" | "removed" | "expired";
}

function requireActor(ctx:EffectContext):string{
  const actorId=ctx.target.actor_id;
  if(!actorId)throw new EncounterConflictError("ongoing effects require an actor-backed target");
  return actorId;
}

/** Persists an immutable ongoing entry and a sidecar modifier marker so the
 * existing active-effect projection can still read the row safely. */
function persistOngoingRecord(ctx:EffectContext,ongoingId:string,effect:StarterOngoingEffect):void{
  const {db,deps,action,at}=ctx,actorId=requireActor(ctx);
  const targetRevisionNow=revision(db,"m16",action.campaignId,actorId),targetAfter=targetRevisionNow+1,commandId=nextId(deps);
  if(targetRevisionNow===0&&!db.prepare("SELECT 1 FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(action.campaignId,actorId))db.prepare("INSERT INTO rpg_m16_mutation_revisions_v26 VALUES(?,?,0,?)").run(action.campaignId,actorId,at);
  const request=canonical({kind:"ongoing-effect",ongoingId,ongoing:{effect:effect.effect,durationRounds:effect.durationRounds,timing:effect.timing,...(effect.repeatSave?{repeatSave:effect.repeatSave}:{})}}),result=canonical({kind:"ongoing-effect",ongoingId,applied:true});
  db.prepare("INSERT INTO rpg_m16_commands_v26 VALUES(?,?,?,'effect','apply_effect',?,?,?,?,?,?)").run(action.campaignId,actorId,commandId,commandId,request,sha(request),targetRevisionNow,targetAfter,at);
  db.prepare("INSERT INTO rpg_m16_receipts_v26 VALUES(?,?,?,?,?,?,?)").run(action.campaignId,actorId,commandId,targetAfter,result,sha(result),at);
  db.prepare("INSERT INTO rpg_m16_events_v26 VALUES(?,?,?,?,?,?,?,?)").run(nextId(deps),action.campaignId,actorId,commandId,targetAfter,"effect_applied",result,at);
  db.prepare(`INSERT INTO rpg_active_effects_v26(effect_id,campaign_id,actor_id,command_id,resulting_revision,source_pack_id,source_pack_version,source_kind,source_definition_id,status,concentration_key,duration_kind,remaining_rounds,expires_at,recovery_kind,applied_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?)`).run(ongoingId,action.campaignId,actorId,commandId,targetAfter,action.powerRef.packId,action.powerRef.packVersion,action.powerRef.kind,action.powerRef.definitionId,null,"rounds",effect.durationRounds,null,"none",at,at);
  db.prepare("INSERT INTO rpg_effect_modifiers_v26 VALUES(?,?,?,?,?)").run(ongoingId,0,"flat","ongoing-effect",0);
  db.prepare("UPDATE rpg_m16_mutation_revisions_v26 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=? AND revision=?").run(targetAfter,at,action.campaignId,actorId,targetRevisionNow);
}

/** Creates the ongoing entry, applies its inner effect now, and reports the
 * persisted identity so callers can tick it deterministically later. */
export function handleOngoingEffect(ctx:EffectContext,effect:StarterOngoingEffect,powerUseId:string,apply:EffectApplier):void{
  const ongoingId=nextId(ctx.deps);
  persistOngoingRecord(ctx,ongoingId,effect);
  const marker:any={kind:"ongoing-effect",ongoingId,timing:effect.timing,durationRounds:effect.durationRounds,remainingRounds:effect.durationRounds,repeatSave:effect.repeatSave??null,appliedNow:true,outcomes:[]};
  ctx.outcomes.push(marker);
  const start=ctx.outcomes.length;
  apply(ctx,effect.effect,powerUseId,[ctx.target]);
  marker.outcomes=ctx.outcomes.slice(start);
}

/** Reads one persisted ongoing entry from its originating command payload. */
export function readOngoingEffect(db:DatabaseDriver.Database,campaignId:string,actorId:string,effectId:string):OngoingEffectRecord|null{
  const row=db.prepare(`SELECT effect.status,effect.remaining_rounds,command.canonical_request_json FROM rpg_active_effects_v26 effect
    JOIN rpg_m16_commands_v26 command ON command.campaign_id=effect.campaign_id AND command.actor_id=effect.actor_id AND command.command_id=effect.command_id
    WHERE effect.effect_id=? AND effect.campaign_id=? AND effect.actor_id=? ORDER BY command.resulting_revision DESC LIMIT 1`)
    .get(effectId,campaignId,actorId)as {status:"active"|"removed"|"expired";remaining_rounds:number|null;canonical_request_json:string}|undefined;
  if(!row)return null;
  let request:any;try{request=JSON.parse(row.canonical_request_json);}catch{return null;}
  const ongoing=request?.ongoing;if(!ongoing)return null;
  const parsed=starterEffectV2Schema.safeParse(ongoing.effect);if(!parsed.success)return null;
  return {effectId,effect:parsed.data,durationRounds:ongoing.durationRounds,remainingRounds:row.remaining_rounds??ongoing.durationRounds,timing:ongoing.timing,repeatSave:ongoing.repeatSave??null,status:row.status};
}

/** Advances or ends one ongoing entry with a fully-provenanced effect command. */
export function persistOngoingTick(ctx:EffectContext,effectId:string,remainingAfter:number,ended:boolean):void{
  const {db,deps,action,at}=ctx,actorId=requireActor(ctx);
  const targetRevisionNow=revision(db,"m16",action.campaignId,actorId),targetAfter=targetRevisionNow+1,commandId=nextId(deps),lifecycleId=nextId(deps);
  if(targetRevisionNow===0&&!db.prepare("SELECT 1 FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(action.campaignId,actorId))db.prepare("INSERT INTO rpg_m16_mutation_revisions_v26 VALUES(?,?,0,?)").run(action.campaignId,actorId,at);
  const request=canonical(ended?{kind:"remove",effectId,remaining:remainingAfter}:{kind:"advance",effectId,rounds:1,remaining:remainingAfter}),result=canonical({kind:ended?"ongoing-effect-ended":"ongoing-effect-ticked",effectId,remainingAfter});
  db.prepare("INSERT INTO rpg_m16_commands_v26 VALUES(?,?,?,'effect',?,?,?,?,?,?,?)").run(action.campaignId,actorId,commandId,ended?"remove_effect":"advance_effect_duration",commandId,request,sha(request),targetRevisionNow,targetAfter,at);
  db.prepare("INSERT INTO rpg_m16_receipts_v26 VALUES(?,?,?,?,?,?,?)").run(action.campaignId,actorId,commandId,targetAfter,result,sha(result),at);
  db.prepare("INSERT INTO rpg_m16_events_v26 VALUES(?,?,?,?,?,?,?,?)").run(nextId(deps),action.campaignId,actorId,commandId,targetAfter,ended?"effect_removed":"effect_duration_advanced",result,at);
  db.prepare("INSERT INTO rpg_effect_lifecycle_events_v26(lifecycle_event_id,effect_id,campaign_id,actor_id,command_id,resulting_revision,lifecycle_kind,remaining_rounds,occurred_at) VALUES(?,?,?,?,?,?,?,?,?)").run(lifecycleId,effectId,action.campaignId,actorId,commandId,targetAfter,ended?"removed":"duration_advanced",ended?null:remainingAfter,at);
  if(ended)db.prepare("UPDATE rpg_active_effects_v26 SET status='removed',state_revision=state_revision+1,last_lifecycle_event_id=?,updated_at=?,ended_at=? WHERE effect_id=?").run(lifecycleId,at,at,effectId);
  else db.prepare("UPDATE rpg_active_effects_v26 SET remaining_rounds=?,state_revision=state_revision+1,last_lifecycle_event_id=?,updated_at=? WHERE effect_id=?").run(remainingAfter,lifecycleId,at,effectId);
  db.prepare("UPDATE rpg_m16_mutation_revisions_v26 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=? AND revision=?").run(targetAfter,at,action.campaignId,actorId,targetRevisionNow);
}
