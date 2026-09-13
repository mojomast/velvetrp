import type DatabaseDriver from "better-sqlite3";
import { abilityCatalogDefinitionSchema, spellCatalogDefinitionSchema, utcIsoTimestampSchema,
  type PowerReference } from "@velvet/contracts";
import type { EncounterDependencies } from "./encounterWriteRepo.js";
import { EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, EncounterTurnError } from "./encounterErrors.js";
import { buildCombatCompositionPlan, type CombatantStateChange } from "./combatCompositionPlan.js";
import { executeCombatCompositionPlan } from "./combatCompositionExecutor.js";
import { mayActForConsumable } from "./useConsumableRuntime.js";
import { isDndCombat, readCombatTurnEconomy, consumeDndTurnCost, endDndCombatTurn } from "./combatActionPlan.js";
import { grantTemporaryHitPoints, interruptConcentrationAfterDamage } from "./combatConditionRuntime.js";
import { canonical, sha, nextId, exactlyOne, revision, feature, RAGE, LAY_ON_HANDS } from "./effectHandlers/util.js";
import { applyEffectKind, getEffectHandler } from "./effectHandlers/index.js";
import type { CombatPowerLegalAction, CombatPowerRequest, CombatPowerResult, CombatPowerBoundary, Row, Definition, EffectContext } from "./effectHandlers/types.js";
export type { CombatPowerLegalAction, CombatPowerRequest, CombatPowerResult, CombatPowerBoundary } from "./effectHandlers/types.js";



/** Reads a committed power receipt only; this path cannot execute a command. */
export function getCombatPowerResultByKey(db:DatabaseDriver.Database,principal:string,combatId:string,idempotencyKey:string):{request:CombatPowerRequest;result:CombatPowerResult}|null{const row=db.prepare(`SELECT command.actor_id,encounter.campaign_id,command.canonical_request_json,receipt.canonical_result_json FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt USING(encounter_id,command_id) JOIN encounter USING(encounter_id) WHERE command.encounter_id=? AND command.idempotency_key=?`).get(combatId,idempotencyKey)as any;if(!row||!mayActForConsumable(db,principal,row.campaign_id,row.actor_id))return null;const envelope=JSON.parse(row.canonical_request_json);return envelope.kind==="combat-power"?{request:envelope.request,result:JSON.parse(row.canonical_result_json)}:null;}

function rows(db:DatabaseDriver.Database,encounterId:string):Row[]{return db.prepare(`SELECT combatant_id,actor_id,team,hit_points,maximum_hit_points,status,state_revision
  FROM combatant WHERE encounter_id=? AND status IN ('active','unconscious','stable') ORDER BY combatant_id`).all(encounterId)as Row[];}
function usedCount(db:DatabaseDriver.Database,campaignId:string,actorId:string,ref:PowerReference,recovery:string):number{
  let recovered:string|null=null;if(recovery==="short-rest"||recovery==="long-rest"){const kinds=recovery==="short-rest"?["short","long"]:["long"];
    recovered=(db.prepare(`SELECT max(occurred_at) at FROM rpg_rest_receipts_v25 WHERE campaign_id=? AND actor_id=? AND rest_kind IN (${kinds.map(()=>"?").join(",")})`).get(campaignId,actorId,...kinds)as any).at;}
  else if(recovery==="encounter")recovered=(db.prepare(`SELECT max(encounter.updated_at) at FROM encounter JOIN combatant USING(encounter_id) WHERE encounter.campaign_id=? AND combatant.actor_id=? AND encounter.status='completed'`).get(campaignId,actorId)as any).at;
  return(db.prepare(`SELECT count(*) count FROM rpg_power_uses_v26 power JOIN rpg_m16_receipts_v26 receipt ON receipt.campaign_id=power.campaign_id AND receipt.actor_id=power.actor_id AND receipt.command_id=power.command_id
    WHERE power.campaign_id=? AND power.actor_id=? AND power.power_kind=? AND power.power_pack_id=? AND power.power_pack_version=? AND power.power_definition_id=? AND (? IS NULL OR receipt.occurred_at>?)`).get(campaignId,actorId,ref.kind,ref.packId,ref.packVersion,ref.definitionId,recovered,recovered)as any).count;}
function supported(definition:Definition):"damage"|"healing"|"temporary-hit-points"|"effect"|null{
  const id=feature(definition);
  if(id===RAGE)return"effect";
  if(id===LAY_ON_HANDS)return"healing";
  if(!["action","bonus-action","reaction"].includes(definition.mechanics.actionCost)||definition.mechanics.target==="area"||definition.mechanics.target==="single"||definition.mechanics.effects.length===0)return null;
  const kinds=new Set(definition.mechanics.effects.map(effect=>effect.type));
  if(kinds.size!==1)return null;if(kinds.has("damage"))return"damage";if(kinds.has("healing"))return"healing";
  if(kinds.has("temporary-hit-points"))return"temporary-hit-points";
  if(definition.mechanics.effects.length===1&&(kinds.has("condition")||(kinds.has("modifier")&&(definition.mechanics.effects[0]as any).duration!=="instant")))return"effect";
  return null;
}
function resolveFeatureDefinition(db:DatabaseDriver.Database,definition:Definition,campaignId:string,actorId:string):Definition {
  if(definition.reference.kind!=="ability"||definition.reference.definitionId!=="srd-5.1:ability:fighter-second-wind")return definition;
  const level=(db.prepare("SELECT level FROM character_progression_v23 WHERE campaign_id=? AND actor_id=?").get(campaignId,actorId)as any)?.level;
  if(!Number.isInteger(level)||level<1||level>20)return definition;
  return {...definition,mechanics:{...definition.mechanics,effects:definition.mechanics.effects.map(effect=>
    effect.type==="healing"?{...effect,dice:{...effect.dice,modifier:level}}:effect)}} as Definition;
}

/** Derives only actor-controlled, exact single-target combat powers from current immutable catalog pins. */
export function buildCombatPowerLegalActions(db:DatabaseDriver.Database,principal:string,encounterId:string):CombatPowerLegalAction[]{
  const encounter=db.prepare(`SELECT encounter.campaign_id,current.actor_id source_actor_id,current.combatant_id acting_id,current.team
    FROM encounter JOIN combatant current ON current.encounter_id=encounter.encounter_id AND current.combatant_id=encounter.current_turn_combatant_id AND current.status='active'
    WHERE encounter.encounter_id=? AND encounter.status='active'`).get(encounterId)as any;
  if(!encounter?.source_actor_id||!mayActForConsumable(db,principal,encounter.campaign_id,encounter.source_actor_id))return[];
  const dnd=isDndCombat(db,encounter.campaign_id),economy=readCombatTurnEconomy(db,encounterId);
  if(dnd&&(!economy||economy.combatantId!==encounter.acting_id))return[];
  const activeCount=(db.prepare(`SELECT count(*) count FROM encounter JOIN combatant USING(encounter_id) WHERE encounter.status='active' AND combatant.actor_id=?`).get(encounter.source_actor_id)as any).count;
  if(activeCount!==1)return[];
  const powers=db.prepare(`SELECT known.kind,known.pack_id,known.pack_version,known.definition_id,definition.definition_json
    FROM campaign_actors actor JOIN character_known_powers_v23 known ON known.campaign_character_id=actor.campaign_character_id
    JOIN campaign_catalog_current_pins pin ON pin.campaign_id=actor.campaign_id AND pin.pack_id=known.pack_id AND pin.pack_version=known.pack_version
    JOIN rpg_campaign_catalog_definitions_v25 execution ON execution.campaign_id=actor.campaign_id AND execution.pack_id=known.pack_id AND execution.pack_version=known.pack_version AND execution.kind=known.kind AND execution.definition_id=known.definition_id
    JOIN rpg_catalog_definitions definition ON definition.pack_id=known.pack_id AND definition.pack_version=known.pack_version AND definition.kind=known.kind AND definition.definition_id=known.definition_id
    WHERE actor.campaign_id=? AND actor.id=? ORDER BY known.kind,known.definition_id`).all(encounter.campaign_id,encounter.source_actor_id)as any[];
  const combatants=rows(db,encounterId),acting=combatants.find(value=>value.combatant_id===encounter.acting_id)!;const output:CombatPowerLegalAction[]=[];
  for(const power of powers){let definition:Definition;try{definition=power.kind==="spell"?spellCatalogDefinitionSchema.parse(JSON.parse(power.definition_json)):abilityCatalogDefinitionSchema.parse(JSON.parse(power.definition_json));}catch{continue;}
    definition=resolveFeatureDefinition(db,definition,encounter.campaign_id,acting.actor_id!);const kind=supported(definition);if(!kind)continue;const ref=definition.reference as PowerReference;
    // SRD spell damage powers resolve an attack roll or save; generic non-spell damage abilities stay unavailable.
    if(dnd&&kind==="damage"&&definition.reference.kind!=="spell")continue;
    if(dnd){const cost=definition.mechanics.actionCost;if(cost==="reaction"?!economy!.reaction.available:!economy![cost==="bonus-action"?"bonusAction":"action"].available)continue;}
    else if(definition.mechanics.actionCost!=="action")continue;
    const mechanics:any=definition.mechanics;let cost:CombatPowerLegalAction["cost"]=null;if(ref.kind==="spell"&&mechanics.level>0){const id=`slot-${mechanics.level}`,slot=db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name=?").get(encounter.campaign_id,acting.actor_id,id)as any;if(!slot||slot.current<1)continue;cost={kind:"slot",id};}
     if(ref.kind==="ability"&&ref.definitionId===RAGE){const resource=db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='rage'").get(encounter.campaign_id,acting.actor_id)as any;if(!resource||resource.current<1)continue;cost={kind:"resource",id:"rage",amount:1};}
     else if(ref.kind==="ability"&&ref.definitionId===LAY_ON_HANDS){const resource=db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='lay-on-hands'").get(encounter.campaign_id,acting.actor_id)as any;if(!resource||resource.current<1)continue;cost={kind:"resource",id:"lay-on-hands",amount:1};}
     else if(ref.kind==="ability"&&mechanics.uses>0){if(usedCount(db,encounter.campaign_id,acting.actor_id!,ref,mechanics.recovery)>=mechanics.uses)continue;cost={kind:"ability-use",id:ref.definitionId};}
    for(const target of combatants){const relation=target.combatant_id===acting.combatant_id?"self":target.team===acting.team?"ally":"enemy";
      const legal=kind==="damage"?definition.mechanics.target==="enemy"&&relation==="enemy"
        :definition.mechanics.target==="self"?relation==="self":definition.mechanics.target==="ally"&&(relation==="self"||relation==="ally");if(!legal)continue;
       if((kind==="healing"||kind==="effect"||kind==="temporary-hit-points")&&target.actor_id===null)continue;
       if(ref.definitionId===LAY_ON_HANDS&&target.hit_points>=target.maximum_hit_points)continue;
      const identity={encounterId,actingCombatantId:acting.combatant_id,powerRef:ref,targetCombatantId:target.combatant_id};
      output.push({legalActionId:`combat-power:${sha(canonical(identity)).slice(0,48)}`,encounterId,campaignId:encounter.campaign_id,actingCombatantId:acting.combatant_id,sourceActorId:acting.actor_id!,targetCombatantId:target.combatant_id,targetActorId:target.actor_id,powerRef:ref,definition,cost});
    }}return output;
}

function turn(db:DatabaseDriver.Database,encounterId:string,currentId:string,targetId:string,targetStatus:string,round:number){const ordered=db.prepare("SELECT combatant_id,team,status FROM combatant WHERE encounter_id=? ORDER BY initiative DESC,initiative_tiebreaker,combatant_id").all(encounterId)as any[];
   const status=(row:any)=>row.combatant_id===targetId?targetStatus:row.status;if(new Set(ordered.filter(row=>["active","unconscious","stable"].includes(status(row))).map(row=>row.team)).size<2)return{next:null,round,event:{kind:"combat_terminal"}};
   const index=ordered.findIndex(row=>row.combatant_id===currentId);for(let step=1;step<=ordered.length;step++){const i=(index+step)%ordered.length,row=ordered[i]!;if(["active","unconscious"].includes(status(row)))return{next:row.combatant_id,round:i<=index?round+1:round,event:{kind:"turn_advanced",combatantId:row.combatant_id}};}return{next:null,round,event:{kind:"combat_terminal"}};}

function persistM15(db:DatabaseDriver.Database,deps:EncounterDependencies,campaignId:string,actorId:string,before:number,at:string,key:string,changes:Array<{name:string;before:number;after:number}>){if(!changes.length)return;
  const commandId=nextId(deps),after=before+1,request={kind:"combat-power-resources",changes},result={resources:changes.map(value=>({resourceId:value.name,current:value.after})),receipt:{commandId,idempotencyKey:key,revisionBefore:before,revisionAfter:after,occurredAt:at,changedKeys:changes.map(value=>`resource:${value.name}`).sort()}},requestJson=canonical(request),resultJson=canonical(result);
  if(before===0&&!db.prepare("SELECT 1 FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?").get(campaignId,actorId))db.prepare("INSERT INTO rpg_m15_mutation_revisions_v25 VALUES(?,?,0,?)").run(campaignId,actorId,at);
  exactlyOne(db.prepare("INSERT INTO rpg_m15_commands_v25 VALUES(?,?,?,'resource','combat_power',?,?,?,?,?,?)").run(commandId,campaignId,actorId,key,requestJson,sha(requestJson),before,after,at),"combat power resource command was not created");
  const keys=canonical(result.receipt.changedKeys);exactlyOne(db.prepare("INSERT INTO rpg_m15_receipts_v25 VALUES(?,?,?,?,?,?,?,?,?)").run(campaignId,actorId,commandId,after,resultJson,sha(resultJson),keys,sha(keys),at),"combat power resource receipt was not created");
  for(const value of changes){exactlyOne(db.prepare("UPDATE rpg_actor_resources SET current=? WHERE campaign_id=? AND actor_id=? AND name=? AND current=?").run(value.after,campaignId,actorId,value.name,value.before),"combat power resource changed before commit");db.prepare("INSERT INTO rpg_m15_receipt_changed_keys_v25 VALUES(?,?,?,?,?)").run(campaignId,actorId,commandId,`resource:${value.name}`,after);}
  exactlyOne(db.prepare("UPDATE rpg_m15_mutation_revisions_v25 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=? AND revision=?").run(after,at,campaignId,actorId,before),"combat power resource revision changed");}

/** Executes a server-derived combat power and all cross-domain deltas in one IMMEDIATE transaction. */
export function executeCombatPower(db:DatabaseDriver.Database,deps:EncounterDependencies,principal:string,input:CombatPowerRequest,failpoint?:(boundary:CombatPowerBoundary)=>void):CombatPowerResult{return db.transaction(()=>{
  const envelope=canonical({kind:"combat-power",request:input});const prior=db.prepare(`SELECT receipt.canonical_result_json,command.actor_id,encounter.campaign_id FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt USING(encounter_id,command_id) JOIN encounter USING(encounter_id) WHERE command.idempotency_key=? AND command.canonical_request_json=?`).get(input.idempotencyKey,envelope)as any;if(prior){if(!mayActForConsumable(db,principal,prior.campaign_id,prior.actor_id))throw new EncounterAuthorizationError("combat power unavailable");return JSON.parse(prior.canonical_result_json);}
  const matches=(db.prepare("SELECT encounter_id FROM encounter WHERE status='active' ORDER BY encounter_id").all()as any[]).flatMap(row=>buildCombatPowerLegalActions(db,principal,row.encounter_id).filter(action=>action.legalActionId===input.legalActionId));if(matches.length!==1)throw new EncounterAuthorizationError("combat power unavailable");const action=matches[0]!,encounter=db.prepare(`SELECT encounter.*,root.revision FROM encounter JOIN combat_mutation_revisions_v27 root USING(encounter_id) WHERE encounter.encounter_id=?`).get(action.encounterId)as any;
  const combatants=rows(db,action.encounterId),source=combatants.find(row=>row.combatant_id===action.actingCombatantId)!,target=combatants.find(row=>row.combatant_id===action.targetCombatantId)!;
  if(canonical(input.powerRef)!==canonical(action.powerRef)||input.targetCombatantId!==action.targetCombatantId)throw new EncounterConflictError("combat power selection was changed");
  if(encounter.revision!==input.expectedCombatRevision)throw new EncounterStaleError("combat revision is stale");if(encounter.current_turn_combatant_id!==source.combatant_id)throw new EncounterTurnError("combat power is outside the current turn");
  const sourceM15=revision(db,"m15",action.campaignId,action.sourceActorId),sourceM16=revision(db,"m16",action.campaignId,action.sourceActorId),targetM15=target.actor_id?revision(db,"m15",action.campaignId,target.actor_id):null,targetM16=target.actor_id?revision(db,"m16",action.campaignId,target.actor_id):null;
  if(sourceM15!==input.expectedSourceM15Revision||sourceM16!==input.expectedSourceM16Revision||targetM15!==input.expectedTargetM15Revision||targetM16!==input.expectedTargetM16Revision)throw new EncounterStaleError("combat power actor revision is stale");
  if(target.actor_id){const health=db.prepare("SELECT current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'").get(action.campaignId,target.actor_id)as any;if(!health||health.current!==target.hit_points||health.max!==target.maximum_hit_points)throw new EncounterConflictError("actor-backed combat health is not synchronized");}
    const at=utcIsoTimestampSchema.parse(deps.clock.now().toISOString()),kind=supported(action.definition)!,featureId=feature(action.definition),rage=featureId===RAGE,layOnHands=featureId===LAY_ON_HANDS;let hp=target.hit_points;const outcomes:any[]=[],tempHitPointGrants:Array<{outcome:any;amount:number}>=[];
    const dnd=isDndCombat(db,action.campaignId);
    const effects:any[]=rage?[{type:"modifier",statistic:"physical",amount:0,duration:"round",durationRounds:10}]:layOnHands?[{type:"healing",dice:{count:1,sides:1,modifier:0}}]:action.definition.mechanics.effects;
    const effectContext:EffectContext={db,deps,action,target,dnd,at,hp,outcomes,tempHitPointGrants,effects,rage,layOnHands};
    for(const effect of effects){const handler=getEffectHandler(effect.type);if(handler)handler(effectContext,effect);}
    hp=effectContext.hp;
    let statusAfter=dnd&&target.actor_id&&target.hit_points===0&&hp>0?"active":hp===0?"defeated":target.status;
  const hitPointDamage=target.hit_points-hp;
  if(dnd&&target.actor_id&&target.hit_points>0&&hp===0){
    db.prepare(`INSERT INTO combat_survival_v61(encounter_id,combatant_id,successes,failures,stable) VALUES(?,?,0,0,0)
      ON CONFLICT(encounter_id,combatant_id) DO UPDATE SET successes=0,failures=0,stable=0`).run(action.encounterId,target.combatant_id);
    statusAfter="unconscious";
  }else if(dnd&&target.actor_id&&target.hit_points===0&&hitPointDamage>0){
    const prior=db.prepare("SELECT successes,failures,stable FROM combat_survival_v61 WHERE encounter_id=? AND combatant_id=?")
      .get(action.encounterId,target.combatant_id) as {successes:number;failures:number;stable:number}|undefined;
    const failures=Math.min(3,(prior?.failures??0)+1);
    db.prepare(`INSERT INTO combat_survival_v61(encounter_id,combatant_id,successes,failures,stable) VALUES(?,?,?,?,?)
      ON CONFLICT(encounter_id,combatant_id) DO UPDATE SET successes=excluded.successes,failures=excluded.failures,stable=excluded.stable`)
      .run(action.encounterId,target.combatant_id,prior?.successes??0,failures,prior?.stable??0);
    statusAfter=failures===3?"dead":target.status;
  }
  const concentrationCheck=interruptConcentrationAfterDamage(db,deps.ids,deps.rng,action.campaignId,action.encounterId,target.combatant_id,hitPointDamage,statusAfter,at);
  if(concentrationCheck){const damage=outcomes.find((outcome)=>outcome.kind==="damage");if(damage)damage.concentrationCheck=concentrationCheck;}
  if(dnd&&target.actor_id&&target.hit_points===0&&hp>0)db.prepare("DELETE FROM combat_survival_v61 WHERE encounter_id=? AND combatant_id=?").run(action.encounterId,target.combatant_id);
  const turnPlan=turn(db,action.encounterId,source.combatant_id,target.combatant_id,statusAfter,encounter.round_number),combatAfter=encounter.revision+1;
  if(dnd&&turnPlan.next!==null){turnPlan.next=source.combatant_id;turnPlan.round=encounter.round_number;turnPlan.event={kind:"turn_continued"};}
  const combatantChanges:CombatantStateChange[]=hp!==target.hit_points?[{combatantId:target.combatant_id,hitPointsBefore:target.hit_points,hitPointsAfter:hp,statusBefore:target.status,statusAfter,stateRevisionBefore:target.state_revision}]:[];
  const external=target.actor_id&&hp!==target.hit_points?[target.actor_id]:[];const composition=buildCombatCompositionPlan(db,deps.ids,{encounterId:action.encounterId,campaignId:action.campaignId,roundBefore:encounter.round_number,roundAfter:turnPlan.round,occurredAt:at,combatantChanges,externallyMirroredActorIds:external});
  const sourceChanges:Array<{name:string;before:number;after:number}>=[];let cost:CombatPowerResult["cost"]=null;if(action.cost?.kind==="slot"){const row=db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name=?").get(action.campaignId,action.sourceActorId,action.cost.id)as any;if(!row||row.current<1)throw new EncounterConflictError("spell slot is exhausted");sourceChanges.push({name:action.cost.id,before:row.current,after:row.current-1});cost={label:`Level ${action.cost.id.slice(5)} spell slot`,before:row.current,after:row.current-1};}
   else if(action.cost?.kind==="resource"){const row=db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name=?").get(action.campaignId,action.sourceActorId,action.cost.id)as any;const amount=layOnHands?outcomes.find(value=>value.kind==="healing")?.applied??0:action.cost.amount;if(!row||row.current<amount||amount<1)throw new EncounterConflictError("bounded combat power resource is exhausted");sourceChanges.push({name:action.cost.id,before:row.current,after:row.current-amount});cost={label:`${action.definition.name} points`,before:row.current,after:row.current-amount};}
   else if(action.cost){const uses=(action.definition as any).mechanics.uses-usedCount(db,action.campaignId,action.sourceActorId,action.powerRef,(action.definition as any).mechanics.recovery);cost={label:`${action.definition.name} uses`,before:uses,after:uses-1};if(uses<1)throw new EncounterConflictError("finite power uses are exhausted");}
  const targetChanges=target.actor_id&&hp!==target.hit_points?[{name:"health",before:target.hit_points,after:hp}]:[];
  if(target.actor_id===action.sourceActorId)sourceChanges.push(...targetChanges);else if(target.actor_id&&targetChanges.length)persistM15(db,deps,action.campaignId,target.actor_id,targetM15!,at,`combat-power-target:${sha(input.idempotencyKey).slice(0,48)}`,targetChanges);
  persistM15(db,deps,action.campaignId,action.sourceActorId,sourceM15,at,`combat-power-source:${sha(input.idempotencyKey).slice(0,48)}`,sourceChanges);failpoint?.("costs");
  const commandId=nextId(deps),powerUseId=nextId(deps),actionId=nextId(deps),eventId=nextId(deps),actionLogId=nextId(deps),stateEventId=nextId(deps),stateLogId=nextId(deps),combatantEventId=nextId(deps),combatantLogId=nextId(deps);
  // Temporary hit points never stack: each grant keeps the larger pool and defers its FK to this command.
  for(const grant of tempHitPointGrants){grant.outcome.after=grantTemporaryHitPoints(db,action.encounterId,target.combatant_id,grant.amount,commandId,at);grant.outcome.granted=grant.outcome.after-grant.outcome.before;}
  db.prepare("INSERT INTO combat_commands_v27 VALUES(?,?,?,?,?,?,?,?,?,?)").run(action.encounterId,commandId,action.sourceActorId,"resolve_action",input.idempotencyKey,envelope,sha(envelope),encounter.revision,combatAfter,at);db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(eventId,action.encounterId,commandId,combatAfter,"combat_action_resolved",canonical({kind:"action_resolved",actionId,action:"combat-power"}),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(actionLogId,action.encounterId,target.combatant_id,eventId,0,"action",canonical({kind:"combat-power",actionId}),at);
  if(combatantChanges.length){db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(combatantEventId,action.encounterId,commandId,combatAfter,"combatant_state_changed",canonical({kind:"combatant_state_changed",combatantId:target.combatant_id,hitPoints:hp,status:statusAfter}),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(combatantLogId,action.encounterId,target.combatant_id,combatantEventId,1,statusAfter==="defeated"?"defeat":"damage",canonical({kind:"combatant_state_changed",hitPoints:hp,status:statusAfter}),at);}
  executeCombatCompositionPlan(db,composition);failpoint?.("effects");
  const sourceRevisionNow=revision(db,"m16",action.campaignId,action.sourceActorId);if(sourceRevisionNow===0&&!db.prepare("SELECT 1 FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?").get(action.campaignId,action.sourceActorId))db.prepare("INSERT INTO rpg_m16_mutation_revisions_v26 VALUES(?,?,0,?)").run(action.campaignId,action.sourceActorId,at);
   if(kind==="effect")applyEffectKind(effectContext,powerUseId);
  const sourcePowerBefore=revision(db,"m16",action.campaignId,action.sourceActorId),sourceAfter=sourcePowerBefore+1,result:CombatPowerResult={commandId,powerName:action.definition.name,targetCombatantId:target.combatant_id,cost,outcomes,concentration:action.definition.reference.kind==="spell"&&(action.definition as any).mechanics.concentration,roundBefore:encounter.round_number,roundAfter:turnPlan.round,revisionBefore:encounter.revision,revisionAfter:combatAfter,occurredAt:at};const resultJson=canonical(result),m16Request=canonical({kind:"combat-power-use",request:input});
  db.prepare("INSERT INTO rpg_m16_commands_v26 VALUES(?,?,?,'power','use_power',?,?,?,?,?,?)").run(action.campaignId,action.sourceActorId,commandId,input.idempotencyKey,m16Request,sha(m16Request),sourcePowerBefore,sourceAfter,at);db.prepare("INSERT INTO rpg_m16_receipts_v26 VALUES(?,?,?,?,?,?,?)").run(action.campaignId,action.sourceActorId,commandId,sourceAfter,resultJson,sha(resultJson),at);
   db.prepare("INSERT INTO rpg_power_uses_v26 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(powerUseId,action.campaignId,action.sourceActorId,commandId,sourceAfter,action.powerRef.packId,action.powerRef.packVersion,action.powerRef.kind,action.powerRef.definitionId,"slot",action.powerRef.kind==="spell"?(action.definition as any).mechanics.level||1:1,target.actor_id,envelope,at);if(action.cost)db.prepare("INSERT INTO rpg_power_use_costs_v26 VALUES(?,?,?,?,?)").run(powerUseId,0,action.cost.kind==="slot"?"slot":action.cost.kind==="resource"?"resource":"charge",action.cost.id,action.cost.kind==="resource"?cost!.before-cost!.after:1);db.prepare("INSERT INTO rpg_m16_events_v26 VALUES(?,?,?,?,?,?,?,?)").run(nextId(deps),action.campaignId,action.sourceActorId,commandId,sourceAfter,"power_used",resultJson,at);db.prepare("UPDATE rpg_m16_mutation_revisions_v26 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=? AND revision=?").run(sourceAfter,at,action.campaignId,action.sourceActorId,sourcePowerBefore);
  failpoint?.("combatant");
  if(dnd){const turnCost=action.definition.mechanics.actionCost==="bonus-action"?"bonus-action":action.definition.mechanics.actionCost==="reaction"?"reaction":"action";consumeDndTurnCost(db,action.encounterId,source.combatant_id,turnCost);if(turnPlan.next===null)endDndCombatTurn(db,action.encounterId,at);}
  db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(stateEventId,action.encounterId,commandId,combatAfter,"encounter_state_changed",canonical(turnPlan.event),at);db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(stateLogId,action.encounterId,null,stateEventId,2,"encounter_state",canonical(turnPlan.event),at);failpoint?.("log");
  exactlyOne(db.prepare("UPDATE encounter SET current_turn_combatant_id=?,round_number=?,state_revision=state_revision+1,updated_at=? WHERE encounter_id=? AND state_revision=?").run(turnPlan.next,turnPlan.round,at,action.encounterId,encounter.state_revision),"encounter state changed");exactlyOne(db.prepare("UPDATE combat_mutation_revisions_v27 SET revision=?,updated_at=? WHERE encounter_id=? AND revision=?").run(combatAfter,at,action.encounterId,encounter.revision),"combat revision changed");failpoint?.("combat");db.prepare("INSERT INTO combat_receipts_v27 VALUES(?,?,?,?,?,?)").run(action.encounterId,commandId,combatAfter,resultJson,sha(resultJson),at);failpoint?.("receipt");return result;
}).immediate();}
