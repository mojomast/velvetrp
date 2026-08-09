import { createHash } from "node:crypto";
import DatabaseDriver from "better-sqlite3";
import {
  AGENT_TOOL_REGISTRY_VERSION,
  MAX_AGENT_DECISION_ROUNDS, MAX_AGENT_EXECUTION_DURATION_MS, MAX_AGENT_MUTATION_CALLS,
  MAX_AGENT_PROVIDER_CALLS, MAX_AGENT_TOOL_CALLS, agentDecisionToolCallInputSchema, canonicalAgentJson,
  markAgentReadOutcomeInputSchema, persistAgentDecisionRoundInputSchema, startAgentProviderCallInputSchema,
} from "@velvet/contracts";
import { assertToolExecutionBindingsV37 } from "./v37_tool_execution_bindings.js";

/** Canonical digest of the additive v38 durable agent-execution layout. */
export const V38_DURABLE_AGENT_EXECUTION_CANONICAL_DIGEST = "8757b92bb686f546c1cc9102565215f3c2047197097855afb29d31a48ad52717";

const TABLES = [
  "adventure_agent_executions_v38", "agent_execution_operations_v38", "agent_provider_starts_v38",
  "agent_decision_rounds_v38", "agent_tool_calls_v38", "agent_decision_batch_seals_v38",
  "agent_read_outcomes_v38", "durable_agent_execution_layout_attestation_v38",
] as const;
const INDEXES = [
  "idx_agent_execution_operations_turn_v38", "idx_agent_provider_starts_turn_v38",
  "idx_agent_decision_rounds_turn_v38", "idx_agent_tool_calls_turn_v38",
] as const;
const TRIGGERS = [
  "adventure_agent_executions_validate_v38", "agent_execution_operations_validate_v38",
  "provider_call_metadata_agent_limit_v38", "agent_provider_starts_validate_v38", "agent_decision_rounds_validate_v38",
  "agent_tool_calls_validate_v38", "agent_decision_batch_seals_validate_v38", "agent_read_outcomes_validate_v38",
  ...TABLES.filter((table) => table !== "durable_agent_execution_layout_attestation_v38")
    .flatMap((table) => [`${table}_replace_v38`, `${table}_update_v38`, `${table}_delete_v38`]),
  "durable_agent_execution_attestation_insert_v38", "durable_agent_execution_attestation_update_v38",
  "durable_agent_execution_attestation_delete_v38",
] as const;

/** Exact SQLite object inventory owned by additive schema v38. */
export const DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS: ReadonlyArray<readonly ["table" | "index" | "trigger", string]> = [
  ...TABLES.map((name) => ["table", name] as const), ...INDEXES.map((name) => ["index", name] as const),
  ...TRIGGERS.map((name) => ["trigger", name] as const),
];

const names = DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS.map(([, name]) => name);
const layoutDigest = (db: DatabaseDriver.Database): string => createHash("sha256").update(JSON.stringify(db.prepare(
  `SELECT type,name,sql FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type,name`,
).all(...names))).digest("hex");
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function assertInventory(db: DatabaseDriver.Database): void {
  const expected = new Set(DURABLE_AGENT_EXECUTION_V38_MANAGED_OBJECTS.map(([type, name]) => `${type}:${name}`));
  const rows = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL`)
    .all(...names) as Array<{ type: string; name: string }>;
  const actual = new Set(rows.map(({ type, name }) => `${type}:${name}`));
  const missing = [...expected].find((entry) => !actual.has(entry));
  const unknown = (db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v38*' AND sql IS NOT NULL").all() as Array<{ type: string; name: string }>)
    .find(({ type, name }) => !expected.has(`${type}:${name}`));
  if (missing || unknown) throw new Error(`schema v38 durable agent execution object inventory is incompatible (${unknown?.name ?? missing})`);
}

/** Creates the additive append-only planning substrate without a receipt or execution bridge. */
export function createDurableAgentExecutionV38(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE adventure_agent_executions_v38(
       campaign_id TEXT NOT NULL, turn_id TEXT PRIMARY KEY, tool_registry_version TEXT NOT NULL CHECK(tool_registry_version='v1'),
      max_decision_rounds INTEGER NOT NULL CHECK(typeof(max_decision_rounds)='integer' AND max_decision_rounds BETWEEN 1 AND 5),
      max_tool_calls INTEGER NOT NULL CHECK(typeof(max_tool_calls)='integer' AND max_tool_calls BETWEEN 0 AND 12),
      max_mutation_calls INTEGER NOT NULL CHECK(typeof(max_mutation_calls)='integer' AND max_mutation_calls BETWEEN 0 AND 4),
       max_provider_calls INTEGER NOT NULL CHECK(typeof(max_provider_calls)='integer' AND max_provider_calls BETWEEN 1 AND 1000000),
      max_duration_ms INTEGER NOT NULL CHECK(typeof(max_duration_ms)='integer' AND max_duration_ms BETWEEN 1 AND 90000),
       started_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',started_at)=started_at AND substr(started_at,12,2) BETWEEN '00' AND '23'),
       deadline_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',deadline_at)=deadline_at AND substr(deadline_at,12,2) BETWEEN '00' AND '23' AND deadline_at>started_at),
      UNIQUE(campaign_id,turn_id), FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT);

    CREATE TABLE agent_execution_operations_v38(
      operation_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, principal_id TEXT NOT NULL,
       operation_type TEXT NOT NULL CHECK(operation_type IN ('provider-start','decision-round','read-outcome')),
      idempotency_key TEXT NOT NULL, expected_campaign_revision INTEGER NOT NULL,
      expected_turn_revision INTEGER NOT NULL, expected_execution_revision INTEGER NOT NULL,
      resulting_execution_revision INTEGER NOT NULL CHECK(resulting_execution_revision=expected_execution_revision+1),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'),
       request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
       occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,turn_id,idempotency_key), UNIQUE(campaign_id,turn_id,resulting_execution_revision),
      UNIQUE(operation_id,campaign_id,turn_id,resulting_execution_revision),
      UNIQUE(operation_id,campaign_id,turn_id,operation_type,resulting_execution_revision),
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_agent_executions_v38(campaign_id,turn_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT);
    CREATE INDEX idx_agent_execution_operations_turn_v38 ON agent_execution_operations_v38(campaign_id,turn_id,resulting_execution_revision);

    CREATE TABLE agent_provider_starts_v38(
      operation_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, provider_call_id TEXT NOT NULL,
       provider_phase TEXT NOT NULL CHECK(provider_phase='started'), resulting_execution_revision INTEGER NOT NULL,
       recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at AND substr(recorded_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,turn_id,provider_call_id),
      FOREIGN KEY(operation_id,campaign_id,turn_id,resulting_execution_revision)
        REFERENCES agent_execution_operations_v38(operation_id,campaign_id,turn_id,resulting_execution_revision) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,turn_id,provider_call_id,provider_phase)
        REFERENCES provider_call_metadata(campaign_id,turn_id,call_id,phase) ON DELETE RESTRICT);
    CREATE INDEX idx_agent_provider_starts_turn_v38 ON agent_provider_starts_v38(campaign_id,turn_id,recorded_at,provider_call_id);

    CREATE TABLE agent_decision_rounds_v38(
      round_id TEXT PRIMARY KEY, seal_id TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, round_number INTEGER NOT NULL,
      provider_call_id TEXT NOT NULL, tool_registry_version TEXT NOT NULL CHECK(tool_registry_version='v1'),
      provider_request_json TEXT NOT NULL CHECK(json_valid(provider_request_json) AND json_type(provider_request_json)='object'),
      provider_request_digest TEXT NOT NULL CHECK(length(provider_request_digest)=64 AND provider_request_digest NOT GLOB '*[^0-9a-f]*'),
      response_json TEXT NOT NULL CHECK(json_valid(response_json) AND json_type(response_json)='object'),
      response_digest TEXT NOT NULL CHECK(length(response_digest)=64 AND response_digest NOT GLOB '*[^0-9a-f]*'),
       result TEXT NOT NULL CHECK(result IN ('tool-calls','complete','refused')), resulting_execution_revision INTEGER NOT NULL,
       recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at AND substr(recorded_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,turn_id,round_number), UNIQUE(campaign_id,turn_id,provider_call_id),
      UNIQUE(round_id,campaign_id,turn_id), UNIQUE(round_id,campaign_id,turn_id,round_number), UNIQUE(seal_id,round_id),
      FOREIGN KEY(operation_id,campaign_id,turn_id,resulting_execution_revision)
        REFERENCES agent_execution_operations_v38(operation_id,campaign_id,turn_id,resulting_execution_revision) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_starts_v38(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT,
      FOREIGN KEY(seal_id,round_id) REFERENCES agent_decision_batch_seals_v38(seal_id,round_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED);
    CREATE INDEX idx_agent_decision_rounds_turn_v38 ON agent_decision_rounds_v38(campaign_id,turn_id,round_number);

    CREATE TABLE agent_tool_calls_v38(
      call_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, round_id TEXT NOT NULL, round_number INTEGER NOT NULL,
      position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 11), provider_tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL CHECK(tool_name IN ('campaign_context.read','actor_resources.read','actor_inventory.read','actor_powers.read',
        'combat_state.read','world_state.read','quest_state.read','actor_attribute.set','actor_resource.initialize','actor_dice.roll')),
      call_kind TEXT NOT NULL CHECK(call_kind IN ('read','mutation')),
      arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json)='object' AND length(arguments_json)<=32768),
       argument_digest TEXT NOT NULL CHECK(length(argument_digest)=64 AND argument_digest NOT GLOB '*[^0-9a-f]*'),
       recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at AND substr(recorded_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,turn_id,provider_tool_call_id), UNIQUE(campaign_id,turn_id,round_number,position),
      UNIQUE(call_id,campaign_id,turn_id), FOREIGN KEY(round_id,campaign_id,turn_id,round_number)
        REFERENCES agent_decision_rounds_v38(round_id,campaign_id,turn_id,round_number) ON DELETE RESTRICT);
    CREATE INDEX idx_agent_tool_calls_turn_v38 ON agent_tool_calls_v38(campaign_id,turn_id,round_number,position);

    CREATE TABLE agent_decision_batch_seals_v38(
      seal_id TEXT PRIMARY KEY, round_id TEXT NOT NULL UNIQUE, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL,
       call_count INTEGER NOT NULL CHECK(typeof(call_count)='integer' AND call_count BETWEEN 0 AND 12),
       sealed_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',sealed_at)=sealed_at AND substr(sealed_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(seal_id,round_id), FOREIGN KEY(round_id,campaign_id,turn_id) REFERENCES agent_decision_rounds_v38(round_id,campaign_id,turn_id) ON DELETE RESTRICT);

    CREATE TABLE agent_read_outcomes_v38(
      outcome_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, call_id TEXT NOT NULL UNIQUE,
      campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('succeeded','failed')),
      result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json)='object' AND length(result_json)<=262144)),
      result_digest TEXT CHECK(result_digest IS NULL OR (length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*')),
       error_code TEXT, resulting_execution_revision INTEGER NOT NULL,
       recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at AND substr(recorded_at,12,2) BETWEEN '00' AND '23'),
      CHECK((status='succeeded' AND result_json IS NOT NULL AND result_digest IS NOT NULL AND error_code IS NULL) OR
        (status='failed' AND result_json IS NULL AND result_digest IS NULL AND error_code IS NOT NULL)),
      FOREIGN KEY(operation_id,campaign_id,turn_id,resulting_execution_revision)
        REFERENCES agent_execution_operations_v38(operation_id,campaign_id,turn_id,resulting_execution_revision) ON DELETE RESTRICT,
      FOREIGN KEY(call_id,campaign_id,turn_id) REFERENCES agent_tool_calls_v38(call_id,campaign_id,turn_id) ON DELETE RESTRICT);

    CREATE TABLE durable_agent_execution_layout_attestation_v38(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64 AND layout_digest NOT GLOB '*[^0-9a-f]*'));

    CREATE TRIGGER adventure_agent_executions_validate_v38 BEFORE INSERT ON adventure_agent_executions_v38 WHEN
      NOT EXISTS(SELECT 1 FROM adventure_turns turn WHERE turn.id=NEW.turn_id AND turn.campaign_id=NEW.campaign_id) OR
      NEW.deadline_at<=NEW.started_at BEGIN SELECT RAISE(ABORT,'invalid durable agent execution'); END;
    CREATE TRIGGER provider_call_metadata_agent_limit_v38 BEFORE INSERT ON provider_call_metadata WHEN NEW.phase='started' AND
      (NOT EXISTS(SELECT 1 FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id) OR
       (SELECT count(*) FROM provider_call_metadata old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id
         AND old.phase='started') >= (SELECT max_provider_calls FROM adventure_agent_executions_v38 run
           WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id))
      BEGIN SELECT RAISE(ABORT,'provider call limit exceeded'); END;
    CREATE TRIGGER agent_execution_operations_validate_v38 BEFORE INSERT ON agent_execution_operations_v38 WHEN
      NEW.expected_execution_revision<>COALESCE((SELECT max(old.resulting_execution_revision) FROM agent_execution_operations_v38 old
        WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id),0) OR
      NEW.resulting_execution_revision<>NEW.expected_execution_revision+1 OR
      NEW.occurred_at>=(SELECT deadline_at FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id) OR
      NEW.expected_campaign_revision<>(SELECT administration_revision FROM campaigns WHERE id=NEW.campaign_id) OR
      NEW.expected_turn_revision<>(SELECT max(event.resulting_revision) FROM adventure_coordination_events_v36 event
        WHERE event.aggregate_kind='turn' AND event.campaign_id=NEW.campaign_id AND event.aggregate_id=NEW.turn_id) OR
      NOT EXISTS(SELECT 1 FROM adventure_turns turn JOIN campaigns campaign ON campaign.id=turn.campaign_id
        JOIN campaign_memberships membership ON membership.campaign_id=turn.campaign_id AND membership.principal_id=NEW.principal_id
        JOIN campaign_sessions attached ON attached.campaign_id=turn.campaign_id AND attached.session_id=turn.session_id
        JOIN sessions session ON session.id=attached.session_id
        JOIN campaign_actors actor ON actor.campaign_id=turn.campaign_id AND actor.id=turn.actor_id
        JOIN campaign_characters character ON character.campaign_id=actor.campaign_id AND character.id=actor.campaign_character_id
        JOIN session_characters participant ON participant.session_id=turn.session_id AND participant.character_id=character.character_id
        WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND campaign.active_timeline_id=turn.timeline_id
          AND campaign.lifecycle_status IN ('draft','published') AND membership.role<>'observer'
          AND session.state='active' AND session.stopped_at IS NULL AND (membership.role IN ('owner','gm') OR EXISTS(
            SELECT 1 FROM campaign_actor_private_state control WHERE control.campaign_id=turn.campaign_id
              AND control.actor_id=turn.actor_id AND control.controller_principal_id=NEW.principal_id))) OR
      EXISTS(SELECT 1 FROM adventure_coordination_events_v36 terminal_turn WHERE terminal_turn.aggregate_kind='turn'
        AND terminal_turn.campaign_id=NEW.campaign_id AND terminal_turn.aggregate_id=NEW.turn_id
        AND terminal_turn.resulting_state IN ('completed','cancelled','failed')) OR
      EXISTS(SELECT 1 FROM agent_decision_rounds_v38 terminal WHERE terminal.campaign_id=NEW.campaign_id AND terminal.turn_id=NEW.turn_id
        AND terminal.result IN ('complete','refused'))
      BEGIN SELECT RAISE(ABORT,'invalid durable agent execution operation'); END;
    CREATE TRIGGER agent_provider_starts_validate_v38 BEFORE INSERT ON agent_provider_starts_v38 WHEN
      NOT EXISTS(SELECT 1 FROM agent_execution_operations_v38 operation WHERE operation.operation_id=NEW.operation_id
        AND operation.campaign_id=NEW.campaign_id AND operation.turn_id=NEW.turn_id AND operation.operation_type='provider-start'
        AND operation.resulting_execution_revision=NEW.resulting_execution_revision AND operation.occurred_at=NEW.recorded_at
        AND json_extract(operation.request_json,'$.providerCallId')=NEW.provider_call_id) OR
      NOT EXISTS(SELECT 1 FROM provider_call_metadata provider WHERE provider.campaign_id=NEW.campaign_id AND provider.turn_id=NEW.turn_id
        AND provider.call_id=NEW.provider_call_id AND provider.phase='started' AND provider.recorded_at=NEW.recorded_at) OR
      (SELECT count(*) FROM agent_provider_starts_v38 old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)<>
        (SELECT count(*) FROM agent_decision_rounds_v38 round WHERE round.campaign_id=NEW.campaign_id AND round.turn_id=NEW.turn_id) OR
      (SELECT count(*) FROM agent_decision_rounds_v38 round WHERE round.campaign_id=NEW.campaign_id AND round.turn_id=NEW.turn_id)>=(
        SELECT max_decision_rounds FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id) OR
      EXISTS(SELECT 1 FROM agent_tool_calls_v38 call WHERE call.campaign_id=NEW.campaign_id AND call.turn_id=NEW.turn_id AND
        (call.call_kind='mutation' OR NOT EXISTS(SELECT 1 FROM agent_read_outcomes_v38 outcome WHERE outcome.call_id=call.call_id)))
      BEGIN SELECT RAISE(ABORT,'invalid durable agent provider start'); END;
    CREATE TRIGGER agent_decision_rounds_validate_v38 BEFORE INSERT ON agent_decision_rounds_v38 WHEN
      NOT EXISTS(SELECT 1 FROM agent_execution_operations_v38 operation WHERE operation.operation_id=NEW.operation_id
        AND operation.campaign_id=NEW.campaign_id AND operation.turn_id=NEW.turn_id AND operation.operation_type='decision-round'
        AND operation.resulting_execution_revision=NEW.resulting_execution_revision AND operation.occurred_at=NEW.recorded_at
        AND EXISTS(SELECT 1 FROM agent_provider_starts_v38 start WHERE start.campaign_id=NEW.campaign_id
          AND start.turn_id=NEW.turn_id AND start.provider_call_id=NEW.provider_call_id
          AND start.resulting_execution_revision=operation.expected_execution_revision)) OR
      NEW.round_number<>(SELECT count(*)+1 FROM agent_decision_rounds_v38 old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id) OR
      NEW.round_number>(SELECT max_decision_rounds FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id) OR
      EXISTS(SELECT 1 FROM agent_decision_rounds_v38 prior WHERE prior.campaign_id=NEW.campaign_id AND prior.turn_id=NEW.turn_id
        AND (prior.result IN ('complete','refused') OR EXISTS(SELECT 1 FROM agent_tool_calls_v38 call WHERE call.round_id=prior.round_id AND
           ((call.call_kind='read' AND NOT EXISTS(SELECT 1 FROM agent_read_outcomes_v38 outcome WHERE outcome.call_id=call.call_id)) OR
            call.call_kind='mutation'))))
      BEGIN SELECT RAISE(ABORT,'invalid durable agent decision round'); END;
    CREATE TRIGGER agent_tool_calls_validate_v38 BEFORE INSERT ON agent_tool_calls_v38 WHEN
      (SELECT count(*) FROM agent_tool_calls_v38 old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)>=(
        SELECT max_tool_calls FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id) OR
      (NEW.call_kind='mutation' AND (SELECT count(*) FROM agent_tool_calls_v38 old WHERE old.campaign_id=NEW.campaign_id
        AND old.turn_id=NEW.turn_id AND old.call_kind='mutation')>=(SELECT max_mutation_calls FROM adventure_agent_executions_v38 run
          WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id)) OR
      ((NEW.call_kind='mutation')<>(NEW.tool_name IN ('actor_attribute.set','actor_resource.initialize','actor_dice.roll'))) OR
      NOT EXISTS(SELECT 1 FROM agent_decision_rounds_v38 round WHERE round.round_id=NEW.round_id AND round.campaign_id=NEW.campaign_id
        AND round.turn_id=NEW.turn_id AND round.round_number=NEW.round_number AND round.result='tool-calls') OR
      NEW.recorded_at<>(SELECT recorded_at FROM agent_decision_rounds_v38 round WHERE round.round_id=NEW.round_id)
      BEGIN SELECT RAISE(ABORT,'invalid durable agent tool call'); END;
    CREATE TRIGGER agent_decision_batch_seals_validate_v38 BEFORE INSERT ON agent_decision_batch_seals_v38 WHEN
      NOT EXISTS(SELECT 1 FROM agent_decision_rounds_v38 round WHERE round.round_id=NEW.round_id AND round.seal_id=NEW.seal_id
        AND round.campaign_id=NEW.campaign_id AND round.turn_id=NEW.turn_id AND round.recorded_at=NEW.sealed_at) OR
      NEW.call_count<>(SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.round_id=NEW.round_id) OR
      (NEW.call_count>0 AND ((SELECT min(position) FROM agent_tool_calls_v38 call WHERE call.round_id=NEW.round_id)<>0 OR
        (SELECT max(position) FROM agent_tool_calls_v38 call WHERE call.round_id=NEW.round_id)<>NEW.call_count-1)) OR
      NOT EXISTS(SELECT 1 FROM agent_decision_rounds_v38 round WHERE round.round_id=NEW.round_id AND
        ((round.result='tool-calls' AND NEW.call_count>0) OR (round.result IN ('complete','refused') AND NEW.call_count=0)) AND
        json_type(round.response_json,'$.calls')='array' AND json_array_length(round.response_json,'$.calls')=NEW.call_count AND
        json_extract(round.response_json,'$.result')=round.result AND
        NOT EXISTS(SELECT 1 FROM json_each(round.response_json) field WHERE field.key NOT IN ('result','calls')) AND
        NOT EXISTS(SELECT 1 FROM agent_tool_calls_v38 call WHERE call.round_id=round.round_id AND NOT EXISTS(
          SELECT 1 FROM json_each(round.response_json,'$.calls') response_call WHERE CAST(response_call.key AS INTEGER)=call.position
            AND json_extract(response_call.value,'$.providerToolCallId')=call.provider_tool_call_id
            AND json_extract(response_call.value,'$.toolName')=call.tool_name AND json_extract(response_call.value,'$.kind')=call.call_kind
            AND json(json_extract(response_call.value,'$.arguments'))=json(call.arguments_json)
            AND NOT EXISTS(SELECT 1 FROM json_each(response_call.value) field WHERE field.key NOT IN ('providerToolCallId','toolName','kind','arguments')))))
      BEGIN SELECT RAISE(ABORT,'invalid durable agent decision batch seal'); END;
    CREATE TRIGGER agent_read_outcomes_validate_v38 BEFORE INSERT ON agent_read_outcomes_v38 WHEN
      NOT EXISTS(SELECT 1 FROM agent_execution_operations_v38 operation WHERE operation.operation_id=NEW.operation_id
        AND operation.campaign_id=NEW.campaign_id AND operation.turn_id=NEW.turn_id AND operation.operation_type='read-outcome'
        AND operation.resulting_execution_revision=NEW.resulting_execution_revision AND operation.occurred_at=NEW.recorded_at) OR
      NOT EXISTS(SELECT 1 FROM agent_tool_calls_v38 call WHERE call.call_id=NEW.call_id AND call.campaign_id=NEW.campaign_id
        AND call.turn_id=NEW.turn_id AND call.call_kind='read')
      BEGIN SELECT RAISE(ABORT,'invalid durable agent read outcome'); END;
  `);

  for (const table of TABLES.filter((value) => value !== "durable_agent_execution_layout_attestation_v38")) {
    const identity = table === "adventure_agent_executions_v38" ? "old.turn_id=NEW.turn_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)"
      : table === "agent_execution_operations_v38" ? "old.operation_id=NEW.operation_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.idempotency_key=NEW.idempotency_key OR old.resulting_execution_revision=NEW.resulting_execution_revision))"
      : table === "agent_provider_starts_v38" ? "old.operation_id=NEW.operation_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND old.provider_call_id=NEW.provider_call_id)"
      : table === "agent_decision_rounds_v38" ? "old.round_id=NEW.round_id OR old.seal_id=NEW.seal_id OR old.operation_id=NEW.operation_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.round_number=NEW.round_number OR old.provider_call_id=NEW.provider_call_id))"
      : table === "agent_tool_calls_v38" ? "old.call_id=NEW.call_id OR (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.provider_tool_call_id=NEW.provider_tool_call_id OR (old.round_number=NEW.round_number AND old.position=NEW.position)))"
      : table === "agent_decision_batch_seals_v38" ? "old.seal_id=NEW.seal_id OR old.round_id=NEW.round_id"
      : "old.outcome_id=NEW.outcome_id OR old.operation_id=NEW.operation_id OR old.call_id=NEW.call_id";
    db.exec(`CREATE TRIGGER ${table}_replace_v38 BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} old WHERE ${identity})
        BEGIN SELECT RAISE(ABORT,'${table} records cannot be replaced'); END;
      CREATE TRIGGER ${table}_update_v38 BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} records are immutable'); END;
      CREATE TRIGGER ${table}_delete_v38 BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} records are immutable'); END;`);
  }
  db.exec(`CREATE TRIGGER durable_agent_execution_attestation_insert_v38 BEFORE INSERT ON durable_agent_execution_layout_attestation_v38
      WHEN EXISTS(SELECT 1 FROM durable_agent_execution_layout_attestation_v38) BEGIN SELECT RAISE(ABORT,'v38 attestation is sealed'); END;
    CREATE TRIGGER durable_agent_execution_attestation_update_v38 BEFORE UPDATE ON durable_agent_execution_layout_attestation_v38 BEGIN SELECT RAISE(ABORT,'v38 attestation is immutable'); END;
    CREATE TRIGGER durable_agent_execution_attestation_delete_v38 BEFORE DELETE ON durable_agent_execution_layout_attestation_v38 BEGIN SELECT RAISE(ABORT,'v38 attestation is immutable'); END;`);
  assertInventory(db);
  db.prepare("INSERT INTO durable_agent_execution_layout_attestation_v38 VALUES(1,?)").run(layoutDigest(db));
}

/** Adds new migration-time windows and provider baselines without rewriting any historical turn. */
function backfillHistoricalExecutions(db: DatabaseDriver.Database): void {
  const startedAt = new Date().toISOString();
  const deadlineAt = new Date(new Date(startedAt).getTime() + MAX_AGENT_EXECUTION_DURATION_MS).toISOString();
  const insert = db.prepare(`INSERT INTO adventure_agent_executions_v38(campaign_id,turn_id,tool_registry_version,
    max_decision_rounds,max_tool_calls,max_mutation_calls,max_provider_calls,max_duration_ms,started_at,deadline_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`);
  for (const turn of db.prepare(`SELECT turn.campaign_id,turn.id,count(provider.record_id) provider_starts FROM adventure_turns turn
    LEFT JOIN provider_call_metadata provider ON provider.campaign_id=turn.campaign_id AND provider.turn_id=turn.id AND provider.phase='started'
    GROUP BY turn.campaign_id,turn.id ORDER BY turn.campaign_id,turn.id`).all() as Array<{ campaign_id: string; id: string; provider_starts: number }>) {
    insert.run(turn.campaign_id, turn.id, AGENT_TOOL_REGISTRY_VERSION,
      MAX_AGENT_DECISION_ROUNDS, MAX_AGENT_TOOL_CALLS, MAX_AGENT_MUTATION_CALLS,
      Math.max(MAX_AGENT_PROVIDER_CALLS, turn.provider_starts), MAX_AGENT_EXECUTION_DURATION_MS, startedAt, deadlineAt);
  }
}

function canonicalRow(value: string): { parsed: Record<string, unknown>; canonical: string } {
  const parsed = JSON.parse(value) as Record<string, unknown>;
  return { parsed, canonical: canonicalAgentJson(parsed as never) };
}

/** Validates every FK, canonical value, digest, sequence, limit, transition, and child projection independently at startup. */
export function validateDurableAgentExecutionDataV38(db: DatabaseDriver.Database): void {
  const fk = (db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string; rowid: number; parent: string; fkid: number }>)
    .find((row) => TABLES.includes(row.table as never));
  if (fk) throw new Error(`schema v38 durable agent foreign key violation (${fk.table} rowid=${fk.rowid} parent=${fk.parent} fk=${fk.fkid})`);
  const missingRun = db.prepare(`SELECT turn.id FROM adventure_turns turn LEFT JOIN adventure_agent_executions_v38 run
    ON run.campaign_id=turn.campaign_id AND run.turn_id=turn.id WHERE run.turn_id IS NULL LIMIT 1`).get() as { id: string } | undefined;
  if (missingRun) throw new Error(`schema v38 durable agent execution is missing (${missingRun.id})`);
  const badWindow = (db.prepare("SELECT * FROM adventure_agent_executions_v38").all() as any[]).find((run) =>
    new Date(run.deadline_at).getTime() - new Date(run.started_at).getTime() !== run.max_duration_ms);
  if (badWindow) throw new Error(`schema v38 durable agent window is malformed (${badWindow.turn_id})`);
  const badProviderLimit = db.prepare(`SELECT run.turn_id FROM adventure_agent_executions_v38 run WHERE
    (SELECT count(*) FROM provider_call_metadata provider WHERE provider.campaign_id=run.campaign_id
      AND provider.turn_id=run.turn_id AND provider.phase='started')>run.max_provider_calls OR
    (run.max_provider_calls>7 AND run.max_provider_calls<>(SELECT count(*) FROM provider_call_metadata provider
      WHERE provider.campaign_id=run.campaign_id AND provider.turn_id=run.turn_id AND provider.phase='started')) LIMIT 1`)
    .get() as { turn_id: string } | undefined;
  if (badProviderLimit) throw new Error(`schema v38 durable agent provider limit is malformed (${badProviderLimit.turn_id})`);

  const operations = db.prepare("SELECT * FROM agent_execution_operations_v38 ORDER BY campaign_id,turn_id,resulting_execution_revision").all() as any[];
  const malformedOperation = operations.find((operation) => {
    try {
      const value = canonicalRow(operation.request_json);
      const schemas: Record<string, { parse(input: unknown): unknown }> = {
        "provider-start": startAgentProviderCallInputSchema, "decision-round": persistAgentDecisionRoundInputSchema,
        "read-outcome": markAgentReadOutcomeInputSchema,
      };
      schemas[operation.operation_type]!.parse(value.parsed);
      return value.canonical !== operation.request_json || sha256(value.canonical) !== operation.request_digest;
    } catch { return true; }
  });
  if (malformedOperation) throw new Error(`schema v38 durable agent operation request is malformed (${malformedOperation.operation_id})`);
  const badOperationSequence = operations.find((operation, index) => operation.resulting_execution_revision !== operation.expected_execution_revision + 1
    || operation.expected_execution_revision !== operations.slice(0, index).filter((prior) => prior.campaign_id === operation.campaign_id
      && prior.turn_id === operation.turn_id).length);
  if (badOperationSequence) throw new Error(`schema v38 durable agent operation sequence is malformed (${badOperationSequence.operation_id})`);
  const badOperationIdentity = operations.find((operation) => {
    const parsed = JSON.parse(operation.request_json) as any;
    return parsed.turnId !== operation.turn_id || parsed.idempotencyKey !== operation.idempotency_key
      || parsed.expectedCampaignRevision !== operation.expected_campaign_revision || parsed.expectedTurnRevision !== operation.expected_turn_revision
      || parsed.expectedExecutionRevision !== operation.expected_execution_revision;
  });
  if (badOperationIdentity) throw new Error(`schema v38 durable agent operation identity is malformed (${badOperationIdentity.operation_id})`);

  const orphanedOperation = operations.find((operation) => {
    const children = operation.operation_type === "provider-start"
      ? db.prepare("SELECT count(*) count FROM agent_provider_starts_v38 WHERE operation_id=?").get(operation.operation_id) as { count: number }
      : operation.operation_type === "decision-round"
        ? db.prepare("SELECT count(*) count FROM agent_decision_rounds_v38 WHERE operation_id=?").get(operation.operation_id) as { count: number }
        : db.prepare("SELECT count(*) count FROM agent_read_outcomes_v38 WHERE operation_id=?").get(operation.operation_id) as { count: number };
    return children.count !== 1;
  });
  if (orphanedOperation) throw new Error(`schema v38 durable agent operation child is malformed (${orphanedOperation.operation_id})`);

  const badProvider = db.prepare(`SELECT sidecar.operation_id FROM agent_provider_starts_v38 sidecar
    JOIN agent_execution_operations_v38 operation ON operation.operation_id=sidecar.operation_id
    LEFT JOIN provider_call_metadata provider ON provider.campaign_id=sidecar.campaign_id AND provider.turn_id=sidecar.turn_id
      AND provider.call_id=sidecar.provider_call_id AND provider.phase='started'
    WHERE operation.operation_type<>'provider-start' OR operation.campaign_id<>sidecar.campaign_id OR operation.turn_id<>sidecar.turn_id
      OR operation.resulting_execution_revision<>sidecar.resulting_execution_revision
      OR operation.occurred_at<>sidecar.recorded_at OR provider.record_id IS NULL
      OR provider.recorded_at<>sidecar.recorded_at LIMIT 1`).get() as { operation_id: string } | undefined;
  if (badProvider) throw new Error(`schema v38 durable agent provider start is malformed (${badProvider.operation_id})`);
  const providerStarts = db.prepare(`SELECT sidecar.*,provider.provider,provider.model,provider.attempt,provider.idempotency_key
    FROM agent_provider_starts_v38 sidecar JOIN provider_call_metadata provider ON provider.campaign_id=sidecar.campaign_id
      AND provider.turn_id=sidecar.turn_id AND provider.call_id=sidecar.provider_call_id AND provider.phase='started'`).all() as any[];
  const mismatchedProvider = providerStarts.find((start) => {
    const operation = operations.find((candidate) => candidate.operation_id === start.operation_id);
    const parsed = JSON.parse(operation.request_json) as any;
    return parsed.providerCallId !== start.provider_call_id || parsed.provider !== start.provider || parsed.model !== start.model
      || parsed.attempt !== start.attempt || parsed.idempotencyKey !== start.idempotency_key
      || operation.resulting_execution_revision !== start.resulting_execution_revision;
  });
  if (mismatchedProvider) throw new Error(`schema v38 durable agent provider request is malformed (${mismatchedProvider.operation_id})`);
  const rounds = db.prepare("SELECT * FROM agent_decision_rounds_v38 ORDER BY campaign_id,turn_id,round_number").all() as any[];
  const calls = db.prepare("SELECT * FROM agent_tool_calls_v38 ORDER BY campaign_id,turn_id,round_number,position").all() as any[];
  const seals = db.prepare("SELECT * FROM agent_decision_batch_seals_v38").all() as any[];
  const outcomes = db.prepare("SELECT * FROM agent_read_outcomes_v38").all() as any[];
  const badProviderOrdering = providerStarts.find((start) => {
    const sameStarts = providerStarts.filter((candidate) => candidate.campaign_id === start.campaign_id && candidate.turn_id === start.turn_id)
      .sort((left, right) => left.resulting_execution_revision - right.resulting_execution_revision);
    const position = sameStarts.indexOf(start);
    const sameRounds = rounds.filter((round) => round.campaign_id === start.campaign_id && round.turn_id === start.turn_id)
      .sort((left, right) => left.round_number - right.round_number);
    const corresponding = sameRounds[position];
    const run = (db.prepare("SELECT max_decision_rounds FROM adventure_agent_executions_v38 WHERE campaign_id=? AND turn_id=?")
      .get(start.campaign_id, start.turn_id) as { max_decision_rounds: number });
    const priorRounds = sameRounds.filter((round) => round.resulting_execution_revision < start.resulting_execution_revision);
    const priorCalls = calls.filter((call) => priorRounds.some((round) => round.round_id === call.round_id));
    return priorRounds.length !== position || (!corresponding && sameRounds.length >= run.max_decision_rounds)
      || (corresponding ? corresponding.provider_call_id !== start.provider_call_id
      : position !== sameStarts.length - 1) || sameStarts.length - sameRounds.length < 0 || sameStarts.length - sameRounds.length > 1
      || priorCalls.some((call) => call.call_kind === "mutation" || !outcomes.some((outcome) => outcome.call_id === call.call_id
        && outcome.resulting_execution_revision < start.resulting_execution_revision));
  });
  if (badProviderOrdering) throw new Error(`schema v38 durable agent provider ordering is malformed (${badProviderOrdering.operation_id})`);
  const malformedRound = rounds.find((round, index) => {
    try {
      const request = canonicalRow(round.provider_request_json), response = canonicalRow(round.response_json);
      const childCalls = calls.filter((call) => call.round_id === round.round_id).map((call) => ({
        providerToolCallId: call.provider_tool_call_id, toolName: call.tool_name, kind: call.call_kind,
        arguments: JSON.parse(call.arguments_json),
      }));
      const operation = operations.find((candidate) => candidate.operation_id === round.operation_id) as any;
      const start = providerStarts.find((candidate) => candidate.campaign_id === round.campaign_id && candidate.turn_id === round.turn_id
        && candidate.provider_call_id === round.provider_call_id);
      const operationInput = persistAgentDecisionRoundInputSchema.parse(JSON.parse(operation.request_json));
      return request.canonical !== round.provider_request_json || sha256(request.canonical) !== round.provider_request_digest
        || response.canonical !== round.response_json || sha256(response.canonical) !== round.response_digest
        || response.canonical !== canonicalAgentJson({ result: round.result, calls: childCalls })
        || canonicalAgentJson(operationInput.request) !== request.canonical
        || canonicalAgentJson({ result: operationInput.result, calls: operationInput.calls }) !== response.canonical
        || operationInput.round !== round.round_number || operationInput.providerCallId !== round.provider_call_id
        || operationInput.toolRegistryVersion !== round.tool_registry_version
        || operation.resulting_execution_revision !== round.resulting_execution_revision
        || operation.campaign_id !== round.campaign_id || operation.turn_id !== round.turn_id
        || operation.occurred_at !== round.recorded_at || start?.resulting_execution_revision !== operation.expected_execution_revision
        || round.round_number !== rounds.slice(0, index).filter((prior) => prior.campaign_id === round.campaign_id && prior.turn_id === round.turn_id).length + 1;
    } catch { return true; }
  });
  if (malformedRound) throw new Error(`schema v38 durable agent decision round is malformed (${malformedRound.round_id})`);
  const malformedCall = calls.find((call, index) => {
    try {
      agentDecisionToolCallInputSchema.parse({ providerToolCallId: call.provider_tool_call_id, toolName: call.tool_name,
        kind: call.call_kind, arguments: JSON.parse(call.arguments_json) });
      const canonical = canonicalRow(call.arguments_json).canonical;
      const preceding = calls.slice(0, index).filter((prior) => prior.round_id === call.round_id).length;
      const round = rounds.find((candidate) => candidate.round_id === call.round_id);
      return canonical !== call.arguments_json || sha256(canonical) !== call.argument_digest || call.position !== preceding
        || !round || call.campaign_id !== round.campaign_id || call.turn_id !== round.turn_id
        || call.round_number !== round.round_number || call.recorded_at !== round.recorded_at;
    } catch { return true; }
  });
  if (malformedCall) throw new Error(`schema v38 durable agent tool call is malformed (${malformedCall.call_id})`);
  const malformedSeal = seals.find((seal) => {
    const round = rounds.find((candidate) => candidate.round_id === seal.round_id);
    const childCalls = calls.filter((call) => call.round_id === seal.round_id);
    return !round || seal.seal_id !== round.seal_id || seal.campaign_id !== round.campaign_id || seal.turn_id !== round.turn_id
      || seal.sealed_at !== round.recorded_at || seal.call_count !== childCalls.length
      || (seal.call_count > 0 && (Math.min(...childCalls.map((call) => call.position)) !== 0
        || Math.max(...childCalls.map((call) => call.position)) !== seal.call_count - 1));
  });
  const unsealedRound = rounds.find((round) => seals.filter((seal) => seal.round_id === round.round_id).length !== 1);
  if (malformedSeal || unsealedRound) throw new Error(`schema v38 durable agent batch seal is malformed (${malformedSeal?.seal_id ?? unsealedRound?.round_id})`);
  const exceededCalls = db.prepare(`SELECT run.turn_id FROM adventure_agent_executions_v38 run WHERE
    (SELECT count(*) FROM agent_decision_rounds_v38 round WHERE round.campaign_id=run.campaign_id AND round.turn_id=run.turn_id)>run.max_decision_rounds OR
    (SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.campaign_id=run.campaign_id AND call.turn_id=run.turn_id)>run.max_tool_calls OR
    (SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.campaign_id=run.campaign_id AND call.turn_id=run.turn_id AND call.call_kind='mutation')>run.max_mutation_calls LIMIT 1`).get() as { turn_id: string } | undefined;
  if (exceededCalls) throw new Error(`schema v38 durable agent call limits are malformed (${exceededCalls.turn_id})`);
  const badTransition = rounds.find((round, index) => rounds.slice(0, index).some((prior) => prior.campaign_id === round.campaign_id
    && prior.turn_id === round.turn_id && (prior.result !== "tool-calls" || calls.some((call) => call.round_id === prior.round_id
      && (call.call_kind === "mutation" || !outcomes.some((outcome) => outcome.call_id === call.call_id))))));
  if (badTransition) throw new Error(`schema v38 durable agent round transition is malformed (${badTransition.round_id})`);

  const malformedOutcome = outcomes.find((outcome) => {
    try {
      const operation = operations.find((candidate) => candidate.operation_id === outcome.operation_id);
      const call = calls.find((candidate) => candidate.call_id === outcome.call_id);
      const parsed = JSON.parse(operation.request_json) as any;
      const result = outcome.result_json ? canonicalRow(outcome.result_json) : null;
      return operation.operation_type !== "read-outcome" || call?.call_kind !== "read" || parsed.providerToolCallId !== call.provider_tool_call_id
        || operation.campaign_id !== outcome.campaign_id || operation.turn_id !== outcome.turn_id
        || operation.resulting_execution_revision !== outcome.resulting_execution_revision || operation.occurred_at !== outcome.recorded_at
        || call.campaign_id !== outcome.campaign_id || call.turn_id !== outcome.turn_id
        || operation.resulting_execution_revision <= (rounds.find((round) => round.round_id === call.round_id)?.resulting_execution_revision ?? Number.MAX_SAFE_INTEGER)
        || parsed.outcome.status !== outcome.status || (result && (result.canonical !== outcome.result_json || sha256(result.canonical) !== outcome.result_digest
          || canonicalAgentJson(parsed.outcome.result) !== result.canonical)) || (!result && parsed.outcome.errorCode !== outcome.error_code);
    } catch { return true; }
  });
  if (malformedOutcome) throw new Error(`schema v38 durable agent read outcome is malformed (${malformedOutcome.outcome_id})`);
}

/** Attests exact additive SQL and validates every durable execution row. */
export function assertDurableAgentExecutionV38(db: DatabaseDriver.Database): void {
  assertToolExecutionBindingsV37(db); assertDurableAgentExecutionLayoutV38(db); validateDurableAgentExecutionDataV38(db);
}

/** Validates only the exact v38 SQL inventory and immutable attestation. */
export function assertDurableAgentExecutionLayoutV38(db: DatabaseDriver.Database): void {
  assertInventory(db); const actual = layoutDigest(db);
  const row = db.prepare("SELECT layout_digest FROM durable_agent_execution_layout_attestation_v38 WHERE singleton=1").get() as { layout_digest: string } | undefined;
  if (!row || row.layout_digest !== actual || (V38_DURABLE_AGENT_EXECUTION_CANONICAL_DIGEST && actual !== V38_DURABLE_AGENT_EXECUTION_CANONICAL_DIGEST)) {
    throw new Error("schema v38 canonical durable agent execution layout is incompatible");
  }
}

/** Migrates canonical v37 to additive v38 without rewriting any historical object. */
export function migrate37to38(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    assertToolExecutionBindingsV37(db); createDurableAgentExecutionV38(db); backfillHistoricalExecutions(db);
    validateDurableAgentExecutionDataV38(db); db.prepare("UPDATE meta SET value='38' WHERE key='schemaVersion'").run();
  })();
}
