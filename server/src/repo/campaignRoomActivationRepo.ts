import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  campaignRoomActivationReadinessSchema, campaignRoomActivationRequestSchema,
  campaignRoomActivationResponseSchema, resourceIdSchema,
  type CampaignCatalogResolutionReport, type CampaignRoomActivationReadiness,
  type CampaignRoomActivationRequest, type CampaignRoomActivationResponse,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "./campaign/campaignTypes.js";
import { createCampaignPlayReadRepository } from "./campaign/campaignPlayReadRepo.js";
import { createCampaignRoomSessionLifecycleRepository } from "./campaign/campaignRoomSessionLifecycleRepo.js";
import { resolveCampaignRuleset } from "../rulesets/campaignBinding.js";
import { placeFinalizedActorAtCampaignStartV51 } from "./grantSettlementRepo.js";
import { reconcileGeneratedNpcPlacementsV52 } from "./campaignGenerationRepo.js";
import { transitionSessionSync } from "./sessionRepo.js";

export class CampaignRoomActivationUnavailableError extends Error {}
export class CampaignRoomActivationConflictError extends Error {}

export interface CampaignRoomActivationRepository {
  getCampaignRoomActivationReadiness(principalId: string, campaignId: string, sessionId: string): CampaignRoomActivationReadiness;
  activateCampaignRoom(principalId: string, campaignId: string, sessionId: string, input: CampaignRoomActivationRequest): CampaignRoomActivationResponse;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scope = "campaign-room-activation:v1";

export function createCampaignRoomActivationRepository(db: DatabaseDriver.Database, deps: RepositoryDependencies,
  guard: () => void, catalog: (principalId: string, campaignId: string) => CampaignCatalogResolutionReport | null,
): CampaignRoomActivationRepository {
  const play = createCampaignPlayReadRepository(db);
  const lifecycle = createCampaignRoomSessionLifecycleRepository(db);
  function inspect(principalId: string, campaignId: string, sessionId: string): CampaignRoomActivationReadiness {
    [principalId, campaignId, sessionId].forEach(value => resourceIdSchema.parse(value));
    const campaign = db.prepare(`SELECT campaign.lifecycle_status, campaign.administration_revision FROM campaigns campaign
      JOIN campaign_memberships member ON member.campaign_id=campaign.id
      JOIN principals principal ON principal.id=member.principal_id
      JOIN campaign_sessions attached ON attached.campaign_id=campaign.id AND attached.session_id=?
      WHERE campaign.id=? AND member.principal_id=? AND (member.role='gm'
        OR (member.role='owner' AND campaign.owner_principal_id=member.principal_id))`)
      .get(sessionId, campaignId, principalId) as { lifecycle_status: string; administration_revision: number } | undefined;
    if (!campaign) throw new CampaignRoomActivationUnavailableError();
    const state = db.prepare("SELECT state,stopped_at FROM sessions WHERE id=?").get(sessionId) as { state: string; stopped_at: string | null };
    const blockers: CampaignRoomActivationReadiness["blockers"] = [];
    if (campaign.lifecycle_status !== "published") blockers.push("campaign-not-published");
    if (db.prepare("SELECT 1 FROM campaign_administration_integrations_v59 WHERE campaign_id=? AND paused=1").get(campaignId)) blockers.push("safety-paused");
    if (lifecycle.getCampaignRoomSessionLifecycle(sessionId) !== "running" || !["setup", "active"].includes(state.state)) blockers.push("room-not-startable");
    if (db.prepare(`SELECT 1 FROM campaign_sessions attached JOIN sessions session ON session.id=attached.session_id
      WHERE attached.campaign_id=? AND attached.session_id<>? AND session.state='active' AND session.stopped_at IS NULL`)
      .get(campaignId, sessionId)) blockers.push("ambiguous-room");
    const incomplete = db.prepare(`SELECT 1 FROM session_characters participant WHERE participant.session_id=? AND NOT EXISTS (
      SELECT 1 FROM campaign_characters cc JOIN campaign_actors actor ON actor.campaign_id=cc.campaign_id AND actor.campaign_character_id=cc.id
      WHERE cc.campaign_id=? AND cc.character_id=participant.character_id AND actor.kind='player-character')`).get(sessionId, campaignId);
    let actorIds: string[] = [];
    if (incomplete) blockers.push("participants-not-ready");
    else {
      const bootstrap = play.getCampaignPlayBootstrap(principalId, campaignId, sessionId);
      if (!bootstrap) throw new CampaignRoomActivationUnavailableError();
      actorIds = bootstrap.playableActors.map(actor => actor.actorId);
      if (!actorIds.length) blockers.push("participants-not-ready");
    }
    const configured = db.prepare("SELECT 1 FROM campaign_rules_profiles WHERE campaign_id=?").get(campaignId);
    if (!configured) blockers.push("content-not-ready");
    else {
      const binding = resolveCampaignRuleset(db, campaignId), resolved = catalog(principalId, campaignId);
      if (!resolved?.compatible || !resolved.contentPacks.length || resolved.rulesProfileId !== binding.rulesProfileId) blockers.push("content-not-ready");
    }
    const start = db.prepare(`SELECT 1 FROM campaign_starting_locations_v51 start JOIN campaign_locations_v28 location
      ON location.campaign_id=start.campaign_id AND location.location_id=start.location_id
      WHERE start.campaign_id=? AND location.visibility='public'`).get(campaignId);
    for (const actorId of actorIds) {
      const location = db.prepare("SELECT session_id FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=?")
        .get(campaignId, actorId) as { session_id: string } | undefined;
      if (location && location.session_id !== sessionId && !blockers.includes("actor-in-other-room")) blockers.push("actor-in-other-room");
      if (!location && !start && !blockers.includes("starting-location-required")) blockers.push("starting-location-required");
    }
    return campaignRoomActivationReadinessSchema.parse({ campaignId, sessionId, expectedRevision: campaign.administration_revision,
      active: state.state === "active" && state.stopped_at === null, ready: blockers.length === 0, blockers, actorIds });
  }
  return {
    getCampaignRoomActivationReadiness(principalId, campaignId, sessionId) {
      guard(); return db.transaction(() => inspect(principalId, campaignId, sessionId))();
    },
    activateCampaignRoom(principalId, campaignId, sessionId, raw) {
      guard(); const input = campaignRoomActivationRequestSchema.parse(raw);
      return db.transaction(() => {
        const before = inspect(principalId, campaignId, sessionId);
        if (!before.ready) throw new CampaignRoomActivationConflictError("room is not ready; read activation-readiness");
        const commandId = `room-activation:${hash([campaignId, sessionId, input.idempotencyKey]).slice(0, 48)}`;
        const requestDigest = hash([principalId, campaignId, sessionId, input.expectedRevision, input.idempotencyKey]);
        const prior = db.prepare("SELECT note FROM consent_events WHERE id=? AND session_id=? AND scope=? AND granted=1")
          .get(commandId, sessionId, scope) as { note: string } | undefined;
        if (prior) {
          const stored = JSON.parse(prior.note);
          if (stored.requestDigest !== requestDigest) throw new CampaignRoomActivationConflictError("idempotency key was reused");
          return campaignRoomActivationResponseSchema.parse(stored.response);
        }
        if (input.expectedRevision !== before.expectedRevision) throw new CampaignRoomActivationConflictError("campaign revision is stale");
        const at = deps.clock.now().toISOString();
        if (!before.active) transitionSessionSync(db, deps.clock, sessionId, "active", "campaign-room-activation");
        const placedActorIds = before.actorIds.filter(actorId => !db.prepare("SELECT 1 FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=?").get(campaignId, actorId));
        for (const actorId of placedActorIds) placeFinalizedActorAtCampaignStartV51(db, { campaignId, actorId, occurredAt: at });
        const reconciledNpcCount = reconcileGeneratedNpcPlacementsV52(db, campaignId, at, { sessionId, principalId });
        const readiness = inspect(principalId, campaignId, sessionId);
        if (readiness.actorIds.some(actorId => !db.prepare("SELECT 1 FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=? AND session_id=?").get(campaignId, actorId, sessionId))) throw new Error("activation placement was not established");
        const response = campaignRoomActivationResponseSchema.parse({ readiness,
          receipt: { commandId, idempotencyKey: input.idempotencyKey, occurredAt: at, activated: !before.active, placedActorIds, reconciledNpcCount } });
        // The existing consent stream stores one versioned, public-safe command receipt.
        // Principal identity is bound by the digest, never exposed in legacy consent reads.
        db.prepare(`INSERT INTO consent_events(id,session_id,seq,at,scope,granted,note)
          VALUES(?,?,(SELECT COALESCE(MAX(seq),-1)+1 FROM consent_events WHERE session_id=?),?,?,1,?)`)
          .run(commandId, sessionId, sessionId, at, scope, JSON.stringify({ requestDigest, response }));
        return response;
      }).immediate();
    },
  };
}
