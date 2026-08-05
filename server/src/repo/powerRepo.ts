import type DatabaseDriver from "better-sqlite3";
import { powerUseCommandSchema, resourceIdSchema, type PowerUseCommand } from "@velvet/contracts";
import { runM16Mutation, type M16Dependencies, type M16Result } from "./effectRepo.js";

export class PowerUnavailableError extends Error { readonly code="POWER_UNAVAILABLE"; }
export class PowerInsufficientResourceError extends Error { readonly code="POWER_INSUFFICIENT_RESOURCE"; }
export interface PowerRepository { usePower(principal:string,command:PowerUseCommand):M16Result<{powerUseId:string}>; }

export function createPowerRepository(db:DatabaseDriver.Database,deps:M16Dependencies,guard:()=>void):PowerRepository { return { usePower(principal,input) {
 const command=powerUseCommandSchema.parse(input);
 return runM16Mutation(db,deps,guard,{principal,campaignId:command.campaignId,actorId:command.actorId,family:"power",type:"use_power",expectedRevision:command.expectedRevision,idempotencyKey:command.idempotencyKey,request:command,eventType:"power_used",build:(after,now,id)=>{
  const known=db.prepare(`SELECT 1 FROM campaign_actors actor JOIN character_known_powers_v23 power ON power.campaign_character_id=actor.campaign_character_id WHERE actor.campaign_id=? AND actor.id=? AND power.kind=? AND power.pack_id=? AND power.pack_version=? AND power.definition_id=?`).get(command.campaignId,command.actorId,command.power.kind,command.power.packId,command.power.packVersion,command.power.definitionId);
  const pinned=db.prepare("SELECT 1 FROM rpg_campaign_catalog_definitions_v25 WHERE campaign_id=? AND pack_id=? AND pack_version=? AND kind=? AND definition_id=?").get(command.campaignId,command.power.packId,command.power.packVersion,command.power.kind,command.power.definitionId);
  if(!known||!pinned)throw new PowerUnavailableError("power is not known and pinned");
  const slot=command.costs.find(cost=>cost.kind==="slot") as {slotId:string}|undefined;
  const slotLevel=slot?Number(/^slot-([1-9]|1[0-9]|20)$/.exec(slot.slotId)?.[1]):1;
  if(!Number.isInteger(slotLevel)||slotLevel<1||slotLevel>20)throw new PowerUnavailableError("slot identity has no server-owned level");
  for(const cost of command.costs){const name=cost.kind==="resource"?cost.resourceId:cost.kind==="slot"?cost.slotId:cost.chargeId;const row=cost.kind==="charge"?db.prepare("SELECT current_charges current FROM rpg_actor_resource_charges_v25 WHERE campaign_id=? AND actor_id=? AND resource_name=?").get(command.campaignId,command.actorId,name)as any:db.prepare("SELECT current FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name=?").get(command.campaignId,command.actorId,name)as any;if(!row||row.current<cost.amount)throw new PowerInsufficientResourceError("power cost is unavailable");}
  const powerUseId=resourceIdSchema.parse(deps.ids.nextId());
  return {result:{powerUseId},persist:()=>{for(const cost of command.costs){const name=cost.kind==="resource"?cost.resourceId:cost.kind==="slot"?cost.slotId:cost.chargeId;if(cost.kind==="charge")db.prepare("UPDATE rpg_actor_resource_charges_v25 SET current_charges=current_charges-? WHERE campaign_id=? AND actor_id=? AND resource_name=?").run(cost.amount,command.campaignId,command.actorId,name);else db.prepare("UPDATE rpg_actor_resources SET current=current-? WHERE campaign_id=? AND actor_id=? AND name=?").run(cost.amount,command.campaignId,command.actorId,name);}db.prepare("INSERT INTO rpg_power_uses_v26(power_use_id,campaign_id,actor_id,command_id,resulting_revision,power_pack_id,power_pack_version,power_kind,power_definition_id,slot_kind,slot_level,target_actor_id,use_json,used_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(powerUseId,command.campaignId,command.actorId,id,after,command.power.packId,command.power.packVersion,command.power.kind,command.power.definitionId,"slot",slotLevel,command.targetActorId,JSON.stringify(command),now);const insertCost=db.prepare("INSERT INTO rpg_power_use_costs_v26 VALUES(?,?,?,?,?)");command.costs.forEach((cost,index)=>insertCost.run(powerUseId,index,cost.kind,cost.kind==="resource"?cost.resourceId:cost.kind==="slot"?cost.slotId:cost.chargeId,cost.amount));}};
 }}); } }; }
