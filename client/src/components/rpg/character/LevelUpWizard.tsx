import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CharacterProgressionHttpApplyRequest, CharacterProgressionHttpApplyResponse, CharacterProgressionHttpPreview,
  CharacterProgressionHttpPreviewRequest, CharacterProgressionHttpState, CharacterSheetHttpResponse, ProgressionSelection,
} from "@velvet/contracts";
import { ApiError, ApiInputError } from "../../../api";

export interface LevelUpWizardApi {
  getProgression: (campaignId: string, campaignCharacterId: string) => Promise<CharacterProgressionHttpState>;
  preview: (campaignId: string, campaignCharacterId: string, input: CharacterProgressionHttpPreviewRequest) => Promise<CharacterProgressionHttpPreview>;
  apply: (campaignId: string, campaignCharacterId: string, input: CharacterProgressionHttpApplyRequest, expectedPreview: CharacterProgressionHttpPreview) => Promise<CharacterProgressionHttpApplyResponse>;
  getSheet: (campaignId: string, campaignCharacterId: string) => Promise<CharacterSheetHttpResponse>;
}

export interface LevelUpWizardProps {
  campaignId: string;
  campaignCharacterId: string;
  api: LevelUpWizardApi;
  onUnavailable?: () => void;
  onSheetRefreshed?: (sheet: CharacterSheetHttpResponse) => void;
}

type ApplyLock = { token: symbol; phase: "writing" | "uncertain"; message: string };
const applyLocks = new Map<string, ApplyLock>();
const applyListeners = new Set<(key: string, lock: ApplyLock | null) => void>();
const characterKey = (campaignId: string, characterId: string) => `${campaignId.length}:${campaignId}${characterId}`;
function publish(key: string, lock: ApplyLock | null) { if (lock) applyLocks.set(key, lock); else applyLocks.delete(key); for (const listener of applyListeners) listener(key, lock); }
function intentKey(kind: string) { const value = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`; return `ui-${kind}-${value}`; }
function knownNonCommit(error: unknown) { return error instanceof ApiInputError || (error instanceof ApiError && [400, 404, 409, 415, 422].includes(error.status)); }
function optionKey(option: ProgressionSelection["ability"]) { return `${option.packId}:${option.packVersion}:${option.definitionId}`; }
function selectionKey(selections: ProgressionSelection[]): string {
  return JSON.stringify([...selections].sort((left, right) => left.choiceId.localeCompare(right.choiceId))
    .map(({ choiceId, ability }) => [choiceId, ability.kind, ability.packId, ability.packVersion, ability.definitionId]));
}

export function resetLevelUpWizardModuleStateForTests(): void { applyLocks.clear(); applyListeners.clear(); }

/** Applies one exact server preview. A document-lifetime lock prevents replay after an ambiguous outcome. */
export function LevelUpWizard({ campaignId, campaignCharacterId, api, onUnavailable = () => undefined, onSheetRefreshed = () => undefined }: LevelUpWizardProps) {
  const key = characterKey(campaignId, campaignCharacterId);
  const [state, setState] = useState<CharacterProgressionHttpState | null>(null);
  const [preview, setPreview] = useState<CharacterProgressionHttpPreview | null>(null);
  const [previewSelectionKey, setPreviewSelectionKey] = useState<string | null>(null);
  const [pendingChoices, setPendingChoices] = useState<CharacterProgressionHttpPreview["pendingChoices"]>([]);
  const [selections, setSelections] = useState<ProgressionSelection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [receipt, setReceipt] = useState<CharacterProgressionHttpApplyResponse["receipt"] | null>(null);
  const [lock, setLock] = useState<ApplyLock | null>(() => applyLocks.get(key) ?? null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const activeRef = useRef(key); activeRef.current = key;
  const statusRef = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const unavailableRef = useRef(onUnavailable); unavailableRef.current = onUnavailable;
  const sheetRefreshedRef = useRef(onSheetRefreshed); sheetRefreshedRef.current = onSheetRefreshed;

  const focusStatus = useCallback((generation: number, retry = false) => queueMicrotask(() => {
    if (mountedRef.current && generationRef.current === generation) (retry ? retryRef.current : statusRef.current)?.focus();
  }), []);

  const load = useCallback(async (authoritative = false, retryFocus = false) => {
    const requestedKey = key; const generation = ++generationRef.current;
    if (authoritative) setRefreshing(true); else setLoading(true);
    setError("");
    try {
      const [nextState, nextSheet] = await Promise.all([api.getProgression(campaignId, campaignCharacterId), api.getSheet(campaignId, campaignCharacterId)]);
      const nextPreview = await api.preview(campaignId, campaignCharacterId, { selections: [] });
      if (!mountedRef.current || activeRef.current !== requestedKey || generationRef.current !== generation) return;
      setState(nextState); setPreview(nextPreview); setPreviewSelectionKey(selectionKey([])); setPendingChoices(nextPreview.pendingChoices); setSelections([]); setLoading(false); setRefreshing(false);
      sheetRefreshedRef.current(nextSheet);
      if (authoritative) {
        publish(requestedKey, null); setNotice("Authoritative progression and sheet refreshed. No advancement was retried."); focusStatus(generation);
      }
    } catch (loadError) {
      if (!mountedRef.current || activeRef.current !== requestedKey || generationRef.current !== generation) return;
      setLoading(false); setRefreshing(false); setError("Character advancement could not be loaded.");
      if (loadError instanceof ApiError && loadError.status === 404) unavailableRef.current(); else if (retryFocus || authoritative) focusStatus(generation, true);
    }
  }, [api, campaignCharacterId, campaignId, focusStatus, key]);

  useEffect(() => {
    mountedRef.current = true; activeRef.current = key; setLock(applyLocks.get(key) ?? null);
    const listener = (changed: string, next: ApplyLock | null) => { if (mountedRef.current && activeRef.current === changed) setLock(next); };
    applyListeners.add(listener); void load();
    return () => { mountedRef.current = false; generationRef.current += 1; applyListeners.delete(listener); };
  }, [key, load]);

  async function updatePreview() {
    const generation = ++generationRef.current; const requestedSelections = [...selections]; const requestedKey = selectionKey(requestedSelections);
    setError(""); setNotice("Calculating exact changes on the server…");
    try {
      const result = await api.preview(campaignId, campaignCharacterId, { selections: requestedSelections });
      if (!mountedRef.current || generationRef.current !== generation) return;
      setPreview(result); setPreviewSelectionKey(requestedKey); setPendingChoices(result.pendingChoices); setNotice("Exact advancement changes are ready for review."); focusStatus(generation);
    } catch { if (mountedRef.current && generationRef.current === generation) { setError("Choices could not be previewed. Nothing was applied."); focusStatus(generation); } }
  }

  function choose(choiceId: string, ability: ProgressionSelection["ability"]) {
    generationRef.current += 1;
    setSelections((current) => [...current.filter((item) => item.choiceId !== choiceId), { choiceId, ability }]);
    setPreview(null); setPreviewSelectionKey(null); setNotice("Choices changed. Calculate a new exact preview before applying.");
  }

  async function applyOnce() {
    const currentSelectionKey = selectionKey(selections);
    if (!preview || previewSelectionKey !== currentSelectionKey || applyLocks.has(key)) return;
    const token = Symbol(key); const entry: ApplyLock = { token, phase: "writing", message: "Applying this reviewed advancement once…" };
    publish(key, entry); setError(""); setNotice("");
    const input = { previewRevision: preview.previewRevision, previewToken: preview.previewToken, selections, idempotencyKey: intentKey("level-up") };
    try {
      const result = await api.apply(campaignId, campaignCharacterId, input, preview);
      if (JSON.stringify(result.receipt.appliedLevels) !== JSON.stringify(preview.levels)
        || result.receipt.revisionBefore !== preview.previewRevision || result.progression.level !== preview.eligibleLevel) {
        throw new Error("Progression apply response did not match the displayed preview");
      }
      if (applyLocks.get(key)?.token !== token) return;
      publish(key, null);
      if (!mountedRef.current || activeRef.current !== key) return;
      setState(result.progression); setReceipt(result.receipt); setPreview(null); setPreviewSelectionKey(null);
      setNotice(`Levels ${result.receipt.appliedLevels.map((level) => level.level).join(", ")} applied exactly once. Refreshing the authoritative sheet…`);
      try {
        const freshSheet = await api.getSheet(campaignId, campaignCharacterId);
        if (!mountedRef.current || activeRef.current !== key) return;
        sheetRefreshedRef.current(freshSheet);
        setNotice(`Levels ${result.receipt.appliedLevels.map((level) => level.level).join(", ")} applied exactly once. Authoritative sheet refreshed.`);
      } catch {
        if (mountedRef.current && activeRef.current === key) setError("Advancement was confirmed by receipt, but the authoritative sheet refresh failed. The apply will not be repeated.");
      }
      focusStatus(generationRef.current);
    } catch (applyError) {
      if (applyLocks.get(key)?.token !== token) return;
      if (knownNonCommit(applyError)) publish(key, null);
      else publish(key, { token, phase: "uncertain", message: "The apply outcome is uncertain. Applying again is locked until authoritative refresh; no write will be retried." });
      if (mountedRef.current && activeRef.current === key) { setError(knownNonCommit(applyError) ? "Advancement was rejected. The reviewed preview and sheet remain unchanged." : "The apply outcome is uncertain. Refresh authoritative state before continuing."); focusStatus(generationRef.current); }
    }
  }

  if (loading && !state) return <section className="builder-section level-up-wizard" aria-busy="true"><h2>Advancement</h2><p role="status">Loading progression…</p></section>;
  if (!state) return <section className="builder-section level-up-wizard"><h2>Advancement unavailable</h2><p role="alert">{error}</p><button ref={retryRef} className="primary" onClick={() => void load(false, true)}>Retry</button></section>;
  const pending = pendingChoices.length ? pendingChoices : state.pendingChoices;
  const allSelected = pending.every((choice) => selections.some((selection) => selection.choiceId === choice.choiceId));
  const previewCurrent = preview !== null && previewSelectionKey === selectionKey(selections);
  return <section className="builder-section level-up-wizard" aria-labelledby="level-up-heading" aria-busy={lock?.phase === "writing" || refreshing}>
    <div className="builder-section-heading"><div><p className="eyebrow">SERVER-CALCULATED ADVANCEMENT</p><h2 id="level-up-heading">Level up wizard</h2></div><span className="status-pill">Level {state.level}</span></div>
    {(error || notice || lock) && <div ref={statusRef} tabIndex={-1} className={`builder-status ${error || lock?.phase === "uncertain" ? "is-error" : ""}`} role={error || lock?.phase === "uncertain" ? "alert" : "status"}><p>{error || lock?.message || notice}</p>{lock?.phase === "uncertain" && <button className="primary" disabled={refreshing} onClick={() => void load(true)}>{refreshing ? "Refreshing…" : "Refresh authoritative state"}</button>}</div>}
    <dl className="progression-summary"><div><dt>Current level</dt><dd>{state.level}</dd></div><div><dt>Eligible level</dt><dd>{preview?.eligibleLevel ?? state.level}</dd></div><div><dt>Total XP</dt><dd>{state.totalXp}</dd></div><div><dt>Milestones</dt><dd>{state.milestoneCount}</dd></div></dl>
    {pending.length > 0 && <fieldset disabled={Boolean(lock)}><legend>All required choices</legend>{pending.map((choice) => <label className="field" key={choice.choiceId}><span>Level {choice.level} · required ability</span><select value={selections.find((item) => item.choiceId === choice.choiceId) ? optionKey(selections.find((item) => item.choiceId === choice.choiceId)!.ability) : ""} onChange={(event) => { const ability = choice.options.find((item) => optionKey(item) === event.target.value); if (ability) choose(choice.choiceId, ability); }}><option value="">Choose an ability</option>{choice.options.map((option) => <option key={optionKey(option)} value={optionKey(option)}>{option.definitionId}</option>)}</select></label>)}</fieldset>}
    <button className="ghost" disabled={Boolean(lock) || !allSelected} onClick={() => void updatePreview()}>Calculate exact changes</button>
    {previewCurrent && preview && <section className="level-crossings" aria-labelledby="level-crossings-heading"><h3 id="level-crossings-heading">Every crossed level</h3>{preview.levels.length === 0 ? <p>No levels are currently ready to apply.</p> : <ol>{preview.levels.map((level) => <li key={level.level}><h4>Level {level.level}</h4><dl><div><dt>Health</dt><dd>{level.hp.currentBefore} / {level.hp.maxBefore} → {level.hp.currentAfter} / {level.hp.maxAfter} (+{level.hp.gain} max)</dd></div><div><dt>Proficiency</dt><dd>{level.proficiency.before} → {level.proficiency.after}</dd></div><div><dt>Maximum health derived</dt><dd>{level.derivedBefore.maxHp} → {level.derivedAfter.maxHp}</dd></div><div><dt>Fixed abilities</dt><dd>{level.fixedAbilities.map((item) => item.definitionId).join(", ") || "None"}</dd></div><div><dt>Selected abilities</dt><dd>{level.selectedAbilities.map((item) => item.definitionId).join(", ") || "None"}</dd></div><div><dt>Spells</dt><dd>{level.spells.map((item) => item.definitionId).join(", ") || "None"}</dd></div>{level.resources.map((resource) => <div key={resource.resourceId}><dt>{resource.resourceId}</dt><dd>{resource.currentBefore}/{resource.maxBefore} → {resource.currentAfter}/{resource.maxAfter}</dd></div>)}</dl></li>)}</ol>}</section>}
    {previewCurrent && preview.levels.length ? <button className="primary" disabled={Boolean(lock) || !allSelected} onClick={() => void applyOnce()}>Apply reviewed levels once</button> : null}
    {receipt && <p className="builder-receipt" role="status">Receipt confirmed revision {receipt.revisionBefore} → {receipt.revisionAfter} at {new Date(receipt.occurredAt).toLocaleString()}.</p>}
  </section>;
}
