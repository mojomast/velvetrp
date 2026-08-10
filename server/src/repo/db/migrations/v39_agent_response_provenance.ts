import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import { assertDurableAgentExecutionV38 } from "./v38_durable_agent_execution.js";
import { canonicalAgentJson } from "@velvet/contracts";

const TABLES = ["agent_provider_contexts_v39", "agent_provider_dispatch_claims_v39", "agent_provider_responses_v39", "agent_combat_proposal_bindings_v39", "agent_generalized_receipts_v39",
  "agent_response_provenance_attestation_v39"] as const;
const TRIGGERS = ["agent_provider_starts_require_terminal_v39", "agent_decisions_require_inbox_v39",
  "agent_provider_response_tools_v39", "agent_generalized_receipts_validate_v39",
  ...TABLES.flatMap((table) => [`${table}_update_v39`, `${table}_delete_v39`, `${table}_replace_v39`])] as const;
export const AGENT_RESPONSE_PROVENANCE_V39_MANAGED_OBJECTS = [
  ...TABLES.map((name) => ["table", name] as const), ...TRIGGERS.map((name) => ["trigger", name] as const),
];
const names = AGENT_RESPONSE_PROVENANCE_V39_MANAGED_OBJECTS.map(([, name]) => name);
export const AGENT_RESPONSE_PROVENANCE_V39_LAYOUT_DIGEST="325566a9a827ece25bf53d2b4c43f93a571e43a50f0e2e37349df1baed6e26eb";
const digest = (db: DatabaseDriver.Database) => createHash("sha256").update(JSON.stringify(db.prepare(
  `SELECT type,name,sql FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) ORDER BY type,name`,
).all(...names))).digest("hex");

export function createAgentResponseProvenanceV39(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE agent_provider_contexts_v39(
      context_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,provider_call_id TEXT NOT NULL,
      round_number INTEGER NOT NULL CHECK(round_number BETWEEN 1 AND 5),timeline_id TEXT NOT NULL,timeline_revision INTEGER NOT NULL,
      campaign_revision INTEGER NOT NULL,turn_revision INTEGER NOT NULL,context_json TEXT NOT NULL CHECK(json_valid(context_json)),
      context_digest TEXT NOT NULL CHECK(length(context_digest)=64),request_json TEXT NOT NULL CHECK(json_valid(request_json)),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64),bound_at TEXT NOT NULL,
       UNIQUE(campaign_id,turn_id,round_number),UNIQUE(campaign_id,turn_id,provider_call_id),UNIQUE(context_id,campaign_id,turn_id,provider_call_id),FOREIGN KEY(campaign_id,turn_id,provider_call_id)
        REFERENCES agent_provider_starts_v38(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT);
    CREATE TABLE agent_provider_responses_v39(
      response_id TEXT PRIMARY KEY,context_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,
        provider_call_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('succeeded','failed','cancelled')),
      response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),response_digest TEXT,
      prompt_tokens INTEGER,completion_tokens INTEGER,outcome_code TEXT NOT NULL,recorded_at TEXT NOT NULL,
       UNIQUE(campaign_id,turn_id,provider_call_id),CHECK((status='succeeded' AND response_json IS NOT NULL AND length(response_digest)=64) OR
        (status<>'succeeded' AND response_json IS NULL AND response_digest IS NULL)),
       FOREIGN KEY(context_id,campaign_id,turn_id,provider_call_id)
         REFERENCES agent_provider_contexts_v39(context_id,campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_starts_v38(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT);
    CREATE TABLE agent_provider_dispatch_claims_v39(
      claim_id TEXT PRIMARY KEY,context_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,
       provider_call_id TEXT NOT NULL,claimed_at TEXT NOT NULL,lease_expires_at TEXT NOT NULL CHECK(lease_expires_at>claimed_at),
        UNIQUE(campaign_id,turn_id,provider_call_id),FOREIGN KEY(context_id,campaign_id,turn_id,provider_call_id)
         REFERENCES agent_provider_contexts_v39(context_id,campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_starts_v38(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT);
    CREATE TABLE agent_generalized_receipts_v39(
      link_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,receipt_family TEXT NOT NULL CHECK(receipt_family='combat'),
       proposal_id TEXT,command_id TEXT NOT NULL,encounter_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,revision_before INTEGER NOT NULL,
      revision_after INTEGER NOT NULL CHECK(revision_after=revision_before+1),linked_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,receipt_family,command_id),
       FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT,
       FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT,
      FOREIGN KEY(encounter_id,command_id,revision_after) REFERENCES combat_receipts_v27(encounter_id,command_id,resulting_revision) ON DELETE RESTRICT);
    CREATE TABLE agent_combat_proposal_bindings_v39(
      proposal_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,turn_id TEXT NOT NULL,provider_call_id TEXT NOT NULL,
       provider_tool_call_id TEXT NOT NULL,encounter_id TEXT NOT NULL,legal_action_id TEXT NOT NULL,command_legal_action_id TEXT NOT NULL,legal_action_digest TEXT NOT NULL,
      expected_combat_revision INTEGER NOT NULL,execution_idempotency_key TEXT NOT NULL UNIQUE,bound_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,provider_tool_call_id),UNIQUE(campaign_id,turn_id,proposal_id,provider_call_id,provider_tool_call_id),
       FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT,
       FOREIGN KEY(campaign_id,turn_id,provider_call_id) REFERENCES agent_provider_responses_v39(campaign_id,turn_id,provider_call_id) ON DELETE RESTRICT);
    CREATE TABLE agent_response_provenance_attestation_v39(singleton INTEGER PRIMARY KEY CHECK(singleton=1),layout_digest TEXT NOT NULL);

    CREATE TRIGGER agent_provider_starts_require_terminal_v39 BEFORE INSERT ON agent_provider_starts_v38 WHEN EXISTS(
      SELECT 1 FROM agent_provider_starts_v38 prior WHERE prior.campaign_id=NEW.campaign_id AND prior.turn_id=NEW.turn_id
         AND EXISTS(SELECT 1 FROM agent_provider_contexts_v39 context WHERE context.campaign_id=prior.campaign_id AND context.turn_id=prior.turn_id AND context.provider_call_id=prior.provider_call_id) AND NOT EXISTS(
        SELECT 1 FROM provider_call_metadata outcome WHERE outcome.campaign_id=prior.campaign_id AND outcome.turn_id=prior.turn_id
          AND outcome.call_id=prior.provider_call_id AND outcome.phase<>'started'))
      BEGIN SELECT RAISE(ABORT,'prior provider start is not terminal'); END;
    CREATE TRIGGER agent_decisions_require_inbox_v39 BEFORE INSERT ON agent_decision_rounds_v38 WHEN EXISTS(
      SELECT 1 FROM agent_provider_contexts_v39 context WHERE context.campaign_id=NEW.campaign_id AND context.turn_id=NEW.turn_id
        AND context.provider_call_id=NEW.provider_call_id) AND NOT EXISTS(
      SELECT 1 FROM agent_provider_responses_v39 response JOIN agent_provider_contexts_v39 context
        ON context.context_id=response.context_id AND context.campaign_id=response.campaign_id
          AND context.turn_id=response.turn_id AND context.provider_call_id=response.provider_call_id
      WHERE response.campaign_id=NEW.campaign_id AND response.turn_id=NEW.turn_id AND response.provider_call_id=NEW.provider_call_id
        AND response.status='succeeded' AND response.response_digest=NEW.response_digest
        AND context.request_digest=NEW.provider_request_digest AND NOT EXISTS(
          SELECT 1 FROM json_each(response.response_json,'$.calls') call WHERE json_extract(call.value,'$.toolName')='actor_resource.initialize'
            OR NOT EXISTS(SELECT 1 FROM json_each(context.request_json,'$.advertisedTools') tool
              WHERE tool.value=json_extract(call.value,'$.toolName'))))
      BEGIN SELECT RAISE(ABORT,'decision batch does not match immutable provider inbox'); END;
    CREATE TRIGGER agent_provider_response_tools_v39 BEFORE INSERT ON agent_provider_responses_v39 WHEN NEW.status='succeeded' AND EXISTS(
      SELECT 1 FROM json_each(NEW.response_json,'$.calls') call JOIN agent_provider_contexts_v39 context ON context.context_id=NEW.context_id
        AND context.campaign_id=NEW.campaign_id AND context.turn_id=NEW.turn_id AND context.provider_call_id=NEW.provider_call_id
      WHERE json_extract(call.value,'$.toolName')='actor_resource.initialize' OR NOT EXISTS(
        SELECT 1 FROM json_each(context.request_json,'$.advertisedTools') tool WHERE tool.value=json_extract(call.value,'$.toolName')))
      BEGIN SELECT RAISE(ABORT,'provider response contains an unadvertised tool'); END;
    CREATE TRIGGER agent_generalized_receipts_validate_v39 BEFORE INSERT ON agent_generalized_receipts_v39 WHEN NOT EXISTS(
      SELECT 1 FROM adventure_turns turn JOIN encounter ON encounter.campaign_id=turn.campaign_id AND encounter.session_id=turn.session_id
      JOIN combat_commands_v27 command ON command.encounter_id=encounter.encounter_id
      JOIN combat_receipts_v27 receipt ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id
        AND receipt.resulting_revision=command.resulting_revision
      WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND encounter.encounter_id=NEW.encounter_id
        AND command.command_id=NEW.command_id AND command.idempotency_key=NEW.idempotency_key AND command.command_type='resolve_action'
        AND command.expected_revision=NEW.revision_before AND command.resulting_revision=NEW.revision_after
        AND receipt.occurred_at=NEW.linked_at AND (NEW.proposal_id IS NULL OR EXISTS(
          SELECT 1 FROM agent_combat_proposal_bindings_v39 binding WHERE binding.proposal_id=NEW.proposal_id
             AND binding.campaign_id=NEW.campaign_id AND binding.turn_id=NEW.turn_id AND binding.encounter_id=NEW.encounter_id
            AND binding.execution_idempotency_key=NEW.idempotency_key)))
      BEGIN SELECT RAISE(ABORT,'generalized receipt lacks authoritative command-service provenance'); END;
  `);
  for (const table of TABLES) {
    const identity = table === "agent_response_provenance_attestation_v39" ? "OLD.singleton=NEW.singleton"
      : table === "agent_provider_contexts_v39" ? "OLD.context_id=NEW.context_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.provider_call_id=NEW.provider_call_id)"
      : table === "agent_provider_responses_v39" ? "OLD.response_id=NEW.response_id OR OLD.context_id=NEW.context_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.provider_call_id=NEW.provider_call_id)"
      : table === "agent_provider_dispatch_claims_v39" ? "OLD.claim_id=NEW.claim_id OR OLD.context_id=NEW.context_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.provider_call_id=NEW.provider_call_id)"
      : table === "agent_combat_proposal_bindings_v39" ? "OLD.proposal_id=NEW.proposal_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.provider_tool_call_id=NEW.provider_tool_call_id)"
      : "OLD.link_id=NEW.link_id OR (OLD.campaign_id=NEW.campaign_id AND OLD.turn_id=NEW.turn_id AND OLD.command_id=NEW.command_id)";
    db.exec(`CREATE TRIGGER ${table}_replace_v39 BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} OLD WHERE ${identity}) BEGIN SELECT RAISE(ABORT,'v39 record cannot be replaced'); END;
      CREATE TRIGGER ${table}_update_v39 BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;
      CREATE TRIGGER ${table}_delete_v39 BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'v39 records are immutable'); END;`);
  }
  const actual=digest(db);if(actual!==AGENT_RESPONSE_PROVENANCE_V39_LAYOUT_DIGEST)throw new Error(`canonical schema v39 DDL digest changed (${actual})`);
  db.prepare("INSERT INTO agent_response_provenance_attestation_v39 VALUES(1,?)").run(AGENT_RESPONSE_PROVENANCE_V39_LAYOUT_DIGEST);
}

/** Exact SQL inventory/digest/attestation check used by rewound-marker cleanup. */
export function assertAgentResponseProvenanceLayoutV39(db:DatabaseDriver.Database):void {
  const expected = new Set(AGENT_RESPONSE_PROVENANCE_V39_MANAGED_OBJECTS.map(([type,name]) => `${type}:${name}`));
  const rows = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v39*' AND sql IS NOT NULL").all() as Array<{type:string;name:string}>;
  const missing = [...expected].find((entry) => !rows.some((row) => `${row.type}:${row.name}` === entry));
  const unknown = rows.find((row) => !expected.has(`${row.type}:${row.name}`));
  if (missing || unknown) throw new Error(`schema v39 inventory incompatible (${unknown?.name ?? missing})`);
  const attestation = db.prepare("SELECT layout_digest FROM agent_response_provenance_attestation_v39 WHERE singleton=1").get() as {layout_digest:string}|undefined;
  if (!attestation || attestation.layout_digest !== AGENT_RESPONSE_PROVENANCE_V39_LAYOUT_DIGEST || digest(db)!==AGENT_RESPONSE_PROVENANCE_V39_LAYOUT_DIGEST) throw new Error("schema v39 attestation mismatch");
}

export function assertAgentResponseProvenanceV39(db: DatabaseDriver.Database): void {
  assertAgentResponseProvenanceLayoutV39(db);
  const fk=(db.prepare("PRAGMA foreign_key_check").all() as Array<{table:string;rowid:number;parent:string}>).find((row)=>TABLES.includes(row.table as never));
  if(fk)throw new Error(`schema v39 foreign key violation (${fk.table} rowid=${fk.rowid} parent=${fk.parent})`);
  const badResponse = db.prepare(`SELECT response_id FROM agent_provider_responses_v39 response LEFT JOIN provider_call_metadata outcome
    ON outcome.campaign_id=response.campaign_id AND outcome.turn_id=response.turn_id AND outcome.call_id=response.provider_call_id
      AND outcome.phase=response.status AND outcome.prompt_tokens IS response.prompt_tokens AND outcome.completion_tokens IS response.completion_tokens
      AND outcome.outcome_code=response.outcome_code AND outcome.recorded_at=response.recorded_at WHERE outcome.record_id IS NULL LIMIT 1`).get();
  if (badResponse) throw new Error("schema v39 provider outcome provenance is incomplete");
  const mismatchedSettlement=db.prepare(`SELECT response.response_id FROM agent_provider_responses_v39 response
    JOIN provider_call_metadata outcome ON outcome.campaign_id=response.campaign_id AND outcome.turn_id=response.turn_id
      AND outcome.call_id=response.provider_call_id AND outcome.phase=response.status
    JOIN provider_call_metadata start ON start.campaign_id=response.campaign_id AND start.turn_id=response.turn_id
      AND start.call_id=response.provider_call_id AND start.phase='started'
    WHERE outcome.provider<>start.provider OR outcome.model<>start.model OR outcome.attempt<>start.attempt LIMIT 1`).get();
  if(mismatchedSettlement)throw new Error("schema v39 provider settlement identity is malformed");
  const badClaim=db.prepare(`SELECT claim.claim_id FROM agent_provider_dispatch_claims_v39 claim
    JOIN agent_provider_contexts_v39 context ON context.context_id=claim.context_id AND context.campaign_id=claim.campaign_id
      AND context.turn_id=claim.turn_id AND context.provider_call_id=claim.provider_call_id
    JOIN adventure_agent_executions_v38 run ON run.turn_id=claim.turn_id AND run.campaign_id=claim.campaign_id
    WHERE claim.provider_call_id<>context.provider_call_id OR claim.campaign_id<>context.campaign_id OR claim.turn_id<>context.turn_id
      OR claim.claimed_at<context.bound_at OR claim.lease_expires_at<>run.deadline_at LIMIT 1`).get();
  if(badClaim)throw new Error("schema v39 provider dispatch claim malformed");
  const allowed=new Set(["campaign_context.read","actor_resources.read","actor_inventory.read","actor_powers.read","combat_state.read","world_state.read","quest_state.read","actor_attribute.set","actor_dice.roll","combat_action.execute"]);
  for(const context of db.prepare("SELECT * FROM agent_provider_contexts_v39").all() as any[]){
    let contextValue:any,requestValue:any;try{contextValue=JSON.parse(context.context_json);requestValue=JSON.parse(context.request_json);}catch{throw new Error("schema v39 context JSON malformed");}
    if(canonicalAgentJson(contextValue)!==context.context_json||canonicalAgentJson(requestValue)!==context.request_json
      ||createHash("sha256").update(context.context_json).digest("hex")!==context.context_digest
      ||createHash("sha256").update(context.request_json).digest("hex")!==context.request_digest)throw new Error("schema v39 context digest mismatch");
    const identity=contextValue.decisionIdentity;if(contextValue.orphanedBeforeDispatch!==true&&(!identity||identity.timelineId!==context.timeline_id
      ||identity.timelineRevision!==context.timeline_revision||identity.campaignRevision!==context.campaign_revision
      ||identity.turnRevision!==context.turn_revision||identity.roundNumber!==context.round_number))throw new Error("schema v39 decision identity mismatch");
    if(contextValue.orphanedBeforeDispatch!==true){
      const provenance=db.prepare(`SELECT operation.request_json,start.resulting_execution_revision FROM agent_provider_starts_v38 start
        JOIN agent_execution_operations_v38 operation ON operation.operation_id=start.operation_id
        WHERE start.campaign_id=? AND start.turn_id=? AND start.provider_call_id=?`).get(context.campaign_id,context.turn_id,context.provider_call_id) as any;
      let operation:any;try{operation=JSON.parse(provenance?.request_json??"");}catch{operation=null;}
      if(!operation||operation.providerCallId!==context.provider_call_id||operation.expectedTurnRevision!==context.turn_revision
        ||operation.expectedCampaignRevision!==context.campaign_revision)throw new Error("schema v39 context operation provenance mismatch");
       const round=db.prepare("SELECT round_number FROM agent_decision_rounds_v38 WHERE campaign_id=? AND turn_id=? AND provider_call_id=?").get(context.campaign_id,context.turn_id,context.provider_call_id) as any;
       if(round&&round.round_number!==context.round_number)throw new Error("schema v39 context round provenance mismatch");
    }
     const tools=requestValue.advertisedTools;if(contextValue.orphanedBeforeDispatch!==true&&(!Array.isArray(tools)||new Set(tools).size!==tools.length||tools.some((tool:unknown)=>typeof tool!=="string"||!allowed.has(tool))
       ||(tools.includes("combat_action.execute")&&requestValue.postV38ToolRegistryVersion!=="v2")))
      throw new Error("schema v39 advertised tool set malformed");
    if(contextValue.orphanedBeforeDispatch!==true){
      if(!["owner","gm","player","observer"].includes(identity.authority?.role)||!["all","controlled","none"].includes(identity.authority?.control))throw new Error("schema v39 authority snapshot malformed");
      const encounter=identity.encounter,candidates=encounter?.legalActionCandidates??[];
       if(!Array.isArray(candidates)||candidates.some((candidate:any)=>candidate.digest!==createHash("sha256").update(JSON.stringify([encounter.encounterId,encounter.revision,candidate.legalActionId,encounter.currentCombatantId,candidate.targetId])).digest("hex")
         ||!(candidate.targetId===null||typeof candidate.targetId==="string")||typeof candidate.commandLegalActionId!=="string"))
        throw new Error("schema v39 legal action snapshot malformed");
       const attributes=identity.attributeCandidates;if(!Array.isArray(attributes)||attributes.some((item:any)=>typeof item.candidateId!=="string"
         ||typeof item.commandAttributeId!=="string"||!Number.isSafeInteger(item.currentValue)||item.digest!==createHash("sha256").update(JSON.stringify([
           context.campaign_id,context.timeline_id,context.timeline_revision,identity.audience?.actorId,item.commandAttributeId,item.currentValue])).digest("hex")))
         throw new Error("schema v39 attribute candidates malformed");
       const expected=["campaign_context.read","world_state.read","quest_state.read"];if(encounter)expected.push("combat_state.read");
      const controlled=identity.audience?.kind==="player"&&identity.authority.control!=="none";if(controlled)expected.push("actor_resources.read","actor_inventory.read","actor_powers.read");
       if(controlled&&!encounter){if(attributes.length)expected.push("actor_attribute.set");expected.push("actor_dice.roll");}
      const ownsTurn=(controlled&&identity.audience?.kind==="player"&&identity.audience.actorId===encounter?.currentActorId)||(identity.audience?.kind==="enemy"&&identity.audience.combatantId===encounter?.currentCombatantId);
      if(candidates.length&&ownsTurn)expected.push("combat_action.execute");if(canonicalAgentJson(tools)!==canonicalAgentJson(expected))throw new Error("schema v39 advertised tools do not match authority snapshot");
    }
  }
  for(const response of db.prepare("SELECT * FROM agent_provider_responses_v39").all() as any[]){
    if(response.status==="succeeded"){
      const canonical=canonicalAgentJson(JSON.parse(response.response_json));if(canonical!==response.response_json||createHash("sha256").update(canonical).digest("hex")!==response.response_digest)
        throw new Error("schema v39 response digest mismatch");
      const request=JSON.parse((db.prepare(`SELECT request_json FROM agent_provider_contexts_v39
        WHERE context_id=? AND campaign_id=? AND turn_id=? AND provider_call_id=?`)
        .get(response.context_id,response.campaign_id,response.turn_id,response.provider_call_id) as any).request_json) as any;
      const advertised=new Set(request.advertisedTools);const value=JSON.parse(canonical) as any;
      if(!Array.isArray(value.calls)||value.calls.some((call:any)=>!advertised.has(call.toolName)||call.toolName==="actor_resource.initialize"))throw new Error("schema v39 response exceeds advertised tools");
    }
  }
  for(const binding of db.prepare(`SELECT binding.*,proposal.tool_name,proposal.arguments_json,proposal.requires_confirmation,response.response_json,context.context_json
    FROM agent_combat_proposal_bindings_v39 binding JOIN tool_proposals proposal ON proposal.proposal_id=binding.proposal_id
    JOIN agent_provider_responses_v39 response ON response.campaign_id=binding.campaign_id AND response.turn_id=binding.turn_id AND response.provider_call_id=binding.provider_call_id
    JOIN agent_provider_contexts_v39 context ON context.context_id=response.context_id AND context.campaign_id=response.campaign_id
      AND context.turn_id=response.turn_id AND context.provider_call_id=response.provider_call_id`).all() as any[]){
    const response=JSON.parse(binding.response_json),identity=JSON.parse(binding.context_json).decisionIdentity,args=JSON.parse(binding.arguments_json);
    const call=response.calls?.find((item:any)=>item.providerToolCallId===binding.provider_tool_call_id&&item.toolName==="combat_action.execute");
    const candidate=identity.encounter?.legalActionCandidates?.find((item:any)=>item.legalActionId===binding.legal_action_id&&item.digest===binding.legal_action_digest);
    const player=identity.audience?.kind==="player";
     if(binding.tool_name!=="combat_action"||!call||call.arguments?.legalActionId!==candidate?.legalActionId||call.arguments?.legalActionDigest!==binding.legal_action_digest
       ||!candidate||identity.encounter.encounterId!==binding.encounter_id||identity.encounter.revision!==binding.expected_combat_revision
       ||binding.legal_action_id!==candidate.legalActionId||binding.command_legal_action_id!==candidate.commandLegalActionId
       ||args.commandLegalActionId!==candidate.commandLegalActionId||args.targetId!==candidate.targetId||Boolean(binding.requires_confirmation)!==player)
      throw new Error("schema v39 combat proposal provenance malformed");
  }
  const badGeneralized=db.prepare(`SELECT link.link_id FROM agent_generalized_receipts_v39 link JOIN adventure_turns turn ON turn.id=link.turn_id AND turn.campaign_id=link.campaign_id
    LEFT JOIN encounter ON encounter.encounter_id=link.encounter_id AND encounter.campaign_id=link.campaign_id AND encounter.session_id=turn.session_id
    LEFT JOIN combat_commands_v27 command ON command.encounter_id=link.encounter_id AND command.command_id=link.command_id AND command.idempotency_key=link.idempotency_key
      AND command.expected_revision=link.revision_before AND command.resulting_revision=link.revision_after AND command.command_type='resolve_action'
    LEFT JOIN combat_receipts_v27 receipt ON receipt.encounter_id=command.encounter_id AND receipt.command_id=command.command_id AND receipt.resulting_revision=command.resulting_revision
    WHERE encounter.encounter_id IS NULL OR command.command_id IS NULL OR receipt.command_id IS NULL OR receipt.occurred_at<>link.linked_at LIMIT 1`).get();
  if(badGeneralized)throw new Error("schema v39 generalized combat provenance malformed");
}

/** Cross-version checks are deliberately separate: a genuine v38 -> v39
 * migration must be fully assertable before any v40 object exists. */
export function assertAgentResponseProvenanceV39WithV40(db:DatabaseDriver.Database):void {
  const mismatch=db.prepare(`SELECT context.context_id FROM agent_provider_contexts_v39 context
    JOIN agent_mutation_accounting_v40 mutation ON mutation.campaign_id=context.campaign_id
      AND mutation.turn_id=context.turn_id AND mutation.provider_call_id=context.provider_call_id
    WHERE mutation.round_number<>context.round_number LIMIT 1`).get();
  if(mismatch)throw new Error("schema v39/v40 context round provenance mismatch");
}

export function migrate38to39(db: DatabaseDriver.Database): void {
  db.transaction(() => { assertDurableAgentExecutionV38(db); createAgentResponseProvenanceV39(db);
    db.prepare("UPDATE meta SET value='39' WHERE key='schemaVersion'").run(); })();
  assertAgentResponseProvenanceV39(db);
}
