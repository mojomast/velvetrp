import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createCampaign, listCampaigns, type CampaignAccess } from "../api";

export interface CampaignLibraryPageProps { onBack: () => void; onOpen?: (campaignId: string) => void; onContentPacks?: () => void; focusContentPacksRequest?: number; onContentPacksFocused?: (request: number) => void; }

function roleLabel(role: CampaignAccess["actorRole"]): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function CampaignLibraryPage({ onBack, onOpen, onContentPacks, focusContentPacksRequest, onContentPacksFocused = () => undefined }: CampaignLibraryPageProps) {
  const [campaigns, setCampaigns] = useState<CampaignAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [focusCampaignId, setFocusCampaignId] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const listGenerationRef = useRef(0);
  const campaignElements = useRef(new Map<string, HTMLLIElement>());
  const contentPacksRef = useRef<HTMLButtonElement>(null);
  const focusedContentPacksRequestRef = useRef<number | undefined>(undefined);
  const load = useCallback(async (): Promise<"success" | "failure" | "stale"> => {
    const generation = ++listGenerationRef.current;
    if (!mountedRef.current) return "stale";
    setLoading(true); setFailed(false);
    try {
      const response = await listCampaigns();
      if (!mountedRef.current || generation !== listGenerationRef.current) return "stale";
      setCampaigns(response.campaigns);
      setLoading(false);
      return "success";
    } catch {
      if (!mountedRef.current || generation !== listGenerationRef.current) return "stale";
      setCampaigns([]); setFailed(true); setLoading(false);
      return "failure";
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      // Invalidate every outstanding list completion as part of unmount.
      listGenerationRef.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (!focusCampaignId) return;
    const element = campaignElements.current.get(focusCampaignId);
    if (element) {
      element.focus();
      setFocusCampaignId(null);
    }
  }, [campaigns, focusCampaignId]);
  useEffect(() => {
    if (loading || focusContentPacksRequest === undefined || focusedContentPacksRequestRef.current === focusContentPacksRequest) return;
    focusedContentPacksRequestRef.current = focusContentPacksRequest;
    queueMicrotask(() => { contentPacksRef.current?.focus(); onContentPacksFocused(focusContentPacksRequest); });
  }, [focusContentPacksRequest, loading, onContentPacksFocused]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setCreateError(false);
    setAnnouncement("");
    try {
      const { campaign } = await createCampaign({ name });
      if (!mountedRef.current) return;
      // A successful POST is authoritative for clearing the draft. The list is
      // still re-read rather than optimistically appending that response.
      setName("");
      // Starting this authoritative refresh advances the shared generation,
      // so an older initial load or manual retry cannot overwrite its result.
      const refreshResult = await load();
      if (!mountedRef.current || refreshResult === "stale") return;
      if (refreshResult === "success") {
        setFocusCampaignId(campaign.id);
        setAnnouncement(`Campaign “${campaign.name}” created.`);
      } else {
        setAnnouncement(`Campaign “${campaign.name}” was created, but the library could not be refreshed.`);
      }
    } catch {
      if (mountedRef.current) setCreateError(true);
    } finally {
      if (mountedRef.current) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }
  }

  return <main className="page library-page campaign-page"><section className="campaign-shell" aria-labelledby="campaign-heading">
    <header className="library-header"><div><button className="back-link" onClick={onBack}>← Character library</button><p className="eyebrow">TRUSTED LOCAL LIBRARY</p><h1 className="title" id="campaign-heading">Campaigns</h1><p className="subtitle">Campaigns available to this local installation.</p></div>{onContentPacks && <button ref={contentPacksRef} className="ghost" onClick={onContentPacks}>Content packs</button>}</header>
    <form className="campaign-create" onSubmit={(event) => void submit(event)} aria-busy={submitting}>
      <div><label htmlFor="campaign-name">Campaign name</label><input id="campaign-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required disabled={submitting} /></div>
      <button className="primary" type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create campaign"}</button>
      {createError && <p className="form-error" role="alert">Campaign could not be created. Please try again.</p>}
    </form>
    <p className="sr-only" aria-live="polite">{announcement}</p>
    <section className="library-panel campaign-panel" aria-busy={loading}>
      {loading && <p className="empty-state" role="status">Loading campaigns…</p>}
      {!loading && failed && <div className="empty-state large" role="alert"><p>Campaigns could not be loaded.</p><button className="ghost" onClick={() => void load()}>Retry</button></div>}
       {!loading && !failed && campaigns.length === 0 && <div className="empty-state large"><p>No campaigns yet.</p><p className="meta-text">Create one to begin your local campaign library.</p></div>}
       {!loading && !failed && campaigns.length > 0 && <ul className="campaign-list">{campaigns.map((campaign) => <li className="campaign-card" key={campaign.id} tabIndex={-1} ref={(element) => { if (element) campaignElements.current.set(campaign.id, element); else campaignElements.current.delete(campaign.id); }}><h2>{campaign.name}</h2><dl><div><dt>Role</dt><dd>{roleLabel(campaign.actorRole)}</dd></div><div><dt>Updated</dt><dd><time dateTime={campaign.updatedAt}>{new Date(campaign.updatedAt).toLocaleDateString()}</time></dd></div></dl><button className="ghost campaign-open" type="button" onClick={() => onOpen?.(campaign.id)} aria-label={`Open campaign ${campaign.name}`}>Open</button></li>)}</ul>}
    </section>
  </section></main>;
}
