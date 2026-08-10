import { useEffect, useMemo, useRef, useState } from "react";
import type { AdventureTurnConfirmRequest, AdventureTurnGetResponse, AdventureTurnHttpProposal } from "@velvet/contracts";
import { ApiError, type AdventureTurnClientBinding } from "../../../api";

/** Narrow confirmation and reconciliation lane required by the banner. */
export interface ConfirmationBannerApi {
  confirmAdventureTurn: (turnId: string, input: AdventureTurnConfirmRequest, expected: AdventureTurnClientBinding) => Promise<{ turn: AdventureTurnGetResponse["turn"]; resumeToken?: string }>;
  getAdventureTurn: (turnId: string, expected: AdventureTurnClientBinding) => Promise<AdventureTurnGetResponse>;
}

/** Props for one exact pending proposal batch. */
export interface ConfirmationBannerProps {
  turnId: string;
  revision: number;
  proposals: readonly AdventureTurnHttpProposal[];
  proposalIds: readonly string[];
  expiresAt: string;
  binding: AdventureTurnClientBinding;
  api: ConfirmationBannerApi;
  onReconciled: (turn: AdventureTurnGetResponse, resumeToken?: string) => void;
  restoreFocusRef?: React.RefObject<HTMLElement>;
}

const storageKey = (turnId: string) => `velvet.adventure-confirm.v1:${turnId}`;
const makeKey = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const batchFingerprint = (ids: readonly string[]) => {
  let hash = 2166136261;
  for (const unit of ids.join("\0")) { hash ^= unit.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  return `batch-${(hash >>> 0).toString(16)}`;
};

/** Renders a non-executable AI proposal review and performs one locked batch decision. */
export function ConfirmationBanner({ turnId, revision, proposals, proposalIds, expiresAt, binding, api, onReconciled, restoreFocusRef }: ConfirmationBannerProps) {
  const pending = useMemo(() => proposals.filter((proposal) => proposalIds.includes(proposal.proposalId)), [proposalIds, proposals]);
  const pendingBatch = `${revision}\0${proposalIds.join("\0")}`;
  const [selected, setSelected] = useState(() => new Set(proposalIds));
  const [phase, setPhase] = useState<"ready" | "sending" | "ambiguous">("ready");
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const bannerRef = useRef<HTMLElement>(null);
  const activeBatchRef = useRef(pendingBatch);
  activeBatchRef.current = pendingBatch;
  useEffect(() => { bannerRef.current?.focus(); }, [turnId]);
  useEffect(() => {
    setSelected(new Set(proposalIds)); setPhase("ready"); setMessage(""); setFailed(false);
  }, [pendingBatch]);

  async function decide(decision: "approve" | "reject") {
    const exactIds = proposalIds.filter((id) => selected.has(id));
    if (phase !== "ready" || exactIds.length === 0) return;
    const decisionBatch = pendingBatch;
    let idempotencyKey = makeKey();
    try {
      const fingerprint = batchFingerprint(exactIds);
      const stored = JSON.parse(localStorage.getItem(storageKey(turnId)) ?? "null") as { revision?: unknown; batchFingerprint?: unknown; decision?: unknown; idempotencyKey?: unknown } | null;
      if (stored?.revision === revision && stored.decision === decision && stored.batchFingerprint === fingerprint && typeof stored.idempotencyKey === "string") idempotencyKey = stored.idempotencyKey;
      localStorage.setItem(storageKey(turnId), JSON.stringify({ revision, batchFingerprint: fingerprint, decision, idempotencyKey }));
    } catch { /* the in-memory lock still prevents duplicate delivery */ }
    setPhase("sending"); setMessage("Recording your decision…"); setFailed(false);
    let result: { turn: AdventureTurnGetResponse["turn"]; resumeToken?: string };
    try {
      result = await api.confirmAdventureTurn(turnId, { proposalIds: exactIds, decision, expectedRevision: revision, idempotencyKey }, binding);
    } catch (error) {
      if (activeBatchRef.current !== decisionBatch) return;
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        try { localStorage.removeItem(storageKey(turnId)); } catch { /* optional persistence */ }
        setPhase("ready"); setMessage("This decision was rejected. Review the current suggestions and try again."); setFailed(true);
        return;
      }
      // A write failure is commit-ambiguous. Reconcile once by GET; never replay POST.
      setPhase("ambiguous"); setMessage("Decision outcome is uncertain; checking the durable turn without retrying…");
      try {
        const reconciled = await api.getAdventureTurn(turnId, binding);
        if (activeBatchRef.current !== decisionBatch) return;
        try { localStorage.removeItem(storageKey(turnId)); } catch { /* optional */ }
        if (reconciled.confirmation.state === "pending") {
          setPhase("ready"); setMessage("The decision was not committed. Review the current suggestions and submit again if appropriate.");
        }
        onReconciled(reconciled, reconciled.resumeToken); restoreFocusRef?.current?.focus(); return;
      } catch { /* retain the explicit ambiguous state */ }
      setMessage("Decision is still uncertain. Refresh or reconcile this turn; it will not be submitted again automatically.");
      return;
    }
    if (activeBatchRef.current !== decisionBatch) return;
    try {
      const reconciled = await api.getAdventureTurn(turnId, binding);
      if (activeBatchRef.current !== decisionBatch) return;
      try { localStorage.removeItem(storageKey(turnId)); } catch { /* optional persistence */ }
      if (reconciled.confirmation.state === "pending") {
        setPhase("ready"); setMessage("The decision was not committed. Review the current suggestions and submit again if appropriate.");
      }
      onReconciled(reconciled, result.resumeToken); restoreFocusRef?.current?.focus();
    } catch {
      if (activeBatchRef.current !== decisionBatch) return;
      // A lost confirmation response is commit-ambiguous. Reconcile once by GET; never replay POST.
      setPhase("ambiguous"); setMessage("Decision outcome is uncertain; checking the durable turn without retrying…");
      try {
        const reconciled = await api.getAdventureTurn(turnId, binding);
        if (activeBatchRef.current !== decisionBatch) return;
        try { localStorage.removeItem(storageKey(turnId)); } catch { /* optional */ }
        if (reconciled.confirmation.state === "pending") {
          setPhase("ready"); setMessage("The decision was not committed. Review the current suggestions and submit again if appropriate.");
        }
        onReconciled(reconciled, reconciled.resumeToken); restoreFocusRef?.current?.focus(); return;
      } catch { /* retain the lock and explicit ambiguous state */ }
      setMessage("Decision is still uncertain. Refresh or reconcile this turn; it will not be submitted again automatically.");
    }
  }

  return <section ref={bannerRef} tabIndex={-1} className="confirmation-banner" aria-labelledby="confirmation-heading">
    <div className="confirmation-labels"><strong>AI suggestion</strong><strong>Confirmation required</strong></div>
    <h2 id="confirmation-heading">Review suggested mechanics</h2>
    <p>These suggestions contain no recorded execution binding or arguments. The server remains authoritative.</p>
    <p>Expires <time dateTime={expiresAt}>{new Date(expiresAt).toLocaleString()}</time></p>
    <fieldset disabled={phase !== "ready"}><legend>Select the exact suggestions to decide</legend>
      {pending.map((proposal) => <label key={proposal.proposalId}><input type="checkbox" checked={selected.has(proposal.proposalId)} onChange={(event) => {
        setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(proposal.proposalId); else next.delete(proposal.proposalId); return next; });
      }} /><span><strong>{proposal.policy.review.summary}</strong>
        <small>{proposal.policy.review.consequences.map((consequence)=>consequence.text).join("; ")}</small>
        <small>{proposal.policy.requiredAuthorizer === "gm" ? "Owner or GM approval required" : "Controller approval required"} · execution details not exposed</small></span></label>)}
    </fieldset>
    <div className="button-row"><button className="primary" disabled={phase !== "ready" || selected.size === 0} onClick={() => void decide("approve")}>Approve selected batch</button>
      <button className="danger subtle" disabled={phase !== "ready" || selected.size === 0} onClick={() => void decide("reject")}>Reject selected batch</button></div>
    {message && <p role={phase === "ambiguous" || failed ? "alert" : "status"}>{message}</p>}
  </section>;
}
