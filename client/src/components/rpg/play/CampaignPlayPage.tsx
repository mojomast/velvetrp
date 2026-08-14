import { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adventureTurnResumeTokenSchema, idempotencyKeySchema, resourceIdSchema } from "@velvet/contracts";
import type { AdventureTurnConfirmRequest, AdventureTurnGetResponse, AdventureTurnInitialReconcileRequest,
  AdventureTurnStreamEvent, CampaignPlayBootstrap } from "@velvet/contracts";
import type { AdventureTurnClientBinding } from "../../../api";
import { ApiError } from "../../../api";
import { AdventureActionComposer } from "./AdventureActionComposer";
import { CampaignContextDrawer, type CampaignContextDrawerApi } from "./CampaignContextDrawer";
import { ConfirmationBanner } from "./ConfirmationBanner";
import { MechanicReceiptCard, type MechanicReceiptApi } from "./MechanicReceiptCard";
import { CampaignQuickPanel, type CampaignQuickPanelApi } from "./CampaignQuickPanel";
import { CAMPAIGN_CONTEXT_WIDGETS, DEFAULT_CAMPAIGN_WORKBENCH_PREFERENCES, useCampaignWorkbenchPreferences,
  type CampaignContextWidget, type CampaignWorkbenchPreferences } from "./campaignWorkbenchPreferences";

/** Delivery-only handle. Cancelling it never cancels the durable adventure turn. */
export interface AdventureTurnStreamHandle {
  turnId: Promise<string>;
  done: Promise<void>;
  cancelDelivery: () => void;
}

type PlayStreamRequest =
  | { kind: "initial"; campaignId: string; sessionId: string; actorId: string; declaration: string; expectedRevision: number; idempotencyKey: string }
  | { kind: "resume"; resumeToken: string; expected: AdventureTurnClientBinding }
  | { kind: "narration-retry" | "narration-swipe"; campaignId: string; sessionId: string; actorId: string; priorTurnId: string;
    expectedRevision: number; idempotencyKey: string };

/** Narrow API required by the durable campaign play shell. */
export interface CampaignPlayApi extends CampaignContextDrawerApi, CampaignQuickPanelApi, MechanicReceiptApi {
  getCampaignPlayBootstrap: (campaignId: string, sessionId: string) => Promise<CampaignPlayBootstrap>;
  streamAdventureTurn: (request: PlayStreamRequest, onEvent: (event: AdventureTurnStreamEvent) => void) => AdventureTurnStreamHandle;
  getAdventureTurn: (turnId: string, expected: AdventureTurnClientBinding) => Promise<AdventureTurnGetResponse>;
  reconcileInitialAdventureTurn: (input: AdventureTurnInitialReconcileRequest) => Promise<AdventureTurnGetResponse | null>;
  confirmAdventureTurn: (turnId: string, input: AdventureTurnConfirmRequest, expected: AdventureTurnClientBinding) => Promise<{ turn: AdventureTurnGetResponse["turn"]; resumeToken?: string }>;
}

/** Props for the campaign play layout surrounding the existing room Chat child. */
export interface CampaignPlayPageProps {
  campaignId: string;
  sessionId: string;
  authorizationGeneration: number;
  api: CampaignPlayApi;
  children: ReactNode;
  onBack: () => void;
  onUnavailable: () => void;
  onSelectedActorChange?: (actorId: string | null) => void;
  onTurnIdChange?: (turnId: string | null) => void;
  initialSelectedActorId?: string;
  initialTurnId?: string;
  authorizationCanAct?: boolean;
  focusHeading?: boolean;
  onNavigate?: (destination: "campaign" | "combat" | "world" | "cast" | "quests" | "story" | "history" | "administration") => void;
  combatAvailable?: boolean;
  studioAvailable?: boolean;
}

type StreamPhase = "idle" | "streaming" | "awaiting-confirmation" | "ambiguous" | "terminal";
type SafeState = { turnId?: string; selectedActorId?: string; resumeToken?: string; streamPhase: StreamPhase };
type PendingInitial = { campaignId: string; sessionId: string; actorId: string; idempotencyKey: string };
type PendingTurnReconciliation = { turnId: string; actorId: string; allowResumeToken: boolean; priorTurnId?: string | null };
const stateKey = (campaignId: string, sessionId: string) => `velvet.campaign-play.v1:${campaignId}:${sessionId}`;
const lockKey = (campaignId: string, sessionId: string) => `velvet.campaign-play-submit.v1:${campaignId}:${sessionId}`;
const confirmationKey = (turnId: string) => `velvet.adventure-confirm.v1:${turnId}`;
const idempotency = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const widgetLabels: Record<CampaignContextWidget, string> = { location: "Location", cast: "Present cast", objectives: "Objectives", resources: "Party resources", encounter: "Encounter" };

function clampPaneWidth(value: number) { return Math.max(220, Math.min(520, Math.round(value))); }

function PanelSeparator({ side, value, controls, label, onChange, onCollapse }: { side: "left" | "right"; value: number; controls: string; label: string;
  onChange: (value: number) => void; onCollapse: () => void }) {
  function resize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX; const startWidth = value;
    const move = (next: PointerEvent) => onChange(clampPaneWidth(startWidth + (side === "left" ? next.clientX - startX : startX - next.clientX)));
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop);
  }
  return <div className="campaign-panel-separator" role="separator" aria-label={label} aria-controls={controls} aria-orientation="vertical"
    aria-valuemin={220} aria-valuemax={520} aria-valuenow={value} tabIndex={0} onPointerDown={resize} onKeyDown={(event) => {
      const inward = side === "left" ? "ArrowRight" : "ArrowLeft"; const outward = side === "left" ? "ArrowLeft" : "ArrowRight";
      if (event.key === inward) { event.preventDefault(); onChange(clampPaneWidth(value + (event.shiftKey ? 64 : 16))); }
      if (event.key === outward) { event.preventDefault(); onChange(clampPaneWidth(value - (event.shiftKey ? 64 : 16))); }
      if (event.key === "Home") { event.preventDefault(); onChange(220); }
      if (event.key === "End") { event.preventDefault(); onChange(520); }
      if (event.key === "Enter") { event.preventDefault(); onCollapse(); }
    }} />;
}

function WorkbenchPreferencesDialog({ dialogRef, preferences, onChange }: { dialogRef: React.RefObject<HTMLDialogElement>; preferences: CampaignWorkbenchPreferences;
  onChange: (value: CampaignWorkbenchPreferences) => void }) {
  const moveWidget = (widget: CampaignContextWidget, direction: -1 | 1) => {
    const index = preferences.widgets.indexOf(widget); const target = index + direction;
    if (index < 0 || target < 0 || target >= preferences.widgets.length) return;
    const widgets = [...preferences.widgets]; [widgets[index], widgets[target]] = [widgets[target]!, widgets[index]!];
    onChange({ ...preferences, widgets });
  };
  return <dialog ref={dialogRef} className="workbench-dialog" aria-labelledby="workbench-preferences-heading"><form method="dialog">
    <header><div><p className="eyebrow">LOCAL DISPLAY</p><h2 id="workbench-preferences-heading">Campaign workbench</h2></div><button className="ghost" value="close">Close</button></header>
    <div className="workbench-preference-grid"><label>Theme<select value={preferences.theme} onChange={(event) => onChange({ ...preferences, theme: event.target.value as CampaignWorkbenchPreferences["theme"] })}><option value="system">System</option><option value="light">Light</option><option value="dark">Velvet dark</option><option value="contrast">High contrast</option></select></label>
      <label>Layout density<select value={preferences.density} onChange={(event) => onChange({ ...preferences, density: event.target.value as CampaignWorkbenchPreferences["density"] })}><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option></select></label></div>
    <fieldset><legend>Panels</legend><label><input type="checkbox" checked={preferences.contextVisible} onChange={(event) => onChange({ ...preferences, contextVisible: event.target.checked })} /> Campaign context</label><label><input type="checkbox" checked={preferences.quickToolsVisible} onChange={(event) => onChange({ ...preferences, quickToolsVisible: event.target.checked })} /> Character quick tools</label></fieldset>
    <fieldset><legend>Context widgets and order</legend>{CAMPAIGN_CONTEXT_WIDGETS.map((widget) => { const index = preferences.widgets.indexOf(widget); const enabled = index >= 0; return <div className="widget-preference" key={widget}><label><input type="checkbox" checked={enabled} onChange={(event) => onChange({ ...preferences, widgets: event.target.checked ? [...preferences.widgets, widget] : preferences.widgets.filter((item) => item !== widget) })} /> {widgetLabels[widget]}</label><div className="button-row"><button type="button" className="ghost" aria-label={`Move ${widgetLabels[widget]} earlier`} disabled={!enabled || index === 0} onClick={() => moveWidget(widget, -1)}>Up</button><button type="button" className="ghost" aria-label={`Move ${widgetLabels[widget]} later`} disabled={!enabled || index === preferences.widgets.length - 1} onClick={() => moveWidget(widget, 1)}>Down</button></div></div>; })}</fieldset>
    <button type="button" className="ghost" onClick={() => onChange({ ...DEFAULT_CAMPAIGN_WORKBENCH_PREFERENCES, widgets: [...CAMPAIGN_CONTEXT_WIDGETS] })}>Reset workbench</button>
  </form></dialog>;
}

function ShortcutDialog({ dialogRef }: { dialogRef: React.RefObject<HTMLDialogElement> }) {
  return <dialog ref={dialogRef} className="workbench-dialog shortcut-dialog" aria-labelledby="shortcut-heading"><form method="dialog"><header><div><p className="eyebrow">KEYBOARD MAP</p><h2 id="shortcut-heading">Campaign shortcuts</h2></div><button className="ghost" value="close">Close</button></header><dl>
    <div><dt><kbd>F6</kbd></dt><dd>Move to the next visible workbench pane</dd></div><div><dt><kbd>Shift</kbd> + <kbd>F6</kbd></dt><dd>Move to the previous pane</dd></div><div><dt><kbd>Alt</kbd> + <kbd>1</kbd></dt><dd>Focus campaign context</dd></div><div><dt><kbd>Alt</kbd> + <kbd>2</kbd></dt><dd>Focus narration and action workspace</dd></div><div><dt><kbd>Alt</kbd> + <kbd>3</kbd></dt><dd>Focus character quick tools</dd></div><div><dt><kbd>?</kbd></dt><dd>Open this keyboard map outside text fields</dd></div>
  </dl><p>Splitters use arrow keys, Shift + arrow for larger steps, Home/End for minimum/maximum, and Enter to collapse.</p></form></dialog>;
}

function readSafeState(campaignId: string, sessionId: string): SafeState {
  try {
    const value = JSON.parse(localStorage.getItem(stateKey(campaignId, sessionId)) ?? "null") as Record<string, unknown> | null;
    if (!value || !["idle", "streaming", "awaiting-confirmation", "ambiguous", "terminal"].includes(String(value.streamPhase))) return { streamPhase: "idle" };
    const turnId = typeof value.turnId === "string" && resourceIdSchema.safeParse(value.turnId).success ? value.turnId : undefined;
    const selectedActorId = typeof value.selectedActorId === "string" && resourceIdSchema.safeParse(value.selectedActorId).success ? value.selectedActorId : undefined;
    const resumeToken = typeof value.resumeToken === "string" && adventureTurnResumeTokenSchema.safeParse(value.resumeToken).success ? value.resumeToken : undefined;
    const storedPhase = value.streamPhase as StreamPhase;
    return { streamPhase: storedPhase === "streaming" && !turnId && !resumeToken ? "ambiguous" : storedPhase,
      ...(turnId ? { turnId } : {}), ...(selectedActorId ? { selectedActorId } : {}), ...(resumeToken ? { resumeToken } : {}) };
  } catch { return { streamPhase: "idle" }; }
}

function readPendingInitial(campaignId: string, sessionId: string): PendingInitial | null {
  try {
    const value = JSON.parse(localStorage.getItem(lockKey(campaignId, sessionId)) ?? "null") as Record<string, unknown> | null;
    if (!value || value.campaignId !== campaignId || value.sessionId !== sessionId
      || typeof value.actorId !== "string" || !resourceIdSchema.safeParse(value.actorId).success
      || typeof value.idempotencyKey !== "string" || !idempotencyKeySchema.safeParse(value.idempotencyKey).success) return null;
    return { campaignId, sessionId, actorId: value.actorId, idempotencyKey: value.idempotencyKey };
  } catch { return null; }
}

/** Coordinates bootstrap, exact durable reconciliation, SSE delivery, confirmation, and the accessible play grid. */
export function CampaignPlayPage({ campaignId, sessionId, authorizationGeneration, api, children, onBack, onUnavailable,
  onSelectedActorChange, onTurnIdChange, initialSelectedActorId, initialTurnId, authorizationCanAct = true, focusHeading,
  onNavigate, combatAvailable = false, studioAvailable = false }: CampaignPlayPageProps) {
  if (!authorizationCanAct) {
    try { localStorage.removeItem(stateKey(campaignId, sessionId)); localStorage.removeItem(lockKey(campaignId, sessionId));
      if (initialTurnId) localStorage.removeItem(confirmationKey(initialTurnId)); } catch { /* synchronous authority cleanup is best effort */ }
  }
  const initial = useRef(readSafeState(campaignId, sessionId)).current;
  const [bootstrap, setBootstrap] = useState<CampaignPlayBootstrap | null>(null);
  const [selectedActorId, setSelectedActorId] = useState(initialSelectedActorId ?? initial.selectedActorId ?? "");
  const selectedActorRef = useRef(selectedActorId); selectedActorRef.current = selectedActorId;
  const [turn, setTurn] = useState<AdventureTurnGetResponse | null>(null);
  const turnRef = useRef(turn); turnRef.current = turn;
  const [phase, setPhase] = useState<StreamPhase>(() => readPendingInitial(campaignId, sessionId) ? "ambiguous" : initial.streamPhase);
  const [resumeToken, setResumeToken] = useState(initial.resumeToken);
  const [pendingInitial, setPendingInitial] = useState<PendingInitial | null>(() => readPendingInitial(campaignId, sessionId));
  const [pendingTurnReconciliation, setPendingTurnReconciliation] = useState<PendingTurnReconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<AdventureTurnStreamHandle | null>(null);
  const deliveryTurnIdRef=useRef<string|null>(null);
  const activeRef = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null); const composerRef = useRef<HTMLTextAreaElement>(null);
  const headingFocusedRef = useRef(false);
  const [preferences, setPreferences] = useCampaignWorkbenchPreferences();
  const preferencesDialogRef = useRef<HTMLDialogElement>(null); const shortcutDialogRef = useRef<HTMLDialogElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  const unavailableRef = useRef(onUnavailable); const selectedChangeRef = useRef(onSelectedActorChange); const turnChangeRef = useRef(onTurnIdChange);
  unavailableRef.current = onUnavailable; selectedChangeRef.current = onSelectedActorChange; turnChangeRef.current = onTurnIdChange;

  const persist = useCallback((next: SafeState) => { try { localStorage.setItem(stateKey(campaignId, sessionId), JSON.stringify(next)); } catch { /* server state remains authoritative */ } }, [campaignId, sessionId]);
  const clearLock = useCallback(() => { setPendingInitial(null); try { localStorage.removeItem(lockKey(campaignId, sessionId)); } catch { /* optional */ } }, [campaignId, sessionId]);
  const clearAdventureState = useCallback(() => {
    streamRef.current?.cancelDelivery(); streamRef.current = null;
    if (turnRef.current) try { localStorage.removeItem(confirmationKey(turnRef.current.turn.turnId)); } catch { /* optional */ }
    deliveryTurnIdRef.current = null; setPendingTurnReconciliation(null);
    setTurn(null); setResumeToken(undefined); setPhase("idle"); setSelectedActorId(""); selectedActorRef.current = ""; setError(null); clearLock();
    turnChangeRef.current?.(null); selectedChangeRef.current?.(null);
    try { localStorage.removeItem(stateKey(campaignId, sessionId)); } catch { /* optional */ }
  }, [campaignId, clearLock, sessionId]);

  const refreshBootstrap = useCallback(async (): Promise<CampaignPlayBootstrap> => {
    const value = await api.getCampaignPlayBootstrap(campaignId, sessionId);
    if (!activeRef.current) throw new DOMException("Play page is unavailable", "AbortError");
    const allowed = authorizationCanAct && value.session.adventureEligible && value.session.active && value.principal.role !== "observer" && value.playableActors.length > 0;
    if (!allowed) { setBootstrap(value); clearAdventureState(); return value; }
    const previous = selectedActorRef.current || initialSelectedActorId;
    if (previous && !value.playableActors.some((actor) => actor.actorId === previous)) { setBootstrap(value); clearAdventureState(); return value; }
    const candidate = [selectedActorRef.current, initialSelectedActorId].find((id) => id && value.playableActors.some((actor) => actor.actorId === id));
    const selected = candidate ?? value.playableActors[0]!.actorId;
    setBootstrap(value); setSelectedActorId(selected); selectedActorRef.current = selected; selectedChangeRef.current?.(selected);
    return value;
  }, [api, authorizationCanAct, campaignId, clearAdventureState, initialSelectedActorId, sessionId]);

  const applyReconciled = useCallback(async (value: AdventureTurnGetResponse, allowResumeToken: boolean) => {
    if (!activeRef.current) return;
    setTurn(value); setPendingTurnReconciliation(null); turnChangeRef.current?.(value.turn.turnId); clearLock();
    const token = allowResumeToken ? value.resumeToken : undefined; setResumeToken(token);
    const nextPhase: StreamPhase = value.confirmation.state === "pending" ? "awaiting-confirmation"
      : token ? "ambiguous" : ["completed", "cancelled", "failed"].includes(value.turn.state) ? "terminal" : "ambiguous";
    setPhase(nextPhase); persist({ turnId: value.turn.turnId, selectedActorId: value.turn.actorId, ...(token ? { resumeToken: token } : {}), streamPhase: nextPhase });
    await refreshBootstrap().catch(() => undefined);
  }, [clearLock, persist, refreshBootstrap]);

  const reconcile = useCallback(async (turnId: string, actorId: string, allowResumeToken = true, priorTurnId?: string | null) => {
    const value = await api.getAdventureTurn(turnId, { campaignId, sessionId, actorId, turnId, ...(priorTurnId !== undefined ? { priorTurnId } : {}) });
    await applyReconciled(value, allowResumeToken); return value;
  }, [api, applyReconciled, campaignId, sessionId]);
  const reconcileKnownTurn = useCallback(async (locator: PendingTurnReconciliation) => {
    setError(null);
    try { await reconcile(locator.turnId, locator.actorId, locator.allowResumeToken, locator.priorTurnId); }
    catch { setPhase("ambiguous"); setError("The turn could not be reconciled authoritatively. Try again before continuing."); }
  }, [reconcile]);

  useEffect(() => {
    activeRef.current = true; setBootstrap(null); setTurn(null); setResumeToken(undefined); setError(null);
    streamRef.current?.cancelDelivery(); streamRef.current = null;
    void refreshBootstrap().catch(() => { if (activeRef.current) { clearAdventureState(); unavailableRef.current(); } });
    return () => { activeRef.current = false; streamRef.current?.cancelDelivery(); streamRef.current = null; };
  }, [authorizationGeneration, clearAdventureState, refreshBootstrap]);
  useEffect(() => { if (focusHeading && bootstrap && !headingFocusedRef.current) { headingFocusedRef.current = true; headingRef.current?.focus(); } }, [bootstrap, focusHeading]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target; const editing = target instanceof Element && target.matches("input, textarea, select, [contenteditable=true]");
      if (event.key === "?" && !editing && !event.altKey && !event.ctrlKey && !event.metaKey) { event.preventDefault(); shortcutDialogRef.current?.showModal(); return; }
      const panes = [preferences.contextVisible ? document.getElementById("campaign-context-panel") : null, centerRef.current,
        preferences.quickToolsVisible ? document.getElementById("campaign-quick-tools") : null].filter((pane): pane is HTMLElement => pane !== null);
      if (event.key === "F6" && panes.length) { event.preventDefault(); const current = panes.findIndex((pane) => pane === document.activeElement || pane.contains(document.activeElement)); const next = (current + (event.shiftKey ? panes.length - 1 : 1)) % panes.length; panes[next]?.focus(); return; }
      if (event.altKey && ["1", "2", "3"].includes(event.key)) { const pane = [document.getElementById("campaign-context-panel"), centerRef.current, document.getElementById("campaign-quick-tools")][Number(event.key) - 1]; if (pane) { event.preventDefault(); pane.focus(); } }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  }, [preferences.contextVisible, preferences.quickToolsVisible]);

  const initialReconciledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bootstrap || !selectedActorId || bootstrap.principal.role === "observer") return;
    const candidate = initialTurnId ?? initial.turnId; if (!candidate || initialReconciledRef.current === candidate) return;
    initialReconciledRef.current = candidate;
    void reconcile(candidate, selectedActorId).catch(() => {
      if (!activeRef.current) return; setTurn(null); setResumeToken(undefined); setPhase(pendingInitial ? "ambiguous" : "idle");
      turnChangeRef.current?.(null); try { localStorage.removeItem(stateKey(campaignId, sessionId)); } catch { /* optional */ }
      setError("The saved turn did not match this campaign room and actor, so its locator was removed.");
    });
  }, [bootstrap, campaignId, initial.turnId, initialTurnId, pendingInitial, reconcile, selectedActorId, sessionId]);

  const receive = useCallback((event: AdventureTurnStreamEvent) => {
    if (!activeRef.current) return;
    if (event.type === "turn_started") {
      const id = event.payload.turn.turnId;deliveryTurnIdRef.current=id; clearLock(); setPhase("streaming"); turnChangeRef.current?.(id);
      persist({ turnId: id, selectedActorId: event.payload.turn.actorId, streamPhase: "streaming" });
    }
    if (event.type === "confirmation_required") setPhase("awaiting-confirmation");
    if (event.type === "terminal") {
      setResumeToken(undefined);
      const locator = { turnId: event.payload.turn.turnId, actorId: event.payload.turn.actorId,
        allowResumeToken: false, priorTurnId: event.payload.turn.priorTurnId };
      setPendingTurnReconciliation(locator); void reconcileKnownTurn(locator);
    }
  }, [clearLock, persist, reconcileKnownTurn]);

  const openStream = useCallback((request: PlayStreamRequest) => {
    deliveryTurnIdRef.current = null;
    setError(null); setPhase("streaming"); const handle = api.streamAdventureTurn(request, receive); streamRef.current = handle;
    let knownTurnId: string | null = request.kind === "resume" ? request.expected.turnId ?? null : null;
    void handle.turnId.then((turnId) => { knownTurnId = turnId; if (!activeRef.current) return; turnChangeRef.current?.(turnId);
      deliveryTurnIdRef.current=turnId;
      const actorId = request.kind === "resume" ? request.expected.actorId : request.actorId;
      persist({ turnId, selectedActorId: actorId, ...(request.kind === "resume" ? { resumeToken: request.resumeToken } : {}), streamPhase: "streaming" });
    }).catch(() => undefined);
    void handle.done.catch(async (failure: unknown) => {
      if (!activeRef.current || (failure instanceof Error && failure.name === "AbortError")) return;
      const actorId = request.kind === "resume" ? request.expected.actorId : request.actorId;
      if (knownTurnId) {
        const prior = request.kind === "resume" ? request.expected.priorTurnId : request.kind === "initial" ? null : request.priorTurnId;
        const locator = { turnId: knownTurnId, actorId, allowResumeToken: request.kind === "resume", priorTurnId: prior };
        setPendingTurnReconciliation(locator);
        await reconcileKnownTurn(locator);
        return;
      }
      if (request.kind === "initial" && failure instanceof ApiError && failure.status >= 400 && failure.status < 500) {
        clearLock(); setPhase("idle"); await refreshBootstrap().catch(() => undefined);
        setError(failure.status === 409 ? "Campaign state changed. Latest play state is loaded; submit the declaration again explicitly."
          : "The declaration was rejected before a turn was committed. Correct it and submit explicitly."); return;
      }
      setPhase("ambiguous"); setError(request.kind === "initial"
        ? "No turn identity was received. Use authoritative reconciliation; the declaration will not be replayed."
        : "No derivative turn identity was received. The narration request will not be replayed automatically.");
    }).finally(() => { if (streamRef.current === handle) streamRef.current = null; });
  }, [api, clearLock, persist, receive, reconcileKnownTurn, refreshBootstrap]);
  const cancelLiveDelivery=useCallback(()=>{const handle=streamRef.current;if(!handle)return;handle.cancelDelivery();streamRef.current=null;setPhase("ambiguous");
    const id=deliveryTurnIdRef.current,actor=selectedActorRef.current;if(id&&actor){const locator={turnId:id,actorId:actor,allowResumeToken:true};setPendingTurnReconciliation(locator);void reconcileKnownTurn(locator);}
    else setError("Live delivery stopped before the turn locator arrived. Reconcile the submitted declaration before continuing.");},[reconcileKnownTurn]);

  const resumedTokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!bootstrap || !resumeToken || !turn || bootstrap.principal.role === "observer" || resumedTokenRef.current === resumeToken) return;
    resumedTokenRef.current = resumeToken;
    openStream({ kind: "resume", resumeToken, expected: { campaignId, sessionId, actorId: turn.turn.actorId, turnId: turn.turn.turnId,
      priorTurnId: turn.turn.priorTurnId } });
  }, [bootstrap, campaignId, openStream, resumeToken, sessionId, turn]);

  async function submit(declaration: string) {
    if (!selectedActorId || phase === "streaming" || phase === "ambiguous" || phase === "awaiting-confirmation") return;
    setPhase("streaming");
    try {
      const latest = await refreshBootstrap();
      if (!latest.playableActors.some((actor) => actor.actorId === selectedActorRef.current) || latest.principal.role === "observer") { clearAdventureState(); return; }
      if (readPendingInitial(campaignId, sessionId)) { setPendingInitial(readPendingInitial(campaignId, sessionId)); setPhase("ambiguous");
        setError("A prior declaration is locked until its exact durable key is reconciled."); return; }
      const key = idempotency(); const locator = { campaignId, sessionId, actorId: selectedActorRef.current, idempotencyKey: key };
      setResumeToken(undefined); resumedTokenRef.current = null; setPendingInitial(locator);
      try { localStorage.setItem(lockKey(campaignId, sessionId), JSON.stringify(locator)); } catch { /* in-memory lock remains */ }
      openStream({ kind: "initial", ...locator, declaration, expectedRevision: latest.expectedRevision });
    } catch { setPhase("idle"); setError("Latest campaign play state could not be loaded. Nothing was submitted."); }
  }

  async function reconcilePendingInitial() {
    const locator = pendingInitial ?? readPendingInitial(campaignId, sessionId); if (!locator || phase === "streaming") return;
    setError(null);
    try {
      const found = await api.reconcileInitialAdventureTurn(locator);
      if (!found) { setPhase("ambiguous"); setError("No committed turn is visible for this exact key. A race is still possible; the declaration remains locked and will not be replayed.");
        await refreshBootstrap().catch(() => undefined); return; }
      await applyReconciled(found, true);
    } catch { setPhase("ambiguous"); setError("Authoritative initial-turn reconciliation is unavailable. The declaration remains locked."); }
  }

  async function narrateVariant(kind: "narration-retry" | "narration-swipe") {
    if (!turn || !["completed", "cancelled", "failed"].includes(turn.turn.state) || phase === "streaming" || !selectedActorId) return;
    setPhase("streaming");
    try {
      const latest = await refreshBootstrap();
      openStream({ kind, campaignId, sessionId, actorId: selectedActorId, priorTurnId: turn.turn.turnId,
        expectedRevision: latest.expectedRevision, idempotencyKey: idempotency() });
    } catch { setPhase("terminal"); setError("Latest play state could not be loaded. No narration variant was submitted."); }
  }

  const setActor = (actorId: string) => { if (!bootstrap?.playableActors.some((actor) => actor.actorId === actorId)) return;
    setSelectedActorId(actorId); selectedActorRef.current = actorId; selectedChangeRef.current?.(actorId);
    persist({ ...(turn ? { turnId: turn.turn.turnId } : {}), selectedActorId: actorId, ...(resumeToken ? { resumeToken } : {}), streamPhase: phase }); };
  const pending = turn?.confirmation.state === "pending" ? turn.confirmation : null;
  const confirmationApi = useMemo(() => ({ confirmAdventureTurn: api.confirmAdventureTurn, getAdventureTurn: api.getAdventureTurn }), [api]);
  const activeBinding = turn ? { campaignId, sessionId, actorId: turn.turn.actorId, turnId: turn.turn.turnId, priorTurnId: turn.turn.priorTurnId } : null;
  if (!bootstrap) return <main className="campaign-play-page"><p role="status">Opening campaign play…</p></main>;
  const actionable = authorizationCanAct && bootstrap.session.adventureEligible && bootstrap.session.active
    && bootstrap.principal.role !== "observer" && bootstrap.playableActors.length > 0;
  const audience = bootstrap.principal.role === "owner" || bootstrap.principal.role === "gm" ? "gm" : "player";
  const playBlocker = !authorizationCanAct || bootstrap.principal.role === "observer" ? "Observer access is read-only."
    : !bootstrap.session.active ? "This attached room has stopped and is read-only."
      : !bootstrap.session.adventureEligible ? "Adventure turns are unavailable. Publish the campaign and use an attached active room with a finalized participating character."
        : bootstrap.playableActors.length === 0 ? "No controlled actor is available in this room. Review character finalization, room participants, and campaign control." : null;
  const navigate = (destination: Parameters<NonNullable<CampaignPlayPageProps["onNavigate"]>>[0]) => onNavigate?.(destination);
  const gridStyle = { "--campaign-context-width": `${preferences.contextWidth}px`, "--campaign-quick-width": `${preferences.quickToolsWidth}px` } as CSSProperties;
  return <main className="campaign-play-page"><header className="campaign-play-header"><div><button className="back-link" onClick={onBack}>← Back to campaign</button><p className="eyebrow">CAMPAIGN COMMAND CENTER</p><h1 ref={headingRef} tabIndex={-1}>Adventure room</h1></div>
    <div className="campaign-play-status"><span>{bootstrap.playableActors.find((actor) => actor.actorId === selectedActorId)?.name ?? "No acting character"}</span><p className="play-phase" role="status">{phase.replace("-", " ")}</p><small>Campaign revision {bootstrap.expectedRevision}</small></div></header>
    <nav className="campaign-play-nav" aria-label="Campaign command navigation"><button className="ghost" onClick={() => navigate("campaign")}>Campaign</button>{combatAvailable && <button className="ghost" onClick={() => navigate("combat")}>Combat</button>}{studioAvailable && <><button className="ghost" onClick={() => navigate("world")}>World</button><button className="ghost" onClick={() => navigate("cast")}>Cast</button><button className="ghost" onClick={() => navigate("quests")}>Quests</button><button className="ghost" onClick={() => navigate("story")}>Story</button></>}<button className="ghost" onClick={() => navigate("history")}>History</button>{audience === "gm" && <button className="ghost" onClick={() => navigate("administration")}>GM tools</button>}<span className="campaign-nav-spacer" /><button className="ghost" aria-label="Campaign workbench preferences" onClick={() => preferencesDialogRef.current?.showModal()}>Display</button><button className="ghost" aria-label="Campaign keyboard shortcuts" onClick={() => shortcutDialogRef.current?.showModal()}>Shortcuts</button></nav>
    {error && <p className="play-error" role="alert">{error}</p>}
    {playBlocker && <section className="play-prerequisite" role="status"><div><p className="eyebrow">PLAY READINESS</p><h2>Action declaration unavailable</h2></div><p>{playBlocker}</p><button className="ghost" onClick={() => navigate("campaign")}>Review campaign readiness</button></section>}
    {pendingInitial && phase === "ambiguous" && actionable && <div className="play-reconcile"><p>A submitted declaration has no confirmed turn identity.</p><button className="primary" onClick={() => void reconcilePendingInitial()}>Reconcile submitted declaration</button></div>}
    {pendingTurnReconciliation && phase === "ambiguous" && actionable && <div className="play-reconcile"><p>A known turn needs authoritative reconciliation.</p><button className="primary" onClick={() => void reconcileKnownTurn(pendingTurnReconciliation)}>Reconcile known turn</button></div>}
    <div className={`campaign-play-grid ${preferences.contextVisible ? "has-context" : ""} ${preferences.quickToolsVisible ? "has-quick-tools" : ""}`} style={gridStyle}>
      {preferences.contextVisible && <><CampaignContextDrawer key={`${authorizationGeneration}:${audience}`} campaignId={campaignId} sessionId={sessionId} selectedActorId={selectedActorId || null} playableActorIds={bootstrap.playableActors.map((actor) => actor.actorId)} audience={audience} authorizationGeneration={authorizationGeneration} api={api} widgets={preferences.widgets} /><PanelSeparator side="left" value={preferences.contextWidth} controls="campaign-context-panel" label="Resize campaign context" onChange={(contextWidth) => setPreferences({ ...preferences, contextWidth })} onCollapse={() => setPreferences({ ...preferences, contextVisible: false })} /></>}
      <section ref={centerRef} tabIndex={-1} className="campaign-play-center" aria-label="Campaign narration and actions">{actionable && <AdventureActionComposer actors={bootstrap.playableActors} selectedActorId={selectedActorId} role={bootstrap.principal.role} eligible={bootstrap.session.adventureEligible} inactive={!bootstrap.session.active}
          phase={phase === "streaming" || phase === "awaiting-confirmation" ? "inflight" : phase === "ambiguous" ? "ambiguous" : "ready"} onActorChange={setActor} onSubmit={(declaration) => void submit(declaration)} composerRef={composerRef} />}
        <div className="embedded-room-chat">{children}</div>
        {turn?.narrationStatus.text && <article className="adventure-narration"><h2>Adventure narration</h2><p>{turn.narrationStatus.text}</p>{turn.receipts.length === 0 && <p className="no-tools-label">No mechanics were needed. {turn.narrationStatus.source === "provider-assisted" ? "The scene was narrated from public campaign context." : "Provider narration failed, so a deterministic fallback is shown."}</p>}</article>}
        {actionable && pending && activeBinding && <ConfirmationBanner turnId={turn!.turn.turnId} revision={turn!.turn.revision} proposals={turn!.proposals} proposalIds={pending.proposalIds} expiresAt={pending.expiresAt} binding={activeBinding} api={confirmationApi} restoreFocusRef={composerRef}
          onReconciled={(value, token) => { void applyReconciled({ ...value, ...(token ? { resumeToken: token } : {}) }, true); }} />}
        {turn && <MechanicReceiptCard campaignId={campaignId} links={turn.receipts} api={api} />}
        {actionable && turn && ["completed", "cancelled", "failed"].includes(turn.turn.state) && <div className="adventure-variant-controls" aria-label="Adventure narration alternatives">
          <button className="ghost" disabled={phase === "streaming"} onClick={() => void narrateVariant("narration-swipe")}>Swipe narration</button>
          <button className="ghost" disabled={phase === "streaming"} onClick={() => void narrateVariant("narration-retry")}>Retry narration</button></div>}
      </section>
      {preferences.quickToolsVisible && <><PanelSeparator side="right" value={preferences.quickToolsWidth} controls="campaign-quick-tools" label="Resize character quick tools" onChange={(quickToolsWidth) => setPreferences({ ...preferences, quickToolsWidth })} onCollapse={() => setPreferences({ ...preferences, quickToolsVisible: false })} /><CampaignQuickPanel campaignId={campaignId} selectedActorId={selectedActorId || null} actors={bootstrap.playableActors} api={api} /></>}
    </div>
    {actionable && streamRef.current && <button className="ghost cancel-delivery" onClick={cancelLiveDelivery}>Stop receiving live updates</button>}
    <WorkbenchPreferencesDialog dialogRef={preferencesDialogRef} preferences={preferences} onChange={setPreferences} /><ShortcutDialog dialogRef={shortcutDialogRef} />
  </main>;
}
