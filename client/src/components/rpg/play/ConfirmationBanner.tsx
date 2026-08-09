import { useEffect, useMemo, useRef, useState } from "react";
import type { AdventureTurnConfirmRequest, AdventureTurnGetResponse, RoleSafeToolProposal } from "@velvet/contracts";

/** Narrow confirmation and reconciliation lane required by the banner. */
export interface ConfirmationBannerApi {
  confirmAdventureTurn: (turnId: string, input: AdventureTurnConfirmRequest) => Promise<{ turn: AdventureTurnGetResponse["turn"]; resumeToken?: string }>;
  getAdventureTurn: (turnId: string) => Promise<AdventureTurnGetResponse>;
}

/** Props for one exact pending proposal batch. */
export interface ConfirmationBannerProps {
  turnId: string;
  revision: number;
  proposals: readonly RoleSafeToolProposal[];
  proposalIds: readonly string[];
  expiresAt: string;
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
export function ConfirmationBanner({ turnId, revision, proposals, proposalIds, expiresAt, api, onReconciled, restoreFocusRef }: ConfirmationBannerProps) {
  const pending = useMemo(() => proposals.filter((proposal) => proposalIds.includes(proposal.proposalId)), [proposalIds, proposals]);
  const [selected, setSelected] = useState(() => new Set(proposalIds));
  const [phase, setPhase] = useState<"ready" | "sending" | "ambiguous">("ready");
  const [message, setMessage] = useState("");
  const bannerRef = useRef<HTMLElement>(null);
  useEffect(() => { bannerRef.current?.focus(); }, [turnId]);
  useEffect(() => { setSelected(new Set(proposalIds)); }, [proposalIds]);

  async function decide(decision: "approve" | "reject") {
    const exactIds = proposalIds.filter((id) => selected.has(id));
    if (phase !== "ready" || exactIds.length === 0) return;
    let idempotencyKey = makeKey();
    try {
      const fingerprint = batchFingerprint(exactIds);
      const stored = JSON.parse(localStorage.getItem(storageKey(turnId)) ?? "null") as { revision?: unknown; batchFingerprint?: unknown; decision?: unknown; idempotencyKey?: unknown } | null;
      if (stored?.revision === revision && stored.decision === decision && stored.batchFingerprint === fingerprint && typeof stored.idempotencyKey === "string") idempotencyKey = stored.idempotencyKey;
      localStorage.setItem(storageKey(turnId), JSON.stringify({ revision, batchFingerprint: fingerprint, decision, idempotencyKey }));
    } catch { /* the in-memory lock still prevents duplicate delivery */ }
    setPhase("sending"); setMessage("Recording your decision…");
    try {
      const result = await api.confirmAdventureTurn(turnId, { proposalIds: exactIds, decision, expectedRevision: revision, idempotencyKey });
      const reconciled = await api.getAdventureTurn(turnId);
      try { localStorage.removeItem(storageKey(turnId)); } catch { /* optional persistence */ }
      onReconciled(reconciled, result.resumeToken); restoreFocusRef?.current?.focus();
    } catch {
      // A write failure is commit-ambiguous. Reconcile once by GET; never replay POST.
      setPhase("ambiguous"); setMessage("Decision outcome is uncertain; checking the durable turn without retrying…");
      try {
        const reconciled = await api.getAdventureTurn(turnId);
        if (reconciled.confirmation.state !== "pending") { try { localStorage.removeItem(storageKey(turnId)); } catch { /* optional */ }
          onReconciled(reconciled); restoreFocusRef?.current?.focus(); return; }
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
      }} /><span><strong>{proposal.toolName}</strong><small>AI suggestion · execution details not exposed</small></span></label>)}
    </fieldset>
    <div className="button-row"><button className="primary" disabled={phase !== "ready" || selected.size === 0} onClick={() => void decide("approve")}>Approve selected batch</button>
      <button className="danger subtle" disabled={phase !== "ready" || selected.size === 0} onClick={() => void decide("reject")}>Reject selected batch</button></div>
    {message && <p role={phase === "ambiguous" ? "alert" : "status"}>{message}</p>}
  </section>;
}
