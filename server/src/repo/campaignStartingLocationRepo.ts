import type DatabaseDriver from "better-sqlite3";
import {
  campaignStartingLocationDesignationRequestSchema,
  campaignStartingLocationDesignationResponseSchema,
  campaignStartingLocationReadResponseSchema,
  resourceIdSchema,
  utcIsoTimestampSchema,
  type CampaignStartingLocationDesignationRequest,
  type CampaignStartingLocationDesignationResponse,
  type CampaignStartingLocationReadResponse,
} from "@velvet/contracts";
import type { RepositoryDependencies } from "./campaign/campaignTypes.js";

export class CampaignStartingLocationAuthorizationError extends Error {}
export class CampaignStartingLocationUnavailableError extends Error {}
export class CampaignStartingLocationStaleError extends Error {}
export class CampaignStartingLocationConflictError extends Error {}

export interface CampaignStartingLocationRepository {
  getCampaignStartingLocation(principalId: string, campaignId: string): CampaignStartingLocationReadResponse | null;
  designateCampaignStartingLocation(principalId: string, campaignId: string,
    input: CampaignStartingLocationDesignationRequest): CampaignStartingLocationDesignationResponse;
}

type StartingRow = { location_id: string; public_name: string; designated_at: string };

export function preserveCampaignStartingLocation(db: DatabaseDriver.Database, campaignId: string,
  locationId: string, designatedAt: string): StartingRow {
  const existing = db.prepare(`SELECT start.location_id,location.public_name,start.designated_at
    FROM campaign_starting_locations_v51 start JOIN campaign_locations_v28 location
      ON location.campaign_id=start.campaign_id AND location.location_id=start.location_id
    WHERE start.campaign_id=?`).get(campaignId) as StartingRow | undefined;
  if (existing) return existing;
  const target = db.prepare("SELECT 1 FROM campaign_locations_v28 WHERE campaign_id=? AND location_id=? AND visibility='public'")
    .get(campaignId, locationId);
  if (!target) throw new CampaignStartingLocationUnavailableError();
  db.prepare("INSERT INTO campaign_starting_locations_v51(campaign_id,location_id,designated_at) VALUES(?,?,?)")
    .run(campaignId, locationId, designatedAt);
  return db.prepare(`SELECT start.location_id,location.public_name,start.designated_at
    FROM campaign_starting_locations_v51 start JOIN campaign_locations_v28 location
      ON location.campaign_id=start.campaign_id AND location.location_id=start.location_id
    WHERE start.campaign_id=?`).get(campaignId) as StartingRow;
}

export function createCampaignStartingLocationRepository(db: DatabaseDriver.Database, deps: RepositoryDependencies,
  guard: () => void): CampaignStartingLocationRepository {
  const read = (principalId: string, campaignId: string): CampaignStartingLocationReadResponse | null => {
    guard(); resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId);
    const campaign = db.prepare(`SELECT campaign.administration_revision FROM campaigns campaign
      JOIN campaign_memberships member ON member.campaign_id=campaign.id
      WHERE campaign.id=? AND member.principal_id=?`).get(campaignId, principalId) as { administration_revision: number } | undefined;
    if (!campaign) return null;
    const row = db.prepare(`SELECT start.location_id,location.public_name,start.designated_at
      FROM campaign_starting_locations_v51 start JOIN campaign_locations_v28 location
        ON location.campaign_id=start.campaign_id AND location.location_id=start.location_id
      WHERE start.campaign_id=?`).get(campaignId) as StartingRow | undefined;
    return campaignStartingLocationReadResponseSchema.parse({ campaignId, revision: campaign.administration_revision,
      startingLocation: row ? { locationId: row.location_id, name: row.public_name, designatedAt: row.designated_at } : null });
  };
  return {
    getCampaignStartingLocation: read,
    designateCampaignStartingLocation(principalId, campaignId, raw) {
      guard(); resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId);
      const input = campaignStartingLocationDesignationRequestSchema.parse(raw);
      return db.transaction(() => {
        const authority = db.prepare(`SELECT campaign.owner_principal_id,campaign.lifecycle_status,
          campaign.administration_revision,campaign.updated_at,member.role
          FROM campaigns campaign JOIN campaign_memberships member ON member.campaign_id=campaign.id
          WHERE campaign.id=? AND member.principal_id=?`).get(campaignId, principalId) as any;
        if (!authority || !(["owner", "gm"].includes(authority.role))
          || (authority.role === "owner" && authority.owner_principal_id !== principalId)) throw new CampaignStartingLocationAuthorizationError();
        const prior = db.prepare(`SELECT command.command_id,command.expected_revision,command.payload,command.created_at,
          receipt.revision_before,receipt.revision_after,receipt.result_data
          FROM campaign_administration_commands command JOIN campaign_administration_receipts receipt USING(command_id)
          WHERE command.campaign_id=? AND command.idempotency_key=?`).get(campaignId, input.idempotencyKey) as any;
        const payload = JSON.stringify({ startingLocationId: input.locationId });
        if (prior) {
          if (prior.expected_revision !== input.expectedRevision || prior.payload !== payload) throw new CampaignStartingLocationConflictError("idempotency key was reused");
          const stored = JSON.parse(prior.result_data);
          return campaignStartingLocationDesignationResponseSchema.parse({ campaignId, revision: prior.revision_after,
            startingLocation: stored.startingLocation, receipt: { commandId: prior.command_id,
              idempotencyKey: input.idempotencyKey, revisionBefore: prior.revision_before,
              revisionAfter: prior.revision_after, occurredAt: prior.created_at } });
        }
        if (authority.administration_revision !== input.expectedRevision) throw new CampaignStartingLocationStaleError();
        if (!["draft", "published"].includes(authority.lifecycle_status)
          || !db.prepare("SELECT 1 FROM campaign_rules_profiles WHERE campaign_id=?").get(campaignId)
          || db.prepare("SELECT 1 FROM campaign_administration_integrations_v59 WHERE campaign_id=? AND paused=1").get(campaignId)) {
          throw new CampaignStartingLocationConflictError("campaign is not ready for starting-location designation");
        }
        const location = db.prepare(`SELECT public_name FROM campaign_locations_v28
          WHERE campaign_id=? AND location_id=? AND visibility='public'`).get(campaignId, input.locationId) as { public_name: string } | undefined;
        if (!location) throw new CampaignStartingLocationUnavailableError();
        const existing = db.prepare("SELECT location_id FROM campaign_starting_locations_v51 WHERE campaign_id=?")
          .get(campaignId) as { location_id: string } | undefined;
        if (existing && existing.location_id !== input.locationId) throw new CampaignStartingLocationConflictError("a different starting location is already designated");
        const clockAt = utcIsoTimestampSchema.parse(deps.clock.now().toISOString());
        const at = utcIsoTimestampSchema.parse(new Date(Math.max(Date.parse(clockAt), Date.parse(authority.updated_at) + 1)).toISOString());
        const commandId = resourceIdSchema.parse(deps.ids.nextId()), eventId = resourceIdSchema.parse(deps.ids.nextId());
        const starting = preserveCampaignStartingLocation(db, campaignId, input.locationId, at);
        const next = input.expectedRevision + 1;
        db.prepare(`INSERT INTO campaign_administration_commands
          (command_id,campaign_id,idempotency_key,actor_principal_id,expected_revision,type,payload,created_at)
          VALUES(?,?,?,?,?,'administration_updated',?,?)`).run(commandId, campaignId, input.idempotencyKey,
            principalId, input.expectedRevision, payload, at);
        if (db.prepare("UPDATE campaigns SET administration_revision=?,updated_at=? WHERE id=? AND administration_revision=?")
          .run(next, at, campaignId, input.expectedRevision).changes !== 1) throw new CampaignStartingLocationStaleError();
        db.prepare(`INSERT INTO campaign_administration_events
          (event_id,campaign_id,command_id,revision_before,revision,type,public_data,private_data,occurred_at)
          VALUES(?,?,?,?,?,'administration_updated',?,?,?)`).run(eventId, campaignId, commandId,
            input.expectedRevision, next, payload, payload, at);
        const startingLocation = { locationId: starting.location_id, name: starting.public_name, designatedAt: starting.designated_at };
        db.prepare(`INSERT INTO campaign_administration_receipts
          (command_id,campaign_id,event_id,type,revision_before,revision_after,result_data)
          VALUES(?,?,?,'administration_updated',?,?,?)`).run(commandId, campaignId, eventId,
            input.expectedRevision, next, JSON.stringify({ startingLocation }));
        return campaignStartingLocationDesignationResponseSchema.parse({ campaignId, revision: next, startingLocation,
          receipt: { commandId, idempotencyKey: input.idempotencyKey, revisionBefore: input.expectedRevision,
            revisionAfter: next, occurredAt: at } });
      }).immediate();
    },
  };
}
