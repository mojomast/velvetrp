import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdventureTurnConfirmRequest, AdventureTurnGetResponse, AdventureTurnStreamEvent, CampaignPlayBootstrap } from "@velvet/contracts";
import { AdventureActionComposer } from "./AdventureActionComposer";
import { CampaignContextDrawer, type CampaignContextDrawerApi } from "./CampaignContextDrawer";
import { ConfirmationBanner } from "./ConfirmationBanner";
import { MechanicReceiptCard, type MechanicReceiptApi } from "./MechanicReceiptCard";

/** Delivery-only handle. Cancelling it never cancels the durable adventure turn. */
export interface AdventureTurnStreamHandle {
  turnId: Promise<string>;
  done: Promise<void>;
  cancelDelivery: () => void;
}

/** Narrow API required by the durable campaign play shell. */
export interface CampaignPlayApi extends CampaignContextDrawerApi, MechanicReceiptApi {
  getCampaignPlayBootstrap: (campaignId: string, sessionId: string) => Promise<CampaignPlayBootstrap>;
  streamAdventureTurn: (request: { kind: "initial"; campaignId: string; sessionId: string; actorId: string; declaration: string; expectedRevision: number; idempotencyKey: string }
    | { kind: "resume"; resumeToken: string }, onEvent: (event: AdventureTurnStreamEvent) => void) => AdventureTurnStreamHandle;
  getAdventureTurn: (turnId: string) => Promise<AdventureTurnGetResponse>;
  confirmAdventureTurn: (turnId: string, input: AdventureTurnConfirmRequest) => Promise<{ turn: AdventureTurnGetResponse["turn"]; resumeToken?: string }>;
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
  initialSelectedActorId?: string;
  focusHeading?: boolean;
}

type StreamPhase = "idle" | "streaming" | "awaiting-confirmation" | "ambiguous" | "terminal";
type SafeState = { turnId?: string; selectedActorId?: string; resumeToken?: string; streamPhase: StreamPhase };
const stateKey = (campaignId: string, sessionId: string) => `velvet.campaign-play.v1:${campaignId}:${sessionId}`;
const lockKey = (campaignId: string, sessionId: string) => `velvet.campaign-play-submit.v1:${campaignId}:${sessionId}`;
const idempotency = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `turn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function readSafeState(campaignId: string, sessionId: string): SafeState {
  try {
    const value = JSON.parse(localStorage.getItem(stateKey(campaignId, sessionId)) ?? "null") as Record<string, unknown> | null;
    if (!value || !["idle", "streaming", "awaiting-confirmation", "ambiguous", "terminal"].includes(String(value.streamPhase))) return { streamPhase: "idle" };
    return { streamPhase: value.streamPhase as StreamPhase, ...(typeof value.turnId === "string" ? { turnId: value.turnId } : {}),
      ...(typeof value.selectedActorId === "string" ? { selectedActorId: value.selectedActorId } : {}), ...(typeof value.resumeToken === "string" ? { resumeToken: value.resumeToken } : {}) };
  } catch { return { streamPhase: "idle" }; }
}

/** Coordinates bootstrap, durable GET reconciliation, SSE delivery, confirmation, and the accessible play grid. */
export function CampaignPlayPage({ campaignId, sessionId, authorizationGeneration, api, children, onBack, onUnavailable,
  onSelectedActorChange, initialSelectedActorId, focusHeading }: CampaignPlayPageProps) {
  const initial = useRef(readSafeState(campaignId, sessionId)).current;
  const [bootstrap, setBootstrap] = useState<CampaignPlayBootstrap | null>(null);
  const [selectedActorId, setSelectedActorId] = useState(initialSelectedActorId ?? initial.selectedActorId ?? "");
  const [turn, setTurn] = useState<AdventureTurnGetResponse | null>(null);
  const [phase, setPhase] = useState<StreamPhase>(initial.streamPhase);
  const [resumeToken, setResumeToken] = useState(initial.resumeToken);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<AdventureTurnStreamHandle | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null); const composerRef = useRef<HTMLTextAreaElement>(null);

  const persist = useCallback((next: SafeState) => { try { localStorage.setItem(stateKey(campaignId, sessionId), JSON.stringify(next)); } catch { /* durable server state remains authoritative */ } }, [campaignId, sessionId]);
  const reconcile = useCallback(async (turnId: string) => {
    const value = await api.getAdventureTurn(turnId); setTurn(value);
    const nextPhase: StreamPhase = value.confirmation.state === "pending" ? "awaiting-confirmation"
      : ["completed", "cancelled", "failed"].includes(value.turn.state) ? "terminal" : "ambiguous";
    setPhase(nextPhase); persist({ turnId, selectedActorId: value.turn.actorId, ...(resumeToken ? { resumeToken } : {}), streamPhase: nextPhase });
    if (nextPhase === "terminal") try { localStorage.removeItem(lockKey(campaignId, sessionId)); } catch { /* optional */ }
    return value;
  }, [api, campaignId, persist, resumeToken, sessionId]);

  useEffect(() => { let current = true; setBootstrap(null); setTurn(null); setError(null);
    void api.getCampaignPlayBootstrap(campaignId, sessionId).then((value) => { if (!current) return; setBootstrap(value);
      const candidate = [selectedActorId, initialSelectedActorId].find((id) => id && value.playableActors.some((actor) => actor.actorId === id));
      const selected = candidate ?? value.playableActors[0]?.actorId ?? ""; setSelectedActorId(selected); onSelectedActorChange?.(selected || null);
    }).catch(() => { if (current) onUnavailable(); }); return () => { current = false; };
  }, [api, authorizationGeneration, campaignId, initialSelectedActorId, onSelectedActorChange, onUnavailable, sessionId]);
  useEffect(() => { if (focusHeading) headingRef.current?.focus(); }, [focusHeading]);
  useEffect(() => { if (initial.turnId) void reconcile(initial.turnId).catch(() => { setPhase("ambiguous"); setError("The durable turn could not be reconciled."); }); }, [initial.turnId, reconcile]);

  const receive = useCallback((event: AdventureTurnStreamEvent) => {
    if (event.type === "turn_started") { const id = event.payload.turn.turnId; setPhase("streaming"); persist({ turnId: id, selectedActorId: event.payload.turn.actorId, streamPhase: "streaming" }); }
    if (event.type === "confirmation_required") setPhase("awaiting-confirmation");
    if (event.type === "terminal") { setPhase(event.payload.turn.state === "awaiting-confirmation" ? "awaiting-confirmation" : "terminal"); void reconcile(event.payload.turn.turnId).catch(() => setPhase("ambiguous")); }
  }, [persist, reconcile]);

  const openStream = useCallback((request: Parameters<CampaignPlayApi["streamAdventureTurn"]>[0]) => {
    setError(null); setPhase("streaming"); const handle = api.streamAdventureTurn(request, receive); streamRef.current = handle;
    void handle.turnId.then((turnId) => persist({ turnId, selectedActorId, ...(request.kind === "resume" ? { resumeToken: request.resumeToken } : {}), streamPhase: "streaming" })).catch(() => undefined);
    void handle.done.catch(() => handle.turnId.then((turnId) => reconcile(turnId)).catch(() => { setPhase("ambiguous"); setError("Stream delivery ended before the durable outcome could be reconciled. The declaration will not be replayed."); }))
      .finally(() => { if (streamRef.current === handle) streamRef.current = null; });
  }, [api, persist, receive, reconcile, selectedActorId]);

  // Only a server-issued token may reconnect automatically. Initial declaration
  // bodies are never persisted and therefore cannot be replayed on reload.
  const resumedTokenRef = useRef<string | null>(null);
  useEffect(() => { if (bootstrap && resumeToken && phase !== "terminal" && resumedTokenRef.current !== resumeToken) { resumedTokenRef.current = resumeToken; openStream({ kind: "resume", resumeToken }); } }, [bootstrap, openStream, phase, resumeToken]);

  function submit(declaration: string) {
    if (!bootstrap || phase === "streaming" || phase === "ambiguous" || phase === "awaiting-confirmation") return;
    try { if (localStorage.getItem(lockKey(campaignId, sessionId))) { setPhase("ambiguous"); setError("A prior declaration is locked until its durable turn is reconciled."); return; } } catch { /* continue with in-memory lock */ }
    const key = idempotency(); try { localStorage.setItem(lockKey(campaignId, sessionId), JSON.stringify({ idempotencyKey: key, selectedActorId, submitted: true })); } catch { /* in-memory phase still locks */ }
    openStream({ kind: "initial", campaignId, sessionId, actorId: selectedActorId, declaration, expectedRevision: bootstrap.expectedRevision, idempotencyKey: key });
  }

  const setActor = (actorId: string) => { if (!bootstrap?.playableActors.some((actor) => actor.actorId === actorId)) return; setSelectedActorId(actorId); onSelectedActorChange?.(actorId); persist({ ...(turn ? { turnId: turn.turn.turnId } : {}), selectedActorId: actorId, ...(resumeToken ? { resumeToken } : {}), streamPhase: phase }); };
  const pending = turn?.confirmation.state === "pending" ? turn.confirmation : null;
  const confirmationApi = useMemo(() => ({ confirmAdventureTurn: api.confirmAdventureTurn, getAdventureTurn: api.getAdventureTurn }), [api]);
  if (!bootstrap) return <main className="campaign-play-page"><p role="status">Opening campaign play…</p></main>;
  return <main className="campaign-play-page"><header className="campaign-play-header"><div><button className="back-link" onClick={onBack}>← Back to campaign</button><p className="eyebrow">CAMPAIGN PLAY</p><h1 ref={headingRef} tabIndex={-1}>Adventure room</h1></div>
    <p className="play-phase" role="status">{phase.replace("-", " ")}</p></header>
    {error && <p className="play-error" role="alert">{error}</p>}
    <div className="campaign-play-grid"><CampaignContextDrawer campaignId={campaignId} selectedActorId={selectedActorId || null} playableActorIds={bootstrap.playableActors.map((actor) => actor.actorId)} audience={bootstrap.principal.role === "owner" || bootstrap.principal.role === "gm" ? "gm" : "player"} authorizationGeneration={authorizationGeneration} api={api} />
      <section className="campaign-play-center" aria-label="Campaign room conversation"><div className="embedded-room-chat">{children}</div>
        {turn?.narrationStatus.text && <article className="adventure-narration"><h2>Adventure narration</h2><p>{turn.narrationStatus.text}</p>{turn.receipts.length === 0 && <p className="no-tools-label">No mechanics committed · server fallback/no-tools narration</p>}</article>}
        {pending && <ConfirmationBanner turnId={turn!.turn.turnId} revision={turn!.turn.revision} proposals={turn!.proposals} proposalIds={pending.proposalIds} expiresAt={pending.expiresAt} api={confirmationApi} restoreFocusRef={composerRef}
          onReconciled={(value, token) => { setTurn(value); if (token) { setResumeToken(token); persist({ turnId: value.turn.turnId, selectedActorId, resumeToken: token, streamPhase: "streaming" }); } else { setPhase(value.confirmation.state === "pending" ? "awaiting-confirmation" : "terminal"); } }} />}
        {turn && <MechanicReceiptCard campaignId={campaignId} links={turn.receipts} api={api} />}
        <AdventureActionComposer actors={bootstrap.playableActors} selectedActorId={selectedActorId} role={bootstrap.principal.role} eligible={bootstrap.session.adventureEligible} inactive={!bootstrap.session.active}
          phase={phase === "streaming" || phase === "awaiting-confirmation" ? "inflight" : phase === "ambiguous" ? "ambiguous" : "ready"} onActorChange={setActor} onSubmit={submit} composerRef={composerRef} />
      </section></div>
    {streamRef.current && <button className="ghost cancel-delivery" onClick={() => streamRef.current?.cancelDelivery()}>Stop receiving live updates</button>}
  </main>;
}
