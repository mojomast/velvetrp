import type DatabaseDriver from "better-sqlite3";
import { campaignWorldHttpResponseSchema, worldProjectionSchema, type CampaignWorldHttpResponse, type WorldProjection } from "@velvet/contracts";
import { WorldConflictError } from "./worldWriteRepo.js";

/** Context required to run a world projection. */
export interface WorldReadContext {
  /** Rejects reads when their enclosing repository is unavailable. */
  guard: () => void;
}

/** Non-mutating, principal-authorized world projection operations. */
export interface WorldReadRepository {
  /** Returns the principal's audience-filtered world state for a campaign session. */
  getWorldProjection(principalId: string, campaignId: string, sessionId: string): WorldProjection | null;
  getCampaignWorld(principalId:string,campaignId:string):WorldCampaignHttpSnapshot|null;
}
export type WorldCampaignHttpSnapshot=CampaignWorldHttpResponse&{campaignId:string;sessionId:string;revision:number};

/** Creates database-backed world projections with their required lifecycle guard. */
export function createWorldReadRepository(
  db: DatabaseDriver.Database,
  context: WorldReadContext,
): WorldReadRepository {
  const member = (principalId: string, campaignId: string): boolean => Boolean(
    db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaignId, principalId),
  );
  const gm = (principalId: string, campaignId: string): boolean => Boolean(
    db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')").get(campaignId, principalId),
  );

  /** Preserves the M1.8 audience filtering for both GM and player views. */
  const getWorldProjection = (principalId: string, campaignId: string, sessionId: string): WorldProjection | null => {
    context.guard();
    if (!member(principalId, campaignId) || !db.prepare("SELECT 1 FROM campaign_sessions WHERE campaign_id=? AND session_id=?").get(campaignId, sessionId)) return null;

    const isGm = gm(principalId, campaignId);
    const revision = (db.prepare("SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id=?").get(campaignId, sessionId) as any)?.revision ?? 0;
    const locations = db.prepare("SELECT * FROM campaign_locations_v28 WHERE campaign_id=?").all(campaignId) as any[];
    const connections = db.prepare("SELECT * FROM campaign_location_connections_v28 WHERE campaign_id=?").all(campaignId) as any[];
    const actors = db.prepare("SELECT * FROM campaign_actor_locations_v28 WHERE campaign_id=? AND session_id=?" + (isGm ? "" : " AND actor_id IN (SELECT actor_id FROM campaign_actor_private_state WHERE campaign_id=? AND controller_principal_id=?)"))
      .all(...(isGm ? [campaignId, sessionId] : [campaignId, sessionId, campaignId, principalId])) as any[];
    const actorLocations = actors.map((row) => ({ campaignId, sessionId, actorId: row.actor_id, locationId: row.location_id, revision: row.state_revision, updatedAt: row.updated_at }));

    if (isGm) return worldProjectionSchema.parse({
      audience: "gm", campaignId, revision,
      locations: locations.map((row) => ({ campaignId, locationId: row.location_id, parentLocationId: row.parent_location_id, name: row.public_name, description: row.public_description, visibility: row.visibility === "public" ? "visible" : "hidden", createdAt: row.created_at, updatedAt: row.created_at })),
      connections: connections.map((row) => ({ campaignId, locationConnectionId: row.connection_id, fromLocationId: row.from_location_id, toLocationId: row.to_location_id, visibility: row.visibility === "public" ? "visible" : "hidden", createdAt: row.created_at })),
      discoveries: [], actorLocations, npcPersonaLinks: [], privateNpcStates: [], factions: [], memberships: [], factionRelations: [], relationships: [], reputationLedger: [],
    });

    const discoveries = db.prepare("SELECT d.* FROM campaign_location_discoveries_v28 d JOIN campaign_actor_private_state a ON a.campaign_id=d.campaign_id AND a.actor_id=d.actor_id WHERE d.campaign_id=? AND a.controller_principal_id=?").all(campaignId, principalId) as any[];
    const known = new Set(discoveries.map((row) => row.location_id));
    return worldProjectionSchema.parse({
      audience: "player", campaignId, revision,
      discoveries: discoveries.map((row) => ({ locationDiscoveryId: `discovery:${row.actor_id}:${row.location_id}`, campaignId, principalId, locationId: row.location_id, discoveredAt: row.discovered_at })),
      locations: locations.filter((row) => row.visibility === "public" && known.has(row.location_id)).map((row) => ({ locationId: row.location_id, parentLocationId: row.parent_location_id, name: row.public_name, description: row.public_description })),
      connections: connections.filter((row) => row.visibility === "public" && known.has(row.from_location_id) && known.has(row.to_location_id)).map((row) => ({ locationConnectionId: row.connection_id, fromLocationId: row.from_location_id, toLocationId: row.to_location_id })),
      npcs: [], actorLocations, factions: [], relationships: [],
    });
  };

  const getCampaignWorld=(principalId:string,campaignId:string):WorldCampaignHttpSnapshot|null=>{
    context.guard();if(!member(principalId,campaignId))return null;
    const sessions=db.prepare("SELECT session_id FROM campaign_sessions WHERE campaign_id=? ORDER BY attached_at,session_id")
      .all(campaignId) as Array<{session_id:string}>;
    if(sessions.length===0)return null;
    if(sessions.length!==1)throw new WorldConflictError("campaign world session is ambiguous");
    const sessionId=sessions[0]!.session_id,isGm=gm(principalId,campaignId);
    const revision=(db.prepare("SELECT revision FROM world_mutation_revisions_v28 WHERE campaign_id=? AND session_id=?")
      .get(campaignId,sessionId) as {revision:number}|undefined)?.revision??0;
    const discoveries=isGm?[]:db.prepare(`SELECT DISTINCT discovery.location_id FROM campaign_location_discoveries_v28 discovery
      JOIN campaign_actor_private_state actor ON actor.campaign_id=discovery.campaign_id AND actor.actor_id=discovery.actor_id
      WHERE discovery.campaign_id=? AND actor.controller_principal_id=? ORDER BY discovery.location_id`)
      .all(campaignId,principalId) as Array<{location_id:string}>;
    const known=new Set(discoveries.map((row)=>row.location_id));
    const locations=(db.prepare("SELECT * FROM campaign_locations_v28 WHERE campaign_id=? ORDER BY location_id")
      .all(campaignId) as any[]).filter((row)=>isGm||(row.visibility!=="gm"&&known.has(row.location_id)));
    const visibleIds=new Set(locations.map((row)=>row.location_id));
    const connections=(db.prepare("SELECT * FROM campaign_location_connections_v28 WHERE campaign_id=? ORDER BY connection_id")
      .all(campaignId) as any[]).filter((row)=>isGm||(row.visibility!=="gm"&&visibleIds.has(row.from_location_id)&&visibleIds.has(row.to_location_id)));
    const actorRows=db.prepare(`SELECT location.* FROM campaign_actor_locations_v28 location
      WHERE location.campaign_id=? AND location.session_id=?${isGm?"":" AND location.actor_id IN (SELECT actor_id FROM campaign_actor_private_state WHERE campaign_id=? AND controller_principal_id=?)"}
      ORDER BY location.actor_id`).all(...(isGm?[campaignId,sessionId]:[campaignId,sessionId,campaignId,principalId])) as any[];
    const response=campaignWorldHttpResponseSchema.parse({
      currentLocations:actorRows.map((row)=>({actorId:row.actor_id,locationId:row.location_id,
        revision:row.state_revision,updatedAt:row.updated_at})),
      visibleLocations:locations.map((row)=>({locationId:row.location_id,parentLocationId:row.parent_location_id,
        name:row.public_name,description:row.public_description})),
      visibleConnections:connections.map((row)=>({connectionId:row.connection_id,
        fromLocationId:row.from_location_id,toLocationId:row.to_location_id})),
    });
    return {campaignId,sessionId,revision,...response};
  };

  return { getWorldProjection,getCampaignWorld };
}
