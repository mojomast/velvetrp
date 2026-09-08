import type { CampaignWorldHttpResponse } from "@velvet/contracts";
import { useId, useMemo } from "react";

type VisibleLocation = CampaignWorldHttpResponse["visibleLocations"][number];

export interface CampaignRouteMapProps {
  world: CampaignWorldHttpResponse;
  selectedActorId: string | null;
  onPrefillDeclaration: (declaration: string) => void;
  onOpenWorld: () => void;
}

type PositionedLocation = {
  location: VisibleLocation;
  depth: number;
  x: number;
  y: number;
};

function hierarchyDepth(location: VisibleLocation, byId: ReadonlyMap<string, VisibleLocation>): number {
  const visited = new Set<string>();
  let current = location;
  let depth = 0;
  while (current.parentLocationId !== null) {
    if (visited.has(current.locationId)) return 0;
    visited.add(current.locationId);
    const parent = byId.get(current.parentLocationId);
    if (!parent) return depth;
    depth += 1;
    current = parent;
  }
  return depth;
}

/** A presentation-only view of the directed routes in the server's world projection. */
export function CampaignRouteMap({ world, selectedActorId, onPrefillDeclaration, onOpenWorld }: CampaignRouteMapProps) {
  const headingId = useId();
  const descriptionId = useId();
  const { positioned, positions, width, height } = useMemo(() => {
    const byId = new Map<string, VisibleLocation>();
    for (const location of world.visibleLocations) if (!byId.has(location.locationId)) byId.set(location.locationId, location);
    const rows = world.visibleLocations.map((location, order) => {
      const depth = hierarchyDepth(location, byId);
      return { location, depth, x: 80 + depth * 180, y: 55 + order * 90 };
    });
    const lookup = new Map<string, PositionedLocation>();
    for (const row of rows) if (!lookup.has(row.location.locationId)) lookup.set(row.location.locationId, row);
    const maxDepth = rows.reduce((maximum, row) => Math.max(maximum, row.depth), 0);
    return {
      positioned: rows,
      positions: lookup,
      width: Math.max(360, 160 + maxDepth * 180),
      height: Math.max(180, 110 + Math.max(0, rows.length - 1) * 90),
    };
  }, [world.visibleLocations]);

  const currentLocationId = world.currentLocations.find((entry) => entry.actorId === selectedActorId)?.locationId;
  const outgoing = currentLocationId === undefined ? [] : world.visibleConnections.filter((connection) =>
    connection.fromLocationId === currentLocationId && positions.has(connection.fromLocationId) && positions.has(connection.toLocationId));
  const reachableIds = new Set(outgoing.map((connection) => connection.toLocationId));

  return <section className="campaign-route-map" aria-labelledby={headingId}>
    <header className="campaign-route-map-header">
      <div><p className="eyebrow">ROUTE MAP</p><h2 id={headingId}>Known routes</h2></div>
      <button type="button" className="ghost" onClick={onOpenWorld}>Open World</button>
    </header>
    <p id={descriptionId} className="route-map-note">Topological route map, not to scale. Arrows show only server-visible directed connections.</p>
    {positioned.length === 0 ? <p className="quick-empty">No known locations.</p> : <svg className="route-map-canvas" role="img" aria-labelledby={`${headingId} ${descriptionId}`}
      viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMinYMin meet">
      {world.visibleConnections.map((connection, index) => {
        const from = positions.get(connection.fromLocationId);
        const to = positions.get(connection.toLocationId);
        if (!from || !to) return null;
        const isOutgoing = connection.fromLocationId === currentLocationId;
        return <g className={`route-map-connection${isOutgoing ? " is-reachable" : ""}`} key={`${connection.connectionId}-${index}`}>
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="currentColor" strokeWidth={isOutgoing ? 3 : 1.5} />
          <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 5} textAnchor="middle" aria-hidden="true">→</text>
        </g>;
      })}
      {positioned.map(({ location, depth, x, y }, index) => {
        const isCurrent = location.locationId === currentLocationId;
        const isReachable = reachableIds.has(location.locationId);
        return <g className={`route-map-location${isCurrent ? " is-current" : ""}${isReachable ? " is-reachable" : ""}`}
          data-location-id={location.locationId} data-depth={depth} transform={`translate(${x} ${y})`} key={`${location.locationId}-${index}`}>
          <title>{location.name}{isCurrent ? ", current location" : isReachable ? ", reachable destination" : ""}</title>
          <circle r={isCurrent ? 22 : 18} fill={isCurrent ? "currentColor" : "Canvas"} stroke="currentColor" strokeWidth={isReachable ? 4 : 2} />
          {isCurrent && <circle r="7" fill="Canvas" />}
          <text y="35" textAnchor="middle" fill="currentColor"><tspan>{location.name}</tspan></text>
        </g>;
      })}
    </svg>}
    <section className="route-map-destinations" aria-labelledby={`${headingId}-destinations`}>
      <h3 id={`${headingId}-destinations`}>Reachable destinations</h3>
      {outgoing.length > 0 ? <ul>{outgoing.map((connection, index) => {
        const destination = positions.get(connection.toLocationId)!.location;
        return <li key={`${connection.connectionId}-${index}`}><button type="button" className="ghost"
          onClick={() => onPrefillDeclaration(`Travel to ${destination.name}.`)}>
          Prefill travel to <bdi dir="auto">{destination.name}</bdi>
        </button></li>;
      })}</ul> : <p className="quick-empty">No outgoing reachable destinations for the selected actor.</p>}
    </section>
  </section>;
}
