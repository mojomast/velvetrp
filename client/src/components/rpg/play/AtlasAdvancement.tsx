import { useEffect, useRef, useState } from "react";
import type { CampaignCharacterListResponse, CharacterProgressionHttpGrantXpRequest, CharacterProgressionHttpGrantXpResponse, CharacterProgressionHttpState } from "@velvet/contracts";
import { createClientId } from "../../../utils/clientId";
import { LevelUpWizard, type LevelUpWizardApi } from "../character/LevelUpWizard";

export interface AtlasAdvancementApi extends LevelUpWizardApi {
  listCharacters: (campaignId: string) => Promise<CampaignCharacterListResponse>;
  grantXp: (campaignId: string, campaignCharacterId: string, input: CharacterProgressionHttpGrantXpRequest) => Promise<CharacterProgressionHttpGrantXpResponse>;
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
  const [progression, setProgression] = useState<CharacterProgressionHttpState | null>(null);
  const [amount, setAmount] = useState("100");
  const [reason, setReason] = useState("Session award");
  const [grantMessage, setGrantMessage] = useState("");
  const [granting, setGranting] = useState(false);
  const grantingRef = useRef(false);
  useEffect(() => {
    let current = true; setError("");
    void api.listCharacters(campaignId).then((value) => { if (current) setCharacters(value.characters); }).catch(() => { if (current) setError("The authorized character roster could not be loaded."); });
    return () => { current = false; };
  }, [api, campaignId, retry]);
  useEffect(() => {
    let current = true; setProgression(null); setGrantMessage("");
    if (!selected) return () => { current = false; };
    void api.getProgression(campaignId, selected).then((value) => { if (current) setProgression(value); }).catch(() => { if (current) setProgression(null); });
    return () => { current = false; };
  }, [api, campaignId, selected, retry]);
  useEffect(() => { onLockChange(locked); }, [locked, onLockChange]);
  useEffect(() => () => onLockChange(false), [onLockChange]);
  const parsedAmount = Number(amount);
  const grantValid = Boolean(progression) && Number.isSafeInteger(parsedAmount) && parsedAmount >= 1 && parsedAmount <= 1_000_000 && reason.trim().length > 0 && reason.trim().length <= 500;
  async function grant() {
    if (!grantValid || !progression || grantingRef.current || blocked) return;
    grantingRef.current = true; setGranting(true); setLocked(true); setGrantMessage("");
    try {
      if (reauthorize && !await reauthorize()) { setGrantMessage("Authorization could not be refreshed. No XP was granted."); return; }
      const result = await api.grantXp(campaignId, selected, { amount: parsedAmount, reason: reason.trim(),
        expectedRevision: progression.revision, idempotencyKey: `ui-grant-xp-${createClientId()}` });
      setProgression(result.progression);
      setGrantMessage(`Granted ${result.receipt.appliedLevels.length} level(s); progression revision ${result.receipt.revisionBefore} → ${result.receipt.revisionAfter}.`);
      onStateChange();
      setRetry((value) => value + 1);
    } catch {
      setGrantMessage("The XP grant outcome is uncertain. Refresh the progression before trying again; no automatic retry was sent.");
    } finally { grantingRef.current = false; setGranting(false); setLocked(false); }
  }
  return <section className="atlas-advancement">
    <p>Choose the campaign character to advance. The public roster does not identify its play actor; names are not used to guess that binding. The server checks your control before applying levels.</p>
    {error && <p role="alert">{error}</p>}
    <label>Advancement character<select value={selected} disabled={blocked || locked} onChange={(event) => setSelected(event.target.value)}><option value="">Choose a roster character</option>{characters.map((character) => <option key={character.id} value={character.id}>{character.name} ({character.id})</option>)}</select></label>
    <button type="button" disabled={locked} onClick={() => setRetry((value) => value + 1)}>Refresh character roster</button>
    {selected && progression && <section className="grant-xp" aria-labelledby="grant-xp-heading"><h3 id="grant-xp-heading">Grant experience</h3>
      <p>The server adds XP, crosses thresholds in order, and records an immutable receipt. Level {progression.level} · {progression.totalXp} total XP · revision {progression.revision}.</p>
      <label className="field">Amount<input type="number" min={1} value={amount} disabled={blocked || locked} onChange={(event) => setAmount(event.target.value)} /></label>
      <label className="field">Reason<input value={reason} disabled={blocked || locked} onChange={(event) => setReason(event.target.value)} /></label>
      <div className="button-row"><button className="primary" type="button" disabled={blocked || locked || !grantValid || granting} onClick={() => void grant()}>Grant XP</button></div>
      {grantMessage && <p role="status">{grantMessage}</p>}
    </section>}
    {selected && characters.some((character) => character.id === selected) && <LevelUpWizard key={selected} campaignId={campaignId} campaignCharacterId={selected} api={api} blocked={blocked} reauthorize={reauthorize}
      onLockChange={setLocked} onSheetRefreshed={onStateChange} onUnavailable={() => setError("Advancement is unavailable for this roster character with your current access.")} />}
  </section>;
}
