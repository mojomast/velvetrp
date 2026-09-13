import { useEffect, useRef, useState } from "react";
import { voiceBase, voiceRequest, type VoiceSegment } from "./playback";
type Script = { revision: number; sourceVersion: string; segments: VoiceSegment[]; speakers: { id: string; label: string }[] };
/** Presentation attribution only: the server owns all text and eligible identities. */
export function VoiceSpeakerEditor({ campaignId, source, onClose }: {
  campaignId: string; source: { kind: string; id: string }; onClose: () => void;
}) {
  const url = `${voiceBase(campaignId)}/sources/${encodeURIComponent(source.kind)}/${encodeURIComponent(source.id)}`;
  const [script, setScript] = useState<Script | null>(null);
  const [speakerIds, setSpeakerIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setSaving(false);
    const abort = new AbortController(); setScript(null); setError("");
    void voiceRequest<Script>(url, { signal: abort.signal }).then(value => {
      if (abort.signal.aborted) return;
      const segments = [...value.segments].sort((a, b) => a.index - b.index);
      setScript({ ...value, segments }); setSpeakerIds(segments.map(s => s.speakerId));
    }).catch(error => { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "Could not load line speakers."); });
    return () => { generation.current++; abort.abort(); };
  }, [url, reload]);
  async function save() {
    if (!script || saving) return;
    const attempt = generation.current;
    setSaving(true); setError("");
    try {
      await voiceRequest(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: script.revision, sourceVersion: script.sourceVersion, speakerIds }) });
      if (attempt === generation.current) onClose();
    } catch (error) { if (attempt === generation.current) setError(`${error instanceof Error ? error.message : "Could not save line speakers."} Reload before retrying a conflicting edit.`); }
    finally { if (attempt === generation.current) setSaving(false); }
  }
  return <aside aria-label="Published line speakers" className="voice-editor">
    <p>Optional manual attribution of published text. Choose narrator or an eligible NPC; this does not change the text or perform a game action.</p>
    {error && <p role="alert">{error}</p>}
    {!script && !error && <p role="status">Loading published captions…</p>}
    {script?.segments.map((segment, index) => <div key={segment.index}><p>{segment.text}</p>
      <label>Speaker for line {index + 1}<select value={speakerIds[index]} disabled={saving} onChange={event => setSpeakerIds(ids => ids.map((id, i) => i === index ? event.target.value : id))}>
        {script.speakers.map(speaker => <option key={speaker.id} value={speaker.id}>{speaker.label} ({speaker.id})</option>)}
      </select></label></div>)}
    <button type="button" disabled={!script || saving} onClick={() => void save()}>Save line speakers</button>
    <button type="button" disabled={saving} onClick={() => setReload(value => value + 1)}>Reload line speakers</button>
    <button type="button" disabled={saving} onClick={onClose}>Close line speakers</button>
  </aside>;
}
