import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CampaignContentDraftView, CampaignCreateResponse, CampaignContentGenerationRequest } from "@velvet/contracts";
import {
  applyCampaignContentDraft,
  createCampaign,
  createCampaignContentDraft,
  getCampaignContentDraft,
  getCampaignGeneratedFoundation,
  getCampaignGeneratedPlanning,
  setupSrd51Starter,
} from "../../../api";
import { createClientId } from "../../../utils/clientId";
import { reconcileWorldbuildingGeneration } from "./worldbuildingRecoveryApi";
import "./worldbuilding-agent.css";
import {
  WorldbuildingPlanError,
  acceptedPublicArtifactKeys,
  artifactKeysFromPreview,
  buildDefaultPlan,
  composeStageBrief,
  coverageIssues,
  worldLinkIssues,
  labelForSections,
  parseWorldbuildingPlan,
  resolveExpansionKeys,
  type WorldbuildingPlan,
  type WorldbuildingSection,
  type WorldbuildingStagePlan,
} from "./worldbuildingPlan";

type StageStatus = "pending" | "generating" | "applying" | "applied" | "failed" | "uncertain";
type WorldbuildingMode = "prompt" | "advanced";

interface ApplyRetryIntent {
  draftId: string;
  expectedRevision: number;
  selectedArtifactKeys: string[];
  idempotencyKey: string;
}

interface RunStage {
  id: string;
  label: string;
  sections: WorldbuildingSection[];
  brief: string;
  tone: string;
  exclusions: string[];
  desiredCounts: Record<string, number>;
  expandFrom: WorldbuildingStagePlan["expandFrom"];
  status: StageStatus;
  validationIssues: string[];
  artifactKeys: string[];
  publicKeys: Record<string, string[]>;
  error: string | null;
  applyIntent: ApplyRetryIntent | null;
  generationKey: string;
  generationIntent?: CampaignContentGenerationRequest;
  draftId?: string;
  failedAttempt?: number;
  canRevise?: boolean;
}

interface SavedRun {
  version: 1;
  campaignId: string | null;
  prompt: string;
  mode: WorldbuildingMode;
  stages: RunStage[];
  starterPending: boolean;
  creationPending: boolean;
  createdResult?: CampaignCreateResponse;
}

function restoreRun(key: string, interrupted = true): SavedRun | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as SavedRun | null;
    if (saved?.version !== 1 || typeof saved.prompt !== "string" || !Array.isArray(saved.stages)
      || saved.stages.some((stage) => !stage || typeof stage.id !== "string" || !Array.isArray(stage.sections) || !stage.publicKeys || !stage.desiredCounts || !stage.generationKey)) return null;
    if (!interrupted) return saved;
    return { ...saved, stages: saved.stages.map((stage) => ({ ...stage,
      status: stage.status === "applying" ? "uncertain" : stage.status === "generating" ? "failed" : stage.status,
      error: ["applying", "generating"].includes(stage.status) ? "Interrupted request. Reconcile or explicitly retry the retained request before continuing." : stage.error,
    })) };
  } catch { return null; }
}

export interface WorldbuildingAgentApi {
  createCampaign: typeof createCampaign;
  setupSrd51Starter: typeof setupSrd51Starter;
  createCampaignContentDraft: typeof createCampaignContentDraft;
  getCampaignContentDraft: typeof getCampaignContentDraft;
  applyCampaignContentDraft: typeof applyCampaignContentDraft;
  getCampaignGeneratedFoundation: typeof getCampaignGeneratedFoundation;
  getCampaignGeneratedPlanning: typeof getCampaignGeneratedPlanning;
  reconcileWorldbuildingGeneration: typeof reconcileWorldbuildingGeneration;
}

const defaultApi: WorldbuildingAgentApi = {
  createCampaign,
  setupSrd51Starter,
  createCampaignContentDraft,
  getCampaignContentDraft,
  applyCampaignContentDraft,
  getCampaignGeneratedFoundation,
  getCampaignGeneratedPlanning,
  reconcileWorldbuildingGeneration,
};

export interface WorldbuildingAgentPanelProps {
  campaignId?: string;
  initialCampaignName?: string;
  api?: WorldbuildingAgentApi;
  onCampaignCreated?: (result: CampaignCreateResponse) => void;
  onManageWorld?: (campaignId: string) => void;
  onStartPlaying?: (campaignId: string) => void;
}

const STATUS_LABEL: Record<StageStatus, string> = {
  pending: "Pending",
  generating: "Generating…",
  applying: "Applying…",
  applied: "Applied",
  failed: "Failed",
  uncertain: "Apply unconfirmed",
};

const ADVANCED_EXAMPLE = JSON.stringify({
  tone: "dark mystery with hopeful choices",
  exclusions: ["graphic torture"],
  stages: [
    { id: "factions", sections: ["factions"], brief: "Create four competing factions with usable tensions.", desiredCounts: { factions: 4 } },
    {
      id: "locations", sections: ["locations"], brief: "Create six public places with outward and return routes, tied to the accepted factions.", desiredCounts: { locations: 6, connections: 10 },
      expandFrom: [{ stageId: "factions", fields: ["factions"], limit: 4 }],
    },
    {
      id: "cast", sections: ["npcs"], brief: "Create the cast with exact accepted locationKey and factionKeys references.", desiredCounts: { npcs: 6 },
      expandFrom: [{ stageId: "locations", fields: ["locations"], limit: 6 }, { stageId: "factions", fields: ["factions"], limit: 4 }],
    },
  ],
}, null, 2);

function parseExclusions(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed";
}

export function WorldbuildingAgentPanel({ campaignId, initialCampaignName = "", api = defaultApi, onCampaignCreated, onManageWorld, onStartPlaying }: WorldbuildingAgentPanelProps) {
  const storageKey = `velvet-worldbuilding-v1:${campaignId ?? "new"}`;
  const [saved] = useState(() => restoreRun(storageKey));
  const [mode, setMode] = useState<WorldbuildingMode>(saved?.mode ?? "prompt");
  const [premise, setPremise] = useState(saved?.prompt ?? "");
  const [tone, setTone] = useState("adventurous and grounded");
  const [exclusions, setExclusions] = useState("");
  const [campaignName, setCampaignName] = useState(saved?.createdResult?.campaign.name ?? initialCampaignName);
  const [advancedJson, setAdvancedJson] = useState(ADVANCED_EXAMPLE);
  const [planError, setPlanError] = useState("");
  const [stages, setStages] = useState<RunStage[]>(saved?.stages ?? []);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resolvedCampaignId, setResolvedCampaignId] = useState(saved?.campaignId ?? campaignId ?? "");
  const [acceptedSummary, setAcceptedSummary] = useState<{ foundation: boolean; materials: number } | null>(null);

  const stagesRef = useRef<RunStage[]>(saved?.stages ?? []);
  const acceptedRef = useRef<Record<string, Record<string, string[]>>>(Object.fromEntries((saved?.stages ?? []).filter((stage) => stage.status === "applied").map((stage) => [stage.id, stage.publicKeys])));
  const campaignIdRef = useRef<string | null>(saved?.campaignId ?? campaignId ?? null);
  const runLock = useRef(false);
  const promptRef = useRef(saved?.prompt ?? "");
  const starterPending = useRef(saved?.starterPending ?? false);
  const creationPending = useRef(saved?.creationPending ?? false);
  const createdResult = useRef(saved?.createdResult);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function writeJournal(value: SavedRun): void {
    sessionStorage.setItem(storageKey, JSON.stringify(value));
    if (value.campaignId) sessionStorage.setItem(`velvet-worldbuilding-v1:${value.campaignId}`, JSON.stringify(value));
  }

  function persist(): void {
    const value: SavedRun = { version: 1, campaignId: campaignIdRef.current, prompt: promptRef.current, mode, stages: stagesRef.current, starterPending: starterPending.current, creationPending: creationPending.current, createdResult: createdResult.current };
    // Write before dispatch. If browser storage fails, do not start an unrecoverable mutation.
    if (!mounted.current) {
      // A newly mounted panel may already own a newer snapshot. Preserve its stage progress.
      const current = restoreRun(storageKey, false);
      if (!current || current.stages[0]?.generationKey !== value.stages[0]?.generationKey) return;
      writeJournal({ ...current, campaignId: value.campaignId, starterPending: value.starterPending, creationPending: value.creationPending, createdResult: value.createdResult });
      return;
    }
    writeJournal(value);
  }

  function setStagesBoth(next: RunStage[]): void {
    stagesRef.current = next;
    setStages(next);
    persist();
  }

  function patchStage(id: string, patch: Partial<RunStage>): void {
    if (!mounted.current) {
      const original = stagesRef.current.find((stage) => stage.id === id);
      const current = restoreRun(storageKey, false);
      if (!original || !current) return;
      // Late responses may record their own result, but must never replace a remount's whole run.
      const next = current.stages.map((stage) => stage.generationKey === original.generationKey && stage.status !== "applied" && (original.applyIntent || !stage.applyIntent) ? { ...stage, ...patch } : stage);
      writeJournal({ ...current, stages: next });
      return;
    }
    setStagesBoth(stagesRef.current.map((stage) => (stage.id === id ? { ...stage, ...patch } : stage)));
  }

  useEffect(() => {
    let cancelled = false;
    // Reconcile known in-flight applies with read-only calls on reload; never redispatch generation.
    for (const stage of saved?.stages ?? []) {
      if (stage.status === "failed" && stage.generationIntent && !stage.draftId) {
        void api.reconcileWorldbuildingGeneration(stage.generationIntent).then((result) => {
          if (cancelled || runLock.current) return;
          if (result.state === "succeeded" && result.draftId) patchStage(stage.id, { draftId: result.draftId, error: "Generated draft recovered. Reconcile draft to validate and apply it." });
          else if (result.state === "failed") patchStage(stage.id, { failedAttempt: result.attempt, error: "The server confirmed a failed generation attempt. Retrying authorizes another paid attempt with the same intent." });
          else if (result.state !== "not-found") patchStage(stage.id, { error: `Generation is ${result.state}. Reconcile again later; no paid retry will be dispatched.` });
        }).catch(() => { /* Explicit reconciliation remains available. */ });
      }
      if (stage.status !== "uncertain" || !stage.applyIntent) continue;
      void api.getCampaignContentDraft(stage.applyIntent.draftId).then((current) => {
        if (cancelled || runLock.current || current.draft.campaignId !== campaignIdRef.current || current.draft.state !== "applied") return;
        if (coverageIssues(current.preview, stage.desiredCounts).length) return;
        acceptedRef.current[stage.id] = stage.publicKeys;
        patchStage(stage.id, { status: "applied", applyIntent: null, error: null });
      }).catch(() => { /* The explicit exact-apply recovery remains available. */ });
    }
    return () => { cancelled = true; };
  }, [api, saved]);

  function toRunStage(stage: WorldbuildingStagePlan, plan: WorldbuildingPlan): RunStage {
    return {
      id: stage.id,
      label: stage.label || labelForSections(stage.sections),
      sections: [...stage.sections],
      brief: stage.brief,
      tone: stage.tone ?? plan.tone,
      exclusions: stage.exclusions ?? plan.exclusions,
      desiredCounts: stage.desiredCounts,
      expandFrom: stage.expandFrom,
      status: "pending",
      validationIssues: [],
      artifactKeys: [],
      publicKeys: {},
      error: null,
      applyIntent: null,
      generationKey: createClientId(),
    };
  }

  function loadPlan(plan: WorldbuildingPlan): void {
    acceptedRef.current = {};
    setStagesBoth(plan.stages.map((stage) => toRunStage(stage, plan)));
  }

  function switchMode(next: WorldbuildingMode): void {
    if (running || next === mode) return;
    setMode(next);
    setPlanError("");
    setError("");
    setNotice("");
    setStagesBoth([]);
  }

  async function ensureCampaign(promptForName: string): Promise<string | null> {
    if (!mounted.current) return null;
    if (campaignIdRef.current) {
      if (starterPending.current) {
        await api.setupSrd51Starter(campaignIdRef.current);
        starterPending.current = false;
        persist();
        if (!mounted.current) return null;
        if (createdResult.current) onCampaignCreated?.(createdResult.current);
      }
      return campaignIdRef.current;
    }
    if (creationPending.current) throw new Error("Campaign creation was interrupted. Check the campaign library and open the created campaign before continuing; creation cannot safely be repeated.");
    const provided = campaignName.trim();
    const derived = promptForName.trim() ? `Worldbuilding: ${promptForName.trim().slice(0, 80)}` : "";
    const name = provided || derived;
    if (!name) {
      setError("A campaign name is required when creating a new campaign.");
      return null;
    }
    try {
      creationPending.current = true;
      persist();
      const created = await api.createCampaign({ name });
      createdResult.current = created;
      const id = created.campaign.id;
      campaignIdRef.current = id;
      creationPending.current = false;
      starterPending.current = true;
      persist();
      if (!mounted.current) return null;
      setResolvedCampaignId(id);
      await api.setupSrd51Starter(id);
      starterPending.current = false;
      persist();
      if (!mounted.current) return null;
      onCampaignCreated?.(created);
      return id;
    } catch (cause) {
      setError(`Campaign creation or SRD 5.1 starter setup failed: ${messageOf(cause)}. No world stage was dispatched.`);
      return null;
    }
  }

  async function applyStageWithIntent(stageId: string, intent: ApplyRetryIntent): Promise<boolean> {
    if (!mounted.current) return false;
    try {
      const stage = stagesRef.current.find((item) => item.id === stageId);
      if (stage?.status === "uncertain") {
        const current = await api.getCampaignContentDraft(intent.draftId);
        if (current.draft.campaignId !== campaignIdRef.current) throw new Error("Draft campaign mismatch");
        if (current.draft.state === "applied") {
          acceptedRef.current[stageId] = stage.publicKeys;
          patchStage(stageId, { status: "applied", applyIntent: null, error: null });
          return mounted.current;
        }
        if (!mounted.current) return false;
        if (current.draft.revision !== intent.expectedRevision) throw new Error("Draft revision changed; manage the retained draft before retrying");
      }
      await api.applyCampaignContentDraft(intent.draftId, {
        expectedRevision: intent.expectedRevision,
        idempotencyKey: intent.idempotencyKey,
        selectedArtifactKeys: intent.selectedArtifactKeys,
      });
    } catch (cause) {
      if (!mounted.current) {
        patchStage(stageId, { status: "uncertain", error: "Apply interrupted by navigation. Reconcile the retained apply before continuing." });
        return false;
      }
      let applied = false;
      try {
        const current = await api.getCampaignContentDraft(intent.draftId);
        applied = current.draft.campaignId === campaignIdRef.current && current.draft.state === "applied";
      } catch {
        // The authoritative draft state could not be read; keep the outcome uncertain.
      }
      if (!applied) {
        patchStage(stageId, {
          status: "uncertain",
          error: `Apply outcome could not be confirmed: ${messageOf(cause)}. The exact selection and idempotency key are retained; retry only after review.`,
        });
        return false;
      }
    }
    const stage = stagesRef.current.find((item) => item.id === stageId);
    if (stage) acceptedRef.current[stageId] = stage.publicKeys;
    patchStage(stageId, { status: "applied", applyIntent: null, error: null });
    return mounted.current;
  }

  async function runStage(stageId: string, prompt: string): Promise<boolean> {
    if (!mounted.current) return false;
    const campaign = campaignIdRef.current;
    const stage = stagesRef.current.find((item) => item.id === stageId);
    if (!campaign || !stage || stage.status === "applied") return true;
    if (stage.applyIntent) return applyStageWithIntent(stageId, stage.applyIntent);
    if (stage.expandFrom?.some((selector) => stagesRef.current.find((source) => source.id === selector.stageId)?.status !== "applied")) {
      patchStage(stageId, { status: "failed", error: "Apply the earlier dependency stages before running this stage." });
      return false;
    }
    const brief = composeStageBrief(prompt, stage);
    if (brief.length > 2_000) {
      patchStage(stageId, { status: "failed", error: "The composed brief exceeds the 2000-character limit. Shorten the premise or the stage brief." });
      return false;
    }
    const expandArtifactKeys = resolveExpansionKeys(stage, acceptedRef.current);
    let generationIntent = stage.generationIntent ?? {
      campaignId: campaign, brief, tone: stage.tone, exclusions: stage.exclusions,
      sections: stage.sections, desiredCounts: stage.desiredCounts, expandArtifactKeys,
      revisionFeedback: null, retryFailedAttempt: null, idempotencyKey: stage.generationKey,
    };
    let recoveredDraftId = stage.draftId;
    if (stage.generationIntent && !recoveredDraftId) {
      try {
        const recovery = await api.reconcileWorldbuildingGeneration(stage.generationIntent);
        if (!mounted.current) {
          if (recovery.draftId) patchStage(stageId, { draftId: recovery.draftId, status: "failed", error: "Draft recovered after navigation. Reconcile draft to continue." });
          return false;
        }
        if (recovery.state === "succeeded" && recovery.draftId) recoveredDraftId = recovery.draftId;
        else if (recovery.state === "failed") {
          if (stage.failedAttempt !== recovery.attempt) {
            patchStage(stageId, { status: "failed", failedAttempt: recovery.attempt, error: "The server confirmed a failed generation attempt. Retrying authorizes another paid attempt with the same intent." });
            return false;
          }
          generationIntent = { ...stage.generationIntent, retryFailedAttempt: { failedAttempt: recovery.attempt } };
        } else if (recovery.state !== "not-found") {
          patchStage(stageId, { status: "failed", error: `Generation is ${recovery.state}. Reconcile again later; no paid retry was dispatched.` });
          return false;
        }
      } catch (cause) {
        patchStage(stageId, { status: "failed", error: messageOf(cause) });
        return false;
      }
    }
    patchStage(stageId, { status: "generating", generationIntent, error: null, validationIssues: [] });
    let draft: CampaignContentDraftView;
    try {
      draft = recoveredDraftId ? await api.getCampaignContentDraft(recoveredDraftId) : await api.createCampaignContentDraft(generationIntent);
    } catch (cause) {
      patchStage(stageId, { status: "failed", error: `Generation failed: ${messageOf(cause)}. The stage was not retried automatically.` });
      return false;
    }
    if (draft.draft.campaignId !== campaign) {
      patchStage(stageId, { status: "failed", error: "The draft response did not match this campaign." });
      return false;
    }
    const artifactKeys = artifactKeysFromPreview(draft.preview);
    const publicKeys = acceptedPublicArtifactKeys(draft.preview);
    const missing = [...coverageIssues(draft.preview, stage.desiredCounts), ...(mode === "prompt" ? worldLinkIssues(draft.preview, acceptedRef.current) : [])];
    patchStage(stageId, { draftId: draft.draft.draftId, validationIssues: [...draft.validationIssues, ...missing], artifactKeys, publicKeys });
    if (missing.length) {
      patchStage(stageId, { status: "failed", canRevise: draft.draft.state !== "applied", error: "Requested coverage or world links were not met. Generate a revised stage to request a new paid candidate with this feedback; accepted stages are preserved." });
      return false;
    }
    if (draft.draft.state === "applied") {
      acceptedRef.current[stageId] = publicKeys;
      patchStage(stageId, { status: "applied", applyIntent: null });
      return mounted.current;
    }
    if (!mounted.current) {
      patchStage(stageId, { status: "failed", error: "Generation finished after navigation. The draft is saved; reconcile it before continuing." });
      return false;
    }
    if (artifactKeys.length === 0) {
      patchStage(stageId, { status: "failed", error: "The candidate contained no selectable artifacts." });
      return false;
    }
    if (artifactKeys.length > 128) {
      patchStage(stageId, { status: "failed", error: "The candidate exceeded the 128-artifact apply limit." });
      return false;
    }
    const applyIntent: ApplyRetryIntent = {
      draftId: draft.draft.draftId,
      expectedRevision: draft.draft.revision,
      selectedArtifactKeys: artifactKeys,
      idempotencyKey: `${stage.generationKey}-apply`,
    };
    patchStage(stageId, { status: "applying", applyIntent });
    return applyStageWithIntent(stageId, applyIntent);
  }

  async function refreshAccepted(): Promise<void> {
    const id = campaignIdRef.current;
    if (!id) return;
    try {
      const [foundation, planning] = await Promise.all([api.getCampaignGeneratedFoundation(id), api.getCampaignGeneratedPlanning(id)]);
      if (!mounted.current || campaignIdRef.current !== id) return;
      setAcceptedSummary({
        foundation: Boolean(foundation.opening),
        materials: planning.encounters.length + planning.lore.length + planning.questItems.length + planning.monsterConcepts.length + planning.deliverables.length,
      });
    } catch {
      setAcceptedSummary(null);
    }
  }

  async function runStages(stageIds: string[], prompt: string): Promise<void> {
    if (runLock.current) return;
    runLock.current = true;
    setRunning(true);
    setError("");
    setNotice("");
    try {
      const campaign = await ensureCampaign(prompt);
      if (!campaign || !mounted.current) return;
      for (const stageId of stageIds) {
        if (!mounted.current) return;
        const stage = stagesRef.current.find((item) => item.id === stageId);
        if (!stage || stage.status === "applied") continue;
        if (stage.status !== "pending") {
          setNotice("Build paused. Reconcile or explicitly retry the interrupted stage, then resume the remaining stages.");
          return;
        }
        const succeeded = await runStage(stageId, prompt);
        if (!succeeded) {
          setNotice("");
          return;
        }
      }
      if (stagesRef.current.every((stage) => stage.status === "applied")) setNotice("World build completed: every planned stage met its coverage targets and was applied.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      runLock.current = false;
      setRunning(false);
      if (mounted.current) void refreshAccepted();
    }
  }

  function buildFromPrompt(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (running) return;
    const prompt = premise.trim();
    if (!prompt) {
      setError("Describe the premise before building the world.");
      return;
    }
    const exclusionsValue = parseExclusions(exclusions);
    if (exclusionsValue.length > 16 || exclusionsValue.some((item) => item.length > 200)) {
      setError("Use no more than 16 exclusions of 200 characters each.");
      return;
    }
    const plan = buildDefaultPlan(tone, exclusionsValue);
    if (plan.tone.length > 200 || plan.stages.some((stage) => composeStageBrief(prompt, stage).length > 2_000)) {
      setError("Shorten the premise (including stage instructions, the limit is 2000 characters) and keep the tone under 200 characters.");
      return;
    }
    promptRef.current = prompt;
    setError("");
    try { loadPlan(plan); } catch (cause) { setError(`Could not save recoverable progress: ${messageOf(cause)}`); return; }
    void runStages(plan.stages.map((stage) => stage.id), prompt);
  }

  function validateAdvancedPlan(): void {
    setPlanError("");
    setError("");
    setNotice("");
    let parsed: unknown;
    try {
      parsed = JSON.parse(advancedJson);
    } catch {
      setPlanError("Plan JSON could not be parsed.");
      setStagesBoth([]);
      return;
    }
    try {
      const plan = parseWorldbuildingPlan(parsed);
      loadPlan(plan);
      setNotice(`Plan loaded with ${plan.stages.length} stage${plan.stages.length === 1 ? "" : "s"}. Run stages individually or run every stage.`);
    } catch (cause) {
      setStagesBoth([]);
      setPlanError(cause instanceof WorldbuildingPlanError ? cause.message : "The plan did not match the expected shape.");
    }
  }

  function runOne(stageId: string): void {
    if (runLock.current) return;
    runLock.current = true;
    setRunning(true);
    void (async () => {
      try {
        if (await ensureCampaign(promptRef.current)) await runStage(stageId, promptRef.current);
      } catch (cause) { setError(messageOf(cause)); }
      finally { runLock.current = false; setRunning(false); }
    })();
  }

  function runAllAdvanced(): void {
    void runStages(stagesRef.current.map((stage) => stage.id), "");
  }

  function retryApply(stage: RunStage): void {
    if (!stage.applyIntent || running || runLock.current) return;
    runLock.current = true;
    setError("");
    setRunning(true);
    void (async () => {
      try {
        const recovered = await applyStageWithIntent(stage.id, stage.applyIntent!);
        if (recovered) setNotice("The retained apply was confirmed.");
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        runLock.current = false;
        setRunning(false);
      }
    })();
  }

  async function generateRevisedStage(stage: RunStage): Promise<void> {
    const current = stagesRef.current.find((item) => item.id === stage.id);
    if (!mounted.current || runLock.current || !current?.canRevise || current.status !== "failed" || !current.draftId || current.applyIntent || !current.generationIntent) return;
    const generationKey = createClientId();
    runLock.current = true;
    setRunning(true);
    try {
      const latest = await api.getCampaignContentDraft(current.draftId);
      if (!mounted.current) return;
      if (latest.draft.campaignId !== campaignIdRef.current) throw new Error("Draft campaign mismatch");
      if (latest.draft.state === "applied") {
        patchStage(current.id, { canRevise: false, error: "This candidate was already applied. Manage its accepted content before continuing; no revised generation was dispatched." });
        return;
      }
      patchStage(current.id, {
        status: "pending", generationKey, draftId: undefined, failedAttempt: undefined,
        canRevise: false, applyIntent: null, artifactKeys: [], publicKeys: {}, error: null,
        generationIntent: {
          ...current.generationIntent, idempotencyKey: generationKey, retryFailedAttempt: null,
          revisionFeedback: current.validationIssues.join("\n").slice(0, 2_000),
        },
        validationIssues: [],
      });
      await runStage(current.id, promptRef.current);
    } catch (cause) { setError(messageOf(cause)); }
    finally { runLock.current = false; if (mounted.current) setRunning(false); }
  }

  const appliedCount = stages.filter((stage) => stage.status === "applied").length;

  function buildAnotherWorld(): void {
    if (runLock.current || !stagesRef.current.length || stagesRef.current.some((stage) => stage.status !== "applied")) return;
    // Preserve the completed campaign journal; only the library's new-world composer is cleared.
    persist();
    if (!campaignId) sessionStorage.removeItem(storageKey);
    stagesRef.current = [];
    acceptedRef.current = {};
    campaignIdRef.current = campaignId ?? null;
    promptRef.current = "";
    starterPending.current = false;
    creationPending.current = false;
    createdResult.current = undefined;
    setStages([]);
    setResolvedCampaignId(campaignId ?? "");
    setPremise("");
    setCampaignName(initialCampaignName);
    setTone("adventurous and grounded");
    setExclusions("");
    setMode("prompt");
    setAdvancedJson(ADVANCED_EXAMPLE);
    setPlanError("");
    setError("");
    setNotice("");
    setAcceptedSummary(null);
  }

  return (
    <section className="admin-section worldbuilding-panel" aria-labelledby="worldbuilding-agent-heading">
      <div className="admin-section-heading">
        <div>
          <p className="eyebrow">PROMPT TO WORLD</p>
          <h3 id="worldbuilding-agent-heading">Worldbuilding agent</h3>
        </div>
        {resolvedCampaignId ? <span className="status-pill" title={resolvedCampaignId}>{createdResult.current?.campaign.name ?? "Campaign connected"}</span> : null}
      </div>
      <p>Build a connected world from one prompt: places, factions, characters, lore, special items, enemies, quests, and scenes. Build world authorizes generation and application of all listed stages. Progress is saved in this browser tab; interrupted requests wait for your explicit retry.</p>
      <p>Items and monsters are narrative concepts unless bound to a pinned rules catalog. Completing the world prepares campaign content; playing also requires room, character, and startup setup.</p>

      <fieldset className="worldbuilding-mode" disabled={running || stages.length > 0}>
        <legend>Worldbuilding mode</legend>
        <label>
          <input type="radio" name="worldbuilding-mode" checked={mode === "prompt"} onChange={() => switchMode("prompt")} /> Prompt mode
        </label>
        <label>
          <input type="radio" name="worldbuilding-mode" checked={mode === "advanced"} onChange={() => switchMode("advanced")} /> Advanced mode
        </label>
      </fieldset>

      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}

      {!campaignId ? (
        <label htmlFor="worldbuilding-campaign-name">Campaign name
          <input id="worldbuilding-campaign-name" value={campaignName} disabled={running || Boolean(resolvedCampaignId)} onChange={(event) => setCampaignName(event.target.value)} />
        </label>
      ) : null}

      {mode === "prompt" ? (
        <form className="worldbuilding-form" onSubmit={buildFromPrompt}>
          <label htmlFor="worldbuilding-premise">Premise or description
            <textarea id="worldbuilding-premise" rows={5} value={premise} disabled={running || stages.length > 0} onChange={(event) => setPremise(event.target.value)} />
          </label>
          <label htmlFor="worldbuilding-tone">Tone
            <input id="worldbuilding-tone" value={tone} disabled={running} onChange={(event) => setTone(event.target.value)} />
          </label>
          <label htmlFor="worldbuilding-exclusions">Exclusions (comma separated)
            <input id="worldbuilding-exclusions" value={exclusions} disabled={running} onChange={(event) => setExclusions(event.target.value)} />
          </label>
          <button type="submit" className="primary" disabled={running || stages.length > 0 || !premise.trim()}>{running ? "Building world…" : "Build world"}</button>
        </form>
      ) : (
        <div>
          <label htmlFor="worldbuilding-plan-json">Plan JSON
            <textarea id="worldbuilding-plan-json" rows={12} value={advancedJson} disabled={running} onChange={(event) => setAdvancedJson(event.target.value)} />
          </label>
          {planError ? <p role="alert">{planError}</p> : null}
          <div className="worldbuilding-actions">
            <button type="button" onClick={validateAdvancedPlan} disabled={running || stages.length > 0}>Validate plan</button>
            <button type="button" onClick={runAllAdvanced} disabled={running || stages.length === 0}>Run all stages</button>
          </div>
        </div>
      )}

      {stages.length > 0 ? (
        <section className="worldbuilding-progress" aria-label="Worldbuilding progress">
          <h4>Progress: {appliedCount} of {stages.length} stages applied</h4>
          <progress aria-label="World stages applied" value={appliedCount} max={stages.length} />
          <p role="status">{running ? "Working through the stages in order…" : appliedCount === stages.length ? "World content prepared. Manage its details or prepare to play." : "Progress saved. Resume pending stages or recover the interrupted stage below."}</p>
          <div className="worldbuilding-actions"><button type="button" disabled={running || appliedCount === stages.length} onClick={() => void runStages(stagesRef.current.map((stage) => stage.id), promptRef.current)}>Resume world build</button>
          {appliedCount === stages.length ? <button type="button" disabled={running} onClick={buildAnotherWorld}>Build another world</button> : null}
          </div>
          <ol>
            {stages.map((stage) => (
              <li key={stage.id} data-status={stage.status}>
                <strong>{stage.label}</strong>
                <small>{stage.sections.join(", ")}</small>
                <span>{STATUS_LABEL[stage.status]}</span>
                {stage.validationIssues.length > 0 ? (
                  <ul aria-label={`${stage.label} validation issues`}>
                    {stage.validationIssues.map((issue) => <li key={issue}>{issue}</li>)}
                  </ul>
                ) : null}
                {stage.error ? <p role="alert">{stage.error}</p> : null}
                <div>
                  <button type="button" onClick={() => runOne(stage.id)} disabled={running || stage.status === "applied" || stage.status === "uncertain" || stage.status === "generating" || stage.status === "applying"}>{stage.status === "failed" ? stage.draftId ? "Reconcile draft" : stage.failedAttempt ? "Retry paid generation" : "Reconcile generation" : "Run stage"}</button>
                  {stage.status === "uncertain" && stage.applyIntent ? (
                    <button type="button" onClick={() => retryApply(stage)} disabled={running}>Retry exact apply</button>
                  ) : null}
                  {stage.canRevise && stage.status === "failed" && stage.draftId && !stage.applyIntent ? (
                    <button type="button" onClick={() => generateRevisedStage(stage)} disabled={running}>Generate revised stage</button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="worldbuilding-actions worldbuilding-handoff">
        {resolvedCampaignId && onManageWorld ? <button type="button" disabled={running} onClick={() => onManageWorld(resolvedCampaignId)}>Manage world</button> : null}
        {resolvedCampaignId && onStartPlaying ? <button type="button" className="primary" disabled={running || !stages.length || appliedCount !== stages.length} onClick={() => onStartPlaying(resolvedCampaignId)}>Prepare to play</button> : null}
        <button type="button" onClick={() => void refreshAccepted()} disabled={running || !resolvedCampaignId}>Refresh accepted content</button>
        {acceptedSummary ? (
          <p role="status">Accepted: {acceptedSummary.foundation ? "foundation outline present" : "no foundation outline"}; {acceptedSummary.materials} generated planning material{acceptedSummary.materials === 1 ? "" : "s"}.</p>
        ) : null}
      </div>
    </section>
  );
}
