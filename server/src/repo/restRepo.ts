import type DatabaseDriver from "better-sqlite3";
import { actorResourcesSchema, restCommandSchema, restReceiptSchema, resourceIdSchema, type RestCommand, type RestReceipt } from "@velvet/contracts";
import { ActorResourceConflictError, m15Authorized, runM15Mutation, type M15Dependencies, type M15Result } from "./actorResourceRepo.js";

export class RestAuthorizationError extends Error { readonly code="REST_FORBIDDEN"; }
export class RestStaleError extends Error { readonly code="REST_STALE"; }
export class RestIllegalStateError extends Error { readonly code="REST_ILLEGAL_STATE"; }

export interface RestRepository { takeRest(principal:string,command:RestCommand):M15Result<{rest:RestReceipt;actorState:{resources:ReturnType<typeof actorResourcesSchema.parse>;revision:number}}>; listRestReceipts(principal:string,campaignId:string,actorId:string):RestReceipt[]; }
export function createRestRepository(db:DatabaseDriver.Database,deps:M15Dependencies,assertMutation:()=>void):RestRepository {
  const list=(principal:string,campaign:string,actor:string):RestReceipt[]=>{resourceIdSchema.parse(principal);resourceIdSchema.parse(campaign);resourceIdSchema.parse(actor);if(!m15Authorized(db,principal,campaign,actor))return [];
    return (db.prepare(`SELECT receipt.canonical_result_json FROM rpg_rest_receipts_v25 rest
      JOIN rpg_m15_receipts_v25 receipt ON receipt.campaign_id=rest.campaign_id AND receipt.actor_id=rest.actor_id AND receipt.command_id=rest.receipt_id
      WHERE rest.campaign_id=? AND rest.actor_id=? ORDER BY rest.occurred_at,rest.receipt_id`).all(campaign,actor)as any[])
      .map(row=>restReceiptSchema.parse(JSON.parse(row.canonical_result_json).rest));};
  return {listRestReceipts:list,takeRest(principal,input){const command=restCommandSchema.parse(input);return runM15Mutation(db,deps,assertMutation,{principal,campaignId:command.campaignId,actorId:command.actorId,family:'rest',type:command.type,expectedRevision:command.expectedRevision,idempotencyKey:command.idempotencyKey,request:command,changedKeys:[`rest:${command.actorId}`],apply:(after,now,commandId)=>{
    if(!m15Authorized(db,principal,command.campaignId,command.actorId))throw new RestAuthorizationError('rest unavailable');
     // Recovery is opt-in and pinned to the resource binding.  The bounded
     // vocabulary intentionally mirrors catalog mechanics: short-rest pools
     // recover on either rest, long-rest pools only on a long rest, and every
     // other resource is untouched.
     const resources=db.prepare(`SELECT resource.name,resource.current,resource.max,binding.binding_json
       FROM rpg_actor_resources resource LEFT JOIN rpg_actor_resource_bindings_v25 binding
       ON binding.campaign_id=resource.campaign_id AND binding.actor_id=resource.actor_id AND binding.resource_name=resource.name
       WHERE resource.campaign_id=? AND resource.actor_id=? ORDER BY resource.name`).all(command.campaignId,command.actorId)as any[];
      const changes=resources.filter(row=>{
       const recovery=row.binding_json?JSON.parse(row.binding_json).recovery:undefined;
       return row.current<row.max&&(recovery==='short-rest'||(command.type==='take_long_rest'&&recovery==='long-rest'));
      }).map(row=>({resourceId:row.name,before:row.current,after:row.max}));
      const sidecars=(table:string,current:string,maximum:string,suffix:string)=>(db.prepare(`SELECT sidecar.resource_name,sidecar.${current} current,sidecar.${maximum} maximum,binding.binding_json
        FROM ${table} sidecar JOIN rpg_actor_resource_bindings_v25 binding ON binding.campaign_id=sidecar.campaign_id AND binding.actor_id=sidecar.actor_id AND binding.resource_name=sidecar.resource_name
        WHERE sidecar.campaign_id=? AND sidecar.actor_id=?`).all(command.campaignId,command.actorId)as any[]).filter(row=>{
        const recovery=JSON.parse(row.binding_json).recovery;return row.current<row.maximum&&(recovery==='short-rest'||(command.type==='take_long_rest'&&recovery==='long-rest'));
      }).map(row=>({resourceId:`${row.resource_name}:${suffix}`,before:row.current,after:row.maximum,resourceName:row.resource_name}));
      const chargeChanges=sidecars('rpg_actor_resource_charges_v25','current_charges','maximum_charges','charges');
      const ammunitionChanges=sidecars('rpg_actor_resource_ammunition_v25','current_ammunition','maximum_ammunition','ammunition');
      changes.push(...chargeChanges.map(({resourceId,before,after})=>({resourceId,before,after})),...ammunitionChanges.map(({resourceId,before,after})=>({resourceId,before,after})));
    if(!changes.length)throw new RestIllegalStateError('no resource can recover');
     for(const delta of changes)db.prepare("UPDATE rpg_actor_resources SET current=? WHERE campaign_id=? AND actor_id=? AND name=?").run(delta.after,command.campaignId,command.actorId,delta.resourceId);
     for(const delta of chargeChanges)db.prepare("UPDATE rpg_actor_resource_charges_v25 SET current_charges=? WHERE campaign_id=? AND actor_id=? AND resource_name=?").run(delta.after,command.campaignId,command.actorId,delta.resourceName);
     for(const delta of ammunitionChanges)db.prepare("UPDATE rpg_actor_resource_ammunition_v25 SET current_ammunition=? WHERE campaign_id=? AND actor_id=? AND resource_name=?").run(delta.after,command.campaignId,command.actorId,delta.resourceName);
    // The v25 rest receipt is the immutable domain receipt; generic M1.5 receipt retains retry data.
     db.prepare("INSERT INTO rpg_rest_receipts_v25 VALUES(?,?,?,?,?,?,?,?)").run(commandId,command.campaignId,command.actorId,commandId,after,command.type==='take_short_rest'?'short':'long',JSON.stringify(changes),now);
     return {rest:restReceiptSchema.parse({restId:commandId,campaignId:command.campaignId,actorId:command.actorId,kind:command.type==='take_short_rest'?'short':'long',recoveredAt:now,recovery:{resources:changes},revisionBefore:command.expectedRevision,revisionAfter:after,idempotencyKey:command.idempotencyKey}),actorState:{resources:actorResourcesSchema.parse((db.prepare("SELECT name resourceId,current,max capacity FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? ORDER BY name").all(command.campaignId,command.actorId)as any[])),revision:after}};
  }});}};
}
