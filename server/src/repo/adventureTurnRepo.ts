import type DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import type { Clock, IdGenerator } from "../runtime.js";
import type { CommandEnvelope, PrivateAdventureTurn } from "@velvet/contracts";
import { createAdventureTurnReadRepository, createAdventureTurnWriteRepository,
  createAdventureTurnAgentExecutionRepository, type AdventureTurnAgentExecutionRepository,
  createAdventureTurnAgentResponseRepository, type AdventureTurnAgentResponseRepository,
  type AdventureTurnReadRepository, type AdventureTurnWriteRepository } from "./adventureTurn/index.js";

export * from "./adventureTurn/index.js";

/** Complete read/write adventure-turn and generation-draft repository. */
export interface AdventureTurnRepository extends AdventureTurnReadRepository, AdventureTurnWriteRepository, AdventureTurnAgentExecutionRepository, AdventureTurnAgentResponseRepository {
  /** Validates consent/context, executes mechanics, and links its receipt in one SQLite transaction. */
  executeApprovedAgentProposalAtomically(principalId:string,turnId:string,proposalId:string):
    {status:"committed"|"replan";turn:PrivateAdventureTurn;reason?:string};
}

type AgentCommandExecutors={
  executeSetActorAttribute(principalId:string,input:CommandEnvelope):{commandId:string};
  executeRollActorDice(principalId:string,input:CommandEnvelope):{commandId:string};
  resolveCombatAction(principalId:string,encounterId:string,input:any):unknown;
};

/** Creates the composed M1.10 repository facade. */
export function createAdventureTurnRepository(db: DatabaseDriver.Database, dependencies: { clock: Clock; ids: IdGenerator }, guard: () => void,
  executors?:AgentCommandExecutors): AdventureTurnRepository {
  const reads = createAdventureTurnReadRepository(db);
  const writes=createAdventureTurnWriteRepository(db,{...dependencies,guard},reads);
  const responses=createAdventureTurnAgentResponseRepository(db,{...dependencies,guard});
  const base={...reads,...writes,...createAdventureTurnAgentExecutionRepository(db,{...dependencies,guard}),...responses};
  return {...base,executeApprovedAgentProposalAtomically(principalId,turnId,proposalId){
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
        db.transaction(()=>{if(binding.commandType==="combat_action"){
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
