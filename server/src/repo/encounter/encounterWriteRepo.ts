import type DatabaseDriver from "better-sqlite3";
import {
  type CombatActionCommandRequest,
  type CombatActionResolution,
  type CombatEndCommandRequest,
  type CombatEnemyTurnCommandRequest,
  type EncounterCommand,
  type EncounterCreateRequest,
  type EncounterStartCommandRequest,
  type UseConsumableCommandRequest,
  type UseConsumableCommandResult,
} from "@velvet/contracts";
import type { EncounterCombatSnapshot, EncounterLifecycleSnapshot } from "./encounterReadRepo.js";
import { EncounterUnavailableError } from "./encounterErrors.js";
import { executeUseConsumable } from "./useConsumableRuntime.js";
import { buildCombatPowerLegalActions, executeCombatPower, getCombatPowerResultByKey, type CombatPowerRequest, type CombatPowerResult } from "./combatPowerRuntime.js";
import { initiateCombatFromTarget as executeInitiateCombatFromTarget, type InitiateCombatInput, type InitiateCombatResult } from "./initiateCombat.js";
import { now, type EncounterResult, type EncounterRewardGrantSnapshot, type EncounterWriteDependencies } from "./actionExecution/shared.js";
import { createCreateLifecycleEncounter, createStartLifecycleEncounter } from "./actionExecution/lifecycle.js";
import { createResolveCombatAction } from "./actionExecution/attack.js";
import { createExecuteCombatEnemyTurn } from "./actionExecution/enemyTurn.js";
import { createEndCombat } from "./actionExecution/rewards.js";
import { createExecute } from "./actionExecution/command.js";

export type { EncounterDependencies, EncounterReceipt, EncounterResult, EncounterRewardGrantSnapshot, EncounterWriteDependencies } from "./actionExecution/shared.js";
export { contestScore } from "./actionExecution/survival.js";

/** State-changing encounter commands. */
export interface EncounterWriteRepository {
  createEncounter(principal:string,campaignId:string,input:EncounterCreateRequest):EncounterResult<{campaignId:string;encounter:EncounterLifecycleSnapshot}>;
  startEncounter(principal:string,encounterId:string,input:EncounterStartCommandRequest):EncounterResult<{campaignId:string;encounterId:string;combat:EncounterCombatSnapshot}>;
  resolveCombatAction(principal:string,combatId:string,input:CombatActionCommandRequest):EncounterResult<{campaignId:string;encounterId:string;resolution:CombatActionResolution;combat:EncounterCombatSnapshot}>;
  executeCombatEnemyTurn(principal:string,combatId:string,input:CombatEnemyTurnCommandRequest):EncounterResult<{campaignId:string;encounterId:string;resolution:CombatActionResolution;combat:EncounterCombatSnapshot}>;
  endCombat(principal:string,combatId:string,input:CombatEndCommandRequest):EncounterResult<{campaignId:string;encounterId:string;encounter:EncounterLifecycleSnapshot;rewards:EncounterRewardGrantSnapshot[]}>;
  executeEncounterCommand(principal:string, command:EncounterCommand):EncounterResult<{encounterId:string;status:string}>;
  mutateEncounter(principal:string, command:EncounterCommand):EncounterResult<{encounterId:string;status:string}>;
  useConsumable(principal:string,input:UseConsumableCommandRequest):UseConsumableCommandResult;
  useCombatPower(principal:string,input:CombatPowerRequest):CombatPowerResult;
  getCombatPowerLegalActions(principal:string,combatId:string):Array<ReturnType<typeof buildCombatPowerLegalActions>[number]&{revisions:{combat:number;sourceM15:number;sourceM16:number;targetM15:number|null;targetM16:number|null}}>;
  getCombatPowerResultByKey(principal:string,combatId:string,idempotencyKey:string):{request:CombatPowerRequest;result:CombatPowerResult}|null;
  /**
   * Materializes and starts one encounter when a player attacks a visible campaign target.
   * `principal` is the initiating principal: the service authorizes it against the actor and
   * routes start through the campaign GM authority, exactly like GM-created encounters.
   */
  initiateCombatFromTarget(principal:string,input:Omit<InitiateCombatInput,"principalId">):InitiateCombatResult;
  claimCombatReward(principal:string,combatId:string,rewardBundleId:string,input:{rewardClaimId:string;expectedRevision:number;idempotencyKey:string}):EncounterResult<{encounterId:string;status:string}>;
}

/** Creates immediate-transaction commands backed by the authoritative read projection. */
export function createEncounterWriteRepository(db:DatabaseDriver.Database,deps:EncounterWriteDependencies):EncounterWriteRepository {
  const createEncounter=createCreateLifecycleEncounter(db,deps);
  const startEncounter=createStartLifecycleEncounter(db,deps);
  const resolveCombatAction=createResolveCombatAction(db,deps);
  const executeCombatEnemyTurn=createExecuteCombatEnemyTurn(db,deps);
  const endCombat=createEndCombat(db,deps);
  const execute=createExecute(db,deps,resolveCombatAction);
  return {createEncounter,startEncounter,resolveCombatAction,executeCombatEnemyTurn,endCombat,
    claimCombatReward(principal,combatId,rewardBundleId,input){
      const bundle=db.prepare(`SELECT campaign_id,reward_bundle_id,recipient_actor_id FROM reward_bundle
        WHERE encounter_id=? AND reward_bundle_id=? AND recipient_actor_id IN(SELECT actor_id FROM campaign_actor_private_state WHERE controller_principal_id=?)`)
        .get(combatId,rewardBundleId,principal) as any;
      if(!bundle)throw new EncounterUnavailableError("reward bundle unavailable");
      return execute(principal,{type:"claim_reward_bundle",campaignId:bundle.campaign_id,encounterId:combatId,
        rewardClaimId:input.rewardClaimId,rewardBundleId:bundle.reward_bundle_id,recipientActorId:bundle.recipient_actor_id,
        claimedAt:now(deps),expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey});
    },
    executeEncounterCommand:execute,mutateEncounter:execute,
    useConsumable(principal,input){deps.assertFactoryMutation();return executeUseConsumable(db,deps,principal,input);},
    useCombatPower(principal,input){deps.assertFactoryMutation();return executeCombatPower(db,deps,principal,input);},
    initiateCombatFromTarget(principal,input){return executeInitiateCombatFromTarget(db,deps,{...input,principalId:principal});},
    getCombatPowerLegalActions(principal,combatId){const actions=buildCombatPowerLegalActions(db,principal,combatId);const combat=(db.prepare("SELECT revision FROM combat_mutation_revisions_v27 WHERE encounter_id=?").get(combatId)as any)?.revision;if(combat===undefined)return[];const rev=(family:"m15"|"m16",campaignId:string,actorId:string)=>(db.prepare(`SELECT revision FROM rpg_${family}_mutation_revisions_v${family==="m15"?"25":"26"} WHERE campaign_id=? AND actor_id=?`).get(campaignId,actorId)as any)?.revision??0;return actions.map(action=>({...action,revisions:{combat,sourceM15:rev("m15",action.campaignId,action.sourceActorId),sourceM16:rev("m16",action.campaignId,action.sourceActorId),targetM15:action.targetActorId?rev("m15",action.campaignId,action.targetActorId):null,targetM16:action.targetActorId?rev("m16",action.campaignId,action.targetActorId):null}}));},
    getCombatPowerResultByKey(principal,combatId,idempotencyKey){return getCombatPowerResultByKey(db,principal,combatId,idempotencyKey);}};
}
