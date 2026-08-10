import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { agentRequestObjectSchema, agentResultObjectSchema, canonicalAgentJson, resourceIdSchema, startAgentProviderCallInputSchema,
  utcIsoTimestampSchema, type AgentJsonObject } from "@velvet/contracts";
import type { Clock, IdGenerator } from "../../runtime.js";
import { AdventureTurnConflictError, AdventureTurnStaleError, AdventureTurnUnavailableError } from "./errors.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export interface ProviderContextInput { turnId:string; providerCallId:string; round:number; expectedCampaignRevision:number;
  expectedTurnRevision:number; timelineId:string; timelineRevision:number; context:AgentJsonObject; request:AgentJsonObject; }
export interface ProviderResponseInput { turnId:string; providerCallId:string; status:"succeeded"|"failed"|"cancelled";
  response?:AgentJsonObject; outcomeCode:string; promptTokens?:number|null; completionTokens?:number|null; orphanRecovery?:boolean; }
export interface ProviderRecoveryState { providerCallId:string; round:number; provider:string; model:string; attempt:number;
  context:AgentJsonObject|null; request:AgentJsonObject|null; claim:{claimedAt:string;leaseExpiresAt:string;expired:boolean}|null;
  response:{status:"succeeded"|"failed"|"cancelled";response:AgentJsonObject|null}|null; }
export interface AdventureTurnAgentResponseRepository {
  claimAgentProviderRound(principal:string,input:ProviderContextInput&{provider:string;model:string;attempt:number;
    expectedExecutionRevision:number;idempotencyKey:string}):{claimed:boolean;leaseExpiresAt:string;expired:boolean};
  bindAgentProviderContext(principal:string,input:ProviderContextInput):void;
  settleAgentProviderResponse(principal:string,input:ProviderResponseInput):{status:"succeeded"|"failed"|"cancelled"};
  claimAgentProviderDispatch(principal:string,turnId:string,providerCallId:string):{claimed:boolean;leaseExpiresAt:string;expired:boolean};
  getAgentProviderRecovery(principal:string,turnId:string):ProviderRecoveryState|null;
  getAgentDecisionContext(principal:string,turnId:string,providerToolCallId:string):{providerCallId:string;timelineRevision:number;context:AgentJsonObject}|null;
  linkAgentCombatReceipt(principal:string,input:{turnId:string;encounterId:string;idempotencyKey:string;proposalId?:string|null}):void;
  getAgentCombatReceipt(principal:string,campaignId:string,commandId:string):{revisionBefore:number;revisionAfter:number;occurredAt:string;resolution:AgentJsonObject}|null;
  validateApprovedAgentProposal(principal:string,turnId:string,proposalId:string):{valid:true}|{valid:false;reason:string};
  requireAgentProposalReplan(principal:string,turnId:string,proposalId:string,reason:"command-stale"):void;
}

export function createAdventureTurnAgentResponseRepository(db:DatabaseDriver.Database,deps:{clock:Clock;ids:IdGenerator;guard():void}):AdventureTurnAgentResponseRepository {
  const now=()=>utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
  const immediate=<T>(fn:()=>T)=>{deps.guard();return db.transaction(fn).immediate();};
  const turn=(id:string)=>{const row=db.prepare("SELECT * FROM adventure_turns WHERE id=?").get(id) as any;if(!row)throw new AdventureTurnUnavailableError();return row;};
  const authority=(principal:string,row:any)=>{if(!db.prepare(`SELECT 1 FROM campaign_memberships member
    LEFT JOIN campaign_actor_private_state control ON control.campaign_id=member.campaign_id AND control.actor_id=?
      AND control.controller_principal_id=member.principal_id
    WHERE member.campaign_id=? AND member.principal_id=? AND (member.role IN('owner','gm') OR (member.role='player' AND control.actor_id IS NOT NULL))`)
    .get(row.actor_id,row.campaign_id,principal))throw new AdventureTurnUnavailableError();};
  return {
    claimAgentProviderRound(principal,raw){return immediate(()=>{
      const start=startAgentProviderCallInputSchema.parse({turnId:raw.turnId,providerCallId:raw.providerCallId,provider:raw.provider,
        model:raw.model,attempt:raw.attempt,expectedCampaignRevision:raw.expectedCampaignRevision,
        expectedTurnRevision:raw.expectedTurnRevision,expectedExecutionRevision:raw.expectedExecutionRevision,idempotencyKey:raw.idempotencyKey});
      const input={...raw,context:agentResultObjectSchema.parse(raw.context),request:agentRequestObjectSchema.parse(raw.request)};
      const row=turn(input.turnId);authority(principal,row);const at=now(),contextJson=canonicalAgentJson(input.context),requestJson=canonicalAgentJson(input.request);
      const existing=db.prepare(`SELECT operation.request_json operation_request_json,context.context_json,context.request_json context_request_json,claim.lease_expires_at
        FROM agent_execution_operations_v38 operation JOIN agent_provider_starts_v38 start ON start.operation_id=operation.operation_id
        JOIN agent_provider_contexts_v39 context ON context.campaign_id=start.campaign_id AND context.turn_id=start.turn_id AND context.provider_call_id=start.provider_call_id
        JOIN agent_provider_dispatch_claims_v39 claim ON claim.campaign_id=start.campaign_id AND claim.turn_id=start.turn_id AND claim.provider_call_id=start.provider_call_id
        WHERE operation.campaign_id=? AND operation.turn_id=? AND operation.idempotency_key=?`).get(row.campaign_id,row.id,start.idempotencyKey) as any;
      const startJson=canonicalAgentJson(start as never);
      if(existing){if(existing.operation_request_json!==startJson||existing.context_json!==contextJson||existing.context_request_json!==requestJson)
        throw new AdventureTurnConflictError("provider dispatch replay changed");
        return{claimed:false,leaseExpiresAt:existing.lease_expires_at,expired:at>=existing.lease_expires_at};}
      const campaign=db.prepare("SELECT active_timeline_id,administration_revision,lifecycle_status FROM campaigns WHERE id=?").get(row.campaign_id) as any;
      const timeline=db.prepare("SELECT revision FROM campaign_timelines WHERE campaign_id=? AND id=?").get(row.campaign_id,input.timelineId) as any;
      const latest=db.prepare("SELECT max(resulting_revision) revision FROM adventure_coordination_events_v36 WHERE campaign_id=? AND aggregate_kind='turn' AND aggregate_id=?").get(row.campaign_id,row.id) as any;
      const run=db.prepare("SELECT * FROM adventure_agent_executions_v38 WHERE campaign_id=? AND turn_id=?").get(row.campaign_id,row.id) as any;
      const execution=(db.prepare("SELECT COALESCE(max(resulting_execution_revision),0) revision FROM agent_execution_operations_v38 WHERE campaign_id=? AND turn_id=?").get(row.campaign_id,row.id) as any).revision;
      const starts=(db.prepare("SELECT count(*) count FROM agent_provider_starts_v38 WHERE campaign_id=? AND turn_id=?").get(row.campaign_id,row.id) as any).count;
      const rounds=(db.prepare(`SELECT max(completed) count FROM (
        SELECT count(*) completed FROM agent_decision_rounds_v38 WHERE campaign_id=? AND turn_id=?
        UNION ALL SELECT COALESCE(max(round_number),0) completed FROM agent_mutation_accounting_v40 WHERE campaign_id=? AND turn_id=?)`)
        .get(row.campaign_id,row.id,row.campaign_id,row.id) as any).count;
      if(!campaign||!timeline||!run||!['draft','published'].includes(campaign.lifecycle_status)||campaign.active_timeline_id!==input.timelineId
        ||campaign.administration_revision!==input.expectedCampaignRevision||timeline.revision!==input.timelineRevision
        ||latest.revision!==input.expectedTurnRevision||execution!==input.expectedExecutionRevision||starts!==rounds
        ||starts>=run.max_provider_calls||rounds>=run.max_decision_rounds||at>=run.deadline_at)
        throw new AdventureTurnStaleError("provider dispatch context is stale");
      const operationId=deps.ids.nextId(),resulting=execution+1;
      db.prepare(`INSERT INTO agent_execution_operations_v38 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(operationId,row.campaign_id,row.id,principal,
        "provider-start",start.idempotencyKey,start.expectedCampaignRevision,start.expectedTurnRevision,start.expectedExecutionRevision,resulting,startJson,hash(startJson),at);
      db.prepare(`INSERT INTO provider_call_metadata(record_id,campaign_id,turn_id,call_id,phase,provider,model,attempt,prompt_tokens,completion_tokens,outcome_code,idempotency_key,recorded_at)
        VALUES(?,?,?,?,'started',?,?,?,NULL,NULL,NULL,?,?)`).run(deps.ids.nextId(),row.campaign_id,row.id,start.providerCallId,start.provider,start.model,start.attempt,start.idempotencyKey,at);
      db.prepare("INSERT INTO agent_provider_starts_v38 VALUES(?,?,?,?,?,?,?)").run(operationId,row.campaign_id,row.id,start.providerCallId,"started",resulting,at);
      const contextId=deps.ids.nextId();db.prepare("INSERT INTO agent_provider_contexts_v39 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(contextId,row.campaign_id,row.id,start.providerCallId,input.round,input.timelineId,input.timelineRevision,input.expectedCampaignRevision,input.expectedTurnRevision,contextJson,hash(contextJson),requestJson,hash(requestJson),at);
      db.prepare("INSERT INTO agent_provider_dispatch_claims_v39 VALUES(?,?,?,?,?,?,?)")
        .run(deps.ids.nextId(),contextId,row.campaign_id,row.id,start.providerCallId,at,run.deadline_at);
      return{claimed:true,leaseExpiresAt:run.deadline_at,expired:false};
    });},
    bindAgentProviderContext(principal,raw){const input={...raw,context:agentResultObjectSchema.parse(raw.context),request:agentRequestObjectSchema.parse(raw.request)};
      immediate(()=>{const row=turn(input.turnId);authority(principal,row);const existing=db.prepare("SELECT * FROM agent_provider_contexts_v39 WHERE campaign_id=? AND turn_id=? AND provider_call_id=?").get(row.campaign_id,row.id,input.providerCallId) as any;
        const contextJson=canonicalAgentJson(input.context),requestJson=canonicalAgentJson(input.request);
        if(existing){if(existing.context_json!==contextJson||existing.request_json!==requestJson)throw new AdventureTurnConflictError("provider context changed");return;}
        const campaign=db.prepare("SELECT active_timeline_id,administration_revision FROM campaigns WHERE id=?").get(row.campaign_id) as any;
        const timeline=db.prepare("SELECT revision FROM campaign_timelines WHERE campaign_id=? AND id=?").get(row.campaign_id,input.timelineId) as any;
        const latest=db.prepare("SELECT max(resulting_revision) revision FROM adventure_coordination_events_v36 WHERE campaign_id=? AND aggregate_kind='turn' AND aggregate_id=?").get(row.campaign_id,row.id) as any;
        const run=db.prepare("SELECT deadline_at FROM adventure_agent_executions_v38 WHERE campaign_id=? AND turn_id=?").get(row.campaign_id,row.id) as any;
        if(!campaign||!timeline||campaign.active_timeline_id!==input.timelineId||campaign.administration_revision!==input.expectedCampaignRevision
          ||timeline.revision!==input.timelineRevision||latest.revision!==input.expectedTurnRevision||now()>=run.deadline_at)throw new AdventureTurnStaleError("provider context is stale");
        if(!db.prepare("SELECT 1 FROM agent_provider_starts_v38 WHERE campaign_id=? AND turn_id=? AND provider_call_id=?").get(row.campaign_id,row.id,input.providerCallId))throw new AdventureTurnConflictError("provider start missing");
        db.prepare(`INSERT INTO agent_provider_contexts_v39 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(deps.ids.nextId(),row.campaign_id,row.id,input.providerCallId,input.round,input.timelineId,input.timelineRevision,input.expectedCampaignRevision,input.expectedTurnRevision,contextJson,hash(contextJson),requestJson,hash(requestJson),now());
      });},
    settleAgentProviderResponse(principal,raw){const input={...raw,response:raw.response===undefined?undefined:agentResultObjectSchema.parse(raw.response)};return immediate(()=>{
      const row=turn(input.turnId);authority(principal,row);let context=db.prepare("SELECT * FROM agent_provider_contexts_v39 WHERE campaign_id=? AND provider_call_id=? AND turn_id=?").get(row.campaign_id,input.providerCallId,row.id) as any;
      if(!context&&input.status!=="succeeded") { const timeline=db.prepare("SELECT revision FROM campaign_timelines WHERE campaign_id=? AND id=?").get(row.campaign_id,row.timeline_id) as any;
        const round=(db.prepare("SELECT count(*) count FROM agent_provider_starts_v38 WHERE campaign_id=? AND turn_id=?")
          .get(row.campaign_id,row.id) as any).count;
        const contextJson=canonicalAgentJson({orphanedBeforeDispatch:true}),requestJson=canonicalAgentJson({});const contextId=deps.ids.nextId();
        db.prepare("INSERT INTO agent_provider_contexts_v39 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(contextId,row.campaign_id,row.id,input.providerCallId,round,row.timeline_id,timeline.revision,row.campaign_revision,row.revision,contextJson,hash(contextJson),requestJson,hash(requestJson),now());
         context=db.prepare("SELECT * FROM agent_provider_contexts_v39 WHERE context_id=? AND campaign_id=? AND turn_id=? AND provider_call_id=?")
           .get(contextId,row.campaign_id,row.id,input.providerCallId) as any; }
      if(!context)throw new AdventureTurnConflictError("provider context missing");
      const old=db.prepare("SELECT * FROM agent_provider_responses_v39 WHERE campaign_id=? AND turn_id=? AND provider_call_id=?").get(row.campaign_id,row.id,input.providerCallId) as any;
      const responseJson=input.status==="succeeded"?canonicalAgentJson(input.response!):null;
       if(old){if(old.status!==input.status||old.response_json!==responseJson||old.outcome_code!==input.outcomeCode
         ||old.prompt_tokens!==(input.promptTokens??null)||old.completion_tokens!==(input.completionTokens??null))
         throw new AdventureTurnConflictError("provider response changed");
         const outcome=db.prepare(`SELECT * FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? AND call_id=? AND phase=?`)
           .get(row.campaign_id,row.id,input.providerCallId,input.status) as any;
         if(!outcome||outcome.prompt_tokens!==old.prompt_tokens||outcome.completion_tokens!==old.completion_tokens
           ||outcome.outcome_code!==old.outcome_code||outcome.recorded_at!==old.recorded_at)
          throw new AdventureTurnConflictError("provider response settlement is incomplete");return{status:old.status};}
      const start=db.prepare("SELECT * FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? AND call_id=? AND phase='started'").get(row.campaign_id,row.id,input.providerCallId) as any;if(!start)throw new AdventureTurnConflictError("provider start missing");
      const at=now();
      const claim=db.prepare("SELECT * FROM agent_provider_dispatch_claims_v39 WHERE context_id=? AND campaign_id=? AND turn_id=? AND provider_call_id=?")
        .get(context.context_id,row.campaign_id,row.id,input.providerCallId) as any;
      const run=db.prepare("SELECT deadline_at FROM adventure_agent_executions_v38 WHERE campaign_id=? AND turn_id=?").get(row.campaign_id,row.id) as any;
      const campaign=db.prepare("SELECT active_timeline_id,administration_revision,lifecycle_status FROM campaigns WHERE id=?").get(row.campaign_id) as any;
      const timeline=db.prepare("SELECT revision FROM campaign_timelines WHERE campaign_id=? AND id=?").get(row.campaign_id,context.timeline_id) as any;
      const latest=db.prepare("SELECT max(resulting_revision) revision FROM adventure_coordination_events_v36 WHERE campaign_id=? AND aggregate_kind='turn' AND aggregate_id=?")
        .get(row.campaign_id,row.id) as any;
      let status=input.status,outcomeCode=input.outcomeCode,promptTokens=input.promptTokens??null,completionTokens=input.completionTokens??null;
      if(input.orphanRecovery){
        if(input.status==="succeeded"||!run)
          throw new AdventureTurnConflictError("provider orphan is not recoverable");
      }else if(!claim||!run||at>=claim.lease_expires_at||at>=run.deadline_at||!campaign||!timeline
        ||!['draft','published'].includes(campaign.lifecycle_status)||campaign.active_timeline_id!==context.timeline_id
        ||campaign.administration_revision!==context.campaign_revision||timeline.revision!==context.timeline_revision
        ||latest.revision!==context.turn_revision){
        // A rejected late/stale settlement is itself durably terminal. This
        // prevents fallback or terminal turn state from stranding a live claim.
        status="failed";outcomeCode=input.status==="succeeded"?"orphaned-rejected-success":input.outcomeCode;
        promptTokens=null;completionTokens=null;
      }
      const settledResponseJson=status==="succeeded"?responseJson:null;
      db.prepare(`INSERT INTO provider_call_metadata(record_id,campaign_id,turn_id,call_id,phase,provider,model,attempt,prompt_tokens,completion_tokens,outcome_code,idempotency_key,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(deps.ids.nextId(),row.campaign_id,row.id,input.providerCallId,status,start.provider,start.model,start.attempt,promptTokens,completionTokens,outcomeCode,`v39:${hash(input.providerCallId).slice(0,48)}`,at);
      db.prepare("INSERT INTO agent_provider_responses_v39 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(deps.ids.nextId(),context.context_id,row.campaign_id,row.id,input.providerCallId,status,
        settledResponseJson,settledResponseJson?hash(settledResponseJson):null,promptTokens,completionTokens,outcomeCode,at);
      return{status};
    });},
    claimAgentProviderDispatch(principal,turnId,providerCallId){return immediate(()=>{const row=turn(turnId);authority(principal,row);
      const context=db.prepare("SELECT context_id FROM agent_provider_contexts_v39 WHERE campaign_id=? AND turn_id=? AND provider_call_id=?").get(row.campaign_id,turnId,providerCallId) as {context_id:string}|undefined;
       if(!context)throw new AdventureTurnConflictError("provider context missing");const old=db.prepare("SELECT lease_expires_at FROM agent_provider_dispatch_claims_v39 WHERE campaign_id=? AND turn_id=? AND provider_call_id=?").get(row.campaign_id,turnId,providerCallId) as {lease_expires_at:string}|undefined;
       if(old)return{claimed:false,leaseExpiresAt:old.lease_expires_at,expired:now()>=old.lease_expires_at};const run=db.prepare("SELECT deadline_at FROM adventure_agent_executions_v38 WHERE campaign_id=? AND turn_id=?").get(row.campaign_id,turnId) as {deadline_at:string};const at=now();
      if(at>=run.deadline_at)throw new AdventureTurnConflictError("provider dispatch deadline expired");db.prepare("INSERT INTO agent_provider_dispatch_claims_v39 VALUES(?,?,?,?,?,?,?)").run(deps.ids.nextId(),context.context_id,row.campaign_id,row.id,providerCallId,at,run.deadline_at);
      return{claimed:true,leaseExpiresAt:run.deadline_at,expired:false};});},
    getAgentProviderRecovery(principal,turnId){const row=turn(turnId);authority(principal,row);const start=db.prepare(`SELECT start.provider_call_id,context.round_number,provider.provider,provider.model,provider.attempt,context.context_json,context.request_json,claim.claimed_at,claim.lease_expires_at,response.status,response.response_json
      FROM agent_provider_starts_v38 start JOIN provider_call_metadata provider ON provider.campaign_id=start.campaign_id AND provider.turn_id=start.turn_id AND provider.call_id=start.provider_call_id AND provider.phase='started'
       LEFT JOIN agent_provider_contexts_v39 context ON context.campaign_id=start.campaign_id AND context.turn_id=start.turn_id AND context.provider_call_id=start.provider_call_id
       LEFT JOIN agent_provider_dispatch_claims_v39 claim ON claim.campaign_id=start.campaign_id AND claim.turn_id=start.turn_id AND claim.provider_call_id=start.provider_call_id
       LEFT JOIN agent_provider_responses_v39 response ON response.campaign_id=start.campaign_id AND response.turn_id=start.turn_id AND response.provider_call_id=start.provider_call_id
       WHERE start.campaign_id=? AND start.turn_id=? AND NOT EXISTS(SELECT 1 FROM agent_decision_rounds_v38 round
         WHERE round.campaign_id=start.campaign_id AND round.turn_id=start.turn_id AND round.provider_call_id=start.provider_call_id)
         AND NOT EXISTS(SELECT 1 FROM agent_mutation_accounting_v40 mutation WHERE mutation.campaign_id=start.campaign_id
           AND mutation.turn_id=start.turn_id AND mutation.provider_call_id=start.provider_call_id)
         ORDER BY provider.recorded_at DESC LIMIT 1`).get(row.campaign_id,turnId) as any;
      if(!start)return null;return {providerCallId:start.provider_call_id,round:start.round_number??1,provider:start.provider,model:start.model,attempt:start.attempt,context:start.context_json?JSON.parse(start.context_json):null,request:start.request_json?JSON.parse(start.request_json):null,
         claim:start.claimed_at?{claimedAt:start.claimed_at,leaseExpiresAt:start.lease_expires_at,expired:now()>=start.lease_expires_at}:null,response:start.status?{status:start.status,response:start.response_json?JSON.parse(start.response_json):null}:null};},
    getAgentDecisionContext(principal,turnId,providerToolCallId){const row=turn(turnId);authority(principal,row);
      const value=db.prepare(`SELECT round.provider_call_id,context.timeline_revision,context.context_json
        FROM agent_tool_calls_v38 call JOIN agent_decision_rounds_v38 round ON round.round_id=call.round_id
        JOIN agent_provider_contexts_v39 context ON context.campaign_id=round.campaign_id AND context.turn_id=round.turn_id
          AND context.provider_call_id=round.provider_call_id
        WHERE call.campaign_id=? AND call.turn_id=? AND call.provider_tool_call_id=?`).get(row.campaign_id,row.id,providerToolCallId) as any;
      return value?{providerCallId:value.provider_call_id,timelineRevision:value.timeline_revision,context:agentResultObjectSchema.parse(JSON.parse(value.context_json))}:null;},
    linkAgentCombatReceipt(principal,input){immediate(()=>{const row=turn(input.turnId);authority(principal,row);
       const command=db.prepare(`SELECT command.command_id,command.expected_revision,command.resulting_revision,receipt.occurred_at FROM combat_commands_v27 command JOIN combat_receipts_v27 receipt USING(encounter_id,command_id,resulting_revision)
         JOIN encounter ON encounter.encounter_id=command.encounter_id WHERE command.encounter_id=? AND command.idempotency_key=? AND command.command_type='resolve_action' AND encounter.campaign_id=? AND encounter.session_id=?`).get(input.encounterId,input.idempotencyKey,row.campaign_id,row.session_id) as any;
       if(!command)throw new AdventureTurnUnavailableError("combat receipt unavailable");
       const old=db.prepare("SELECT * FROM agent_generalized_receipts_v39 WHERE campaign_id=? AND turn_id=? AND receipt_family='combat'").get(row.campaign_id,row.id) as any;
       if(old){if(old.proposal_id!==(input.proposalId??null)||old.command_id!==command.command_id||old.encounter_id!==input.encounterId
         ||old.idempotency_key!==input.idempotencyKey||old.revision_before!==command.expected_revision
         ||old.revision_after!==command.resulting_revision||old.linked_at!==command.occurred_at)
         throw new AdventureTurnConflictError("combat receipt link changed");return;}
       db.prepare("INSERT INTO agent_generalized_receipts_v39 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(deps.ids.nextId(),row.campaign_id,row.id,"combat",input.proposalId??null,command.command_id,input.encounterId,input.idempotencyKey,command.expected_revision,command.resulting_revision,command.occurred_at);
    });},
    getAgentCombatReceipt(principal,campaignId,commandId){
      const member=db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId,principal);if(!member)return null;
      const row=db.prepare(`SELECT link.revision_before,link.revision_after,link.linked_at,receipt.canonical_result_json
        FROM agent_generalized_receipts_v39 link JOIN combat_receipts_v27 receipt ON receipt.encounter_id=link.encounter_id AND receipt.command_id=link.command_id
          AND receipt.resulting_revision=link.revision_after WHERE link.campaign_id=? AND link.command_id=?`).get(campaignId,commandId) as any;
      if(!row)return null;const result=JSON.parse(row.canonical_result_json) as any;const resolution=agentResultObjectSchema.parse(result.resolution);
      return{revisionBefore:row.revision_before,revisionAfter:row.revision_after,occurredAt:row.linked_at,resolution};
    },
    validateApprovedAgentProposal(principal,turnId,proposalId){return immediate(()=>{
      const row=turn(turnId);authority(principal,row);const at=now();
      const proposal=db.prepare(`SELECT proposal.*,policy.policy_version,policy.category,policy.requires_confirmation policy_requires_confirmation,
        policy.required_authorizer,policy.safe_summary_json,policy.proposed_command_digest,policy.observed_domain_revisions_json,policy.attested_at,
        decision.decision,decision.principal_id decision_principal_id,
        turn.timeline_id,turn.session_id,turn.actor_id,turn.campaign_revision,combat.encounter_id,combat.legal_action_id,
        combat.command_legal_action_id,combat.legal_action_digest,combat.expected_combat_revision
        FROM tool_proposals proposal JOIN confirmation_policy_attestations_v40 policy
          ON policy.campaign_id=proposal.campaign_id AND policy.turn_id=proposal.turn_id AND policy.proposal_id=proposal.proposal_id
        JOIN adventure_turns turn ON turn.campaign_id=proposal.campaign_id AND turn.id=proposal.turn_id
        LEFT JOIN confirmation_decisions decision ON decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id
        LEFT JOIN agent_combat_proposal_bindings_v39 combat ON combat.campaign_id=proposal.campaign_id AND combat.turn_id=proposal.turn_id AND combat.proposal_id=proposal.proposal_id
        WHERE proposal.campaign_id=? AND proposal.turn_id=? AND proposal.proposal_id=?`).get(row.campaign_id,row.id,proposalId) as any;
      if(!proposal)throw new AdventureTurnUnavailableError("proposal unavailable");
      const args=JSON.parse(proposal.arguments_json),commandDigest=hash(canonicalAgentJson({toolName:proposal.tool_name,arguments:args}));
      const domains=JSON.parse(proposal.observed_domain_revisions_json) as Array<{domain:string;revision:number}>;
      const domain=(name:string)=>domains.find((item)=>item.domain===name)?.revision;
      let reason:string|null=null;
      const compatible=proposal.tool_name==="combat_action"?["combat-action-consequential","controller"]
        :proposal.tool_name==="set_actor_attribute"?["gm-override","gm"]
        :proposal.tool_name==="roll_actor_dice"?["deterministic-roll","controller"]:["ambiguous-consequential-change","controller"];
      if(proposal.policy_version!=="v1"||proposal.category!==compatible[0]||proposal.required_authorizer!==compatible[1]
        ||Boolean(proposal.requires_confirmation)!==Boolean(proposal.policy_requires_confirmation??proposal.requires_confirmation)
        ||proposal.proposed_command_digest!==commandDigest)reason="policy-stale";
      const campaign=db.prepare("SELECT active_timeline_id,administration_revision,lifecycle_status FROM campaigns WHERE id=?").get(row.campaign_id) as any;
      const timeline=db.prepare("SELECT revision FROM campaign_timelines WHERE campaign_id=? AND id=?").get(row.campaign_id,row.timeline_id) as any;
      if(!reason&&(!campaign||!['draft','published'].includes(campaign.lifecycle_status)||campaign.administration_revision!==domain('campaign')))reason="campaign-stale";
      if(!reason&&(!timeline||campaign.active_timeline_id!==row.timeline_id||timeline.revision!==domain('timeline')))reason="timeline-stale";
      const member=db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(row.campaign_id,principal) as any;
      const session=db.prepare(`SELECT 1 FROM campaign_sessions attached JOIN sessions session ON session.id=attached.session_id
        WHERE attached.campaign_id=? AND attached.session_id=? AND session.state='active' AND session.stopped_at IS NULL`).get(row.campaign_id,row.session_id);
      const controlled=member?.role==='owner'||member?.role==='gm'||Boolean(db.prepare(`SELECT 1 FROM campaign_actor_private_state
        WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`).get(row.campaign_id,row.actor_id,principal));
       const decisionRole=proposal.decision_principal_id?db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
         .get(row.campaign_id,proposal.decision_principal_id) as any:null;
       const decisionControls=Boolean(proposal.decision_principal_id&&db.prepare(`SELECT 1 FROM campaign_actor_private_state
         WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`).get(row.campaign_id,row.actor_id,proposal.decision_principal_id));
       const decisionAuthorized=!proposal.requires_confirmation||(proposal.decision==='approved'&&decisionRole
         &&(proposal.required_authorizer==='gm'?['owner','gm'].includes(decisionRole.role)
           :['owner','gm'].includes(decisionRole.role)||(decisionRole.role==='player'&&decisionControls)));
       if(!reason&&((proposal.requires_confirmation&&proposal.decision!=="approved")||!member||member.role==='observer'||!session||!controlled
         ||!decisionAuthorized))reason="authority-stale";
      if(!reason&&proposal.encounter_id){const combat=db.prepare(`SELECT encounter.current_turn_combatant_id current_id,revision FROM encounter
        JOIN combat_mutation_revisions_v27 revision ON revision.encounter_id=encounter.encounter_id
        WHERE encounter.encounter_id=? AND encounter.campaign_id=? AND encounter.session_id=? AND encounter.status='active'`)
        .get(proposal.encounter_id,row.campaign_id,row.session_id) as any;
        const currentCandidate=db.prepare(`SELECT 1 FROM combatant current WHERE current.encounter_id=? AND current.combatant_id=? AND current.status='active'`)
          .get(proposal.encounter_id,combat?.current_id);
        const current=db.prepare("SELECT team FROM combatant WHERE encounter_id=? AND combatant_id=? AND status='active'")
          .get(proposal.encounter_id,combat?.current_id) as {team:string}|undefined;
        const target=args.targetId===null?null:typeof args.targetId==='string'?db.prepare(`SELECT team FROM combatant
          WHERE encounter_id=? AND combatant_id=? AND status='active'`).get(proposal.encounter_id,args.targetId) as {team:string}|undefined:undefined;
        const exactTarget=proposal.command_legal_action_id==='attack:basic'?Boolean(target&&current&&target.team!==current.team)
          :args.targetId===null&&['flee','end-turn'].includes(proposal.command_legal_action_id);
        const opaque=args.legalActionId,digestValue=typeof opaque==='string'&&combat
          ?hash(JSON.stringify([proposal.encounter_id,combat.revision,opaque,combat.current_id,args.targetId])):"";
        if(!combat||!currentCandidate||combat.revision!==domain('combat')||combat.revision!==proposal.expected_combat_revision
          ||args.commandLegalActionId!==proposal.command_legal_action_id||opaque!==proposal.legal_action_id
          ||args.legalActionDigest!==proposal.legal_action_digest||digestValue!==proposal.legal_action_digest||!exactTarget)reason="combat-stale";
      }
      if(!reason)return{valid:true as const};
      const validation=canonicalAgentJson({reason,proposalId,commandDigest,domains} as never);
      const old=db.prepare("SELECT reason,validation_json FROM agent_replan_requirements_v40 WHERE proposal_id=?").get(proposalId) as any;
      if(old){if(old.reason!==reason||old.validation_json!==validation)throw new AdventureTurnConflictError("replan requirement changed");return{valid:false as const,reason};}
      db.prepare("INSERT INTO agent_replan_requirements_v40 VALUES(?,?,?,?,?,?,?)").run(deps.ids.nextId(),row.campaign_id,row.id,proposalId,reason,validation,at);
      return{valid:false as const,reason};
    });},
    requireAgentProposalReplan(principal,turnId,proposalId,reason){immediate(()=>{
      const row=turn(turnId);authority(principal,row);
      const proposal=db.prepare("SELECT 1 FROM tool_proposals WHERE campaign_id=? AND turn_id=? AND proposal_id=?")
        .get(row.campaign_id,row.id,proposalId);
      if(!proposal)throw new AdventureTurnUnavailableError("proposal unavailable");
      const validation=canonicalAgentJson({reason,proposalId} as never);
      const old=db.prepare("SELECT reason,validation_json FROM agent_replan_requirements_v40 WHERE campaign_id=? AND turn_id=? AND proposal_id=?")
        .get(row.campaign_id,row.id,proposalId) as any;
      if(old){if(old.reason!==reason||old.validation_json!==validation)throw new AdventureTurnConflictError("replan requirement changed");return;}
      db.prepare("INSERT INTO agent_replan_requirements_v40 VALUES(?,?,?,?,?,?,?)")
        .run(deps.ids.nextId(),row.campaign_id,row.id,proposalId,reason,validation,now());
    });}
  };
}
