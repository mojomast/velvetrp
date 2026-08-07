import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getSession, listLoreEntries, listMessages } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();

describe("schema v4 to v5 migration", () => {
  it("backfills participants and character-message speakers without resetting data", async () => {
    const db = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"));
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schemaVersion', '4');
      CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, archetype TEXT NOT NULL,
        boundaries TEXT NOT NULL, fictional_confirmed INTEGER NOT NULL, is_real_person INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        title TEXT NOT NULL, state TEXT NOT NULL, preset_id TEXT NOT NULL, active_leaf_id TEXT, created_at TEXT NOT NULL, stopped_at TEXT, stop_reason TEXT);
      CREATE TABLE consent_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, at TEXT NOT NULL, scope TEXT NOT NULL, granted INTEGER NOT NULL, note TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL,
        content TEXT NOT NULL, parent_id TEXT, swipe_group_id TEXT, swipe_index INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'final', prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER, usage_source TEXT,
        usage_model TEXT, created_at TEXT NOT NULL);
      CREATE TABLE lore (id TEXT PRIMARY KEY, character_id TEXT, keys TEXT NOT NULL, content TEXT NOT NULL, enabled INTEGER NOT NULL,
        insertion_order REAL NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO characters VALUES ('c1', 'Legacy', 30, 'archivist', 'fictional', 1, 0, '2025-01-01');
      INSERT INTO sessions VALUES ('s1', 'c1', 'kept', 'active', 'default', 'm2', '2025-01-01', NULL, NULL);
      INSERT INTO messages VALUES ('m1', 's1', 'user', 'hello', NULL, 'm1', 0, 0, 'final', NULL, NULL, NULL, NULL, NULL, '2025-01-01');
      INSERT INTO messages VALUES ('m2', 's1', 'character', 'reply', 'm1', 'm2', 0, 1, 'final', 10, 5, 15, 'provider', 'legacy-model', '2025-01-02');
      INSERT INTO lore VALUES ('l1', 'c1', '["archive"]', 'kept lore', 1, 1, '2025-01-01');
    `);
    db.close();

    const session = await getSession("s1");
    expect(session?.primaryCharacterId).toBe("c1");
    expect(session?.participants.map((participant) => participant.id)).toEqual(["c1"]);
    const messages = await listMessages("s1");
    expect(messages[0]?.speakerCharacterId).toBeNull();
    expect(messages[1]?.speakerCharacterId).toBe("c1");
    expect((await listLoreEntries("c1"))[0]?.characterIds).toEqual(["c1"]);

    const verify = new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite"), { readonly: true });
    expect((verify.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("30");
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'session_context'").get()).toBeTruthy();
    const contextColumns = verify.pragma("table_info(session_context)") as Array<{ name: string }>;
    expect(contextColumns.some((column) => column.name === "synthesized_source")).toBe(true);
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_events'").get()).toBeTruthy();
    expect(verify.prepare("SELECT kind, total_tokens FROM usage_events WHERE source_message_id = 'm2'").get()).toEqual({ kind: "character_reply", total_tokens: 15 });
    verify.close();
  });

  it("rolls back DDL, backfills, and schemaVersion together when migration fails", async () => {
    const dbPath = path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
    const db = new DatabaseDriver(dbPath);
    // Foreign keys are intentionally off while constructing corrupt legacy
    // input. Opening the repository enables them, making the backfill fail.
    db.pragma("foreign_keys = OFF");
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schemaVersion', '4');
      CREATE TABLE characters (id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, archetype TEXT NOT NULL,
        boundaries TEXT NOT NULL, fictional_confirmed INTEGER NOT NULL, is_real_person INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        title TEXT NOT NULL, state TEXT NOT NULL, preset_id TEXT NOT NULL, active_leaf_id TEXT, created_at TEXT NOT NULL, stopped_at TEXT, stop_reason TEXT);
      CREATE TABLE consent_events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL, at TEXT NOT NULL, scope TEXT NOT NULL, granted INTEGER NOT NULL, note TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL,
        content TEXT NOT NULL, parent_id TEXT, swipe_group_id TEXT, swipe_index INTEGER NOT NULL DEFAULT 0, seq INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'final', prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER, usage_source TEXT,
        usage_model TEXT, created_at TEXT NOT NULL);
      CREATE TABLE lore (id TEXT PRIMARY KEY, character_id TEXT, keys TEXT NOT NULL, content TEXT NOT NULL, enabled INTEGER NOT NULL,
        insertion_order REAL NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO sessions VALUES ('broken', 'missing-character', 'broken', 'setup', 'default', NULL, '2025-01-01', NULL, NULL);
    `);
    db.close();

    await expect(getSession("broken")).rejects.toThrow(/FOREIGN KEY/);

    const verify = new DatabaseDriver(dbPath, { readonly: true });
    expect((verify.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("4");
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'session_characters'").get()).toBeUndefined();
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'lore_characters'").get()).toBeUndefined();
    const messageColumns = verify.pragma("table_info(messages)") as Array<{ name: string }>;
    expect(messageColumns.some((column) => column.name === "speaker_character_id")).toBe(false);
    verify.close();
  });
});
