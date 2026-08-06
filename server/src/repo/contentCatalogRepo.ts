import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  CONTENT_VALIDATION_LEVEL,
  VELVET_STARTER_RULES_ENGINE,
  campaignCatalogResolutionReportSchema,
  campaignCatalogConfigurationResultSchema,
  campaignCatalogReceiptSchema,
  catalogDefinitionKindSchema,
  catalogDefinitionReferenceSchema,
  catalogDefinitionSchema,
  catalogValidationReportSchema,
  configureCampaignCatalogInputSchema,
  contentPackIdSchema,
  contentPackVersionSchema,
  gmCatalogProjectionSchema,
  memberCatalogDefinitionSchema,
  observerCatalogProjectionSchema,
  observerCatalogDefinitionSchema,
  ownerCatalogProjectionSchema,
  playerCatalogProjectionSchema,
  publicationSummarySchema,
  publishContentCatalogInputSchema,
  resourceIdSchema,
  type CampaignCatalogResolutionReport,
  type CampaignCatalogConfigurationResult,
  type CampaignCatalogReceipt,
  type CatalogDefinition,
  type CatalogDefinitionKind,
  type CatalogDefinitionReference,
  type CatalogValidationIssue,
  type CatalogValidationReport,
  type ConfigureCampaignCatalogInput,
  type GmCatalogProjection,
  type ObserverCatalogProjection,
  type OwnerCatalogProjection,
  type PlayerCatalogProjection,
  type PublicationSummary,
  type PublishContentCatalogInput,
} from "@velvet/contracts";
import type { Clock } from "../runtime.js";

const KINDS = catalogDefinitionKindSchema.options;

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => binaryCompare(left, right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

export function canonicalCatalogJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function definitionKey(reference: CatalogDefinitionReference): string {
  return `${reference.kind}\0${reference.definitionId}`;
}

type CatalogByKind<Kind extends CatalogDefinitionKind> = Extract<CatalogDefinition, { reference: { kind: Kind } }>;
const asKind = <Kind extends CatalogDefinitionKind>(definition: CatalogDefinition, _kind: Kind) =>
  definition as CatalogByKind<Kind>;

function sortedDefinitions(definitions: readonly CatalogDefinition[]): CatalogDefinition[] {
  return [...definitions].sort((left, right) =>
    binaryCompare(left.reference.kind, right.reference.kind)
    || binaryCompare(left.reference.definitionId, right.reference.definitionId));
}

function dependencies(definition: CatalogDefinition): CatalogDefinitionReference[] {
  switch (definition.reference.kind) {
    case "race": return [...asKind(definition, "race").mechanics.abilityRefs];
    case "background": { const value = asKind(definition, "background"); return [...value.mechanics.skillRefs, ...value.mechanics.itemRefs, value.mechanics.startingCurrency.currency]; }
    case "class": return [...asKind(definition, "class").mechanics.levelRefs];
    case "class-level": { const value = asKind(definition, "class-level"); return [value.mechanics.classRef, ...value.mechanics.abilityRefs, ...value.mechanics.spellRefs,
      ...(value.mechanics.progressionChoices ?? []).flatMap((choice) => choice.options)]; }
    case "item": return [asKind(definition, "item").mechanics.price.currency];
    case "enemy-template": { const value = asKind(definition, "enemy-template"); return [...value.mechanics.abilityRefs, ...value.private.hiddenAbilityRefs, ...(value.private.hiddenRefs ?? [])]; }
    case "skill": case "ability": case "spell": case "currency": return [];
  }
}

function publicDependencies(definition: CatalogDefinition): CatalogDefinitionReference[] {
  if (definition.reference.kind !== "enemy-template") return dependencies(definition);
  return [...asKind(definition, "enemy-template").mechanics.abilityRefs];
}

function privateDependencies(definition: CatalogDefinition): CatalogDefinitionReference[] {
  return definition.reference.kind === "enemy-template"
    ? [...asKind(definition, "enemy-template").private.hiddenAbilityRefs,
      ...(asKind(definition, "enemy-template").private.hiddenRefs ?? [])]
    : [];
}

function publiclyReachableKeys(definitions: readonly CatalogDefinition[]): Set<string> {
  const keys = new Set(definitions.map((definition) => definitionKey(definition.reference)));
  const publicEdges = new Map<string,string[]>(), allEdges = new Map<string,string[]>(), incoming = new Map<string,number>();
  const directPrivate = new Set<string>();
  for (const definition of definitions) {
    const key=definitionKey(definition.reference);
    const pub=publicDependencies(definition).map(definitionKey).filter((child)=>keys.has(child));
    const priv=privateDependencies(definition).map(definitionKey).filter((child)=>keys.has(child));
    publicEdges.set(key,pub); allEdges.set(key,[...pub,...priv]);
    for (const child of pub) incoming.set(child,(incoming.get(child) ?? 0)+1);
    for (const child of priv) directPrivate.add(child);
  }
  const privateClosure=new Set<string>(), pendingPrivate=[...directPrivate];
  while(pendingPrivate.length){const key=pendingPrivate.shift()!;if(privateClosure.has(key))continue;privateClosure.add(key);pendingPrivate.push(...(allEdges.get(key)??[]));}
  const roots=definitions.filter((definition)=>{const key=definitionKey(definition.reference);return !privateClosure.has(key)
    && (["race","background","class","enemy-template"].includes(definition.reference.kind)||(incoming.get(key)??0)===0);})
    .map((definition)=>definitionKey(definition.reference));
  const reachable=new Set<string>();
  while(roots.length){const key=roots.shift()!;if(reachable.has(key))continue;reachable.add(key);roots.push(...(publicEdges.get(key)??[]));}
  return reachable;
}

function digestInput(input: PublishContentCatalogInput): string {
  const stripIdentity = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripIdentity);
    if (value !== null && typeof value === "object") return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "digest" && key !== "packVersion" && key !== "idempotencyKey")
        .map(([key, child]) => [key, stripIdentity(child)]),
    );
    return value;
  };
  return canonicalCatalogJson(stripIdentity({ manifest: input.manifest, definitions: sortedDefinitions(input.definitions) }));
}

export function calculateCatalogDigest(input: PublishContentCatalogInput): string {
  return createHash("sha256").update(digestInput(input), "utf8").digest("hex");
}

function issueSort(left: CatalogValidationIssue, right: CatalogValidationIssue): number {
  return binaryCompare(left.path, right.path)
    || binaryCompare(left.code, right.code)
    || binaryCompare(left.message, right.message)
    || binaryCompare(left.reference ? definitionKey(left.reference) : "", right.reference ? definitionKey(right.reference) : "");
}

/** Pure, deterministic validation: no database, clock, IDs, files, or network. */
export function validateContentCatalog(input: unknown): CatalogValidationReport {
  const parsed = publishContentCatalogInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues: CatalogValidationIssue[] = parsed.error.issues.map((entry) => ({
      code: "invalid-input" as const,
      path: entry.path.length ? entry.path.join(".") : "$",
      message: entry.message,
    })).sort(issueSort);
    return catalogValidationReportSchema.parse({
      valid: false,
      issues,
      normalizedSummary: { totalDefinitions: 0, counts: KINDS.map((kind) => ({ kind, count: 0 })), digest: null },
    });
  }

  const normalized = parsed.data;
  const issues: CatalogValidationIssue[] = [];
  const counts = new Map<CatalogDefinitionKind, number>(KINDS.map((kind) => [kind, 0]));
  const identities = new Map<string, CatalogDefinition>();
  normalized.definitions.forEach((definition, index) => {
    const reference = definition.reference;
    counts.set(reference.kind, (counts.get(reference.kind) ?? 0) + 1);
    if (reference.packId !== normalized.manifest.packId || reference.packVersion !== normalized.manifest.packVersion) {
      issues.push({ code: "identity-mismatch", path: `definitions.${index}.reference`, message: "definition reference must use the manifest's exact pack ID and version", reference });
    }
    const key = definitionKey(reference);
    if (identities.has(key)) issues.push({ code: "duplicate-definition", path: `definitions.${index}.reference`, message: `duplicate definition ${reference.kind}:${reference.definitionId}`, reference });
    else identities.set(key, definition);
  });

  for (const kind of KINDS) {
    if ((counts.get(kind) ?? 0) === 0) issues.push({ code: "incomplete-starter", path: `definitions.${kind}`, message: `validated-v1 requires at least one ${kind} definition` });
  }

  normalized.definitions.forEach((definition) => {
    for (const reference of dependencies(definition)) {
      const path = `definitions.${definition.reference.kind}:${definition.reference.definitionId}.references.${reference.kind}:${reference.definitionId}`;
      if (reference.packId !== normalized.manifest.packId || reference.packVersion !== normalized.manifest.packVersion) {
        issues.push({ code: "identity-mismatch", path, message: "dependencies must resolve within this exact immutable publication", reference });
      } else if (!identities.has(definitionKey(reference))) {
        issues.push({ code: "missing-reference", path, message: `missing exact reference ${reference.kind}:${reference.definitionId}`, reference });
      }
    }
  });

  // Class-level identity, ownership, and complete monotonic progression are
  // cross-record invariants. Every level belongs to exactly one class.
  const levelReferenceCounts = new Map<string, number>();
  for (const definition of normalized.definitions) {
    if (definition.reference.kind !== "class") continue;
    const classDefinition = asKind(definition, "class");
    const levels = classDefinition.mechanics.levelRefs.map((reference) => identities.get(definitionKey(reference)))
      .filter((entry): entry is CatalogByKind<"class-level"> => entry?.reference.kind === "class-level")
      .map((entry) => asKind(entry, "class-level"));
    const seenLevels = new Set<number>();
    const progressionChoiceIds = new Set<string>();
    for (const level of levels) {
      if (definitionKey(level.mechanics.classRef) !== definitionKey(classDefinition.reference)) {
        issues.push({ code: "wrong-reference-kind", path: `definitions.class:${definition.reference.definitionId}.levels.${level.reference.definitionId}`, message: "class level must refer back to its owning class", reference: level.reference });
      }
      const levelKey = definitionKey(level.reference);
      levelReferenceCounts.set(levelKey, (levelReferenceCounts.get(levelKey) ?? 0) + 1);
      if (seenLevels.has(level.mechanics.level)) issues.push({ code: "duplicate-definition", path: `definitions.class:${definition.reference.definitionId}.level.${level.mechanics.level}`, message: "class progression levels must be unique", reference: level.reference });
      seenLevels.add(level.mechanics.level);
      for (const choice of level.mechanics.progressionChoices ?? []) {
        if (progressionChoiceIds.has(choice.choiceId)) issues.push({ code: "duplicate-definition",
          path: `definitions.class:${definition.reference.definitionId}.choice.${choice.choiceId}`,
          message: "progression choice IDs must be unique across the selected class progression", reference: level.reference });
        progressionChoiceIds.add(choice.choiceId);
        const optionKeys = choice.options.map(definitionKey);
        if (new Set(optionKeys).size !== optionKeys.length) issues.push({ code: "duplicate-definition",
          path: `definitions.class-level:${level.reference.definitionId}.choice.${choice.choiceId}.options`,
          message: "progression choice options must be unique", reference: level.reference });
      }
    }
    if (!seenLevels.has(1)) issues.push({ code: "incomplete-starter", path: `definitions.class:${definition.reference.definitionId}.level.1`, message: "each class requires an exact level 1 definition", reference: definition.reference });
    const orderedLevels = [...seenLevels].sort((left, right) => left - right);
    orderedLevels.forEach((level, index) => {
      if (level !== index + 1) issues.push({ code: "incomplete-starter", path: `definitions.class:${definition.reference.definitionId}.level.${index + 1}`, message: "class progression levels must be contiguous from level 1", reference: definition.reference });
    });
  }
  for (const definition of normalized.definitions) {
    if (definition.reference.kind !== "class-level") continue;
    const level = asKind(definition, "class-level");
    const count = levelReferenceCounts.get(definitionKey(level.reference)) ?? 0;
    const owner = identities.get(definitionKey(level.mechanics.classRef));
    if (owner?.reference.kind !== "class") {
      issues.push({ code: "wrong-reference-kind", path: `definitions.class-level:${level.reference.definitionId}.classRef`, message: "class level must have an existing class owner", reference: level.mechanics.classRef });
    }
    if (count !== 1) issues.push({ code: count === 0 ? "missing-reference" : "duplicate-definition", path: `definitions.class-level:${level.reference.definitionId}.owner`, message: "class level must be referenced exactly once by its owning class", reference: level.reference });
  }

  // Detect dependency cycles. A valid class-level -> owning-class edge is the
  // sole structural back-reference and is not an execution dependency.
  const graph = new Map<string, string[]>();
  for (const definition of normalized.definitions) {
    const refs = dependencies(definition).filter((reference) => {
      if (definition.reference.kind !== "class-level" || reference.kind !== "class") return true;
      const owner = identities.get(definitionKey(reference));
      return owner?.reference.kind !== "class"
        || !asKind(owner, "class").mechanics.levelRefs.some((levelRef) => definitionKey(levelRef) === definitionKey(definition.reference));
    });
    graph.set(definitionKey(definition.reference), refs.map(definitionKey).filter((key) => identities.has(key)).sort(binaryCompare));
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const reportedCycles = new Set<string>();
  const visit = (key: string, stack: string[]): void => {
    if (visiting.has(key)) {
      const start = stack.indexOf(key);
      const cycle = [...stack.slice(start), key].join(" -> ");
      if (!reportedCycles.has(cycle)) {
        reportedCycles.add(cycle);
        issues.push({ code: "dependency-cycle", path: `definitions.${key.replace("\0", ":")}.dependencies`, message: `catalog dependency cycle: ${cycle.replaceAll("\0", ":")}` });
      }
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const child of graph.get(key) ?? []) visit(child, [...stack, key]);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of [...graph.keys()].sort(binaryCompare)) visit(key, []);

  const digest = calculateCatalogDigest(normalized);
  if (normalized.manifest.digest !== digest) issues.push({ code: "digest-mismatch", path: "manifest.digest", message: `manifest digest must equal canonical SHA-256 ${digest}` });
  if (!normalized.manifest.packVersion.endsWith(`+${digest.slice(0, 12)}`)) {
    issues.push({ code: "digest-mismatch", path: "manifest.packVersion", message: "pack version must end with the first 12 canonical digest characters" });
  }

  issues.sort(issueSort);
  return catalogValidationReportSchema.parse({
    valid: issues.length === 0,
    issues,
    normalizedSummary: { totalDefinitions: normalized.definitions.length, counts: KINDS.map((kind) => ({ kind, count: counts.get(kind) ?? 0 })), digest },
  });
}

export class ContentCatalogValidationError extends Error {
  readonly code = "CONTENT_CATALOG_INVALID";
  constructor(readonly report: CatalogValidationReport) { super("content catalog validation failed"); this.name = "ContentCatalogValidationError"; }
}
export class ContentCatalogAuthorizationError extends Error {
  readonly code = "CONTENT_CATALOG_FORBIDDEN";
  constructor(message = "content catalog publication requires the application owner") { super(message); this.name = "ContentCatalogAuthorizationError"; }
}
export class ContentCatalogConflictError extends Error {
  readonly code = "CONTENT_CATALOG_CONFLICT";
  constructor(message: string) { super(message); this.name = "ContentCatalogConflictError"; }
}
export class ContentCatalogStaleError extends Error {
  readonly code = "CONTENT_CATALOG_STALE";
  constructor() { super("campaign catalog revision is stale"); this.name = "ContentCatalogStaleError"; }
}

export interface ContentCatalogPublicationPageInput {
  status: "validated";
  cursor?: string;
  limit?: number;
}

export interface ContentCatalogPublicationPage {
  publications: PublicationSummary[];
  nextCursor: string | null;
}

export interface ContentCatalogRepository {
  validateContentCatalog(input: unknown): CatalogValidationReport;
  publishContentCatalog(actorPrincipalId: string, input: unknown): OwnerCatalogProjection;
  listContentCatalogPublications(actorPrincipalId: string): PublicationSummary[];
  listContentCatalogPublicationPage(actorPrincipalId: string, input: ContentCatalogPublicationPageInput): ContentCatalogPublicationPage;
  getContentCatalogForOwner(actorPrincipalId: string, packId: string, packVersion: string): OwnerCatalogProjection | null;
  getCampaignContentCatalog(actorPrincipalId: string, campaignId: string, packId: string, packVersion: string): GmCatalogProjection | PlayerCatalogProjection | ObserverCatalogProjection | null;
  configureCampaignCatalog(actorPrincipalId: string, campaignId: string, input: ConfigureCampaignCatalogInput): CampaignCatalogConfigurationResult;
  resolveCampaignCatalog(actorPrincipalId: string, campaignId: string): CampaignCatalogResolutionReport | null;
  getCampaignCatalogReceipt(actorPrincipalId: string, campaignId: string, commandId: string): CampaignCatalogReceipt | null;
}

interface PublicationRow {
  pack_id: string; pack_version: string; name: string; description: string; tags: string;
  rules_profile_id: string; manifest_digest: string; manifest_json: string; provenance_json: string;
  validation_report_json: string; published_at: string;
  definition_count: number; definition_counts_json: string;
  publication_digest: string; public_projection_digest: string; public_projection_count: number;
}

function isApplicationOwner(db: DatabaseDriver.Database, actor: string): boolean {
  return !!db.prepare(`SELECT 1 FROM application_owner owner JOIN principals principal ON principal.id=owner.principal_id
    WHERE owner.singleton=1 AND owner.principal_id=?`).get(actor);
}

function summary(row: PublicationRow): PublicationSummary {
  const manifest = publishContentCatalogInputSchema.shape.manifest.parse(JSON.parse(row.manifest_json));
  if (manifest.packId !== row.pack_id || manifest.packVersion !== row.pack_version
    || manifest.compatibility.rulesProfileId !== row.rules_profile_id || manifest.digest !== row.manifest_digest
    || manifest.name !== row.name || manifest.description !== row.description
    || JSON.stringify(manifest.tags) !== row.tags) {
    throw new Error("persisted content publication manifest is inconsistent");
  }
  const report = catalogValidationReportSchema.parse(JSON.parse(row.validation_report_json));
  if (!report.valid || report.issues.length !== 0 || report.normalizedSummary.digest !== row.manifest_digest
    || report.normalizedSummary.totalDefinitions !== row.definition_count
    || canonicalCatalogJson(report.normalizedSummary.counts) !== canonicalCatalogJson(JSON.parse(row.definition_counts_json))) {
    throw new Error("persisted content publication report is inconsistent");
  }
  return publicationSummarySchema.parse({
    packId: row.pack_id, packVersion: row.pack_version, name: row.name, description: row.description,
    tags: JSON.parse(row.tags), compatibility: manifest.compatibility, digest: row.manifest_digest,
    validationLevel: CONTENT_VALIDATION_LEVEL, publishedAt: row.published_at,
  });
}

const PUBLICATION_SELECT = `SELECT pack.pack_id,pack.pack_version,pack.rules_profile_id,pack.name,pack.description,pack.tags,
  publication.manifest_digest,publication.manifest_json,publication.provenance_json,
  publication.validation_report_json,publication.published_at,
  attestation.definition_count,attestation.definition_counts_json,attestation.publication_digest,
  attestation.public_projection_digest,attestation.public_projection_count
  FROM rpg_content_packs pack JOIN rpg_content_pack_publications publication
    ON publication.pack_id=pack.pack_id AND publication.pack_version=pack.pack_version
  JOIN rpg_catalog_publication_attestations attestation
    ON attestation.pack_id=publication.pack_id AND attestation.pack_version=publication.pack_version
  WHERE publication.validation_level='validated-v1'`;

const MAX_PUBLICATION_PAGE_SIZE = 100;

function encodePublicationCursor(packId: string, packVersion: string): string {
  return Buffer.from(JSON.stringify([packId, packVersion]), "utf8").toString("base64url");
}

function decodePublicationCursor(cursor: string): [string, string] {
  try {
    if (cursor.length === 0 || cursor.length > 512) throw new Error("invalid cursor");
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== cursor) throw new Error("invalid cursor");
    const value: unknown = JSON.parse(decoded);
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "string" || typeof value[1] !== "string") {
      throw new Error("invalid cursor");
    }
    return [contentPackIdSchema.parse(value[0]), contentPackVersionSchema.parse(value[1])];
  } catch {
    throw new Error("invalid content catalog publication cursor");
  }
}

function parsePublicationPageInput(input: ContentCatalogPublicationPageInput): { cursor: [string, string] | null; limit: number } {
  if (input === null || typeof input !== "object" || Array.isArray(input)
    || input.status !== "validated"
    || (input.cursor !== undefined && typeof input.cursor !== "string")
    || (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isInteger(input.limit)
      || input.limit < 1 || input.limit > MAX_PUBLICATION_PAGE_SIZE))) {
    throw new Error("invalid content catalog publication page input");
  }
  return { cursor: input.cursor === undefined ? null : decodePublicationCursor(input.cursor), limit: input.limit ?? 25 };
}

function readDefinitions(db: DatabaseDriver.Database, packId: string, packVersion: string): CatalogDefinition[] {
  return (db.prepare(`SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=?
    ORDER BY kind COLLATE BINARY,definition_id COLLATE BINARY`).all(packId, packVersion) as Array<{ definition_json: string }>)
    .map((row) => catalogDefinitionSchema.parse(JSON.parse(row.definition_json)));
}

export interface PersistedCatalogVisibilityRow {
  kind: CatalogDefinitionKind; definition_id: string; public_definition_json: string;
  public_dependencies_json: string; private_dependencies_json: string; row_digest: string; publicly_reachable: number;
}

/** Pure verifier used by modern and legacy role projections. */
export function verifyCatalogVisibilityProjection(input:{packId:string;packVersion:string;expectedCount:number;
  publicationDigest:string;manifestDigest:string;aggregateDigest:string;rows:PersistedCatalogVisibilityRow[]}):unknown[]{
  const {packId,packVersion,expectedCount,rows}=input;
  const keys = new Set(rows.map((row) => `${row.kind}\0${row.definition_id}`));
  if (rows.length !== expectedCount || keys.size !== expectedCount) throw new Error("persisted public catalog definition count is inconsistent");
  const attestations: unknown[] = [];
  for (const row of rows) {
    const publicRefs = JSON.parse(row.public_dependencies_json) as unknown[];
    const privateRefs = JSON.parse(row.private_dependencies_json) as unknown[];
    const parsedPublic = publicRefs.map((reference) => catalogDefinitionReferenceSchema.parse(reference));
    const parsedPrivate = privateRefs.map((reference) => catalogDefinitionReferenceSchema.parse(reference));
    for (const reference of [...parsedPublic, ...parsedPrivate]) {
      if (reference.packId !== packId || reference.packVersion !== packVersion || !keys.has(definitionKey(reference)))
        throw new Error("persisted public catalog dependency is inconsistent");
    }
    const expectedRowDigest = createHash("sha256").update(canonicalCatalogJson({
      definition: JSON.parse(row.public_definition_json), publicDependencies: parsedPublic, privateDependencies: parsedPrivate,
    })).digest("hex");
    if (row.row_digest !== expectedRowDigest) throw new Error("persisted public catalog row attestation is inconsistent");
    attestations.push({ kind: row.kind, definitionId: row.definition_id, rowDigest: row.row_digest,
      publiclyReachable: row.publicly_reachable === 1 });
  }
  const aggregateDigest = createHash("sha256").update(canonicalCatalogJson(attestations)).digest("hex");
  if (aggregateDigest !== input.aggregateDigest || input.publicationDigest !== input.manifestDigest)
    throw new Error("persisted public catalog projection attestation is inconsistent");
  return rows.filter((row) => row.publicly_reachable === 1).map((row) => {
    const definition = memberCatalogDefinitionSchema.parse(JSON.parse(row.public_definition_json));
    if (definition.reference.kind !== row.kind || definition.reference.definitionId !== row.definition_id
      || definition.reference.packId !== packId || definition.reference.packVersion !== packVersion)
      throw new Error("persisted public catalog definition identity is inconsistent");
    return definition;
  });
}

function readPublicDefinitions(db: DatabaseDriver.Database, packId: string, packVersion: string, expectedCount: number): unknown[] {
  const rows = db.prepare(`SELECT kind,definition_id,public_definition_json,public_dependencies_json,private_dependencies_json,row_digest
    ,publicly_reachable FROM rpg_catalog_definition_visibility WHERE pack_id=? AND pack_version=?
    ORDER BY kind COLLATE BINARY,definition_id COLLATE BINARY`).all(packId, packVersion) as PersistedCatalogVisibilityRow[];
  const publication=publicationRow(db,packId,packVersion);
  if(!publication)throw new Error("validated content publication attestation is missing");
  return verifyCatalogVisibilityProjection({packId,packVersion,expectedCount,rows,publicationDigest:publication.publication_digest,
    manifestDigest:publication.manifest_digest,aggregateDigest:publication.public_projection_digest});
}

/**
 * Verifies every persisted visibility row and the aggregate publication
 * attestation before returning the role-safe legacy definition identities.
 * Callers must never use `publicly_reachable` directly.
 */
export function readVerifiedPublicDefinitionKeys(
  db: DatabaseDriver.Database,
  packId: string,
  packVersion: string,
): Set<string> {
  const row = publicationRow(db, packId, packVersion);
  if (!row) throw new Error("validated content publication attestation is missing");
  summary(row);
  return new Set(readPublicDefinitions(db, packId, packVersion, row.definition_count).map((definition) => {
    const parsed = memberCatalogDefinitionSchema.parse(definition);
    const kind = parsed.reference.kind === "enemy-template" ? "enemy" : parsed.reference.kind;
    return `${kind}\0${parsed.reference.definitionId}`;
  }));
}

function observerDefinition(definition: unknown): unknown {
  const parsed = memberCatalogDefinitionSchema.parse(definition);
  return observerCatalogDefinitionSchema.parse({ reference: parsed.reference, name: parsed.name,
    description: parsed.description, tags: parsed.tags });
}

function ownerProjection(db: DatabaseDriver.Database, row: PublicationRow): OwnerCatalogProjection {
  const validated = validateStoredPublication(db, row);
  return ownerCatalogProjectionSchema.parse({ publication: summary(row), provenance: validated.manifest.provenance, definitions: validated.definitions });
}

function publicationRow(db: DatabaseDriver.Database, packId: string, packVersion: string): PublicationRow | undefined {
  return db.prepare(`${PUBLICATION_SELECT} AND pack.pack_id=? AND pack.pack_version=?`).get(packId, packVersion) as PublicationRow | undefined;
}

function legacyKind(kind: CatalogDefinitionKind): "race" | "background" | "class" | "item" | "spell" | "ability" | "enemy" | null {
  if (kind === "enemy-template") return "enemy";
  return kind === "race" || kind === "background" || kind === "class" || kind === "item" || kind === "spell" || kind === "ability"
    ? kind : null;
}

function validateStoredPublication(db: DatabaseDriver.Database, row: PublicationRow): PublishContentCatalogInput {
  const manifest = publishContentCatalogInputSchema.shape.manifest.parse(JSON.parse(row.manifest_json));
  const definitions = readDefinitions(db, row.pack_id, row.pack_version);
  const input = publishContentCatalogInputSchema.parse({ idempotencyKey: "stored-publication-validation", manifest, definitions });
  const report = validateContentCatalog(input);
  const storedReport = catalogValidationReportSchema.parse(JSON.parse(row.validation_report_json));
  if (!report.valid || report.normalizedSummary.digest !== row.manifest_digest
    || row.definition_count !== definitions.length
    || canonicalCatalogJson(report) !== canonicalCatalogJson(storedReport)
    || canonicalCatalogJson(report.normalizedSummary.counts) !== canonicalCatalogJson(JSON.parse(row.definition_counts_json))) {
    throw new Error("persisted content publication validation is inconsistent");
  }
  summary(row);
  const profile = db.prepare("SELECT name,description,tags FROM rpg_rules_profiles WHERE rules_profile_id=?")
    .get(row.rules_profile_id) as { name: string; description: string; tags: string } | undefined;
  if (!profile || profile.name !== manifest.rulesProfile.name || profile.description !== manifest.rulesProfile.description
    || profile.tags !== JSON.stringify(manifest.rulesProfile.tags)) {
    throw new Error("persisted content publication rules profile is inconsistent");
  }
  const legacyRows = db.prepare(`SELECT kind,definition_id,name,description,tags FROM rpg_definitions
    WHERE pack_id=? AND pack_version=? ORDER BY kind COLLATE BINARY,definition_id COLLATE BINARY`)
    .all(row.pack_id, row.pack_version) as Array<{ kind: string; definition_id: string; name: string; description: string; tags: string }>;
  const expectedLegacy = definitions.flatMap((definition) => {
    const kind = legacyKind(definition.reference.kind);
    return kind ? [{ kind, definition_id: definition.reference.definitionId, name: definition.name,
      description: definition.description, tags: JSON.stringify(definition.tags) }] : [];
  }).sort((left, right) => binaryCompare(left.kind, right.kind) || binaryCompare(left.definition_id, right.definition_id));
  if (canonicalCatalogJson(legacyRows) !== canonicalCatalogJson(expectedLegacy)) {
    throw new Error("persisted content publication legacy definitions are inconsistent");
  }
  return input;
}

function publicDefinition(definition: CatalogDefinition): unknown {
  if (definition.reference.kind !== "enemy-template") return definition;
  const { private: _private, ...safe } = asKind(definition, "enemy-template");
  return safe;
}

export interface DerivedCatalogVisibilityRow {
  definition: CatalogDefinition;
  publicDefinitionJson: string;
  publicDependenciesJson: string;
  privateDependenciesJson: string;
  rowDigest: string;
  publiclyReachable: boolean;
}

/** Pure canonical visibility derivation shared by publication and migration. */
export function deriveCatalogVisibility(definitions: readonly unknown[]): {
  rows: DerivedCatalogVisibilityRow[];
  aggregateDigest: string;
} {
  const ordered=sortedDefinitions(definitions.map((definition)=>catalogDefinitionSchema.parse(definition)));
  const reachable=publiclyReachableKeys(ordered);
  const rows=ordered.map((definition)=>{
    const publicDefinitionJson=canonicalCatalogJson(publicDefinition(definition));
    const publicRefs=publicDependencies(definition),privateRefs=privateDependencies(definition);
    const rowDigest=createHash("sha256").update(canonicalCatalogJson({definition:JSON.parse(publicDefinitionJson),
      publicDependencies:publicRefs,privateDependencies:privateRefs})).digest("hex");
    return {definition,publicDefinitionJson,publicDependenciesJson:canonicalCatalogJson(publicRefs),
      privateDependenciesJson:canonicalCatalogJson(privateRefs),rowDigest,
      publiclyReachable:reachable.has(definitionKey(definition.reference))};
  });
  const aggregateDigest=createHash("sha256").update(canonicalCatalogJson(rows.map((row)=>({
    kind:row.definition.reference.kind,definitionId:row.definition.reference.definitionId,rowDigest:row.rowDigest,
    publiclyReachable:row.publiclyReachable,
  })))).digest("hex");
  return {rows,aggregateDigest};
}

function ensureProfile(db: DatabaseDriver.Database, input: PublishContentCatalogInput): void {
  const id = input.manifest.compatibility.rulesProfileId;
  const existing = db.prepare("SELECT name,description,tags FROM rpg_rules_profiles WHERE rules_profile_id=?").get(id) as { name: string; description: string; tags: string } | undefined;
  const expected = input.manifest.rulesProfile;
  if (existing) {
    if (existing.name !== expected.name || existing.description !== expected.description || existing.tags !== JSON.stringify(expected.tags)) {
      throw new ContentCatalogConflictError("rules profile metadata conflicts with the exact installed profile");
    }
    return;
  }
  db.prepare("INSERT INTO rpg_rules_profiles (rules_profile_id,name,description,tags) VALUES (?,?,?,?)")
    .run(id, expected.name, expected.description, JSON.stringify(expected.tags));
}

function publish(db: DatabaseDriver.Database, clock: Clock, actor: string, unknownInput: unknown): OwnerCatalogProjection {
  if (!isApplicationOwner(db, actor)) throw new ContentCatalogAuthorizationError();
  const report = validateContentCatalog(unknownInput);
  const parsed = publishContentCatalogInputSchema.safeParse(unknownInput);
  if (!report.valid) {
    if (parsed.success && db.prepare("SELECT 1 FROM rpg_content_packs WHERE pack_id=? AND pack_version=?")
      .get(parsed.data.manifest.packId, parsed.data.manifest.packVersion)) {
      throw new ContentCatalogConflictError("a differing content catalog already uses this exact pack version");
    }
    throw new ContentCatalogValidationError(report);
  }
  const input = parsed.success ? parsed.data : publishContentCatalogInputSchema.parse(unknownInput);
  const requestDigest = createHash("sha256").update(canonicalCatalogJson(input)).digest("hex");
  return db.transaction(() => {
    if (!isApplicationOwner(db, actor)) throw new ContentCatalogAuthorizationError();
    const prior = db.prepare(`SELECT request_digest,pack_id,pack_version FROM rpg_catalog_publication_submissions
      WHERE principal_id=? AND idempotency_key=?`).get(actor,input.idempotencyKey) as {
        request_digest:string;pack_id:string;pack_version:string;
      } | undefined;
    if (prior) {
      if (prior.request_digest!==requestDigest) throw new ContentCatalogConflictError("publication idempotency key conflicts with a different payload");
      const row=publicationRow(db,prior.pack_id,prior.pack_version);
      if(!row) throw new Error("publication submission receipt is incomplete");
      return ownerProjection(db,row);
    }
    const collision = db.prepare("SELECT sealed FROM rpg_content_packs WHERE pack_id=? AND pack_version=?")
      .get(input.manifest.packId, input.manifest.packVersion) as { sealed: number } | undefined;
    if (collision) {
      throw new ContentCatalogConflictError("a differing content catalog already uses this exact pack version");
    }
    ensureProfile(db, input);
    db.prepare(`INSERT INTO rpg_content_packs (pack_id,pack_version,rules_profile_id,name,description,tags,sealed)
      VALUES (?,?,?,?,?,?,0)`).run(input.manifest.packId, input.manifest.packVersion,
      input.manifest.compatibility.rulesProfileId, input.manifest.name, input.manifest.description, JSON.stringify(input.manifest.tags));
    const insert = db.prepare(`INSERT INTO rpg_catalog_definitions
      (pack_id,pack_version,kind,definition_id,definition_json,public_definition_json,dependencies_json)
      VALUES (?,?,?,?,?,?,?)`);
    const insertVisibility=db.prepare(`INSERT INTO rpg_catalog_definition_visibility
      (pack_id,pack_version,kind,definition_id,public_definition_json,public_dependencies_json,private_dependencies_json,row_digest,publicly_reachable)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const insertLegacy = db.prepare(`INSERT INTO rpg_definitions
      (pack_id,pack_version,kind,definition_id,name,description,tags) VALUES (?,?,?,?,?,?,?)`);
    const visibility=deriveCatalogVisibility(input.definitions);
    for (const derived of visibility.rows) {
      const definition=derived.definition;
      insert.run(input.manifest.packId, input.manifest.packVersion, definition.reference.kind,
        definition.reference.definitionId, canonicalCatalogJson(definition), derived.publicDefinitionJson, canonicalCatalogJson(dependencies(definition)));
      insertVisibility.run(input.manifest.packId,input.manifest.packVersion,definition.reference.kind,definition.reference.definitionId,
        derived.publicDefinitionJson,derived.publicDependenciesJson,derived.privateDependenciesJson,derived.rowDigest,
        derived.publiclyReachable?1:0);
      const compatibleKind = legacyKind(definition.reference.kind);
      if (compatibleKind) insertLegacy.run(input.manifest.packId, input.manifest.packVersion, compatibleKind,
        definition.reference.definitionId, definition.name, definition.description, JSON.stringify(definition.tags));
    }
    // Complete validation and all definition inserts precede the sole seal.
    // The subsequent publication row and seal commit atomically with them.
    db.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id=? AND pack_version=? AND sealed=0")
      .run(input.manifest.packId, input.manifest.packVersion);
    const publishedAt = clock.now().toISOString();
    db.prepare(`INSERT INTO rpg_content_pack_publications
      (pack_id,pack_version,validation_level,rules_engine,manifest_digest,manifest_json,provenance_json,
       validation_report_json,published_by_principal_id,published_at)
       VALUES (?,?, 'validated-v1',?,?,?,?,?,?,?)`)
      .run(input.manifest.packId, input.manifest.packVersion, VELVET_STARTER_RULES_ENGINE, input.manifest.digest,
        canonicalCatalogJson(input.manifest), canonicalCatalogJson(input.manifest.provenance), canonicalCatalogJson(report),actor,publishedAt);
    db.prepare(`INSERT INTO rpg_catalog_publication_attestations VALUES (?,?,?,?,?,?,?)`).run(input.manifest.packId,
      input.manifest.packVersion,input.definitions.length,canonicalCatalogJson(report.normalizedSummary.counts),input.manifest.digest,
      visibility.aggregateDigest,input.definitions.length);
    db.prepare(`INSERT INTO rpg_catalog_publication_submissions VALUES (?,?,?,?,?,?,?)`).run(actor,input.idempotencyKey,
      requestDigest,input.manifest.packId,input.manifest.packVersion,
      canonicalCatalogJson({packId:input.manifest.packId,packVersion:input.manifest.packVersion}),publishedAt);
    return ownerProjection(db, publicationRow(db, input.manifest.packId, input.manifest.packVersion)!);
  }).immediate();
}

function campaignAuthority(db: DatabaseDriver.Database, actor: string, campaignId: string): "owner" | "gm" | "player" | "observer" | null {
  const row = db.prepare(`SELECT membership.role,campaign.owner_principal_id,campaign.owner_role,
      (SELECT COUNT(*) FROM campaign_memberships owner_membership WHERE owner_membership.campaign_id=campaign.id
        AND owner_membership.role='owner') owner_count,
      (SELECT COUNT(*) FROM campaign_memberships owner_membership JOIN principals owner_principal
        ON owner_principal.id=owner_membership.principal_id WHERE owner_membership.campaign_id=campaign.id
        AND owner_membership.role='owner' AND owner_membership.principal_id=campaign.owner_principal_id) canonical_owner_count
    FROM campaigns campaign
    JOIN campaign_memberships membership ON membership.campaign_id=campaign.id AND membership.principal_id=?
    JOIN principals principal ON principal.id=membership.principal_id
    WHERE campaign.id=? AND membership.role IN ('owner','gm','player','observer')`).get(actor, campaignId) as {
      role: "owner" | "gm" | "player" | "observer"; owner_principal_id: string; owner_role: string;
      owner_count: number; canonical_owner_count: number;
    } | undefined;
  if (!row) return null;
  if (row.owner_role !== "owner" || row.owner_count !== 1 || row.canonical_owner_count !== 1
    || (row.role === "owner" && row.owner_principal_id !== actor)) {
    throw new Error("malformed campaign ownership");
  }
  return row.role;
}

function resolve(db: DatabaseDriver.Database, actor: string, campaignIdValue: string): CampaignCatalogResolutionReport | null {
  const campaignId = resourceIdSchema.parse(campaignIdValue);
  if (!campaignAuthority(db, actor, campaignId)) return null;
  if (db.prepare(`SELECT 1 FROM campaign_catalog_commands command LEFT JOIN campaign_catalog_receipts receipt
    ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
    WHERE command.campaign_id=? AND receipt.command_id IS NULL LIMIT 1`).get(campaignId)) {
    throw new Error("campaign catalog audit is incomplete");
  }
  const selection = db.prepare(`SELECT rules_profile_id,selection_digest,configured_by_principal_id,configured_at
    FROM campaign_catalog_current_selections WHERE campaign_id=?`)
    .get(campaignId) as { rules_profile_id: string; selection_digest: string;
      configured_by_principal_id: string; configured_at: string } | undefined;
  if (!selection) return null;
  const packs = db.prepare(`SELECT pin.pack_id,pin.pack_version,publication.manifest_digest
    FROM campaign_catalog_current_pins pin JOIN rpg_content_pack_publications publication
      ON publication.pack_id=pin.pack_id AND publication.pack_version=pin.pack_version
    WHERE pin.campaign_id=? ORDER BY pin.pack_id COLLATE BINARY,pin.pack_version COLLATE BINARY`).all(campaignId) as Array<{ pack_id: string; pack_version: string; manifest_digest: string }>;
  if (packs.length === 0) throw new Error("persisted campaign catalog is incomplete");
  resourceIdSchema.parse(selection.configured_by_principal_id);
  if (!Number.isFinite(new Date(selection.configured_at).getTime())) throw new Error("persisted campaign catalog timestamp is invalid");
  const identifiers = packs.map((pack) => ({ packId: pack.pack_id, packVersion: pack.pack_version }));
  const expectedSelectionDigest = createHash("sha256").update(canonicalCatalogJson({ rulesProfileId: selection.rules_profile_id,
    contentPacks: identifiers }), "utf8").digest("hex");
  if (selection.selection_digest !== expectedSelectionDigest) throw new Error("persisted campaign catalog selection digest is inconsistent");
  const legacyProfile = db.prepare("SELECT rules_profile_id FROM campaign_rules_profiles WHERE campaign_id=?").get(campaignId) as { rules_profile_id: string } | undefined;
  const legacyPins = db.prepare(`SELECT pack_id,pack_version FROM campaign_content_packs WHERE campaign_id=?
    ORDER BY pack_id COLLATE BINARY,pack_version COLLATE BINARY`).all(campaignId) as Array<{ pack_id: string; pack_version: string }>;
  if (legacyProfile?.rules_profile_id !== selection.rules_profile_id
    || canonicalCatalogJson(legacyPins.map((pin) => ({ packId: pin.pack_id, packVersion: pin.pack_version }))) !== canonicalCatalogJson(identifiers)) {
    throw new Error("persisted campaign catalog legacy pins are inconsistent");
  }
  for (const pack of packs) {
    const row = publicationRow(db, pack.pack_id, pack.pack_version);
    if (!row || row.rules_profile_id !== selection.rules_profile_id) throw new Error("persisted campaign catalog is inconsistent");
    validateStoredPublication(db, row);
  }
  return campaignCatalogResolutionReportSchema.parse({ campaignId, compatible: true, rulesProfileId: selection.rules_profile_id,
    contentPacks: packs.map((pack) => ({ packId: pack.pack_id, packVersion: pack.pack_version, digest: pack.manifest_digest })), issues: [] });
}

function receiptFromRow(value: string): CampaignCatalogReceipt {
  return campaignCatalogReceiptSchema.parse(JSON.parse(value));
}

function getReceipt(db: DatabaseDriver.Database, actor: string, campaignIdValue: string, commandIdValue: string): CampaignCatalogReceipt | null {
  const campaignId = resourceIdSchema.parse(campaignIdValue);
  const commandId = resourceIdSchema.parse(commandIdValue);
  if (!campaignAuthority(db, actor, campaignId)) return null;
  const row = db.prepare(`SELECT receipt.result_json FROM campaign_catalog_receipts receipt
    JOIN campaign_catalog_commands command ON command.campaign_id=receipt.campaign_id AND command.command_id=receipt.command_id
    WHERE receipt.campaign_id=? AND receipt.command_id=?`).get(campaignId, commandId) as { result_json: string } | undefined;
  return row ? receiptFromRow(row.result_json) : null;
}

function configure(db: DatabaseDriver.Database, clock: Clock, actor: string, campaignIdValue: string, raw: ConfigureCampaignCatalogInput): CampaignCatalogConfigurationResult {
  const campaignId = resourceIdSchema.parse(campaignIdValue);
  if (campaignAuthority(db, actor, campaignId) !== "owner") throw new ContentCatalogAuthorizationError("campaign catalog configuration requires the campaign owner");
  const input = configureCampaignCatalogInputSchema.parse(raw);
  const ordered = [...input.contentPacks].sort((left, right) => binaryCompare(left.packId, right.packId) || binaryCompare(left.packVersion, right.packVersion));
  return db.transaction(() => {
    if (campaignAuthority(db, actor, campaignId) !== "owner") throw new ContentCatalogAuthorizationError("campaign catalog configuration requires the campaign owner");
    const requested = { rulesProfileId: input.rulesProfileId, contentPacks: ordered,
      expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey };
    const canonicalRequested=canonicalCatalogJson(requested);
    // request_digest is informational only. Exact retry identity is the
    // immutable canonical request and its persisted actor/revision binding.
    const requestDigest = createHash("sha256").update(canonicalRequested, "utf8").digest("hex");
    const prior = db.prepare(`SELECT command.requested_json,command.actor_principal_id,command.expected_revision,receipt.result_json
      FROM campaign_catalog_commands command
      LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
      WHERE command.campaign_id=? AND command.idempotency_key=?`).get(campaignId, input.idempotencyKey) as {
        requested_json:string;actor_principal_id:string;expected_revision:number;result_json: string | null;
      } | undefined;
    if (prior) {
      if (prior.requested_json!==canonicalRequested||prior.actor_principal_id!==actor
        ||prior.expected_revision!==input.expectedRevision)
        throw new ContentCatalogConflictError("catalog idempotency key conflicts with a different request");
      if (prior.result_json === null) throw new Error("catalog command is incomplete");
      const receipt = receiptFromRow(prior.result_json);
      return campaignCatalogConfigurationResultSchema.parse({ content: receipt.content, receipt });
    }
    const campaign = db.prepare("SELECT administration_revision,updated_at FROM campaigns WHERE id=?").get(campaignId) as {
      administration_revision: number; updated_at: string;
    };
    if (campaign.administration_revision !== input.expectedRevision) throw new ContentCatalogStaleError();
    const existingSelection = db.prepare("SELECT 1 FROM campaign_catalog_current_selections WHERE campaign_id=?").get(campaignId);
    if (!existingSelection && db.prepare("SELECT 1 FROM campaign_rules_profiles WHERE campaign_id=?").get(campaignId)) {
      throw new ContentCatalogConflictError("campaign already has legacy content configuration");
    }
    const resolvedPacks:Array<{packId:string;packVersion:string;digest:string}>=[];
    for (const pin of ordered) {
      const row = publicationRow(db, pin.packId, pin.packVersion);
      if (!row || row.rules_profile_id !== input.rulesProfileId) {
        throw new ContentCatalogConflictError(`incompatible or unavailable exact publication ${pin.packId}@${pin.packVersion}`);
      }
      validateStoredPublication(db, row);
      resolvedPacks.push({packId:pin.packId,packVersion:pin.packVersion,digest:row.manifest_digest});
    }
    const selectionDigest = createHash("sha256").update(canonicalCatalogJson({ rulesProfileId: input.rulesProfileId,
      contentPacks: ordered }), "utf8").digest("hex");
    const rawNow = clock.now();
    const at = rawNow.getTime() > new Date(campaign.updated_at).getTime()
      ? rawNow.toISOString() : new Date(new Date(campaign.updated_at).getTime() + 1).toISOString();
    const content = campaignCatalogResolutionReportSchema.parse({campaignId,compatible:true,rulesProfileId:input.rulesProfileId,
      contentPacks:resolvedPacks,issues:[]});
    const receipt = campaignCatalogReceiptSchema.parse({ campaignId, commandId: input.idempotencyKey,
      idempotencyKey: input.idempotencyKey, revisionBefore: input.expectedRevision,
      revisionAfter: input.expectedRevision + 1, configuredAt: at, content });
    const publicData=canonicalCatalogJson({content}),resultJson=canonicalCatalogJson(receipt);
    db.prepare(`INSERT INTO campaign_catalog_commands
      (campaign_id,command_id,idempotency_key,actor_principal_id,expected_revision,request_digest,target_selection_digest,requested_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(campaignId, input.idempotencyKey, input.idempotencyKey, actor,
        input.expectedRevision, requestDigest, selectionDigest, canonicalRequested, at);
    db.prepare(`INSERT INTO campaign_catalog_command_provenance_v18
      (campaign_id,command_id,proposed_event_id,proposed_event_type,actor_principal_id,proposed_public_data,proposed_result_json)
      VALUES (?,?,?,'catalog_configured',?,?,?)`).run(campaignId,input.idempotencyKey,input.idempotencyKey,actor,publicData,resultJson);
    const changed = db.prepare(`UPDATE campaigns SET administration_revision=?,updated_at=?
      WHERE id=? AND administration_revision=?`).run(input.expectedRevision + 1, at, campaignId, input.expectedRevision);
    if (changed.changes !== 1) throw new ContentCatalogStaleError();
    if (existingSelection) {
      db.prepare("DELETE FROM campaign_catalog_current_selections WHERE campaign_id=?").run(campaignId);
      db.prepare("DELETE FROM campaign_content_packs WHERE campaign_id=?").run(campaignId);
      db.prepare("DELETE FROM campaign_rules_profiles WHERE campaign_id=?").run(campaignId);
    }
    db.prepare("INSERT INTO campaign_rules_profiles (campaign_id,rules_profile_id) VALUES (?,?)").run(campaignId, input.rulesProfileId);
    const insertLegacyPin = db.prepare("INSERT INTO campaign_content_packs (campaign_id,pack_id,pack_version,rules_profile_id) VALUES (?,?,?,?)");
    for (const pin of ordered) insertLegacyPin.run(campaignId, pin.packId, pin.packVersion, input.rulesProfileId);
    db.prepare(`INSERT INTO campaign_catalog_current_selections
      (campaign_id,rules_profile_id,selection_digest,configured_by_principal_id,configured_at,open_command_id) VALUES (?,?,?,?,?,?)`)
      .run(campaignId, input.rulesProfileId, selectionDigest, actor, at,input.idempotencyKey);
    const insertPin = db.prepare(`INSERT INTO campaign_catalog_current_pins
      (campaign_id,pack_id,pack_version,position,open_command_id) VALUES (?,?,?,?,?)`);
    ordered.forEach((pin, position) => insertPin.run(campaignId, pin.packId, pin.packVersion, position,input.idempotencyKey));
    db.prepare(`INSERT INTO campaign_catalog_events
      (campaign_id,command_id,event_id,revision_before,revision,occurred_at,public_data) VALUES (?,?,?,?,?,?,?)`)
      .run(campaignId, input.idempotencyKey, input.idempotencyKey, input.expectedRevision,
        input.expectedRevision + 1, at, publicData);
    db.prepare(`INSERT INTO campaign_catalog_receipts
      (campaign_id,command_id,event_id,revision_before,revision_after,result_json) VALUES (?,?,?,?,?,?)`)
      .run(campaignId, input.idempotencyKey, input.idempotencyKey, input.expectedRevision,
        input.expectedRevision + 1, resultJson);
    return campaignCatalogConfigurationResultSchema.parse({ content, receipt });
  }).immediate();
}

export function createContentCatalogRepository(
  db: DatabaseDriver.Database,
  clock: Clock,
  mutationGuard: () => void,
): ContentCatalogRepository {
  return {
    validateContentCatalog,
    publishContentCatalog: (actor, input) => { mutationGuard(); return publish(db, clock, actor, input); },
    listContentCatalogPublications: (actor) => {
      if (!isApplicationOwner(db, actor)) return [];
      return (db.prepare(`${PUBLICATION_SELECT} ORDER BY pack.pack_id COLLATE BINARY,pack.pack_version COLLATE BINARY`).all() as PublicationRow[])
        .map((row) => { validateStoredPublication(db, row); return summary(row); });
    },
    listContentCatalogPublicationPage: (actor, input) => {
      const { cursor, limit } = parsePublicationPageInput(input);
      if (!isApplicationOwner(db, actor)) return { publications: [], nextCursor: null };
      const cursorClause = cursor === null ? "" : ` AND (pack.pack_id COLLATE BINARY > ?
        OR (pack.pack_id COLLATE BINARY = ? AND pack.pack_version COLLATE BINARY > ?))`;
      const rows = db.prepare(`${PUBLICATION_SELECT}${cursorClause}
        ORDER BY pack.pack_id COLLATE BINARY,pack.pack_version COLLATE BINARY LIMIT ?`)
        .all(...(cursor === null ? [] : [cursor[0], cursor[0], cursor[1]]), limit + 1) as PublicationRow[];
      const hasNextPage = rows.length > limit;
      const publications = rows.slice(0, limit).map((row) => { validateStoredPublication(db, row); return summary(row); });
      const last = publications.at(-1);
      return { publications, nextCursor: hasNextPage && last ? encodePublicationCursor(last.packId, last.packVersion) : null };
    },
    getContentCatalogForOwner: (actor, packIdValue, packVersion) => {
      const packId = contentPackIdSchema.parse(packIdValue);
      const version = contentPackVersionSchema.parse(packVersion);
      if (!isApplicationOwner(db, actor)) return null;
      const row = publicationRow(db, packId, version);
      return row ? ownerProjection(db, row) : null;
    },
    getCampaignContentCatalog: (actor, campaignIdValue, packIdValue, packVersion) => {
      const campaignId = resourceIdSchema.parse(campaignIdValue);
      const packId = contentPackIdSchema.parse(packIdValue);
      const version = contentPackVersionSchema.parse(packVersion);
      const role = campaignAuthority(db, actor, campaignId);
      if (!role) return null;
      if (!db.prepare(`SELECT 1 FROM campaign_catalog_current_pins WHERE campaign_id=? AND pack_id=? AND pack_version=?`).get(campaignId, packId, version)) return null;
      const row = publicationRow(db, packId, version);
      if (!row) throw new Error("persisted campaign catalog publication is missing");
      if (role === "owner" || role === "gm") {
        const validated = validateStoredPublication(db, row);
        return gmCatalogProjectionSchema.parse({ publication: summary(row), definitions: validated.definitions });
      }
      const safe = readPublicDefinitions(db, packId, version, row.definition_count);
      return role === "player"
        ? playerCatalogProjectionSchema.parse({ publication: summary(row), definitions: safe })
        : observerCatalogProjectionSchema.parse({ publication: summary(row), definitions: safe.map(observerDefinition) });
    },
    configureCampaignCatalog: (actor, campaignId, input) => { mutationGuard(); return configure(db, clock, actor, campaignId, input); },
    resolveCampaignCatalog: (actor, campaignId) => resolve(db, actor, campaignId),
    getCampaignCatalogReceipt: (actor, campaignId, commandId) => getReceipt(db, actor, campaignId, commandId),
  };
}
