import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CharacterDraftFinalizationResult, CharacterDraftHttpView, CharacterDraftMutationReceipt, CharacterSheetHttpResponse,
  CreateCharacterDraftHttpInput, UpdateCharacterDraftHttpInput,
} from "@velvet/contracts";
import { ApiError, ApiInputError } from "../../../api";
import { AttributeAllocator } from "./AttributeAllocator";
import { ChoiceGroupEditor } from "./ChoiceGroupEditor";
import { DerivedStatsReview } from "./DerivedStatsReview";

export interface CharacterBuilderApi {
  create: (campaignId: string, input: CreateCharacterDraftHttpInput) => Promise<{ draft: CharacterDraftHttpView; receipt: Omit<CharacterDraftMutationReceipt, "commandId" | "draft"> }>;
  get: (campaignId: string, draftId: string) => Promise<CharacterDraftHttpView>;
  update: (campaignId: string, draftId: string, input: UpdateCharacterDraftHttpInput) => Promise<{ draft: CharacterDraftHttpView; receipt: Omit<CharacterDraftMutationReceipt, "commandId" | "draft"> }>;
  finalize: (campaignId: string, draftId: string, input: { expectedRevision: number; idempotencyKey: string }) => Promise<CharacterDraftFinalizationResult>;
  getSheet: (campaignId: string, campaignCharacterId: string) => Promise<CharacterSheetHttpResponse>;
}

export interface CharacterBuilderPageProps {
  campaignId: string;
  personas: Array<{ id: string; name: string }>;
  initialDraftId?: string;
  api: CharacterBuilderApi;
  onBack: () => void;
  onUnavailable: () => void;
  onDraftIdentity?: (draftId: string) => void;
  onEditPersona: (personaId: string) => void;
  onOpenCharacter: (campaignCharacterId: string) => void;
  focusHeadingRequest?: number;
}

type SaveState = "idle" | "saving" | "saved" | "stale" | "failed";
type DraftLock = { token: symbol; phase: "writing" | "uncertain"; kind: "save" | "finalize"; message: string };
const draftLocks = new Map<string, DraftLock>();
const draftListeners = new Set<(key: string, lock: DraftLock | null) => void>();
const lockKey = (campaignId: string, draftId: string) => `${campaignId.length}:${campaignId}${draftId}`;
const createLockKey = (campaignId: string, personaId: string) => `new:${campaignId.length}:${campaignId}${personaId}`;
function publish(key: string, lock: DraftLock | null) { if (lock) draftLocks.set(key, lock); else draftLocks.delete(key); for (const listener of draftListeners) listener(key, lock); }
function idempotency(kind: string) { const value = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; return `ui-${kind}-${value}`; }
function knownNonCommit(error: unknown) { return error instanceof ApiInputError || (error instanceof ApiError && [400, 404, 415, 422].includes(error.status)); }
function issueTarget(path: string): string { const part = path.split(".").at(-1); return `builder-choice-${part === "starterGrant" ? "starter-grant" : part}`; }

export function resetCharacterBuilderPageModuleStateForTests(): void { draftLocks.clear(); draftListeners.clear(); }

/** Draft-to-play orchestration with revision-bound autosave and no automatic write retry. */
export function CharacterBuilderPage({ campaignId, personas, initialDraftId, api, onBack, onUnavailable, onDraftIdentity = () => undefined, onEditPersona, onOpenCharacter, focusHeadingRequest }: CharacterBuilderPageProps) {
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? "");
  const [draft, setDraft] = useState<CharacterDraftHttpView | null>(null);
  const [loading, setLoading] = useState(Boolean(initialDraftId));
  const [creating, setCreating] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [lock, setLock] = useState<DraftLock | null>(() => initialDraftId ? draftLocks.get(lockKey(campaignId, initialDraftId)) ?? null : draftLocks.get(createLockKey(campaignId, personas[0]?.id ?? "")) ?? null);
  const [finalReceipt, setFinalReceipt] = useState<CharacterDraftFinalizationResult["receipt"] | null>(null);
  const [finalSheet, setFinalSheet] = useState<CharacterSheetHttpResponse | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const activeRef = useRef({ campaignId, draftId: initialDraftId ?? "" });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const focusedRequestRef = useRef<number | undefined>();
  const unavailableRef = useRef(onUnavailable); unavailableRef.current = onUnavailable;
  const draftIdentityRef = useRef(onDraftIdentity); draftIdentityRef.current = onDraftIdentity;

  const focus = useCallback((generation: number, target: "heading" | "retry" | "status") => queueMicrotask(() => {
    if (!mountedRef.current || generationRef.current !== generation) return;
    (target === "heading" ? headingRef.current : target === "retry" ? retryRef.current : statusRef.current)?.focus();
  }), []);

  const load = useCallback(async (authoritative = false) => {
    if (!initialDraftId) return;
    const requested = { campaignId, draftId: initialDraftId }; const generation = ++generationRef.current;
    setLoading(true); setError("");
    try {
      const result = await api.get(campaignId, initialDraftId);
      if (!mountedRef.current || generationRef.current !== generation || activeRef.current.campaignId !== requested.campaignId || activeRef.current.draftId !== requested.draftId) return;
      setDraft(result); setPersonaId(result.personaId); setLoading(false); setSaveState("saved"); draftIdentityRef.current(result.id);
      if (authoritative) { publish(lockKey(campaignId, result.id), null); setNotice("Authoritative draft revision refreshed. No save or finalization was retried."); focus(generation, "status"); }
      else if (focusHeadingRequest !== undefined && focusedRequestRef.current !== focusHeadingRequest) { focusedRequestRef.current = focusHeadingRequest; focus(generation, "heading"); }
    } catch (loadError) {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setLoading(false); setError("Character draft could not be loaded.");
      if (loadError instanceof ApiError && loadError.status === 404) unavailableRef.current(); else focus(generation, "retry");
    }
  }, [api, campaignId, focus, focusHeadingRequest, initialDraftId]);

  useEffect(() => {
    mountedRef.current = true; activeRef.current = { campaignId, draftId: initialDraftId ?? "" };
    const key = initialDraftId ? lockKey(campaignId, initialDraftId) : createLockKey(campaignId, personaId); setLock(draftLocks.get(key) ?? null);
    const listener = (changed: string, next: DraftLock | null) => { const activeKey = activeRef.current.draftId ? lockKey(activeRef.current.campaignId, activeRef.current.draftId) : createLockKey(activeRef.current.campaignId, personaId); if (mountedRef.current && changed === activeKey) setLock(next); };
    draftListeners.add(listener); if (initialDraftId) void load();
    return () => { mountedRef.current = false; generationRef.current += 1; draftListeners.delete(listener); };
  }, [campaignId, initialDraftId, load, personaId]);

  async function create(allocation: CreateCharacterDraftHttpInput["allocation"]) {
    if (!personaId || creating) return; const key = createLockKey(campaignId, personaId); if (draftLocks.has(key)) return;
    const token = Symbol(key); const generation = ++generationRef.current; publish(key, { token, phase: "writing", kind: "save", message: "Creating this draft once…" }); setCreating(true); setError("");
    try {
      const result = await api.create(campaignId, { personaId, durability: "durable", allocation, idempotencyKey: idempotency("draft-create") });
      if (draftLocks.get(key)?.token !== token) return; publish(key, null);
      if (!mountedRef.current || generationRef.current !== generation) return;
      activeRef.current = { campaignId, draftId: result.draft.id }; setDraft(result.draft); setSaveState("saved"); setNotice("Draft created and saved at revision 0."); draftIdentityRef.current(result.draft.id); focus(generation, "status");
    } catch (createError) {
      if (draftLocks.get(key)?.token !== token) return;
      if (knownNonCommit(createError)) publish(key, null); else publish(key, { token, phase: "uncertain", kind: "save", message: "Draft creation outcome is uncertain. Duplicate creation is locked; return to the campaign and refresh. No POST will be retried." });
      if (mountedRef.current && generationRef.current === generation) { setError(knownNonCommit(createError) && createError instanceof ApiError ? createError.message : "Draft creation outcome is uncertain. Return to the campaign and refresh before creating again."); focus(generation, "status"); }
    }
    finally { if (mountedRef.current && generationRef.current === generation) setCreating(false); }
  }

  async function save(selections: UpdateCharacterDraftHttpInput["selections"]) {
    if (!draft) return; const key = lockKey(campaignId, draft.id); if (draftLocks.has(key)) return;
    const token = Symbol(key); const generation = generationRef.current; const expectedRevision = draft.revision;
    publish(key, { token, phase: "writing", kind: "save", message: `Saving revision ${expectedRevision + 1}…` }); setSaveState("saving"); setError(""); setNotice("");
    try {
      const result = await api.update(campaignId, draft.id, { expectedRevision, selections, idempotencyKey: idempotency("draft-save") });
      if (draftLocks.get(key)?.token !== token) return; publish(key, null);
      if (!mountedRef.current || generationRef.current !== generation) return;
      setDraft(result.draft); setSaveState("saved"); setNotice(`Saved revision ${result.draft.revision}.`); setConfirmed(false); focus(generation, "status");
    } catch (saveError) {
      if (draftLocks.get(key)?.token !== token) return;
      const stale = saveError instanceof ApiError && saveError.status === 409;
      if (knownNonCommit(saveError)) publish(key, null); else publish(key, { token, phase: "uncertain", kind: "save", message: stale ? "Draft revision is stale. Refresh authoritative state; the save will not be retried." : "Save outcome is uncertain. Further changes are locked until authoritative refresh; no write will be retried." });
      if (mountedRef.current) { setSaveState(stale ? "stale" : "failed"); setError(stale ? "Draft revision is stale. Refresh before changing another choice." : knownNonCommit(saveError) ? "The selection was rejected and the last saved revision is unchanged." : "Save outcome is uncertain. Refresh authoritative state before continuing."); focus(generationRef.current, "status"); }
    }
  }

  async function finalize() {
    if (!draft || !draft.completion.complete || !confirmed) return; const key = lockKey(campaignId, draft.id); if (draftLocks.has(key)) return;
    const token = Symbol(key); publish(key, { token, phase: "writing", kind: "finalize", message: "Finalizing once and refreshing the authoritative sheet…" }); setError(""); setNotice("");
    try {
      const result = await api.finalize(campaignId, draft.id, { expectedRevision: draft.revision, idempotencyKey: idempotency("draft-finalize") });
      const sheet = await api.getSheet(campaignId, result.receipt.campaignCharacterId);
      if (draftLocks.get(key)?.token !== token) return; publish(key, null);
      if (!mountedRef.current) return;
      setDraft((current) => current ? { ...current, status: "finalized", revision: result.receipt.revisionAfter } : current); setFinalReceipt(result.receipt); setFinalSheet(sheet); setNotice("Finalization receipt confirmed. The authoritative character sheet was refreshed."); focus(generationRef.current, "status");
    } catch (finalError) {
      if (draftLocks.get(key)?.token !== token) return;
      if (knownNonCommit(finalError)) publish(key, null); else publish(key, { token, phase: "uncertain", kind: "finalize", message: "Finalization outcome is uncertain. It is locked until authoritative refresh and will not be retried." });
      if (mountedRef.current) { setError(knownNonCommit(finalError) ? "Finalization was rejected. The draft remains available." : "Finalization outcome is uncertain. Refresh authoritative state before continuing."); focus(generationRef.current, "status"); }
    }
  }

  const busy = creating || lock?.phase === "writing" || loading;
  return <main className="page library-page campaign-page character-builder-page"><section className="character-builder-shell" aria-labelledby="character-builder-heading">
    <header className="library-header"><div><button className="back-link" type="button" disabled={busy} onClick={onBack}>← Back to campaign</button><p className="eyebrow">PLAYABLE MECHANICS · PERSONA SEPARATE</p><h1 ref={headingRef} tabIndex={-1} className="title" id="character-builder-heading">Character builder</h1><p className="subtitle">Build a server-validated sheet without changing the persona.</p></div>{draft && <span className="status-pill">Revision {draft.revision}</span>}</header>
    {(error || notice || lock || saveState !== "idle") && <div ref={statusRef} tabIndex={-1} className={`builder-status ${error || saveState === "stale" || lock?.phase === "uncertain" ? "is-error" : ""}`} role={error || saveState === "stale" || lock?.phase === "uncertain" ? "alert" : "status"}><p>{error || lock?.message || notice || (saveState === "saving" ? "Saving…" : saveState === "saved" ? `Saved revision ${draft?.revision ?? 0}.` : saveState === "stale" ? "Stale revision." : "Save failed.")}</p>{lock?.phase === "uncertain" && initialDraftId && <button className="primary" disabled={loading} onClick={() => void load(true)}>{loading ? "Refreshing…" : "Refresh authoritative draft"}</button>}</div>}
    {!draft && !loading && <section className="builder-section persona-selection"><h2>Choose an existing persona</h2><p className="builder-help">Persona name, description, boundaries, and memories stay in the separate persona editor.</p>{personas.length ? <><label className="field"><span>Persona</span><select value={personaId} disabled={creating || Boolean(lock)} onChange={(event) => setPersonaId(event.target.value)}>{personas.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select></label><button className="ghost" type="button" disabled={!personaId || creating || Boolean(lock)} onClick={() => onEditPersona(personaId)}>Edit selected persona separately</button><AttributeAllocator disabled={creating || Boolean(lock)} onContinue={(allocation) => void create(allocation)} /></> : <p role="alert">Create a persona in the character library before building playable mechanics.</p>}</section>}
    {loading && !draft && <section className="builder-section" aria-busy="true"><p role="status">Loading draft…</p></section>}
    {error && !draft && initialDraftId && <button ref={retryRef} className="primary" onClick={() => void load()}>Retry draft</button>}
    {draft && <div className="character-builder-layout">
      <ChoiceGroupEditor groups={draft.choiceGroups} selections={draft.selections} disabled={busy || Boolean(lock) || draft.status !== "active"} onSelect={(selection) => void save(selection)} />
      {!draft.completion.complete && <section className="builder-section completion-issues" aria-labelledby="completion-heading"><h2 id="completion-heading">Complete required choices</h2><ul>{draft.completion.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><button type="button" onClick={() => document.getElementById(issueTarget(issue.path))?.focus()}>{issue.message}</button></li>)}</ul></section>}
      {draft.derivedPreview && <DerivedStatsReview derived={draft.derivedPreview} startingGrants={draft.startingGrants} />}
      {draft.completion.complete && draft.derivedPreview && draft.status === "active" && <section className="builder-section finalization-review"><h2>Explicit finalization confirmation</h2><p>Review every server-derived value and exact grant above. Finalization creates the playable sheet once.</p><label className="builder-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the server preview and exact starter grants and want to finalize once.</label><button className="primary" disabled={!confirmed || busy || Boolean(lock)} onClick={() => void finalize()}>Finalize playable character once</button></section>}
      {finalReceipt && finalSheet && <section className="builder-section finalized-character"><h2>Playable character finalized</h2><p className="builder-receipt">Receipt revision {finalReceipt.revisionBefore} → {finalReceipt.revisionAfter} at {new Date(finalReceipt.occurredAt).toLocaleString()}.</p><p>Authoritative sheet: level {finalSheet.progression.level}, maximum health {finalSheet.derived.maxHp}.</p><button className="primary" onClick={() => onOpenCharacter(finalReceipt.campaignCharacterId)}>Open character sheet</button></section>}
    </div>}
  </section></main>;
}
