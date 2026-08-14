import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CharacterDraftHttpFinalizationResult, CharacterDraftHttpView, CharacterDraftMutationReceipt, CharacterSheetHttpResponse,
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
  reroll: (campaignId: string, draftId: string, input: { expectedRevision: number; idempotencyKey: string }) => Promise<{ draft: CharacterDraftHttpView; receipt: Omit<CharacterDraftMutationReceipt, "commandId" | "draft"> }>;
  finalize: (campaignId: string, draftId: string, input: { expectedRevision: number; idempotencyKey: string }) => Promise<CharacterDraftHttpFinalizationResult>;
  getSheet: (campaignId: string, campaignCharacterId: string) => Promise<CharacterSheetHttpResponse>;
}

export interface CharacterBuilderPageProps {
  campaignId: string;
  personas: Array<{ id: string; name: string }>;
  initialDraftId?: string;
  api: CharacterBuilderApi;
  onBack: () => void;
  onUnavailable: () => void;
  onDraftIdentity?: (draftId: string | null) => void;
  onReviewCampaignRoster?: () => void;
  onEditPersona: (personaId: string) => void;
  onOpenCharacter: (campaignCharacterId: string) => void;
  focusHeadingRequest?: number;
}

type SaveState = "idle" | "saving" | "saved" | "stale" | "failed";
type DraftLock = { token: symbol; phase: "writing" | "uncertain"; kind: "create" | "save" | "reroll" | "finalize"; message: string };
interface AmbiguousCreateMarker { campaignId: string; personaId: string; idempotencyKey: string; startedAt: string }
const AMBIGUOUS_CREATE_KEY = "velvet.character-builder.ambiguous-creates.v1";
const draftLocks = new Map<string, DraftLock>();
const draftListeners = new Set<(key: string, lock: DraftLock | null) => void>();
const lockKey = (campaignId: string, draftId: string) => `${campaignId.length}:${campaignId}${draftId}`;
const createLockKey = (campaignId: string, personaId: string) => `new:${campaignId.length}:${campaignId}${personaId}`;
function publish(key: string, lock: DraftLock | null) { if (lock) draftLocks.set(key, lock); else draftLocks.delete(key); for (const listener of draftListeners) listener(key, lock); }
function idempotency(kind: string) { const value = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; return `ui-${kind}-${value}`; }
function knownNonCommit(error: unknown) { return error instanceof ApiInputError || (error instanceof ApiError && [400, 404, 415, 422].includes(error.status)); }
function issueTarget(path: string): string { const part = path.split(".").at(-1); return `builder-choice-${part === "starterGrant" ? "starter-grant" : part}`; }
function markerKey(campaignId: string, personaId: string): string { return `${campaignId.length}:${campaignId}${personaId}`; }
function readCreateMarkers(): Record<string, AmbiguousCreateMarker> {
  try {
    const value = JSON.parse(localStorage.getItem(AMBIGUOUS_CREATE_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, AmbiguousCreateMarker> = {};
    for (const [key, marker] of Object.entries(value as Record<string, unknown>)) {
      if (marker && typeof marker === "object" && !Array.isArray(marker)) {
        const item = marker as Record<string, unknown>;
        if (typeof item.campaignId === "string" && typeof item.personaId === "string" && typeof item.idempotencyKey === "string" && typeof item.startedAt === "string") {
          result[key] = item as unknown as AmbiguousCreateMarker;
        }
      }
    }
    return result;
  } catch { return {}; }
}
function writeCreateMarker(marker: AmbiguousCreateMarker | null, campaignId: string, personaId: string): void {
  try {
    const markers = readCreateMarkers(); const key = markerKey(campaignId, personaId);
    if (marker) markers[key] = marker; else delete markers[key];
    localStorage.setItem(AMBIGUOUS_CREATE_KEY, JSON.stringify(markers));
  } catch { /* Storage failure cannot make a write safe to replay. The document lock still applies. */ }
}
function markerLock(): DraftLock { return { token: Symbol("persisted-create"), phase: "uncertain", kind: "create", message: "A draft creation request from this browser has an unresolved outcome. It will not be replayed automatically." }; }

export function resetCharacterBuilderPageModuleStateForTests(): void { draftLocks.clear(); draftListeners.clear(); }

/** Draft-to-play orchestration with revision-bound autosave and no automatic write retry. */
export function CharacterBuilderPage({ campaignId, personas, initialDraftId, api, onBack, onUnavailable, onDraftIdentity = () => undefined, onReviewCampaignRoster = onBack, onEditPersona, onOpenCharacter, focusHeadingRequest }: CharacterBuilderPageProps) {
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? "");
  const [draft, setDraft] = useState<CharacterDraftHttpView | null>(null);
  const [loading, setLoading] = useState(Boolean(initialDraftId));
  const [creating, setCreating] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [lock, setLock] = useState<DraftLock | null>(() => initialDraftId ? draftLocks.get(lockKey(campaignId, initialDraftId)) ?? null : readCreateMarkers()[markerKey(campaignId, personas[0]?.id ?? "")] ? markerLock() : draftLocks.get(createLockKey(campaignId, personas[0]?.id ?? "")) ?? null);
  const [finalResult, setFinalResult] = useState<CharacterDraftHttpFinalizationResult | null>(null);
  const [finalSheet, setFinalSheet] = useState<CharacterSheetHttpResponse | null>(null);
  const [sheetRefreshError, setSheetRefreshError] = useState("");
  const [creationResolutionConfirmed, setCreationResolutionConfirmed] = useState(false);
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
      if (result.status === "finalized") setNotice("This draft is already finalized. Start a new draft to build another playable character.");
      if (authoritative) { publish(lockKey(campaignId, result.id), null); setNotice("Authoritative draft revision refreshed. No save or finalization was retried."); focus(generation, "status"); }
      else if (focusHeadingRequest !== undefined && focusedRequestRef.current !== focusHeadingRequest) { focusedRequestRef.current = focusHeadingRequest; focus(generation, "heading"); }
    } catch (loadError) {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setLoading(false);
      if (loadError instanceof ApiError && loadError.status === 404) {
        setError("The saved draft is no longer available. You can start a new draft.");
        setDraft(null); draftIdentityRef.current(null); focus(generation, "status");
      } else { setError("Character draft could not be loaded."); focus(generation, "retry"); }
    }
  }, [api, campaignId, focus, focusHeadingRequest, initialDraftId]);

  useEffect(() => {
    mountedRef.current = true; activeRef.current = { campaignId, draftId: initialDraftId ?? "" };
    const key = initialDraftId ? lockKey(campaignId, initialDraftId) : createLockKey(campaignId, personaId);
    const persistedMarker = !initialDraftId && readCreateMarkers()[markerKey(campaignId, personaId)];
    setLock(persistedMarker ? markerLock() : draftLocks.get(key) ?? null);
    const listener = (changed: string, next: DraftLock | null) => { const activeKey = activeRef.current.draftId ? lockKey(activeRef.current.campaignId, activeRef.current.draftId) : createLockKey(activeRef.current.campaignId, personaId); if (mountedRef.current && changed === activeKey) setLock(next); };
    draftListeners.add(listener);
    if (initialDraftId) void load();
    else if (focusHeadingRequest !== undefined && focusedRequestRef.current !== focusHeadingRequest) {
      focusedRequestRef.current = focusHeadingRequest; const generation = generationRef.current; focus(generation, "heading");
    }
    return () => { mountedRef.current = false; generationRef.current += 1; draftListeners.delete(listener); };
  }, [campaignId, initialDraftId, load, personaId]);

  async function create(allocation: CreateCharacterDraftHttpInput["allocation"]) {
    if (!personaId || creating) return; const key = createLockKey(campaignId, personaId); if (draftLocks.has(key)) return;
    const token = Symbol(key); const generation = ++generationRef.current; const intentIdempotencyKey = idempotency("draft-create");
    writeCreateMarker({ campaignId, personaId, idempotencyKey: intentIdempotencyKey, startedAt: new Date().toISOString() }, campaignId, personaId);
    publish(key, { token, phase: "writing", kind: "create", message: "Creating this draft once…" }); setCreating(true); setError("");
    try {
      const result = await api.create(campaignId, { personaId, durability: "durable", allocation, idempotencyKey: intentIdempotencyKey });
      if (draftLocks.get(key)?.token !== token) return; publish(key, null);
      writeCreateMarker(null, campaignId, personaId);
      if (!mountedRef.current || generationRef.current !== generation) return;
      activeRef.current = { campaignId, draftId: result.draft.id }; setDraft(result.draft); setSaveState("saved"); setNotice("Draft created and saved at revision 0."); draftIdentityRef.current(result.draft.id); focus(generation, "status");
    } catch (createError) {
      if (draftLocks.get(key)?.token !== token) return;
      if (knownNonCommit(createError)) { publish(key, null); writeCreateMarker(null, campaignId, personaId); }
      else publish(key, { token, phase: "uncertain", kind: "create", message: "Draft creation outcome is uncertain. Duplicate creation is locked across reload; no POST will be retried." });
      if (mountedRef.current && generationRef.current === generation) { setError(knownNonCommit(createError) ? (createError instanceof ApiError ? createError.message : "The allocation was rejected locally. No draft request was sent or left uncertain.") : "Draft creation outcome is uncertain. Review campaign status before resolving this lock."); focus(generation, "status"); }
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

  async function reroll() {
    if (!draft || draft.allocation.method !== "server-roll") return; const key = lockKey(campaignId, draft.id); if (draftLocks.has(key)) return;
    const token = Symbol(key); const expectedRevision = draft.revision; const generation = generationRef.current;
    publish(key, { token, phase: "writing", kind: "reroll", message: "Rolling six new auditable attribute sets once…" }); setError(""); setNotice(""); setConfirmed(false);
    try {
      const result = await api.reroll(campaignId, draft.id, { expectedRevision, idempotencyKey: idempotency("draft-reroll") });
      if (draftLocks.get(key)?.token !== token) return; publish(key, null);
      if (!mountedRef.current || generationRef.current !== generation) return;
      setDraft(result.draft); setSaveState("saved"); setNotice(`New roll saved at revision ${result.draft.revision}. The earlier roll remains in revision history.`); focus(generation, "status");
    } catch (rerollError) {
      if (draftLocks.get(key)?.token !== token) return;
      const stale = rerollError instanceof ApiError && rerollError.status === 409;
      if (knownNonCommit(rerollError)) publish(key, null); else publish(key, { token, phase: "uncertain", kind: "reroll", message: "Reroll outcome is uncertain. Refresh authoritative state; the roll will not be repeated." });
      if (mountedRef.current) { setError(stale ? "Draft revision changed before the reroll. Refresh authoritative state." : knownNonCommit(rerollError) ? "The reroll was rejected and the current roll is unchanged." : "Reroll outcome is uncertain. Refresh before continuing."); focus(generationRef.current, "status"); }
    }
  }

  async function finalize() {
    if (!draft || !draft.completion.complete || !confirmed) return; const key = lockKey(campaignId, draft.id); if (draftLocks.has(key)) return;
    const token = Symbol(key); publish(key, { token, phase: "writing", kind: "finalize", message: "Finalizing once and refreshing the authoritative sheet…" }); setError(""); setNotice("");
    try {
      const result = await api.finalize(campaignId, draft.id, { expectedRevision: draft.revision, idempotencyKey: idempotency("draft-finalize") });
      if (draftLocks.get(key)?.token !== token) return; publish(key, null);
      if (!mountedRef.current) return;
      setDraft((current) => current ? { ...current, status: "finalized", revision: result.receipt.revisionAfter } : current);
      setFinalResult(result); setFinalSheet(null); setSheetRefreshError("");
      setNotice("Finalization receipt confirmed. Refreshing the authoritative character sheet; the POST will never be repeated.");
      draftIdentityRef.current(null); focus(generationRef.current, "status");
      try {
        const sheet = await api.getSheet(campaignId, result.character.id);
        if (!mountedRef.current) return;
        setFinalSheet(sheet); setNotice("Finalization receipt confirmed. The authoritative character sheet was refreshed.");
      } catch {
        if (!mountedRef.current) return;
        setSheetRefreshError("The character was created and confirmed by receipt, but the sheet refresh failed. Retry only the authoritative GET or open the created character.");
        setError("");
      }
    } catch (finalError) {
      if (draftLocks.get(key)?.token !== token) return;
      if (knownNonCommit(finalError)) publish(key, null); else publish(key, { token, phase: "uncertain", kind: "finalize", message: "Finalization outcome is uncertain. It is locked until authoritative refresh and will not be retried." });
      if (mountedRef.current) { setError(knownNonCommit(finalError) ? "Finalization was rejected. The draft remains available." : "Finalization outcome is uncertain. Refresh authoritative state before continuing."); focus(generationRef.current, "status"); }
    }
  }

  async function retryFinalSheet() {
    if (!finalResult) return;
    const generation = ++generationRef.current; setSheetRefreshError(""); setNotice("Refreshing the authoritative sheet. No finalization POST will be made.");
    try {
      const sheet = await api.getSheet(campaignId, finalResult.character.id);
      if (!mountedRef.current || generationRef.current !== generation) return;
      setFinalSheet(sheet); setNotice("Authoritative character sheet refreshed. The finalization receipt remains confirmed."); focus(generation, "status");
    } catch {
      if (!mountedRef.current || generationRef.current !== generation) return;
      setSheetRefreshError("The created character remains confirmed, but its authoritative sheet still could not be refreshed."); focus(generation, "status");
    }
  }

  function startNewDraft() {
    if (draft) publish(lockKey(campaignId, draft.id), null);
    setDraft(null); setFinalResult(null); setFinalSheet(null); setSheetRefreshError(""); setError(""); setNotice("Ready to create a new draft."); setSaveState("idle"); setConfirmed(false); draftIdentityRef.current(null);
  }

  function resolveAmbiguousCreation() {
    if (!creationResolutionConfirmed) return;
    writeCreateMarker(null, campaignId, personaId); publish(createLockKey(campaignId, personaId), null);
    setCreationResolutionConfirmed(false); setError(""); setNotice("The reviewed creation lock was cleared. No earlier POST was replayed.");
  }

  const busy = creating || lock?.phase === "writing" || loading;
  return <main className="page library-page campaign-page character-builder-page"><section className="character-builder-shell" aria-labelledby="character-builder-heading">
    <header className="library-header"><div><button className="back-link" type="button" disabled={busy} onClick={onBack}>← Back to campaign</button><p className="eyebrow">PLAYABLE MECHANICS · PERSONA SEPARATE</p><h1 ref={headingRef} tabIndex={-1} className="title" id="character-builder-heading">Character builder</h1><p className="subtitle">Build a server-validated sheet without changing the persona.</p></div>{draft && <span className="status-pill">Revision {draft.revision}</span>}</header>
    {(error || notice || lock || saveState !== "idle" || sheetRefreshError) && <div ref={statusRef} tabIndex={-1} className={`builder-status ${error || sheetRefreshError || saveState === "stale" || lock?.phase === "uncertain" ? "is-error" : ""}`} role={error || sheetRefreshError || saveState === "stale" || lock?.phase === "uncertain" ? "alert" : "status"}><p>{error || sheetRefreshError || lock?.message || notice || (saveState === "saving" ? "Saving…" : saveState === "saved" ? `Saved revision ${draft?.revision ?? 0}.` : saveState === "stale" ? "Stale revision." : "Save failed.")}</p>{lock?.phase === "uncertain" && initialDraftId && <button className="primary" disabled={loading} onClick={() => void load(true)}>{loading ? "Refreshing…" : "Refresh authoritative draft"}</button>}</div>}
    {lock?.phase === "uncertain" && lock.kind === "create" && !initialDraftId && <section className="builder-section ambiguous-create-resolution" aria-labelledby="ambiguous-create-heading"><h2 id="ambiguous-create-heading">Review unresolved draft creation</h2><p className="builder-help">No draft-list endpoint exists, so campaign roster refresh cannot prove whether this draft POST committed. The same POST will not be replayed automatically.</p><button className="ghost" type="button" onClick={onReviewCampaignRoster}>Review authoritative campaign roster</button><label className="builder-confirm"><input type="checkbox" checked={creationResolutionConfirmed} onChange={(event) => setCreationResolutionConfirmed(event.target.checked)} /> I reviewed the available campaign status and accept responsibility for clearing this unresolved draft lock.</label><button className="danger subtle" type="button" disabled={!creationResolutionConfirmed} onClick={resolveAmbiguousCreation}>Clear reviewed lock without replaying POST</button></section>}
    {!draft && !loading && <section className="builder-section persona-selection"><h2>Choose an existing persona</h2><p className="builder-help">Persona name, description, boundaries, and memories stay in the separate persona editor.</p>{personas.length ? <><label className="field"><span>Persona</span><select value={personaId} disabled={creating || Boolean(lock)} onChange={(event) => setPersonaId(event.target.value)}>{personas.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select></label><button className="ghost" type="button" disabled={!personaId || creating || Boolean(lock)} onClick={() => onEditPersona(personaId)}>Edit selected persona separately</button><AttributeAllocator disabled={creating || Boolean(lock)} onContinue={(allocation) => void create(allocation)} /></> : <p role="alert">Create a persona in the character library before building playable mechanics.</p>}</section>}
    {loading && !draft && <section className="builder-section" aria-busy="true"><p role="status">Loading draft…</p></section>}
    {error && !draft && initialDraftId && <button ref={retryRef} className="primary" onClick={() => void load()}>Retry draft</button>}
    {draft && <div className="character-builder-layout">
      <section className="builder-section attribute-review" aria-labelledby="attribute-review-heading"><div className="builder-section-heading"><div><p className="eyebrow">BASE ATTRIBUTES</p><h2 id="attribute-review-heading">{draft.allocation.method === "server-roll" ? "Server roll" : draft.allocation.method.replace("-", " ")}</h2></div>{draft.allocation.method === "server-roll" && <button className="ghost" type="button" disabled={busy || Boolean(lock) || draft.status !== "active"} onClick={() => void reroll()}>Reroll all stats</button>}</div><div className="attribute-score-review">{Object.entries(draft.allocation.scores).map(([name, score]) => <div key={name}><span>{name}</span><strong>{score}</strong></div>)}</div>{draft.allocation.method === "server-roll" && <details><summary>Show auditable dice</summary><ul className="roll-term-list">{draft.allocation.terms.map((term) => <li key={term.attributeId}><strong>{term.attributeId}</strong>: {term.dice.map((die, index) => <span key={index} className={index === term.droppedIndex ? "is-dropped" : ""}>{die}</span>)} = {term.score}</li>)}</ul></details>}</section>
      <ChoiceGroupEditor groups={draft.choiceGroups} selections={draft.selections} disabled={busy || Boolean(lock) || draft.status !== "active"} onSelect={(selection) => void save(selection)} />
      {!draft.completion.complete && <section className="builder-section completion-issues" aria-labelledby="completion-heading"><h2 id="completion-heading">Complete required choices</h2><ul>{draft.completion.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><button type="button" onClick={() => document.getElementById(issueTarget(issue.path))?.focus()}>{issue.message}</button></li>)}</ul></section>}
      {draft.derivedPreview && <DerivedStatsReview derived={draft.derivedPreview} startingGrants={draft.startingGrants} />}
      {draft.completion.complete && draft.derivedPreview && draft.status === "active" && <section className="builder-section finalization-review"><h2>Explicit finalization confirmation</h2><p>Review every server-derived value and exact grant above. Finalization creates the playable sheet once.</p><label className="builder-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the server preview and exact starter grants and want to finalize once.</label><button className="primary" disabled={!confirmed || busy || Boolean(lock)} onClick={() => void finalize()}>Finalize playable character once</button></section>}
      {draft.status === "finalized" && !finalResult && <section className="builder-section finalized-character"><h2>Draft already finalized</h2><p>This saved draft cannot be changed or finalized again.</p><button className="primary" onClick={startNewDraft}>Start a new draft</button></section>}
    </div>}
    {finalResult && <section className="builder-section finalized-character"><h2>Playable character finalized</h2><p className="builder-receipt">Receipt revision {finalResult.receipt.revisionBefore} → {finalResult.receipt.revisionAfter} at {new Date(finalResult.receipt.occurredAt).toLocaleString()}.</p><p>Created character <code>{finalResult.character.id}</code>. Finalization is confirmed and will not be repeated.</p>{finalSheet ? <p>Authoritative sheet: level {finalSheet.progression.level}, maximum health {finalSheet.derived.maxHp}.</p> : <p>The public finalization response preserved the created sheet and health grant while the display sheet refresh is pending or unavailable.</p>}<div className="button-row"><button className="primary" onClick={() => onOpenCharacter(finalResult.character.id)}>Open created character</button>{!finalSheet && <button className="ghost" onClick={() => void retryFinalSheet()}>Retry authoritative sheet GET</button>}<button className="ghost" onClick={startNewDraft}>Build another character</button></div></section>}
  </section></main>;
}
