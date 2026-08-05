import { randomUUID } from "node:crypto";
import { now } from "../defaults.js";
import type { MemoryFact, MemoryKind, NewMemoryFact } from "../types.js";
import { getRepositoryDatabase } from "./repoContext.js";

interface MemoryRow {
  id: string;
  character_id: string;
  kind: string;
  content: string;
  source_turn_id: string;
  created_at: string;
  user_approved: number;
  forgotten_at: string | null;
}

function toMemory(row: MemoryRow): MemoryFact {
  return {
    id: row.id,
    characterId: row.character_id,
    kind: row.kind as MemoryKind,
    content: row.content,
    sourceTurnId: row.source_turn_id,
    createdAt: row.created_at,
    userApproved: row.user_approved === 1,
    forgottenAt: row.forgotten_at,
  };
}

export async function addMemoryFacts(characterId: string, facts: NewMemoryFact[]): Promise<MemoryFact[]> {
  const db = getRepositoryDatabase();
  const seen = new Set<string>();
  const existing = db.prepare(
    "SELECT 1 FROM memories WHERE character_id = ? AND forgotten_at IS NULL AND lower(trim(content)) = lower(trim(?)) LIMIT 1",
  );
  const uniqueFacts = facts.filter((fact) => {
    const key = fact.content.trim().toLocaleLowerCase();
    if (!key || seen.has(key) || existing.get(characterId, fact.content)) return false;
    seen.add(key);
    return true;
  });
  const created: MemoryFact[] = uniqueFacts.map((fact) => ({
    id: randomUUID(),
    characterId,
    kind: fact.kind,
    content: fact.content,
    sourceTurnId: fact.sourceTurnId,
    createdAt: now(),
    userApproved: fact.userApproved,
    forgottenAt: null,
  }));
  if (created.length === 0) return created;
  const insert = db.prepare(
    `INSERT INTO memories (id, character_id, kind, content, source_turn_id, created_at, user_approved, forgotten_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const run = db.transaction((rows: MemoryFact[]) => {
    for (const row of rows) {
      insert.run(
        row.id,
        row.characterId,
        row.kind,
        row.content,
        row.sourceTurnId,
        row.createdAt,
        row.userApproved ? 1 : 0,
        row.forgottenAt,
      );
    }
  });
  run(created);
  return created;
}

export async function listApprovedMemories(characterId: string, limit = 8): Promise<MemoryFact[]> {
  const rows = getRepositoryDatabase()
    .prepare(
      `SELECT * FROM memories
       WHERE character_id = ? AND user_approved = 1 AND forgotten_at IS NULL
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(characterId, limit) as MemoryRow[];
  return rows.map(toMemory);
}

export async function listAllMemories(characterId: string): Promise<MemoryFact[]> {
  const rows = getRepositoryDatabase()
    .prepare(
      `SELECT * FROM memories
       WHERE character_id = ?
       ORDER BY created_at DESC, rowid DESC`,
    )
    .all(characterId) as MemoryRow[];
  return rows.map(toMemory);
}

export async function setMemoryApproval(id: string, userApproved: boolean): Promise<MemoryFact | null> {
  const db = getRepositoryDatabase();
  const row = db.prepare("SELECT * FROM memories WHERE id = ? AND forgotten_at IS NULL").get(id) as MemoryRow | undefined;
  if (!row) return null;
  db.prepare("UPDATE memories SET user_approved = ? WHERE id = ?").run(userApproved ? 1 : 0, id);
  return toMemory({ ...row, user_approved: userApproved ? 1 : 0 });
}

export async function getMemory(id: string): Promise<MemoryFact | null> {
  const row = getRepositoryDatabase().prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
  return row ? toMemory(row) : null;
}

export async function updateMemory(
  id: string,
  patch: Partial<Pick<MemoryFact, "content" | "kind" | "userApproved" | "forgottenAt">>,
): Promise<MemoryFact | null> {
  const current = await getMemory(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  getRepositoryDatabase().prepare("UPDATE memories SET kind = ?, content = ?, user_approved = ?, forgotten_at = ? WHERE id = ?").run(
    next.kind, next.content, next.userApproved ? 1 : 0, next.forgottenAt, id,
  );
  return getMemory(id);
}

export async function restoreMemory(id: string): Promise<MemoryFact | null> {
  return updateMemory(id, { forgottenAt: null });
}

export async function forgetMemory(id: string): Promise<MemoryFact | null> {
  const db = getRepositoryDatabase();
  const row = db.prepare("SELECT * FROM memories WHERE id = ? AND forgotten_at IS NULL").get(id) as MemoryRow | undefined;
  if (!row) return null;
  const forgottenAt = now();
  db.prepare("UPDATE memories SET forgotten_at = ? WHERE id = ?").run(forgottenAt, id);
  return toMemory({ ...row, forgotten_at: forgottenAt });
}
