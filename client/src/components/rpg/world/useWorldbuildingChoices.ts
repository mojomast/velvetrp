import { useEffect, useState } from "react";
import { getCampaignStory, getEncounterSetupCandidates, listCharacters } from "../../../api";
import type { StudioAuthorization } from "../StudioAuthorization";

export type NamedChoice = { id: string; name: string };
export function useWorldbuildingChoices(campaignId: string, authorization: StudioAuthorization, kind: "personas" | "actors" | "storylines") {
  const [result, setResult] = useState<{ scope: string; choices: NamedChoice[]; failed: boolean } | null>(null);
  const scope = `${campaignId}:${authorization.audience}:${authorization.generation}:${kind}`;
  useEffect(() => {
    if (authorization.audience !== "gm") return;
    let current = true;
    const load = async (): Promise<NamedChoice[]> => {
      if (kind === "personas") return (await listCharacters()).characters.map(item => ({ id: item.id, name: item.name }));
      if (kind === "actors") return (await getEncounterSetupCandidates(campaignId)).actors.map(item => ({ id: item.actorId, name: item.label }));
      return (await getCampaignStory(campaignId, "gm")).data.storylines.map(item => ({ id: item.storylineId, name: item.title }));
    };
    void load().then(choices => { if (current) setResult({ scope, choices, failed: false }); })
      .catch(() => { if (current) setResult({ scope, choices: [], failed: true }); });
    return () => { current = false; };
  }, [campaignId, authorization.audience, kind, scope]);
  return result?.scope === scope && authorization.audience === "gm" ? result : { choices: [], failed: false };
}
