-- Combat ready actions: one bounded, expiring held response per combatant.
-- A ready action spends the action and fires its response through the reaction
-- window when its closed trigger matches, or expires at the start of the
-- readying combatant's next turn. One row per combatant.
CREATE TABLE combat_ready_actions_v66 (
      encounter_id TEXT NOT NULL, combatant_id TEXT NOT NULL, ready_id TEXT NOT NULL,
      response_kind TEXT NOT NULL CHECK(response_kind IN ('spell','maneuver')),
      response_id TEXT NOT NULL,
      trigger_event TEXT NOT NULL CHECK(trigger_event IN ('hit','targeted','turn-start','leaves-reach')),
      trigger_subject TEXT NOT NULL CHECK(trigger_subject IN ('self','ally','enemy')),
      max_distance_feet INTEGER CHECK(max_distance_feet IS NULL OR (typeof(max_distance_feet)='integer' AND max_distance_feet BETWEEN 0 AND 1000)),
      requires_hit INTEGER NOT NULL DEFAULT 0 CHECK(requires_hit IN (0,1)),
      expires_at_round INTEGER NOT NULL CHECK(typeof(expires_at_round)='integer' AND expires_at_round BETWEEN 1 AND 1000000),
      command_id TEXT NOT NULL,
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      PRIMARY KEY(encounter_id,combatant_id),
      FOREIGN KEY(encounter_id,combatant_id) REFERENCES combatant(encounter_id,combatant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(encounter_id,command_id) REFERENCES combat_commands_v27(encounter_id,command_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
