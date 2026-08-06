import type DatabaseDriver from "better-sqlite3";
import { actorInventorySchema, inventoryCommandSchema, resourceIdSchema, type ActorInventory, type InventoryCommand } from "@velvet/contracts";
import { ActorResourceConflictError, ActorResourceNegativeError, getM15ActorRevision, m15Authorized, runM15Mutation, type M15Dependencies, type M15Result } from "./actorResourceRepo.js";

export class InventoryAuthorizationError extends Error { readonly code="INVENTORY_FORBIDDEN"; }
export class InventoryCapacityError extends Error { readonly code="INVENTORY_CAPACITY"; }
export class InventorySlotConflictError extends Error { readonly code="INVENTORY_SLOT_CONFLICT"; }
export class InventoryBindingError extends Error { readonly code="INVENTORY_BINDING"; }
export class InventoryStaleError extends Error { readonly code="INVENTORY_STALE"; }

export interface ActorInventorySnapshot { campaignId:string; actorId:string; inventory:ActorInventory["inventory"]; equipment:ActorInventory["equipment"]; revision:number; }
export type ActorScopedInventoryCommand=
  |{kind:"equip";entryId:string;slot:string;expectedRevision:number;idempotencyKey:string}
  |{kind:"unequip";slot:string;expectedRevision:number;idempotencyKey:string}
  |{kind:"consume"|"drop";entryId:string;item:{kind:"item";packId:string;packVersion:string;definitionId:string};quantity:number;expectedRevision:number;idempotencyKey:string}
  |{kind:"gift";recipientActorId:string;entryId:string;item:{kind:"item";packId:string;packVersion:string;definitionId:string};quantity:number;expectedRevision:number;idempotencyKey:string};
export interface InventoryRepository {
  getActorInventorySnapshot(principal:string,campaignId:string,actorId:string):ActorInventorySnapshot|null;
  mutateInventoryForActor(principal:string,campaignId:string,actorId:string,input:ActorScopedInventoryCommand):M15Result<{inventory:ActorInventory}>;
}
export function createInventoryRepository(db:DatabaseDriver.Database,deps:M15Dependencies,assertMutation:()=>void):InventoryRepository {
  const capacity=(campaign:string,actor:string)=>((db.prepare("SELECT max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='inventory-capacity'").get(campaign,actor) as any)?.max??1000);
  const read=(principal:string,campaign:string,actor:string):ActorInventory|null=>{resourceIdSchema.parse(principal);resourceIdSchema.parse(campaign);resourceIdSchema.parse(actor);if(!m15Authorized(db,principal,campaign,actor))return null;
    const rows=db.prepare("SELECT * FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? ORDER BY created_at,entry_id").all(campaign,actor) as any[];
    const items=rows.map((row)=>row.entry_mode==='stackable'
      ?{kind:'stackable' as const,entryId:row.entry_id,item:{kind:'item' as const,packId:row.item_pack_id,packVersion:row.item_pack_version,definitionId:row.item_definition_id},quantity:row.quantity}
      :{kind:'instanced' as const,entryId:row.entry_id,item:{kind:'item' as const,packId:row.item_pack_id,packVersion:row.item_pack_version,definitionId:row.item_definition_id}});
    return actorInventorySchema.parse({campaignId:campaign,actorId:actor,inventory:{capacity:capacity(campaign,actor),items},equipment:rows.filter(row=>row.equipped).map(row=>({slot:row.slot_key,entryId:row.entry_id}))});};
  /** Lazily materialize the additive FK parent from the existing canonical
   * campaign pin.  A normal configured campaign therefore needs no private
   * SQL fixture setup, while an unpinned reference still fails closed. */
  const itemPinned=(campaign:string,item:any)=>{
    const existing=db.prepare("SELECT 1 FROM rpg_campaign_catalog_definitions_v25 WHERE campaign_id=? AND pack_id=? AND pack_version=? AND kind='item' AND definition_id=?").get(campaign,item.packId,item.packVersion,item.definitionId);
    if(existing)return true;
    const valid=Boolean(db.prepare(`SELECT 1 FROM campaign_catalog_current_pins pin JOIN rpg_catalog_definitions definition
      ON definition.pack_id=pin.pack_id AND definition.pack_version=pin.pack_version
      WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=? AND definition.kind='item' AND definition.definition_id=?`).get(campaign,item.packId,item.packVersion,item.definitionId));
    if(valid)db.prepare("INSERT INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,'item',?)").run(campaign,item.packId,item.packVersion,item.definitionId);
    return valid;
  };
  const snapshot=(principal:string,campaign:string,actor:string):ActorInventorySnapshot|null=>db.transaction(()=>{
    resourceIdSchema.parse(principal);resourceIdSchema.parse(campaign);resourceIdSchema.parse(actor);
    if(!m15Authorized(db,principal,campaign,actor))return null;
    const inventory=read(principal,campaign,actor);
    return inventory?{campaignId:campaign,actorId:actor,inventory:inventory.inventory,equipment:inventory.equipment,revision:getM15ActorRevision(db,campaign,actor)}:null;
  })();
  const mutate=(principal:string,input:InventoryCommand)=>{const command=inventoryCommandSchema.parse(input),changed=[`inventory:${command.actorId}`];if('recipientActorId'in command)changed.push(`inventory:${command.recipientActorId}`);
    return runM15Mutation(db,deps,assertMutation,{principal,campaignId:command.campaignId,actorId:command.actorId,family:'inventory',type:command.type,expectedRevision:command.expectedRevision,idempotencyKey:command.idempotencyKey,request:command,changedKeys:changed,additionalActorIds:command.type==='transfer_inventory_item'?[command.recipientActorId]:[],apply:(_revision,now)=>{
      if(!m15Authorized(db,principal,command.campaignId,command.actorId))throw new InventoryAuthorizationError('inventory unavailable');
      const entry=('entryId'in command)?db.prepare("SELECT * FROM rpg_inventory_entries_v25 WHERE entry_id=? AND campaign_id=? AND actor_id=?").get(command.entryId,command.campaignId,command.actorId) as any:undefined;
      const remove=(quantity:number)=>{if(!entry)throw new ActorResourceConflictError('inventory entry is unavailable');if(entry.equipped)throw new InventoryBindingError('equipped item must be unequipped first');if(quantity>entry.quantity)throw new ActorResourceNegativeError('inventory quantity cannot become negative');if(quantity===entry.quantity)db.prepare("DELETE FROM rpg_inventory_entries_v25 WHERE entry_id=?").run(entry.entry_id);else db.prepare("UPDATE rpg_inventory_entries_v25 SET quantity=quantity-? WHERE entry_id=?").run(quantity,entry.entry_id);};
      if(command.type==='add_inventory_item'){
        if(!itemPinned(command.campaignId,command.item.item))throw new ActorResourceConflictError('item is not pinned by campaign catalog');
        if(command.item.kind==='stackable'){const same=db.prepare(`SELECT entry_id FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? AND entry_mode='stackable' AND item_pack_id=? AND item_pack_version=? AND item_definition_id=?`).get(command.campaignId,command.actorId,command.item.item.packId,command.item.item.packVersion,command.item.item.definitionId) as any;
          if(same)db.prepare("UPDATE rpg_inventory_entries_v25 SET quantity=quantity+? WHERE entry_id=?").run(command.item.quantity,same.entry_id);else {if((read(principal,command.campaignId,command.actorId)?.inventory.items.length??0)>=capacity(command.campaignId,command.actorId))throw new InventoryCapacityError('inventory is full');db.prepare("INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at) VALUES(?,?,?,?,?, 'item',?,'stackable',?,NULL,NULL,0,?)").run(command.item.entryId,command.campaignId,command.actorId,command.item.item.packId,command.item.item.packVersion,command.item.item.definitionId,command.item.quantity,now);}}
        else {if(!itemPinned(command.campaignId,command.item.item))throw new ActorResourceConflictError('item is not pinned by campaign catalog');if((read(principal,command.campaignId,command.actorId)?.inventory.items.length??0)>=capacity(command.campaignId,command.actorId))throw new InventoryCapacityError('inventory is full');db.prepare("INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at) VALUES(?,?,?,?,?,'item',?,'instanced',1,?,NULL,0,?)").run(command.item.entryId,command.campaignId,command.actorId,command.item.item.packId,command.item.item.packVersion,command.item.item.definitionId,command.item.entryId,now);}
      } else if(command.type==='remove_inventory_item') remove(command.quantity??entry?.quantity??0);
      else if(command.type==='consume_inventory_item'||command.type==='drop_inventory_item') {if(!entry||entry.item_pack_id!==command.item.packId||entry.item_pack_version!==command.item.packVersion||entry.item_definition_id!==command.item.definitionId)throw new ActorResourceConflictError('inventory item identity differs');remove(command.quantity);}
      else if(command.type==='equip_inventory_item'){if(!entry)throw new ActorResourceConflictError('inventory entry unavailable');if(entry.equipped)throw new InventorySlotConflictError('entry is already equipped');if(db.prepare("SELECT 1 FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? AND equipped=1 AND slot_key=?").get(command.campaignId,command.actorId,command.slot))throw new InventorySlotConflictError('equipment slot is occupied');db.prepare("UPDATE rpg_inventory_entries_v25 SET equipped=1,slot_key=? WHERE entry_id=?").run(command.slot,entry.entry_id);}
      else if(command.type==='unequip_inventory_item'){const equipped=db.prepare("SELECT entry_id FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? AND equipped=1 AND slot_key=?").get(command.campaignId,command.actorId,command.slot)as any;if(!equipped)throw new InventorySlotConflictError('equipment slot is empty');db.prepare("UPDATE rpg_inventory_entries_v25 SET equipped=0,slot_key=NULL WHERE entry_id=?").run(equipped.entry_id);}
      else if(command.type==='set_inventory_capacity'){if(command.capacity<(read(principal,command.campaignId,command.actorId)?.inventory.items.length??0))throw new InventoryCapacityError('capacity is below occupied entries');db.prepare("INSERT INTO rpg_actor_resources(campaign_id,actor_id,name,current,max) VALUES(?,?, 'inventory-capacity',0,?) ON CONFLICT(actor_id,name) DO UPDATE SET max=excluded.max").run(command.campaignId,command.actorId,command.capacity);}
       else if(command.type==='transfer_inventory_item'){
         if(!entry||entry.item_pack_id!==command.item.packId||entry.item_pack_version!==command.item.packVersion||entry.item_definition_id!==command.item.definitionId)throw new ActorResourceConflictError('inventory item identity differs');
         if(entry.equipped)throw new InventoryBindingError('equipped item must be unequipped first');
         if(command.quantity>entry.quantity)throw new ActorResourceNegativeError('inventory quantity cannot become negative');
         if(entry.entry_mode==='instanced') {
           if(command.quantity!==1)throw new ActorResourceConflictError('an instanced item has quantity one');
           if((read(principal,command.campaignId,command.recipientActorId)?.inventory.items.length??0)>=capacity(command.campaignId,command.recipientActorId))throw new InventoryCapacityError('recipient inventory is full');
           // Ownership changes; the durable instance identity does not.
           db.prepare("UPDATE rpg_inventory_entries_v25 SET actor_id=?,slot_key=NULL,equipped=0 WHERE entry_id=?").run(command.recipientActorId,entry.entry_id);
         } else {
           const destination=db.prepare("SELECT entry_id FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? AND entry_mode='stackable' AND item_pack_id=? AND item_pack_version=? AND item_definition_id=?").get(command.campaignId,command.recipientActorId,entry.item_pack_id,entry.item_pack_version,entry.item_definition_id) as any;
           if(!destination&&(read(principal,command.campaignId,command.recipientActorId)?.inventory.items.length??0)>=capacity(command.campaignId,command.recipientActorId))throw new InventoryCapacityError('recipient inventory is full');
           remove(command.quantity);
           if(destination) db.prepare("UPDATE rpg_inventory_entries_v25 SET quantity=quantity+? WHERE entry_id=?").run(command.quantity,destination.entry_id);
           else db.prepare("INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at) VALUES(?,?,?,?,?,'item',?,'stackable',?,NULL,NULL,0,?)").run(deps.ids.nextId(),command.campaignId,command.recipientActorId,command.item.packId,command.item.packVersion,command.item.definitionId,command.quantity,now);
         }
       }
      return {inventory:read(principal,command.campaignId,command.actorId)!};
    }});
    };
  return {getActorInventorySnapshot:snapshot,mutateInventoryForActor(principal,campaignId,actorId,input){
    const command:InventoryCommand=input.kind==="equip"?{type:"equip_inventory_item",campaignId,actorId,entryId:input.entryId,slot:input.slot as any,expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey}
      :input.kind==="unequip"?{type:"unequip_inventory_item",campaignId,actorId,slot:input.slot as any,expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey}
      :input.kind==="gift"?{type:"transfer_inventory_item",campaignId,actorId,recipientActorId:input.recipientActorId,entryId:input.entryId,item:input.item,quantity:input.quantity,expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey}
      :{type:input.kind==="consume"?"consume_inventory_item":"drop_inventory_item",campaignId,actorId,entryId:input.entryId,item:input.item,quantity:input.quantity,expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey};
    return mutate(principal,command);
  }};
}
