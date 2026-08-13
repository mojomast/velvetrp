import {createHash} from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {MAX_EXACT_CANDIDATE_LIFETIME_MS,canonicalAgentJson,canonicalExactCandidateActionFrame,
  canonicalExactCandidateEnvelopeFrame,computeExactCandidateActionDigest,computeExactCandidateEnvelopeDigest,
  internalExactCandidateSchema,type InternalExactCandidate} from "@velvet/contracts";

const crypto={sha256:(frame:string)=>createHash("sha256").update(frame).digest("hex")};
const digest=(value:unknown)=>crypto.sha256(canonicalAgentJson(value as never));

export type ExactCandidateIssuanceBatchRow={batch_id:string;campaign_id:string;turn_id:string;session_id:string;actor_id:string;
  principal_id:string;idempotency_key:string;connection_id:string;candidate_count:number;world_revision:number;issued_at:string;
  expires_at:string;request_digest:string};
export type ExactCandidateIssuanceRow=Record<string,unknown>&{candidate_id:string;batch_id:string;position:number;envelope_json:string};

/** Reconstructs and cryptographically verifies one complete immutable v46 issuance batch. */
export function verifyExactCandidateIssuanceBatch(db:DatabaseDriver.Database,batchId:string):{
  batch:ExactCandidateIssuanceBatchRow;rows:ExactCandidateIssuanceRow[];candidates:InternalExactCandidate[]
} {
  const batch=db.prepare("SELECT * FROM exact_candidate_batches_v46 WHERE batch_id=?").get(batchId) as ExactCandidateIssuanceBatchRow|undefined;
  if(!batch)throw new Error("candidate batch is unavailable");
  const turn=db.prepare("SELECT id,campaign_id,session_id,actor_id,principal_id FROM adventure_turns WHERE id=?").get(batch.turn_id) as any;
  if(!turn||batch.campaign_id!==turn.campaign_id||batch.session_id!==turn.session_id||batch.actor_id!==turn.actor_id
    ||batch.principal_id!==turn.principal_id||batch.connection_id!==`adventure-turn:${turn.id}`)throw new Error("candidate batch turn binding is invalid");
  const issued=Date.parse(batch.issued_at),expires=Date.parse(batch.expires_at);
  if(!Number.isFinite(issued)||!Number.isFinite(expires)||expires<=issued||expires-issued>MAX_EXACT_CANDIDATE_LIFETIME_MS)
    throw new Error("candidate batch lifetime is invalid");
  const rows=db.prepare("SELECT * FROM exact_candidates_v46 WHERE batch_id=? ORDER BY position").all(batch.batch_id) as ExactCandidateIssuanceRow[];
  if(rows.length!==batch.candidate_count||rows.some((row,index)=>row.position!==index+1))throw new Error("batch positions are not exact contiguous 1..N");
  const candidates=rows.map((row)=>{
    const value=internalExactCandidateSchema.parse(JSON.parse(row.envelope_json));
    const expected:Record<string,unknown>={candidate_id:value.candidateId,batch_id:batch.batch_id,position:row.position,
      campaign_id:value.scope.campaignId,turn_id:batch.turn_id,session_id:value.scope.sessionId,actor_id:value.scope.actorId,
      principal_id:value.scope.principalId,connection_id:value.scope.connectionId,kind:value.kind,version:value.version,
      world_revision:value.expectedRevisions[0].revision,issued_at:value.issuedAt,expires_at:value.expiresAt,
      policy_result:value.policy.result,policy_reason:value.policy.reason,confirmation_requirement:value.confirmation.requirement,
      quote_kind:value.quote.kind,supersession_state:value.supersession.state,execution_state:value.execution.state,
      action_frame:canonicalExactCandidateActionFrame(value),action_digest:value.canonicalActionDigest,
      envelope_frame:canonicalExactCandidateEnvelopeFrame(value),envelope_digest:value.canonicalEnvelopeDigest};
    for(const [key,expectedValue] of Object.entries(expected))if(row[key]!==expectedValue)throw new Error(`candidate ${key} mismatch`);
    if(batch.campaign_id!==value.scope.campaignId||batch.session_id!==value.scope.sessionId||batch.actor_id!==value.scope.actorId
      ||batch.principal_id!==value.scope.principalId||batch.connection_id!==value.scope.connectionId
      ||batch.world_revision!==value.expectedRevisions[0].revision||batch.issued_at!==value.issuedAt||batch.expires_at!==value.expiresAt
      ||value.label.routeOption!==row.position||value.policy.result!=="allowed"||value.confirmation.requirement!=="not-required"
      ||value.quote.kind!=="not-applicable"||value.supersession.state!=="current"||value.execution.state!=="unexecuted")
      throw new Error("candidate batch scope mismatch");
    if(computeExactCandidateActionDigest(value,crypto)!==row.action_digest
      ||computeExactCandidateEnvelopeDigest(value,crypto)!==row.envelope_digest)throw new Error("candidate canonical digest mismatch");
    return value;
  });
  if(new Set(candidates.map(({candidateId})=>candidateId)).size!==candidates.length)throw new Error("candidate IDs are duplicated");
  const requestFrame=canonicalAgentJson({turnId:batch.turn_id,worldRevision:batch.world_revision,candidates} as never);
  if(digest({turnId:batch.turn_id,worldRevision:batch.world_revision,candidates})!==batch.request_digest)
    throw new Error("batch request digest mismatch");
  if(canonicalAgentJson(JSON.parse(requestFrame) as never)!==requestFrame)throw new Error("batch request is not canonical");
  return{batch,rows,candidates};
}
