import type DatabaseDriver from "better-sqlite3";
import {
  characterBuilderAllocationSchema,
  characterBuilderCompletionSchema,
  characterBuilderSelectionsSchema,
  characterDraftPinSchema,
  characterDraftViewSchema,
  type CatalogDefinition,
  type CharacterDraftPin,
  type CharacterDraftView,
  type CharacterStartingGrant,
} from "@velvet/contracts";
import { calculateCharacterDerivedStats } from "../../characterBuilderCalculator.js";

/** Campaign membership roles that can be represented in a draft view. */
export type CharacterBuilderRole = "owner" | "gm" | "player" | "observer";

/** Raw `character_drafts_v19` database projection. */
export interface DraftRow {
  id: string; campaign_id: string; persona_id: string; controller_principal_id: string; created_by_principal_id: string;
  status: "active" | "abandoned" | "finalized"; durability: "durable" | "expiring"; expires_at: string | null;
  revision: number; rules_profile_id: string; allocation_json: string; selections_json: string; created_at: string; updated_at: string;
}

type RaceCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "race" } }>;
type BackgroundCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "background" } }>;
type ClassCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "class" } }>;
type ClassLevelCatalogDefinition = Extract<CatalogDefinition, { reference: { kind: "class-level" } }>;
type SelectedDefinitions = {
  race: RaceCatalogDefinition;
  background: BackgroundCatalogDefinition;
  klass: ClassCatalogDefinition;
  level: ClassLevelCatalogDefinition;
};

/** Collaborators used to map a persisted draft to its authoritative view. */
export interface CharacterBuilderViewMappers {
  catalogForPins(db: DatabaseDriver.Database, rulesProfileId: string, pins: CharacterDraftPin[]): CatalogDefinition[];
  pinsMatchCurrent(db: DatabaseDriver.Database, campaignId: string, rulesProfileId: string, pins: CharacterDraftPin[]): boolean;
  selectedDefinitions(
    definitions: CatalogDefinition[],
    selections: ReturnType<typeof characterBuilderSelectionsSchema.parse>,
  ): SelectedDefinitions | null;
  grantsFor(background: BackgroundCatalogDefinition, choice: "kit" | "currency"): CharacterStartingGrant[];
}

/** Reads a draft's raw database projection by identifier. */
export function rowFor(db: DatabaseDriver.Database, draftId: string): DraftRow | undefined {
  return db.prepare(`SELECT draft.*,COALESCE((SELECT reroll.allocation_json FROM character_draft_rerolls_v49 reroll
    WHERE reroll.draft_id=draft.id ORDER BY reroll.revision DESC LIMIT 1),draft.allocation_json) allocation_json
    FROM character_drafts_v19 draft WHERE draft.id=?`).get(draftId) as DraftRow | undefined;
}

/** Resolves the latest immutable reroll, falling back to the creation allocation. */
export function allocationFor(db: DatabaseDriver.Database, row: DraftRow) {
  const reroll = db.prepare("SELECT allocation_json FROM character_draft_rerolls_v49 WHERE draft_id=? ORDER BY revision DESC LIMIT 1")
    .get(row.id) as { allocation_json: string } | undefined;
  return characterBuilderAllocationSchema.parse(JSON.parse(reroll?.allocation_json ?? row.allocation_json));
}

/** Reads and validates the ordered content-publication pins stored for a draft. */
export function pinsFor(db: DatabaseDriver.Database, draftId: string): CharacterDraftPin[] {
  return (db.prepare(`SELECT pack_id,pack_version,publication_digest FROM character_draft_pins_v19 WHERE draft_id=? ORDER BY position`).all(draftId) as Array<{ pack_id: string; pack_version: string; publication_digest: string }>).map((row) =>
    characterDraftPinSchema.parse({ packId: row.pack_id, packVersion: row.pack_version, publicationDigest: row.publication_digest }));
}

/** Maps a persisted draft and its pinned catalog state to the validated public draft view. */
export function buildView(
  db: DatabaseDriver.Database,
  row: DraftRow,
  role: CharacterBuilderRole,
  now: string,
  mappers: CharacterBuilderViewMappers,
): CharacterDraftView {
  const pins = pinsFor(db, row.id);
  const allocation = allocationFor(db, row);
  const selections = characterBuilderSelectionsSchema.parse(JSON.parse(row.selections_json));
  const definitions = mappers.catalogForPins(db, row.rules_profile_id, pins);
  const effectiveExpiry = row.expires_at !== null && row.expires_at <= now;
  let pinChanged = false;
  try { pinChanged = !mappers.pinsMatchCurrent(db, row.campaign_id, row.rules_profile_id, pins); } catch { pinChanged = true; }
  const chosen = mappers.selectedDefinitions(definitions, selections);
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
    .get(row.campaign_id, row.controller_principal_id) as { role: CharacterBuilderRole; parent_id: string | null } | undefined;
  if (!controller || controller.parent_id !== row.controller_principal_id || !["owner", "gm", "player"].includes(controller.role)) {
    issues.push({ code: "controller-unavailable", path: "controllerPrincipalId", message: "The selected controller is no longer eligible." });
  }
  if (selections.race && selections.background && selections.class && selections.starterGrant && !chosen) {
    issues.push({ code: "definition-unavailable", path: "selections", message: "A selected definition is unavailable or not a valid level-one choice." });
  }
  const derived = chosen ? calculateCharacterDerivedStats({ scores: allocation.scores, racialBonuses: chosen.race.mechanics.attributeBonuses,
    classHp: chosen.level.mechanics.hpGain, raceSpeed: chosen.race.mechanics.speed,
    proficiencyBonus: chosen.level.mechanics.proficiencyBonus, spellcastingAttribute: chosen.klass.mechanics.primaryAttribute }) : null;
  const grants = chosen && selections.starterGrant ? mappers.grantsFor(chosen.background, selections.starterGrant) : [];
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
