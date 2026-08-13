import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {canonicalAgentJson,computeExactCandidateSelectionDigest,exactCandidateSelectionResponseSchema,
  projectExactCandidateForProvider,providerSafeExactCandidateListSchema} from "@velvet/contracts";
import {verifyExactCandidateIssuanceBatch} from "../../candidateRepo/issuanceVerifier.js";

const TABLES=["exact_candidate_provider_bindings_v48","exact_candidate_provider_layout_attestation_v48"] as const;
const INDEXES=["idx_exact_candidate_provider_turn_v48"] as const;
const TRIGGERS=[...TABLES.flatMap((table)=>[`${table}_immutable_update_v48`,`${table}_immutable_delete_v48`]),
  "exact_candidate_provider_binding_validate_v48"] as const;
export const EXACT_CANDIDATE_PROVIDER_V48_MANAGED_OBJECTS=[...TABLES.map((name)=>["table",name] as const),
  ...INDEXES.map((name)=>["index",name] as const),...TRIGGERS.map((name)=>["trigger",name] as const)] as const;

/** Additive provider-to-execution evidence. Historical provider and candidate layouts remain unchanged. */
export const EXACT_CANDIDATE_PROVIDER_V48_DDL=`
CREATE TABLE exact_candidate_provider_bindings_v48(
 binding_id TEXT PRIMARY KEY CHECK(length(binding_id) BETWEEN 1 AND 128 AND binding_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,batch_id TEXT NOT NULL,candidate_id TEXT NOT NULL UNIQUE,execution_id TEXT NOT NULL UNIQUE,
 provider_call_id TEXT NOT NULL,provider_tool_call_id TEXT NOT NULL,round_number INTEGER NOT NULL CHECK(round_number BETWEEN 1 AND 5),
 tool_name TEXT NOT NULL CHECK(tool_name='exact_actor_travel.select'),tool_position INTEGER NOT NULL CHECK(tool_position=0),
 provider_projection_json TEXT NOT NULL CHECK(json_valid(provider_projection_json) AND json_type(provider_projection_json)='object'),
 provider_projection_digest TEXT NOT NULL CHECK(length(provider_projection_digest)=64 AND provider_projection_digest NOT GLOB '*[^0-9a-f]*'),
 selection_json TEXT NOT NULL CHECK(json_valid(selection_json) AND json_type(selection_json)='object'),
 selection_digest TEXT NOT NULL CHECK(length(selection_digest)=64 AND selection_digest NOT GLOB '*[^0-9a-f]*'),
  world_command_id TEXT NOT NULL,expected_execution_revision INTEGER NOT NULL CHECK(expected_execution_revision BETWEEN 0 AND 9007199254740990),
  resulting_execution_revision INTEGER NOT NULL CHECK(resulting_execution_revision=expected_execution_revision+1),linked_at TEXT NOT NULL,
 UNIQUE(campaign_id,turn_id,provider_call_id),UNIQUE(campaign_id,turn_id,provider_tool_call_id),
 FOREIGN KEY(batch_id) REFERENCES exact_candidate_batches_v46(batch_id) ON DELETE RESTRICT,
 FOREIGN KEY(candidate_id) REFERENCES exact_candidates_v46(candidate_id) ON DELETE RESTRICT,
 FOREIGN KEY(execution_id) REFERENCES exact_candidate_executions_v47(execution_id) ON DELETE RESTRICT,
 FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_responses_v39(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT,
 CHECK(linked_at=strftime('%Y-%m-%dT%H:%M:%fZ',linked_at) AND substr(linked_at,12,2) BETWEEN '00' AND '23')
);
CREATE TABLE exact_candidate_provider_layout_attestation_v48(singleton INTEGER PRIMARY KEY CHECK(singleton=1),layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64 AND layout_digest NOT GLOB '*[^0-9a-f]*'));
CREATE INDEX idx_exact_candidate_provider_turn_v48 ON exact_candidate_provider_bindings_v48(campaign_id,turn_id,linked_at);
CREATE TRIGGER exact_candidate_provider_binding_validate_v48 BEFORE INSERT ON exact_candidate_provider_bindings_v48 WHEN
 NOT EXISTS(SELECT 1 FROM agent_provider_responses_v39 response JOIN agent_provider_contexts_v39 context ON context.context_id=response.context_id
   WHERE response.campaign_id=NEW.campaign_id AND response.turn_id=NEW.turn_id AND response.provider_call_id=NEW.provider_call_id
    AND response.status='succeeded' AND context.round_number=NEW.round_number
    AND json_array_length(json_extract(response.response_json,'$.calls'))=1
    AND json_extract(response.response_json,'$.result')='tool-calls'
    AND json_extract(response.response_json,'$.calls[0].providerToolCallId')=NEW.provider_tool_call_id
    AND json_extract(response.response_json,'$.calls[0].toolName')=NEW.tool_name
     AND json_extract(response.response_json,'$.calls[0].kind')='mutation'
     AND json_extract(response.response_json,'$.calls[0].arguments')=json(NEW.selection_json)
    AND json_extract(context.request_json,'$.exactCandidateProjection')=json(NEW.provider_projection_json)
    AND json_array_length(json_extract(context.request_json,'$.advertisedToolSchemas'))>0
    AND EXISTS(SELECT 1 FROM json_each(context.request_json,'$.advertisedTools') tool WHERE tool.value=NEW.tool_name)
     AND EXISTS(SELECT 1 FROM json_each(context.request_json,'$.advertisedToolSchemas') tool WHERE json_extract(tool.value,'$.name')=NEW.tool_name
      AND json_extract(tool.value,'$.parameters.additionalProperties')=0
      AND json_array_length(json_extract(tool.value,'$.parameters.required'))=4
      AND NOT EXISTS(SELECT 1 FROM json_each(json_extract(tool.value,'$.parameters.required')) required
        WHERE required.value NOT IN('candidateId','kind','version','choices'))
      AND json_array_length(json_extract(tool.value,'$.parameters.properties.candidateId.enum'))=
        json_array_length(json_extract(context.request_json,'$.exactCandidateProjection.candidates'))
      AND json_extract(tool.value,'$.parameters.properties.kind.enum[0]')='actor.travel'
      AND json_array_length(json_extract(tool.value,'$.parameters.properties.kind.enum'))=1
      AND json_extract(tool.value,'$.parameters.properties.version.enum[0]')='v1'
      AND json_array_length(json_extract(tool.value,'$.parameters.properties.version.enum'))=1
      AND json_extract(tool.value,'$.parameters.properties.choices.type')='array'
      AND json_extract(tool.value,'$.parameters.properties.choices.maxItems')=0))
 OR NOT EXISTS(SELECT 1 FROM exact_candidate_executions_v47 execution JOIN exact_candidates_v46 candidate ON candidate.candidate_id=execution.candidate_id
   JOIN exact_candidate_batches_v46 batch ON batch.batch_id=candidate.batch_id
   WHERE execution.execution_id=NEW.execution_id AND execution.candidate_id=NEW.candidate_id AND execution.campaign_id=NEW.campaign_id
    AND execution.turn_id=NEW.turn_id AND execution.world_command_id=NEW.world_command_id AND execution.selection_digest=NEW.selection_digest
    AND execution.linked_at=NEW.linked_at AND batch.batch_id=NEW.batch_id
    AND json_extract(NEW.selection_json,'$.candidateId')=NEW.candidate_id
    AND json_extract(NEW.selection_json,'$.kind')='actor.travel' AND json_extract(NEW.selection_json,'$.version')='v1'
    AND json_array_length(json_extract(NEW.selection_json,'$.choices'))=0
    AND (SELECT count(*) FROM json_each(NEW.selection_json))=4
    AND NOT EXISTS(SELECT 1 FROM json_each(NEW.selection_json) field WHERE field.key NOT IN('candidateId','kind','version','choices')))
 OR NEW.expected_execution_revision<>(SELECT COALESCE(max(operation.resulting_execution_revision),0) FROM agent_execution_operations_v38 operation
      WHERE operation.campaign_id=NEW.campaign_id AND operation.turn_id=NEW.turn_id)
 OR NEW.expected_execution_revision<>(SELECT start.resulting_execution_revision FROM agent_provider_starts_v38 start
      WHERE start.campaign_id=NEW.campaign_id AND start.turn_id=NEW.turn_id AND start.provider_call_id=NEW.provider_call_id)
 OR EXISTS(SELECT 1 FROM exact_candidate_provider_bindings_v48 prior WHERE prior.campaign_id=NEW.campaign_id AND prior.turn_id=NEW.turn_id)
 BEGIN SELECT RAISE(ABORT,'v48 provider exact-candidate binding is invalid');END;
CREATE TRIGGER exact_candidate_provider_bindings_v48_immutable_update_v48 BEFORE UPDATE ON exact_candidate_provider_bindings_v48 BEGIN SELECT RAISE(ABORT,'v48 provider bindings are immutable');END;
CREATE TRIGGER exact_candidate_provider_bindings_v48_immutable_delete_v48 BEFORE DELETE ON exact_candidate_provider_bindings_v48 BEGIN SELECT RAISE(ABORT,'v48 provider bindings are immutable');END;
CREATE TRIGGER exact_candidate_provider_layout_attestation_v48_immutable_update_v48 BEFORE UPDATE ON exact_candidate_provider_layout_attestation_v48 BEGIN SELECT RAISE(ABORT,'v48 provider layout is immutable');END;
CREATE TRIGGER exact_candidate_provider_layout_attestation_v48_immutable_delete_v48 BEFORE DELETE ON exact_candidate_provider_layout_attestation_v48 BEGIN SELECT RAISE(ABORT,'v48 provider layout is immutable');END;`;

function layoutDigest(db:DatabaseDriver.Database):string {const names=EXACT_CANDIDATE_PROVIDER_V48_MANAGED_OBJECTS.map(([,name])=>name);
  const rows=(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN (${names.map(()=>"?").join(",")}) ORDER BY type,name`).all(...names) as any[])
    .map((row)=>({...row,sql:row.sql?.replace(/\s+/g," ").trim()??null}));return createHash("sha256").update(JSON.stringify(rows)).digest("hex");}
// Updated after review of the static DDL. A mismatch during development prints the replacement digest.
export const EXACT_CANDIDATE_PROVIDER_V48_LAYOUT_DIGEST="533c4ac4164f4cdd77972eab8e6eb41bfa4a538ff615b710ac500d148cb49373";
export function createExactCandidateProviderBridgeV48(db:DatabaseDriver.Database):void {db.exec(EXACT_CANDIDATE_PROVIDER_V48_DDL);
  const actual=layoutDigest(db);if(EXACT_CANDIDATE_PROVIDER_V48_LAYOUT_DIGEST!==actual)throw new Error(`canonical schema v48 DDL digest changed (${actual})`);
  db.prepare("INSERT INTO exact_candidate_provider_layout_attestation_v48 VALUES(1,?)").run(actual);}
const boundRowsSql=`SELECT binding.*,context.request_json,context.round_number context_round,response.status response_status,
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
function assertBoundRow(db:DatabaseDriver.Database,row:any):void {let projection:any,request:any,response:any,selection:any;try{
    projection=providerSafeExactCandidateListSchema.parse(JSON.parse(row.provider_projection_json));request=JSON.parse(row.request_json);
    response=JSON.parse(row.response_json);selection=exactCandidateSelectionResponseSchema.parse(JSON.parse(row.selection_json));
  }catch{throw new Error("schema v48 provider binding JSON is malformed");}
  const frame=canonicalAgentJson(projection),selectionFrame=canonicalAgentJson(selection);
  let expectedProjection:any;try{const issuance=verifyExactCandidateIssuanceBatch(db,row.batch_id);
    expectedProjection=providerSafeExactCandidateListSchema.parse({version:"v1",candidates:issuance.candidates.map((candidate)=>
      projectExactCandidateForProvider(candidate,candidate.issuedAt))});}
  catch{throw new Error("schema v48 authoritative provider projection is malformed");}
  const expectedFrame=canonicalAgentJson(expectedProjection);
  const schema=request.advertisedToolSchemas?.find((tool:any)=>tool?.name===row.tool_name);
  const exactParameters={type:"object",properties:{candidateId:{type:"string",enum:projection.candidates.map((candidate:{candidateId:string})=>candidate.candidateId)},
    kind:{type:"string",enum:["actor.travel"]},version:{type:"string",enum:["v1"]},choices:{type:"array",maxItems:0}},
    required:["candidateId","kind","version","choices"],additionalProperties:false};
  if(frame!==expectedFrame||frame!==row.provider_projection_json||createHash("sha256").update(frame).digest("hex")!==row.provider_projection_digest
    ||canonicalAgentJson(request.exactCandidateProjection)!==frame||selectionFrame!==row.selection_json
    ||computeExactCandidateSelectionDigest(selection,{sha256:(value)=>createHash("sha256").update(value).digest("hex")})!==row.selection_digest
    ||selection.candidateId!==row.candidate_id||row.context_round!==row.round_number||row.response_status!=="succeeded"
    ||response.result!=="tool-calls"||response.calls?.length!==1||response.calls[0]?.providerToolCallId!==row.provider_tool_call_id
    ||response.calls[0]?.toolName!==row.tool_name||response.calls[0]?.kind!=="mutation"
    ||canonicalAgentJson(response.calls[0]?.arguments)!==selectionFrame
    ||!Array.isArray(request.advertisedTools)||request.advertisedTools.filter((name:any)=>name===row.tool_name).length!==1
    ||!schema||canonicalAgentJson(schema.parameters)!==canonicalAgentJson(exactParameters)
    ||row.execution_candidate_id!==row.candidate_id||row.execution_campaign_id!==row.campaign_id||row.execution_turn_id!==row.turn_id
    ||row.execution_selection_digest!==row.selection_digest||row.execution_world_command_id!==row.world_command_id
    ||row.execution_linked_at!==row.linked_at||row.candidate_batch_id!==row.batch_id
    ||row.candidate_campaign_id!==row.campaign_id||row.candidate_turn_id!==row.turn_id||row.candidate_action_digest!==row.execution_action_digest
    ||row.command_expected_revision!==row.world_expected_revision||row.command_revision!==row.world_revision
    ||row.command_created_at!==row.linked_at||row.start_execution_revision!==row.expected_execution_revision
    ||row.resulting_execution_revision!==row.expected_execution_revision+1)throw new Error("schema v48 provider binding attestation is malformed");
}
/** Verifies one selected binding and its complete provider/candidate/execution ancestry. */
export function assertExactCandidateProviderBindingV48(db:DatabaseDriver.Database,bindingId:string):void {
  const row=db.prepare(`${boundRowsSql} WHERE binding.binding_id=?`).get(bindingId) as any;
  if(!row)throw new Error("schema v48 provider binding ancestry is incomplete");assertBoundRow(db,row);
}
export function assertExactCandidateProviderBridgeLayoutV48(db:DatabaseDriver.Database):void {const expected=new Set(EXACT_CANDIDATE_PROVIDER_V48_MANAGED_OBJECTS.map(([type,name])=>`${type}:${name}`));
  const rows=db.prepare(`SELECT type,name FROM sqlite_master WHERE sql IS NOT NULL AND (name GLOB '*v48*' OR tbl_name IN (${TABLES.map(()=>"?").join(",")})) ORDER BY type,name`).all(...TABLES) as Array<{type:string;name:string}>;
  if(rows.length!==expected.size||rows.some(({type,name})=>!expected.has(`${type}:${name}`)))throw new Error("schema v48 provider bridge inventory is incompatible");
  const actual=layoutDigest(db),attestation=db.prepare("SELECT layout_digest FROM exact_candidate_provider_layout_attestation_v48 WHERE singleton=1").get() as {layout_digest:string}|undefined;
  if(actual!==EXACT_CANDIDATE_PROVIDER_V48_LAYOUT_DIGEST||attestation?.layout_digest!==actual)throw new Error(`schema v48 provider bridge attestation is incompatible (${actual})`);
  const bindingCount=(db.prepare("SELECT count(*) count FROM exact_candidate_provider_bindings_v48").get() as {count:number}).count;
  const boundRows=db.prepare(boundRowsSql).all() as any[];
  if(boundRows.length!==bindingCount)throw new Error("schema v48 provider binding ancestry is incomplete");
  for(const row of boundRows)assertBoundRow(db,row);}
export function migrate47to48(db:DatabaseDriver.Database):void {db.transaction(()=>{createExactCandidateProviderBridgeV48(db);db.prepare("UPDATE meta SET value='48' WHERE key='schemaVersion'").run();})();}
