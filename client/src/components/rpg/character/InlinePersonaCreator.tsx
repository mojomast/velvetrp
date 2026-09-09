import { useEffect, useRef, useState } from "react";
import { emptyPersonaProfile, MAX_PERSONA_PROFILE_TRAIT_LENGTH } from "@velvet/contracts";
import { ApiError, ApiInputError, createCharacter, listCharacters, type Character, type CharacterSpec } from "../../../api";

const STORAGE_KEY = "velvet.character-builder.persona-create.v1";
const emptyForm = { name: "", age: "", archetype: "", goal: "", boundaries: "", confirmed: false };
type PersonaForm = typeof emptyForm;
function readAttempt(): PersonaForm | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as PersonaForm;
  if (!value || ["name", "age", "archetype", "goal", "boundaries"].some((key) => typeof value[key as keyof PersonaForm] !== "string") || typeof value.confirmed !== "boolean") throw new Error("Invalid saved attempt");
  return value;
}

/** The legacy persona POST cannot be replayed safely, even after an empty list read. */
export function InlinePersonaCreator({ disabled, onSelect, onBusy }: {
  disabled: boolean;
  onSelect: (persona: { id: string; name: string }) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [initial] = useState(() => { try { return { form: readAttempt(), blocked: false }; } catch { return { form: null, blocked: true }; } });
  const [form, setForm] = useState(initial.form ?? emptyForm);
  const [locked, setLocked] = useState(Boolean(initial.form) || initial.blocked);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<Character[] | null>(null);
  const [selected, setSelected] = useState("");
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function submit() {
    if (disabled || sending.current || locked) return;
    const age = Number(form.age);
    if (!form.name.trim() || !Number.isInteger(age) || age < 18 || !form.archetype.trim() || !form.goal.trim() || !form.boundaries.trim() || !form.confirmed) {
      setMessage("Complete every required field, including an adult age, adventuring goal, boundaries, and fictional confirmation."); return;
    }
    // Persist before dispatch: remount/reload must never turn a lost response into another POST.
    try {
      if (readAttempt()) { setLocked(true); return; }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
    } catch { setLocked(true); setMessage("Safe creation storage is unavailable. No request was sent; use the authoritative persona picker."); return; }
    sending.current = true; setBusy(true); onBusy(true); setMessage("");
    const spec: CharacterSpec = { name: form.name.trim(), age, archetype: form.archetype.trim(), boundaries: form.boundaries.trim(), fictionalConfirmed: true, profile: { ...emptyPersonaProfile(), goal: form.goal.trim() } };
    try {
      const persona = await createCharacter(spec);
      if (!persona || typeof persona.id !== "string" || !persona.id.trim() || typeof persona.name !== "string") throw new Error("Missing persona identity");
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* Keep the lock if durable cleanup fails. */ }
      if (mounted.current) { setLocked(false); setMessage(`Persona saved: ${persona.name}. Continue to Rules choices.`); onSelect(persona); }
    } catch (error) {
      const rejected = error instanceof ApiInputError || (error instanceof ApiError && [400, 422].includes(error.status));
      let cleared = false;
      if (rejected) { try { localStorage.removeItem(STORAGE_KEY); cleared = true; } catch { /* A persisted lock must not be bypassed. */ } }
      if (mounted.current) { setLocked(!cleared); setMessage(rejected ? `${error.message} Your form has been retained.` : "Persona creation outcome is uncertain. No request will be resent. Refresh the authoritative list and explicitly choose a persona by ID."); }
    } finally {
      sending.current = false;
      if (mounted.current) { setBusy(false); onBusy(false); }
    }
  }

  async function refresh() {
    if (busy || sending.current) return;
    setBusy(true); setResults(null); setSelected("");
    try {
      const result = await listCharacters();
      if (mounted.current) { setResults(result.characters); setMessage("Authoritative list refreshed. A matching name or an absent entry does not establish the outcome of the earlier request."); }
    } catch { if (mounted.current) setMessage("Authoritative persona list could not be loaded. Retry this read; creation remains locked."); }
    finally { if (mounted.current) setBusy(false); }
  }

  return <div className="inline-persona-creator">
    <p>Define a fictional adult adventurer. Identity and story are separate from the race, class, attributes, and equipment chosen under Rules.</p>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={disabled || busy || locked}><legend>New persona concept (all fields required)</legend>
        <label className="field"><span>Persona name</span><input required maxLength={60} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
        <label className="field"><span>Age (18+)</span><input required type="number" min={18} step={1} value={form.age} onChange={(event) => setForm({ ...form, age: event.target.value })} /></label>
        <label className="field"><span>Adventurer concept</span><textarea required maxLength={200} placeholder="A disgraced scout seeking a missing expedition" value={form.archetype} onChange={(event) => setForm({ ...form, archetype: event.target.value })} /></label>
        <label className="field"><span>Adventuring goal</span><textarea required maxLength={MAX_PERSONA_PROFILE_TRAIT_LENGTH} value={form.goal} onChange={(event) => setForm({ ...form, goal: event.target.value })} /></label>
        <label className="field"><span>Boundaries and hard limits</span><textarea required maxLength={500} placeholder="Topics and behaviors to exclude from this character's story" value={form.boundaries} onChange={(event) => setForm({ ...form, boundaries: event.target.value })} /></label>
        <label className="builder-confirm"><input required type="checkbox" checked={form.confirmed} onChange={(event) => setForm({ ...form, confirmed: event.target.checked })} /> This character is fictional, 18 or older, and not based on a real person.</label>
        <button className="primary" type="submit">Create persona once</button>
      </fieldset>
    </form>
    {message && <p role="status">{message}</p>}
    {locked && <section aria-label="Unresolved persona creation"><p role="alert">Persona creation is locked. The earlier request cannot be safely replayed. Your concept is retained; choosing an existing persona does not confirm that request succeeded or unlock creation.</p>
      <button className="ghost" type="button" disabled={disabled || busy} onClick={() => void refresh()}>Refresh authoritative persona list</button>
      {results && <><label className="field"><span>Authoritative persona</span><select value={selected} onChange={(event) => setSelected(event.target.value)}><option value="">Choose explicitly by identity</option>{results.map((persona) => <option key={persona.id} value={persona.id}>{persona.name} - {persona.id}</option>)}</select></label>
        {results.length === 0 && <p>No personas are currently listed. This does not prove the earlier request failed; creation remains locked.</p>}
        {results.filter((persona) => persona.id === selected).map((persona) => <div key={persona.id}><p><strong>{persona.name}</strong> / ID: <code>{persona.id}</code> / Age: {persona.age} / Created: {persona.createdAt}</p><p>{persona.archetype}</p><p>Goal: {persona.profile?.goal || "Not specified"}</p><p>Boundaries: {persona.boundaries}</p></div>)}
        <button className="primary" type="button" disabled={disabled || busy || !results.some((persona) => persona.id === selected)} onClick={() => { const persona = results.find((item) => item.id === selected); if (persona) onSelect(persona); }}>Use explicitly selected persona</button>
      </>}
    </section>}
  </div>;
}
