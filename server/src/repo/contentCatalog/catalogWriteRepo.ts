import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  VELVET_STARTER_RULES_ENGINE,
  campaignCatalogConfigurationResultSchema,
  campaignCatalogReceiptSchema,
  campaignCatalogResolutionReportSchema,
  configureCampaignCatalogInputSchema,
  publishContentCatalogInputSchema,
  resourceIdSchema,
  type CampaignCatalogConfigurationResult,
  type CatalogDefinition,
  type CatalogValidationReport,
  type OwnerCatalogProjection,
  type PublishContentCatalogInput,
} from "@velvet/contracts";
import type { Clock } from "../../runtime.js";
import { createCatalogReadRepository, type PersistedCatalogVisibilityRow } from "./catalogReadRepo.js";

/** Raised when a submitted catalog fails deterministic validation. */
export class ContentCatalogValidationError extends Error {
  readonly code = "CONTENT_CATALOG_INVALID";
  constructor(readonly report: CatalogValidationReport) { super("content catalog validation failed"); this.name = "ContentCatalogValidationError"; }
}
/** Raised when an actor is not allowed to change catalog state. */
export class ContentCatalogAuthorizationError extends Error {
  readonly code = "CONTENT_CATALOG_FORBIDDEN";
  constructor(message = "content catalog publication requires the application owner") { super(message); this.name = "ContentCatalogAuthorizationError"; }
}
/** Raised when an immutable catalog or command idempotency identity conflicts. */
export class ContentCatalogConflictError extends Error {
  readonly code = "CONTENT_CATALOG_CONFLICT";
  constructor(message: string) { super(message); this.name = "ContentCatalogConflictError"; }
}
/** Raised when a campaign catalog command uses an old administration revision. */
export class ContentCatalogStaleError extends Error {
  readonly code = "CONTENT_CATALOG_STALE";
  constructor() { super("campaign catalog revision is stale"); this.name = "ContentCatalogStaleError"; }
}

/** Pure collaborators required by the catalog write transaction factory. */
export interface CatalogWriteDependencies {
  clock: Clock;
  canonicalCatalogJson(value: unknown): string;
  validateContentCatalog(input: unknown): CatalogValidationReport;
  verifyCatalogVisibilityProjection(input: { packId: string; packVersion: string; expectedCount: number; publicationDigest: string; manifestDigest: string; aggregateDigest: string; rows: PersistedCatalogVisibilityRow[] }): unknown[];
  deriveCatalogVisibility(definitions: readonly unknown[]): { rows: Array<{ definition: CatalogDefinition; publicDefinitionJson: string; publicDependenciesJson: string; privateDependenciesJson: string; rowDigest: string; publiclyReachable: boolean }>; aggregateDigest: string };
  dependencies(definition: CatalogDefinition): unknown[];
}

/** Builds atomic content-publication and campaign-catalog command write operations. */
export function createCatalogWriteRepository(db: DatabaseDriver.Database, deps: CatalogWriteDependencies) {
  const reads = createCatalogReadRepository(db, deps);
  const ensureProfile = (input: PublishContentCatalogInput): void => {
    const id = input.manifest.compatibility.rulesProfileId;
    const existing = db.prepare("SELECT name,description,tags FROM rpg_rules_profiles WHERE rules_profile_id=?").get(id) as { name: string; description: string; tags: string } | undefined;
    const expected = input.manifest.rulesProfile;
    if (existing) {
      if (existing.name !== expected.name || existing.description !== expected.description || existing.tags !== JSON.stringify(expected.tags)) throw new ContentCatalogConflictError("rules profile metadata conflicts with the exact installed profile");
      return;
    }
    db.prepare("INSERT INTO rpg_rules_profiles (rules_profile_id,name,description,tags) VALUES (?,?,?,?)").run(id, expected.name, expected.description, JSON.stringify(expected.tags));
  };
  const receiptFromRow = (value: string) => campaignCatalogReceiptSchema.parse(JSON.parse(value));

  const publishContentCatalog = (actor: string, unknownInput: unknown): OwnerCatalogProjection => {
    if (!reads.isApplicationOwner(actor)) throw new ContentCatalogAuthorizationError();
    const report = deps.validateContentCatalog(unknownInput);
    const parsed = publishContentCatalogInputSchema.safeParse(unknownInput);
    if (!report.valid) {
      if (parsed.success && db.prepare("SELECT 1 FROM rpg_content_packs WHERE pack_id=? AND pack_version=?").get(parsed.data.manifest.packId, parsed.data.manifest.packVersion)) throw new ContentCatalogConflictError("a differing content catalog already uses this exact pack version");
      throw new ContentCatalogValidationError(report);
    }
    const input = parsed.success ? parsed.data : publishContentCatalogInputSchema.parse(unknownInput);
    const requestDigest = createHash("sha256").update(deps.canonicalCatalogJson(input), "utf8").digest("hex");
    return db.transaction(() => {
      if (!reads.isApplicationOwner(actor)) throw new ContentCatalogAuthorizationError();
      const prior = db.prepare("SELECT request_digest,pack_id,pack_version FROM rpg_catalog_publication_submissions WHERE principal_id=? AND idempotency_key=?").get(actor, input.idempotencyKey) as { request_digest: string; pack_id: string; pack_version: string } | undefined;
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new ContentCatalogConflictError("publication idempotency key conflicts with a different payload");
        const row = reads.publicationRow(prior.pack_id, prior.pack_version);
        if (!row) throw new Error("publication submission receipt is incomplete");
        return reads.ownerProjection(row);
      }
      if (db.prepare("SELECT sealed FROM rpg_content_packs WHERE pack_id=? AND pack_version=?").get(input.manifest.packId, input.manifest.packVersion)) throw new ContentCatalogConflictError("a differing content catalog already uses this exact pack version");
      ensureProfile(input);
      db.prepare("INSERT INTO rpg_content_packs (pack_id,pack_version,rules_profile_id,name,description,tags,sealed) VALUES (?,?,?,?,?,?,0)").run(input.manifest.packId, input.manifest.packVersion, input.manifest.compatibility.rulesProfileId, input.manifest.name, input.manifest.description, JSON.stringify(input.manifest.tags));
      const insert = db.prepare("INSERT INTO rpg_catalog_definitions (pack_id,pack_version,kind,definition_id,definition_json,public_definition_json,dependencies_json) VALUES (?,?,?,?,?,?,?)");
      const insertVisibility = db.prepare("INSERT INTO rpg_catalog_definition_visibility (pack_id,pack_version,kind,definition_id,public_definition_json,public_dependencies_json,private_dependencies_json,row_digest,publicly_reachable) VALUES (?,?,?,?,?,?,?,?,?)");
      const insertLegacy = db.prepare("INSERT INTO rpg_definitions (pack_id,pack_version,kind,definition_id,name,description,tags) VALUES (?,?,?,?,?,?,?)");
      const visibility = deps.deriveCatalogVisibility(input.definitions);
      for (const derived of visibility.rows) {
        const definition = derived.definition;
        insert.run(input.manifest.packId, input.manifest.packVersion, definition.reference.kind, definition.reference.definitionId, deps.canonicalCatalogJson(definition), derived.publicDefinitionJson, deps.canonicalCatalogJson(deps.dependencies(definition)));
        insertVisibility.run(input.manifest.packId, input.manifest.packVersion, definition.reference.kind, definition.reference.definitionId, derived.publicDefinitionJson, derived.publicDependenciesJson, derived.privateDependenciesJson, derived.rowDigest, derived.publiclyReachable ? 1 : 0);
        const kind = reads.legacyKind(definition.reference.kind);
        if (kind) insertLegacy.run(input.manifest.packId, input.manifest.packVersion, kind, definition.reference.definitionId, definition.name, definition.description, JSON.stringify(definition.tags));
      }
      db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id=? AND pack_version=? AND sealed=0").run(input.manifest.packId, input.manifest.packVersion);
      const publishedAt = deps.clock.now().toISOString();
      db.prepare("INSERT INTO rpg_content_pack_publications (pack_id,pack_version,validation_level,rules_engine,manifest_digest,manifest_json,provenance_json,validation_report_json,published_by_principal_id,published_at) VALUES (?,?, 'validated-v1',?,?,?,?,?,?,?)").run(input.manifest.packId, input.manifest.packVersion, VELVET_STARTER_RULES_ENGINE, input.manifest.digest, deps.canonicalCatalogJson(input.manifest), deps.canonicalCatalogJson(input.manifest.provenance), deps.canonicalCatalogJson(report), actor, publishedAt);
      db.prepare("INSERT INTO rpg_catalog_publication_attestations VALUES (?,?,?,?,?,?,?)").run(input.manifest.packId, input.manifest.packVersion, input.definitions.length, deps.canonicalCatalogJson(report.normalizedSummary.counts), input.manifest.digest, visibility.aggregateDigest, input.definitions.length);
      db.prepare("INSERT INTO rpg_catalog_publication_submissions VALUES (?,?,?,?,?,?,?)").run(actor, input.idempotencyKey, requestDigest, input.manifest.packId, input.manifest.packVersion, deps.canonicalCatalogJson({ packId: input.manifest.packId, packVersion: input.manifest.packVersion }), publishedAt);
      return reads.ownerProjection(reads.publicationRow(input.manifest.packId, input.manifest.packVersion)!);
    }).immediate();
  };

  const configureCampaignCatalog = (actor: string, campaignIdValue: string, raw: unknown): CampaignCatalogConfigurationResult => {
    const campaignId = resourceIdSchema.parse(campaignIdValue);
    if (reads.campaignAuthority(actor, campaignId) !== "owner") throw new ContentCatalogAuthorizationError("campaign catalog configuration requires the campaign owner");
    const input = configureCampaignCatalogInputSchema.parse(raw);
    const ordered = [...input.contentPacks].sort((a, b) => a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : a.packVersion < b.packVersion ? -1 : a.packVersion > b.packVersion ? 1 : 0);
    return db.transaction(() => {
      if (reads.campaignAuthority(actor, campaignId) !== "owner") throw new ContentCatalogAuthorizationError("campaign catalog configuration requires the campaign owner");
      const requested = { rulesProfileId: input.rulesProfileId, contentPacks: ordered, expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey };
      const canonicalRequested = deps.canonicalCatalogJson(requested);
      const requestDigest = createHash("sha256").update(canonicalRequested, "utf8").digest("hex");
      const prior = db.prepare("SELECT command.requested_json,command.actor_principal_id,command.expected_revision,receipt.result_json FROM campaign_catalog_commands command LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id WHERE command.campaign_id=? AND command.idempotency_key=?").get(campaignId, input.idempotencyKey) as { requested_json: string; actor_principal_id: string; expected_revision: number; result_json: string | null } | undefined;
      if (prior) {
        if (prior.requested_json !== canonicalRequested || prior.actor_principal_id !== actor || prior.expected_revision !== input.expectedRevision) throw new ContentCatalogConflictError("catalog idempotency key conflicts with a different request");
        if (prior.result_json === null) throw new Error("catalog command is incomplete");
        const receipt = receiptFromRow(prior.result_json);
        return campaignCatalogConfigurationResultSchema.parse({ content: receipt.content, receipt });
      }
      const campaign = db.prepare("SELECT administration_revision,updated_at FROM campaigns WHERE id=?").get(campaignId) as { administration_revision: number; updated_at: string };
      if (campaign.administration_revision !== input.expectedRevision) throw new ContentCatalogStaleError();
      const existingSelection = db.prepare("SELECT 1 FROM campaign_catalog_current_selections WHERE campaign_id=?").get(campaignId);
      if (!existingSelection && db.prepare("SELECT 1 FROM campaign_rules_profiles WHERE campaign_id=?").get(campaignId)) throw new ContentCatalogConflictError("campaign already has legacy content configuration");
      const resolvedPacks: Array<{ packId: string; packVersion: string; digest: string }> = [];
      for (const pin of ordered) {
        const row = reads.publicationRow(pin.packId, pin.packVersion);
        if (!row || row.rules_profile_id !== input.rulesProfileId) throw new ContentCatalogConflictError(`incompatible or unavailable exact publication ${pin.packId}@${pin.packVersion}`);
        reads.validateStoredPublication(row);
        resolvedPacks.push({ packId: pin.packId, packVersion: pin.packVersion, digest: row.manifest_digest });
      }
      const selectionDigest = createHash("sha256").update(deps.canonicalCatalogJson({ rulesProfileId: input.rulesProfileId, contentPacks: ordered }), "utf8").digest("hex");
      const now = deps.clock.now(); const at = now.getTime() > new Date(campaign.updated_at).getTime() ? now.toISOString() : new Date(new Date(campaign.updated_at).getTime() + 1).toISOString();
      const content = campaignCatalogResolutionReportSchema.parse({ campaignId, compatible: true, rulesProfileId: input.rulesProfileId, contentPacks: resolvedPacks, issues: [] });
      const receipt = campaignCatalogReceiptSchema.parse({ campaignId, commandId: input.idempotencyKey, idempotencyKey: input.idempotencyKey, revisionBefore: input.expectedRevision, revisionAfter: input.expectedRevision + 1, configuredAt: at, content });
      const publicData = deps.canonicalCatalogJson({ content }); const resultJson = deps.canonicalCatalogJson(receipt);
      db.prepare("INSERT INTO campaign_catalog_commands (campaign_id,command_id,idempotency_key,actor_principal_id,expected_revision,request_digest,target_selection_digest,requested_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(campaignId, input.idempotencyKey, input.idempotencyKey, actor, input.expectedRevision, requestDigest, selectionDigest, canonicalRequested, at);
      db.prepare("INSERT INTO campaign_catalog_command_provenance_v18 (campaign_id,command_id,proposed_event_id,proposed_event_type,actor_principal_id,proposed_public_data,proposed_result_json) VALUES (?,?,?,'catalog_configured',?,?,?)").run(campaignId, input.idempotencyKey, input.idempotencyKey, actor, publicData, resultJson);
      if (db.prepare("UPDATE campaigns SET administration_revision=?,updated_at=? WHERE id=? AND administration_revision=?").run(input.expectedRevision + 1, at, campaignId, input.expectedRevision).changes !== 1) throw new ContentCatalogStaleError();
      if (existingSelection) { db.prepare("DELETE FROM campaign_catalog_current_selections WHERE campaign_id=?").run(campaignId); db.prepare("DELETE FROM campaign_content_packs WHERE campaign_id=?").run(campaignId); db.prepare("DELETE FROM campaign_rules_profiles WHERE campaign_id=?").run(campaignId); }
      db.prepare("INSERT INTO campaign_rules_profiles (campaign_id,rules_profile_id) VALUES (?,?)").run(campaignId, input.rulesProfileId);
      const insertLegacyPin = db.prepare("INSERT INTO campaign_content_packs (campaign_id,pack_id,pack_version,rules_profile_id) VALUES (?,?,?,?)"); for (const pin of ordered) insertLegacyPin.run(campaignId, pin.packId, pin.packVersion, input.rulesProfileId);
      db.prepare("INSERT INTO campaign_catalog_current_selections (campaign_id,rules_profile_id,selection_digest,configured_by_principal_id,configured_at,open_command_id) VALUES (?,?,?,?,?,?)").run(campaignId, input.rulesProfileId, selectionDigest, actor, at, input.idempotencyKey);
      const insertPin = db.prepare("INSERT INTO campaign_catalog_current_pins (campaign_id,pack_id,pack_version,position,open_command_id) VALUES (?,?,?,?,?)"); ordered.forEach((pin, position) => insertPin.run(campaignId, pin.packId, pin.packVersion, position, input.idempotencyKey));
      db.prepare("INSERT INTO campaign_catalog_events (campaign_id,command_id,event_id,revision_before,revision,occurred_at,public_data) VALUES (?,?,?,?,?,?,?)").run(campaignId, input.idempotencyKey, input.idempotencyKey, input.expectedRevision, input.expectedRevision + 1, at, publicData);
      db.prepare("INSERT INTO campaign_catalog_receipts (campaign_id,command_id,event_id,revision_before,revision_after,result_json) VALUES (?,?,?,?,?,?)").run(campaignId, input.idempotencyKey, input.idempotencyKey, input.expectedRevision, input.expectedRevision + 1, resultJson);
      return campaignCatalogConfigurationResultSchema.parse({ content, receipt });
    }).immediate();
  };
  return { publishContentCatalog, configureCampaignCatalog };
}
