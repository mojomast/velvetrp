import { createHash } from "node:crypto";
import type DatabaseDriver from "better-sqlite3";
import {
  CHARACTER_BUILDER_ATTRIBUTE_IDS,
  CHARACTER_DRAFT_EXPIRY_SECONDS,
  abandonCharacterDraftInputSchema,
  backgroundCatalogDefinitionSchema,
  catalogDefinitionSchema,
  characterBuilderAllocationSchema,
  characterBuilderCompletionSchema,
  characterBuilderSelectionsSchema,
  characterDraftFinalizationResultSchema,
  characterDraftMutationReceiptSchema,
  characterDraftMutationResultSchema,
  characterDraftPinSchema,
  characterDraftViewSchema,
  characterFinalizationReceiptSchema,
  characterStartingGrantSchema,
  classCatalogDefinitionSchema,
  classLevelCatalogDefinitionSchema,
  createCharacterDraftInputSchema,
  finalizeCharacterDraftInputSchema,
  raceCatalogDefinitionSchema,
  resourceIdSchema,
  updateCharacterDraftInputSchema,
  utcIsoTimestampSchema,
  type CatalogDefinition,
  type CharacterBuilderAllocation,
  type CharacterBuilderAllocationRequest,
  type CharacterBuilderAttributeScores,
  type CharacterDraftFinalizationResult,
  type CharacterDraftMutationReceipt,
  type CharacterDraftMutationResult,
  type CharacterDraftPin,
  type CharacterDraftView,
  type CharacterStartingGrant,
  type CreateCharacterDraftInput,
  type FinalizeCharacterDraftInput,
  type UpdateCharacterDraftInput,
} from "@velvet/contracts";
import { calculateCharacterDerivedStats } from "../characterBuilderCalculator.js";
import type { Clock, IdGenerator, RandomNumberGenerator } from "../runtime.js";
import { canonicalCatalogJson } from "./contentCatalogRepo.js";
import { initializeCharacterProgressionV24 } from "./characterProgressionRepo.js";

type Role = "owner" | "gm" | "player" | "observer";
type Dependencies = { clock: Clock; ids: IdGenerator; rng: RandomNumberGenerator };
type RaceCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "race" } }>;
type BackgroundCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "background" } }>;
type ClassCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "class" } }>;
type ClassLevelCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "class-level" } }>;

export class CharacterBuilderAuthorizationError extends Error {
  readonly code = "CHARACTER_BUILDER_FORBIDDEN";
  constructor() { super("character draft operation is unavailable"); this.name = "CharacterBuilderAuthorizationError"; }
}
export class CharacterBuilderConflictError extends Error {
  readonly code = "CHARACTER_BUILDER_CONFLICT";
  constructor(message = "character draft command conflicts with authoritative state") { super(message); this.name = "CharacterBuilderConflictError"; }
}
export class CharacterBuilderStaleError extends Error {
  readonly code = "CHARACTER_BUILDER_STALE";
  constructor() { super("character draft revision is stale"); this.name = "CharacterBuilderStaleError"; }
}
export class CharacterBuilderExpiredError extends Error {
  readonly code = "CHARACTER_BUILDER_EXPIRED";
  constructor() { super("character draft has expired"); this.name = "CharacterBuilderExpiredError"; }
}
export class CharacterBuilderIncompleteError extends Error {
  readonly code = "CHARACTER_BUILDER_INCOMPLETE";
  constructor() { super("character draft is incomplete"); this.name = "CharacterBuilderIncompleteError"; }
}
export class CharacterBuilderUnavailableError extends Error {
  readonly code = "CHARACTER_BUILDER_UNAVAILABLE";
  constructor(message = "character draft dependency is unavailable") { super(message); this.name = "CharacterBuilderUnavailableError"; }
}

/** Roll each physical die independently through the injected bounded RNG. */
export function rollCharacterBuilderAttributes(rng: RandomNumberGenerator): Extract<CharacterBuilderAllocation, { method: "server-roll" }> {
  const nextDie = () => {
    const value = rng.integer(1, 7);
    if (!Number.isSafeInteger(value) || value < 1 || value > 6) throw new Error("character builder RNG returned an out-of-range die");
    return value;
  };
  const terms = CHARACTER_BUILDER_ATTRIBUTE_IDS.map((attributeId) => {
    const dice = [nextDie(), nextDie(), nextDie(), nextDie()];
    const minimum = Math.min(...dice);
    const droppedIndex = dice.indexOf(minimum);
    return { attributeId, dice, droppedIndex, score: dice.reduce((sum, die) => sum + die, 0) - minimum };
  });
  const scores = Object.fromEntries(terms.map((term) => [term.attributeId, term.score]));
  return characterBuilderAllocationSchema.parse({ method: "server-roll", algorithm: "velvet-4d6-drop-first-lowest-v1", scores, terms }) as
    Extract<CharacterBuilderAllocation, { method: "server-roll" }>;
}

function resolveAllocation(request: CharacterBuilderAllocationRequest, rng: RandomNumberGenerator): CharacterBuilderAllocation {
  return request.method === "server-roll" ? rollCharacterBuilderAttributes(rng) : characterBuilderAllocationSchema.parse(request);
}

interface Authority { role: Role; ownerPrincipalId: string }
function authority(db: DatabaseDriver.Database, actorPrincipalId: string, campaignId: string): Authority | null {
  const row = db.prepare(`SELECT campaign.owner_principal_id, actor.role,
      actor.principal_id actor_id, actor_parent.id actor_parent_id,
      owner.principal_id owner_id, owner.role owner_role, owner_parent.id owner_parent_id,
      (SELECT COUNT(*) FROM campaign_memberships candidate WHERE candidate.campaign_id=campaign.id AND candidate.role='owner') owner_count
    FROM campaigns campaign
    LEFT JOIN campaign_memberships actor ON actor.campaign_id=campaign.id AND actor.principal_id=?
    LEFT JOIN principals actor_parent ON actor_parent.id=actor.principal_id
    LEFT JOIN campaign_memberships owner ON owner.campaign_id=campaign.id AND owner.principal_id=campaign.owner_principal_id
    LEFT JOIN principals owner_parent ON owner_parent.id=owner.principal_id
    WHERE campaign.id=?`).get(actorPrincipalId, campaignId) as {
      owner_principal_id: string; role: Role | null; actor_id: string | null; actor_parent_id: string | null;
      owner_id: string | null; owner_role: string | null; owner_parent_id: string | null; owner_count: number;
    } | undefined;
  if (!row || !row.role || !row.actor_id || !row.actor_parent_id) return null;
  if (row.owner_count !== 1 || row.owner_id !== row.owner_principal_id || row.owner_parent_id !== row.owner_principal_id || row.owner_role !== "owner") {
    throw new Error("campaign owner authority is malformed");
  }
  if (row.role === "owner" && actorPrincipalId !== row.owner_principal_id) throw new Error("campaign owner pointer is malformed");
  return { role: row.role, ownerPrincipalId: row.owner_principal_id };
}

function mayControl(actor: string, auth: Authority, controller: string): boolean {
  return auth.role === "owner" || auth.role === "gm" || (auth.role === "player" && actor === controller);
}

function validateController(db: DatabaseDriver.Database, campaignId: string, controller: string): Role {
  const row = db.prepare(`SELECT membership.role,principal.id parent_id FROM campaign_memberships membership
    LEFT JOIN principals principal ON principal.id=membership.principal_id
    WHERE membership.campaign_id=? AND membership.principal_id=?`).get(campaignId, controller) as { role: Role; parent_id: string | null } | undefined;
  if (!row || row.parent_id !== controller || !["owner", "gm", "player"].includes(row.role)) throw new CharacterBuilderUnavailableError("draft controller is not an eligible campaign member");
  return row.role;
}

function validatePersona(db: DatabaseDriver.Database, campaignId: string, personaId: string, now: string, exceptDraftId?: string): void {
  const persona = db.prepare("SELECT fictional_confirmed,is_real_person FROM characters WHERE id=?").get(personaId) as { fictional_confirmed: number; is_real_person: number } | undefined;
  if (!persona || persona.fictional_confirmed !== 1 || persona.is_real_person !== 0) throw new CharacterBuilderUnavailableError("persona is not eligible for campaign play");
  if (db.prepare("SELECT 1 FROM campaign_characters WHERE campaign_id=? AND character_id=?").get(campaignId, personaId)) {
    throw new CharacterBuilderConflictError("persona already has a campaign character");
  }
  const competing = db.prepare(`SELECT id FROM character_drafts_v19 WHERE campaign_id=? AND persona_id=? AND status='active'
    AND id<>coalesce(?, '') AND (durability='durable' OR expires_at>?) LIMIT 1`).get(campaignId, personaId, exceptDraftId ?? null, now);
  if (competing) throw new CharacterBuilderConflictError("persona already has an active character draft");
}

interface CatalogContext {
  rulesProfileId: string;
  pins: CharacterDraftPin[];
  definitions: CatalogDefinition[];
}
function currentCatalog(db: DatabaseDriver.Database, campaignId: string): CatalogContext {
  const selection = db.prepare(`SELECT rules_profile_id FROM campaign_catalog_current_selections WHERE campaign_id=?`).get(campaignId) as { rules_profile_id: string } | undefined;
  if (!selection) throw new CharacterBuilderUnavailableError("campaign requires validated-v1 content pins");
  const rows = db.prepare(`SELECT pin.position,pin.pack_id,pin.pack_version,publication.manifest_digest,publication.validation_level,
      pack.sealed,pack.rules_profile_id
    FROM campaign_catalog_current_pins pin
    LEFT JOIN rpg_content_pack_publications publication ON publication.pack_id=pin.pack_id AND publication.pack_version=pin.pack_version
    LEFT JOIN rpg_content_packs pack ON pack.pack_id=pin.pack_id AND pack.pack_version=pin.pack_version
    WHERE pin.campaign_id=? ORDER BY pin.position`).all(campaignId) as Array<{ position: number; pack_id: string; pack_version: string; manifest_digest: string | null; validation_level: string | null; sealed: number | null; rules_profile_id: string | null }>;
  if (!rows.length || rows.some((row, index) => row.position !== index || row.validation_level !== "validated-v1" || row.sealed !== 1 || row.rules_profile_id !== selection.rules_profile_id)) {
    throw new CharacterBuilderUnavailableError("campaign validated-v1 pins are incomplete");
  }
  const pins = rows.map((row) => characterDraftPinSchema.parse({ packId: row.pack_id, packVersion: row.pack_version, publicationDigest: row.manifest_digest }));
  const definitions: CatalogDefinition[] = [];
  const statement = db.prepare(`SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=?
    AND kind IN ('race','background','class','class-level') ORDER BY kind COLLATE BINARY,definition_id COLLATE BINARY`);
  for (const pin of pins) for (const row of statement.all(pin.packId, pin.packVersion) as Array<{ definition_json: string }>) {
    definitions.push(catalogDefinitionSchema.parse(JSON.parse(row.definition_json)));
  }
  if (!definitions.some((value) => value.reference.kind === "race") || !definitions.some((value) => value.reference.kind === "background") || !definitions.some((value) => value.reference.kind === "class")) {
    throw new CharacterBuilderUnavailableError("campaign catalog has no complete builder choices");
  }
  return { rulesProfileId: selection.rules_profile_id, pins, definitions };
}

function catalogForPins(db: DatabaseDriver.Database, rulesProfileId: string, pins: CharacterDraftPin[]): CatalogDefinition[] {
  const definitions: CatalogDefinition[] = [];
  const statement = db.prepare(`SELECT definition_json FROM rpg_catalog_definitions definition
    JOIN rpg_content_pack_publications publication ON publication.pack_id=definition.pack_id AND publication.pack_version=definition.pack_version
    JOIN rpg_content_packs pack ON pack.pack_id=publication.pack_id AND pack.pack_version=publication.pack_version
    WHERE definition.pack_id=? AND definition.pack_version=? AND publication.validation_level='validated-v1'
      AND publication.manifest_digest=? AND pack.sealed=1 AND pack.rules_profile_id=?
      AND definition.kind IN ('race','background','class','class-level')
    ORDER BY definition.kind COLLATE BINARY,definition.definition_id COLLATE BINARY`);
  for (const pin of pins) for (const row of statement.all(pin.packId, pin.packVersion, pin.publicationDigest, rulesProfileId) as Array<{ definition_json: string }>) {
    definitions.push(catalogDefinitionSchema.parse(JSON.parse(row.definition_json)));
  }
  return definitions;
}

const refKey = (reference: { packId: string; packVersion: string; kind: string; definitionId: string }) =>
  `${reference.packId}\0${reference.packVersion}\0${reference.kind}\0${reference.definitionId}`;

function selectedDefinitions(definitions: CatalogDefinition[], selections: ReturnType<typeof characterBuilderSelectionsSchema.parse>): {
  race: RaceCatalogDefinition; background: BackgroundCatalogDefinition; klass: ClassCatalogDefinition; level: ClassLevelCatalogDefinition;
} | null {
  if (!selections.race || !selections.background || !selections.class || !selections.starterGrant) return null;
  const map = new Map(definitions.map((definition) => [refKey(definition.reference), definition]));
  const race = raceCatalogDefinitionSchema.safeParse(map.get(refKey(selections.race)));
  const background = backgroundCatalogDefinitionSchema.safeParse(map.get(refKey(selections.background)));
  const klass = classCatalogDefinitionSchema.safeParse(map.get(refKey(selections.class)));
  if (!race.success || !background.success || !klass.success) return null;
  const levels = klass.data.mechanics.levelRefs.map((reference) => classLevelCatalogDefinitionSchema.safeParse(map.get(refKey(reference))))
    .filter((value): value is { success: true; data: ClassLevelCatalogDefinition } => value.success)
    .filter((value) => value.data.mechanics.level === 1 && refKey(value.data.mechanics.classRef) === refKey(klass.data.reference));
  if (levels.length !== 1) return null;
  return { race: race.data, background: background.data, klass: klass.data, level: levels[0]!.data };
}

function grantsFor(background: BackgroundCatalogDefinition, choice: "kit" | "currency"): CharacterStartingGrant[] {
  return choice === "kit"
    ? background.mechanics.itemRefs.map((reference) => characterStartingGrantSchema.parse({ kind: "item", reference, quantity: 1, source: "background-kit" }))
    : [characterStartingGrantSchema.parse({ kind: "currency", reference: background.mechanics.startingCurrency.currency,
        amount: background.mechanics.startingCurrency.amount, source: "background-currency" })];
}

function samePins(current: CatalogContext, rulesProfileId: string, pins: CharacterDraftPin[]): boolean {
  return current.rulesProfileId === rulesProfileId && canonicalCatalogJson(current.pins) === canonicalCatalogJson(pins);
}

interface DraftRow {
  id: string; campaign_id: string; persona_id: string; controller_principal_id: string; created_by_principal_id: string;
  status: "active" | "abandoned" | "finalized"; durability: "durable" | "expiring"; expires_at: string | null;
  revision: number; rules_profile_id: string; allocation_json: string; selections_json: string; created_at: string; updated_at: string;
}
function rowFor(db: DatabaseDriver.Database, draftId: string): DraftRow | undefined {
  return db.prepare("SELECT * FROM character_drafts_v19 WHERE id=?").get(draftId) as DraftRow | undefined;
}
function pinsFor(db: DatabaseDriver.Database, draftId: string): CharacterDraftPin[] {
  return (db.prepare(`SELECT pack_id,pack_version,publication_digest FROM character_draft_pins_v19 WHERE draft_id=? ORDER BY position`).all(draftId) as Array<{ pack_id: string; pack_version: string; publication_digest: string }>).map((row) =>
    characterDraftPinSchema.parse({ packId: row.pack_id, packVersion: row.pack_version, publicationDigest: row.publication_digest }));
}

function buildView(db: DatabaseDriver.Database, row: DraftRow, role: Role, now: string): CharacterDraftView {
  const pins = pinsFor(db, row.id);
  const allocation = characterBuilderAllocationSchema.parse(JSON.parse(row.allocation_json));
  const selections = characterBuilderSelectionsSchema.parse(JSON.parse(row.selections_json));
  const definitions = catalogForPins(db, row.rules_profile_id, pins);
  const effectiveExpiry = row.expires_at !== null && row.expires_at <= now;
  let pinChanged = false;
  try { pinChanged = !samePins(currentCatalog(db, row.campaign_id), row.rules_profile_id, pins); } catch { pinChanged = true; }
  const chosen = selectedDefinitions(definitions, selections);
  const issues: Array<{ code: "missing-race" | "missing-background" | "missing-class" | "missing-starter-grant" | "expired" | "pins-changed" | "definition-unavailable" | "persona-unavailable" | "controller-unavailable"; path: string; message: string }> = [];
  if (!selections.race) issues.push({ code: "missing-race", path: "selections.race", message: "Select one race." });
  if (!selections.background) issues.push({ code: "missing-background", path: "selections.background", message: "Select one background." });
  if (!selections.class) issues.push({ code: "missing-class", path: "selections.class", message: "Select one class." });
  if (!selections.starterGrant) issues.push({ code: "missing-starter-grant", path: "selections.starterGrant", message: "Select a starter kit or currency." });
  if (effectiveExpiry) issues.push({ code: "expired", path: "expiresAt", message: "This expiring draft is no longer effective." });
  if (pinChanged) issues.push({ code: "pins-changed", path: "pins", message: "Campaign content pins no longer match this draft." });
  const persona = db.prepare("SELECT fictional_confirmed,is_real_person FROM characters WHERE id=?").get(row.persona_id) as { fictional_confirmed: number; is_real_person: number } | undefined;
  if (!persona || persona.fictional_confirmed !== 1 || persona.is_real_person !== 0
    || (row.status === "active" && !!db.prepare("SELECT 1 FROM campaign_characters WHERE campaign_id=? AND character_id=?").get(row.campaign_id, row.persona_id))) {
    issues.push({ code: "persona-unavailable", path: "personaId", message: "The selected persona is no longer eligible." });
  }
  const controller = db.prepare(`SELECT membership.role,principal.id parent_id FROM campaign_memberships membership
    LEFT JOIN principals principal ON principal.id=membership.principal_id WHERE membership.campaign_id=? AND membership.principal_id=?`)
    .get(row.campaign_id, row.controller_principal_id) as { role: Role; parent_id: string | null } | undefined;
  if (!controller || controller.parent_id !== row.controller_principal_id || !["owner", "gm", "player"].includes(controller.role)) {
    issues.push({ code: "controller-unavailable", path: "controllerPrincipalId", message: "The selected controller is no longer eligible." });
  }
  if (selections.race && selections.background && selections.class && selections.starterGrant && !chosen) {
    issues.push({ code: "definition-unavailable", path: "selections", message: "A selected definition is unavailable or not a valid level-one choice." });
  }
  const derived = chosen ? calculateCharacterDerivedStats({ scores: allocation.scores, racialBonuses: chosen.race.mechanics.attributeBonuses,
    classHp: chosen.level.mechanics.hpGain, raceSpeed: chosen.race.mechanics.speed,
    proficiencyBonus: chosen.level.mechanics.proficiencyBonus, spellcastingAttribute: chosen.klass.mechanics.primaryAttribute }) : null;
  const grants = chosen && selections.starterGrant ? grantsFor(chosen.background, selections.starterGrant) : [];
  const option = (definition: CatalogDefinition) => ({ reference: definition.reference, name: definition.name, description: definition.description });
  return characterDraftViewSchema.parse({
    id: row.id, campaignId: row.campaign_id, personaId: row.persona_id, controllerPrincipalId: row.controller_principal_id,
    role, status: row.status, durability: row.durability, expiresAt: row.expires_at, effectivelyExpired: effectiveExpiry,
    revision: row.revision, rulesProfileId: row.rules_profile_id, pins, allocation, selections,
    choiceGroups: [
      { id: "race", required: true, options: definitions.filter((value) => value.reference.kind === "race").map(option) },
      { id: "background", required: true, options: definitions.filter((value) => value.reference.kind === "background").map(option) },
      { id: "class", required: true, options: definitions.filter((value) => value.reference.kind === "class").map(option) },
      { id: "starter-grant", required: true, options: ["kit", "currency"] },
    ],
    completion: characterBuilderCompletionSchema.parse({ complete: issues.length === 0, issues }),
    derivedPreview: derived, startingGrants: grants, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function digest(value: unknown): string { return createHash("sha256").update(canonicalCatalogJson(value)).digest("hex"); }
function commandRetry(db: DatabaseDriver.Database, campaignId: string, actor: string, key: string): { draft_id: string; type: string; requested_json: string; result_json: string } | undefined {
  return db.prepare(`SELECT command.draft_id,command.type,command.requested_json,receipt.result_json
    FROM character_draft_commands_v19 command
    JOIN character_draft_receipts_v19 receipt ON receipt.draft_id=command.draft_id AND receipt.command_id=command.command_id
    JOIN character_draft_events_v19 event ON event.draft_id=receipt.draft_id AND event.command_id=receipt.command_id
      AND event.event_id=receipt.event_id AND event.revision=receipt.revision_after
    JOIN character_draft_revisions_v19 history ON history.draft_id=receipt.draft_id AND history.command_id=receipt.command_id
      AND history.revision=receipt.revision_after AND history.snapshot_json=receipt.result_json->>'$.draft'
    JOIN character_draft_command_provenance_v20 proposal ON proposal.draft_id=command.draft_id AND proposal.command_id=command.command_id
      AND proposal.proposed_event_id=event.event_id AND proposal.proposed_result_json=receipt.result_json
    WHERE command.campaign_id=? AND command.actor_principal_id=? AND command.idempotency_key=?`).get(campaignId, actor, key) as { draft_id: string; type: string; requested_json: string; result_json: string } | undefined;
}
function exactRetry<T>(retry: ReturnType<typeof commandRetry>, type: string, requested: unknown, parser: { parse(value: unknown): T }, draftId?: string): T | null {
  if (!retry) return null;
  if (retry.type !== type || retry.requested_json !== canonicalCatalogJson(requested) || (draftId && retry.draft_id !== draftId)) throw new CharacterBuilderConflictError("idempotency key was reused for a different draft command");
  return parser.parse(JSON.parse(retry.result_json));
}

function insertAudit(db: DatabaseDriver.Database, values: { draftId: string; commandId: string; eventId: string; campaignId: string; actor: string;
  idempotencyKey: string; type: "create" | "update" | "abandon" | "finalize"; expectedRevision: number; requested: unknown;
  revisionAfter: number; occurredAt: string; result: unknown }): void {
  const requestedJson = canonicalCatalogJson(values.requested);
  db.prepare(`INSERT INTO character_draft_commands_v19
    (draft_id,command_id,campaign_id,actor_principal_id,idempotency_key,type,expected_revision,requested_json,request_digest,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(values.draftId, values.commandId, values.campaignId, values.actor, values.idempotencyKey,
      values.type, values.expectedRevision, requestedJson, digest(values.requested), values.occurredAt);
  const eventType = { create: "draft_created", update: "draft_updated", abandon: "draft_abandoned", finalize: "draft_finalized" }[values.type];
  const publicData = { draftId: values.draftId, revision: values.revisionAfter,
    status: values.type === "finalize" ? "finalized" : values.type === "abandon" ? "abandoned" : "active" };
  const proposedEvent = { actorPrincipalId: values.actor, campaignId: values.campaignId, commandId: values.commandId,
    draftId: values.draftId, eventId: values.eventId, occurredAt: values.occurredAt, publicData,
    revision: values.revisionAfter, revisionBefore: values.expectedRevision, type: eventType };
  db.prepare(`INSERT INTO character_draft_command_provenance_v20
    (draft_id,command_id,campaign_id,actor_principal_id,proposed_event_id,proposed_event_type,proposed_event_json,proposed_result_json)
    VALUES (?,?,?,?,?,?,?,?)`).run(values.draftId,values.commandId,values.campaignId,values.actor,values.eventId,eventType,
      canonicalCatalogJson(proposedEvent),canonicalCatalogJson(values.result));
  db.prepare(`INSERT INTO character_draft_revisions_v19 (draft_id,revision,status,snapshot_json,command_id) VALUES (?,?,?,?,?)`)
    .run(values.draftId, values.revisionAfter, publicData.status,
      canonicalCatalogJson((values.result as { draft: unknown }).draft), values.commandId);
  db.prepare(`INSERT INTO character_draft_events_v19
    (draft_id,command_id,event_id,type,revision_before,revision,occurred_at,public_data) VALUES (?,?,?,?,?,?,?,?)`)
    .run(values.draftId, values.commandId, values.eventId, eventType, values.expectedRevision, values.revisionAfter, values.occurredAt,
      canonicalCatalogJson(publicData));
  db.prepare(`INSERT INTO character_draft_receipts_v19
    (draft_id,command_id,event_id,revision_before,revision_after,result_json) VALUES (?,?,?,?,?,?)`)
    .run(values.draftId, values.commandId, values.eventId, values.expectedRevision, values.revisionAfter, canonicalCatalogJson(values.result));
}

export interface CharacterBuilderRepository {
  createCharacterDraft(actorPrincipalId: string, campaignId: string, input: CreateCharacterDraftInput): CharacterDraftMutationResult;
  getCharacterDraft(actorPrincipalId: string, draftId: string): CharacterDraftView | null;
  updateCharacterDraft(actorPrincipalId: string, draftId: string, input: UpdateCharacterDraftInput): CharacterDraftMutationResult;
  abandonCharacterDraft(actorPrincipalId: string, draftId: string, input: { expectedRevision: number; idempotencyKey: string }): CharacterDraftMutationResult;
  finalizeCharacterDraft(actorPrincipalId: string, draftId: string, input: FinalizeCharacterDraftInput): CharacterDraftFinalizationResult;
  getCharacterDraftReceipt(actorPrincipalId: string, draftId: string, commandId: string): CharacterDraftMutationReceipt | import("@velvet/contracts").CharacterFinalizationReceipt | null;
}

export function createCharacterBuilderRepository(
  db: DatabaseDriver.Database,
  dependencies: Dependencies,
  assertFactoryMutation: () => void,
): CharacterBuilderRepository {
  const getAuthorized = (actorPrincipalId: string, draftId: string): { row: DraftRow; auth: Authority } | null => {
    const actor = resourceIdSchema.parse(actorPrincipalId), id = resourceIdSchema.parse(draftId);
    const row = rowFor(db, id); if (!row) return null;
    const auth = authority(db, actor, row.campaign_id); if (!auth || !mayControl(actor, auth, row.controller_principal_id)) return null;
    return { row, auth };
  };
  return {
    createCharacterDraft(actorPrincipalId, campaignId, input) {
      assertFactoryMutation();
      const actor = resourceIdSchema.parse(actorPrincipalId), campaign = resourceIdSchema.parse(campaignId);
      const normalized = createCharacterDraftInputSchema.parse(input);
      const requested = normalized;
      return db.transaction(() => {
        const auth = authority(db, actor, campaign); if (!auth || !mayControl(actor, auth, normalized.controllerPrincipalId)) throw new CharacterBuilderAuthorizationError();
        const retry = exactRetry(commandRetry(db, campaign, actor, normalized.idempotencyKey), "create", requested, characterDraftMutationResultSchema);
        if (retry) return retry;
        validateController(db, campaign, normalized.controllerPrincipalId);
        const catalog = currentCatalog(db, campaign);
        const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
        validatePersona(db, campaign, normalized.personaId, now);
        // All 24 physical dice are requested only after non-random validation.
        const allocation = resolveAllocation(normalized.allocation, dependencies.rng);
        const draftId = resourceIdSchema.parse(dependencies.ids.nextId());
        const commandId = resourceIdSchema.parse(dependencies.ids.nextId());
        const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
        const expiresAt = normalized.durability === "expiring"
          ? utcIsoTimestampSchema.parse(new Date(new Date(now).getTime() + CHARACTER_DRAFT_EXPIRY_SECONDS * 1_000).toISOString()) : null;
        const selections = { race: null, background: null, class: null, starterGrant: null };
        db.prepare(`INSERT INTO character_drafts_v19
          (id,campaign_id,persona_id,controller_principal_id,created_by_principal_id,status,durability,expires_at,revision,rules_profile_id,allocation_json,selections_json,created_at,updated_at)
          VALUES (?,?,?,?,?,'active',?,?,0,?,?,?,?,?)`).run(draftId, campaign, normalized.personaId, normalized.controllerPrincipalId,
            actor, normalized.durability, expiresAt, catalog.rulesProfileId, canonicalCatalogJson(allocation), canonicalCatalogJson(selections), now, now);
        const insertPin = db.prepare("INSERT INTO character_draft_pins_v19 (draft_id,position,pack_id,pack_version,publication_digest) VALUES (?,?,?,?,?)");
        catalog.pins.forEach((pin, position) => insertPin.run(draftId, position, pin.packId, pin.packVersion, pin.publicationDigest));
        const draft = buildView(db, rowFor(db, draftId)!, auth.role, now);
        const receipt = characterDraftMutationReceiptSchema.parse({ draftId, commandId, idempotencyKey: normalized.idempotencyKey,
          type: "create", revisionBefore: 0, revisionAfter: 0, occurredAt: now, draft });
        const result = characterDraftMutationResultSchema.parse({ draft, receipt });
        insertAudit(db, { draftId, commandId, eventId, campaignId: campaign, actor, idempotencyKey: normalized.idempotencyKey,
          type: "create", expectedRevision: 0, requested, revisionAfter: 0, occurredAt: now, result });
        return result;
      }).immediate();
    },
    getCharacterDraft(actorPrincipalId, draftId) {
      const found = getAuthorized(actorPrincipalId, draftId); if (!found) return null;
      const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
      return db.transaction(() => buildView(db, rowFor(db, found.row.id)!, found.auth.role, now))();
    },
    updateCharacterDraft(actorPrincipalId, draftId, input) {
      assertFactoryMutation();
      const actor = resourceIdSchema.parse(actorPrincipalId), id = resourceIdSchema.parse(draftId), normalized = updateCharacterDraftInputSchema.parse(input);
      const requested = normalized;
      return db.transaction(() => {
        const row = rowFor(db, id); if (!row) throw new CharacterBuilderAuthorizationError();
        const auth = authority(db, actor, row.campaign_id); if (!auth || !mayControl(actor, auth, row.controller_principal_id)) throw new CharacterBuilderAuthorizationError();
        const retry = exactRetry(commandRetry(db, row.campaign_id, actor, normalized.idempotencyKey), "update", requested, characterDraftMutationResultSchema, id); if (retry) return retry;
        if (row.status !== "active") throw new CharacterBuilderConflictError("only active drafts can be updated");
        if (row.revision !== normalized.expectedRevision) throw new CharacterBuilderStaleError();
        const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
        if (row.expires_at !== null && row.expires_at <= now) throw new CharacterBuilderExpiredError();
        const definitions = catalogForPins(db, row.rules_profile_id, pinsFor(db, id));
        const valid = new Set(definitions.filter((value) => ["race", "background", "class"].includes(value.reference.kind)).map((value) => refKey(value.reference)));
        for (const reference of [normalized.selections.race, normalized.selections.background, normalized.selections.class]) {
          if (reference && !valid.has(refKey(reference))) throw new CharacterBuilderUnavailableError("selection is not in the draft's exact pins");
        }
        const old = characterBuilderSelectionsSchema.parse(JSON.parse(row.selections_json));
        const selections = characterBuilderSelectionsSchema.parse({ ...old, ...normalized.selections });
        const commandId = resourceIdSchema.parse(dependencies.ids.nextId()), eventId = resourceIdSchema.parse(dependencies.ids.nextId());
        db.prepare("UPDATE character_drafts_v19 SET selections_json=?,revision=revision+1,updated_at=? WHERE id=?")
          .run(canonicalCatalogJson(selections), now, id);
        const draft = buildView(db, rowFor(db, id)!, auth.role, now);
        const receipt = characterDraftMutationReceiptSchema.parse({ draftId: id, commandId, idempotencyKey: normalized.idempotencyKey,
          type: "update", revisionBefore: row.revision, revisionAfter: row.revision + 1, occurredAt: now, draft });
        const result = characterDraftMutationResultSchema.parse({ draft, receipt });
        insertAudit(db, { draftId: id, commandId, eventId, campaignId: row.campaign_id, actor, idempotencyKey: normalized.idempotencyKey,
          type: "update", expectedRevision: row.revision, requested, revisionAfter: row.revision + 1, occurredAt: now, result });
        return result;
      }).immediate();
    },
    abandonCharacterDraft(actorPrincipalId, draftId, input) {
      assertFactoryMutation();
      const actor = resourceIdSchema.parse(actorPrincipalId), id = resourceIdSchema.parse(draftId), normalized = abandonCharacterDraftInputSchema.parse(input);
      const requested = normalized;
      return db.transaction(() => {
        const row = rowFor(db, id); if (!row) throw new CharacterBuilderAuthorizationError();
        const auth = authority(db, actor, row.campaign_id); if (!auth || !mayControl(actor, auth, row.controller_principal_id)) throw new CharacterBuilderAuthorizationError();
        const retry = exactRetry(commandRetry(db, row.campaign_id, actor, normalized.idempotencyKey), "abandon", requested, characterDraftMutationResultSchema, id); if (retry) return retry;
        if (row.status !== "active") throw new CharacterBuilderConflictError("only active drafts can be abandoned");
        if (row.revision !== normalized.expectedRevision) throw new CharacterBuilderStaleError();
        const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
        const commandId = resourceIdSchema.parse(dependencies.ids.nextId()), eventId = resourceIdSchema.parse(dependencies.ids.nextId());
        db.prepare("UPDATE character_drafts_v19 SET status='abandoned',revision=revision+1,updated_at=? WHERE id=?").run(now, id);
        const draft = buildView(db, rowFor(db, id)!, auth.role, now);
        const receipt = characterDraftMutationReceiptSchema.parse({ draftId: id, commandId, idempotencyKey: normalized.idempotencyKey,
          type: "abandon", revisionBefore: row.revision, revisionAfter: row.revision + 1, occurredAt: now, draft });
        const result = characterDraftMutationResultSchema.parse({ draft, receipt });
        insertAudit(db, { draftId: id, commandId, eventId, campaignId: row.campaign_id, actor, idempotencyKey: normalized.idempotencyKey,
          type: "abandon", expectedRevision: row.revision, requested, revisionAfter: row.revision + 1, occurredAt: now, result });
        return result;
      }).immediate();
    },
    finalizeCharacterDraft(actorPrincipalId, draftId, input) {
      assertFactoryMutation();
      const actor = resourceIdSchema.parse(actorPrincipalId), id = resourceIdSchema.parse(draftId), normalized = finalizeCharacterDraftInputSchema.parse(input);
      const requested = normalized;
      return db.transaction(() => {
        const row = rowFor(db, id); if (!row) throw new CharacterBuilderAuthorizationError();
        const auth = authority(db, actor, row.campaign_id); if (!auth || !mayControl(actor, auth, row.controller_principal_id)) throw new CharacterBuilderAuthorizationError();
        const retry = exactRetry(commandRetry(db, row.campaign_id, actor, normalized.idempotencyKey), "finalize", requested, characterDraftFinalizationResultSchema, id); if (retry) return retry;
        if (row.status !== "active") throw new CharacterBuilderConflictError("only active drafts can be finalized");
        if (row.revision !== normalized.expectedRevision) throw new CharacterBuilderStaleError();
        const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString());
        if (row.expires_at !== null && row.expires_at <= now) throw new CharacterBuilderExpiredError();
        validateController(db, row.campaign_id, row.controller_principal_id);
        validatePersona(db, row.campaign_id, row.persona_id, now, id);
        const pins = pinsFor(db, id), current = currentCatalog(db, row.campaign_id);
        if (!samePins(current, row.rules_profile_id, pins)) throw new CharacterBuilderConflictError("campaign content pins changed after draft creation");
        const allocation = characterBuilderAllocationSchema.parse(JSON.parse(row.allocation_json));
        const selections = characterBuilderSelectionsSchema.parse(JSON.parse(row.selections_json));
        const chosen = selectedDefinitions(current.definitions, selections);
        if (!chosen || !selections.starterGrant) throw new CharacterBuilderIncompleteError();
        const derived = calculateCharacterDerivedStats({ scores: allocation.scores, racialBonuses: chosen.race.mechanics.attributeBonuses,
          classHp: chosen.level.mechanics.hpGain, raceSpeed: chosen.race.mechanics.speed,
          proficiencyBonus: chosen.level.mechanics.proficiencyBonus, spellcastingAttribute: chosen.klass.mechanics.primaryAttribute });
        const grants = grantsFor(chosen.background, selections.starterGrant);
        const campaignCharacterId = resourceIdSchema.parse(dependencies.ids.nextId());
        const sheetId = resourceIdSchema.parse(dependencies.ids.nextId());
        const actorId = resourceIdSchema.parse(dependencies.ids.nextId());
        const commandId = resourceIdSchema.parse(dependencies.ids.nextId());
        const eventId = resourceIdSchema.parse(dependencies.ids.nextId());
        db.prepare("INSERT INTO campaign_characters (id,campaign_id,character_id,created_at,updated_at) VALUES (?,?,?,?,?)")
          .run(campaignCharacterId, row.campaign_id, row.persona_id, now, now);
        db.prepare(`INSERT INTO rpg_campaign_sheets (id,campaign_id,campaign_character_id,race_pack_id,race_pack_version,race_kind,race_definition_id,
          background_pack_id,background_pack_version,background_kind,background_definition_id,created_at,updated_at)
          VALUES (?,?,?,?,?,'race',?,?,?,'background',?,?,?)`).run(sheetId, row.campaign_id, campaignCharacterId,
            chosen.race.reference.packId, chosen.race.reference.packVersion, chosen.race.reference.definitionId,
            chosen.background.reference.packId, chosen.background.reference.packVersion, chosen.background.reference.definitionId, now, now);
        db.prepare(`INSERT INTO rpg_character_classes (campaign_id,sheet_id,position,pack_id,pack_version,kind,definition_id,level)
          VALUES (?,?,0,?,?,'class',?,1)`).run(row.campaign_id, sheetId, chosen.klass.reference.packId, chosen.klass.reference.packVersion, chosen.klass.reference.definitionId);
        const attributeInsert = db.prepare("INSERT INTO rpg_character_attributes (campaign_id,sheet_id,position,attribute_id,value) VALUES (?,?,?,?,?)");
        CHARACTER_BUILDER_ATTRIBUTE_IDS.forEach((attributeId, position) => attributeInsert.run(row.campaign_id, sheetId, position, attributeId,
          allocation.scores[attributeId] + (chosen.race.mechanics.attributeBonuses[attributeId] ?? 0)));
        const proficiencyInsert = db.prepare("INSERT INTO rpg_character_proficiencies (campaign_id,sheet_id,position,category,proficiency_id) VALUES (?,?,?,?,?)");
        const proficiencies = [
          ...chosen.background.mechanics.skillRefs.map((reference) => ({ category: "skill", id: reference.definitionId })),
          ...chosen.klass.mechanics.savingAttributes.map((attributeId) => ({ category: "saving-throw", id: attributeId })),
        ];
        [...new Map(proficiencies.map((value) => [`${value.category}\0${value.id}`, value])).values()].forEach((value, position) =>
          proficiencyInsert.run(row.campaign_id, sheetId, position, value.category, value.id));
        const choiceInsert = db.prepare(`INSERT INTO rpg_character_choices
          (campaign_id,sheet_id,position,choice_id,pack_id,pack_version,kind,definition_id) VALUES (?,?,?,?,?,?,?,?)`);
        [chosen.race.reference, chosen.background.reference, chosen.klass.reference].forEach((reference, position) =>
          choiceInsert.run(row.campaign_id, sheetId, position, ["race", "background", "class"][position], reference.packId, reference.packVersion, reference.kind, reference.definitionId));
        db.prepare(`INSERT INTO campaign_actors (id,campaign_id,campaign_character_id,sheet_id,kind,control,created_at,updated_at)
          VALUES (?,?,?,?,'player-character','principal',?,?)`).run(actorId, row.campaign_id, campaignCharacterId, sheetId, now, now);
        db.prepare("INSERT INTO campaign_actor_private_state (actor_id,campaign_id,controller_principal_id,private_notes) VALUES (?,?,?,NULL)")
          .run(actorId, row.campaign_id, row.controller_principal_id);
        db.prepare("INSERT INTO rpg_actor_resources (campaign_id,actor_id,name,current,max) VALUES (?,?,'health',?,?)")
          .run(row.campaign_id, actorId, derived.maxHp, derived.maxHp);
        db.prepare(`INSERT INTO character_derived_snapshots_v19
          (draft_id,campaign_id,campaign_character_id,sheet_id,actor_id,calculator_version,derived_json,created_at)
          VALUES (?,?,?,?,?,'velvet-character-derived-v1',?,?)`).run(id, row.campaign_id, campaignCharacterId, sheetId, actorId, canonicalCatalogJson(derived), now);
        initializeCharacterProgressionV24(db,{campaignCharacterId,campaignId:row.campaign_id,sheetId,actorId,
          classRef:{packId:chosen.klass.reference.packId,packVersion:chosen.klass.reference.packVersion,definitionId:chosen.klass.reference.definitionId},derived,now,mode:normalized.progressionMode??"xp"});
        const grantInsert = db.prepare(`INSERT INTO character_starting_grants_v19
          (draft_id,position,kind,pack_id,pack_version,definition_id,amount,source,grant_json) VALUES (?,?,?,?,?,?,?,?,?)`);
        grants.forEach((grant, position) => grantInsert.run(id, position, grant.kind, grant.reference.packId, grant.reference.packVersion,
          grant.reference.definitionId, grant.kind === "item" ? grant.quantity : grant.amount, grant.source, canonicalCatalogJson(grant)));
        db.prepare("UPDATE character_drafts_v19 SET status='finalized',revision=revision+1,updated_at=? WHERE id=?").run(now, id);
        const draft = buildView(db, rowFor(db, id)!, auth.role, now);
        const receipt = characterFinalizationReceiptSchema.parse({ draftId: id, commandId, eventId, idempotencyKey: normalized.idempotencyKey,
          revisionBefore: row.revision, revisionAfter: row.revision + 1, occurredAt: now,
          campaignCharacterId, sheetId, actorId, derived, startingGrants: grants });
        const result = characterDraftFinalizationResultSchema.parse({ draft, receipt });
        insertAudit(db, { draftId: id, commandId, eventId, campaignId: row.campaign_id, actor, idempotencyKey: normalized.idempotencyKey,
          type: "finalize", expectedRevision: row.revision, requested, revisionAfter: row.revision + 1, occurredAt: now, result });
        return result;
      }).immediate();
    },
    getCharacterDraftReceipt(actorPrincipalId, draftId, commandId) {
      const found = getAuthorized(actorPrincipalId, draftId); if (!found) return null;
      const id = resourceIdSchema.parse(commandId);
      const row = db.prepare(`SELECT command.type,command.draft_id,command.command_id,command.campaign_id,receipt.result_json FROM character_draft_commands_v19 command
        JOIN character_draft_receipts_v19 receipt ON receipt.draft_id=command.draft_id AND receipt.command_id=command.command_id
        JOIN character_draft_command_provenance_v20 proposal ON proposal.draft_id=command.draft_id AND proposal.command_id=command.command_id
          AND proposal.proposed_event_id=receipt.event_id AND proposal.proposed_result_json=receipt.result_json
        JOIN character_draft_revisions_v19 history ON history.draft_id=receipt.draft_id AND history.command_id=receipt.command_id
          AND history.revision=receipt.revision_after AND history.snapshot_json=receipt.result_json->>'$.draft'
        WHERE command.draft_id=? AND command.command_id=? AND command.campaign_id=?`).get(found.row.id, id, found.row.campaign_id) as
          { type: string; draft_id:string; command_id:string; campaign_id:string; result_json: string } | undefined;
      if (!row) return null;
      const result = JSON.parse(row.result_json) as { receipt: unknown };
      const receipt = row.type === "finalize" ? characterFinalizationReceiptSchema.parse(result.receipt) : characterDraftMutationReceiptSchema.parse(result.receipt);
      if(row.draft_id!==found.row.id||row.command_id!==id||row.campaign_id!==found.row.campaign_id
        ||receipt.draftId!==found.row.id||receipt.commandId!==id)throw new Error("character draft receipt path binding is malformed");
      return receipt;
    },
  };
}
