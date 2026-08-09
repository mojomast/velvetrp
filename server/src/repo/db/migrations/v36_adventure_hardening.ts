import { createHash } from "node:crypto";
import DatabaseDriver from "better-sqlite3";
import {
  appendToolProposalInputSchema, applyGenerationDraftInputSchema, createAdventureTurnInputSchema,
  createGenerationDraftInputSchema, decideToolProposalInputSchema, generationDraftValidationSchema,
  linkTurnReceiptInputSchema, privateAdventureTurnSchema, privateGenerationDraftSchema,
  providerCallOutcomeInputSchema, providerCallStartInputSchema, reviewGenerationDraftInputSchema,
  stagedGenerationContentSchema, toolProposalSchema, turnMutationInputSchema, updateTurnNarrationInputSchema,
} from "@velvet/contracts";
import { ADVENTURE_GENERATION_V35_MANAGED_OBJECTS, assertAdventureGenerationV35 } from "./v35_adventure_generation.js";

/** Canonical digest of the committed, immutable v35r1 SQLite layout. */
export const V35_ADVENTURE_GENERATION_CANONICAL_DIGEST = "e133d1bf2490232c9eef1d9cb9fbca669c2320385f35d28d8bb02c62b5a28133";
/** Canonical digest of the v36 hardening layout. Filled from the reviewed DDL, never from persisted attestation. */
export const V36_ADVENTURE_HARDENING_CANONICAL_DIGEST = "682647023ae9ee9f6c575172a9d142a769641d5ba6649059e8cbf52b3fef5330";

const TABLES = ["adventure_coordination_commands_v36", "adventure_coordination_events_v36",
  "adventure_coordination_receipts_v36", "turn_mechanics_links_v36", "generation_draft_apply_receipts_v36",
  "adventure_hardening_layout_attestation_v36"] as const;
const INDEXES = ["idx_adventure_coordination_commands_aggregate_v36", "idx_turn_mechanics_links_turn_v36"] as const;
const IMMUTABLE = TABLES.filter((table) => table !== "adventure_hardening_layout_attestation_v36");
const TRIGGERS = [
  "adventure_coordination_commands_validate_v36", "adventure_coordination_events_validate_v36",
  "adventure_coordination_receipts_validate_v36", "turn_mechanics_links_validate_v36",
  "generation_draft_apply_receipts_validate_v36", "provider_call_metadata_bound_v36",
  "final_receipt_links_provenance_v36", "adventure_hardening_attestation_insert_v36",
  "adventure_hardening_attestation_update_v36", "adventure_hardening_attestation_delete_v36",
  ...IMMUTABLE.flatMap((table) => [`${table}_insert_v36`, `${table}_update_v36`, `${table}_delete_v36`]),
] as const;

/** Exact SQLite object inventory owned by additive schema v36. */
export const ADVENTURE_HARDENING_V36_MANAGED_OBJECTS: ReadonlyArray<readonly ["table" | "index" | "trigger", string]> = [
  ...TABLES.map((name) => ["table", name] as const), ...INDEXES.map((name) => ["index", name] as const),
  ...TRIGGERS.map((name) => ["trigger", name] as const),
];

const layoutDigest = (db: DatabaseDriver.Database): string => createHash("sha256").update(JSON.stringify(db.prepare(
  `SELECT type,name,sql FROM sqlite_master WHERE name IN (${ADVENTURE_HARDENING_V36_MANAGED_OBJECTS.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type,name`,
).all(...ADVENTURE_HARDENING_V36_MANAGED_OBJECTS.map(([, name]) => name)))).digest("hex");

const canonical = (value: unknown): string => JSON.stringify(value, (_key, nested) => nested && typeof nested === "object" && !Array.isArray(nested)
  ? Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) : nested);

function assertInventory(db: DatabaseDriver.Database): void {
  const expected = new Set(ADVENTURE_HARDENING_V36_MANAGED_OBJECTS.map(([type, name]) => `${type}:${name}`));
  const names = ADVENTURE_HARDENING_V36_MANAGED_OBJECTS.map(([, name]) => name);
  const rows = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL`).all(...names) as Array<{ type: string; name: string }>;
  const actual = new Set(rows.map(({ type, name }) => `${type}:${name}`));
  const missing = [...expected].find((entry) => !actual.has(entry));
  const wrong = rows.find(({ type, name }) => !expected.has(`${type}:${name}`));
  const unknown = (db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v36*' AND sql IS NOT NULL").all() as Array<{ type: string; name: string }>)
    .find(({ type, name }) => !expected.has(`${type}:${name}`));
  if (missing || wrong || unknown) throw new Error(`schema v36 adventure hardening object inventory is incompatible (${unknown?.name ?? wrong?.name ?? missing})`);
}

/** Creates only additive ledgers, provenance sidecars, and guards over the immutable v35 schema. */
export function createAdventureHardeningV36(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE adventure_coordination_commands_v36(
      command_id TEXT PRIMARY KEY, aggregate_kind TEXT NOT NULL CHECK(aggregate_kind IN ('turn','draft')),
      campaign_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      mutation_type TEXT NOT NULL CHECK(length(mutation_type) BETWEEN 1 AND 64), idempotency_key TEXT NOT NULL,
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN -1 AND 9007199254740990),
      expected_campaign_revision INTEGER NOT NULL CHECK(typeof(expected_campaign_revision)='integer' AND expected_campaign_revision BETWEEN 0 AND 9007199254740991),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 0 AND 9007199254740991),
      request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object'), created_at TEXT NOT NULL,
      UNIQUE(aggregate_kind,campaign_id,aggregate_id,idempotency_key), UNIQUE(aggregate_kind,campaign_id,aggregate_id,resulting_revision),
      UNIQUE(command_id,aggregate_kind,campaign_id,aggregate_id,principal_id,expected_revision,resulting_revision),
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT);
    CREATE INDEX idx_adventure_coordination_commands_aggregate_v36 ON adventure_coordination_commands_v36(aggregate_kind,campaign_id,aggregate_id,resulting_revision);
    CREATE TABLE adventure_coordination_events_v36(
      event_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, aggregate_kind TEXT NOT NULL, campaign_id TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, mutation_type TEXT NOT NULL, expected_revision INTEGER NOT NULL, resulting_revision INTEGER NOT NULL,
      resulting_state TEXT NOT NULL, narration_status TEXT, event_json TEXT NOT NULL CHECK(json_valid(event_json) AND json_type(event_json)='object'), occurred_at TEXT NOT NULL,
      UNIQUE(aggregate_kind,campaign_id,aggregate_id,resulting_revision),
      FOREIGN KEY(command_id,aggregate_kind,campaign_id,aggregate_id,principal_id,expected_revision,resulting_revision)
        REFERENCES adventure_coordination_commands_v36(command_id,aggregate_kind,campaign_id,aggregate_id,principal_id,expected_revision,resulting_revision) ON DELETE RESTRICT);
    CREATE TABLE adventure_coordination_receipts_v36(
      command_id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, aggregate_kind TEXT NOT NULL, campaign_id TEXT NOT NULL, aggregate_id TEXT NOT NULL,
      expected_revision INTEGER NOT NULL, resulting_revision INTEGER NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'),
      FOREIGN KEY(command_id) REFERENCES adventure_coordination_commands_v36(command_id) ON DELETE RESTRICT,
      FOREIGN KEY(event_id) REFERENCES adventure_coordination_events_v36(event_id) ON DELETE RESTRICT);
    CREATE TABLE turn_mechanics_links_v36(
      link_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, root_turn_id TEXT NOT NULL,
      proposal_id TEXT NOT NULL, command_id TEXT NOT NULL, source_turn_id TEXT NOT NULL, linked_at TEXT NOT NULL,
      UNIQUE(campaign_id,turn_id,proposal_id), UNIQUE(campaign_id,command_id),
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,root_turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,command_id) REFERENCES command_receipts(campaign_id,command_id) ON DELETE RESTRICT);
    CREATE INDEX idx_turn_mechanics_links_turn_v36 ON turn_mechanics_links_v36(campaign_id,root_turn_id,linked_at,link_id);
    CREATE TABLE generation_draft_apply_receipts_v36(
      receipt_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, draft_id TEXT NOT NULL UNIQUE, review_decision_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, expected_draft_revision INTEGER NOT NULL, resulting_draft_revision INTEGER NOT NULL,
      result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object'), applied_at TEXT NOT NULL,
      FOREIGN KEY(campaign_id,draft_id) REFERENCES generation_drafts(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(review_decision_id) REFERENCES review_decisions(decision_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT);
    CREATE TABLE adventure_hardening_layout_attestation_v36(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      v35_layout_digest TEXT NOT NULL CHECK(length(v35_layout_digest)=64), layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64));

    CREATE TRIGGER adventure_coordination_commands_validate_v36 BEFORE INSERT ON adventure_coordination_commands_v36 WHEN
      EXISTS(SELECT 1 FROM adventure_coordination_commands_v36 old WHERE old.command_id=NEW.command_id OR
        (old.aggregate_kind=NEW.aggregate_kind AND old.campaign_id=NEW.campaign_id AND old.aggregate_id=NEW.aggregate_id AND old.idempotency_key=NEW.idempotency_key)) OR
      (NEW.mutation_type<>'migration-snapshot' AND ((NOT EXISTS(SELECT 1 FROM adventure_coordination_events_v36 prior WHERE prior.aggregate_kind=NEW.aggregate_kind AND prior.campaign_id=NEW.campaign_id AND prior.aggregate_id=NEW.aggregate_id) AND NEW.expected_revision<>-1)
        OR (EXISTS(SELECT 1 FROM adventure_coordination_events_v36 prior WHERE prior.aggregate_kind=NEW.aggregate_kind AND prior.campaign_id=NEW.campaign_id AND prior.aggregate_id=NEW.aggregate_id) AND NEW.expected_revision<>(SELECT max(resulting_revision) FROM adventure_coordination_events_v36 prior WHERE prior.aggregate_kind=NEW.aggregate_kind AND prior.campaign_id=NEW.campaign_id AND prior.aggregate_id=NEW.aggregate_id))
        OR NEW.resulting_revision<>NEW.expected_revision+1))
      BEGIN SELECT RAISE(ABORT,'invalid adventure coordination command'); END;
    CREATE TRIGGER adventure_coordination_events_validate_v36 BEFORE INSERT ON adventure_coordination_events_v36 WHEN
      EXISTS(SELECT 1 FROM adventure_coordination_events_v36 old WHERE old.event_id=NEW.event_id OR old.command_id=NEW.command_id OR
        (old.aggregate_kind=NEW.aggregate_kind AND old.campaign_id=NEW.campaign_id AND old.aggregate_id=NEW.aggregate_id AND old.resulting_revision=NEW.resulting_revision))
      BEGIN SELECT RAISE(ABORT,'invalid adventure coordination event'); END;
    CREATE TRIGGER adventure_coordination_receipts_validate_v36 BEFORE INSERT ON adventure_coordination_receipts_v36 WHEN
      EXISTS(SELECT 1 FROM adventure_coordination_receipts_v36 old WHERE old.command_id=NEW.command_id OR old.event_id=NEW.event_id) OR
      NOT EXISTS(SELECT 1 FROM adventure_coordination_events_v36 event WHERE event.event_id=NEW.event_id AND event.command_id=NEW.command_id
        AND event.aggregate_kind=NEW.aggregate_kind AND event.campaign_id=NEW.campaign_id AND event.aggregate_id=NEW.aggregate_id
        AND event.expected_revision=NEW.expected_revision AND event.resulting_revision=NEW.resulting_revision)
      BEGIN SELECT RAISE(ABORT,'invalid adventure coordination receipt'); END;
    CREATE TRIGGER turn_mechanics_links_validate_v36 BEFORE INSERT ON turn_mechanics_links_v36 WHEN
      EXISTS(SELECT 1 FROM turn_mechanics_links_v36 old WHERE old.link_id=NEW.link_id OR (old.campaign_id=NEW.campaign_id AND (old.command_id=NEW.command_id OR (old.turn_id=NEW.turn_id AND old.proposal_id=NEW.proposal_id)))) OR
      NEW.turn_id<>NEW.root_turn_id OR NEW.source_turn_id<>NEW.root_turn_id OR
      NOT EXISTS(SELECT 1 FROM tool_proposals proposal LEFT JOIN confirmation_decisions decision ON decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id
        WHERE proposal.campaign_id=NEW.campaign_id AND proposal.turn_id=NEW.turn_id AND proposal.proposal_id=NEW.proposal_id AND (proposal.requires_confirmation=0 OR decision.decision='approved'))
      BEGIN SELECT RAISE(ABORT,'invalid mechanics receipt provenance'); END;
    CREATE TRIGGER generation_draft_apply_receipts_validate_v36 BEFORE INSERT ON generation_draft_apply_receipts_v36 WHEN
      EXISTS(SELECT 1 FROM generation_draft_apply_receipts_v36 old WHERE old.receipt_id=NEW.receipt_id OR (old.campaign_id=NEW.campaign_id AND old.draft_id=NEW.draft_id)) OR
      NEW.resulting_draft_revision<>NEW.expected_draft_revision+1 OR NOT EXISTS(SELECT 1 FROM review_decisions review
        JOIN generation_drafts draft ON draft.campaign_id=review.campaign_id AND draft.id=review.draft_id
        WHERE review.decision_id=NEW.review_decision_id AND review.campaign_id=NEW.campaign_id AND review.draft_id=NEW.draft_id
          AND review.decision='approved' AND draft.state IN ('approved','applied'))
      BEGIN SELECT RAISE(ABORT,'invalid draft apply receipt provenance'); END;
    CREATE TRIGGER provider_call_metadata_bound_v36 BEFORE INSERT ON provider_call_metadata WHEN
      (SELECT count(*) FROM provider_call_metadata old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)>=64
      BEGIN SELECT RAISE(ABORT,'provider call metadata limit exceeded'); END;
    CREATE TRIGGER final_receipt_links_provenance_v36 BEFORE INSERT ON final_receipt_links WHEN NEW.turn_id IS NOT NULL AND
      NOT EXISTS(SELECT 1 FROM turn_mechanics_links_v36 sidecar WHERE sidecar.link_id=NEW.link_id AND sidecar.campaign_id=NEW.campaign_id
        AND sidecar.turn_id=NEW.turn_id AND sidecar.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'final receipt link requires v36 provenance'); END;
  `);
  for (const table of IMMUTABLE) db.exec(`CREATE TRIGGER ${table}_insert_v36 BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} old WHERE old.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'${table} records are immutable'); END;
    CREATE TRIGGER ${table}_update_v36 BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} records are immutable'); END;
    CREATE TRIGGER ${table}_delete_v36 BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} records are immutable'); END;`);
  db.exec(`CREATE TRIGGER adventure_hardening_attestation_insert_v36 BEFORE INSERT ON adventure_hardening_layout_attestation_v36 WHEN EXISTS(SELECT 1 FROM adventure_hardening_layout_attestation_v36) BEGIN SELECT RAISE(ABORT,'v36 attestation is sealed'); END;
    CREATE TRIGGER adventure_hardening_attestation_update_v36 BEFORE UPDATE ON adventure_hardening_layout_attestation_v36 BEGIN SELECT RAISE(ABORT,'v36 attestation is immutable'); END;
    CREATE TRIGGER adventure_hardening_attestation_delete_v36 BEFORE DELETE ON adventure_hardening_layout_attestation_v36 BEGIN SELECT RAISE(ABORT,'v36 attestation is immutable'); END;`);
  assertInventory(db);
  db.prepare("INSERT INTO adventure_hardening_layout_attestation_v36 VALUES(1,?,?)").run(V35_ADVENTURE_GENERATION_CANONICAL_DIGEST, layoutDigest(db));

  // Prove and preserve every v35 mechanics link rather than trusting its formerly broad command-receipt FK.
  for (const turn of db.prepare("SELECT * FROM adventure_turns WHERE mode='original' ORDER BY campaign_id,created_at,id").all() as any[]) {
    const proposals = db.prepare(`SELECT proposal.proposal_id FROM tool_proposals proposal LEFT JOIN confirmation_decisions decision
      ON decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id
      WHERE proposal.campaign_id=? AND proposal.turn_id=? AND (proposal.requires_confirmation=0 OR decision.decision='approved') ORDER BY proposal.position`)
      .all(turn.campaign_id, turn.id) as Array<{ proposal_id: string }>;
    const links = db.prepare("SELECT * FROM final_receipt_links WHERE campaign_id=? AND turn_id=? ORDER BY linked_at,link_id").all(turn.campaign_id, turn.id) as any[];
    if (links.length > proposals.length) throw new Error(`schema v35 turn has receipts without approved proposals (${turn.id})`);
    links.forEach((link, index) => db.prepare(`INSERT INTO turn_mechanics_links_v36(link_id,campaign_id,turn_id,root_turn_id,proposal_id,command_id,source_turn_id,linked_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(link.link_id, turn.campaign_id, turn.id, turn.id, proposals[index]!.proposal_id, link.command_id, turn.id, link.linked_at));
  }
  // Legacy applied drafts are upgraded to a draft-specific receipt tied to their exact approved review.
  for (const draft of db.prepare("SELECT * FROM generation_drafts WHERE state='applied' ORDER BY campaign_id,created_at,id").all() as any[]) {
    const review = db.prepare("SELECT * FROM review_decisions WHERE campaign_id=? AND draft_id=? AND decision='approved'").get(draft.campaign_id, draft.id) as any;
    const links = db.prepare("SELECT * FROM final_receipt_links WHERE campaign_id=? AND draft_id=? ORDER BY linked_at,link_id").all(draft.campaign_id, draft.id) as any[];
    if (!review || links.length !== 1) throw new Error(`schema v35 applied draft provenance is incomplete (${draft.id})`);
    const receiptId = `v36-${createHash("sha256").update(`draft-apply:${draft.campaign_id}:${draft.id}`).digest("hex").slice(0, 40)}`;
    db.prepare(`INSERT INTO generation_draft_apply_receipts_v36(receipt_id,campaign_id,draft_id,review_decision_id,principal_id,
      expected_draft_revision,resulting_draft_revision,result_json,applied_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(receiptId, draft.campaign_id,
        draft.id, review.decision_id, review.principal_id, draft.revision - 1, draft.revision,
        canonical({ legacyCommandId: links[0]!.command_id }), links[0]!.linked_at);
  }

  // Existing v35 aggregates receive one explicit immutable root snapshot; no historical v35 row is rewritten.
  for (const kind of ["turn", "draft"] as const) {
    const source = kind === "turn" ? "adventure_turns" : "generation_drafts";
    const rows = db.prepare(`SELECT id,campaign_id,principal_id,state,revision,campaign_revision,updated_at FROM ${source}`).all() as any[];
    for (const row of rows) {
      const commandId = `v36-${createHash("sha256").update(`${kind}:${row.campaign_id}:${row.id}`).digest("hex").slice(0, 40)}`;
      const eventId = `${commandId}-event`; const snapshot = canonical({ legacyV35: true, state: row.state, revision: row.revision });
      db.prepare(`INSERT INTO adventure_coordination_commands_v36 VALUES(?,?,?,?,?,'migration-snapshot',?,-1,?,?,?,?)`)
        .run(commandId, kind, row.campaign_id, row.id, row.principal_id, commandId, row.campaign_revision, row.revision, snapshot, row.updated_at);
      db.prepare(`INSERT INTO adventure_coordination_events_v36 VALUES(?,?,?,?,?,?,'migration-snapshot',-1,?,?,?,?,?)`)
        .run(eventId, commandId, kind, row.campaign_id, row.id, row.principal_id, row.revision, row.state, kind === "turn" ? "none" : null, snapshot, row.updated_at);
      db.prepare("INSERT INTO adventure_coordination_receipts_v36 VALUES(?,?,?,?,?,?,?,?)")
        .run(commandId, eventId, kind, row.campaign_id, row.id, -1, row.revision, snapshot);
    }
  }
}

/** Validates canonical JSON, ledger continuity, lifecycle state, and mechanics/apply provenance at startup. */
export function validateAdventureHardeningDataV36(db: DatabaseDriver.Database): void {
  const malformedJson = (db.prepare(`SELECT command_id,request_json FROM adventure_coordination_commands_v36
    UNION ALL SELECT event_id,event_json FROM adventure_coordination_events_v36
    UNION ALL SELECT command_id,result_json FROM adventure_coordination_receipts_v36`).all() as Array<{ command_id: string; request_json: string }>).find((row) => {
      try { return canonical(JSON.parse(row.request_json)) !== row.request_json; } catch { return true; }
    });
  if (malformedJson) throw new Error(`schema v36 coordination JSON is not canonical (${malformedJson.command_id})`);
  const mutationSchemas: Record<string, { parse(value: unknown): unknown }> = {
    "turn-create": createAdventureTurnInputSchema, "proposal-append": appendToolProposalInputSchema,
    "confirmation-wait": turnMutationInputSchema, "confirmation-decision": decideToolProposalInputSchema,
    "provider-start": providerCallStartInputSchema, "provider-outcome": providerCallOutcomeInputSchema,
    "mechanics-link": linkTurnReceiptInputSchema, "mechanics-reconcile": turnMutationInputSchema,
    "narration-update": updateTurnNarrationInputSchema, "draft-create": createGenerationDraftInputSchema,
    "draft-review": reviewGenerationDraftInputSchema, "draft-apply": applyGenerationDraftInputSchema,
  };
  const malformedRequest = (db.prepare("SELECT command_id,mutation_type,request_json FROM adventure_coordination_commands_v36 WHERE mutation_type<>'migration-snapshot'").all() as any[])
    .find((row) => { try { const schema = mutationSchemas[row.mutation_type]; if (!schema) return true; schema.parse(JSON.parse(row.request_json)); return false; } catch { return true; } });
  if (malformedRequest) throw new Error(`schema v36 coordination request is malformed (${malformedRequest.command_id})`);
  const malformedDraft = (db.prepare("SELECT id,staged_content_json,validation_json FROM generation_drafts").all() as any[]).find((row) => {
    try { stagedGenerationContentSchema.parse(JSON.parse(row.staged_content_json)); generationDraftValidationSchema.parse(JSON.parse(row.validation_json)); return false; } catch { return true; }
  });
  if (malformedDraft) throw new Error(`schema v36 generation draft JSON is malformed (${malformedDraft.id})`);
  const malformedProposal = (db.prepare("SELECT * FROM tool_proposals").all() as any[]).find((row) => {
    try { toolProposalSchema.pick({ argumentsJson: true }).parse({ argumentsJson: row.arguments_json }); return false; } catch { return true; }
  });
  if (malformedProposal) throw new Error(`schema v36 tool proposal JSON is malformed (${malformedProposal.proposal_id})`);
  const badLedger = db.prepare(`SELECT command.command_id FROM adventure_coordination_commands_v36 command
    LEFT JOIN adventure_coordination_events_v36 event ON event.command_id=command.command_id
    LEFT JOIN adventure_coordination_receipts_v36 receipt ON receipt.command_id=command.command_id AND receipt.event_id=event.event_id
    WHERE event.event_id IS NULL OR receipt.command_id IS NULL OR event.expected_revision<>command.expected_revision OR event.resulting_revision<>command.resulting_revision
      OR receipt.expected_revision<>command.expected_revision OR receipt.resulting_revision<>command.resulting_revision LIMIT 1`).get() as { command_id: string } | undefined;
  if (badLedger) throw new Error(`schema v36 coordination ledger is incomplete (${badLedger.command_id})`);
  const badSequence = db.prepare(`SELECT current.command_id FROM adventure_coordination_commands_v36 current WHERE current.mutation_type<>'migration-snapshot' AND
    current.expected_revision<>COALESCE((SELECT max(prior.resulting_revision) FROM adventure_coordination_events_v36 prior WHERE prior.aggregate_kind=current.aggregate_kind
      AND prior.campaign_id=current.campaign_id AND prior.aggregate_id=current.aggregate_id AND prior.resulting_revision<current.resulting_revision),-1) LIMIT 1`).get() as { command_id: string } | undefined;
  if (badSequence) throw new Error(`schema v36 coordination ledger is not contiguous (${badSequence.command_id})`);
  const badProvider = db.prepare(`SELECT turn_id FROM provider_call_metadata GROUP BY campaign_id,turn_id HAVING count(*)>64
    UNION ALL SELECT terminal.turn_id FROM provider_call_metadata terminal WHERE terminal.phase<>'started' AND NOT EXISTS(SELECT 1 FROM provider_call_metadata start
      WHERE start.campaign_id=terminal.campaign_id AND start.turn_id=terminal.turn_id AND start.call_id=terminal.call_id AND start.phase='started'
        AND start.provider=terminal.provider AND start.model=terminal.model AND start.attempt=terminal.attempt) LIMIT 1`).get() as { turn_id: string } | undefined;
  if (badProvider) throw new Error(`schema v36 provider call ancestry is malformed (${badProvider.turn_id})`);
  const badLink = db.prepare(`SELECT link_id FROM turn_mechanics_links_v36 link WHERE link.source_turn_id<>link.root_turn_id OR link.turn_id<>link.root_turn_id OR
    NOT EXISTS(SELECT 1 FROM tool_proposals proposal LEFT JOIN confirmation_decisions decision ON decision.campaign_id=proposal.campaign_id
      AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id WHERE proposal.campaign_id=link.campaign_id
      AND proposal.turn_id=link.turn_id AND proposal.proposal_id=link.proposal_id AND (proposal.requires_confirmation=0 OR decision.decision='approved')) OR
    NOT EXISTS(SELECT 1 FROM campaign_commands command JOIN command_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
      JOIN adventure_turns turn ON turn.campaign_id=link.campaign_id AND turn.id=link.turn_id WHERE command.campaign_id=link.campaign_id AND command.command_id=link.command_id
        AND command.timeline_id=turn.timeline_id AND command.actor_id=turn.actor_id AND command.source_turn_id=link.source_turn_id) LIMIT 1`).get() as { link_id: string } | undefined;
  if (badLink) throw new Error(`schema v36 mechanics link ancestry is malformed (${badLink.link_id})`);
  const badTurnState = db.prepare(`SELECT turn.id FROM adventure_turns turn JOIN adventure_coordination_events_v36 latest
    ON latest.aggregate_kind='turn' AND latest.campaign_id=turn.campaign_id AND latest.aggregate_id=turn.id
      AND latest.resulting_revision=(SELECT max(event.resulting_revision) FROM adventure_coordination_events_v36 event WHERE event.aggregate_kind='turn'
        AND event.campaign_id=turn.campaign_id AND event.aggregate_id=turn.id)
    WHERE (latest.resulting_state='awaiting-confirmation' AND NOT EXISTS(SELECT 1 FROM tool_proposals proposal WHERE proposal.campaign_id=turn.campaign_id
        AND proposal.turn_id=turn.id AND proposal.requires_confirmation=1 AND NOT EXISTS(SELECT 1 FROM confirmation_decisions decision
          WHERE decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id)))
      OR (latest.resulting_state='confirmed' AND (EXISTS(SELECT 1 FROM tool_proposals proposal WHERE proposal.campaign_id=turn.campaign_id
          AND proposal.turn_id=turn.id AND proposal.requires_confirmation=1 AND NOT EXISTS(SELECT 1 FROM confirmation_decisions decision
            WHERE decision.campaign_id=proposal.campaign_id AND decision.turn_id=proposal.turn_id AND decision.proposal_id=proposal.proposal_id))
        OR EXISTS(SELECT 1 FROM turn_mechanics_links_v36 link WHERE link.campaign_id=turn.campaign_id AND link.turn_id=turn.id)))
      OR (latest.resulting_state IN ('mechanics-committed','narrating','completed') AND NOT EXISTS(SELECT 1 FROM turn_mechanics_links_v36 link
        WHERE link.campaign_id=turn.campaign_id AND link.root_turn_id IN (WITH RECURSIVE ancestry(id,mode,prior_turn_id) AS
          (SELECT turn.id,turn.mode,turn.prior_turn_id UNION ALL SELECT parent.id,parent.mode,parent.prior_turn_id FROM adventure_turns parent
            JOIN ancestry child ON parent.campaign_id=turn.campaign_id AND parent.id=child.prior_turn_id)
          SELECT id FROM ancestry WHERE mode='original'))) LIMIT 1`).get() as { id: string } | undefined;
  if (badTurnState) throw new Error(`schema v36 turn lifecycle is malformed (${badTurnState.id})`);
  const badDraftState = db.prepare(`SELECT draft.id FROM generation_drafts draft JOIN adventure_coordination_events_v36 latest
    ON latest.aggregate_kind='draft' AND latest.campaign_id=draft.campaign_id AND latest.aggregate_id=draft.id
      AND latest.resulting_revision=(SELECT max(event.resulting_revision) FROM adventure_coordination_events_v36 event WHERE event.aggregate_kind='draft'
        AND event.campaign_id=draft.campaign_id AND event.aggregate_id=draft.id)
    LEFT JOIN review_decisions review ON review.campaign_id=draft.campaign_id AND review.draft_id=draft.id
    LEFT JOIN generation_draft_apply_receipts_v36 apply ON apply.campaign_id=draft.campaign_id AND apply.draft_id=draft.id
    WHERE (latest.resulting_state='staged' AND (review.decision_id IS NOT NULL OR apply.receipt_id IS NOT NULL))
      OR (latest.resulting_state='approved' AND (review.decision<>'approved' OR apply.receipt_id IS NOT NULL))
      OR (latest.resulting_state='rejected' AND (review.decision<>'rejected' OR apply.receipt_id IS NOT NULL))
      OR (latest.resulting_state='applied' AND (review.decision<>'approved' OR apply.receipt_id IS NULL OR apply.review_decision_id<>review.decision_id)) LIMIT 1`).get() as { id: string } | undefined;
  if (badDraftState) throw new Error(`schema v36 draft lifecycle is malformed (${badDraftState.id})`);
  // Receipt JSON written by v36 must remain a valid shared projection; migration snapshots are intentionally marked.
  const badResult = (db.prepare(`SELECT command.aggregate_kind,command.mutation_type,receipt.command_id,receipt.result_json,event.resulting_state,event.narration_status
    FROM adventure_coordination_receipts_v36 receipt JOIN adventure_coordination_commands_v36 command ON command.command_id=receipt.command_id
    JOIN adventure_coordination_events_v36 event ON event.command_id=command.command_id WHERE command.mutation_type<>'migration-snapshot'`).all() as any[]).find((row) => {
      try { const result = (row.aggregate_kind === "turn" ? privateAdventureTurnSchema : privateGenerationDraftSchema).parse(JSON.parse(row.result_json)) as any;
        return result.state !== row.resulting_state || (row.aggregate_kind === "turn" && result.narrationStatus !== row.narration_status); } catch { return true; }
    });
  if (badResult) throw new Error(`schema v36 coordination result is malformed (${badResult.command_id})`);
}

/** Attests fixed v35/v36 layouts and validates all coordination data. */
export function assertAdventureHardeningV36(db: DatabaseDriver.Database): void {
  assertAdventureGenerationV35(db);
  assertAdventureHardeningLayoutV36(db);
  validateAdventureHardeningDataV36(db);
}

/** Validates only canonical v35/v36 SQL, allowing exact empty future shells to be inventoried before old migrations. */
export function assertAdventureHardeningLayoutV36(db: DatabaseDriver.Database): void {
  assertAdventureGenerationLayoutV35Canonical(db);
  assertInventory(db); const actual = layoutDigest(db);
  const row = db.prepare("SELECT v35_layout_digest,layout_digest FROM adventure_hardening_layout_attestation_v36 WHERE singleton=1").get() as any;
  if (!row || row.v35_layout_digest !== V35_ADVENTURE_GENERATION_CANONICAL_DIGEST || row.layout_digest !== actual
      || (V36_ADVENTURE_HARDENING_CANONICAL_DIGEST && actual !== V36_ADVENTURE_HARDENING_CANONICAL_DIGEST)) throw new Error("schema v36 canonical adventure hardening layout is incompatible");
}

/** Validates the exact compiled v35 SQL without consulting mutable data or downstream layouts. */
export function assertAdventureGenerationLayoutV35Canonical(db: DatabaseDriver.Database): void {
  const v35 = db.prepare("SELECT layout_digest FROM adventure_generation_layout_attestation_v35 WHERE singleton=1").get() as { layout_digest: string } | undefined;
  const v35Actual = createHash("sha256").update(JSON.stringify(db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE name IN
    (${ADVENTURE_GENERATION_V35_MANAGED_OBJECTS.map(() => "?").join(",")}) AND sql IS NOT NULL ORDER BY type,name`)
    .all(...ADVENTURE_GENERATION_V35_MANAGED_OBJECTS.map(([, name]) => name)))).digest("hex");
  if (v35?.layout_digest !== V35_ADVENTURE_GENERATION_CANONICAL_DIGEST || v35Actual !== V35_ADVENTURE_GENERATION_CANONICAL_DIGEST)
    throw new Error("schema v35 canonical adventure/generation layout is incompatible");
}

/** Migrates v35 to additive v36 without changing any applied v35 table. */
export function migrate35to36(db: DatabaseDriver.Database): void {
  db.transaction(() => { assertAdventureGenerationV35(db); createAdventureHardeningV36(db); db.prepare("UPDATE meta SET value='36' WHERE key='schemaVersion'").run(); })();
}
