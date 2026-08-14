import type DatabaseDriver from "better-sqlite3";

/** Immutable roll history layered over the sealed v19 character draft. */
export function createCharacterRerollsV49(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE character_draft_rerolls_v49 (
      draft_id TEXT NOT NULL REFERENCES character_drafts_v19(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
      allocation_json TEXT NOT NULL CHECK(json_valid(allocation_json) AND json_type(allocation_json)='object'
        AND json_extract(allocation_json,'$.method')='server-roll'),
      created_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      PRIMARY KEY(draft_id,revision),
      FOREIGN KEY(draft_id,revision) REFERENCES character_draft_revisions_v19(draft_id,revision) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER character_draft_rerolls_v49_immutable_update BEFORE UPDATE ON character_draft_rerolls_v49
      BEGIN SELECT RAISE(ABORT,'character rerolls are immutable'); END;
    CREATE TRIGGER character_draft_rerolls_v49_immutable_delete BEFORE DELETE ON character_draft_rerolls_v49
      BEGIN SELECT RAISE(ABORT,'character rerolls are immutable'); END;
  `);
}

export function migrate48to49(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createCharacterRerollsV49(db);
    db.prepare("UPDATE meta SET value='49' WHERE key='schemaVersion'").run();
  })();
}

export function assertCharacterRerollsLayoutV49(db: DatabaseDriver.Database): void {
  const columns = (db.prepare("PRAGMA table_info(character_draft_rerolls_v49)").all() as Array<{ name: string }>).map(({ name }) => name);
  if (JSON.stringify(columns) !== JSON.stringify(["draft_id", "revision", "allocation_json", "created_at"])) throw new Error("schema v49 character rerolls are incompatible");
  const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='character_draft_rerolls_v49' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  if (JSON.stringify(triggers) !== JSON.stringify(["character_draft_rerolls_v49_immutable_delete", "character_draft_rerolls_v49_immutable_update"])) throw new Error("schema v49 character reroll guards are incompatible");
}
