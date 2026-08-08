import { createHash } from "node:crypto";
import DatabaseDriver from "better-sqlite3";
import { assertQuestDomainV33 } from "./v33_quest_domain.js";

const STORY_V34_TABLES = ["story_campaign_revisions_v34", "story_commands_v34", "story_receipts_v34", "story_events_v34",
  "story_metadata_v34", "story_nodes_v34", "story_node_state_v34", "story_edges_v34", "story_plot_points_v34",
  "story_plot_point_answers_v34", "story_clues_v34", "story_clue_sources_v34", "story_discoveries_v34", "story_layout_attestation_v34"] as const;
const STORY_V34_TRIGGERS = [
  "story_campaign_revisions_v34_conflict_insert", "story_campaign_revisions_v34_guard_update", "story_campaign_revisions_v34_guard_delete",
  "story_commands_v34_conflict_insert", "story_commands_v34_authorize_payload", "story_commands_v34_immutable_update", "story_commands_v34_immutable_delete",
  "story_receipts_v34_conflict_insert", "story_receipts_v34_validate_payload", "story_receipts_v34_immutable_update", "story_receipts_v34_immutable_delete",
  "story_events_v34_conflict_insert", "story_events_v34_validate_payload", "story_events_v34_immutable_update", "story_events_v34_immutable_delete",
  "story_discoveries_v34_immutable_update", "story_discoveries_v34_immutable_delete", "story_root_v34_command_backed_insert",
  "story_root_v34_metadata_update", "story_root_v34_metadata_delete", "story_metadata_v34_guard_insert", "story_nodes_v34_guard_insert",
  "story_edges_v34_guard_insert", "story_edges_v34_reject_cycle", "story_plot_points_v34_guard_insert", "story_clues_v34_guard_insert",
  "story_clue_sources_v34_validate_target", "story_clue_sources_v34_guard_insert", "story_node_state_v34_guard_insert",
  "story_node_state_v34_guard_update", "story_node_state_v34_guard_delete", "story_plot_point_answers_v34_guard_insert",
  "story_plot_point_answers_v34_immutable_update", "story_plot_point_answers_v34_immutable_delete", "story_discoveries_v34_guard_insert",
  "story_metadata_v34_immutable_update", "story_metadata_v34_immutable_delete", "story_nodes_v34_immutable_update", "story_nodes_v34_immutable_delete",
  "story_edges_v34_immutable_update", "story_edges_v34_immutable_delete", "story_plot_points_v34_immutable_update", "story_plot_points_v34_immutable_delete",
  "story_clues_v34_immutable_update", "story_clues_v34_immutable_delete", "story_clue_sources_v34_immutable_update",
  "story_clue_sources_v34_immutable_delete", "story_layout_attestation_v34_conflict_insert",
  "story_layout_attestation_v34_immutable_update", "story_layout_attestation_v34_immutable_delete",
] as const;
export const STORY_V34_MANAGED_OBJECTS: ReadonlyArray<readonly ["table" | "index" | "trigger", string]> = [
  ...STORY_V34_TABLES.map((name) => ["table", name] as const), ["index", "uq_storyline_campaign_id_v34"],
  ...STORY_V34_TRIGGERS.map((name) => ["trigger", name] as const),
];

const digest = (db: DatabaseDriver.Database) => createHash("sha256").update(JSON.stringify(db.prepare(
  "SELECT type,name,sql FROM sqlite_master WHERE name GLOB '*v34*' AND sql IS NOT NULL ORDER BY type,name",
).all())).digest("hex");

function assertStoryObjectInventory(db: DatabaseDriver.Database): void {
  const actual = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v34*' AND sql IS NOT NULL ORDER BY type,name").all() as Array<{ type: string; name: string }>;
  const expected = new Set(STORY_V34_MANAGED_OBJECTS.map(([type, name]) => `${type}:${name}`));
  const actualKeys = new Set(actual.map(({ type, name }) => `${type}:${name}`));
  const unknown = actual.find(({ type, name }) => !expected.has(`${type}:${name}`));
  const missing = STORY_V34_MANAGED_OBJECTS.find(([type, name]) => !actualKeys.has(`${type}:${name}`));
  if (unknown || missing) throw new Error(`schema v34 story object inventory is incompatible (${unknown?.name ?? missing?.[1]})`);
}

function assertLegacyStoryAncestry(db: DatabaseDriver.Database): void {
  const row = db.prepare(`SELECT storyline.id FROM quest_storylines storyline LEFT JOIN campaigns campaign
    ON campaign.id=storyline.campaign_id WHERE campaign.id IS NULL LIMIT 1`).get() as { id: string } | undefined;
  if (row) throw new Error(`schema v34 story migration rejected malformed storyline ancestry (${row.id})`);
}

/** Additive graph model rooted in quest_storylines. Existing roots intentionally have empty graphs. */
export function createStoryDomainV34(db: DatabaseDriver.Database): void {
  assertLegacyStoryAncestry(db);
  db.exec(`
    CREATE UNIQUE INDEX uq_storyline_campaign_id_v34 ON quest_storylines(campaign_id,id);
    CREATE TABLE story_campaign_revisions_v34 (campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT
      CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at));
    CREATE TABLE story_commands_v34 (campaign_id TEXT NOT NULL,command_id TEXT NOT NULL,storyline_id TEXT NOT NULL,principal_id TEXT NOT NULL,
      command_type TEXT NOT NULL CHECK(command_type IN ('create-storyline','reveal-node','resolve-node','reveal-clue','answer-plot-point')),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991 AND resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(principal_id) BETWEEN 1 AND 128 AND principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,command_id),UNIQUE(campaign_id,idempotency_key),UNIQUE(campaign_id,resulting_revision),UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id) REFERENCES story_campaign_revisions_v34(campaign_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,storyline_id) REFERENCES quest_storylines(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT);
    CREATE TABLE story_receipts_v34 (campaign_id TEXT NOT NULL,command_id TEXT NOT NULL,resulting_revision INTEGER NOT NULL,
      canonical_result_json TEXT NOT NULL CHECK(json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
      CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),
      CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,command_id),UNIQUE(campaign_id,resulting_revision),UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES story_commands_v34(campaign_id,command_id,resulting_revision) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE story_events_v34 (event_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,command_id TEXT NOT NULL,resulting_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('storyline-created','node-revealed','node-resolved','clue-revealed','plot-point-answered')),
      event_json TEXT NOT NULL CHECK(json_valid(event_json) AND json_type(event_json)='object'),
      occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
      CHECK(typeof(resulting_revision)='integer' AND resulting_revision BETWEEN 1 AND 9007199254740991),UNIQUE(campaign_id,command_id),
      CHECK(length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES story_receipts_v34(campaign_id,command_id,resulting_revision) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE story_metadata_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      summary TEXT CHECK(summary IS NULL OR length(summary)<=4000),status TEXT NOT NULL CHECK(status IN ('active','completed','abandoned')),
      created_command_id TEXT NOT NULL CHECK(length(created_command_id) BETWEEN 1 AND 128 AND created_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),PRIMARY KEY(campaign_id,storyline_id),
      FOREIGN KEY(campaign_id,storyline_id) REFERENCES quest_storylines(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE story_nodes_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 128 AND node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200 AND title=trim(title)),description TEXT CHECK(description IS NULL OR length(description)<=4000),
      gm_notes TEXT CHECK(gm_notes IS NULL OR length(gm_notes)<=4000),
      reveal_threshold INTEGER NOT NULL CHECK(typeof(reveal_threshold)='integer' AND reveal_threshold BETWEEN 0 AND 1000),
      sort_order INTEGER NOT NULL CHECK(typeof(sort_order)='integer' AND sort_order BETWEEN 0 AND 999),
      created_command_id TEXT NOT NULL CHECK(length(created_command_id) BETWEEN 1 AND 128 AND created_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,storyline_id,node_id),UNIQUE(campaign_id,node_id),FOREIGN KEY(campaign_id,storyline_id) REFERENCES story_metadata_v34(campaign_id,storyline_id),
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE story_node_state_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 128 AND node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),status TEXT NOT NULL CHECK(status IN ('hidden','revealed','resolved')),
      last_command_id TEXT NOT NULL CHECK(length(last_command_id) BETWEEN 1 AND 128 AND last_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),PRIMARY KEY(campaign_id,storyline_id,node_id),
      FOREIGN KEY(campaign_id,storyline_id,node_id) REFERENCES story_nodes_v34(campaign_id,storyline_id,node_id),
      FOREIGN KEY(campaign_id,last_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE story_edges_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      edge_id TEXT NOT NULL CHECK(length(edge_id) BETWEEN 1 AND 128 AND edge_id NOT GLOB '*[^A-Za-z0-9._:-]*'),kind TEXT NOT NULL CHECK(kind IN ('sequence','requires')),
      from_node_id TEXT NOT NULL CHECK(length(from_node_id) BETWEEN 1 AND 128 AND from_node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      to_node_id TEXT NOT NULL CHECK(length(to_node_id) BETWEEN 1 AND 128 AND to_node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      created_command_id TEXT NOT NULL CHECK(length(created_command_id) BETWEEN 1 AND 128 AND created_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(from_node_id<>to_node_id),PRIMARY KEY(campaign_id,storyline_id,edge_id),UNIQUE(campaign_id,edge_id),
      UNIQUE(campaign_id,storyline_id,kind,from_node_id,to_node_id),
      FOREIGN KEY(campaign_id,storyline_id,from_node_id) REFERENCES story_nodes_v34(campaign_id,storyline_id,node_id),
      FOREIGN KEY(campaign_id,storyline_id,to_node_id) REFERENCES story_nodes_v34(campaign_id,storyline_id,node_id),
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE story_plot_points_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      plot_point_id TEXT NOT NULL CHECK(length(plot_point_id) BETWEEN 1 AND 128 AND plot_point_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      node_id TEXT NOT NULL CHECK(length(node_id) BETWEEN 1 AND 128 AND node_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      question TEXT NOT NULL CHECK(length(question)<=4000),answer TEXT NOT NULL CHECK(length(answer)<=4000),gm_notes TEXT CHECK(gm_notes IS NULL OR length(gm_notes)<=4000),
      created_command_id TEXT NOT NULL CHECK(length(created_command_id) BETWEEN 1 AND 128 AND created_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,storyline_id,plot_point_id),UNIQUE(campaign_id,plot_point_id),FOREIGN KEY(campaign_id,storyline_id,node_id) REFERENCES story_nodes_v34(campaign_id,storyline_id,node_id),
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE story_plot_point_answers_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      plot_point_id TEXT NOT NULL CHECK(length(plot_point_id) BETWEEN 1 AND 128 AND plot_point_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      player_answer TEXT NOT NULL CHECK(length(player_answer)<=4000 AND length(trim(player_answer))>0),
      command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      answered_at TEXT NOT NULL CHECK(length(answered_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',answered_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',answered_at)=answered_at),
      PRIMARY KEY(campaign_id,storyline_id,plot_point_id),FOREIGN KEY(campaign_id,storyline_id,plot_point_id) REFERENCES story_plot_points_v34(campaign_id,storyline_id,plot_point_id),
      FOREIGN KEY(campaign_id,command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE story_clues_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      clue_id TEXT NOT NULL CHECK(length(clue_id) BETWEEN 1 AND 128 AND clue_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200 AND title=trim(title)),content TEXT NOT NULL CHECK(length(content)<=4000),
      truth TEXT NOT NULL CHECK(length(truth)<=4000),gm_notes TEXT CHECK(gm_notes IS NULL OR length(gm_notes)<=4000),
      reveal_threshold INTEGER NOT NULL CHECK(typeof(reveal_threshold)='integer' AND reveal_threshold BETWEEN 1 AND 1000),
      created_command_id TEXT NOT NULL CHECK(length(created_command_id) BETWEEN 1 AND 128 AND created_command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,storyline_id,clue_id),UNIQUE(campaign_id,clue_id),FOREIGN KEY(campaign_id,storyline_id) REFERENCES story_metadata_v34(campaign_id,storyline_id),
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE story_clue_sources_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      clue_id TEXT NOT NULL CHECK(length(clue_id) BETWEEN 1 AND 128 AND clue_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128 AND source_id NOT GLOB '*[^A-Za-z0-9._:-]*'),source_kind TEXT NOT NULL CHECK(source_kind IN ('node','plot-point')),
      target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 128 AND target_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,storyline_id,clue_id,source_id),UNIQUE(campaign_id,storyline_id,clue_id,source_kind,target_id),
      FOREIGN KEY(campaign_id,storyline_id,clue_id) REFERENCES story_clues_v34(campaign_id,storyline_id,clue_id));
    CREATE TABLE story_discoveries_v34 (campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      storyline_id TEXT NOT NULL CHECK(length(storyline_id) BETWEEN 1 AND 128 AND storyline_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      clue_id TEXT NOT NULL CHECK(length(clue_id) BETWEEN 1 AND 128 AND clue_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      command_id TEXT NOT NULL CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      discovered_at TEXT NOT NULL CHECK(length(discovered_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',discovered_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',discovered_at)=discovered_at),
      PRIMARY KEY(campaign_id,storyline_id,clue_id),FOREIGN KEY(campaign_id,storyline_id,clue_id) REFERENCES story_clues_v34(campaign_id,storyline_id,clue_id),
      FOREIGN KEY(campaign_id,command_id) REFERENCES story_commands_v34(campaign_id,command_id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE story_layout_attestation_v34 (singleton INTEGER PRIMARY KEY CHECK(singleton=1),layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64 AND layout_digest NOT GLOB '*[^0-9a-f]*'));
    CREATE TRIGGER story_campaign_revisions_v34_conflict_insert BEFORE INSERT ON story_campaign_revisions_v34
      WHEN EXISTS(SELECT 1 FROM story_campaign_revisions_v34 old WHERE old.campaign_id=NEW.campaign_id)
      BEGIN SELECT RAISE(ABORT,'story revision identity is sealed'); END;
    CREATE TRIGGER story_campaign_revisions_v34_guard_update BEFORE UPDATE ON story_campaign_revisions_v34
      WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'story revision must advance exactly once'); END;
    CREATE TRIGGER story_campaign_revisions_v34_guard_delete BEFORE DELETE ON story_campaign_revisions_v34 BEGIN SELECT RAISE(ABORT,'story revisions cannot be deleted'); END;
    CREATE TRIGGER story_commands_v34_conflict_insert BEFORE INSERT ON story_commands_v34
      WHEN EXISTS(SELECT 1 FROM story_commands_v34 old WHERE old.campaign_id=NEW.campaign_id AND
        (old.command_id=NEW.command_id OR old.idempotency_key=NEW.idempotency_key OR old.resulting_revision=NEW.resulting_revision))
      BEGIN SELECT RAISE(ABORT,'story command identity is sealed'); END;
    CREATE TRIGGER story_commands_v34_authorize_payload BEFORE INSERT ON story_commands_v34
      WHEN NOT EXISTS(SELECT 1 FROM campaign_memberships membership WHERE membership.campaign_id=NEW.campaign_id
          AND membership.principal_id=NEW.principal_id AND membership.role IN ('owner','gm'))
        OR (NEW.command_type='create-storyline' AND (SELECT count(*) FROM json_each(NEW.canonical_request_json))<>4)
        OR (NEW.command_type<>'create-storyline' AND (SELECT count(*) FROM json_each(NEW.canonical_request_json))<>6)
        OR json_extract(NEW.canonical_request_json,'$.expectedRevision') IS NOT NEW.expected_revision
        OR json_extract(NEW.canonical_request_json,'$.idempotencyKey') IS NOT NEW.idempotency_key
        OR (NEW.command_type='create-storyline' AND (json_extract(NEW.canonical_request_json,'$.campaignId') IS NOT NEW.campaign_id
          OR json_extract(NEW.canonical_request_json,'$.storyline.storylineId') IS NOT NEW.storyline_id
          OR json_type(NEW.canonical_request_json,'$.storyline')<>'object'
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.storyline'))<>7
          OR typeof(json_extract(NEW.canonical_request_json,'$.storyline.title'))<>'text'
          OR length(json_extract(NEW.canonical_request_json,'$.storyline.title')) NOT BETWEEN 1 AND 200
          OR json_extract(NEW.canonical_request_json,'$.storyline.title')<>trim(json_extract(NEW.canonical_request_json,'$.storyline.title'))
          OR json_type(NEW.canonical_request_json,'$.storyline.summary') IS NULL OR json_type(NEW.canonical_request_json,'$.storyline.summary') NOT IN ('null','text')
          OR length(COALESCE(json_extract(NEW.canonical_request_json,'$.storyline.summary'),''))>4000
          OR json_type(NEW.canonical_request_json,'$.storyline.nodes')<>'array'
          OR json_type(NEW.canonical_request_json,'$.storyline.edges')<>'array'
          OR json_type(NEW.canonical_request_json,'$.storyline.plotPoints')<>'array'
          OR json_type(NEW.canonical_request_json,'$.storyline.clues')<>'array'
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.storyline.nodes'))>1000
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.storyline.edges'))>10000
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.storyline.plotPoints'))>10000
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.storyline.clues'))>10000
          OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json,'$.storyline.nodes') item WHERE json_type(item.value)<>'object'
            OR (SELECT count(*) FROM json_each(item.value))<>5 OR typeof(json_extract(item.value,'$.nodeId'))<>'text'
            OR typeof(json_extract(item.value,'$.title'))<>'text' OR length(json_extract(item.value,'$.title')) NOT BETWEEN 1 AND 200
            OR json_type(item.value,'$.description') IS NULL OR json_type(item.value,'$.description') NOT IN ('null','text')
            OR json_type(item.value,'$.gmNotes') IS NULL OR json_type(item.value,'$.gmNotes') NOT IN ('null','text')
            OR length(COALESCE(json_extract(item.value,'$.description'),''))>4000 OR length(COALESCE(json_extract(item.value,'$.gmNotes'),''))>4000
            OR typeof(json_extract(item.value,'$.revealThreshold'))<>'integer' OR json_extract(item.value,'$.revealThreshold') NOT BETWEEN 0 AND 1000)
          OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json,'$.storyline.edges') item WHERE json_type(item.value)<>'object'
            OR (SELECT count(*) FROM json_each(item.value))<>4 OR typeof(json_extract(item.value,'$.edgeId'))<>'text'
            OR json_extract(item.value,'$.kind') NOT IN ('sequence','requires') OR typeof(json_extract(item.value,'$.fromNodeId'))<>'text' OR typeof(json_extract(item.value,'$.toNodeId'))<>'text')
          OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json,'$.storyline.plotPoints') item WHERE json_type(item.value)<>'object'
            OR (SELECT count(*) FROM json_each(item.value))<>5 OR typeof(json_extract(item.value,'$.plotPointId'))<>'text' OR typeof(json_extract(item.value,'$.nodeId'))<>'text'
            OR typeof(json_extract(item.value,'$.question'))<>'text' OR length(json_extract(item.value,'$.question'))>4000
            OR typeof(json_extract(item.value,'$.answer'))<>'text' OR length(json_extract(item.value,'$.answer'))>4000
            OR json_type(item.value,'$.gmNotes') IS NULL OR json_type(item.value,'$.gmNotes') NOT IN ('null','text')
            OR length(COALESCE(json_extract(item.value,'$.gmNotes'),''))>4000)
          OR EXISTS(SELECT 1 FROM json_each(NEW.canonical_request_json,'$.storyline.clues') item WHERE json_type(item.value)<>'object'
            OR (SELECT count(*) FROM json_each(item.value))<>7 OR typeof(json_extract(item.value,'$.clueId'))<>'text'
            OR typeof(json_extract(item.value,'$.title'))<>'text' OR length(json_extract(item.value,'$.title')) NOT BETWEEN 1 AND 200
            OR typeof(json_extract(item.value,'$.content'))<>'text' OR length(json_extract(item.value,'$.content'))>4000
            OR typeof(json_extract(item.value,'$.truth'))<>'text' OR length(json_extract(item.value,'$.truth'))>4000
            OR json_type(item.value,'$.gmNotes') IS NULL OR json_type(item.value,'$.gmNotes') NOT IN ('null','text')
            OR length(COALESCE(json_extract(item.value,'$.gmNotes'),''))>4000 OR typeof(json_extract(item.value,'$.revealThreshold'))<>'integer'
            OR json_extract(item.value,'$.revealThreshold') NOT BETWEEN 1 AND 1000 OR json_type(item.value,'$.sources')<>'array'
            OR json_extract(item.value,'$.revealThreshold')>(SELECT count(*) FROM json_each(item.value,'$.sources'))
            OR EXISTS(SELECT 1 FROM json_each(item.value,'$.sources') source WHERE json_type(source.value)<>'object'
              OR (SELECT count(*) FROM json_each(source.value))<>3 OR typeof(json_extract(source.value,'$.sourceId'))<>'text'
              OR json_extract(source.value,'$.kind') NOT IN ('node','plot-point') OR typeof(json_extract(source.value,'$.targetId'))<>'text'))))
        OR (NEW.command_type<>'create-storyline' AND (json_extract(NEW.canonical_request_json,'$.storylineId') IS NOT NEW.storyline_id
          OR json_extract(NEW.canonical_request_json,'$.kind') IS NOT NEW.command_type
          OR typeof(json_extract(NEW.canonical_request_json,'$.targetId'))<>'text'
          OR length(json_extract(NEW.canonical_request_json,'$.targetId')) NOT BETWEEN 1 AND 128
          OR json_extract(NEW.canonical_request_json,'$.targetId') GLOB '*[^A-Za-z0-9._:-]*'))
        OR (NEW.command_type IN ('reveal-node','resolve-node','reveal-clue') AND
          (json_type(NEW.canonical_request_json,'$.data')<>'object' OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.data'))<>0))
        OR (NEW.command_type='answer-plot-point' AND (json_type(NEW.canonical_request_json,'$.data')<>'object'
          OR (SELECT count(*) FROM json_each(NEW.canonical_request_json,'$.data'))<>1
          OR typeof(json_extract(NEW.canonical_request_json,'$.data.answer'))<>'text'
          OR length(json_extract(NEW.canonical_request_json,'$.data.answer'))>4000 OR length(trim(json_extract(NEW.canonical_request_json,'$.data.answer')))=0))
        OR (NEW.command_type IN ('reveal-node','resolve-node') AND NOT EXISTS(SELECT 1 FROM story_nodes_v34 node WHERE node.campaign_id=NEW.campaign_id AND node.storyline_id=NEW.storyline_id AND node.node_id=json_extract(NEW.canonical_request_json,'$.targetId')))
        OR (NEW.command_type='reveal-clue' AND NOT EXISTS(SELECT 1 FROM story_clues_v34 clue WHERE clue.campaign_id=NEW.campaign_id AND clue.storyline_id=NEW.storyline_id AND clue.clue_id=json_extract(NEW.canonical_request_json,'$.targetId')))
        OR (NEW.command_type='answer-plot-point' AND NOT EXISTS(SELECT 1 FROM story_plot_points_v34 point WHERE point.campaign_id=NEW.campaign_id AND point.storyline_id=NEW.storyline_id AND point.plot_point_id=json_extract(NEW.canonical_request_json,'$.targetId')))
      BEGIN SELECT RAISE(ABORT,'story command authorization or payload is invalid'); END;
    CREATE TRIGGER story_commands_v34_immutable_update BEFORE UPDATE ON story_commands_v34 BEGIN SELECT RAISE(ABORT,'story commands are immutable'); END;
    CREATE TRIGGER story_commands_v34_immutable_delete BEFORE DELETE ON story_commands_v34 BEGIN SELECT RAISE(ABORT,'story commands are immutable'); END;
    CREATE TRIGGER story_receipts_v34_conflict_insert BEFORE INSERT ON story_receipts_v34
      WHEN EXISTS(SELECT 1 FROM story_receipts_v34 old WHERE old.campaign_id=NEW.campaign_id AND (old.command_id=NEW.command_id OR old.resulting_revision=NEW.resulting_revision))
      BEGIN SELECT RAISE(ABORT,'story receipt identity is sealed'); END;
    CREATE TRIGGER story_receipts_v34_validate_payload BEFORE INSERT ON story_receipts_v34
      WHEN (SELECT count(*) FROM json_each(NEW.canonical_result_json))<>4 OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.command_id=NEW.command_id
        AND command.resulting_revision=NEW.resulting_revision AND command.created_at=NEW.occurred_at
        AND json_extract(NEW.canonical_result_json,'$.campaignId')=NEW.campaign_id
        AND json_extract(NEW.canonical_result_json,'$.receipt.commandId')=NEW.command_id
        AND json_extract(NEW.canonical_result_json,'$.receipt.idempotencyKey')=command.idempotency_key
        AND json_extract(NEW.canonical_result_json,'$.receipt.revisionBefore')=command.expected_revision
        AND json_extract(NEW.canonical_result_json,'$.receipt.revisionAfter')=command.resulting_revision
        AND json_extract(NEW.canonical_result_json,'$.receipt.occurredAt')=NEW.occurred_at
        AND (command.command_type<>'create-storyline' OR (
          (SELECT count(*) FROM story_metadata_v34 metadata WHERE metadata.campaign_id=command.campaign_id AND metadata.storyline_id=command.storyline_id)=1
          AND (SELECT count(*) FROM story_nodes_v34 node WHERE node.campaign_id=command.campaign_id AND node.storyline_id=command.storyline_id)
            =(SELECT count(*) FROM json_each(command.canonical_request_json,'$.storyline.nodes'))
          AND (SELECT count(*) FROM story_edges_v34 edge WHERE edge.campaign_id=command.campaign_id AND edge.storyline_id=command.storyline_id)
            =(SELECT count(*) FROM json_each(command.canonical_request_json,'$.storyline.edges'))
          AND (SELECT count(*) FROM story_plot_points_v34 point WHERE point.campaign_id=command.campaign_id AND point.storyline_id=command.storyline_id)
            =(SELECT count(*) FROM json_each(command.canonical_request_json,'$.storyline.plotPoints'))
          AND (SELECT count(*) FROM story_clues_v34 clue WHERE clue.campaign_id=command.campaign_id AND clue.storyline_id=command.storyline_id)
            =(SELECT count(*) FROM json_each(command.canonical_request_json,'$.storyline.clues'))
          AND (SELECT count(*) FROM story_clue_sources_v34 source WHERE source.campaign_id=command.campaign_id AND source.storyline_id=command.storyline_id)
            =(SELECT count(*) FROM json_each(command.canonical_request_json,'$.storyline.clues') clue_item JOIN json_each(clue_item.value,'$.sources'))))
      )
      BEGIN SELECT RAISE(ABORT,'story receipt payload is invalid'); END;
    CREATE TRIGGER story_receipts_v34_immutable_update BEFORE UPDATE ON story_receipts_v34 BEGIN SELECT RAISE(ABORT,'story receipts are immutable'); END;
    CREATE TRIGGER story_receipts_v34_immutable_delete BEFORE DELETE ON story_receipts_v34 BEGIN SELECT RAISE(ABORT,'story receipts are immutable'); END;
    CREATE TRIGGER story_events_v34_conflict_insert BEFORE INSERT ON story_events_v34
      WHEN EXISTS(SELECT 1 FROM story_events_v34 old WHERE old.event_id=NEW.event_id OR (old.campaign_id=NEW.campaign_id AND old.command_id=NEW.command_id))
      BEGIN SELECT RAISE(ABORT,'story event identity is sealed'); END;
    CREATE TRIGGER story_events_v34_validate_payload BEFORE INSERT ON story_events_v34
      WHEN (NEW.event_type='storyline-created' AND (SELECT count(*) FROM json_each(NEW.event_json))<>1)
        OR (NEW.event_type<>'storyline-created' AND (SELECT count(*) FROM json_each(NEW.event_json))<>3)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.command_id=NEW.command_id
        AND command.resulting_revision=NEW.resulting_revision AND command.created_at=NEW.occurred_at
        AND NEW.event_type=CASE command.command_type WHEN 'create-storyline' THEN 'storyline-created' WHEN 'reveal-node' THEN 'node-revealed'
          WHEN 'resolve-node' THEN 'node-resolved' WHEN 'reveal-clue' THEN 'clue-revealed' ELSE 'plot-point-answered' END
        AND json_extract(NEW.event_json,'$.storylineId')=command.storyline_id
        AND (command.command_type='create-storyline' OR (json_extract(NEW.event_json,'$.kind')=command.command_type
          AND json_extract(NEW.event_json,'$.targetId')=json_extract(command.canonical_request_json,'$.targetId'))))
      BEGIN SELECT RAISE(ABORT,'story event payload is invalid'); END;
    CREATE TRIGGER story_events_v34_immutable_update BEFORE UPDATE ON story_events_v34 BEGIN SELECT RAISE(ABORT,'story events are immutable'); END;
    CREATE TRIGGER story_events_v34_immutable_delete BEFORE DELETE ON story_events_v34 BEGIN SELECT RAISE(ABORT,'story events are immutable'); END;
    CREATE TRIGGER story_discoveries_v34_immutable_update BEFORE UPDATE ON story_discoveries_v34 BEGIN SELECT RAISE(ABORT,'story discoveries are immutable'); END;
    CREATE TRIGGER story_discoveries_v34_immutable_delete BEFORE DELETE ON story_discoveries_v34 BEGIN SELECT RAISE(ABORT,'story discoveries are immutable'); END;
    CREATE TRIGGER story_root_v34_command_backed_insert BEFORE INSERT ON quest_storylines
      WHEN EXISTS(SELECT 1 FROM quest_storylines old WHERE old.id=NEW.id)
        OR length(NEW.id) NOT BETWEEN 1 AND 128 OR NEW.id GLOB '*[^A-Za-z0-9._:-]*'
        OR length(NEW.campaign_id) NOT BETWEEN 1 AND 128 OR NEW.campaign_id GLOB '*[^A-Za-z0-9._:-]*'
        OR length(NEW.title) NOT BETWEEN 1 AND 200 OR NEW.title<>trim(NEW.title) OR (NEW.description IS NOT NULL AND length(NEW.description)>4000)
        OR NEW.status<>'active' OR length(NEW.created_at)<>24 OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at) IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at)<>NEW.created_at
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.id AND command.command_type='create-storyline'
          AND command.created_at=NEW.created_at AND json_extract(command.canonical_request_json,'$.storyline.title')=NEW.title
          AND json_extract(command.canonical_request_json,'$.storyline.summary') IS NEW.description)
      BEGIN SELECT RAISE(ABORT,'v34 storyline roots require a create command'); END;
    CREATE TRIGGER story_root_v34_metadata_update BEFORE UPDATE ON quest_storylines
      WHEN EXISTS(SELECT 1 FROM story_metadata_v34 metadata WHERE metadata.campaign_id=OLD.campaign_id AND metadata.storyline_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'v34 storyline roots are immutable'); END;
    CREATE TRIGGER story_root_v34_metadata_delete BEFORE DELETE ON quest_storylines
      WHEN EXISTS(SELECT 1 FROM story_metadata_v34 metadata WHERE metadata.campaign_id=OLD.campaign_id AND metadata.storyline_id=OLD.id)
      BEGIN SELECT RAISE(ABORT,'v34 storyline roots are immutable'); END;
    CREATE TRIGGER story_metadata_v34_guard_insert BEFORE INSERT ON story_metadata_v34
      WHEN EXISTS(SELECT 1 FROM story_metadata_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.storyline_id=NEW.storyline_id)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id
        AND command.command_id=NEW.created_command_id AND command.command_type='create-storyline' AND command.created_at=NEW.updated_at
        AND json_extract(command.canonical_request_json,'$.storyline.summary') IS NEW.summary AND NEW.status='active'
        AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story metadata provenance is invalid'); END;
    CREATE TRIGGER story_nodes_v34_guard_insert BEFORE INSERT ON story_nodes_v34
      WHEN EXISTS(SELECT 1 FROM story_nodes_v34 old WHERE old.campaign_id=NEW.campaign_id AND (old.node_id=NEW.node_id OR (old.storyline_id=NEW.storyline_id AND old.node_id=NEW.node_id)))
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command JOIN json_each(command.canonical_request_json,'$.storyline.nodes') item
        WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id AND command.command_id=NEW.created_command_id
          AND command.command_type='create-storyline' AND CAST(item.key AS INTEGER)=NEW.sort_order
          AND json_extract(item.value,'$.nodeId')=NEW.node_id AND json_extract(item.value,'$.title')=NEW.title
          AND json_extract(item.value,'$.description') IS NEW.description AND json_extract(item.value,'$.gmNotes') IS NEW.gm_notes
          AND json_extract(item.value,'$.revealThreshold')=NEW.reveal_threshold
          AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story node provenance is invalid'); END;
    CREATE TRIGGER story_edges_v34_guard_insert BEFORE INSERT ON story_edges_v34
      WHEN EXISTS(SELECT 1 FROM story_edges_v34 old WHERE old.campaign_id=NEW.campaign_id AND (old.edge_id=NEW.edge_id OR
        (old.storyline_id=NEW.storyline_id AND old.kind=NEW.kind AND old.from_node_id=NEW.from_node_id AND old.to_node_id=NEW.to_node_id)))
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command JOIN json_each(command.canonical_request_json,'$.storyline.edges') item
        WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id AND command.command_id=NEW.created_command_id
          AND command.command_type='create-storyline' AND json_extract(item.value,'$.edgeId')=NEW.edge_id AND json_extract(item.value,'$.kind')=NEW.kind
          AND json_extract(item.value,'$.fromNodeId')=NEW.from_node_id AND json_extract(item.value,'$.toNodeId')=NEW.to_node_id
          AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story edge provenance is invalid'); END;
    CREATE TRIGGER story_edges_v34_reject_cycle BEFORE INSERT ON story_edges_v34
      WHEN EXISTS(WITH RECURSIVE reachable(node_id) AS (
        SELECT NEW.to_node_id UNION SELECT edge.to_node_id FROM story_edges_v34 edge JOIN reachable ON edge.from_node_id=reachable.node_id
          WHERE edge.campaign_id=NEW.campaign_id AND edge.storyline_id=NEW.storyline_id)
        SELECT 1 FROM reachable WHERE node_id=NEW.from_node_id)
      BEGIN SELECT RAISE(ABORT,'story edges contain a cycle'); END;
    CREATE TRIGGER story_plot_points_v34_guard_insert BEFORE INSERT ON story_plot_points_v34
      WHEN EXISTS(SELECT 1 FROM story_plot_points_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.plot_point_id=NEW.plot_point_id)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command JOIN json_each(command.canonical_request_json,'$.storyline.plotPoints') item
        WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id AND command.command_id=NEW.created_command_id
          AND command.command_type='create-storyline' AND json_extract(item.value,'$.plotPointId')=NEW.plot_point_id
          AND json_extract(item.value,'$.nodeId')=NEW.node_id AND json_extract(item.value,'$.question')=NEW.question
          AND json_extract(item.value,'$.answer')=NEW.answer AND json_extract(item.value,'$.gmNotes') IS NEW.gm_notes
          AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story plot point provenance is invalid'); END;
    CREATE TRIGGER story_clues_v34_guard_insert BEFORE INSERT ON story_clues_v34
      WHEN EXISTS(SELECT 1 FROM story_clues_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.clue_id=NEW.clue_id)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command JOIN json_each(command.canonical_request_json,'$.storyline.clues') item
        WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id AND command.command_id=NEW.created_command_id
          AND command.command_type='create-storyline' AND json_extract(item.value,'$.clueId')=NEW.clue_id
          AND json_extract(item.value,'$.title')=NEW.title AND json_extract(item.value,'$.content')=NEW.content
          AND json_extract(item.value,'$.truth')=NEW.truth AND json_extract(item.value,'$.gmNotes') IS NEW.gm_notes
          AND json_extract(item.value,'$.revealThreshold')=NEW.reveal_threshold
          AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story clue provenance is invalid'); END;
    CREATE TRIGGER story_clue_sources_v34_validate_target BEFORE INSERT ON story_clue_sources_v34
      WHEN (NEW.source_kind='node' AND NOT EXISTS(SELECT 1 FROM story_nodes_v34 node WHERE node.campaign_id=NEW.campaign_id AND node.storyline_id=NEW.storyline_id AND node.node_id=NEW.target_id))
        OR (NEW.source_kind='plot-point' AND NOT EXISTS(SELECT 1 FROM story_plot_points_v34 point WHERE point.campaign_id=NEW.campaign_id AND point.storyline_id=NEW.storyline_id AND point.plot_point_id=NEW.target_id))
      BEGIN SELECT RAISE(ABORT,'story clue source target is invalid'); END;
    CREATE TRIGGER story_clue_sources_v34_guard_insert BEFORE INSERT ON story_clue_sources_v34
      WHEN EXISTS(SELECT 1 FROM story_clue_sources_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.storyline_id=NEW.storyline_id AND old.clue_id=NEW.clue_id
        AND (old.source_id=NEW.source_id OR (old.source_kind=NEW.source_kind AND old.target_id=NEW.target_id)))
        OR NOT EXISTS(SELECT 1 FROM story_clues_v34 clue JOIN story_commands_v34 command ON command.campaign_id=clue.campaign_id AND command.command_id=clue.created_command_id
        JOIN json_each(command.canonical_request_json,'$.storyline.clues') clue_item JOIN json_each(clue_item.value,'$.sources') source_item
        WHERE clue.campaign_id=NEW.campaign_id AND clue.storyline_id=NEW.storyline_id AND clue.clue_id=NEW.clue_id AND command.storyline_id=NEW.storyline_id
          AND json_extract(clue_item.value,'$.clueId')=NEW.clue_id AND json_extract(source_item.value,'$.sourceId')=NEW.source_id
          AND json_extract(source_item.value,'$.kind')=NEW.source_kind AND json_extract(source_item.value,'$.targetId')=NEW.target_id
          AND command.command_type='create-storyline' AND NOT EXISTS(SELECT 1 FROM story_receipts_v34 receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'story clue source provenance is invalid'); END;
    CREATE TRIGGER story_node_state_v34_guard_insert BEFORE INSERT ON story_node_state_v34
      WHEN EXISTS(SELECT 1 FROM story_node_state_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.storyline_id=NEW.storyline_id AND old.node_id=NEW.node_id)
        OR NEW.status<>'hidden' OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id
          AND command.storyline_id=NEW.storyline_id AND command.command_id=NEW.last_command_id AND command.command_type='create-storyline'
          AND command.created_at=NEW.updated_at AND EXISTS(SELECT 1 FROM json_each(command.canonical_request_json,'$.storyline.nodes') item
            WHERE json_extract(item.value,'$.nodeId')=NEW.node_id))
      BEGIN SELECT RAISE(ABORT,'story node initial state provenance is invalid'); END;
    CREATE TRIGGER story_node_state_v34_guard_update BEFORE UPDATE ON story_node_state_v34
      WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.storyline_id<>OLD.storyline_id OR NEW.node_id<>OLD.node_id
        OR NOT ((OLD.status='hidden' AND NEW.status='revealed') OR (OLD.status='revealed' AND NEW.status='resolved'))
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id
          AND command.command_id=NEW.last_command_id AND command.command_type=CASE NEW.status WHEN 'revealed' THEN 'reveal-node' ELSE 'resolve-node' END
          AND json_extract(command.canonical_request_json,'$.targetId')=NEW.node_id AND command.created_at=NEW.updated_at)
        OR (NEW.status IN ('revealed','resolved') AND EXISTS(SELECT 1 FROM story_edges_v34 edge JOIN story_node_state_v34 required
          ON required.campaign_id=edge.campaign_id AND required.storyline_id=edge.storyline_id AND required.node_id=edge.from_node_id
          WHERE edge.campaign_id=NEW.campaign_id AND edge.storyline_id=NEW.storyline_id AND edge.to_node_id=NEW.node_id
            AND edge.kind='requires' AND required.status<>'resolved'))
        OR (NEW.status='revealed' AND (SELECT count(*) FROM story_edges_v34 edge JOIN story_node_state_v34 contributor
          ON contributor.campaign_id=edge.campaign_id AND contributor.storyline_id=edge.storyline_id AND contributor.node_id=edge.from_node_id
          WHERE edge.campaign_id=NEW.campaign_id AND edge.storyline_id=NEW.storyline_id AND edge.to_node_id=NEW.node_id
            AND contributor.status='resolved') < (SELECT node.reveal_threshold FROM story_nodes_v34 node
              WHERE node.campaign_id=NEW.campaign_id AND node.storyline_id=NEW.storyline_id AND node.node_id=NEW.node_id))
      BEGIN SELECT RAISE(ABORT,'story node state transition provenance is invalid'); END;
    CREATE TRIGGER story_node_state_v34_guard_delete BEFORE DELETE ON story_node_state_v34 BEGIN SELECT RAISE(ABORT,'story node state cannot be deleted'); END;
    CREATE TRIGGER story_plot_point_answers_v34_guard_insert BEFORE INSERT ON story_plot_point_answers_v34
      WHEN EXISTS(SELECT 1 FROM story_plot_point_answers_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.storyline_id=NEW.storyline_id AND old.plot_point_id=NEW.plot_point_id)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id
        AND command.command_id=NEW.command_id AND command.command_type='answer-plot-point' AND command.created_at=NEW.answered_at
        AND json_extract(command.canonical_request_json,'$.targetId')=NEW.plot_point_id
        AND json_extract(command.canonical_request_json,'$.data.answer')=NEW.player_answer)
      BEGIN SELECT RAISE(ABORT,'story plot point answer provenance is invalid'); END;
    CREATE TRIGGER story_plot_point_answers_v34_immutable_update BEFORE UPDATE ON story_plot_point_answers_v34 BEGIN SELECT RAISE(ABORT,'story plot point answers are immutable'); END;
    CREATE TRIGGER story_plot_point_answers_v34_immutable_delete BEFORE DELETE ON story_plot_point_answers_v34 BEGIN SELECT RAISE(ABORT,'story plot point answers are immutable'); END;
    CREATE TRIGGER story_discoveries_v34_guard_insert BEFORE INSERT ON story_discoveries_v34
      WHEN EXISTS(SELECT 1 FROM story_discoveries_v34 old WHERE old.campaign_id=NEW.campaign_id AND old.storyline_id=NEW.storyline_id AND old.clue_id=NEW.clue_id)
        OR NOT EXISTS(SELECT 1 FROM story_commands_v34 command WHERE command.campaign_id=NEW.campaign_id AND command.storyline_id=NEW.storyline_id
        AND command.command_id=NEW.command_id AND command.command_type='reveal-clue' AND command.created_at=NEW.discovered_at
        AND json_extract(command.canonical_request_json,'$.targetId')=NEW.clue_id)
        OR (SELECT count(*) FROM story_clue_sources_v34 source WHERE source.campaign_id=NEW.campaign_id AND source.storyline_id=NEW.storyline_id
          AND source.clue_id=NEW.clue_id AND ((source.source_kind='node' AND EXISTS(SELECT 1 FROM story_node_state_v34 state
            WHERE state.campaign_id=source.campaign_id AND state.storyline_id=source.storyline_id AND state.node_id=source.target_id AND state.status<>'hidden'))
          OR (source.source_kind='plot-point' AND EXISTS(SELECT 1 FROM story_plot_point_answers_v34 answer WHERE answer.campaign_id=source.campaign_id
            AND answer.storyline_id=source.storyline_id AND answer.plot_point_id=source.target_id))))
          < (SELECT clue.reveal_threshold FROM story_clues_v34 clue WHERE clue.campaign_id=NEW.campaign_id AND clue.storyline_id=NEW.storyline_id AND clue.clue_id=NEW.clue_id)
      BEGIN SELECT RAISE(ABORT,'story discovery provenance is invalid'); END;
    CREATE TRIGGER story_metadata_v34_immutable_update BEFORE UPDATE ON story_metadata_v34 BEGIN SELECT RAISE(ABORT,'story metadata is immutable'); END;
    CREATE TRIGGER story_metadata_v34_immutable_delete BEFORE DELETE ON story_metadata_v34 BEGIN SELECT RAISE(ABORT,'story metadata is immutable'); END;
    CREATE TRIGGER story_nodes_v34_immutable_update BEFORE UPDATE ON story_nodes_v34 BEGIN SELECT RAISE(ABORT,'story nodes are immutable'); END;
    CREATE TRIGGER story_nodes_v34_immutable_delete BEFORE DELETE ON story_nodes_v34 BEGIN SELECT RAISE(ABORT,'story nodes are immutable'); END;
    CREATE TRIGGER story_edges_v34_immutable_update BEFORE UPDATE ON story_edges_v34 BEGIN SELECT RAISE(ABORT,'story edges are immutable'); END;
    CREATE TRIGGER story_edges_v34_immutable_delete BEFORE DELETE ON story_edges_v34 BEGIN SELECT RAISE(ABORT,'story edges are immutable'); END;
    CREATE TRIGGER story_plot_points_v34_immutable_update BEFORE UPDATE ON story_plot_points_v34 BEGIN SELECT RAISE(ABORT,'story plot points are immutable'); END;
    CREATE TRIGGER story_plot_points_v34_immutable_delete BEFORE DELETE ON story_plot_points_v34 BEGIN SELECT RAISE(ABORT,'story plot points are immutable'); END;
    CREATE TRIGGER story_clues_v34_immutable_update BEFORE UPDATE ON story_clues_v34 BEGIN SELECT RAISE(ABORT,'story clues are immutable'); END;
    CREATE TRIGGER story_clues_v34_immutable_delete BEFORE DELETE ON story_clues_v34 BEGIN SELECT RAISE(ABORT,'story clues are immutable'); END;
    CREATE TRIGGER story_clue_sources_v34_immutable_update BEFORE UPDATE ON story_clue_sources_v34 BEGIN SELECT RAISE(ABORT,'story clue sources are immutable'); END;
    CREATE TRIGGER story_clue_sources_v34_immutable_delete BEFORE DELETE ON story_clue_sources_v34 BEGIN SELECT RAISE(ABORT,'story clue sources are immutable'); END;
    CREATE TRIGGER story_layout_attestation_v34_conflict_insert BEFORE INSERT ON story_layout_attestation_v34
      WHEN EXISTS(SELECT 1 FROM story_layout_attestation_v34 old WHERE old.singleton=NEW.singleton)
      BEGIN SELECT RAISE(ABORT,'story layout attestation identity is sealed'); END;
    CREATE TRIGGER story_layout_attestation_v34_immutable_update BEFORE UPDATE ON story_layout_attestation_v34 BEGIN SELECT RAISE(ABORT,'story layout attestation is immutable'); END;
    CREATE TRIGGER story_layout_attestation_v34_immutable_delete BEFORE DELETE ON story_layout_attestation_v34 BEGIN SELECT RAISE(ABORT,'story layout attestation is immutable'); END;
  `);
  assertStoryObjectInventory(db);
  db.prepare("INSERT INTO story_layout_attestation_v34 VALUES(1,?)").run(digest(db));
}

export function assertStoryDomainV34(db: DatabaseDriver.Database): void {
  assertStoryObjectInventory(db);
  const row = db.prepare("SELECT layout_digest FROM story_layout_attestation_v34 WHERE singleton=1").get() as { layout_digest: string } | undefined;
  if (!row || row.layout_digest !== digest(db)) throw new Error("schema v34 story domain is incompatible");
  validateStoryDataV34(db);
}

/** Back-validates relationships which SQLite triggers guard for all future writes. */
export function validateStoryDataV34(db: DatabaseDriver.Database): void {
  assertLegacyStoryAncestry(db);
  const foreignKeyIssue = (db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>).find((issue) => issue.table.startsWith("story_"));
  if (foreignKeyIssue) throw new Error(`schema v34 story data has a foreign-key violation (${foreignKeyIssue.table})`);
  const commandAncestry = db.prepare(`SELECT command.command_id FROM story_commands_v34 command LEFT JOIN quest_storylines root
    ON root.campaign_id=command.campaign_id AND root.id=command.storyline_id WHERE root.id IS NULL LIMIT 1`).get() as { command_id: string } | undefined;
  if (commandAncestry) throw new Error(`schema v34 story data has malformed command ancestry (${commandAncestry.command_id})`);
  const commandPayload = db.prepare(`SELECT command.command_id FROM story_commands_v34 command
    WHERE json_extract(command.canonical_request_json,'$.expectedRevision') IS NOT command.expected_revision
      OR json_extract(command.canonical_request_json,'$.idempotencyKey') IS NOT command.idempotency_key
      OR (command.command_type='create-storyline' AND (json_extract(command.canonical_request_json,'$.campaignId') IS NOT command.campaign_id
        OR json_extract(command.canonical_request_json,'$.storyline.storylineId') IS NOT command.storyline_id))
      OR (command.command_type<>'create-storyline' AND (json_extract(command.canonical_request_json,'$.storylineId') IS NOT command.storyline_id
        OR json_extract(command.canonical_request_json,'$.kind') IS NOT command.command_type)) LIMIT 1`).get() as { command_id: string } | undefined;
  if (commandPayload) throw new Error(`schema v34 story data has unauthorized or malformed command payload (${commandPayload.command_id})`);
  const rootPayload = db.prepare(`SELECT root.id FROM story_metadata_v34 metadata JOIN quest_storylines root
      ON root.campaign_id=metadata.campaign_id AND root.id=metadata.storyline_id
    LEFT JOIN story_commands_v34 command ON command.campaign_id=metadata.campaign_id AND command.storyline_id=metadata.storyline_id
      AND command.command_id=metadata.created_command_id AND command.command_type='create-storyline'
    WHERE command.command_id IS NULL OR root.title IS NOT json_extract(command.canonical_request_json,'$.storyline.title')
      OR root.description IS NOT json_extract(command.canonical_request_json,'$.storyline.summary') OR root.status<>'active'
      OR metadata.summary IS NOT json_extract(command.canonical_request_json,'$.storyline.summary') OR metadata.status<>'active'
      OR root.created_at<>command.created_at OR metadata.updated_at<>command.created_at LIMIT 1`).get() as { id: string } | undefined;
  if (rootPayload) throw new Error(`schema v34 story data has malformed root payload (${rootPayload.id})`);
  const provenance = db.prepare(`SELECT item.created_command_id FROM (
      SELECT campaign_id,storyline_id,created_command_id FROM story_metadata_v34 UNION ALL
      SELECT campaign_id,storyline_id,created_command_id FROM story_nodes_v34 UNION ALL
      SELECT campaign_id,storyline_id,created_command_id FROM story_edges_v34 UNION ALL
      SELECT campaign_id,storyline_id,created_command_id FROM story_plot_points_v34 UNION ALL
      SELECT campaign_id,storyline_id,created_command_id FROM story_clues_v34) item
    LEFT JOIN story_commands_v34 command ON command.campaign_id=item.campaign_id AND command.storyline_id=item.storyline_id
      AND command.command_id=item.created_command_id AND command.command_type='create-storyline'
    WHERE command.command_id IS NULL LIMIT 1`).get() as { created_command_id: string } | undefined;
  if (provenance) throw new Error(`schema v34 story data has malformed creation provenance (${provenance.created_command_id})`);
  const staticPayload = db.prepare(`SELECT command.command_id FROM story_commands_v34 command WHERE command.command_type='create-storyline' AND (
    EXISTS(SELECT 1 FROM story_nodes_v34 node WHERE node.campaign_id=command.campaign_id AND node.storyline_id=command.storyline_id
      AND NOT EXISTS(SELECT 1 FROM json_each(command.canonical_request_json,'$.storyline.nodes') item WHERE json_extract(item.value,'$.nodeId')=node.node_id
        AND CAST(item.key AS INTEGER)=node.sort_order AND json_extract(item.value,'$.title')=node.title AND json_extract(item.value,'$.description') IS node.description
        AND json_extract(item.value,'$.gmNotes') IS node.gm_notes AND json_extract(item.value,'$.revealThreshold')=node.reveal_threshold))
    OR EXISTS(SELECT 1 FROM story_edges_v34 edge WHERE edge.campaign_id=command.campaign_id AND edge.storyline_id=command.storyline_id
      AND NOT EXISTS(SELECT 1 FROM json_each(command.canonical_request_json,'$.storyline.edges') item WHERE json_extract(item.value,'$.edgeId')=edge.edge_id
        AND json_extract(item.value,'$.kind')=edge.kind AND json_extract(item.value,'$.fromNodeId')=edge.from_node_id AND json_extract(item.value,'$.toNodeId')=edge.to_node_id))
    OR EXISTS(SELECT 1 FROM story_plot_points_v34 point WHERE point.campaign_id=command.campaign_id AND point.storyline_id=command.storyline_id
      AND NOT EXISTS(SELECT 1 FROM json_each(command.canonical_request_json,'$.storyline.plotPoints') item WHERE json_extract(item.value,'$.plotPointId')=point.plot_point_id
        AND json_extract(item.value,'$.nodeId')=point.node_id AND json_extract(item.value,'$.question')=point.question AND json_extract(item.value,'$.answer')=point.answer
        AND json_extract(item.value,'$.gmNotes') IS point.gm_notes))
    OR EXISTS(SELECT 1 FROM story_clues_v34 clue WHERE clue.campaign_id=command.campaign_id AND clue.storyline_id=command.storyline_id
      AND NOT EXISTS(SELECT 1 FROM json_each(command.canonical_request_json,'$.storyline.clues') item WHERE json_extract(item.value,'$.clueId')=clue.clue_id
        AND json_extract(item.value,'$.title')=clue.title AND json_extract(item.value,'$.content')=clue.content AND json_extract(item.value,'$.truth')=clue.truth
        AND json_extract(item.value,'$.gmNotes') IS clue.gm_notes AND json_extract(item.value,'$.revealThreshold')=clue.reveal_threshold))
    OR EXISTS(SELECT 1 FROM story_clue_sources_v34 source JOIN story_clues_v34 clue USING(campaign_id,storyline_id,clue_id)
      WHERE source.campaign_id=command.campaign_id AND source.storyline_id=command.storyline_id AND NOT EXISTS(
        SELECT 1 FROM json_each(command.canonical_request_json,'$.storyline.clues') clue_item JOIN json_each(clue_item.value,'$.sources') source_item
        WHERE json_extract(clue_item.value,'$.clueId')=source.clue_id AND json_extract(source_item.value,'$.sourceId')=source.source_id
          AND json_extract(source_item.value,'$.kind')=source.source_kind AND json_extract(source_item.value,'$.targetId')=source.target_id))) LIMIT 1`).get() as { command_id: string } | undefined;
  if (staticPayload) throw new Error(`schema v34 story data has malformed static payload (${staticPayload.command_id})`);
  const source = db.prepare(`SELECT source.source_id FROM story_clue_sources_v34 source WHERE
    (source.source_kind='node' AND NOT EXISTS(SELECT 1 FROM story_nodes_v34 node WHERE node.campaign_id=source.campaign_id AND node.storyline_id=source.storyline_id AND node.node_id=source.target_id)) OR
    (source.source_kind='plot-point' AND NOT EXISTS(SELECT 1 FROM story_plot_points_v34 point WHERE point.campaign_id=source.campaign_id AND point.storyline_id=source.storyline_id AND point.plot_point_id=source.target_id)) LIMIT 1`).get() as { source_id: string } | undefined;
  if (source) throw new Error(`schema v34 story data has malformed clue source ancestry (${source.source_id})`);
  const state = db.prepare(`SELECT state.node_id FROM story_node_state_v34 state LEFT JOIN story_commands_v34 command
    ON command.campaign_id=state.campaign_id AND command.storyline_id=state.storyline_id AND command.command_id=state.last_command_id
    WHERE command.command_id IS NULL OR state.updated_at<>command.created_at OR (state.status='hidden' AND command.command_type<>'create-storyline')
      OR (state.status='revealed' AND (command.command_type<>'reveal-node' OR json_extract(command.canonical_request_json,'$.targetId')<>state.node_id))
      OR (state.status='resolved' AND (command.command_type<>'resolve-node' OR json_extract(command.canonical_request_json,'$.targetId')<>state.node_id))
      OR (state.status IN ('revealed','resolved') AND EXISTS(SELECT 1 FROM story_edges_v34 edge JOIN story_node_state_v34 required
        ON required.campaign_id=edge.campaign_id AND required.storyline_id=edge.storyline_id AND required.node_id=edge.from_node_id
        WHERE edge.campaign_id=state.campaign_id AND edge.storyline_id=state.storyline_id AND edge.to_node_id=state.node_id
          AND edge.kind='requires' AND required.status<>'resolved'))
      OR (state.status='revealed' AND (SELECT count(*) FROM story_edges_v34 edge JOIN story_node_state_v34 contributor
        ON contributor.campaign_id=edge.campaign_id AND contributor.storyline_id=edge.storyline_id AND contributor.node_id=edge.from_node_id
        WHERE edge.campaign_id=state.campaign_id AND edge.storyline_id=state.storyline_id AND edge.to_node_id=state.node_id AND contributor.status='resolved')
        < (SELECT node.reveal_threshold FROM story_nodes_v34 node WHERE node.campaign_id=state.campaign_id AND node.storyline_id=state.storyline_id AND node.node_id=state.node_id)) LIMIT 1`).get() as { node_id: string } | undefined;
  if (state) throw new Error(`schema v34 story data has malformed node state provenance (${state.node_id})`);
  const mutableProvenance = db.prepare(`SELECT target_id FROM (
      SELECT answer.plot_point_id target_id,answer.campaign_id,answer.storyline_id,answer.command_id,'answer-plot-point' command_type,
        answer.answered_at occurred_at,answer.player_answer supplied_value FROM story_plot_point_answers_v34 answer
      UNION ALL SELECT discovery.clue_id,discovery.campaign_id,discovery.storyline_id,discovery.command_id,'reveal-clue',discovery.discovered_at,NULL FROM story_discoveries_v34 discovery) item
    LEFT JOIN story_commands_v34 command ON command.campaign_id=item.campaign_id AND command.storyline_id=item.storyline_id AND command.command_id=item.command_id
      AND command.command_type=item.command_type AND json_extract(command.canonical_request_json,'$.targetId')=item.target_id
    WHERE command.command_id IS NULL OR item.occurred_at<>command.created_at
      OR (item.command_type='answer-plot-point' AND item.supplied_value<>json_extract(command.canonical_request_json,'$.data.answer'))
      OR (item.command_type='reveal-clue' AND (SELECT count(*) FROM story_clue_sources_v34 source WHERE source.campaign_id=item.campaign_id
        AND source.storyline_id=item.storyline_id AND source.clue_id=item.target_id AND
        ((source.source_kind='node' AND EXISTS(SELECT 1 FROM story_node_state_v34 state WHERE state.campaign_id=source.campaign_id
          AND state.storyline_id=source.storyline_id AND state.node_id=source.target_id AND state.status<>'hidden'))
        OR (source.source_kind='plot-point' AND EXISTS(SELECT 1 FROM story_plot_point_answers_v34 answer WHERE answer.campaign_id=source.campaign_id
          AND answer.storyline_id=source.storyline_id AND answer.plot_point_id=source.target_id))))
        < (SELECT clue.reveal_threshold FROM story_clues_v34 clue WHERE clue.campaign_id=item.campaign_id AND clue.storyline_id=item.storyline_id AND clue.clue_id=item.target_id)) LIMIT 1`).get() as { target_id: string } | undefined;
  if (mutableProvenance) throw new Error(`schema v34 story data has malformed mutation provenance (${mutableProvenance.target_id})`);
  const cycle = db.prepare(`WITH RECURSIVE reachable(campaign_id,storyline_id,from_node_id,to_node_id) AS (
      SELECT campaign_id,storyline_id,from_node_id,to_node_id FROM story_edges_v34 UNION
      SELECT reachable.campaign_id,reachable.storyline_id,reachable.from_node_id,edge.to_node_id FROM reachable JOIN story_edges_v34 edge
        ON edge.campaign_id=reachable.campaign_id AND edge.storyline_id=reachable.storyline_id AND edge.from_node_id=reachable.to_node_id)
    SELECT from_node_id FROM reachable WHERE from_node_id=to_node_id LIMIT 1`).get() as { from_node_id: string } | undefined;
  if (cycle) throw new Error(`schema v34 story data contains a graph cycle (${cycle.from_node_id})`);
}
export function migrate33to34(db: DatabaseDriver.Database): void {
  db.transaction(() => { assertQuestDomainV33(db); createStoryDomainV34(db); db.prepare("UPDATE meta SET value='34' WHERE key='schemaVersion'").run(); })();
}
