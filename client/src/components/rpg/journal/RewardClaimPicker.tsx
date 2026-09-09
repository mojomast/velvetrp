import { useEffect, useState } from "react";
import { getCampaignPlayBootstrap, listCampaignRooms } from "../../../api";

export function RewardClaimPicker({ campaignId, disabled, onClaim }: { campaignId: string; disabled: boolean; onClaim: (actorId: string) => void }) {
  const [rooms, setRooms] = useState<Awaited<ReturnType<typeof listCampaignRooms>>["attached"]>([]);
  const [sessionId, setSessionId] = useState("");
  const [actors, setActors] = useState<{ sessionId: string; choices: Array<{ actorId: string; name: string }> } | null>(null);
  const [actorId, setActorId] = useState("");
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let current = true;
    setRooms([]); setFailed(false);
    void listCampaignRooms(campaignId).then(result => { if (current) setRooms(result.attached); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [campaignId, refresh]);
  useEffect(() => {
    if (!sessionId) return;
    let current = true;
    setActors(null); setActorId(""); setFailed(false);
    void getCampaignPlayBootstrap(campaignId, sessionId).then(result => {
      if (current) setActors({ sessionId, choices: result.playableActors });
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [campaignId, sessionId, refresh]);
  const choices = actors?.sessionId === sessionId ? actors.choices : [];
  return <fieldset disabled={disabled}><legend>Choose a reward recipient</legend>
    <p>Choose an attached room, then a character available to your current role. The server still checks reward eligibility.</p>
    <label>Recipient room<select required value={sessionId} onChange={event => { setSessionId(event.target.value); setActorId(""); }}><option value="">Choose an attached room</option>{rooms.map((room, index) => <option key={room.sessionId} value={room.sessionId}>{room.title ?? `Session ${index + 1}`} ({room.participantNames.join(", ")})</option>)}</select></label>
    <label>Claiming character<select required value={actorId} onChange={event => setActorId(event.target.value)}><option value="">Choose an available character</option>{choices.map(actor => <option key={actor.actorId} value={actor.actorId}>{actor.name}</option>)}</select></label>
    {failed && <p role="alert">Recipient choices could not be loaded. No claim has been sent.</p>}
    {!failed && sessionId && actors && !choices.length && <p>No characters available to your role in this room.</p>}
    <div className="button-row"><button type="button" onClick={() => { setActors(null); setActorId(""); setRefresh(value => value + 1); }}>Refresh recipient choices</button><button type="button" disabled={!choices.some(actor => actor.actorId === actorId)} onClick={() => onClaim(actorId)}>Claim this reward</button></div>
  </fieldset>;
}
