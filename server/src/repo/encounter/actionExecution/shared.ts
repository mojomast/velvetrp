import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema, utcIsoTimestampSchema, type CombatRewardGrantPublic, type LegalCombatActionAllowlist } from "@velvet/contracts";
import type { Clock, IdGenerator, RandomNumberGenerator } from "../../../runtime.js";
import type { EncounterReadRepository } from "../encounterReadRepo.js";
import { EncounterAuthorizationError, EncounterConflictError } from "../encounterErrors.js";
import { resolveCampaignRuleset } from "../../../rulesets/campaignBinding.js";

export type EncounterDependencies={clock:Clock;ids:IdGenerator;rng:RandomNumberGenerator};
export type EncounterReceipt={commandId:string;idempotencyKey:string;revisionBefore:number;revisionAfter:number;occurredAt:string};
export type EncounterResult<T extends object>=T&{receipt:EncounterReceipt};
export type EncounterRewardGrantSnapshot=CombatRewardGrantPublic&{campaignId:string;encounterId:string};

/** Dependencies required by transactional encounter commands. */
export interface EncounterWriteDependencies extends EncounterDependencies {
  reads: Pick<EncounterReadRepository, "getLegalCombatActionAllowlist" | "getCombatState" | "listEncounters">;
  assertFactoryMutation(): void;
}

export const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==="object"&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
export const digest=(v:unknown)=>createHash("sha256").update(canonical(v)).digest("hex");
export const id=(d:EncounterDependencies)=>resourceIdSchema.parse(d.ids.nextId());
export const now=(d:EncounterDependencies)=>utcIsoTimestampSchema.parse(d.clock.now().toISOString());
export const member=(db:DatabaseDriver.Database,p:string,c:string)=>Boolean(db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(c,p));
export const gm=(db:DatabaseDriver.Database,p:string,c:string)=>Boolean(db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')").get(c,p));
export const controls=(db:DatabaseDriver.Database,p:string,c:string,a:string)=>Boolean(db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?").get(c,a,p));
export const commandType=(t:string)=>t==="create_encounter"||t==="start_encounter"||t==="resolve_initiative"||t==="join_combatant"?"start":t==="advance_turn"||t==="advance_round"?"advance_turn":t==="flee"?"flee":t==="cancel_encounter"?"close":t==="claim_reward_bundle"||t==="end_combat"?"grant_rewards":"resolve_action";
export const actionTypes=new Set(["attack","power","item","defend","flee","end-turn","dash","disengage","help","hide","grapple","escape-grapple","shove","stand-up"]);
export const dndCommandTypes=new Set(["attack","dash","disengage","help","hide","grapple","escape-grapple","shove","stand-up","flee","end-turn"]);

export function receipt(c:any,commandId:string,b:number,a:number,at:string,status:string){return {encounterId:c.encounterId,status,receipt:{commandId,idempotencyKey:c.idempotencyKey,revisionBefore:b,revisionAfter:a,occurredAt:at}};}
export function allowed(allow:LegalCombatActionAllowlist,c:any){return allow.actions.some((x:any)=>x.kind===c.type&&(x.kind!=="attack"||(x.attackId===c.attackId&&x.targetCombatantIds.includes(c.targetCombatantId))));}
export function beginProtocol(db:DatabaseDriver.Database,d:EncounterDependencies,c:any,request:string,commandId:string,actorId:string|null,b:number,a:number,at:string,eventType:string,event:any,logKind:string,ordinal:number){const eventId=id(d);db.prepare("INSERT INTO combat_commands_v27 VALUES(?,?,?,?,?,?,?,?,?,?)").run(c.encounterId,commandId,actorId,commandType(c.type),c.idempotencyKey,request,digest(JSON.parse(request)),b,a,at);db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(eventId,c.encounterId,commandId,a,eventType,canonical(event),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(id(d),c.encounterId,null,eventId,ordinal,logKind,canonical(event),at);return eventId;}
export function sealReceipt(db:DatabaseDriver.Database,encounterId:string,commandId:string,revision:number,at:string,result:any){db.prepare("INSERT INTO combat_receipts_v27 VALUES(?,?,?,?,?,?)").run(encounterId,commandId,revision,canonical(result),digest(result),at);}
export function protocol(db:DatabaseDriver.Database,d:EncounterDependencies,c:any,request:string,commandId:string,actorId:string|null,b:number,a:number,at:string,result:any,eventType:string,event:any,logKind:string,ordinal:number){beginProtocol(db,d,c,request,commandId,actorId,b,a,at,eventType,event,logKind,ordinal);sealReceipt(db,c.encounterId,commandId,a,at,result);}
export function advanceRevision(db:DatabaseDriver.Database,e:string,a:number,at:string){db.prepare("UPDATE combat_mutation_revisions_v27 SET revision=?,updated_at=? WHERE encounter_id=?").run(a,at,e);}
export function currentCombatant(db:DatabaseDriver.Database,e:any){return e.current_turn_combatant_id&&db.prepare("SELECT * FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'").get(e.encounter_id,e.current_turn_combatant_id) as any;}
export function recordStateEvent(db:DatabaseDriver.Database,d:EncounterDependencies,e:string,c:string,hp:number,status:string,at:string,commandId:string,revision:number){const eventId=id(d),event={kind:"combatant_state_changed",combatantId:c,hitPoints:hp,status};db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(eventId,e,commandId,revision,"combatant_state_changed",canonical(event),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(id(d),e,c,eventId,1,status==="fled"?"flee":status==="defeated"?"defeat":"damage",canonical(event),at);}
export function replayAuthority(db:DatabaseDriver.Database,p:string,c:any,row:any){
  if(["create_encounter","join_combatant","resolve_initiative","advance_turn","advance_round"].includes(c.type)&&!gm(db,p,c.campaignId)) throw new EncounterAuthorizationError("GM authority is required");
  if(c.type==="claim_reward_bundle"&&!controls(db,p,c.campaignId,c.recipientActorId)) throw new EncounterAuthorizationError("only the reward recipient may claim");
  if(actionTypes.has(c.type)&&(!row.actor_id||!controls(db,p,c.campaignId,row.actor_id))) throw new EncounterAuthorizationError("only the acting controller may replay an action");
}

export function enemyDefinition(db:DatabaseDriver.Database,campaignId:string,template:{packId:string;packVersion:string;definitionId:string}):{maximumHitPoints:number}|null{
  let row=db.prepare(`SELECT definition.definition_json FROM rpg_campaign_catalog_definitions_v25 pin
    JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id
      AND definition.pack_version=pin.pack_version AND definition.kind=pin.kind
      AND definition.definition_id=pin.definition_id
    WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?
      AND pin.kind='enemy-template' AND pin.definition_id=?`)
    .get(campaignId,template.packId,template.packVersion,template.definitionId) as {definition_json:string}|undefined;
  if(!row){
    row=db.prepare(`SELECT definition.definition_json FROM campaign_catalog_current_pins pin
      JOIN rpg_catalog_definitions definition ON definition.pack_id=pin.pack_id
        AND definition.pack_version=pin.pack_version
      WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?
        AND definition.kind='enemy-template' AND definition.definition_id=?`)
      .get(campaignId,template.packId,template.packVersion,template.definitionId) as {definition_json:string}|undefined;
    if(row)db.prepare(`INSERT INTO rpg_campaign_catalog_definitions_v25
      (campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,'enemy-template',?)`)
      .run(campaignId,template.packId,template.packVersion,template.definitionId);
  }
  if(!row)return null;
  try{
    const value=JSON.parse(row.definition_json) as {mechanics?:{maxHp?:unknown}};
    return Number.isInteger(value.mechanics?.maxHp)&&Number(value.mechanics?.maxHp)>=1&&Number(value.mechanics?.maxHp)<=1_000_000
      ?{maximumHitPoints:Number(value.mechanics?.maxHp)}:null;
  }catch{return null;}
}

export function campaignInitiative(db:DatabaseDriver.Database,deps:EncounterDependencies,campaignId:string,actorId:string|null):number{
  const roll=deps.rng.integer(1,21);if(!Number.isInteger(roll)||roll<1||roll>20)throw new Error("initiative RNG returned an out-of-range d20");
  let binding:ReturnType<typeof resolveCampaignRuleset>;try{binding=resolveCampaignRuleset(db,campaignId);}catch{return roll;}
  if(binding.rulesetId!=="dnd-5e"||actorId===null||!binding.module.mechanics)return roll;
  const dexterity=db.prepare(`SELECT attribute.value FROM campaign_actors actor JOIN rpg_character_attributes attribute
    ON attribute.campaign_id=actor.campaign_id AND attribute.sheet_id=actor.sheet_id AND attribute.attribute_id='dexterity'
    WHERE actor.campaign_id=? AND actor.id=?`).get(campaignId,actorId) as {value:number}|undefined;
  if(!dexterity)throw new EncounterConflictError("SRD initiative requires Dexterity");
  return binding.module.mechanics.resolveInitiative([{id:actorId,dexterityScore:dexterity.value,roll}])[0]!.total;
}
