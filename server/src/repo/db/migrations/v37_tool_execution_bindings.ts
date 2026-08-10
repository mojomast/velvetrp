import { createHash } from "node:crypto";
import DatabaseDriver from "better-sqlite3";
import { assertAdventureHardeningV36 } from "./v36_adventure_hardening.js";

/** Canonical digest of the additive v37 proposal execution-binding layout. */
export const V37_TOOL_EXECUTION_BINDING_CANONICAL_DIGEST = "feda07d9a80af42ffbbc5a65c86f0573b10c5a291b1297b2310b8687f01f5976";

const TABLES = ["tool_proposal_execution_bindings_v37", "tool_execution_binding_layout_attestation_v37"] as const;
const INDEXES = ["idx_tool_proposal_execution_bindings_turn_v37"] as const;
const TRIGGERS = [
  "tool_proposal_execution_bindings_validate_v37", "tool_proposal_execution_bindings_insert_v37",
  "tool_proposal_execution_bindings_update_v37", "tool_proposal_execution_bindings_delete_v37",
  "turn_mechanics_links_execution_binding_v37", "tool_execution_binding_attestation_insert_v37",
  "tool_execution_binding_attestation_update_v37", "tool_execution_binding_attestation_delete_v37",
] as const;

/** Exact SQLite object inventory owned by additive schema v37. */
export const TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS: ReadonlyArray<readonly ["table" | "index" | "trigger", string]> = [
  ...TABLES.map((name) => ["table", name] as const), ...INDEXES.map((name) => ["index", name] as const),
  ...TRIGGERS.map((name) => ["trigger", name] as const),
];

const names = TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS.map(([, name]) => name);
const layoutDigest = (db: DatabaseDriver.Database): string => createHash("sha256").update(JSON.stringify(db.prepare(
  `SELECT type,name,sql FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type,name`,
).all(...names))).digest("hex");

function assertInventory(db: DatabaseDriver.Database): void {
  const expected = new Set(TOOL_EXECUTION_BINDING_V37_MANAGED_OBJECTS.map(([type, name]) => `${type}:${name}`));
  const rows = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL`)
    .all(...names) as Array<{ type: string; name: string }>;
  const actual = new Set(rows.map(({ type, name }) => `${type}:${name}`));
  const missing = [...expected].find((entry) => !actual.has(entry));
  const unknown = (db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v37*' AND sql IS NOT NULL").all() as Array<{ type: string; name: string }>)
    .find(({ type, name }) => !expected.has(`${type}:${name}`));
  if (missing || unknown) throw new Error(`schema v37 tool execution binding object inventory is incompatible (${unknown?.name ?? missing})`);
}

/** Derives an execution key exclusively from an injected, server-owned proposal identity. */
export const proposalExecutionIdempotencyKeyV37 = (proposalId: string): string =>
  `mechanics:${createHash("sha256").update(proposalId).digest("hex").slice(0, 48)}`;

/** Creates the additive execution-binding sidecar without changing any prior table. */
export function createToolExecutionBindingsV37(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE tool_proposal_execution_bindings_v37(
      proposal_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      execution_idempotency_key TEXT NOT NULL CHECK(length(execution_idempotency_key) BETWEEN 1 AND 128
        AND execution_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      command_type TEXT NOT NULL CHECK(command_type IN ('set_actor_attribute','initialize_actor_resource','roll_actor_dice')),
      source_turn_id TEXT NOT NULL, timeline_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      bound_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',bound_at) IS NOT NULL
        AND bound_at=strftime('%Y-%m-%dT%H:%M:%fZ',bound_at) AND substr(bound_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,execution_idempotency_key), UNIQUE(campaign_id,turn_id,proposal_id),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT);
    CREATE INDEX idx_tool_proposal_execution_bindings_turn_v37
      ON tool_proposal_execution_bindings_v37(campaign_id,turn_id,proposal_id);
    CREATE TABLE tool_execution_binding_layout_attestation_v37(
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64));

    CREATE TRIGGER tool_proposal_execution_bindings_validate_v37 BEFORE INSERT ON tool_proposal_execution_bindings_v37 WHEN
      EXISTS(SELECT 1 FROM tool_proposal_execution_bindings_v37 old WHERE old.proposal_id=NEW.proposal_id OR
        (old.campaign_id=NEW.campaign_id AND old.execution_idempotency_key=NEW.execution_idempotency_key)) OR
      NEW.turn_id<>NEW.source_turn_id OR NOT EXISTS(SELECT 1 FROM tool_proposals proposal JOIN adventure_turns turn
        ON turn.campaign_id=proposal.campaign_id AND turn.id=proposal.turn_id WHERE proposal.proposal_id=NEW.proposal_id
          AND proposal.campaign_id=NEW.campaign_id AND proposal.turn_id=NEW.turn_id AND turn.timeline_id=NEW.timeline_id
          AND turn.actor_id=NEW.actor_id AND proposal.proposed_at=NEW.bound_at
          AND ((proposal.tool_name IN ('roll','roll-check','roll_actor_dice') AND NEW.command_type='roll_actor_dice')
            OR proposal.tool_name=NEW.command_type))
      BEGIN SELECT RAISE(ABORT,'invalid tool proposal execution binding'); END;
    CREATE TRIGGER tool_proposal_execution_bindings_insert_v37 BEFORE INSERT ON tool_proposal_execution_bindings_v37
      WHEN EXISTS(SELECT 1 FROM tool_proposal_execution_bindings_v37 old WHERE old.rowid=NEW.rowid)
      BEGIN SELECT RAISE(ABORT,'tool proposal execution bindings are immutable'); END;
    CREATE TRIGGER tool_proposal_execution_bindings_update_v37 BEFORE UPDATE ON tool_proposal_execution_bindings_v37
      BEGIN SELECT RAISE(ABORT,'tool proposal execution bindings are immutable'); END;
    CREATE TRIGGER tool_proposal_execution_bindings_delete_v37 BEFORE DELETE ON tool_proposal_execution_bindings_v37
      BEGIN SELECT RAISE(ABORT,'tool proposal execution bindings are immutable'); END;
    CREATE TRIGGER turn_mechanics_links_execution_binding_v37 BEFORE INSERT ON turn_mechanics_links_v36 WHEN NOT EXISTS(
      SELECT 1 FROM tool_proposal_execution_bindings_v37 binding JOIN campaign_commands command
        ON command.campaign_id=binding.campaign_id AND command.idempotency_key=binding.execution_idempotency_key
        AND command.type=binding.command_type AND command.timeline_id=binding.timeline_id AND command.actor_id=binding.actor_id
        AND command.source_turn_id=binding.source_turn_id
      WHERE binding.campaign_id=NEW.campaign_id AND binding.turn_id=NEW.turn_id AND binding.proposal_id=NEW.proposal_id
        AND binding.source_turn_id=NEW.source_turn_id AND command.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'mechanics receipt requires exact proposal execution binding'); END;
    CREATE TRIGGER tool_execution_binding_attestation_insert_v37 BEFORE INSERT ON tool_execution_binding_layout_attestation_v37
      WHEN EXISTS(SELECT 1 FROM tool_execution_binding_layout_attestation_v37)
      BEGIN SELECT RAISE(ABORT,'v37 attestation is sealed'); END;
    CREATE TRIGGER tool_execution_binding_attestation_update_v37 BEFORE UPDATE ON tool_execution_binding_layout_attestation_v37
      BEGIN SELECT RAISE(ABORT,'v37 attestation is immutable'); END;
    CREATE TRIGGER tool_execution_binding_attestation_delete_v37 BEFORE DELETE ON tool_execution_binding_layout_attestation_v37
      BEGIN SELECT RAISE(ABORT,'v37 attestation is immutable'); END;
  `);
  assertInventory(db);
  db.prepare("INSERT INTO tool_execution_binding_layout_attestation_v37 VALUES(1,?)").run(layoutDigest(db));
}

const mappedCommandType = (toolName: string): string => ["roll", "roll-check", "roll_actor_dice"].includes(toolName)
  ? "roll_actor_dice" : toolName;

/** Backfills exact linked keys and deterministic keys only for provably unexecuted proposals. */
function backfillBindings(db: DatabaseDriver.Database): void {
  const ambiguous = db.prepare(`SELECT command.command_id FROM campaign_commands command JOIN adventure_turns turn
    ON turn.campaign_id=command.campaign_id AND turn.id=command.source_turn_id
    JOIN command_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
    WHERE NOT EXISTS(SELECT 1 FROM turn_mechanics_links_v36 link
      WHERE link.campaign_id=command.campaign_id AND link.command_id=command.command_id) LIMIT 1`).get() as { command_id: string } | undefined;
  if (ambiguous) throw new Error(`schema v36 source-turn mechanics lack a provable proposal binding (${ambiguous.command_id})`);
  const proposals = db.prepare(`SELECT proposal.*,turn.timeline_id,turn.actor_id,linked.command_id,command.idempotency_key command_key
    FROM tool_proposals proposal JOIN adventure_turns turn ON turn.campaign_id=proposal.campaign_id AND turn.id=proposal.turn_id
    LEFT JOIN turn_mechanics_links_v36 linked ON linked.campaign_id=proposal.campaign_id AND linked.turn_id=proposal.turn_id
      AND linked.proposal_id=proposal.proposal_id
    LEFT JOIN campaign_commands command ON command.campaign_id=linked.campaign_id AND command.command_id=linked.command_id
    ORDER BY proposal.campaign_id,proposal.turn_id,proposal.position`).all() as any[];
  const insert = db.prepare(`INSERT INTO tool_proposal_execution_bindings_v37(proposal_id,campaign_id,turn_id,
    execution_idempotency_key,command_type,source_turn_id,timeline_id,actor_id,bound_at) VALUES(?,?,?,?,?,?,?,?,?)`);
  for (const proposal of proposals) insert.run(proposal.proposal_id, proposal.campaign_id, proposal.turn_id,
    proposal.command_key ?? proposalExecutionIdempotencyKeyV37(proposal.proposal_id), mappedCommandType(proposal.tool_name),
    proposal.turn_id, proposal.timeline_id, proposal.actor_id, proposal.proposed_at);
}

/** Validates exact sidecar coverage and command/link provenance. */
export function validateToolExecutionBindingDataV37(db: DatabaseDriver.Database): void {
  const hasCombatBindings = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_combat_proposal_bindings_v39'").get());
  const missing = db.prepare(`SELECT proposal.proposal_id FROM tool_proposals proposal LEFT JOIN tool_proposal_execution_bindings_v37 binding
    ON binding.campaign_id=proposal.campaign_id AND binding.turn_id=proposal.turn_id AND binding.proposal_id=proposal.proposal_id
    ${hasCombatBindings ? `LEFT JOIN agent_combat_proposal_bindings_v39 combat ON combat.campaign_id=proposal.campaign_id
      AND combat.turn_id=proposal.turn_id AND combat.proposal_id=proposal.proposal_id` : ""}
    WHERE binding.proposal_id IS NULL ${hasCombatBindings ? "AND combat.proposal_id IS NULL" : ""} LIMIT 1`).get() as { proposal_id: string } | undefined;
  if (missing) throw new Error(`schema v37 tool proposal execution binding is missing (${missing.proposal_id})`);
  const invalidLink = db.prepare(`SELECT link.link_id FROM turn_mechanics_links_v36 link
    JOIN tool_proposal_execution_bindings_v37 binding ON binding.campaign_id=link.campaign_id AND binding.turn_id=link.turn_id
      AND binding.proposal_id=link.proposal_id
    JOIN campaign_commands command ON command.campaign_id=link.campaign_id AND command.command_id=link.command_id
    WHERE command.idempotency_key<>binding.execution_idempotency_key OR command.type<>binding.command_type
      OR command.source_turn_id<>binding.source_turn_id OR command.timeline_id<>binding.timeline_id OR command.actor_id<>binding.actor_id LIMIT 1`)
    .get() as { link_id: string } | undefined;
  if (invalidLink) throw new Error(`schema v37 mechanics link execution binding is malformed (${invalidLink.link_id})`);
  const unboundCommand = db.prepare(`SELECT command.command_id FROM campaign_commands command JOIN adventure_turns turn
      ON turn.campaign_id=command.campaign_id AND turn.id=command.source_turn_id
    LEFT JOIN tool_proposal_execution_bindings_v37 binding ON binding.campaign_id=command.campaign_id
      AND binding.execution_idempotency_key=command.idempotency_key AND binding.source_turn_id=command.source_turn_id
      AND binding.timeline_id=command.timeline_id AND binding.actor_id=command.actor_id AND binding.command_type=command.type
    WHERE binding.proposal_id IS NULL LIMIT 1`).get() as { command_id: string } | undefined;
  if (unboundCommand) throw new Error(`schema v37 source-turn command execution binding is malformed (${unboundCommand.command_id})`);
}

/** Attests canonical additive SQL and all exact execution provenance. */
export function assertToolExecutionBindingsV37(db: DatabaseDriver.Database): void {
  assertAdventureHardeningV36(db);
  assertToolExecutionBindingLayoutV37(db);
  validateToolExecutionBindingDataV37(db);
}

/** Validates only the exact additive v37 SQL inventory and attestation. */
export function assertToolExecutionBindingLayoutV37(db: DatabaseDriver.Database): void {
  assertInventory(db);
  const actual = layoutDigest(db);
  const row = db.prepare("SELECT layout_digest FROM tool_execution_binding_layout_attestation_v37 WHERE singleton=1").get() as { layout_digest: string } | undefined;
  if (!row || row.layout_digest !== actual || (V37_TOOL_EXECUTION_BINDING_CANONICAL_DIGEST
      && actual !== V37_TOOL_EXECUTION_BINDING_CANONICAL_DIGEST)) throw new Error("schema v37 canonical tool execution binding layout is incompatible");
}

/** Migrates v36 to v37 transactionally without altering any prior table. */
export function migrate36to37(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    assertAdventureHardeningV36(db);
    createToolExecutionBindingsV37(db);
    backfillBindings(db);
    validateToolExecutionBindingDataV37(db);
    db.prepare("UPDATE meta SET value='37' WHERE key='schemaVersion'").run();
  })();
}
