-- Encounter combatant labels: one immutable public display label per labeled
-- combatant. Target-initiated NPC combat records the NPC's public name here so
-- the combat tracker and the generated tactical-map token identify the specific
-- NPC instead of the enemy template that NPC borrows. GM-created encounters and
-- actor targets write no row and keep their persona/template fallback names.
CREATE TABLE encounter_combatant_label_v67 (
      combatant_id TEXT PRIMARY KEY CHECK(length(combatant_id) BETWEEN 1 AND 128 AND combatant_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      encounter_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 200 AND label=trim(label)),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      FOREIGN KEY(encounter_id,combatant_id) REFERENCES combatant(encounter_id,combatant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE TRIGGER encounter_combatant_label_v67_immutable_update BEFORE UPDATE ON encounter_combatant_label_v67
      BEGIN SELECT RAISE(ABORT,'encounter combatant labels are immutable'); END;
CREATE TRIGGER encounter_combatant_label_v67_immutable_delete BEFORE DELETE ON encounter_combatant_label_v67
      BEGIN SELECT RAISE(ABORT,'encounter combatant labels are immutable'); END;
