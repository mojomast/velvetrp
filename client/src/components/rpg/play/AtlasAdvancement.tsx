import { useEffect, useState } from "react";
import type { CampaignCharacterListResponse } from "@velvet/contracts";
import { LevelUpWizard, type LevelUpWizardApi } from "../character/LevelUpWizard";

export interface AtlasAdvancementApi extends LevelUpWizardApi {
  listCharacters: (campaignId: string) => Promise<CampaignCharacterListResponse>;
}

export function AtlasAdvancement({ campaignId, api, blocked, reauthorize, onLockChange, onStateChange }: {
  campaignId: string; api: AtlasAdvancementApi; blocked: boolean; reauthorize: () => Promise<boolean>;
  onLockChange: (locked: boolean) => void; onStateChange: () => void;
}) {
  const [characters, setCharacters] = useState<CampaignCharacterListResponse["characters"]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true; setError("");
    void api.listCharacters(campaignId).then((value) => { if (current) setCharacters(value.characters); }).catch(() => { if (current) setError("The authorized character roster could not be loaded."); });
    return () => { current = false; };
  }, [api, campaignId, retry]);
  useEffect(() => { onLockChange(locked); }, [locked, onLockChange]);
  useEffect(() => () => onLockChange(false), [onLockChange]);
  return <section className="atlas-advancement">
    <p>Choose the campaign character to advance. The public roster does not identify its play actor; names are not used to guess that binding. The server checks your control before applying levels.</p>
    {error && <p role="alert">{error}</p>}
    <label>Advancement character<select value={selected} disabled={blocked || locked} onChange={(event) => setSelected(event.target.value)}><option value="">Choose a roster character</option>{characters.map((character) => <option key={character.id} value={character.id}>{character.name} ({character.id})</option>)}</select></label>
    <button type="button" disabled={locked} onClick={() => setRetry((value) => value + 1)}>Refresh character roster</button>
    {selected && characters.some((character) => character.id === selected) && <LevelUpWizard key={selected} campaignId={campaignId} campaignCharacterId={selected} api={api} blocked={blocked} reauthorize={reauthorize}
      onLockChange={setLocked} onSheetRefreshed={onStateChange} onUnavailable={() => setError("Advancement is unavailable for this roster character with your current access.")} />}
  </section>;
}
