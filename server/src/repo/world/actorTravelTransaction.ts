import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  actorTravelCommandRequestSchema, actorTravelCommandResponseSchema, resourceIdSchema, travelCommandSchema,
  utcIsoTimestampSchema, type ActorTravelCommandRequest, type TravelCommand,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../../runtime.js";
import { evaluateActorTravelPolicy } from "./actorTravelPolicy.js";
import { WorldAuthorizationError, WorldConflictError, WorldStaleError, WorldUnavailableError } from "./worldErrors.js";
import type { ActorTravelResult, WorldReceipt } from "./worldWriteRepo.js";

const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)
  ?Object.fromEntries(Object.keys(item).sort().map((key)=>[key,item[key]])):item);
const digest=(value:unknown):string=>createHash("sha256").update(canonical(value)).digest("hex");
const requireOne=(result:{changes:number},message:string):void=>{if(result.changes!==1)throw new WorldConflictError(message);};

export interface ActorTravelTransactionDependencies {clock:Clock;ids:IdGenerator}
type Receipt={commandId:string;idempotencyKey:string;revisionBefore:number;revisionAfter:number;occurredAt:string};

/** Shared connection-scoped travel persistence. The projector is the only legacy/actor shape difference. */
export function executeTravelInTransaction<Result>(db:DatabaseDriver.Database,deps:ActorTravelTransactionDependencies,
  principalId:string,sessionIdInput:string,actorIdInput:string,commandInput:TravelCommand,
  project:(value:{command:TravelCommand;sessionId:string;destinationLocationId:string;locations:ActorTravelResult["locations"];
    discoveries:ActorTravelResult["discoveries"];receipt:Receipt})=>Result):Result {
  if(!db.inTransaction)throw new Error("actor travel requires a caller-owned transaction");
  const sessionId=resourceIdSchema.parse(sessionIdInput),actorId=resourceIdSchema.parse(actorIdInput),command=travelCommandSchema.parse(commandInput);
  if(!db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(command.campaignId,sessionId))
    throw new WorldUnavailableError("session does not belong to campaign");
  const request=canonical(command);
  const replays=db.prepare(`SELECT command.canonical_request_json,receipt.canonical_result_json FROM world_commands_v28 command
    JOIN world_receipts_v28 receipt USING(campaign_id,session_id,command_id)
    WHERE command.campaign_id=? AND command.session_id=? AND command.idempotency_key=? AND command.command_type='travel'`)
    .all(command.campaignId,sessionId,command.idempotencyKey) as Array<{canonical_request_json:string;canonical_result_json:string}>;
  if(replays.length>1)throw new WorldConflictError("travel replay is ambiguous");
  if(replays.length===1){
    const authority=evaluateActorTravelPolicy(db,{campaignId:command.campaignId,sessionId,actorId,principalId,
      partyActorIds:command.selectedPartyActorIds,connectionId:command.locationConnectionId,requireRunningSession:false,authorityOnly:true});
    if(!authority.allowed)throw new WorldAuthorizationError("travel authority is required");
    if(replays[0]!.canonical_request_json!==request)throw new WorldConflictError("idempotency key was reused");
    return JSON.parse(replays[0]!.canonical_result_json) as Result;
  }
  const authority=evaluateActorTravelPolicy(db,{campaignId:command.campaignId,sessionId,actorId,principalId,
    partyActorIds:command.selectedPartyActorIds,connectionId:command.locationConnectionId,requireRunningSession:true,authorityOnly:true});
  if(!authority.allowed){if(authority.reason==="identity-or-authority")throw new WorldAuthorizationError("travel authority is required");
    throw new WorldUnavailableError("route is unavailable");}
  const root=db.prepare("SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id=?")
    .get(command.campaignId,sessionId) as {revision:number}|undefined;
  const before=root?.revision??0;
  if(before!==command.expectedRevision)throw new WorldStaleError("world revision is stale");
  const policy=evaluateActorTravelPolicy(db,{campaignId:command.campaignId,sessionId,actorId,principalId,
    partyActorIds:command.selectedPartyActorIds,connectionId:command.locationConnectionId,requireRunningSession:true});
  if(!policy.allowed){if(policy.reason==="identity-or-authority")throw new WorldAuthorizationError("travel authority is required");
    throw new WorldUnavailableError("route is unavailable");}
  const at=utcIsoTimestampSchema.parse(deps.clock.now().toISOString()),commandId=resourceIdSchema.parse(deps.ids.nextId()),after=before+1;
  const discoveries=policy.positions.map((position)=>{const existing=db.prepare(`SELECT discovered_at FROM campaign_location_discoveries_v28
    WHERE campaign_id=? AND actor_id=? AND location_id=?`).get(command.campaignId,position.actorId,policy.route.toLocationId) as {discovered_at:string}|undefined;
    return {actorId:position.actorId,locationId:policy.route.toLocationId,discoveredAt:existing?.discovered_at??at};});
  const locations=policy.positions.map((position)=>({actorId:position.actorId,locationId:policy.route.toLocationId,revision:position.revision+1,updatedAt:at}));
  const receipt={commandId,idempotencyKey:command.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:at};
  const result=project({command,sessionId,destinationLocationId:policy.route.toLocationId,locations,discoveries,receipt});
  if(!root)requireOne(db.prepare("INSERT INTO world_mutation_revisions_v28 VALUES(?,?,?,?)").run(command.campaignId,sessionId,0,at),"world revision root was not created");
  requireOne(db.prepare("INSERT INTO world_commands_v28 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(command.campaignId,sessionId,commandId,actorId,"travel",command.idempotencyKey,request,digest(command),before,after,at),"world command was not created");
  requireOne(db.prepare("INSERT INTO world_receipts_v28 VALUES(?,?,?,?,?,?,?)").run(command.campaignId,sessionId,commandId,after,canonical(result),digest(result),at),"world receipt was not created");
  requireOne(db.prepare("INSERT INTO world_events_v28 VALUES(?,?,?,?,?,?,?,?)").run(resourceIdSchema.parse(deps.ids.nextId()),command.campaignId,sessionId,commandId,after,"travelled",canonical({travelId:command.travelId,destinationLocationId:policy.route.toLocationId}),at),"world event was not created");
  requireOne(db.prepare("UPDATE world_mutation_revisions_v28 SET revision=?,updated_at=? WHERE campaign_id=? AND session_id=? AND revision=?").run(after,at,command.campaignId,sessionId,before),"world revision was not advanced");
  for(const position of policy.positions){
    requireOne(db.prepare("INSERT INTO world_travel_party_members_v28 VALUES(?,?,?,?)").run(command.campaignId,sessionId,commandId,position.actorId),"travel party member was not recorded");
    requireOne(db.prepare(`UPDATE campaign_actor_locations_v28 SET location_id=?,state_revision=state_revision+1,updated_at=?
      WHERE campaign_id=? AND actor_id=? AND session_id=? AND state_revision=?`).run(policy.route.toLocationId,at,command.campaignId,position.actorId,sessionId,position.revision),"actor location was not updated");
    const discovery=db.prepare("INSERT OR IGNORE INTO campaign_location_discoveries_v28 VALUES(?,?,?,?)").run(command.campaignId,position.actorId,policy.route.toLocationId,at);
    if(discovery.changes!==0&&discovery.changes!==1)throw new WorldConflictError("travel discovery was not recorded");
  }
  requireOne(db.prepare("INSERT INTO world_travel_destinations_v28 VALUES(?,?,?,?,?)").run(command.campaignId,sessionId,commandId,policy.route.connectionId,policy.route.toLocationId),"travel destination was not recorded");
  return result;
}

export function executeLegacyTravelInTransaction(db:DatabaseDriver.Database,deps:ActorTravelTransactionDependencies,
  principalId:string,sessionId:string,command:TravelCommand):WorldReceipt {
  return executeTravelInTransaction(db,deps,principalId,sessionId,command.selectedPartyActorIds[0]!,command,
    ({command:exact,destinationLocationId,receipt})=>({travelId:exact.travelId,destinationLocationId,receipt}));
}

export function executeActorTravelInTransaction(db:DatabaseDriver.Database,deps:ActorTravelTransactionDependencies,
  principalId:string,sessionId:string,actorIdInput:string,input:ActorTravelCommandRequest):ActorTravelResult {
  const actorId=resourceIdSchema.parse(actorIdInput),intent=actorTravelCommandRequestSchema.parse(input);
  const actor=db.prepare("SELECT campaign_id FROM campaign_actors WHERE id=?").get(actorId) as {campaign_id:string}|undefined;
  if(!actor)throw new WorldUnavailableError("actor world state is unavailable");
  if(!intent.partyActorIds.includes(actorId))throw new WorldConflictError("route actor must belong to the travel party");
  const command=travelCommandSchema.parse({type:"travel",campaignId:actor.campaign_id,
    travelId:`travel:${digest({campaignId:actor.campaign_id,sessionId,actorId,idempotencyKey:intent.idempotencyKey}).slice(0,40)}`,
    locationConnectionId:intent.connectionId,selectedPartyActorIds:intent.partyActorIds,expectedRevision:intent.expectedRevision,idempotencyKey:intent.idempotencyKey});
  return executeTravelInTransaction(db,deps,principalId,sessionId,actorId,command,({sessionId:exactSession,locations,discoveries,receipt})=>{
    actorTravelCommandResponseSchema.parse({locations,discoveries,receipt:{idempotencyKey:receipt.idempotencyKey,revisionBefore:receipt.revisionBefore,
      revisionAfter:receipt.revisionAfter,occurredAt:receipt.occurredAt}});
    return {campaignId:command.campaignId,sessionId:exactSession,locations,discoveries,receipt};
  });
}
