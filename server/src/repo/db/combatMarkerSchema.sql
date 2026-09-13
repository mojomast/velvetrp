-- Combat markers: bounded per-combatant benefits granted by combat actions.
-- 'helped' is consumed by the helped creature's next attack; 'hidden' likewise.
CREATE TABLE combat_markers_v64 (
      encounter_id TEXT NOT NULL, combatant_id TEXT NOT NULL,
      marker TEXT NOT NULL CHECK(marker IN ('helped','hidden')),
      source_combatant_id TEXT, command_id TEXT NOT NULL,
      round_number INTEGER NOT NULL CHECK(typeof(round_number)='integer' AND round_number BETWEEN 1 AND 1000000),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      PRIMARY KEY(encounter_id,combatant_id,marker),
      FOREIGN KEY(encounter_id,combatant_id) REFERENCES combatant(encounter_id,combatant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id,command_id) REFERENCES combat_commands_v27(encounter_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
