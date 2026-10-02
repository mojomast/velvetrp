import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createCampaign, getCampaignAdministration, listCampaigns, type CampaignAccess } from "../api";
import type { CampaignLifecycleStatus } from "@velvet/contracts";
import { WorldbuildingAgentPanel } from "../components/rpg/campaign/WorldbuildingAgentPanel";
import "./campaign-library.css";

export interface CampaignLibraryPageProps { onBack: () => void; onOpen?: (campaignId: string, destination?: "world" | "play") => void; onContentPacks?: () => void; focusContentPacksRequest?: number; onContentPacksFocused?: (request: number) => void; }

function roleLabel(role: CampaignAccess["actorRole"]): string {
  return role === "gm" ? "Game master" : role.charAt(0).toUpperCase() + role.slice(1);
}

const lifecycleLabels: Record<CampaignLifecycleStatus, string> = { draft: "Draft", published: "Published", paused: "Paused", completed: "Completed", archived: "Archived" };

export function CampaignLibraryPage({ onBack, onOpen, onContentPacks, focusContentPacksRequest, onContentPacksFocused = () => undefined }: CampaignLibraryPageProps) {
  const [campaigns, setCampaigns] = useState<CampaignAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState("recent");
  const [generatorOpened, setGeneratorOpened] = useState(false);
  const generatorHeadingRef = useRef<HTMLHeadingElement>(null);
  const [statuses, setStatuses] = useState<Record<string, CampaignLifecycleStatus | "unavailable">>({});
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
    let cancelled = false;
    setStatuses({});
    // The list contract has no lifecycle projection. Bound concurrent reads and
    // isolate failures so one unavailable administration read never hides a world.
    let next = 0;
    async function worker() {
      while (!cancelled && next < campaigns.length) {
        const campaign = campaigns[next++];
        if (!campaign) return;
        let value: CampaignLifecycleStatus | "unavailable";
        try { value = (await getCampaignAdministration(campaign.id)).campaign.status; }
        catch { value = "unavailable"; }
        if (!cancelled) setStatuses((current) => ({ ...current, [campaign.id]: value }));
      }
    }
    void Promise.all(Array.from({ length: Math.min(4, campaigns.length) }, worker));
    return () => { cancelled = true; };
  }, [campaigns]);
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
      // Campaign creation completes here with no room/session, so the idempotent
      // `campaignStartup` command cannot run yet (the server requires an attached
      // room). The documented invocation point is the first room attach in
      // CampaignPreparation.
      if (!mountedRef.current) return;
      // A successful POST is authoritative for clearing the draft. The list is
      // still re-read rather than optimistically appending that response.
      setName("");
      setQuery(""); setRole("all"); setStatus("all");
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

  const visibleCampaigns = campaigns.filter((campaign) => campaign.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    && (role === "all" || campaign.actorRole === role)
    && (status === "all" || statuses[campaign.id] === status))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name));
  const filtered = query !== "" || role !== "all" || status !== "all";

  return <main className="page library-page campaign-page world-library"><section className="campaign-shell" aria-labelledby="campaign-heading">
    <header className="library-header"><div><button className="back-link" onClick={onBack}>← Character library</button><p className="eyebrow">YOUR WORLDS, YOUR STORIES</p><h1 className="title" id="campaign-heading">Campaigns & worlds</h1><p className="subtitle">Find your next adventure. Create a world, shape its story, then bring it to life in play.</p></div>{onContentPacks && <button ref={contentPacksRef} className="ghost" onClick={onContentPacks}>Content packs</button>}</header>
    <section className="world-library-start" aria-labelledby="world-library-start-heading">
      <div><h2 id="world-library-start-heading">From an idea to a world</h2><p>Describe your setting to generate a world, cast, and adventure material. Review and edit them before you play.</p></div>
      <button className="primary" aria-expanded={generatorOpened} aria-controls="library-world-generator" onClick={() => { setGeneratorOpened(true); queueMicrotask(() => generatorHeadingRef.current?.focus()); }}>Generate world</button>
    </section>
    {generatorOpened && <section id="library-world-generator" className="world-library-generator" aria-labelledby="library-generator-heading">
      <h2 id="library-generator-heading" ref={generatorHeadingRef} tabIndex={-1}>Generate a new world</h2>
      <p className="meta-text">Stay here while generation runs. Your campaign will appear in the library as soon as it is created; review the generation results before opening it.</p>
      <WorldbuildingAgentPanel onCampaignCreated={() => { void load(); }} onManageWorld={onOpen ? (id) => onOpen(id, "world") : undefined} onStartPlaying={onOpen ? (id) => onOpen(id, "play") : undefined} />
    </section>}
    <details className="world-library-blank">
    <summary>Start with a blank campaign</summary>
    <p className="meta-text">Name your campaign now, then add world details and characters at your own pace.</p>
    <form className="campaign-create" onSubmit={(event) => void submit(event)} aria-busy={submitting}>
      <div><label htmlFor="campaign-name">Campaign name</label><input id="campaign-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={200} required disabled={submitting} /></div>
      <button className="primary" type="submit" disabled={submitting}>{submitting ? "Creating…" : "Create campaign"}</button>
      {createError && <p className="form-error" role="alert">Campaign could not be created. Please try again.</p>}
    </form>
    </details>
    <p className="world-library-announcement" aria-live="polite">{announcement}</p>
    <section className="library-panel campaign-panel" aria-busy={loading} aria-labelledby="saved-worlds-heading">
      <div className="world-library-saved-heading"><div><h2 id="saved-worlds-heading">Your saved campaigns</h2><p className="meta-text">Open a campaign to continue play, edit its world, or manage its setup.</p></div><button className="ghost" disabled={loading} onClick={() => void load()}>Refresh library</button></div>
      <div className="world-library-filters">
        <label htmlFor="world-search">Search campaigns<input id="world-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name" /></label>
        <label htmlFor="world-role">Your role<select id="world-role" value={role} onChange={(event) => setRole(event.target.value)}><option value="all">All roles</option>{(["owner", "gm", "player", "observer"] as const).map((value) => <option key={value} value={value}>{roleLabel(value)}</option>)}</select></label>
        <label htmlFor="world-status">Lifecycle<select id="world-status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option>{Object.entries(lifecycleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}<option value="unavailable">Status unavailable</option></select></label>
        <label htmlFor="world-sort">Sort by<select id="world-sort" value={sort} onChange={(event) => setSort(event.target.value)}><option value="recent">Recently updated</option><option value="name">Name A–Z</option></select></label>
      </div>
      {!loading && !failed && <p className="meta-text" aria-live="polite">{visibleCampaigns.length} of {campaigns.length} campaigns{filtered && <> · <button className="back-link" onClick={() => { setQuery(""); setRole("all"); setStatus("all"); }}>Clear filters</button></>}</p>}
      {loading && <p className="empty-state" role="status">Loading campaigns…</p>}
      {!loading && failed && <div className="empty-state large" role="alert"><p>Campaigns could not be loaded.</p><button className="ghost" onClick={() => void load()}>Retry</button></div>}
       {!loading && !failed && campaigns.length === 0 && <div className="empty-state large"><p>No campaigns yet.</p><p className="meta-text">Generate a world above, or start with a blank campaign.</p></div>}
       {!loading && !failed && campaigns.length > 0 && visibleCampaigns.length === 0 && <div className="empty-state large"><p>No campaigns match your filters.</p><p className="meta-text">Try another name, role, or lifecycle status.</p></div>}
       {!loading && !failed && visibleCampaigns.length > 0 && <ul className="campaign-list">{visibleCampaigns.map((campaign) => <li className="campaign-card" key={campaign.id} tabIndex={-1} ref={(element) => { if (element) campaignElements.current.set(campaign.id, element); else campaignElements.current.delete(campaign.id); }}><h3>{campaign.name}</h3><dl><div><dt>Lifecycle</dt><dd>{statuses[campaign.id] === "unavailable" ? "Status unavailable" : statuses[campaign.id] ? lifecycleLabels[statuses[campaign.id] as CampaignLifecycleStatus] : "Loading status…"}</dd></div><div><dt>Your role</dt><dd>{roleLabel(campaign.actorRole)}</dd></div><div><dt>Updated</dt><dd><time dateTime={campaign.updatedAt}>{new Date(campaign.updatedAt).toLocaleDateString()}</time></dd></div></dl><p className="meta-text">{campaign.actorRole === "owner" || campaign.actorRole === "gm" ? "World editing, generation, and play setup" : "Campaign details and shared play"}</p><button className="ghost campaign-open" type="button" disabled={!onOpen} onClick={() => onOpen?.(campaign.id)} aria-label={`Open campaign ${campaign.name}`}>Open campaign →</button></li>)}</ul>}
    </section>
  </section></main>;
}
