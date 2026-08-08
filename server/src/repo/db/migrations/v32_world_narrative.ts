import DatabaseDriver from "better-sqlite3";

export function createWorldNarrativeV32(db:DatabaseDriver.Database):void{
  db.exec(`
    CREATE TABLE world_narrative_revisions_v32 (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23')
    );
    CREATE TABLE world_narrative_commands_v32 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL,
      resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 128 AND resource_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      command_type TEXT NOT NULL CHECK(command_type IN ('create_npc','change_npc_relationship','create_faction','change_faction_reputation')),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_request_json TEXT NOT NULL CHECK(json_valid(canonical_request_json) AND json_type(canonical_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at AND substr(created_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,command_id),UNIQUE(campaign_id,idempotency_key),UNIQUE(campaign_id,resulting_revision),
      UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id) REFERENCES world_narrative_revisions_v32(campaign_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE world_narrative_receipts_v32 (
      campaign_id TEXT NOT NULL,command_id TEXT NOT NULL,resulting_revision INTEGER NOT NULL,
      canonical_result_json TEXT NOT NULL CHECK(json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,command_id),UNIQUE(campaign_id,resulting_revision),
      UNIQUE(campaign_id,command_id,resulting_revision),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES world_narrative_commands_v32(campaign_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE world_narrative_events_v32 (
      event_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,command_id TEXT NOT NULL,resulting_revision INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('npc_created','npc_relationship_changed','faction_created','faction_reputation_changed')),
      event_json TEXT NOT NULL CHECK(json_valid(event_json) AND json_type(event_json)='object'),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at AND substr(occurred_at,12,2) BETWEEN '00' AND '23'),
      UNIQUE(campaign_id,command_id),
      FOREIGN KEY(campaign_id,command_id,resulting_revision) REFERENCES world_narrative_receipts_v32(campaign_id,command_id,resulting_revision) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE campaign_npc_metadata_v32 (
      npc_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,public_state_json TEXT NOT NULL,
      private_state_json TEXT NOT NULL,created_command_id TEXT NOT NULL,created_at TEXT NOT NULL,
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES world_narrative_commands_v32(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(json_valid(public_state_json) AND json_type(public_state_json)='object'),
      CHECK(json_valid(private_state_json) AND json_type(private_state_json)='object')
    );
    CREATE TABLE campaign_npc_relationships_v32 (
      campaign_id TEXT NOT NULL,npc_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      affinity INTEGER NOT NULL CHECK(typeof(affinity)='integer' AND affinity BETWEEN -1000 AND 1000),
      trust INTEGER NOT NULL CHECK(typeof(trust)='integer' AND trust BETWEEN -1000 AND 1000),
      fear INTEGER NOT NULL CHECK(typeof(fear)='integer' AND fear BETWEEN -1000 AND 1000),
      last_command_id TEXT NOT NULL,updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at AND substr(updated_at,12,2) BETWEEN '00' AND '23'),
      PRIMARY KEY(campaign_id,npc_id,actor_id),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,last_command_id) REFERENCES world_narrative_commands_v32(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE campaign_faction_metadata_v32 (
      faction_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,public_state_json TEXT NOT NULL,
      private_state_json TEXT NOT NULL,created_command_id TEXT NOT NULL,created_at TEXT NOT NULL,
      FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,created_command_id) REFERENCES world_narrative_commands_v32(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      CHECK(json_valid(public_state_json) AND json_type(public_state_json)='object'),
      CHECK(json_valid(private_state_json) AND json_type(private_state_json)='object')
    );
    CREATE TABLE campaign_faction_reputation_v32 (
      entry_id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,faction_id TEXT NOT NULL,actor_id TEXT NOT NULL,
      delta INTEGER NOT NULL CHECK(typeof(delta)='integer' AND delta BETWEEN -10000 AND 10000 AND delta<>0),reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500 AND reason=trim(reason)),
      command_id TEXT NOT NULL,recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)=recorded_at AND substr(recorded_at,12,2) BETWEEN '00' AND '23'),
      FOREIGN KEY(campaign_id,faction_id) REFERENCES campaign_factions_v28(campaign_id,faction_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,command_id) REFERENCES world_narrative_commands_v32(campaign_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER world_narrative_commands_v32_immutable_update BEFORE UPDATE ON world_narrative_commands_v32 BEGIN SELECT RAISE(ABORT,'world narrative commands are immutable'); END;
    CREATE TRIGGER world_narrative_commands_v32_immutable_delete BEFORE DELETE ON world_narrative_commands_v32 BEGIN SELECT RAISE(ABORT,'world narrative commands are immutable'); END;
    CREATE TRIGGER world_narrative_receipts_v32_immutable_update BEFORE UPDATE ON world_narrative_receipts_v32 BEGIN SELECT RAISE(ABORT,'world narrative receipts are immutable'); END;
    CREATE TRIGGER world_narrative_receipts_v32_immutable_delete BEFORE DELETE ON world_narrative_receipts_v32 BEGIN SELECT RAISE(ABORT,'world narrative receipts are immutable'); END;
    CREATE TRIGGER world_narrative_events_v32_immutable_update BEFORE UPDATE ON world_narrative_events_v32 BEGIN SELECT RAISE(ABORT,'world narrative events are immutable'); END;
    CREATE TRIGGER world_narrative_events_v32_immutable_delete BEFORE DELETE ON world_narrative_events_v32 BEGIN SELECT RAISE(ABORT,'world narrative events are immutable'); END;
    CREATE TRIGGER campaign_npc_metadata_v32_immutable_update BEFORE UPDATE ON campaign_npc_metadata_v32 BEGIN SELECT RAISE(ABORT,'NPC metadata is immutable'); END;
    CREATE TRIGGER campaign_npc_metadata_v32_immutable_delete BEFORE DELETE ON campaign_npc_metadata_v32 BEGIN SELECT RAISE(ABORT,'NPC metadata is immutable'); END;
    CREATE TRIGGER campaign_faction_metadata_v32_immutable_update BEFORE UPDATE ON campaign_faction_metadata_v32 BEGIN SELECT RAISE(ABORT,'faction metadata is immutable'); END;
    CREATE TRIGGER campaign_faction_metadata_v32_immutable_delete BEFORE DELETE ON campaign_faction_metadata_v32 BEGIN SELECT RAISE(ABORT,'faction metadata is immutable'); END;
    CREATE TRIGGER campaign_faction_reputation_v32_immutable_update BEFORE UPDATE ON campaign_faction_reputation_v32 BEGIN SELECT RAISE(ABORT,'faction reputation is immutable'); END;
    CREATE TRIGGER campaign_faction_reputation_v32_immutable_delete BEFORE DELETE ON campaign_faction_reputation_v32 BEGIN SELECT RAISE(ABORT,'faction reputation is immutable'); END;
  `);
}

export function assertWorldNarrativeV32(db:DatabaseDriver.Database):void{
  const names=new Set((db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND (name GLOB '*_v32' OR name GLOB '*_v32_*')").all() as Array<{name:string}>).map((row)=>row.name));
  const expected=["world_narrative_revisions_v32","world_narrative_commands_v32","world_narrative_receipts_v32",
    "world_narrative_events_v32","campaign_npc_metadata_v32","campaign_npc_relationships_v32",
    "campaign_faction_metadata_v32","campaign_faction_reputation_v32","world_narrative_commands_v32_immutable_update",
    "world_narrative_commands_v32_immutable_delete","world_narrative_receipts_v32_immutable_update",
    "world_narrative_receipts_v32_immutable_delete","world_narrative_events_v32_immutable_update",
    "world_narrative_events_v32_immutable_delete","campaign_npc_metadata_v32_immutable_update",
    "campaign_npc_metadata_v32_immutable_delete","campaign_faction_metadata_v32_immutable_update",
    "campaign_faction_metadata_v32_immutable_delete","campaign_faction_reputation_v32_immutable_update",
    "campaign_faction_reputation_v32_immutable_delete"];
  if(names.size!==expected.length||expected.some((name)=>!names.has(name)))
    throw new Error("schema v32 world narrative is incompatible");
}
export function migrate31to32(db:DatabaseDriver.Database):void{db.transaction(()=>{
  createWorldNarrativeV32(db);db.prepare("UPDATE meta SET value='32' WHERE key='schemaVersion'").run();
})();}
