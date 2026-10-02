import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../runtime.js";
import type { ContextInspectionProvenanceMode } from "./campaign/campaignContextInspectionProvenanceWrite.js";
import type { ActorGameplaySheetResponse, CommandEnvelope, PrivateAdventureTurn } from "@velvet/contracts";
import { createAdventureTurnReadRepository, createAdventureTurnWriteRepository,
  createAdventureTurnAgentExecutionRepository, type AdventureTurnAgentExecutionRepository,
  createAdventureTurnAgentResponseRepository, type AdventureTurnAgentResponseRepository,
  type AdventureTurnReadRepository, type AdventureTurnWriteRepository } from "./adventureTurn/index.js";

export * from "./adventureTurn/index.js";

/** Complete read/write adventure-turn and generation-draft repository. */
export interface AdventureTurnRepository extends AdventureTurnReadRepository, AdventureTurnWriteRepository, AdventureTurnAgentExecutionRepository, AdventureTurnAgentResponseRepository {
  /** Public, presently co-located NPC identities for player adventure narration. */
  getAdventureNarrationPresentNpcs(principalId: string, turnId: string): Array<{ npcId: string; name: string }>;
  /** Validates consent/context, executes mechanics, and links its receipt in one SQLite transaction. */
  executeApprovedAgentProposalAtomically(principalId:string,turnId:string,proposalId:string):
    {status:"committed"|"replan";turn:PrivateAdventureTurn;reason?:string};
}

type AgentCommandExecutors={
  executeSetActorAttribute(principalId:string,input:CommandEnvelope):{commandId:string};
  executeRollActorDice(principalId:string,input:CommandEnvelope):{commandId:string};
  resolveCombatAction(principalId:string,encounterId:string,input:any):unknown;
  executeInventoryAction(principalId:string,turnId:string,proposalId:string):{commandId:string};
  executeCommerceAction(principalId:string,turnId:string,proposalId:string):{commandId:string};
  executePowerRestAction(principalId:string,turnId:string,proposalId:string):{commandId:string};
  executeQuestProgressionAction(principalId:string,turnId:string,proposalId:string):{commandId:string};
};

/** Creates the composed M1.10 repository facade. */
export function createAdventureTurnRepository(db: DatabaseDriver.Database, dependencies: { clock: Clock; ids: IdGenerator; contextInspectionProvenance: ContextInspectionProvenanceMode;
  getActorGameplaySheet?: (principalId: string, actorId: string) => ActorGameplaySheetResponse | null }, guard: () => void,
  executors?:AgentCommandExecutors): AdventureTurnRepository {
  const reads = createAdventureTurnReadRepository(db);
  const writes=createAdventureTurnWriteRepository(db,{...dependencies,guard},reads);
  const responses=createAdventureTurnAgentResponseRepository(db,{...dependencies,guard});
  const base={...reads,...writes,...createAdventureTurnAgentExecutionRepository(db,{...dependencies,guard}),...responses};
  return {...base,getAdventureNarrationPresentNpcs(principalId,turnId){
    const turn = reads.getAdventureTurn(principalId, turnId);
    if (!turn || !("declaration" in turn)) return [];
    return db.prepare(`SELECT npc.npc_id npcId,npc.public_name name
      FROM campaign_npc_presence_v43 presence JOIN campaign_npcs_v28 npc USING(campaign_id,npc_id)
      WHERE presence.campaign_id=? AND presence.session_id=? AND presence.state='present'
        AND NOT EXISTS(SELECT 1 FROM campaign_generation_accepted_artifacts_v52 hidden
          WHERE hidden.campaign_id=npc.campaign_id AND hidden.server_resource_id=npc.npc_id AND hidden.visibility='gm')
        AND (presence.location_id IS NULL OR EXISTS(SELECT 1 FROM campaign_actor_locations_v28 current
          JOIN campaign_locations_v28 location ON location.campaign_id=current.campaign_id AND location.location_id=current.location_id
          WHERE current.campaign_id=presence.campaign_id AND current.session_id=presence.session_id
            AND current.actor_id=? AND current.location_id=presence.location_id AND location.visibility='public'))
      ORDER BY npc.npc_id LIMIT 12`).all(turn.campaignId,turn.sessionId,turn.actorId) as Array<{npcId:string;name:string}>;
  },executeApprovedAgentProposalAtomically(principalId,turnId,proposalId){
    guard();if(!executors)throw new Error("agent command executors are unavailable");
    return db.transaction(()=>{
      const current=reads.getAdventureTurn(principalId,turnId);
      if(!current||!("declaration" in current))throw new Error("adventure turn is unavailable");
      const validation=responses.validateApprovedAgentProposal(principalId,turnId,proposalId);
      if(!validation.valid){
        const replanned=writes.replanAgentProposal(principalId,{turnId,proposalId,reason:validation.reason,
          expectedTurnRevision:current.revision,expectedCampaignRevision:current.campaignRevision,
          idempotencyKey:`agent-replan:${createHash("sha256").update(`${turnId}\0${proposalId}\0${validation.reason}`).digest("hex").slice(0,48)}`});
        return{status:"replan" as const,turn:replanned,reason:validation.reason};
      }
      const call=current.toolCalls.find((item)=>item.proposal.proposalId===proposalId);
      if(!call)throw new Error("approved proposal is unavailable");
      const binding=call.proposal.executionBinding,args=JSON.parse(call.proposal.argumentsJson) as any;
      try{
        db.transaction(()=>{if(binding.commandType==="inventory_action"){
          executors.executeInventoryAction(principalId,turnId,proposalId);
        }else if(binding.commandType==="commerce_action"){
          executors.executeCommerceAction(principalId,turnId,proposalId);
         }else if(binding.commandType==="power_action"||binding.commandType==="rest_action"||binding.commandType==="combat_consumable_action"||binding.commandType==="combat_power_action"){
           executors.executePowerRestAction(principalId,turnId,proposalId);
         }else if(binding.commandType==="quest_lifecycle_action"||binding.commandType==="progression_action"){
           executors.executeQuestProgressionAction(principalId,turnId,proposalId);
        }else if(binding.commandType==="combat_action"){
          executors.resolveCombatAction(principalId,binding.encounterId,{legalActionId:binding.legalActionId,
            targetIds:args.targetId?[args.targetId]:[],choices:[],expectedRevision:binding.expectedCombatRevision,idempotencyKey:binding.idempotencyKey});
          responses.linkAgentCombatReceipt(principalId,{turnId,encounterId:binding.encounterId,
            idempotencyKey:binding.idempotencyKey,proposalId});
        }else{
          const envelope={commandId:`agent-command:${createHash("sha256").update(`${turnId}\0${proposalId}`).digest("hex").slice(0,48)}`,
            idempotencyKey:binding.idempotencyKey,campaignId:current.campaignId,timelineId:current.timelineId,actorId:current.actorId,
            expectedRevision:args.expectedTimelineRevision,sourceTurnId:turnId,command:binding.commandType==="set_actor_attribute"
              ?{type:"set_actor_attribute" as const,payload:{attributeId:args.attributeId,value:args.value}}
              :{type:"roll_actor_dice" as const,payload:{expression:args.expression}}};
          const receipt=binding.commandType==="set_actor_attribute"?executors.executeSetActorAttribute(principalId,envelope)
            :executors.executeRollActorDice(principalId,envelope);
          const after=reads.getAdventureTurn(principalId,turnId);
          if(!after||!("declaration" in after))throw new Error("adventure turn is unavailable");
          writes.linkFinalMechanicsReceipt(principalId,{turnId,proposalId,commandId:receipt.commandId,
            expectedTurnRevision:after.revision,expectedCampaignRevision:after.campaignRevision,
            idempotencyKey:`agent-link:${createHash("sha256").update(`${turnId}\0${proposalId}`).digest("hex").slice(0,48)}`});
        }}).immediate();
      }catch{
        responses.requireAgentProposalReplan(principalId,turnId,proposalId,"command-stale");
        const replanned=writes.replanAgentProposal(principalId,{turnId,proposalId,reason:"command-stale",
          expectedTurnRevision:current.revision,expectedCampaignRevision:current.campaignRevision,
          idempotencyKey:`agent-replan:${createHash("sha256").update(`${turnId}\0${proposalId}\0command-stale`).digest("hex").slice(0,48)}`});
        return{status:"replan" as const,turn:replanned,reason:"command-stale"};
      }
      const committed=reads.getAdventureTurn(principalId,turnId);
      if(!committed||!("declaration" in committed))throw new Error("adventure turn is unavailable");
      return{status:"committed" as const,turn:committed};
    }).immediate();
  }};
}
