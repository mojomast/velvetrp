/**
 * Phase 2b free-form shops: bounded, catalog-bound shop stock for an ad-hoc merchant.
 *
 * When a player wants to buy from a shopkeeper the prepared campaign never defined,
 * the server — never the model — decides whether that needs durable shop content and
 * builds the closed candidate set. This module:
 *
 * 1. Classifies one ad-hoc merchant context deterministically (`classifyFreeformShop`)
 *    against public canon (the merchant's public identity and the campaign's pinned,
 *    publicly reachable item catalog). It returns either no intent or a bounded
 *    candidate list (currently exactly one candidate) whose identity is a deterministic
 *    digest of durable ids.
 * 2. Materializes the exact chosen candidate atomically (`materializeFreeformShop`):
 *    a public `lore` shop notice through the existing campaign-content generation
 *    apply path (the durable `campaign_content_*_v42` command/receipt), plus the exact
 *    `rpg_shop_definitions_v25` / `rpg_shop_stock_v25` rows and the
 *    `campaign_npc_shop_bindings_v57` merchant binding, all inside one caller-owned
 *    immediate transaction.
 *
 * Hard invariants:
 * - **No invented items and no invented prices.** A stock line exists only for an item
 *   that is publicly reachable and pinned in the campaign's current catalog packs
 *   (`campaign_catalog_current_pins` + `rpg_catalog_definition_visibility`). Its unit
 *   price is exactly the catalog's `mechanics.price.amount`; the model/provider never
 *   supplies an item, quantity, price or currency.
 * - **No fabricated currency.** A price currency resolves through the campaign's exact
 *   `rpg_currency_references_v25` reference, or is attached deterministically from the
 *   pinned currency definition with the same formula `grantSettlementRepo.currencyCode`
 *   uses.
 * - **Atomic + receipted.** Every materialization writes a public shop notice through
 *   `createGenerationDraft` + `recordCampaignGenerationCandidate` +
 *   `applyCampaignContentGenerationDraftAtomically` in the same outer transaction as the
 *   shop rows. Shops have no built-in command table (see the design note below); the
 *   content receipt is the durable receipt for the whole action. A failure in any step
 *   rolls back the shop rows and the receipt together, so there is never a shop without
 *   its receipt or a receipt without its shop.
 * - **Idempotent via durable identities.** `shopId` is derived from `campaignId:npcId`
 *   and each `stockId` from `shopId:item`, so a replayed attempt converges on the same
 *   shop, stock and receipt instead of creating a second shop.
 * - **Public/private separation.** Only a public merchant may host a player-facing shop;
 *   GM-only NPC artifacts make the merchant ineligible. No GM-only NPC state is written
 *   here.
 *
 * Design note (no migration this pass): `docs/freeform-generation-research.md` §2.4
 * proposes recording a shop-creation command in a free-form sidecar
 * (`freeform_materializations_v61`). That table does not exist and shops have no built-in
 * command table, so this pass reuses the existing generation-content command/receipt path
 * as the durable receipt and relies on deterministic shop/stock ids for replay. A
 * dedicated sidecar (or a new `campaign_administration_integration_commands_v59`
 * operation, which today has a closed CHECK constraint) remains the recommended follow-up;
 * neither is required for correctness or idempotency here.
 */
import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  currencyCatalogReferenceSchema,
  generatedArtifactKeySchema,
  generatedCampaignContentProviderSchema,
  idempotencyKeySchema,
  itemCatalogReferenceSchema,
  nonNegativeMechanicIntegerSchema,
  privateGenerationDraftSchema,
  resourceIdSchema,
  stagedCampaignContentGenerationSchema,
  type CreateGenerationDraftInput,
  type DraftMutationInput,
  type GeneratedCampaignContentProvider,
  type PrivateGenerationDraft,
} from "@velvet/contracts";
import type { Clock } from "../../runtime.js";

/** Upper bound on distinct catalog items a free-form shop may stock. */
export const MAX_FREEFORM_SHOP_ITEMS = 8;
/** Lower/upper bound on a stocked line's available quantity. */
export const MIN_FREEFORM_SHOP_QUANTITY = 1;
export const MAX_FREEFORM_SHOP_QUANTITY = 20;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)))
    : item);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** The exact pinned catalog reference for one stocked item. */
export interface FreeformShopItemReference {
  kind: "item";
  packId: string;
  packVersion: string;
  definitionId: string;
}

/**
 * One server-authored stock line before materialization. Every field is derived
 * server-side: `reference` and `unitPriceMinor` come from the pinned catalog,
 * `currency` is the item's exact pinned price currency and `currencyCode` is its
 * campaign reference (existing or deterministically attachable).
 */
export interface FreeformShopItemContext {
  reference: FreeformShopItemReference;
  name: string;
  /** Exact pinned catalog `mechanics.price.amount`; never model-authored. */
  unitPriceMinor: number;
  currencyCode: string;
  /** The exact pinned currency definition the item's price references. */
  currency: { kind: "currency"; packId: string; packVersion: string; definitionId: string };
  stackable: boolean;
}

/** Public merchant context used by the pure classifier. */
export interface FreeformShopMerchantContext {
  npcId: string;
  name: string;
  /** A merchant with any GM-only NPC artifact is ineligible for a public shop. */
  visibility: "public" | "gm";
}

/** One materializable stock line of a candidate shop. */
export interface FreeformShopStockLine {
  stockId: string;
  item: FreeformShopItemReference;
  quantity: number;
  unitPriceMinor: number;
  currencyCode: string;
}

/** One server-authored materialization candidate. */
export interface FreeformShopCandidate {
  candidateId: string;
  shopId: string;
  shopName: string;
  npcId: string;
  items: readonly FreeformShopStockLine[];
}

/** Fail-closed reasons a merchant context does not produce a materialization candidate. */
export type FreeformShopNoneReason =
  | "no-merchant"
  | "merchant-not-public"
  | "shop-already-exists"
  | "no-compatible-item";

export type FreeformShopClassification =
  | { intent: "none"; reason: FreeformShopNoneReason }
  | { intent: "materialize-shop"; merchantName: string; candidates: readonly FreeformShopCandidate[] };

/** A materialized candidate projection returned with the receipts. */
export interface FreeformShopMaterializedCandidate {
  candidateId: string;
  shopId: string;
  shopName: string;
  npcId: string;
  items: readonly FreeformShopStockLine[];
}

export type FreeformShopMaterialization =
  | { status: "declined"; reason: FreeformShopNoneReason }
  | {
    status: "materialized";
    candidate: FreeformShopMaterializedCandidate;
    shopId: string;
    npcId: string;
    draftId: string;
    /** Durable `campaign_content_receipts_v42` receipt for the whole materialization. */
    contentReceiptId: string | null;
    /** Whether this attempt created the `campaign_npc_shop_bindings_v57` merchant binding. */
    bindingCreated: boolean;
    stock: readonly FreeformShopStockLine[];
  };

export class FreeformShopAuthorizationError extends Error {}
export class FreeformShopConflictError extends Error {}
export class FreeformShopUnavailableError extends Error {}

/** Deterministic shop id for a campaign-scoped merchant identity. */
export function freeformShopId(identity: string): string {
  return `ff-shop-${sha256(identity).slice(0, 40)}`;
}

/** Deterministic stock id for one item in one shop. */
export function freeformShopStockId(shopId: string, reference: FreeformShopItemReference): string {
  return `ff-stock-${sha256(`${shopId}:${reference.packId}:${reference.packVersion}:${reference.definitionId}`).slice(0, 40)}`;
}

/** Deterministic, bounded quantity (1..20) derived from the shop and item identity. */
export function freeformShopQuantity(shopId: string, reference: FreeformShopItemReference): number {
  const span = MAX_FREEFORM_SHOP_QUANTITY - MIN_FREEFORM_SHOP_QUANTITY + 1;
  const value = Number.parseInt(sha256(`${shopId}:${reference.packId}:${reference.packVersion}:${reference.definitionId}`).slice(0, 8), 16);
  return MIN_FREEFORM_SHOP_QUANTITY + (value % span);
}

/** Deterministic public shop name derived from the merchant's bounded public name. */
export function freeformShopName(merchantName: string): string {
  const bounded = merchantName.trim().slice(0, 180) || "Merchant";
  return `${bounded}'s wares`;
}

const compareReferences = (left: FreeformShopItemReference, right: FreeformShopItemReference): number =>
  left.packId.localeCompare(right.packId) || left.packVersion.localeCompare(right.packVersion) || left.definitionId.localeCompare(right.definitionId);

const isValidItemContext = (item: FreeformShopItemContext): boolean =>
  itemCatalogReferenceSchema.safeParse(item.reference).success
  && currencyCatalogReferenceSchema.safeParse(item.currency).success
  && nonNegativeMechanicIntegerSchema.safeParse(item.unitPriceMinor).success
  && typeof item.currencyCode === "string" && item.currencyCode.length > 0;

/**
 * Deterministic, server-owned classification. It never invents content: a candidate
 * shop is only produced when the merchant is public, no shop already exists for it,
 * and the pinned catalog offers at least one priceable item. The classifier only ever
 * selects from the supplied item contexts; callers cannot inject an item or a price.
 */
export function classifyFreeformShop(input: {
  identity: string;
  merchant: FreeformShopMerchantContext | null;
  items: ReadonlyArray<FreeformShopItemContext>;
  existingShopId: string | null;
}): FreeformShopClassification {
  if (!input.merchant) return { intent: "none", reason: "no-merchant" };
  if (input.merchant.visibility !== "public") return { intent: "none", reason: "merchant-not-public" };
  const shopId = freeformShopId(input.identity);
  if (input.existingShopId === shopId) return { intent: "none", reason: "shop-already-exists" };

  const compatible = input.items
    .filter(isValidItemContext)
    .slice()
    .sort((left, right) => compareReferences(left.reference, right.reference))
    .slice(0, MAX_FREEFORM_SHOP_ITEMS);
  if (compatible.length === 0) return { intent: "none", reason: "no-compatible-item" };

  const items: FreeformShopStockLine[] = compatible.map((item) => ({
    stockId: freeformShopStockId(shopId, item.reference),
    item: item.reference,
    quantity: freeformShopQuantity(shopId, item.reference),
    unitPriceMinor: item.unitPriceMinor,
    currencyCode: item.currencyCode,
  }));
  const candidate: FreeformShopCandidate = {
    candidateId: `ffsc-${sha256(input.identity).slice(0, 40)}`,
    shopId,
    shopName: freeformShopName(input.merchant.name),
    npcId: input.merchant.npcId,
    items,
  };
  return { intent: "materialize-shop", merchantName: input.merchant.name, candidates: [candidate] };
}

/** Narrow ports so the module reuses existing repos without importing their full surface. */
export interface FreeformShopPorts {
  getDraftByIdempotencyKey(principalId: string, campaignId: string, idempotencyKey: string): unknown;
  createDraft(principalId: string, input: CreateGenerationDraftInput): PrivateGenerationDraft;
  getContentRevision(principalId: string, campaignId: string): number | null;
  recordCandidate(draftId: string, content: GeneratedCampaignContentProvider): void;
  applyDraft(principalId: string, input: DraftMutationInput & { selectedArtifactKeys: string[] }): PrivateGenerationDraft;
}

export interface FreeformShopRepository {
  /** Classifies one merchant context; throws only for unauthorized principals. */
  classifyFreeformShopIntent(principalId: string, campaignId: string, sessionId: string, actorId: string, merchantNpcId: string): FreeformShopClassification;
  /** Applies the exact server-authored candidate atomically. */
  materializeFreeformShop(principalId: string, campaignId: string, sessionId: string, actorId: string, merchantNpcId: string,
    options?: { candidateId?: string }): FreeformShopMaterialization;
}

type MerchantRow = { npc_id: string; public_name: string };
type StockRow = { stock_id: string; item_pack_id: string; item_pack_version: string; item_definition_id: string; available_quantity: number; unit_price_minor: number; currency_code: string };
type CatalogVisibilityRow = { pack_id: string; pack_version: string; definition_id: string; public_definition_json: string };

function parseItemDefinition(json: string): { name: string; stackable: boolean; amount: unknown; currency: unknown } | null {
  try {
    const value = JSON.parse(json) as { name?: unknown; mechanics?: { price?: { amount?: unknown; currency?: unknown } | null; stackable?: unknown } };
    const price = value.mechanics?.price;
    if (typeof value.name !== "string" || !price || typeof price !== "object") return null;
    return { name: value.name, stackable: value.mechanics?.stackable === true, amount: price.amount, currency: price.currency };
  } catch {
    return null;
  }
}

export function createFreeformShopRepository(
  db: DatabaseDriver.Database,
  deps: { clock: Clock },
  ports: FreeformShopPorts,
  guard: () => void,
): FreeformShopRepository {
  const now = (): string => deps.clock.now().toISOString();

  function authorize(principalId: string, campaignId: string, actorId: string): void {
    const member = db.prepare("SELECT role FROM campaign_memberships WHERE campaign_id=? AND principal_id=?")
      .get(campaignId, principalId) as { role: string } | undefined;
    if (!member || member.role === "observer") throw new FreeformShopAuthorizationError("campaign membership is required");
    if (member.role === "owner" || member.role === "gm") return;
    if (!db.prepare("SELECT 1 FROM campaign_actor_private_state WHERE campaign_id=? AND actor_id=? AND controller_principal_id=?")
      .get(campaignId, actorId, principalId)) throw new FreeformShopAuthorizationError("principal cannot act for the actor");
  }

  /** Resolves GM materialization authority exactly as `initiateCombat` does. */
  function gmAuthorityPrincipal(principalId: string, campaignId: string): string | null {
    if (db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=? AND role IN ('owner','gm')")
      .get(campaignId, principalId)) return principalId;
    const row = db.prepare(`SELECT membership.principal_id principal_id FROM campaign_memberships membership
      JOIN campaigns campaign ON campaign.id=membership.campaign_id
      WHERE membership.campaign_id=? AND membership.role IN ('owner','gm')
      ORDER BY CASE WHEN membership.principal_id=campaign.owner_principal_id THEN 0 ELSE 1 END,membership.principal_id
      LIMIT 1`).get(campaignId) as { principal_id: string } | undefined;
    return row?.principal_id ?? null;
  }

  function readMerchant(campaignId: string, merchantNpcId: string): FreeformShopMerchantContext | null {
    const row = db.prepare("SELECT npc_id,public_name FROM campaign_npcs_v28 WHERE campaign_id=? AND npc_id=?")
      .get(campaignId, merchantNpcId) as MerchantRow | undefined;
    if (!row) return null;
    // A GM-only accepted NPC artifact means the persona is not a public player-facing surface.
    const hidden = db.prepare(`SELECT 1 FROM campaign_generation_accepted_artifacts_v52
      WHERE campaign_id=? AND artifact_kind='npc' AND server_resource_id=? AND visibility='gm' LIMIT 1`)
      .get(campaignId, row.npc_id);
    return { npcId: row.npc_id, name: row.public_name, visibility: hidden ? "gm" : "public" };
  }

  /** The same deterministic legacy code used by `grantSettlementRepo.currencyCode`. */
  function derivedCurrencyCode(currency: { packId: string; packVersion: string; definitionId: string }): string {
    return `CUR${sha256(`${currency.packId}\0${currency.packVersion}\0${currency.definitionId}`).slice(0, 13)}`.toUpperCase();
  }

  /**
   * Resolves the campaign reference for an item's price currency. When no reference
   * exists yet but the exact currency definition is publicly reachable and pinned, the
   * deterministic code is returned; materialization attaches the reference inside its
   * transaction. Never invents a currency definition.
   */
  function resolveCurrencyCode(campaignId: string, currency: { packId: string; packVersion: string; definitionId: string }): string | null {
    const existing = db.prepare(`SELECT currency_code FROM rpg_currency_references_v25
      WHERE campaign_id=? AND pack_id=? AND pack_version=? AND kind='currency' AND definition_id=?`)
      .get(campaignId, currency.packId, currency.packVersion, currency.definitionId) as { currency_code: string } | undefined;
    if (existing) return existing.currency_code;
    const reachable = db.prepare(`SELECT 1 FROM campaign_catalog_current_pins pin
      JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
      WHERE pin.campaign_id=? AND pin.pack_id=? AND pin.pack_version=?
        AND visibility.kind='currency' AND visibility.definition_id=? AND visibility.publicly_reachable=1`)
      .get(campaignId, currency.packId, currency.packVersion, currency.definitionId);
    return reachable ? derivedCurrencyCode(currency) : null;
  }

  /** Reads the closed, public, priceable item set from the campaign's pinned packs. */
  function readCatalogItems(campaignId: string): FreeformShopItemContext[] {
    const rows = db.prepare(`SELECT visibility.pack_id,visibility.pack_version,visibility.definition_id,visibility.public_definition_json
      FROM campaign_catalog_current_pins pin
      JOIN rpg_catalog_definition_visibility visibility ON visibility.pack_id=pin.pack_id AND visibility.pack_version=pin.pack_version
      WHERE pin.campaign_id=? AND visibility.kind='item' AND visibility.publicly_reachable=1
      ORDER BY visibility.pack_id,visibility.pack_version,visibility.definition_id`).all(campaignId) as CatalogVisibilityRow[];
    const items: FreeformShopItemContext[] = [];
    for (const row of rows) {
      const parsed = parseItemDefinition(row.public_definition_json);
      if (!parsed) continue;
      const reference = itemCatalogReferenceSchema.safeParse({ kind: "item", packId: row.pack_id, packVersion: row.pack_version, definitionId: row.definition_id });
      const currency = currencyCatalogReferenceSchema.safeParse(parsed.currency);
      const amount = nonNegativeMechanicIntegerSchema.safeParse(parsed.amount);
      if (!reference.success || !currency.success || !amount.success) continue;
      const currencyCode = resolveCurrencyCode(campaignId, currency.data);
      if (!currencyCode) continue;
      items.push({ reference: reference.data, name: parsed.name, unitPriceMinor: amount.data, currencyCode, currency: currency.data, stackable: parsed.stackable });
    }
    return items;
  }

  function existingShopId(campaignId: string, shopId: string): string | null {
    return db.prepare("SELECT shop_id FROM rpg_shop_definitions_v25 WHERE campaign_id=? AND shop_id=?").get(campaignId, shopId)
      ? shopId : null;
  }

  function classifyWithContext(identity: string, campaignId: string, merchantNpcId: string): FreeformShopClassification {
    return classifyFreeformShop({
      identity,
      merchant: readMerchant(campaignId, merchantNpcId),
      items: readCatalogItems(campaignId),
      existingShopId: existingShopId(campaignId, freeformShopId(identity)),
    });
  }

  /** Attaches the exact campaign catalog definition for stock/currency foreign keys. */
  function ensureCatalogDefinition(campaignId: string, kind: "item" | "currency", reference: { packId: string; packVersion: string; definitionId: string }): void {
    db.prepare(`INSERT OR IGNORE INTO rpg_campaign_catalog_definitions_v25(campaign_id,pack_id,pack_version,kind,definition_id)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM campaign_catalog_current_pins WHERE campaign_id=? AND pack_id=? AND pack_version=?)`)
      .run(campaignId, reference.packId, reference.packVersion, kind, reference.definitionId,
        campaignId, reference.packId, reference.packVersion);
  }

  /** Attaches the exact currency reference for a price, or reuses the existing one. */
  function ensureCurrencyReference(campaignId: string, currency: { packId: string; packVersion: string; definitionId: string }, currencyCode: string): string {
    ensureCatalogDefinition(campaignId, "currency", currency);
    const existing = db.prepare(`SELECT currency_code FROM rpg_currency_references_v25
      WHERE campaign_id=? AND pack_id=? AND pack_version=? AND kind='currency' AND definition_id=?`)
      .get(campaignId, currency.packId, currency.packVersion, currency.definitionId) as { currency_code: string } | undefined;
    if (existing) return existing.currency_code;
    db.prepare("INSERT INTO rpg_currency_references_v25(campaign_id,currency_code,pack_id,pack_version,kind,definition_id) VALUES(?,?,?,?,'currency',?)")
      .run(campaignId, currencyCode, currency.packId, currency.packVersion, currency.definitionId);
    return currencyCode;
  }

  function readStoredStock(campaignId: string, shopId: string): FreeformShopStockLine[] {
    return (db.prepare("SELECT stock_id,item_pack_id,item_pack_version,item_definition_id,available_quantity,unit_price_minor,currency_code FROM rpg_shop_stock_v25 WHERE campaign_id=? AND shop_id=? ORDER BY stock_id")
      .all(campaignId, shopId) as StockRow[]).map((row) => ({
      stockId: row.stock_id,
      item: { kind: "item", packId: row.item_pack_id, packVersion: row.item_pack_version, definitionId: row.item_definition_id },
      quantity: row.available_quantity, unitPriceMinor: row.unit_price_minor, currencyCode: row.currency_code,
    }));
  }

  /**
   * Replays a previously committed materialization. All writes happened in one
   * transaction, so a stored draft is proof the shop notice, shop, stock and binding
   * exist. The receipt is read back from the durable content command rather than re-issued.
   */
  function replayMaterialization(authority: string, campaignId: string, identity: string, merchantNpcId: string): FreeformShopMaterialization {
    const draftKey = idempotencyKeySchema.parse(`ff-shop-draft-${sha256(identity).slice(0, 48)}`);
    const existing = ports.getDraftByIdempotencyKey(authority, campaignId, draftKey);
    if (!existing) throw new FreeformShopConflictError("materialization replay is unavailable");
    const draft = privateGenerationDraftSchema.parse(existing);
    const shop = db.prepare("SELECT name FROM rpg_shop_definitions_v25 WHERE campaign_id=? AND shop_id=?")
      .get(campaignId, freeformShopId(identity)) as { name: string } | undefined;
    if (!shop) throw new FreeformShopConflictError("materialized shop is unavailable");
    const stock = readStoredStock(campaignId, freeformShopId(identity));
    if (stock.length === 0) throw new FreeformShopConflictError("materialized shop has no stock");
    if (!db.prepare("SELECT 1 FROM campaign_npc_shop_bindings_v57 WHERE campaign_id=? AND shop_id=?")
      .get(campaignId, freeformShopId(identity))) throw new FreeformShopConflictError("materialized shop binding is unavailable");
    const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
      .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
    return {
      status: "materialized",
      candidate: { candidateId: `ffsc-${sha256(identity).slice(0, 40)}`, shopId: freeformShopId(identity), shopName: shop.name, npcId: merchantNpcId, items: stock },
      shopId: freeformShopId(identity), npcId: merchantNpcId, draftId: draft.draftId,
      contentReceiptId: receipt?.receipt_id ?? null, bindingCreated: false, stock,
    };
  }

  return {
    classifyFreeformShopIntent(principalId, campaignId, sessionId, actorId, merchantNpcId) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId);
      resourceIdSchema.parse(actorId); resourceIdSchema.parse(merchantNpcId);
      authorize(principalId, campaignId, actorId);
      return classifyWithContext(`${campaignId}:${merchantNpcId}`, campaignId, merchantNpcId);
    },

    materializeFreeformShop(principalId, campaignId, sessionId, actorId, merchantNpcId, options) {
      guard();
      resourceIdSchema.parse(principalId); resourceIdSchema.parse(campaignId); resourceIdSchema.parse(sessionId);
      resourceIdSchema.parse(actorId); resourceIdSchema.parse(merchantNpcId);
      authorize(principalId, campaignId, actorId);

      const identity = `${campaignId}:${merchantNpcId}`;
      const candidateId = `ffsc-${sha256(identity).slice(0, 40)}`;
      const draftKey = idempotencyKeySchema.parse(`ff-shop-draft-${sha256(identity).slice(0, 48)}`);
      const applyKey = idempotencyKeySchema.parse(`ff-shop-apply-${sha256(identity).slice(0, 48)}`);
      if (options?.candidateId !== undefined && options.candidateId !== candidateId) {
        throw new FreeformShopConflictError("the chosen candidate is not in the server-authored set");
      }
      const authority = gmAuthorityPrincipal(principalId, campaignId);
      if (!authority) throw new FreeformShopUnavailableError("campaign has no GM authority to materialize a shop");

      return db.transaction(() => {
        if (ports.getDraftByIdempotencyKey(authority, campaignId, draftKey)) {
          return replayMaterialization(authority, campaignId, identity, merchantNpcId);
        }

        // Freshness re-check: only materialize a shop the classifier still authorizes.
        const classification = classifyWithContext(identity, campaignId, merchantNpcId);
        if (classification.intent === "none") return { status: "declined" as const, reason: classification.reason };
        const candidate = classification.candidates.find((value) => value.candidateId === candidateId);
        if (!candidate) throw new FreeformShopConflictError("the chosen candidate is no longer available");

        const campaign = db.prepare("SELECT active_timeline_id,administration_revision FROM campaigns WHERE id=?")
          .get(campaignId) as { active_timeline_id: string; administration_revision: number } | undefined;
        if (!campaign) throw new FreeformShopUnavailableError("campaign is unavailable");

        // A public shop notice is the durable, player-facing artifact and carries the receipt.
        const catalogItems = readCatalogItems(campaignId);
        const catalogByReference = new Map(catalogItems.map((item) =>
          [`${item.reference.packId}\0${item.reference.packVersion}\0${item.reference.definitionId}`, item]));
        const referenceKey = (line: FreeformShopStockLine): string =>
          `${line.item.packId}\0${line.item.packVersion}\0${line.item.definitionId}`;
        const noticeKey = generatedArtifactKeySchema.parse(`ff-shop-notice-${sha256(identity).slice(0, 40)}`);
        const noticeDetails = candidate.items.map((line) => {
          const label = catalogByReference.get(referenceKey(line));
          const text = `${label?.name ?? line.item.definitionId} — ${line.unitPriceMinor} ${line.currencyCode}`;
          return text.length > 500 ? text.slice(0, 500) : text;
        });
        const content = generatedCampaignContentProviderSchema.parse({
          lore: [{
            key: noticeKey, title: candidate.shopName,
            summary: `A public stall of ${candidate.shopName.replace(/'s wares$/, "")}, offering catalog-priced wares.`.slice(0, 4000),
            details: noticeDetails, visibility: "public", locationKeys: [], factionKeys: [], storyNodeKeys: [],
          }],
        });
        const requestDigest = sha256(canonical({ kind: "freeform-materialize-shop", campaignId, merchantNpcId, candidate }));

        const baseRevision = ports.getContentRevision(authority, campaignId);
        if (baseRevision === null) throw new FreeformShopUnavailableError("generation context is unavailable");
        const draft = ports.createDraft(authority, {
          campaignId, timelineId: campaign.active_timeline_id, sessionId, kind: "content-pack",
          stagedContent: stagedCampaignContentGenerationSchema.parse({
            kind: "campaign-content", requestDigest, baseContentRevision: baseRevision, dependencyDigests: {}, ...content,
          }),
          validation: { valid: true, issues: [], validatedAt: now() },
          expectedCampaignRevision: campaign.administration_revision,
          idempotencyKey: draftKey,
        });
        if (!db.prepare("SELECT 1 FROM campaign_generation_candidate_artifacts_v52 WHERE draft_id=? LIMIT 1").get(draft.draftId)) {
          ports.recordCandidate(draft.draftId, content);
        }
        const applied = ports.applyDraft(authority, {
          draftId: draft.draftId, expectedDraftRevision: draft.revision, expectedCampaignRevision: draft.campaignRevision,
          idempotencyKey: applyKey, selectedArtifactKeys: [noticeKey],
        });

        const at = now();
        db.prepare("INSERT INTO rpg_shop_definitions_v25(shop_id,campaign_id,name,created_at) VALUES(?,?,?,?)")
          .run(candidate.shopId, campaignId, candidate.shopName, at);
        for (const line of candidate.items) {
          ensureCatalogDefinition(campaignId, "item", line.item);
          const context = catalogByReference.get(referenceKey(line));
          const currencyCode = context
            ? ensureCurrencyReference(campaignId, context.currency, line.currencyCode)
            : line.currencyCode;
          db.prepare(`INSERT INTO rpg_shop_stock_v25(stock_id,campaign_id,shop_id,item_pack_id,item_pack_version,item_kind,
            item_definition_id,available_quantity,unit_price_minor,currency_code) VALUES(?,?,?,?,?,'item',?,?,?,?)`)
            .run(line.stockId, campaignId, candidate.shopId, line.item.packId, line.item.packVersion, line.item.definitionId,
              line.quantity, line.unitPriceMinor, currencyCode);
        }
        const priorBinding = db.prepare("SELECT shop_id FROM campaign_npc_shop_bindings_v57 WHERE campaign_id=? AND npc_id=?")
          .get(campaignId, merchantNpcId) as { shop_id: string } | undefined;
        if (priorBinding && priorBinding.shop_id !== candidate.shopId) {
          throw new FreeformShopConflictError("the merchant is already bound to a different shop");
        }
        const bindingCreated = !priorBinding;
        if (bindingCreated) {
          db.prepare("INSERT INTO campaign_npc_shop_bindings_v57 VALUES(?,?,?,?,?)")
            .run(campaignId, merchantNpcId, candidate.shopId, at, authority);
        }
        const receipt = db.prepare("SELECT receipt_id FROM campaign_content_receipts_v42 WHERE campaign_id=? AND draft_id=?")
          .get(campaignId, draft.draftId) as { receipt_id: string } | undefined;
        return {
          status: "materialized" as const,
          candidate: { candidateId, shopId: candidate.shopId, shopName: candidate.shopName, npcId: merchantNpcId, items: candidate.items },
          shopId: candidate.shopId, npcId: merchantNpcId, draftId: applied.draftId,
          contentReceiptId: receipt?.receipt_id ?? null, bindingCreated,
          stock: candidate.items,
        };
      }).immediate();
    },
  };
}
