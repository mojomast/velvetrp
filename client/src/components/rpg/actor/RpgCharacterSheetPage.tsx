import type {
  ActorEffectsResponse, ActorResourcesHttpGetResponse, CharacterSheetHttpResponse,
  ContentCatalogHttpCampaignContentGetResponse, ContentCatalogHttpCampaignPackDetailResponse,
  EconomyHttpCommandRequest, EconomyHttpCommandResponse, EconomyHttpShopGetResponse, EconomyHttpWalletGetResponse,
  InventoryHttpCommandRequest, InventoryHttpCommandResponse, InventoryHttpGetResponse, RestHttpRequest, RestHttpResponse,
} from "@velvet/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InventoryPanel, type InventoryIntent } from "./InventoryPanel";
import { ResourceTrackers } from "./ResourceTrackers";
import { RestDialog, type RestIntent } from "./RestDialog";
import { ShopBrowser, catalogReferenceKey, type CurrencyPresentations } from "./ShopBrowser";
import { TradeReviewDialog, type TradeIntent } from "./TradeReviewDialog";

export interface RpgCharacterSheetApi {
  getSheet: (campaignId: string, campaignCharacterId: string) => Promise<CharacterSheetHttpResponse>;
  getResources: (campaignId: string, actorId: string) => Promise<ActorResourcesHttpGetResponse>;
  getInventory: (campaignId: string, actorId: string) => Promise<InventoryHttpGetResponse>;
  getWallet: (campaignId: string, actorId: string) => Promise<EconomyHttpWalletGetResponse>;
  getEffects: (actorId: string) => Promise<ActorEffectsResponse>;
  getShop: (campaignId: string, shopId: string) => Promise<EconomyHttpShopGetResponse>;
  inventoryCommand: (campaignId: string, actorId: string, command: InventoryHttpCommandRequest) => Promise<InventoryHttpCommandResponse>;
  economyCommand: (campaignId: string, actorId: string, command: EconomyHttpCommandRequest) => Promise<EconomyHttpCommandResponse>;
  rest: (campaignId: string, actorId: string, command: RestHttpRequest) => Promise<RestHttpResponse>;
  getCampaignContent: (campaignId: string) => Promise<ContentCatalogHttpCampaignContentGetResponse>;
  getCampaignPack: (campaignId: string, packId: string, packVersion: string) => Promise<ContentCatalogHttpCampaignPackDetailResponse>;
}

export interface RpgCharacterSheetPageProps {
  campaignId: string;
  campaignCharacterId: string;
  api: RpgCharacterSheetApi;
  onBack: () => void;
  onUnavailable: () => void;
  focusHeadingRequest?: number;
}

type Marker = { campaignId: string; actorId: string; phase: "ambiguous" | "confirmed"; operation: string; command: unknown; startedAt: string; receipt?: string };
const markerKey = (campaignId: string, characterId: string) => `velvet.actor-command.v1:${campaignId.length}:${campaignId}${characterId}`;
const actorKey = (campaignId: string, characterId: string) => `velvet.actor-id.v1:${campaignId.length}:${campaignId}${characterId}`;
const commandKey = (kind: string) => `ui-${kind}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const isNotFound = (error: unknown) => typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 404;

function readMarker(key: string): Marker | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    if (typeof value !== "object" || value === null) return null;
    const item = value as Partial<Marker>;
    return typeof item.campaignId === "string" && typeof item.actorId === "string" && (item.phase === "ambiguous" || item.phase === "confirmed")
      && typeof item.operation === "string" && typeof item.startedAt === "string" ? item as Marker : null;
  } catch { return null; }
}
function writeMarker(key: string, value: Marker | null) { try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch { /* best-effort ambiguity durability */ } }
function receiptText(receipt: { revisionBefore: number; revisionAfter: number; idempotencyKey: string }) { return `Receipt ${receipt.idempotencyKey}: revision ${receipt.revisionBefore} → ${receipt.revisionAfter}`; }
function displayDuration(effect: ActorEffectsResponse["effects"][number]) {
  return effect.duration.kind === "rounds" ? `${effect.duration.remaining} rounds` : effect.duration.kind === "until_timestamp" ? `until ${effect.duration.expiresAt}` : "until removed";
}

export function RpgCharacterSheetPage({ campaignId, campaignCharacterId, api, onBack, onUnavailable, focusHeadingRequest }: RpgCharacterSheetPageProps) {
  const [sheet, setSheet] = useState<CharacterSheetHttpResponse | null>(null);
  const storageKey = markerKey(campaignId, campaignCharacterId);
  const restoredMarker = useMemo(() => readMarker(storageKey), [storageKey]);
  const [actorId, setActorId] = useState(() => restoredMarker?.actorId ?? (() => { try { return localStorage.getItem(actorKey(campaignId, campaignCharacterId)) ?? ""; } catch { return ""; } })());
  const [actorIdDraft, setActorIdDraft] = useState(actorId);
  const [resources, setResources] = useState<ActorResourcesHttpGetResponse | null>(null);
  const [inventory, setInventory] = useState<InventoryHttpGetResponse | null>(null);
  const [wallet, setWallet] = useState<EconomyHttpWalletGetResponse | null>(null);
  const [effects, setEffects] = useState<ActorEffectsResponse | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [optionalWarning, setOptionalWarning] = useState("");
  const [itemNames, setItemNames] = useState(new Map<string, { name: string; category?: string; slot?: string | null }>());
  const [currencies, setCurrencies] = useState<CurrencyPresentations>(new Map());
  const [shop, setShop] = useState<EconomyHttpShopGetResponse | null>(null);
  const [shopId, setShopId] = useState("");
  const [quote, setQuote] = useState<Extract<EconomyHttpCommandResponse, { type: "request_purchase_quote" }>["quote"] | null>(null);
  const [tradeOpen, setTradeOpen] = useState(false);
  const [restOpen, setRestOpen] = useState(false);
  const [marker, setMarker] = useState<Marker | null>(restoredMarker);
  const [receipt, setReceipt] = useState("");
  const [commandMessage, setCommandMessage] = useState("");
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const shopRequestRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const activeRef = useRef({ campaignId, campaignCharacterId });
  activeRef.current = { campaignId, campaignCharacterId };
  const current = useCallback((generation: number) => mountedRef.current && generation === generationRef.current
    && activeRef.current.campaignId === campaignId && activeRef.current.campaignCharacterId === campaignCharacterId, [campaignCharacterId, campaignId]);

  const loadCatalog = useCallback(async (generation: number) => {
    try {
      const content = await api.getCampaignContent(campaignId);
      const packs = await Promise.all(content.content.contentPacks.map((pin) => api.getCampaignPack(campaignId, pin.packId, pin.packVersion)));
      if (!current(generation)) return;
      const nextItems = new Map<string, { name: string; category?: string; slot?: string | null }>();
      const nextCurrencies: CurrencyPresentations = new Map();
      for (const pack of packs) for (const definition of pack.catalog.definitions) {
        const key = catalogReferenceKey(definition.reference);
        if (definition.reference.kind === "item" && "mechanics" in definition) {
          const mechanics = definition.mechanics as { category: string; slot: string | null };
          nextItems.set(key, { name: definition.name, category: mechanics.category, slot: mechanics.slot });
        }
        if (definition.reference.kind === "currency" && "mechanics" in definition) {
          const mechanics = definition.mechanics as { symbol: string; minorPerMajor: number };
          nextCurrencies.set(key, { name: definition.name, symbol: mechanics.symbol, minorPerMajor: mechanics.minorPerMajor });
        }
      }
      setItemNames(nextItems); setCurrencies(nextCurrencies);
    } catch { /* Catalog labels are optional; exact references remain displayable. */ }
  }, [api, campaignId, current]);

  const loadActor = useCallback(async (generation: number, exactActorId: string) => {
    const reads = await Promise.allSettled([api.getResources(campaignId, exactActorId), api.getInventory(campaignId, exactActorId), api.getWallet(campaignId, exactActorId), api.getEffects(exactActorId)] as const);
    if (!current(generation)) return;
    const setters = [setResources, setInventory, setWallet, setEffects] as const;
    let warnings = 0;
    reads.forEach((result, index) => {
      if (result.status === "fulfilled") (setters[index] as (value: never) => void)(result.value as never);
      else if (!isNotFound(result.reason)) warnings += 1;
    });
    setOptionalWarning(warnings ? `${warnings} actor section${warnings === 1 ? "" : "s"} could not be refreshed.`
      : reads.every((result) => result.status === "rejected") ? "No actor state was available for that exact actor ID." : "");
  }, [api, campaignId, current]);

  const load = useCallback(async (focusFailure = false) => {
    const generation = ++generationRef.current;
    setPhase("loading"); setOptionalWarning("");
    try {
      const nextSheet = await api.getSheet(campaignId, campaignCharacterId);
      if (!current(generation)) return;
      setSheet(nextSheet);
      if (actorId) await loadActor(generation, actorId);
      setPhase("ready");
      void loadCatalog(generation);
      if (focusHeadingRequest !== undefined) queueMicrotask(() => { if (current(generation)) headingRef.current?.focus(); });
    } catch (error) {
      if (!current(generation)) return;
      if (isNotFound(error)) { onUnavailable(); return; }
      setPhase("failed");
      if (focusFailure) queueMicrotask(() => retryRef.current?.focus());
    }
  }, [actorId, api, campaignCharacterId, campaignId, current, focusHeadingRequest, loadActor, loadCatalog, onUnavailable]);

  useEffect(() => {
    mountedRef.current = true; setMarker(readMarker(storageKey)); void load();
    return () => { mountedRef.current = false; generationRef.current += 1; shopRequestRef.current += 1; };
  }, [load, storageKey]);

  const setDurableMarker = (next: Marker | null) => { writeMarker(storageKey, next); if (mountedRef.current) setMarker(next); };
  async function connectActor() {
    if (!actorIdDraft || marker) return;
    const generation = generationRef.current;
    setResources(null); setInventory(null); setWallet(null); setEffects(null); setOptionalWarning("Loading exact actor state…");
    await loadActor(generation, actorIdDraft);
    if (!current(generation)) return;
    setActorId(actorIdDraft);
    try { localStorage.setItem(actorKey(campaignId, campaignCharacterId), actorIdDraft); } catch { /* optional restoration */ }
  }
  async function runCommand<T>(operation: string, command: unknown, invoke: () => Promise<T>, getReceipt: (value: T) => string, refresh: (value: T) => Promise<void>, after?: (value: T) => void) {
    if (marker) return;
    const pending: Marker = { campaignId, actorId, phase: "ambiguous", operation, command, startedAt: new Date().toISOString() };
    setDurableMarker(pending); setCommandMessage(""); setReceipt("");
    try {
      const result = await invoke();
      const proof = getReceipt(result);
      const confirmed: Marker = { ...pending, phase: "confirmed", receipt: proof };
      writeMarker(storageKey, confirmed);
      if (mountedRef.current) { setMarker(confirmed); setReceipt(proof); after?.(result); }
      try {
        await refresh(result);
        writeMarker(storageKey, null);
        if (mountedRef.current) { setMarker(null); setCommandMessage("Command confirmed and authoritative state refreshed."); }
      } catch {
        if (mountedRef.current) setCommandMessage("Command was confirmed, but authoritative refresh failed. The receipt is preserved; refresh before another command.");
      }
    } catch {
      if (mountedRef.current) setCommandMessage("The command outcome is uncertain. It will not be replayed. Refresh authoritative state before another command.");
    }
  }

  const refreshInventory = async () => { const value = await api.getInventory(campaignId, actorId); if (mountedRef.current) setInventory(value); };
  const refreshWallet = async () => { const value = await api.getWallet(campaignId, actorId); if (mountedRef.current) setWallet(value); };
  const refreshResources = async () => { const value = await api.getResources(campaignId, actorId); if (mountedRef.current) setResources(value); };
  const reconcile = async () => {
    if (!actorId) return;
    setCommandMessage("Refreshing authoritative state…");
    try { await Promise.all([refreshResources(), refreshInventory(), refreshWallet(), api.getEffects(actorId).then((value) => { if (mountedRef.current) setEffects(value); })]); setDurableMarker(null); setCommandMessage("Authoritative state refreshed. No command was replayed."); }
    catch { setCommandMessage("Authoritative refresh failed. The write lock remains in place."); }
  };

  const describeItem = (item: InventoryHttpGetResponse["entries"][number]["item"]) => itemNames.get(catalogReferenceKey(item)) ?? { name: item.definitionId };
  function submitInventory(intent: InventoryIntent) {
    if (!inventory) return;
    const command = { ...intent, expectedRevision: inventory.revision, idempotencyKey: commandKey(`inventory-${intent.kind}`) } as InventoryHttpCommandRequest;
    void runCommand(intent.kind, command, () => api.inventoryCommand(campaignId, actorId, command), (value) => receiptText(value.receipt), refreshInventory);
  }
  type EconomyIntent = EconomyHttpCommandRequest extends infer Command ? Command extends EconomyHttpCommandRequest ? Omit<Command, "expectedRevision" | "idempotencyKey"> : never : never;
  function submitEconomy(intent: EconomyIntent, operation: string, after?: (value: EconomyHttpCommandResponse) => void) {
    if (!wallet) return;
    const command = { ...intent, expectedRevision: wallet.revision, idempotencyKey: commandKey(`economy-${operation}`) } as EconomyHttpCommandRequest;
    void runCommand(operation, command, () => api.economyCommand(campaignId, actorId, command), (value) => receiptText(value.receipt), refreshWallet, after);
  }
  function submitTrade(intent: TradeIntent) { setTradeOpen(false); submitEconomy(intent, "trade", (value) => { if (value.type === "propose_bilateral_trade") setReceipt(`${receiptText(value.receipt)} · Trade ${value.trade.tradeId} is ${value.trade.status}.`); }); }
  function submitRest(intent: RestIntent) {
    if (!resources) return;
    const command = { ...intent, expectedRevision: resources.revision, idempotencyKey: commandKey("rest") } as RestHttpRequest;
    setRestOpen(false);
    void runCommand("rest", command, () => api.rest(campaignId, actorId, command), (value) => `${receiptText(value.receipt)} · ${value.receipt.kind} rest recovered ${value.receipt.recovery.resources.length} tracked resource(s).`, refreshResources);
  }
  async function openShop(id: string) {
    const request = ++shopRequestRef.current; setShop(null); setShopId(id); setQuote(null);
    try { const value = await api.getShop(campaignId, id); if (mountedRef.current && request === shopRequestRef.current) setShop(value); }
    catch { if (mountedRef.current && request === shopRequestRef.current) setCommandMessage("Known shop could not be loaded."); }
  }

  const derivedStats = useMemo(() => sheet ? [
    ["Maximum HP", sheet.derived.maxHp], ["Guard", sheet.derived.defenses.guard], ["Evasion", sheet.derived.defenses.evasion], ["Will", sheet.derived.defenses.will],
    ["Initiative", sheet.derived.initiative], ["Speed", sheet.derived.speed], ["Carrying limit", sheet.derived.carryingLimit], ["Spell attack", sheet.derived.spellAttack], ["Save DC", sheet.derived.saveDc],
  ] as const : [], [sheet]);

  return <main className="page library-page campaign-page actor-sheet-page"><section className="actor-sheet-shell" aria-labelledby="actor-sheet-heading">
    <header className="library-header"><div><button className="back-link" type="button" onClick={onBack}>← Character workspace</button><p className="eyebrow">CHARACTER SHEET // SERVER STATE</p><h1 ref={headingRef} tabIndex={-1} className="title" id="actor-sheet-heading"><bdi dir="auto">{sheet?.sheet.name ?? "Character sheet"}</bdi></h1></div>{phase === "ready" && <button className="ghost" type="button" onClick={() => void load()} disabled={Boolean(marker)}>Refresh sheet</button>}</header>
    {phase === "loading" && <section className="library-panel actor-loading" role="status">Loading authoritative character state…</section>}
    {phase === "failed" && <section className="library-panel actor-loading" role="alert"><p>Character sheet could not be loaded.</p><button ref={retryRef} className="ghost" type="button" onClick={() => void load(true)}>Retry</button></section>}
    {phase === "ready" && sheet && <div className="actor-sheet-layout">
      {(marker || commandMessage || receipt) && <section className={`actor-command-status ${marker?.phase === "ambiguous" ? "is-warning" : ""}`} aria-live="assertive">
        {marker && <p><strong>{marker.phase === "confirmed" ? "Confirmed write awaiting refresh" : "Write outcome uncertain"}:</strong> {marker.operation}. No duplicate or automatic replay is allowed.</p>}
        {receipt && <p>{receipt}</p>}{commandMessage && <p>{commandMessage}</p>}
        {marker && <button className="ghost" type="button" onClick={() => void reconcile()}>Refresh authoritative state</button>}
      </section>}
      {optionalWarning && <p className="actor-warning" role="status">{optionalWarning}</p>}
      {!actorId && <form className="actor-section known-actor-form" onSubmit={(event) => { event.preventDefault(); void connectActor(); }}><div className="actor-section-heading"><h2>Actor state</h2></div><label className="field">Campaign-provided actor ID<input value={actorIdDraft} onChange={(event) => setActorIdDraft(event.target.value)} autoComplete="off" /></label><button className="ghost" type="submit" disabled={!actorIdDraft || Boolean(marker)}>Load actor resources</button><p className="actor-help">The character-sheet route does not expose its actor binding. Enter an exact actor ID supplied by the campaign; this client never guesses one.</p></form>}
      <section className="actor-section actor-overview" aria-labelledby="overview-heading"><div className="actor-section-heading"><h2 id="overview-heading">Statistics & defenses</h2><span className="status-pill">Level {sheet.progression.level}</span></div><dl className="actor-stat-grid">{derivedStats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
      <section className="actor-section" aria-labelledby="skills-heading"><div className="actor-section-heading"><h2 id="skills-heading">Skills, saves & proficiencies</h2></div>{sheet.sheet.proficiencies.length ? <ul className="compact-server-list">{sheet.sheet.proficiencies.map((item, index) => <li key={`${item.category}-${index}`}><span>{item.category}</span><strong>{item.label}</strong></li>)}</ul> : <p className="actor-empty">No proficiencies returned.</p>}</section>
      {resources && <ResourceTrackers resources={resources.resources} />}
      {effects && <section className="actor-section" aria-labelledby="conditions-heading"><div className="actor-section-heading"><h2 id="conditions-heading">Conditions & effects</h2><span className="count-badge">{effects.effects.length}</span></div>{effects.effects.length ? <ul className="effects-list">{effects.effects.map((effect) => <li key={effect.effectId}><strong>{effect.modifiers.map((modifier) => `${modifier.kind} ${modifier.appliesToId}`).join(", ")}</strong><span>{displayDuration(effect)} · recovery {effect.recovery}{effect.stacking === "concentration" ? " · concentration bound" : ""}</span></li>)}</ul> : <p className="actor-empty">No active effects.</p>}</section>}
      {inventory && <InventoryPanel inventory={inventory} disabled={Boolean(marker)} describeItem={describeItem} onCommand={submitInventory} />}
      {wallet && <ShopBrowser wallet={wallet} shop={shop} shopId={shopId} quote={quote} currencies={currencies} disabled={Boolean(marker)} itemLabel={(item) => describeItem(item).name} onLoadShop={(id) => void openShop(id)} onQuote={(id, item, quantity) => submitEconomy({ type: "request_purchase_quote", shopId: id, item, quantity }, "purchase quote", (value) => { if (value.type === "request_purchase_quote") setQuote(value.quote); })} onPurchase={(quoteId) => submitEconomy({ type: "purchase_from_shop", quoteId }, "purchase", (value) => { if (value.type === "purchase_from_shop") { setQuote(null); setReceipt(`${receiptText(value.receipt)} · Purchased ${value.purchase.quantity} for exact server total.`); void refreshInventory().catch(() => undefined); } })} />}
      <section className="actor-section actor-actions" aria-labelledby="actor-actions-heading"><div className="actor-section-heading"><h2 id="actor-actions-heading">Recovery & exchange</h2></div><div className="button-row">{resources && <button className="ghost" type="button" disabled={Boolean(marker)} onClick={() => setRestOpen(true)}>Review rest</button>}{inventory && wallet && <button className="ghost" type="button" disabled={Boolean(marker)} onClick={() => setTradeOpen(true)}>Review trade</button>}</div></section>
    </div>}
    {inventory && wallet && <TradeReviewDialog open={tradeOpen} inventory={inventory} wallet={wallet} currencies={currencies} disabled={Boolean(marker)} itemLabel={(item) => describeItem(item).name} onClose={() => setTradeOpen(false)} onSubmit={submitTrade} />}
    <RestDialog open={restOpen} disabled={Boolean(marker)} onClose={() => setRestOpen(false)} onSubmit={submitRest} />
  </section></main>;
}
