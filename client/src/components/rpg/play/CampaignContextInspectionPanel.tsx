import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  CampaignContextInspectionDispatchReference,
  CampaignContextInspectionDispatchReferenceSelector,
  CampaignContextInspectionDispatchReferenceSource,
  CampaignContextInspectionResponse,
  CampaignDmRun,
} from "@velvet/contracts";

export interface CampaignContextInspectionApi {
  getCampaignContextInspectionReferences: (campaignId: string, sessionId: string, source: CampaignContextInspectionDispatchReferenceSource) => Promise<CampaignContextInspectionDispatchReferenceSelector>;
  getCampaignContextInspection: (campaignId: string, sessionId: string, lane: CampaignContextInspectionDispatchReference["lane"], dispatchId: string) => Promise<CampaignContextInspectionResponse>;
}

const laneLabel: Record<CampaignContextInspectionDispatchReference["lane"], string> = {
  "adventure-planning": "Adventure planning",
  "adventure-narration": "Adventure narration",
  "director-planning": "Director planning",
  "director-narration": "Director narration",
};
const unavailableLabel: Record<Extract<CampaignContextInspectionResponse, { availability: "unavailable" }>["reason"], string> = {
  "dispatch-not-found": "This recorded dispatch is no longer available.",
  "provenance-not-recorded": "Inspectable context was not recorded for this dispatch.",
  "provenance-version-unsupported": "This dispatch uses an unsupported provenance version.",
  "provenance-corrupt": "The recorded provenance could not be safely read.",
  "access-revoked": "Current access to this context has been revoked.",
};
const withheldLabel: Record<string, string> = {
  "current-visibility-revoked": "Withheld because its current visibility was revoked.",
  "private-source": "Withheld because the source is private.",
  "unsafe-persisted-content": "Withheld because persisted content was not safe to display.",
  "metadata-overflow": "Withheld because its metadata exceeded the safe display limit.",
  "display-budget-exceeded": "Withheld because the safe display budget was reached.",
};
const usageLabels = {
  storedRecallPacketUtf8Bytes: "Stored recall packet (UTF-8 bytes)",
  storedMessageContentUtf8Bytes: "Stored message content (UTF-8 bytes)",
  serializedStoredRequestUtf8Bytes: "Serialized stored request (UTF-8 bytes)",
  displayedSafeResponseUtf8Bytes: "Displayed safe response (UTF-8 bytes)",
  reportedPromptTokens: "Reported prompt tokens",
  reportedCompletionTokens: "Reported completion tokens",
  reservedPromptTokens: "Reserved prompt tokens",
  reservedCompletionTokens: "Reserved completion tokens",
} as const;

/** Read-only, explicitly triggered inspection of one exact historical provider dispatch. */
export function CampaignContextInspectionPanel({ campaignId, sessionId, role, runs, currentTurnId, api }: {
  campaignId: string;
  sessionId: string;
  role: "owner" | "gm";
  runs: readonly CampaignDmRun[];
  currentTurnId?: string;
  api: CampaignContextInspectionApi;
}) {
  const [sourceKey, setSourceKey] = useState("");
  const [references, setReferences] = useState<CampaignContextInspectionDispatchReference[]>([]);
  const [dispatchKey, setDispatchKey] = useState("");
  const [inspection, setInspection] = useState<CampaignContextInspectionResponse | null>(null);
  const [state, setState] = useState<"idle" | "loading-references" | "references" | "loading-inspection" | "error">("idle");
  const generation = useRef(0);

  const clear = () => { generation.current += 1; setReferences([]); setDispatchKey(""); setInspection(null); setState("idle"); };
  useLayoutEffect(() => { setSourceKey(""); clear(); }, [campaignId, sessionId, role]);
  useEffect(() => () => { generation.current += 1; }, []);

  const sources: Array<{ key: string; source: CampaignContextInspectionDispatchReferenceSource; label: string }> = [
    ...(currentTurnId ? [{ key: `adventure-turn:${currentTurnId}`, source: { kind: "adventure-turn" as const, sourceId: currentTurnId }, label: `Current adventure turn (${currentTurnId})` }] : []),
    ...runs.map((run) => ({ key: `director-run:${run.runId}`, source: { kind: "director-run" as const, sourceId: run.runId }, label: `Director run ${run.runId} (${run.intent}, ${run.state})` })),
  ];
  const selectedSource = sources.find((source) => source.key === sourceKey)?.source;
  const selectedDispatch = references.find((reference) => `${reference.lane}:${reference.dispatchId}` === dispatchKey);
  useLayoutEffect(() => { if (sourceKey && !selectedSource) { setSourceKey(""); clear(); } }, [sourceKey, selectedSource]);

  async function loadReferences() {
    if (!selectedSource) return;
    const request = ++generation.current; setReferences([]); setDispatchKey(""); setInspection(null); setState("loading-references");
    try {
      const value = await api.getCampaignContextInspectionReferences(campaignId, sessionId, selectedSource);
      if (request !== generation.current) return;
      setReferences(value.references); setState("references");
    } catch { if (request === generation.current) setState("error"); }
  }
  async function inspect() {
    if (!selectedDispatch) return;
    const request = ++generation.current; setInspection(null); setState("loading-inspection");
    try {
      const value = await api.getCampaignContextInspection(campaignId, sessionId, selectedDispatch.lane, selectedDispatch.dispatchId);
      if (request !== generation.current) return;
      setInspection(value); setState("references");
    } catch { if (request === generation.current) setState("error"); }
  }

  return <section className="dm-context-inspection" aria-labelledby="dm-context-inspection-heading">
    <div className="dm-readiness-heading"><div><h4 id="dm-context-inspection-heading">Context inspection</h4><p>Inspect the bounded, server-reviewed context recorded for one exact provider dispatch. Nothing loads until requested.</p></div></div>
    <label>Turn or director run<select value={sourceKey} onChange={(event) => { setSourceKey(event.target.value); clear(); }}>
      <option value="">Choose an exact source</option>{sources.map((source) => <option key={source.key} value={source.key}>{source.label}</option>)}
    </select></label>
    {!sources.length && <p>No current turn or bounded director run is available.</p>}
    <button type="button" disabled={!selectedSource || state === "loading-references" || state === "loading-inspection"} onClick={() => void loadReferences()}>Load dispatch references</button>
    {state === "loading-references" && <p role="status">Loading dispatch references...</p>}
    {references.length > 0 && <><label>Recorded dispatch<select value={dispatchKey} onChange={(event) => { generation.current += 1; setDispatchKey(event.target.value); setInspection(null); setState("references"); }}>
      <option value="">Choose a dispatch</option>{references.map((reference) => <option key={`${reference.lane}:${reference.dispatchId}`} value={`${reference.lane}:${reference.dispatchId}`}>{laneLabel[reference.lane]} ({reference.dispatchId})</option>)}
    </select></label><button type="button" disabled={!selectedDispatch || state === "loading-inspection"} onClick={() => void inspect()}>Inspect selected dispatch</button></>}
    {state === "references" && references.length === 0 && <p role="status">No recorded provider dispatches are available for this source.</p>}
    {state === "loading-inspection" && <p role="status">Loading safe context inspection...</p>}
    {state === "error" && <p role="alert">Context inspection is unavailable. No command was sent; choose the source and try the read again.</p>}
    {inspection?.availability === "unavailable" && <p role="status">{unavailableLabel[inspection.reason]}</p>}
    {inspection?.availability === "available" && <article className="dm-context-inspection-result" aria-label="Context inspection result">
      <h5>{laneLabel[inspection.identity.lane]}</h5>
      <p>Recorded phase: {inspection.dispatch.recordedPhase}. Certainty: {inspection.dispatch.certainty}. Settlement: {inspection.dispatch.settlement}.</p>
      <h6>Recorded sections</h6>
      {!inspection.sections.length && <p>No safe sections were recorded.</p>}
      {inspection.sections.map((section, index) => section.status === "included"
        ? <section key={index} className="dm-context-inspection-section"><h6>{section.label}</h6><p>{section.text}</p><small>{section.kind}; authority: {section.authority}; {section.displayedUtf8Bytes} displayed UTF-8 bytes</small></section>
        : <p key={index} className="dm-context-withheld"><strong>{section.kind}:</strong> {withheldLabel[section.reason] ?? "Withheld by the server."}</p>)}
      <h6>Recall</h6>
      {!inspection.recallHits.length && <p>No safe recall hits were returned.</p>}
      {inspection.recallHits.map((hit) => <section key={hit.sourceId} className="dm-context-inspection-section"><h6>{hit.sourceLink ? <a href={hit.sourceLink}>{hit.sourceLabel}</a> : hit.sourceLabel}</h6><p>{hit.text}</p><small>Authority: {hit.authority}; {hit.displayedUtf8Bytes} displayed UTF-8 bytes</small></section>)}
      <h6>Usage</h6><dl className="dm-context-usage">{Object.entries(usageLabels).map(([key, label]) => { const value = inspection.usage[key as keyof typeof inspection.usage]; return <div key={key}><dt>{label}</dt><dd>{value === null ? "Withheld or not reported" : value.toLocaleString()}</dd></div>; })}</dl>
    </article>}
  </section>;
}
