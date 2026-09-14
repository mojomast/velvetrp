import type DatabaseDriver from "better-sqlite3";
import { resolveCampaignRuleset } from "../../rulesets/campaignBinding.js";
import { resolveSrdEquipment } from "../srdEquipmentRuntime.js";
import {
  progressionPendingChoiceSchema,
  progressionReceiptSchema,
  progressionEventSchema,
  progressionStateSchema,
  resourceIdSchema,
  type ProgressionEvent,
  type ProgressionPreview,
  type ProgressionReceipt,
  type ProgressionSelection,
  type ProgressionState,
} from "@velvet/contracts";
import { progressionCatalogDigest, progressionReferenceKey } from "../../characterProgressionCatalog.js";
import { canonicalCatalogJson } from "../contentCatalog/index.js";
import {
  calculateAuthoritativeProgressionPreview,
  expectedKnownPowerSources,
  loadCanonicalProgressionProfile,
  loadExactProgressionCatalog,
  readKnownPowerReferences,
  type ProgressionRootRow,
} from "../characterProgressionPersistence.js";

type Role = "owner" | "gm" | "player" | "observer";

  /** Reads the durably persisted known feat/subclass references for a character. */
  function readKnownOptionReferences(db: DatabaseDriver.Database, characterId: string) {
    return (db.prepare("SELECT kind,pack_id,pack_version,definition_id FROM character_known_options_v25 WHERE campaign_character_id=? ORDER BY kind,pack_id,pack_version,definition_id")
      .all(characterId) as Array<any>).map((option) => ({ kind: option.kind, packId: option.pack_id, packVersion: option.pack_version, definitionId: option.definition_id }));
  }

  /** Reads additive per-class levels from the sheet's durable class rows. */
  function readClassLevels(db: DatabaseDriver.Database, row: ProgressionRootRow) {
    return (db.prepare("SELECT pack_id,pack_version,definition_id,level FROM rpg_character_classes WHERE campaign_id=? AND sheet_id=? ORDER BY position")
      .all(row.campaign_id, row.sheet_id) as Array<any>)
      .map((entry) => ({ classRef: { kind: "class" as const, packId: entry.pack_id as string, packVersion: entry.pack_version as string, definitionId: entry.definition_id as string }, level: entry.level as number }))
      .sort((left, right) => progressionReferenceKey(left.classRef).localeCompare(progressionReferenceKey(right.classRef)));
  }

  /** Derives additive multiclass proficiency grants from immutable advancements. */
  function readKnownProficiencies(db: DatabaseDriver.Database, characterId: string) {
    const granted = new Set<string>();
    for (const advancement of db.prepare("SELECT changes_json FROM character_level_advancements_v23 WHERE campaign_character_id=? ORDER BY level")
      .all(characterId) as Array<{ changes_json: string }>) {
      for (const entry of JSON.parse(advancement.changes_json).grantedProficiencies ?? []) granted.add(entry);
    }
    return [...granted].sort();
  }

/** Read collaborators shared by the public progression queries and commands. */
export interface CharacterProgressionReadRepository {
  rootFor(campaignCharacterId: string): ProgressionRootRow | undefined;
  authority(principal: string, row: ProgressionRootRow): Role | null;
  getAuthorized(actorPrincipalId: string, campaignCharacterId: string): ProgressionRootRow | null;
  getState(row: ProgressionRootRow, pendingOverride?: ProgressionPreview["pendingChoices"]): ProgressionState;
  getPreview(row: ProgressionRootRow, selections?: ProgressionSelection[]): ProgressionPreview;
  getValidatedKnownPowers(row: ProgressionRootRow): ReturnType<typeof readKnownPowerReferences>;
  getCharacterProgression(actorPrincipalId: string, campaignCharacterId: string): ProgressionState | null;
  previewCharacterProgression(actorPrincipalId: string, campaignCharacterId: string, selections?: ProgressionSelection[]): ProgressionPreview | null;
  getCharacterProgressionReceipt(actorPrincipalId: string, campaignCharacterId: string, commandId: string): ProgressionReceipt | null;
  listCharacterProgressionEvents(actorPrincipalId: string, campaignCharacterId: string): ProgressionEvent[];
}

/** Creates authoritative, actor-authorized progression read projections. */
export function createCharacterProgressionReadRepository(db: DatabaseDriver.Database): CharacterProgressionReadRepository {
  /** Loads only progression rows with their required bootstrap provenance. */
  const rootFor = (campaignCharacterId: string): ProgressionRootRow | undefined => db.prepare(`SELECT root.* FROM character_progression_v23 root
    JOIN character_progression_bootstrap_v24 bootstrap ON bootstrap.campaign_character_id=root.campaign_character_id WHERE root.campaign_character_id=?`).get(campaignCharacterId) as ProgressionRootRow | undefined;
  /** Resolves campaign access, including the player controller restriction. */
  const authority = (principal: string, row: ProgressionRootRow): Role | null => {
    const membership = db.prepare(`SELECT membership.role,state.controller_principal_id FROM campaign_memberships membership
      JOIN campaign_actor_private_state state ON state.campaign_id=membership.campaign_id AND state.actor_id=? WHERE membership.campaign_id=? AND membership.principal_id=?`)
      .get(row.actor_id, row.campaign_id, principal) as { role: Role; controller_principal_id: string } | undefined;
    if (!membership || membership.role === "observer") return null;
    if (membership.role === "player" && membership.controller_principal_id !== principal) return null;
    return membership.role;
  };
  /** Loads an authorized root after validating externally supplied resource IDs. */
  const getAuthorized = (actorPrincipalId: string, campaignCharacterId: string): ProgressionRootRow | null => {
    const actor = resourceIdSchema.parse(actorPrincipalId);
    const id = resourceIdSchema.parse(campaignCharacterId);
    const row = rootFor(id);
    return !row || !authority(actor, row) ? null : row;
  };
  /** Verifies the persisted pending-choice snapshot against the authoritative calculator. */
  const pendingFor = (row: ProgressionRootRow): ProgressionPreview["pendingChoices"] => {
    const stored = db.prepare("SELECT pending_json,pending_digest FROM character_progression_pending_snapshots_v24 WHERE campaign_character_id=? AND revision=?")
      .get(row.campaign_character_id, row.revision) as { pending_json: string; pending_digest: string } | undefined;
    const expected = calculateAuthoritativeProgressionPreview(db, row).pendingChoices;
    const expectedJson = canonicalCatalogJson(expected);
    if (!stored || stored.pending_json !== expectedJson || stored.pending_digest !== progressionCatalogDigest(expected)) throw new Error("progression pending choice provenance is inconsistent");
    return expected.map((choice) => progressionPendingChoiceSchema.parse(choice));
  };
  /** Ensures every known power has exact, reconstructable source provenance. */
  const assertPowerProvenance = (row: ProgressionRootRow): void => {
    const catalog = loadExactProgressionCatalog(db, row);
    const expected = expectedKnownPowerSources(db, row, catalog);
    const actual = db.prepare(`SELECT power.kind,power.pack_id,power.pack_version,power.definition_id,source.source_kind,source.source_reference_json,source.source_digest
      FROM character_known_powers_v23 power LEFT JOIN character_known_power_sources_v24 source ON source.campaign_character_id=power.campaign_character_id
        AND source.kind=power.kind AND source.pack_id=power.pack_id AND source.pack_version=power.pack_version AND source.definition_id=power.definition_id
      WHERE power.campaign_character_id=?`).all(row.campaign_character_id) as Array<any>;
    if (actual.length !== expected.size) throw new Error("known power provenance is incomplete");
    for (const power of actual) {
      const key = progressionReferenceKey({ kind: power.kind, packId: power.pack_id, packVersion: power.pack_version, definitionId: power.definition_id });
      const source = expected.get(key);
      if (!source || power.source_kind !== source.sourceKind || power.source_reference_json !== canonicalCatalogJson(source.sourceReference) || power.source_digest !== progressionCatalogDigest(source.sourceReference)) throw new Error("known power exact source provenance is inconsistent");
    }
  };
  /** Reuses the progression projection's exact provenance closure for consumers. */
  const getValidatedKnownPowers = (row: ProgressionRootRow): ReturnType<typeof readKnownPowerReferences> => {
    assertPowerProvenance(row);
    return readKnownPowerReferences(db, row.campaign_character_id);
  };
  /** Ensures every known feat/subclass still matches its exact advancement choice. */
  const assertOptionProvenance = (row: ProgressionRootRow): void => {
    const options = db.prepare(`SELECT kind,pack_id,pack_version,definition_id,source_level,source_choice_id
      FROM character_known_options_v25 WHERE campaign_character_id=?`).all(row.campaign_character_id) as Array<any>;
    if (options.length === 0) return;
    const advancements = db.prepare(`SELECT level,selections_json,changes_json FROM character_level_advancements_v23
      WHERE campaign_character_id=?`).all(row.campaign_character_id) as Array<any>;
    const byLevel = new Map(advancements.map((advancement) => [advancement.level, advancement]));
    for (const option of options) {
      const advancement = byLevel.get(option.source_level);
      if (!advancement) throw new Error("known option provenance is incomplete");
      const reference = { kind: option.kind, packId: option.pack_id, packVersion: option.pack_version, definitionId: option.definition_id };
      const key = progressionReferenceKey(reference);
      const changes = JSON.parse(advancement.changes_json);
      const selected = option.kind === "feat" ? (changes.selectedFeats ?? []) : (changes.selectedSubclasses ?? []);
      if (!selected.some((value: any) => progressionReferenceKey(value) === key)) throw new Error("known option advancement provenance is inconsistent");
      const selections = JSON.parse(advancement.selections_json) as Array<any>;
      if (!selections.some((value) => value.choiceId === option.source_choice_id && progressionReferenceKey(value.ability) === key)) {
        throw new Error("known option selection provenance is inconsistent");
      }
    }
  };
  /** Reuses the option provenance closure before surfacing known feats/subclasses. */
  const getValidatedKnownOptions = (row: ProgressionRootRow): ReturnType<typeof readKnownOptionReferences> => {
    assertOptionProvenance(row);
    return readKnownOptionReferences(db, row.campaign_character_id);
  };
  /** Builds and validates the current authoritative progression state. */
  const getState = (row: ProgressionRootRow, pendingOverride?: ProgressionPreview["pendingChoices"]): ProgressionState => {
    loadCanonicalProgressionProfile(db, row.profile_id);
    const refs = getValidatedKnownPowers(row);
    const optionRefs = getValidatedKnownOptions(row);
    const catalog = loadExactProgressionCatalog(db, row);
    const derived = JSON.parse(row.derived_json);
    if (resolveCampaignRuleset(db, row.campaign_id).rulesetId === "dnd-5e") {
      derived.armorClass = resolveSrdEquipment(db, row.campaign_id, row.actor_id).armorClass;
    }
    const classLevels = readClassLevels(db, row), knownProficiencies = readKnownProficiencies(db, row.campaign_character_id);
    return progressionStateSchema.parse({ campaignCharacterId: row.campaign_character_id, campaignId: row.campaign_id, sheetId: row.sheet_id, actorId: row.actor_id,
       profile: loadCanonicalProgressionProfile(db, row.profile_id), classRef: { kind: "class", packId: row.class_pack_id, packVersion: row.class_pack_version, definitionId: row.class_definition_id }, raceRef: catalog.raceRef, race: catalog.selectedRace,
      level: row.level, totalXp: row.total_xp, milestoneCount: row.milestone_count, revision: row.revision, pendingChoices: pendingOverride ?? pendingFor(row),
      knownAbilities: refs.filter((ref) => ref.kind === "ability"), knownSpells: refs.filter((ref) => ref.kind === "spell"),
      knownFeats: optionRefs.filter((ref) => ref.kind === "feat"), knownSubclasses: optionRefs.filter((ref) => ref.kind === "subclass"),
      ...(classLevels.length > 1 ? { classLevelsByClass: classLevels } : {}),
      ...(knownProficiencies.length ? { knownProficiencies } : {}),
      derived, updatedAt: row.updated_at });
  };
  /** Delegates previews to the shared persistence-backed authoritative calculator. */
  const getPreview = (row: ProgressionRootRow, selections: ProgressionSelection[] = []): ProgressionPreview => calculateAuthoritativeProgressionPreview(db, row, selections);
  /** Reads an actor-authorized current progression state. */
  const getCharacterProgression = (actorPrincipalId: string, campaignCharacterId: string): ProgressionState | null => {
    const row = getAuthorized(actorPrincipalId, campaignCharacterId);
    return row ? getState(row) : null;
  };
  /** Previews advancement for an actor-authorized progression state. */
  const previewCharacterProgression = (actorPrincipalId: string, campaignCharacterId: string, selections: ProgressionSelection[] = []): ProgressionPreview | null => {
    const row = getAuthorized(actorPrincipalId, campaignCharacterId);
    return row ? getPreview(row, selections) : null;
  };
  /** Reads a path-bound command receipt for an authorized character. */
  const getCharacterProgressionReceipt = (actorPrincipalId: string, campaignCharacterId: string, commandId: string): ProgressionReceipt | null => {
    const row = getAuthorized(actorPrincipalId, campaignCharacterId);
    if (!row) return null;
    const id = resourceIdSchema.parse(commandId);
    const receipt = db.prepare(`SELECT receipt.result_json FROM character_progression_receipts_v23 receipt JOIN character_progression_command_proposals_v24 proposal ON proposal.campaign_character_id=receipt.campaign_character_id AND proposal.command_id=receipt.command_id AND proposal.proposed_result_json=receipt.result_json JOIN character_progression_events_v24 event ON event.campaign_character_id=receipt.campaign_character_id AND event.command_id=receipt.command_id AND event.event_id=proposal.proposed_event_id WHERE receipt.campaign_character_id=? AND receipt.command_id=?`).get(row.campaign_character_id, id) as { result_json: string } | undefined;
    return receipt ? progressionReceiptSchema.parse(JSON.parse(receipt.result_json).receipt) : null;
  };
  /** Lists actor-authorized immutable progression events in revision order. */
  const listCharacterProgressionEvents = (actorPrincipalId: string, campaignCharacterId: string): ProgressionEvent[] => {
    const row = getAuthorized(actorPrincipalId, campaignCharacterId);
    if (!row) return [];
    return (db.prepare("SELECT event_id,command_id,type,revision,occurred_at,public_data FROM character_progression_events_v24 WHERE campaign_character_id=? ORDER BY revision").all(row.campaign_character_id) as Array<any>).map((event) => progressionEventSchema.parse({ eventId: event.event_id, commandId: event.command_id, campaignCharacterId: row.campaign_character_id, type: event.type, revision: event.revision, occurredAt: event.occurred_at, publicData: JSON.parse(event.public_data) }));
  };
  return { rootFor, authority, getAuthorized, getState, getPreview, getValidatedKnownPowers, getCharacterProgression, previewCharacterProgression, getCharacterProgressionReceipt, listCharacterProgressionEvents };
}
