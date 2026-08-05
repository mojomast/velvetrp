import type DatabaseDriver from "better-sqlite3";
import { systemRuntime } from "../runtime.js";
import type { Clock, IdGenerator } from "../runtime.js";
import type { Character, CreateCharacterInput } from "../types.js";
import { repairLoreForCharacterDeletionSync } from "./loreRepo.js";
import { getRepositoryDatabase } from "./repoContext.js";

interface CharacterRow {
  id: string;
  name: string;
  age: number;
  archetype: string;
  boundaries: string;
  safe_word: string;
  fictional_confirmed: number;
  is_real_person: number;
  created_at: string;
}

export function characterFromRow(row: CharacterRow): Character {
  return {
    id: row.id,
    name: row.name,
    age: row.age,
    archetype: row.archetype,
    boundaries: row.boundaries,
    safeWord: row.safe_word,
    fictionalConfirmed: row.fictional_confirmed === 1,
    isRealPerson: row.is_real_person === 1,
    createdAt: row.created_at,
  };
}

/** Synchronous creation path used by the Repository factory. */
export function createCharacterSync(
  db: DatabaseDriver.Database,
  dependencies: { clock: Clock; ids: IdGenerator },
  input: CreateCharacterInput,
): Character {
  const character: Character = {
    id: dependencies.ids.nextId(),
    name: input.name,
    age: input.age,
    archetype: input.archetype,
    boundaries: input.boundaries,
    safeWord: input.safeWord,
    fictionalConfirmed: input.fictionalConfirmed,
    isRealPerson: false,
    createdAt: dependencies.clock.now().toISOString(),
  };
  db.prepare(
    `INSERT INTO characters (id, name, age, archetype, boundaries, safe_word, fictional_confirmed, is_real_person, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    character.id,
    character.name,
    character.age,
    character.archetype,
    character.boundaries,
    character.safeWord,
    character.fictionalConfirmed ? 1 : 0,
    character.isRealPerson ? 1 : 0,
    character.createdAt,
  );
  return character;
}

export async function listCharacters(): Promise<Character[]> {
  const rows = getRepositoryDatabase()
    .prepare("SELECT * FROM characters ORDER BY created_at ASC, rowid ASC")
    .all() as CharacterRow[];
  return rows.map(characterFromRow);
}

export async function getCharacter(id: string): Promise<Character | null> {
  const row = getRepositoryDatabase().prepare("SELECT * FROM characters WHERE id = ?").get(id) as
    | CharacterRow
    | undefined;
  return row ? characterFromRow(row) : null;
}

export async function createCharacter(input: CreateCharacterInput): Promise<Character> {
  return createCharacterSync(getRepositoryDatabase(), systemRuntime, input);
}

export async function updateCharacter(id: string, input: CreateCharacterInput): Promise<Character | null> {
  const db = getRepositoryDatabase();
  const exists = db.prepare("SELECT id FROM characters WHERE id = ?").get(id);
  if (!exists) return null;
  db.prepare(`UPDATE characters SET name = ?, age = ?, archetype = ?, boundaries = ?, safe_word = ?,
    fictional_confirmed = ?, is_real_person = 0 WHERE id = ?`).run(
    input.name, input.age, input.archetype, input.boundaries, input.safeWord, input.fictionalConfirmed ? 1 : 0, id,
  );
  return getCharacter(id);
}

/** Refuses to remove characters referenced by sessions or campaigns. */
export async function deleteCharacter(id: string): Promise<"deleted" | "in-use" | "not-found"> {
  const db = getRepositoryDatabase();
  const run = db.transaction(() => {
    if (!db.prepare("SELECT id FROM characters WHERE id = ?").get(id)) return "not-found" as const;
    const used = db.prepare(`SELECT 1 FROM sessions WHERE character_id = ?
      UNION ALL SELECT 1 FROM session_characters WHERE character_id = ?
      UNION ALL SELECT 1 FROM campaign_characters WHERE character_id = ?
      UNION ALL SELECT 1 FROM character_drafts_v19 WHERE persona_id = ? LIMIT 1`).get(id, id, id, id);
    if (used) return "in-use" as const;

    repairLoreForCharacterDeletionSync(db, id);
    db.prepare("DELETE FROM characters WHERE id = ?").run(id);
    return "deleted" as const;
  });
  return run.immediate();
}
