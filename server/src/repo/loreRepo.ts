import type DatabaseDriver from "better-sqlite3";
import { systemRuntime } from "../runtime.js";
import type { Clock, IdGenerator } from "../runtime.js";
import type { LoreEntry, NewLoreEntry } from "../types.js";
import { getRepositoryDatabase } from "./repoContext.js";

interface LoreRow {
  id: string;
  character_id: string | null;
  keys: string;
  content: string;
  enabled: number;
  insertion_order: number;
  created_at: string;
}

function loreCharacterIds(db: DatabaseDriver.Database, loreId: string): string[] {
  const rows = db.prepare("SELECT character_id FROM lore_characters WHERE lore_id = ? ORDER BY rowid ASC").all(loreId) as Array<{ character_id: string }>;
  return rows.map((row) => row.character_id);
}

function toLore(row: LoreRow, characterIds: string[] = row.character_id ? [row.character_id] : []): LoreEntry {
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(row.keys) as unknown;
    if (Array.isArray(parsed)) keys = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    keys = [];
  }
  return {
    id: row.id,
    characterId: row.character_id,
    characterIds,
    keys,
    content: row.content,
    enabled: row.enabled === 1,
    insertionOrder: row.insertion_order,
    createdAt: row.created_at,
  };
}

/** Keeps the legacy primary lore pointer coherent before character cascades remove associations. */
export function repairLoreForCharacterDeletionSync(db: DatabaseDriver.Database, characterId: string): void {
  db.prepare(`UPDATE lore SET character_id = (
    SELECT lc.character_id FROM lore_characters lc WHERE lc.lore_id = lore.id AND lc.character_id <> ? LIMIT 1
  ) WHERE character_id = ? AND EXISTS (
    SELECT 1 FROM lore_characters lc WHERE lc.lore_id = lore.id AND lc.character_id <> ?
  )`).run(characterId, characterId, characterId);
  db.prepare("DELETE FROM lore WHERE character_id = ? AND NOT EXISTS (SELECT 1 FROM lore_characters WHERE lore_id = lore.id AND character_id <> ?)")
    .run(characterId, characterId);
}

export function createLoreEntrySync(
  db: DatabaseDriver.Database,
  dependencies: { clock: Clock; ids: IdGenerator },
  input: NewLoreEntry,
): LoreEntry {
  const characterIds = input.characterIds ?? (input.characterId ? [input.characterId] : []);
  const entry: LoreEntry = {
    id: dependencies.ids.nextId(),
    characterId: characterIds[0] ?? null,
    characterIds,
    keys: input.keys.map((key) => key.trim()).filter((key) => key.length > 0).slice(0, 8),
    content: input.content.trim().slice(0, 1200),
    enabled: input.enabled,
    insertionOrder: Number.isFinite(input.insertionOrder) ? input.insertionOrder : 100,
    createdAt: dependencies.clock.now().toISOString(),
  };
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO lore (id, character_id, keys, content, enabled, insertion_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(entry.id, entry.characterId, JSON.stringify(entry.keys), entry.content, entry.enabled ? 1 : 0, entry.insertionOrder, entry.createdAt);
    const insert = db.prepare("INSERT INTO lore_characters (lore_id, character_id) VALUES (?, ?)");
    entry.characterIds.forEach((id) => insert.run(entry.id, id));
  });
  run();
  return entry;
}

export async function listLoreEntries(characterId?: string | string[]): Promise<LoreEntry[]> {
  const db = getRepositoryDatabase();
  const ids = characterId === undefined ? null : Array.isArray(characterId) ? characterId : [characterId];
  let rows: LoreRow[];
  if (ids === null) {
    rows = db.prepare("SELECT * FROM lore ORDER BY insertion_order ASC, rowid ASC").all() as LoreRow[];
  } else if (ids.length === 0) {
    rows = db.prepare("SELECT * FROM lore WHERE NOT EXISTS (SELECT 1 FROM lore_characters lc WHERE lc.lore_id = lore.id) ORDER BY insertion_order ASC, rowid ASC").all() as LoreRow[];
  } else {
    const placeholders = ids.map(() => "?").join(", ");
    rows = db.prepare(`SELECT DISTINCT lore.* FROM lore WHERE
      NOT EXISTS (SELECT 1 FROM lore_characters lc WHERE lc.lore_id = lore.id)
      OR EXISTS (SELECT 1 FROM lore_characters lc WHERE lc.lore_id = lore.id AND lc.character_id IN (${placeholders}))
      ORDER BY insertion_order ASC, rowid ASC`).all(...ids) as LoreRow[];
  }
  return rows.map((row) => toLore(row, loreCharacterIds(db, row.id)));
}

export async function createLoreEntry(input: NewLoreEntry): Promise<LoreEntry> {
  return createLoreEntrySync(getRepositoryDatabase(), systemRuntime, input);
}

export async function getLoreEntry(id: string): Promise<LoreEntry | null> {
  const db = getRepositoryDatabase();
  const row = db.prepare("SELECT * FROM lore WHERE id = ?").get(id) as LoreRow | undefined;
  return row ? toLore(row, loreCharacterIds(db, id)) : null;
}

export async function updateLoreEntry(id: string, input: NewLoreEntry): Promise<LoreEntry | null> {
  const db = getRepositoryDatabase();
  const existing = await getLoreEntry(id);
  if (!existing) return null;
  const ids = input.characterIds ?? (input.characterId ? [input.characterId] : []);
  const keys = input.keys.map((key) => key.trim()).filter(Boolean).slice(0, 8);
  const content = input.content.trim().slice(0, 1200);
  const run = db.transaction(() => {
    db.prepare("UPDATE lore SET character_id = ?, keys = ?, content = ?, enabled = ?, insertion_order = ? WHERE id = ?").run(
      ids[0] ?? null, JSON.stringify(keys), content, input.enabled ? 1 : 0,
      Number.isFinite(input.insertionOrder) ? input.insertionOrder : 100, id,
    );
    db.prepare("DELETE FROM lore_characters WHERE lore_id = ?").run(id);
    const insert = db.prepare("INSERT INTO lore_characters (lore_id, character_id) VALUES (?, ?)");
    ids.forEach((characterId) => insert.run(id, characterId));
  });
  run();
  return getLoreEntry(id);
}

export async function deleteLoreEntry(id: string): Promise<boolean> {
  return getRepositoryDatabase().prepare("DELETE FROM lore WHERE id = ?").run(id).changes > 0;
}
