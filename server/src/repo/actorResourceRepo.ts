import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { actorResourcesSchema, resourceIdSchema, utcIsoTimestampSchema } from "@velvet/contracts";
import type { Clock, IdGenerator } from "../runtime.js";
import { createActorResourceReadRepository, type ActorResourceReadRepository } from "./actorResource/actorResourceReadRepo.js";
import { createActorResourceWriteRepository, type ActorResourceWriteRepository } from "./actorResource/actorResourceWriteRepo.js";

export type { ActorResourceReadRepository } from "./actorResource/actorResourceReadRepo.js";
export type { ActorResourceWriteRepository } from "./actorResource/actorResourceWriteRepo.js";

/** M1.5 failures are deliberately small and safe for a future HTTP adapter. */
export class ActorResourceAuthorizationError extends Error { readonly code="ACTOR_RESOURCE_FORBIDDEN"; }
export class ActorResourceStaleError extends Error { readonly code="ACTOR_RESOURCE_STALE"; }
export class ActorResourceNegativeError extends Error { readonly code="ACTOR_RESOURCE_NEGATIVE"; }
export class ActorResourceConflictError extends Error { readonly code="ACTOR_RESOURCE_CONFLICT"; }

export type M15Dependencies={clock:Clock;ids:IdGenerator};
export type M15Result<T extends object>=T&{receipt:{commandId:string;idempotencyKey:string;revisionBefore:number;revisionAfter:number;occurredAt:string;changedKeys:string[]}};

const canonical=(value:unknown):string=>JSON.stringify(value,(_key,value)=>value&&typeof value==="object"&&!Array.isArray(value)
  ?Object.fromEntries(Object.keys(value).sort().map((key)=>[key,value[key]])):value);
const digest=(value:unknown)=>createHash("sha256").update(canonical(value)).digest("hex");

/** Fixed internal policy: owner/GM, or the actor's recorded player controller. */
export function m15Authorized(db:DatabaseDriver.Database,principal:string,campaign:string,actor:string):boolean {
  return Boolean(db.prepare(`SELECT 1 FROM campaign_memberships membership
    JOIN campaigns campaign ON campaign.id=membership.campaign_id
    JOIN campaign_actors target ON target.campaign_id=membership.campaign_id AND target.id=?
    LEFT JOIN campaign_actor_private_state state ON state.campaign_id=target.campaign_id AND state.actor_id=target.id
    WHERE membership.campaign_id=? AND membership.principal_id=? AND (
      membership.role='gm' OR (membership.role='owner' AND campaign.owner_principal_id=membership.principal_id)
      OR (membership.role='player' AND state.controller_principal_id=membership.principal_id))`).get(actor,campaign,principal));
}

/** Runs the v25 immutable command/receipt protocol.  Callers must mutate only in `apply`. */
export function runM15Mutation<T extends object>(db:DatabaseDriver.Database,deps:M15Dependencies,assertMutation:()=>void,values:{
  principal:string;campaignId:string;actorId:string;family:"resource"|"inventory"|"economy"|"purchase"|"trade"|"rest";type:string;
  expectedRevision:number;idempotencyKey:string;request:object;changedKeys:string[];
  /** Parties changed by this command.  Their streams advance in the same IMMEDIATE transaction. */
  additionalActorIds?:string[];apply:(revisionAfter:number,now:string,commandId:string)=>T;
}):M15Result<T> {
  assertMutation(); const requestJson=canonical(values.request);
  return db.transaction(()=>{
    if(!m15Authorized(db,values.principal,values.campaignId,values.actorId))throw new ActorResourceAuthorizationError("M1.5 mutation unavailable");
    const previous=db.prepare(`SELECT command.command_family,command.command_type,command.canonical_request_json,receipt.canonical_result_json
      FROM rpg_m15_commands_v25 command JOIN rpg_m15_receipts_v25 receipt ON receipt.campaign_id=command.campaign_id AND receipt.actor_id=command.actor_id AND receipt.command_id=command.command_id
      WHERE command.campaign_id=? AND command.actor_id=? AND command.idempotency_key=?`).get(values.campaignId,values.actorId,values.idempotencyKey) as any;
    if(previous){
      if(previous.command_family!==values.family||previous.command_type!==values.type||previous.canonical_request_json!==requestJson)
        throw new ActorResourceConflictError("idempotency key was reused for a different M1.5 command");
      return JSON.parse(previous.canonical_result_json) as M15Result<T>;
    }
    const root=db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?").get(values.campaignId,values.actorId) as {revision:number}|undefined;
    const before=root?.revision??0;
    if(before!==values.expectedRevision)throw new ActorResourceStaleError("M1.5 mutation revision is stale");
    const now=utcIsoTimestampSchema.parse(deps.clock.now().toISOString()),commandId=resourceIdSchema.parse(deps.ids.nextId()),after=before+1;
    if(root)db.prepare("UPDATE rpg_m15_mutation_revisions_v25 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=?").run(after,now,values.campaignId,values.actorId);
    else db.prepare("INSERT INTO rpg_m15_mutation_revisions_v25(campaign_id,actor_id,revision,updated_at) VALUES(?,?,0,?)").run(values.campaignId,values.actorId,now);
    // A bilateral mutation must never leave the counterpart on an old stream.
    // There is intentionally no caller supplied counterpart revision in the
    // public v25 command vocabulary, so the row is locked by this immediate
    // transaction and advanced exactly once with the initiating command.
    const counterpartRevisions:Array<{actorId:string;before:number;after:number}>=[];
    for(const other of [...new Set(values.additionalActorIds??[])].filter(id=>id!==values.actorId)){
      // The initiating actor controls only their own assets.  A counterpart is
      // deliberately not authorized here: transfers and trade proposals need
      // recipient consent only at acceptance, while GM/owner authorization is
      // already covered by the initiating actor check above.
      if(!db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?").get(values.campaignId,other)) throw new ActorResourceAuthorizationError("M1.5 counterpart unavailable");
      const otherRoot=db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?").get(values.campaignId,other) as {revision:number}|undefined;
      const otherBefore=otherRoot?.revision??0,otherAfter=otherBefore+1;
      if(otherRoot) db.prepare("UPDATE rpg_m15_mutation_revisions_v25 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=?").run(otherAfter,now,values.campaignId,other);
      else { db.prepare("INSERT INTO rpg_m15_mutation_revisions_v25(campaign_id,actor_id,revision,updated_at) VALUES(?,?,0,?)").run(values.campaignId,other,now); db.prepare("UPDATE rpg_m15_mutation_revisions_v25 SET revision=1,updated_at=? WHERE campaign_id=? AND actor_id=?").run(now,values.campaignId,other); }
      counterpartRevisions.push({actorId:other,before:otherBefore,after:otherAfter});
    }
    const payload=values.apply(after,now,commandId),result={...payload,receipt:{commandId,idempotencyKey:values.idempotencyKey,revisionBefore:before,revisionAfter:after,occurredAt:now,changedKeys:[...values.changedKeys].sort()}} as M15Result<T>;
    if(!root)db.prepare("UPDATE rpg_m15_mutation_revisions_v25 SET revision=?,updated_at=? WHERE campaign_id=? AND actor_id=?").run(after,now,values.campaignId,values.actorId);
    db.prepare(`INSERT INTO rpg_m15_commands_v25(command_id,campaign_id,actor_id,command_family,command_type,idempotency_key,canonical_request_json,request_digest,expected_revision,resulting_revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(commandId,values.campaignId,values.actorId,values.family,values.type,values.idempotencyKey,requestJson,digest(values.request),before,after,now);
    const keys=[...new Set(values.changedKeys)].sort(),resultJson=canonical(result);
    db.prepare("INSERT INTO rpg_m15_receipts_v25 VALUES(?,?,?,?,?,?,?,?,?)").run(values.campaignId,values.actorId,commandId,after,resultJson,digest(result),canonical(keys),digest(keys),now);
    const keyInsert=db.prepare("INSERT INTO rpg_m15_receipt_changed_keys_v25 VALUES(?,?,?,?,?)"); for(const key of keys)keyInsert.run(values.campaignId,values.actorId,commandId,key,after);
    const counterpartInsert=db.prepare("INSERT INTO rpg_m15_counterpart_receipts_v25 VALUES(?,?,?,?,?,?,?)");
    for(const other of counterpartRevisions)counterpartInsert.run(values.campaignId,values.actorId,commandId,other.actorId,other.before,other.after,now);
    return result;
  }).immediate();
}

export type M15ActorResource=ReturnType<typeof actorResourcesSchema.parse>[number];
/** Authoritative actor-stream state for an actor-scoped resource route. */
export interface ActorResourceSnapshot { campaignId:string; actorId:string; resources:M15ActorResource[]; revision:number; }
/** Route payload with actor and campaign identity bound by the request path. */
export interface ActorScopedResourceChange { kind:"change"; resourceName:string; amount:number; expectedRevision:number; idempotencyKey:string; }
export interface ActorResourceRepository extends ActorResourceReadRepository, ActorResourceWriteRepository {}
/** Reads the shared M1.5 stream revision inside a caller-owned snapshot transaction. */
export function getM15ActorRevision(db:DatabaseDriver.Database,campaignId:string,actorId:string):number {
  return (db.prepare("SELECT revision FROM rpg_m15_mutation_revisions_v25 WHERE campaign_id=? AND actor_id=?").get(campaignId,actorId) as {revision:number}|undefined)?.revision??0;
}
export function createActorResourceRepository(db:DatabaseDriver.Database,deps:M15Dependencies,assertMutation:()=>void):ActorResourceRepository {
  const reads=createActorResourceReadRepository(db);
  const writes=createActorResourceWriteRepository(db,deps,assertMutation,reads);
  return {...reads,...writes};
}
