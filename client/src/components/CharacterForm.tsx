import { FormEvent, useEffect, useState } from "react";
import { emptyPersonaProfile, MAX_PERSONA_PROFILE_DETAIL_LENGTH, MAX_PERSONA_PROFILE_TRAIT_LENGTH, type PersonaProfile } from "@velvet/contracts";
import type { Character, CharacterSpec } from "../api";

const ARCHETYPES = [
  "Warm conversationalist", "Playful companion", "Mysterious stranger", "Confidant",
  "Adventurous storyteller", "Award-show charisma (fictional)",
  "Chart-topper confidence (fictional)", "Silver-screen mystery (fictional)", "Custom (describe below)",
];
const CUSTOM = "Custom (describe below)";
const TRAIT_FIELDS: Array<{ key: keyof PersonaProfile; label: string; help: string }> = [
  { key: "goal", label: "Goal", help: "What are they actively trying to achieve?" },
  { key: "ideal", label: "Ideal", help: "What principle guides their choices?" },
  { key: "bond", label: "Bond", help: "Who or what matters most to them?" },
  { key: "flaw", label: "Flaw", help: "What tendency creates trouble for them?" },
];
const DETAIL_FIELDS: Array<{ key: keyof PersonaProfile; label: string; help: string }> = [
  { key: "history", label: "History", help: "Past events that shaped them." },
  { key: "personality", label: "Personality", help: "Temperament, habits, and contradictions." },
  { key: "fears", label: "Fears", help: "Anxieties, vulnerabilities, or things they avoid." },
  { key: "relationships", label: "Relationships", help: "Important people and relationship dynamics." },
  { key: "appearance", label: "Appearance", help: "Distinctive physical details and presentation." },
  { key: "voice", label: "Voice", help: "Speech patterns, vocabulary, cadence, and tone." },
];

interface Props {
  character?: Character | null;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSave: (spec: CharacterSpec, startAfterSave: boolean) => Promise<void>;
}

export function CharacterForm({ character, busy, error, onCancel, onSave }: Props) {
  const [name, setName] = useState("");
  const [age, setAge] = useState("");
  const [archetype, setArchetype] = useState("");
  const [custom, setCustom] = useState("");
  const [boundaries, setBoundaries] = useState("");
  const [profile, setProfile] = useState<PersonaProfile>(() => emptyPersonaProfile());
  const [confirmed, setConfirmed] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);

  useEffect(() => {
    setName(character?.name ?? "");
    setAge(character ? String(character.age) : "");
    const known = character && ARCHETYPES.includes(character.archetype);
    setArchetype(known ? character.archetype : character ? CUSTOM : "");
    setCustom(character && !known ? character.archetype : "");
    setBoundaries(character?.boundaries ?? "");
    setProfile({ ...emptyPersonaProfile(), ...character?.profile });
    setConfirmed(character?.fictionalConfirmed ?? false);
    setValidation(null);
  }, [character]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const ageNumber = Number(age);
    const finalArchetype = archetype === CUSTOM ? custom.trim() : archetype.trim();
    if (!name.trim()) return setValidation("Please give your character a name.");
    if (!Number.isInteger(ageNumber) || ageNumber < 18) return setValidation("Character age must be a whole number of 18 or older.");
    if (!finalArchetype) return setValidation("Please choose or describe an archetype/vibe.");
    if (!boundaries.trim()) return setValidation("Please list boundaries and hard limits.");
    if (!confirmed) return setValidation("Please confirm the character is fictional and not a real person.");
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    setValidation(null);
    await onSave({ name: name.trim(), age: ageNumber, archetype: finalArchetype, boundaries: boundaries.trim(), profile, fictionalConfirmed: true }, submitter?.value === "start");
  }

  return (
    <section className="card editor-card" aria-labelledby="character-editor-title">
      <div className="section-heading-row">
        <div><p className="eyebrow">CHARACTER CARD</p><h1 id="character-editor-title" className="title">{character ? `Edit ${character.name}` : "Create a character"}</h1></div>
        <button type="button" className="ghost" disabled={busy} onClick={() => { if (!busy) onCancel(); }}>Cancel</button>
      </div>
      <p className="notice">18+ only. All characters are fictional. Real-person impersonation is not allowed.</p>
      <form className="form" onSubmit={submit}>
        <label className="field"><span>Character name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rowan" maxLength={60} /></label>
        <label className="field"><span>Age (18+)</span><input type="number" min={18} max={120} value={age} onChange={(e) => setAge(e.target.value)} placeholder="18+" /></label>
        <label className="field"><span>Archetype / vibe</span><select value={archetype} onChange={(e) => setArchetype(e.target.value)}><option value="">Select a vibe…</option>{ARCHETYPES.map((item) => <option key={item}>{item}</option>)}</select></label>
        {archetype === CUSTOM && <label className="field"><span>Describe the vibe</span><input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="A few words about personality and tone" maxLength={200} /></label>}
        <label className="field"><span>Boundaries &amp; hard limits</span><textarea value={boundaries} onChange={(e) => setBoundaries(e.target.value)} placeholder="Topics and behaviors the character must avoid" rows={3} maxLength={500} /></label>
        <details>
          <summary>Character depth (optional)</summary>
          <p id="character-depth-help" className="muted">Add only what helps define the character. You can leave every field blank and return later.</p>
          <div className="form" aria-describedby="character-depth-help">
            {TRAIT_FIELDS.map(({ key, label, help }) => <div className="field" key={key}><label htmlFor={`profile-${key}`}>{label}</label><small id={`profile-${key}-help`}>{help}</small><textarea id={`profile-${key}`} aria-describedby={`profile-${key}-help`} value={profile[key]} onChange={(e) => setProfile((current) => ({ ...current, [key]: e.target.value }))} rows={2} maxLength={MAX_PERSONA_PROFILE_TRAIT_LENGTH} /></div>)}
            <details>
              <summary>Advanced details (optional)</summary>
              <p id="advanced-character-help" className="muted">Use these details for richer continuity, appearance, and dialogue style.</p>
              <div className="form" aria-describedby="advanced-character-help">
                {DETAIL_FIELDS.map(({ key, label, help }) => <div className="field" key={key}><label htmlFor={`profile-${key}`}>{label}</label><small id={`profile-${key}-help`}>{help}</small><textarea id={`profile-${key}`} aria-describedby={`profile-${key}-help`} value={profile[key]} onChange={(e) => setProfile((current) => ({ ...current, [key]: e.target.value }))} rows={3} maxLength={MAX_PERSONA_PROFILE_DETAIL_LENGTH} /></div>)}
              </div>
            </details>
          </div>
        </details>
        <label className="checkbox"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /><span>I confirm this character is entirely fictional, is 18 or older, and is not based on a real person.</span></label>
        {(validation || error) && <p className="error" role="alert">{validation ?? error}</p>}
        <div className="button-row">
          <button type="submit" value="save" className="ghost" disabled={busy}>{busy ? "Saving…" : character ? "Save changes" : "Save to library"}</button>
          {!character && <button type="submit" value="start" className="primary" disabled={busy}>{busy ? "Starting…" : "Create character & start session"}</button>}
        </div>
      </form>
    </section>
  );
}
