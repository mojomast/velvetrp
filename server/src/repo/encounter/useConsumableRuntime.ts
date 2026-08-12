import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  canonicalUseConsumableRequestFrame,
  deriveUseConsumableEffectPlan,
  evaluateUseConsumableEligibility,
  itemCatalogDefinitionSchema,
  resourceIdSchema,
  useConsumableCommandRequestSchema,
  useConsumableCommandResultSchema,
  useConsumableLegalActionSchema,
  utcIsoTimestampSchema,
  type UseConsumableCommandRequest,
  type UseConsumableCommandResult,
  type UseConsumableLegalAction,
  type UseConsumableSettlement,
} from "@velvet/contracts";
import { evaluateDiceExpression } from "../../dice.js";
import { readActiveEffects } from "../effectRepo.js";
import type { EncounterDependencies } from "./encounterWriteRepo.js";
import { buildCombatCompositionPlan, type CombatantStateChange } from "./combatCompositionPlan.js";
import { executeCombatCompositionPlan } from "./combatCompositionExecutor.js";
import { EncounterAuthorizationError, EncounterConflictError, EncounterStaleError, EncounterTurnError } from "./encounterErrors.js";

const canonical=(value:unknown):string=>JSON.stringify(value,(_key,nested)=>nested&&typeof nested==="object"&&!Array.isArray(nested)
  ?Object.fromEntries(Object.keys(nested).sort().map((key)=>[key,nested[key]])):nested);
const sha=(value:string):string=>createHash("sha256").update(value).digest("hex");
const digest=(value:unknown):string=>sha(canonical(value));
const nextId=(deps:EncounterDependencies):string=>resourceIdSchema.parse(deps.ids.nextId());
const now=(deps:EncounterDependencies):string=>utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
const exactlyOne=(result:{changes:number},message:string):void=>{if(result.changes!==1)throw new EncounterConflictError(message);};

type CombatantRow={combatant_id:string;encounter_id:string;campaign_id:string;actor_id:string|null;team:string;
  hit_points:number;maximum_hit_points:number;status:string;state_revision:number};
type EncounterRow={encounter_id:string;campaign_id:string;status:string;round_number:number;
  current_turn_combatant_id:string|null;state_revision:number;revision:number};
type InventoryRow={entry_id:string;actor_id:string;item_pack_id:string;item_pack_version:string;
  item_definition_id:string;quantity:number;equipped:number;definition_json:string};

export type UseConsumableBoundary="inventory"|"m15"|"effects"|"combatant"|"combat"|"log"|"receipt";

function member(db:DatabaseDriver.Database,principal:string,campaignId:string):boolean{
  return Boolean(db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId,principal));
}
export function mayActForConsumable(db:DatabaseDriver.Database,principal:string,campaignId:string,actorId:string):boolean{
  return Boolean(db.prepare(`SELECT 1 FROM campaign_memberships membership JOIN campaigns campaign ON campaign.id=membership.campaign_id
    LEFT JOIN campaign_actor_private_state state ON state.campaign_id=membership.campaign_id AND state.actor_id=?
    WHERE membership.campaign_id=? AND membership.principal_id=? AND (membership.role='gm'
      OR (membership.role='owner' AND campaign.owner_principal_id=membership.principal_id)
      OR state.controller_principal_id=membership.principal_id)`).get(actorId,campaignId,principal));
}
const mayAct=mayActForConsumable;
function m15Revision(db:DatabaseDriver.Database,campaignId:string,actorId:string):number{
  return (db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?")
    .get(campaignId,actorId) as {revision:number}|undefined)?.revision??0;
}
function relation(acting:CombatantRow,target:CombatantRow):"self"|"ally"|"enemy"{
  return acting.combatant_id===target.combatant_id?"self":acting.team===target.team?"ally":"enemy";
}

/** Reads an item only through its exact inventory, execution-pin, current-pin, and immutable definition ancestry. */
function inventoryRows(db:DatabaseDriver.Database,campaignId:string,actorId:string):InventoryRow[]{
  return db.prepare(`SELECT entry.entry_id,entry.actor_id,entry.item_pack_id,entry.item_pack_version,
    entry.item_definition_id,entry.quantity,entry.equipped,definition.definition_json
    FROM rpg_inventory_entries_v25 entry
    JOIN rpg_campaign_catalog_definitions_v25 execution ON execution.campaign_id=entry.campaign_id
      AND execution.pack_id=entry.item_pack_id AND execution.pack_version=entry.item_pack_version
      AND execution.kind=entry.item_kind AND execution.definition_id=entry.item_definition_id
    JOIN campaign_catalog_current_pins pin ON pin.campaign_id=execution.campaign_id
      AND pin.pack_id=execution.pack_id AND pin.pack_version=execution.pack_version
    JOIN rpg_catalog_definitions definition ON definition.pack_id=execution.pack_id
      AND definition.pack_version=execution.pack_version AND definition.kind=execution.kind
      AND definition.definition_id=execution.definition_id
    WHERE entry.campaign_id=? AND entry.actor_id=? AND entry.item_kind='item' AND entry.quantity>=1
    ORDER BY entry.entry_id`).all(campaignId,actorId) as InventoryRow[];
}

function encounterRow(db:DatabaseDriver.Database,encounterId:string):EncounterRow|undefined{
  return db.prepare(`SELECT encounter.encounter_id,encounter.campaign_id,encounter.status,encounter.round_number,
    encounter.current_turn_combatant_id,encounter.state_revision,root.revision
    FROM encounter JOIN combat_mutation_revisions_v27 root USING(encounter_id) WHERE encounter.encounter_id=?`)
    .get(encounterId) as EncounterRow|undefined;
}
function combatants(db:DatabaseDriver.Database,encounterId:string):CombatantRow[]{
  return db.prepare(`SELECT combatant_id,encounter_id,campaign_id,actor_id,team,hit_points,maximum_hit_points,status,state_revision
    FROM combatant WHERE encounter_id=? AND status='active' ORDER BY combatant_id`).all(encounterId) as CombatantRow[];
}

/** Server-authored consumable actions are intentionally separate from the unchanged live combat union. */
export function buildUseConsumableLegalActions(db:DatabaseDriver.Database,principal:string,encounterId:string):UseConsumableLegalAction[]{
  const encounter=encounterRow(db,encounterId);
  if(!encounter||encounter.status!=="active"||encounter.current_turn_combatant_id===null||!member(db,principal,encounter.campaign_id))return [];
  const rows=combatants(db,encounterId),acting=rows.find((row)=>row.combatant_id===encounter.current_turn_combatant_id);
  if(!acting?.actor_id||!mayAct(db,principal,encounter.campaign_id,acting.actor_id))return [];
  // This invariant is rechecked by execution. It prevents an ambiguous actor authority root.
  const activeCount=(db.prepare(`SELECT count(*) count FROM encounter other JOIN combatant participant USING(encounter_id)
    WHERE other.status='active' AND participant.actor_id=?`).get(acting.actor_id) as {count:number}).count;
  if(activeCount!==1)return [];
  const actions:UseConsumableLegalAction[]=[];
  for(const entry of inventoryRows(db,encounter.campaign_id,acting.actor_id)){
    let item:ReturnType<typeof itemCatalogDefinitionSchema.parse>;
    try{item=itemCatalogDefinitionSchema.parse(JSON.parse(entry.definition_json));}catch{continue;}
    const reference={kind:"item" as const,packId:entry.item_pack_id,packVersion:entry.item_pack_version,definitionId:entry.item_definition_id};
    if(item.reference.kind!=="item"||item.reference.packId!==reference.packId||item.reference.packVersion!==reference.packVersion
        ||item.reference.definitionId!==reference.definitionId)continue;
    const eligibility=evaluateUseConsumableEligibility(item),effectPlan=deriveUseConsumableEffectPlan(item,reference);
    if(!eligibility.eligible||effectPlan===null)continue;
    // Receipt-only instant modifiers have no authoritative runtime semantics yet.
    if(effectPlan.effects.some(({effect})=>effect.kind==="modifier"))continue;
    for(const target of rows){
      const targetRelation=relation(acting,target);
      if(eligibility.targetPolicy==="damage-only-enemy"&&targetRelation!=="enemy")continue;
      if(eligibility.targetPolicy==="beneficial-only-self-or-ally"&&targetRelation==="enemy")continue;
      if(target.actor_id===null&&effectPlan.effects.some(({effect})=>effect.kind==="resource"&&(effect.resource==="guard"||effect.resource==="focus")))continue;
      const identity={encounterId,actingCombatantId:acting.combatant_id,inventoryEntryId:entry.entry_id,item:reference,
        targetCombatantId:target.combatant_id,targetPolicy:eligibility.targetPolicy,effectPlan};
      actions.push(useConsumableLegalActionSchema.parse({legalActionId:`consume:${sha(canonical(identity)).slice(0,64)}`,
        kind:"use-consumable",actingCombatantId:acting.combatant_id,inventoryEntryId:entry.entry_id,item:reference,
        quantity:1,actionCost:"action",targetPolicy:eligibility.targetPolicy,
        target:{combatantId:target.combatant_id,relation:targetRelation,actorBacked:target.actor_id!==null},effectPlan}));
    }
  }
  return actions;
}

function activeEncounterForAction(db:DatabaseDriver.Database,principal:string,legalActionId:string):{encounter:EncounterRow;action:UseConsumableLegalAction}|null{
  const candidates=db.prepare(`SELECT encounter.encounter_id FROM encounter JOIN combatant current
    ON current.encounter_id=encounter.encounter_id AND current.combatant_id=encounter.current_turn_combatant_id
    WHERE encounter.status='active' AND current.actor_id IS NOT NULL ORDER BY encounter.encounter_id`).all() as Array<{encounter_id:string}>;
  const matches=candidates.flatMap(({encounter_id})=>buildUseConsumableLegalActions(db,principal,encounter_id)
    .filter((action)=>action.legalActionId===legalActionId).map((action)=>({encounter:encounterRow(db,encounter_id)!,action})));
  if(matches.length>1)throw new EncounterConflictError("consumable legal action identity is ambiguous");
  return matches[0]??null;
}

const commandEnvelope=(request:UseConsumableCommandRequest)=>({kind:"use-consumable",request});

export function readUseConsumableCommandResult(db:DatabaseDriver.Database,principal:string,commandId:string):UseConsumableCommandResult|null{
  const parsedId=resourceIdSchema.parse(commandId);
  const rows=db.prepare(`SELECT command.actor_id,command.canonical_request_json,receipt.canonical_result_json,encounter.campaign_id
    FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt USING(encounter_id,command_id)
    JOIN encounter ON encounter.encounter_id=command.encounter_id
    WHERE command.command_id=? AND command.command_type='resolve_action'
      AND json_extract(command.canonical_request_json,'$.kind')='use-consumable'`).all(parsedId) as Array<any>;
  const authorized=rows.filter((row)=>row.actor_id&&mayAct(db,principal,row.campaign_id,row.actor_id));
  if(authorized.length>1)throw new EncounterConflictError("consumable command identity is ambiguous");
  return authorized.length===1?useConsumableCommandResultSchema.parse(JSON.parse(authorized[0]!.canonical_result_json)):null;
}

/** Replays only the dedicated canonical envelope whose action identity embeds its encounter. */
function findReplay(db:DatabaseDriver.Database,principal:string,request:UseConsumableCommandRequest):UseConsumableCommandResult|null{
  const expected=canonical(commandEnvelope(request));
  const rows=db.prepare(`SELECT command.encounter_id,command.actor_id,command.canonical_request_json,receipt.canonical_result_json,
    encounter.campaign_id FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt USING(encounter_id,command_id)
    JOIN encounter ON encounter.encounter_id=command.encounter_id
    WHERE command.idempotency_key=? AND command.command_type='resolve_action'
      AND json_extract(command.canonical_request_json,'$.kind')='use-consumable'
      AND json_extract(command.canonical_request_json,'$.request.legalActionId')=?
    ORDER BY command.encounter_id`).all(request.idempotencyKey,request.legalActionId) as Array<any>;
  const exact=rows.filter((row)=>row.canonical_request_json===expected&&row.actor_id
    &&mayAct(db,principal,row.campaign_id,row.actor_id));
  if(exact.length>1)throw new EncounterConflictError("consumable replay identity is ambiguous");
  return exact.length===1?useConsumableCommandResultSchema.parse(JSON.parse(exact[0]!.canonical_result_json)):null;
}

type PlannedM15={commandId:string;campaignId:string;actorId:string;before:number;after:number;at:string;idempotencyKey:string;
  requestJson:string;requestDigest:string;changedKeys:string[];resultJson:string;resultDigest:string};
function planM15(values:{commandId:string;campaignId:string;actorId:string;before:number;at:string;idempotencyKey:string;
  request:unknown;changedKeys:string[];consumableResult:UseConsumableCommandResult}):PlannedM15{
  const after=values.before+1,changedKeys=[...new Set(values.changedKeys)].sort();
  const receipt={commandId:values.commandId,idempotencyKey:values.idempotencyKey,revisionBefore:values.before,
    revisionAfter:after,occurredAt:values.at,changedKeys};
  const result={consumable:values.consumableResult,receipt};
  const requestJson=canonical(values.request),resultJson=canonical(result);
  return {...values,after,changedKeys,requestJson,requestDigest:digest(values.request),resultJson,resultDigest:digest(result)};
}
function persistM15(db:DatabaseDriver.Database,values:PlannedM15):void{
  const root=db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?")
    .get(values.campaignId,values.actorId) as {revision:number}|undefined;
  if((root?.revision??0)!==values.before)throw new EncounterStaleError("actor M1.5 revision is stale");
  if(!root)exactlyOne(db.prepare("INSERT INTO rpg_m15_mutation_revisions_v25 VALUES(?,?,0,?)").run(values.campaignId,values.actorId,values.at),"M1.5 revision root was not created");
  exactlyOne(db.prepare(`INSERT INTO rpg_m15_commands_v25(command_id,campaign_id,actor_id,command_family,command_type,idempotency_key,
    canonical_request_json,request_digest,expected_revision,resulting_revision,created_at)
    VALUES(?,?,?,'inventory','use_consumable',?,?,?,?,?,?)`).run(values.commandId,values.campaignId,values.actorId,
      values.idempotencyKey,values.requestJson,values.requestDigest,values.before,values.after,values.at),"M1.5 command was not created");
  const keysJson=canonical(values.changedKeys);
  exactlyOne(db.prepare("INSERT INTO rpg_m15_receipts_v25 VALUES(?,?,?,?,?,?,?,?,?)").run(values.campaignId,values.actorId,values.commandId,
    values.after,values.resultJson,values.resultDigest,keysJson,sha(keysJson),values.at),"M1.5 receipt was not created");
  for(const key of values.changedKeys)exactlyOne(db.prepare("INSERT INTO rpg_m15_receipt_changed_keys_v25 VALUES(?,?,?,?,?)")
    .run(values.campaignId,values.actorId,values.commandId,key,values.after),"M1.5 changed key was not created");
  const update=db.prepare(`UPDATE rpg_m15_mutation_revisions_v25 SET revision=?,updated_at=?
    WHERE campaign_id=? AND actor_id=? AND revision=?`).run(values.after,values.at,values.campaignId,values.actorId,values.before);
  if(update.changes!==1)throw new EncounterStaleError("actor M1.5 revision is stale");
}

function assertGeneratedIdsAvailable(db:DatabaseDriver.Database,ids:{[key:string]:string},compositions:readonly ReturnType<typeof buildCombatCompositionPlan>[]):void{
  const compositionIds=compositions.flatMap((plan)=>[
    ...plan.healthMirrors.map((value)=>value.commandId),
    ...plan.effectAdvances.flatMap((value)=>[value.commandId,value.eventId,...value.effects.map((effect)=>effect.lifecycleEventId)]),
  ]);
  // Resource IDs are opaque global identities throughout the repository. Reject
  // duplicate fresh output even where today's SQL primary keys happen to be disjoint.
  const generatedIds=[...Object.values(ids),...compositionIds];
  if(new Set(generatedIds).size!==generatedIds.length)
    throw new EncounterConflictError("generated consumable identities are not unique");
  const commandIds=[ids.commandId,ids.actingM15Id,ids.targetM15Id,
    ...compositions.flatMap((plan)=>[...plan.healthMirrors.map((value)=>value.commandId),...plan.effectAdvances.map((value)=>value.commandId)])];
  const eventIds=[ids.actionEventId,ids.stateEventId,ids.combatantEventId,
    ...compositions.flatMap((plan)=>plan.effectAdvances.flatMap((value)=>[value.eventId,...value.effects.map((effect)=>effect.lifecycleEventId)]))];
  const logIds=[ids.actionLogId,ids.stateLogId,ids.combatantLogId];
  if(commandIds.some((id)=>db.prepare(`SELECT 1 FROM combat_commands_v27 WHERE command_id=? UNION ALL
      SELECT 1 FROM rpg_m15_commands_v25 WHERE command_id=? UNION ALL SELECT 1 FROM rpg_m16_commands_v26 WHERE command_id=? LIMIT 1`).get(id,id,id))
      ||eventIds.some((id)=>db.prepare(`SELECT 1 FROM combat_events_v27 WHERE event_id=? UNION ALL
        SELECT 1 FROM rpg_m16_events_v26 WHERE event_id=? UNION ALL SELECT 1 FROM rpg_effect_lifecycle_events_v26 WHERE lifecycle_event_id=? LIMIT 1`).get(id,id,id))
      ||logIds.some((id)=>db.prepare("SELECT 1 FROM combat_log WHERE log_id=?").get(id)))
    throw new EncounterConflictError("generated consumable identity already exists");
}

function damageAdjustment(db:DatabaseDriver.Database,campaignId:string,actorId:string|null,damageType:string,at:string):"none"|"resistance"|"vulnerability"|"immunity"{
  if(actorId===null)return "none";
  const modifiers=readActiveEffects(db,campaignId,actorId,at).flatMap((effect)=>effect.modifiers)
    .filter((modifier)=>(modifier.appliesToId===damageType||modifier.appliesToId==="all")
      &&(modifier.kind==="resistance"||modifier.kind==="vulnerability"||modifier.kind==="immunity"));
  if(modifiers.some((modifier)=>modifier.kind==="immunity"))return "immunity";
  const resistant=modifiers.some((modifier)=>modifier.kind==="resistance"),vulnerable=modifiers.some((modifier)=>modifier.kind==="vulnerability");
  return resistant===vulnerable?"none":resistant?"resistance":"vulnerability";
}

type TurnPlan={nextId:string|null;round:number;event:{kind:string;combatantId?:string}};
function turnPlan(db:DatabaseDriver.Database,encounter:EncounterRow,currentId:string,targetId:string,targetStatus:string):TurnPlan{
  const rows=db.prepare(`SELECT combatant_id,team,status FROM combatant WHERE encounter_id=?
    ORDER BY initiative DESC,initiative_tiebreaker,combatant_id`).all(encounter.encounter_id) as Array<{combatant_id:string;team:string;status:string}>;
  const status=(row:{combatant_id:string;status:string})=>row.combatant_id===targetId?targetStatus:row.status;
  if(new Set(rows.filter((row)=>status(row)==="active").map((row)=>row.team)).size<2)return {nextId:null,round:encounter.round_number,event:{kind:"combat_terminal"}};
  const index=rows.findIndex((row)=>row.combatant_id===currentId);
  for(let step=1;step<=rows.length;step++){
    const candidateIndex=(index+step)%rows.length,candidate=rows[candidateIndex]!;
    if(status(candidate)==="active")return {nextId:candidate.combatant_id,
      round:candidateIndex<=index?encounter.round_number+1:encounter.round_number,
      event:{kind:"turn_advanced",combatantId:candidate.combatant_id}};
  }
  return {nextId:null,round:encounter.round_number,event:{kind:"combat_terminal"}};
}

/** Executes one server-derived consumable action in one caller-owned IMMEDIATE transaction. */
export function executeUseConsumable(db:DatabaseDriver.Database,deps:EncounterDependencies,principal:string,input:UseConsumableCommandRequest,
  failpoint?: (boundary:UseConsumableBoundary)=>void):UseConsumableCommandResult{
  const request=useConsumableCommandRequestSchema.parse(input);
  return db.transaction(()=>{
    // Exact immutable replay precedes stale checks and never depends on current action legality.
    const immutableReplay=findReplay(db,principal,request);
    if(immutableReplay)return immutableReplay;
    const located=activeEncounterForAction(db,principal,request.legalActionId);
    const encounter=located?.encounter;
    if(!encounter)throw new EncounterAuthorizationError("consumable action unavailable");
    const action=located!.action,rows=combatants(db,encounter.encounter_id);
    const acting=rows.find((row)=>row.combatant_id===action.actingCombatantId),target=rows.find((row)=>row.combatant_id===action.target.combatantId);
    if(!acting?.actor_id||!target||!mayAct(db,principal,encounter.campaign_id,acting.actor_id))throw new EncounterAuthorizationError("consumable action unavailable");
    const replay=db.prepare(`SELECT command.actor_id,command.canonical_request_json,receipt.canonical_result_json
      FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt USING(encounter_id,command_id)
      WHERE command.encounter_id=? AND command.idempotency_key=?`).get(encounter.encounter_id,request.idempotencyKey) as any;
    if(replay){
      if(replay.actor_id!==acting.actor_id||replay.canonical_request_json!==canonical(commandEnvelope(request)))throw new EncounterConflictError("idempotency key was reused");
      return useConsumableCommandResultSchema.parse(JSON.parse(replay.canonical_result_json));
    }
    // Exact request/action binding and every stale/legality check precede the first random draw or write.
    if(request.inventoryEntryId!==action.inventoryEntryId||canonical(request.item)!==canonical(action.item)||request.quantity!==1
        ||request.targetCombatantId!==target.combatant_id||request.targetActorBacked!==(target.actor_id!==null))
      throw new EncounterConflictError("request differs from the server-derived consumable action");
    if(encounter.revision!==request.expectedCombatRevision)throw new EncounterStaleError("combat revision is stale");
    if(encounter.status!=="active"||encounter.current_turn_combatant_id!==acting.combatant_id)throw new EncounterTurnError("consumable action is outside the current turn");
    if((db.prepare(`SELECT count(*) count FROM encounter other JOIN combatant participant USING(encounter_id)
      WHERE other.status='active' AND participant.actor_id=?`).get(acting.actor_id) as {count:number}).count!==1)
      throw new EncounterConflictError("acting actor has ambiguous active encounter ancestry");
    const actingBefore=m15Revision(db,encounter.campaign_id,acting.actor_id);
    if(actingBefore!==request.expectedActingM15Revision)throw new EncounterStaleError("acting M1.5 revision is stale");
    const self=target.combatant_id===acting.combatant_id,targetBefore=target.actor_id===null?null:m15Revision(db,encounter.campaign_id,target.actor_id);
    if(request.expectedTargetM15Revision!==(self?actingBefore:targetBefore))throw new EncounterStaleError("target M1.5 revision is stale");
    const entry=inventoryRows(db,encounter.campaign_id,acting.actor_id).find((row)=>row.entry_id===request.inventoryEntryId);
    if(!entry||entry.quantity<1||entry.item_pack_id!==request.item.packId||entry.item_pack_version!==request.item.packVersion
        ||entry.item_definition_id!==request.item.definitionId)throw new EncounterConflictError("inventory possession identity is unavailable");
    let item:ReturnType<typeof itemCatalogDefinitionSchema.parse>;
    try{item=itemCatalogDefinitionSchema.parse(JSON.parse(entry.definition_json));}catch{throw new EncounterConflictError("consumable definition is invalid");}
    const eligibility=evaluateUseConsumableEligibility(item),derived=deriveUseConsumableEffectPlan(item,request.item);
    if(!eligibility.eligible||derived===null||canonical(derived)!==canonical(action.effectPlan)||eligibility.targetPolicy!==action.targetPolicy)
      throw new EncounterConflictError("consumable effect plan is unavailable");
    if(derived.effects.some(({effect})=>effect.kind==="modifier"))
      throw new EncounterConflictError("instant modifier runtime semantics are unavailable");
    if(relation(acting,target)!==action.target.relation)throw new EncounterConflictError("consumable target relation changed");
    if(target.actor_id!==null){
      const health=db.prepare("SELECT current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='health'")
        .get(encounter.campaign_id,target.actor_id) as {current:number;max:number}|undefined;
      if(!health||health.current!==target.hit_points||health.max!==target.maximum_hit_points)
        throw new EncounterConflictError("actor-backed target health is not synchronized");
    }
    for(const {effect} of derived.effects){
      if(effect.kind==="resource"&&(effect.resource==="guard"||effect.resource==="focus")){
        if(target.actor_id===null)throw new EncounterConflictError("actor resource target is unavailable");
        if(!db.prepare("SELECT 1 FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name=?")
          .get(encounter.campaign_id,target.actor_id,effect.resource))throw new EncounterConflictError("actor resource is unavailable");
      }
    }

    const at=now(deps);
    const adjustments=new Map<number,"none"|"resistance"|"vulnerability"|"immunity">();
    for(const {effectOrdinal,effect} of derived.effects)if(effect.kind==="damage")
      adjustments.set(effectOrdinal,damageAdjustment(db,encounter.campaign_id,target.actor_id,effect.damageType,at));
    const resourceValues=new Map<string,{current:number;max:number}>();
    if(target.actor_id)for(const row of db.prepare(`SELECT name,current,max FROM rpg_actor_resources
      WHERE campaign_id=? AND actor_id=? AND name IN ('guard','focus')`).all(encounter.campaign_id,target.actor_id) as Array<{name:string;current:number;max:number}>)
      resourceValues.set(row.name,{current:row.current,max:row.max});
    // Pre-validate every identity that this bounded command and either round outcome can consume.
    const plannedIds={actionId:nextId(deps),commandId:nextId(deps),actionEventId:nextId(deps),actionLogId:nextId(deps),
      stateEventId:nextId(deps),stateLogId:nextId(deps),combatantEventId:nextId(deps),combatantLogId:nextId(deps),
      actingM15Id:nextId(deps),targetM15Id:nextId(deps)};
    // Both possible round outcomes are sealed before RNG. Their generated IDs are validated by the shared planner.
    const sameRoundComposition=buildCombatCompositionPlan(db,deps.ids,{encounterId:encounter.encounter_id,campaignId:encounter.campaign_id,
      roundBefore:encounter.round_number,roundAfter:encounter.round_number,occurredAt:at,combatantChanges:[]});
    const wrappedComposition=buildCombatCompositionPlan(db,deps.ids,{encounterId:encounter.encounter_id,campaignId:encounter.campaign_id,
      roundBefore:encounter.round_number,roundAfter:encounter.round_number+1,occurredAt:at,combatantChanges:[]});
    assertGeneratedIdsAvailable(db,plannedIds,[sameRoundComposition,wrappedComposition]);
    const activeTurn=turnPlan(db,encounter,acting.combatant_id,target.combatant_id,target.status);
    const defeatedTurn=turnPlan(db,encounter,acting.combatant_id,target.combatant_id,"defeated");
    // Randomness begins only after the complete preflight. Settlements are then resolved in catalog order.
    let hp=target.hit_points;
    const touchedResources=new Set<string>();
    const settlements:UseConsumableSettlement[]=derived.effects.map(({effectOrdinal,effect})=>{
      if(effect.kind==="damage"){
        const modifier=effect.dice.modifier,roll=evaluateDiceExpression(`${effect.dice.count}d${effect.dice.sides}${modifier===0?"":modifier>0?`+${modifier}`:modifier}`,deps.rng);
        const requested=Math.max(0,roll.total),adjustment=adjustments.get(effectOrdinal)!;
        const adjusted=adjustment==="immunity"?0:adjustment==="resistance"?Math.floor(requested/2):adjustment==="vulnerability"?requested*2:requested;
        const before=hp,applied=Math.min(before,adjusted);hp-=applied;
        return {kind:"combat-hp-damage",effectOrdinal,damageType:effect.damageType,roll,requested,adjustment,applied,before,after:hp};
      }
      if(effect.kind==="healing"){
        const modifier=effect.dice.modifier,roll=evaluateDiceExpression(`${effect.dice.count}d${effect.dice.sides}${modifier===0?"":`+${modifier}`}`,deps.rng);
        const requested=Math.max(0,roll.total),before=hp;hp=Math.min(target.maximum_hit_points,hp+requested);
        return {kind:"combat-hp-healing",effectOrdinal,roll,requested,applied:hp-before,before,after:hp};
      }
      if(effect.kind==="resource"&&effect.resource==="health"){
        const before=hp;hp=Math.max(0,Math.min(target.maximum_hit_points,hp+effect.amount));
        return {kind:"combat-hp-resource",effectOrdinal,resource:"health",requested:effect.amount,applied:hp-before,before,after:hp};
      }
      if(effect.kind==="resource"){
        const resource: "guard"|"focus"=effect.resource==="guard"?"guard":"focus";
        const value=resourceValues.get(resource)!;const after=Math.max(0,Math.min(value.max,value.current+effect.amount)),applied=after-value.current;
        touchedResources.add(resource);
        resourceValues.set(resource,{...value,current:after});return {kind:"actor-resource-delta",effectOrdinal,resource,requested:effect.amount,applied};
      }
      throw new EncounterConflictError("instant modifier runtime semantics are unavailable");
    });
    const statusAfter=hp===0?"defeated":target.status,turn=statusAfter==="defeated"?defeatedTurn:activeTurn;
    const combatAfter=encounter.revision+1,actingAfter=actingBefore+1;
    const targetDelta=!self&&target.actor_id?{before:targetBefore!,after:targetBefore!+1}:null;
    const actionId=plannedIds.actionId,commandId=plannedIds.commandId;
    const resolution={actionId,legalActionId:action.legalActionId,kind:"use-consumable" as const,actingCombatantId:acting.combatant_id,
      target:action.target,targetPolicy:action.targetPolicy,actionCost:"action" as const,
      consumed:{inventoryEntryId:entry.entry_id,item:request.item,quantity:1 as const},effectPlan:derived,
      outcome:{targetCombatantId:target.combatant_id,settlements},combatRevisionBefore:encounter.revision,combatRevisionAfter:combatAfter,
      actingM15Revision:{before:actingBefore,after:actingAfter},targetM15Revision:targetDelta};
    const receipt={idempotencyKey:request.idempotencyKey,revisionBefore:encounter.revision,revisionAfter:combatAfter,occurredAt:at};
    const result=useConsumableCommandResultSchema.parse({resolution,requestBinding:{requestEvidence:request,
      canonicalRequestDigest:sha(canonicalUseConsumableRequestFrame(request)),idempotencyKey:request.idempotencyKey},receipt});
    const resultJson=canonical(result),combatRequestJson=canonical(commandEnvelope(request));
    if(resultJson.length>32768||combatRequestJson.length>32768)throw new EncounterConflictError("consumable protocol frame exceeds receipt bounds");
    const actingKeys=[`inventory:${entry.entry_id}`];
    if(self){if(hp!==target.hit_points)actingKeys.push("resource:health");for(const name of touchedResources)actingKeys.push(`resource:${name}`);}
    const actingM15=planM15({commandId:plannedIds.actingM15Id,campaignId:encounter.campaign_id,actorId:acting.actor_id,before:actingBefore,at,
      idempotencyKey:`consume:${sha(request.idempotencyKey).slice(0,64)}`,request:{kind:"use-consumable",request},changedKeys:actingKeys,consumableResult:result});
    const targetKeys:string[]=[];if(hp!==target.hit_points)targetKeys.push("resource:health");for(const name of touchedResources)targetKeys.push(`resource:${name}`);
    const targetM15=!self&&target.actor_id?planM15({commandId:plannedIds.targetM15Id,campaignId:encounter.campaign_id,actorId:target.actor_id,before:targetBefore!,at,
      idempotencyKey:`consume-target:${sha(request.idempotencyKey).slice(0,57)}`,request:{kind:"use-consumable-target",actionId},changedKeys:targetKeys,consumableResult:result}):null;

    if(entry.quantity===1)exactlyOne(db.prepare("DELETE FROM rpg_inventory_entries_v25 WHERE entry_id=? AND quantity=1").run(entry.entry_id),"inventory unit was not consumed");
    else if(db.prepare("UPDATE rpg_inventory_entries_v25 SET quantity=quantity-1 WHERE entry_id=? AND quantity=?")
      .run(entry.entry_id,entry.quantity).changes!==1)throw new EncounterConflictError("inventory quantity changed before commit");
    failpoint?.("inventory");
    persistM15(db,actingM15);if(targetM15)persistM15(db,targetM15);
    failpoint?.("m15");
    if(target.actor_id){
      if(hp!==target.hit_points)exactlyOne(db.prepare("UPDATE rpg_actor_resources SET current=? WHERE campaign_id=? AND actor_id=? AND name='health'")
        .run(hp,encounter.campaign_id,target.actor_id),"actor health was not updated");
      for(const name of touchedResources){const value=resourceValues.get(name)!;exactlyOne(db.prepare("UPDATE rpg_actor_resources SET current=? WHERE campaign_id=? AND actor_id=? AND name=?")
          .run(value.current,encounter.campaign_id,target.actor_id,name),"actor resource was not updated");}
    }
    const commandDigest=sha(combatRequestJson),eventId=plannedIds.actionEventId;
    exactlyOne(db.prepare("INSERT INTO combat_commands_v27 VALUES(?,?,?,?,?,?,?,?,?,?)").run(encounter.encounter_id,commandId,acting.actor_id,
      "resolve_action",request.idempotencyKey,combatRequestJson,commandDigest,encounter.revision,combatAfter,at),"combat command was not created");
    exactlyOne(db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(eventId,encounter.encounter_id,commandId,combatAfter,
      "combat_action_resolved",canonical({kind:"action_resolved",actionId,action:"use-consumable"}),at),"combat action event was not created");
    exactlyOne(db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(plannedIds.actionLogId,encounter.encounter_id,target.combatant_id,eventId,0,
      "action",canonical({kind:"use-consumable",actionId,targetCombatantId:target.combatant_id}),at),"combat action log was not created");
    if(hp!==target.hit_points||statusAfter!==target.status){
      const state={kind:"combatant_state_changed",combatantId:target.combatant_id,hitPoints:hp,status:statusAfter};
      exactlyOne(db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(plannedIds.combatantEventId,encounter.encounter_id,commandId,combatAfter,
        "combatant_state_changed",canonical(state),at),"combatant state event was not created");
      exactlyOne(db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(plannedIds.combatantLogId,encounter.encounter_id,target.combatant_id,
        plannedIds.combatantEventId,1,statusAfter==="defeated"?"defeat":"damage",canonical(state),at),"combatant state log was not created");
    }
    const turnEventId=plannedIds.stateEventId;
    exactlyOne(db.prepare("INSERT INTO combat_events_v27 VALUES(?,?,?,?,?,?,?)").run(turnEventId,encounter.encounter_id,commandId,combatAfter,
      "encounter_state_changed",canonical(turn.event),at),"encounter state event was not created");
    exactlyOne(db.prepare("INSERT INTO combat_log VALUES(?,?,?,?,?,?,?,?)").run(plannedIds.stateLogId,encounter.encounter_id,null,turnEventId,2,
      "encounter_state",canonical(turn.event),at),"encounter state log was not created");
    failpoint?.("log");
    executeCombatCompositionPlan(db,turn.round===encounter.round_number+1?wrappedComposition:sameRoundComposition,
      (boundary)=>{if(boundary==="effects")failpoint?.("effects");});
    if(hp!==target.hit_points||statusAfter!==target.status){
      const update=db.prepare(`UPDATE combatant SET hit_points=?,status=?,state_revision=state_revision+1,updated_at=?
        WHERE encounter_id=? AND combatant_id=? AND hit_points=? AND status=? AND state_revision=?`)
        .run(hp,statusAfter,at,encounter.encounter_id,target.combatant_id,target.hit_points,target.status,target.state_revision);
      if(update.changes!==1)throw new EncounterConflictError("target combatant changed before commit");
    }
    failpoint?.("combatant");
    exactlyOne(db.prepare(`UPDATE encounter SET current_turn_combatant_id=?,round_number=?,state_revision=state_revision+1,updated_at=?
      WHERE encounter_id=? AND state_revision=?`).run(turn.nextId,turn.round,at,encounter.encounter_id,encounter.state_revision),"encounter state was not updated");
    exactlyOne(db.prepare("UPDATE combat_mutation_revisions_v27 SET revision=?,updated_at=? WHERE encounter_id=? AND revision=?")
      .run(combatAfter,at,encounter.encounter_id,encounter.revision),"combat revision was not updated");
    failpoint?.("combat");
    exactlyOne(db.prepare("INSERT INTO combat_receipts_v27 VALUES(?,?,?,?,?,?)").run(encounter.encounter_id,commandId,combatAfter,
      resultJson,digest(result),at),"combat receipt was not created");
    failpoint?.("receipt");
    return result;
  }).immediate();
}
