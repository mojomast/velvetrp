import type DatabaseDriver from "better-sqlite3";
import {
  campaignMembershipReadSchema,
  campaignPlayBootstrapSchema,
  campaignPlayLifecycleSchema,
  campaignPlaySessionIdSchema,
  resourceIdSchema,
  revisionSchema,
  utcIsoTimestampSchema,
  type CampaignPlayBootstrap,
} from "@velvet/contracts";

interface CampaignPlayRow {
  row_kind: "authority" | "participant";
  campaign_id: string;
  owner_principal_id: string;
  campaign_owner_role: string;
  lifecycle_status: string;
  administration_revision: unknown;
  actor_campaign_id: string | null;
  actor_principal_id: string | null;
  actor_role: string | null;
  actor_created_at: string | null;
  actor_parent_id: string | null;
  owner_count: unknown;
  owner_campaign_id: string | null;
  owner_membership_principal_id: string | null;
  owner_membership_role: string | null;
  owner_created_at: string | null;
  owner_parent_id: string | null;
  session_id: string | null;
  attached_at: string | null;
  session_presence: string | null;
  session_character_id: string | null;
  session_state: string | null;
  session_created_at: string | null;
  stopped_at: string | null;
  stop_reason_kind: unknown;
  participant_character_id: string | null;
  participant_position: unknown;
  participant_name: string | null;
  participant_count: unknown;
  joined_character_count: unknown;
  primary_participant_count: unknown;
  distinct_character_count: unknown;
  distinct_position_count: unknown;
  malformed_position_count: unknown;
  minimum_position: unknown;
  maximum_position: unknown;
  campaign_character_id: string | null;
  campaign_character_count: unknown;
  sheet_id: string | null;
  sheet_count: unknown;
  actor_id: string | null;
  actor_kind: string | null;
  actor_control: string | null;
  actor_count: unknown;
  private_actor_id: string | null;
  private_state_count: unknown;
  controller_principal_id: string | null;
  controller_parent_id: string | null;
  controller_campaign_id: string | null;
  controller_role: string | null;
  controller_created_at: string | null;
}

const CAMPAIGN_ROLES = ["owner", "gm", "player", "observer"] as const;
const SESSION_STATES = ["setup", "active", "paused", "cooldown", "closed"] as const;

function malformed(): never {
  throw new Error("campaign play bootstrap is malformed");
}

/** One-statement, authorization-rooted campaign play bootstrap reader. */
export interface CampaignPlayReadRepository {
  getCampaignPlayBootstrap(
    principalId: string,
    campaignId: string,
    sessionId: string,
  ): CampaignPlayBootstrap | null;
}

/** Creates the campaign play reader over a caller-owned SQLite connection. */
export function createCampaignPlayReadRepository(
  db: DatabaseDriver.Database,
): CampaignPlayReadRepository {
  return {
    getCampaignPlayBootstrap(principalId, campaignId, sessionId) {
      const actorId = resourceIdSchema.parse(principalId);
      const id = resourceIdSchema.parse(campaignId);
      const roomId = campaignPlaySessionIdSchema.parse(sessionId);
      const rows = db.prepare(`WITH authority AS MATERIALIZED (
        SELECT campaign.id AS campaign_id, campaign.owner_principal_id,
          campaign.owner_role AS campaign_owner_role, campaign.lifecycle_status,
          campaign.administration_revision,
          actor_membership.campaign_id AS actor_campaign_id,
          actor_membership.principal_id AS actor_principal_id,
          actor_membership.role AS actor_role,
          actor_membership.created_at AS actor_created_at,
          actor_parent.id AS actor_parent_id,
          (SELECT COUNT(*) FROM campaign_memberships sole_owner
            WHERE sole_owner.campaign_id = campaign.id AND sole_owner.role = 'owner') AS owner_count,
          owner_membership.campaign_id AS owner_campaign_id,
          owner_membership.principal_id AS owner_membership_principal_id,
          owner_membership.role AS owner_membership_role,
          owner_membership.created_at AS owner_created_at,
          owner_parent.id AS owner_parent_id
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
        SELECT campaign_id, owner_principal_id, campaign_owner_role, lifecycle_status,
          administration_revision, actor_campaign_id, actor_principal_id, actor_role,
          actor_created_at, actor_parent_id, owner_count, owner_campaign_id,
          owner_membership_principal_id, owner_membership_role, owner_created_at, owner_parent_id
        FROM authority
        WHERE actor_campaign_id = campaign_id
          AND actor_principal_id = $actorId AND actor_parent_id = $actorId
          AND actor_role IN ('owner', 'gm', 'player', 'observer')
          AND (actor_role <> 'owner' OR owner_principal_id = $actorId)
      ), integrity_authorized AS MATERIALIZED (
        SELECT campaign_id, owner_principal_id, campaign_owner_role, lifecycle_status,
          administration_revision, actor_campaign_id, actor_principal_id, actor_role,
          actor_created_at, actor_parent_id, owner_count, owner_campaign_id,
          owner_membership_principal_id, owner_membership_role, owner_created_at, owner_parent_id
        FROM authorized
        WHERE campaign_owner_role = 'owner' AND owner_count = 1
          AND owner_campaign_id = campaign_id AND owner_membership_principal_id = owner_principal_id
          AND owner_membership_role = 'owner' AND owner_parent_id = owner_principal_id
          AND typeof(actor_created_at) = 'text'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', actor_created_at) = actor_created_at
          AND typeof(owner_created_at) = 'text'
          AND strftime('%Y-%m-%dT%H:%M:%fZ', owner_created_at) = owner_created_at
          AND lifecycle_status IN ('draft', 'published', 'paused', 'completed', 'archived')
          AND typeof(administration_revision) = 'integer'
          AND administration_revision BETWEEN 0 AND 9007199254740991
      ), target AS MATERIALIZED (
        SELECT authorized.campaign_id, authorized.owner_principal_id,
          authorized.campaign_owner_role, authorized.lifecycle_status,
          authorized.administration_revision, authorized.actor_campaign_id,
          authorized.actor_principal_id, authorized.actor_role, authorized.actor_created_at,
          authorized.actor_parent_id, authorized.owner_count, authorized.owner_campaign_id,
          authorized.owner_membership_principal_id, authorized.owner_membership_role,
          authorized.owner_created_at, authorized.owner_parent_id,
          attachment.session_id, attachment.attached_at,
          session.id AS session_presence, session.character_id AS session_character_id,
          session.state AS session_state, session.created_at AS session_created_at,
          session.stopped_at,
          CASE WHEN session.stop_reason IS NULL THEN 0
            WHEN typeof(session.stop_reason) = 'text' AND length(trim(session.stop_reason)) > 0 THEN 1
            ELSE 2 END AS stop_reason_kind
        FROM integrity_authorized authorized
        JOIN campaign_sessions attachment ON attachment.campaign_id = authorized.campaign_id
          AND attachment.session_id = $sessionId
        LEFT JOIN sessions session ON session.id = attachment.session_id
      )
      SELECT 'authority' AS row_kind, authority.campaign_id, authority.owner_principal_id,
        authority.campaign_owner_role, authority.lifecycle_status, authority.administration_revision,
        authority.actor_campaign_id, authority.actor_principal_id, authority.actor_role,
        authority.actor_created_at, authority.actor_parent_id, authority.owner_count,
        authority.owner_campaign_id, authority.owner_membership_principal_id,
        authority.owner_membership_role, authority.owner_created_at, authority.owner_parent_id,
        NULL AS session_id, NULL AS attached_at, NULL AS session_presence,
        NULL AS session_character_id, NULL AS session_state, NULL AS session_created_at,
        NULL AS stopped_at, NULL AS stop_reason_kind,
        NULL AS participant_character_id, NULL AS participant_position, NULL AS participant_name,
        NULL AS participant_count, NULL AS joined_character_count, NULL AS primary_participant_count,
        NULL AS distinct_character_count, NULL AS distinct_position_count,
        NULL AS malformed_position_count, NULL AS minimum_position, NULL AS maximum_position,
        NULL AS campaign_character_id, NULL AS campaign_character_count,
        NULL AS sheet_id, NULL AS sheet_count, NULL AS actor_id, NULL AS actor_kind,
        NULL AS actor_control, NULL AS actor_count, NULL AS private_actor_id,
        NULL AS private_state_count, NULL AS controller_principal_id, NULL AS controller_parent_id,
        NULL AS controller_campaign_id, NULL AS controller_role, NULL AS controller_created_at,
        0 AS row_order, 0 AS participant_order
      FROM authority
      UNION ALL
      SELECT 'participant', target.campaign_id, target.owner_principal_id,
        target.campaign_owner_role, target.lifecycle_status, target.administration_revision,
        target.actor_campaign_id, target.actor_principal_id, target.actor_role,
        target.actor_created_at, target.actor_parent_id, target.owner_count,
        target.owner_campaign_id, target.owner_membership_principal_id,
        target.owner_membership_role, target.owner_created_at, target.owner_parent_id,
        target.session_id, target.attached_at, target.session_presence,
        target.session_character_id, target.session_state, target.session_created_at,
        target.stopped_at, target.stop_reason_kind,
        participant.character_id, participant.position, persona.name,
        (SELECT COUNT(*) FROM session_characters item WHERE item.session_id = target.session_id),
        (SELECT COUNT(*) FROM session_characters item JOIN characters joined ON joined.id = item.character_id
          WHERE item.session_id = target.session_id),
        (SELECT COUNT(*) FROM session_characters item WHERE item.session_id = target.session_id
          AND item.character_id = target.session_character_id),
        (SELECT COUNT(DISTINCT item.character_id) FROM session_characters item WHERE item.session_id = target.session_id),
        (SELECT COUNT(DISTINCT item.position) FROM session_characters item WHERE item.session_id = target.session_id),
        (SELECT COUNT(*) FROM session_characters item WHERE item.session_id = target.session_id
          AND typeof(item.position) <> 'integer'),
        (SELECT MIN(item.position) FROM session_characters item WHERE item.session_id = target.session_id),
        (SELECT MAX(item.position) FROM session_characters item WHERE item.session_id = target.session_id),
        campaign_character.id,
        (SELECT COUNT(*) FROM campaign_characters item WHERE item.campaign_id = target.campaign_id
          AND item.character_id = participant.character_id),
        sheet.id,
        (SELECT COUNT(*) FROM rpg_campaign_sheets item WHERE item.campaign_id = target.campaign_id
          AND item.campaign_character_id = campaign_character.id),
        playable_actor.id, playable_actor.kind, playable_actor.control,
        (SELECT COUNT(*) FROM campaign_actors item WHERE item.campaign_id = target.campaign_id
          AND item.campaign_character_id = campaign_character.id AND item.sheet_id = sheet.id),
        private_state.actor_id,
        (SELECT COUNT(*) FROM campaign_actor_private_state item WHERE item.campaign_id = target.campaign_id
          AND item.actor_id = playable_actor.id),
        private_state.controller_principal_id, controller_parent.id,
        controller_membership.campaign_id, controller_membership.role, controller_membership.created_at,
        1, participant.position
      FROM target
      LEFT JOIN session_characters participant ON participant.session_id = target.session_id
      LEFT JOIN characters persona ON persona.id = participant.character_id
      LEFT JOIN campaign_characters campaign_character
        ON campaign_character.campaign_id = target.campaign_id
        AND campaign_character.character_id = participant.character_id
      LEFT JOIN rpg_campaign_sheets sheet ON sheet.campaign_id = target.campaign_id
        AND sheet.campaign_character_id = campaign_character.id
      LEFT JOIN campaign_actors playable_actor ON playable_actor.campaign_id = target.campaign_id
        AND playable_actor.campaign_character_id = campaign_character.id AND playable_actor.sheet_id = sheet.id
      LEFT JOIN campaign_actor_private_state private_state
        ON private_state.campaign_id = target.campaign_id AND private_state.actor_id = playable_actor.id
      LEFT JOIN principals controller_parent ON controller_parent.id = private_state.controller_principal_id
      LEFT JOIN campaign_memberships controller_membership
        ON controller_membership.campaign_id = target.campaign_id
        AND controller_membership.principal_id = private_state.controller_principal_id
      ORDER BY row_order, participant_order`).all({ actorId, campaignId: id, sessionId: roomId }) as CampaignPlayRow[];

      if (rows.length === 0) return null;
      const authority = rows[0]!;
      // Missing principals, unknown roles, and stale purported owners cannot
      // establish attributable access and are deliberately null-masked.
      if (authority.actor_campaign_id !== id || authority.actor_principal_id !== actorId
        || authority.actor_parent_id !== actorId || authority.actor_role === null
        || !CAMPAIGN_ROLES.includes(authority.actor_role as typeof CAMPAIGN_ROLES[number])
        || (authority.actor_role === "owner" && authority.owner_principal_id !== actorId)) return null;

      try {
        const membership = campaignMembershipReadSchema.parse({
          campaignId: authority.actor_campaign_id, principalId: authority.actor_principal_id,
          role: authority.actor_role, createdAt: authority.actor_created_at,
        });
        const owner = campaignMembershipReadSchema.parse({
          campaignId: authority.owner_campaign_id,
          principalId: authority.owner_membership_principal_id,
          role: authority.owner_membership_role,
          createdAt: authority.owner_created_at,
        });
        if (membership.campaignId !== id || membership.principalId !== actorId
          || authority.campaign_id !== id || authority.campaign_owner_role !== "owner"
          || authority.owner_count !== 1 || owner.campaignId !== id || owner.role !== "owner"
          || owner.principalId !== authority.owner_principal_id
          || authority.owner_parent_id !== authority.owner_principal_id) malformed();
        campaignPlayLifecycleSchema.parse(authority.lifecycle_status);
        revisionSchema.parse(authority.administration_revision);
      } catch (error) {
        if (error instanceof Error && error.message === "campaign play bootstrap is malformed") throw error;
        malformed();
      }

      const participants = rows.slice(1);
      if (participants.length === 0) return null;
      const first = participants[0]!;
      try {
        if (first.session_id !== roomId || first.session_presence !== roomId
          || first.attached_at === null || first.session_created_at === null
          || first.session_state === null
          || !SESSION_STATES.includes(first.session_state as typeof SESSION_STATES[number])) malformed();
        const attachedAt = utcIsoTimestampSchema.parse(first.attached_at);
        const createdAt = utcIsoTimestampSchema.parse(first.session_created_at);
        const active = first.session_state === "active" && first.stopped_at === null && first.stop_reason_kind === 0;
        if (first.session_state === "closed") {
          const stoppedAt = utcIsoTimestampSchema.parse(first.stopped_at);
          if (first.stop_reason_kind !== 1 || stoppedAt < createdAt) malformed();
        } else if (first.stopped_at !== null || first.stop_reason_kind !== 0) malformed();
        if (!Number.isSafeInteger(first.participant_count) || (first.participant_count as number) < 1
          || (first.participant_count as number) > 12 || participants.length !== first.participant_count
          || first.joined_character_count !== first.participant_count
          || first.primary_participant_count !== 1
          || first.distinct_character_count !== first.participant_count
          || first.distinct_position_count !== first.participant_count
          || first.malformed_position_count !== 0 || first.minimum_position !== 0
          || first.maximum_position !== (first.participant_count as number) - 1) malformed();

        const seenActors = new Set<string>();
        const allActors: Array<{ actorId: string; name: string; controller: string }> = [];
        for (const row of participants) {
          if (row.campaign_id !== id || row.session_id !== roomId
            || row.lifecycle_status !== first.lifecycle_status
            || row.administration_revision !== first.administration_revision
            || row.session_state !== first.session_state || row.attached_at !== first.attached_at
            || row.participant_count !== first.participant_count
            || row.participant_character_id === null || row.participant_name === null
            || row.campaign_character_id === null || row.campaign_character_count !== 1
            || row.sheet_id === null || row.sheet_count !== 1
            || row.actor_id === null || row.actor_count !== 1 || seenActors.has(row.actor_id)
            || row.actor_kind !== "player-character" || row.actor_control !== "principal"
            || row.private_actor_id !== row.actor_id || row.private_state_count !== 1
            || row.controller_principal_id === null
            || row.controller_parent_id !== row.controller_principal_id
            || row.controller_campaign_id !== id
            || !["owner", "gm", "player"].includes(row.controller_role ?? "")
            || (row.controller_role === "owner" && row.controller_principal_id !== authority.owner_principal_id)) malformed();
          campaignMembershipReadSchema.parse({ campaignId: row.controller_campaign_id,
            principalId: row.controller_principal_id, role: row.controller_role,
            createdAt: row.controller_created_at });
          resourceIdSchema.parse(row.actor_id);
          seenActors.add(row.actor_id);
          allActors.push({ actorId: row.actor_id, name: row.participant_name, controller: row.controller_principal_id });
        }

        const role = authority.actor_role as typeof CAMPAIGN_ROLES[number];
        const control = role === "owner" || role === "gm" ? "all" : role === "player" ? "controlled" : "none";
        const playableActors = control === "all" ? allActors
          : control === "controlled" ? allActors.filter(({ controller }) => controller === actorId) : [];
        return campaignPlayBootstrapSchema.parse({
          campaignId: id,
          sessionId: roomId,
          expectedRevision: authority.administration_revision,
          session: {
            attached: true,
            attachedAt,
            active,
            adventureEligible: authority.lifecycle_status === "published" && active
              && resourceIdSchema.safeParse(roomId).success,
          },
          principal: { role, control },
          playableActors: playableActors.map(({ actorId: playableActorId, name }) => ({ actorId: playableActorId, name })),
        });
      } catch (error) {
        if (error instanceof Error && error.message === "campaign play bootstrap is malformed") throw error;
        malformed();
      }
    },
  };
}
