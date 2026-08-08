import { resourceIdSchema } from "@velvet/contracts";
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
import { ShopBrowser, catalogReferenceKey, formatMinorUnits, type CurrencyPresentations } from "./ShopBrowser";
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

type ConfirmedResult =
  | { kind: "inventory"; value: InventoryHttpCommandResponse }
  | { kind: "economy"; value: EconomyHttpCommandResponse }
  | { kind: "rest"; value: RestHttpResponse };
type Marker = { campaignId: string; actorId: string; phase: "ambiguous" | "confirmed"; operation: string; command: unknown; startedAt: string; receipt?: string; result?: ConfirmedResult };
const markerKey = (campaignId: string, characterId: string) => `velvet.actor-command.v1:${campaignId.length}:${campaignId}${characterId}`;
const actorKey = (campaignId: string, characterId: string) => `velvet.actor-id.v1:${campaignId.length}:${campaignId}${characterId}`;
const commandKey = (kind: string) => `ui-${kind}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const isNotFound = (error: unknown) => typeof error === "object" && error !== null && "status" in error && (error as { status?: unknown }).status === 404;

function readMarker(key: string, campaignId: string): Marker | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
    if (typeof value !== "object" || value === null) return null;
    const item = value as Partial<Marker>;
    return item.campaignId === campaignId && resourceIdSchema.safeParse(item.actorId).success && (item.phase === "ambiguous" || item.phase === "confirmed")
      && typeof item.operation === "string" && typeof item.startedAt === "string" ? item as Marker : null;
  } catch { return null; }
}
function readActorId(key: string): string {
  try { const value = localStorage.getItem(key) ?? ""; return resourceIdSchema.safeParse(value).success ? value : ""; }
  catch { return ""; }
}
function writeMarker(key: string, value: Marker | null) { try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch { /* best-effort ambiguity durability */ } }
function receiptText(receipt: { revisionBefore: number; revisionAfter: number; idempotencyKey: string }) { return `Receipt ${receipt.idempotencyKey}: revision ${receipt.revisionBefore} → ${receipt.revisionAfter}`; }
function displayDuration(effect: ActorEffectsResponse["effects"][number]) {
  return effect.duration.kind === "rounds" ? `${effect.duration.remaining} rounds` : effect.duration.kind === "until_timestamp" ? `until ${effect.duration.expiresAt}` : "until removed";
}

function ReceiptDetails({ result, currencies }: { result: ConfirmedResult; currencies: CurrencyPresentations }) {
  if (result.kind === "inventory") {
    const { receipt, inventory } = result.value;
    return <section className="receipt-details"><h3>Inventory receipt and returned state</h3><dl className="command-detail-list"><div><dt>Command</dt><dd>{receipt.kind}</dd></div><div><dt>Revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div><div><dt>Occurred</dt><dd>{receipt.occurredAt}</dd></div>{"entryId" in receipt && <div><dt>Entry</dt><dd>{receipt.entryId}</dd></div>}{"item" in receipt && <div><dt>Item</dt><dd>{catalogReferenceKey(receipt.item)}</dd></div>}{"quantity" in receipt && <div><dt>Quantity</dt><dd>{receipt.quantity}</dd></div>}{"slot" in receipt && <div><dt>Slot</dt><dd>{receipt.slot}</dd></div>}{receipt.kind === "gift" && <div><dt>Recipient</dt><dd>{receipt.recipientActorId}</dd></div>}<div><dt>Returned inventory</dt><dd>Revision {inventory.revision} · {inventory.entries.length} entries · capacity {inventory.capacity} · {inventory.equipment.length} equipped</dd></div></dl><details><summary>Complete strict server response</summary><pre>{JSON.stringify(result.value, null, 2)}</pre></details></section>;
  }
  if (result.kind === "rest") {
    const { receipt, actorState } = result.value;
    return <section className="receipt-details"><h3>Rest receipt and returned resource state</h3><dl className="command-detail-list"><div><dt>Rest</dt><dd>{receipt.kind}</dd></div><div><dt>Recovered at</dt><dd>{receipt.recoveredAt}</dd></div><div><dt>Revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div>{receipt.recovery.resources.map((delta) => <div key={delta.resourceId}><dt>{delta.resourceId}</dt><dd>{delta.before} → {delta.after}</dd></div>)}<div><dt>Returned actor state</dt><dd>Revision {actorState.revision} · {actorState.resources.length} resources</dd></div></dl><details><summary>Complete strict server response</summary><pre>{JSON.stringify(result.value, null, 2)}</pre></details></section>;
  }
  const response = result.value;
  const receipt = response.receipt;
  return <section className="receipt-details"><h3>Economy receipt and server result</h3><dl className="command-detail-list"><div><dt>Command</dt><dd>{receipt.type}</dd></div><div><dt>Revision</dt><dd>{receipt.revisionBefore} → {receipt.revisionAfter}</dd></div><div><dt>Occurred</dt><dd>{receipt.occurredAt}</dd></div>{response.type === "request_purchase_quote" && <><div><dt>Quote</dt><dd>{response.quote.quoteId} · expires {response.quote.expiresAt}</dd></div><div><dt>Exact total</dt><dd>{formatMinorUnits(response.quote.total.minorUnits, response.quote.total.currency, currencies.get(catalogReferenceKey(response.quote.total.currency)))}</dd></div></>}{response.type === "purchase_from_shop" && <><div><dt>Purchase</dt><dd>{response.purchase.purchaseId} · quote {response.purchase.quoteId} · {response.purchase.quantity} items</dd></div><div><dt>Exact paid total</dt><dd>{formatMinorUnits(response.purchase.total.minorUnits, response.purchase.total.currency, currencies.get(catalogReferenceKey(response.purchase.total.currency)))}</dd></div><div><dt>Purchased at</dt><dd>{response.purchase.purchasedAt}</dd></div></>}{response.type === "propose_bilateral_trade" && <div><dt>Trade</dt><dd>{response.trade.tradeId} · {response.trade.status}</dd></div>}</dl><details><summary>Complete strict server response</summary><pre>{JSON.stringify(response, null, 2)}</pre></details></section>;
}

export function RpgCharacterSheetPage({ campaignId, campaignCharacterId, api, onBack, onUnavailable, focusHeadingRequest }: RpgCharacterSheetPageProps) {
  const [sheet, setSheet] = useState<CharacterSheetHttpResponse | null>(null);
  const storageKey = markerKey(campaignId, campaignCharacterId);
  const restoredMarker = useMemo(() => readMarker(storageKey, campaignId), [campaignId, storageKey]);
  const actorStorageKey = actorKey(campaignId, campaignCharacterId);
  const [actorId, setActorId] = useState(() => restoredMarker?.actorId ?? readActorId(actorStorageKey));
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
  const [confirmedResult, setConfirmedResult] = useState<ConfirmedResult | null>(restoredMarker?.result ?? null);
  const [commandMessage, setCommandMessage] = useState("");
  const [correctionFocusPending, setCorrectionFocusPending] = useState(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const shopRequestRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const actorCorrectionRef = useRef<HTMLButtonElement>(null);
  const actorInputRef = useRef<HTMLInputElement>(null);
  const actorIdRef = useRef(actorId);
  actorIdRef.current = actorId;
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
    } catch { if (current(generation)) { setItemNames(new Map()); setCurrencies(new Map()); } }
  }, [api, campaignId, current]);

  const loadActor = useCallback(async (generation: number, exactActorId: string): Promise<number> => {
    const reads = await Promise.allSettled([api.getResources(campaignId, exactActorId), api.getInventory(campaignId, exactActorId), api.getWallet(campaignId, exactActorId), api.getEffects(exactActorId)] as const);
    if (!current(generation)) return 0;
    const setters = [setResources, setInventory, setWallet, setEffects] as const;
    let warnings = 0;
    let available = 0;
    reads.forEach((result, index) => {
      if (result.status === "fulfilled") { available += 1; (setters[index] as (value: never) => void)(result.value as never); }
      else { if (isNotFound(result.reason)) (setters[index] as (value: null) => void)(null); else warnings += 1; }
    });
    setOptionalWarning(available === 0 ? `No actor state is available for that exact actor ID. Check or change the binding.${warnings ? ` ${warnings} lane read${warnings === 1 ? "" : "s"} failed.` : ""}`
      : warnings ? `${warnings} actor section${warnings === 1 ? "" : "s"} could not be refreshed.` : "");
    setCorrectionFocusPending(available === 0);
    return available;
  }, [api, campaignId, current]);

  const load = useCallback(async (focusFailure = false) => {
    const generation = ++generationRef.current;
    setPhase("loading"); setOptionalWarning(""); setSheet(null);
    try {
      const nextSheet = await api.getSheet(campaignId, campaignCharacterId);
      if (!current(generation)) return;
      setSheet(nextSheet);
      const actorAvailability = actorId ? await loadActor(generation, actorId) : null;
      setPhase("ready");
      void loadCatalog(generation);
      if (focusHeadingRequest !== undefined && actorAvailability !== 0) queueMicrotask(() => { if (current(generation)) headingRef.current?.focus(); });
    } catch (error) {
      if (!current(generation)) return;
      setSheet(null);
      if (isNotFound(error)) { onUnavailable(); return; }
      setPhase("failed");
      if (focusFailure) queueMicrotask(() => retryRef.current?.focus());
    }
  }, [actorId, api, campaignCharacterId, campaignId, current, focusHeadingRequest, loadActor, loadCatalog, onUnavailable]);

  useEffect(() => {
    mountedRef.current = true;
    const restored = readMarker(storageKey, campaignId);
    const restoredActor = restored?.actorId ?? readActorId(actorStorageKey);
    actorIdRef.current = restoredActor; setActorId(restoredActor); setActorIdDraft(restoredActor);
    setResources(null); setInventory(null); setWallet(null); setEffects(null); setShop(null); setQuote(null);
    setMarker(restored); setConfirmedResult(restored?.result ?? null);
    if (!restoredActor) { try { localStorage.removeItem(actorStorageKey); } catch { /* optional restoration */ } }
    void load();
    return () => { mountedRef.current = false; generationRef.current += 1; shopRequestRef.current += 1; };
  }, [actorStorageKey, campaignId, load, storageKey]);

  useEffect(() => {
    if (!correctionFocusPending || phase !== "ready") return;
    actorCorrectionRef.current?.focus(); setCorrectionFocusPending(false);
  }, [correctionFocusPending, phase]);

  const setDurableMarker = (next: Marker | null) => { writeMarker(storageKey, next); if (mountedRef.current) setMarker(next); };
  async function connectActor() {
    if (!resourceIdSchema.safeParse(actorIdDraft).success) return;
    const generation = generationRef.current;
    actorIdRef.current = actorIdDraft; setActorId(actorIdDraft);
    setResources(null); setInventory(null); setWallet(null); setEffects(null); setOptionalWarning("Loading exact actor state…");
    try { localStorage.setItem(actorStorageKey, actorIdDraft); } catch { /* optional restoration */ }
    await loadActor(generation, actorIdDraft);
  }
  function disconnectActor() {
    actorIdRef.current = ""; setActorId(""); setActorIdDraft(""); setResources(null); setInventory(null); setWallet(null); setEffects(null); setShop(null); setQuote(null); setOptionalWarning("");
    try { localStorage.removeItem(actorStorageKey); } catch { /* optional restoration */ }
    queueMicrotask(() => actorInputRef.current?.focus());
  }
  async function runCommand<T>(operation: string, command: unknown, invoke: () => Promise<T>, wrap: (value: T) => ConfirmedResult, refresh: () => Promise<void>, consume?: (value: T) => void) {
    if (marker) return;
    const pending: Marker = { campaignId, actorId, phase: "ambiguous", operation, command, startedAt: new Date().toISOString() };
    setDurableMarker(pending); setCommandMessage(""); setReceipt(""); setConfirmedResult(null);
    try {
      const result = await invoke();
      const wrapped = wrap(result);
      const proof = receiptText(wrapped.value.receipt);
      const confirmed: Marker = { ...pending, phase: "confirmed", receipt: proof, result: wrapped };
      writeMarker(storageKey, confirmed);
      if (mountedRef.current) { setMarker(confirmed); setReceipt(proof); setConfirmedResult(wrapped); consume?.(result); }
      try {
        await refresh();
        writeMarker(storageKey, null);
        if (mountedRef.current) { setMarker(null); setCommandMessage("Command confirmed and authoritative state refreshed."); }
      } catch {
        if (mountedRef.current) setCommandMessage("Command was confirmed and its returned state was applied, but one or more authoritative GET refreshes failed. The complete receipt is preserved; displayed lanes may be partial until refresh succeeds.");
      }
    } catch {
      if (mountedRef.current) setCommandMessage("The command outcome is uncertain. It will not be replayed. Refresh authoritative state before another command.");
    }
  }

  const refreshAllLanes = async (exactActorId = actorId) => {
    const generation = generationRef.current;
    const reads = await Promise.allSettled([api.getSheet(campaignId, campaignCharacterId), api.getResources(campaignId, exactActorId), api.getInventory(campaignId, exactActorId), api.getWallet(campaignId, exactActorId), api.getEffects(exactActorId)] as const);
    if (!current(generation)) throw new Error("stale refresh");
    const activeActor = actorIdRef.current === exactActorId;
    const [sheetRead, resourcesRead, inventoryRead, walletRead, effectsRead] = reads;
    if (sheetRead.status === "fulfilled") setSheet(sheetRead.value); else if (isNotFound(sheetRead.reason)) setSheet(null);
    const actorReads = [resourcesRead, inventoryRead, walletRead, effectsRead] as const;
    const setters = [setResources, setInventory, setWallet, setEffects] as const;
    if (activeActor) actorReads.forEach((read, index) => {
      if (read.status === "fulfilled") (setters[index] as (value: never) => void)(read.value as never);
      else if (isNotFound(read.reason)) (setters[index] as (value: null) => void)(null);
    });
    if (reads.some((read) => read.status === "rejected")) throw new Error("partial authoritative refresh");
  };
  const reconcile = async () => {
    const reconcileActorId = marker?.actorId ?? actorId;
    if (!reconcileActorId) return;
    setCommandMessage("Refreshing authoritative state…");
    try { await refreshAllLanes(reconcileActorId); setDurableMarker(null); setCommandMessage("All authoritative lanes refreshed. No command was replayed."); }
    catch { setCommandMessage("Authoritative refresh failed. The write lock remains in place."); }
  };

  const describeItem = (item: InventoryHttpGetResponse["entries"][number]["item"]) => itemNames.get(catalogReferenceKey(item)) ?? { name: item.definitionId };
  function submitInventory(intent: InventoryIntent) {
    if (!inventory) return;
    const command = { ...intent, expectedRevision: inventory.revision, idempotencyKey: commandKey(`inventory-${intent.kind}`) } as InventoryHttpCommandRequest;
    void runCommand(intent.kind, command, () => api.inventoryCommand(campaignId, actorId, command), (value) => ({ kind: "inventory", value }), () => refreshAllLanes(actorId), (value) => setInventory(value.inventory));
  }
  type EconomyIntent = EconomyHttpCommandRequest extends infer Command ? Command extends EconomyHttpCommandRequest ? Omit<Command, "expectedRevision" | "idempotencyKey"> : never : never;
  function submitEconomy(intent: EconomyIntent, operation: string, consume?: (value: EconomyHttpCommandResponse) => void) {
    if (!wallet) return;
    const command = { ...intent, expectedRevision: wallet.revision, idempotencyKey: commandKey(`economy-${operation}`) } as EconomyHttpCommandRequest;
    void runCommand(operation, command, () => api.economyCommand(campaignId, actorId, command), (value) => ({ kind: "economy", value }), () => refreshAllLanes(actorId), consume);
  }
  function submitTrade(intent: TradeIntent) { setTradeOpen(false); submitEconomy(intent, "trade"); }
  function submitRest(intent: RestIntent) {
    if (!resources) return;
    const command = { ...intent, expectedRevision: resources.revision, idempotencyKey: commandKey("rest") } as RestHttpRequest;
    setRestOpen(false);
    void runCommand("rest", command, () => api.rest(campaignId, actorId, command), (value) => ({ kind: "rest", value }), () => refreshAllLanes(actorId), (value) => setResources({ resources: value.actorState.resources.map((resource) => ({ name: resource.resourceId, current: resource.current, max: resource.capacity })), revision: value.actorState.revision }));
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
      {confirmedResult && <ReceiptDetails result={confirmedResult} currencies={currencies} />}
      {optionalWarning && <p className="actor-warning" role="status">{optionalWarning}</p>}
      <form className="actor-section known-actor-form" onSubmit={(event) => { event.preventDefault(); void connectActor(); }}><div className="actor-section-heading"><h2>Actor binding</h2>{actorId && <span className="status-pill">Connected</span>}</div>{actorId && <p>Current campaign-provided actor: <bdi dir="auto">{actorId}</bdi></p>}<label className="field">Campaign-provided actor ID<input ref={actorInputRef} value={actorIdDraft} onChange={(event) => setActorIdDraft(event.target.value)} autoComplete="off" /></label><div className="button-row"><button ref={actorCorrectionRef} className="ghost" type="submit" disabled={!resourceIdSchema.safeParse(actorIdDraft).success}>{actorId ? "Change actor" : "Load actor resources"}</button>{actorId && <button className="ghost" type="button" onClick={disconnectActor}>Disconnect actor</button>}</div><p className="actor-help">The character-sheet route does not expose its actor binding. Enter an exact actor ID supplied by the campaign; this client never guesses one.</p></form>
      <section className="actor-section actor-overview" aria-labelledby="overview-heading"><div className="actor-section-heading"><h2 id="overview-heading">Statistics & defenses</h2><span className="status-pill">Level {sheet.progression.level}</span></div><dl className="actor-stat-grid">{derivedStats.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
      <section className="actor-section" aria-labelledby="skills-heading"><div className="actor-section-heading"><h2 id="skills-heading">Skills, saves & proficiencies</h2></div>{sheet.sheet.proficiencies.length ? <ul className="compact-server-list">{sheet.sheet.proficiencies.map((item, index) => <li key={`${item.category}-${index}`}><span>{item.category}</span><strong>{item.label}</strong></li>)}</ul> : <p className="actor-empty">No proficiencies returned.</p>}</section>
      {resources && <ResourceTrackers resources={resources.resources} />}
      {effects && <section className="actor-section" aria-labelledby="conditions-heading"><div className="actor-section-heading"><h2 id="conditions-heading">Conditions & effects</h2><span className="count-badge">{effects.effects.length}</span></div>{effects.effects.length ? <ul className="effects-list">{effects.effects.map((effect) => <li key={effect.effectId}><strong>{effect.modifiers.map((modifier) => `${modifier.kind} ${modifier.appliesToId}`).join(", ")}</strong><span>{displayDuration(effect)} · recovery {effect.recovery}{effect.stacking === "concentration" ? " · concentration bound" : ""}</span></li>)}</ul> : <p className="actor-empty">No active effects.</p>}</section>}
      {inventory && <InventoryPanel inventory={inventory} disabled={Boolean(marker)} describeItem={describeItem} onCommand={submitInventory} />}
      {wallet && <ShopBrowser wallet={wallet} shop={shop} shopId={shopId} quote={quote} currencies={currencies} disabled={Boolean(marker)} itemLabel={(item) => describeItem(item).name} onLoadShop={(id) => void openShop(id)} onQuote={(id, item, quantity) => submitEconomy({ type: "request_purchase_quote", shopId: id, item, quantity }, "purchase quote", (value) => { if (value.type === "request_purchase_quote") setQuote(value.quote); })} onPurchase={(quoteId) => submitEconomy({ type: "purchase_from_shop", quoteId }, "purchase", () => setQuote(null))} />}
      <section className="actor-section actor-actions" aria-labelledby="actor-actions-heading"><div className="actor-section-heading"><h2 id="actor-actions-heading">Recovery & exchange</h2></div><div className="button-row">{resources && <button className="ghost" type="button" disabled={Boolean(marker)} onClick={() => setRestOpen(true)}>Review rest</button>}{inventory && wallet && <button className="ghost" type="button" disabled={Boolean(marker)} onClick={() => setTradeOpen(true)}>Review trade</button>}</div></section>
    </div>}
    {inventory && wallet && <TradeReviewDialog open={tradeOpen} inventory={inventory} wallet={wallet} currencies={currencies} disabled={Boolean(marker)} itemLabel={(item) => describeItem(item).name} onClose={() => setTradeOpen(false)} onSubmit={submitTrade} />}
    {resources && <RestDialog open={restOpen} disabled={Boolean(marker)} resources={resources} onClose={() => setRestOpen(false)} onSubmit={submitRest} />}
  </section></main>;
}
