import { useEffect, useMemo, useRef, useState } from "react";
import "./voice.css";
import { VoiceSpeakerEditor } from "./VoiceSpeakerEditor";
import { VoicePlayback, voiceBase, voiceRequest, type PlaybackView } from "./playback";

const sourceKey = (source: { kind: string; id: string }) => JSON.stringify([source.kind, source.id]);

type Catalog = { enabled: boolean; voices: { id: string; label: string }[]; speakers: { id: string; label: string }[];
  assignments: { speakerId: string; voiceId: string; revision: number }[]; sources: { kind: string; id: string; label: string }[] };
/** Any room, turn, generation or safety boundary retires the entire listening queue. */
export function VoiceControls({ campaignId, contextKey = "" }: { campaignId: string; contextKey?: string }) {
  return <CampaignVoiceControls key={JSON.stringify([campaignId, contextKey])} campaignId={campaignId} />;
}
function CampaignVoiceControls({ campaignId }: { campaignId: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [editing, setEditing] = useState(false);
  const [casting, setCasting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function saveCasting(speakerId: string, voiceId: string) {
    if (!voiceId || saving) return;
    setSaving(true); setError("");
    try {
      await voiceRequest(`${voiceBase(campaignId)}/casting`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ speakerId, voiceId, expectedRevision: catalog?.assignments.find(a => a.speakerId === speakerId)?.revision ?? 0 }) });
      const next = await voiceRequest<Catalog>(voiceBase(campaignId));
      if (mounted.current) setCatalog(next);
    } catch (error) {
      if (mounted.current) setError(`${error instanceof Error ? error.message : "Could not save casting."} Refresh voices before retrying a conflicting edit.`);
    } finally { if (mounted.current) setSaving(false); }
  }
  const [selection, setSelection] = useState("");
  const [view, setView] = useState<PlaybackView>({ state: "idle" });
  const playback = useMemo(() => new VoicePlayback(campaignId, setView), [campaignId]);
  useEffect(() => {
    const abort = new AbortController(); setCatalog(null); setSelection("");
    void voiceRequest<Catalog>(voiceBase(campaignId), { signal: abort.signal }).then(value => { if (!abort.signal.aborted) setCatalog(value); }).catch(() => {});
    return () => { abort.abort(); playback.stop(); };
  }, [campaignId, playback]);
  const source = catalog?.enabled ? catalog.sources.find(source => sourceKey(source) === selection) : undefined;
  useEffect(() => {
    if (selection && !source) { playback.stop(); setSelection(""); setEditing(false); }
  }, [selection, source, playback]);
  if (!catalog?.enabled) return null;
  const active = ["playing", "buffering", "paused"].includes(view.state);
  return <section className="campaign-voice-controls" aria-label="Voice playback">
    <button type="button" aria-expanded={casting} aria-controls="campaign-voice-cast" onClick={() => setCasting(!casting)}>Cast & Voices</button>
    <button type="button" disabled={saving} onClick={() => {
      playback.stop(); setSelection(""); setEditing(false); setSaving(true); setError("");
      void voiceRequest<Catalog>(voiceBase(campaignId)).then(value => { if (mounted.current) setCatalog(value); })
        .catch(error => { if (mounted.current) setError(error instanceof Error ? error.message : "Could not refresh voices."); })
        .finally(() => { if (mounted.current) setSaving(false); });
    }}>Refresh voices</button>
    {error && <p role="alert">{error}</p>}
    {casting && <aside id="campaign-voice-cast" aria-label="Cast & Voices">
      <p>Saved across this campaign’s rooms. Recasting affects future renders, not gameplay or existing audio.</p>
      {catalog.speakers.map(speaker => <label key={speaker.id}>{speaker.label}<select aria-label={`Voice for ${speaker.label} (${speaker.id})`} disabled={saving}
        value={catalog.assignments.find(a => a.speakerId === speaker.id)?.voiceId || ""} onChange={event => void saveCasting(speaker.id, event.target.value)}>
        <option value="">Not assigned</option>{catalog.voices.map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
      </select></label>)}
      {!catalog.voices.length && <p>No approved voices available. Text play remains available.</p>}
    </aside>}
    <label>Published voice source<select value={selection} onChange={event => { playback.stop(); setEditing(false); setSelection(event.target.value); }}>
      <option value="">Choose published text</option>{catalog.sources.map(source => <option key={sourceKey(source)} value={sourceKey(source)}>{source.label}</option>)}
    </select></label>
    <button type="button" disabled={!source || active || editing} onClick={() => source && void playback.play({ kind: source.kind, id: source.id })}>Play voice</button>
    {active && <button type="button" onClick={() => view.state === "paused" ? playback.resume() : playback.pause()}>{view.state === "paused" ? "Resume voice" : "Pause voice"}</button>}
    <button type="button" disabled={!active} onClick={() => playback.stop()}>Stop listening</button>
    <button type="button" disabled={!source || editing} onClick={() => source && void playback.play({ kind: source.kind, id: source.id })}>Replay voice</button>
    <button type="button" disabled={!source} onClick={() => { playback.stop(); setEditing(!editing); }}>Edit line speakers</button>
    {editing && source && <VoiceSpeakerEditor key={sourceKey(source)} campaignId={campaignId} source={source} onClose={() => setEditing(false)} />}
    <span role="status">{view.state === "buffering" ? "Text ready; voice buffering" : view.state}</span>
    {view.error && <p role="alert">{view.error}</p>}
    {view.caption && <p aria-label="Voice caption"><strong>{catalog.speakers.find(s => s.id === view.caption!.speakerId)?.label || "Speaker"}: </strong><span>{view.caption.text}</span></p>}
  </section>;
}
