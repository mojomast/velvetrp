import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { campaignTransferHttpExportDocumentSchema, MAX_CAMPAIGN_IMPORT_BYTES } from "@velvet/contracts";
import type { CampaignTransferHttpApplyRequest, CampaignTransferHttpApplyResponse, CampaignTransferHttpDryRunRequest, CampaignTransferHttpDryRunResponse, CampaignTransferPackage } from "@velvet/contracts";

const REPORT_MAX_AGE_MS = 5 * 60_000;
const AMBIGUITY_KEY = "velvet.campaign-import.ambiguous.v1";
interface FreshReport { result: CampaignTransferHttpDryRunResponse; createdAt: number }
export interface CampaignImportApi {
  dryRun: (input: CampaignTransferHttpDryRunRequest) => Promise<CampaignTransferHttpDryRunResponse>;
  apply: (importId: string, input: CampaignTransferHttpApplyRequest) => Promise<CampaignTransferHttpApplyResponse>;
}
export interface CampaignImportWizardProps { api: CampaignImportApi; onImported?: (campaignId: string) => void }

function uniqueKey(): string { return `import-ui-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`; }
function ambiguousImport(): boolean { try { return sessionStorage.getItem(AMBIGUITY_KEY) !== null; } catch { return false; } }
function setAmbiguous(value: boolean): void { try { if (value) sessionStorage.setItem(AMBIGUITY_KEY, new Date().toISOString()); else sessionStorage.removeItem(AMBIGUITY_KEY); } catch { /* Storage is advisory; the in-memory lock still applies. */ } }

export function CampaignImportWizard({ api, onImported = () => undefined }: CampaignImportWizardProps) {
  const [fileName, setFileName] = useState(""), [pack, setPack] = useState<CampaignTransferPackage | null>(null);
  const [report, setReport] = useState<FreshReport | null>(null), [busy, setBusy] = useState<"dry-run" | "apply" | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [ambiguous, setAmbiguousState] = useState(ambiguousImport), [now, setNow] = useState(Date.now());
  const fileRef = useRef<HTMLInputElement>(null), dryRunRef = useRef<HTMLButtonElement>(null), statusRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true), operation = useRef(0), selectedFile = useRef<File | null>(null);
  useEffect(() => { mounted.current = true; const timer = window.setInterval(() => setNow(Date.now()), 15_000); return () => { mounted.current = false; operation.current += 1; window.clearInterval(timer); }; }, []);
  const expired = report !== null && now - report.createdAt > REPORT_MAX_AGE_MS;
  const applicable = report !== null && !expired && report.result.report.valid && report.result.report.conflicts.length === 0 && report.result.report.missingReferences.length === 0 && !ambiguous;

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; const token = ++operation.current; selectedFile.current = file ?? null;
    setPack(null); setReport(null); setFileName(""); setError(""); setNotice(""); setBusy(null);
    if (!file) return;
    if (file.size === 0 || file.size > MAX_CAMPAIGN_IMPORT_BYTES) { setError(`Choose a non-empty Velvet JSON export no larger than ${Math.floor(MAX_CAMPAIGN_IMPORT_BYTES / 1_000_000)} MB.`); queueMicrotask(() => fileRef.current?.focus()); return; }
    try {
      const parsed = campaignTransferHttpExportDocumentSchema.safeParse(JSON.parse(await file.text()) as unknown);
      if (!parsed.success) throw new Error("shape");
      if (!mounted.current || token !== operation.current || selectedFile.current !== file) return;
      setPack(parsed.data.package); setFileName(file.name); setNotice("Local file validated. Create a fresh dry-run report before Apply is available."); queueMicrotask(() => dryRunRef.current?.focus());
    } catch { if (mounted.current && token === operation.current && selectedFile.current === file) { setError("This file is not a valid, bounded Velvet campaign export document. Nothing was uploaded or changed."); queueMicrotask(() => fileRef.current?.focus()); } }
  }
  async function dryRun() {
    if (!pack || busy) return; const token = ++operation.current; setBusy("dry-run"); setReport(null); setError(""); setNotice("");
    try { const result = await api.dryRun({ package: pack, mode: "dry-run" }); if (!mounted.current || token !== operation.current) return; setReport({ result, createdAt: Date.now() }); setNow(Date.now()); setNotice("Fresh dry run completed. Review every result before applying."); queueMicrotask(() => statusRef.current?.focus()); }
    catch { if (mounted.current && token === operation.current) { setError("A dry-run report could not be created. Apply remains blocked; retry the dry run."); queueMicrotask(() => dryRunRef.current?.focus()); } }
    finally { if (mounted.current && token === operation.current) setBusy(null); }
  }
  async function apply() {
    if (!applicable || !report || busy) { if (expired) { setReport(null); setError("That dry-run report expired. Create a new dry run before Apply."); queueMicrotask(() => dryRunRef.current?.focus()); } return; }
    const token = ++operation.current; setBusy("apply"); setError(""); setNotice(""); setAmbiguousState(true); setAmbiguous(true);
    try {
      const result = await api.apply(report.result.importId, { idempotencyKey: uniqueKey(), conflictResolutions: [] });
      if (!mounted.current || token !== operation.current) return; setAmbiguous(false); setAmbiguousState(false); setBusy(null); setReport(null);
      setNotice(`Import applied exactly once and confirmed by receipt at revision ${result.receipt.revisionAfter}.`); queueMicrotask(() => statusRef.current?.focus()); onImported(result.campaign.id);
    } catch (cause) {
      if (!mounted.current || token !== operation.current) return;
      const knownStale = typeof cause === "object" && cause !== null && "status" in cause && cause.status === 409;
      setBusy(null);
      if (knownStale) { setAmbiguous(false); setAmbiguousState(false); setReport(null); setError("The report is stale or expired. Apply was rejected; create a new dry run before applying."); queueMicrotask(() => dryRunRef.current?.focus()); }
      else { setError("The Apply outcome is unknown. It will not be replayed automatically, including after reload. Reconcile with the campaign library before clearing this lock."); queueMicrotask(() => statusRef.current?.focus()); }
    }
  }
  function reconcile() { setAmbiguous(false); setAmbiguousState(false); setReport(null); setError("Import lock cleared after explicit reconciliation. Select the file and create a new dry run before another Apply."); if (fileRef.current) fileRef.current.value = ""; selectedFile.current = null; setPack(null); setFileName(""); queueMicrotask(() => fileRef.current?.focus()); }
  const result = report?.result.report;
  return <section className="transfer-panel" aria-labelledby="import-heading">
    <div className="admin-section-heading"><div><p className="eyebrow">FRESH CAMPAIGN ONLY</p><h2 id="import-heading">Import campaign</h2></div></div>
    <p className="admin-help">Choose a local JSON export. Import always creates a fresh campaign; it never merges into or overwrites this campaign.</p>
    {ambiguous && <div ref={statusRef} tabIndex={-1} className="admin-status is-error" role="alert"><p>An earlier Apply outcome is unknown. No write will be replayed automatically.</p><button className="ghost" onClick={reconcile}>I checked the campaign library</button></div>}
    <label className="field"><span>Local Velvet export JSON</span><input ref={fileRef} type="file" accept="application/json,.json" disabled={busy !== null || ambiguous} onChange={(event) => void chooseFile(event)} /></label>
    {fileName && <p className="meta-text">Selected: {fileName}</p>}
    <button ref={dryRunRef} className="primary" disabled={!pack || busy !== null || ambiguous} onClick={() => void dryRun()}>{busy === "dry-run" ? "Creating dry-run report…" : "Create fresh dry-run report"}</button>
    {(error || notice) && <div ref={statusRef} tabIndex={-1} className={`admin-status ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}><p>{error || notice}</p></div>}
    {result && <section className={`import-report-result ${result.valid ? "is-valid" : "is-invalid"}`} aria-labelledby="dry-run-heading"><h3 id="dry-run-heading">Dry-run report {expired ? "expired" : "ready"}</h3>
      {expired && <p role="alert">This report is no longer fresh. Create a new dry run; Apply is blocked.</p>}
      <dl>{Object.entries(result.counts).map(([name, count]) => <div key={name}><dt>{name.replace(/([A-Z])/g, " $1")}</dt><dd>{count}</dd></div>)}</dl>
      {(["conflicts", "missingReferences", "warnings"] as const).map((kind) => <section key={kind}><h4>{kind.replace(/([A-Z])/g, " $1")}</h4>{result[kind].length ? <ul>{result[kind].map((entry, index) => <li key={index}>{entry}</li>)}</ul> : <p>None.</p>}</section>)}
      <button className="primary" disabled={!applicable || busy !== null} onClick={() => void apply()}>{busy === "apply" ? "Applying exactly once…" : "Apply as fresh campaign"}</button>
    </section>}
  </section>;
}
