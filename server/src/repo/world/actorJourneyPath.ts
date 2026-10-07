import type DatabaseDriver from "better-sqlite3";
import {
  evaluateActorTravelConnectionPolicy,
  resolveActorTravelAuthority,
  type ActorTravelPosition,
  type ActorTravelRoute,
} from "./actorTravelPolicy.js";

/** Hard bound on journey length; a destination farther than this is unreachable. */
export const MAX_ACTOR_JOURNEY_HOPS = 32;
/** Hard bound on the route graph scanned for one journey; larger graphs fail closed. */
export const MAX_ACTOR_JOURNEY_EDGES = 10_000;

export interface ActorJourneyPathInput {
  campaignId: string;
  sessionId: string;
  actorId: string;
  principalId: string;
  partyActorIds: readonly string[];
  targetLocationId: string;
  /** Provider player decisions never inherit owner/GM hidden-route visibility. */
  audienceMode?: "principal" | "player";
}

export interface ActorJourneyPath {
  originLocationId: string;
  destinationLocationId: string;
  steps: ActorTravelRoute[];
  positions: ActorTravelPosition[];
}

/**
 * Resolves the deterministic shortest server-authored path from the party's
 * current location to `targetLocationId` using only open, visible, legal
 * connections. Every step is evaluated by the shared connection policy, so
 * route state, GM visibility, discovery, faction-reputation, and party-control
 * rules are never bypassed. Real party co-location at the initial origin is
 * proven up front; later steps are evaluated against their hypothetical node
 * because the party moves as one unit.
 *
 * Returns null when authority, session, co-location, the edge bound, the hop
 * bound, or reachability fails. Active-combat blocking is a caller concern.
 */
export function resolveActorJourneyPath(
  db: DatabaseDriver.Database,
  input: ActorJourneyPathInput,
): ActorJourneyPath | null {
  if (input.partyActorIds.length === 0) return null;
  if (new Set(input.partyActorIds).size !== input.partyActorIds.length) return null;

  const authority = resolveActorTravelAuthority(db, {
    campaignId: input.campaignId,
    sessionId: input.sessionId,
    actorId: input.actorId,
    principalId: input.principalId,
    partyActorIds: input.partyActorIds,
    requireRunningSession: true,
    ...(input.audienceMode === undefined ? {} : { audienceMode: input.audienceMode }),
  });
  if (!authority.allowed) return null;
  const resolvedAuthority = authority.authority;

  const positions: ActorTravelPosition[] = [];
  let originLocationId: string | null = null;
  for (const partyActorId of input.partyActorIds) {
    const position = db.prepare(`SELECT location_id,state_revision FROM campaign_actor_locations_v28
      WHERE campaign_id=? AND session_id=? AND actor_id=?`)
      .get(input.campaignId, input.sessionId, partyActorId) as { location_id: string; state_revision: number } | undefined;
    if (!position) return null;
    if (originLocationId === null) originLocationId = position.location_id;
    else if (position.location_id !== originLocationId) return null;
    positions.push({ actorId: partyActorId, locationId: position.location_id, revision: position.state_revision });
  }
  if (originLocationId === null) return null;
  const origin = originLocationId;
  if (input.targetLocationId === origin) return null;

  const edges = db.prepare(`SELECT connection_id,from_location_id,to_location_id FROM campaign_location_connections_v28
    WHERE campaign_id=? ORDER BY connection_id COLLATE BINARY LIMIT ?`)
    .all(input.campaignId, MAX_ACTOR_JOURNEY_EDGES + 1) as Array<{ connection_id: string; from_location_id: string; to_location_id: string }>;
  if (edges.length > MAX_ACTOR_JOURNEY_EDGES) return null;

  // Edge rows are already ordered by connection id, so every adjacency list is
  // deterministically ordered and BFS ties resolve the same way across runs.
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from_location_id);
    if (list) list.push(edge.connection_id);
    else outgoing.set(edge.from_location_id, [edge.connection_id]);
  }

  const routeCache = new Map<string, ActorTravelRoute | null>();
  const routeFor = (connectionId: string, fromNode: string): ActorTravelRoute | null => {
    const cached = routeCache.get(connectionId);
    if (cached !== undefined) return cached;
    const result = evaluateActorTravelConnectionPolicy(db, {
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      partyActorIds: input.partyActorIds,
      connectionId,
      authority: resolvedAuthority,
      ...(input.audienceMode === undefined ? {} : { audienceMode: input.audienceMode }),
      // The first hop is checked against the real persisted party location; later
      // hops use the hypothetical node the party would occupy.
      ...(fromNode === origin ? {} : { simulatedOriginLocationId: fromNode }),
    });
    const route = result.allowed ? result.route : null;
    routeCache.set(connectionId, route);
    return route;
  };

  const parent = new Map<string, { from: string; connectionId: string }>();
  const depth = new Map<string, number>([[origin, 0]]);
  const visited = new Set<string>([origin]);
  const queue: string[] = [origin];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]!;
    const currentDepth = depth.get(current)!;
    if (currentDepth >= MAX_ACTOR_JOURNEY_HOPS) continue;
    for (const connectionId of outgoing.get(current) ?? []) {
      const route = routeFor(connectionId, current);
      if (!route) continue;
      const next = route.toLocationId;
      if (visited.has(next)) continue;
      visited.add(next);
      depth.set(next, currentDepth + 1);
      parent.set(next, { from: current, connectionId });
      if (next === input.targetLocationId) {
        const steps: ActorTravelRoute[] = [];
        let node = input.targetLocationId;
        while (node !== origin) {
          const link = parent.get(node);
          const step = link ? routeCache.get(link.connectionId) : undefined;
          if (!link || !step) return null;
          steps.push(step);
          node = link.from;
        }
        steps.reverse();
        return { originLocationId: origin, destinationLocationId: input.targetLocationId, steps, positions };
      }
      queue.push(next);
    }
  }
  return null;
}
