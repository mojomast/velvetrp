import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type {
  CampaignAdministration,
  CampaignAdministrationHttpMembership,
  CampaignAdministrationReceipt,
  CampaignHistoryHttpCheckpoint,
  CampaignHistoryHttpCommandReceipt,
  CampaignHistoryHttpTimeline,
  CampaignImportReport,
  CampaignLifecycleStatus,
  CampaignMemberRole,
  CampaignTransferPackage,
} from "@velvet/contracts";
import {
  ApiError,
  addCampaignAdministrationMembership,
  archiveCampaignAdministration,
  createCampaignCheckpoint,
  dryRunCampaignImport,
  forkCampaignTimeline,
  getCampaignAdministration,
  getCampaignDetail,
  listCampaignCheckpoints,
  listCampaignMemberships,
  listCampaignTimelines,
  removeCampaignAdministrationMembership,
  updateCampaignAdministration,
  updateCampaignAdministrationMembership,
} from "../../../api";
import { CampaignSettingsForm } from "./CampaignSettingsForm";
import { MembershipManager } from "./MembershipManager";
import { TimelineCheckpointPanel } from "./TimelineCheckpointPanel";

export interface CampaignAdministrationPageProps {
  campaignId: string;
  campaignName?: string;
  onBack: () => void;
  onUnavailable: () => void;
  focusHeadingRequest?: number;
  onHeadingFocused?: (request: number) => void;
}

type MutationKind = "settings" | "lifecycle" | "archive" | "membership" | "checkpoint" | "fork";
type Receipt = CampaignAdministrationReceipt | CampaignHistoryHttpCommandReceipt;
interface UncertainMutation { kind: MutationKind; message: string }

// Commit ambiguity survives route unmounts for this document. The only way to
// clear it is an explicit authoritative refresh; no write is ever replayed.
const uncertainCampaignMutations = new Map<string, UncertainMutation>();
const inFlightCampaignAdministration = new Set<string>();

function idempotencyKey(kind: string): string {
  const unique = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ui-${kind}-${unique}`;
}

function isKnownNonCommit(error: unknown): boolean {
  return error instanceof ApiError && [400, 404, 409, 415, 422].includes(error.status);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function receiptSummary(receipt: Receipt): string {
  return `Confirmed by receipt at revision ${receipt.revisionAfter} on ${new Date(receipt.occurredAt).toLocaleString()}.`;
}

export function CampaignAdministrationPage({ campaignId, campaignName: initialName = "", onBack, onUnavailable, focusHeadingRequest, onHeadingFocused = () => undefined }: CampaignAdministrationPageProps) {
  const [campaign, setCampaign] = useState<CampaignAdministration | null>(null);
  const [campaignName, setCampaignName] = useState(initialName);
  const [memberships, setMemberships] = useState<CampaignAdministrationHttpMembership[]>([]);
  const [timelines, setTimelines] = useState<CampaignHistoryHttpTimeline[]>([]);
  const [activeTimelineId, setActiveTimelineId] = useState("");
  const [checkpoints, setCheckpoints] = useState<CampaignHistoryHttpCheckpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(() => inFlightCampaignAdministration.has(campaignId));
  const [uncertain, setUncertain] = useState<UncertainMutation | null>(() => uncertainCampaignMutations.get(campaignId) ?? null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importReport, setImportReport] = useState<CampaignImportReport | null>(null);
  const [importPackage, setImportPackage] = useState<CampaignTransferPackage | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const focusedRequestRef = useRef<number | undefined>(undefined);
  const onHeadingFocusedRef = useRef(onHeadingFocused);
  onHeadingFocusedRef.current = onHeadingFocused;

  const load = useCallback(async (explicitRefresh = false, preserveCurrent = false): Promise<boolean> => {
    const generation = ++generationRef.current;
    if (explicitRefresh) setRefreshing(true); else if (!preserveCurrent) setLoading(true);
    if (!preserveCurrent) setFailed(false);
    setError("");
    try {
      const [administration, timelineData, checkpointData, detail] = await Promise.all([
        getCampaignAdministration(campaignId),
        listCampaignTimelines(campaignId),
        listCampaignCheckpoints(campaignId),
        initialName ? Promise.resolve(null) : getCampaignDetail(campaignId).catch(() => null),
      ]);
      const membershipData = administration.campaign.actorRole === "owner"
        ? await listCampaignMemberships(campaignId) : { memberships: [] };
      if (!mountedRef.current || generation !== generationRef.current) return false;
      setCampaign(administration.campaign);
      if (detail) setCampaignName(detail.campaign.name);
      else if (initialName) setCampaignName(initialName);
      setMemberships(membershipData.memberships);
      setTimelines(timelineData.timelines);
      setActiveTimelineId(timelineData.activeTimelineId);
      setCheckpoints(checkpointData.checkpoints);
      setLoading(false); setRefreshing(false);
      if (explicitRefresh) {
        uncertainCampaignMutations.delete(campaignId);
        setUncertain(null);
        setNotice("Authoritative campaign administration, memberships, timelines, and checkpoints were refreshed. No write was retried.");
        queueMicrotask(() => statusRef.current?.focus());
      } else if (focusHeadingRequest !== undefined && focusedRequestRef.current !== focusHeadingRequest) {
        focusedRequestRef.current = focusHeadingRequest;
        queueMicrotask(() => { headingRef.current?.focus(); onHeadingFocusedRef.current(focusHeadingRequest); });
      }
      return true;
    } catch (loadError) {
      if (!mountedRef.current || generation !== generationRef.current) return false;
      if (loadError instanceof ApiError && loadError.status === 404) { onUnavailable(); return false; }
      setFailed(!preserveCurrent); setLoading(false); setRefreshing(false);
      setError(preserveCurrent
        ? "The command receipt confirmed success, but fresh authoritative state could not be loaded. Refresh before another write."
        : "Campaign administration could not be loaded.");
      if (explicitRefresh) queueMicrotask(() => (preserveCurrent ? statusRef.current : retryRef.current)?.focus());
      return false;
    }
  }, [campaignId, focusHeadingRequest, initialName, onUnavailable]);

  useEffect(() => {
    mountedRef.current = true;
    setCampaign(null); setMemberships([]); setTimelines([]); setCheckpoints([]);
    setNotice(""); setError(""); setImportReport(null); setImportPackage(null); setImportError("");
    setBusy(inFlightCampaignAdministration.has(campaignId));
    setUncertain(uncertainCampaignMutations.get(campaignId) ?? null);
    void load();
    return () => { mountedRef.current = false; generationRef.current += 1; };
  }, [campaignId, load]);

  async function mutate(kind: MutationKind, write: () => Promise<{ receipt: Receipt }>): Promise<void> {
    if (busy || uncertain || inFlightCampaignAdministration.has(campaignId)) return;
    inFlightCampaignAdministration.add(campaignId);
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await write();
      if (!mountedRef.current) return;
      setNotice(receiptSummary(result.receipt));
      // A valid bound receipt proves the exact commit. Read reconciliation is
      // safe and never turns success into failure or repeats the command.
      const refreshed = await load(false, true);
      if (mountedRef.current) {
        if (refreshed) setNotice(receiptSummary(result.receipt));
        else {
          const lock = { kind, message: `${receiptSummary(result.receipt)} Fresh authoritative state is unavailable, so further writes are locked until refresh.` };
          uncertainCampaignMutations.set(campaignId, lock);
          setUncertain(lock);
        }
        queueMicrotask(() => statusRef.current?.focus());
      }
    } catch (mutationError) {
      if (!mountedRef.current) return;
      if (isKnownNonCommit(mutationError)) setError(errorMessage(mutationError, "The change was rejected. Refresh before editing stale state."));
      else {
        const lock = { kind, message: "The write outcome is uncertain. Duplicate submission is locked until you refresh authoritative state; the write will not be retried." };
        uncertainCampaignMutations.set(campaignId, lock);
        setUncertain(lock); setError(lock.message);
      }
      queueMicrotask(() => statusRef.current?.focus());
    } finally {
      inFlightCampaignAdministration.delete(campaignId);
      if (mountedRef.current) setBusy(false);
    }
  }

  async function chooseImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setImportReport(null); setImportPackage(null); setImportError("");
    if (!file) return;
    if (file.size > 1_000_000) { setImportError("Import packages must be 1 MB or smaller."); return; }
    try {
      const value = JSON.parse(await file.text()) as unknown;
      if (typeof value !== "object" || value === null || !("package" in value)) throw new Error("missing package");
      setImportPackage((value as { package: CampaignTransferPackage }).package);
    } catch { setImportError("Choose a Velvet campaign export JSON document."); }
  }

  async function inspectImport() {
    if (!importPackage || importBusy) return;
    setImportBusy(true); setImportError(""); setImportReport(null);
    try {
      const result = await dryRunCampaignImport({ package: importPackage, mode: "dry-run" });
      if (mountedRef.current) setImportReport(result.report);
    } catch (reportError) {
      if (mountedRef.current) setImportError(errorMessage(reportError, "The import report could not be created. No campaign state was changed."));
    } finally { if (mountedRef.current) setImportBusy(false); }
  }

  if (loading && !campaign) return <main className="page library-page campaign-page administration-page"><section className="campaign-shell"><header className="library-header"><div><button className="back-link" onClick={onBack}>← Campaign</button><p className="eyebrow">CAMPAIGN ADMINISTRATION</p><h1 className="title">Opening administration…</h1></div></header><div className="library-panel admin-loading" aria-busy="true"><p>Loading permitted campaign controls…</p></div></section></main>;
  if (failed || !campaign) return <main className="page library-page campaign-page administration-page"><section className="campaign-shell"><header className="library-header"><div><button className="back-link" onClick={onBack}>← Campaign</button><p className="eyebrow">CAMPAIGN ADMINISTRATION</p><h1 className="title">Administration unavailable</h1></div></header><div className="library-panel admin-error"><p role="alert">{error}</p><button ref={retryRef} className="primary" onClick={() => void load(Boolean(uncertain))}>Try again</button></div></section></main>;

  const owner = campaign.actorRole === "owner";
  const expectedRevision = campaign.revision;
  return <main className="page library-page campaign-page administration-page"><section className="campaign-shell" aria-labelledby="administration-heading">
    <header className="library-header"><div><button className="back-link" disabled={busy} onClick={onBack}>← Campaign</button><p className="eyebrow">TRUSTED LOCAL · {campaign.actorRole.toUpperCase()} VIEW</p><h1 ref={headingRef} tabIndex={-1} className="title" id="administration-heading">Campaign administration</h1><p className="subtitle">{campaignName || "Current campaign"}</p></div><button className="ghost" disabled={busy || refreshing} onClick={() => void load(true, true)}>{refreshing ? "Refreshing…" : "Refresh"}</button></header>

    {(notice || error || uncertain) && <div ref={statusRef} tabIndex={-1} className={`admin-status ${error ? "is-error" : "is-success"}`} role={error ? "alert" : "status"}>
      <p>{error || notice}</p>
      {uncertain && <button className="primary" disabled={refreshing} onClick={() => void load(true, true)}>{refreshing ? "Refreshing authoritative state…" : "Refresh authoritative state"}</button>}
    </div>}

    <div className="admin-grid" aria-busy={busy || refreshing}>
      <CampaignSettingsForm campaign={campaign} campaignName={campaignName} busy={busy} mutationLocked={Boolean(uncertain)}
        onSave={(patch) => void mutate("settings", () => updateCampaignAdministration(campaignId, { ...patch, expectedRevision, idempotencyKey: idempotencyKey("settings") }))}
        onStatusChange={(status: CampaignLifecycleStatus) => void mutate("lifecycle", () => updateCampaignAdministration(campaignId, { status, expectedRevision, idempotencyKey: idempotencyKey("lifecycle") }))}
        onArchive={(confirmationName) => void mutate("archive", () => archiveCampaignAdministration(campaignId, { confirmationName, expectedRevision, idempotencyKey: idempotencyKey("archive") }))} />

      {owner && <MembershipManager memberships={memberships} busy={busy} mutationLocked={Boolean(uncertain)}
        onAdd={(principalId, role) => void mutate("membership", () => addCampaignAdministrationMembership(campaignId, { principalId, role, expectedRevision, idempotencyKey: idempotencyKey("member-add") }))}
        onChangeRole={(principalId, role: Exclude<CampaignMemberRole, "owner">) => void mutate("membership", () => updateCampaignAdministrationMembership(campaignId, principalId, { role, expectedRevision, idempotencyKey: idempotencyKey("member-role") }))}
        onRemove={(principalId) => void mutate("membership", () => removeCampaignAdministrationMembership(campaignId, principalId, { expectedRevision, idempotencyKey: idempotencyKey("member-remove") }))} />}

      <TimelineCheckpointPanel timelines={timelines} activeTimelineId={activeTimelineId} checkpoints={checkpoints} canMutate={owner} busy={busy} mutationLocked={Boolean(uncertain)}
        onCreateCheckpoint={(label, timelineId, timelineRevision) => void mutate("checkpoint", () => createCampaignCheckpoint(campaignId, { label, timelineId, timelineRevision, expectedRevision, idempotencyKey: idempotencyKey("checkpoint") }))}
        onFork={(checkpointId) => void mutate("fork", () => forkCampaignTimeline(campaignId, { checkpointId, expectedRevision, idempotencyKey: idempotencyKey("fork") }))} />

      {owner && <section className="admin-section import-report" aria-labelledby="import-report-heading">
        <div className="admin-section-heading"><div><p className="eyebrow">TRANSFER REVIEW</p><h2 id="import-report-heading">Inspect an import report</h2></div></div>
        <p className="admin-help">A dry run validates a local Velvet export without changing campaign state. Applying imports is a separate operation.</p>
        <label className="field"><span>Velvet campaign export JSON</span><input type="file" accept="application/json,.json" disabled={importBusy} onChange={(event) => void chooseImportFile(event)} /></label>
        <button className="primary" disabled={!importPackage || importBusy} onClick={() => void inspectImport()}>{importBusy ? "Inspecting…" : "Create dry-run report"}</button>
        {importError && <p className="form-error" role="alert">{importError}</p>}
        {importReport && <div className={`import-report-result ${importReport.valid ? "is-valid" : "is-invalid"}`} role="status">
          <h3>{importReport.valid ? "Import package is valid" : "Import package needs attention"}</h3>
          <dl>{Object.entries(importReport.counts).map(([label, count]) => <div key={label}><dt>{label.replace(/([A-Z])/g, " $1")}</dt><dd>{count}</dd></div>)}</dl>
          {(["conflicts", "missingReferences", "warnings"] as const).map((kind) => importReport[kind].length > 0 && <section key={kind}><h4>{kind.replace(/([A-Z])/g, " $1")}</h4><ul>{importReport[kind].map((entry, index) => <li key={`${kind}-${index}`}>{entry}</li>)}</ul></section>)}
        </div>}
      </section>}
    </div>
  </section></main>;
}
