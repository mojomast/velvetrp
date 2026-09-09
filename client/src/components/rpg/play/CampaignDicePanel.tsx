import { FormEvent, useEffect, useRef, useState } from "react";
import { campaignDiceRollRequestSchema } from "@velvet/contracts";
import type { CampaignDiceHistoryResponse, CampaignDiceRollRequest, CampaignDiceRollResponse } from "@velvet/contracts";

export interface CampaignDiceApi {
  getCampaignDiceHistory?: (campaignId: string) => Promise<CampaignDiceHistoryResponse>;
  rollCampaignDice?: (campaignId: string, input: CampaignDiceRollRequest) => Promise<CampaignDiceRollResponse>;
}

export interface CampaignDicePanelProps {
  campaignId: string;
  api: CampaignDiceApi;
  canView: boolean;
  canRoll: boolean;
  actorNames: readonly string[];
  selectedActorName?: string;
  refreshKey?: number;
}

type Load = { state: "idle" | "loading" | "error"; history: CampaignDiceHistoryResponse | null };

/** Generic campaign dice UI. Every displayed result comes from an authoritative API response. */
export function CampaignDicePanel({ campaignId, api, canView, canRoll, actorNames, selectedActorName, refreshKey = 0 }: CampaignDicePanelProps) {
  const [load, setLoad] = useState<Load>({ state: "idle", history: null });
  const [position, setPosition] = useState<number | null>(null);
  const [expression, setExpression] = useState("1d20");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const writeLock = useRef(false);
  const mounted = useRef(false);

  const permittedCharacters = (history: CampaignDiceHistoryResponse) => canRoll
    ? history.characters.filter((character) => actorNames.includes(character.name))
    : history.characters;

  async function refresh(showLoading: boolean) {
    if (!canView || !api.getCampaignDiceHistory) return;
    const request = ++generation.current;
    if (showLoading) setLoad((current) => ({ state: "loading", history: current.history }));
    try {
      const history = await api.getCampaignDiceHistory(campaignId);
      if (!mounted.current || request !== generation.current) return;
      const characters = permittedCharacters(history);
      setLoad({ state: "idle", history });
      setPosition((current) => characters.some((character) => character.position === current) ? current
        : characters.find((character) => character.name === selectedActorName)?.position ?? characters[0]?.position ?? null);
    } catch {
      if (mounted.current && request === generation.current) setLoad((current) => ({ state: "error", history: current.history }));
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (canView && api.getCampaignDiceHistory) void refresh(true);
    return () => { mounted.current = false; generation.current += 1; writeLock.current = false; };
  // The refresh key intentionally drives GET-only live-table synchronization.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, campaignId, canView, refreshKey]);

  async function roll(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const history = load.history;
    const character = history?.characters.find((candidate) => candidate.position === position);
    if (!canRoll || !api.rollCampaignDice || !api.getCampaignDiceHistory || !character
      || !actorNames.includes(character.name) || writeLock.current) return;
    const parsed = campaignDiceRollRequestSchema.safeParse({ character, expression });
    if (!parsed.success) {
      setMessage("Use canonical notation such as 1d20, 2d6+3, 4d6kh3, 1d20adv, or 1d20dis.");
      return;
    }
    writeLock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await api.rollCampaignDice(campaignId, parsed.data);
      setMessage("Roll committed. Authoritative history refreshed.");
    } catch {
      setMessage("Roll status was reconciled from history. The roll was not repeated.");
    } finally {
      await refresh(false);
      if (mounted.current) setBusy(false);
      writeLock.current = false;
    }
  }

  if (!canView || !api.getCampaignDiceHistory) return <section className="table-dice table-dice-receipts-only" aria-labelledby="table-dice-heading">
    <h2 id="table-dice-heading">Dice & results</h2>
    <p>Table dice are not authorized for this role. Dice resolved by the adventure remain visible in committed mechanic receipts.</p>
  </section>;

  const characters = load.history ? permittedCharacters(load.history) : [];
  return <section className="table-dice" aria-labelledby="table-dice-heading" aria-busy={busy || load.state === "loading"}>
    <header><div><p className="eyebrow">SERVER-ROLLED</p><h2 id="table-dice-heading">Dice & results</h2></div>
      <button type="button" className="ghost" disabled={busy || load.state === "loading"} onClick={() => void refresh(true)}>Refresh results</button></header>
    {canRoll && api.rollCampaignDice && <form className="table-dice-form" onSubmit={(event) => void roll(event)}>
      <label>Named actor<select value={position ?? ""} disabled={busy || characters.length === 0} onChange={(event) => setPosition(Number(event.target.value))}>
        {characters.length === 0 && <option value="">No authorized actor</option>}
        {characters.map((character) => <option key={character.position} value={character.position}>{character.name}</option>)}
      </select></label>
      <label>Dice expression<input value={expression} maxLength={24} disabled={busy || characters.length === 0} onChange={(event) => setExpression(event.target.value)} /></label>
      <button type="submit" className="primary" disabled={busy || characters.length === 0}>{busy ? "Rolling once..." : "Roll dice"}</button>
    </form>}
    {!canRoll && <p className="table-dice-permission">Results are visible, but this role cannot roll table dice.</p>}
    {message && <p role={message.startsWith("Roll committed") ? "status" : "alert"}>{message}</p>}
    {load.state === "loading" && !load.history && <p role="status">Loading roll history...</p>}
    {load.state === "error" && <p role="alert">Roll history could not be refreshed. Existing results are unchanged.</p>}
    {load.history && <div className="table-dice-history"><h3>Recent rolls</h3>
      {load.history.rolls.length === 0 ? <p>No rolls yet.</p> : <ol aria-label="Recent dice rolls">{load.history.rolls.map((roll, index) => <li key={`${roll.occurredAt}:${index}`}>
        <div className="table-dice-roll-heading"><strong><bdi dir="auto">{roll.character.name}</bdi></strong><time dateTime={roll.occurredAt}>{new Date(roll.occurredAt).toLocaleString()}</time></div>
        <dl><div><dt>Expression</dt><dd><code>{roll.result.expression}</code></dd></div>
          <div><dt>Physical dice</dt><dd>{roll.result.terms.map((term, termIndex) => <span className={term.kept ? "kept-term" : "discarded-term"} key={termIndex}>{term.value} ({term.kept ? "kept" : "discarded"})</span>)}</dd></div>
          <div><dt>Modifier</dt><dd>{roll.result.modifier >= 0 ? "+" : ""}{roll.result.modifier}</dd></div>
          <div><dt>Total</dt><dd><strong>{roll.result.total}</strong></dd></div></dl>
      </li>)}</ol>}
    </div>}
  </section>;
}
