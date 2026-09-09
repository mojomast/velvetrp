import { useEffect, useRef, useState } from "react";
import { campaignDmReadinessIssueCatalog, type CampaignDmReadinessResponse } from "@velvet/contracts";
import type { CampaignDmApi } from "./CampaignDmPanel";

const activationLabels: Record<string, string> = {
  "campaign-not-published": "Campaign is not published",
  "safety-paused": "Safety is paused",
  "room-not-startable": "Room is not startable",
  "ambiguous-room": "Room identity is ambiguous",
  "participants-not-ready": "Participants are not ready",
  "content-not-ready": "Published content is not ready",
  "starting-location-required": "A starting location is required",
  "actor-in-other-room": "An actor is assigned to another room",
};

/** Private, read-only preparation diagnostics. Inspection never owns the DM command lock. */
export function CampaignDmReadinessPanel({ campaignId, sessionId, role, api }: {
  campaignId: string; sessionId: string; role: string; api: { getCampaignDmPreparationReadiness: NonNullable<CampaignDmApi["getCampaignDmPreparationReadiness"]> };
}) {
  const [report, setReport] = useState<CampaignDmReadinessResponse | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const generation = useRef(0);
  const identity = JSON.stringify([campaignId, sessionId, role]);

  useEffect(() => {
    generation.current += 1;
    setReport(null);
    setState("idle");
  }, [identity]);

  async function inspect() {
    const request = ++generation.current;
    setState("loading");
    try {
      const value = await api.getCampaignDmPreparationReadiness(campaignId, sessionId);
      if (request !== generation.current) return;
      setReport(value);
      setState("idle");
    } catch {
      if (request !== generation.current) return;
      setReport(null);
      setState("error");
    }
  }

  return <section className="dm-readiness" aria-label="Private preparation readiness">
    <div className="dm-readiness-heading">
      <div><p className="atlas-kicker">OWNER / GM ONLY</p><h4>Preparation readiness</h4></div>
      <button type="button" onClick={() => void inspect()} disabled={state === "loading"}>
        {state === "loading" ? "Inspecting preparation..." : "Inspect preparation"}
      </button>
    </div>
    {state === "error" && <p role="alert">Preparation inspection could not be read. No command or preparation state was changed.</p>}
    {report && <div className="dm-readiness-report">
      <section className="dm-readiness-section" aria-labelledby="dm-activation-heading">
        <h5 id="dm-activation-heading">Activation readiness</h5>
        <p role="status">{report.activationReadiness.ready ? "Ready for room activation" : "Not ready for room activation"}. {report.activationReadiness.active ? "Room is active." : "Room is not active."}</p>
        {!report.activationReadiness.ready && <ul>{report.activationReadiness.blockers.map(blocker => <li key={blocker}>{activationLabels[blocker] ?? "Activation requirement needs review"}</li>)}</ul>}
      </section>
      <section className="dm-readiness-section" aria-labelledby="dm-diagnostics-heading">
        <h5 id="dm-diagnostics-heading">Preparation diagnostics</h5>
        {report.issues.length === 0 ? <p>No deterministic preparation issues were found in the inspected scope.</p> : <ul className="dm-readiness-issues">
          {report.issues.map((issue, index) => {
            const definition = campaignDmReadinessIssueCatalog[issue.code];
            return <li key={`${issue.code}:${issue.reference?.kind ?? "none"}:${issue.reference?.id ?? index}`}>
              <strong>{definition.label}</strong> <span className={`dm-readiness-severity dm-readiness-${issue.severity}`}>{issue.severity}</span>
              <p>{definition.explanation}</p>
              <small>Scope: {issue.scope}. Remediation: {definition.remediation === "binding" ? "use Prepare scene resolution in this panel" : definition.remediation === "play" ? "continue supported play until qualifying evidence is committed" : definition.remediation === "activation" ? "resolve the activation requirement" : definition.remediation === "manual-review" ? "review this preparation manually" : definition.remediation === "coverage" ? "narrow the inspection scope or review omitted families" : `review ${definition.remediation} preparation`}</small>
            </li>;
          })}
        </ul>}
        {report.issues.some(issue => issue.code === "awaiting-play-evidence") && <p role="status">Awaiting play evidence: preparation is bound, but qualifying committed evidence is not yet available.</p>}
      </section>
      <section className="dm-readiness-section" aria-labelledby="dm-coverage-heading">
        <h5 id="dm-coverage-heading">Inspection coverage: {report.coverage.state}</h5>
        <ul className="dm-readiness-coverage">{report.coverage.families.map(family => <li key={family.family}><strong>{family.family}</strong>: {family.state}; {family.inspected.length} inspected, {family.omitted.length} omitted</li>)}</ul>
      </section>
      <section className="dm-readiness-section" aria-labelledby="dm-review-heading">
        <h5 id="dm-review-heading">Manual review limitations</h5>
        <ul>{report.manualReviewLimitations.map(limitation => <li key={limitation}>{limitation}</li>)}</ul>
        <p role="note">This report does not declare the campaign solvable. Deterministic inspection cannot establish every alternative route, finale, aftermath, or player choice.</p>
      </section>
    </div>}
  </section>;
}
