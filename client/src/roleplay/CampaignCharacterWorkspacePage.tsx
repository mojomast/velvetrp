import { useCallback, useEffect, useRef, useState } from "react";
import type { CampaignCharacterWorkspace } from "@velvet/contracts";
import { ApiError, applyCharacterProgression, getCampaignCharacterWorkspace, getCharacterProgression, getCharacterSheet, previewCharacterProgression } from "../api";
import { LevelUpWizard, type LevelUpWizardApi } from "../components/rpg/character/LevelUpWizard";

const levelUpApi: LevelUpWizardApi = {
  getProgression: getCharacterProgression, preview: previewCharacterProgression,
  apply: applyCharacterProgression, getSheet: getCharacterSheet,
};

export interface CampaignCharacterWorkspacePageProps {
  campaignId: string;
  campaignCharacterId: string;
  onBack: () => void;
  onUnavailable: () => void;
  /** App-owned request proving this workspace was opened in the current SPA transition. */
  focusHeadingRequest?: number;
  focusSheetRequest?: number;
  onSheetFocused?: (request: number) => void;
  onOpenSheet?: () => void;
}

const initialWorkspaceReads = new Map<string, Promise<Awaited<ReturnType<typeof getCampaignCharacterWorkspace>>>>();

function initialRead(campaignId: string, campaignCharacterId: string) {
  const key = `${campaignId.length}:${campaignId}${campaignCharacterId}`;
  const existing = initialWorkspaceReads.get(key);
  if (existing) return existing;
  const promise = getCampaignCharacterWorkspace(campaignId, campaignCharacterId);
  initialWorkspaceReads.set(key, promise);
  void promise.finally(() => {
    if (initialWorkspaceReads.get(key) === promise) initialWorkspaceReads.delete(key);
  }).catch(() => undefined);
  return promise;
}

export function resetCampaignCharacterWorkspacePageModuleStateForTests(): void {
  initialWorkspaceReads.clear();
}

function displayKind(value: string): string {
  return value.split("-").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

type WorkspaceFocusIntent = {
  campaignId: string;
  campaignCharacterId: string;
  generation: number;
  request?: number;
  target: "heading" | "retry";
  outcome: "pending" | "success" | "failure";
};

export function CampaignCharacterWorkspacePage({ campaignId, campaignCharacterId, onBack, onUnavailable, focusHeadingRequest, focusSheetRequest, onSheetFocused, onOpenSheet }: CampaignCharacterWorkspacePageProps) {
  const [workspace, setWorkspace] = useState<CampaignCharacterWorkspace | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const activeRef = useRef({ campaignId, campaignCharacterId });
  activeRef.current = { campaignId, campaignCharacterId };
  const retryRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sheetButtonRef = useRef<HTMLButtonElement>(null);
  const focusIntentRef = useRef<WorkspaceFocusIntent | null>(null);
  const focusedHeadingRequestRef = useRef<number | null>(null);
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;

  const load = useCallback(async (retry = false, reuseInitial = false, transitionFocus = false) => {
    const requested = { campaignId, campaignCharacterId };
    const generation = ++generationRef.current;
    if (!mountedRef.current) return;
    setWorkspace(null);
    setPhase("loading");
    focusIntentRef.current = retry
      ? { ...requested, generation, target: "retry", outcome: "pending" }
      : transitionFocus && focusHeadingRequest !== undefined && focusedHeadingRequestRef.current !== focusHeadingRequest
        ? { ...requested, generation, request: focusHeadingRequest, target: "heading", outcome: "pending" }
        : null;
    try {
      const response = await (reuseInitial ? initialRead(campaignId, campaignCharacterId) : getCampaignCharacterWorkspace(campaignId, campaignCharacterId));
      if (!mountedRef.current || generation !== generationRef.current
        || activeRef.current.campaignId !== requested.campaignId
        || activeRef.current.campaignCharacterId !== requested.campaignCharacterId) return;
      setWorkspace(response.character);
      setPhase("ready");
      if (focusIntentRef.current?.generation === generation) focusIntentRef.current.outcome = "success";
    } catch (error) {
      if (!mountedRef.current || generation !== generationRef.current
        || activeRef.current.campaignId !== requested.campaignId
        || activeRef.current.campaignCharacterId !== requested.campaignCharacterId) return;
      if (error instanceof ApiError && error.status === 404) {
        focusIntentRef.current = null;
        unavailableRef.current();
        return;
      }
      setPhase("failed");
      if (focusIntentRef.current?.generation === generation) focusIntentRef.current.outcome = "failure";
    }
  }, [campaignCharacterId, campaignId, focusHeadingRequest]);

  useEffect(() => {
    mountedRef.current = true;
    void load(false, true, focusHeadingRequest !== undefined);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      focusIntentRef.current = null;
    };
  }, [focusHeadingRequest, load]);

  useEffect(() => {
    const intent = focusIntentRef.current;
    if (!intent || intent.generation !== generationRef.current
      || intent.campaignId !== campaignId || intent.campaignCharacterId !== campaignCharacterId
      || (intent.request !== undefined && intent.request !== focusHeadingRequest)
      || (phase === "ready" && intent.outcome !== "success")
      || (phase === "failed" && intent.outcome !== "failure")
      || phase === "loading") return;
    focusIntentRef.current = null;
    queueMicrotask(() => {
      if (!mountedRef.current || generationRef.current !== intent.generation
        || activeRef.current.campaignId !== intent.campaignId
        || activeRef.current.campaignCharacterId !== intent.campaignCharacterId
        || (intent.request !== undefined && intent.request !== focusHeadingRequest)) return;
      if (intent.outcome === "success") {
        headingRef.current?.focus();
        if (intent.request !== undefined) focusedHeadingRequestRef.current = intent.request;
      } else if (intent.target === "retry" && intent.outcome === "failure") retryRef.current?.focus();
    });
  }, [campaignCharacterId, campaignId, focusHeadingRequest, phase]);

  useEffect(() => {
    if (phase !== "ready" || focusSheetRequest === undefined) return;
    queueMicrotask(() => { if (mountedRef.current) { sheetButtonRef.current?.focus(); onSheetFocused?.(focusSheetRequest); } });
  }, [focusSheetRequest, onSheetFocused, phase]);

  return <main className="page library-page campaign-page workspace-page"><section className="campaign-shell" aria-labelledby="workspace-heading">
    <header className="library-header"><div><button className="back-link" type="button" onClick={onBack}>← Back to campaign</button><p className="eyebrow">CHARACTER WORKSPACE</p><h1 ref={headingRef} tabIndex={-1} className="title" id="workspace-heading"><bdi dir="auto">{workspace?.name ?? "Character"}</bdi></h1></div></header>
    <section className="library-panel workspace-panel" aria-busy={phase === "loading"}>
      {phase === "loading" && <p className="empty-state" role="status">Loading character…</p>}
      {phase === "failed" && <div className="empty-state large" role="alert"><p>Character could not be loaded.</p><button ref={retryRef} className="ghost" type="button" onClick={() => void load(true)}>Retry</button></div>}
      {phase === "ready" && workspace && <>
        {onOpenSheet && <div className="workspace-command-bar"><button ref={sheetButtonRef} className="primary" type="button" onClick={onOpenSheet}>Open sheet, inventory & economy</button><span>Authoritative gameplay state</span></div>}
        <section className="workspace-identity" aria-label="Character metadata">
          <article><span>Race</span><h2><bdi dir="auto">{workspace.race.name}</bdi></h2><p><bdi dir="auto">{workspace.race.description}</bdi></p></article>
          <article><span>Background</span><h2><bdi dir="auto">{workspace.background.name}</bdi></h2><p><bdi dir="auto">{workspace.background.description}</bdi></p></article>
          <article><span>Classes</span>{workspace.classes.length ? <ul>{workspace.classes.map((item, index) => <li key={index}><h2><bdi dir="auto">{item.name}</bdi> · level {item.level}</h2><p><bdi dir="auto">{item.description}</bdi></p></li>)}</ul> : <p>No classes.</p>}</article>
        </section>
        <section className="workspace-section"><h2>Attributes</h2>{workspace.attributes.length ? <dl>{workspace.attributes.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl> : <p>No attributes.</p>}</section>
        <section className="workspace-section"><h2>Proficiencies</h2>{workspace.proficiencies.length ? <ul>{workspace.proficiencies.map((item, index) => <li key={index}><span>{displayKind(item.category)}</span><strong>{item.label}</strong></li>)}</ul> : <p>No proficiencies.</p>}</section>
        <section className="workspace-section"><h2>Choices</h2>{workspace.choices.length ? <ul>{workspace.choices.map((item, index) => <li key={index}><span>{item.label} · {displayKind(item.selection.kind)}</span><h3><bdi dir="auto">{item.selection.name}</bdi></h3><p><bdi dir="auto">{item.selection.description}</bdi></p></li>)}</ul> : <p>No choices.</p>}</section>
        <section className="workspace-section"><h2>Resources</h2>{workspace.resources.length ? <dl>{workspace.resources.map((item, index) => <div key={index}><dt>{item.label}</dt><dd>{item.current} / {item.max}</dd></div>)}</dl> : <p>No resources.</p>}</section>
        <LevelUpWizard campaignId={campaignId} campaignCharacterId={campaignCharacterId} api={levelUpApi} onUnavailable={onUnavailable} onSheetRefreshed={(sheet) => setWorkspace(sheet.sheet)} />
      </>}
    </section>
  </section></main>;
}
