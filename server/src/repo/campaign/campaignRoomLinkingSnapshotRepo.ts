// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import {
  campaignMembershipReadSchema,
  campaignRoomLinkingResponseSchema,
  MAX_CAMPAIGN_ROOM_SUMMARIES,
  resourceIdSchema,
  utcIsoTimestampSchema,
  type CampaignRoomLinkingResponse,
} from "@velvet/contracts";
import type { CampaignRoomLinkingSnapshot } from "../campaignRepo.js";
import { projectLegacyRoomText } from "./campaignRoomSessionLifecycleRepo.js";

interface CampaignRoomSnapshotRow {
  row_kind: "authority" | "attached" | "eligible";
  campaign_id: string;
  actor_principal_id: string | null;
  actor_role: string | null;
  actor_created_at: string | null;
  actor_parent_id: string | null;
  owner_principal_id: string;
  campaign_owner_role: string;
  owner_membership_principal_id: string | null;
  owner_membership_role: string | null;
  owner_created_at: string | null;
  owner_parent_id: string | null;
  owner_count: unknown;
  session_id: string | null;
  session_presence: string | null;
  title: string | null;
  session_state: string | null;
  created_at: string | null;
  stopped_at: string | null;
  stop_reason_kind: unknown;
  attached_at: string | null;
  participant_names: string | null;
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

const SQL_VALID_STORED_RESOURCE_ID = (column: string): string =>
  `typeof(${column}) = 'text'
    AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND 128
    AND instr(${column}, char(0)) = 0
    AND ${column} NOT GLOB '*[^A-Za-z0-9._:-]*'`;

interface CampaignRoomLinkingSnapshotRepository {
  getCampaignRoomLinkingSnapshot(
    actorPrincipalId: string,
    campaignId: string,
  ): CampaignRoomLinkingSnapshot | null;
}

/** Factory-local reader; presentation remains owned by session integrity. */
export function createCampaignRoomLinkingSnapshotRepository(
  db: DatabaseDriver.Database,
): CampaignRoomLinkingSnapshotRepository {
  return {
    getCampaignRoomLinkingSnapshot(actorPrincipalId, campaignId) {
      const actorId = resourceIdSchema.parse(actorPrincipalId);
      const id = resourceIdSchema.parse(campaignId);
      const rows = db.prepare(`WITH authority AS MATERIALIZED (
      SELECT campaign.id AS campaign_id, campaign.owner_principal_id,
        campaign.owner_role AS campaign_owner_role,
        actor_membership.principal_id AS actor_principal_id,
        actor_membership.role AS actor_role,
        actor_membership.created_at AS actor_created_at,
        actor_parent.id AS actor_parent_id,
        owner_membership.principal_id AS owner_membership_principal_id,
        owner_membership.role AS owner_membership_role,
        owner_membership.created_at AS owner_created_at,
        owner_parent.id AS owner_parent_id,
        (SELECT COUNT(*) FROM campaign_memberships sole_owner
          WHERE sole_owner.campaign_id = campaign.id AND sole_owner.role = 'owner') AS owner_count
      FROM campaigns campaign
      LEFT JOIN campaign_memberships actor_membership
        ON actor_membership.campaign_id = campaign.id AND actor_membership.principal_id = $actorId
      LEFT JOIN principals actor_parent ON actor_parent.id = actor_membership.principal_id
      LEFT JOIN campaign_memberships owner_membership
        ON owner_membership.campaign_id = campaign.id
        AND owner_membership.principal_id = campaign.owner_principal_id
        AND owner_membership.role = 'owner'
      LEFT JOIN principals owner_parent ON owner_parent.id = owner_membership.principal_id
       WHERE campaign.id = $campaignId
     ), authorized AS MATERIALIZED (
       SELECT campaign_id, owner_principal_id, campaign_owner_role,
         actor_principal_id, actor_role, actor_created_at, actor_parent_id,
         owner_membership_principal_id, owner_membership_role, owner_created_at,
         owner_parent_id, owner_count
       FROM authority
       WHERE actor_principal_id = $actorId
         AND actor_parent_id = $actorId
         AND actor_role IN ('owner', 'gm', 'player', 'observer')
         AND (actor_role <> 'owner' OR owner_principal_id = $actorId)
          AND campaign_owner_role = 'owner'
          AND owner_count = 1
          AND ${SQL_VALID_STORED_RESOURCE_ID("owner_principal_id")}
          AND ${SQL_VALID_STORED_RESOURCE_ID("owner_membership_principal_id")}
          AND ${SQL_VALID_STORED_RESOURCE_ID("owner_parent_id")}
          AND owner_membership_principal_id COLLATE BINARY = owner_principal_id COLLATE BINARY
          AND owner_membership_role = 'owner'
          AND owner_parent_id COLLATE BINARY = owner_principal_id COLLATE BINARY
          AND typeof(actor_created_at) = 'text'
         AND strftime('%Y-%m-%dT%H:%M:%fZ', actor_created_at) = actor_created_at
         AND typeof(owner_created_at) = 'text'
         AND strftime('%Y-%m-%dT%H:%M:%fZ', owner_created_at) = owner_created_at
     ), attached_candidates AS MATERIALIZED (
      SELECT attachment.session_id, attachment.attached_at
       FROM authorized
       JOIN campaign_sessions attachment ON attachment.campaign_id = authorized.campaign_id
       ORDER BY attachment.attached_at ASC, attachment.session_id COLLATE BINARY ASC
       LIMIT ${MAX_CAMPAIGN_ROOM_SUMMARIES + 1}
     ), eligible_candidates AS MATERIALIZED (
      SELECT session.id AS session_id, session.created_at
       FROM authorized
       JOIN sessions session
         ON authorized.actor_role = 'owner' AND authorized.owner_principal_id = $actorId
       WHERE session.state <> 'closed' AND session.stopped_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM campaign_sessions linked WHERE linked.session_id = session.id)
       ORDER BY session.created_at ASC, session.id COLLATE BINARY ASC
       LIMIT ${MAX_CAMPAIGN_ROOM_SUMMARIES + 1}
     ), selected AS MATERIALIZED (
      SELECT 'attached' AS row_kind, candidate.session_id, candidate.attached_at,
        candidate.attached_at AS ordering_time
      FROM attached_candidates candidate
      UNION ALL
      SELECT 'eligible', candidate.session_id, NULL, candidate.created_at
      FROM eligible_candidates candidate
    )
    SELECT 'authority' AS row_kind, authority.campaign_id,
      authority.actor_principal_id, authority.actor_role, authority.actor_created_at,
      authority.actor_parent_id, authority.owner_principal_id, authority.campaign_owner_role,
      authority.owner_membership_principal_id, authority.owner_membership_role,
      authority.owner_created_at, authority.owner_parent_id, authority.owner_count,
      NULL AS session_id, NULL AS session_presence, NULL AS title, NULL AS session_state,
       NULL AS created_at, NULL AS stopped_at, NULL AS stop_reason_kind, NULL AS attached_at,
       NULL AS participant_names, NULL AS participant_count, NULL AS joined_character_count,
       NULL AS primary_participant_count, NULL AS distinct_character_count, NULL AS distinct_position_count,
       NULL AS malformed_position_count, NULL AS minimum_position, NULL AS maximum_position,
       0 AS kind_order, '' AS ordering_time
    FROM authority
    UNION ALL
    SELECT selected.row_kind, authority.campaign_id,
      authority.actor_principal_id, authority.actor_role, authority.actor_created_at,
      authority.actor_parent_id, authority.owner_principal_id, authority.campaign_owner_role,
      authority.owner_membership_principal_id, authority.owner_membership_role,
      authority.owner_created_at, authority.owner_parent_id, authority.owner_count,
      selected.session_id, session.id AS session_presence, session.title,
       session.state AS session_state, session.created_at, session.stopped_at,
       CASE WHEN session.stop_reason IS NULL THEN 0
         WHEN typeof(session.stop_reason) = 'text' AND length(trim(session.stop_reason)) > 0 THEN 1
         ELSE 2 END AS stop_reason_kind,
       selected.attached_at,
      COALESCE((SELECT json_group_array(participant_name) FROM (
        SELECT character.name AS participant_name
        FROM session_characters participant
        JOIN characters character ON character.id = participant.character_id
        WHERE participant.session_id = selected.session_id
        ORDER BY participant.position ASC
        LIMIT 13
      )), '[]') AS participant_names,
      (SELECT COUNT(*) FROM session_characters participant
        WHERE participant.session_id = selected.session_id) AS participant_count,
      (SELECT COUNT(*) FROM session_characters participant
        JOIN characters character ON character.id = participant.character_id
        WHERE participant.session_id = selected.session_id) AS joined_character_count,
       (SELECT COUNT(*) FROM session_characters participant
         WHERE participant.session_id = selected.session_id
           AND participant.character_id = session.character_id) AS primary_participant_count,
       (SELECT COUNT(DISTINCT participant.character_id) FROM session_characters participant
         WHERE participant.session_id = selected.session_id) AS distinct_character_count,
       (SELECT COUNT(DISTINCT participant.position) FROM session_characters participant
         WHERE participant.session_id = selected.session_id) AS distinct_position_count,
       (SELECT COUNT(*) FROM session_characters participant
         WHERE participant.session_id = selected.session_id
           AND typeof(participant.position) <> 'integer') AS malformed_position_count,
      (SELECT MIN(participant.position) FROM session_characters participant
        WHERE participant.session_id = selected.session_id) AS minimum_position,
      (SELECT MAX(participant.position) FROM session_characters participant
        WHERE participant.session_id = selected.session_id) AS maximum_position,
      CASE selected.row_kind WHEN 'attached' THEN 1 ELSE 2 END AS kind_order,
      selected.ordering_time
    FROM selected CROSS JOIN authorized AS authority
    LEFT JOIN sessions session ON session.id = selected.session_id
    ORDER BY kind_order ASC, ordering_time ASC, session_id COLLATE BINARY ASC`)
        .all({ actorId, campaignId: id }) as CampaignRoomSnapshotRow[];
      if (rows.length === 0) return null;
      const authority = rows[0]!;
      if (authority.actor_principal_id !== actorId || authority.actor_parent_id !== actorId
        || authority.actor_role === null) return null;
      // These states cannot establish attributable membership. Mask them before
      // parsing any actor-controlled fields, preserving non-disclosure.
      if (!["owner", "gm", "player", "observer"].includes(authority.actor_role)) return null;
      if (authority.actor_role === "owner" && authority.owner_principal_id !== actorId) return null;
      try {
        campaignMembershipReadSchema.parse({
          campaignId: id, principalId: actorId, role: authority.actor_role, createdAt: authority.actor_created_at,
        });
      } catch {
        throw new Error("campaign room linking authority is malformed");
      }
      if (authority.campaign_id !== id || authority.campaign_owner_role !== "owner"
        || authority.owner_count !== 1
        || authority.owner_membership_principal_id !== authority.owner_principal_id
        || authority.owner_membership_role !== "owner"
        || authority.owner_parent_id !== authority.owner_principal_id) {
        throw new Error("campaign room linking authority is malformed");
      }
      try {
        campaignMembershipReadSchema.parse({
          campaignId: id, principalId: authority.owner_principal_id,
          role: authority.owner_membership_role, createdAt: authority.owner_created_at,
        });
      } catch {
        throw new Error("campaign room linking authority is malformed");
      }

      const attached: CampaignRoomLinkingResponse["attached"] = [];
      const eligible: CampaignRoomLinkingResponse["eligible"] = [];
      for (const row of rows.slice(1)) {
        if (row.session_id === null || row.session_presence !== row.session_id
          || row.created_at === null || row.session_state === null
          || !Number.isInteger(row.participant_count) || (row.participant_count as number) < 1
          || (row.participant_count as number) > 12
          || row.joined_character_count !== row.participant_count
          || row.primary_participant_count !== 1
          || row.distinct_character_count !== row.participant_count
          || row.distinct_position_count !== row.participant_count
          || row.malformed_position_count !== 0
          || row.minimum_position !== 0
          || row.maximum_position !== (row.participant_count as number) - 1) {
          throw new Error("campaign room summary is malformed");
        }
        const rawNames = JSON.parse(row.participant_names ?? "null") as unknown;
        if (!Array.isArray(rawNames) || rawNames.length !== row.participant_count) {
          throw new Error("campaign room summary is malformed");
        }
        let createdAt: string;
        try {
          createdAt = utcIsoTimestampSchema.parse(row.created_at);
        } catch {
          throw new Error("campaign room summary is malformed");
        }
        const running = (RUNNING_CAMPAIGN_ROOM_STATES as readonly string[]).includes(row.session_state)
          && row.stopped_at === null && row.stop_reason_kind === 0;
        let stopped = false;
        if (!running && row.session_state === "closed" && row.stopped_at !== null && row.stop_reason_kind === 1) {
          try {
            const stoppedAt = utcIsoTimestampSchema.parse(row.stopped_at);
            if (stoppedAt < createdAt) throw new Error("invalid stopped provenance");
            stopped = true;
          } catch {
            throw new Error("campaign room summary is malformed");
          }
        } else if (!running) {
          throw new Error("campaign room summary is malformed");
        }
        const summary = {
          sessionId: row.session_id,
          title: projectLegacyRoomText(row.title, true),
          participantNames: rawNames.map((name) => projectLegacyRoomText(name, false) as string),
          createdAt,
        };
        if (row.row_kind === "attached") {
          if (row.attached_at === null) {
            throw new Error("campaign room summary is malformed");
          }
          attached.push({ ...summary, attachedAt: row.attached_at, stopped });
        } else if (row.row_kind === "eligible") {
          if (authority.actor_role !== "owner" || authority.owner_principal_id !== actorId
            || !running) {
            throw new Error("campaign room summary is malformed");
          }
          eligible.push(summary);
        } else {
          throw new Error("campaign room summary is malformed");
        }
      }
      if (attached.length > MAX_CAMPAIGN_ROOM_SUMMARIES || eligible.length > MAX_CAMPAIGN_ROOM_SUMMARIES) {
        throw new Error("campaign room summary limit exceeded");
      }
      const response = campaignRoomLinkingResponseSchema.parse({ attached, eligible });
      return { campaignId: id, ...response };
    },
  };
}
