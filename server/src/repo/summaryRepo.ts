import { now } from "../defaults.js";
import type { EpisodeSummary } from "../types.js";
import { getRepositoryDatabase } from "./repoContext.js";

interface SummaryRow {
  session_id: string;
  summary: string;
  key_events: string;
  emotional_beat: string;
  updated_at: string;
}

function toSummary(row: SummaryRow): EpisodeSummary {
  let keyEvents: string[] = [];
  try {
    const parsed = JSON.parse(row.key_events) as unknown;
    if (Array.isArray(parsed)) keyEvents = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    keyEvents = [];
  }
  return {
    sessionId: row.session_id,
    summary: row.summary,
    keyEvents,
    emotionalBeat: row.emotional_beat,
    updatedAt: row.updated_at,
  };
}

export async function getSummary(sessionId: string): Promise<EpisodeSummary | null> {
  const row = getRepositoryDatabase().prepare("SELECT * FROM summaries WHERE session_id = ?").get(sessionId) as
    | SummaryRow
    | undefined;
  return row ? toSummary(row) : null;
}

export async function upsertSummary(
  sessionId: string,
  summary: Omit<EpisodeSummary, "sessionId" | "updatedAt">,
): Promise<EpisodeSummary> {
  const next: EpisodeSummary = { sessionId, ...summary, updatedAt: now() };
  getRepositoryDatabase()
    .prepare(
      `INSERT INTO summaries (session_id, summary, key_events, emotional_beat, updated_at)
       VALUES (@sessionId, @summary, @keyEvents, @emotionalBeat, @updatedAt)
       ON CONFLICT(session_id) DO UPDATE SET
         summary = excluded.summary,
         key_events = excluded.key_events,
         emotional_beat = excluded.emotional_beat,
         updated_at = excluded.updated_at`,
    )
    .run({ ...next, keyEvents: JSON.stringify(next.keyEvents) });
  return next;
}

export async function deleteSummary(sessionId: string): Promise<void> {
  getRepositoryDatabase().prepare("DELETE FROM summaries WHERE session_id = ?").run(sessionId);
}
