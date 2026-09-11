import { useState } from "react";
import type { ActorCampCommandRequest, ActorPlacementCommandRequest, CampaignWorldHttpResponse } from "@velvet/contracts";
import { createClientId } from "../../../utils/clientId";

export interface WorldExpeditionApi {
  place: (actorId: string, input: ActorPlacementCommandRequest) => Promise<unknown>;
  camp: (actorId: string, input: ActorCampCommandRequest) => Promise<unknown>;
}

/** GM bootstrap placement and camp are revision-bound world commands; this panel never retries one. */
export function WorldExpeditionPanel({ campaignId, revision, world, actors, canCommand, disabled, api }: {
  campaignId: string; revision: number; world: CampaignWorldHttpResponse;
  actors: readonly { actorId: string; name: string }[];
  canCommand: boolean; disabled: boolean; api: WorldExpeditionApi;
}) {
  const [actorId, setActorId] = useState(actors[0]?.actorId ?? "");
  const [locationId, setLocationId] = useState(world.visibleLocations[0]?.locationId ?? "");
  const [pending, setPending] = useState(false);
  if (!canCommand || actors.length === 0) return null;
  const placed = new Set(world.currentLocations.map((item) => item.actorId));
  const isPlaced = placed.has(actorId);
  const ready = !disabled && !pending && actorId.length > 0;
  function submit(action: Promise<unknown>): void {
    setPending(true);
    void action.catch(() => undefined).finally(() => setPending(false));
  }
  function submitPlace(): void {
    if (!ready || isPlaced || locationId.length === 0) return;
    submit(api.place(actorId, { campaignId, locationId, expectedRevision: revision, idempotencyKey: createClientId() }));
  }
  function submitCamp(): void {
    if (!ready || !isPlaced) return;
    submit(api.camp(actorId, { campaignId, expectedRevision: revision, idempotencyKey: createClientId() }));
  }
  return <section className="world-expedition" aria-labelledby="world-expedition-heading">
    <h3 id="world-expedition-heading">Expedition</h3>
    <p>Bootstrap placement and camp are authoritative server commands bound to the current world revision. They are never retried automatically.</p>
    <div className="world-expedition-fields">
      <label>Actor
        <select value={actorId} disabled={disabled || actors.length === 0} onChange={(event) => setActorId(event.target.value)}>
          {actors.map((actor) => <option key={actor.actorId} value={actor.actorId}>{actor.name}</option>)}
        </select>
      </label>
      <label>Location
        <select value={locationId} disabled={disabled || world.visibleLocations.length === 0} onChange={(event) => setLocationId(event.target.value)}>
          {world.visibleLocations.length === 0 && <option value="">No known locations</option>}
          {world.visibleLocations.map((entry) => <option key={entry.locationId} value={entry.locationId}>{entry.name}</option>)}
        </select>
      </label>
    </div>
    <div className="world-expedition-actions">
      <button type="button" disabled={!ready || isPlaced || locationId.length === 0} onClick={submitPlace}>Place actor</button>
      <button type="button" disabled={!ready || !isPlaced} onClick={submitCamp}>Make camp</button>
    </div>
    <p className="meta-text">{isPlaced ? "This actor is placed; camp is available at its current location." : "This actor is unplaced; choose a location and place it before making camp."}</p>
  </section>;
}
