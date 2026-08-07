import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  CONTENT_VALIDATION_LEVEL,
  campaignCatalogReceiptSchema,
  campaignCatalogResolutionReportSchema,
  catalogDefinitionReferenceSchema,
  catalogDefinitionSchema,
  catalogValidationReportSchema,
  contentPackIdSchema,
  contentPackVersionSchema,
  gmCatalogProjectionSchema,
  memberCatalogDefinitionSchema,
  observerCatalogDefinitionSchema,
  observerCatalogProjectionSchema,
  ownerCatalogProjectionSchema,
  playerCatalogProjectionSchema,
  publicationSummarySchema,
  publishContentCatalogInputSchema,
  resourceIdSchema,
  type CampaignCatalogReceipt,
  type CampaignCatalogResolutionReport,
  type CatalogDefinition,
  type CatalogDefinitionKind,
  type CatalogValidationReport,
  type OwnerCatalogProjection,
  type PublicationSummary,
  type PublishContentCatalogInput,
} from "@velvet/contracts";
import {
  type PersistedCatalogVisibilityRow,
  verifyCatalogVisibilityProjection,
} from "./catalogVisibility.js";
import { canonicalCatalogJson } from "./catalogValidation.js";

/** Input accepted by the validated-publication page reader. */
export interface ContentCatalogPublicationPageInput { status: "validated"; cursor?: string; limit?: number; }
/** A deterministic page of validated publication summaries. */
export interface ContentCatalogPublicationPage { publications: PublicationSummary[]; nextCursor: string | null; }
/** Persisted, attestable role-visibility record. */
export type { PersistedCatalogVisibilityRow } from "./catalogVisibility.js";

interface PublicationRow { pack_id: string; pack_version: string; name: string; description: string; tags: string; rules_profile_id: string; manifest_digest: string; manifest_json: string; provenance_json: string; validation_report_json: string; published_at: string; definition_count: number; definition_counts_json: string; publication_digest: string; public_projection_digest: string; public_projection_count: number; }
interface Projectors { canonicalCatalogJson(value: unknown): string; validateContentCatalog(input: unknown): CatalogValidationReport; verifyCatalogVisibilityProjection(input: { packId: string; packVersion: string; expectedCount: number; publicationDigest: string; manifestDigest: string; aggregateDigest: string; rows: PersistedCatalogVisibilityRow[] }): unknown[]; }
const PUBLICATION_SELECT = `SELECT pack.pack_id,pack.pack_version,pack.rules_profile_id,pack.name,pack.description,pack.tags, publication.manifest_digest,publication.manifest_json,publication.provenance_json, publication.validation_report_json,publication.published_at, attestation.definition_count,attestation.definition_counts_json,attestation.publication_digest, attestation.public_projection_digest,attestation.public_projection_count FROM rpg_content_packs pack JOIN rpg_content_pack_publications publication ON publication.pack_id=pack.pack_id AND publication.pack_version=pack.pack_version JOIN rpg_catalog_publication_attestations attestation ON attestation.pack_id=publication.pack_id AND attestation.pack_version=publication.pack_version WHERE publication.validation_level='validated-v1'`;
const MAX_PUBLICATION_PAGE_SIZE = 100;
const binaryCompare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

/**
 * Verifies persisted visibility data before returning legacy public definition
 * identities. Callers must not trust `publicly_reachable` directly.
 */
export function readVerifiedPublicDefinitionKeys(
  db: DatabaseDriver.Database,
  packId: string,
  packVersion: string,
): Set<string> {
  const publication = db.prepare(`${PUBLICATION_SELECT} AND pack.pack_id=? AND pack.pack_version=?`)
    .get(packId, packVersion) as PublicationRow | undefined;
  if (!publication) throw new Error("validated content publication attestation is missing");
  publicationSummary(publication, canonicalCatalogJson);
  const rows = db.prepare(`SELECT kind,definition_id,public_definition_json,public_dependencies_json,
    private_dependencies_json,row_digest,publicly_reachable FROM rpg_catalog_definition_visibility
    WHERE pack_id=? AND pack_version=? ORDER BY kind COLLATE BINARY,definition_id COLLATE BINARY`)
    .all(packId, packVersion) as PersistedCatalogVisibilityRow[];
  return new Set(verifyCatalogVisibilityProjection({
    packId,
    packVersion,
    expectedCount: publication.definition_count,
    rows,
    publicationDigest: publication.publication_digest,
    manifestDigest: publication.manifest_digest,
    aggregateDigest: publication.public_projection_digest,
  }).map((definition) => {
    const parsed = memberCatalogDefinitionSchema.parse(definition);
    const kind = parsed.reference.kind === "enemy-template" ? "enemy" : parsed.reference.kind;
    return `${kind}\0${parsed.reference.definitionId}`;
  }));
}

/** Validates and projects an attested publication summary from persisted fields. */
function publicationSummary(
  row: PublicationRow,
  canonicalJson: (value: unknown) => string,
): PublicationSummary {
  const manifest = publishContentCatalogInputSchema.shape.manifest.parse(JSON.parse(row.manifest_json));
  if (manifest.packId !== row.pack_id || manifest.packVersion !== row.pack_version
    || manifest.compatibility.rulesProfileId !== row.rules_profile_id || manifest.digest !== row.manifest_digest
    || manifest.name !== row.name || manifest.description !== row.description || JSON.stringify(manifest.tags) !== row.tags) {
    throw new Error("persisted content publication manifest is inconsistent");
  }
  const report = catalogValidationReportSchema.parse(JSON.parse(row.validation_report_json));
  if (!report.valid || report.issues.length !== 0 || report.normalizedSummary.digest !== row.manifest_digest
    || report.normalizedSummary.totalDefinitions !== row.definition_count
    || canonicalJson(report.normalizedSummary.counts) !== canonicalJson(JSON.parse(row.definition_counts_json))) {
    throw new Error("persisted content publication report is inconsistent");
  }
  return publicationSummarySchema.parse({
    packId: row.pack_id,
    packVersion: row.pack_version,
    name: row.name,
    description: row.description,
    tags: JSON.parse(row.tags),
    compatibility: manifest.compatibility,
    digest: row.manifest_digest,
    validationLevel: CONTENT_VALIDATION_LEVEL,
    publishedAt: row.published_at,
  });
}

/** Builds the database-backed, non-mutating content-catalog operations. */
export function createCatalogReadRepository(db: DatabaseDriver.Database, projectors: Projectors) {
  const isApplicationOwner = (actor: string): boolean => !!db.prepare(`SELECT 1 FROM application_owner owner JOIN principals principal ON principal.id=owner.principal_id WHERE owner.singleton=1 AND owner.principal_id=?`).get(actor);
  const summary = (row: PublicationRow): PublicationSummary => publicationSummary(row, projectors.canonicalCatalogJson);
  const publicationRow = (packId: string, packVersion: string): PublicationRow | undefined => db.prepare(`${PUBLICATION_SELECT} AND pack.pack_id=? AND pack.pack_version=?`).get(packId, packVersion) as PublicationRow | undefined;
  const readDefinitions = (packId: string, packVersion: string): CatalogDefinition[] => (db.prepare(`SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? ORDER BY kind COLLATE BINARY,definition_id COLLATE BINARY`).all(packId, packVersion) as Array<{ definition_json: string }>).map((row) => catalogDefinitionSchema.parse(JSON.parse(row.definition_json)));
  const legacyKind = (kind: CatalogDefinitionKind): "race" | "background" | "class" | "item" | "spell" | "ability" | "enemy" | null => kind === "enemy-template" ? "enemy" : kind === "race" || kind === "background" || kind === "class" || kind === "item" || kind === "spell" || kind === "ability" ? kind : null;
  const validateStoredPublication = (row: PublicationRow): PublishContentCatalogInput => {
    const manifest = publishContentCatalogInputSchema.shape.manifest.parse(JSON.parse(row.manifest_json)); const definitions = readDefinitions(row.pack_id, row.pack_version); const input = publishContentCatalogInputSchema.parse({ idempotencyKey: "stored-publication-validation", manifest, definitions }); const report = projectors.validateContentCatalog(input); const storedReport = catalogValidationReportSchema.parse(JSON.parse(row.validation_report_json));
    if (!report.valid || report.normalizedSummary.digest !== row.manifest_digest || row.definition_count !== definitions.length || projectors.canonicalCatalogJson(report) !== projectors.canonicalCatalogJson(storedReport) || projectors.canonicalCatalogJson(report.normalizedSummary.counts) !== projectors.canonicalCatalogJson(JSON.parse(row.definition_counts_json))) throw new Error("persisted content publication validation is inconsistent");
    summary(row); const profile = db.prepare("SELECT name,description,tags FROM rpg_rules_profiles WHERE rules_profile_id=?").get(row.rules_profile_id) as { name: string; description: string; tags: string } | undefined;
    if (!profile || profile.name !== manifest.rulesProfile.name || profile.description !== manifest.rulesProfile.description || profile.tags !== JSON.stringify(manifest.rulesProfile.tags)) throw new Error("persisted content publication rules profile is inconsistent");
    const legacyRows = db.prepare(`SELECT kind,definition_id,name,description,tags FROM rpg_definitions WHERE pack_id=? AND pack_version=? ORDER BY kind COLLATE BINARY,definition_id COLLATE BINARY`).all(row.pack_id, row.pack_version);
    const expectedLegacy = definitions.flatMap((definition) => { const kind = legacyKind(definition.reference.kind); return kind ? [{ kind, definition_id: definition.reference.definitionId, name: definition.name, description: definition.description, tags: JSON.stringify(definition.tags) }] : []; }).sort((left, right) => binaryCompare(left.kind, right.kind) || binaryCompare(left.definition_id, right.definition_id));
    if (projectors.canonicalCatalogJson(legacyRows) !== projectors.canonicalCatalogJson(expectedLegacy)) throw new Error("persisted content publication legacy definitions are inconsistent"); return input;
  };
  const authority = (actor: string, campaignId: string): "owner" | "gm" | "player" | "observer" | null => {
    const row = db.prepare(`SELECT membership.role,campaign.owner_principal_id,campaign.owner_role,(SELECT COUNT(*) FROM campaign_memberships owner_membership WHERE owner_membership.campaign_id=campaign.id AND owner_membership.role='owner') owner_count,(SELECT COUNT(*) FROM campaign_memberships owner_membership JOIN principals owner_principal ON owner_principal.id=owner_membership.principal_id WHERE owner_membership.campaign_id=campaign.id AND owner_membership.role='owner' AND owner_membership.principal_id=campaign.owner_principal_id) canonical_owner_count FROM campaigns campaign JOIN campaign_memberships membership ON membership.campaign_id=campaign.id AND membership.principal_id=? JOIN principals principal ON principal.id=membership.principal_id WHERE campaign.id=? AND membership.role IN ('owner','gm','player','observer')`).get(actor, campaignId) as { role: "owner" | "gm" | "player" | "observer"; owner_principal_id: string; owner_role: string; owner_count: number; canonical_owner_count: number } | undefined;
    if (!row) return null; if (row.owner_role !== "owner" || row.owner_count !== 1 || row.canonical_owner_count !== 1 || (row.role === "owner" && row.owner_principal_id !== actor)) throw new Error("malformed campaign ownership"); return row.role;
  };
  const readPublicDefinitions = (packId: string, packVersion: string, expectedCount: number): unknown[] => { const rows = db.prepare(`SELECT kind,definition_id,public_definition_json,public_dependencies_json,private_dependencies_json,row_digest,publicly_reachable FROM rpg_catalog_definition_visibility WHERE pack_id=? AND pack_version=? ORDER BY kind COLLATE BINARY,definition_id COLLATE BINARY`).all(packId, packVersion) as PersistedCatalogVisibilityRow[]; const publication = publicationRow(packId, packVersion); if (!publication) throw new Error("validated content publication attestation is missing"); return projectors.verifyCatalogVisibilityProjection({ packId, packVersion, expectedCount, rows, publicationDigest: publication.publication_digest, manifestDigest: publication.manifest_digest, aggregateDigest: publication.public_projection_digest }); };
  const ownerProjection = (row: PublicationRow): OwnerCatalogProjection => { const validated = validateStoredPublication(row); return ownerCatalogProjectionSchema.parse({ publication: summary(row), provenance: validated.manifest.provenance, definitions: validated.definitions }); };
  const observerDefinition = (definition: unknown): unknown => { const parsed = memberCatalogDefinitionSchema.parse(definition); return observerCatalogDefinitionSchema.parse({ reference: parsed.reference, name: parsed.name, description: parsed.description, tags: parsed.tags }); };
  const cursor = (packId: string, packVersion: string) => Buffer.from(JSON.stringify([packId, packVersion]), "utf8").toString("base64url");
  const parsePage = (input: ContentCatalogPublicationPageInput): { cursor: [string, string] | null; limit: number } => { try { if (input === null || typeof input !== "object" || Array.isArray(input) || input.status !== "validated" || (input.cursor !== undefined && typeof input.cursor !== "string") || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_PUBLICATION_PAGE_SIZE))) throw new Error(); let decoded: [string, string] | null = null; if (input.cursor !== undefined) { if (!input.cursor || input.cursor.length > 512) throw new Error(); const text = Buffer.from(input.cursor, "base64url").toString("utf8"); if (Buffer.from(text, "utf8").toString("base64url") !== input.cursor) throw new Error(); const value: unknown = JSON.parse(text); if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") throw new Error(); decoded = [contentPackIdSchema.parse(value[0]), contentPackVersionSchema.parse(value[1])]; } return { cursor: decoded, limit: input.limit ?? 25 }; } catch { throw new Error("invalid content catalog publication page input"); } };
  return {
    isApplicationOwner, publicationRow, validateStoredPublication, ownerProjection, campaignAuthority: authority, legacyKind,
    listContentCatalogPublications(actor: string): PublicationSummary[] { if (!isApplicationOwner(actor)) return []; return (db.prepare(`${PUBLICATION_SELECT} ORDER BY pack.pack_id COLLATE BINARY,pack.pack_version COLLATE BINARY`).all() as PublicationRow[]).map((row) => { validateStoredPublication(row); return summary(row); }); },
    listContentCatalogPublicationPage(actor: string, input: ContentCatalogPublicationPageInput): ContentCatalogPublicationPage { const page = parsePage(input); if (!isApplicationOwner(actor)) return { publications: [], nextCursor: null }; const clause = page.cursor === null ? "" : " AND (pack.pack_id COLLATE BINARY > ? OR (pack.pack_id COLLATE BINARY = ? AND pack.pack_version COLLATE BINARY > ?))"; const rows = db.prepare(`${PUBLICATION_SELECT}${clause} ORDER BY pack.pack_id COLLATE BINARY,pack.pack_version COLLATE BINARY LIMIT ?`).all(...(page.cursor === null ? [] : [page.cursor[0], page.cursor[0], page.cursor[1]]), page.limit + 1) as PublicationRow[]; const publications = rows.slice(0, page.limit).map((row) => { validateStoredPublication(row); return summary(row); }); const last = publications.at(-1); return { publications, nextCursor: rows.length > page.limit && last ? cursor(last.packId, last.packVersion) : null }; },
    getContentCatalogForOwner(actor: string, packIdValue: string, packVersion: string): OwnerCatalogProjection | null { const packId = contentPackIdSchema.parse(packIdValue); const version = contentPackVersionSchema.parse(packVersion); if (!isApplicationOwner(actor)) return null; const row = publicationRow(packId, version); return row ? ownerProjection(row) : null; },
    getCampaignContentCatalog(actor: string, campaignIdValue: string, packIdValue: string, packVersion: string) { const campaignId = resourceIdSchema.parse(campaignIdValue); const packId = contentPackIdSchema.parse(packIdValue); const version = contentPackVersionSchema.parse(packVersion); const role = authority(actor, campaignId); if (!role || !db.prepare("SELECT 1 FROM campaign_catalog_current_pins WHERE campaign_id=? AND pack_id=? AND pack_version=?").get(campaignId, packId, version)) return null; const row = publicationRow(packId, version); if (!row) throw new Error("persisted campaign catalog publication is missing"); if (role === "owner" || role === "gm") return gmCatalogProjectionSchema.parse({ publication: summary(row), definitions: validateStoredPublication(row).definitions }); const safe = readPublicDefinitions(packId, version, row.definition_count); return role === "player" ? playerCatalogProjectionSchema.parse({ publication: summary(row), definitions: safe }) : observerCatalogProjectionSchema.parse({ publication: summary(row), definitions: safe.map(observerDefinition) }); },
    resolveCampaignCatalog(actor: string, campaignIdValue: string): CampaignCatalogResolutionReport | null { const campaignId = resourceIdSchema.parse(campaignIdValue); if (!authority(actor, campaignId)) return null; if (db.prepare(`SELECT 1 FROM campaign_catalog_commands command LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id WHERE command.campaign_id=? AND receipt.command_id IS NULL LIMIT 1`).get(campaignId)) throw new Error("campaign catalog audit is incomplete"); const selection = db.prepare("SELECT rules_profile_id,selection_digest,configured_by_principal_id,configured_at FROM campaign_catalog_current_selections WHERE campaign_id=?").get(campaignId) as { rules_profile_id: string; selection_digest: string; configured_by_principal_id: string; configured_at: string } | undefined; if (!selection) return null; const packs = db.prepare(`SELECT pin.pack_id,pin.pack_version,publication.manifest_digest FROM campaign_catalog_current_pins pin JOIN rpg_content_pack_publications publication ON publication.pack_id=pin.pack_id AND publication.pack_version=pin.pack_version WHERE pin.campaign_id=? ORDER BY pin.pack_id COLLATE BINARY,pin.pack_version COLLATE BINARY`).all(campaignId) as Array<{ pack_id: string; pack_version: string; manifest_digest: string }>; if (!packs.length) throw new Error("persisted campaign catalog is incomplete"); resourceIdSchema.parse(selection.configured_by_principal_id); if (!Number.isFinite(new Date(selection.configured_at).getTime())) throw new Error("persisted campaign catalog timestamp is invalid"); const identifiers = packs.map((pack) => ({ packId: pack.pack_id, packVersion: pack.pack_version })); const expected = createHash("sha256").update(projectors.canonicalCatalogJson({ rulesProfileId: selection.rules_profile_id, contentPacks: identifiers }), "utf8").digest("hex"); if (selection.selection_digest !== expected) throw new Error("persisted campaign catalog selection digest is inconsistent"); const legacyProfile = db.prepare("SELECT rules_profile_id FROM campaign_rules_profiles WHERE campaign_id=?").get(campaignId) as { rules_profile_id: string } | undefined; const legacyPins = db.prepare("SELECT pack_id,pack_version FROM campaign_content_packs WHERE campaign_id=? ORDER BY pack_id COLLATE BINARY,pack_version COLLATE BINARY").all(campaignId) as Array<{ pack_id: string; pack_version: string }>; if (legacyProfile?.rules_profile_id !== selection.rules_profile_id || projectors.canonicalCatalogJson(legacyPins.map((pin) => ({ packId: pin.pack_id, packVersion: pin.pack_version }))) !== projectors.canonicalCatalogJson(identifiers)) throw new Error("persisted campaign catalog legacy pins are inconsistent"); for (const pack of packs) { const row = publicationRow(pack.pack_id, pack.pack_version); if (!row || row.rules_profile_id !== selection.rules_profile_id) throw new Error("persisted campaign catalog is inconsistent"); validateStoredPublication(row); } return campaignCatalogResolutionReportSchema.parse({ campaignId, compatible: true, rulesProfileId: selection.rules_profile_id, contentPacks: packs.map((pack) => ({ packId: pack.pack_id, packVersion: pack.pack_version, digest: pack.manifest_digest })), issues: [] }); },
    getCampaignCatalogReceipt(actor: string, campaignIdValue: string, commandIdValue: string): CampaignCatalogReceipt | null { const campaignId = resourceIdSchema.parse(campaignIdValue); const commandId = resourceIdSchema.parse(commandIdValue); if (!authority(actor, campaignId)) return null; const row = db.prepare("SELECT receipt.result_json FROM campaign_catalog_receipts receipt JOIN campaign_catalog_commands command ON command.campaign_id=receipt.campaign_id AND command.command_id=receipt.command_id WHERE receipt.campaign_id=? AND receipt.command_id=?").get(campaignId, commandId) as { result_json: string } | undefined; return row ? campaignCatalogReceiptSchema.parse(JSON.parse(row.result_json)) : null; },
  };
}
