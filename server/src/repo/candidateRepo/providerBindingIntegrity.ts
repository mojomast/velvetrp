import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  canonicalAgentJson,
  computeExactCandidateSelectionDigest,
  exactCandidateSelectionResponseSchema,
  projectExactCandidateForProvider,
  providerSafeExactCandidateListSchema,
} from "@velvet/contracts";
import { verifyExactCandidateIssuanceBatch } from "./issuanceVerifier.js";

const boundRowsSql = `SELECT binding.*,context.request_json,context.round_number context_round,response.status response_status,
    response.response_json,execution.candidate_id execution_candidate_id,execution.campaign_id execution_campaign_id,
    execution.turn_id execution_turn_id,execution.selection_digest execution_selection_digest,execution.world_command_id execution_world_command_id,
    execution.world_expected_revision,execution.world_revision,execution.linked_at execution_linked_at,candidate.batch_id candidate_batch_id,
    candidate.campaign_id candidate_campaign_id,candidate.turn_id candidate_turn_id,candidate.action_digest candidate_action_digest,
    execution.action_digest execution_action_digest,
    start.resulting_execution_revision start_execution_revision,command.resulting_revision command_revision,command.expected_revision command_expected_revision,
    command.created_at command_created_at
    FROM exact_candidate_provider_bindings_v48 binding
    JOIN agent_provider_contexts_v39 context ON context.campaign_id=binding.campaign_id AND context.turn_id=binding.turn_id
      AND context.provider_call_id=binding.provider_call_id
    JOIN agent_provider_responses_v39 response ON response.context_id=context.context_id
    JOIN agent_provider_starts_v38 start ON start.campaign_id=binding.campaign_id AND start.turn_id=binding.turn_id AND start.provider_call_id=binding.provider_call_id
    JOIN exact_candidate_executions_v47 execution ON execution.execution_id=binding.execution_id
    JOIN exact_candidates_v46 candidate ON candidate.candidate_id=binding.candidate_id
    JOIN world_commands_v28 command ON command.campaign_id=binding.campaign_id AND command.command_id=binding.world_command_id`;

function assertBoundRow(db: DatabaseDriver.Database, row: any): void {
  let projection: any;
  let request: any;
  let response: any;
  let selection: any;
  try {
    projection = providerSafeExactCandidateListSchema.parse(JSON.parse(row.provider_projection_json));
    request = JSON.parse(row.request_json);
    response = JSON.parse(row.response_json);
    selection = exactCandidateSelectionResponseSchema.parse(JSON.parse(row.selection_json));
  } catch {
    throw new Error("exact-candidate provider binding JSON is malformed");
  }
  const frame = canonicalAgentJson(projection);
  const selectionFrame = canonicalAgentJson(selection);
  let expectedProjection: any;
  try {
    const issuance = verifyExactCandidateIssuanceBatch(db, row.batch_id);
    expectedProjection = providerSafeExactCandidateListSchema.parse({
      version: "v1",
      candidates: issuance.candidates.map((candidate) => projectExactCandidateForProvider(candidate, candidate.issuedAt)),
    });
  } catch {
    throw new Error("exact-candidate authoritative provider projection is malformed");
  }
  const schema = request.advertisedToolSchemas?.find((tool: any) => tool?.name === row.tool_name);
  const exactParameters = { type: "object", properties: {
    candidateId: { type: "string", enum: projection.candidates.map((candidate: { candidateId: string }) => candidate.candidateId) },
    kind: { type: "string", enum: ["actor.travel"] }, version: { type: "string", enum: ["v1"] },
    choices: { type: "array", maxItems: 0 },
  }, required: ["candidateId", "kind", "version", "choices"], additionalProperties: false };
  if (frame !== canonicalAgentJson(expectedProjection) || frame !== row.provider_projection_json
    || createHash("sha256").update(frame).digest("hex") !== row.provider_projection_digest
    || canonicalAgentJson(request.exactCandidateProjection) !== frame || selectionFrame !== row.selection_json
    || computeExactCandidateSelectionDigest(selection, { sha256: (value) => createHash("sha256").update(value).digest("hex") }) !== row.selection_digest
    || selection.candidateId !== row.candidate_id || row.context_round !== row.round_number || row.response_status !== "succeeded"
    || response.result !== "tool-calls" || response.calls?.length !== 1 || response.calls[0]?.providerToolCallId !== row.provider_tool_call_id
    || response.calls[0]?.toolName !== row.tool_name || response.calls[0]?.kind !== "mutation"
    || canonicalAgentJson(response.calls[0]?.arguments) !== selectionFrame
    || !Array.isArray(request.advertisedTools) || request.advertisedTools.filter((name: any) => name === row.tool_name).length !== 1
    || !schema || canonicalAgentJson(schema.parameters) !== canonicalAgentJson(exactParameters)
    || row.execution_candidate_id !== row.candidate_id || row.execution_campaign_id !== row.campaign_id || row.execution_turn_id !== row.turn_id
    || row.execution_selection_digest !== row.selection_digest || row.execution_world_command_id !== row.world_command_id
    || row.execution_linked_at !== row.linked_at || row.candidate_batch_id !== row.batch_id
    || row.candidate_campaign_id !== row.campaign_id || row.candidate_turn_id !== row.turn_id
    || row.candidate_action_digest !== row.execution_action_digest || row.command_expected_revision !== row.world_expected_revision
    || row.command_revision !== row.world_revision || row.command_created_at !== row.linked_at
    || row.start_execution_revision !== row.expected_execution_revision
    || row.resulting_execution_revision !== row.expected_execution_revision + 1) {
    throw new Error("exact-candidate provider binding is malformed");
  }
}

export function assertExactCandidateProviderBinding(db: DatabaseDriver.Database, bindingId: string): void {
  const row = db.prepare(`${boundRowsSql} WHERE binding.binding_id=?`).get(bindingId) as any;
  if (!row) throw new Error("exact-candidate provider binding ancestry is incomplete");
  assertBoundRow(db, row);
}
