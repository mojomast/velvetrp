import type DatabaseDriver from "better-sqlite3";
import {
  abilityCatalogDefinitionSchema,
  actorPowersResponseSchema,
  powerReferenceSchema,
  powerUseCommandSchema,
  resourceIdSchema,
  spellCatalogDefinitionSchema,
  type ActorPowerCommandRequest,
  type ActorPowerResolution,
  type ActorPowerActorState,
  type ActorPowerAvailabilityReason,
  type ActorPowersResponse,
  type PowerReference,
  type PowerUseCommand,
} from "@velvet/contracts";
import { createCharacterProgressionReadRepository } from "./characterProgression/index.js";
import { runM16Mutation, type M16Dependencies, type M16Result } from "./effectRepo.js";
import { m15Authorized } from "./actorResourceRepo.js";
import { useActorPower as executeActorPower, ActorPowerNotFoundError, ActorPowerConflictError, ActorPowerInsufficientError } from "./actorPowerUseRepo.js";
import { planActorPowerCommands } from "./actorPowerCommandPlanner.js";

export class PowerUnavailableError extends Error { readonly code="POWER_UNAVAILABLE"; }
export class PowerInsufficientResourceError extends Error { readonly code="POWER_INSUFFICIENT_RESOURCE"; }
export { ActorPowerNotFoundError, ActorPowerConflictError, ActorPowerInsufficientError };

/** Internal path binding is retained only long enough for the HTTP adapter to verify it. */
export interface ActorPowerSnapshot extends ActorPowersResponse { campaignId:string; actorId:string; }
export interface PowerRepository {
  getActorPowerSnapshot(principal:string,actorId:string):ActorPowerSnapshot|null;
  usePower(principal:string,command:PowerUseCommand):M16Result<{powerUseId:string}>;
  useActorPower(principal:string,actorId:string,input:ActorPowerCommandRequest):M16Result<{resolution:ActorPowerResolution;actorStates:ActorPowerActorState[]}>;
}

type DefinitionState = {
  reference:PowerReference;
  executionPinned:boolean;
  spellLevel:number|null;
  uses:number;
  recovery:"none"|"short-rest"|"long-rest"|"encounter";
};

const referenceKey=(reference:PowerReference)=>`${reference.kind}\0${reference.packId}\0${reference.packVersion}\0${reference.definitionId}`;

export function createPowerRepository(db:DatabaseDriver.Database,deps:M16Dependencies,guard:()=>void):PowerRepository {
  const progression=createCharacterProgressionReadRepository(db);

  const readSnapshot=(principal:string,actorId:string):ActorPowerSnapshot|null=>db.transaction(()=>{
    const parsedPrincipal=resourceIdSchema.parse(principal),parsedActor=resourceIdSchema.parse(actorId);
    const actor=db.prepare("SELECT campaign_id,campaign_character_id FROM campaign_actors WHERE id=?")
      .get(parsedActor) as {campaign_id:string;campaign_character_id:string|null}|undefined;
    if(!actor||!m15Authorized(db,parsedPrincipal,actor.campaign_id,parsedActor))return null;

    let known:PowerReference[]=[];
    if(actor.campaign_character_id!==null){
      const root=progression.rootFor(actor.campaign_character_id);
      if(!root||root.actor_id!==parsedActor||root.campaign_id!==actor.campaign_id)throw new Error("actor progression binding is incomplete");
      known=progression.getValidatedKnownPowers(root).map((reference)=>powerReferenceSchema.parse(reference));
    }

    const definitionStatement=db.prepare(`SELECT visibility.public_definition_json,
      CASE WHEN execution.definition_id IS NULL THEN 0 ELSE 1 END execution_pinned
      FROM campaign_catalog_current_pins pin
      JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
        AND visibility.kind=? AND visibility.definition_id=? AND visibility.publicly_reachable=1
      LEFT JOIN rpg_campaign_catalog_definitions_v25 execution ON execution.campaign_id=pin.campaign_id
        AND execution.pack_id=visibility.pack_id AND execution.pack_version=visibility.pack_version
        AND execution.kind=visibility.kind AND execution.definition_id=visibility.definition_id
      WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?`);
    const definitions:DefinitionState[]=known.map((reference)=>{
      const row=definitionStatement.get(reference.kind,reference.definitionId,actor.campaign_id,reference.packId,reference.packVersion) as
        {public_definition_json:string;execution_pinned:number}|undefined;
      if(!row)throw new Error("known power is outside the current public campaign catalog ancestry");
      const raw=JSON.parse(row.public_definition_json);
      if(reference.kind==="ability"){
        const definition=abilityCatalogDefinitionSchema.parse(raw);
        return {reference,executionPinned:row.execution_pinned===1,spellLevel:null,uses:definition.mechanics.uses,recovery:definition.mechanics.recovery};
      }
      const definition=spellCatalogDefinitionSchema.parse(raw);
      return {reference,executionPinned:row.execution_pinned===1,spellLevel:definition.mechanics.level,uses:0,recovery:"none"};
    });

    const slots=(db.prepare("SELECT name,current,max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=?")
      .all(actor.campaign_id,parsedActor) as Array<{name:string;current:number;max:number}>)
      .flatMap((row)=>{const match=/^slot-([1-9]|1[0-9]|20)$/.exec(row.name);return match?[{slotId:row.name,level:Number(match[1]),current:row.current,max:row.max}]:[];})
      .sort((left,right)=>left.level-right.level);

    const uses=definitions.filter((definition)=>definition.reference.kind==="ability"&&definition.uses>0).map((definition)=>{
      let recoveredAt:string|null=null;
      if(definition.recovery==="short-rest"||definition.recovery==="long-rest"){
        const kinds=definition.recovery==="short-rest"?["short","long"]:["long"];
        recoveredAt=(db.prepare(`SELECT max(occurred_at) occurred_at FROM rpg_rest_receipts_v25
          WHERE campaign_id=? AND actor_id=? AND rest_kind IN (${kinds.map(()=>"?").join(",")})`)
          .get(actor.campaign_id,parsedActor,...kinds) as {occurred_at:string|null}).occurred_at;
      }else if(definition.recovery==="encounter"){
        recoveredAt=(db.prepare(`SELECT max(encounter.updated_at) occurred_at FROM encounter
          JOIN combatant ON combatant.encounter_id=encounter.encounter_id AND combatant.campaign_id=encounter.campaign_id
          WHERE encounter.campaign_id=? AND combatant.actor_id=? AND encounter.status='completed'`)
          .get(actor.campaign_id,parsedActor) as {occurred_at:string|null}).occurred_at;
      }
      const count=(db.prepare(`SELECT count(*) count FROM rpg_power_uses_v26 power
        JOIN rpg_m16_receipts_v26 receipt ON receipt.campaign_id=power.campaign_id AND receipt.actor_id=power.actor_id AND receipt.command_id=power.command_id
        WHERE power.campaign_id=? AND power.actor_id=? AND power.power_kind=? AND power.power_pack_id=?
          AND power.power_pack_version=? AND power.power_definition_id=? AND (? IS NULL OR receipt.occurred_at>?)`)
        .get(actor.campaign_id,parsedActor,definition.reference.kind,definition.reference.packId,
          definition.reference.packVersion,definition.reference.definitionId,recoveredAt,recoveredAt) as {count:number}).count;
      return {powerRef:definition.reference,current:Math.max(0,definition.uses-count),max:definition.uses,recovery:definition.recovery};
    });
    const useByReference=new Map(uses.map((state)=>[referenceKey(state.powerRef),state]));
    const slotByLevel=new Map(slots.map((slot)=>[slot.level,slot]));
    const legalNow=definitions.map((definition)=>{
      const reasons:ActorPowerAvailabilityReason[]=[];
      if(!definition.executionPinned)reasons.push("execution-pin-unavailable");
      if(definition.reference.kind==="ability"&&definition.uses>0&&useByReference.get(referenceKey(definition.reference))?.current===0)
        reasons.push("finite-uses-exhausted");
      if(definition.reference.kind==="spell"&&definition.spellLevel!==null&&definition.spellLevel>0
          &&(slotByLevel.get(definition.spellLevel)?.current??0)<1)reasons.push("spell-slot-unavailable");
      return {powerRef:definition.reference,legal:reasons.length===0,reasons};
    });
    const revision=(db.prepare("SELECT revision FROM rpg_m16_mutation_revisions_v26 WHERE campaign_id=? AND actor_id=?")
      .get(actor.campaign_id,parsedActor) as {revision:number}|undefined)?.revision??0;
    const legalCommands=planActorPowerCommands(db,actor.campaign_id,parsedActor).map(({definition:_definition,...command})=>command);
    const response=actorPowersResponseSchema.parse({known,prepared:known,slots,uses,legalNow,legalCommands,revision});
    return {...response,campaignId:actor.campaign_id,actorId:parsedActor};
  }).deferred();

  return {getActorPowerSnapshot:readSnapshot,usePower(principal,input) {
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
    }});
  },useActorPower:(principal,actorId,input)=>executeActorPower(db,deps,guard,principal,actorId,input)};
}
