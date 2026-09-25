import type DatabaseDriver from "better-sqlite3";
import { resourceIdSchema } from "@velvet/contracts";
import type { RepositoryDependencies } from "./campaign/campaignTypes.js";

/**
 * Bounded read seam for the campaign startup pipeline.
 *
 * The startup command needs one durable view of the campaign preparation that
 * the public scene-image lane may safely use: the designated starting location
 * (or none) plus every location whose own visibility is `public`. It never
 * exposes GM-only locations, accepted-artifact internals, or story secrets.
 *
 * Authorization is the same owner/GM rule used by the DM and generation repos:
 * a missing membership or a public role returns null, and the caller fails
 * closed rather than leaking campaign existence.
 */
export interface CampaignStartupPublicLocation {
  locationId: string;
  name: string;
  description: string;
}

export interface CampaignStartupRead {
  /** Designated public starting location, or null when none is set. */
  startingLocationId: string | null;
  /** Campaign administration revision; a durable token that changes on campaign edits. */
  administrationRevision: number;
  /** Durable session state (`setup`/`active`/`paused`/...) for the attached room. */
  sessionState: string;
  /** True when the room's session has stopped; a paused/stopped room blocks the opening beat. */
  sessionStopped: boolean;
  /** Every campaign location with `visibility='public'`, ordered deterministically. */
  locations: CampaignStartupPublicLocation[];
}

export interface CampaignStartupRepository {
  getCampaignStartupRead(principalId: string, campaignId: string, sessionId: string): CampaignStartupRead | null;
}

export function createCampaignStartupRepository(db: DatabaseDriver.Database, _deps: RepositoryDependencies,
  guard: () => void): CampaignStartupRepository {
  return {
    getCampaignStartupRead(principalId, campaignId, sessionId) {
      guard();
      resourceIdSchema.parse(principalId);
      resourceIdSchema.parse(campaignId);
      resourceIdSchema.parse(sessionId);
      const authority = db.prepare(`SELECT campaign.administration_revision, member.role
        FROM campaigns campaign JOIN campaign_memberships member ON member.campaign_id=campaign.id
        WHERE campaign.id=? AND member.principal_id=?`).get(campaignId, principalId) as
        { administration_revision: number; role: string } | undefined;
      if (!authority || !["owner", "gm"].includes(authority.role)) return null;
      const session = db.prepare(`SELECT session.state, session.stopped_at
        FROM campaign_sessions attached JOIN sessions session ON session.id=attached.session_id
        WHERE attached.campaign_id=? AND attached.session_id=?`).get(campaignId, sessionId) as
        { state: string; stopped_at: string | null } | undefined;
      if (!session) return null;
      const start = db.prepare(`SELECT start.location_id
        FROM campaign_starting_locations_v51 start JOIN campaign_locations_v28 location
          ON location.campaign_id=start.campaign_id AND location.location_id=start.location_id
        WHERE start.campaign_id=? AND location.visibility='public'`).get(campaignId) as
        { location_id: string } | undefined;
      const rows = db.prepare(`SELECT location_id, public_name, public_description
        FROM campaign_locations_v28
        WHERE campaign_id=? AND visibility='public'
        ORDER BY location_id`).all(campaignId) as
        Array<{ location_id: string; public_name: string; public_description: string | null }>;
      return {
        startingLocationId: start?.location_id ?? null,
        administrationRevision: authority.administration_revision,
        sessionState: session.state,
        sessionStopped: session.stopped_at !== null,
        locations: rows.map((row) => ({
          locationId: row.location_id,
          name: row.public_name,
          description: row.public_description ?? "",
        })),
      };
    },
  };
}
