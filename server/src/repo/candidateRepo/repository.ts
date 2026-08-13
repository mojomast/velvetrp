import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  MAX_EXACT_CANDIDATE_LIFETIME_MS, MAX_EXACT_CANDIDATES_PER_RESPONSE, canonicalAgentJson,
  canonicalExactCandidateActionFrame, canonicalExactCandidateEnvelopeFrame,
  canonicalExactCandidateExecutionResultFrame,canonicalExactCandidateSelectionFrame,
  computeExactCandidateActionDigest, computeExactCandidateEnvelopeDigest,computeExactCandidateExecutionResultDigest,
  computeExactCandidateSelectionDigest,exactCandidateExecutionResultSchema,exactCandidateSelectionResponseSchema,
  internalExactCandidateSchema,resourceIdSchema, utcIsoTimestampSchema,validateExactCandidateSelection,
  verifyExactCandidateExecutionResult,
  type ExactCandidateExecutionResult,type ExactCandidateSelectionResponse,type InternalExactCandidate,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../../runtime.js";
import { evaluateActorTravelPolicy } from "../world/actorTravelPolicy.js";
import { executeActorTravelInTransaction } from "../world/internal.js";
import {verifyExactCandidateIssuanceBatch} from "./issuanceVerifier.js";
import { ExactCandidateAuthorizationError, ExactCandidateConflictError, ExactCandidateExpiredError,
  ExactCandidateIntegrityError, ExactCandidateUnavailableError } from "./errors.js";

type Db=DatabaseDriver.Database;
type TurnRow={id:string;campaign_id:string;session_id:string;actor_id:string;principal_id:string};
type BatchRow={batch_id:string;campaign_id:string;turn_id:string;session_id:string;actor_id:string;principal_id:string;
  idempotency_key:string;connection_id:string;candidate_count:number;world_revision:number;issued_at:string;expires_at:string;request_digest:string};
type CandidateRow={candidate_id:string;batch_id:string;position:number;campaign_id:string;turn_id:string;session_id:string;actor_id:string;
  principal_id:string;connection_id:string;kind:string;version:string;world_revision:number;issued_at:string;expires_at:string;
  policy_result:string;policy_reason:string;confirmation_requirement:string;quote_kind:string;supersession_state:string;execution_state:string;
  action_frame:string;action_digest:string;envelope_frame:string;envelope_digest:string;envelope_json:string};
const crypto={sha256:(frame:string)=>createHash("sha256").update(frame).digest("hex")};
const digest=(value:unknown)=>crypto.sha256(canonicalAgentJson(value as never));
const connection=(turnId:string)=>resourceIdSchema.parse(`adventure-turn:${resourceIdSchema.parse(turnId)}`);
const scopeEqual=(a:InternalExactCandidate,b:InternalExactCandidate)=>canonicalAgentJson(a.scope)===canonicalAgentJson(b.scope);

export interface IssueExactCandidateBatchInput {turnId:string;idempotencyKey:string;worldRevision:number;candidates:readonly InternalExactCandidate[]}
export interface GenerateActorTravelCandidatesInput {turnId:string;idempotencyKey:string;audienceMode?:"principal"|"player"}
export interface ExecuteExactActorTravelCandidateInput {turnId:string;selection:ExactCandidateSelectionResponse}
export interface ExactCandidateBatch {batchId:string;turnId:string;connectionId:string;worldRevision:number;issuedAt:string;expiresAt:string;candidates:InternalExactCandidate[]}
export interface ExactCandidateRepository {
  generateActorTravelCandidates(principalId:string,input:GenerateActorTravelCandidatesInput):ExactCandidateBatch;
  executeExactActorTravelCandidate(principalId:string,input:ExecuteExactActorTravelCandidateInput):ExactCandidateExecutionResult;
  issueExactCandidateBatch(principalId:string,input:IssueExactCandidateBatchInput):ExactCandidateBatch;
  getExactCandidateBatch(principalId:string,batchId:string):ExactCandidateBatch|null;
  getExactCandidate(principalId:string,candidateId:string):InternalExactCandidate|null;
  observeExactCandidateExpiry(principalId:string,candidateId:string):InternalExactCandidate;
  supersedeExactCandidate(principalId:string,sourceCandidateId:string,replacementCandidateId:string):InternalExactCandidate;
  /** Integrity-only committed read used after a separate public membership gate. */
  verifyExactCandidateExecution(candidateId:string):ExactCandidateExecutionResult;
}

export function createExactCandidateRepository(db:Db,deps:{clock:Clock;ids:IdGenerator},guard:()=>void):ExactCandidateRepository {
  const now=()=>utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
  const id=()=>resourceIdSchema.parse(deps.ids.nextId());
  const turn=(turnId:string)=>db.prepare("SELECT id,campaign_id,session_id,actor_id,principal_id FROM adventure_turns WHERE id=?").get(turnId) as TurnRow|undefined;
  const issueAuthority=(principalId:string,row:TurnRow)=>{
    const membership=db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(row.campaign_id,principalId) as {role:string}|undefined;
    return Boolean(membership&&membership.role!=="observer"&&(membership.role==="owner"||membership.role==="gm"||db.prepare(
      "SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?").get(row.campaign_id,row.actor_id,principalId)));
  };
  const authorizePrivate=(principalId:string,row:{turn_id:string})=>{
    const owner=turn(row.turn_id);
    return owner&&owner.principal_id===principalId&&issueAuthority(principalId,owner)?owner:undefined;
  };
  const timestampMillis=(value:unknown,label:string)=>{try{return Date.parse(utcIsoTimestampSchema.parse(value));}
    catch(error){throw new ExactCandidateIntegrityError(`${label} is not a canonical UTC timestamp`,{cause:error});}};
  const verifyBatchTurn=(row:BatchRow,owner:TurnRow)=>{
    if(row.campaign_id!==owner.campaign_id||row.turn_id!==owner.id||row.session_id!==owner.session_id||row.actor_id!==owner.actor_id
      ||row.principal_id!==owner.principal_id||row.connection_id!==connection(owner.id))throw new ExactCandidateIntegrityError("candidate batch turn binding is invalid");
    const issuedAt=timestampMillis(row.issued_at,"candidate batch issued_at"),expiresAt=timestampMillis(row.expires_at,"candidate batch expires_at");
    if(expiresAt<=issuedAt||expiresAt-issuedAt>MAX_EXACT_CANDIDATE_LIFETIME_MS)throw new ExactCandidateIntegrityError("candidate batch lifetime is invalid");
  };
  const requestDigest=(turnId:string,worldRevision:number,candidates:readonly InternalExactCandidate[])=>digest({turnId,worldRevision,candidates});
  const verifyCandidate=(row:CandidateRow,batch:BatchRow):InternalExactCandidate=>{
    try{
      const value=internalExactCandidateSchema.parse(JSON.parse(row.envelope_json));
      const issuedAt=timestampMillis(row.issued_at,"candidate issued_at"),expiresAt=timestampMillis(row.expires_at,"candidate expires_at");
      if(expiresAt<=issuedAt||expiresAt-issuedAt>MAX_EXACT_CANDIDATE_LIFETIME_MS)throw new Error("candidate lifetime is invalid");
      const expected={candidate_id:value.candidateId,batch_id:batch.batch_id,campaign_id:value.scope.campaignId,turn_id:batch.turn_id,
        session_id:value.scope.sessionId,actor_id:value.scope.actorId,principal_id:value.scope.principalId,connection_id:value.scope.connectionId,
        kind:value.kind,version:value.version,world_revision:value.expectedRevisions[0].revision,issued_at:value.issuedAt,expires_at:value.expiresAt,
        policy_result:value.policy.result,policy_reason:value.policy.reason,confirmation_requirement:value.confirmation.requirement,
        quote_kind:value.quote.kind,supersession_state:value.supersession.state,execution_state:value.execution.state,
        action_frame:canonicalExactCandidateActionFrame(value),action_digest:value.canonicalActionDigest,
        envelope_frame:canonicalExactCandidateEnvelopeFrame(value),envelope_digest:value.canonicalEnvelopeDigest};
      for(const [key,expectedValue] of Object.entries(expected))if(row[key as keyof CandidateRow]!==expectedValue)throw new Error(`candidate ${key} mismatch`);
      if(row.position<1||row.position>batch.candidate_count||batch.campaign_id!==row.campaign_id||batch.session_id!==row.session_id
        ||batch.actor_id!==row.actor_id||batch.principal_id!==row.principal_id||batch.connection_id!==row.connection_id
        ||batch.world_revision!==row.world_revision||batch.issued_at!==row.issued_at||batch.expires_at!==row.expires_at)throw new Error("candidate batch scope mismatch");
      if(computeExactCandidateActionDigest(value,crypto)!==row.action_digest||computeExactCandidateEnvelopeDigest(value,crypto)!==row.envelope_digest)throw new Error("candidate digest mismatch");
      return value;
    }catch(error){throw new ExactCandidateIntegrityError("candidate integrity verification failed",{cause:error});}
  };
  const current=(row:CandidateRow,batchRow:BatchRow):InternalExactCandidate=>{
    const value=verifyCandidate(row,batchRow);
    const expiration=db.prepare("SELECT * FROM exact_candidate_expirations_v46 WHERE candidate_id=?").get(row.candidate_id) as any;
    if(expiration){for(const key of ["candidate_id","campaign_id","turn_id","session_id","actor_id","principal_id","connection_id","kind","version","expires_at"])
      if(expiration[key]!==row[key as keyof CandidateRow])throw new ExactCandidateIntegrityError("candidate expiration binding is invalid");
      if(timestampMillis(expiration.observed_at,"candidate expiration observed_at")<timestampMillis(row.expires_at,"candidate expires_at"))throw new ExactCandidateIntegrityError("candidate expiration observation predates expiry");}
    const supersession=db.prepare("SELECT * FROM exact_candidate_supersessions_v46 WHERE source_candidate_id=?").get(row.candidate_id) as any;
    if(!supersession)return value;
    for(const key of ["campaign_id","turn_id","session_id","actor_id","principal_id","connection_id","kind","version"])
      if(supersession[key]!==row[key as keyof CandidateRow])throw new ExactCandidateIntegrityError("candidate supersession binding is invalid");
    if(timestampMillis(supersession.superseded_at,"candidate superseded_at")<timestampMillis(value.issuedAt,"candidate issued_at"))throw new ExactCandidateIntegrityError("candidate supersession predates issuance");
    const replacementRow=db.prepare("SELECT * FROM exact_candidates_v46 WHERE candidate_id=?").get(supersession.replacement_candidate_id) as CandidateRow|undefined;
    if(!replacementRow)throw new ExactCandidateIntegrityError("candidate replacement is unavailable");
    const replacementBatch=db.prepare("SELECT * FROM exact_candidate_batches_v46 WHERE batch_id=?").get(replacementRow.batch_id) as BatchRow;
    const replacement=verifyCandidate(replacementRow,replacementBatch);if(!scopeEqual(value,replacement))throw new ExactCandidateIntegrityError("candidate replacement scope is invalid");
    const seen=new Set<string>([row.candidate_id]);let cursor:string|undefined=replacement.candidateId;
    while(cursor){if(seen.has(cursor))throw new ExactCandidateIntegrityError("candidate supersession cycle detected");seen.add(cursor);
      cursor=(db.prepare("SELECT replacement_candidate_id id FROM exact_candidate_supersessions_v46 WHERE source_candidate_id=?").get(cursor) as {id:string}|undefined)?.id;}
    const updated={...value,supersession:{state:"superseded" as const,supersededAt:supersession.superseded_at,
      replacement:{candidateId:replacement.candidateId,kind:replacement.kind,version:replacement.version,scope:replacement.scope}}};
    return internalExactCandidateSchema.parse({...updated,canonicalEnvelopeDigest:computeExactCandidateEnvelopeDigest(updated,crypto)});
  };
  /** Reconstructs immutable issuance only; derived lifecycle observations never alter the batch request digest. */
  const originalBatch=(batchRow:BatchRow,owner:TurnRow):{rows:CandidateRow[];candidates:InternalExactCandidate[]}=>{try{
    verifyBatchTurn(batchRow,owner);const verified=verifyExactCandidateIssuanceBatch(db,batchRow.batch_id);
    return {rows:verified.rows as CandidateRow[],candidates:verified.candidates};
  }catch(error){if(error instanceof ExactCandidateIntegrityError)throw error;throw new ExactCandidateIntegrityError("candidate batch integrity verification failed",{cause:error});}};
  const executionRow=(candidateId:string)=>db.prepare("SELECT * FROM exact_candidate_executions_v47 WHERE candidate_id=?").get(candidateId) as any|undefined;
  const verifyExecution=(row:any,original:InternalExactCandidate):ExactCandidateExecutionResult=>{try{
    const linked=internalExactCandidateSchema.parse(JSON.parse(row.linked_envelope_json));
    const result=exactCandidateExecutionResultSchema.parse(JSON.parse(row.result_json));
    const scopeFrame=canonicalAgentJson(original.scope as never),selectionFrame=canonicalExactCandidateSelectionFrame(result.selection);
    const worldKey=`exact-candidate:${original.canonicalActionDigest}`;
    const worldCommand={type:"travel",campaignId:original.scope.campaignId,
      travelId:`travel:${digest({campaignId:original.scope.campaignId,sessionId:original.scope.sessionId,actorId:original.scope.actorId,idempotencyKey:worldKey}).slice(0,40)}`,
      locationConnectionId:original.privateParameters.connectionId,selectedPartyActorIds:original.privateParameters.partyActorIds,
      expectedRevision:original.expectedRevisions[0].revision,idempotencyKey:worldKey};
    const commandJson=canonicalAgentJson(worldCommand as never),resultJson=canonicalAgentJson(result.actorTravelResult as never);
    const expected:any={execution_id:result.executionId,candidate_id:original.candidateId,campaign_id:original.scope.campaignId,
      session_id:original.scope.sessionId,actor_id:original.scope.actorId,principal_id:original.scope.principalId,connection_id:original.scope.connectionId,
      kind:original.kind,version:original.version,action_frame:canonicalExactCandidateActionFrame(original),action_digest:original.canonicalActionDigest,
      scope_frame:scopeFrame,scope_digest:crypto.sha256(scopeFrame),selection_candidate_id:result.selection.candidateId,selection_kind:result.selection.kind,
      selection_version:result.selection.version,selection_frame:selectionFrame,selection_digest:computeExactCandidateSelectionDigest(result.selection,crypto),
      world_idempotency_key:`exact-candidate:${original.canonicalActionDigest}`,world_command_id:result.actorTravelResult.receipt.commandId,world_actor_id:original.scope.actorId,
      world_command_type:"travel",world_expected_revision:original.expectedRevisions[0].revision,
      world_revision:result.actorTravelResult.receipt.revisionAfter,world_created_at:row.linked_at,world_request_json:commandJson,
      world_request_digest:crypto.sha256(commandJson),world_result_json:resultJson,world_result_digest:crypto.sha256(resultJson),
      travel_id:worldCommand.travelId,destination_location_id:result.actorTravelResult.locations[0]?.locationId,
      party_actor_ids_json:canonicalAgentJson(original.privateParameters.partyActorIds as never),
      linked_envelope_frame:canonicalExactCandidateEnvelopeFrame(linked),
      linked_envelope_digest:linked.canonicalEnvelopeDigest,result_frame:canonicalExactCandidateExecutionResultFrame(result),
      result_digest:result.canonicalResultDigest,linked_at:linked.execution.state==="receipt-linked"?linked.execution.linkedAt:""};
    for(const [key,value] of Object.entries(expected))if(row[key]!==value)throw new Error(`execution ${key} mismatch`);
    if(linked.execution.state!=="receipt-linked"||linked.execution.receiptId!==row.execution_id||result.linkedCandidate.canonicalEnvelopeDigest!==linked.canonicalEnvelopeDigest
      ||canonicalExactCandidateEnvelopeFrame(result.linkedCandidate)!==row.linked_envelope_frame
      ||computeExactCandidateEnvelopeDigest(linked,crypto)!==row.linked_envelope_digest
      ||!verifyExactCandidateExecutionResult(result,crypto))throw new Error("execution cryptographic binding mismatch");
    const command=db.prepare("SELECT * FROM world_commands_v28 WHERE campaign_id=? AND session_id=? AND command_id=?").get(row.campaign_id,row.session_id,row.world_command_id) as any;
    const receipt=db.prepare("SELECT * FROM world_receipts_v28 WHERE campaign_id=? AND session_id=? AND command_id=?").get(row.campaign_id,row.session_id,row.world_command_id) as any;
    if(!command||!receipt||command.actor_id!==original.scope.actorId||command.command_type!=="travel"||command.idempotency_key!==worldKey
      ||command.canonical_request_json!==commandJson||command.request_digest!==crypto.sha256(commandJson)
      ||result.actorTravelResult.receipt.idempotencyKey!==worldKey||row.world_idempotency_key!==worldKey
      ||command.expected_revision!==original.expectedRevisions[0].revision||command.resulting_revision!==row.world_revision||command.created_at!==row.linked_at
      ||receipt.resulting_revision!==row.world_revision||receipt.canonical_result_json!==resultJson||receipt.result_digest!==crypto.sha256(resultJson)
      ||receipt.occurred_at!==row.linked_at)throw new Error("world command or receipt binding mismatch");
    const events=db.prepare("SELECT * FROM world_events_v28 WHERE campaign_id=? AND session_id=? AND command_id=?").all(row.campaign_id,row.session_id,row.world_command_id) as any[];
    const destination=db.prepare("SELECT * FROM world_travel_destinations_v28 WHERE campaign_id=? AND session_id=? AND command_id=?").all(row.campaign_id,row.session_id,row.world_command_id) as any[];
    const party=db.prepare("SELECT actor_id FROM world_travel_party_members_v28 WHERE campaign_id=? AND session_id=? AND command_id=? ORDER BY actor_id COLLATE BINARY").all(row.campaign_id,row.session_id,row.world_command_id) as Array<{actor_id:string}>;
    const travelId=worldCommand.travelId,expectedEvent=canonicalAgentJson({travelId,destinationLocationId:result.actorTravelResult.locations[0]?.locationId} as never);
    if(events.length!==1||events[0].event_type!=="travelled"||events[0].resulting_revision!==row.world_revision||events[0].occurred_at!==row.linked_at
      ||events[0].event_json!==expectedEvent
      ||destination.length!==1||destination[0].connection_id!==original.privateParameters.connectionId
      ||destination[0].destination_location_id!==result.actorTravelResult.locations[0]?.locationId
      ||canonicalAgentJson(party.map(({actor_id})=>actor_id).sort() as never)!==canonicalAgentJson([...original.privateParameters.partyActorIds].sort() as never))throw new Error("world travel evidence binding mismatch");
    return result;
  }catch(error){throw new ExactCandidateIntegrityError("candidate execution integrity verification failed",{cause:error});}};
  const readBatch=(principalId:string,batchId:string):ExactCandidateBatch|null=>{
    const row=db.prepare("SELECT * FROM exact_candidate_batches_v46 WHERE batch_id=?").get(batchId) as BatchRow|undefined;
    const owner=row&&authorizePrivate(principalId,row);if(!row||!owner)return null;
    try{
      verifyBatchTurn(row,owner);
      const {rows,candidates:originals}=originalBatch(row,owner);
      const candidates=rows.map((candidate)=>current(candidate,row));
      if(originals.length!==candidates.length)throw new Error("candidate batch reconstruction mismatch");
      return {batchId:row.batch_id,turnId:row.turn_id,connectionId:row.connection_id,worldRevision:row.world_revision,
        issuedAt:row.issued_at,expiresAt:row.expires_at,candidates};
    }catch(error){if(error instanceof ExactCandidateIntegrityError)throw error;throw new ExactCandidateIntegrityError("candidate batch integrity verification failed",{cause:error});}
  };
  const locateAuthorized=(principalId:string,candidateId:string)=>{
    const row=db.prepare("SELECT * FROM exact_candidates_v46 WHERE candidate_id=?").get(candidateId) as CandidateRow|undefined;
    const owner=row&&authorizePrivate(principalId,row);if(!row||!owner)return null;
    const batchRow=db.prepare("SELECT * FROM exact_candidate_batches_v46 WHERE batch_id=?").get(row.batch_id) as BatchRow|undefined;
    if(!batchRow)throw new ExactCandidateIntegrityError("candidate batch is unavailable");verifyBatchTurn(batchRow,owner);return{row,batchRow};
  };
  const readByIssueKey=(principalId:string,turnId:string,idempotencyKey:string):ExactCandidateBatch|null=>{
    resourceIdSchema.parse(turnId);resourceIdSchema.parse(idempotencyKey);
    const row=db.prepare("SELECT batch_id FROM exact_candidate_batches_v46 WHERE turn_id=? AND principal_id=? AND idempotency_key=?")
      .get(turnId,principalId,idempotencyKey) as {batch_id:string}|undefined;
    return row?readBatch(principalId,row.batch_id):null;
  };
  const issue=(principalId:string,input:IssueExactCandidateBatchInput,generatedAt?:string):ExactCandidateBatch=>{
    resourceIdSchema.parse(input.turnId);resourceIdSchema.parse(input.idempotencyKey);
    if(!Number.isSafeInteger(input.worldRevision)||input.worldRevision<0||input.worldRevision>Number.MAX_SAFE_INTEGER-1)throw new ExactCandidateConflictError("world revision is invalid");
    if(input.candidates.length>MAX_EXACT_CANDIDATES_PER_RESPONSE)throw new ExactCandidateConflictError("candidate batch exceeds 32 routes");
    const owner=turn(input.turnId);
    if(!owner||owner.principal_id!==principalId||!issueAuthority(principalId,owner))
      throw new ExactCandidateAuthorizationError("candidate issuance is unavailable");
    const parsed=input.candidates.map((candidate,index)=>{const value=internalExactCandidateSchema.parse(candidate);
      if(value.scope.campaignId!==owner.campaign_id||value.scope.sessionId!==owner.session_id||value.scope.actorId!==owner.actor_id||value.scope.principalId!==principalId
        ||value.scope.connectionId!==connection(input.turnId)||value.expectedRevisions[0].revision!==input.worldRevision||value.label.routeOption!==index+1
        ||value.privateParameters.partyActorIds[0]!==value.scope.actorId||value.confirmation.requirement!=="not-required"||value.quote.kind!=="not-applicable"
        ||value.policy.result!=="allowed"||value.supersession.state!=="current"||value.execution.state!=="unexecuted")throw new ExactCandidateConflictError("candidate does not match exact turn scope and policy");
      if(computeExactCandidateActionDigest(value,crypto)!==value.canonicalActionDigest||computeExactCandidateEnvelopeDigest(value,crypto)!==value.canonicalEnvelopeDigest)throw new ExactCandidateIntegrityError("candidate digest is invalid");return value;});
    const requestedDigest=requestDigest(input.turnId,input.worldRevision,parsed);
    const existing=db.prepare("SELECT * FROM exact_candidate_batches_v46 WHERE turn_id=? AND principal_id=? AND idempotency_key=?").get(input.turnId,principalId,input.idempotencyKey) as BatchRow|undefined;
    if(existing){if(existing.request_digest!==requestedDigest)throw new ExactCandidateConflictError("idempotency key was reused");const replay=readBatch(principalId,existing.batch_id);if(!replay)throw new ExactCandidateUnavailableError("candidate batch is unavailable");return replay;}
    const serverIssuedAt=generatedAt??now();
    const issuedAt=parsed[0]?.issuedAt??serverIssuedAt;const expiresAt=parsed[0]?.expiresAt??new Date(Date.parse(issuedAt)+MAX_EXACT_CANDIDATE_LIFETIME_MS).toISOString();
    if(issuedAt!==serverIssuedAt)throw new ExactCandidateConflictError("candidate issuance time must equal server time");
    if(parsed.some((value)=>value.issuedAt!==issuedAt||value.expiresAt!==expiresAt))throw new ExactCandidateConflictError("batch lifetime must be exact");
    const candidateIds=parsed.map((value)=>value.candidateId);
    if(new Set(candidateIds).size!==candidateIds.length)throw new ExactCandidateConflictError("candidate IDs must be unique");
    if(candidateIds.length&&db.prepare(`SELECT 1 FROM exact_candidates_v46 WHERE candidate_id IN (${candidateIds.map(()=>"?").join(",")}) LIMIT 1`).get(...candidateIds))
      throw new ExactCandidateConflictError("candidate ID collision");
    return db.transaction(()=>{const batchId=id();db.prepare(`INSERT INTO exact_candidate_batches_v46 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(batchId,owner.campaign_id,input.turnId,owner.session_id,owner.actor_id,principalId,input.idempotencyKey,connection(input.turnId),parsed.length,input.worldRevision,issuedAt,expiresAt,requestedDigest);
      const insert=db.prepare(`INSERT INTO exact_candidates_v46 VALUES(${Array.from({length:25},()=>"?").join(",")})`);
      parsed.forEach((value,index)=>insert.run(value.candidateId,batchId,index+1,value.scope.campaignId,input.turnId,value.scope.sessionId,value.scope.actorId,
        value.scope.principalId,value.scope.connectionId,value.kind,value.version,value.expectedRevisions[0].revision,value.issuedAt,value.expiresAt,value.policy.result,
        value.policy.reason,value.confirmation.requirement,value.quote.kind,value.supersession.state,value.execution.state,canonicalExactCandidateActionFrame(value),
        value.canonicalActionDigest,canonicalExactCandidateEnvelopeFrame(value),value.canonicalEnvelopeDigest,JSON.stringify(value)));
      const persisted=readBatch(principalId,batchId);
      if(!persisted)throw new ExactCandidateIntegrityError("persisted candidate batch is unavailable after insert");
      return persisted;}).immediate();
  };
  return {
    verifyExactCandidateExecution(candidateId){resourceIdSchema.parse(candidateId);
      const row=db.prepare("SELECT * FROM exact_candidates_v46 WHERE candidate_id=?").get(candidateId) as CandidateRow|undefined;
      if(!row)throw new ExactCandidateUnavailableError("candidate execution is unavailable");
      const batchRow=db.prepare("SELECT * FROM exact_candidate_batches_v46 WHERE batch_id=?").get(row.batch_id) as BatchRow|undefined;
      const owner=batchRow&&turn(batchRow.turn_id);if(!batchRow||!owner)throw new ExactCandidateIntegrityError("candidate execution ancestry is unavailable");
      const issuance=originalBatch(batchRow,owner),original=issuance.candidates.find((candidate)=>candidate.candidateId===candidateId);
      const execution=executionRow(candidateId);if(!original||!execution)throw new ExactCandidateIntegrityError("candidate execution evidence is unavailable");
      return verifyExecution(execution,original);},
    generateActorTravelCandidates(principalId,input){guard();resourceIdSchema.parse(principalId);resourceIdSchema.parse(input.turnId);resourceIdSchema.parse(input.idempotencyKey);
      const audienceMode=input.audienceMode??"principal";
      if(audienceMode==="player"&&!input.idempotencyKey.startsWith("provider-player:"))throw new ExactCandidateConflictError("player candidate batch key is invalid");
      const replay=readByIssueKey(principalId,input.turnId,input.idempotencyKey);if(replay)return replay;
      return db.transaction(()=>{
        const concurrentReplay=readByIssueKey(principalId,input.turnId,input.idempotencyKey);if(concurrentReplay)return concurrentReplay;
        const row=db.prepare(`SELECT turn.id,turn.campaign_id,turn.session_id,turn.actor_id,turn.principal_id,membership.role
          FROM adventure_turns turn JOIN campaigns campaign ON campaign.id=turn.campaign_id AND campaign.active_timeline_id=turn.timeline_id
          JOIN campaign_memberships membership ON membership.campaign_id=turn.campaign_id AND membership.principal_id=?
          JOIN campaign_sessions attached ON attached.campaign_id=turn.campaign_id AND attached.session_id=turn.session_id
          JOIN sessions session ON session.id=attached.session_id JOIN campaign_actors actor ON actor.campaign_id=turn.campaign_id AND actor.id=turn.actor_id
          JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
          JOIN session_characters participant ON participant.session_id=turn.session_id AND participant.character_id=character.character_id
          LEFT JOIN campaign_actor_private_state control ON control.campaign_id=turn.campaign_id AND control.actor_id=turn.actor_id
          WHERE turn.id=? AND turn.principal_id=? AND campaign.lifecycle_status IN ('draft','published')
            AND session.state='active' AND session.stopped_at IS NULL AND membership.role<>'observer'
            AND (membership.role IN ('owner','gm') OR (membership.role='player' AND control.controller_principal_id=?))`)
          .get(principalId,input.turnId,principalId,principalId) as (TurnRow&{role:string})|undefined;
        if(!row)throw new ExactCandidateAuthorizationError("authoritative current turn authority is unavailable");
        const revision=(db.prepare(`SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id=?`)
          .get(row.campaign_id,row.session_id) as {revision:number}|undefined)?.revision??0;
        const routes=(db.prepare(`SELECT connection_id FROM campaign_location_connections_v28
          WHERE campaign_id=? ORDER BY connection_id COLLATE BINARY`).all(row.campaign_id) as Array<{connection_id:string}>)
          .map(({connection_id})=>evaluateActorTravelPolicy(db,{campaignId:row.campaign_id,sessionId:row.session_id,
            actorId:row.actor_id,principalId,partyActorIds:[row.actor_id],connectionId:connection_id,requireRunningSession:true,audienceMode}))
          .filter((result):result is Extract<typeof result,{allowed:true}>=>result.allowed)
          .map((result)=>result.route);
        if(routes.length>MAX_EXACT_CANDIDATES_PER_RESPONSE)throw new ExactCandidateConflictError("legal route count exceeds exact candidate limit");
        const issuedAt=now(),expiresAt=new Date(Date.parse(issuedAt)+MAX_EXACT_CANDIDATE_LIFETIME_MS).toISOString();
        const candidateIds=routes.map(()=>id());
        if(new Set(candidateIds).size!==candidateIds.length)throw new ExactCandidateConflictError("generated candidate IDs must be unique");
        const candidates=routes.map((route,index)=>{
          const unsigned:any={candidateId:candidateIds[index]!,kind:"actor.travel",version:"v1",purpose:"execute-once",
            scope:{campaignId:row.campaign_id,sessionId:row.session_id,actorId:row.actor_id,principalId,connectionId:connection(row.id),authorizationEffect:"none"},
            label:{format:"message-key-v1",key:"candidate.actor.travel.label",routeOption:index+1},summary:{format:"message-key-v1",key:"candidate.actor.travel.summary"},
            canonicalActionDigest:"0".repeat(64),canonicalEnvelopeDigest:"0".repeat(64),privateParameters:{kind:"actor.travel",connectionId:route.connectionId,partyActorIds:[row.actor_id]},
            expectedRevisions:[{domain:"world",revision}],policy:{kind:"actor.travel",result:"allowed",reason:"legal-visible-connection"},
            confirmation:{requirement:"not-required",decision:{state:"not-applicable"}},quote:{kind:"not-applicable"},issuedAt,expiresAt,
            supersession:{state:"current"},execution:{state:"unexecuted"},executionRequiresAuthorityRecheck:true};
          const action={...unsigned,canonicalActionDigest:computeExactCandidateActionDigest(unsigned,crypto)};
          return internalExactCandidateSchema.parse({...action,canonicalEnvelopeDigest:computeExactCandidateEnvelopeDigest(action,crypto)});
        });
        return issue(principalId,{turnId:row.id,idempotencyKey:input.idempotencyKey,worldRevision:revision,candidates},issuedAt);
      }).immediate();
    },
    issueExactCandidateBatch(principalId,input){guard();return issue(principalId,input);},
    executeExactActorTravelCandidate(principalId,input){guard();resourceIdSchema.parse(principalId);resourceIdSchema.parse(input.turnId);
      const selection=exactCandidateSelectionResponseSchema.parse(input.selection);
      return db.transaction(()=>{
        // Current authority is intentionally checked before replay; lifecycle and world gates are intentionally after it.
        const owner=turn(input.turnId);if(!owner||owner.principal_id!==principalId||!issueAuthority(principalId,owner))
          throw new ExactCandidateAuthorizationError("authoritative current turn authority is unavailable");
        const located=locateAuthorized(principalId,selection.candidateId);if(!located||located.row.turn_id!==input.turnId)
          throw new ExactCandidateUnavailableError("candidate is unavailable");
        const issuance=originalBatch(located.batchRow,owner),original=issuance.candidates.find(({candidateId})=>candidateId===selection.candidateId);
        if(!original)throw new ExactCandidateIntegrityError("candidate is absent from its owning batch");
        const existing=executionRow(selection.candidateId);
        if(existing){const replay=verifyExecution(existing,original);if(canonicalExactCandidateSelectionFrame(replay.selection)!==canonicalExactCandidateSelectionFrame(selection))
          throw new ExactCandidateConflictError("candidate replay selection does not match");return replay;}
        const batch=readBatch(principalId,located.batchRow.batch_id);if(!batch)throw new ExactCandidateUnavailableError("candidate batch is unavailable");
        const at=now(),revision=(db.prepare("SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id=?").get(owner.campaign_id,owner.session_id) as {revision:number}|undefined)?.revision??0;
        const boundary=validateExactCandidateSelection(selection,batch.candidates,{campaignId:owner.campaign_id,sessionId:owner.session_id,
          actorId:owner.actor_id,principalId,connectionId:connection(owner.id),now:at,observedRevisions:{world:revision}},crypto);
        if(!boundary.ok)throw new ExactCandidateConflictError(`candidate selection rejected: ${boundary.code}`);
        const providerPlayer=located.batchRow.idempotency_key.startsWith("provider-player:");
        const policy=evaluateActorTravelPolicy(db,{campaignId:owner.campaign_id,sessionId:owner.session_id,actorId:owner.actor_id,principalId,
          partyActorIds:boundary.candidate.privateParameters.partyActorIds,connectionId:boundary.candidate.privateParameters.connectionId,
          requireRunningSession:true,audienceMode:providerPlayer?"player":"principal"});
        if(!policy.allowed)throw new ExactCandidateUnavailableError("candidate route is unavailable");
        const executionId=id(),worldKey=`exact-candidate:${boundary.candidate.canonicalActionDigest}`;
        const actorTravelResult=executeActorTravelInTransaction(db,{clock:{now:()=>new Date(at)},ids:deps.ids},principalId,owner.session_id,owner.actor_id,
          {connectionId:boundary.candidate.privateParameters.connectionId,partyActorIds:boundary.candidate.privateParameters.partyActorIds,
            expectedRevision:revision,idempotencyKey:worldKey});
        const binding={candidateId:boundary.candidate.candidateId,kind:boundary.candidate.kind,version:boundary.candidate.version,
          scope:boundary.candidate.scope,canonicalActionDigest:boundary.candidate.canonicalActionDigest,commandId:actorTravelResult.receipt.commandId};
        const linkedUnsigned={...boundary.candidate,execution:{state:"receipt-linked" as const,receiptId:executionId,binding,linkedAt:at}};
        const linkedCandidate=internalExactCandidateSchema.parse({...linkedUnsigned,canonicalEnvelopeDigest:computeExactCandidateEnvelopeDigest(linkedUnsigned,crypto)});
        const selectionDigest=computeExactCandidateSelectionDigest(selection,crypto),resultUnsigned={version:"v1" as const,executionId,selection,
          canonicalSelectionDigest:selectionDigest,linkedCandidate,actorTravelResult,canonicalResultDigest:"0".repeat(64)};
        const result=exactCandidateExecutionResultSchema.parse({...resultUnsigned,canonicalResultDigest:computeExactCandidateExecutionResultDigest(resultUnsigned,crypto)});
        const scopeFrame=canonicalAgentJson(linkedCandidate.scope as never);
        const worldCommand={type:"travel",campaignId:linkedCandidate.scope.campaignId,
          travelId:`travel:${digest({campaignId:linkedCandidate.scope.campaignId,sessionId:owner.session_id,actorId:owner.actor_id,idempotencyKey:worldKey}).slice(0,40)}`,
          locationConnectionId:linkedCandidate.privateParameters.connectionId,selectedPartyActorIds:linkedCandidate.privateParameters.partyActorIds,
          expectedRevision:linkedCandidate.expectedRevisions[0].revision,idempotencyKey:worldKey};
        const worldRequestJson=canonicalAgentJson(worldCommand as never),worldResultJson=canonicalAgentJson(actorTravelResult as never);
        const partyJson=canonicalAgentJson(linkedCandidate.privateParameters.partyActorIds as never);
        const inserted=db.prepare(`INSERT INTO exact_candidate_executions_v47 VALUES(${Array.from({length:40},()=>"?").join(",")})`).run(executionId,
          linkedCandidate.candidateId,owner.campaign_id,owner.id,owner.session_id,owner.actor_id,principalId,linkedCandidate.scope.connectionId,linkedCandidate.kind,linkedCandidate.version,
          canonicalExactCandidateActionFrame(linkedCandidate),linkedCandidate.canonicalActionDigest,scopeFrame,crypto.sha256(scopeFrame),selection.candidateId,selection.kind,selection.version,
          canonicalExactCandidateSelectionFrame(selection),selectionDigest,worldKey,actorTravelResult.receipt.commandId,owner.actor_id,"travel",boundary.candidate.expectedRevisions[0].revision,
          actorTravelResult.receipt.revisionAfter,at,worldRequestJson,crypto.sha256(worldRequestJson),worldResultJson,crypto.sha256(worldResultJson),
          worldCommand.travelId,actorTravelResult.locations[0]!.locationId,partyJson,
          canonicalExactCandidateEnvelopeFrame(linkedCandidate),linkedCandidate.canonicalEnvelopeDigest,
          JSON.stringify(linkedCandidate),canonicalExactCandidateExecutionResultFrame(result),result.canonicalResultDigest,JSON.stringify(result),at);
        if(inserted.changes!==1)throw new ExactCandidateConflictError("candidate execution link was not created");
        const persisted=executionRow(selection.candidateId);if(!persisted)throw new ExactCandidateIntegrityError("candidate execution link is unavailable after insert");
        return verifyExecution(persisted,boundary.candidate);
      }).immediate();},
    getExactCandidateBatch:readBatch,
    getExactCandidate(principalId,candidateId){const located=locateAuthorized(principalId,candidateId);return located?current(located.row,located.batchRow):null;},
    observeExactCandidateExpiry(principalId,candidateId){guard();const located=locateAuthorized(principalId,candidateId);if(!located)throw new ExactCandidateUnavailableError("candidate is unavailable");
      const at=now();if(Date.parse(at)<Date.parse(located.row.expires_at))throw new ExactCandidateExpiredError("candidate has not expired");
      db.transaction(()=>{const existing=db.prepare("SELECT 1 FROM exact_candidate_expirations_v46 WHERE candidate_id=?").get(candidateId);if(!existing)db.prepare("INSERT INTO exact_candidate_expirations_v46 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id(),candidateId,located.row.campaign_id,located.row.turn_id,located.row.session_id,located.row.actor_id,located.row.principal_id,located.row.connection_id,located.row.kind,located.row.version,located.row.expires_at,at);}).immediate();
      return current(located.row,located.batchRow);},
    supersedeExactCandidate(principalId,sourceId,replacementId){guard();return db.transaction(()=>{
      const source=locateAuthorized(principalId,sourceId),replacement=locateAuthorized(principalId,replacementId);
      if(!source||!replacement)throw new ExactCandidateUnavailableError("candidate is unavailable");
      const sourceValue=current(source.row,source.batchRow),replacementValue=current(replacement.row,replacement.batchRow);
      if(sourceValue.supersession.state!=="current"||replacementValue.supersession.state!=="current"||sourceValue.kind!==replacementValue.kind
        ||sourceValue.version!==replacementValue.version||!scopeEqual(sourceValue,replacementValue))
        throw new ExactCandidateConflictError("replacement must be current and retain exact scope");
      let cursor:string|undefined=replacementId;const seen=new Set([sourceId]);while(cursor){
        if(seen.has(cursor))throw new ExactCandidateConflictError("candidate supersession cycle");seen.add(cursor);
        cursor=(db.prepare("SELECT replacement_candidate_id id FROM exact_candidate_supersessions_v46 WHERE source_candidate_id=?").get(cursor) as {id:string}|undefined)?.id;
      }
      const at=now(),atMillis=timestampMillis(at,"candidate superseded_at");
      const sourceIssued=timestampMillis(sourceValue.issuedAt,"source candidate issued_at"),replacementIssued=timestampMillis(replacementValue.issuedAt,"replacement candidate issued_at");
      const sourceExpires=timestampMillis(sourceValue.expiresAt,"source candidate expires_at"),replacementExpires=timestampMillis(replacementValue.expiresAt,"replacement candidate expires_at");
      if(atMillis<sourceIssued||atMillis<replacementIssued||atMillis>=sourceExpires||atMillis>=replacementExpires)
        throw new ExactCandidateConflictError("supersession time must be within both candidate lifetimes");
      db.prepare("INSERT INTO exact_candidate_supersessions_v46 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(sourceId,replacementId,
        source.row.campaign_id,source.row.turn_id,source.row.session_id,source.row.actor_id,source.row.principal_id,source.row.connection_id,
        source.row.kind,source.row.version,at);
      return current(source.row,source.batchRow);
    }).immediate();},
  };
}
