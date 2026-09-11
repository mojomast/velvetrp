import type { ActorResourcesHttpResources } from "@velvet/contracts";
import { useState } from "react";

export interface ResourceAdjustIntent { kind: "change"; resourceName: string; amount: number; }
export interface ResourceTrackersProps {
  resources: ActorResourcesHttpResources;
  disabled?: boolean;
  onAdjust?: (intent: ResourceAdjustIntent) => void;
}

/** Renders the exact current/max values supplied by the actor-resource route, with optional GM/player adjustment. */
export function ResourceTrackers({ resources, disabled = false, onAdjust }: ResourceTrackersProps) {
  const [resourceName, setResourceName] = useState(resources[0]?.name ?? "");
  const [amount, setAmount] = useState("");
  const parsed = Number(amount);
  const valid = resourceName.length > 0 && Number.isSafeInteger(parsed) && parsed !== 0 && parsed >= -1_000_000 && parsed <= 1_000_000;
  return <section className="actor-section" aria-labelledby="actor-resources-heading">
    <div className="actor-section-heading"><h2 id="actor-resources-heading">Resources</h2><span className="count-badge">{resources.length}</span></div>
    {resources.length === 0 ? <p className="actor-empty">No tracked resources.</p> : <ul className="resource-trackers">
      {resources.map((resource) => <li key={resource.name}>
        <div><strong><bdi dir="auto">{resource.name}</bdi></strong><span>{resource.current} of {resource.max}</span></div>
        <progress value={resource.current} max={resource.max || 1} aria-label={`${resource.name}: ${resource.current} of ${resource.max}`} />
      </li>)}
    </ul>}
    {onAdjust && resources.length > 0 && <div className="resource-adjust-form">
      <p className="actor-help">Changes are bounded, revision-checked, and recorded as a receipt. Negative amounts spend; positive amounts restore.</p>
      <label className="field">Resource<select value={resourceName} disabled={disabled} onChange={(event) => setResourceName(event.target.value)}>{resources.map((resource) => <option key={resource.name} value={resource.name}>{resource.name}</option>)}</select></label>
      <label className="field">Amount<input type="number" value={amount} disabled={disabled} onChange={(event) => setAmount(event.target.value)} /></label>
      <div className="button-row"><button className="ghost" type="button" disabled={disabled || !valid} onClick={() => { onAdjust({ kind: "change", resourceName, amount: parsed }); setAmount(""); }}>Adjust resource</button></div>
    </div>}
  </section>;
}
