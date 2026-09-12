import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  campaignRoomParticipantRequestSchema, campaignRoomParticipantResponseSchema, resourceIdSchema,
  type CampaignRoomParticipantRequest, type CampaignRoomParticipantResponse,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "./campaign/campaignTypes.js";
import { placeFinalizedActorAtCampaignStartV51 } from "./grantSettlementRepo.js";

export class CampaignRoomParticipantUnavailableError extends Error {}
export class CampaignRoomParticipantConflictError extends Error {}

export interface CampaignRoomParticipantRepository {
  addCampaignRoomParticipant(principalId: string, campaignId: string, sessionId: string, input: CampaignRoomParticipantRequest): CampaignRoomParticipantResponse;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scope = "campaign-room-participant:v1";

/**
 * Adds one finalized campaign character to an existing attached room as a
 * participant. The play bootstrap reads playable actors exclusively from
 * session_characters, so finalization alone is insufficient for join.
 *
 * Invariants preserved: the new row takes the next contiguous position, the
 * session's primary character is untouched, and the character must already have
 * a complete campaign_characters -> sheet -> player-character actor chain.
 */
export function createCampaignRoomParticipantRepository(db: DatabaseDriver.Database, deps: RepositoryDependencies,
  guard: () => void,
): CampaignRoomParticipantRepository {
  return {
    addCampaignRoomParticipant(principalId, campaignId, sessionId, raw) {
      guard();
      const input = campaignRoomParticipantRequestSchema.parse(raw);
      [principalId, campaignId, sessionId].forEach(value => resourceIdSchema.parse(value));
      return db.transaction(() => {
        const authority = db.prepare(`SELECT campaign.administration_revision, campaign.lifecycle_status
          FROM campaigns campaign
          JOIN campaign_memberships member ON member.campaign_id=campaign.id
          JOIN campaign_sessions attached ON attached.campaign_id=campaign.id AND attached.session_id=?
          WHERE campaign.id=? AND member.principal_id=? AND (member.role='gm'
            OR (member.role='owner' AND campaign.owner_principal_id=member.principal_id))`)
          .get(sessionId, campaignId, principalId) as { administration_revision: number; lifecycle_status: string } | undefined;
        if (!authority) throw new CampaignRoomParticipantUnavailableError();
        if (authority.lifecycle_status === "archived") throw new CampaignRoomParticipantConflictError("campaign is archived");
        const session = db.prepare("SELECT state, stopped_at FROM sessions WHERE id=?").get(sessionId) as { state: string; stopped_at: string | null } | undefined;
        if (!session || session.state === "closed" || session.stopped_at !== null) throw new CampaignRoomParticipantConflictError("room is not joinable");

        const commandId = `room-participant:${hash([campaignId, sessionId, input.idempotencyKey]).slice(0, 48)}`;
        const requestDigest = hash([principalId, campaignId, sessionId, input.expectedRevision, input.idempotencyKey, input.campaignCharacterId]);
        const prior = db.prepare("SELECT note FROM consent_events WHERE id=? AND session_id=? AND scope=? AND granted=1")
          .get(commandId, sessionId, scope) as { note: string } | undefined;
        if (prior) {
          const stored = JSON.parse(prior.note);
          if (stored.requestDigest !== requestDigest) throw new CampaignRoomParticipantConflictError("idempotency key was reused");
          return campaignRoomParticipantResponseSchema.parse(stored.response);
        }
        if (input.expectedRevision !== authority.administration_revision) throw new CampaignRoomParticipantConflictError("campaign revision is stale");

        const resolved = db.prepare(`SELECT character.id AS campaign_character_id, character.character_id AS character_id,
            actor.id AS actor_id
          FROM campaign_characters character
          JOIN rpg_campaign_sheets sheet ON sheet.campaign_id=character.campaign_id AND sheet.campaign_character_id=character.id
          JOIN campaign_actors actor ON actor.campaign_id=character.campaign_id
            AND actor.campaign_character_id=character.id AND actor.sheet_id=sheet.id
          WHERE character.campaign_id=? AND character.id=? AND actor.kind='player-character' AND actor.control='principal'`)
          .get(campaignId, input.campaignCharacterId) as { campaign_character_id: string; character_id: string; actor_id: string } | undefined;
        if (!resolved) throw new CampaignRoomParticipantConflictError("character is not finalized in this campaign");

        const count = (db.prepare("SELECT COUNT(*) AS total FROM session_characters WHERE session_id=?").get(sessionId) as { total: number }).total;
        if (count >= 12) throw new CampaignRoomParticipantConflictError("room already has the maximum participants");
        if (db.prepare("SELECT 1 FROM session_characters WHERE session_id=? AND character_id=?").get(sessionId, resolved.character_id)) {
          throw new CampaignRoomParticipantConflictError("character is already in this room");
        }
        const location = db.prepare("SELECT session_id FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=?")
          .get(campaignId, resolved.actor_id) as { session_id: string } | undefined;
        if (location && location.session_id !== sessionId) throw new CampaignRoomParticipantConflictError("actor is placed in another room");

        const at = deps.clock.now().toISOString();
        db.prepare("INSERT INTO session_characters (session_id, character_id, position) VALUES (?, ?, ?)").run(sessionId, resolved.character_id, count);
        if (!location) placeFinalizedActorAtCampaignStartV51(db, { campaignId, actorId: resolved.actor_id, occurredAt: at });

        const response = campaignRoomParticipantResponseSchema.parse({
          campaignId, sessionId, campaignCharacterId: resolved.campaign_character_id, characterId: resolved.character_id,
          actorId: resolved.actor_id, position: count, revision: authority.administration_revision,
          receipt: { commandId, idempotencyKey: input.idempotencyKey, occurredAt: at },
        });
        db.prepare(`INSERT INTO consent_events(id,session_id,seq,at,scope,granted,note)
          VALUES(?,?,(SELECT COALESCE(MAX(seq),-1)+1 FROM consent_events WHERE session_id=?),?,?,1,?)`)
          .run(commandId, sessionId, sessionId, at, scope, JSON.stringify({ requestDigest, response }));
        return response;
      }).immediate();
    },
  };
}
