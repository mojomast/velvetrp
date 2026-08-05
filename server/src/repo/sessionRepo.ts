import type DatabaseDriver from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { now } from "../defaults.js";
import { systemRuntime } from "../runtime.js";
import type { Clock, IdGenerator } from "../runtime.js";
import type {
  Character,
  ConsentEvent,
  CreateSessionInput,
  SceneState,
  Session,
} from "../types.js";
import { characterFromRow } from "./characterRepo.js";
import { getRepositoryDatabase } from "./repoContext.js";

interface SessionRow {
  id: string;
  character_id: string;
  title: string;
  state: string;
  preset_id: string;
  active_leaf_id: string | null;
  created_at: string;
  stopped_at: string | null;
  stop_reason: string | null;
}

interface ConsentRow {
  id: string;
  session_id: string;
  seq: number;
  at: string;
  scope: string;
  granted: number;
  note: string;
}

interface CharacterRow {
  id: string;
  name: string;
  age: number;
  archetype: string;
  boundaries: string;
  fictional_confirmed: number;
  is_real_person: number;
  created_at: string;
}

export interface SessionRepositoryDependencies {
  clock: Clock;
  ids: IdGenerator;
}

type SessionStopUnitOfWork = {
  addConsentEvent(sessionId: string, scope: string, granted: boolean, note: string): ConsentEvent | null;
  transitionSession(id: string, state: SceneState, reason: string): Session | null;
};

function toConsentEvent(row: ConsentRow): ConsentEvent {
  return { id: row.id, at: row.at, scope: row.scope, granted: row.granted === 1, note: row.note };
}

function participantsFor(db: DatabaseDriver.Database, sessionId: string): Character[] {
  const rows = db.prepare(`SELECT c.* FROM characters c
    JOIN session_characters sc ON sc.character_id = c.id
    WHERE sc.session_id = ? ORDER BY sc.position ASC, sc.rowid ASC`).all(sessionId) as CharacterRow[];
  return rows.map(characterFromRow);
}

function consentLogFor(db: DatabaseDriver.Database, sessionId: string): ConsentEvent[] {
  const rows = db
    .prepare("SELECT * FROM consent_events WHERE session_id = ? ORDER BY seq ASC, rowid ASC")
    .all(sessionId) as ConsentRow[];
  return rows.map(toConsentEvent);
}

function sessionFromRow(db: DatabaseDriver.Database, row: SessionRow): Session {
  // Preserve the established aggregate read order: consent, then participants.
  const consentLog = consentLogFor(db, row.id);
  const participants = participantsFor(db, row.id);
  return {
    id: row.id,
    characterId: row.character_id,
    primaryCharacterId: row.character_id,
    participants,
    title: row.title,
    state: row.state as SceneState,
    presetId: row.preset_id,
    consentLog,
    activeLeafId: row.active_leaf_id,
    createdAt: row.created_at,
    stoppedAt: row.stopped_at,
    stopReason: row.stop_reason,
  };
}

/** Synchronous session reads support repository transactions and cross-domain branch updates. */
export function getSessionSync(db: DatabaseDriver.Database, id: string): Session | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  return row ? sessionFromRow(db, row) : null;
}

export function updateSessionContextSourceSync(
  db: DatabaseDriver.Database,
  clock: Clock,
  sessionId: string,
  sourceOfTruth: string,
): { sourceOfTruth: string; updatedAt: string } {
  const updatedAt = clock.now().toISOString();
  db.prepare(`INSERT INTO session_context (session_id, source_of_truth, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET source_of_truth = excluded.source_of_truth, updated_at = excluded.updated_at`)
    .run(sessionId, sourceOfTruth, updatedAt);
  return { sourceOfTruth, updatedAt };
}

export function transitionSessionSync(
  db: DatabaseDriver.Database,
  clock: Clock,
  id: string,
  state: SceneState,
  reason: string,
): Session | null {
  const existing = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  if (!existing) return null;
  const stoppedAt = state === "closed" && !existing.stopped_at ? clock.now().toISOString() : existing.stopped_at;
  const stopReason = state === "closed" && !existing.stopped_at ? reason : existing.stop_reason;
  db.prepare("UPDATE sessions SET state = ?, stopped_at = ?, stop_reason = ? WHERE id = ?").run(
    state,
    stoppedAt,
    stopReason,
    id,
  );
  return getSessionSync(db, id);
}

export function addConsentEventSync(
  db: DatabaseDriver.Database,
  dependencies: SessionRepositoryDependencies,
  sessionId: string,
  scope: string,
  granted: boolean,
  note: string,
): ConsentEvent | null {
  const existing = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId) as { id: string } | undefined;
  if (!existing) return null;
  const event: ConsentEvent = {
    id: dependencies.ids.nextId(),
    at: dependencies.clock.now().toISOString(),
    scope,
    granted,
    note,
  };
  const maxSeq = db.prepare("SELECT COALESCE(MAX(seq), -1) AS maxSeq FROM consent_events WHERE session_id = ?").get(sessionId) as {
    maxSeq: number;
  };
  db.prepare("INSERT INTO consent_events (id, session_id, seq, at, scope, granted, note) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    event.id,
    sessionId,
    maxSeq.maxSeq + 1,
    event.at,
    event.scope,
    event.granted ? 1 : 0,
    event.note,
  );
  return event;
}

/** Keeps consent and terminal state changes composed by the caller's unit of work. */
export function stopSessionSync(repository: SessionStopUnitOfWork, id: string, reason: string): Session | null {
  repository.addConsentEvent(id, "user-stop", false, "User pressed stop; scene closed.");
  return repository.transitionSession(id, "closed", reason);
}

function runSessionTransaction<T>(
  db: DatabaseDriver.Database,
  dependencies: SessionRepositoryDependencies,
  callback: (repository: SessionStopUnitOfWork) => T,
): T {
  let active = true;
  const assertActive = () => {
    if (!active) throw new Error("transaction unit of work is no longer active");
  };
  const unitOfWork: SessionStopUnitOfWork = {
    addConsentEvent: (sessionId, scope, granted, note) => {
      assertActive();
      return addConsentEventSync(db, dependencies, sessionId, scope, granted, note);
    },
    transitionSession: (id, state, reason) => {
      assertActive();
      return transitionSessionSync(db, dependencies.clock, id, state, reason);
    },
  };
  try {
    return db.transaction(() => {
      const result = callback(unitOfWork);
      if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => undefined);
        throw new TypeError("repository transaction callbacks must be synchronous");
      }
      return result;
    })();
  } finally {
    active = false;
  }
}

export async function listSessions(characterId?: string): Promise<Session[]> {
  const db = getRepositoryDatabase();
  const rows = (characterId
    ? db.prepare(`SELECT s.* FROM sessions s JOIN session_characters sc ON sc.session_id = s.id
        WHERE sc.character_id = ? ORDER BY s.created_at ASC, s.rowid ASC`).all(characterId)
    : db.prepare("SELECT * FROM sessions ORDER BY created_at ASC, rowid ASC").all()) as SessionRow[];
  return rows.map((row) => sessionFromRow(db, row));
}

export async function getSession(id: string): Promise<Session | null> {
  return getSessionSync(getRepositoryDatabase(), id);
}

export async function getSessionContextSource(sessionId: string): Promise<{ sourceOfTruth: string; updatedAt: string | null; synthesizedSource: string; synthesizedUpdatedAt: string | null }> {
  const row = getRepositoryDatabase().prepare("SELECT source_of_truth, updated_at, synthesized_source, synthesized_updated_at FROM session_context WHERE session_id = ?").get(sessionId) as
    { source_of_truth: string; updated_at: string; synthesized_source: string; synthesized_updated_at: string | null } | undefined;
  return { sourceOfTruth: row?.source_of_truth ?? "", updatedAt: row?.updated_at ?? null, synthesizedSource: row?.synthesized_source ?? "", synthesizedUpdatedAt: row?.synthesized_updated_at ?? null };
}

export async function updateSessionContextSource(sessionId: string, sourceOfTruth: string): Promise<{ sourceOfTruth: string; updatedAt: string }> {
  return updateSessionContextSourceSync(getRepositoryDatabase(), systemRuntime.clock, sessionId, sourceOfTruth);
}

export async function updateSessionSynthesizedSource(sessionId: string, synthesizedSource: string): Promise<{ synthesizedSource: string; updatedAt: string }> {
  const updatedAt = now();
  getRepositoryDatabase().prepare(`INSERT INTO session_context (session_id, source_of_truth, updated_at, synthesized_source, synthesized_updated_at)
    VALUES (?, '', ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET synthesized_source = excluded.synthesized_source, synthesized_updated_at = excluded.synthesized_updated_at`)
    .run(sessionId, updatedAt, synthesizedSource, updatedAt);
  return { synthesizedSource, updatedAt };
}

export async function createSession(input: CreateSessionInput): Promise<Session> {
  const db = getRepositoryDatabase();
  const ids = input.characterIds ?? (input.characterId ? [input.characterId] : []);
  const primaryCharacterId = input.primaryCharacterId ?? input.characterId ?? ids[0]!;
  const session: Session = {
    id: randomUUID(),
    characterId: primaryCharacterId,
    primaryCharacterId,
    participants: ids.map((id) => ({ id }) as Character),
    title: input.title ?? "",
    state: "setup",
    presetId: input.presetId ?? "default",
    consentLog: [{
      id: randomUUID(),
      at: now(),
      scope: "scene-created",
      granted: true,
      note: "Fictional adult character confirmed at creation.",
    }],
    activeLeafId: null,
    createdAt: now(),
    stoppedAt: null,
    stopReason: null,
  };
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO sessions (id, character_id, title, state, preset_id, active_leaf_id, created_at, stopped_at, stop_reason)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(session.id, session.characterId, session.title, session.state, session.presetId, session.createdAt, null, null);
    const insertParticipant = db.prepare("INSERT INTO session_characters (session_id, character_id, position) VALUES (?, ?, ?)");
    ids.forEach((characterId, position) => insertParticipant.run(session.id, characterId, position));
    const event = session.consentLog[0] as ConsentEvent;
    db.prepare(
      `INSERT INTO consent_events (id, session_id, seq, at, scope, granted, note) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(event.id, session.id, 0, event.at, event.scope, event.granted ? 1 : 0, event.note);
  });
  run();
  return (await getSession(session.id))!;
}

export async function deleteSession(id: string): Promise<boolean> {
  const db = getRepositoryDatabase();
  return db.transaction(() => {
    // Cascades cover child rows; the transaction also resolves the deferred
    // active_leaf_id relationship between sessions and messages.
    return db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
  })();
}

export async function transitionSession(id: string, state: SceneState, reason: string): Promise<Session | null> {
  return transitionSessionSync(getRepositoryDatabase(), systemRuntime.clock, id, state, reason);
}

export async function addConsentEvent(
  sessionId: string,
  scope: string,
  granted: boolean,
  note: string,
): Promise<ConsentEvent | null> {
  return addConsentEventSync(getRepositoryDatabase(), systemRuntime, sessionId, scope, granted, note);
}

export async function stopSession(id: string, reason: string): Promise<Session | null> {
  const db = getRepositoryDatabase();
  return runSessionTransaction(db, systemRuntime, (repository) => stopSessionSync(repository, id, reason));
}
