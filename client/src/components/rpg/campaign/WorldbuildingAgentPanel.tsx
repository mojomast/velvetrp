import { useRef, useState, type FormEvent } from "react";
import type { CampaignContentDraftView, CampaignCreateResponse } from "@velvet/contracts";
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
import {
  WorldbuildingPlanError,
  acceptedPublicArtifactKeys,
  artifactKeysFromPreview,
  buildDefaultPlan,
  composeStageBrief,
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
}

export interface WorldbuildingAgentApi {
  createCampaign: typeof createCampaign;
  setupSrd51Starter: typeof setupSrd51Starter;
  createCampaignContentDraft: typeof createCampaignContentDraft;
  getCampaignContentDraft: typeof getCampaignContentDraft;
  applyCampaignContentDraft: typeof applyCampaignContentDraft;
  getCampaignGeneratedFoundation: typeof getCampaignGeneratedFoundation;
  getCampaignGeneratedPlanning: typeof getCampaignGeneratedPlanning;
}

const defaultApi: WorldbuildingAgentApi = {
  createCampaign,
  setupSrd51Starter,
  createCampaignContentDraft,
  getCampaignContentDraft,
  applyCampaignContentDraft,
  getCampaignGeneratedFoundation,
  getCampaignGeneratedPlanning,
};

export interface WorldbuildingAgentPanelProps {
  campaignId?: string;
  initialCampaignName?: string;
  api?: WorldbuildingAgentApi;
  onCampaignCreated?: (result: CampaignCreateResponse) => void;
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
      id: "cast", sections: ["npcs"], brief: "Create the cast tied to those factions.", desiredCounts: { npcs: 6 },
      expandFrom: [{ stageId: "factions", fields: ["factions"], limit: 4 }],
    },
  ],
}, null, 2);

function parseExclusions(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed";
}

export function WorldbuildingAgentPanel({ campaignId, initialCampaignName = "", api = defaultApi, onCampaignCreated }: WorldbuildingAgentPanelProps) {
  const [mode, setMode] = useState<WorldbuildingMode>("prompt");
  const [premise, setPremise] = useState("");
  const [tone, setTone] = useState("adventurous and grounded");
  const [exclusions, setExclusions] = useState("");
  const [campaignName, setCampaignName] = useState(initialCampaignName);
  const [advancedJson, setAdvancedJson] = useState(ADVANCED_EXAMPLE);
  const [planError, setPlanError] = useState("");
  const [stages, setStages] = useState<RunStage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [resolvedCampaignId, setResolvedCampaignId] = useState(campaignId ?? "");
  const [acceptedSummary, setAcceptedSummary] = useState<{ foundation: boolean; materials: number } | null>(null);

  const stagesRef = useRef<RunStage[]>([]);
  const acceptedRef = useRef<Record<string, Record<string, string[]>>>({});
  const campaignIdRef = useRef<string | null>(campaignId ?? null);
  const runLock = useRef(false);

  function setStagesBoth(next: RunStage[]): void {
    stagesRef.current = next;
    setStages(next);
  }

  function patchStage(id: string, patch: Partial<RunStage>): void {
    setStagesBoth(stagesRef.current.map((stage) => (stage.id === id ? { ...stage, ...patch } : stage)));
  }

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
    if (campaignIdRef.current) return campaignIdRef.current;
    const provided = campaignName.trim();
    const derived = promptForName.trim() ? `Worldbuilding: ${promptForName.trim().slice(0, 80)}` : "";
    const name = provided || derived;
    if (!name) {
      setError("A campaign name is required when creating a new campaign.");
      return null;
    }
    try {
      const created = await api.createCampaign({ name });
      const id = created.campaign.id;
      campaignIdRef.current = id;
      setResolvedCampaignId(id);
      onCampaignCreated?.(created);
      await api.setupSrd51Starter(id);
      return id;
    } catch (cause) {
      setError(`Campaign creation or SRD 5.1 starter setup failed: ${messageOf(cause)}. No world stage was dispatched.`);
      return null;
    }
  }

  async function applyStageWithIntent(stageId: string, intent: ApplyRetryIntent): Promise<boolean> {
    try {
      await api.applyCampaignContentDraft(intent.draftId, {
        expectedRevision: intent.expectedRevision,
        idempotencyKey: intent.idempotencyKey,
        selectedArtifactKeys: intent.selectedArtifactKeys,
      });
    } catch (cause) {
      let applied = false;
      try {
        const current = await api.getCampaignContentDraft(intent.draftId);
        applied = current.draft.state === "applied";
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
    return true;
  }

  async function runStage(stageId: string, prompt: string): Promise<boolean> {
    const campaign = campaignIdRef.current;
    const stage = stagesRef.current.find((item) => item.id === stageId);
    if (!campaign || !stage || stage.status === "applied") return true;
    const brief = composeStageBrief(prompt, stage);
    if (brief.length > 2_000) {
      patchStage(stageId, { status: "failed", error: "The composed brief exceeds the 2000-character limit. Shorten the premise or the stage brief." });
      return false;
    }
    const expandArtifactKeys = resolveExpansionKeys(stage, acceptedRef.current);
    patchStage(stageId, { status: "generating", error: null, validationIssues: [] });
    let draft: CampaignContentDraftView;
    try {
      draft = await api.createCampaignContentDraft({
        campaignId: campaign,
        brief,
        tone: stage.tone,
        exclusions: stage.exclusions,
        sections: stage.sections,
        expandArtifactKeys,
        revisionFeedback: null,
        retryFailedAttempt: null,
        idempotencyKey: stage.generationKey,
      });
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
    patchStage(stageId, { validationIssues: [...draft.validationIssues], artifactKeys, publicKeys });
    if (draft.draft.state === "applied") {
      acceptedRef.current[stageId] = publicKeys;
      patchStage(stageId, { status: "applied", applyIntent: null });
      return true;
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
      if (!campaign) return;
      for (const stageId of stageIds) {
        const stage = stagesRef.current.find((item) => item.id === stageId);
        if (!stage || stage.status === "applied") continue;
        const succeeded = await runStage(stageId, prompt);
        if (!succeeded) {
          setNotice("");
          return;
        }
      }
      setNotice("World build completed: every planned stage was generated and applied once.");
    } finally {
      runLock.current = false;
      setRunning(false);
      void refreshAccepted();
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
    setError("");
    loadPlan(plan);
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
    void runStages([stageId], mode === "prompt" ? premise.trim() : "");
  }

  function runAllAdvanced(): void {
    void runStages(stagesRef.current.map((stage) => stage.id), "");
  }

  function retryApply(stage: RunStage): void {
    if (!stage.applyIntent || running) return;
    setError("");
    setRunning(true);
    void (async () => {
      try {
        const recovered = await applyStageWithIntent(stage.id, stage.applyIntent!);
        if (recovered) setNotice("The retained apply was confirmed.");
      } finally {
        setRunning(false);
      }
    })();
  }

  const appliedCount = stages.filter((stage) => stage.status === "applied").length;

  return (
    <section className="admin-section" aria-labelledby="worldbuilding-agent-heading">
      <div className="admin-section-heading">
        <div>
          <p className="eyebrow">CLIENT-SIDE ORCHESTRATION</p>
          <h3 id="worldbuilding-agent-heading">Worldbuilding agent</h3>
        </div>
        {resolvedCampaignId ? <span className="status-pill">{resolvedCampaignId}</span> : null}
      </div>
      <p>Hydrate a reviewed campaign world from a short brief by running the existing campaign-content endpoints in bounded stages. No apply is ever retried automatically.</p>

      <fieldset disabled={running}>
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

      {mode === "prompt" ? (
        <form onSubmit={buildFromPrompt}>
          {!campaignId ? (
            <label htmlFor="worldbuilding-campaign-name">Campaign name
              <input id="worldbuilding-campaign-name" value={campaignName} disabled={running} onChange={(event) => setCampaignName(event.target.value)} />
            </label>
          ) : null}
          <label htmlFor="worldbuilding-premise">Premise or description
            <textarea id="worldbuilding-premise" rows={5} value={premise} disabled={running} onChange={(event) => setPremise(event.target.value)} />
          </label>
          <label htmlFor="worldbuilding-tone">Tone
            <input id="worldbuilding-tone" value={tone} disabled={running} onChange={(event) => setTone(event.target.value)} />
          </label>
          <label htmlFor="worldbuilding-exclusions">Exclusions (comma separated)
            <input id="worldbuilding-exclusions" value={exclusions} disabled={running} onChange={(event) => setExclusions(event.target.value)} />
          </label>
          <button type="submit" disabled={running || !premise.trim()}>{running ? "Building world…" : "Build world"}</button>
        </form>
      ) : (
        <div>
          <label htmlFor="worldbuilding-plan-json">Plan JSON
            <textarea id="worldbuilding-plan-json" rows={12} value={advancedJson} disabled={running} onChange={(event) => setAdvancedJson(event.target.value)} />
          </label>
          {planError ? <p role="alert">{planError}</p> : null}
          <div>
            <button type="button" onClick={validateAdvancedPlan} disabled={running}>Validate plan</button>
            <button type="button" onClick={runAllAdvanced} disabled={running || stages.length === 0}>Run all stages</button>
          </div>
        </div>
      )}

      {stages.length > 0 ? (
        <section aria-label="Worldbuilding progress">
          <h4>Progress: {appliedCount} of {stages.length} stages applied</h4>
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
                  <button type="button" onClick={() => runOne(stage.id)} disabled={running || stage.status === "applied" || stage.status === "generating" || stage.status === "applying"}>Run stage</button>
                  {stage.status === "uncertain" && stage.applyIntent ? (
                    <button type="button" onClick={() => retryApply(stage)} disabled={running}>Retry exact apply</button>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div>
        <button type="button" onClick={() => void refreshAccepted()} disabled={running || !resolvedCampaignId}>Refresh accepted content</button>
        {acceptedSummary ? (
          <p role="status">Accepted: {acceptedSummary.foundation ? "foundation outline present" : "no foundation outline"}; {acceptedSummary.materials} generated planning material{acceptedSummary.materials === 1 ? "" : "s"}.</p>
        ) : null}
      </div>
    </section>
  );
}
