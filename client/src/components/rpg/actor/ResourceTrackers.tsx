import type { ActorResourcesHttpResources } from "@velvet/contracts";

export interface ResourceTrackersProps {
  resources: ActorResourcesHttpResources;
}

/** Renders the exact current/max values supplied by the actor-resource route. */
export function ResourceTrackers({ resources }: ResourceTrackersProps) {
  return <section className="actor-section" aria-labelledby="actor-resources-heading">
    <div className="actor-section-heading"><h2 id="actor-resources-heading">Resources</h2><span className="count-badge">{resources.length}</span></div>
    {resources.length === 0 ? <p className="actor-empty">No tracked resources.</p> : <ul className="resource-trackers">
      {resources.map((resource) => <li key={resource.name}>
        <div><strong><bdi dir="auto">{resource.name}</bdi></strong><span>{resource.current} of {resource.max}</span></div>
        <progress value={resource.current} max={resource.max || 1} aria-label={`${resource.name}: ${resource.current} of ${resource.max}`} />
      </li>)}
    </ul>}
  </section>;
}
