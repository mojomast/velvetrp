import { createHash } from "node:crypto";
import DatabaseDriver from "better-sqlite3";
import { assertStoryDomainV34 } from "./v34_story_domain.js";

const TABLES = [
  "adventure_turns", "tool_proposals", "confirmation_decisions", "provider_call_metadata",
  "generation_drafts", "review_decisions", "final_receipt_links", "adventure_generation_layout_attestation_v35",
] as const;
const INDEXES = [
  "uq_campaign_sessions_campaign_session_v35", "idx_adventure_turns_session_v35", "idx_adventure_turns_campaign_state_v35",
  "idx_tool_proposals_turn_v35", "idx_provider_calls_turn_v35", "idx_generation_drafts_campaign_v35",
  "idx_final_receipt_links_turn_v35", "idx_final_receipt_links_draft_v35",
] as const;
const IMMUTABLE_TABLES = ["tool_proposals", "confirmation_decisions", "provider_call_metadata", "review_decisions", "final_receipt_links"] as const;
const TRIGGERS = [
  "adventure_turns_conflict_insert_v35", "adventure_turns_guard_update_v35", "adventure_turns_guard_delete_v35",
  "generation_drafts_conflict_insert_v35", "generation_drafts_guard_update_v35", "generation_drafts_guard_delete_v35",
  "tool_proposals_guard_insert_v35", "confirmation_decisions_guard_insert_v35", "provider_call_metadata_guard_insert_v35",
  "review_decisions_guard_insert_v35", "final_receipt_links_guard_insert_v35",
  ...IMMUTABLE_TABLES.flatMap((table) => [`${table}_immutable_update_v35`, `${table}_immutable_delete_v35`]),
  "adventure_generation_attestation_conflict_insert_v35", "adventure_generation_attestation_immutable_update_v35",
  "adventure_generation_attestation_immutable_delete_v35",
] as const;

/** Exact SQLite objects owned by schema v35r1. */
export const ADVENTURE_GENERATION_V35_MANAGED_OBJECTS: ReadonlyArray<readonly ["table" | "index" | "trigger", string]> = [
  ...TABLES.map((name) => ["table", name] as const),
  ...INDEXES.map((name) => ["index", name] as const),
  ...TRIGGERS.map((name) => ["trigger", name] as const),
];

const digest = (db: DatabaseDriver.Database): string => createHash("sha256").update(JSON.stringify(db.prepare(
  `SELECT type,name,sql FROM sqlite_master WHERE name IN (${ADVENTURE_GENERATION_V35_MANAGED_OBJECTS.map(() => "?").join(",")})
    AND sql IS NOT NULL ORDER BY type,name`,
).all(...ADVENTURE_GENERATION_V35_MANAGED_OBJECTS.map(([, name]) => name)))).digest("hex");

function assertInventory(db: DatabaseDriver.Database): void {
  const expected = new Set(ADVENTURE_GENERATION_V35_MANAGED_OBJECTS.map(([type, name]) => `${type}:${name}`));
  const names = ADVENTURE_GENERATION_V35_MANAGED_OBJECTS.map(([, name]) => name);
  const rows = db.prepare(`SELECT type,name FROM sqlite_master WHERE name IN (${names.map(() => "?").join(",")}) AND sql IS NOT NULL`).all(...names) as Array<{ type: string; name: string }>;
  const actual = new Set(rows.map(({ type, name }) => `${type}:${name}`));
  const missing = [...expected].find((key) => !actual.has(key));
  const wrong = rows.find(({ type, name }) => !expected.has(`${type}:${name}`));
  if (missing || wrong) throw new Error(`schema v35 adventure/generation object inventory is incompatible (${wrong?.name ?? missing})`);
  const unknown = db.prepare("SELECT name FROM sqlite_master WHERE name GLOB '*v35*' AND sql IS NOT NULL").all() as Array<{ name: string }>;
  const unknownRow = unknown.find(({ name }) => !names.includes(name as never));
  if (unknownRow) throw new Error(`schema v35 adventure/generation object inventory is incompatible (${unknownRow.name})`);
}

/** Creates the additive M1.10 coordination schema without rebuilding existing tables. */
export function createAdventureGenerationV35(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE UNIQUE INDEX uq_campaign_sessions_campaign_session_v35 ON campaign_sessions(campaign_id,session_id);
    CREATE TABLE adventure_turns (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      timeline_id TEXT NOT NULL CHECK(length(timeline_id) BETWEEN 1 AND 128 AND timeline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 128 AND session_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128 AND actor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 128 AND principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      declaration TEXT NOT NULL CHECK(length(trim(declaration)) BETWEEN 1 AND 8000),
      mode TEXT NOT NULL CHECK(mode IN ('original','narration-retry','narration-swipe')),
      prior_turn_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('declared','proposed','awaiting-confirmation','mechanics-committed','narrating','completed','cancelled','failed')),
      narration_status TEXT NOT NULL CHECK(narration_status IN ('none','pending','in-progress','completed','failed')),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      campaign_revision INTEGER NOT NULL CHECK(typeof(campaign_revision)='integer' AND campaign_revision BETWEEN 0 AND 9007199254740991),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND updated_at>=created_at),
      CHECK((mode='original' AND prior_turn_id IS NULL) OR (mode<>'original' AND prior_turn_id IS NOT NULL AND prior_turn_id<>id)),
      CHECK((state IN ('declared','proposed','awaiting-confirmation') AND narration_status='none') OR
        (state='mechanics-committed' AND narration_status IN ('none','pending')) OR
        (state='narrating' AND narration_status IN ('pending','in-progress','failed')) OR
        (state='completed' AND narration_status='completed') OR (state IN ('cancelled','failed'))),
      UNIQUE(campaign_id,id), UNIQUE(campaign_id,idempotency_key),
      FOREIGN KEY(campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,prior_turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_adventure_turns_session_v35 ON adventure_turns(session_id,created_at,id);
    CREATE INDEX idx_adventure_turns_campaign_state_v35 ON adventure_turns(campaign_id,state,updated_at,id);
    CREATE TABLE tool_proposals (
      proposal_id TEXT PRIMARY KEY CHECK(length(proposal_id) BETWEEN 1 AND 128 AND proposal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 31),
      tool_name TEXT NOT NULL CHECK(length(tool_name) BETWEEN 1 AND 128 AND tool_name NOT GLOB '*[^A-Za-z0-9._:-]*'),
      arguments_json TEXT NOT NULL CHECK(json_valid(arguments_json) AND json_type(arguments_json)='object' AND length(arguments_json)<=32768),
      requires_confirmation INTEGER NOT NULL CHECK(typeof(requires_confirmation)='integer' AND requires_confirmation IN (0,1)),
      confirmation_expires_at TEXT CHECK((requires_confirmation=0 AND confirmation_expires_at IS NULL) OR
        (requires_confirmation=1 AND length(confirmation_expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',confirmation_expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',confirmation_expires_at)=confirmation_expires_at)),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      proposed_at TEXT NOT NULL CHECK(length(proposed_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',proposed_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',proposed_at)=proposed_at),
      UNIQUE(campaign_id,turn_id,position), UNIQUE(campaign_id,turn_id,idempotency_key), UNIQUE(campaign_id,turn_id,proposal_id),
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_tool_proposals_turn_v35 ON tool_proposals(campaign_id,turn_id,position);
    CREATE TABLE confirmation_decisions (
      decision_id TEXT PRIMARY KEY CHECK(length(decision_id) BETWEEN 1 AND 128 AND decision_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, proposal_id TEXT NOT NULL,
      principal_id TEXT NOT NULL, decision TEXT NOT NULL CHECK(decision IN ('approved','rejected','expired')),
      expected_turn_revision INTEGER NOT NULL CHECK(typeof(expected_turn_revision)='integer' AND expected_turn_revision BETWEEN 0 AND 9007199254740990),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      expires_at TEXT NOT NULL CHECK(length(expires_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',expires_at)=expires_at),
      decided_at TEXT NOT NULL CHECK(length(decided_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',decided_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',decided_at)=decided_at),
      CHECK((decision='expired' AND decided_at>=expires_at) OR (decision<>'expired' AND decided_at<expires_at)),
      UNIQUE(campaign_id,turn_id,proposal_id), UNIQUE(campaign_id,turn_id,idempotency_key),
      FOREIGN KEY(campaign_id,turn_id,proposal_id) REFERENCES tool_proposals(campaign_id,turn_id,proposal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );
    CREATE TABLE provider_call_metadata (
      record_id TEXT PRIMARY KEY CHECK(length(record_id) BETWEEN 1 AND 128 AND record_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, turn_id TEXT NOT NULL, call_id TEXT NOT NULL CHECK(length(call_id) BETWEEN 1 AND 128 AND call_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      phase TEXT NOT NULL CHECK(phase IN ('started','succeeded','failed','cancelled')), provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 128),
      model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 256), attempt INTEGER NOT NULL CHECK(typeof(attempt)='integer' AND attempt BETWEEN 1 AND 32),
      prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR (typeof(prompt_tokens)='integer' AND prompt_tokens BETWEEN 0 AND 1000000000)),
      completion_tokens INTEGER CHECK(completion_tokens IS NULL OR (typeof(completion_tokens)='integer' AND completion_tokens BETWEEN 0 AND 1000000000)),
      outcome_code TEXT CHECK(outcome_code IS NULL OR length(outcome_code) BETWEEN 1 AND 128),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      recorded_at TEXT NOT NULL CHECK(length(recorded_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at),
      CHECK((phase='started' AND prompt_tokens IS NULL AND completion_tokens IS NULL AND outcome_code IS NULL) OR
        (phase<>'started' AND outcome_code IS NOT NULL)),
      UNIQUE(campaign_id,turn_id,call_id,phase), UNIQUE(campaign_id,turn_id,idempotency_key),
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_provider_calls_turn_v35 ON provider_call_metadata(campaign_id,turn_id,call_id,recorded_at);
    CREATE TABLE generation_drafts (
      id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9._:-]*'), campaign_id TEXT NOT NULL,
      timeline_id TEXT NOT NULL, session_id TEXT, principal_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('encounter','location','npc','faction','quest','storyline','content-pack')),
      staged_content_json TEXT NOT NULL CHECK(json_valid(staged_content_json) AND json_type(staged_content_json)='object' AND length(staged_content_json)<=1048576),
      validation_json TEXT NOT NULL CHECK(json_valid(validation_json) AND json_type(validation_json)='object' AND length(validation_json)<=262144),
      state TEXT NOT NULL CHECK(state IN ('staged','in-review','approved','rejected','applied','cancelled')),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      campaign_revision INTEGER NOT NULL CHECK(typeof(campaign_revision)='integer' AND campaign_revision BETWEEN 0 AND 9007199254740991),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND updated_at>=created_at),
      UNIQUE(campaign_id,id), UNIQUE(campaign_id,idempotency_key),
      FOREIGN KEY(campaign_id,timeline_id) REFERENCES campaign_timelines(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_generation_drafts_campaign_v35 ON generation_drafts(campaign_id,state,updated_at,id);
    CREATE TABLE review_decisions (
      decision_id TEXT PRIMARY KEY CHECK(length(decision_id) BETWEEN 1 AND 128 AND decision_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, draft_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')), notes TEXT CHECK(notes IS NULL OR length(notes)<=4000),
      expected_draft_revision INTEGER NOT NULL CHECK(typeof(expected_draft_revision)='integer' AND expected_draft_revision BETWEEN 0 AND 9007199254740990),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      decided_at TEXT NOT NULL CHECK(length(decided_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',decided_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',decided_at)=decided_at),
      UNIQUE(campaign_id,draft_id), UNIQUE(campaign_id,draft_id,idempotency_key),
      FOREIGN KEY(campaign_id,draft_id) REFERENCES generation_drafts(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );
    CREATE TABLE final_receipt_links (
      link_id TEXT PRIMARY KEY CHECK(length(link_id) BETWEEN 1 AND 128 AND link_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL, turn_id TEXT, draft_id TEXT, command_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      linked_at TEXT NOT NULL CHECK(length(linked_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',linked_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',linked_at)=linked_at),
      CHECK((turn_id IS NULL)<>(draft_id IS NULL)), UNIQUE(campaign_id,command_id),
      UNIQUE(campaign_id,turn_id,idempotency_key), UNIQUE(campaign_id,draft_id,idempotency_key),
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,draft_id) REFERENCES generation_drafts(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,command_id) REFERENCES command_receipts(campaign_id,command_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_final_receipt_links_turn_v35 ON final_receipt_links(campaign_id,turn_id,linked_at);
    CREATE INDEX idx_final_receipt_links_draft_v35 ON final_receipt_links(campaign_id,draft_id,linked_at);
    CREATE TABLE adventure_generation_layout_attestation_v35(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64 AND layout_digest NOT GLOB '*[^0-9a-f]*'));

    CREATE TRIGGER adventure_turns_conflict_insert_v35 BEFORE INSERT ON adventure_turns WHEN EXISTS(SELECT 1 FROM adventure_turns old
      WHERE old.id=NEW.id OR (old.campaign_id=NEW.campaign_id AND old.idempotency_key=NEW.idempotency_key)) OR
      NOT EXISTS(SELECT 1 FROM campaigns campaign WHERE campaign.id=NEW.campaign_id AND campaign.active_timeline_id=NEW.timeline_id) OR
      NOT EXISTS(SELECT 1 FROM campaign_sessions attached WHERE attached.campaign_id=NEW.campaign_id AND attached.session_id=NEW.session_id) OR
      NOT EXISTS(SELECT 1 FROM campaign_actors actor WHERE actor.campaign_id=NEW.campaign_id AND actor.id=NEW.actor_id) OR
      NOT EXISTS(SELECT 1 FROM campaign_memberships member WHERE member.campaign_id=NEW.campaign_id AND member.principal_id=NEW.principal_id) OR
      (NEW.prior_turn_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM adventure_turns prior WHERE prior.campaign_id=NEW.campaign_id AND prior.id=NEW.prior_turn_id
        AND prior.timeline_id=NEW.timeline_id AND prior.session_id=NEW.session_id AND prior.actor_id=NEW.actor_id))
      BEGIN SELECT RAISE(ABORT,'adventure turn identity or ancestry is invalid'); END;
    CREATE TRIGGER adventure_turns_guard_update_v35 BEFORE UPDATE ON adventure_turns WHEN NEW.id<>OLD.id OR NEW.campaign_id<>OLD.campaign_id OR
      NEW.timeline_id<>OLD.timeline_id OR NEW.session_id<>OLD.session_id OR NEW.actor_id<>OLD.actor_id OR NEW.principal_id<>OLD.principal_id OR
      NEW.declaration<>OLD.declaration OR NEW.mode<>OLD.mode OR NEW.prior_turn_id IS NOT OLD.prior_turn_id OR NEW.idempotency_key<>OLD.idempotency_key OR
      NEW.created_at<>OLD.created_at OR NEW.campaign_revision<>OLD.campaign_revision OR NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR NOT (
        (OLD.state='declared' AND NEW.state IN ('proposed','awaiting-confirmation','mechanics-committed','narrating','cancelled','failed')) OR
        (OLD.state='proposed' AND NEW.state IN ('proposed','awaiting-confirmation','mechanics-committed','cancelled','failed')) OR
        (OLD.state='awaiting-confirmation' AND NEW.state IN ('mechanics-committed','cancelled','failed')) OR
        (OLD.state='mechanics-committed' AND NEW.state IN ('mechanics-committed','narrating','completed','cancelled','failed')) OR
        (OLD.state='narrating' AND NEW.state IN ('narrating','completed','cancelled','failed'))) BEGIN SELECT RAISE(ABORT,'invalid adventure turn transition'); END;
    CREATE TRIGGER adventure_turns_guard_delete_v35 BEFORE DELETE ON adventure_turns BEGIN SELECT RAISE(ABORT,'adventure turns cannot be deleted'); END;
    CREATE TRIGGER generation_drafts_conflict_insert_v35 BEFORE INSERT ON generation_drafts WHEN EXISTS(SELECT 1 FROM generation_drafts old
      WHERE old.id=NEW.id OR (old.campaign_id=NEW.campaign_id AND old.idempotency_key=NEW.idempotency_key)) OR
      NOT EXISTS(SELECT 1 FROM campaigns campaign WHERE campaign.id=NEW.campaign_id AND campaign.active_timeline_id=NEW.timeline_id) OR
      NOT EXISTS(SELECT 1 FROM campaign_memberships member WHERE member.campaign_id=NEW.campaign_id AND member.principal_id=NEW.principal_id) OR
      (NEW.session_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM campaign_sessions attached WHERE attached.campaign_id=NEW.campaign_id AND attached.session_id=NEW.session_id))
      BEGIN SELECT RAISE(ABORT,'generation draft identity or ancestry is invalid'); END;
    CREATE TRIGGER generation_drafts_guard_update_v35 BEFORE UPDATE ON generation_drafts WHEN NEW.id<>OLD.id OR NEW.campaign_id<>OLD.campaign_id OR
      NEW.timeline_id<>OLD.timeline_id OR NEW.session_id IS NOT OLD.session_id OR NEW.principal_id<>OLD.principal_id OR NEW.kind<>OLD.kind OR
      NEW.idempotency_key<>OLD.idempotency_key OR NEW.created_at<>OLD.created_at OR NEW.campaign_revision<>OLD.campaign_revision OR
      NEW.revision<>OLD.revision+1 OR NEW.updated_at<OLD.updated_at OR NOT ((OLD.state='staged' AND NEW.state IN ('staged','in-review','cancelled')) OR
      (OLD.state='in-review' AND NEW.state IN ('in-review','approved','rejected','cancelled')) OR (OLD.state='approved' AND NEW.state IN ('approved','applied','cancelled')))
      BEGIN SELECT RAISE(ABORT,'invalid generation draft transition'); END;
    CREATE TRIGGER generation_drafts_guard_delete_v35 BEFORE DELETE ON generation_drafts BEGIN SELECT RAISE(ABORT,'generation drafts cannot be deleted'); END;
    CREATE TRIGGER tool_proposals_guard_insert_v35 BEFORE INSERT ON tool_proposals WHEN EXISTS(SELECT 1 FROM tool_proposals old WHERE old.proposal_id=NEW.proposal_id OR
      (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.position=NEW.position OR old.idempotency_key=NEW.idempotency_key))) OR
      NOT EXISTS(SELECT 1 FROM adventure_turns turn WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND turn.state IN ('declared','proposed')) OR
      (NEW.requires_confirmation=1 AND NEW.confirmation_expires_at<=NEW.proposed_at) OR
      (SELECT count(*) FROM tool_proposals old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id)>=32
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate tool proposal'); END;
    CREATE TRIGGER confirmation_decisions_guard_insert_v35 BEFORE INSERT ON confirmation_decisions WHEN EXISTS(SELECT 1 FROM confirmation_decisions old WHERE old.decision_id=NEW.decision_id OR
      (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.proposal_id=NEW.proposal_id OR old.idempotency_key=NEW.idempotency_key))) OR
      NOT EXISTS(SELECT 1 FROM adventure_turns turn JOIN tool_proposals proposal ON proposal.campaign_id=turn.campaign_id AND proposal.turn_id=turn.id
        WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id AND proposal.proposal_id=NEW.proposal_id AND proposal.requires_confirmation=1
          AND proposal.confirmation_expires_at=NEW.expires_at AND turn.state='awaiting-confirmation' AND turn.revision=NEW.expected_turn_revision)
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate confirmation decision'); END;
    CREATE TRIGGER provider_call_metadata_guard_insert_v35 BEFORE INSERT ON provider_call_metadata WHEN EXISTS(SELECT 1 FROM provider_call_metadata old WHERE old.record_id=NEW.record_id OR
      (old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND (old.idempotency_key=NEW.idempotency_key OR (old.call_id=NEW.call_id AND old.phase=NEW.phase)))) OR
      (NEW.phase='started' AND EXISTS(SELECT 1 FROM provider_call_metadata old WHERE old.campaign_id=NEW.campaign_id AND old.turn_id=NEW.turn_id AND old.call_id=NEW.call_id)) OR
      (NEW.phase<>'started' AND NOT EXISTS(SELECT 1 FROM provider_call_metadata start WHERE start.campaign_id=NEW.campaign_id AND start.turn_id=NEW.turn_id AND start.call_id=NEW.call_id AND start.phase='started' AND start.provider=NEW.provider AND start.model=NEW.model AND start.attempt=NEW.attempt AND start.recorded_at<=NEW.recorded_at))
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate provider call metadata'); END;
    CREATE TRIGGER review_decisions_guard_insert_v35 BEFORE INSERT ON review_decisions WHEN EXISTS(SELECT 1 FROM review_decisions old WHERE old.decision_id=NEW.decision_id OR
      (old.campaign_id=NEW.campaign_id AND old.draft_id=NEW.draft_id)) OR NOT EXISTS(SELECT 1 FROM generation_drafts draft WHERE draft.campaign_id=NEW.campaign_id
        AND draft.id=NEW.draft_id AND draft.state='in-review' AND draft.revision=NEW.expected_draft_revision) OR NOT EXISTS(SELECT 1 FROM campaign_memberships member
        WHERE member.campaign_id=NEW.campaign_id AND member.principal_id=NEW.principal_id AND member.role IN ('owner','gm'))
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate review decision'); END;
    CREATE TRIGGER final_receipt_links_guard_insert_v35 BEFORE INSERT ON final_receipt_links WHEN EXISTS(SELECT 1 FROM final_receipt_links old WHERE old.link_id=NEW.link_id OR
      (old.campaign_id=NEW.campaign_id AND (old.command_id=NEW.command_id OR (old.turn_id IS NEW.turn_id AND old.draft_id IS NEW.draft_id AND old.idempotency_key=NEW.idempotency_key)))) OR
      (NEW.turn_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM adventure_turns turn WHERE turn.campaign_id=NEW.campaign_id AND turn.id=NEW.turn_id
        AND (turn.state IN ('mechanics-committed','narrating','completed') OR (turn.state='proposed' AND NOT EXISTS(
          SELECT 1 FROM tool_proposals proposal WHERE proposal.campaign_id=turn.campaign_id AND proposal.turn_id=turn.id AND proposal.requires_confirmation=1))))) OR
      (NEW.draft_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM generation_drafts draft WHERE draft.campaign_id=NEW.campaign_id AND draft.id=NEW.draft_id AND draft.state IN ('approved','applied')))
      BEGIN SELECT RAISE(ABORT,'invalid or duplicate final receipt link'); END;
  `);
  for (const table of IMMUTABLE_TABLES) db.exec(`CREATE TRIGGER ${table}_immutable_update_v35 BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} records are immutable'); END;
    CREATE TRIGGER ${table}_immutable_delete_v35 BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'${table} records are immutable'); END;`);
  db.exec(`CREATE TRIGGER adventure_generation_attestation_conflict_insert_v35 BEFORE INSERT ON adventure_generation_layout_attestation_v35
      WHEN EXISTS(SELECT 1 FROM adventure_generation_layout_attestation_v35) BEGIN SELECT RAISE(ABORT,'adventure/generation attestation identity is sealed'); END;
    CREATE TRIGGER adventure_generation_attestation_immutable_update_v35 BEFORE UPDATE ON adventure_generation_layout_attestation_v35 BEGIN SELECT RAISE(ABORT,'adventure/generation attestation is immutable'); END;
    CREATE TRIGGER adventure_generation_attestation_immutable_delete_v35 BEFORE DELETE ON adventure_generation_layout_attestation_v35 BEGIN SELECT RAISE(ABORT,'adventure/generation attestation is immutable'); END;`);
  assertInventory(db);
  db.prepare("INSERT INTO adventure_generation_layout_attestation_v35 VALUES(1,?)").run(digest(db));
}

/** Validates all persisted M1.10 ancestry and state invariants at startup. */
export function validateAdventureGenerationDataV35(db: DatabaseDriver.Database): void {
  const fk = (db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>).find(({ table }) => TABLES.includes(table as never));
  if (fk) throw new Error(`schema v35 adventure/generation data has a foreign-key violation (${fk.table})`);
  const badTurn = db.prepare(`SELECT turn.id FROM adventure_turns turn JOIN campaigns campaign ON campaign.id=turn.campaign_id
    LEFT JOIN sessions session ON session.id=turn.session_id
    LEFT JOIN campaign_timelines timeline ON timeline.campaign_id=turn.campaign_id AND timeline.id=turn.timeline_id
    LEFT JOIN campaign_actors actor ON actor.campaign_id=turn.campaign_id AND actor.id=turn.actor_id
    WHERE session.id IS NULL OR timeline.id IS NULL OR actor.id IS NULL
      OR (turn.mode<>'original' AND NOT EXISTS(SELECT 1 FROM adventure_turns prior WHERE prior.campaign_id=turn.campaign_id AND prior.id=turn.prior_turn_id
        AND prior.timeline_id=turn.timeline_id AND prior.session_id=turn.session_id AND prior.actor_id=turn.actor_id)) LIMIT 1`).get() as { id: string } | undefined;
  if (badTurn) throw new Error(`schema v35 adventure/generation data has malformed turn ancestry (${badTurn.id})`);
  const badDraft = db.prepare(`SELECT draft.id FROM generation_drafts draft LEFT JOIN campaigns campaign ON campaign.id=draft.campaign_id
    LEFT JOIN campaign_timelines timeline ON timeline.campaign_id=draft.campaign_id AND timeline.id=draft.timeline_id
    LEFT JOIN sessions session ON session.id=draft.session_id LEFT JOIN campaign_memberships member
      ON member.campaign_id=draft.campaign_id AND member.principal_id=draft.principal_id
    WHERE campaign.id IS NULL OR timeline.id IS NULL OR member.principal_id IS NULL OR (draft.session_id IS NOT NULL AND session.id IS NULL) LIMIT 1`)
    .get() as { id: string } | undefined;
  if (badDraft) throw new Error(`schema v35 adventure/generation data has malformed draft ancestry (${badDraft.id})`);
  const badDecision = db.prepare(`SELECT decision.decision_id FROM confirmation_decisions decision JOIN tool_proposals proposal
    ON proposal.campaign_id=decision.campaign_id AND proposal.turn_id=decision.turn_id AND proposal.proposal_id=decision.proposal_id
    WHERE proposal.requires_confirmation<>1 OR proposal.confirmation_expires_at<>decision.expires_at LIMIT 1`).get() as { decision_id: string } | undefined;
  if (badDecision) throw new Error(`schema v35 adventure/generation data has malformed confirmation ancestry (${badDecision.decision_id})`);
  const badProvider = db.prepare(`SELECT terminal.record_id FROM provider_call_metadata terminal WHERE terminal.phase<>'started' AND NOT EXISTS(
    SELECT 1 FROM provider_call_metadata start WHERE start.campaign_id=terminal.campaign_id AND start.turn_id=terminal.turn_id AND start.call_id=terminal.call_id
      AND start.phase='started' AND start.provider=terminal.provider AND start.model=terminal.model AND start.attempt=terminal.attempt AND start.recorded_at<=terminal.recorded_at) LIMIT 1`).get() as { record_id: string } | undefined;
  if (badProvider) throw new Error(`schema v35 adventure/generation data has malformed provider-call ancestry (${badProvider.record_id})`);
}

/** Attests the exact v35r1 layout and validates all existing rows. */
export function assertAdventureGenerationV35(db: DatabaseDriver.Database): void {
  assertInventory(db);
  const row = db.prepare("SELECT layout_digest FROM adventure_generation_layout_attestation_v35 WHERE singleton=1").get() as { layout_digest: string } | undefined;
  if (!row || row.layout_digest !== digest(db)) throw new Error("schema v35 adventure/generation domain is incompatible");
  validateAdventureGenerationDataV35(db);
}

/** Migrates a valid v34 database to additive schema v35r1. */
export function migrate34to35(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    assertStoryDomainV34(db);
    createAdventureGenerationV35(db);
    db.prepare("UPDATE meta SET value='35' WHERE key='schemaVersion'").run();
  })();
}
