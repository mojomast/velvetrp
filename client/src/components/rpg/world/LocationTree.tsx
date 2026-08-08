import type { CampaignWorldHttpResponse } from "@velvet/contracts";
import { useMemo, useRef, useState } from "react";

type Location = CampaignWorldHttpResponse["visibleLocations"][number];
export function LocationTree({ locations, currentLocationIds = [] }: { locations: Location[]; currentLocationIds?: string[] }) {
  const [selected, setSelected] = useState(0);
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const ordered = useMemo(() => {
    const byParent = new Map<string | null, Location[]>();
    for (const location of locations) byParent.set(location.parentLocationId, [...(byParent.get(location.parentLocationId) ?? []), location]);
    const output: Array<{ location: Location; level: number }> = [], visited = new Set<string>();
    const walk = (parent: string | null, level: number) => {
      for (const location of byParent.get(parent) ?? []) { if (visited.has(location.locationId)) continue; visited.add(location.locationId); output.push({ location, level }); walk(location.locationId, level + 1); }
    };
    walk(null, 1);
    for (const location of locations) if (!visited.has(location.locationId)) output.push({ location, level: 1 });
    return output;
  }, [locations]);
  const focus = (index: number) => { const next = Math.max(0, Math.min(ordered.length - 1, index)); setSelected(next); refs.current[next]?.focus(); };
  if (!ordered.length) return <p>No known locations.</p>;
  return <ul className="location-tree" role="tree" aria-label="Known location hierarchy">
    {ordered.map(({ location, level }, index) => <li key={location.locationId} role="none">
      <button ref={(node) => { refs.current[index] = node; }} type="button" role="treeitem" aria-level={level} aria-current={currentLocationIds.includes(location.locationId) ? "location" : undefined} tabIndex={index === selected ? 0 : -1}
        style={{ "--tree-depth": level - 1 } as React.CSSProperties}
        onFocus={() => setSelected(index)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); focus(index + 1); } else if (event.key === "ArrowUp") { event.preventDefault(); focus(index - 1); } else if (event.key === "Home") { event.preventDefault(); focus(0); } else if (event.key === "End") { event.preventDefault(); focus(ordered.length - 1); } }}>
        <strong><bdi dir="auto">{location.name}</bdi></strong>{currentLocationIds.includes(location.locationId) && <span>Current</span>}
        {location.description && <small><bdi dir="auto">{location.description}</bdi></small>}
      </button>
    </li>)}
  </ul>;
}
