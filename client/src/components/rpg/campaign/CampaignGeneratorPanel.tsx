import { useEffect, useMemo, useRef, useState } from "react";
import { CampaignIntentForm, emptyCampaignIntent, intentBrief } from "../generation/CampaignIntentForm";
import { CampaignCoverage } from "../generation/CampaignCoverage";
import { useCampaignWorkspaceState } from "../generation/useCampaignWorkspaceState";
import { reconcileCampaignGeneration, writeAuthoringField } from "../generation/generationRecovery";
import { CampaignStartingLocationPanel, type StartingLocationCandidate } from "../generation/CampaignStartingLocationPanel";
import { campaignStartingLocationApi, type CampaignStartingLocationApi } from "../generation/campaignStartingLocationApi";
import "../generation/campaign-create.css";
import type {
  CampaignContentDraftView,
  CampaignContentGenerationRequest,
  CampaignGeneratedPlanning,
} from "@velvet/contracts";
import {
  ApiError,
  applyCampaignContentDraft,
  createCampaignContentDraft,
  getCampaignContentDraft,
  getCampaignGeneratedFoundation,
  getCampaignGeneratedPlanning,
  publishCampaignMaterial,
  type CampaignContentApplyInput,
  type CampaignMaterialPublishInput,
} from "../../../api";
import { createClientId } from "../../../utils/clientId";

const sectionOptions = [
  ["outline", "Campaign outline"], ["arcs", "Story arcs"], ["locations", "Locations & routes"],
  ["factions", "Factions"], ["npcs", "NPCs"], ["quests", "Quests"],
  ["encounters", "Encounter concepts"], ["clues", "Clues"], ["story", "Story graph"],
  ["lore", "Campaign lore"], ["quest-items", "Quest items"], ["monster-concepts", "Monster concepts"],
  ["handouts", "Handouts"], ["scene-prompts", "Scene prompts"],
] as const satisfies ReadonlyArray<readonly [CampaignContentGenerationRequest["sections"][number], string]>;

const allSections = sectionOptions.map(([value]) => value);
const foundationSections: CampaignContentGenerationRequest["sections"] = ["outline", "locations", "factions", "npcs", "quests"];
const hydrationSteps: ReadonlyArray<{ id: string; label: string; sections: Section[] }> = [
  { id: "foundation", label: "Foundation and places", sections: ["outline", "arcs", "locations"] },
  { id: "people", label: "People and powers", sections: ["factions", "npcs"] },
  { id: "story", label: "Story and discoveries", sections: ["quests", "clues", "story", "lore"] },
  { id: "challenges", label: "Challenges and rewards", sections: ["encounters", "quest-items", "monster-concepts"] },
  { id: "table", label: "Table materials", sections: ["handouts", "scene-prompts"] },
];
const sectionGroups: ReadonlyArray<readonly [string, readonly Section[]]> = [
  ["Location / world", ["locations"]], ["NPC / faction", ["npcs", "factions"]],
  ["Quest / clue", ["quests", "clues"]], ["Encounter", ["encounters"]],
  ["Story / lore", ["outline", "arcs", "story", "lore"]], ["Items / monsters", ["quest-items", "monster-concepts"]],
  ["Handout", ["handouts"]], ["Scene prompt", ["scene-prompts"]],
];

const focusOptions = [
  ["adventure spine", "A connected premise, opening, and quest arc"],
  ["living world", "Distinct locations and factions with usable tensions"],
  ["memorable cast", "NPCs with clear roles and conflicting goals"],
] as const;

type Section = CampaignContentGenerationRequest["sections"][number];
type Preset = "foundation" | "full" | "custom";
type Preview = CampaignContentDraftView["preview"];
type ArtifactRow = { key: string; kind: string; label: string; summary: string; dependencies: string[]; visibility: "public" | "gm" };
type Foundation = { opening: string; premise: string };

export interface CampaignGeneratorPanelApi extends CampaignStartingLocationApi {
  reconcileCampaignGeneration?: typeof reconcileCampaignGeneration;
  createCampaignContentDraft: typeof createCampaignContentDraft;
  getCampaignContentDraft: typeof getCampaignContentDraft;
  applyCampaignContentDraft: typeof applyCampaignContentDraft;
  getCampaignGeneratedFoundation: typeof getCampaignGeneratedFoundation;
  getCampaignGeneratedPlanning: typeof getCampaignGeneratedPlanning;
  publishCampaignMaterial: typeof publishCampaignMaterial;
}

const defaultApi: CampaignGeneratorPanelApi = {
  createCampaignContentDraft, getCampaignContentDraft, applyCampaignContentDraft, getCampaignGeneratedFoundation,
  getCampaignGeneratedPlanning, publishCampaignMaterial, ...campaignStartingLocationApi,
};

function newKey(kind: string): string {
  return `ui-campaign-${kind}-${createClientId()}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function artifactRows(preview: Preview): Array<{ title: string; description: string; rows: ArtifactRow[] }> {
  const names = new Map([
    ...preview.locations.map((item) => [item.key, item.name] as const),
    ...preview.factions.map((item) => [item.key, item.name] as const),
    ...preview.npcs.map((item) => [item.key, item.name] as const),
    ...preview.storyNodes.map((item) => [item.key, item.title] as const),
  ]);
  const world = [
    ...preview.locations.map((item) => ({ key: item.key, kind: "Location", label: item.name, summary: item.description, dependencies: item.factionKeys, visibility: item.visibility })),
    ...preview.connections.map((item) => ({ key: item.key, kind: "Connection", label: `${names.get(item.fromLocationKey) ?? "Location"} to ${names.get(item.toLocationKey) ?? "location"}`, summary: item.description, dependencies: [item.fromLocationKey, item.toLocationKey], visibility: item.visibility })),
    ...preview.lore.map((item) => ({ key: item.key, kind: "Lore", label: item.title, summary: item.summary, dependencies: [...item.locationKeys, ...item.factionKeys, ...item.storyNodeKeys], visibility: item.visibility })),
  ];
  const cast = [
    ...preview.factions.map((item) => ({ key: item.key, kind: "Faction", label: item.name, summary: item.description, dependencies: [], visibility: item.visibility })),
    ...preview.npcs.map((item) => ({ key: item.key, kind: "NPC", label: item.name, summary: `${item.archetype} · ${item.description}`, dependencies: [...item.factionKeys, ...(item.locationKey ? [item.locationKey] : [])], visibility: item.visibility })),
    ...preview.monsterConcepts.map((item) => ({ key: item.key, kind: item.mechanics.state === "catalog-bound" ? "Rules-bound monster" : "Narrative monster concept", label: item.name, summary: `${item.role} · ${item.description} · ${item.mechanics.state === "catalog-bound" ? "Playable mechanics are pinned" : `Narrative only: ${item.mechanics.reason}`}`, dependencies: [], visibility: item.visibility })),
  ];
  const story = [
    ...preview.outlines.map((item) => ({ key: item.key, kind: "Outline", label: item.opening, summary: item.premise, dependencies: item.startLocationKey ? [item.startLocationKey] : [], visibility: item.visibility })),
    ...preview.arcs.map((item) => ({ key: item.key, kind: "Arc", label: item.title, summary: item.summary, dependencies: [], visibility: item.visibility })),
    ...preview.quests.map((item) => ({ key: item.key, kind: "Quest", label: item.title, summary: `${item.description}${item.objectives.length ? ` · ${item.objectives.length} operational objective${item.objectives.length === 1 ? "" : "s"}` : ""}`, dependencies: [...item.locationKeys, ...(item.arcKey ? [item.arcKey] : [])], visibility: item.visibility })),
    ...preview.clues.map((item) => ({ key: item.key, kind: "Clue", label: item.title, summary: item.description, dependencies: [...(item.locationKey ? [item.locationKey] : []), ...(item.revealsStoryNodeKey ? [item.revealsStoryNodeKey] : [])], visibility: item.visibility })),
    ...preview.storyNodes.map((item) => ({ key: item.key, kind: "Story beat", label: item.title, summary: item.description, dependencies: [], visibility: item.visibility })),
    ...preview.storyRelationships.map((item) => ({ key: item.key, kind: "Story relationship", label: `${names.get(item.fromStoryNodeKey) ?? "Story beat"} to ${names.get(item.toStoryNodeKey) ?? "story beat"}`, summary: item.description, dependencies: [item.fromStoryNodeKey, item.toStoryNodeKey], visibility: item.visibility })),
    ...preview.questItems.map((item) => ({ key: item.key, kind: item.mechanics.state === "catalog-bound" ? "Rules-bound quest item" : "Narrative quest item", label: item.name, summary: `${item.description} · ${item.mechanics.state === "catalog-bound" ? "Playable mechanics are pinned" : `Narrative only: ${item.mechanics.reason}`}`, dependencies: [...item.questKeys, ...item.locationKeys], visibility: item.visibility })),
  ];
  const play = [
    ...preview.encounters.map((item) => ({ key: item.key, kind: "Encounter plan", label: item.title, summary: `${item.description}${item.enemyReferences.length ? ` · ${item.enemyReferences.length} pinned enemy reference${item.enemyReferences.length === 1 ? "" : "s"}` : " · no playable enemy references"}`, dependencies: [...item.participantNpcKeys, ...item.monsterConceptKeys, ...(item.locationKey ? [item.locationKey] : [])], visibility: item.visibility })),
    ...preview.handouts.map((item) => ({ key: item.key, kind: "Handout", label: item.title, summary: item.content, dependencies: [], visibility: item.visibility })),
    ...preview.scenePrompts.map((item) => ({ key: item.key, kind: "Scene prompt", label: item.title, summary: item.prompt, dependencies: [...item.npcKeys, ...(item.locationKey ? [item.locationKey] : [])], visibility: item.visibility })),
  ];
  return [
    { title: "World", description: "Places, routes, and lore", rows: world },
    { title: "Cast", description: "Factions, people, and creatures", rows: cast },
    { title: "Story", description: "Premise, arcs, quests, and clues", rows: story },
    { title: "Play", description: "Encounter plans and table-facing material", rows: play },
  ];
}

interface GenerationIntent { input: CampaignContentGenerationRequest; failedAttempt: number | null; ambiguous: boolean }
interface ApplyIntent { draftId: string; input: CampaignContentApplyInput }
interface PublishIntent { campaignId: string; input: CampaignMaterialPublishInput; title: string }
interface HydrationPlan {
  version: 1;
  currentStep: number;
  completed: Array<{ stepId: string; draftId: string; returnedCount: number; acceptedCount: number }>;
  contextOptions: Array<{ key: string; label: string; kind: string }>;
  contextKeys: string[];
}
type WizardStage = "foundation" | "vision" | "safety" | "scope" | "review" | "candidate" | "ready";
const wizardStages: ReadonlyArray<{ id: WizardStage; label: string }> = [
  { id: "foundation", label: "Foundation" }, { id: "vision", label: "Vision" },
  { id: "safety", label: "Safety" }, { id: "scope", label: "World plan" },
  { id: "review", label: "LLM review" }, { id: "candidate", label: "Candidate" },
  { id: "ready", label: "Next steps" },
];

export function CampaignGeneratorPanel({ campaignId, disabled = false, openDraftId = null, api = defaultApi, onBack }: {
  campaignId: string; disabled?: boolean; openDraftId?: string | null; api?: CampaignGeneratorPanelApi; onBack?: () => void;
}) {
  const workspaceId = onBack ? campaignId : null;
  const [stage, setStage] = useCampaignWorkspaceState<WizardStage>(workspaceId, "stage", "foundation");
  const [answers, setAnswers] = useCampaignWorkspaceState(workspaceId, "answers", emptyCampaignIntent);
  const brief = intentBrief(answers);
  const [reviewed, setReviewed] = useCampaignWorkspaceState(workspaceId, "reviewed", false);
  const [draftCoverage, setDraftCoverage] = useCampaignWorkspaceState<{ draftId: string; sections: Section[] } | null>(workspaceId, "coverage", null);
  const [tone, setTone] = useCampaignWorkspaceState(workspaceId, "tone", "adventurous and grounded");
  const [depth, setDepth] = useCampaignWorkspaceState(workspaceId, "depth", "play-ready");
  const [focus, setFocus] = useCampaignWorkspaceState<string[]>(workspaceId, "focus", focusOptions.map(([value]) => value));
  const [preset, setPreset] = useCampaignWorkspaceState<Preset>(workspaceId, "preset", "foundation");
  const [sections, setSections] = useCampaignWorkspaceState<Section[]>(workspaceId, "sections", foundationSections);
  const [stagedMode, setStagedMode] = useCampaignWorkspaceState(campaignId, "stagedMode", false);
  const [hydrationPlan, setHydrationPlan] = useCampaignWorkspaceState<HydrationPlan | null>(campaignId, "hydrationPlan", null);
  const [exclusions, setExclusions] = useCampaignWorkspaceState(workspaceId, "exclusions", "");
  const [revisionFeedback, setRevisionFeedback] = useCampaignWorkspaceState(workspaceId, "feedback", "");
  const [expandKeys, setExpandKeys] = useCampaignWorkspaceState(workspaceId, "expandKeys", "");
  const [draft, setDraft] = useCampaignWorkspaceState<CampaignContentDraftView | null>(workspaceId, "draft", null);
  const [retainedDraftId, setRetainedDraftId] = useCampaignWorkspaceState<string | null>(campaignId, "draftId", null);
  const [selectedKeys, setSelectedKeys] = useCampaignWorkspaceState<string[]>(workspaceId, "selectedKeys", []);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmed, setConfirmed] = useCampaignWorkspaceState(workspaceId, "confirmed", false);
  const [generationIntent, setGenerationIntent] = useCampaignWorkspaceState<GenerationIntent | null>(campaignId, "generationIntent", null);
  const [applyIntent, setApplyIntent] = useCampaignWorkspaceState<ApplyIntent | null>(campaignId, "applyIntent", null);
  const [publishIntent, setPublishIntent] = useCampaignWorkspaceState<PublishIntent | null>(campaignId, "publishIntent", null);
  const [error, setError] = useCampaignWorkspaceState(workspaceId, "error", "");
  const [notice, setNotice] = useCampaignWorkspaceState(workspaceId, "notice", "");
  const [selectionNotice, setSelectionNotice] = useState("");
  const [foundation, setFoundation] = useState<Foundation | null>(null);
  const [planning, setPlanning] = useState<CampaignGeneratedPlanning | null>(null);
  const [startingCandidates, setStartingCandidates] = useState<StartingLocationCandidate[]>([]);
  const generationLock = useRef(false);

  useEffect(() => {
    if (!workspaceId || (!answers.premise && !draft && !generationIntent && !applyIntent && !publishIntent)) return;
    const warnBeforeReload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeReload);
    return () => window.removeEventListener("beforeunload", warnBeforeReload);
  }, [workspaceId, answers.premise, draft, generationIntent, applyIntent, publishIntent]);

  useEffect(() => {
    let current = true;
    void api.getCampaignGeneratedFoundation(campaignId).then((value) => {
      if (current) setFoundation(value.opening ? { opening: value.opening.opening, premise: value.opening.premise } : null);
    }).catch(() => { if (current) setFoundation(null); });
    void api.getCampaignGeneratedPlanning(campaignId).then((value) => { if (current) setPlanning(value); })
      .catch(() => { if (current) setPlanning(null); });
    return () => { current = false; };
  }, [api, campaignId]);

  useEffect(() => {
    const target=openDraftId??(!draft?retainedDraftId:null);
    if (!target) return;
    let current = true;
    void api.getCampaignContentDraft(target).then((value) => {
      if (!current || value.draft.campaignId !== campaignId || value.draft.draftId !== target) return;
      const keys = artifactRows(value.preview).flatMap((group) => group.rows).map((row) => row.key);
      setDraft(value); setSelectedKeys(keys.length <= 128 ? keys : []);
      if (hydrationPlan) setDraftCoverage({ draftId: value.draft.draftId, sections: [...hydrationSteps[hydrationPlan.currentStep]!.sections] });
      setSelectionNotice(keys.length <= 128 ? "" : "This candidate has more than 128 artifacts. Select a bounded dependency-safe subset to apply.");
      const stagedInProgress = hydrationPlan && hydrationPlan.currentStep < hydrationSteps.length - 1;
      setStage(value.draft.state === "applied" && !stagedInProgress ? "ready" : "candidate");
      setNotice(`Opened exact durable draft ${target}.`); setError("");
    }).catch(() => { if (current) setError("The exact durable draft could not be opened."); });
    return () => { current = false; };
  }, [api, campaignId, openDraftId, retainedDraftId, hydrationPlan]);

  useEffect(() => {
    if (draft?.draft.state !== "applied") { setStartingCandidates([]); return; }
    let current = true;
    void api.getCampaignStartingLocationWorld(campaignId).then((world) => {
      if (!current) return;
      const publicDraftLocations = draft.preview.locations.filter((item) => item.visibility === "public");
      const available = world.visibleLocations.filter((location) => publicDraftLocations.some((candidate) =>
        candidate.name === location.name && candidate.description === location.description));
      setStartingCandidates([...new Map(available.map((item) => [item.locationId, { locationId: item.locationId, name: item.name }])).values()]);
    }).catch(() => { if (current) setStartingCandidates([]); });
    return () => { current = false; };
  }, [api, campaignId, draft]);

  const groups = useMemo(() => draft ? artifactRows(draft.preview) : [], [draft]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const rowByKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
  const exclusionValues = parseList(exclusions);
  const expansionValues = hydrationPlan ? hydrationPlan.contextKeys : parseList(expandKeys);
  const acceptedArtifacts = useMemo(() => planning ? [
    ...planning.encounters.map((item) => ({ key: item.artifactKey, label: item.title, kind: "Encounter plan" })),
    ...planning.lore.map((item) => ({ key: item.artifactKey, label: item.title, kind: "Lore" })),
    ...planning.questItems.map((item) => ({ key: item.artifactKey, label: item.title, kind: "Quest item" })),
    ...planning.monsterConcepts.map((item) => ({ key: item.artifactKey, label: item.title, kind: "Monster concept" })),
    ...planning.deliverables.map((item) => ({ key: item.artifactKey, label: item.title, kind: item.kind === "handout" ? "Handout" : "Scene prompt" })),
  ] : [], [planning]);
  const staged = Boolean(hydrationPlan) || (preset === "full" && stagedMode);
  const unavailableExpansion = !staged && expansionValues.some((key) => !acceptedArtifacts.some((item) => item.key === key));
  const expansionInvalid = expansionValues.length > 16 || expansionValues.some((item) => item.length > 64 || !/^[a-z][a-z0-9-]*$/.test(item));
  const exclusionsInvalid = exclusionValues.length > 16 || exclusionValues.some((item) => item.length > 200);
  const direction = `${brief.trim()}\n\nDetail level: ${depth}. Prioritize: ${focus.join(", ")}. Establish breadth before depth, make every element immediately usable at the table, and keep all elements internally consistent.`;
  const generationFormInvalid = !answers.premise.trim() || direction.length > 2000 || focus.length === 0 || sections.length === 0 || expansionInvalid || unavailableExpansion || exclusionsInvalid;
  const busy = disabled || generating || applying || publishing;
  const activeHydrationStep = hydrationPlan ? hydrationSteps[hydrationPlan.currentStep] : hydrationSteps[0];

  function persistHydrationPlan(next: HydrationPlan | null): void {
    writeAuthoringField(campaignId, "hydrationPlan", next);
    setHydrationPlan(next);
  }

  function toggleFocus(value: string): void {
    setFocus((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function toggleSection(value: Section): void {
    setPreset("custom");
    setSections((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function choosePreset(value: Preset): void {
    setPreset(value);
    if (value === "foundation") setSections([...foundationSections]);
    if (value === "full") setSections([...allSections]);
  }

  function chooseStagedMode(enabled: boolean): void {
    setStagedMode(enabled);
    setSections(enabled ? [...hydrationSteps[0]!.sections] : [...allSections]);
  }

  function toggleHydrationContext(key: string): void {
    if (!hydrationPlan) return;
    const nextKeys = hydrationPlan.contextKeys.includes(key)
      ? hydrationPlan.contextKeys.filter((item) => item !== key)
      : [...hydrationPlan.contextKeys, key];
    if (nextKeys.length > 16) return;
    try { persistHydrationPlan({ ...hydrationPlan, contextKeys: nextKeys }); }
    catch { setError("Browser recovery storage is unavailable. The staged context selection was not changed."); }
  }

  function toggleExpansion(key: string): void {
    const next = expansionValues.includes(key) ? expansionValues.filter((item) => item !== key) : [...expansionValues, key];
    if (next.length <= 16) setExpandKeys(next.join(","));
  }

  function toggleArtifact(row: ArtifactRow): void {
    setSelectionNotice("");
    setConfirmed(false);
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (!next.has(row.key)) {
        const add = (key: string) => {
          if (next.has(key)) return;
          next.add(key);
          rowByKey.get(key)?.dependencies.forEach(add);
        };
        add(row.key);
        if (next.size > 128) {
          setSelectionNotice("This dependency closure would exceed the 128-artifact apply limit. Deselect other candidates first.");
          return current;
        }
        return rows.filter((item) => next.has(item.key)).map((item) => item.key);
      }
      const removed = new Set([row.key]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of rows) {
          if (!removed.has(candidate.key) && candidate.dependencies.some((dependency) => removed.has(dependency))) {
            removed.add(candidate.key); changed = true;
          }
        }
      }
      removed.forEach((key) => next.delete(key));
      if (removed.size > 1) setSelectionNotice(`Deselected ${removed.size - 1} dependent candidate${removed.size === 2 ? "" : "s"} to keep the selection resolvable.`);
      return rows.filter((item) => next.has(item.key)).map((item) => item.key);
    });
  }

  async function submitGeneration(intent: GenerationIntent, acknowledgement: number | null): Promise<void> {
    if (generationLock.current || generating || applying) return;
    generationLock.current = true;
    const submitted: GenerationIntent = { ...intent, input: { ...intent.input, retryFailedAttempt: acknowledgement === null ? null : { failedAttempt: acknowledgement } } };
    try { setGenerationIntent(submitted); } catch { generationLock.current = false; setError("Browser recovery storage is unavailable. No generation request was sent."); return; }
    setGenerating(true); setError(""); setNotice(""); setConfirmed(false);
    try {
      const result = await api.createCampaignContentDraft(submitted.input);
      setDraft(result);
      setRetainedDraftId(result.draft.draftId);
      setStage("candidate");
      setDraftCoverage({ draftId: result.draft.draftId, sections: [...submitted.input.sections] });
      setReviewed(false);
      const candidateRows = artifactRows(result.preview).flatMap((group) => group.rows);
      setSelectedKeys(candidateRows.length <= 128 ? candidateRows.map((row) => row.key) : []);
      setSelectionNotice(candidateRows.length <= 128 ? "" : "This candidate has more than 128 artifacts. Select a bounded dependency-safe subset to apply.");
      setGenerationIntent(null);
      setNotice("A new candidate is ready. Nothing has been added to the campaign yet.");
    } catch (generationError) {
      const failedExplicitly = generationError instanceof ApiError
        && generationError.status === 503 && generationError.code === "RPG_GENERATION_UNAVAILABLE";
      if (failedExplicitly) {
        const attempted = acknowledgement ?? 0;
        try { setGenerationIntent({ ...submitted, failedAttempt: attempted + 1, ambiguous: false }); } catch { /* The pre-dispatch exact intent remains in storage. */ }
        setError(`Generation attempt ${attempted + 1} failed explicitly. It will not be replayed unless you acknowledge and retry it.`);
      } else {
        try { setGenerationIntent({ ...submitted, failedAttempt: null, ambiguous: true }); } catch { /* The pre-dispatch exact intent remains in storage. */ }
        setError("The generation response is uncertain. The exact request and idempotency key are retained; reconcile or explicitly retry it before starting a new intent.");
      }
    } finally { generationLock.current = false; setGenerating(false); }
  }

  function generate(): void {
    if (!reviewed || generationFormInvalid || generationIntent) return;
    let plan = hydrationPlan;
    if (preset === "full" && stagedMode && !plan) {
      plan = { version: 1, currentStep: 0, completed: [], contextOptions: [], contextKeys: [] };
      try { persistHydrationPlan(plan); }
      catch { setError("Browser recovery storage is unavailable. No staged generation request was sent."); return; }
    }
    const input: CampaignContentGenerationRequest = {
      campaignId, brief: direction, tone, exclusions: exclusionValues, sections: plan ? hydrationSteps[plan.currentStep]!.sections : sections,
      expandArtifactKeys: plan ? plan.contextKeys : expansionValues, revisionFeedback: revisionFeedback.trim() || null,
      retryFailedAttempt: null, idempotencyKey: newKey("generate"),
    };
    void submitGeneration({ input, failedAttempt: null, ambiguous: false }, null);
  }

  async function reconcileGeneration(): Promise<void> {
    if(!generationIntent || busy)return;
    setGenerating(true);
    try {
      const result=await (api.reconcileCampaignGeneration??reconcileCampaignGeneration)(generationIntent.input);
      if(result.state==="succeeded" && result.draftId){
        const restored=await api.getCampaignContentDraft(result.draftId);
        if(restored.draft.campaignId!==campaignId||restored.draft.draftId!==result.draftId)throw new Error("Draft binding mismatch");
        setDraft(restored);setRetainedDraftId(restored.draft.draftId);setDraftCoverage({draftId:restored.draft.draftId,sections:[...generationIntent.input.sections]});setStage("candidate");setSelectedKeys([]);setConfirmed(false);setGenerationIntent(null);
        setNotice("Recovered the durable candidate. Review and select material before applying.");setError("");
      }else{
        const terminal=result.state==="failed"||result.state==="outcome-uncertain";
        setGenerationIntent({...generationIntent,failedAttempt:terminal&&result.attempt<32?result.attempt:null,ambiguous:result.state!=="failed"});
        setError(result.state==="outcome-uncertain"?"Provider outcome is uncertain after ownership expired. It may have charged. Another paid call requires explicit attempt acknowledgement.":`Authoritative generation state: ${result.state}. No provider was called during reconciliation.`);
      }
    }catch{setError("Reconciliation could not be confirmed. The exact intent remains retained; no provider call was dispatched.");}
    finally{setGenerating(false);}
  }

  async function submitApply(intent: ApplyIntent): Promise<void> {
    if (applying || generating) return;
    try { setApplyIntent(intent); } catch { setError("Browser recovery storage is unavailable. No apply request was sent."); return; }
    setApplying(true); setError(""); setNotice("");
    try {
      const result = await api.applyCampaignContentDraft(intent.draftId, intent.input);
      setDraft((current) => current ? { ...current, draft: result.draft } : current);
      const outline = draft?.preview.outlines.find((item) => intent.input.selectedArtifactKeys.includes(item.key));
      if (outline) setFoundation({ opening: outline.opening, premise: outline.premise });
      setConfirmed(false);
      if (hydrationPlan) {
        const step = hydrationSteps[hydrationPlan.currentStep]!;
        const publicAccepted = rows.filter((row) => row.visibility === "public" && intent.input.selectedArtifactKeys.includes(row.key))
          .map(({ key, label, kind }) => ({ key, label, kind }));
        const options = [...new Map([...hydrationPlan.contextOptions, ...publicAccepted].map((item) => [item.key, item])).values()];
        const completed = hydrationPlan.completed.some((item) => item.stepId === step.id) ? hydrationPlan.completed : [...hydrationPlan.completed, {
          stepId: step.id, draftId: result.draft.draftId, returnedCount: rows.length, acceptedCount: intent.input.selectedArtifactKeys.length,
        }];
        try { persistHydrationPlan({ ...hydrationPlan, completed, contextOptions: options }); }
        catch { setError("The apply succeeded, but staged recovery progress could not be saved. Do not generate the next request until storage is available."); return; }
        setStage(hydrationPlan.currentStep === hydrationSteps.length - 1 ? "ready" : "candidate");
        setNotice(hydrationPlan.currentStep === hydrationSteps.length - 1
          ? "The final staged candidate was applied. Coverage is complete; playable readiness still requires separate review."
          : "This candidate was applied once. Choose named public context, then explicitly review the next request.");
      } else {
        setStage("ready");
        setNotice("The selected campaign material was applied once. Planning and publication remain explicit.");
      }
      setApplyIntent(null);
      try { setPlanning(await api.getCampaignGeneratedPlanning(campaignId)); } catch { /* The apply receipt is already authoritative. */ }
    } catch (applyError) {
      setError(`${errorMessage(applyError, "The apply response is uncertain.")} The exact selection and idempotency key are retained; no automatic replay was attempted.`);
    } finally { setApplying(false); }
  }

  function apply(): void {
    if (!draft || !confirmed || selectedKeys.length === 0 || draft.draft.state !== "staged" || applyIntent) return;
    void submitApply({ draftId: draft.draft.draftId, input: {
      expectedRevision: draft.draft.revision, idempotencyKey: newKey("apply"), selectedArtifactKeys: selectedKeys,
    } });
  }

  function proceedToNextHydrationRequest(): void {
    if (!hydrationPlan || generationIntent || applyIntent || busy) return;
    const current = hydrationSteps[hydrationPlan.currentStep];
    if (!current || !hydrationPlan.completed.some((item) => item.stepId === current.id) || hydrationPlan.currentStep >= hydrationSteps.length - 1) return;
    const next = { ...hydrationPlan, currentStep: hydrationPlan.currentStep + 1 };
    try { persistHydrationPlan(next); }
    catch { setError("Browser recovery storage is unavailable. The next staged request was not opened."); return; }
    setRetainedDraftId(null); setDraft(null); setSections([...hydrationSteps[next.currentStep]!.sections]); setSelectedKeys([]); setConfirmed(false); setReviewed(true); setStage("review"); setError("");
    setNotice("Review the next bounded request. Continuing here has not contacted the provider.");
  }

  async function submitPublication(intent: PublishIntent): Promise<void> {
    if (publishing || applying) return;
    try { setPublishIntent(intent); } catch { setError("Browser recovery storage is unavailable. No publication request was sent."); return; }
    setPublishing(true); setError(""); setNotice("");
    try {
      const result = await api.publishCampaignMaterial(intent.campaignId, intent.input);
      setPlanning((current) => current ? {
        ...current, deliveryRevision: result.receipt.revisionAfter,
        deliverables: current.deliverables.map((item) => item.artifactKey === result.material.artifactKey ? { ...item, publishedAt: result.material.publishedAt } : item),
      } : current);
      setPublishIntent(null);
      setNotice("Public material was explicitly delivered to campaign readers.");
      try { setPlanning(await api.getCampaignGeneratedPlanning(campaignId)); } catch { /* Keep the confirmed publication projection above. */ }
    } catch (publishError) {
      setError(`${errorMessage(publishError, "The publication response is uncertain.")} The exact publication intent is retained; no automatic replay was attempted.`);
    } finally { setPublishing(false); }
  }

  function publish(artifactKey: string, title: string): void {
    if (!planning || publishIntent) return;
    void submitPublication({ campaignId, title, input: {
      artifactKey, expectedRevision: planning.deliveryRevision, idempotencyKey: newKey("publish"),
    } });
  }

  const planningCount = acceptedArtifacts.length;
  const currentIndex = wizardStages.findIndex((item) => item.id === stage);
  const canOpenStage = (candidate: WizardStage): boolean => {
    const index = wizardStages.findIndex((item) => item.id === candidate);
    if (index <= currentIndex || candidate === "foundation" || candidate === "vision") return true;
    if ((candidate === "safety" || candidate === "scope") && answers.premise.trim()) return true;
    if (candidate === "review") return reviewed && !generationFormInvalid;
    if (candidate === "candidate") return Boolean(draft);
    return candidate === "ready" && draft?.draft.state === "applied";
  };

  return <section className="admin-section campaign-generator campaign-create-flow" data-testid="campaign-create-flow" data-stage={stage} aria-labelledby="campaign-generator-heading">
    <div className="campaign-wizard-topline">{onBack && <button type="button" disabled={generating || applying || publishing || Boolean(generationIntent || applyIntent || publishIntent)} onClick={onBack}>Back to campaign</button>}<small>Answers and recovery intents survive a reload in this tab. A provider is contacted only when you explicitly check capability or generate.</small></div>
    <nav className="campaign-wizard-progress" aria-label="Worldbuilding stages"><ol>{wizardStages.map((item, index) => <li key={item.id}><button type="button" aria-current={stage === item.id ? "step" : undefined} disabled={!canOpenStage(item.id) || busy} onClick={() => setStage(item.id)}><span>{index + 1}</span>{item.label}</button></li>)}</ol></nav>
    <div className="admin-section-heading"><div><p className="eyebrow">LLM-ASSISTED WORLDBUILDING</p><h2 id="campaign-generator-heading">Campaign workshop</h2></div>{draft && <span className="status-pill">{draft.draft.state === "applied" ? "accepted" : "candidate"}</span>}</div>
    {(error || notice) && <div className={`admin-status ${error ? "is-error" : "is-success"}`} role={error ? "alert" : "status"}><p>{error || notice}</p></div>}

    {generationIntent && <div className="campaign-generation-recovery" aria-label="Retained generation intent"><strong>{generationIntent.ambiguous ? "Uncertain generation response" : `Failed generation attempt ${generationIntent.failedAttempt}`}</strong><p>The exact reviewed request is retained. It will never be replayed automatically.</p><p>Reconciliation reads authoritative state without calling the provider. A retry may create another paid provider attempt and requires your explicit action.</p><div className="campaign-create-actions"><button type="button" disabled={busy} onClick={() => void reconcileGeneration()}>Reconcile without provider call</button><button type="button" disabled={busy} onClick={() => void submitGeneration(generationIntent, generationIntent.failedAttempt)}>{generationIntent.failedAttempt ? `Acknowledge attempt ${generationIntent.failedAttempt} and retry` : "Retry exact request with same key"}</button><button type="button" disabled={busy} onClick={() => { setGenerationIntent(null); setError(""); }}>Abandon retained intent</button></div></div>}
    {applyIntent && <div className="campaign-generation-recovery" aria-label="Retained apply intent"><strong>Apply outcome needs attention</strong><p>The reviewed selection is retained under the same operation identity. No automatic replay occurs.</p><button type="button" disabled={busy} onClick={() => void submitApply(applyIntent)}>Retry exact apply</button><button type="button" disabled={busy} onClick={() => { setApplyIntent(null); setError(""); }}>Abandon retained intent</button></div>}
    {publishIntent && <div className="campaign-generation-recovery" aria-label="Retained publication intent"><strong>Delivery outcome needs attention: {publishIntent.title}</strong><p>Retry only after reviewing current player delivery. This uses the same operation identity.</p><button type="button" disabled={busy} onClick={() => void submitPublication(publishIntent)}>Retry exact publication</button><button type="button" disabled={busy} onClick={() => { setPublishIntent(null); setError(""); }}>Abandon retained intent</button></div>}

    {stage === "scope" && preset === "full" && !hydrationPlan && <fieldset className="campaign-hydration-choice"><legend>Full campaign request strategy</legend><label><input type="checkbox" checked={stagedMode} disabled={busy} onChange={(event) => chooseStagedMode(event.target.checked)} /><span><strong>Generate in stages (recommended)</strong><small>Five bounded provider requests. You review and apply each candidate, then explicitly open the next request.</small></span></label></fieldset>}
    {staged && <section className="campaign-hydration-progress" data-testid="staged-hydration-plan" aria-label="Staged generation progress"><div><p className="eyebrow">STAGED FULL CAMPAIGN</p><h3>{hydrationPlan ? `Request ${hydrationPlan.currentStep + 1} of ${hydrationSteps.length}: ${activeHydrationStep.label}` : `${hydrationSteps.length} planned requests`}</h3><p>Only one provider request can run at a time. Every candidate requires review and an explicit one-time apply before the next request can be opened.</p></div><ol>{hydrationSteps.map((item, index) => { const complete = Boolean(hydrationPlan?.completed.some((entry) => entry.stepId === item.id)); const current = (hydrationPlan?.currentStep ?? 0) === index; const failed = current && Boolean(generationIntent?.failedAttempt || generationIntent?.ambiguous); return <li key={item.id} data-status={complete ? "applied" : failed ? "failed" : current ? "current" : "waiting"}><strong>{index + 1}. {item.label}</strong><small>{item.sections.map((section) => sectionOptions.find(([key]) => key === section)?.[1]).join(", ")}</small><span>{complete ? "Applied" : failed ? "Paused after failed or uncertain attempt" : current ? "Current reviewed request" : "Waiting for prior apply"}</span></li>; })}</ol>{hydrationPlan && <p className="campaign-hydration-coverage" role="status">Section coverage: {hydrationPlan.completed.reduce((count, item) => count + (hydrationSteps.find((step) => step.id === item.stepId)?.sections.length ?? 0), 0)} of {allSections.length} planned sections applied across {hydrationPlan.completed.length} of {hydrationSteps.length} requests. Coverage is not playable readiness.</p>}</section>}

    {stage === "foundation" && <section className="campaign-wizard-stage" aria-labelledby="foundation-heading"><p className="eyebrow">STAGE 1 · READ ONLY</p><h3 id="foundation-heading">Understand the foundation</h3><p>This workshop adds narrative material. It does not replace campaign rules, change safety agreements, publish the campaign, start a room, or make generated mechanics playable.</p><dl className="campaign-foundation-facts"><div><dt>Rules and readiness</dt><dd>Preserved; review authoritative status in campaign preparation.</dd></div><div><dt>Accepted opening outline</dt><dd>{foundation ? "Narrative outline available" : "No generated outline accepted"}</dd></div><div><dt>Accepted generated material</dt><dd>{planningCount} named item{planningCount === 1 ? "" : "s"} available as expansion context</dd></div></dl>{foundation && <article className="campaign-generated-foundation"><h4>{foundation.opening}</h4><p>{foundation.premise}</p><small>Accepted narrative canon. A generated foundation location key is not the authoritative designation.</small></article>}<button className="primary" type="button" disabled={busy} onClick={() => setStage("vision")}>Continue: shape the vision</button></section>}

    {stage === "vision" && <section className="campaign-wizard-stage" aria-labelledby="vision-heading"><p className="eyebrow">STAGE 2 · VISION</p><h3 id="vision-heading">Describe the campaign you want to run</h3><p>Use the full questionnaire or a scripted one-question-at-a-time interview. Both are local forms; the LLM is not called while you answer.</p><fieldset className="generation-inputs"><CampaignIntentForm value={answers} onChange={setAnswers} disabled={busy || Boolean(generationIntent)} /></fieldset><div className="campaign-wizard-actions"><button type="button" disabled={busy} onClick={() => setStage("foundation")}>Back: foundation</button><button className="primary" type="button" disabled={busy || !answers.premise.trim()} onClick={() => setStage("safety")}>Continue: review safety</button></div></section>}

    {stage === "safety" && <section className="campaign-wizard-stage" aria-labelledby="safety-heading"><p className="eyebrow">STAGE 3 · GENERATION BOUNDARIES</p><h3 id="safety-heading">Carry safety into this request</h3><p>The campaign safety agreement remains authoritative and is never overwritten here. Add request-specific exclusions or veils for the generated candidate.</p><label className="field"><span>Exclude or veil in generated material</span><textarea rows={4} maxLength={3215} disabled={busy || Boolean(generationIntent)} value={exclusions} onChange={(event) => setExclusions(event.target.value)} placeholder="body horror, harm to children" aria-invalid={exclusionsInvalid} /><small>Optional. Separate up to 16 boundaries with commas; 200 characters each.</small>{exclusionsInvalid && <small className="field-error">Use no more than 16 boundaries of 200 characters each.</small>}</label><p><a href="#session-zero-heading">Review the authoritative campaign safety agreement</a> in Manage before generation if these boundaries may have changed.</p><div className="campaign-wizard-actions"><button type="button" disabled={busy} onClick={() => setStage("vision")}>Back: vision</button><button className="primary" type="button" disabled={busy || exclusionsInvalid} onClick={() => setStage("scope")}>Continue: plan the world</button></div></section>}

    {stage === "scope" && <section className="campaign-wizard-stage" aria-labelledby="scope-heading"><p className="eyebrow">STAGE 4 · WORLD PLAN</p><h3 id="scope-heading">Choose the candidate scope</h3><p>Generate a practical foundation, a broad narrative campaign, or only missing sections. Breadth and detail affect provider work, but one click still sends one reviewed request.</p><fieldset className="generation-inputs"><div className="campaign-generator-controls"><label className="field"><span>Tone</span><select disabled={busy || Boolean(generationIntent)} value={tone} onChange={(event) => setTone(event.target.value)}><option>adventurous and grounded</option><option>dark mystery with hopeful choices</option><option>heroic high fantasy</option><option>political and morally complex</option><option>whimsical and strange</option></select></label><label className="field"><span>Detail level</span><select disabled={busy || Boolean(generationIntent)} value={depth} onChange={(event) => setDepth(event.target.value)}><option value="concise">Concise outline</option><option value="play-ready">Play-ready foundation</option><option value="rich">Rich detail and hooks</option></select></label></div><fieldset disabled={busy || Boolean(generationIntent)}><legend>Generation preset</legend><div className="campaign-generation-focus"><label><input type="radio" name="campaign-generation-preset" checked={preset === "foundation"} onChange={() => choosePreset("foundation")} /><span><strong>Foundation</strong><small>Outline, world, factions, NPCs, and quests</small></span></label><label><input type="radio" name="campaign-generation-preset" checked={preset === "full"} onChange={() => choosePreset("full")} /><span><strong>Full narrative campaign</strong><small>Every supported narrative section in one request</small></span></label><label><input type="radio" name="campaign-generation-preset" checked={preset === "custom"} onChange={() => choosePreset("custom")} /><span><strong>Custom scope</strong><small>Choose only the sections you need</small></span></label></div></fieldset><fieldset disabled={busy || Boolean(generationIntent)}><legend>Sections in this request</legend>{sectionGroups.map(([group, values]) => <div key={group}><strong>{group}</strong><div className="campaign-generation-sections">{values.map((value) => { const label = sectionOptions.find(([candidate]) => candidate === value)?.[1] ?? value; return <label key={value}><input type="checkbox" checked={sections.includes(value)} onChange={() => toggleSection(value)} /><span>{label}</span></label>; })}</div></div>)}{sections.length === 0 && <small className="field-error">Select at least one section.</small>}</fieldset><fieldset disabled={busy || Boolean(generationIntent)}><legend>Priorities</legend><div className="campaign-generation-focus">{focusOptions.map(([value, description]) => <label key={value}><input type="checkbox" checked={focus.includes(value)} onChange={() => toggleFocus(value)} /><span><strong>{value}</strong><small>{description}</small></span></label>)}</div></fieldset>{acceptedArtifacts.length > 0 && <fieldset disabled={busy || Boolean(generationIntent)}><legend>Expand accepted material (optional)</legend><p>Select named, already accepted material as immutable context. Expansion adds new candidates; it does not rewrite the source.</p><div className="campaign-expansion-list">{acceptedArtifacts.map((item) => <label key={item.key}><input type="checkbox" checked={expansionValues.includes(item.key)} onChange={() => toggleExpansion(item.key)} /><span><strong>{item.label}</strong><small>{item.kind}</small></span></label>)}</div></fieldset>}{unavailableExpansion && <p className="builder-help">Some retained expansion context is no longer available by name. <button type="button" onClick={() => setExpandKeys("")}>Clear unavailable context</button></p>}<label className="field"><span>Revision direction (optional)</span><textarea rows={3} maxLength={2000} disabled={busy || Boolean(generationIntent)} value={revisionFeedback} onChange={(event) => setRevisionFeedback(event.target.value)} placeholder="Keep the premise, but make the faction conflict more immediate." /><small>Use this for an iteration on accepted material or a previous idea.</small></label></fieldset>{direction.length > 2000 && <p role="alert">Shorten the answers: the complete brief must fit within 2,000 characters.</p>}<div className="campaign-wizard-actions"><button type="button" disabled={busy} onClick={() => setStage("safety")}>Back: safety</button><button className="primary" type="button" disabled={busy || generationFormInvalid || Boolean(generationIntent || applyIntent || publishIntent)} onClick={() => { setReviewed(true); setStage("review"); }}>Review LLM request and cost</button>{draft && <button type="button" onClick={() => setStage(draft.draft.state === "applied" ? "ready" : "candidate")}>Return to retained {draft.draft.state === "applied" ? "next steps" : "candidate"}</button>}</div></section>}

    {stage === "review" && <section className="campaign-wizard-stage campaign-brief-review" aria-label="Final brief review"><p className="eyebrow">STAGE 5 · EXPLICIT LLM ACTION</p><h3>Review the LLM generation request</h3><pre>{direction}</pre><dl className="campaign-review-facts"><div><dt>Tone</dt><dd>{tone}</dd></div><div><dt>Requested sections</dt><dd>{sections.map((section) => sectionOptions.find(([key]) => key === section)?.[1]).join(", ")}</dd></div><div><dt>Generation boundaries</dt><dd>{exclusionValues.join(", ") || "None added here"}</dd></div><div><dt>Accepted context</dt><dd>{expansionValues.length ? `${expansionValues.length} named accepted item${expansionValues.length === 1 ? "" : "s"}` : "None"}</dd></div><div><dt>Revision direction</dt><dd>{revisionFeedback.trim() || "None"}</dd></div></dl><div className="campaign-cost-warning"><strong>This action contacts the configured LLM provider and may incur cost.</strong><p>It sends one request for the selected sections. Returned content is an untrusted candidate, not canon or proof of playable readiness. No per-question model calls occurred.</p></div><div className="campaign-wizard-actions"><button type="button" disabled={busy || Boolean(generationIntent)} onClick={() => { setReviewed(false); setStage("scope"); }}>Back: edit plan</button><button className="primary" type="button" disabled={busy || generationFormInvalid || Boolean(generationIntent)} onClick={generate}>{generating ? "Generating candidate…" : "Generate candidate with LLM (may incur cost)"}</button></div></section>}

    {stage === "candidate" && draft && <section className="campaign-wizard-stage campaign-generation-preview" aria-labelledby="campaign-generation-preview-heading"><p className="eyebrow">STAGE 6 · CANDIDATE, NOT CANON</p><div className="admin-section-heading"><div><h3 id="campaign-generation-preview-heading">Review generated material</h3><p>Select only what belongs in this campaign. Dependencies are selected and removed together.</p></div><span>{selectedKeys.length} of {rows.length} selected</span></div><CampaignCoverage preview={draft.preview} requested={draftCoverage?.draftId === draft.draft.draftId ? draftCoverage.sections : null} options={sectionOptions} />{draft.derivativeContextKeys.length > 0 && <p className="builder-help">This derivative candidate used {draft.derivativeContextKeys.length} accepted item{draft.derivativeContextKeys.length === 1 ? "" : "s"} as immutable context. Applying is additive.</p>}{draft.validationIssues.length > 0 && <ul className="field-error">{draft.validationIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}{selectionNotice && <p className="builder-help" role="status">{selectionNotice}</p>}<div className="campaign-generation-artifacts">{groups.map((group) => <section key={group.title} aria-labelledby={`candidate-${group.title.toLowerCase()}`}><h4 id={`candidate-${group.title.toLowerCase()}`}>{group.title}</h4><p>{group.description}</p>{group.rows.length === 0 ? <p className="campaign-empty-section">No {group.title.toLowerCase()} candidates were returned.</p> : group.rows.map((row) => <article key={row.key} data-artifact-key={row.key}><label className={`campaign-generation-artifact ${selectedKeys.includes(row.key) ? "is-selected" : ""}`}><input type="checkbox" disabled={busy || Boolean(applyIntent) || draft.draft.state !== "staged"} checked={selectedKeys.includes(row.key)} onChange={() => toggleArtifact(row)} /><span><strong>{row.label}</strong><small>Generated {row.kind.toLowerCase()}</small><p>{row.summary}</p>{row.dependencies.length > 0 && <small>Uses: {row.dependencies.map((key) => rowByKey.get(key)?.label ?? "accepted campaign context").join(", ")}</small>}</span></label></article>)}</section>)}</div>{rows.length === 0 && <div className="campaign-empty-candidate" role="status"><strong>The provider returned no reviewable artifacts.</strong><p>Nothing can be applied. Return to the plan to request a different or smaller scope; generating again is a new explicit provider action.</p></div>}<div className="campaign-wizard-actions"><button type="button" disabled={busy || Boolean(generationIntent || applyIntent || publishIntent)} onClick={() => { setReviewed(false); setStage("scope"); }}>Back: revise plan (keep candidate)</button>{draft.draft.state === "staged" && rows.length > 0 && <><label className="builder-confirm"><input type="checkbox" checked={confirmed} disabled={busy || Boolean(applyIntent) || selectedKeys.length === 0} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the {selectedKeys.length} selected candidate artifact{selectedKeys.length === 1 ? "" : "s"} and want to accept them as campaign canon once.</label><button className="primary" type="button" disabled={busy || Boolean(applyIntent) || !confirmed || selectedKeys.length === 0} onClick={apply}>{applying ? "Accepting selected content…" : "Accept selected material as canon"}</button></>}</div></section>}

    {stage === "candidate" && draft?.draft.state === "applied" && hydrationPlan && hydrationPlan.currentStep < hydrationSteps.length - 1 && <section className="campaign-hydration-context" aria-label="Context for next staged request"><h3>Choose context for later references</h3><p>Only named public artifacts accepted from completed requests are offered. Nothing is selected automatically; GM-only material and undisclosed raw keys are excluded.</p>{hydrationPlan.contextOptions.length ? <div className="campaign-expansion-list">{hydrationPlan.contextOptions.map((item) => <label key={item.key}><input type="checkbox" checked={hydrationPlan.contextKeys.includes(item.key)} disabled={busy} onChange={() => toggleHydrationContext(item.key)} /><span><strong>{item.label}</strong><small>{item.kind}</small></span></label>)}</div> : <p>No eligible public accepted artifacts are available as context. You may continue without expansion context.</p>}<p>{hydrationPlan.contextKeys.length} of 16 context items selected.</p><button className="primary" type="button" disabled={busy || Boolean(generationIntent || applyIntent)} onClick={proceedToNextHydrationRequest}>Review next staged request</button></section>}
    {stage === "candidate" && draft?.draft.state === "applied" && (!hydrationPlan || hydrationPlan.currentStep === hydrationSteps.length - 1) && <CampaignStartingLocationPanel campaignId={campaignId} candidates={startingCandidates} canDesignate api={api} />}
    {stage === "candidate" && !draft && <section className="campaign-wizard-stage" aria-labelledby="candidate-restore-heading"><p className="eyebrow">STAGE 6 · RESTORE</p><h3 id="candidate-restore-heading">Restoring the retained candidate</h3><p role="status">The durable reviewed draft is being reopened. No provider call is being made.</p><button type="button" onClick={() => setStage("scope")}>Return to world plan</button></section>}

    {stage === "ready" && <section className="campaign-wizard-stage" aria-labelledby="ready-heading"><p className="eyebrow">STAGE 7 · READINESS</p><h3 id="ready-heading">Choose the opening, then prepare play</h3><p>Acceptance added selected material to campaign canon. It did not publish the campaign, share private material, create or move characters, attach a room, or make a room ready.</p><CampaignStartingLocationPanel campaignId={campaignId} candidates={startingCandidates} canDesignate api={api} /><div className="campaign-next-grid"><section><h4>Accepted canon</h4>{foundation ? <><strong>{foundation.opening}</strong><p>{foundation.premise}</p></> : <p>No generated opening outline is currently projected.</p>}<p>{planningCount} accepted generated planning item{planningCount === 1 ? "" : "s"} available.</p></section><section><h4>Next steps</h4><ul><li>Create and review campaign characters.</li><li>Attach and prepare a room separately in Rooms.</li><li>Review campaign rules, safety, quest objectives, and mechanics.</li><li>Publish the campaign separately when it is ready for players.</li></ul></section></div>{planning?.deliverables.length ? <section className="campaign-delivery"><h4>Player sharing is separate</h4><p>Accepting canon does not reveal it to players. Only public handouts and scene prompts can be explicitly delivered here; GM-only material remains private.</p>{planning.deliverables.map((item) => <article key={item.resourceId}><strong>{item.title}</strong><p>{item.content}</p><small>{item.visibility === "gm" ? "GM only; cannot be shared" : item.publishedAt ? "Shared with players" : "Accepted, not shared"}</small>{item.visibility === "public" && !item.publishedAt && <button type="button" disabled={busy || Boolean(publishIntent)} onClick={() => publish(item.artifactKey, item.title)}>Share this material with players</button>}</article>)}</section> : <p>No accepted player-facing material is waiting to be shared.</p>}<div className="campaign-wizard-actions"><button type="button" disabled={busy} onClick={() => setStage("scope")}>Plan another generation or expansion</button>{onBack && <button className="primary" type="button" disabled={busy || Boolean(publishIntent)} onClick={onBack}>Return to campaign readiness</button>}</div></section>}
  </section>;
}
