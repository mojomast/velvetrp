import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { canonicalAgentJson, exactCandidateSelectionResponseSchema,
  providerSafeExactCandidateListSchema, resourceIdSchema, type ExactCandidateExecutionResult } from "@velvet/contracts";
import type { ExactCandidateRepository } from "./repository.js";
import { ExactCandidateConflictError, ExactCandidateIntegrityError, ExactCandidateUnavailableError } from "./errors.js";
import type { Clock, IdGenerator } from "../../runtime.js";
import { assertExactCandidateProviderBinding } from "./providerBindingIntegrity.js";

export interface BindExactCandidateProviderExecutionInput {
  turnId:string;providerCallId:string;providerToolCallId:string;round:number;selection:unknown;requireCommittedExecution?:boolean;
}
export interface ExactCandidateProviderBridgeRepository {
  bindExactCandidateProviderExecution(principalId:string,input:BindExactCandidateProviderExecutionInput):ExactCandidateExecutionResult;
  getExactCandidateTravelNarrationReceipt(principalId:string,turnId:string,commandId:string):{destination:string}|null;
  getExactCandidateTravelPublicReceipt(principalId:string,campaignId:string,commandId:string):
    {destination:string;revisionBefore:number;revisionAfter:number;occurredAt:string}|null;
}

/** Creates the v48 recovery-safe provider/selection/execution binding lane. */
export function createExactCandidateProviderBridgeRepository(db:DatabaseDriver.Database,deps:{clock:Clock;ids:IdGenerator},guard:()=>void,
  candidates:ExactCandidateRepository):ExactCandidateProviderBridgeRepository {
  const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
  const verifyBoundExecution=(binding:any,principalId:string,turnId:string,selection:ReturnType<typeof exactCandidateSelectionResponseSchema.parse>)=>{
    if(binding.turn_id!==turnId||binding.provider_call_id===undefined)throw new ExactCandidateIntegrityError("provider exact-candidate binding ancestry is invalid");
    assertExactCandidateProviderBinding(db,binding.binding_id);
    if(binding.provider_call_id!==undefined&&binding.selection_json!==canonicalAgentJson(selection as never))
      throw new ExactCandidateConflictError("provider exact-candidate binding changed");
    return candidates.executeExactActorTravelCandidate(principalId,{turnId,selection});
  };
  return {getExactCandidateTravelPublicReceipt(principalId,campaignId,commandId){
    resourceIdSchema.parse(principalId);resourceIdSchema.parse(campaignId);resourceIdSchema.parse(commandId);
    const authorized=db.prepare(`SELECT binding.binding_id,binding.turn_id,binding.selection_json,candidate.principal_id,location.public_name destination
      FROM exact_candidate_provider_bindings_v48 binding
      JOIN campaign_memberships membership ON membership.campaign_id=binding.campaign_id AND membership.principal_id=?
      JOIN exact_candidates_v46 candidate ON candidate.candidate_id=binding.candidate_id AND candidate.campaign_id=binding.campaign_id
      JOIN exact_candidate_executions_v47 execution ON execution.execution_id=binding.execution_id
        AND execution.candidate_id=binding.candidate_id AND execution.world_command_id=binding.world_command_id
      JOIN world_travel_destinations_v28 destination ON destination.campaign_id=binding.campaign_id
        AND destination.command_id=binding.world_command_id
      JOIN campaign_location_connections_v28 connection ON connection.campaign_id=binding.campaign_id
        AND connection.connection_id=destination.connection_id
      JOIN campaign_locations_v28 location ON location.campaign_id=binding.campaign_id
        AND location.location_id=execution.destination_location_id
      WHERE binding.campaign_id=? AND binding.world_command_id=?
        AND connection.visibility IN('public','discovered') AND location.visibility IN('public','discovered')
        AND ((connection.visibility='public' AND location.visibility='public') OR (
          candidate.principal_id=?
          AND (membership.role IN('owner','gm') OR EXISTS(SELECT 1 FROM campaign_actor_private_state control
            WHERE control.campaign_id=binding.campaign_id AND control.actor_id=execution.actor_id AND control.controller_principal_id=?))
          AND EXISTS(SELECT 1 FROM campaign_location_discoveries_v28 discovery
            WHERE discovery.campaign_id=binding.campaign_id AND discovery.actor_id=execution.actor_id
              AND discovery.location_id=execution.destination_location_id)))`)
      .get(principalId,campaignId,commandId,principalId,principalId) as {binding_id:string;turn_id:string;selection_json:string;principal_id:string;destination:string}|undefined;
    if(!authorized)return null;
    // Candidate execution replay verifies the complete issuance,
    // selection, world command, receipt, event, destination, and party evidence.
    assertExactCandidateProviderBinding(db,authorized.binding_id);
    const selection=exactCandidateSelectionResponseSchema.parse(JSON.parse(authorized.selection_json));
    const execution=candidates.verifyExactCandidateExecution(selection.candidateId);
    if(execution.actorTravelResult.receipt.commandId!==commandId||execution.linkedCandidate.scope.campaignId!==campaignId)
      throw new ExactCandidateIntegrityError("public travel receipt binding is invalid");
    return {destination:authorized.destination,revisionBefore:execution.actorTravelResult.receipt.revisionBefore,
      revisionAfter:execution.actorTravelResult.receipt.revisionAfter,occurredAt:execution.actorTravelResult.receipt.occurredAt};
  },getExactCandidateTravelNarrationReceipt(principalId,turnId,commandId){resourceIdSchema.parse(principalId);resourceIdSchema.parse(turnId);resourceIdSchema.parse(commandId);
    const row=db.prepare(`WITH RECURSIVE ancestry(id,campaign_id,prior_turn_id,mode,principal_id) AS (
        SELECT id,campaign_id,prior_turn_id,mode,principal_id FROM adventure_turns WHERE id=?
        UNION ALL SELECT parent.id,parent.campaign_id,parent.prior_turn_id,parent.mode,parent.principal_id FROM adventure_turns parent
          JOIN ancestry child ON child.prior_turn_id=parent.id AND child.campaign_id=parent.campaign_id)
      SELECT binding.*,location.public_name destination,connection.visibility connection_visibility,location.visibility destination_visibility,
        requested.id root_turn_id,requested.campaign_id root_campaign_id FROM ancestry requested
      JOIN adventure_turns visible ON visible.id=? AND visible.campaign_id=requested.campaign_id
      JOIN campaign_memberships member ON member.campaign_id=visible.campaign_id AND member.principal_id=?
      JOIN exact_candidate_provider_bindings_v48 binding ON binding.campaign_id=requested.campaign_id AND binding.turn_id=requested.id
       JOIN exact_candidate_executions_v47 execution ON execution.execution_id=binding.execution_id AND execution.turn_id=requested.id
      JOIN world_travel_destinations_v28 destination ON destination.campaign_id=binding.campaign_id AND destination.command_id=binding.world_command_id
      JOIN campaign_location_connections_v28 connection ON connection.campaign_id=binding.campaign_id AND connection.connection_id=destination.connection_id
      JOIN campaign_locations_v28 location ON location.campaign_id=binding.campaign_id AND location.location_id=execution.destination_location_id
      LEFT JOIN campaign_actor_private_state control ON control.campaign_id=visible.campaign_id AND control.actor_id=visible.actor_id
      WHERE requested.mode='original' AND binding.world_command_id=?
        AND connection.visibility IN('public','discovered') AND location.visibility IN('public','discovered')
        AND binding.turn_id=requested.id AND binding.campaign_id=requested.campaign_id
        AND visible.principal_id=requested.principal_id AND requested.principal_id=?
        AND (member.role IN('owner','gm') OR control.controller_principal_id=?)
        AND ((connection.visibility='public' AND location.visibility='public') OR EXISTS(
          SELECT 1 FROM campaign_location_discoveries_v28 discovery WHERE discovery.campaign_id=binding.campaign_id
            AND discovery.actor_id=execution.actor_id AND discovery.location_id=execution.destination_location_id))`)
       .get(turnId,turnId,principalId,commandId,principalId,principalId) as any;
     if(!row)return null;assertExactCandidateProviderBinding(db,row.binding_id);
     const selection=exactCandidateSelectionResponseSchema.parse(JSON.parse(row.selection_json)),execution=candidates.verifyExactCandidateExecution(selection.candidateId);
     if(row.root_turn_id!==row.turn_id||row.root_campaign_id!==row.campaign_id||execution.linkedCandidate.scope.campaignId!==row.campaign_id
       ||execution.actorTravelResult.receipt.commandId!==commandId)throw new ExactCandidateIntegrityError("travel narration receipt ancestry is invalid");
     return{destination:row.destination};
  },bindExactCandidateProviderExecution(principalId,input){guard();resourceIdSchema.parse(principalId);resourceIdSchema.parse(input.turnId);
    resourceIdSchema.parse(input.providerCallId);resourceIdSchema.parse(input.providerToolCallId);
    const selection=exactCandidateSelectionResponseSchema.parse(input.selection);
    const existing=db.prepare("SELECT * FROM exact_candidate_provider_bindings_v48 WHERE campaign_id=(SELECT campaign_id FROM adventure_turns WHERE id=?) AND turn_id=?")
      .get(input.turnId,input.turnId) as any;
    if(existing){if(existing.provider_call_id!==input.providerCallId||existing.provider_tool_call_id!==input.providerToolCallId
        ||existing.selection_json!==canonicalAgentJson(selection as never)||existing.round_number!==input.round)
        throw new ExactCandidateConflictError("provider exact-candidate binding changed");
      return verifyBoundExecution(existing,principalId,input.turnId,selection);}
    const response=db.prepare(`SELECT response.status,response.response_json,context.round_number,context.request_json FROM agent_provider_responses_v39 response
      JOIN agent_provider_contexts_v39 context ON context.context_id=response.context_id WHERE response.turn_id=? AND response.provider_call_id=?`)
      .get(input.turnId,input.providerCallId) as {status:string;response_json:string;round_number:number;request_json:string}|undefined;
    if(!response||response.status!=="succeeded"||response.round_number!==input.round)throw new ExactCandidateUnavailableError("settled provider selection is unavailable");
    const parsed=JSON.parse(response.response_json),call=parsed?.calls?.[0];
    if(parsed?.result!=="tool-calls"||parsed.calls.length!==1||call?.providerToolCallId!==input.providerToolCallId
      ||call?.toolName!=="exact_actor_travel.select"||call?.kind!=="mutation"
      ||canonicalAgentJson(call.arguments)!==canonicalAgentJson(selection as never))throw new ExactCandidateIntegrityError("provider selection settlement is invalid");
    const batchRow=db.prepare(`SELECT batch.batch_id,batch.issued_at FROM exact_candidate_batches_v46 batch JOIN exact_candidates_v46 candidate
      ON candidate.batch_id=batch.batch_id WHERE candidate.candidate_id=? AND batch.turn_id=?`).get(selection.candidateId,input.turnId) as {batch_id:string;issued_at:string}|undefined;
    if(!batchRow)throw new ExactCandidateIntegrityError("candidate provider batch is unavailable");
    if(input.requireCommittedExecution&&!db.prepare("SELECT 1 FROM exact_candidate_executions_v47 WHERE candidate_id=? AND turn_id=?")
      .get(selection.candidateId,input.turnId))throw new ExactCandidateUnavailableError("committed exact travel recovery is unavailable");
    const batch=candidates.getExactCandidateBatch(principalId,batchRow.batch_id);if(!batch)throw new ExactCandidateUnavailableError("candidate provider batch is unavailable");
    // Projection deliberately ignores mutable lifecycle overlays so recovery
    // after mechanics can reconstruct the exact safe list sent before execution.
    const projection=providerSafeExactCandidateListSchema.parse({version:"v1",candidates:batch.candidates.map((candidate)=>({
      candidateId:candidate.candidateId,kind:candidate.kind,version:candidate.version,label:candidate.label,summary:candidate.summary,
      confirmation:{required:candidate.confirmation.requirement==="required"},quote:candidate.quote,expiresAt:candidate.expiresAt,choices:[],
    }))});
    const projectionJson=canonicalAgentJson(projection as never),selectionJson=canonicalAgentJson(selection as never);
    const request=JSON.parse(response.request_json),requestProjection=providerSafeExactCandidateListSchema.parse(request.exactCandidateProjection);
    const exactTool=request.advertisedToolSchemas?.find((tool:any)=>tool?.name==="exact_actor_travel.select");
    const exactParameters={type:"object",properties:{candidateId:{type:"string",enum:projection.candidates.map(({candidateId})=>candidateId)},
      kind:{type:"string",enum:["actor.travel"]},version:{type:"string",enum:["v1"]},choices:{type:"array",maxItems:0}},
      required:["candidateId","kind","version","choices"],additionalProperties:false};
    if(canonicalAgentJson(requestProjection as never)!==projectionJson||!exactTool
      ||canonicalAgentJson(exactTool.parameters as never)!==canonicalAgentJson(exactParameters as never))
      throw new ExactCandidateIntegrityError("persisted provider candidate projection is invalid");
    const limits=db.prepare(`SELECT run.max_decision_rounds,run.max_tool_calls,run.max_mutation_calls,
      (SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.campaign_id=run.campaign_id AND call.turn_id=run.turn_id) legacy_calls,
      (SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.campaign_id=run.campaign_id AND call.turn_id=run.turn_id AND call.call_kind='mutation') legacy_mutations,
      (SELECT count(*) FROM agent_mutation_accounting_v40 item WHERE item.campaign_id=run.campaign_id AND item.turn_id=run.turn_id
        AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.proposal_id=item.proposal_id)) post_mutations
      FROM adventure_agent_executions_v38 run WHERE run.turn_id=?`).get(input.turnId) as any;
    if(!limits||input.round>limits.max_decision_rounds||limits.legacy_calls+limits.post_mutations+1>limits.max_tool_calls
      ||limits.legacy_mutations+limits.post_mutations+1>limits.max_mutation_calls)
      throw new ExactCandidateConflictError("exact travel exceeds durable execution limits");
    // Execution is the sole mechanics path. If a worker crashed after this call,
    // its deterministic replay is returned and only the missing v48 binding is added.
    const execution=candidates.executeExactActorTravelCandidate(principalId,{turnId:input.turnId,selection});
    const prior=(db.prepare(`SELECT max(revision) revision FROM (SELECT COALESCE(max(resulting_execution_revision),0) revision FROM agent_execution_operations_v38
      WHERE turn_id=? UNION ALL SELECT COALESCE(max(resulting_execution_revision),0) revision FROM exact_candidate_provider_bindings_v48 WHERE turn_id=?)`)
      .get(input.turnId,input.turnId) as {revision:number}).revision;
    try{db.prepare(`INSERT INTO exact_candidate_provider_bindings_v48 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(deps.ids.nextId(),
      execution.linkedCandidate.scope.campaignId,input.turnId,batch.batchId,selection.candidateId,execution.executionId,input.providerCallId,
      input.providerToolCallId,input.round,"exact_actor_travel.select",0,projectionJson,sha(projectionJson),selectionJson,
      execution.canonicalSelectionDigest,execution.actorTravelResult.receipt.commandId,prior,prior+1,execution.actorTravelResult.receipt.occurredAt);}
    catch(error){const raced=db.prepare("SELECT * FROM exact_candidate_provider_bindings_v48 WHERE candidate_id=?").get(selection.candidateId) as any;
      if(!raced)throw error;
      if(raced.provider_call_id!==input.providerCallId||raced.provider_tool_call_id!==input.providerToolCallId||raced.round_number!==input.round)
        throw new ExactCandidateConflictError("provider exact-candidate raced binding changed");
      return verifyBoundExecution(raced,principalId,input.turnId,selection);}
    return execution;
  }};
}
