import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  MAX_EXACT_CANDIDATE_LIFETIME_MS, MAX_EXACT_CANDIDATES_PER_RESPONSE, canonicalAgentJson,
  canonicalExactCandidateActionFrame, canonicalExactCandidateEnvelopeFrame,
  computeExactCandidateActionDigest, computeExactCandidateEnvelopeDigest, internalExactCandidateSchema,
  resourceIdSchema, utcIsoTimestampSchema, type InternalExactCandidate,
} from "@velvet/contracts";
import type { Clock, IdGenerator } from "../../runtime.js";
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
export interface ExactCandidateBatch {batchId:string;turnId:string;connectionId:string;worldRevision:number;issuedAt:string;expiresAt:string;candidates:InternalExactCandidate[]}
export interface ExactCandidateRepository {
  issueExactCandidateBatch(principalId:string,input:IssueExactCandidateBatchInput):ExactCandidateBatch;
  getExactCandidateBatch(principalId:string,batchId:string):ExactCandidateBatch|null;
  getExactCandidate(principalId:string,candidateId:string):InternalExactCandidate|null;
  observeExactCandidateExpiry(principalId:string,candidateId:string):InternalExactCandidate;
  supersedeExactCandidate(principalId:string,sourceCandidateId:string,replacementCandidateId:string):InternalExactCandidate;
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
  const readBatch=(principalId:string,batchId:string):ExactCandidateBatch|null=>{
    const row=db.prepare("SELECT * FROM exact_candidate_batches_v46 WHERE batch_id=?").get(batchId) as BatchRow|undefined;
    const owner=row&&authorizePrivate(principalId,row);if(!row||!owner)return null;
    try{
      verifyBatchTurn(row,owner);
      const rows=db.prepare("SELECT * FROM exact_candidates_v46 WHERE batch_id=? ORDER BY position").all(batchId) as CandidateRow[];
      if(rows.length!==row.candidate_count||rows.some((candidate,index)=>candidate.position!==index+1))throw new Error("batch positions are not exact contiguous 1..N");
      const candidates=rows.map((candidate)=>current(candidate,row));
      if(requestDigest(row.turn_id,row.world_revision,candidates.map((candidate,index)=>{
        // Request digest binds the originally issued current envelopes, not derived lifecycle state.
        if(candidate.supersession.state!=="current")return verifyCandidate(rows[index]!,row);return candidate;
      }))!==row.request_digest)throw new Error("batch request digest mismatch");
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
  return {
    issueExactCandidateBatch(principalId,input){guard();resourceIdSchema.parse(input.turnId);resourceIdSchema.parse(input.idempotencyKey);
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
      const serverIssuedAt=now();
      const issuedAt=parsed[0]?.issuedAt??serverIssuedAt;const expiresAt=parsed[0]?.expiresAt??new Date(Date.parse(issuedAt)+MAX_EXACT_CANDIDATE_LIFETIME_MS).toISOString();
      if(issuedAt!==serverIssuedAt)throw new ExactCandidateConflictError("candidate issuance time must equal server time");
      if(parsed.some((value)=>value.issuedAt!==issuedAt||value.expiresAt!==expiresAt))throw new ExactCandidateConflictError("batch lifetime must be exact");
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
    },
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
