import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  agentExecutionMutationResultSchema, canonicalAgentJson, durableAgentPlanningStateSchema,
  markAgentReadOutcomeInputSchema, persistAgentDecisionRoundInputSchema, utcIsoTimestampSchema,
  startAgentProviderCallInputSchema, type AgentExecutionMutationResult,
  type DurableAgentPlanningState, type MarkAgentReadOutcomeInput, type PersistAgentDecisionRoundInput,
  type StartAgentProviderCallInput,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../../runtime.js";
import { AdventureTurnAuthorizationError, AdventureTurnConflictError, AdventureTurnStaleError,
  AdventureTurnUnavailableError } from "./errors.js";

type Database = DatabaseDriver.Database;
type TurnRow = { id: string; campaign_id: string; timeline_id: string; session_id: string; actor_id: string; principal_id: string; mode: string };

/** Runtime dependencies and transaction guard for durable agent-execution writes. */
export interface AgentExecutionRepositoryContext { clock: Clock; ids: IdGenerator; guard(): void }

/** Private restart-safe planning persistence; no method executes or marks a mutation committed. */
export interface AdventureTurnAgentExecutionRepository {
  /** Records one exact provider start for the planning loop without invoking the provider. */
  startAgentProviderCall(principalId: string, input: StartAgentProviderCallInput): AgentExecutionMutationResult;
  /** Persists one complete validated provider response batch before any selected call executes. */
  persistAgentDecisionRound(principalId: string, input: PersistAgentDecisionRoundInput): AgentExecutionMutationResult;
  /** Marks one exact read call as succeeded or failed without creating campaign mechanics. */
  markAgentReadOutcome(principalId: string, input: MarkAgentReadOutcomeInput): AgentExecutionMutationResult;
  /** Reads private durable planning state for a currently authorized turn principal. */
  getDurableAgentPlanningState(principalId: string, turnId: string): DurableAgentPlanningState | null;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
function executionRevision(db: Database, row: TurnRow): number {
  return (db.prepare(`SELECT max(revision) revision FROM (
    SELECT COALESCE(max(resulting_execution_revision),0) revision FROM agent_execution_operations_v38 WHERE campaign_id=? AND turn_id=?
    UNION ALL SELECT COALESCE(max(resulting_execution_revision),0) revision FROM exact_candidate_provider_bindings_v48 WHERE campaign_id=? AND turn_id=?)`)
    .get(row.campaign_id,row.id,row.campaign_id,row.id) as { revision: number }).revision;
}

function latestTurnRevision(db: Database, row: TurnRow): { revision: number; state: string } {
  const latest = db.prepare(`SELECT resulting_revision revision,resulting_state state FROM adventure_coordination_events_v36
    WHERE aggregate_kind='turn' AND campaign_id=? AND aggregate_id=? ORDER BY resulting_revision DESC LIMIT 1`)
    .get(row.campaign_id, row.id) as { revision: number; state: string } | undefined;
  if (!latest) throw new AdventureTurnUnavailableError("turn coordination is unavailable");
  return latest;
}

function safeAuthority(db: Database, principalId: string, row: TurnRow): void {
  const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
    .get(row.campaign_id, principalId) as { role: string } | undefined;
  if (!member || member.role === "observer") throw new AdventureTurnAuthorizationError("current action role is required");
  const activeSession = db.prepare(`SELECT 1 FROM campaign_sessions attached JOIN sessions session ON session.id=attached.session_id
    WHERE attached.campaign_id=? AND attached.session_id=? AND session.state='active' AND session.stopped_at IS NULL`)
    .get(row.campaign_id, row.session_id);
  if (!activeSession) throw new AdventureTurnAuthorizationError("an attached active session is required");
  const participant = db.prepare(`SELECT 1 FROM campaign_actors actor JOIN campaign_characters character
    ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
    JOIN session_characters session_character ON session_character.character_id=character.character_id
    WHERE actor.campaign_id=? AND actor.id=? AND session_character.session_id=?`).get(row.campaign_id, row.actor_id, row.session_id);
  if (!participant) throw new AdventureTurnAuthorizationError("the selected actor is not a current session participant");
  if (member.role !== "owner" && member.role !== "gm" && !db.prepare(`SELECT 1 FROM campaign_actor_private_state
    WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`).get(row.campaign_id, row.actor_id, principalId)) {
    throw new AdventureTurnAuthorizationError("current actor control is required");
  }
}

function executionRun(db: Database, row: TurnRow): any {
  const run = db.prepare("SELECT * FROM adventure_agent_executions_v38 WHERE campaign_id=? AND turn_id=?")
    .get(row.campaign_id, row.id);
  if (!run) throw new AdventureTurnUnavailableError("durable execution is unavailable");
  return run;
}

function requireFresh(
  db: Database,
  row: TurnRow,
  input: { expectedCampaignRevision: number; expectedTurnRevision: number; expectedExecutionRevision: number },
  at: string,
): any {
  const campaign = db.prepare("SELECT active_timeline_id,administration_revision,lifecycle_status FROM campaigns WHERE id=?")
    .get(row.campaign_id) as any;
  if (!campaign || !["draft", "published"].includes(campaign.lifecycle_status) || campaign.active_timeline_id !== row.timeline_id) {
    throw new AdventureTurnStaleError("campaign no longer permits durable planning");
  }
  const latest = latestTurnRevision(db, row);
  if (["completed", "cancelled", "failed"].includes(latest.state)) throw new AdventureTurnConflictError("turn is terminal");
  if (campaign.administration_revision !== input.expectedCampaignRevision) throw new AdventureTurnStaleError("campaign revision is stale");
  if (latest.revision !== input.expectedTurnRevision) throw new AdventureTurnStaleError("turn revision is stale");
  if (executionRevision(db, row) !== input.expectedExecutionRevision) throw new AdventureTurnStaleError("execution revision is stale");
  const run = executionRun(db, row);
  if (at >= run.deadline_at) throw new AdventureTurnConflictError("durable execution deadline exceeded");
  if (db.prepare("SELECT 1 FROM agent_decision_rounds_v38 WHERE campaign_id=? AND turn_id=? AND result IN ('complete','refused')")
    .get(row.campaign_id, row.id)) throw new AdventureTurnConflictError("durable execution is terminal");
  return run;
}

function insertOperation(
  db: Database,
  context: AgentExecutionRepositoryContext,
  principalId: string,
  row: TurnRow,
  operationType: "provider-start" | "decision-round" | "read-outcome",
  input: Record<string, unknown>,
  expectedExecutionRevision: number,
  at: string,
): { operationId: string; resultingRevision: number } {
  const operationId = context.ids.nextId();
  const requestJson = canonicalAgentJson(input as never);
  const resultingRevision = expectedExecutionRevision + 1;
  db.prepare(`INSERT INTO agent_execution_operations_v38(operation_id,campaign_id,turn_id,principal_id,operation_type,idempotency_key,
    expected_campaign_revision,expected_turn_revision,expected_execution_revision,resulting_execution_revision,request_json,request_digest,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(operationId, row.campaign_id, row.id, principalId, operationType,
      input.idempotencyKey, input.expectedCampaignRevision, input.expectedTurnRevision, expectedExecutionRevision, resultingRevision,
      requestJson, sha256(requestJson), at);
  return { operationId, resultingRevision };
}

/** Creates the additive v38 planning repository; it does not execute tools or providers. */
export function createAdventureTurnAgentExecutionRepository(
  db: Database,
  context: AgentExecutionRepositoryContext,
): AdventureTurnAgentExecutionRepository {
  const now = () => utcIsoTimestampSchema.parse(context.clock.now().toISOString());
  const immediate = <T>(work: () => T): T => { context.guard(); return db.transaction(work).immediate(); };
  const turn = (turnId: string): TurnRow => {
    const row = db.prepare("SELECT id,campaign_id,timeline_id,session_id,actor_id,principal_id,mode FROM adventure_turns WHERE id=?")
      .get(turnId) as TurnRow | undefined;
    if (!row) throw new AdventureTurnUnavailableError("turn is unavailable");
    return row;
  };

  const readState = (principalId: string, turnId: string): DurableAgentPlanningState | null => {
    const row = db.prepare("SELECT id,campaign_id,timeline_id,session_id,actor_id,principal_id,mode FROM adventure_turns WHERE id=?")
      .get(turnId) as TurnRow | undefined;
    if (!row) return null;
    safeAuthority(db, principalId, row);
    const run = executionRun(db, row);
    const calls = (db.prepare(`SELECT call.*,outcome.status outcome_status,outcome.result_json,outcome.result_digest,outcome.error_code
      FROM agent_tool_calls_v38 call LEFT JOIN agent_read_outcomes_v38 outcome ON outcome.call_id=call.call_id
      WHERE call.campaign_id=? AND call.turn_id=? AND NOT(call.call_kind='mutation' AND EXISTS(
        SELECT 1 FROM agent_replan_requirements_v40 replan JOIN tool_proposals proposal ON proposal.proposal_id=replan.proposal_id
        WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id AND proposal.position=(SELECT count(*)-1
          FROM agent_tool_calls_v38 prior WHERE prior.campaign_id=call.campaign_id AND prior.turn_id=call.turn_id AND prior.call_kind='mutation'
            AND (prior.round_number<call.round_number OR (prior.round_number=call.round_number AND prior.position<=call.position)))))
      ORDER BY call.round_number,call.position`).all(row.campaign_id, row.id) as any[])
      .map((call) => {
        const readOutcome = call.outcome_status ? { status: call.outcome_status,
          result: call.result_json ? JSON.parse(call.result_json) : null, resultDigest: call.result_digest, errorCode: call.error_code } : null;
        const status = call.call_kind === "read" ? call.outcome_status === "succeeded" ? "read-succeeded"
          : call.outcome_status === "failed" ? "read-failed" : "pending" : "pending";
        return { providerToolCallId: call.provider_tool_call_id, round: call.round_number, position: call.position,
          toolName: call.tool_name, kind: call.call_kind, arguments: JSON.parse(call.arguments_json), argumentDigest: call.argument_digest,
          status, readOutcome };
      });
    const decisionRounds = (db.prepare(`SELECT max(rounds) count FROM (
      SELECT count(*) rounds FROM agent_decision_rounds_v38 WHERE campaign_id=? AND turn_id=?
      UNION ALL SELECT COALESCE(max(round_number),0) rounds FROM agent_mutation_accounting_v40 WHERE campaign_id=? AND turn_id=?
      UNION ALL SELECT COALESCE(max(round_number),0) rounds FROM exact_candidate_provider_bindings_v48 WHERE campaign_id=? AND turn_id=?)`)
      .get(row.campaign_id,row.id,row.campaign_id,row.id,row.campaign_id,row.id) as { count: number }).count;
    const postV38Mutations=(db.prepare(`SELECT count(*) count FROM agent_mutation_accounting_v40 item WHERE campaign_id=? AND turn_id=?
      AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.proposal_id=item.proposal_id)`)
      .get(row.campaign_id,row.id) as {count:number}).count;
    const providerStarts = (db.prepare("SELECT count(*) count FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? AND phase='started'")
      .get(row.campaign_id, row.id) as { count: number }).count;
    const exactTravel=(db.prepare("SELECT count(*) count FROM exact_candidate_provider_bindings_v48 WHERE campaign_id=? AND turn_id=?")
      .get(row.campaign_id,row.id) as {count:number}).count;
    return durableAgentPlanningStateSchema.parse({ turnId: row.id, toolRegistryVersion: run.tool_registry_version,
      executionRevision: executionRevision(db, row),
      limits: { decisionRounds: run.max_decision_rounds, toolCalls: run.max_tool_calls, mutationCalls: run.max_mutation_calls,
        providerCalls: run.max_provider_calls, durationMs: run.max_duration_ms }, startedAt: run.started_at, deadlineAt: run.deadline_at,
       decisionRounds, toolCalls: calls, totalToolCalls:calls.length+postV38Mutations+exactTravel,
       mutationCalls: calls.filter((call) => call.kind === "mutation").length+postV38Mutations+exactTravel,
      providerStarts, deadlineExceeded: now() >= run.deadline_at });
  };

  const replay = (principalId: string, row: TurnRow, type: string, input: Record<string, unknown>): AgentExecutionMutationResult | null => {
    const operation = db.prepare(`SELECT * FROM agent_execution_operations_v38 WHERE campaign_id=? AND turn_id=? AND idempotency_key=?`)
      .get(row.campaign_id, row.id, input.idempotencyKey) as any;
    if (!operation) return null;
    const requestJson = canonicalAgentJson(input as never);
    if (operation.principal_id !== principalId || operation.operation_type !== type || operation.request_json !== requestJson
        || operation.request_digest !== sha256(requestJson)) throw new AdventureTurnConflictError("idempotency key was reused with changed values");
    return agentExecutionMutationResultSchema.parse({ turnId: row.id,
      resultingExecutionRevision: operation.resulting_execution_revision });
  };

  const result = (row: TurnRow, resultingExecutionRevision: number): AgentExecutionMutationResult =>
    agentExecutionMutationResultSchema.parse({ turnId: row.id, resultingExecutionRevision });

  return {
    startAgentProviderCall(principalId, raw) {
      const input = startAgentProviderCallInputSchema.parse(raw);
      return immediate(() => {
        const row = turn(input.turnId); safeAuthority(db, principalId, row);
        const old = replay(principalId, row, "provider-start", input as unknown as Record<string, unknown>); if (old) return old;
        const at = now(); const run = requireFresh(db, row, input, at);
        const starts = (db.prepare(`SELECT count(*) count FROM provider_call_metadata
          WHERE campaign_id=? AND turn_id=? AND phase='started'`).get(row.campaign_id, row.id) as { count: number }).count;
        if (starts >= run.max_provider_calls) throw new AdventureTurnConflictError("provider call limit exceeded");
        const rounds = (db.prepare(`SELECT max(completed) count FROM (
          SELECT count(*) completed FROM agent_decision_rounds_v38 WHERE campaign_id=? AND turn_id=?
          UNION ALL SELECT COALESCE(max(round_number),0) completed FROM agent_mutation_accounting_v40 WHERE campaign_id=? AND turn_id=?)`)
          .get(row.campaign_id,row.id,row.campaign_id,row.id) as { count: number }).count;
        const agentStarts = (db.prepare("SELECT count(*) count FROM agent_provider_starts_v38 WHERE campaign_id=? AND turn_id=?")
          .get(row.campaign_id, row.id) as { count: number }).count;
        const unresolved = db.prepare(`SELECT 1 FROM agent_tool_calls_v38 call WHERE call.campaign_id=? AND call.turn_id=? AND
           ((call.call_kind='mutation' AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan JOIN tool_proposals proposal ON proposal.proposal_id=replan.proposal_id
             WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id AND proposal.position=(SELECT count(*)-1
               FROM agent_tool_calls_v38 prior WHERE prior.campaign_id=call.campaign_id AND prior.turn_id=call.turn_id AND prior.call_kind='mutation'
                 AND (prior.round_number<call.round_number OR (prior.round_number=call.round_number AND prior.position<=call.position)))))
             OR (call.call_kind='read' AND NOT EXISTS(SELECT 1 FROM agent_read_outcomes_v38 outcome WHERE outcome.call_id=call.call_id))) LIMIT 1`)
          .get(row.campaign_id, row.id);
        if (rounds >= run.max_decision_rounds) throw new AdventureTurnConflictError("decision round limit exceeded");
        if (agentStarts !== rounds || unresolved) throw new AdventureTurnConflictError("prior provider round is unresolved");
        if (db.prepare("SELECT 1 FROM provider_call_metadata WHERE campaign_id=? AND turn_id=? AND call_id=?")
          .get(row.campaign_id, row.id, input.providerCallId)) throw new AdventureTurnConflictError("provider call identity is unavailable");
        const operation = insertOperation(db, context, principalId, row, "provider-start",
          input as unknown as Record<string, unknown>, input.expectedExecutionRevision, at);
        db.prepare(`INSERT INTO provider_call_metadata(record_id,campaign_id,turn_id,call_id,phase,provider,model,attempt,
          prompt_tokens,completion_tokens,outcome_code,idempotency_key,recorded_at)
          VALUES(?,?,?,?,'started',?,?,?,NULL,NULL,NULL,?,?)`).run(context.ids.nextId(), row.campaign_id, row.id,
            input.providerCallId, input.provider, input.model, input.attempt, input.idempotencyKey, at);
        db.prepare(`INSERT INTO agent_provider_starts_v38(operation_id,campaign_id,turn_id,provider_call_id,provider_phase,
          resulting_execution_revision,recorded_at) VALUES(?,?,?,?,'started',?,?)`)
          .run(operation.operationId, row.campaign_id, row.id, input.providerCallId, operation.resultingRevision, at);
        return result(row, operation.resultingRevision);
      });
    },
    persistAgentDecisionRound(principalId, raw) {
      const input = persistAgentDecisionRoundInputSchema.parse(raw);
      return immediate(() => {
        const row = turn(input.turnId); safeAuthority(db, principalId, row);
        const old = replay(principalId, row, "decision-round", input as unknown as Record<string, unknown>); if (old) return old;
        const at = now(); const run = requireFresh(db, row, input, at);
        const priorRounds = db.prepare("SELECT * FROM agent_decision_rounds_v38 WHERE campaign_id=? AND turn_id=? ORDER BY round_number")
          .all(row.campaign_id, row.id) as any[];
        const priorCompleted=(db.prepare("SELECT COALESCE(max(round_number),0) round FROM agent_mutation_accounting_v40 WHERE campaign_id=? AND turn_id=?")
          .get(row.campaign_id,row.id) as {round:number}).round;
        if (input.round !== Math.max(priorRounds.length,priorCompleted) + 1 || input.round > run.max_decision_rounds
            || priorRounds.some((round) => round.result !== "tool-calls")
            || priorRounds.some((round) => db.prepare(`SELECT 1 FROM agent_tool_calls_v38 call WHERE call.round_id=? AND
               ((call.call_kind='read' AND NOT EXISTS(SELECT 1 FROM agent_read_outcomes_v38 outcome WHERE outcome.call_id=call.call_id)) OR
                  (call.call_kind='mutation' AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan JOIN tool_proposals proposal ON proposal.proposal_id=replan.proposal_id
                    WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id AND proposal.position=(SELECT count(*)-1
                      FROM agent_tool_calls_v38 prior WHERE prior.campaign_id=call.campaign_id AND prior.turn_id=call.turn_id AND prior.call_kind='mutation'
                        AND (prior.round_number<call.round_number OR (prior.round_number=call.round_number AND prior.position<=call.position)))))) LIMIT 1`)
              .get(round.round_id))) throw new AdventureTurnConflictError("prior decision round is not terminal");
        const totals = db.prepare(`SELECT count(*) calls,COALESCE(sum(call_kind='mutation'),0) mutations FROM agent_tool_calls_v38 call
          WHERE campaign_id=? AND turn_id=? AND NOT(call_kind='mutation' AND EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan JOIN tool_proposals proposal ON proposal.proposal_id=replan.proposal_id
            WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id AND proposal.position=(SELECT count(*)-1
              FROM agent_tool_calls_v38 prior WHERE prior.campaign_id=call.campaign_id AND prior.turn_id=call.turn_id AND prior.call_kind='mutation'
                AND (prior.round_number<call.round_number OR (prior.round_number=call.round_number AND prior.position<=call.position)))))`).get(row.campaign_id, row.id) as { calls: number; mutations: number };
        const addedMutations = input.calls.filter((call) => call.kind === "mutation").length;
        if (totals.calls + input.calls.length > run.max_tool_calls || totals.mutations + addedMutations > run.max_mutation_calls) {
          throw new AdventureTurnConflictError("durable execution tool limit exceeded");
        }
        if (!db.prepare(`SELECT 1 FROM agent_provider_starts_v38 start WHERE start.campaign_id=? AND start.turn_id=?
          AND start.provider_call_id=? AND start.resulting_execution_revision=? AND NOT EXISTS(
            SELECT 1 FROM agent_decision_rounds_v38 round WHERE round.campaign_id=start.campaign_id
              AND round.turn_id=start.turn_id AND round.provider_call_id=start.provider_call_id)`)
          .get(row.campaign_id, row.id, input.providerCallId, input.expectedExecutionRevision)) {
          throw new AdventureTurnConflictError("provider start is not the next invocation");
        }
        const operation = insertOperation(db, context, principalId, row, "decision-round", input as unknown as Record<string, unknown>,
          input.expectedExecutionRevision, at);
        const roundId = context.ids.nextId(), sealId = context.ids.nextId();
        const providerRequestJson = canonicalAgentJson(input.request), responseJson = canonicalAgentJson({ result: input.result, calls: input.calls });
        db.prepare(`INSERT INTO agent_decision_rounds_v38(round_id,seal_id,operation_id,campaign_id,turn_id,round_number,provider_call_id,
          tool_registry_version,provider_request_json,provider_request_digest,response_json,response_digest,result,resulting_execution_revision,recorded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(roundId, sealId, operation.operationId, row.campaign_id, row.id, input.round,
            input.providerCallId, input.toolRegistryVersion, providerRequestJson, sha256(providerRequestJson), responseJson,
            sha256(responseJson), input.result, operation.resultingRevision, at);
        const insertCall = db.prepare(`INSERT INTO agent_tool_calls_v38(call_id,campaign_id,turn_id,round_id,round_number,position,
          provider_tool_call_id,tool_name,call_kind,arguments_json,argument_digest,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
        input.calls.forEach((call, position) => { const argumentsJson = canonicalAgentJson(call.arguments);
          insertCall.run(context.ids.nextId(), row.campaign_id, row.id, roundId, input.round, position, call.providerToolCallId,
            call.toolName, call.kind, argumentsJson, sha256(argumentsJson), at); });
        db.prepare(`INSERT INTO agent_decision_batch_seals_v38(seal_id,round_id,campaign_id,turn_id,call_count,sealed_at)
          VALUES(?,?,?,?,?,?)`).run(sealId, roundId, row.campaign_id, row.id, input.calls.length, at);
        return result(row, operation.resultingRevision);
      });
    },
    markAgentReadOutcome(principalId, raw) {
      const input = markAgentReadOutcomeInputSchema.parse(raw);
      return immediate(() => {
        const row = turn(input.turnId); safeAuthority(db, principalId, row);
        const old = replay(principalId, row, "read-outcome", input as unknown as Record<string, unknown>); if (old) return old;
        const at = now(); requireFresh(db, row, input, at);
        const call = db.prepare(`SELECT * FROM agent_tool_calls_v38 WHERE campaign_id=? AND turn_id=?
          AND provider_tool_call_id=? AND call_kind='read'`).get(row.campaign_id, row.id, input.providerToolCallId) as any;
        if (!call || db.prepare("SELECT 1 FROM agent_read_outcomes_v38 WHERE call_id=?").get(call?.call_id)) {
          throw new AdventureTurnConflictError("read call is unavailable or terminal");
        }
        const operation = insertOperation(db, context, principalId, row, "read-outcome", input as unknown as Record<string, unknown>,
          input.expectedExecutionRevision, at);
        const resultJson = input.outcome.status === "succeeded" ? canonicalAgentJson(input.outcome.result) : null;
        db.prepare(`INSERT INTO agent_read_outcomes_v38(outcome_id,operation_id,call_id,campaign_id,turn_id,status,result_json,result_digest,
          error_code,resulting_execution_revision,recorded_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(context.ids.nextId(), operation.operationId,
            call.call_id, row.campaign_id, row.id, input.outcome.status, resultJson, resultJson ? sha256(resultJson) : null,
            input.outcome.status === "failed" ? input.outcome.errorCode : null, operation.resultingRevision, at);
        return result(row, operation.resultingRevision);
      });
    },
    getDurableAgentPlanningState(principalId, turnId) { return readState(principalId, turnId); },
  };
}
