import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CatalogDefinition,
  CatalogDefinitionKind,
  CatalogValidationReport,
  ContentCatalogHttpOwnerDetailResponse,
  ContentCatalogHttpPublicationRequest,
  ContentCatalogHttpPublicationResponse,
  ContentCatalogHttpPublicationsQuery,
  ContentCatalogHttpPublicationsResponse,
  ContentCatalogHttpValidationRequest,
  ContentCatalogHttpValidationResponse,
  OwnerCatalogProjection,
} from "@velvet/contracts";
import { ContentPackEditor, type ContentPackDraft } from "./ContentPackEditor";
import { PackValidationReport } from "./PackValidationReport";

export interface ContentPackLibraryApi {
  list: (query?: ContentCatalogHttpPublicationsQuery) => Promise<ContentCatalogHttpPublicationsResponse>;
  detail: (packId: string, packVersion: string) => Promise<ContentCatalogHttpOwnerDetailResponse>;
  validate: (draft: ContentCatalogHttpValidationRequest) => Promise<ContentCatalogHttpValidationResponse>;
  publish: (input: ContentCatalogHttpPublicationRequest) => Promise<ContentCatalogHttpPublicationResponse>;
}

export interface ContentPackLibraryPageProps {
  api: ContentPackLibraryApi;
  onBack: () => void;
  focusHeadingRequest?: number;
  onHeadingFocused?: (request: number) => void;
}

type PublicationLock = { phase: "writing" | "uncertain"; message: string };
const publicationLocks = new Map<string, PublicationLock>();
const KINDS: CatalogDefinitionKind[] = ["race", "background", "class", "class-level", "skill", "ability", "spell", "item", "currency", "enemy-template"];
const exactKey = (packId: string, packVersion: string) => `${packId}\0${packVersion}`;
const operationKey = () => `ui-publish-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function resetContentPackLibraryPageModuleStateForTests(): void {
  publicationLocks.clear();
}

function newDraft(): ContentPackDraft {
  const now = new Date().toISOString();
  return {
    manifest: {
      packId: "local-pack", packVersion: "0.1.0", name: "Local content pack", description: "An editable local draft.", tags: [], digest: "0".repeat(64),
      rulesProfile: { name: "Local rules profile", description: "A Velvet starter-compatible profile.", tags: [] },
      compatibility: { rulesEngine: "velvet-starter-v1", rulesProfileId: "local-rules", catalogFormat: "validated-v1" },
      provenance: { authorship: "original", author: "Local author", authoredAt: now, reviewedBy: "Local reviewer", reviewedAt: now, declaration: "This pack contains original work.", thirdPartyData: false },
    },
    definitions: [{ reference: { packId: "local-pack", packVersion: "0.1.0", definitionId: "local-race", kind: "race" }, name: "Local ancestry", description: "A local draft ancestry.", tags: [], mechanics: { speed: 30, attributeBonuses: {}, abilityRefs: [] } }],
  };
}

function groupedDefinitions(definitions: CatalogDefinition[]) {
  return KINDS.map((kind) => ({ kind, definitions: definitions.filter((definition) => definition.reference.kind === kind) })).filter((group) => group.definitions.length > 0);
}

function isKnownNonCommit(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && [400, 415, 422].includes(Number((error as { status: unknown }).status));
}

/** Local draft workflow and read-only sealed catalog browser. */
export function ContentPackLibraryPage({ api, onBack, focusHeadingRequest, onHeadingFocused = () => undefined }: ContentPackLibraryPageProps) {
  const [publications, setPublications] = useState<ContentCatalogHttpPublicationsResponse["publications"]>([]);
  const [selected, setSelected] = useState<OwnerCatalogProjection | null>(null);
  const [draft, setDraft] = useState<ContentPackDraft>(newDraft);
  const [report, setReport] = useState<CatalogValidationReport | null>(null);
  const [validatedDraft, setValidatedDraft] = useState("");
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [publicationReview, setPublicationReview] = useState(false);
  const [publicationConfirmed, setPublicationConfirmed] = useState(false);
  const [publicationLock, setPublicationLock] = useState<PublicationLock | null>(() => publicationLocks.get(exactKey(draft.manifest.packId, draft.manifest.packVersion)) ?? null);
  const [notice, setNotice] = useState("");
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const validationRef = useRef(0);
  const detailRef = useRef(0);
  const publishingRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const focusedHeadingRef = useRef<number | undefined>(undefined);

  const load = useCallback(async (explicit = false) => {
    const generation = ++generationRef.current;
    if (explicit) setRefreshing(true); else setLoading(true);
    setLoadError("");
    try {
      const response = await api.list({ limit: 100 });
      if (!mountedRef.current || generation !== generationRef.current) return;
      setPublications(response.publications);
      setLoading(false); setRefreshing(false);
      if (explicit) {
        const latestDraft = draftRef.current;
        const key = exactKey(latestDraft.manifest.packId, latestDraft.manifest.packVersion);
        publicationLocks.delete(key); setPublicationLock(null);
        setNotice("Authoritative sealed publications were refreshed. No publication was retried.");
        queueMicrotask(() => statusRef.current?.focus());
      }
    } catch {
      if (!mountedRef.current || generation !== generationRef.current) return;
      setLoading(false); setRefreshing(false); setLoadError("Sealed content packs could not be loaded.");
      queueMicrotask(() => retryRef.current?.focus());
    }
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => { mountedRef.current = false; generationRef.current += 1; validationRef.current += 1; detailRef.current += 1; };
  }, [load]);

  useEffect(() => {
    if (focusHeadingRequest === undefined || focusedHeadingRef.current === focusHeadingRequest || loading) return;
    focusedHeadingRef.current = focusHeadingRequest;
    queueMicrotask(() => { headingRef.current?.focus(); onHeadingFocused(focusHeadingRequest); });
  }, [focusHeadingRequest, loading, onHeadingFocused]);

  function changeDraft(next: ContentPackDraft): void {
    validationRef.current += 1;
    setDraft(next); setReport(null); setValidatedDraft(""); setPublicationReview(false); setPublicationConfirmed(false); setNotice("");
    setPublicationLock(publicationLocks.get(exactKey(next.manifest.packId, next.manifest.packVersion)) ?? null);
  }

  async function inspect(packId: string, packVersion: string): Promise<void> {
    const request = ++detailRef.current;
    setDetailBusy(true); setLoadError("");
    try {
      const response = await api.detail(packId, packVersion);
      if (!mountedRef.current || request !== detailRef.current) return;
      setSelected(response.catalog);
    } catch { if (mountedRef.current && request === detailRef.current) setLoadError("That sealed version could not be loaded."); }
    finally { if (mountedRef.current && request === detailRef.current) setDetailBusy(false); }
  }

  async function validate(): Promise<void> {
    if (validating) return;
    const request = ++validationRef.current;
    const snapshot = draft;
    setValidating(true); setNotice("");
    try {
      const response = await api.validate(snapshot);
      if (!mountedRef.current || request !== validationRef.current) return;
      const normalized = response.report.normalizedSummary.digest && response.report.valid
        ? { ...snapshot, manifest: { ...snapshot.manifest, digest: response.report.normalizedSummary.digest } }
        : snapshot;
      setDraft(normalized); setReport(response.report); setValidatedDraft(JSON.stringify(normalized));
      setPublicationReview(false); setPublicationConfirmed(false);
    } catch { if (mountedRef.current && request === validationRef.current) setNotice("Draft validation could not be completed. Nothing was published."); }
    finally { if (mountedRef.current && request === validationRef.current) setValidating(false); }
  }

  async function publish(): Promise<void> {
    const key = exactKey(draft.manifest.packId, draft.manifest.packVersion);
    if (publishingRef.current || publicationLocks.has(key) || !report?.valid || validatedDraft !== JSON.stringify(draft) || !publicationConfirmed) return;
    publishingRef.current = true;
    const lock = { phase: "writing" as const, message: "Publication is in progress. Duplicate submission is blocked." };
    publicationLocks.set(key, lock); setPublicationLock(lock); setNotice("");
    try {
      const response = await api.publish({ ...draft, idempotencyKey: operationKey() });
      if (!mountedRef.current) {
        publicationLocks.set(key, { phase: "uncertain", message: "Publication returned after this view closed. Refresh authoritative publications before another attempt." });
        return;
      }
      setSelected(response.catalog);
      setPublications((current) => current.some((entry) => exactKey(entry.packId, entry.packVersion) === key) ? current : [response.catalog.publication, ...current]);
      publicationLocks.delete(key); setPublicationLock(null); setPublicationReview(false); setPublicationConfirmed(false);
      setNotice(`Published ${response.catalog.publication.packId} @ ${response.catalog.publication.packVersion}. This exact version is now sealed and immutable.`);
      queueMicrotask(() => statusRef.current?.focus());
    } catch (error) {
      if (!mountedRef.current) return;
      if (isKnownNonCommit(error)) {
        publicationLocks.delete(key); setPublicationLock(null);
        setNotice("Publication was rejected before commit. Correct and validate the local draft again.");
      } else {
        const uncertain = { phase: "uncertain" as const, message: "Publication is stale or its outcome is uncertain. Duplicate submission is blocked until authoritative refresh; no POST will be retried automatically." };
        publicationLocks.set(key, uncertain); setPublicationLock(uncertain);
      }
      queueMicrotask(() => statusRef.current?.focus());
    } finally { publishingRef.current = false; }
  }

  const exactValidated = Boolean(report?.valid && validatedDraft === JSON.stringify(draft));
  return <main className="page library-page campaign-page content-studio-page"><section className="content-studio-shell" aria-labelledby="content-pack-library-heading">
    <header className="library-header"><div><button className="back-link" disabled={publicationLock?.phase === "writing"} onClick={onBack}>← Character library</button><p className="eyebrow">LOCAL CONTENT STUDIO</p><h1 ref={headingRef} tabIndex={-1} className="title" id="content-pack-library-heading">Content pack studio</h1><p className="subtitle">Edit local memory drafts and inspect sealed exact versions.</p></div><button className="ghost" disabled={refreshing || publicationLock?.phase === "writing"} onClick={() => void load(true)}>{refreshing ? "Refreshing…" : "Refresh sealed packs"}</button></header>
    {(notice || publicationLock) && <div ref={statusRef} tabIndex={-1} className={`admin-status ${publicationLock?.phase === "uncertain" ? "is-error" : ""}`} role={publicationLock?.phase === "uncertain" ? "alert" : "status"}><p>{publicationLock?.message ?? notice}</p>{publicationLock?.phase === "uncertain" && <button className="primary" disabled={refreshing} onClick={() => void load(true)}>Refresh authoritative publications</button>}</div>}
    <div className="content-studio-layout">
      <aside className="library-panel sealed-library" aria-labelledby="sealed-packs-heading" aria-busy={loading || detailBusy}>
        <div className="content-studio-heading"><div><p className="eyebrow">SEALED · IMMUTABLE</p><h2 id="sealed-packs-heading">Published versions</h2></div><span className="status-pill">Read only</span></div>
        {loading && <p className="content-empty">Loading sealed versions…</p>}
        {!loading && loadError && <div className="content-load-error"><p role="alert">{loadError}</p><button ref={retryRef} className="primary" onClick={() => void load()}>Try again</button></div>}
        {!loading && !loadError && publications.length === 0 && <p className="content-empty">No sealed content packs yet. Your local draft remains separate.</p>}
        {!loading && publications.length > 0 && <ul className="sealed-pack-list">{publications.map((publication) => <li key={exactKey(publication.packId, publication.packVersion)}><strong>{publication.name}</strong><code>{publication.packId} @ {publication.packVersion}</code><small>Published {new Date(publication.publishedAt).toLocaleString()}</small><button className="ghost" disabled={detailBusy} onClick={() => void inspect(publication.packId, publication.packVersion)}>Inspect sealed definitions</button></li>)}</ul>}
      </aside>
      <div className="content-studio-main">
        {selected && <section className="library-panel sealed-detail" aria-labelledby="sealed-detail-heading"><div className="content-studio-heading"><div><p className="eyebrow">SEALED EXACT VERSION</p><h2 id="sealed-detail-heading">{selected.publication.name}</h2></div><span className="status-pill">Immutable</span></div><p><code>{selected.publication.packId} @ {selected.publication.packVersion}</code></p><p className="content-studio-help">Published definitions are read-only. Create a new local draft with a new exact version to make changes.</p>{groupedDefinitions(selected.definitions).map((group) => <section className="sealed-definition-kind" key={group.kind}><h3>{group.kind} <span>{group.definitions.length}</span></h3><ul>{group.definitions.map((definition) => <li key={definition.reference.definitionId}><strong>{definition.name}</strong><p>{definition.description}</p><code>{definition.reference.definitionId}</code></li>)}</ul></section>)}</section>}
        <section className="library-panel draft-panel"><ContentPackEditor draft={draft} disabled={validating || publicationLock?.phase === "writing"} focusPath={focusPath} onChange={changeDraft} onValidate={() => void validate()} />{validating && <p className="content-empty" role="status">Validating the current in-memory draft…</p>}
          {report && <PackValidationReport report={report} onIssueSelect={(path) => { setFocusPath(null); queueMicrotask(() => setFocusPath(path)); }} />}
          {exactValidated && <section className="publication-review" aria-labelledby="publication-review-heading"><div className="content-studio-heading"><div><p className="eyebrow">IRREVERSIBLE PUBLICATION REVIEW</p><h2 id="publication-review-heading">Publish exact immutable version</h2></div><span className="status-pill">Explicit review</span></div><p className="content-studio-help">Publication seals this exact identity and definition set. It cannot be edited or deleted; future changes require a different exact version.</p><dl><div><dt>Pack</dt><dd>{draft.manifest.packId}</dd></div><div><dt>Version</dt><dd>{draft.manifest.packVersion}</dd></div><div><dt>Definitions</dt><dd>{draft.definitions.length}</dd></div><div><dt>Digest</dt><dd><code>{draft.manifest.digest}</code></dd></div></dl>{!publicationReview ? <button className="primary" disabled={Boolean(publicationLock)} onClick={() => setPublicationReview(true)}>Review immutable publication</button> : <><label className="checkbox publication-confirm"><input type="checkbox" checked={publicationConfirmed} onChange={(event) => setPublicationConfirmed(event.target.checked)} /><span>I reviewed the exact version, digest, provenance, and definitions. I understand publication is immutable.</span></label><button className="primary" disabled={!publicationConfirmed || Boolean(publicationLock)} onClick={() => void publish()}>Publish this exact version once</button></>}</section>}
        </section>
      </div>
    </div>
  </section></main>;
}
