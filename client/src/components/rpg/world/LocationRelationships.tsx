import { useEffect, useState } from "react";
import type { CampaignGeneratedPlanning } from "@velvet/contracts";
import { getCampaignGeneratedFoundation, getCampaignGeneratedPlanning, listCampaignFactions, listCampaignNpcs, listCampaignQuests } from "../../../api";
import type { StudioAuthorization } from "../StudioAuthorization";
import { useCampaignShell } from "../shell/CampaignShell";

type Context = {
  planning: CampaignGeneratedPlanning;
  opening: Awaited<ReturnType<typeof getCampaignGeneratedFoundation>>["opening"];
  npcs: Map<string, string>; factions: Map<string, string>; quests: Map<string, string>;
};

export function LocationRelationships({ campaignId, authorization, locationId }: { campaignId: string; authorization: StudioAuthorization; locationId: string }) {
  const { navigate, generationAvailable } = useCampaignShell();
  const [result, setResult] = useState<{ scope: string; data: Context | null; failed: boolean } | null>(null);
  const scope = `${campaignId}:${authorization.audience}:${authorization.generation}`;
  const gm = authorization.audience === "gm";
  useEffect(() => {
    if (!gm) return;
    let current = true;
    void Promise.all([getCampaignGeneratedPlanning(campaignId), getCampaignGeneratedFoundation(campaignId), listCampaignNpcs(campaignId, "gm"), listCampaignFactions(campaignId, "gm"), listCampaignQuests(campaignId, "gm")])
      .then(([planning, foundation, npcs, factions, quests]) => {
        if (current) setResult({ scope, failed: false, data: { planning, opening: foundation.opening,
          npcs: new Map(npcs.data.npcs.map(item => [item.npcId, item.publicState.name])),
          factions: new Map(factions.data.factions.map(item => [item.factionId, item.name])),
          quests: new Map(quests.data.quests.map(item => [item.questId, item.title])) } });
      }).catch(() => { if (current) setResult({ scope, data: null, failed: true }); });
    return () => { current = false; };
  }, [campaignId, gm, scope]);
  if (!gm) return <p>Only server-visible locations and exits are shown. Private planning links are not part of the player projection.</p>;
  const data = result?.scope === scope ? result.data : null;
  return <>
    <section className="worldbuilding-opening" aria-labelledby="opening-preparation-heading">
      <h2 id="opening-preparation-heading">Prepare the opening</h2>
      {data?.opening ? <><p>{data.opening.premise}</p><p>{data.opening.opening}</p><p>An outline location key is narrative context, not the authoritative designation shown above.</p></> : <p>{result?.scope === scope && result.failed ? "Opening and planning context could not be loaded. Reauthorize & refresh to retry." : data ? "No applied opening outline yet." : "Loading opening and planning context..."}</p>}
      <ol><li>In Create, apply a public named location, then explicitly designate the opening once. Selecting a location here does not move anyone or designate it.</li><li>Prepare NPC definitions and an opening quest. NPC presence is managed in the attached room, not by editing this map.</li><li>Prepare and attach a room separately; this world view does not claim room readiness.</li></ol>
      {navigate && <div className="button-row">{generationAvailable && <button onClick={() => navigate("create")}>Prepare opening in Create</button>}<button onClick={() => navigate("cast")}>Prepare opening cast</button><button onClick={() => navigate("journal")}>Prepare opening quest</button><button onClick={() => navigate("play")}>Check room readiness</button></div>}
    </section>
    {data && locationId && <section aria-labelledby="location-relationships-heading"><h2 id="location-relationships-heading">Related preparation</h2>
      <p className="field-help">GM planning links, not proof of current NPC presence or player discovery. Public planning material is not automatically delivered to players.</p>
      <ul className="worldbuilding-links">
        {data.planning.encounters.filter(item => item.locationId === locationId).map(item => <li key={item.resourceId}><strong>{item.title}</strong> (encounter plan; {item.visibility})<p>{item.description}</p><p>Cast: {item.participantNpcIds.map(id => data.npcs.get(id) ?? "Unavailable NPC").join(", ") || "None linked"}</p>{navigate && <button onClick={() => navigate("cast")}>Review linked cast</button>}</li>)}
        {data.planning.lore.filter(item => item.locationIds.includes(locationId)).map(item => <li key={item.resourceId}><strong>{item.title}</strong> (lore; {item.visibility})<p>{item.summary}</p><p>Factions: {item.factionIds.map(id => data.factions.get(id) ?? "Unavailable faction").join(", ") || "None linked"}</p>{navigate && <button onClick={() => navigate("cast")}>Review linked factions</button>}</li>)}
        {data.planning.questItems.filter(item => item.locationIds.includes(locationId)).map(item => <li key={item.resourceId}><strong>{item.title}</strong> (quest item; {item.visibility})<p>{item.description}</p><p>Quests: {item.questIds.map(id => data.quests.get(id) ?? "Unavailable quest").join(", ") || "None linked"}</p>{navigate && <button onClick={() => navigate("journal")}>Review linked quests</button>}</li>)}
        {data.planning.deliverables.filter(item => item.locationId === locationId).map(item => <li key={item.resourceId}><strong>{item.title}</strong> ({item.kind}; {item.publishedAt ? "Published" : "Not published"})<p>Cast: {item.npcIds.map(id => data.npcs.get(id) ?? "Unavailable NPC").join(", ") || "None linked"}</p></li>)}
      </ul>
      {!data.planning.encounters.some(item => item.locationId === locationId) && !data.planning.lore.some(item => item.locationIds.includes(locationId)) && !data.planning.questItems.some(item => item.locationIds.includes(locationId)) && !data.planning.deliverables.some(item => item.locationId === locationId) && <p>No persisted planning links for this location. No relationships are inferred from names or prose.</p>}
    </section>}
  </>;
}
