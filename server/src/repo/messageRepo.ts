import type DatabaseDriver from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { now } from "../defaults.js";
import type { AddMessageOptions, Message, MessageRole, Session } from "../types.js";
import { getRepositoryDatabase } from "./repoContext.js";
import { getSession } from "./sessionRepo.js";

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  speaker_character_id: string | null;
  content: string;
  parent_id: string | null;
  swipe_group_id: string | null;
  swipe_index: number;
  seq: number;
  status: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  usage_source: string | null;
  usage_model: string | null;
  created_at: string;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    speakerCharacterId: row.speaker_character_id,
    content: row.content,
    parentId: row.parent_id,
    swipeGroupId: row.swipe_group_id,
    swipeIndex: row.swipe_index,
    seq: row.seq,
    status: row.status === "aborted" ? "aborted" : "final",
    createdAt: row.created_at,
    usage:
      row.prompt_tokens !== null && row.completion_tokens !== null && row.total_tokens !== null && row.usage_model
        ? {
            promptTokens: row.prompt_tokens,
            completionTokens: row.completion_tokens,
            totalTokens: row.total_tokens,
            source: row.usage_source === "provider" ? "provider" : "estimated",
            model: row.usage_model,
          }
        : null,
  };
}

function messageRowsForSession(db: DatabaseDriver.Database, sessionId: string): MessageRow[] {
  return db
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC, created_at ASC, rowid ASC")
    .all(sessionId) as MessageRow[];
}

export async function getMessage(sessionId: string, messageId: string): Promise<Message | null> {
  const row = getRepositoryDatabase().prepare("SELECT * FROM messages WHERE session_id = ? AND id = ?").get(sessionId, messageId) as
    | MessageRow
    | undefined;
  return row ? toMessage(row) : null;
}

export async function getActiveLeaf(sessionId: string): Promise<Message | null> {
  const db = getRepositoryDatabase();
  const session = db.prepare("SELECT active_leaf_id FROM sessions WHERE id = ?").get(sessionId) as
    | { active_leaf_id: string | null }
    | undefined;
  if (!session) return null;
  if (session.active_leaf_id) {
    const row = db.prepare("SELECT * FROM messages WHERE id = ? AND session_id = ?").get(session.active_leaf_id, sessionId) as
      | MessageRow
      | undefined;
    if (row) return toMessage(row);
  }
  const fallback = db
    .prepare("SELECT * FROM messages WHERE session_id = ? AND status = 'final' ORDER BY seq DESC, rowid DESC LIMIT 1")
    .get(sessionId) as MessageRow | undefined;
  return fallback ? toMessage(fallback) : null;
}

export async function listBranchMessages(sessionId: string, leafId: string): Promise<Message[]> {
  const rows = messageRowsForSession(getRepositoryDatabase(), sessionId);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const path: MessageRow[] = [];
  const seen = new Set<string>();
  let cursor: MessageRow | undefined = byId.get(leafId);
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    path.push(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  path.reverse();
  return path.map(toMessage);
}

export async function listMessages(sessionId: string): Promise<Message[]> {
  const db = getRepositoryDatabase();
  const session = db.prepare("SELECT active_leaf_id FROM sessions WHERE id = ?").get(sessionId) as
    | { active_leaf_id: string | null }
    | undefined;
  if (session?.active_leaf_id) return listBranchMessages(sessionId, session.active_leaf_id);
  return messageRowsForSession(db, sessionId).map(toMessage);
}

export async function listBranchChildren(sessionId: string, parentId: string | null): Promise<Message[]> {
  const rows = getRepositoryDatabase()
    .prepare(
      `SELECT * FROM messages
       WHERE session_id = ? AND parent_id IS ?
       ORDER BY swipe_index ASC, seq ASC, rowid ASC`,
    )
    .all(sessionId, parentId) as MessageRow[];
  return rows.map(toMessage);
}

export async function nextSwipeIndex(sessionId: string, swipeGroupId: string): Promise<number> {
  const row = getRepositoryDatabase()
    .prepare("SELECT COALESCE(MAX(swipe_index), -1) AS maxIndex FROM messages WHERE session_id = ? AND swipe_group_id = ?")
    .get(sessionId, swipeGroupId) as { maxIndex: number };
  return row.maxIndex + 1;
}

export async function setActiveBranch(sessionId: string, leafId: string): Promise<Session | null> {
  const db = getRepositoryDatabase();
  const message = db.prepare("SELECT id FROM messages WHERE id = ? AND session_id = ?").get(leafId, sessionId) as
    | { id: string }
    | undefined;
  if (!message) return null;
  db.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?").run(leafId, sessionId);
  return getSession(sessionId);
}

export async function addMessage(
  sessionId: string,
  role: MessageRole,
  content: string,
  opts: AddMessageOptions = {},
): Promise<Message> {
  const db = getRepositoryDatabase();
  const status = opts.status ?? "final";
  const parentId = opts.parentId !== undefined ? opts.parentId : ((await getActiveLeaf(sessionId))?.id ?? null);
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM messages WHERE session_id = ?").get(sessionId) as {
    maxSeq: number;
  };
  const message: Message = {
    id: randomUUID(),
    sessionId,
    role,
    speakerCharacterId: role === "character" ? (opts.speakerCharacterId ?? null) : null,
    content,
    parentId,
    swipeGroupId: opts.swipeGroupId ?? null,
    swipeIndex: opts.swipeIndex ?? 0,
    seq: maxSeq.maxSeq + 1,
    status,
    createdAt: now(),
    usage: opts.usage ?? null,
  };
  if (!message.swipeGroupId) message.swipeGroupId = message.id;
  const run = db.transaction(() => {
    db.prepare(
       `INSERT INTO messages (id, session_id, role, speaker_character_id, content, parent_id, swipe_group_id, swipe_index, seq, status,
          prompt_tokens, completion_tokens, total_tokens, usage_source, usage_model, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      message.id,
      message.sessionId,
      message.role,
      message.speakerCharacterId,
      message.content,
      message.parentId,
      message.swipeGroupId,
      message.swipeIndex,
      message.seq,
      message.status,
      message.usage?.promptTokens ?? null,
      message.usage?.completionTokens ?? null,
      message.usage?.totalTokens ?? null,
      message.usage?.source ?? null,
      message.usage?.model ?? null,
      message.createdAt,
    );
    // The active leaf and usage event commit with the message so session and
    // message domains cannot expose a partially-applied turn.
    if (status === "final") db.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?").run(message.id, sessionId);
    if (message.usage) {
      db.prepare(`INSERT INTO usage_events (id, session_id, source_message_id, kind, prompt_tokens, completion_tokens, total_tokens, usage_source, usage_model, created_at)
        VALUES (?, ?, ?, 'character_reply', ?, ?, ?, ?, ?, ?)`).run(
          randomUUID(), sessionId, message.id, message.usage.promptTokens, message.usage.completionTokens,
          message.usage.totalTokens, message.usage.source, message.usage.model, message.createdAt,
        );
    }
  });
  run();
  return message;
}
