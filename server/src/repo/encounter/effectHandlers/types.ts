import type DatabaseDriver from "better-sqlite3";
import { abilityCatalogDefinitionSchema, spellCatalogDefinitionSchema, type PowerReference } from "@velvet/contracts";
import type { EncounterDependencies } from "../encounterWriteRepo.js";

export type Row={combatant_id:string;actor_id:string|null;team:string;hit_points:number;maximum_hit_points:number;status:string;state_revision:number};
export type Definition=ReturnType<typeof abilityCatalogDefinitionSchema.parse>|ReturnType<typeof spellCatalogDefinitionSchema.parse>;
export type CombatPowerLegalAction={legalActionId:string;encounterId:string;campaignId:string;actingCombatantId:string;sourceActorId:string;
  targetCombatantId:string;targetActorId:string|null;powerRef:PowerReference;definition:Definition;cost:{kind:"slot";id:string}|{kind:"ability-use";id:string}|{kind:"resource";id:string;amount:number}|null};
export type CombatPowerRequest={legalActionId:string;powerRef:PowerReference;targetCombatantId:string;expectedCombatRevision:number;
  expectedSourceM15Revision:number;expectedSourceM16Revision:number;expectedTargetM15Revision:number|null;expectedTargetM16Revision:number|null;idempotencyKey:string};
export type CombatPowerResult={commandId:string;powerName:string;targetCombatantId:string;cost:{label:string;before:number;after:number}|null;
  outcomes:any[];concentration:boolean;roundBefore:number;roundAfter:number;revisionBefore:number;revisionAfter:number;occurredAt:string};
export type CombatPowerBoundary="costs"|"effects"|"combatant"|"combat"|"log"|"receipt";

export interface EffectContext {
  db:DatabaseDriver.Database;
  deps:EncounterDependencies;
  action:CombatPowerLegalAction;
  target:Row;
  dnd:boolean;
  at:string;
  hp:number;
  outcomes:any[];
  tempHitPointGrants:Array<{outcome:any;amount:number}>;
  effects:any[];
  rage:boolean;
  layOnHands:boolean;
}
