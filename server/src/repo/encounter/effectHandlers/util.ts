import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema } from "@velvet/contracts";
import type { EncounterDependencies } from "../encounterWriteRepo.js";
import { EncounterConflictError } from "../encounterErrors.js";
import type { Definition } from "./types.js";

export const canonical=(value:unknown):string=>JSON.stringify(value,(_key,nested)=>nested&&typeof nested==="object"&&!Array.isArray(nested)
  ?Object.fromEntries(Object.keys(nested).sort().map(key=>[key,nested[key]])):nested);
export const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
export const nextId=(deps:EncounterDependencies)=>resourceIdSchema.parse(deps.ids.nextId());
export const exactlyOne=(result:{changes:number},message:string)=>{if(result.changes!==1)throw new EncounterConflictError(message);};
export const revision=(db:DatabaseDriver.Database,family:"m15"|"m16",campaignId:string,actorId:string)=>(db.prepare(`SELECT revision FROM rpg_${family}_mutation_revisions_v${family==="m15"?"25":"26"} WHERE campaign_id=? AND actor_id=?`).get(campaignId,actorId)as any)?.revision??0;
export const RAGE="srd-5.1:ability:barbarian-rage",LAY_ON_HANDS="srd-5.1:ability:paladin-lay-on-hands";
export const feature=(definition:Definition)=>definition.reference.kind==="ability"?definition.reference.definitionId:null;
