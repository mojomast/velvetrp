import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { canonicalAgentJson, confirmationPolicyAttestationSchema, LEGACY_CONFIRMATION_POLICY_VERSION } from "@velvet/contracts";
import { assertAgentResponseProvenanceV39, assertAgentResponseProvenanceV39WithV40 } from "./v39_agent_response_provenance.js";

const TABLES = ["confirmation_policy_attestations_v40", "agent_mutation_accounting_v40", "agent_replan_requirements_v40",
  "confirmation_authority_evidence_v40", "confirmation_expiration_operations_v40", "confirmation_policy_layout_attestation_v40"] as const;
const TRIGGERS = ["confirmation_policy_required_v40", "confirmation_authorizer_required_v40", "agent_mutation_limit_v40",
  "agent_total_tool_limit_v40", "agent_mutation_response_crossbind_v40", "combat_binding_response_crossbind_v40",
  "provider_response_context_crossbind_v40", "provider_claim_context_crossbind_v40",
  ...TABLES.flatMap((table) => [`${table}_update_v40`, `${table}_delete_v40`, `${table}_replace_v40`])] as const;
export const CONFIRMATION_POLICY_V40_MANAGED_OBJECTS = [
  ...TABLES.map((name) => ["table", name] as const), ...TRIGGERS.map((name) => ["trigger", name] as const),
];
const names = CONFIRMATION_POLICY_V40_MANAGED_OBJECTS.map(([, name]) => name);
export const CONFIRMATION_POLICY_V40_LAYOUT_DIGEST = "5b6de0023c69b7e1f614addbbbc732a63b34ddfda2861c1d6cac4cb31b46ae6a";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const layoutDigest = (db: DatabaseDriver.Database) => hash(JSON.stringify(db.prepare(
  `SELECT type,name,sql FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY type,name`,
).all(...names)));

/** Restores superseded guards when an empty rewound v40 shell is removed. */
export function restorePreV40CoordinationGuards(db:DatabaseDriver.Database):void { db.exec(`
  DROP TRIGGER agent_provider_starts_validate_v38; DROP TRIGGER agent_decision_rounds_validate_v38; DROP TRIGGER tool_proposals_guard_insert_v35;
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
         ((call.call_kind='read' AND NOT EXISTS(SELECT 1 FROM agent_read_outcomes_v38 outcome WHERE outcome.call_id=call.call_id)) OR call.call_kind='mutation'))))
    BEGIN SELECT RAISE(ABORT,'invalid durable agent decision round'); END;
  CREATE TRIGGER tool_proposals_guard_insert_v35 BEFORE INSERT ON tool_proposals WHEN EXISTS(SELECT 1 FROM tool_proposals old WHERE old.proposal_id=NEW.proposal_id OR
    (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.position=NEW.position OR old.idempotency_key=NEW.idempotency_key))) OR
    NOT EXISTS(SELECT 1 FROM adventure_turns turn WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND turn.state IN ('declared','proposed')) OR
    (NEW.requires_confirmation=1 AND NEW.confirmation_expires_at<=NEW.proposed_at) OR
    (SELECT count(*) FROM tool_proposals old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)>=32
    BEGIN SELECT RAISE(ABORT,'invalid or duplicate tool proposal'); END;
`); }

export function createConfirmationPolicyV40(db: DatabaseDriver.Database): void {
  db.exec(`
    DROP TRIGGER agent_provider_starts_validate_v38;
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
        ((call.call_kind='mutation' AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan
          WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id)) OR
         (call.call_kind='read' AND NOT EXISTS(SELECT 1 FROM agent_read_outcomes_v38 outcome WHERE outcome.call_id=call.call_id))))
      BEGIN SELECT RAISE(ABORT,'invalid durable agent provider start'); END;
    DROP TRIGGER agent_decision_rounds_validate_v38;
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
            (call.call_kind='mutation' AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan
              WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id))))))
      BEGIN SELECT RAISE(ABORT,'invalid durable agent decision round'); END;
    DROP TRIGGER tool_proposals_guard_insert_v35;
    CREATE TRIGGER tool_proposals_guard_insert_v35 BEFORE INSERT ON tool_proposals WHEN EXISTS(SELECT 1 FROM tool_proposals old WHERE old.proposal_id=NEW.proposal_id OR
      (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.position=NEW.position OR old.idempotency_key=NEW.idempotency_key))) OR
      NOT EXISTS(SELECT 1 FROM adventure_turns turn WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND
        (turn.state IN ('declared','proposed') OR (turn.state='mechanics-committed' AND EXISTS(
          SELECT 1 FROM adventure_coordination_events_v36 event WHERE event.campaign_id=turn.campaign_id AND event.aggregate_kind='turn'
            AND event.aggregate_id=turn.id AND event.resulting_revision=turn.revision AND event.resulting_state='declared') AND EXISTS(
          SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.campaign_id=turn.campaign_id AND replan.turn_id=turn.id)))) OR
      (NEW.requires_confirmation=1 AND NEW.confirmation_expires_at<=NEW.proposed_at) OR
      (SELECT count(*) FROM tool_proposals old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)>=32
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate tool proposal'); END;
    CREATE TABLE confirmation_policy_attestations_v40(
      proposal_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,
       policy_version TEXT NOT NULL CHECK(policy_version IN('v1','legacy-v40-backfill-v1')),category TEXT NOT NULL CHECK(category IN(
        'currency-transfer','purchase','important-item-loss','important-item-consume','important-item-gift',
        'ambiguous-limited-resource-use','rest-timing','companion-change','combat-start','combat-action-consequential',
        'generated-world-change','generated-quest-change','generated-story-change','gm-override','deterministic-roll','ambiguous-consequential-change')),
      requires_confirmation INTEGER NOT NULL CHECK(requires_confirmation IN(0,1)),
      required_authorizer TEXT NOT NULL CHECK(required_authorizer IN('controller','gm')),
      safe_summary_json TEXT NOT NULL CHECK(json_valid(safe_summary_json) AND json_type(safe_summary_json)='object'),
      proposed_command_digest TEXT NOT NULL CHECK(length(proposed_command_digest)=64 AND proposed_command_digest NOT GLOB '*[^0-9a-f]*'),
      observed_domain_revisions_json TEXT NOT NULL CHECK(json_valid(observed_domain_revisions_json) AND json_type(observed_domain_revisions_json)='array'),
      attested_at TEXT NOT NULL,UNIQUE(campaign_id,turn_id,proposal_id),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT);
    CREATE TABLE agent_mutation_accounting_v40(
      accounting_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,proposal_id TEXT NOT NULL UNIQUE,
      provider_call_id TEXT NOT NULL,provider_tool_call_id TEXT NOT NULL,round_number INTEGER NOT NULL CHECK(round_number BETWEEN 1 AND 5),
      tool_name TEXT NOT NULL CHECK(tool_name='combat_action.execute'),argument_digest TEXT NOT NULL CHECK(length(argument_digest)=64),recorded_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,provider_tool_call_id),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT,
        FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_responses_v39(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT,
        FOREIGN KEY(campaign_id,turn_id,proposal_id,provider_call_id,provider_tool_call_id)
          REFERENCES agent_combat_proposal_bindings_v39(campaign_id,turn_id,proposal_id,provider_call_id,provider_tool_call_id) ON DELETE RESTRICT);
    CREATE TABLE agent_replan_requirements_v40(
      requirement_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,proposal_id TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL CHECK(reason IN('policy-stale','command-stale','campaign-stale','timeline-stale','combat-stale','authority-stale')),
      validation_json TEXT NOT NULL CHECK(json_valid(validation_json) AND json_type(validation_json)='object'),required_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,proposal_id),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT);
    CREATE TABLE confirmation_expiration_operations_v40(
      operation_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,expected_turn_revision INTEGER NOT NULL,resulting_turn_revision INTEGER NOT NULL,
      proposal_ids_json TEXT NOT NULL CHECK(json_valid(proposal_ids_json) AND json_type(proposal_ids_json)='array'),expired_at TEXT NOT NULL,
       UNIQUE(campaign_id,turn_id,idempotency_key),UNIQUE(campaign_id,turn_id,resulting_turn_revision),
       FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT);
    CREATE TABLE confirmation_authority_evidence_v40(
      evidence_id TEXT PRIMARY KEY,decision_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,proposal_id TEXT NOT NULL,
      principal_id TEXT NOT NULL,decision TEXT NOT NULL CHECK(decision IN('approved','rejected','expired')),
      evidence_version TEXT NOT NULL CHECK(evidence_version IN('v1','legacy-v40-backfill-v1')),
      authority_role TEXT CHECK(authority_role IS NULL OR authority_role IN('owner','gm','player','observer')),
      authority_control TEXT CHECK(authority_control IS NULL OR authority_control IN('all','controlled','none')),
      actor_id TEXT,required_authorizer TEXT NOT NULL CHECK(required_authorizer IN('controller','gm')),
      policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64 AND policy_digest NOT GLOB '*[^0-9a-f]*'),
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json) AND json_type(evidence_json)='object'),
      evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),attested_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,proposal_id),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT);
    CREATE TABLE confirmation_policy_layout_attestation_v40(singleton INTEGER PRIMARY KEY CHECK(singleton=1),layout_digest TEXT NOT NULL);
    CREATE TRIGGER confirmation_policy_required_v40 BEFORE INSERT ON confirmation_decisions WHEN NOT EXISTS(
      SELECT 1 FROM confirmation_policy_attestations_v40 policy WHERE policy.proposal_id=NEW.proposal_id
        AND policy.campaign_id=NEW.campaign_id AND policy.turn_id=NEW.turn_id AND policy.requires_confirmation=1)
      BEGIN SELECT RAISE(ABORT,'confirmation decision lacks server policy'); END;
    CREATE TRIGGER confirmation_authorizer_required_v40 BEFORE INSERT ON confirmation_decisions WHEN NOT EXISTS(
        SELECT 1 FROM confirmation_authority_evidence_v40 evidence
        JOIN confirmation_policy_attestations_v40 policy ON policy.campaign_id=evidence.campaign_id
          AND policy.turn_id=evidence.turn_id AND policy.proposal_id=evidence.proposal_id
        WHERE evidence.decision_id=NEW.decision_id AND evidence.campaign_id=NEW.campaign_id AND evidence.turn_id=NEW.turn_id
          AND evidence.proposal_id=NEW.proposal_id AND evidence.principal_id=NEW.principal_id AND evidence.decision=NEW.decision
          AND evidence.attested_at=NEW.decided_at AND evidence.required_authorizer=policy.required_authorizer)
      BEGIN SELECT RAISE(ABORT,'confirmation decision lacks required authorizer'); END;
    CREATE TRIGGER agent_mutation_limit_v40 BEFORE INSERT ON agent_mutation_accounting_v40 WHEN
      (SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.campaign_id=NEW.campaign_id AND call.turn_id=NEW.turn_id AND call.call_kind='mutation'
        AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id))+
      (SELECT count(*) FROM agent_mutation_accounting_v40 old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id
        AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.proposal_id=old.proposal_id))>=
      (SELECT max_mutation_calls FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id)
      BEGIN SELECT RAISE(ABORT,'agent mutation limit exceeded'); END;
    CREATE TRIGGER agent_total_tool_limit_v40 BEFORE INSERT ON agent_mutation_accounting_v40 WHEN
      (SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.campaign_id=NEW.campaign_id AND call.turn_id=NEW.turn_id
        AND NOT(call.call_kind='mutation' AND EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id)))+
      (SELECT count(*) FROM agent_mutation_accounting_v40 old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id
        AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.proposal_id=old.proposal_id))>=
      (SELECT max_tool_calls FROM adventure_agent_executions_v38 run WHERE run.campaign_id=NEW.campaign_id AND run.turn_id=NEW.turn_id)
      BEGIN SELECT RAISE(ABORT,'agent tool limit exceeded'); END;
    CREATE TRIGGER agent_mutation_response_crossbind_v40 BEFORE INSERT ON agent_mutation_accounting_v40 WHEN NOT EXISTS(
       SELECT 1 FROM agent_provider_responses_v39 response JOIN agent_provider_contexts_v39 context
         ON context.context_id=response.context_id AND context.campaign_id=response.campaign_id
           AND context.turn_id=response.turn_id AND context.provider_call_id=response.provider_call_id
       JOIN agent_combat_proposal_bindings_v39 binding ON binding.campaign_id=NEW.campaign_id AND binding.turn_id=NEW.turn_id
         AND binding.proposal_id=NEW.proposal_id AND binding.provider_call_id=NEW.provider_call_id
         AND binding.provider_tool_call_id=NEW.provider_tool_call_id
      JOIN tool_proposals proposal ON proposal.campaign_id=NEW.campaign_id AND proposal.turn_id=NEW.turn_id AND proposal.proposal_id=NEW.proposal_id
      WHERE response.campaign_id=NEW.campaign_id AND response.turn_id=NEW.turn_id AND response.provider_call_id=NEW.provider_call_id
        AND response.status='succeeded' AND context.round_number=NEW.round_number
        AND json_extract(response.response_json,'$.result')='tool-calls'
        AND EXISTS(SELECT 1 FROM json_each(response.response_json,'$.calls') call
          WHERE json_extract(call.value,'$.providerToolCallId')=NEW.provider_tool_call_id
            AND json_extract(call.value,'$.toolName')=NEW.tool_name))
      BEGIN SELECT RAISE(ABORT,'agent mutation is not bound to its provider response'); END;
    CREATE TRIGGER combat_binding_response_crossbind_v40 BEFORE INSERT ON agent_combat_proposal_bindings_v39 WHEN NOT EXISTS(
      SELECT 1 FROM agent_provider_responses_v39 response WHERE response.campaign_id=NEW.campaign_id AND response.turn_id=NEW.turn_id
        AND response.provider_call_id=NEW.provider_call_id AND response.status='succeeded'
        AND EXISTS(SELECT 1 FROM json_each(response.response_json,'$.calls') call
          WHERE json_extract(call.value,'$.providerToolCallId')=NEW.provider_tool_call_id
            AND json_extract(call.value,'$.toolName')='combat_action.execute'
            AND json_extract(call.value,'$.arguments.legalActionId')=NEW.legal_action_id
            AND json_extract(call.value,'$.arguments.legalActionDigest')=NEW.legal_action_digest))
      BEGIN SELECT RAISE(ABORT,'combat proposal is not bound to its provider response'); END;
    CREATE TRIGGER provider_response_context_crossbind_v40 BEFORE INSERT ON agent_provider_responses_v39 WHEN NOT EXISTS(
      SELECT 1 FROM agent_provider_contexts_v39 context WHERE context.context_id=NEW.context_id AND context.campaign_id=NEW.campaign_id
        AND context.turn_id=NEW.turn_id AND context.provider_call_id=NEW.provider_call_id)
      BEGIN SELECT RAISE(ABORT,'provider response context is cross-wired'); END;
    CREATE TRIGGER provider_claim_context_crossbind_v40 BEFORE INSERT ON agent_provider_dispatch_claims_v39 WHEN NOT EXISTS(
      SELECT 1 FROM agent_provider_contexts_v39 context WHERE context.context_id=NEW.context_id AND context.campaign_id=NEW.campaign_id
        AND context.turn_id=NEW.turn_id AND context.provider_call_id=NEW.provider_call_id)
      BEGIN SELECT RAISE(ABORT,'provider claim context is cross-wired'); END;
  `);
  for (const table of TABLES) {
    const identity = table === "confirmation_policy_layout_attestation_v40" ? "OLD.singleton=NEW.singleton"
      : table === "confirmation_policy_attestations_v40" ? "OLD.proposal_id=NEW.proposal_id"
       : table === "confirmation_authority_evidence_v40" ? "OLD.evidence_id=NEW.evidence_id OR OLD.decision_id=NEW.decision_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.proposal_id=NEW.proposal_id)"
       : table === "agent_mutation_accounting_v40" ? "OLD.accounting_id=NEW.accounting_id OR OLD.proposal_id=NEW.proposal_id OR OLD.provider_tool_call_id=NEW.provider_tool_call_id"
       : table === "agent_replan_requirements_v40" ? "OLD.requirement_id=NEW.requirement_id OR OLD.proposal_id=NEW.proposal_id"
      : "OLD.operation_id=NEW.operation_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND (OLD.idempotency_key=NEW.idempotency_key OR OLD.resulting_turn_revision=NEW.resulting_turn_revision))";
    db.exec(`CREATE TRIGGER ${table}_replace_v40 BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} OLD WHERE ${identity}) BEGIN SELECT RAISE(ABORT,'v40 record cannot be replaced'); END;
      CREATE TRIGGER ${table}_update_v40 BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;
      CREATE TRIGGER ${table}_delete_v40 BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'v40 records are immutable'); END;`);
  }
  const actual = layoutDigest(db);
  if (actual !== CONFIRMATION_POLICY_V40_LAYOUT_DIGEST) throw new Error(`canonical schema v40 DDL digest changed (${actual})`);
  db.prepare("INSERT INTO confirmation_policy_layout_attestation_v40 VALUES(1,?)").run(actual);
}

function backfill(db: DatabaseDriver.Database): void {
  const insert = db.prepare(`INSERT INTO confirmation_policy_attestations_v40 VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of db.prepare(`SELECT proposal.*,turn.timeline_id,operation.expected_campaign_revision historical_campaign_revision,
      operation.expected_revision historical_turn_revision FROM tool_proposals proposal
    JOIN adventure_turns turn ON turn.id=proposal.turn_id AND turn.campaign_id=proposal.campaign_id
    JOIN adventure_coordination_commands_v36 operation ON operation.campaign_id=proposal.campaign_id
      AND operation.aggregate_kind='turn' AND operation.aggregate_id=proposal.turn_id AND operation.mutation_type='proposal-append'
      AND operation.idempotency_key=proposal.idempotency_key
    ORDER BY proposal.proposed_at,proposal.proposal_id`).all() as any[]) {
    const args = JSON.parse(row.arguments_json); const combat = row.tool_name === "combat_action";
    const category = combat ? "combat-action-consequential" : ["roll","roll_actor_dice"].includes(row.tool_name) ? "deterministic-roll"
      : row.tool_name === "set_actor_attribute" ? "gm-override" : "ambiguous-consequential-change";
    // Preserve the exact historical review requirement. A migration may add
    // compatible policy metadata, but cannot retroactively change consent.
    const required = Boolean(row.requires_confirmation);
    const legacyRoll=["roll","roll_actor_dice"].includes(row.tool_name);
    const review = { summary: combat ? "Execute the selected consequential combat action." : legacyRoll
      ? "Roll dice using authoritative mechanics." : "Apply a consequential character change.", consequences: [combat
        ? {kind:"combat-impact",text:"Combat state may change"} : legacyRoll
          ? {kind:"roll-recorded",text:"A roll result will be recorded"} : {kind:"attribute-change",text:"A character value will change"}] };
    const domains = [{ domain: "campaign", revision: row.historical_campaign_revision }, { domain: "turn", revision: row.historical_turn_revision }];
    if (Number.isSafeInteger(args.expectedTimelineRevision)) domains.push({ domain: "timeline", revision: args.expectedTimelineRevision });
    if (combat && Number.isSafeInteger(args.expectedCombatRevision)) domains.push({ domain: "combat", revision: args.expectedCombatRevision });
    const attestation = confirmationPolicyAttestationSchema.parse({ version: LEGACY_CONFIRMATION_POLICY_VERSION, category,
      requiresConfirmation: required, requiredAuthorizer: category === "gm-override" ? "gm" : "controller", review,
      proposedCommandDigest: hash(canonicalAgentJson({ toolName: row.tool_name, arguments: args })), observedDomains: domains, attestedAt: row.proposed_at });
    insert.run(row.proposal_id,row.campaign_id,row.turn_id,attestation.version,attestation.category,required?1:0,attestation.requiredAuthorizer,
      canonicalAgentJson(attestation.review as never),attestation.proposedCommandDigest,canonicalAgentJson(attestation.observedDomains),attestation.attestedAt);
  }
  const evidenceInsert=db.prepare(`INSERT INTO confirmation_authority_evidence_v40 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for(const row of db.prepare(`SELECT decision.*,turn.actor_id,policy.policy_version,policy.category,policy.requires_confirmation,
      policy.required_authorizer,policy.proposed_command_digest,policy.observed_domain_revisions_json
    FROM confirmation_decisions decision JOIN adventure_turns turn ON turn.campaign_id=decision.campaign_id AND turn.id=decision.turn_id
    JOIN confirmation_policy_attestations_v40 policy ON policy.campaign_id=decision.campaign_id AND policy.turn_id=decision.turn_id
      AND policy.proposal_id=decision.proposal_id ORDER BY decision.decided_at,decision.decision_id`).all() as any[]){
    const policyDigest=hash(canonicalAgentJson({version:row.policy_version,category:row.category,requiresConfirmation:Boolean(row.requires_confirmation),
      requiredAuthorizer:row.required_authorizer,proposedCommandDigest:row.proposed_command_digest,
      observedDomains:JSON.parse(row.observed_domain_revisions_json)} as never));
    const value={evidenceVersion:LEGACY_CONFIRMATION_POLICY_VERSION,authorityProven:false,decisionId:row.decision_id,
      campaignId:row.campaign_id,turnId:row.turn_id,proposalId:row.proposal_id,principalId:row.principal_id,
      decision:row.decision,actorId:row.actor_id,requiredAuthorizer:row.required_authorizer,policyDigest,attestedAt:row.decided_at};
    const json=canonicalAgentJson(value as never);
    evidenceInsert.run(`legacy:${hash(row.decision_id).slice(0,48)}`,row.decision_id,row.campaign_id,row.turn_id,row.proposal_id,
      row.principal_id,row.decision,LEGACY_CONFIRMATION_POLICY_VERSION,null,null,row.actor_id,row.required_authorizer,policyDigest,json,hash(json),row.decided_at);
  }
}

/** Exact SQL inventory/digest/attestation check used by rewound-marker cleanup. */
export function assertConfirmationPolicyLayoutV40(db:DatabaseDriver.Database):void {
  const expected = new Set(CONFIRMATION_POLICY_V40_MANAGED_OBJECTS.map(([type,name]) => `${type}:${name}`));
  const rows = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v40*' AND sql IS NOT NULL").all() as Array<{type:string;name:string}>;
  const missing = [...expected].find((entry) => !rows.some((row) => `${row.type}:${row.name}` === entry));
  const unknown = rows.find((row) => !expected.has(`${row.type}:${row.name}`));
  if (missing || unknown) throw new Error(`schema v40 inventory incompatible (${unknown?.name ?? missing})`);
  const attested = db.prepare("SELECT layout_digest FROM confirmation_policy_layout_attestation_v40 WHERE singleton=1").get() as {layout_digest:string}|undefined;
  const actual = layoutDigest(db); if (!attested || attested.layout_digest !== actual || (CONFIRMATION_POLICY_V40_LAYOUT_DIGEST && actual !== CONFIRMATION_POLICY_V40_LAYOUT_DIGEST)) throw new Error("schema v40 attestation mismatch");
}

export function assertConfirmationPolicyV40(db: DatabaseDriver.Database): void {
  assertAgentResponseProvenanceV39(db);assertConfirmationPolicyLayoutV40(db);assertAgentResponseProvenanceV39WithV40(db);
  const fk=(db.prepare("PRAGMA foreign_key_check").all() as Array<{table:string;rowid:number;parent:string}>).find((row)=>TABLES.includes(row.table as never));
  if(fk)throw new Error(`schema v40 foreign key violation (${fk.table} rowid=${fk.rowid} parent=${fk.parent})`);
  const missingPolicy = db.prepare(`SELECT proposal.proposal_id FROM tool_proposals proposal LEFT JOIN confirmation_policy_attestations_v40 policy
    ON policy.proposal_id=proposal.proposal_id WHERE policy.proposal_id IS NULL LIMIT 1`).get();
  if (missingPolicy) throw new Error("schema v40 proposal policy is missing");
  const crosswired=db.prepare(`SELECT response.response_id FROM agent_provider_responses_v39 response JOIN agent_provider_contexts_v39 context ON context.context_id=response.context_id
      AND context.campaign_id=response.campaign_id AND context.turn_id=response.turn_id AND context.provider_call_id=response.provider_call_id
    WHERE context.campaign_id<>response.campaign_id OR context.turn_id<>response.turn_id OR context.provider_call_id<>response.provider_call_id
    UNION ALL SELECT claim.claim_id FROM agent_provider_dispatch_claims_v39 claim JOIN agent_provider_contexts_v39 context ON context.context_id=claim.context_id
      AND context.campaign_id=claim.campaign_id AND context.turn_id=claim.turn_id AND context.provider_call_id=claim.provider_call_id
    WHERE context.campaign_id<>claim.campaign_id OR context.turn_id<>claim.turn_id OR context.provider_call_id<>claim.provider_call_id LIMIT 1`).get();
  if(crosswired)throw new Error("schema v40 provider context is cross-wired");
  for (const row of db.prepare(`SELECT policy.*,proposal.tool_name,proposal.arguments_json,
    proposal.requires_confirmation proposal_requires_confirmation,proposal.proposed_at,proposal.idempotency_key FROM confirmation_policy_attestations_v40 policy
    JOIN tool_proposals proposal ON proposal.campaign_id=policy.campaign_id AND proposal.turn_id=policy.turn_id AND proposal.proposal_id=policy.proposal_id`).all() as any[]) {
    const value = confirmationPolicyAttestationSchema.parse({ version:row.policy_version,category:row.category,requiresConfirmation:Boolean(row.requires_confirmation),requiredAuthorizer:row.required_authorizer,
      review:JSON.parse(row.safe_summary_json),proposedCommandDigest:row.proposed_command_digest,observedDomains:JSON.parse(row.observed_domain_revisions_json),attestedAt:row.attested_at });
    const compatible=row.tool_name==="combat_action"?["combat-action-consequential","controller"]
      :row.tool_name==="set_actor_attribute"?["gm-override","gm"]
      :["roll","roll_actor_dice"].includes(row.tool_name)?["deterministic-roll","controller"]
      :["ambiguous-consequential-change","controller"];
    const domains=new Map(value.observedDomains.map((item)=>[item.domain,item.revision]));
    const operation=db.prepare(`SELECT expected_campaign_revision,expected_revision,created_at FROM adventure_coordination_commands_v36
      WHERE campaign_id=? AND aggregate_kind='turn' AND aggregate_id=? AND mutation_type='proposal-append' AND idempotency_key=?`)
      .get(row.campaign_id,row.turn_id,row.idempotency_key) as any;
    if(!operation||domains.get("campaign")!==operation.expected_campaign_revision||domains.get("turn")!==operation.expected_revision
      ||(row.policy_version===LEGACY_CONFIRMATION_POLICY_VERSION&&row.attested_at!==row.proposed_at))
      throw new Error("schema v40 observed revision provenance malformed");
    if (canonicalAgentJson(value.review as never)!==row.safe_summary_json || canonicalAgentJson(value.observedDomains)!==row.observed_domain_revisions_json
      || value.proposedCommandDigest!==hash(canonicalAgentJson({toolName:row.tool_name,arguments:JSON.parse(row.arguments_json)}))
      || Boolean(row.proposal_requires_confirmation)!==Boolean(value.requiresConfirmation)
      ||value.category!==compatible[0]||value.requiredAuthorizer!==compatible[1]) throw new Error(`schema v40 proposal policy malformed (${row.tool_name}:${value.category})`);
  }
  for(const row of db.prepare(`SELECT accounting.*,proposal.arguments_json,response.response_json,context.round_number context_round_number,
    binding.legal_action_id,binding.legal_action_digest,binding.provider_call_id binding_provider_call_id,
    binding.provider_tool_call_id binding_provider_tool_call_id FROM agent_mutation_accounting_v40 accounting
    JOIN tool_proposals proposal ON proposal.campaign_id=accounting.campaign_id AND proposal.turn_id=accounting.turn_id AND proposal.proposal_id=accounting.proposal_id
    JOIN agent_provider_responses_v39 response ON response.campaign_id=accounting.campaign_id AND response.turn_id=accounting.turn_id AND response.provider_call_id=accounting.provider_call_id
    JOIN agent_provider_contexts_v39 context ON context.context_id=response.context_id AND context.campaign_id=response.campaign_id
      AND context.turn_id=response.turn_id AND context.provider_call_id=response.provider_call_id
    LEFT JOIN agent_combat_proposal_bindings_v39 binding ON binding.campaign_id=accounting.campaign_id AND binding.turn_id=accounting.turn_id AND binding.proposal_id=accounting.proposal_id`).all() as any[]){
    const response=JSON.parse(row.response_json),call=response.calls?.find((item:any)=>item.providerToolCallId===row.provider_tool_call_id&&item.toolName===row.tool_name);
    if(!call||response.result!=="tool-calls"||row.round_number!==row.context_round_number
      ||row.provider_call_id!==row.binding_provider_call_id||row.provider_tool_call_id!==row.binding_provider_tool_call_id
      ||row.argument_digest!==hash(canonicalAgentJson(JSON.parse(row.arguments_json)))
      ||(row.tool_name==="combat_action.execute"&&(call.arguments?.legalActionId!==row.legal_action_id||call.arguments?.legalActionDigest!==row.legal_action_digest)))
      throw new Error("schema v40 mutation accounting malformed");
  }
  for(const row of db.prepare("SELECT * FROM agent_replan_requirements_v40").all() as any[]){
    const parsed=JSON.parse(row.validation_json);if(canonicalAgentJson(parsed)!==row.validation_json||parsed.reason!==row.reason||parsed.proposalId!==row.proposal_id)
      throw new Error("schema v40 replan requirement malformed");
  }
  const decisions=db.prepare(`SELECT decision.*,evidence.evidence_id,evidence.decision_id evidence_decision_id,
      evidence.campaign_id evidence_campaign_id,evidence.turn_id evidence_turn_id,evidence.proposal_id evidence_proposal_id,
      evidence.principal_id evidence_principal_id,evidence.decision evidence_decision,evidence.evidence_version,
      evidence.authority_role,evidence.authority_control,evidence.actor_id,evidence.required_authorizer,evidence.policy_digest,
      evidence.evidence_json,evidence.evidence_digest,evidence.attested_at,
      turn.actor_id turn_actor_id,policy.policy_version,policy.category,
      policy.requires_confirmation,policy.required_authorizer policy_required_authorizer,policy.proposed_command_digest,
      policy.observed_domain_revisions_json
    FROM confirmation_decisions decision LEFT JOIN confirmation_authority_evidence_v40 evidence ON evidence.decision_id=decision.decision_id
    JOIN adventure_turns turn ON turn.campaign_id=decision.campaign_id AND turn.id=decision.turn_id
    JOIN confirmation_policy_attestations_v40 policy ON policy.campaign_id=decision.campaign_id AND policy.turn_id=decision.turn_id
      AND policy.proposal_id=decision.proposal_id`).all() as any[];
  for(const row of decisions){
    const policyDigest=hash(canonicalAgentJson({version:row.policy_version,category:row.category,requiresConfirmation:Boolean(row.requires_confirmation),
      requiredAuthorizer:row.policy_required_authorizer,proposedCommandDigest:row.proposed_command_digest,
      observedDomains:JSON.parse(row.observed_domain_revisions_json)} as never));
    let value:any;try{value=JSON.parse(row.evidence_json??"");}catch{value=null;}
    const common=!row.evidence_id||row.evidence_decision_id!==row.decision_id||row.evidence_campaign_id!==row.campaign_id
      ||row.evidence_turn_id!==row.turn_id||row.evidence_proposal_id!==row.proposal_id
      ||row.evidence_principal_id!==row.principal_id||row.evidence_decision!==row.decision||row.actor_id!==row.turn_actor_id
      ||row.required_authorizer!==row.policy_required_authorizer||row.policy_digest!==policyDigest
      ||row.attested_at!==row.decided_at||canonicalAgentJson(value as never)!==row.evidence_json||hash(row.evidence_json)!==row.evidence_digest;
    const expectedEvidence=row.evidence_version==='v1'
      ?{evidenceVersion:'v1',authorityProven:true,decisionId:row.decision_id,campaignId:row.campaign_id,turnId:row.turn_id,
        proposalId:row.proposal_id,principalId:row.principal_id,decision:row.decision,actorId:row.actor_id,
        authorityRole:row.authority_role,authorityControl:row.authority_control,requiredAuthorizer:row.required_authorizer,
        policyDigest:row.policy_digest,attestedAt:row.attested_at}
      :{evidenceVersion:LEGACY_CONFIRMATION_POLICY_VERSION,authorityProven:false,decisionId:row.decision_id,
        campaignId:row.campaign_id,turnId:row.turn_id,proposalId:row.proposal_id,principalId:row.principal_id,
        decision:row.decision,actorId:row.actor_id,requiredAuthorizer:row.required_authorizer,
        policyDigest:row.policy_digest,attestedAt:row.attested_at};
    const exact=row.evidence_json===canonicalAgentJson(expectedEvidence as never);
    const executable=row.evidence_version==='v1'&&row.policy_version==='v1'&&value?.authorityProven===true
      &&((row.decision==='expired'&&((row.authority_role==='owner'||row.authority_role==='gm')
        ||(row.authority_role==='player'&&row.authority_control==='controlled')))
        ||(row.decision!=='expired'&&((row.required_authorizer==='gm'&&['owner','gm'].includes(row.authority_role))
          ||(row.required_authorizer==='controller'&&(['owner','gm'].includes(row.authority_role)
            ||(row.authority_role==='player'&&row.authority_control==='controlled'))))))
      &&value.authorityRole===row.authority_role&&value.authorityControl===row.authority_control;
    const legacy=row.evidence_version===LEGACY_CONFIRMATION_POLICY_VERSION&&row.policy_version===LEGACY_CONFIRMATION_POLICY_VERSION
      &&row.authority_role===null&&row.authority_control===null&&value?.authorityProven===false;
    if(common||!exact||(!executable&&!legacy))throw new Error("schema v40 confirmation authority evidence malformed");
  }
  const orphanEvidence=db.prepare(`SELECT evidence.evidence_id FROM confirmation_authority_evidence_v40 evidence
    LEFT JOIN confirmation_decisions decision ON decision.decision_id=evidence.decision_id
      AND decision.campaign_id=evidence.campaign_id AND decision.turn_id=evidence.turn_id AND decision.proposal_id=evidence.proposal_id
      AND decision.principal_id=evidence.principal_id AND decision.decision=evidence.decision
    WHERE decision.decision_id IS NULL LIMIT 1`).get();
  if(orphanEvidence)throw new Error("schema v40 confirmation authority evidence is orphaned");
  const exceeded=db.prepare(`SELECT run.turn_id FROM adventure_agent_executions_v38 run WHERE
    (SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.campaign_id=run.campaign_id AND call.turn_id=run.turn_id
      AND NOT(call.call_kind='mutation' AND EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id)))+
      (SELECT count(*) FROM agent_mutation_accounting_v40 item WHERE item.campaign_id=run.campaign_id AND item.turn_id=run.turn_id
        AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.proposal_id=item.proposal_id))>run.max_tool_calls OR
    (SELECT count(*) FROM agent_tool_calls_v38 call WHERE call.campaign_id=run.campaign_id AND call.turn_id=run.turn_id AND call.call_kind='mutation'
      AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.campaign_id=call.campaign_id AND replan.turn_id=call.turn_id))+
      (SELECT count(*) FROM agent_mutation_accounting_v40 item WHERE item.campaign_id=run.campaign_id AND item.turn_id=run.turn_id
        AND NOT EXISTS(SELECT 1 FROM agent_replan_requirements_v40 replan WHERE replan.proposal_id=item.proposal_id))>run.max_mutation_calls LIMIT 1`).get();
  if(exceeded)throw new Error("schema v40 agent limits malformed");
  for(const operation of db.prepare("SELECT * FROM confirmation_expiration_operations_v40").all() as any[]){
    let ids:unknown;try{ids=JSON.parse(operation.proposal_ids_json);}catch{ids=null;}
    if(!Array.isArray(ids)||ids.some((value)=>typeof value!=="string")
      ||canonicalAgentJson([...ids].sort() as never)!==operation.proposal_ids_json
      ||operation.resulting_turn_revision!==operation.expected_turn_revision+1)
      throw new Error("schema v40 expiration operation malformed");
    const command=db.prepare(`SELECT command_id,principal_id,expected_revision,resulting_revision FROM adventure_coordination_commands_v36
      WHERE campaign_id=? AND aggregate_kind='turn' AND aggregate_id=? AND mutation_type='confirmation-expiration' AND idempotency_key=?`)
      .get(operation.campaign_id,operation.turn_id,operation.idempotency_key) as any;
    const decisions=db.prepare(`SELECT proposal_id FROM confirmation_decisions WHERE campaign_id=? AND turn_id=?
      AND decision='expired' AND expected_turn_revision=? AND decided_at=? ORDER BY proposal_id`)
      .all(operation.campaign_id,operation.turn_id,operation.expected_turn_revision,operation.expired_at) as Array<{proposal_id:string}>;
    if(!command||command.principal_id!==operation.principal_id||command.expected_revision!==operation.expected_turn_revision
      ||command.resulting_revision!==operation.resulting_turn_revision
      ||canonicalAgentJson(decisions.map((item)=>item.proposal_id) as never)!==operation.proposal_ids_json)
      throw new Error("schema v40 expiration operation provenance malformed");
  }
}

export function migrate39to40(db: DatabaseDriver.Database): void {
  db.transaction(() => { assertAgentResponseProvenanceV39(db); createConfirmationPolicyV40(db); backfill(db);
    db.prepare("UPDATE meta SET value='40' WHERE key='schemaVersion'").run(); })();
  assertConfirmationPolicyV40(db);
}
