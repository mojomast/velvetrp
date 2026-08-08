import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import type {
  CampaignAdministration,
  CampaignAdministrationHttpMembership,
  CampaignAdministrationReceipt,
  CampaignHistoryHttpCheckpoint,
  CampaignHistoryHttpCommandReceipt,
  CampaignHistoryHttpTimeline,
  CampaignImportReport,
  ContentCatalogHttpCampaignContent,
  ContentCatalogHttpCampaignContentReceipt,
  ContentCatalogHttpCampaignPack,
  PublicationSummary,
  CampaignLifecycleStatus,
  CampaignMemberRole,
  CampaignTransferPackage,
} from "@velvet/contracts";
import {
  ApiError,
  ApiInputError,
  addCampaignAdministrationMembership,
  archiveCampaignAdministration,
  createCampaignCheckpoint,
  configureCampaignContent,
  dryRunCampaignImport,
  forkCampaignTimeline,
  getCampaignAdministration,
  getCampaignContent,
  getCampaignContentPack,
  getCampaignDetail,
  listCampaignCheckpoints,
  listCampaignMemberships,
  listAllContentPackPublications,
  listCampaignTimelines,
  removeCampaignAdministrationMembership,
  updateCampaignAdministration,
  updateCampaignAdministrationMembership,
} from "../../../api";
import { CampaignSettingsForm } from "./CampaignSettingsForm";
import { MembershipManager } from "./MembershipManager";
import { TimelineCheckpointPanel } from "./TimelineCheckpointPanel";
import { CampaignContentPicker } from "../content/CampaignContentPicker";

export interface CampaignAdministrationPageProps {
  campaignId: string;
  campaignName?: string;
  onBack: () => void;
  onUnavailable: () => void;
  focusHeadingRequest?: number;
  onHeadingFocused?: (request: number) => void;
}

type MutationKind = "settings" | "lifecycle" | "archive" | "membership" | "checkpoint" | "fork" | "content";
type Receipt = CampaignAdministrationReceipt | CampaignHistoryHttpCommandReceipt | ContentCatalogHttpCampaignContentReceipt;
interface CampaignMutationEntry {
  token: symbol;
  kind: MutationKind;
  phase: "writing" | "reconciling" | "uncertain";
  message: string;
}

// This registry is document-lifetime rather than component-lifetime. A route
// unmount cannot release a write whose delivery or reconciliation is unknown.
const campaignMutationRegistry = new Map<string, CampaignMutationEntry>();
const campaignMutationListeners = new Set<(campaignId: string, entry: CampaignMutationEntry | null) => void>();

function publishMutation(campaignId: string, entry: CampaignMutationEntry | null): void {
  if (entry) campaignMutationRegistry.set(campaignId, entry);
  else campaignMutationRegistry.delete(campaignId);
  for (const listener of campaignMutationListeners) listener(campaignId, entry);
}

function clearMutation(campaignId: string, token: symbol): void {
  if (campaignMutationRegistry.get(campaignId)?.token === token) publishMutation(campaignId, null);
}

export function resetCampaignAdministrationPageModuleStateForTests(): void {
  campaignMutationRegistry.clear();
  campaignMutationListeners.clear();
}

function idempotencyKey(kind: string): string {
  const unique = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `ui-${kind}-${unique}`;
}

function isKnownNonCommit(error: unknown): boolean {
  return error instanceof ApiInputError
    || (error instanceof ApiError && [400, 404, 409, 415, 422].includes(error.status));
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

function receiptSummary(receipt: Receipt): string {
  const occurredAt = "occurredAt" in receipt ? receipt.occurredAt : receipt.configuredAt;
  return `Confirmed by receipt at revision ${receipt.revisionAfter} on ${new Date(occurredAt).toLocaleString()}.`;
}

function definitionsByKind(catalog: ContentCatalogHttpCampaignPack) {
  const groups = new Map<string, ContentCatalogHttpCampaignPack["definitions"]>();
  for (const definition of catalog.definitions) groups.set(definition.reference.kind, [...(groups.get(definition.reference.kind) ?? []), definition] as ContentCatalogHttpCampaignPack["definitions"]);
  return [...groups.entries()];
}

export function CampaignAdministrationPage({ campaignId, campaignName: initialName = "", onBack, onUnavailable, focusHeadingRequest, onHeadingFocused = () => undefined }: CampaignAdministrationPageProps) {
  const [campaign, setCampaign] = useState<CampaignAdministration | null>(null);
  const [campaignName, setCampaignName] = useState<string | null>(null);
  const [campaignNameLoading, setCampaignNameLoading] = useState(false);
  const [memberships, setMemberships] = useState<CampaignAdministrationHttpMembership[]>([]);
  const [timelines, setTimelines] = useState<CampaignHistoryHttpTimeline[]>([]);
  const [activeTimelineId, setActiveTimelineId] = useState("");
  const [checkpoints, setCheckpoints] = useState<CampaignHistoryHttpCheckpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mutationEntry, setMutationEntry] = useState<CampaignMutationEntry | null>(() => campaignMutationRegistry.get(campaignId) ?? null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState("");
  const [importReport, setImportReport] = useState<CampaignImportReport | null>(null);
  const [importPackage, setImportPackage] = useState<CampaignTransferPackage | null>(null);
  const [catalogContent, setCatalogContent] = useState<ContentCatalogHttpCampaignContent | null>(null);
  const [catalogPublications, setCatalogPublications] = useState<PublicationSummary[]>([]);
  const [catalogPack, setCatalogPack] = useState<ContentCatalogHttpCampaignPack | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [catalogInspecting, setCatalogInspecting] = useState(false);
  const mountedRef = useRef(true);
  const activeCampaignRef = useRef(campaignId);
  const generationRef = useRef(0);
  const nameGenerationRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const focusedRequestRef = useRef<number | undefined>(undefined);
  const onHeadingFocusedRef = useRef(onHeadingFocused);
  onHeadingFocusedRef.current = onHeadingFocused;
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  const queueScoped = useCallback((requestedCampaignId: string, generation: number, action: () => void) => {
    queueMicrotask(() => {
      if (mountedRef.current && activeCampaignRef.current === requestedCampaignId
        && generationRef.current === generation) action();
    });
  }, []);

  const load = useCallback(async (explicitRefresh = false, preserveCurrent = false): Promise<boolean> => {
    const requestedCampaignId = campaignId;
    const generation = ++generationRef.current;
    const refreshEntry = campaignMutationRegistry.get(requestedCampaignId) ?? null;
    if (explicitRefresh) setRefreshing(true); else if (!preserveCurrent) setLoading(true);
    if (!preserveCurrent) setFailed(false);
    setError("");
    try {
      const [administration, timelineData, checkpointData] = await Promise.all([
        getCampaignAdministration(requestedCampaignId),
        listCampaignTimelines(requestedCampaignId),
        listCampaignCheckpoints(requestedCampaignId),
      ]);
      const [membershipResult, detailResult, contentResult, publicationsResult] = await Promise.allSettled([
        administration.campaign.actorRole === "owner"
          ? listCampaignMemberships(requestedCampaignId) : Promise.resolve({ memberships: [] }),
        getCampaignDetail(requestedCampaignId),
        getCampaignContent(requestedCampaignId),
        listAllContentPackPublications(),
      ]);
      if (membershipResult.status === "rejected") throw membershipResult.reason;
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
        || generation !== generationRef.current) return false;
      setCampaign(administration.campaign);
      setCampaignName(detailResult.status === "fulfilled" ? detailResult.value.campaign.name : null);
      setCampaignNameLoading(false);
      setMemberships(membershipResult.value.memberships);
      setTimelines(timelineData.timelines);
      setActiveTimelineId(timelineData.activeTimelineId);
      setCheckpoints(checkpointData.checkpoints);
      setCatalogContent(contentResult.status === "fulfilled" ? contentResult.value.content : null);
      setCatalogPublications(publicationsResult.status === "fulfilled" ? publicationsResult.value.publications : []);
      setCatalogError((contentResult.status === "rejected" && !(contentResult.reason instanceof ApiError && contentResult.reason.status === 404))
        || (publicationsResult.status === "rejected" && !(publicationsResult.reason instanceof ApiError && publicationsResult.reason.status === 404))
        ? "Campaign content could not be loaded. Refresh authoritative administration before changing pins." : "");
      setLoading(false); setRefreshing(false);
      if (refreshEntry?.kind === "content" && (contentResult.status !== "fulfilled" || publicationsResult.status !== "fulfilled")) {
        setError("Authoritative campaign pins and sealed publications could not both be refreshed. Content writes remain locked; no PUT was retried.");
        queueScoped(requestedCampaignId, generation, () => statusRef.current?.focus());
        return false;
      }
      if (detailResult.status === "rejected" && (explicitRefresh || preserveCurrent)) {
        setError("Authoritative campaign state loaded, but the campaign name could not be verified. Archive and further writes remain locked; retry the full authoritative refresh.");
        queueScoped(requestedCampaignId, generation, () => statusRef.current?.focus());
        return false;
      }
      if (explicitRefresh) {
        if (refreshEntry?.phase === "uncertain"
          && campaignMutationRegistry.get(requestedCampaignId)?.token === refreshEntry.token) {
          clearMutation(requestedCampaignId, refreshEntry.token);
        }
        setNotice("Authoritative campaign administration, memberships, timelines, and checkpoints were refreshed. No write was retried.");
        queueScoped(requestedCampaignId, generation, () => statusRef.current?.focus());
      } else if (focusHeadingRequest !== undefined && focusedRequestRef.current !== focusHeadingRequest) {
        focusedRequestRef.current = focusHeadingRequest;
        queueScoped(requestedCampaignId, generation, () => {
          headingRef.current?.focus(); onHeadingFocusedRef.current(focusHeadingRequest);
        });
      }
      return true;
    } catch (loadError) {
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
        || generation !== generationRef.current) return false;
      if (loadError instanceof ApiError && loadError.status === 404) { onUnavailableRef.current(); return false; }
      setFailed(!preserveCurrent); setLoading(false); setRefreshing(false);
      setError(preserveCurrent
        ? "The command receipt confirmed success, but fresh authoritative state could not be loaded. Refresh before another write."
        : "Campaign administration could not be loaded.");
      if (explicitRefresh || !preserveCurrent) queueScoped(requestedCampaignId, generation,
        () => (preserveCurrent ? statusRef.current : retryRef.current)?.focus());
      return false;
    }
  }, [campaignId, focusHeadingRequest, queueScoped]);

  useEffect(() => {
    mountedRef.current = true;
    activeCampaignRef.current = campaignId;
    setCampaign(null); setMemberships([]); setTimelines([]); setCheckpoints([]);
    setCampaignName(null); setCampaignNameLoading(false);
    setNotice(""); setError(""); setImportReport(null); setImportPackage(null); setImportError("");
    setCatalogContent(null); setCatalogPublications([]); setCatalogPack(null); setCatalogError(""); setCatalogInspecting(false);
    const currentEntry = campaignMutationRegistry.get(campaignId) ?? null;
    setMutationEntry(currentEntry);
    if (currentEntry?.phase === "uncertain") setError(currentEntry.message);
    const listener = (changedCampaignId: string, entry: CampaignMutationEntry | null) => {
      if (!mountedRef.current || activeCampaignRef.current !== changedCampaignId) return;
      setMutationEntry(entry);
      if (entry?.phase === "uncertain") setError(entry.message);
    };
    campaignMutationListeners.add(listener);
    void load();
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      nameGenerationRef.current += 1;
      campaignMutationListeners.delete(listener);
    };
  }, [campaignId, load]);

  async function mutate(kind: MutationKind, write: () => Promise<{ receipt: Receipt }>): Promise<void> {
    if (mutationEntry || campaignMutationRegistry.has(campaignId)) return;
    const requestedCampaignId = campaignId;
    const token = Symbol(`${kind}:${requestedCampaignId}`);
    publishMutation(requestedCampaignId, { token, kind, phase: "writing", message: "A campaign write is still in progress." });
    setError(""); setNotice("");
    try {
      const result = await write();
      if (campaignMutationRegistry.get(requestedCampaignId)?.token !== token) return;
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId) {
        publishMutation(requestedCampaignId, { token, kind, phase: "uncertain",
          message: `${receiptSummary(result.receipt)} The route closed before authoritative reconciliation, so further writes remain locked.` });
        return;
      }
      setNotice(receiptSummary(result.receipt));
      // A valid bound receipt proves the exact commit. Read reconciliation is
      // safe and never turns success into failure or repeats the command.
      publishMutation(requestedCampaignId, { token, kind, phase: "reconciling", message: "The confirmed write is being reconciled." });
      const refreshed = await load(false, true);
      if (campaignMutationRegistry.get(requestedCampaignId)?.token !== token) return;
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId) {
        publishMutation(requestedCampaignId, { token, kind, phase: "uncertain",
          message: `${receiptSummary(result.receipt)} Reconciliation was interrupted, so further writes remain locked.` });
        return;
      }
      if (refreshed) {
        clearMutation(requestedCampaignId, token);
        setNotice(receiptSummary(result.receipt));
      } else {
        publishMutation(requestedCampaignId, { token, kind, phase: "uncertain",
          message: `${receiptSummary(result.receipt)} Fresh authoritative state is unavailable, so further writes are locked until refresh.` });
      }
      queueScoped(requestedCampaignId, generationRef.current, () => statusRef.current?.focus());
    } catch (mutationError) {
      if (campaignMutationRegistry.get(requestedCampaignId)?.token !== token) return;
      if (kind === "content" && mutationError instanceof ApiError && mutationError.status === 409) {
        publishMutation(requestedCampaignId, { token, kind, phase: "uncertain",
          message: "Campaign pins are stale or conflict with current state. Duplicate submission is locked until authoritative campaign content is refreshed; the PUT will not be retried." });
      } else if (isKnownNonCommit(mutationError)) {
        clearMutation(requestedCampaignId, token);
        if (mountedRef.current && activeCampaignRef.current === requestedCampaignId) {
          setError(errorMessage(mutationError, "The change was rejected. Refresh before editing stale state."));
        }
      } else {
        const entry = { token, kind, phase: "uncertain" as const, message: "The write outcome is uncertain. Duplicate submission is locked until you refresh authoritative state; the write will not be retried." };
        publishMutation(requestedCampaignId, entry);
      }
      if (mountedRef.current && activeCampaignRef.current === requestedCampaignId) {
        queueScoped(requestedCampaignId, generationRef.current, () => statusRef.current?.focus());
      }
    }
  }

  async function retryCampaignName(): Promise<void> {
    if (campaignNameLoading) return;
    const requestedCampaignId = campaignId;
    const nameGeneration = ++nameGenerationRef.current;
    const pageGeneration = generationRef.current;
    setCampaignNameLoading(true); setError("");
    try {
      const detail = await getCampaignDetail(requestedCampaignId);
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
        || nameGenerationRef.current !== nameGeneration || generationRef.current !== pageGeneration) return;
      setCampaignName(detail.campaign.name);
      setNotice("Authoritative campaign name loaded. Archive confirmation is now available.");
      queueScoped(requestedCampaignId, pageGeneration, () => statusRef.current?.focus());
    } catch {
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId
        || nameGenerationRef.current !== nameGeneration || generationRef.current !== pageGeneration) return;
      setCampaignName(null);
      setError("The authoritative campaign name still could not be loaded. Archive remains unavailable.");
      queueScoped(requestedCampaignId, pageGeneration, () => statusRef.current?.focus());
    } finally {
      if (mountedRef.current && activeCampaignRef.current === requestedCampaignId
        && nameGenerationRef.current === nameGeneration) setCampaignNameLoading(false);
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

  async function inspectCampaignPack(packId: string, packVersion: string): Promise<void> {
    if (catalogInspecting) return;
    const requestedCampaignId = campaignId;
    const generation = generationRef.current;
    setCatalogInspecting(true); setCatalogError("");
    try {
      const response = await getCampaignContentPack(requestedCampaignId, packId, packVersion);
      if (!mountedRef.current || activeCampaignRef.current !== requestedCampaignId || generationRef.current !== generation) return;
      setCatalogPack(response.catalog);
    } catch {
      if (mountedRef.current && activeCampaignRef.current === requestedCampaignId && generationRef.current === generation) {
        setCatalogError("That exact campaign pack projection could not be loaded.");
      }
    } finally {
      if (mountedRef.current && activeCampaignRef.current === requestedCampaignId && generationRef.current === generation) setCatalogInspecting(false);
    }
  }

  const busy = mutationEntry?.phase === "writing" || mutationEntry?.phase === "reconciling";
  const uncertain = mutationEntry?.phase === "uncertain" ? mutationEntry : null;
  const mutationLocked = mutationEntry !== null;

  if (loading && !campaign) return <main className="page library-page campaign-page administration-page"><section className="campaign-shell"><header className="library-header"><div><button className="back-link" onClick={onBack}>← Campaign</button><p className="eyebrow">CAMPAIGN ADMINISTRATION</p><h1 className="title">Opening administration…</h1></div></header><div className="library-panel admin-loading" aria-busy="true"><p>Loading permitted campaign controls…</p></div></section></main>;
  if (failed || !campaign) return <main className="page library-page campaign-page administration-page"><section className="campaign-shell"><header className="library-header"><div><button className="back-link" onClick={onBack}>← Campaign</button><p className="eyebrow">CAMPAIGN ADMINISTRATION</p><h1 className="title">Administration unavailable</h1></div></header><div className="library-panel admin-error"><p role="alert">{error}</p><button ref={retryRef} className="primary" onClick={() => void load(Boolean(uncertain))}>Try again</button></div></section></main>;

  const owner = campaign.actorRole === "owner";
  const expectedRevision = campaign.revision;
  return <main className="page library-page campaign-page administration-page"><section className="campaign-shell" aria-labelledby="administration-heading">
    <header className="library-header"><div><button className="back-link" disabled={busy} onClick={onBack}>← Campaign</button><p className="eyebrow">TRUSTED LOCAL · {campaign.actorRole.toUpperCase()} VIEW</p><h1 ref={headingRef} tabIndex={-1} className="title" id="administration-heading">Campaign administration</h1><p className="subtitle">{campaignName ?? (initialName || "Current campaign")}</p></div><button className="ghost" disabled={busy || refreshing} onClick={() => void load(true, true)}>{refreshing ? "Refreshing…" : "Refresh"}</button></header>

    {(notice || error || mutationEntry) && <div ref={statusRef} tabIndex={-1} className={`admin-status ${error || uncertain ? "is-error" : "is-success"}`} role={error || uncertain ? "alert" : "status"}>
      <p>{error || mutationEntry?.message || notice}</p>
      {uncertain && <button className="primary" disabled={refreshing} onClick={() => void load(true, true)}>{refreshing ? "Refreshing authoritative state…" : "Refresh authoritative state"}</button>}
    </div>}

    <div className="admin-grid" aria-busy={busy || refreshing}>
      <CampaignSettingsForm campaign={campaign} campaignName={campaignName} campaignNameLoading={campaignNameLoading} busy={busy} mutationLocked={mutationLocked}
        onSave={(patch) => void mutate("settings", () => updateCampaignAdministration(campaignId, { ...patch, expectedRevision, idempotencyKey: idempotencyKey("settings") }))}
        onStatusChange={(status: CampaignLifecycleStatus) => void mutate("lifecycle", () => updateCampaignAdministration(campaignId, { status, expectedRevision, idempotencyKey: idempotencyKey("lifecycle") }))}
        onArchive={(confirmationName) => void mutate("archive", () => archiveCampaignAdministration(campaignId, { confirmationName, expectedRevision, idempotencyKey: idempotencyKey("archive") }))}
        onRetryCampaignName={() => void retryCampaignName()} />

      {owner && <MembershipManager memberships={memberships} busy={busy} mutationLocked={mutationLocked}
        onAdd={(principalId, role) => void mutate("membership", () => addCampaignAdministrationMembership(campaignId, { principalId, role, expectedRevision, idempotencyKey: idempotencyKey("member-add") }))}
        onChangeRole={(principalId, role: Exclude<CampaignMemberRole, "owner">) => void mutate("membership", () => updateCampaignAdministrationMembership(campaignId, principalId, { role, expectedRevision, idempotencyKey: idempotencyKey("member-role") }))}
        onRemove={(principalId) => void mutate("membership", () => removeCampaignAdministrationMembership(campaignId, principalId, { expectedRevision, idempotencyKey: idempotencyKey("member-remove") }))} />}

      <TimelineCheckpointPanel timelines={timelines} activeTimelineId={activeTimelineId} checkpoints={checkpoints} canMutate={owner} busy={busy} mutationLocked={mutationLocked}
        onCreateCheckpoint={(label, timelineId, timelineRevision) => void mutate("checkpoint", () => createCampaignCheckpoint(campaignId, { label, timelineId, timelineRevision, expectedRevision, idempotencyKey: idempotencyKey("checkpoint") }))}
        onFork={(checkpoint) => void mutate("fork", () => forkCampaignTimeline(campaignId, { checkpointId: checkpoint.id, expectedRevision, idempotencyKey: idempotencyKey("fork") }, checkpoint))} />

      {(catalogContent || catalogError) && <section className="admin-section campaign-catalog-section">
        {catalogContent && <CampaignContentPicker actorRole={campaign.actorRole} current={catalogContent} publications={catalogPublications} expectedRevision={expectedRevision} busy={busy || catalogInspecting} mutationLocked={mutationLocked}
          onInspect={(packId, packVersion) => void inspectCampaignPack(packId, packVersion)}
          onApply={(input) => void mutate("content", () => configureCampaignContent(campaignId, input))}
          onRefresh={() => void load(true, true)} />}
        {catalogError && <p className="form-error" role="alert">{catalogError}</p>}
        {catalogPack && <section className="campaign-pack-inspection" aria-labelledby="campaign-pack-inspection-heading"><div className="content-studio-heading"><div><p className="eyebrow">ROLE-FILTERED EXACT VERSION</p><h3 id="campaign-pack-inspection-heading">{catalogPack.publication.name}</h3></div><span className="status-pill">Read only</span></div><code>{catalogPack.publication.packId} @ {catalogPack.publication.packVersion}</code>{definitionsByKind(catalogPack).map(([kind, definitions]) => <section key={kind}><h4>{kind} <span>{definitions.length}</span></h4><ul>{definitions.map((definition) => <li key={definition.reference.definitionId}><strong>{definition.name}</strong><p>{definition.description}</p></li>)}</ul></section>)}</section>}
      </section>}

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
