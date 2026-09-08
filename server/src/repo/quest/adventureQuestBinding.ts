import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { canonicalAgentJson, resourceIdSchema } from "@velvet/contracts";

export type AdventureQuestCandidateEvidence={version:"v1";turnId:string;campaignId:string;questRevision:number;questId:string;
  objectiveId:string;progress:number;targetProgress:number;questTitle:string;objectiveDescription:string};

export function makeAdventureQuestCandidate(evidence:AdventureQuestCandidateEvidence){
  const frame=canonicalAgentJson(evidence as never),hash=createHash("sha256").update(frame).digest("hex");
  return{candidateId:resourceIdSchema.parse(`quest-candidate:${hash.slice(0,48)}`),digest:hash};
}

export type BoundAdventureQuestReceipt={commandId:string;linkedAt:string;providerCallId:string;round:number;
  questId:string;objectiveId:string;questTitle:string;objectiveDescription:string;progressBefore:number;progressAfter:number;
  targetProgress:number;revisionBefore:number;revisionAfter:number;resultJson:string};

/** Reconstructs and verifies provider selection -> candidate -> immutable quest command provenance. */
export function boundAdventureQuestReceipts(db:DatabaseDriver.Database,campaignId:string,turnId:string):BoundAdventureQuestReceipt[]{
  const rows=db.prepare(`SELECT command.command_id,command.quest_id,command.expected_revision,command.resulting_revision,
      command.canonical_request_json,command.request_digest command_request_digest,receipt.canonical_result_json,receipt.result_digest,receipt.occurred_at,
      objective.description,objective.target_progress,response.provider_call_id,response.response_json,response.response_digest,
      provider_request.request_json,provider_request.request_digest provider_request_digest,provider_request.round_number,event.occurred_at event_occurred_at
    FROM adventure_turns turn JOIN agent_provider_responses_v39 response ON response.campaign_id=turn.campaign_id
      AND response.turn_id=turn.id AND response.status='succeeded' AND json_array_length(response.response_json,'$.calls')=1
      AND json_extract(response.response_json,'$.calls[0].toolName')='exact_quest_objective.select'
    JOIN agent_provider_contexts_v39 provider_request ON provider_request.context_id=response.context_id
    JOIN quest_domain_commands_v33 command ON command.campaign_id=turn.campaign_id AND command.principal_id=turn.principal_id
      AND command.command_type='advance-objective'
      AND command.idempotency_key='adventure-quest:'||substr(response.provider_call_id,-32)||':'
        ||substr(json_extract(response.response_json,'$.calls[0].arguments.candidateId'),-32)
    JOIN quest_domain_receipts_v33 receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
      AND receipt.resulting_revision=command.resulting_revision
    JOIN quest_domain_events_v33 event ON event.campaign_id=command.campaign_id AND event.command_id=command.command_id
      AND event.resulting_revision=command.resulting_revision AND event.event_type IN ('objective-advanced','quest-completed')
    JOIN quest_definitions_v33 quest_definition ON quest_definition.campaign_id=command.campaign_id
      AND quest_definition.quest_id=command.quest_id AND quest_definition.visibility='public'
    JOIN quest_objectives_v33 objective ON objective.campaign_id=command.campaign_id AND objective.quest_id=command.quest_id
      AND objective.objective_id=json_extract(command.canonical_request_json,'$.objectiveId') AND objective.visibility='public'
    WHERE turn.campaign_id=? AND turn.id=? ORDER BY command.command_id`).all(campaignId,turnId) as any[];
  return rows.flatMap((row)=>{
    const request=JSON.parse(row.canonical_request_json) as {objectiveId?:string};if(!request.objectiveId)return[];
    const response=JSON.parse(row.response_json) as any,providerRequest=JSON.parse(row.request_json) as any,selected=response?.calls?.[0]?.arguments;
    const advertised=Array.isArray(providerRequest?.questCandidateProjection?.candidates)?providerRequest.questCandidateProjection.candidates:[];
    if(createHash("sha256").update(row.request_json).digest("hex")!==row.provider_request_digest
      ||createHash("sha256").update(row.response_json).digest("hex")!==row.response_digest
      ||createHash("sha256").update(canonicalAgentJson(JSON.parse(row.canonical_request_json) as never)).digest("hex")!==row.command_request_digest
      ||createHash("sha256").update(canonicalAgentJson(JSON.parse(row.canonical_result_json) as never)).digest("hex")!==row.result_digest
      ||row.occurred_at!==row.event_occurred_at)throw new Error("adventure quest receipt evidence is malformed");
    const progressBefore=(db.prepare(`SELECT count(*) count FROM quest_domain_commands_v33 prior WHERE prior.campaign_id=?
      AND prior.quest_id=? AND prior.command_type='advance-objective' AND prior.resulting_revision<?
      AND json_extract(prior.canonical_request_json,'$.objectiveId')=?`).get(campaignId,row.quest_id,row.resulting_revision,request.objectiveId) as {count:number}).count;
    const projected=advertised.find((item:any)=>item?.candidateId===selected?.candidateId&&item?.digest===selected?.digest);
    if(!projected||typeof projected.questTitle!=="string"||typeof projected.objectiveDescription!=="string"
      ||projected.objectiveDescription!==row.description||projected.progress!==progressBefore
      ||projected.targetProgress!==row.target_progress)return[];
    const candidate=makeAdventureQuestCandidate({version:"v1",turnId,campaignId,questRevision:row.expected_revision,questId:row.quest_id,
      objectiveId:request.objectiveId,progress:progressBefore,targetProgress:row.target_progress,questTitle:projected.questTitle,
      objectiveDescription:projected.objectiveDescription});
    if(selected?.candidateId!==candidate.candidateId||selected?.digest!==candidate.digest
      ||!advertised.some((item:any)=>item?.candidateId===candidate.candidateId&&item?.digest===candidate.digest))return[];
    return[{commandId:row.command_id,linkedAt:row.occurred_at,providerCallId:row.provider_call_id,round:row.round_number,
      questId:row.quest_id,objectiveId:request.objectiveId,questTitle:projected.questTitle,objectiveDescription:projected.objectiveDescription,
      progressBefore,progressAfter:progressBefore+1,targetProgress:row.target_progress,revisionBefore:row.expected_revision,
      revisionAfter:row.resulting_revision,resultJson:row.canonical_result_json}];
  });
}
