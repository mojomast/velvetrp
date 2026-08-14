import { useEffect, useState } from "react";
import type { ActorEffectsResponse, ActorResourcesHttpGetResponse, InventoryHttpGetResponse } from "@velvet/contracts";
import type { CampaignPlayActor } from "@velvet/contracts";

export interface CampaignQuickPanelApi {
  getActorResources: (campaignId: string, actorId: string) => Promise<ActorResourcesHttpGetResponse>;
  getActorInventory: (campaignId: string, actorId: string) => Promise<InventoryHttpGetResponse>;
  getActorEffects: (actorId: string) => Promise<ActorEffectsResponse>;
}

interface CampaignQuickPanelProps {
  campaignId: string;
  selectedActorId: string | null;
  actors: readonly CampaignPlayActor[];
  api: CampaignQuickPanelApi;
}

type QuickState = {
  resources: ActorResourcesHttpGetResponse | null;
  inventory: InventoryHttpGetResponse | null;
  effects: ActorEffectsResponse | null;
};

export function CampaignQuickPanel({ campaignId, selectedActorId, actors, api }: CampaignQuickPanelProps) {
  const [state, setState] = useState<QuickState>({ resources: null, inventory: null, effects: null });
  const [loading, setLoading] = useState(false);
  const [failures, setFailures] = useState(0);

  useEffect(() => {
    let current = true;
    setState({ resources: null, inventory: null, effects: null });
    setFailures(0);
    if (!selectedActorId || !actors.some((actor) => actor.actorId === selectedActorId)) return () => { current = false; };
    setLoading(true);
    void Promise.allSettled([
      api.getActorResources(campaignId, selectedActorId),
      api.getActorInventory(campaignId, selectedActorId),
      api.getActorEffects(selectedActorId),
    ] as const).then(([resources, inventory, effects]) => {
      if (!current) return;
      setState({
        resources: resources.status === "fulfilled" ? resources.value : null,
        inventory: inventory.status === "fulfilled" ? inventory.value : null,
        effects: effects.status === "fulfilled" ? effects.value : null,
      });
      setFailures([resources, inventory, effects].filter((result) => result.status === "rejected").length);
      setLoading(false);
    });
    return () => { current = false; };
  }, [actors, api, campaignId, selectedActorId]);

  const actor = actors.find((candidate) => candidate.actorId === selectedActorId);
  return <aside id="campaign-quick-tools" className="campaign-quick-panel" aria-label="Character quick tools" tabIndex={-1}>
    <header><div><p className="eyebrow">ACTING CHARACTER</p><h2>{actor?.name ?? "No actor selected"}</h2></div>{loading && <span role="status">Refreshing...</span>}</header>
    {failures > 0 && <p className="quick-panel-warning" role="alert">{failures} character {failures === 1 ? "lane is" : "lanes are"} unavailable. No state was inferred.</p>}
    <section aria-labelledby="quick-party-heading"><div className="quick-section-heading"><h3 id="quick-party-heading">Party</h3><span>{actors.length}</span></div>{actors.length ? <ul className="quick-party-list">{actors.map((member) => <li className={member.actorId === selectedActorId ? "is-acting" : ""} key={member.actorId}>{member.name}<span>{member.actorId === selectedActorId ? "Acting" : "Available"}</span></li>)}</ul> : <p className="quick-empty">No controlled actors available.</p>}</section>
    <section aria-labelledby="quick-resources-heading"><div className="quick-section-heading"><h3 id="quick-resources-heading">Health & resources</h3><span>{state.resources?.resources.length ?? 0}</span></div>{state.resources?.resources.length ? <ul className="quick-resource-list">{state.resources.resources.map((resource) => <li key={resource.name}><div><strong>{resource.name}</strong><span>{resource.current} / {resource.max}</span></div><progress value={resource.current} max={Math.max(1, resource.max)} aria-label={`${resource.name}: ${resource.current} of ${resource.max}`} /></li>)}</ul> : <p className="quick-empty">{selectedActorId ? "No resource tracks available." : "Select an acting character."}</p>}</section>
    <section aria-labelledby="quick-inventory-heading"><div className="quick-section-heading"><h3 id="quick-inventory-heading">Inventory quick access</h3><span>{state.inventory?.entries.length ?? 0}</span></div>{state.inventory?.entries.length ? <ul className="quick-inventory-list">{state.inventory.entries.slice(0, 8).map((entry) => <li key={entry.entryId}><span>{entry.item.definitionId}</span><strong>{entry.kind === "stackable" ? `x${entry.quantity}` : "1"}</strong></li>)}</ul> : <p className="quick-empty">No carried items.</p>}{state.inventory && state.inventory.entries.length > 8 && <p className="quick-more">+{state.inventory.entries.length - 8} more in the character sheet</p>}</section>
    <section aria-labelledby="quick-effects-heading"><div className="quick-section-heading"><h3 id="quick-effects-heading">Active effects</h3><span>{state.effects?.effects.length ?? 0}</span></div>{state.effects?.effects.length ? <ul className="quick-effects-list">{state.effects.effects.map((effect) => <li key={effect.effectId}><strong>{effect.modifiers.map((modifier) => modifier.kind).join(", ") || "Effect"}</strong><span>{effect.duration.kind.replaceAll("_", " ")}</span></li>)}</ul> : <p className="quick-empty">No active effects.</p>}</section>
    <p className="quick-panel-note">Inventory and effects are read-only here. Commands remain in the authoritative character and combat workspaces.</p>
  </aside>;
}
