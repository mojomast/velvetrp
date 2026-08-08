import DatabaseDriver from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";

const makeDir = () => mkdtempSync(path.join(os.tmpdir(), "velvet-v29-"));
const file = (dir: string) => path.join(dir, "velvet.sqlite");

function layout(dir: string): unknown[] {
  const db = new DatabaseDriver(file(dir), { readonly: true });
  const result = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  db.close();
  return result;
}

function rewindToV28(dir: string): void {
  const db = new DatabaseDriver(file(dir));
  db.exec("DROP TRIGGER IF EXISTS character_layout_attestation_v29_immutable_update; DROP TRIGGER IF EXISTS character_layout_attestation_v29_immutable_delete; DROP TABLE character_layout_attestation_v29; ALTER TABLE characters ADD COLUMN safe_word TEXT NOT NULL DEFAULT ''; ");
  db.prepare("UPDATE meta SET value='28' WHERE key='schemaVersion'").run();
  db.close();
}

describe("schema v29 character-column removal", () => {
  it("has fresh/migrated parity and preserves character identities and references", () => {
    const migrated = makeDir();
    const repository = createRepository({ dataDir: migrated });
    const character = repository.createCharacter({ name: "Preserved", age: 30, archetype: "Guide", boundaries: "fictional adults", fictionalConfirmed: true });
    repository.close();
    const original = new DatabaseDriver(file(migrated));
    original.prepare("INSERT INTO sessions (id,character_id,title,state,preset_id,created_at) VALUES ('preserved-session',?,'preserved session','setup','default','2030-01-01T00:00:00.000Z')").run(character.id);
    original.prepare("INSERT INTO session_characters (session_id,character_id,position) VALUES ('preserved-session',?,0)").run(character.id);
    original.close();
    rewindToV28(migrated);
    createRepository({ dataDir: migrated }).close();

    const db = new DatabaseDriver(file(migrated));
    expect(db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "34" });
    expect((db.prepare("PRAGMA table_info(characters)").all() as Array<{ name: string }>).map((column) => column.name)).not.toContain("safe_word");
    expect(db.prepare("SELECT id FROM characters WHERE id=?").get(character.id)).toEqual({ id: character.id });
    expect(db.prepare("SELECT character_id FROM sessions WHERE id='preserved-session'").get()).toEqual({ character_id: character.id });
    db.close();

    const fresh = makeDir();
    createRepository({ dataDir: fresh }).close();
    expect(layout(migrated)).toEqual(layout(fresh));
  });

  it("rolls back on marker failure and rejects character-layout drift", () => {
    const dir = makeDir();
    createRepository({ dataDir: dir }).close();
    rewindToV28(dir);
    const blocked = new DatabaseDriver(file(dir));
    blocked.exec("CREATE TRIGGER reject_v29_marker BEFORE UPDATE OF value ON meta WHEN NEW.value='29' BEGIN SELECT RAISE(ABORT,'reject v29 marker'); END;");
    blocked.close();
    expect(() => createRepository({ dataDir: dir })).toThrow("reject v29 marker");
    const rolledBack = new DatabaseDriver(file(dir));
    expect(rolledBack.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get()).toEqual({ value: "28" });
    expect((rolledBack.prepare("PRAGMA table_info(characters)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("safe_word");
    rolledBack.close();

    const drift = makeDir();
    createRepository({ dataDir: drift }).close();
    const driftDb = new DatabaseDriver(file(drift));
    driftDb.exec("ALTER TABLE characters ADD COLUMN unexpected TEXT;");
    driftDb.close();
    expect(() => createRepository({ dataDir: drift })).toThrow("schema v29 character layout is incompatible");
  });
});
