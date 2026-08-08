import { createHash } from "node:crypto";
import DatabaseDriver from "better-sqlite3";

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    : item);

/** Additive lifecycle metadata without changing the attested v27 combat tables. */
export function createEncounterLifecycleV31(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE encounter_lifecycle_v31 (
      encounter_id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200 AND name=trim(name)),
      create_idempotency_key TEXT NOT NULL CHECK(length(create_idempotency_key) BETWEEN 1 AND 128
        AND create_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      canonical_create_request_json TEXT NOT NULL CHECK(length(canonical_create_request_json) BETWEEN 2 AND 32768
        AND json_valid(canonical_create_request_json) AND json_type(canonical_create_request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      UNIQUE(campaign_id,create_idempotency_key),
      FOREIGN KEY(encounter_id) REFERENCES encounter(encounter_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX idx_encounter_lifecycle_v31_campaign
      ON encounter_lifecycle_v31(campaign_id,encounter_id);
    CREATE TABLE encounter_enemy_provenance_v31 (
      combatant_id TEXT PRIMARY KEY,
      encounter_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      pack_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind='enemy-template'),
      definition_id TEXT NOT NULL,
      FOREIGN KEY(encounter_id,combatant_id) REFERENCES combatant(encounter_id,combatant_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,pack_id,pack_version,kind,definition_id)
        REFERENCES rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id)
        ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
    CREATE INDEX idx_encounter_enemy_provenance_v31_encounter
      ON encounter_enemy_provenance_v31(encounter_id,combatant_id);
    CREATE TRIGGER encounter_lifecycle_v31_exact_ancestry BEFORE INSERT ON encounter_lifecycle_v31
      WHEN NOT EXISTS(SELECT 1 FROM encounter e WHERE e.encounter_id=NEW.encounter_id
        AND e.campaign_id=NEW.campaign_id AND e.session_id=NEW.session_id)
      BEGIN SELECT RAISE(ABORT,'encounter lifecycle metadata must match encounter ancestry'); END;
    CREATE TRIGGER encounter_lifecycle_v31_immutable_update BEFORE UPDATE ON encounter_lifecycle_v31
      BEGIN SELECT RAISE(ABORT,'encounter lifecycle metadata is immutable'); END;
    CREATE TRIGGER encounter_lifecycle_v31_immutable_delete BEFORE DELETE ON encounter_lifecycle_v31
      BEGIN SELECT RAISE(ABORT,'encounter lifecycle metadata is immutable'); END;
    CREATE TRIGGER encounter_enemy_provenance_v31_exact_combatant BEFORE INSERT ON encounter_enemy_provenance_v31
      WHEN NOT EXISTS(SELECT 1 FROM combatant c WHERE c.combatant_id=NEW.combatant_id
        AND c.encounter_id=NEW.encounter_id AND c.campaign_id=NEW.campaign_id AND c.combatant_kind='enemy')
      BEGIN SELECT RAISE(ABORT,'enemy provenance must match an enemy combatant'); END;
    CREATE TRIGGER encounter_enemy_provenance_v31_immutable_update BEFORE UPDATE ON encounter_enemy_provenance_v31
      BEGIN SELECT RAISE(ABORT,'enemy provenance is immutable'); END;
    CREATE TRIGGER encounter_enemy_provenance_v31_immutable_delete BEFORE DELETE ON encounter_enemy_provenance_v31
      BEGIN SELECT RAISE(ABORT,'enemy provenance is immutable'); END;
  `);

  const rows = db.prepare("SELECT encounter_id,campaign_id,session_id FROM encounter ORDER BY encounter_id").all() as Array<{
    encounter_id: string; campaign_id: string; session_id: string;
  }>;
  const insert = db.prepare(`INSERT INTO encounter_lifecycle_v31
    (encounter_id,campaign_id,session_id,name,create_idempotency_key,canonical_create_request_json,request_digest)
    VALUES(?,?,?,?,?,?,?)`);
  for (const row of rows) {
    const request = canonical({ legacyEncounterId: row.encounter_id });
    const hash = createHash("sha256").update(request).digest("hex");
    insert.run(row.encounter_id, row.campaign_id, row.session_id, `Encounter ${row.encounter_id}`,
      `legacy:${hash}`, request, hash);
  }
}

export function assertEncounterLifecycleV31(db: DatabaseDriver.Database): void {
  const names = new Set((db.prepare(`SELECT name FROM sqlite_master WHERE name IN (
    'encounter_lifecycle_v31','idx_encounter_lifecycle_v31_campaign','encounter_enemy_provenance_v31',
    'idx_encounter_enemy_provenance_v31_encounter','encounter_lifecycle_v31_exact_ancestry',
    'encounter_lifecycle_v31_immutable_update','encounter_lifecycle_v31_immutable_delete',
    'encounter_enemy_provenance_v31_exact_combatant','encounter_enemy_provenance_v31_immutable_update',
    'encounter_enemy_provenance_v31_immutable_delete')`).all() as Array<{ name: string }>).map((row) => row.name));
  if (names.size !== 10) throw new Error("schema v31 encounter lifecycle is incompatible");
}

export function migrate30to31(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createEncounterLifecycleV31(db);
    db.prepare("UPDATE meta SET value='31' WHERE key='schemaVersion'").run();
  })();
}
