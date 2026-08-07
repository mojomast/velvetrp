import type DatabaseDriver from "better-sqlite3";
import {
  backgroundCatalogDefinitionSchema,
  catalogDefinitionSchema,
  characterBuilderSelectionsSchema,
  characterDraftMutationReceiptSchema,
  characterDraftPinSchema,
  characterFinalizationReceiptSchema,
  characterStartingGrantSchema,
  classCatalogDefinitionSchema,
  classLevelCatalogDefinitionSchema,
  raceCatalogDefinitionSchema,
  resourceIdSchema,
  utcIsoTimestampSchema,
  type CatalogDefinition,
  type CharacterDraftPin,
  type CharacterDraftMutationReceipt,
  type CharacterDraftView,
  type CharacterStartingGrant,
} from "@velvet/contracts";
import type { Clock } from "../../runtime.js";
import { canonicalCatalogJson } from "../contentCatalog/index.js";
import { CharacterBuilderConflictError, CharacterBuilderUnavailableError } from "./characterBuilderErrors.js";
import { buildView, pinsFor, rowFor, type CharacterBuilderRole, type CharacterBuilderViewMappers, type DraftRow } from "./characterBuilderRowTypes.js";

type Role = CharacterBuilderRole;
type RaceCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "race" } }>;
type BackgroundCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "background" } }>;
type ClassCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "class" } }>;
type ClassLevelCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "class-level" } }>;
export interface CharacterBuilderAuthority { role: Role; ownerPrincipalId: string }
export interface CharacterBuilderCatalogContext { rulesProfileId: string; pins: CharacterDraftPin[]; definitions: CatalogDefinition[]; }

/** Dependencies required by non-mutating character-builder operations. */
export interface CharacterBuilderReadDependencies { clock: Clock; }

/** The actor-authorized reads and authoritative lookup helpers for character drafts. */
export interface CharacterBuilderReadRepository {
  authority(actorPrincipalId: string, campaignId: string): CharacterBuilderAuthority | null;
  mayControl(actor: string, auth: CharacterBuilderAuthority, controller: string): boolean;
  validateController(campaignId: string, controller: string): Role;
  validatePersona(campaignId: string, personaId: string, now: string, exceptDraftId?: string): void;
  currentCatalog(campaignId: string): CharacterBuilderCatalogContext;
  catalogForPins(rulesProfileId: string, pins: CharacterDraftPin[]): CatalogDefinition[];
  refKey(reference: { packId: string; packVersion: string; kind: string; definitionId: string }): string;
  selectedDefinitions(definitions: CatalogDefinition[], selections: ReturnType<typeof characterBuilderSelectionsSchema.parse>): {
    race: RaceCatalogDefinition; background: BackgroundCatalogDefinition; klass: ClassCatalogDefinition; level: ClassLevelCatalogDefinition;
  } | null;
  grantsFor(background: BackgroundCatalogDefinition, choice: "kit" | "currency"): CharacterStartingGrant[];
  samePins(current: CharacterBuilderCatalogContext, rulesProfileId: string, pins: CharacterDraftPin[]): boolean;
  viewMappers: CharacterBuilderViewMappers;
  getAuthorized(actorPrincipalId: string, draftId: string): { row: DraftRow; auth: CharacterBuilderAuthority } | null;
  getCharacterDraft(actorPrincipalId: string, draftId: string): CharacterDraftView | null;
  getCharacterDraftReceipt(actorPrincipalId: string, draftId: string, commandId: string): CharacterDraftMutationReceipt | import("@velvet/contracts").CharacterFinalizationReceipt | null;
}

/** Creates the database-backed read, authorization, and catalog helpers for character drafts. */
export function createCharacterBuilderReadRepository(db: DatabaseDriver.Database, dependencies: CharacterBuilderReadDependencies): CharacterBuilderReadRepository {
  /** Resolves a campaign member's authority while verifying the campaign owner invariant. */
  const authority = (actorPrincipalId: string, campaignId: string): CharacterBuilderAuthority | null => {
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
    if (row.owner_count !== 1 || row.owner_id !== row.owner_principal_id || row.owner_parent_id !== row.owner_principal_id || row.owner_role !== "owner") throw new Error("campaign owner authority is malformed");
    if (row.role === "owner" && actorPrincipalId !== row.owner_principal_id) throw new Error("campaign owner pointer is malformed");
    return { role: row.role, ownerPrincipalId: row.owner_principal_id };
  };
  /** Tests whether campaign authority permits controlling the given draft controller. */
  const mayControl = (actor: string, auth: CharacterBuilderAuthority, controller: string): boolean => auth.role === "owner" || auth.role === "gm" || (auth.role === "player" && actor === controller);
  /** Validates that a draft controller remains an eligible campaign member. */
  const validateController = (campaignId: string, controller: string): Role => {
    const row = db.prepare(`SELECT membership.role,principal.id parent_id FROM campaign_memberships membership LEFT JOIN principals principal ON principal.id=membership.principal_id WHERE membership.campaign_id=? AND membership.principal_id=?`).get(campaignId, controller) as { role: Role; parent_id: string | null } | undefined;
    if (!row || row.parent_id !== controller || !["owner", "gm", "player"].includes(row.role)) throw new CharacterBuilderUnavailableError("draft controller is not an eligible campaign member");
    return row.role;
  };
  /** Validates that a persona is eligible and has no competing campaign character or draft. */
  const validatePersona = (campaignId: string, personaId: string, now: string, exceptDraftId?: string): void => {
    const persona = db.prepare("SELECT fictional_confirmed,is_real_person FROM characters WHERE id=?").get(personaId) as { fictional_confirmed: number; is_real_person: number } | undefined;
    if (!persona || persona.fictional_confirmed !== 1 || persona.is_real_person !== 0) throw new CharacterBuilderUnavailableError("persona is not eligible for campaign play");
    if (db.prepare("SELECT 1 FROM campaign_characters WHERE campaign_id=? AND character_id=?").get(campaignId, personaId)) throw new CharacterBuilderConflictError("persona already has a campaign character");
    const competing = db.prepare(`SELECT id FROM character_drafts_v19 WHERE campaign_id=? AND persona_id=? AND status='active' AND id<>coalesce(?, '') AND (durability='durable' OR expires_at>?) LIMIT 1`).get(campaignId, personaId, exceptDraftId ?? null, now);
    if (competing) throw new CharacterBuilderConflictError("persona already has an active character draft");
  };
  /** Reads the campaign's complete, validated content pins and builder definitions. */
  const currentCatalog = (campaignId: string): CharacterBuilderCatalogContext => {
    const selection = db.prepare(`SELECT rules_profile_id FROM campaign_catalog_current_selections WHERE campaign_id=?`).get(campaignId) as { rules_profile_id: string } | undefined;
    if (!selection) throw new CharacterBuilderUnavailableError("campaign requires validated-v1 content pins");
    const rows = db.prepare(`SELECT pin.position,pin.pack_id,pin.pack_version,publication.manifest_digest,publication.validation_level,pack.sealed,pack.rules_profile_id FROM campaign_catalog_current_pins pin LEFT JOIN rpg_content_pack_publications publication ON publication.pack_id=pin.pack_id AND publication.pack_version=pin.pack_version LEFT JOIN rpg_content_packs pack ON pack.pack_id=pin.pack_id AND pack.pack_version=pin.pack_version WHERE pin.campaign_id=? ORDER BY pin.position`).all(campaignId) as Array<{ position: number; pack_id: string; pack_version: string; manifest_digest: string | null; validation_level: string | null; sealed: number | null; rules_profile_id: string | null }>;
    if (!rows.length || rows.some((row, index) => row.position !== index || row.validation_level !== "validated-v1" || row.sealed !== 1 || row.rules_profile_id !== selection.rules_profile_id)) throw new CharacterBuilderUnavailableError("campaign validated-v1 pins are incomplete");
    const pins = rows.map((row) => characterDraftPinSchema.parse({ packId: row.pack_id, packVersion: row.pack_version, publicationDigest: row.manifest_digest }));
    const definitions: CatalogDefinition[] = []; const statement = db.prepare(`SELECT definition_json FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? AND kind IN ('race','background','class','class-level') ORDER BY kind COLLATE BINARY,definition_id COLLATE BINARY`);
    for (const pin of pins) for (const row of statement.all(pin.packId, pin.packVersion) as Array<{ definition_json: string }>) definitions.push(catalogDefinitionSchema.parse(JSON.parse(row.definition_json)));
    if (!definitions.some((value) => value.reference.kind === "race") || !definitions.some((value) => value.reference.kind === "background") || !definitions.some((value) => value.reference.kind === "class")) throw new CharacterBuilderUnavailableError("campaign catalog has no complete builder choices");
    return { rulesProfileId: selection.rules_profile_id, pins, definitions };
  };
  /** Reads the exact validated builder definitions represented by immutable draft pins. */
  const catalogForPins = (rulesProfileId: string, pins: CharacterDraftPin[]): CatalogDefinition[] => {
    const definitions: CatalogDefinition[] = []; const statement = db.prepare(`SELECT definition_json FROM rpg_catalog_definitions definition JOIN rpg_content_pack_publications publication ON publication.pack_id=definition.pack_id AND publication.pack_version=definition.pack_version JOIN rpg_content_packs pack ON pack.pack_id=publication.pack_id AND pack.pack_version=publication.pack_version WHERE definition.pack_id=? AND definition.pack_version=? AND publication.validation_level='validated-v1' AND publication.manifest_digest=? AND pack.sealed=1 AND pack.rules_profile_id=? AND definition.kind IN ('race','background','class','class-level') ORDER BY definition.kind COLLATE BINARY,definition.definition_id COLLATE BINARY`);
    for (const pin of pins) for (const row of statement.all(pin.packId, pin.packVersion, pin.publicationDigest, rulesProfileId) as Array<{ definition_json: string }>) definitions.push(catalogDefinitionSchema.parse(JSON.parse(row.definition_json)));
    return definitions;
  };
  /** Produces a stable map key for a catalog definition reference. */
  const refKey = (reference: { packId: string; packVersion: string; kind: string; definitionId: string }): string => `${reference.packId}\0${reference.packVersion}\0${reference.kind}\0${reference.definitionId}`;
  /** Resolves the selected race, background, class, and its unique level-one definition. */
  const selectedDefinitions = (definitions: CatalogDefinition[], selections: ReturnType<typeof characterBuilderSelectionsSchema.parse>): { race: RaceCatalogDefinition; background: BackgroundCatalogDefinition; klass: ClassCatalogDefinition; level: ClassLevelCatalogDefinition } | null => {
    if (!selections.race || !selections.background || !selections.class || !selections.starterGrant) return null;
    const map = new Map(definitions.map((definition) => [refKey(definition.reference), definition])); const race = raceCatalogDefinitionSchema.safeParse(map.get(refKey(selections.race))); const background = backgroundCatalogDefinitionSchema.safeParse(map.get(refKey(selections.background))); const klass = classCatalogDefinitionSchema.safeParse(map.get(refKey(selections.class)));
    if (!race.success || !background.success || !klass.success) return null;
    const levels = klass.data.mechanics.levelRefs.map((reference) => classLevelCatalogDefinitionSchema.safeParse(map.get(refKey(reference)))).filter((value): value is { success: true; data: ClassLevelCatalogDefinition } => value.success).filter((value) => value.data.mechanics.level === 1 && refKey(value.data.mechanics.classRef) === refKey(klass.data.reference));
    return levels.length === 1 ? { race: race.data, background: background.data, klass: klass.data, level: levels[0]!.data } : null;
  };
  /** Builds the starting grants granted by the selected background option. */
  const grantsFor = (background: BackgroundCatalogDefinition, choice: "kit" | "currency"): CharacterStartingGrant[] => choice === "kit" ? background.mechanics.itemRefs.map((reference) => characterStartingGrantSchema.parse({ kind: "item", reference, quantity: 1, source: "background-kit" })) : [characterStartingGrantSchema.parse({ kind: "currency", reference: background.mechanics.startingCurrency.currency, amount: background.mechanics.startingCurrency.amount, source: "background-currency" })];
  /** Compares draft pins to the campaign's current content selection. */
  const samePins = (current: CharacterBuilderCatalogContext, rulesProfileId: string, pins: CharacterDraftPin[]): boolean => current.rulesProfileId === rulesProfileId && canonicalCatalogJson(current.pins) === canonicalCatalogJson(pins);
  /** Supplies row mappers with catalog collaborators without importing command orchestration. */
  const viewMappers: CharacterBuilderViewMappers = { catalogForPins: (_db, rulesProfileId, pins) => catalogForPins(rulesProfileId, pins), pinsMatchCurrent: (_db, campaignId, rulesProfileId, pins) => samePins(currentCatalog(campaignId), rulesProfileId, pins), selectedDefinitions, grantsFor };
  /** Finds a draft and confirms that the actor may view or control it. */
  const getAuthorized = (actorPrincipalId: string, draftId: string): { row: DraftRow; auth: CharacterBuilderAuthority } | null => { const actor = resourceIdSchema.parse(actorPrincipalId); const id = resourceIdSchema.parse(draftId); const row = rowFor(db, id); if (!row) return null; const auth = authority(actor, row.campaign_id); return !auth || !mayControl(actor, auth, row.controller_principal_id) ? null : { row, auth }; };
  /** Reads the actor-authorized current public view for a character draft. */
  const getCharacterDraft = (actorPrincipalId: string, draftId: string): CharacterDraftView | null => { const found = getAuthorized(actorPrincipalId, draftId); if (!found) return null; const now = utcIsoTimestampSchema.parse(dependencies.clock.now().toISOString()); return db.transaction(() => buildView(db, rowFor(db, found.row.id)!, found.auth.role, now, viewMappers))(); };
  /** Reads an actor-authorized command receipt after validating its persisted path binding. */
  const getCharacterDraftReceipt = (actorPrincipalId: string, draftId: string, commandId: string): CharacterDraftMutationReceipt | import("@velvet/contracts").CharacterFinalizationReceipt | null => {
    const found = getAuthorized(actorPrincipalId, draftId); if (!found) return null; const id = resourceIdSchema.parse(commandId);
    const row = db.prepare(`SELECT command.type,command.draft_id,command.command_id,command.campaign_id,receipt.result_json FROM character_draft_commands_v19 command JOIN character_draft_receipts_v19 receipt ON receipt.draft_id=command.draft_id AND receipt.command_id=command.command_id JOIN character_draft_command_provenance_v20 proposal ON proposal.draft_id=command.draft_id AND proposal.command_id=command.command_id AND proposal.proposed_event_id=receipt.event_id AND proposal.proposed_result_json=receipt.result_json JOIN character_draft_revisions_v19 history ON history.draft_id=receipt.draft_id AND history.command_id=receipt.command_id AND history.revision=receipt.revision_after AND history.snapshot_json=receipt.result_json->>'$.draft' WHERE command.draft_id=? AND command.command_id=? AND command.campaign_id=?`).get(found.row.id, id, found.row.campaign_id) as { type: string; draft_id: string; command_id: string; campaign_id: string; result_json: string } | undefined;
    if (!row) return null; const result = JSON.parse(row.result_json) as { receipt: unknown }; const receipt = row.type === "finalize" ? characterFinalizationReceiptSchema.parse(result.receipt) : characterDraftMutationReceiptSchema.parse(result.receipt);
    if (row.draft_id !== found.row.id || row.command_id !== id || row.campaign_id !== found.row.campaign_id || receipt.draftId !== found.row.id || receipt.commandId !== id) throw new Error("character draft receipt path binding is malformed");
    return receipt;
  };
  return { authority, mayControl, validateController, validatePersona, currentCatalog, catalogForPins, refKey, selectedDefinitions, grantsFor, samePins, viewMappers, getAuthorized, getCharacterDraft, getCharacterDraftReceipt };
}
