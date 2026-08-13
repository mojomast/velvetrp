import type DatabaseDriver from "better-sqlite3";

export type ActorTravelPolicyDenial =
  | "identity-or-authority"
  | "session-unavailable"
  | "route-unavailable"
  | "not-adjacent"
  | "undiscovered"
  | "requirement-not-met";

export type ActorTravelRoute = {
  connectionId: string;
  fromLocationId: string;
  toLocationId: string;
  visibility: string;
  requirementKind: string;
};

export type ActorTravelPosition = { actorId: string; locationId: string; revision: number };
export type ActorTravelPolicyResult =
  | { allowed: true; route: ActorTravelRoute; positions: ActorTravelPosition[] }
  | { allowed: false; reason: ActorTravelPolicyDenial };

/**
 * Evaluates one exact connection against authoritative current identity, party,
 * session, location, discovery, and reputation state. Denial reasons are for
 * internal control flow only and must not be exposed by public adapters.
 */
export function evaluateActorTravelPolicy(
  db: DatabaseDriver.Database,
  input: {
    campaignId: string;
    sessionId: string;
    actorId: string;
    principalId: string;
    partyActorIds: readonly string[];
    connectionId: string;
    requireRunningSession: boolean;
    /** Replay authorization checks identity and exact party authority without consulting mutable route state. */
    authorityOnly?: boolean;
  },
): ActorTravelPolicyResult {
  const membership = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
    .get(input.campaignId, input.principalId) as { role: string } | undefined;
  if (!membership || membership.role === "observer" || !input.partyActorIds.includes(input.actorId))
    return { allowed: false, reason: "identity-or-authority" };

  const attached = db.prepare(`SELECT session.state,session.stopped_at FROM campaign_sessions attached
    JOIN sessions session ON session.id=attached.session_id WHERE attached.campaign_id=? AND attached.session_id=?`)
    .get(input.campaignId, input.sessionId) as { state: string; stopped_at: string | null } | undefined;
  if (!attached || (input.requireRunningSession && (attached.state !== "active" || attached.stopped_at !== null)))
    return { allowed: false, reason: "session-unavailable" };

  const isGm = membership.role === "owner" || membership.role === "gm";
  for (const partyActorId of input.partyActorIds) {
    const actor = db.prepare("SELECT 1 FROM campaign_actors WHERE campaign_id=? AND id=?")
      .get(input.campaignId, partyActorId);
    const controls = isGm || db.prepare(`SELECT 1 FROM campaign_actor_private_state
      WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?`).get(input.campaignId, partyActorId, input.principalId);
    if (!actor || !controls) return { allowed: false, reason: "identity-or-authority" };
  }

  if (input.authorityOnly) return { allowed: true, route: { connectionId: input.connectionId,
    fromLocationId: "", toLocationId: "", visibility: "", requirementKind: "" }, positions: [] };

  const row = db.prepare(`SELECT connection_id,from_location_id,to_location_id,visibility,route_state,
      requirement_kind,required_faction_id,minimum_reputation
    FROM campaign_location_connections_v28 WHERE campaign_id=? AND connection_id=?`)
    .get(input.campaignId, input.connectionId) as any;
  if (!row || row.route_state !== "open" || (!isGm && row.visibility === "gm"))
    return { allowed: false, reason: "route-unavailable" };

  const positions: ActorTravelPosition[] = [];
  for (const partyActorId of input.partyActorIds) {
    const position = db.prepare(`SELECT location_id,state_revision FROM campaign_actor_locations_v28
      WHERE campaign_id=? AND session_id=? AND actor_id=?`).get(input.campaignId, input.sessionId, partyActorId) as any;
    if (!position || position.location_id !== row.from_location_id) return { allowed: false, reason: "not-adjacent" };
    if ((row.visibility === "discovered" || row.requirement_kind === "discovery")
      && !db.prepare(`SELECT 1 FROM campaign_location_discoveries_v28 WHERE campaign_id=? AND actor_id=? AND location_id=?`)
        .get(input.campaignId, partyActorId, row.to_location_id)) return { allowed: false, reason: "undiscovered" };
    if (row.requirement_kind === "faction_reputation") {
      const total = (db.prepare(`SELECT coalesce(sum(delta),0) total FROM (
        SELECT delta FROM campaign_reputation_ledger_v28 WHERE campaign_id=? AND actor_id=? AND faction_id=?
        UNION ALL SELECT delta FROM campaign_faction_reputation_v32 WHERE campaign_id=? AND actor_id=? AND faction_id=?)`)
        .get(input.campaignId, partyActorId, row.required_faction_id, input.campaignId, partyActorId, row.required_faction_id) as { total: number }).total;
      if (total < row.minimum_reputation) return { allowed: false, reason: "requirement-not-met" };
    }
    positions.push({ actorId: partyActorId, locationId: position.location_id, revision: position.state_revision });
  }
  return { allowed: true, route: { connectionId: row.connection_id, fromLocationId: row.from_location_id,
    toLocationId: row.to_location_id, visibility: row.visibility, requirementKind: row.requirement_kind }, positions };
}
