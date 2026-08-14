import { useEffect, useMemo, useState } from "react";
import type {
  CampaignContentDraftView,
  CampaignContentGenerationRequest,
  CampaignGeneratedPlanning,
} from "@velvet/contracts";
import {
  ApiError,
  applyCampaignContentDraft,
  createCampaignContentDraft,
  getCampaignGeneratedFoundation,
  getCampaignGeneratedPlanning,
  publishCampaignMaterial,
  type CampaignContentApplyInput,
  type CampaignMaterialPublishInput,
} from "../../../api";

const sectionOptions = [
  ["outline", "Campaign outline"], ["arcs", "Story arcs"], ["locations", "Locations & routes"],
  ["factions", "Factions"], ["npcs", "NPCs"], ["quests", "Quests"],
  ["encounters", "Encounter concepts"], ["clues", "Clues"], ["story", "Story graph"],
  ["handouts", "Handouts"], ["scene-prompts", "Scene prompts"],
] as const satisfies ReadonlyArray<readonly [CampaignContentGenerationRequest["sections"][number], string]>;

const focusOptions = [
  ["adventure spine", "A connected premise, opening, and quest arc"],
  ["living world", "Distinct locations and factions with usable tensions"],
  ["memorable cast", "NPCs with clear roles and conflicting goals"],
] as const;

type Section = CampaignContentGenerationRequest["sections"][number];
type Preview = CampaignContentDraftView["preview"];
type ArtifactRow = { key: string; kind: string; label: string; summary: string; dependencies: string[] };
type Foundation = { opening: string; premise: string };

export interface CampaignGeneratorPanelApi {
  createCampaignContentDraft: typeof createCampaignContentDraft;
  applyCampaignContentDraft: typeof applyCampaignContentDraft;
  getCampaignGeneratedFoundation: typeof getCampaignGeneratedFoundation;
  getCampaignGeneratedPlanning: typeof getCampaignGeneratedPlanning;
  publishCampaignMaterial: typeof publishCampaignMaterial;
}

const defaultApi: CampaignGeneratorPanelApi = {
  createCampaignContentDraft, applyCampaignContentDraft, getCampaignGeneratedFoundation,
  getCampaignGeneratedPlanning, publishCampaignMaterial,
};

function newKey(kind: string): string {
  const value = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ui-campaign-${kind}-${value}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function artifactRows(preview: Preview): Array<{ title: string; rows: ArtifactRow[] }> {
  return [
    { title: "Outlines", rows: preview.outlines.map((item) => ({ key: item.key, kind: "Outline", label: item.opening, summary: item.premise, dependencies: item.startLocationKey ? [item.startLocationKey] : [] })) },
    { title: "Arcs", rows: preview.arcs.map((item) => ({ key: item.key, kind: "Arc", label: item.title, summary: item.summary, dependencies: [] })) },
    { title: "Locations", rows: preview.locations.map((item) => ({ key: item.key, kind: "Location", label: item.name, summary: item.description, dependencies: item.factionKeys })) },
    { title: "Connections", rows: preview.connections.map((item) => ({ key: item.key, kind: "Connection", label: `${item.fromLocationKey} → ${item.toLocationKey}`, summary: item.description, dependencies: [item.fromLocationKey, item.toLocationKey] })) },
    { title: "Factions", rows: preview.factions.map((item) => ({ key: item.key, kind: "Faction", label: item.name, summary: item.description, dependencies: [] })) },
    { title: "NPCs", rows: preview.npcs.map((item) => ({ key: item.key, kind: "NPC", label: item.name, summary: `${item.archetype} · ${item.description}`, dependencies: [...item.factionKeys, ...(item.locationKey ? [item.locationKey] : [])] })) },
    { title: "Quests", rows: preview.quests.map((item) => ({ key: item.key, kind: "Quest", label: item.title, summary: item.description, dependencies: [...item.locationKeys, ...(item.arcKey ? [item.arcKey] : [])] })) },
    { title: "Encounter concepts", rows: preview.encounters.map((item) => ({ key: item.key, kind: "Encounter", label: item.title, summary: item.description, dependencies: [...item.participantNpcKeys, ...(item.locationKey ? [item.locationKey] : [])] })) },
    { title: "Clues", rows: preview.clues.map((item) => ({ key: item.key, kind: "Clue", label: item.title, summary: item.description, dependencies: [...(item.locationKey ? [item.locationKey] : []), ...(item.revealsStoryNodeKey ? [item.revealsStoryNodeKey] : [])] })) },
    { title: "Story nodes", rows: preview.storyNodes.map((item) => ({ key: item.key, kind: "Story node", label: item.title, summary: item.description, dependencies: [] })) },
    { title: "Story relationships", rows: preview.storyRelationships.map((item) => ({ key: item.key, kind: "Story relationship", label: `${item.fromStoryNodeKey} → ${item.toStoryNodeKey}`, summary: item.description, dependencies: [item.fromStoryNodeKey, item.toStoryNodeKey] })) },
    { title: "Handouts", rows: preview.handouts.map((item) => ({ key: item.key, kind: "Handout", label: item.title, summary: item.content, dependencies: [] })) },
    { title: "Scene prompts", rows: preview.scenePrompts.map((item) => ({ key: item.key, kind: "Scene prompt", label: item.title, summary: item.prompt, dependencies: [...item.npcKeys, ...(item.locationKey ? [item.locationKey] : [])] })) },
  ];
}

interface GenerationIntent { input: CampaignContentGenerationRequest; failedAttempt: number | null; ambiguous: boolean }
interface ApplyIntent { draftId: string; input: CampaignContentApplyInput }
interface PublishIntent { campaignId: string; input: CampaignMaterialPublishInput; title: string }

export function CampaignGeneratorPanel({ campaignId, disabled = false, api = defaultApi }: {
  campaignId: string; disabled?: boolean; api?: CampaignGeneratorPanelApi;
}) {
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState("adventurous and grounded");
  const [depth, setDepth] = useState("play-ready");
  const [focus, setFocus] = useState<string[]>(focusOptions.map(([value]) => value));
  const [sections, setSections] = useState<Section[]>(["outline", "locations", "factions", "quests", "npcs"]);
  const [exclusions, setExclusions] = useState("");
  const [revisionFeedback, setRevisionFeedback] = useState("");
  const [expandKeys, setExpandKeys] = useState("");
  const [draft, setDraft] = useState<CampaignContentDraftView | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [generationIntent, setGenerationIntent] = useState<GenerationIntent | null>(null);
  const [applyIntent, setApplyIntent] = useState<ApplyIntent | null>(null);
  const [publishIntent, setPublishIntent] = useState<PublishIntent | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectionNotice, setSelectionNotice] = useState("");
  const [foundation, setFoundation] = useState<Foundation | null>(null);
  const [planning, setPlanning] = useState<CampaignGeneratedPlanning | null>(null);

  useEffect(() => {
    let current = true;
    void api.getCampaignGeneratedFoundation(campaignId).then((value) => {
      if (current) setFoundation(value.opening ? { opening: value.opening.opening, premise: value.opening.premise } : null);
    }).catch(() => { if (current) setFoundation(null); });
    void api.getCampaignGeneratedPlanning(campaignId).then((value) => { if (current) setPlanning(value); })
      .catch(() => { if (current) setPlanning(null); });
    return () => { current = false; };
  }, [api, campaignId]);

  const groups = useMemo(() => draft ? artifactRows(draft.preview) : [], [draft]);
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const rowByKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
  const exclusionValues = parseList(exclusions);
  const expansionValues = parseList(expandKeys);
  const expansionInvalid = expansionValues.length > 16 || expansionValues.some((item) => item.length > 64 || !/^[a-z][a-z0-9-]*$/.test(item));
  const exclusionsInvalid = exclusionValues.length > 16 || exclusionValues.some((item) => item.length > 200);
  const generationFormInvalid = !brief.trim() || focus.length === 0 || sections.length === 0 || expansionInvalid || exclusionsInvalid;
  const busy = disabled || generating || applying || publishing;

  function toggleFocus(value: string): void {
    setFocus((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  }

  function toggleSection(value: Section): void {
    setSections((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
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
    if (generating || applying) return;
    const submitted: GenerationIntent = { ...intent, input: { ...intent.input, retryFailedAttempt: acknowledgement === null ? null : { failedAttempt: acknowledgement } } };
    setGenerationIntent(submitted); setGenerating(true); setError(""); setNotice(""); setConfirmed(false);
    try {
      const result = await api.createCampaignContentDraft(submitted.input);
      setDraft(result);
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
        setGenerationIntent({ ...submitted, failedAttempt: attempted + 1, ambiguous: false });
        setError(`Generation attempt ${attempted + 1} failed explicitly. It will not be replayed unless you acknowledge and retry it.`);
      } else {
        setGenerationIntent({ ...submitted, failedAttempt: null, ambiguous: true });
        setError("The generation response is uncertain. The exact request and idempotency key are retained; reconcile or explicitly retry it before starting a new intent.");
      }
    } finally { setGenerating(false); }
  }

  function generate(): void {
    if (generationFormInvalid || generationIntent) return;
    const direction = `${brief.trim()}\n\nDetail level: ${depth}. Prioritize: ${focus.join(", ")}. Establish breadth before depth, make every element immediately usable at the table, and keep all elements internally consistent.`;
    const input: CampaignContentGenerationRequest = {
      campaignId, brief: direction, tone, exclusions: exclusionValues, sections,
      expandArtifactKeys: expansionValues, revisionFeedback: revisionFeedback.trim() || null,
      retryFailedAttempt: null, idempotencyKey: newKey("generate"),
    };
    void submitGeneration({ input, failedAttempt: null, ambiguous: false }, null);
  }

  async function submitApply(intent: ApplyIntent): Promise<void> {
    if (applying || generating) return;
    setApplyIntent(intent); setApplying(true); setError(""); setNotice("");
    try {
      const result = await api.applyCampaignContentDraft(intent.draftId, intent.input);
      setDraft((current) => current ? { ...current, draft: result.draft } : current);
      const outline = draft?.preview.outlines.find((item) => intent.input.selectedArtifactKeys.includes(item.key));
      if (outline) setFoundation({ opening: outline.opening, premise: outline.premise });
      setApplyIntent(null); setConfirmed(false);
      setNotice("The selected campaign material was applied once. Planning and publication remain explicit.");
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

  async function submitPublication(intent: PublishIntent): Promise<void> {
    if (publishing || applying) return;
    setPublishIntent(intent); setPublishing(true); setError(""); setNotice("");
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

  return <section className="admin-section campaign-generator" aria-labelledby="campaign-generator-heading">
    <div className="admin-section-heading"><div><p className="eyebrow">REVIEWED API GENERATION</p><h2 id="campaign-generator-heading">Flesh out this campaign</h2></div>{draft && <span className="status-pill">{draft.draft.state}</span>}</div>
    <p className="builder-help">Generate only the sections you need, inspect every candidate, then apply an explicit dependency-safe selection.</p>
    {(error || notice) && <div className={`admin-status ${error ? "is-error" : "is-success"}`} role={error ? "alert" : "status"}><p>{error || notice}</p></div>}

    {generationIntent && <div className="campaign-generation-recovery" aria-label="Retained generation intent">
      <strong>{generationIntent.ambiguous ? "Uncertain generation response" : `Failed generation attempt ${generationIntent.failedAttempt}`}</strong>
      <p>The exact request is retained under the same idempotency key. No provider call will be repeated automatically.</p>
      <button type="button" disabled={busy} onClick={() => void submitGeneration(generationIntent, generationIntent.failedAttempt)}>{generationIntent.failedAttempt ? `Acknowledge attempt ${generationIntent.failedAttempt} and retry` : "Retry exact request with same key"}</button>
      <button type="button" disabled={busy} onClick={() => { setGenerationIntent(null); setError(""); }}>Abandon retained intent</button>
    </div>}
    {applyIntent && <div className="campaign-generation-recovery" aria-label="Retained apply intent"><strong>Apply intent retained</strong><p>{applyIntent.input.selectedArtifactKeys.length} exact candidate keys are locked to the same idempotency key.</p><button type="button" disabled={busy} onClick={() => void submitApply(applyIntent)}>Retry exact apply</button><button type="button" disabled={busy} onClick={() => { setApplyIntent(null); setError(""); }}>Abandon retained intent</button></div>}
    {publishIntent && <div className="campaign-generation-recovery" aria-label="Retained publication intent"><strong>Publication intent retained: {publishIntent.title}</strong><p>Reconcile the planning read or retry this exact publication with the same key.</p><button type="button" disabled={busy} onClick={() => void submitPublication(publishIntent)}>Retry exact publication</button><button type="button" disabled={busy} onClick={() => { setPublishIntent(null); setError(""); }}>Abandon retained intent</button></div>}

    {foundation && <article className="campaign-generated-foundation"><p className="eyebrow">ACCEPTED CAMPAIGN CANON</p><h3>Opening</h3><p>{foundation.opening}</p><h3>Premise</h3><p>{foundation.premise}</p></article>}
    {planning && (planning.encounters.length > 0 || planning.deliverables.length > 0) && <section className="campaign-generation-preview"><h3>Campaign plans</h3><p className="builder-help">Encounter concepts remain preparation only. Player materials appear only after an explicit public delivery.</p>{planning.encounters.map((item) => <article key={item.resourceId}><strong>{item.title}</strong><p>{item.description}</p><small>Encounter concept · combat not started</small></article>)}{planning.deliverables.map((item) => <article key={item.resourceId}><strong>{item.title}</strong><p>{item.content}</p><small>{item.visibility === "gm" ? "GM only · cannot publish" : item.publishedAt ? "Delivered" : "Public candidate · not delivered"}</small>{item.visibility === "public" && !item.publishedAt && <button type="button" disabled={busy || Boolean(publishIntent)} onClick={() => publish(item.artifactKey, item.title)}>Deliver to players</button>}</article>)}</section>}

    <label className="field"><span>Campaign brief</span><textarea rows={5} maxLength={1500} disabled={busy || Boolean(generationIntent)} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="A flooded frontier city survives by bargaining with the spirits beneath its canals…" /><small>Include the central conflict, player fantasy, and anything that must remain true.</small></label>
    <div className="campaign-generator-controls">
      <label className="field"><span>Tone</span><select disabled={busy || Boolean(generationIntent)} value={tone} onChange={(event) => setTone(event.target.value)}><option>adventurous and grounded</option><option>dark mystery with hopeful choices</option><option>heroic high fantasy</option><option>political and morally complex</option><option>whimsical and strange</option></select></label>
      <label className="field"><span>Detail level</span><select disabled={busy || Boolean(generationIntent)} value={depth} onChange={(event) => setDepth(event.target.value)}><option value="concise">Concise outline</option><option value="play-ready">Play-ready foundation</option><option value="rich">Rich detail and hooks</option></select></label>
    </div>
    <fieldset disabled={busy || Boolean(generationIntent)}><legend>Sections to generate</legend><div className="campaign-generation-sections">{sectionOptions.map(([value, label]) => <label key={value}><input type="checkbox" checked={sections.includes(value)} onChange={() => toggleSection(value)} /><span>{label}</span></label>)}</div>{sections.length === 0 && <small className="field-error">Select at least one section.</small>}</fieldset>
    <fieldset disabled={busy || Boolean(generationIntent)}><legend>What should the API prioritize?</legend><div className="campaign-generation-focus">{focusOptions.map(([value, description]) => <label key={value}><input type="checkbox" checked={focus.includes(value)} onChange={() => toggleFocus(value)} /><span><strong>{value}</strong><small>{description}</small></span></label>)}</div></fieldset>
    <label className="field"><span>Focused revision feedback (optional)</span><textarea rows={3} maxLength={2000} disabled={busy || Boolean(generationIntent)} value={revisionFeedback} onChange={(event) => setRevisionFeedback(event.target.value)} placeholder="Keep the existing premise, but make the faction conflict more immediate…" /><small>Up to 2,000 characters of prose direction for this candidate.</small></label>
    <label className="field"><span>Accepted artifact keys to expand (optional)</span><input maxLength={1039} disabled={busy || Boolean(generationIntent)} value={expandKeys} onChange={(event) => setExpandKeys(event.target.value)} placeholder="old-harbor, lantern-guild" aria-invalid={expansionInvalid} /><small>Up to 16 comma-separated accepted keys; lowercase letters, numbers, and hyphens only.</small>{expansionInvalid && <small className="field-error">Use no more than 16 valid artifact keys of 64 characters each.</small>}</label>
    <label className="field"><span>Exclude or veil</span><input maxLength={3215} disabled={busy || Boolean(generationIntent)} value={exclusions} onChange={(event) => setExclusions(event.target.value)} placeholder="body horror, harm to children" aria-invalid={exclusionsInvalid} /><small>Up to 16 comma-separated boundaries, 200 characters each.</small>{exclusionsInvalid && <small className="field-error">Use no more than 16 boundaries of 200 characters each.</small>}</label>
    <button className="primary" type="button" disabled={busy || generationFormInvalid || Boolean(generationIntent)} onClick={generate}>{generating ? "Building candidate…" : draft ? "Generate another candidate" : "Generate selected sections"}</button>

    {draft && <section className="campaign-generation-preview" aria-labelledby="campaign-generation-preview-heading">
      <div className="admin-section-heading"><div><p className="eyebrow">CANDIDATE · NOT APPLIED</p><h3 id="campaign-generation-preview-heading">Review generated material</h3></div><span>{selectedKeys.length} of {rows.length} selected</span></div>
      {draft.validationIssues.length > 0 && <ul className="field-error">{draft.validationIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
      {selectionNotice && <p className="builder-help" role="status">{selectionNotice}</p>}
      <div className="campaign-generation-artifacts">{groups.map((group) => <section key={group.title}><h4>{group.title}</h4>{group.rows.length === 0 ? <p className="builder-help">No candidates in this section.</p> : group.rows.map((row) => <label className={`campaign-generation-artifact ${selectedKeys.includes(row.key) ? "is-selected" : ""}`} key={row.key}><input type="checkbox" disabled={busy || Boolean(applyIntent) || draft.draft.state !== "staged"} checked={selectedKeys.includes(row.key)} onChange={() => toggleArtifact(row)} /><span><strong>{row.label}</strong><small>{row.kind} · {row.key}</small><p>{row.summary}</p>{row.dependencies.length > 0 && <small>Uses: {row.dependencies.join(", ")}</small>}</span></label>)}</section>)}</div>
      {draft.draft.state === "staged" && <><label className="builder-confirm"><input type="checkbox" checked={confirmed} disabled={busy || Boolean(applyIntent) || selectedKeys.length === 0} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the {selectedKeys.length} selected candidate artifact{selectedKeys.length === 1 ? "" : "s"} and want to apply them once.</label><button className="primary" type="button" disabled={busy || Boolean(applyIntent) || !confirmed || selectedKeys.length === 0} onClick={apply}>{applying ? "Applying selected content…" : "Apply selected material once"}</button></>}
    </section>}
  </section>;
}
