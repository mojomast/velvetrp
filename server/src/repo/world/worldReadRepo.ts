import type DatabaseDriver from "better-sqlite3";
import { gmCampaignFactionsHttpResponseSchema,gmCampaignNpcsHttpResponseSchema,playerCampaignFactionsHttpResponseSchema,playerCampaignNpcsHttpResponseSchema,campaignWorldHttpResponseSchema, worldProjectionSchema,
  type CampaignWorldHttpResponse,type FactionStandingHttp,type GmCampaignFactionHttp,type GmCampaignNpcHttp,type NpcRelationshipHttp,type PlayerCampaignFactionHttp,type PlayerCampaignNpcHttp,type WorldProjection } from "@velvet/contracts";
import { WorldConflictError } from "./worldErrors.js";

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
  listCampaignNpcs(principalId:string,campaignId:string):CampaignNpcsSnapshot|null;
  listCampaignFactions(principalId:string,campaignId:string):CampaignFactionsSnapshot|null;
}
export type WorldCampaignHttpSnapshot=CampaignWorldHttpResponse&{campaignId:string;sessionId:string;revision:number};
export type CampaignNpcsSnapshot={campaignId:string;revision:number;audience:"gm";npcs:GmCampaignNpcHttp[];relationships:NpcRelationshipHttp[]}|{campaignId:string;revision:number;audience:"player";npcs:PlayerCampaignNpcHttp[];relationships:NpcRelationshipHttp[]};
export type CampaignFactionsSnapshot={campaignId:string;revision:number;audience:"gm";factions:GmCampaignFactionHttp[];standings:FactionStandingHttp[]}|{campaignId:string;revision:number;audience:"player";factions:PlayerCampaignFactionHttp[];standings:FactionStandingHttp[]};

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
  const listCampaignNpcs=(principalId:string,campaignId:string):CampaignNpcsSnapshot|null=>{
    context.guard();if(!member(principalId,campaignId))return null;const isGm=gm(principalId,campaignId);
    const revision=(db.prepare("SELECT revision FROM world_narrative_revisions_v32 WHERE campaign_id=?")
      .get(campaignId) as {revision:number}|undefined)?.revision??0;
    const rows=db.prepare(`SELECT npc.*,metadata.public_state_json,metadata.private_state_json,
      private.private_goals,private.gm_notes,private.merchant_state_json
      FROM campaign_npcs_v28 npc LEFT JOIN campaign_npc_metadata_v32 metadata ON metadata.npc_id=npc.npc_id
      LEFT JOIN campaign_npc_private_state_v28 private ON private.campaign_id=npc.campaign_id AND private.npc_id=npc.npc_id
      WHERE npc.campaign_id=? ORDER BY npc.npc_id`).all(campaignId) as any[];
    const npcs=rows.map((row)=>{
      const publicState=row.public_state_json?JSON.parse(row.public_state_json):{name:row.public_name};
      if(!isGm)return {npcId:row.npc_id,publicState,createdAt:row.created_at};
      const privateState=row.private_state_json?JSON.parse(row.private_state_json):{
        goals:row.private_goals??"",gmNotes:row.gm_notes??"",
        merchantState:row.merchant_state_json?JSON.parse(row.merchant_state_json):null,
      };
      return {npcId:row.npc_id,personaId:row.persona_id,publicState,privateState,createdAt:row.created_at};
    });
    const relationshipRows=db.prepare(`SELECT relationship.campaign_id,relationship.npc_id,relationship.actor_id,
        relationship.affinity,relationship.trust,relationship.fear,relationship.updated_at
      FROM campaign_npc_relationships_v32 relationship WHERE relationship.campaign_id=?
      UNION ALL SELECT legacy.campaign_id,legacy.npc_id,legacy.actor_id,legacy.disposition,0,0,legacy.updated_at
      FROM campaign_npc_relationships_v28 legacy WHERE legacy.campaign_id=? AND NOT EXISTS (
        SELECT 1 FROM campaign_npc_relationships_v32 current WHERE current.campaign_id=legacy.campaign_id
          AND current.npc_id=legacy.npc_id AND current.actor_id=legacy.actor_id)
      ORDER BY npc_id,actor_id`)
      .all(campaignId,campaignId) as any[];
    const visibleRelationshipRows=isGm?relationshipRows:relationshipRows.filter((row)=>db.prepare(`SELECT 1
      FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`)
      .get(campaignId,row.actor_id,principalId));
    const relationships=visibleRelationshipRows.map((row)=>({npcId:row.npc_id,subjectActorId:row.actor_id,
      affinity:row.affinity,trust:row.trust,fear:row.fear,updatedAt:row.updated_at}));
    if(isGm){const response=gmCampaignNpcsHttpResponseSchema.parse({npcs,relationships});return {campaignId,revision,audience:"gm",...response};}
    const response=playerCampaignNpcsHttpResponseSchema.parse({npcs,relationships});return {campaignId,revision,audience:"player",...response};
  };
  const listCampaignFactions=(principalId:string,campaignId:string):CampaignFactionsSnapshot|null=>{
    context.guard();if(!member(principalId,campaignId))return null;const isGm=gm(principalId,campaignId);
    const revision=(db.prepare("SELECT revision FROM world_narrative_revisions_v32 WHERE campaign_id=?").get(campaignId) as any)?.revision??0;
    const rows=db.prepare(`SELECT faction.*,metadata.public_state_json,metadata.private_state_json,private.gm_notes
      FROM campaign_factions_v28 faction LEFT JOIN campaign_faction_metadata_v32 metadata
        ON metadata.campaign_id=faction.campaign_id AND metadata.faction_id=faction.faction_id
      LEFT JOIN campaign_faction_private_state_v28 private ON private.campaign_id=faction.campaign_id AND private.faction_id=faction.faction_id
      WHERE faction.campaign_id=? ORDER BY faction.faction_id`).all(campaignId) as any[];
    const visible=rows.filter((row)=>isGm||row.visibility==="public");const visibleIds=new Set(visible.map((row)=>row.faction_id));
    const factions=visible.map((row)=>{const base={factionId:row.faction_id,name:row.public_name,
      publicState:row.public_state_json?JSON.parse(row.public_state_json):{description:""},createdAt:row.created_at};
      return isGm?{...base,privateState:row.private_state_json?JSON.parse(row.private_state_json):{gmNotes:row.gm_notes??"",visibility:row.visibility}}:base;});
    const ledger=db.prepare(`SELECT faction_id,actor_id,sum(delta) reputation,max(recorded_at) updated_at FROM (
      SELECT faction_id,actor_id,delta,occurred_at recorded_at FROM campaign_reputation_ledger_v28 WHERE campaign_id=?
      UNION ALL SELECT faction_id,actor_id,delta,recorded_at FROM campaign_faction_reputation_v32 WHERE campaign_id=?)
      GROUP BY faction_id,actor_id ORDER BY faction_id,actor_id`).all(campaignId,campaignId) as any[];
    const controlled=isGm?null:new Set((db.prepare(`SELECT actor_id FROM campaign_actor_private_state
      WHERE campaign_id=? AND controller_principal_id=?`).all(campaignId,principalId) as any[]).map((row)=>row.actor_id));
    const standings=ledger.filter((row)=>visibleIds.has(row.faction_id)&&(isGm||controlled!.has(row.actor_id))).map((row)=>({
      factionId:row.faction_id,subjectActorId:row.actor_id,reputation:row.reputation,updatedAt:row.updated_at}));
    if(isGm){const response=gmCampaignFactionsHttpResponseSchema.parse({factions,standings});return {campaignId,revision,audience:"gm",...response};}
    const response=playerCampaignFactionsHttpResponseSchema.parse({factions,standings});return {campaignId,revision,audience:"player",...response};
  };

  return { getWorldProjection,getCampaignWorld,listCampaignNpcs,listCampaignFactions };
}
