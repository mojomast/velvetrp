import { createHash } from "node:crypto";
import DatabaseDriver from "better-sqlite3";
import { assertWorldNarrativeV32 } from "./v32_world_narrative.js";

function layoutDigest(db: DatabaseDriver.Database): string {
  const rows = db.prepare(`SELECT type,name,sql FROM sqlite_master
    WHERE name GLOB '*v33*' ORDER BY type,name`).all() as
    Array<{ type: string; name: string; sql: string }>;
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function assertLegacyQuestAncestry(db: DatabaseDriver.Database): void {
  const malformedStoryline = db.prepare(`SELECT storyline.id FROM quest_storylines storyline
    LEFT JOIN campaigns campaign ON campaign.id=storyline.campaign_id WHERE campaign.id IS NULL LIMIT 1`).get() as { id: string } | undefined;
  if (malformedStoryline) throw new Error(`schema v33 quest migration rejected malformed quest/storyline ancestry (${malformedStoryline.id})`);
  const malformedQuest = db.prepare(`SELECT quest.id FROM quests quest
    LEFT JOIN quest_storylines storyline ON storyline.id=quest.storyline_id
    LEFT JOIN campaigns campaign ON campaign.id=quest.campaign_id
    WHERE campaign.id IS NULL OR storyline.id IS NULL OR storyline.campaign_id<>quest.campaign_id LIMIT 1`).get() as { id: string } | undefined;
  if (malformedQuest) throw new Error(`schema v33 quest migration rejected malformed quest/storyline ancestry (${malformedQuest.id})`);
  const malformedReward = db.prepare(`SELECT reward.id FROM quest_rewards reward
    LEFT JOIN quests quest ON quest.id=reward.quest_id
    LEFT JOIN campaigns campaign ON campaign.id=reward.campaign_id
    WHERE campaign.id IS NULL OR quest.id IS NULL OR quest.campaign_id<>reward.campaign_id LIMIT 1`).get() as { id: string } | undefined;
  if (malformedReward) throw new Error(`schema v33 quest migration rejected malformed reward ancestry (${malformedReward.id})`);
  const malformedClue = db.prepare(`SELECT clue.id FROM quest_clues clue
    LEFT JOIN quests quest ON quest.id=clue.quest_id
    LEFT JOIN campaigns campaign ON campaign.id=clue.campaign_id
    WHERE campaign.id IS NULL OR quest.id IS NULL OR quest.campaign_id<>clue.campaign_id LIMIT 1`).get() as { id: string } | undefined;
  if (malformedClue) throw new Error(`schema v33 quest migration rejected malformed clue ancestry (${malformedClue.id})`);
}

/** Additive quest command model. The v29 tables remain the durable legacy aggregate. */
export function createQuestDomainV33(db: DatabaseDriver.Database): void {
  assertLegacyQuestAncestry(db);
  db.exec(`
    CREATE UNIQUE INDEX uq_quest_campaign_id_v33 ON quests(campaign_id,id);
    CREATE UNIQUE INDEX uq_quest_reward_ancestry_v33 ON quest_rewards(campaign_id,quest_id,id);
    CREATE TABLE quest_domain_revisions_v33 (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE quest_domain_commands_v33 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, quest_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      command_type TEXT NOT NULL CHECK(command_type IN ('create','accept','advance-objective','abandon','claim-reward')),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1), created_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,command_id), UNIQUE(campaign_id,idempotency_key), UNIQUE(campaign_id,resulting_revision),
      UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id) REFERENCES quest_domain_revisions_v33(campaign_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT
    );
    CREATE TABLE quest_domain_receipts_v33 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      canonical_result_json TEXT NOT NULL CHECK(json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*'), occurred_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,command_id), UNIQUE(campaign_id,resulting_revision),
      UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES quest_domain_commands_v33(campaign_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE quest_domain_events_v33 (
      event_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('quest-created','quest-accepted','objective-advanced','quest-completed','quest-abandoned','reward-claimed')),
      event_json TEXT NOT NULL CHECK(json_valid(event_json) AND json_type(event_json)='object'), occurred_at TEXT NOT NULL,
      UNIQUE(campaign_id,command_id),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES quest_domain_receipts_v33(campaign_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE quest_definitions_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')),
      created_command_id TEXT NOT NULL, PRIMARY KEY(campaign_id,quest_id),
      FOREIGN KEY(campaign_id,quest_id) REFERENCES quests(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE quest_objectives_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, objective_id TEXT NOT NULL, description TEXT NOT NULL,
      target_progress INTEGER NOT NULL CHECK(typeof(target_progress)='integer' AND target_progress BETWEEN 1 AND 1000000),
      sort_order INTEGER NOT NULL CHECK(typeof(sort_order)='integer' AND sort_order>=0),
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')), created_command_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,quest_id,objective_id), UNIQUE(campaign_id,objective_id),
      FOREIGN KEY(campaign_id,quest_id) REFERENCES quest_definitions_v33(campaign_id,quest_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE quest_objective_dependencies_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, objective_id TEXT NOT NULL, dependency_objective_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,quest_id,objective_id,dependency_objective_id), CHECK(objective_id<>dependency_objective_id),
      FOREIGN KEY(campaign_id,quest_id,objective_id) REFERENCES quest_objectives_v33(campaign_id,quest_id,objective_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,quest_id,dependency_objective_id) REFERENCES quest_objectives_v33(campaign_id,quest_id,objective_id) ON DELETE RESTRICT
    );
    CREATE TABLE quest_objective_progress_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, objective_id TEXT NOT NULL,
      progress INTEGER NOT NULL CHECK(typeof(progress)='integer' AND progress BETWEEN 0 AND 1000000),
      completed_at TEXT, last_command_id TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,quest_id,objective_id),
      FOREIGN KEY(campaign_id,quest_id,objective_id) REFERENCES quest_objectives_v33(campaign_id,quest_id,objective_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,last_command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE quest_reward_definitions_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, reward_id TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')), created_command_id TEXT NOT NULL,
      PRIMARY KEY(campaign_id,quest_id,reward_id), UNIQUE(campaign_id,reward_id),
      FOREIGN KEY(campaign_id,quest_id,reward_id) REFERENCES quest_rewards(campaign_id,quest_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE quest_reward_claims_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, reward_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      command_id TEXT NOT NULL, claimed_at TEXT NOT NULL, PRIMARY KEY(campaign_id,quest_id,reward_id),
      FOREIGN KEY(campaign_id,quest_id,reward_id) REFERENCES quest_reward_definitions_v33(campaign_id,quest_id,reward_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE quest_journal_v33 (
      campaign_id TEXT NOT NULL, quest_id TEXT NOT NULL, entry_id TEXT NOT NULL, text TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')), command_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,entry_id),
      FOREIGN KEY(campaign_id,quest_id) REFERENCES quests(campaign_id,id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,command_id) REFERENCES quest_domain_commands_v33(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE quest_domain_layout_attestation_v33 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), layout_digest TEXT NOT NULL CHECK(length(layout_digest)=64)
    );
    CREATE TRIGGER quest_domain_commands_v33_immutable_update BEFORE UPDATE ON quest_domain_commands_v33 BEGIN SELECT RAISE(ABORT,'quest commands are immutable'); END;
    CREATE TRIGGER quest_domain_commands_v33_immutable_delete BEFORE DELETE ON quest_domain_commands_v33 BEGIN SELECT RAISE(ABORT,'quest commands are immutable'); END;
    CREATE TRIGGER quest_domain_receipts_v33_immutable_update BEFORE UPDATE ON quest_domain_receipts_v33 BEGIN SELECT RAISE(ABORT,'quest receipts are immutable'); END;
    CREATE TRIGGER quest_domain_receipts_v33_immutable_delete BEFORE DELETE ON quest_domain_receipts_v33 BEGIN SELECT RAISE(ABORT,'quest receipts are immutable'); END;
    CREATE TRIGGER quest_domain_events_v33_immutable_update BEFORE UPDATE ON quest_domain_events_v33 BEGIN SELECT RAISE(ABORT,'quest events are immutable'); END;
    CREATE TRIGGER quest_domain_events_v33_immutable_delete BEFORE DELETE ON quest_domain_events_v33 BEGIN SELECT RAISE(ABORT,'quest events are immutable'); END;
    CREATE TRIGGER quest_definitions_v33_immutable_update BEFORE UPDATE ON quest_definitions_v33 BEGIN SELECT RAISE(ABORT,'quest definitions are immutable'); END;
    CREATE TRIGGER quest_definitions_v33_immutable_delete BEFORE DELETE ON quest_definitions_v33 BEGIN SELECT RAISE(ABORT,'quest definitions are immutable'); END;
    CREATE TRIGGER quest_objectives_v33_immutable_update BEFORE UPDATE ON quest_objectives_v33 BEGIN SELECT RAISE(ABORT,'quest objectives are immutable'); END;
    CREATE TRIGGER quest_objectives_v33_immutable_delete BEFORE DELETE ON quest_objectives_v33 BEGIN SELECT RAISE(ABORT,'quest objectives are immutable'); END;
    CREATE TRIGGER quest_objective_dependencies_v33_immutable_update BEFORE UPDATE ON quest_objective_dependencies_v33 BEGIN SELECT RAISE(ABORT,'quest dependencies are immutable'); END;
    CREATE TRIGGER quest_objective_dependencies_v33_immutable_delete BEFORE DELETE ON quest_objective_dependencies_v33 BEGIN SELECT RAISE(ABORT,'quest dependencies are immutable'); END;
    CREATE TRIGGER quest_reward_definitions_v33_immutable_update BEFORE UPDATE ON quest_reward_definitions_v33 BEGIN SELECT RAISE(ABORT,'quest rewards are immutable'); END;
    CREATE TRIGGER quest_reward_definitions_v33_immutable_delete BEFORE DELETE ON quest_reward_definitions_v33 BEGIN SELECT RAISE(ABORT,'quest rewards are immutable'); END;
    CREATE TRIGGER quest_reward_claims_v33_immutable_update BEFORE UPDATE ON quest_reward_claims_v33 BEGIN SELECT RAISE(ABORT,'quest claims are immutable'); END;
    CREATE TRIGGER quest_reward_claims_v33_immutable_delete BEFORE DELETE ON quest_reward_claims_v33 BEGIN SELECT RAISE(ABORT,'quest claims are immutable'); END;
    CREATE TRIGGER quest_journal_v33_immutable_update BEFORE UPDATE ON quest_journal_v33 BEGIN SELECT RAISE(ABORT,'quest journal is immutable'); END;
    CREATE TRIGGER quest_journal_v33_immutable_delete BEFORE DELETE ON quest_journal_v33 BEGIN SELECT RAISE(ABORT,'quest journal is immutable'); END;
    CREATE TRIGGER quest_domain_layout_attestation_v33_immutable_update BEFORE UPDATE ON quest_domain_layout_attestation_v33 BEGIN SELECT RAISE(ABORT,'quest layout attestation is immutable'); END;
    CREATE TRIGGER quest_domain_layout_attestation_v33_immutable_delete BEFORE DELETE ON quest_domain_layout_attestation_v33 BEGIN SELECT RAISE(ABORT,'quest layout attestation is immutable'); END;
  `);
  db.prepare("INSERT INTO quest_domain_layout_attestation_v33 VALUES(1,?)").run(layoutDigest(db));
}

export function assertQuestDomainV33(db: DatabaseDriver.Database): void {
  const row = db.prepare("SELECT layout_digest FROM quest_domain_layout_attestation_v33 WHERE singleton=1").get() as { layout_digest: string } | undefined;
  if (!row || row.layout_digest !== layoutDigest(db)) {
    throw new Error("schema v33 quest domain is incompatible");
  }
}

export function migrate32to33(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    assertWorldNarrativeV32(db);
    createQuestDomainV33(db);
    db.prepare("UPDATE meta SET value='33' WHERE key='schemaVersion'").run();
  })();
}
