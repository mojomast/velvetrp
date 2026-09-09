import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { campaignDmBeatRequestSchema, campaignDmDecisionRequestSchema, campaignDmModeRequestSchema, campaignDmSceneBindingRequestSchema, resourceIdSchema,
  type CampaignDmHistory, type CampaignDmPrivateRun, type CampaignDmRun, type CampaignPlayBootstrap } from "@velvet/contracts";
import { commandCampaignDmBeat, commandCampaignDmDecision, commandCampaignDmMode, getCampaignDmHistory, getCampaignDmProposal, getCampaignDmRun, resumeCampaignDmRun, commandCampaignDmSceneBinding, getCampaignStory, listCampaignQuests, listCampaignEncounters } from "../../../api";
import { createClientId } from "../../../utils/clientId";
import "./campaignDmPanel.css";

export const campaignDmApi = { commandCampaignDmBeat, commandCampaignDmDecision, commandCampaignDmMode, getCampaignDmHistory, getCampaignDmProposal, getCampaignDmRun, resumeCampaignDmRun,
  commandCampaignDmSceneBinding, getBindingStory: (campaignId: string) => getCampaignStory(campaignId, "gm"),
  getBindingQuests: (campaignId: string) => listCampaignQuests(campaignId, "gm"), listCampaignEncounters };
export type CampaignDmApi = typeof campaignDmApi;
const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("beat"), request: campaignDmBeatRequestSchema }).strict(),
  z.object({ kind: z.literal("decision"), runId: resourceIdSchema, request: campaignDmDecisionRequestSchema }).strict(),
  z.object({ kind: z.literal("run"), runId: resourceIdSchema }).strict(),
  z.object({ kind: z.literal("binding"), request: campaignDmSceneBindingRequestSchema }).strict(),
]);
type Operation = z.infer<typeof operationSchema>;
const terminal = (run: CampaignDmRun) => ["completed", "blocked", "cancelled"].includes(run.state);
type BindingChoices = { revision: number; scenes: { id: string; label: string }[]; evidence: { kind: "quest-objective" | "encounter"; id: string; label: string }[] };

/** Always mounted: closing the drawer never drops a durable command or its room lock. */
export function CampaignDmPanel({ bootstrap, api, blocked, canAct, evidenceTurnId, onHistory, onLockChange, onStateChange }: {
  bootstrap: CampaignPlayBootstrap; api: CampaignDmApi; blocked: boolean; canAct: boolean; evidenceTurnId?: string;
  onHistory: (history: CampaignDmHistory) => void; onLockChange: (locked: boolean) => void; onStateChange: () => void;
}) {
  const { campaignId, sessionId } = bootstrap;
  const key = `velvet.dm.v1:${campaignId}:${sessionId}`;
  const modeKey = `velvet.dm-mode.v1:${campaignId}`;
  const [invalid, setInvalid] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [modeOperation, setModeOperation] = useState<z.infer<typeof campaignDmModeRequestSchema> | null>(null);
  const [history, setHistory] = useState<CampaignDmHistory | null>(null);
  const [readUnavailable, setReadUnavailable] = useState(true);
  const [proposal, setProposal] = useState<CampaignDmPrivateRun | null>(null);
  const [reviewMode, setReviewMode] = useState<{ mode: "human" | "ai"; revision: number } | null>(null);
  const [bindingChoices, setBindingChoices] = useState<BindingChoices | null>(null);
  const [sceneId, setSceneId] = useState("");
  const [evidenceChoice, setEvidenceChoice] = useState("");
  const [bindingReview, setBindingReview] = useState<{ operation: Extract<Operation, { kind: "binding" }>; scene: string; evidence: string } | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);
  const modeBusyRef = useRef(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const readGeneration = useRef(0);
  const savedOperation = useRef<string | null>(null);
  const savedModeOperation = useRef<string | null>(null);
  const callbacks = useRef({ onHistory, onStateChange }); callbacks.current = { onHistory, onStateChange };
  const gm = canAct && ["owner", "gm"].includes(bootstrap.principal.role);
  const allowed = canAct && bootstrap.principal.role !== "observer" && bootstrap.session.active && bootstrap.session.adventureEligible;
  const authority = useRef({ gm, allowed, blocked }); authority.current = { gm, allowed, blocked };
  const mode = history?.control.mode ?? bootstrap.dm?.mode;
  const active = history?.runs.find(run => !terminal(run));
  const locked = invalid || readUnavailable || !history || busy || modeBusy || !!operation || !!modeOperation || !!reviewMode || !!bindingReview || !!active;
  useEffect(() => { onLockChange(locked); }, [locked, onLockChange]);
  useEffect(() => () => onLockChange(false), [onLockChange]);
  useEffect(() => { if (!gm) { setBindingChoices(null); setBindingReview(null); setSceneId(""); setEvidenceChoice(""); } }, [gm]);

  function persist(value: Operation | null) {
    if (localStorage.getItem(key) !== savedOperation.current) { setInvalid(true); throw new Error("Another tab changed recovery state"); }
    if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key);
    if (localStorage.getItem(key) !== (value ? JSON.stringify(value) : null)) throw new Error("Recovery storage unavailable");
    savedOperation.current = value ? JSON.stringify(value) : null;
    setOperation(value);
  }
  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current;
    try {
    const value = await api.getCampaignDmHistory(campaignId, sessionId);
    if (!alive.current || generation !== readGeneration.current) return;
    setHistory(value); callbacks.current.onHistory(value);
    setProposal(null);
    const saved = localStorage.getItem(key);
    if (saved) {
      const pending = operationSchema.parse(JSON.parse(saved));
      if (pending.kind === "run") {
        const run = await api.getCampaignDmRun(campaignId, sessionId, pending.runId);
        if (!alive.current || generation !== readGeneration.current) return;
        if (terminal(run)) {
          if (localStorage.getItem(key) !== saved) throw new Error("Recovery state changed during refresh");
          localStorage.removeItem(key); savedOperation.current = null; setOperation(null); callbacks.current.onStateChange();
        }
      }
    }
    const approval = value.runs.find(run => run.state === "awaiting-approval");
    if (approval && authority.current.gm) {
      const privateRun = await api.getCampaignDmProposal(campaignId, sessionId, approval.runId);
      if (alive.current && generation === readGeneration.current && authority.current.gm) setProposal(privateRun);
    }
    if (alive.current && generation === readGeneration.current) setReadUnavailable(false);
    } catch (error) {
      if (alive.current && generation === readGeneration.current) setReadUnavailable(true);
      throw error;
    }
  }, [api, campaignId, sessionId, key]);
  useEffect(() => {
    alive.current = true;
    try {
      const saved = localStorage.getItem(key), savedMode = localStorage.getItem(modeKey);
      savedOperation.current = saved; savedModeOperation.current = savedMode;
      setOperation(saved ? operationSchema.parse(JSON.parse(saved)) : null);
      setModeOperation(savedMode ? campaignDmModeRequestSchema.parse(JSON.parse(savedMode)) : null);
    } catch { setInvalid(true); }
    const read = () => { if (document.visibilityState !== "hidden" && !busyRef.current) void refresh().catch(() => {
      if (alive.current) setNotice("DM state could not be refreshed. No command was repeated. Refresh before continuing.");
    }); };
    const storageChanged = (event: StorageEvent) => { if (event.key === key || event.key === modeKey || event.key === null) { setInvalid(true); setNotice("Another tab changed director recovery state. Reload to reconcile the saved operation before sending commands."); } };
    read(); const timer = window.setInterval(read, 15_000);
    window.addEventListener("storage", storageChanged);
    window.addEventListener("focus", read); document.addEventListener("visibilitychange", read);
    return () => { alive.current = false; readGeneration.current++; window.clearInterval(timer); window.removeEventListener("storage", storageChanged); window.removeEventListener("focus", read); document.removeEventListener("visibilitychange", read); };
  }, [refresh, key, modeKey, gm]);

  async function execute(next: Operation) {
    if (!authority.current.allowed || authority.current.blocked || invalid || busyRef.current || modeBusyRef.current || modeOperation || reviewMode || (bindingReview && next.kind !== "binding") || ((next.kind === "decision" || next.kind === "binding") && !authority.current.gm) || (next.kind === "beat" && mode !== "ai" && !authority.current.gm)) return;
    busyRef.current = true; setBusy(true); setNotice(""); readGeneration.current++;
    try {
      persist(next);
      if (next.kind === "binding") {
        await api.commandCampaignDmSceneBinding(campaignId, next.request);
        if (!alive.current) return;
        persist(null); setBindingReview(null); setBindingChoices(null);
        callbacks.current.onStateChange();
        setNotice("Scene evidence binding confirmed. Nothing was resolved or revealed, and no provider was called. Request Continue scene explicitly when the evidence qualifies.");
        return;
      }
      const run = next.kind === "beat" ? await api.commandCampaignDmBeat(campaignId, sessionId, next.request)
        : next.kind === "decision" ? await api.commandCampaignDmDecision(campaignId, sessionId, next.runId, next.request)
          : await api.resumeCampaignDmRun(campaignId, sessionId, next.runId);
      if (!alive.current) return;
      persist({ kind: "run", runId: run.runId });
      setProposal(null);
      await refresh(); callbacks.current.onStateChange();
      setNotice(run.state === "unknown" ? "Outcome unknown. Read this run to reconcile; do not request another paid beat." : "Server run recorded. Refresh reads state only; continuation requires an explicit action.");
    } catch {
      if (alive.current) setNotice("Outcome uncertain or rejected. The exact request is retained. Refresh is read-only; recovery never creates a replacement beat key.");
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function prepareBinding(review: boolean) {
    if (!authority.current.gm || !authority.current.allowed || authority.current.blocked || locked || busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try {
      const [story, quests, encounters] = await Promise.all([api.getBindingStory(campaignId), api.getBindingQuests(campaignId), api.listCampaignEncounters(campaignId)]);
      if (!alive.current || !authority.current.gm || !authority.current.allowed || authority.current.blocked) return;
      const choices: BindingChoices = { revision: story.revision,
        scenes: story.data.nodes.filter(node => node.status !== "resolved").map(node => ({ id: node.nodeId, label: `${story.data.storylines.find(line => line.storylineId === node.storylineId)?.title ?? "Story"}: ${node.title}` })),
        evidence: [
          ...quests.data.objectives.filter(objective => quests.data.quests.some(quest => quest.questId === objective.questId)).map(objective => ({ kind: "quest-objective" as const, id: objective.objectiveId, label: `Quest: ${quests.data.quests.find(quest => quest.questId === objective.questId)!.title} / ${objective.description}` })),
          ...encounters.encounters.filter(encounter => encounter.sessionId === sessionId).map(encounter => ({ kind: "encounter" as const, id: encounter.encounterId, label: `Encounter: ${encounter.name} (${encounter.status})` })),
        ] };
      setBindingChoices(choices);
      if (review) {
        const scene = choices.scenes.find(choice => choice.id === sceneId);
        const evidence = choices.evidence.find(choice => `${choice.kind}:${choice.id}` === evidenceChoice);
        if (!scene || !evidence) throw new Error("Selected preparation is no longer available");
        setBindingReview({ scene: scene.label, evidence: evidence.label, operation: { kind: "binding", request: {
          nodeId: scene.id, evidence: { kind: evidence.kind, targetId: evidence.id }, expectedStoryRevision: choices.revision, idempotencyKey: createClientId(),
        } } });
      }
    } catch { if (alive.current) { setBindingChoices(null); setNotice("Scene preparation could not be verified. Reload authorized choices and review again; no command was sent."); } }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function changeMode(recover = false) {
    if (!authority.current.gm || invalid || modeBusyRef.current || (!recover && !reviewMode)) return;
    modeBusyRef.current = true; setModeBusy(true); readGeneration.current++;
    try {
      const request = recover ? modeOperation! : { mode: reviewMode!.mode, expectedRevision: reviewMode!.revision, idempotencyKey: createClientId() };
      if (localStorage.getItem(modeKey) !== savedModeOperation.current) { setInvalid(true); throw new Error("Another mode operation is pending"); }
      localStorage.setItem(modeKey, JSON.stringify(request));
      if (localStorage.getItem(modeKey) !== JSON.stringify(request)) throw new Error("Recovery storage unavailable");
      savedModeOperation.current = JSON.stringify(request);
      setModeOperation(request);
      await api.commandCampaignDmMode(campaignId, request);
      if (!alive.current) return;
      if (localStorage.getItem(modeKey) !== JSON.stringify(request)) { setInvalid(true); throw new Error("Mode recovery record changed"); }
      localStorage.removeItem(modeKey); savedModeOperation.current = null; setModeOperation(null); setReviewMode(null);
      await refresh(); callbacks.current.onStateChange();
      setNotice("DM mode confirmed. No provider call was requested. Committed mechanics are not undone.");
    } catch { if (alive.current) setNotice("Mode outcome uncertain. Recover the identical mode request; no provider call is made by changing mode."); }
    finally { modeBusyRef.current = false; if (alive.current) setModeBusy(false); }
  }
  const canBeat = allowed && !blocked && !locked && (gm || mode === "ai");
  const opened = history?.runs.some(run => run.intent === "open" && run.state === "completed");
  return <section className="campaign-dm-panel" aria-label="Campaign director controls">
    <p className="atlas-kicker">WHO RUNS THE TABLE?</p>
    <h3>{mode === "human" ? "Human DM" : mode === "ai" ? "AI DM / no human DM" : "DM status unavailable"}</h3>
    <p>Both modes use the configured provider. Each scene request is one bounded beat with at most two provider calls: planning and narration, not continuous autoplay. Safety and legal transitions remain server-controlled.</p>
    <button type="button" disabled={busy} onClick={() => void refresh().catch(() => setNotice("DM refresh unavailable. No POST was sent."))}>Refresh DM state</button>
    {gm && <div className="button-row">
      <button type="button" disabled={!history || busy || invalid || !!modeOperation || mode === "ai" || blocked || !!active || !!operation || !!bindingReview} onClick={() => setReviewMode({ mode: "ai", revision: history!.control.revision })}>Review AI delegation</button>
      <button type="button" disabled={!history || modeBusy || invalid || !!modeOperation || mode === "human"} onClick={() => setReviewMode({ mode: "human", revision: history!.control.revision })}>Take over</button>
    </div>}
    {reviewMode && gm && <section aria-label="Review DM mode" className="dm-review">
      <h4>{reviewMode.mode === "ai" ? "Delegate to AI DM?" : "Take over as human DM?"}</h4>
      <p>{reviewMode.mode === "ai" ? "The server may execute supported encounter and reveal transitions without a human proposal approval. Players may request a bounded beat. This does not delegate player choices or bypass safety." : "Revoke AI direction. Pending work must reconcile at its server boundary; already committed changes remain. This does not cancel a paid call already in flight."}</p>
      <p>Reviewed mode revision {reviewMode.revision}.</p>
      <button type="button" disabled={modeBusy || !!modeOperation} onClick={() => void changeMode()}>Confirm {reviewMode.mode === "ai" ? "AI delegation" : "human takeover"}</button>
      <button type="button" disabled={modeBusy || !!modeOperation} onClick={() => setReviewMode(null)}>Cancel mode review</button>
    </section>}
    {modeOperation && gm && <button type="button" disabled={modeBusy || invalid} onClick={() => void changeMode(true)}>Recover exact mode request</button>}
    {gm && <details><summary>Prepare scene resolution (GM only)</summary>
      <p>Link a named scene to evidence you judge sufficient to finish it. The server still requires qualifying committed evidence and legal story dependencies. This authors a rule; it does not complete an objective, end an encounter, resolve a scene, or reveal secrets.</p>
      <button type="button" disabled={blocked || locked || !allowed} onClick={() => void prepareBinding(false)}>Load scene preparation choices</button>
      {bindingChoices && !bindingReview && <fieldset disabled={blocked || locked || !allowed}>
        <label>Scene<select value={sceneId} onChange={event => setSceneId(event.target.value)}><option value="">Choose a scene</option>{bindingChoices.scenes.map(scene => <option key={scene.id} value={scene.id}>{scene.label}</option>)}</select></label>
        <label>Resolution evidence<select value={evidenceChoice} onChange={event => setEvidenceChoice(event.target.value)}><option value="">Choose an objective or room encounter</option>{bindingChoices.evidence.map(evidence => <option key={`${evidence.kind}:${evidence.id}`} value={`${evidence.kind}:${evidence.id}`}>{evidence.label}</option>)}</select></label>
        {(!bindingChoices.scenes.length || !bindingChoices.evidence.length) && <p>No eligible scene or evidence choices. Prepare public scene content and quest objectives or a room encounter first.</p>}
        <button type="button" disabled={!sceneId || !evidenceChoice} onClick={() => void prepareBinding(true)}>Review scene binding</button>
      </fieldset>}
      {bindingReview && !operation && <section className="dm-review" aria-label="Review scene binding"><h4>{bindingReview.scene}</h4><p>{bindingReview.evidence}</p>
        <p>{bindingReview.operation.request.evidence.kind === "quest-objective" ? "The objective must be completed, with matching committed evidence accepted by the server." : "The encounter must be completed, with matching committed evidence accepted by the server."} Only this linked evidence can qualify this scene for resolution; unrelated successes do not count. Public scene content must exist separately from GM-only notes.</p>
        <p>Fresh story revision: {bindingReview.operation.request.expectedStoryRevision}. Confirm only if this evidence really resolves the scene.</p>
        <button type="button" disabled={busy || modeBusy || blocked || invalid || !!modeOperation || !!reviewMode || !allowed} onClick={() => void execute(bindingReview.operation)}>Confirm scene binding</button>
        <button type="button" disabled={busy} onClick={() => setBindingReview(null)}>Cancel binding review</button>
      </section>}
    </details>}
    <h4>{mode === "human" ? "Request a suggestion" : "Direct the next beat"}</h4>
    <p>{mode === "human" ? "Only an owner or GM can request and privately approve a suggestion. A proposal is not committed mechanics." : "No human DM is required. Request one beat; the server selects only supported legal transitions."} Requests may use the paid configured provider. Opening never submits a fake player declaration.</p>
    <div className="button-row">
      <button type="button" disabled={!canBeat || !!opened} onClick={() => void execute({ kind: "beat", request: { intent: "open", expectedModeRevision: history!.control.revision, idempotencyKey: createClientId() } })}>Open scene</button>
      <button type="button" disabled={!canBeat || !opened} onClick={() => void execute({ kind: "beat", request: { intent: "continue", expectedModeRevision: history!.control.revision, idempotencyKey: createClientId(), ...(evidenceTurnId ? { evidenceTurnId } : {}) } })}>Continue scene</button>
    </div>
    {blocked && <p>Finish the other room operation before requesting or approving a beat. Human takeover remains available.</p>}
    {!allowed && <p>This room is read-only or not eligible for director commands. Check publication, active room, and finalized participants.</p>}
    {invalid && <p role="alert">Recovery storage is unreadable. Commands are locked; restore the saved record rather than creating a new request.</p>}
    {readUnavailable && <p role="status">Authoritative DM readiness is loading or unavailable. Beat commands remain locked until a successful refresh.</p>}
    {active && <p role="status">Director run: {active.state}. {active.state === "unknown" ? "An outcome is unknown. Refresh only; do not repeat a paid call." : "Other room commands wait for this run to finish."}</p>}
    {proposal && gm && proposal.run.state === "awaiting-approval" && proposal.proposal && <section className="dm-review" aria-label="Private DM proposal">
      <h4>GM-only proposal</h4><p>{proposal.proposal.label}</p><p>Action: {proposal.proposal.action}. Reviewed run revision {proposal.run.revision}.</p>
      {(["approved", "rejected"] as const).map(decision => <button key={decision} type="button" disabled={busy || modeBusy || !!modeOperation || !!reviewMode || blocked || invalid || !allowed || (!!operation && operation.kind !== "run")} onClick={() => void execute({ kind: "decision", runId: proposal.run.runId, request: { decision, expectedRevision: proposal.run.revision, idempotencyKey: createClientId() } })}>{decision === "approved" ? "Approve exact proposal" : "Reject proposal"}</button>)}
    </section>}
    {operation && operation.kind !== "run" && <div className="dm-review"><p>An exact {operation.kind} request has no confirmed response. Its original key is retained across reloads. {operation.kind === "binding" ? "Scene binding recovery never calls the provider. Refresh cannot confirm this write; recover only the saved identical request." : "Recovery may contact the provider only through the server's identical-request recovery."}</p><button type="button" disabled={busy || blocked || invalid || !allowed || ((operation.kind === "decision" || operation.kind === "binding") && !gm)} onClick={() => void execute(operation)}>Recover exact DM request</button></div>}
    {active?.state === "planning" && (!operation || operation.kind === "run") && <button type="button" disabled={busy || blocked || invalid || !allowed || (mode === "human" && !gm)} onClick={() => void execute({ kind: "run", runId: active.runId })}>Resume saved run</button>}
    {history?.runs.flatMap(run => run.blockers.map((reason, index) => <p className="dm-blocker" key={`${run.runId}:${index}`}>{reason === "scene-resolution-requires-gm-binding-or-human-adjudication"
      ? "Scene resolution needs GM preparation: ask the GM to prepare an evidence binding in Director, or take over and adjudicate the scene manually. An unrelated success cannot resolve a scene."
      : reason === "story-public-rendering-required"
        ? "This scene needs publishable public story content. Ask the GM to author a public rendering separately from private notes; do not reveal secrets to remove this blocker."
        : `Preparation needed: ${reason}. Review room participants, starting location, accepted preparation, and encounter/story readiness. Refresh does not generate content.`}</p>))}
    {notice && <p role="status">{notice}</p>}
  </section>;
}

export function CampaignDmChronicle({ history }: { history: CampaignDmHistory | null }) {
  return <section className="dm-chronicle" aria-label="DM chronicle"><h3>From the DM</h3>
    {!history && <p>Loading director history...</p>}
    {history && !history.runs.some(run => run.narration) && <p>No narrated scene yet. Open Director to request the opening.</p>}
    {history?.runs.filter(run => run.narration).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(run => <article key={run.runId}><h4>{run.intent === "open" ? "Opening scene" : "Scene continuation"}</h4><p>{run.narration}</p>{run.receipts.map((receipt, index) => <small key={index}>Committed: {receipt.summary}</small>)}</article>)}
  </section>;
}
