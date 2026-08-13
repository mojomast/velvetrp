import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";

const TABLES=["exact_candidate_executions_v47","exact_candidate_execution_layout_attestation_v47"] as const;
const INDEXES=["idx_exact_candidate_executions_world_v47"] as const;
const TRIGGERS=[...TABLES.flatMap((table)=>[`${table}_immutable_update_v47`,`${table}_immutable_delete_v47`]),
  "exact_candidate_executions_structure_v47"] as const;
export const EXACT_CANDIDATE_EXECUTION_V47_MANAGED_OBJECTS=[...TABLES.map((name)=>["table",name] as const),
  ...INDEXES.map((name)=>["index",name] as const),...TRIGGERS.map((name)=>["trigger",name] as const)] as const;

/** Reviewed additive v47 layout. Existing candidate envelopes remain immutable v46 evidence. */
export const EXACT_CANDIDATE_EXECUTION_V47_DDL=`
CREATE TABLE exact_candidate_executions_v47(
 execution_id TEXT PRIMARY KEY CHECK(length(execution_id) BETWEEN 1 AND 128 AND execution_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
 candidate_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,session_id TEXT NOT NULL,actor_id TEXT NOT NULL,
 principal_id TEXT NOT NULL,connection_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind='actor.travel'),version TEXT NOT NULL CHECK(version='v1'),
 action_frame TEXT NOT NULL,action_digest TEXT NOT NULL CHECK(length(action_digest)=64 AND action_digest NOT GLOB '*[^0-9a-f]*'),
 scope_frame TEXT NOT NULL,scope_digest TEXT NOT NULL CHECK(length(scope_digest)=64 AND scope_digest NOT GLOB '*[^0-9a-f]*'),
 selection_candidate_id TEXT NOT NULL,selection_kind TEXT NOT NULL CHECK(selection_kind='actor.travel'),selection_version TEXT NOT NULL CHECK(selection_version='v1'),
 selection_frame TEXT NOT NULL,selection_digest TEXT NOT NULL CHECK(length(selection_digest)=64 AND selection_digest NOT GLOB '*[^0-9a-f]*'),
 world_idempotency_key TEXT NOT NULL UNIQUE CHECK(world_idempotency_key='exact-candidate:'||action_digest),
 world_command_id TEXT NOT NULL,world_actor_id TEXT NOT NULL,world_command_type TEXT NOT NULL CHECK(world_command_type='travel'),
 world_expected_revision INTEGER NOT NULL CHECK(typeof(world_expected_revision)='integer' AND world_expected_revision BETWEEN 0 AND 9007199254740990),
 world_revision INTEGER NOT NULL CHECK(world_revision=world_expected_revision+1),world_created_at TEXT NOT NULL,
 world_request_json TEXT NOT NULL CHECK(json_valid(world_request_json) AND json_type(world_request_json)='object'),
 world_request_digest TEXT NOT NULL CHECK(length(world_request_digest)=64 AND world_request_digest NOT GLOB '*[^0-9a-f]*'),
 world_result_json TEXT NOT NULL CHECK(json_valid(world_result_json) AND json_type(world_result_json)='object'),
 world_result_digest TEXT NOT NULL CHECK(length(world_result_digest)=64 AND world_result_digest NOT GLOB '*[^0-9a-f]*'),
 travel_id TEXT NOT NULL,destination_location_id TEXT NOT NULL,
 party_actor_ids_json TEXT NOT NULL CHECK(json_valid(party_actor_ids_json) AND json_type(party_actor_ids_json)='array' AND json_array_length(party_actor_ids_json)=1),
 linked_envelope_frame TEXT NOT NULL,linked_envelope_digest TEXT NOT NULL CHECK(length(linked_envelope_digest)=64 AND linked_envelope_digest NOT GLOB '*[^0-9a-f]*'),
 linked_envelope_json TEXT NOT NULL CHECK(json_valid(linked_envelope_json) AND json_type(linked_envelope_json)='object'),
 result_frame TEXT NOT NULL,result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
 result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),linked_at TEXT NOT NULL,
 UNIQUE(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version),
 FOREIGN KEY(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version)
  REFERENCES exact_candidates_v46(candidate_id,campaign_id,turn_id,session_id,actor_id,principal_id,connection_id,kind,version) ON DELETE RESTRICT,
 FOREIGN KEY(campaign_id,session_id,world_command_id,world_revision)
  REFERENCES world_commands_v28(campaign_id,session_id,command_id,resulting_revision) ON DELETE RESTRICT,
 FOREIGN KEY(campaign_id,session_id,world_command_id,world_revision)
  REFERENCES world_receipts_v28(campaign_id,session_id,command_id,resulting_revision) ON DELETE RESTRICT,
 CHECK(linked_at=strftime('%Y-%m-%dT%H:%M:%fZ',linked_at) AND substr(linked_at,12,2) BETWEEN '00' AND '23')
);
CREATE TABLE exact_candidate_execution_layout_attestation_v47(singleton INTEGER PRIMARY KEY CHECK(singleton=1),layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64 AND layout_digest NOT GLOB '*[^0-9a-f]*'));
CREATE INDEX idx_exact_candidate_executions_world_v47 ON exact_candidate_executions_v47(campaign_id,session_id,world_command_id,world_revision);
CREATE TRIGGER exact_candidate_executions_structure_v47 BEFORE INSERT ON exact_candidate_executions_v47 WHEN
 NEW.execution_id IS NOT json_extract(NEW.result_json,'$.executionId')
 OR NEW.selection_candidate_id IS NOT json_extract(NEW.result_json,'$.selection.candidateId')
 OR NEW.selection_kind IS NOT json_extract(NEW.result_json,'$.selection.kind') OR NEW.selection_version IS NOT json_extract(NEW.result_json,'$.selection.version')
 OR NEW.selection_digest IS NOT json_extract(NEW.result_json,'$.canonicalSelectionDigest') OR NEW.result_digest IS NOT json_extract(NEW.result_json,'$.canonicalResultDigest')
 OR NEW.candidate_id IS NOT NEW.selection_candidate_id OR NEW.kind IS NOT NEW.selection_kind OR NEW.version IS NOT NEW.selection_version
 OR NEW.candidate_id IS NOT json_extract(NEW.linked_envelope_json,'$.candidateId') OR NEW.kind IS NOT json_extract(NEW.linked_envelope_json,'$.kind')
 OR NEW.version IS NOT json_extract(NEW.linked_envelope_json,'$.version') OR NEW.campaign_id IS NOT json_extract(NEW.linked_envelope_json,'$.scope.campaignId')
 OR NEW.session_id IS NOT json_extract(NEW.linked_envelope_json,'$.scope.sessionId') OR NEW.actor_id IS NOT json_extract(NEW.linked_envelope_json,'$.scope.actorId')
 OR NEW.principal_id IS NOT json_extract(NEW.linked_envelope_json,'$.scope.principalId') OR NEW.connection_id IS NOT json_extract(NEW.linked_envelope_json,'$.scope.connectionId')
 OR json_extract(NEW.linked_envelope_json,'$.execution.state') IS NOT 'receipt-linked'
 OR NEW.execution_id IS NOT json_extract(NEW.linked_envelope_json,'$.execution.receiptId')
 OR NEW.world_command_id IS NOT json_extract(NEW.linked_envelope_json,'$.execution.binding.commandId')
 OR NEW.action_digest IS NOT json_extract(NEW.linked_envelope_json,'$.canonicalActionDigest')
 OR NEW.linked_envelope_digest IS NOT json_extract(NEW.linked_envelope_json,'$.canonicalEnvelopeDigest')
 OR NEW.linked_at IS NOT json_extract(NEW.linked_envelope_json,'$.execution.linkedAt')
 OR NEW.campaign_id IS NOT json_extract(NEW.result_json,'$.actorTravelResult.campaignId') OR NEW.session_id IS NOT json_extract(NEW.result_json,'$.actorTravelResult.sessionId')
 OR NEW.world_command_id IS NOT json_extract(NEW.result_json,'$.actorTravelResult.receipt.commandId')
 OR NEW.world_idempotency_key IS NOT json_extract(NEW.result_json,'$.actorTravelResult.receipt.idempotencyKey')
 OR NEW.world_expected_revision IS NOT json_extract(NEW.result_json,'$.actorTravelResult.receipt.revisionBefore')
 OR NEW.world_revision IS NOT json_extract(NEW.result_json,'$.actorTravelResult.receipt.revisionAfter')
 OR NEW.linked_at IS NOT json_extract(NEW.result_json,'$.actorTravelResult.receipt.occurredAt')
 OR NEW.world_actor_id IS NOT NEW.actor_id OR NEW.world_created_at IS NOT NEW.linked_at
 OR NEW.travel_id IS NOT json_extract(NEW.world_request_json,'$.travelId')
 OR NEW.destination_location_id IS NOT json_extract(NEW.world_result_json,'$.locations[0].locationId')
 OR json_extract(NEW.party_actor_ids_json,'$[0]') IS NOT NEW.actor_id
 OR json_extract(NEW.world_request_json,'$.selectedPartyActorIds[0]') IS NOT NEW.actor_id
 OR json_array_length(json_extract(NEW.world_request_json,'$.selectedPartyActorIds')) IS NOT 1
 OR json_extract(NEW.world_request_json,'$.campaignId') IS NOT NEW.campaign_id
 OR json_extract(NEW.world_request_json,'$.locationConnectionId') IS NOT json_extract(NEW.linked_envelope_json,'$.privateParameters.connectionId')
 OR json_extract(NEW.world_request_json,'$.expectedRevision') IS NOT NEW.world_expected_revision
 OR json_extract(NEW.world_request_json,'$.idempotencyKey') IS NOT NEW.world_idempotency_key
 OR NOT EXISTS(SELECT 1 FROM exact_candidates_v46 candidate WHERE candidate.candidate_id=NEW.candidate_id
   AND candidate.campaign_id=NEW.campaign_id AND candidate.turn_id=NEW.turn_id AND candidate.session_id=NEW.session_id
   AND candidate.actor_id=NEW.actor_id AND candidate.principal_id=NEW.principal_id AND candidate.connection_id=NEW.connection_id
   AND candidate.kind=NEW.kind AND candidate.version=NEW.version AND candidate.action_frame=NEW.action_frame AND candidate.action_digest=NEW.action_digest)
 OR NOT EXISTS(SELECT 1 FROM world_commands_v28 command WHERE command.campaign_id=NEW.campaign_id AND command.session_id=NEW.session_id
   AND command.command_id=NEW.world_command_id AND command.actor_id=NEW.world_actor_id AND command.command_type=NEW.world_command_type
   AND command.idempotency_key=NEW.world_idempotency_key AND command.expected_revision=NEW.world_expected_revision
   AND command.resulting_revision=NEW.world_revision AND command.created_at=NEW.world_created_at
   AND command.canonical_request_json=NEW.world_request_json AND command.request_digest=NEW.world_request_digest)
 OR NOT EXISTS(SELECT 1 FROM world_receipts_v28 receipt WHERE receipt.campaign_id=NEW.campaign_id AND receipt.session_id=NEW.session_id
   AND receipt.command_id=NEW.world_command_id AND receipt.resulting_revision=NEW.world_revision AND receipt.occurred_at=NEW.linked_at
   AND receipt.canonical_result_json=NEW.world_result_json AND receipt.result_digest=NEW.world_result_digest)
 OR NOT EXISTS(SELECT 1 FROM world_events_v28 event WHERE event.campaign_id=NEW.campaign_id AND event.session_id=NEW.session_id
   AND event.command_id=NEW.world_command_id AND event.resulting_revision=NEW.world_revision AND event.event_type='travelled'
   AND event.occurred_at=NEW.linked_at AND json_extract(event.event_json,'$.travelId')=NEW.travel_id
   AND json_extract(event.event_json,'$.destinationLocationId')=NEW.destination_location_id AND json_type(event.event_json)='object')
 OR NOT EXISTS(SELECT 1 FROM world_travel_destinations_v28 destination WHERE destination.campaign_id=NEW.campaign_id
   AND destination.session_id=NEW.session_id AND destination.command_id=NEW.world_command_id
   AND destination.connection_id=json_extract(NEW.linked_envelope_json,'$.privateParameters.connectionId')
   AND destination.destination_location_id=NEW.destination_location_id)
 OR (SELECT count(*) FROM world_travel_party_members_v28 party WHERE party.campaign_id=NEW.campaign_id
   AND party.session_id=NEW.session_id AND party.command_id=NEW.world_command_id)<>1
 OR NOT EXISTS(SELECT 1 FROM world_travel_party_members_v28 party WHERE party.campaign_id=NEW.campaign_id
   AND party.session_id=NEW.session_id AND party.command_id=NEW.world_command_id AND party.actor_id=json_extract(NEW.party_actor_ids_json,'$[0]'))
 BEGIN SELECT RAISE(ABORT,'v47 exact candidate execution binding is invalid');END;
CREATE TRIGGER exact_candidate_executions_v47_immutable_update_v47 BEFORE UPDATE ON exact_candidate_executions_v47 BEGIN SELECT RAISE(ABORT,'v47 exact candidate execution history is immutable');END;
CREATE TRIGGER exact_candidate_executions_v47_immutable_delete_v47 BEFORE DELETE ON exact_candidate_executions_v47 BEGIN SELECT RAISE(ABORT,'v47 exact candidate execution history is immutable');END;
CREATE TRIGGER exact_candidate_execution_layout_attestation_v47_immutable_update_v47 BEFORE UPDATE ON exact_candidate_execution_layout_attestation_v47 BEGIN SELECT RAISE(ABORT,'v47 exact candidate execution history is immutable');END;
CREATE TRIGGER exact_candidate_execution_layout_attestation_v47_immutable_delete_v47 BEFORE DELETE ON exact_candidate_execution_layout_attestation_v47 BEGIN SELECT RAISE(ABORT,'v47 exact candidate execution history is immutable');END;`;

function layoutDigest(db:DatabaseDriver.Database):string {const names=EXACT_CANDIDATE_EXECUTION_V47_MANAGED_OBJECTS.map(([,name])=>name);
  const rows=(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name IN (${names.map(()=>"?").join(",")}) ORDER BY type,name`).all(...names) as any[])
    .map((row)=>({...row,sql:row.sql?.replace(/\s+/g," ").trim()??null}));return createHash("sha256").update(JSON.stringify(rows)).digest("hex");}
// Updated only after explicit review of the static DDL above.
export const EXACT_CANDIDATE_EXECUTION_V47_LAYOUT_DIGEST="edd69e9855511c976427f18f2cb0287b847543b956eb10b9c0cef381aae3d03b";
export function createExactCandidateExecutionsV47(db:DatabaseDriver.Database):void {db.exec(EXACT_CANDIDATE_EXECUTION_V47_DDL);
  db.prepare("INSERT INTO exact_candidate_execution_layout_attestation_v47 VALUES(1,?)").run(EXACT_CANDIDATE_EXECUTION_V47_LAYOUT_DIGEST);}
export function assertExactCandidateExecutionsLayoutV47(db:DatabaseDriver.Database):void {const expected=new Set(EXACT_CANDIDATE_EXECUTION_V47_MANAGED_OBJECTS.map(([type,name])=>`${type}:${name}`));
  const rows=db.prepare(`SELECT type,name FROM sqlite_master WHERE sql IS NOT NULL AND (name GLOB '*v47*' OR tbl_name IN (${TABLES.map(()=>"?").join(",")})) ORDER BY type,name`).all(...TABLES) as Array<{type:string;name:string}>;
  if(rows.length!==expected.size||rows.some(({type,name})=>!expected.has(`${type}:${name}`)))throw new Error("schema v47 exact-candidate execution inventory is incompatible");
  const actual=layoutDigest(db),attestation=db.prepare("SELECT layout_digest FROM exact_candidate_execution_layout_attestation_v47 WHERE singleton=1").get() as {layout_digest:string}|undefined;
  if(actual!==EXACT_CANDIDATE_EXECUTION_V47_LAYOUT_DIGEST||attestation?.layout_digest!==EXACT_CANDIDATE_EXECUTION_V47_LAYOUT_DIGEST)throw new Error(`schema v47 exact-candidate execution layout attestation is incompatible (${actual})`);}
export function migrate46to47(db:DatabaseDriver.Database):void {db.transaction(()=>{createExactCandidateExecutionsV47(db);db.prepare("UPDATE meta SET value='47' WHERE key='schemaVersion'").run();})();}
