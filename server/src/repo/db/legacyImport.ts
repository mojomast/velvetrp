// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { loadLegacyDatabase, markLegacyMigrated } from "../../legacy.js";
import type { RuntimeDependencies } from "../../runtime.js";
import type { Database } from "../../types.js";

export function migrateLegacyIfPresent(db: DatabaseDriver.Database, dir: string, dependencies: RuntimeDependencies): void {
  const legacy = loadLegacyDatabase(dir, dependencies);
  if (!legacy) return;
  const counts = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM characters) AS characters,
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM messages) AS messages`,
    )
    .get() as { characters: number; sessions: number; messages: number };
  if (counts.characters > 0 || counts.sessions > 0 || counts.messages > 0) {
    console.warn(
      `[velvet] legacy db.json found in ${dir} but migration was skipped because the SQLite database already contains data. ` +
        `The legacy file was left untouched; resolve it manually to avoid stale data.`,
    );
    return;
  }
  const run = db.transaction((data: Database) => {
    const insertCharacter = db.prepare(
      `INSERT INTO characters (id, name, age, archetype, boundaries, fictional_confirmed, is_real_person, created_at)
       VALUES (@id, @name, @age, @archetype, @boundaries, @fictionalConfirmed, @isRealPerson, @createdAt)`,
    );
    for (const c of data.characters) {
      insertCharacter.run({
        ...c,
        fictionalConfirmed: c.fictionalConfirmed ? 1 : 0,
        isRealPerson: c.isRealPerson ? 1 : 0,
      });
    }
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, character_id, title, state, preset_id, active_leaf_id, created_at, stopped_at, stop_reason)
       VALUES (@id, @characterId, @title, @state, @presetId, NULL, @createdAt, @stoppedAt, @stopReason)`,
    );
    const insertConsent = db.prepare(
      `INSERT INTO consent_events (id, session_id, seq, at, scope, granted, note)
       VALUES (@id, @sessionId, @seq, @at, @scope, @granted, @note)`,
    );
    const insertSessionCharacter = db.prepare(
      "INSERT INTO session_characters (session_id, character_id, position) VALUES (?, ?, 0)",
    );
    for (const s of data.sessions) {
      if (!data.characters.some((c) => c.id === s.characterId)) continue;
      insertSession.run(s);
      insertSessionCharacter.run(s.id, s.characterId);
      s.consentLog.forEach((event, seq) => {
        insertConsent.run({
          id: event.id,
          sessionId: s.id,
          seq,
          at: event.at,
          scope: event.scope,
          granted: event.granted ? 1 : 0,
          note: event.note,
        });
      });
    }
    const sessionIds = new Set(data.sessions.map((s) => s.id));
    const insertMessage = db.prepare(
      `INSERT INTO messages (id, session_id, role, speaker_character_id, content, parent_id, swipe_group_id, swipe_index, seq, status, created_at)
        VALUES (@id, @sessionId, @role, @speakerCharacterId, @content, @parentId, @swipeGroupId, @swipeIndex, @seq, @status, @createdAt)`,
    );
    const setLeaf = db.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?");
    const legacyBySession = new Map<string, typeof data.messages>();
    for (const m of data.messages) {
      if (!sessionIds.has(m.sessionId)) continue;
      const bucket = legacyBySession.get(m.sessionId) ?? [];
      bucket.push(m);
      legacyBySession.set(m.sessionId, bucket);
    }
    for (const [sessionId, messages] of legacyBySession) {
      const ordered = [...messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let prev: string | null = null;
      ordered.forEach((m, seq) => {
        insertMessage.run({
          ...m,
          speakerCharacterId: m.role === "character" ? data.sessions.find((s) => s.id === sessionId)?.characterId ?? null : null,
          parentId: prev,
          swipeGroupId: m.id,
          swipeIndex: 0,
          seq,
          status: "final",
        });
        prev = m.id;
      });
      if (prev !== null) setLeaf.run(prev, sessionId);
    }
    const characterIds = new Set(data.characters.map((c) => c.id));
    const insertMemory = db.prepare(
      `INSERT INTO memories (id, character_id, kind, content, source_turn_id, created_at, user_approved, forgotten_at)
       VALUES (@id, @characterId, @kind, @content, @sourceTurnId, @createdAt, @userApproved, @forgottenAt)`,
    );
    for (const m of data.memories) {
      if (!characterIds.has(m.characterId)) continue;
      insertMemory.run({ ...m, userApproved: m.userApproved ? 1 : 0 });
    }
    const insertSummary = db.prepare(
      `INSERT INTO summaries (session_id, summary, key_events, emotional_beat, updated_at)
       VALUES (@sessionId, @summary, @keyEvents, @emotionalBeat, @updatedAt)`,
    );
    for (const s of data.summaries) {
      if (!sessionIds.has(s.sessionId)) continue;
      insertSummary.run({ ...s, keyEvents: JSON.stringify(s.keyEvents) });
    }
    const insertLore = db.prepare(
      `INSERT INTO lore (id, character_id, keys, content, enabled, insertion_order, created_at)
       VALUES (@id, @characterId, @keys, @content, @enabled, @insertionOrder, @createdAt)`,
    );
    const insertLoreCharacter = db.prepare("INSERT INTO lore_characters (lore_id, character_id) VALUES (?, ?)");
    for (const entry of data.lore) {
      if (entry.characterId !== null && !characterIds.has(entry.characterId)) continue;
      insertLore.run({ ...entry, keys: JSON.stringify(entry.keys), enabled: entry.enabled ? 1 : 0 });
      if (entry.characterId) insertLoreCharacter.run(entry.id, entry.characterId);
    }
    db.prepare("INSERT INTO settings (id, payload) VALUES ('harness', ?)").run(JSON.stringify(data.settings));
    db.prepare("INSERT INTO provider (id, payload) VALUES ('provider', ?)").run(JSON.stringify(data.provider));
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('legacyMigratedAt', ?)").run(
      dependencies.clock.now().toISOString(),
    );
  });
  run(legacy);
  markLegacyMigrated(dir);
}
