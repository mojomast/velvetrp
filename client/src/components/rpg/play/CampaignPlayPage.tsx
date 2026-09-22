import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adventureTurnResumeTokenSchema, idempotencyKeySchema, resourceIdSchema } from "@velvet/contracts";
import type { AdventureTurnConfirmRequest, AdventureTurnGetResponse, AdventureTurnInitialReconcileRequest,
  AdventureTurnStreamEvent, AdventureTurnTranscriptEntry, AdventureTurnTranscriptResponse, ActorGameplaySheetResponse, CampaignDiceHistoryResponse, CampaignDiceRollRequest, CampaignDiceRollResponse, CampaignPlayBootstrap } from "@velvet/contracts";
import type { AdventureTurnClientBinding, ChatMessage } from "../../../api";
import { ApiError } from "../../../api";
import { AdventureActionComposer } from "./AdventureActionComposer";
import { CampaignContextDrawer, type CampaignContextDrawerApi } from "./CampaignContextDrawer";
import { ConfirmationBanner } from "./ConfirmationBanner";
import { MechanicReceiptCard, type MechanicReceiptApi } from "./MechanicReceiptCard";
import { CampaignConversation } from "./CampaignConversation";
import { GameplaySheetDrawer } from "./GameplaySheetDrawer";
import { CampaignDicePanel } from "./CampaignDicePanel";
import { SessionControls, type SessionCommandApi } from "../session/SessionControls";
import { createClientId } from "../../../utils/clientId";
import { AtlasDrawer, PlaySurface, type AtlasTool } from "./PlaySurface";
import { campaignDestinations, type CampaignDestination } from "../shell/CampaignShell";
import { CommandCenter } from "./CommandCenter";
import { VoiceControls } from "../../../voice/VoiceControls";
import { CampaignQuickPanel } from "./CampaignQuickPanel";
import { useCampaignWorkbenchPreferences } from "./campaignWorkbenchPreferences";
import { PlayHelp } from "./PlayHelp";
import { CampaignSecurityPanels } from "../administration/CampaignSecurityPanels";
import { CampaignCharacterCreator } from "./CampaignCharacterCreator";
import type { CharacterBuilderApi } from "../character/CharacterBuilderPage";
import { CombatTrackerPage, type CombatTrackerApi } from "../combat/CombatTrackerPage";
import { WorldExplorerPage, type WorldExplorerApi } from "../world/WorldExplorerPage";
import { RpgCharacterSheetPage, type RpgCharacterSheetApi } from "../actor/RpgCharacterSheetPage";
import type { StudioAuthorization } from "../StudioAuthorization";
import { AtlasAdvancement, type AtlasAdvancementApi } from "./AtlasAdvancement";
import { CampaignDmPanel, CampaignDmChronicle, type CampaignDmApi } from "./CampaignDmPanel";
import { CampaignReplay } from "./CampaignReplay";
import { SituationActions } from "./SituationActions";
import { SceneIllustration, SceneImageDmPanel } from "./SceneImagePanel";
import type { SceneImageApi } from "../../../api";
import type { CampaignDmHistory } from "@velvet/contracts";

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
export interface CampaignPlayApi extends CampaignContextDrawerApi, MechanicReceiptApi, SessionCommandApi {
  dm: CampaignDmApi;
  getCampaignPlayBootstrap: (campaignId: string, sessionId: string) => Promise<CampaignPlayBootstrap>;
  streamAdventureTurn: (request: PlayStreamRequest, onEvent: (event: AdventureTurnStreamEvent) => void) => AdventureTurnStreamHandle;
  getAdventureTurn: (turnId: string, expected: AdventureTurnClientBinding) => Promise<AdventureTurnGetResponse>;
  getAdventureTurnTranscript: (campaignId: string, sessionId: string) => Promise<AdventureTurnTranscriptResponse>;
  reconcileInitialAdventureTurn: (input: AdventureTurnInitialReconcileRequest) => Promise<AdventureTurnGetResponse | null>;
  confirmAdventureTurn: (turnId: string, input: AdventureTurnConfirmRequest, expected: AdventureTurnClientBinding) => Promise<{ turn: AdventureTurnGetResponse["turn"]; resumeToken?: string }>;
  getActorGameplaySheet: (actorId: string) => Promise<ActorGameplaySheetResponse>;
  getCampaignDiceHistory?: (campaignId: string) => Promise<CampaignDiceHistoryResponse>;
  rollCampaignDice?: (campaignId: string, input: CampaignDiceRollRequest) => Promise<CampaignDiceRollResponse>;
}

/** Props for the authoritative campaign play layout. */
export interface CampaignPlayPageProps {
  campaignId: string;
  sessionId: string;
  authorizationGeneration: number;
  api: CampaignPlayApi;
  legacyMessages?: readonly ChatMessage[];
  legacyParticipants?: readonly { id: string; name: string }[];
  onBack: () => void;
  onUnavailable: () => void;
  onSelectedActorChange?: (actorId: string | null) => void;
  onTurnIdChange?: (turnId: string | null) => void;
  initialSelectedActorId?: string;
  initialTurnId?: string;
  authorizationCanAct?: boolean;
  focusHeading?: boolean;
  onNavigate?: (destination: CampaignDestination) => void;
  combatAvailable?: boolean;
  combatApi?: CombatTrackerApi;
  worldApi?: WorldExplorerApi;
  actorToolsApi?: RpgCharacterSheetApi;
  advancementApi?: AtlasAdvancementApi;
  characterBuilderApi?: CharacterBuilderApi;
  authorization?: StudioAuthorization;
  studioAvailable?: boolean;
  onOpenCombat?: () => void;
  /** Room presentation: the one-screen command center or the living atlas. */
  surface?: "center" | "atlas";
  /** Feature discovery for scene images; both the illustration and DM panel need it. */
  imagesEnabled?: boolean;
  sceneImageApi?: SceneImageApi;
}

type StreamPhase = "idle" | "streaming" | "awaiting-confirmation" | "ambiguous" | "terminal";
type SafeState = { turnId?: string; selectedActorId?: string; resumeToken?: string; streamPhase: StreamPhase };
type PendingInitial = { campaignId: string; sessionId: string; actorId: string; idempotencyKey: string };
type PendingTurnReconciliation = { turnId: string; actorId: string; allowResumeToken: boolean; priorTurnId?: string | null };
type GameplaySheetState = { kind: "closed" } | { kind: "loading"; actorId: string }
  | { kind: "ready"; actorId: string; sheet: ActorGameplaySheetResponse } | { kind: "error"; actorId: string; message: string };
const stateKey = (campaignId: string, sessionId: string) => `velvet.campaign-play.v1:${campaignId}:${sessionId}`;
const lockKey = (campaignId: string, sessionId: string) => `velvet.campaign-play-submit.v1:${campaignId}:${sessionId}`;
const confirmationKey = (turnId: string) => `velvet.adventure-confirm.v1:${turnId}`;
const idempotency = createClientId;

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

/** Coordinates durable play independently of the atlas presentation and tool drawers. */
export function CampaignPlayPage({ campaignId, sessionId, authorizationGeneration, api, legacyMessages = [], legacyParticipants = [], onBack, onUnavailable,
  onSelectedActorChange, onTurnIdChange, initialSelectedActorId, initialTurnId, authorizationCanAct = true, focusHeading,
  combatAvailable = false, combatApi, worldApi, actorToolsApi, advancementApi, characterBuilderApi, authorization, onNavigate, surface = "center",
  imagesEnabled = false, sceneImageApi }: CampaignPlayPageProps) {
  if (!authorizationCanAct) {
    try { localStorage.removeItem(stateKey(campaignId, sessionId)); localStorage.removeItem(lockKey(campaignId, sessionId));
      if (initialTurnId) localStorage.removeItem(confirmationKey(initialTurnId)); } catch { /* synchronous authority cleanup is best effort */ }
  }
  const initial = useRef(readSafeState(campaignId, sessionId)).current;
  const [bootstrap, setBootstrap] = useState<CampaignPlayBootstrap | null>(null);
  const [sessionLocked, setSessionLocked] = useState(false);
  const [dmLocked, setDmLocked] = useState(false);
  const [dmHistory, setDmHistory] = useState<CampaignDmHistory | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  useEffect(() => { if (!authorizationCanAct || (bootstrap && !["owner", "gm"].includes(bootstrap.principal.role))) setSessionLocked(false); }, [authorizationCanAct, bootstrap]);
  const [activeTool, setActiveTool] = useState<AtlasTool | null>(null);
  const [visitedTools, setVisitedTools] = useState<AtlasTool[]>([]);
  const [activeScene, setActiveScene] = useState<{ sceneKey: string; label: string } | null>(null);
  const resolveScene = useCallback((scene: { sceneKey: string; label: string } | null) => {
    setActiveScene((current) => current?.sceneKey === scene?.sceneKey && current?.label === scene?.label ? current : scene);
  }, []);
  const toolOriginRef = useRef<HTMLElement | null>(null);
  const [combatLocked, setCombatLocked] = useState(false);
  const [travelLocked, setTravelLocked] = useState(false);
  const [inventoryLocked, setInventoryLocked] = useState(false);
  const [advancementLocked, setAdvancementLocked] = useState(false);
  const roomToolsLocked = dmLocked || combatLocked || travelLocked || inventoryLocked || advancementLocked;
  const [selectedActorId, setSelectedActorId] = useState(initialSelectedActorId ?? initial.selectedActorId ?? "");
  const selectedActorRef = useRef(selectedActorId); selectedActorRef.current = selectedActorId;
  const [turn, setTurn] = useState<AdventureTurnGetResponse | null>(null);
  const turnRef = useRef(turn); turnRef.current = turn;
  const [phase, setPhase] = useState<StreamPhase>(() => readPendingInitial(campaignId, sessionId) ? "ambiguous" : initial.streamPhase);
  const [resumeToken, setResumeToken] = useState(initial.resumeToken);
  const [pendingInitial, setPendingInitial] = useState<PendingInitial | null>(() => readPendingInitial(campaignId, sessionId));
  const [pendingTurnReconciliation, setPendingTurnReconciliation] = useState<PendingTurnReconciliation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<AdventureTurnTranscriptEntry[]>([]);
  const [transcriptState, setTranscriptState] = useState<"loading" | "ready" | "error">("loading");
  const [liveEvents, setLiveEvents] = useState<AdventureTurnStreamEvent[]>([]);
  const [declaration, setDeclaration] = useState("");
  const [pendingPrefill, setPendingPrefill] = useState<string | null>(null);
  const [preferences, onPreferences] = useCampaignWorkbenchPreferences();
  const [reconciliationRevision, setReconciliationRevision] = useState(0);
  const [liveRefreshRevision, setLiveRefreshRevision] = useState(0);
  const streamRef = useRef<AdventureTurnStreamHandle | null>(null);
  const deliveryTurnIdRef=useRef<string|null>(null);
  const activeRef = useRef(true);
  const headingRef = useRef<HTMLHeadingElement>(null); const composerRef = useRef<HTMLTextAreaElement>(null);
  const headingFocusedRef = useRef(false);
  const [sheetState, setSheetState] = useState<GameplaySheetState>({ kind: "closed" });
  const sheetRequestRef = useRef(0); const sheetCloseRef = useRef<HTMLButtonElement>(null);
  const unavailableRef = useRef(onUnavailable); const selectedChangeRef = useRef(onSelectedActorChange); const turnChangeRef = useRef(onTurnIdChange);
  const bootstrapReadRef = useRef(0); const transcriptReadRef = useRef(0); const liveReadRef = useRef(false);
  unavailableRef.current = onUnavailable; selectedChangeRef.current = onSelectedActorChange; turnChangeRef.current = onTurnIdChange;

  const persist = useCallback((next: SafeState) => { try { localStorage.setItem(stateKey(campaignId, sessionId), JSON.stringify(next)); } catch { /* server state remains authoritative */ } }, [campaignId, sessionId]);
  const clearLock = useCallback(() => { setPendingInitial(null); try { localStorage.removeItem(lockKey(campaignId, sessionId)); } catch { /* optional */ } }, [campaignId, sessionId]);
  const clearAdventureState = useCallback(() => {
    streamRef.current?.cancelDelivery(); streamRef.current = null;
    if (turnRef.current) try { localStorage.removeItem(confirmationKey(turnRef.current.turn.turnId)); } catch { /* optional */ }
    deliveryTurnIdRef.current = null; setPendingTurnReconciliation(null);
    sheetRequestRef.current += 1; setSheetState({ kind: "closed" });
    setActiveTool((tool) => tool === "character" ? null : tool);
    setTurn(null); setResumeToken(undefined); setPhase("idle"); setSelectedActorId(""); selectedActorRef.current = ""; setError(null); clearLock();
    turnChangeRef.current?.(null); selectedChangeRef.current?.(null);
    try { localStorage.removeItem(stateKey(campaignId, sessionId)); } catch { /* optional */ }
  }, [campaignId, clearLock, sessionId]);

  const refreshBootstrap = useCallback(async (): Promise<CampaignPlayBootstrap> => {
    const request = ++bootstrapReadRef.current;
    let value: CampaignPlayBootstrap;
    try {
      value = await api.getCampaignPlayBootstrap(campaignId, sessionId);
    } catch (failure) {
      if (!activeRef.current || request !== bootstrapReadRef.current) throw new DOMException("Play page read was superseded", "AbortError");
      throw failure;
    }
    if (!activeRef.current || request !== bootstrapReadRef.current) throw new DOMException("Play page read was superseded", "AbortError");
    const allowed = authorizationCanAct && value.session.adventureEligible && value.session.active && value.principal.role !== "observer" && value.playableActors.length > 0;
    if (!allowed) { setBootstrap(value); clearAdventureState(); return value; }
    const previous = selectedActorRef.current || initialSelectedActorId;
    if (previous && !value.playableActors.some((actor) => actor.actorId === previous)) { setBootstrap(value); clearAdventureState(); return value; }
    const candidate = [selectedActorRef.current, initialSelectedActorId].find((id) => id && value.playableActors.some((actor) => actor.actorId === id));
    const selected = candidate ?? value.playableActors[0]!.actorId;
    setBootstrap(value); setSelectedActorId(selected); selectedActorRef.current = selected; selectedChangeRef.current?.(selected);
    return value;
  }, [api, authorizationCanAct, campaignId, clearAdventureState, initialSelectedActorId, sessionId]);

  const refreshTranscript = useCallback(async (showLoading = true) => {
    const request = ++transcriptReadRef.current;
    if (showLoading) setTranscriptState("loading");
    try {
      const value = await api.getAdventureTurnTranscript(campaignId, sessionId);
      if (!activeRef.current || request !== transcriptReadRef.current) return;
      setTranscript(value.turns); setTranscriptState("ready");
    } catch {
      if (activeRef.current && request === transcriptReadRef.current) setTranscriptState("error");
    }
  }, [api, campaignId, sessionId]);
  const refreshAfterTool = useCallback(() => {
    setReconciliationRevision((value) => value + 1);
    void refreshBootstrap().catch(() => { if (activeRef.current) setError("The command tool changed state, but room refresh failed. Refresh before continuing."); });
  }, [refreshBootstrap]);
  const authorizeActorTool = useCallback(async () => {
    const latestAuthorization = await authorization?.reauthorize();
    const latest = await refreshBootstrap();
    return activeRef.current && authorizationCanAct && latestAuthorization?.role !== "observer" && latest.principal.role !== "observer"
      && latest.session.active && latest.playableActors.some((actor) => actor.actorId === selectedActorRef.current);
  }, [authorization, authorizationCanAct, refreshBootstrap]);

  const applyReconciled = useCallback(async (value: AdventureTurnGetResponse, allowResumeToken: boolean) => {
    if (!activeRef.current) return;
    setTurn(value); setPendingTurnReconciliation(null); turnChangeRef.current?.(value.turn.turnId); clearLock();
    const token = allowResumeToken ? value.resumeToken : undefined; setResumeToken(token);
    const nextPhase: StreamPhase = value.confirmation.state === "pending" ? "awaiting-confirmation"
      : token ? "ambiguous" : ["completed", "cancelled", "failed"].includes(value.turn.state) ? "terminal" : "ambiguous";
    setPhase(nextPhase); persist({ turnId: value.turn.turnId, selectedActorId: value.turn.actorId, ...(token ? { resumeToken: token } : {}), streamPhase: nextPhase });
    await Promise.all([refreshBootstrap().catch(() => undefined), refreshTranscript()]);
    if (activeRef.current) setReconciliationRevision((revision) => revision + 1);
  }, [clearLock, persist, refreshBootstrap, refreshTranscript]);

  const reconcile = useCallback(async (turnId: string, actorId: string, allowResumeToken = true, priorTurnId?: string | null) => {
    const value = await api.getAdventureTurn(turnId, { campaignId, sessionId, actorId, turnId, ...(priorTurnId !== undefined ? { priorTurnId } : {}) });
    await applyReconciled(value, allowResumeToken); return value;
  }, [api, applyReconciled, campaignId, sessionId]);
  const reconcileKnownTurn = useCallback(async (locator: PendingTurnReconciliation) => {
    setError(null);
    try { await reconcile(locator.turnId, locator.actorId, locator.allowResumeToken, locator.priorTurnId); }
    catch { setPhase("ambiguous"); setError("The turn could not be reconciled authoritatively. Try again before continuing."); }
  }, [reconcile]);

  const loadBootstrap = useCallback(async () => {
    setBootstrapError(null);
    try { await refreshBootstrap(); }
    catch (failure) {
      const aborted = typeof failure === "object" && failure !== null && "name" in failure && (failure as { name?: unknown }).name === "AbortError";
      if (!activeRef.current || aborted) return;
      // A transient read failure keeps the recovery locator so the user can reconnect or check what happened.
      if ((failure instanceof ApiError && failure.status >= 500) || failure instanceof TypeError) {
        setBootstrapError("Couldn't reach the adventure room. Your place and any unresolved action are preserved; retry when the connection returns.");
        return;
      }
      clearAdventureState(); unavailableRef.current();
    }
  }, [clearAdventureState, refreshBootstrap]);

  useEffect(() => {
    activeRef.current = true; setBootstrap(null); setTurn(null); setResumeToken(undefined); setError(null); setBootstrapError(null); setLiveEvents([]); setTranscript([]); setTranscriptState("loading");
    streamRef.current?.cancelDelivery(); streamRef.current = null;
    void loadBootstrap();
    void refreshTranscript();
    return () => { activeRef.current = false; bootstrapReadRef.current += 1; transcriptReadRef.current += 1; streamRef.current?.cancelDelivery(); streamRef.current = null; };
  }, [authorizationGeneration, clearAdventureState, loadBootstrap, refreshBootstrap, refreshTranscript]);
  useEffect(() => {
    let timer: number | undefined;
    const refreshReads = async () => {
      if (document.visibilityState === "hidden" || liveReadRef.current) return;
      liveReadRef.current = true;
      await Promise.allSettled([refreshBootstrap(), refreshTranscript(false)]);
      if (activeRef.current) setLiveRefreshRevision((value) => value + 1);
      liveReadRef.current = false;
    };
    const schedule = () => { if (timer !== undefined) window.clearInterval(timer); timer = undefined;
      if (document.visibilityState !== "hidden") timer = window.setInterval(() => void refreshReads(), 30_000); };
    const focus = () => void refreshReads();
    const visibility = () => { schedule(); if (document.visibilityState !== "hidden") void refreshReads(); };
    window.addEventListener("focus", focus); document.addEventListener("visibilitychange", visibility); schedule();
    return () => { if (timer !== undefined) window.clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", visibility); liveReadRef.current = false; };
  }, [refreshBootstrap, refreshTranscript]);
  useEffect(() => { if (focusHeading && bootstrap && !headingFocusedRef.current) { headingFocusedRef.current = true; headingRef.current?.focus(); } }, [bootstrap, focusHeading]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activeTool && !document.querySelector("dialog[open]")) { event.preventDefault(); closeTool(); }
    };
    window.addEventListener("keydown", keydown); return () => window.removeEventListener("keydown", keydown);
  // The current tool is the only drawer affected by Escape.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool]);
  useEffect(() => {
    if (activeTool === "character" && sheetState.kind !== "closed") sheetCloseRef.current?.focus({ preventScroll: true });
  // Focus only when the drawer opens or changes from loading to loaded/error.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetState.kind, activeTool]);

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
    setLiveEvents((events) => [...events, event]);
    switch (event.type) {
      case "turn_started": {
        const id = event.payload.turn.turnId; deliveryTurnIdRef.current = id; clearLock(); setDeclaration(""); setPhase("streaming"); turnChangeRef.current?.(id);
        persist({ turnId: id, selectedActorId: event.payload.turn.actorId, streamPhase: "streaming" }); break;
      }
      case "agent_status":
        if (event.payload.status === "awaiting-confirmation") setPhase("awaiting-confirmation");
        break;
      case "tool_proposed": case "mechanics_committed": case "narration_delta": case "choice": break;
      case "confirmation_required": setPhase("awaiting-confirmation"); break;
      case "terminal": {
        setResumeToken(undefined);
        const locator = { turnId: event.payload.turn.turnId, actorId: event.payload.turn.actorId,
          allowResumeToken: false, priorTurnId: event.payload.turn.priorTurnId };
        setPendingTurnReconciliation(locator); void reconcileKnownTurn(locator); break;
      }
    }
  }, [clearLock, persist, reconcileKnownTurn]);

  const openStream = useCallback((request: PlayStreamRequest) => {
    deliveryTurnIdRef.current = null;
    setError(null); setLiveEvents([]); setPhase("streaming"); const handle = api.streamAdventureTurn(request, receive); streamRef.current = handle;
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
    if (sessionLocked || roomToolsLocked || !authorizationCanAct || !selectedActorId || phase === "streaming" || phase === "ambiguous" || phase === "awaiting-confirmation") return;
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
    if (sessionLocked || roomToolsLocked || !turn || !["completed", "cancelled", "failed"].includes(turn.turn.state) || !["idle", "terminal"].includes(phase) || !selectedActorId) return;
    setPhase("streaming");
    try {
      const latest = await refreshBootstrap();
      openStream({ kind, campaignId, sessionId, actorId: selectedActorId, priorTurnId: turn.turn.turnId,
        expectedRevision: latest.expectedRevision, idempotencyKey: idempotency() });
    } catch { setPhase("terminal"); setError("Latest play state could not be loaded. No narration variant was submitted."); }
  }

  const setActor = (actorId: string) => { if (!bootstrap?.playableActors.some((actor) => actor.actorId === actorId)) return;
    if (sessionLocked || roomToolsLocked || !authorizationCanAct || !["idle", "terminal"].includes(phase)) return;
    if (sheetState.kind !== "closed") { sheetRequestRef.current += 1; setSheetState({ kind: "closed" }); if (activeTool === "character") closeTool(); }
    setSelectedActorId(actorId); selectedActorRef.current = actorId; selectedChangeRef.current?.(actorId);
    persist({ ...(turn ? { turnId: turn.turn.turnId } : {}), selectedActorId: actorId, ...(resumeToken ? { resumeToken } : {}), streamPhase: phase }); };
  const pending = turn?.confirmation.state === "pending" ? turn.confirmation : null;
  const confirmationApi = useMemo(() => ({ confirmAdventureTurn: api.confirmAdventureTurn, getAdventureTurn: api.getAdventureTurn }), [api]);
  const activeBinding = turn ? { campaignId, sessionId, actorId: turn.turn.actorId, turnId: turn.turn.turnId, priorTurnId: turn.turn.priorTurnId } : null;
  if (!bootstrap) return <main className="living-atlas atlas-loading"><p className="atlas-kicker">VELVET / LIVING ATLAS</p>
    {bootstrapError ? <><p role="alert">{bootstrapError}</p><div className="button-row"><button type="button" onClick={() => void loadBootstrap()}>Retry connection</button><button type="button" onClick={onBack}>Leave room</button></div></> : <p role="status">Opening campaign play...</p>}
  </main>;
  const actionable = authorizationCanAct && bootstrap.session.adventureEligible && bootstrap.session.active
    && bootstrap.principal.role !== "observer" && bootstrap.playableActors.length > 0;
  const referenceReady = actionable && !sessionLocked && !roomToolsLocked && (phase === "idle" || phase === "terminal") && Boolean(selectedActorId);
  const toolBlocked = dmLocked || sessionLocked || !actionable || !["idle", "terminal"].includes(phase);
  const audience = bootstrap.principal.role === "owner" || bootstrap.principal.role === "gm" ? "gm" : "player";
  const actorNames = new Map(bootstrap.playableActors.map((actor) => [actor.actorId, actor.name]));
  const { canView: canViewDice, canRoll: canRollDice } = bootstrap.capabilities.campaignDice;
  const playBlocker = !authorizationCanAct || bootstrap.principal.role === "observer" ? "Observer access is read-only."
    : !bootstrap.session.active ? "This attached room has stopped and is read-only."
      : !bootstrap.session.adventureEligible ? "Adventure turns are unavailable. Publish the campaign and use an attached active room with a finalized participating character."
        : bootstrap.playableActors.length === 0 ? "No controlled actor is available in this room. Review character finalization, room participants, and campaign control." : null;
  function closeTool() {
    setActiveTool(null);
    const origin = toolOriginRef.current;
    queueMicrotask(() => { if (origin?.isConnected) origin.focus({ preventScroll: true }); });
  }
  function openTool(tool: AtlasTool) {
    if (activeTool === tool) { closeTool(); return; }
    toolOriginRef.current = document.querySelector<HTMLElement>(`[data-atlas-tool="${tool === "inventory" || tool === "advancement" ? "character" : tool}"]`) ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setActiveTool(tool); setVisitedTools((current) => current.includes(tool) ? current : [...current, tool]);
    if (tool === "character") void openSheet();
    // Bring the opened tool into view: scroll its pane when it scrolls, otherwise the page on narrow layouts.
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => {
        const pane = document.getElementById("campaign-quick-tools");
        const slot = pane?.querySelector<HTMLElement>(`#atlas-${tool}`) ?? null;
        if (pane && slot && pane.scrollHeight > pane.clientHeight + 1) pane.scrollTo({ top: Math.max(0, slot.offsetTop - 8), behavior: "smooth" });
        else if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 1100px)").matches) pane?.scrollIntoView({ block: "start" });
      });
    }
  }
  async function openSheet() {
    if (!referenceReady || !selectedActorId || !bootstrap?.playableActors.some((actor) => actor.actorId === selectedActorId)) return;
    const actorId = selectedActorId; const request = ++sheetRequestRef.current; setSheetState({ kind: "loading", actorId });
    try {
      const sheet = await api.getActorGameplaySheet(actorId);
      if (!activeRef.current || request !== sheetRequestRef.current || selectedActorRef.current !== actorId) return;
      setSheetState({ kind: "ready", actorId, sheet });
    } catch (failure) {
      if (!activeRef.current || request !== sheetRequestRef.current) return;
      const denied = failure instanceof ApiError && (failure.status === 403 || failure.status === 404);
      setSheetState({ kind: "error", actorId, message: denied ? "This character sheet is unavailable with your current access." : "The character sheet could not be loaded. Nothing was changed." });
    }
  }
  function appendSheetReference(fragment: string) {
    if (!referenceReady || sheetState.kind !== "ready" || sheetState.actorId !== selectedActorId) return;
    setDeclaration((current) => current.length === 0 ? fragment : `${current}${/\s$/.test(current) ? "" : " "}${fragment}`);
    requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  }

  const role = bootstrap.principal.role === "observer" || !authorizationCanAct ? "Spectator" : audience === "gm" ? "Game master" : "Player";
  const sceneImageAvailable = imagesEnabled && Boolean(sceneImageApi) && authorizationCanAct;
  const scene = activeScene ?? { sceneKey: `session:${sessionId}`, label: "This room" };
  const tools: AtlasTool[] = ["director", "character", "dice", "travel", "context", "combat", ...(audience === "gm" && authorizationCanAct ? ["gm" as const, "security" as const, "create" as const, ...(sceneImageAvailable ? ["images" as const] : [])] : []), "help"];
  const campaignNav = onNavigate ? <label className="campaign-nav-select"><select aria-label="Open a campaign destination" value="" onChange={(event) => { const destination = event.target.value as CampaignDestination; if (destination) onNavigate(destination); }}><option value="">Campaign views…</option>{campaignDestinations(bootstrap.principal.role, Boolean(worldApi), combatAvailable).filter((item) => item.id !== "play").map((item) => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.label}</option>)}</select></label> : null;
  function applyPrefill(value: string, mode: "replace" | "append") {
    if (!referenceReady) return;
    setDeclaration((current) => mode === "replace" || current.length === 0 ? value : `${current}${/\s$/.test(current) ? "" : " "}${value}`);
    setPendingPrefill(null);
    requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
  }
  const prefill = (value: string) => {
    if (!referenceReady) return;
    if (declaration.trim().length === 0) { applyPrefill(value, "replace"); return; }
    setPendingPrefill(value);
  };
  const activeActorName = bootstrap.playableActors.find((actor) => actor.actorId === selectedActorId)?.name ?? null;
  const actorSelector = bootstrap.principal.role !== "observer" && authorizationCanAct && bootstrap.playableActors.length > 0
    ? <p className="atlas-actor-readonly"><span>Acting as</span><strong>{activeActorName ?? "No character selected"}</strong><span className="atlas-actor-hint">Change character in the composer.</span></p>
    : <span className="atlas-kicker">Read-only viewpoint</span>;
  const contextNode = <section id="campaign-context-panel" className="campaign-context-drawer campaign-context-pane" aria-label="Living map" tabIndex={-1}>
    <CampaignContextDrawer key={`context-main:${authorizationGeneration}:${audience}`} mapsOnly commandsBlocked={dmLocked}
      readOnly={!actionable || sessionLocked || combatLocked || travelLocked || inventoryLocked || advancementLocked || !["idle", "terminal"].includes(phase) || !selectedActorId} campaignId={campaignId} sessionId={sessionId}
      selectedActorId={selectedActorId || null} playableActorIds={bootstrap.playableActors.map((actor) => actor.actorId)} audience={audience} authorizationGeneration={authorizationGeneration}
      widgets={preferences.widgets} refreshKey={reconciliationRevision + liveRefreshRevision} api={api} onSceneResolved={resolveScene} onPrefillDeclaration={prefill} onOpenWorld={() => openTool("travel")} onOpenCombat={() => openTool("combat")} />
  </section>;
  const quickToolApi = actorToolsApi ? { getActorResources: actorToolsApi.getResources, getActorInventory: actorToolsApi.getInventory, getActorEffects: actorToolsApi.getEffects } : null;
  const quickNode = quickToolApi
    ? <CampaignQuickPanel campaignId={campaignId} selectedActorId={selectedActorId || null} actors={bootstrap.playableActors} api={quickToolApi}
        refreshKey={reconciliationRevision + liveRefreshRevision} canOpenSheet={referenceReady} onOpenSheet={() => void openSheet()} />
    : <p className="quick-panel-note">Character services are unavailable in this room.</p>;
  const noticesNode = <>
    {error && <p className="atlas-notice" role="alert">{error}</p>}
    {playBlocker && <p className="atlas-notice" role="status">{playBlocker}</p>}
    {dmLocked && <p className="atlas-notice" role="status">Director work needs review or recovery. Open Director; takeover remains available to the GM.</p>}
    {(sessionLocked || combatLocked || travelLocked || inventoryLocked || advancementLocked) && <p className="atlas-notice" role="status">{sessionLocked ? "A GM session operation needs review or recovery. Open GM tools to continue." : travelLocked ? "Travel needs review or recovery. Open Travel to continue." : inventoryLocked || advancementLocked ? "A character operation needs review or recovery. Open Character tools to continue." : "A combat operation needs completion or recovery. Open Combat & rewards to continue."}</p>}
  </>;
  const reconcileNode = <>
    {pendingPrefill && <div className="atlas-reconcile" role="group" aria-label="Insert suggested action"><p>You already have a declaration. Append the suggestion or replace what you wrote?</p><div className="button-row">
      <button type="button" onClick={() => applyPrefill(pendingPrefill, "append")}>Append suggestion</button>
      <button type="button" onClick={() => applyPrefill(pendingPrefill, "replace")}>Replace declaration</button>
      <button type="button" onClick={() => setPendingPrefill(null)}>Cancel</button></div></div>}
    {pendingInitial && phase === "ambiguous" && actionable && <div className="atlas-reconcile"><p>A submitted declaration has no confirmed turn identity.</p><button type="button" onClick={() => void reconcilePendingInitial()}>Reconcile submitted declaration</button></div>}
    {pendingTurnReconciliation && phase === "ambiguous" && actionable && <div className="atlas-reconcile"><p>A known turn needs authoritative reconciliation.</p><button type="button" onClick={() => void reconcileKnownTurn(pendingTurnReconciliation)}>Reconcile known turn</button></div>}
  </>;
  const dmNoticeNode = <p className="atlas-notice">Table DM: {(dmHistory?.control.mode ?? bootstrap.dm?.mode) === "human" ? "Human DM" : (dmHistory?.control.mode ?? bootstrap.dm?.mode) === "ai" ? "AI DM / no human DM" : "Status unavailable"}. <button type="button" onClick={() => openTool("director")}>Manage director</button></p>;
  const replayToggleNode = <div className="atlas-turn-tools" aria-label="Session replay">
      <button type="button" className="ghost" aria-pressed={replayOpen} onClick={() => setReplayOpen((open) => !open)}>{replayOpen ? "Close replay" : "Replay this session"}</button>
    </div>;
  const conversationNode = replayOpen
    ? <CampaignReplay campaignId={campaignId} sessionId={sessionId} dmHistory={dmHistory} transcript={transcript} actorNames={actorNames} trace={api} onExit={() => setReplayOpen(false)} />
    : <>
    {dmHistory?.runs.some((run) => run.narration) && <CampaignDmChronicle history={dmHistory} />}
    <CampaignConversation transcript={transcript} transcriptState={transcriptState} legacyMessages={legacyMessages} legacyParticipants={legacyParticipants}
      current={turn} liveEvents={liveEvents} actorNames={actorNames} onPrefillChoice={prefill} canPrefill={referenceReady} />
    {actionable && pending && activeBinding && <ConfirmationBanner turnId={turn!.turn.turnId} revision={turn!.turn.revision} proposals={turn!.proposals} proposalIds={pending.proposalIds} expiresAt={pending.expiresAt} binding={activeBinding} api={confirmationApi} restoreFocusRef={composerRef}
      onReconciled={(value, token) => { void applyReconciled({ ...value, ...(token ? { resumeToken: token } : {}) }, true); }} />}
    {turn && <MechanicReceiptCard campaignId={campaignId} links={turn.receipts} api={api} compact />}
    {actionable && turn && ["completed", "cancelled", "failed"].includes(turn.turn.state) && <div className="atlas-turn-tools" aria-label="Adventure narration alternatives">
      <button type="button" disabled={!referenceReady} onClick={() => void narrateVariant("narration-swipe")}>Swipe narration</button>
      <button type="button" disabled={!referenceReady} onClick={() => void narrateVariant("narration-retry")}>Retry narration</button></div>}
    {actionable && streamRef.current && <div className="atlas-turn-tools"><button type="button" onClick={cancelLiveDelivery}>Stop receiving live updates</button></div>}
    </>;
  const voiceNode = <VoiceControls campaignId={campaignId} contextKey={JSON.stringify([sessionId, authorizationGeneration, authorizationCanAct, phase,
      sessionLocked, roomToolsLocked, bootstrap.session.active, turn?.turn.turnId ?? "", turn?.turn.state ?? ""])} />;
  const situationNode = actionable && combatAvailable && combatApi
    ? <SituationActions campaignId={campaignId} sessionId={sessionId} controlledActorId={selectedActorId || undefined} api={combatApi} refreshKey={reconciliationRevision + liveRefreshRevision} disabled={!referenceReady} onInsert={prefill} />
    : null;
  const composerNode = <AdventureActionComposer actors={bootstrap.playableActors} selectedActorId={selectedActorId} role={authorizationCanAct ? bootstrap.principal.role : "observer"} eligible={bootstrap.session.adventureEligible} inactive={!bootstrap.session.active}
      phase={sessionLocked || roomToolsLocked || phase === "streaming" || phase === "awaiting-confirmation" ? "inflight" : phase === "ambiguous" ? "ambiguous" : "ready"}
      declaration={declaration} onDeclarationChange={setDeclaration} onActorChange={setActor} onSubmit={(value) => void submit(value)} composerRef={composerRef} />;
  const sceneImageNode = sceneImageAvailable && sceneImageApi
    ? <SceneIllustration campaignId={campaignId} sessionId={sessionId} sceneKey={scene.sceneKey} sceneLabel={scene.label} audience={audience} enabled
        api={sceneImageApi} onOpenControls={audience === "gm" ? () => openTool("images") : undefined} />
    : null;
  const centerNode = <>
    <div className="room-top">{sceneImageNode}{noticesNode}{reconcileNode}</div>
    <div className="room-main">{conversationNode}</div>
    <div className="room-bottom"><div className="room-toolbar">{dmNoticeNode}{replayToggleNode}{voiceNode}</div>{situationNode}{composerNode}</div>
  </>;
  const activityNode = <>{dmNoticeNode}{replayToggleNode}{voiceNode}{situationNode}</>;
  const drawersNode = <>
    <AtlasDrawer tool="director" open={activeTool === "director"} onClose={closeTool}>
      <CampaignDmPanel key={`dm:${campaignId}:${sessionId}:${authorizationGeneration}`} bootstrap={bootstrap} api={api.dm}
        blocked={sessionLocked || combatLocked || travelLocked || inventoryLocked || advancementLocked || !["idle", "terminal"].includes(phase)}
        canAct={authorizationCanAct} onHistory={setDmHistory} onLockChange={setDmLocked} onStateChange={refreshAfterTool}
        contextTurnId={turn?.turn.campaignId === campaignId && turn.turn.sessionId === sessionId ? turn.turn.turnId : undefined}
        evidenceTurnId={turn?.turn.state === "completed" && turn.turn.mode === "original" && turn.turn.campaignId === campaignId && turn.turn.sessionId === sessionId ? turn.turn.turnId : undefined} />
    </AtlasDrawer>
    <div id="atlas-character" className="atlas-drawer-slot atlas-character-reference" hidden={activeTool !== "character"}>
      <nav className="atlas-character-actions" aria-label="Character mechanics"><button type="button" onClick={() => openTool("inventory")}>Inventory & equipment</button><button type="button" onClick={() => openTool("advancement")}>Advancement</button></nav>
      {sheetState.kind === "ready" && <GameplaySheetDrawer sheet={sheetState.sheet} canReference={referenceReady && sheetState.actorId === selectedActorId} closeButtonRef={sheetCloseRef} onClose={closeTool} onReference={appendSheetReference} />}
      {sheetState.kind !== "ready" && <aside className="gameplay-sheet-drawer" role="dialog" aria-modal="false" tabIndex={-1} aria-labelledby="atlas-sheet-heading"><header><h2 id="atlas-sheet-heading">{sheetState.kind === "loading" ? "Opening character sheet" : "Character sheet unavailable"}</h2><button ref={sheetCloseRef} type="button" aria-label="Close character sheet" onClick={closeTool}>Close</button></header>
        {sheetState.kind === "loading" ? <p role="status">Loading authoritative character details...</p> : <><p role="status">{sheetState.kind === "error" ? sheetState.message : "Character references are available only for a controlled actor while play is ready and unambiguous."}</p><button type="button" disabled={!referenceReady} onClick={() => void openSheet()}>Open character sheet</button></>}
      </aside>}
    </div>
    <AtlasDrawer tool="inventory" open={activeTool === "inventory"} onClose={closeTool}>{visitedTools.includes("inventory") && (actorToolsApi && selectedActorId && authorizationCanAct && bootstrap.principal.role !== "observer"
      ? <RpgCharacterSheetPage key={`inventory:${authorizationGeneration}:${selectedActorId}`} embedded controlledActorId={selectedActorId} campaignId={campaignId} api={actorToolsApi}
        canMutate={actionable} blocked={toolBlocked || combatLocked || travelLocked || advancementLocked} reauthorize={authorizeActorTool} onLockChange={setInventoryLocked} onStateChange={refreshAfterTool}
        onBack={closeTool} onUnavailable={() => setError("Character mechanics are unavailable with your current access.")} onOpenCombat={() => openTool("combat")} />
      : <p>Inventory mechanics require an authorized controlled actor and character services.</p>)}</AtlasDrawer>
    <AtlasDrawer tool="advancement" open={activeTool === "advancement"} onClose={closeTool}>{visitedTools.includes("advancement") && (advancementApi && actionable
      ? <AtlasAdvancement campaignId={campaignId} api={advancementApi} blocked={toolBlocked || combatLocked || travelLocked || inventoryLocked} reauthorize={authorizeActorTool} onLockChange={setAdvancementLocked} onStateChange={refreshAfterTool} />
      : <p>Advancement requires an active room, an authorized character, and progression services.</p>)}</AtlasDrawer>
    <AtlasDrawer tool="travel" open={activeTool === "travel"} onClose={closeTool}>{visitedTools.includes("travel") && (worldApi && authorization
      ? <WorldExplorerPage embedded campaignId={campaignId} sessionId={sessionId} authorization={authorization} api={worldApi} actors={bootstrap.playableActors}
        blocked={toolBlocked || combatLocked || inventoryLocked || advancementLocked} onLockChange={setTravelLocked} onStateChange={refreshAfterTool} onBack={closeTool} />
      : <p>Direct travel requires authorized world services. World route buttons can still prepare a declaration; they do not commit travel.</p>)}</AtlasDrawer>
    <AtlasDrawer tool="dice" open={activeTool === "dice"} onClose={closeTool}>{visitedTools.includes("dice") && <CampaignDicePanel campaignId={campaignId} api={api} canView={canViewDice} canRoll={canRollDice && !dmLocked} actorNames={bootstrap.playableActors.map((actor) => actor.name)} selectedActorName={bootstrap.playableActors.find((actor) => actor.actorId === selectedActorId)?.name} refreshKey={liveRefreshRevision} />}</AtlasDrawer>
    <AtlasDrawer tool="context" open={activeTool === "context"} onClose={closeTool}>{visitedTools.includes("context") && <><p>Known locations, present cast, objectives, and published lore. Review direct party travel in Travel; use Character for inventory and advancement.</p><div className="atlas-character-actions"><button type="button" onClick={() => openTool("travel")}>Plan party travel</button><button type="button" onClick={() => openTool("inventory")}>Manage possessions</button></div><CampaignContextDrawer hideMaps readOnly={!referenceReady} key={`context:${authorizationGeneration}:${audience}`} campaignId={campaignId} sessionId={sessionId} selectedActorId={selectedActorId || null} playableActorIds={bootstrap.playableActors.map((actor) => actor.actorId)} audience={audience} authorizationGeneration={authorizationGeneration} refreshKey={reconciliationRevision + liveRefreshRevision} api={api} onSceneResolved={resolveScene} onPrefillDeclaration={prefill} onOpenWorld={() => openTool("travel")} onOpenCombat={() => openTool("combat")} /></>}</AtlasDrawer>
    <AtlasDrawer tool="combat" open={activeTool === "combat"} onClose={closeTool}>{visitedTools.includes("combat") && (combatAvailable && combatApi
      ? <CombatTrackerPage key={`combat:${authorizationGeneration}:${selectedActorId}`} embedded api={combatApi} campaignId={campaignId} sessionId={sessionId} actorRole={authorizationCanAct ? bootstrap.principal.role : "observer"} audience={audience} controlledActorId={selectedActorId || undefined}
        blocked={toolBlocked || travelLocked || inventoryLocked || advancementLocked} onLockChange={setCombatLocked} onStateChange={() => setReconciliationRevision((value) => value + 1)} onBack={closeTool} />
      : <p>Combat commands are unavailable in this room. You can inspect encounter context in Field journal; no action or route change has been issued.</p>)}</AtlasDrawer>
    {audience === "gm" && authorizationCanAct && <AtlasDrawer tool="gm" open={activeTool === "gm"} onClose={closeTool}><section aria-label="DM scene controls"><SessionControls key={`session:${campaignId}:${sessionId}:${authorizationGeneration}`} bootstrap={bootstrap} api={api}
      blocked={roomToolsLocked || (phase !== "idle" && phase !== "terminal")} onLockChange={setSessionLocked}
      onRefresh={async () => { await refreshBootstrap(); await refreshTranscript(); setReconciliationRevision((value) => value + 1); }} onCombat={() => openTool("combat")} /></section></AtlasDrawer>}
    {audience === "gm" && authorizationCanAct && <AtlasDrawer tool="security" open={activeTool === "security"} onClose={closeTool}>{visitedTools.includes("security") && <CampaignSecurityPanels campaignId={campaignId} onMutated={refreshAfterTool} />}</AtlasDrawer>}
    {audience === "gm" && authorizationCanAct && sceneImageAvailable && sceneImageApi && <AtlasDrawer tool="images" open={activeTool === "images"} onClose={closeTool}>{visitedTools.includes("images")
      && <SceneImageDmPanel campaignId={campaignId} sessionId={sessionId} sceneKey={scene.sceneKey} sceneLabel={scene.label} api={sceneImageApi} canManage enabled />}</AtlasDrawer>}
    {audience === "gm" && authorizationCanAct && characterBuilderApi && <AtlasDrawer tool="create" open={activeTool === "create"} onClose={closeTool}>{visitedTools.includes("create") && <CampaignCharacterCreator campaignId={campaignId} sessionId={sessionId} builderApi={characterBuilderApi} expectedRevision={async () => (await refreshBootstrap()).expectedRevision} onJoined={() => refreshAfterTool()} onExit={closeTool} />}</AtlasDrawer>}
    <AtlasDrawer tool="help" open={activeTool === "help"} onClose={closeTool}>{visitedTools.includes("help") && <PlayHelp />}</AtlasDrawer>
  </>;
  const drawersMount = <>{quickNode}{drawersNode}</>;
  if (surface === "atlas") return <PlaySurface headingRef={headingRef} title="Adventure room" role={role} phase={phase} actor={actorSelector}
    tools={tools} activeTool={activeTool} onTool={openTool} onBack={onBack} exitDisabled={sessionLocked || roomToolsLocked}
    map={contextNode} conversation={<>{sceneImageNode}{noticesNode}{reconcileNode}{conversationNode}</>} activity={activityNode} composer={composerNode} drawers={drawersMount} />;
  return <CommandCenter headingRef={headingRef} title="Adventure room" role={role} phase={phase} actor={actorSelector}
    tools={tools} activeTool={activeTool} onTool={openTool} onBack={onBack} exitDisabled={sessionLocked || roomToolsLocked}
    context={contextNode} center={centerNode} tool={drawersMount} campaignNav={campaignNav} preferences={preferences} onPreferences={onPreferences} />;
}
