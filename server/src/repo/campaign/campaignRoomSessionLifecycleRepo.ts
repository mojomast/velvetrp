// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { utcIsoTimestampSchema } from "@velvet/contracts";

interface CampaignRoomSessionIntegrityRow {
  session_id: string;
  character_id: string;
  primary_character_presence: string | null;
  title: string;
  state: string;
  created_at: string;
  stopped_at: string | null;
  stop_reason_kind: unknown;
  participant_names: string;
  participant_count: unknown;
  joined_character_count: unknown;
  primary_participant_count: unknown;
  distinct_character_count: unknown;
  distinct_position_count: unknown;
  malformed_position_count: unknown;
  minimum_position: unknown;
  maximum_position: unknown;
}

const RUNNING_CAMPAIGN_ROOM_STATES = ["setup", "active", "paused", "cooldown"] as const;

export interface CampaignRoomSessionLifecycleRepository {
  getCampaignRoomSessionLifecycle(sessionId: string): "running" | "stopped" | null;
}

export function projectLegacyRoomText(value: unknown, nullable: boolean): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    if (nullable) return null;
    throw new Error("campaign room summary is malformed");
  }
  let projected = "";
  for (let index = 0; index < value.length;) {
    const first = value.charCodeAt(index);
    let width = 1;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) throw new Error("campaign room summary is malformed");
      width = 2;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new Error("campaign room summary is malformed");
    }
    if (projected.length + width > 200) break;
    projected += value.slice(index, index + width);
    index += width;
  }
  if (projected.trim().length === 0) {
    const trimmed = value.trimStart();
    return projectLegacyRoomText(trimmed, nullable);
  }
  return projected;
}

/** Factory-local room lifecycle validator for campaign linking and administration. */
export function createCampaignRoomSessionLifecycleRepository(
  db: DatabaseDriver.Database,
): CampaignRoomSessionLifecycleRepository {
  const getIntegrityRow = (sessionId: string): CampaignRoomSessionIntegrityRow | undefined =>
    db.prepare(`SELECT target_session.id AS session_id, target_session.character_id,
      primary_character.id AS primary_character_presence, target_session.title,
      target_session.state, target_session.created_at, target_session.stopped_at,
      CASE WHEN target_session.stop_reason IS NULL THEN 0
        WHEN typeof(target_session.stop_reason) = 'text'
          AND length(trim(target_session.stop_reason)) > 0 THEN 1 ELSE 2 END AS stop_reason_kind,
      COALESCE((SELECT json_group_array(participant_name) FROM (
        SELECT character.name AS participant_name
        FROM session_characters participant
        JOIN characters character ON character.id = participant.character_id
        WHERE participant.session_id = target_session.id
        ORDER BY participant.position ASC
        LIMIT 13
      )), '[]') AS participant_names,
      (SELECT COUNT(*) FROM session_characters participant
        WHERE participant.session_id = target_session.id) AS participant_count,
      (SELECT COUNT(*) FROM session_characters participant
        JOIN characters character ON character.id = participant.character_id
        WHERE participant.session_id = target_session.id) AS joined_character_count,
      (SELECT COUNT(*) FROM session_characters participant
        WHERE participant.session_id = target_session.id
          AND participant.character_id = target_session.character_id) AS primary_participant_count,
      (SELECT COUNT(DISTINCT participant.character_id) FROM session_characters participant
        WHERE participant.session_id = target_session.id) AS distinct_character_count,
      (SELECT COUNT(DISTINCT participant.position) FROM session_characters participant
        WHERE participant.session_id = target_session.id) AS distinct_position_count,
      (SELECT COUNT(*) FROM session_characters participant
        WHERE participant.session_id = target_session.id
          AND typeof(participant.position) <> 'integer') AS malformed_position_count,
      (SELECT MIN(participant.position) FROM session_characters participant
        WHERE participant.session_id = target_session.id) AS minimum_position,
      (SELECT MAX(participant.position) FROM session_characters participant
        WHERE participant.session_id = target_session.id) AS maximum_position
    FROM sessions target_session
    LEFT JOIN characters primary_character ON primary_character.id = target_session.character_id
    WHERE target_session.id = ?`).get(sessionId) as CampaignRoomSessionIntegrityRow | undefined;

  const validateIntegrity = (row: CampaignRoomSessionIntegrityRow): "running" | "stopped" => {
    if (row.primary_character_presence !== row.character_id
      || !Number.isInteger(row.participant_count) || (row.participant_count as number) < 1
      || (row.participant_count as number) > 12
      || row.joined_character_count !== row.participant_count
      || row.primary_participant_count !== 1
      || row.distinct_character_count !== row.participant_count
      || row.distinct_position_count !== row.participant_count
      || row.malformed_position_count !== 0
      || row.minimum_position !== 0
      || row.maximum_position !== (row.participant_count as number) - 1) {
      throw new Error("campaign room session graph is malformed");
    }
    let names: unknown;
    try {
      names = JSON.parse(row.participant_names);
    } catch {
      throw new Error("campaign room session graph is malformed");
    }
    if (!Array.isArray(names) || names.length !== row.participant_count) {
      throw new Error("campaign room session graph is malformed");
    }
    try {
      projectLegacyRoomText(row.title, true);
      for (const name of names) projectLegacyRoomText(name, false);
      const createdAt = utcIsoTimestampSchema.parse(row.created_at);
      const running = (RUNNING_CAMPAIGN_ROOM_STATES as readonly string[]).includes(row.state)
        && row.stopped_at === null && row.stop_reason_kind === 0;
      if (running) return "running";
      if (row.state === "closed" && row.stopped_at !== null && row.stop_reason_kind === 1) {
        const stoppedAt = utcIsoTimestampSchema.parse(row.stopped_at);
        if (stoppedAt < createdAt) throw new Error("invalid stopped provenance");
        return "stopped";
      }
    } catch {
      throw new Error("campaign room session graph is malformed");
    }
    throw new Error("campaign room session graph is malformed");
  };

  return {
    getCampaignRoomSessionLifecycle(sessionId) {
      const row = getIntegrityRow(sessionId);
      return row ? validateIntegrity(row) : null;
    },
  };
}
