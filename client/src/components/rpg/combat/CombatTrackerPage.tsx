import { resourceIdSchema } from "@velvet/contracts";
import type {
  ActorEffectsResponse, ActorPowersResponse, CombatActionCommandRequest, CombatActionCommandResponse,
  CombatLegalAction, CombatLogEntryPublic, CombatLogResponse, CombatReadResponse,
} from "@velvet/contracts";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CombatLog } from "./CombatLog";
import { EffectList } from "./EffectList";
import { InitiativeRail } from "./InitiativeRail";
import { LegalActionTray } from "./LegalActionTray";
import { PowerLibraryPanel } from "./PowerLibraryPanel";

export interface CombatTrackerApi {
  getCombat: (combatId: string) => Promise<CombatReadResponse>;
  getCombatLog: (combatId: string, query: { afterSequence: number; limit: number }) => Promise<CombatLogResponse>;
  resolveAction: (combatId: string, command: CombatActionCommandRequest) => Promise<CombatActionCommandResponse>;
  getPowers: (actorId: string) => Promise<ActorPowersResponse>;
  getEffects: (actorId: string) => Promise<ActorEffectsResponse>;
}

export interface CombatTrackerPageProps {
  api: CombatTrackerApi;
  initialCombatId?: string;
  onBack: () => void;
  onUnavailable?: () => void;
  focusHeadingRequest?: number;
}

type ActionMarker = {
  combatId: string;
  phase: "ambiguous" | "confirmed";
  command: CombatActionCommandRequest;
  actionKind: string;
  startedAt: string;
  result?: CombatActionCommandResponse;
};

const COMBAT_KEY = "velvet.combat-id.v1";
const ACTOR_KEY = "velvet.combat-actor-id.v1";
const markerKey = (combatId: string) => `velvet.combat-action.v1:${combatId}`;
const readStoredId = (key: string) => { try { const id = localStorage.getItem(key) ?? ""; return resourceIdSchema.safeParse(id).success ? id : ""; } catch { return ""; } };
const writeStoredId = (key: string, id: string) => { try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch { /* optional restoration */ } };
const readMarker = (combatId: string): ActionMarker | null => {
  if (!combatId) return null;
  try {
    const value = JSON.parse(localStorage.getItem(markerKey(combatId)) ?? "null") as Partial<ActionMarker> | null;
    return value?.combatId === combatId && (value.phase === "ambiguous" || value.phase === "confirmed") && typeof value.actionKind === "string" && typeof value.startedAt === "string" && value.command !== undefined ? value as ActionMarker : null;
  } catch { return null; }
};
const writeMarker = (combatId: string, marker: ActionMarker | null) => { try { if (marker) localStorage.setItem(markerKey(combatId), JSON.stringify(marker)); else localStorage.removeItem(markerKey(combatId)); } catch { /* best-effort durable write lock */ } };
const commandId = () => `combat-ui-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const readCombatId = (initial?: string) => resourceIdSchema.safeParse(initial).success ? initial! : readStoredId(COMBAT_KEY);

function publicRead(response: CombatActionCommandResponse): CombatReadResponse {
  const { round, currentCombatant, combatants, legalActions, revision } = response.combat;
  return { round, currentCombatant, combatants, legalActions, revision };
}

function OutcomeReceipt({ result }: { result: CombatActionCommandResponse }) {
  const { resolution, receipt } = result;
  return <section className="combat-receipt" aria-labelledby="combat-receipt-heading">
    <div className="combat-panel-heading"><h2 id="combat-receipt-heading">Confirmed action receipt</h2><span>{resolution.kind}</span></div>
    <dl><div><dt>Action</dt><dd>{resolution.kind}</dd></div><div><dt>Revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div><div><dt>Round</dt><dd>{resolution.roundBefore} → {resolution.roundAfter}</dd></div><div><dt>Occurred</dt><dd>{receipt.occurredAt}</dd></div><div><dt>Targets</dt><dd>{resolution.targetIds.length ? resolution.targetIds.join(", ") : "None"}</dd></div></dl>
    {resolution.outcomes.length > 0 && <ul>{resolution.outcomes.map((outcome, index) => <li key={`${outcome.kind}-${outcome.targetId}-${index}`}>{outcome.kind === "damage" ? <><strong>Damage:</strong> {outcome.applied} {outcome.damageType} · HP {outcome.hitPointsBefore} → {outcome.hitPointsAfter} · {outcome.statusBefore} → {outcome.statusAfter}</> : <><strong>Status:</strong> {outcome.statusBefore} → {outcome.statusAfter}</>}</li>)}</ul>}
    <details><summary>Complete strict server response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>
  </section>;
}

export function CombatTrackerPage({ api, initialCombatId, onBack, onUnavailable, focusHeadingRequest }: CombatTrackerPageProps) {
  const initialId = useMemo(() => readCombatId(initialCombatId), [initialCombatId]);
  const [combatId, setCombatId] = useState(initialId);
  const [combatDraft, setCombatDraft] = useState(initialId);
  const [actorId, setActorId] = useState(() => readStoredId(ACTOR_KEY));
  const [actorDraft, setActorDraft] = useState(actorId);
  const [combat, setCombat] = useState<CombatReadResponse | null>(null);
  const [entries, setEntries] = useState<CombatLogEntryPublic[]>([]);
  const [nextSequence, setNextSequence] = useState<number | null>(null);
  const [powers, setPowers] = useState<ActorPowersResponse | null>(null);
  const [effects, setEffects] = useState<ActorEffectsResponse | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "failed">(initialId ? "loading" : "idle");
  const [stateError, setStateError] = useState("");
  const [logError, setLogError] = useState("");
  const [powerError, setPowerError] = useState("");
  const [effectError, setEffectError] = useState("");
  const [logLoading, setLogLoading] = useState(false);
  const [actorLoading, setActorLoading] = useState(false);
  const [marker, setMarkerState] = useState<ActionMarker | null>(() => readMarker(initialId));
  const [confirmed, setConfirmed] = useState<CombatActionCommandResponse | null>(() => readMarker(initialId)?.result ?? null);
  const [commandStatus, setCommandStatus] = useState("");
  const [inspected, setInspected] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const actorGenerationRef = useRef(0);
  const combatIdRef = useRef(combatId);
  const actorIdRef = useRef(actorId);
  combatIdRef.current = combatId;
  actorIdRef.current = actorId;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  const current = useCallback((generation: number, id: string) => mountedRef.current && generationRef.current === generation && combatIdRef.current === id, []);
  const setMarker = useCallback((next: ActionMarker | null, id = combatId) => { writeMarker(id, next); if (mountedRef.current) setMarkerState(next); }, [combatId]);

  const loadCombat = useCallback(async (id: string, focusFailure = false) => {
    if (!resourceIdSchema.safeParse(id).success) return;
    const generation = ++generationRef.current;
    setPhase("loading"); setStateError(""); setLogError(""); setLogLoading(true);
    const [stateRead, logRead] = await Promise.allSettled([api.getCombat(id), api.getCombatLog(id, { afterSequence: 0, limit: 50 })] as const);
    if (!current(generation, id)) return false;
    if (stateRead.status === "fulfilled") { setCombat(stateRead.value); setPhase("ready"); }
    else { setStateError("Combat state could not be refreshed."); setPhase(combat ? "ready" : "failed"); if (focusFailure) queueMicrotask(() => retryRef.current?.focus()); }
    if (logRead.status === "fulfilled") { setEntries(logRead.value.entries); setNextSequence(logRead.value.nextAfterSequence); }
    else setLogError("Combat log could not be refreshed. Existing events are preserved.");
    setLogLoading(false);
    return stateRead.status === "fulfilled" && logRead.status === "fulfilled";
  }, [api, combat, current]);

  const loadActor = useCallback(async (id: string) => {
    if (!resourceIdSchema.safeParse(id).success) return;
    const generation = ++actorGenerationRef.current; setActorLoading(true); setPowerError(""); setEffectError("");
    const [powerRead, effectRead] = await Promise.allSettled([api.getPowers(id), api.getEffects(id)] as const);
    if (!mountedRef.current || generation !== actorGenerationRef.current || id !== actorIdRef.current) return;
    if (powerRead.status === "fulfilled") setPowers(powerRead.value); else setPowerError("Powers could not be refreshed. Existing power data is preserved.");
    if (effectRead.status === "fulfilled") setEffects(effectRead.value); else setEffectError("Effects could not be refreshed. Existing effect data is preserved.");
    setActorLoading(false);
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    if (combatId) void loadCombat(combatId);
    if (actorId) void loadActor(actorId);
    return () => { mountedRef.current = false; generationRef.current += 1; actorGenerationRef.current += 1; };
    // Route identity initializes this component; explicit forms handle changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (phase === "ready" && focusHeadingRequest !== undefined) queueMicrotask(() => headingRef.current?.focus()); }, [focusHeadingRequest, phase]);

  function connectCombat(event: FormEvent) {
    event.preventDefault(); if (!resourceIdSchema.safeParse(combatDraft).success) return;
    generationRef.current += 1; combatIdRef.current = combatDraft; setCombatId(combatDraft); writeStoredId(COMBAT_KEY, combatDraft); setCombat(null); setEntries([]); setNextSequence(null);
    const restored = readMarker(combatDraft); setMarkerState(restored); setConfirmed(restored?.result ?? null); setCommandStatus("");
    // State publication is asynchronous, so this direct read is bound to the submitted exact ID.
    queueMicrotask(() => { if (mountedRef.current) void loadCombat(combatDraft); });
  }
  function connectActor(event: FormEvent) {
    event.preventDefault(); if (!resourceIdSchema.safeParse(actorDraft).success) return;
    actorGenerationRef.current += 1; actorIdRef.current = actorDraft; setActorId(actorDraft); writeStoredId(ACTOR_KEY, actorDraft); setPowers(null); setEffects(null);
    queueMicrotask(() => { if (mountedRef.current) void loadActor(actorDraft); });
  }
  async function loadMoreLog() {
    if (!combatId || nextSequence === null || logLoading) return;
    const cursor = nextSequence; setLogLoading(true); setLogError("");
    try {
      const page = await api.getCombatLog(combatId, { afterSequence: cursor, limit: 50 });
      if (!mountedRef.current || combatIdRef.current !== combatId) return;
      setEntries((currentEntries) => [...currentEntries, ...page.entries.filter((entry) => !currentEntries.some((old) => old.sequence === entry.sequence))]);
      setNextSequence(page.nextAfterSequence);
    } catch { if (mountedRef.current) setLogError("Later combat events could not be loaded."); }
    finally { if (mountedRef.current) setLogLoading(false); }
  }
  async function submitAction(action: CombatLegalAction, targetIds: string[]) {
    if (!combat || marker || !action.targetIds.every((id) => combat.combatants.some((entry) => entry.combatantId === id)) || targetIds.some((id) => !action.targetIds.includes(id))) return;
    const command: CombatActionCommandRequest = { legalActionId: action.legalActionId, targetIds, choices: [], expectedRevision: combat.revision, idempotencyKey: commandId() };
    const pending: ActionMarker = { combatId, phase: "ambiguous", command, actionKind: action.kind, startedAt: new Date().toISOString() };
    setMarker(pending); setConfirmed(null); setCommandStatus("Submitting once. Automatic replay is disabled.");
    try {
      const result = await api.resolveAction(combatId, command);
      const complete: ActionMarker = { ...pending, phase: "confirmed", result };
      writeMarker(combatId, complete);
      if (!mountedRef.current) return;
      setMarkerState(complete); setConfirmed(result); setCombat(publicRead(result));
      setCommandStatus("Action confirmed. Refreshing authoritative combat state and log…");
      const refreshed = await loadCombat(combatId);
      if (!mountedRef.current) return;
      if (refreshed) { setMarker(null); setCommandStatus("Action confirmed; authoritative state and log refreshed."); }
      else setCommandStatus("Action confirmed, but refresh was partial. The receipt and write lock are preserved.");
    } catch {
      if (mountedRef.current) setCommandStatus("Action outcome is uncertain or stale. It will not be replayed. Use authoritative refresh before another action.");
    }
  }
  async function reconcile() {
    if (!combatId || !marker) return;
    setCommandStatus("Refreshing authoritative state and log; no action will be replayed.");
    const refreshed = await loadCombat(combatId, true);
    if (!mountedRef.current) return;
    if (refreshed) { setMarker(null); setCommandStatus(marker.phase === "confirmed" ? "Confirmed response preserved; authoritative state and log refreshed." : "Authoritative state and log refreshed. The prior action was not replayed."); }
    else setCommandStatus("Authoritative refresh is incomplete. The persistent action lock remains.");
  }

  const labels = useMemo(() => new Map(combat?.combatants.map((entry) => [entry.combatantId, entry.kind === "actor" ? entry.actorId : entry.template?.definitionId ?? "Enemy"]) ?? []), [combat]);
  const inspectedCombatant = combat?.combatants.find((entry) => entry.combatantId === inspected) ?? null;

  return <main className="combat-page" aria-labelledby="combat-heading"><div className="combat-shell">
    <header className="combat-header"><div><button type="button" className="back-link" onClick={onBack}>← Back</button><p className="eyebrow">LIVE SERVER COMBAT</p><h1 ref={headingRef} tabIndex={-1} id="combat-heading">Combat tracker</h1></div>{combat && <div className="combat-round"><span>Round</span><strong>{combat.round}</strong><small>Revision {combat.revision}</small></div>}</header>
    <form className="combat-binding" onSubmit={connectCombat}><label>Combat ID<input value={combatDraft} onChange={(event) => setCombatDraft(event.target.value)} autoComplete="off" /></label><button type="submit" className="ghost" disabled={!resourceIdSchema.safeParse(combatDraft).success || Boolean(marker)}>Load combat</button><p>The current APIs provide no campaign-to-combat discovery binding. Enter the exact server-provided combat ID; the client never guesses one.</p></form>
    {marker && <section className={`combat-lock ${marker.phase === "ambiguous" ? "is-warning" : ""}`} role="alert"><p><strong>{marker.phase === "confirmed" ? "Confirmed action awaiting complete refresh" : "Action outcome unresolved"}.</strong> {marker.actionKind} was issued once at {marker.startedAt}. Controls remain locked and no automatic replay is allowed.</p><button type="button" className="ghost" onClick={() => void reconcile()}>Refresh authoritative state & log</button></section>}
    {commandStatus && <p className="combat-command-status" role="status">{commandStatus}</p>}
    {confirmed && <OutcomeReceipt result={confirmed} />}
    {phase === "idle" && <section className="combat-welcome"><h2>Connect a combat</h2><p>Combat state and paginated events will load without issuing an action.</p></section>}
    {phase === "loading" && !combat && <section className="combat-welcome" role="status">Loading authoritative combat state…</section>}
    {phase === "failed" && !combat && <section className="combat-welcome" role="alert"><p>{stateError}</p><div className="button-row"><button ref={retryRef} type="button" className="ghost" onClick={() => void loadCombat(combatId, true)}>Retry combat</button>{onUnavailable && <button type="button" className="ghost" onClick={onUnavailable}>Leave combat</button>}</div></section>}
    {combat && <div className="combat-layout">
      <InitiativeRail combatants={combat.combatants} currentCombatant={combat.currentCombatant} selectedCombatant={inspected} onInspect={setInspected} />
      <section className="combat-main-column">
        <section className="combat-panel current-turn" aria-live="polite"><div><span>Current turn</span><strong><bdi dir="auto">{combat.currentCombatant ? labels.get(combat.currentCombatant) ?? combat.currentCombatant : "Combat complete"}</bdi></strong></div>{stateError && <p role="alert">{stateError}</p>}{inspectedCombatant && <dl><div><dt>Team</dt><dd>{inspectedCombatant.team}</dd></div><div><dt>Status</dt><dd>{inspectedCombatant.status}</dd></div><div><dt>Hit points</dt><dd>{inspectedCombatant.hitPoints} / {inspectedCombatant.maximumHitPoints}</dd></div></dl>}</section>
        <CombatLog entries={entries} nextAfterSequence={nextSequence} loading={logLoading} error={logError} onLoadMore={() => void loadMoreLog()} onRetry={() => void loadCombat(combatId)} />
        <form className="combat-binding actor-combat-binding" onSubmit={connectActor}><label>Actor ID for powers & effects<input value={actorDraft} onChange={(event) => setActorDraft(event.target.value)} autoComplete="off" /></label><button type="submit" className="ghost" disabled={!resourceIdSchema.safeParse(actorDraft).success}>Load actor lanes</button><p>Actor identity is entered explicitly because combat state does not expose a safe actor-workspace binding.</p></form>
        <div className="combat-actor-lanes"><PowerLibraryPanel powers={powers} loading={actorLoading} error={powerError} onRefresh={actorId ? () => void loadActor(actorId) : undefined} /><EffectList effects={effects} loading={actorLoading} error={effectError} onRefresh={actorId ? () => void loadActor(actorId) : undefined} /></div>
      </section>
      <LegalActionTray legalActions={combat.legalActions} combatantLabels={labels} disabled={Boolean(marker)} busy={marker?.phase === "ambiguous" && commandStatus.startsWith("Submitting")} onSubmit={(action, targets) => void submitAction(action, targets)} />
    </div>}
  </div></main>;
}
