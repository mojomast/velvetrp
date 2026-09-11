import { canAdminister, type AdministrationRole } from "./types";

export interface DurableGenerationDraft {
  draftId: string;
  jobId: string;
  state: "staged" | "approved" | "applied" | "abandoned";
  revision: number;
  createdAt: string;
  artifactCount: number;
}
export interface DurableGenerationJob {
  jobId: string;
  state: "running" | "uncertain" | "failed" | "succeeded";
  attempt: number;
  requestDigest: string;
  updatedAt: string;
  draftId: string | null;
}
export interface GenerationRecoveryApi {
  openDraft: (draftId: string) => void;
  reconcileJob: (jobId: string) => void;
}
export interface GenerationRecoveryPanelProps {
  actorRole: AdministrationRole;
  drafts: DurableGenerationDraft[];
  jobs: DurableGenerationJob[];
  busyJobIds?: string[];
  disabled?: boolean;
  api: GenerationRecoveryApi;
}

export function GenerationRecoveryPanel({ actorRole, drafts, jobs, busyJobIds = [], disabled = false, api }: GenerationRecoveryPanelProps) {
  const mutable = canAdminister(actorRole);
  const draftById = new Map(drafts.map((draft) => [draft.draftId, draft]));
  return <section className="admin-section" aria-labelledby="generation-recovery-heading">
    <div className="admin-section-heading"><div><p className="eyebrow">SERVER-DURABLE RECOVERY</p><h2 id="generation-recovery-heading">Generation drafts and jobs</h2></div><span className="status-pill">{actorRole} view</span></div>
    <p className="builder-help">This panel receives redacted durable metadata from the server after every load. It does not use browser storage and never repeats generation automatically.</p>
    <p className="content-warning">Paid retry is unavailable from redacted recovery metadata. Open the exact durable draft or start a separately reviewed generation request.</p>
    {!mutable && <p className="content-warning">Generation recovery actions are available only to campaign owners and GMs.</p>}
    {jobs.length === 0 && drafts.length === 0 && <p>No recoverable generation work.</p>}
    <ul aria-label="Durable generation jobs">{jobs.map((job) => { const busy = disabled || busyJobIds.includes(job.jobId); const draft = job.draftId ? draftById.get(job.draftId) : undefined; return <li key={job.jobId}><article><h3>Job {job.jobId}</h3><dl className="command-detail-list"><div><dt>Status</dt><dd>{job.state}</dd></div><div><dt>Attempt</dt><dd>{job.attempt}</dd></div><div><dt>Request digest</dt><dd><code>{job.requestDigest}</code></dd></div><div><dt>Last server update</dt><dd>{job.updatedAt}</dd></div></dl>{draft && <p>Draft {draft.draftId}: {draft.state}, revision {draft.revision}, {draft.artifactCount} candidate artifacts.</p>}<div className="button-row">{draft && <button type="button" disabled={busy} onClick={() => api.openDraft(draft.draftId)}>Open durable draft</button>}{(job.state === "running" || job.state === "uncertain") && <button type="button" disabled={!mutable || busy} onClick={() => api.reconcileJob(job.jobId)}>Reconcile job</button>}</div></article></li>; })}</ul>
    {drafts.filter((draft) => !jobs.some((job) => job.draftId === draft.draftId)).map((draft) => <article key={draft.draftId}><h3>Recovered draft {draft.draftId}</h3><p>{draft.state} · revision {draft.revision} · {draft.artifactCount} candidate artifacts · created {draft.createdAt}</p><button type="button" disabled={disabled} onClick={() => api.openDraft(draft.draftId)}>Open durable draft</button></article>)}
  </section>;
}
