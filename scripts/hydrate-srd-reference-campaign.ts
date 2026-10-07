#!/usr/bin/env node
/**
 * Provider-free reference-campaign hydrator for the current SRD 5.1 starter.
 *
 * Targets one existing campaign, configures the repository's own latest SRD
 * starter publication when the campaign is still empty, finalizes four durable
 * level-one characters (Fighter / Wizard / Rogue / Cleric) on the standard
 * array with the Acolyte background, attaches one active room, and publishes
 * the campaign. No provider is contacted; every mutation goes through the
 * public repository API.
 *
 * Idempotent per campaign, room, and character name: a resumed run returns the
 * existing report only after re-validating the named campaign characters and
 * the exact configured catalog version. A pre-mutation online backup, an
 * operator report, and quick_check/foreign_key_check evidence are always
 * produced. --validate-only skips backup and campaign mutations.
 *
 *   npx tsx scripts/hydrate-srd-reference-campaign.ts \
 *     --data-dir .velvet/bramps-camp \
 *     --campaign c6d5f901-3d14-4008-8395-932834e1b1f3 \
 *     [--room-title "Reference Room"] [--validate-only]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  CHARACTER_BUILDER_STANDARD_ARRAY,
  SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS,
  SRD_5_1_STARTER_PACK_ID,
  SRD_5_1_STARTER_RULES_PROFILE_ID,
  type CampaignContentConfiguration,
  type CharacterBuilderAttributeScores,
  type CharacterDraftMutationResult,
  type UpdateCharacterDraftInput,
} from "@velvet/contracts";
import {
  SRD_5_1_STARTER_CATALOG,
  closeRepo,
  createRepository,
  createSession,
  listCharacters,
  listSessions,
} from "../server/src/repo/index.js";

const OWNER = "local-owner";
const ACOLYTE_BACKGROUND_ID = "srd-5.1:background:acolyte";
const DND_5E = "dnd-5e";
const DND_5E_VERSION = "1.0.0";
const STANDARD_ARRAY = [...CHARACTER_BUILDER_STANDARD_ARRAY];

type PartyRole = "fighter" | "wizard" | "rogue" | "cleric";

interface PartyMemberPlan {
  role: PartyRole;
  label: string;
  classDefinitionId: string;
  /** Requested SRD ancestry; present in the current starter catalog. */
  ancestryDefinitionId: string;
  /** Bounded base ancestry used if a future catalog omits the composite option. */
  fallbackAncestryDefinitionId: string;
}

const PARTY: readonly PartyMemberPlan[] = [
  { role: "fighter", label: "Fighter", classDefinitionId: "srd-5.1:class:fighter",
    ancestryDefinitionId: "srd-5.1:race:hill-dwarf", fallbackAncestryDefinitionId: "srd-5.1:race:dwarf" },
  { role: "wizard", label: "Wizard", classDefinitionId: "srd-5.1:class:wizard",
    ancestryDefinitionId: "srd-5.1:race:high-elf", fallbackAncestryDefinitionId: "srd-5.1:race:elf" },
  { role: "rogue", label: "Rogue", classDefinitionId: "srd-5.1:class:rogue",
    ancestryDefinitionId: "srd-5.1:race:lightfoot-halfling", fallbackAncestryDefinitionId: "srd-5.1:race:halfling" },
  { role: "cleric", label: "Cleric", classDefinitionId: "srd-5.1:class:cleric",
    ancestryDefinitionId: "srd-5.1:race:rock-gnome", fallbackAncestryDefinitionId: "srd-5.1:race:gnome" },
];

export interface HydrateSrdReferenceCampaignOptions {
  dataDir: string;
  campaignId: string;
  roomTitle?: string;
  validateOnly?: boolean;
}

export interface HydratedActorReport {
  role: PartyRole;
  name: string;
  personaId: string;
  campaignCharacterId: string;
  actorId: string;
  level: number;
  maxHp: number;
  health: { current: number; max: number };
  classDefinitionId: string;
  backgroundDefinitionId: string;
  requestedAncestryDefinitionId: string;
  selectedAncestryDefinitionId: string;
  ancestryFallback: boolean;
  initialLocationId: string | null;
}

export interface HydrateSrdReferenceCampaignReport {
  status: "ready" | "existing" | "validated";
  dataDir: string;
  databasePath: string;
  backupPath: string | null;
  campaignId: string;
  campaignName: string;
  catalog: { packId: string; packVersion: string; rulesProfileId: string };
  roomTitle: string;
  roomTitleMatched: boolean;
  sessionId: string;
  sessionState: string;
  sessionAttached: boolean;
  campaignStatus: string;
  startingLocation: { locationId: string; name: string } | null;
  pinnedExecutableDefinitionCount: number;
  actors: HydratedActorReport[];
  counts: { campaignCharacters: number; campaignActors: number };
  integrity: { quickCheck: string; foreignKeyFindings: number };
  warnings: string[];
  assumptions: string[];
  createdAt: string;
}

export interface HydrateSrdReferenceCampaignResult {
  reportPath: string;
  report: HydrateSrdReferenceCampaignReport;
}

interface RawRulesetBinding {
  rulesetId: string;
  rulesetVersion: string;
}

interface RawInspection {
  campaignName: string | null;
  lifecycleStatus: string | null;
  administrationRevision: number | null;
  ownerPrincipalId: string | null;
  campaignCharacterCount: number;
  campaignActorCount: number;
  activeDraftCount: number;
  catalogRulesProfileId: string | null;
  catalogPins: Array<{ packId: string; packVersion: string }>;
  legacyRulesProfileId: string | null;
  legacyContentPackCount: number;
  rulesetBinding: RawRulesetBinding | null;
  reservedRuleset: { rulesetId: string | null; rulesetVersion: string | null };
  attachedSessions: Array<{ sessionId: string; state: string; attachedAt: string }>;
  quickCheck: string;
  foreignKeyFindings: number;
}

const ASSUMPTIONS: readonly string[] = [
  "SRD_5_1_STARTER_CATALOG.manifest.packVersion is the current latest expected catalog version; @velvet/contracts must be built so SRD_5_1_STARTER_PACK_VERSION matches this digest.",
  "configureSrdStarterCatalog expectedRevision is campaigns.administration_revision exposed as getCampaignAdministration(...).revision; it pins publicly reachable ability/spell refs automatically and is a one-time per-campaign command.",
  "createCharacterDraft/updateCharacterDraft/finalizeCharacterDraft are idempotent by idempotencyKey and replay the persisted result on retry.",
  "createSession/listCharacters/listSessions read the dataDir configured through VELVET_DATA_DIR; createRepository opens its own connection to the same velvet.sqlite.",
  "finalizeCharacterDraft calls placeFinalizedActorAtCampaignStartV51, which places an actor only when a campaign starting location exists and exactly one active attached session already exists.",
  "placeActor is the public GM bootstrap-placement API used for any actor still unplaced after finalization; it requires exactly one active attached session.",
  "The online backup uses better-sqlite3 db.backup from a read-only connection; integrity is verified with PRAGMA quick_check and foreign_key_check.",
  "Catalog configuration is treated as final: any existing catalog selection is preserved and never rebound.",
];

function fail(message: string): never {
  throw new Error(message);
}

function attributeScores(): CharacterBuilderAttributeScores {
  return Object.fromEntries(
    SRD_5_1_CHARACTER_BUILDER_ATTRIBUTE_IDS.map((key, index) => [key, STANDARD_ARRAY[index]!]),
  ) as CharacterBuilderAttributeScores;
}

interface CatalogReference {
  packId: string;
  packVersion: string;
  definitionId: string;
}

function catalogReference(kind: "race" | "background" | "class", definitionId: string): CatalogReference | null {
  const definition = SRD_5_1_STARTER_CATALOG.definitions.find(
    (candidate) => candidate.reference.kind === kind && candidate.reference.definitionId === definitionId,
  );
  if (!definition) return null;
  return { packId: definition.reference.packId, packVersion: definition.reference.packVersion, definitionId };
}

function hasTable(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

function countWhere(db: Database.Database, table: string, where: string, ...params: unknown[]): number {
  if (!hasTable(db, table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params) as { count: number };
  return row.count;
}

function readReservedRuleset(db: Database.Database, campaignId: string): { rulesetId: string | null; rulesetVersion: string | null } {
  if (!hasTable(db, "campaign_administration_integrations_v59")) return { rulesetId: null, rulesetVersion: null };
  const row = db.prepare(
    "SELECT ruleset_id AS rulesetId, ruleset_version AS rulesetVersion FROM campaign_administration_integrations_v59 WHERE campaign_id=?",
  ).get(campaignId) as { rulesetId: string | null; rulesetVersion: string | null } | undefined;
  return row ?? { rulesetId: null, rulesetVersion: null };
}

async function inspectAndBackup(databasePath: string, campaignId: string, backupPath: string | null): Promise<RawInspection> {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = (db.pragma("quick_check") as Array<{ quick_check: string }>)[0]?.quick_check ?? "unknown";
    const foreignKeyFindings = (db.pragma("foreign_key_check") as unknown[]).length;

    const campaign = db.prepare(
      "SELECT name, lifecycle_status, administration_revision, owner_principal_id FROM campaigns WHERE id=?",
    ).get(campaignId) as {
      name: string; lifecycle_status: string; administration_revision: number; owner_principal_id: string;
    } | undefined;

    const catalogRulesProfileId = hasTable(db, "campaign_catalog_current_selections")
      ? (db.prepare("SELECT rules_profile_id FROM campaign_catalog_current_selections WHERE campaign_id=?")
        .get(campaignId) as { rules_profile_id: string } | undefined)?.rules_profile_id ?? null
      : null;

    const catalogPins = hasTable(db, "campaign_catalog_current_pins")
      ? (db.prepare("SELECT pack_id, pack_version FROM campaign_catalog_current_pins WHERE campaign_id=? ORDER BY position")
        .all(campaignId) as Array<{ pack_id: string; pack_version: string }>)
        .map((row) => ({ packId: row.pack_id, packVersion: row.pack_version }))
      : [];

    const legacyRulesProfileId = hasTable(db, "campaign_rules_profiles")
      ? (db.prepare("SELECT rules_profile_id FROM campaign_rules_profiles WHERE campaign_id=?")
        .get(campaignId) as { rules_profile_id: string } | undefined)?.rules_profile_id ?? null
      : null;

    const rulesetBinding = hasTable(db, "campaign_ruleset_bindings_v60")
      ? (db.prepare("SELECT ruleset_id, ruleset_version FROM campaign_ruleset_bindings_v60 WHERE campaign_id=?")
        .get(campaignId) as { ruleset_id: string; ruleset_version: string } | undefined)
      : undefined;

    const attachedSessions = hasTable(db, "campaign_sessions") && hasTable(db, "sessions")
      ? (db.prepare(`SELECT attachment.session_id, session.state, attachment.attached_at
          FROM campaign_sessions attachment JOIN sessions session ON session.id=attachment.session_id
          WHERE attachment.campaign_id=? ORDER BY attachment.attached_at, attachment.session_id`)
        .all(campaignId) as Array<{ session_id: string; state: string; attached_at: string }>)
        .map((row) => ({ sessionId: row.session_id, state: row.state, attachedAt: row.attached_at }))
      : [];

    if (backupPath) await db.backup(backupPath);

    return {
      campaignName: campaign?.name ?? null,
      lifecycleStatus: campaign?.lifecycle_status ?? null,
      administrationRevision: campaign?.administration_revision ?? null,
      ownerPrincipalId: campaign?.owner_principal_id ?? null,
      campaignCharacterCount: countWhere(db, "campaign_characters", "campaign_id=?", campaignId),
      campaignActorCount: countWhere(db, "campaign_actors", "campaign_id=?", campaignId),
      activeDraftCount: countWhere(db, "character_drafts_v19",
        "campaign_id=? AND status='active' AND durability='durable'", campaignId),
      catalogRulesProfileId,
      catalogPins,
      legacyRulesProfileId,
      legacyContentPackCount: countWhere(db, "campaign_content_packs", "campaign_id=?", campaignId),
      rulesetBinding: rulesetBinding ? { rulesetId: rulesetBinding.ruleset_id, rulesetVersion: rulesetBinding.ruleset_version } : null,
      reservedRuleset: readReservedRuleset(db, campaignId),
      attachedSessions,
      quickCheck,
      foreignKeyFindings,
    };
  } finally {
    db.close();
  }
}

function withReadonlyCount(databasePath: string, sql: string, ...params: unknown[]): number {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(sql).get(...params) as { count: number } | undefined;
    return row?.count ?? 0;
  } finally {
    db.close();
  }
}

function withReadonlyIntegrity(databasePath: string): { quickCheck: string; foreignKeyFindings: number } {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return {
      quickCheck: (db.pragma("quick_check") as Array<{ quick_check: string }>)[0]?.quick_check ?? "unknown",
      foreignKeyFindings: (db.pragma("foreign_key_check") as unknown[]).length,
    };
  } finally {
    db.close();
  }
}

function expectedCatalogVersion(): string {
  return SRD_5_1_STARTER_CATALOG.manifest.packVersion;
}

function isExpectedCatalogConfiguration(configuration: CampaignContentConfiguration): boolean {
  return configuration.rulesProfileId === SRD_5_1_STARTER_RULES_PROFILE_ID
    && configuration.contentPacks.some(
      (pack) => pack.packId === SRD_5_1_STARTER_PACK_ID && pack.packVersion === expectedCatalogVersion(),
    );
}

function personaName(campaignName: string, campaignId: string, label: string): string {
  const base = campaignName.trim().slice(0, 120) || "Campaign";
  return `${base} [${campaignId.slice(0, 8)}] - ${label}`;
}

function operationPrefix(campaignId: string): string {
  return `hydrate-srd-reference.${campaignId}`;
}

interface ResolvedActor {
  plan: PartyMemberPlan;
  personaId: string;
  personaName: string;
  selectedAncestry: CatalogReference;
  ancestryFallback: boolean;
  created: boolean;
}

export async function hydrateSrdReferenceCampaign(
  options: HydrateSrdReferenceCampaignOptions,
): Promise<HydrateSrdReferenceCampaignResult> {
  const dataDir = path.resolve(options.dataDir);
  const databasePath = path.join(dataDir, "velvet.sqlite");
  const campaignId = options.campaignId;
  const warnings: string[] = [];
  if (!existsSync(databasePath)) fail(`database not found: ${databasePath}`);
  if (!expectedCatalogVersion()) fail("current SRD starter catalog version is unavailable");

  // 1. Read-only inspection followed by an online backup of the pre-mutation database.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = options.validateOnly ? null : path.join(dataDir, "hydration-backups", `before-srd-reference-${stamp}.sqlite`);
  if (backupPath) mkdirSync(path.dirname(backupPath), { recursive: true });
  const raw = await inspectAndBackup(databasePath, campaignId, backupPath);
  assert.equal(raw.quickCheck, "ok", `database quick_check failed: ${raw.quickCheck}`);
  assert.equal(raw.foreignKeyFindings, 0, `database has ${raw.foreignKeyFindings} foreign-key finding(s)`);
  if (!raw.campaignName || raw.administrationRevision === null || !raw.ownerPrincipalId) {
    fail(`campaign ${campaignId} was not found in ${databasePath}`);
  }
  const campaignName = raw.campaignName;
  if (raw.ownerPrincipalId !== OWNER) {
    fail(`campaign owner is ${raw.ownerPrincipalId}; this operator script requires ${OWNER}`);
  }
  if (raw.rulesetBinding && (raw.rulesetBinding.rulesetId !== DND_5E || raw.rulesetBinding.rulesetVersion !== DND_5E_VERSION)) {
    fail(`campaign has an existing ${raw.rulesetBinding.rulesetId}@${raw.rulesetBinding.rulesetVersion} ruleset binding; refusing to rebind`);
  }
  if (raw.reservedRuleset.rulesetId && raw.reservedRuleset.rulesetId !== DND_5E) {
    fail(`campaign reserved ruleset ${raw.reservedRuleset.rulesetId}; refusing to reconfigure to dnd-5e`);
  }
  if (raw.reservedRuleset.rulesetId === DND_5E
    && raw.reservedRuleset.rulesetVersion !== null && raw.reservedRuleset.rulesetVersion !== DND_5E_VERSION) {
    fail(`campaign reserved dnd-5e@${raw.reservedRuleset.rulesetVersion}; expected ${DND_5E_VERSION}`);
  }
  if (raw.legacyRulesProfileId && !raw.catalogRulesProfileId) {
    fail(`campaign has a legacy ${raw.legacyRulesProfileId} content configuration without a catalog selection; refusing to rebind`);
  }

  process.env.VELVET_DATA_DIR = dataDir;
  const repository = createRepository({ dataDir });
  try {
    const administration = repository.getCampaignAdministration(OWNER, campaignId);
    if (!administration) fail(`campaign administration unavailable for ${campaignId}`);
    assert.ok(administration.actorRole === "owner" || administration.actorRole === "gm");

    const configurationBefore = repository.getCampaignContentConfiguration(OWNER, campaignId);
    const rosterBefore = repository.getCampaignCharacterRoster(OWNER, campaignId);
    if (!rosterBefore) fail("campaign character roster is unavailable");
    const expectedNames = new Map(PARTY.map((plan) => [plan.role, personaName(campaignName, campaignId, plan.label)]));
    const expectedNameSet = new Set(expectedNames.values());
    for (const character of rosterBefore.characters) {
      if (!expectedNameSet.has(character.name)) {
        fail(`campaign already contains an unexpected campaign character ${JSON.stringify(character.name)}; refusing to add reference duplicates`);
      }
    }
    const allPresentBefore = PARTY.every((plan) => rosterBefore.characters.some(
      (character) => character.name === expectedNames.get(plan.role),
    ));
    const catalogConfiguredBefore = configurationBefore !== null;
    if (catalogConfiguredBefore && !isExpectedCatalogConfiguration(configurationBefore!)) {
      fail(`campaign is already configured with rules profile ${configurationBefore!.rulesProfileId} (${configurationBefore!.contentPacks
        .map((pack) => `${pack.packId}@${pack.packVersion}`).join(", ")}); refusing to rebind an existing catalog selection`);
    }

    if (options.validateOnly) {
      if (!catalogConfiguredBefore) fail("validate-only: campaign has no catalog configuration to validate");
      if (!allPresentBefore) fail("validate-only: the expected reference party is incomplete");
    } else if (!catalogConfiguredBefore) {
      assert.equal(raw.campaignCharacterCount, 0, "campaign must have no campaign characters before first catalog configuration");
      assert.equal(raw.campaignActorCount, 0, "campaign must have no actors before first catalog configuration");
      assert.equal(raw.activeDraftCount, 0, "campaign must have no active durable character drafts before first catalog configuration");
      repository.installSrdStarterCatalog(OWNER);
      const revision = repository.getCampaignAdministration(OWNER, campaignId)!.revision;
      repository.configureSrdStarterCatalog(OWNER, campaignId, {
        expectedRevision: revision,
        idempotencyKey: `${operationPrefix(campaignId)}.catalog`,
      });
    }

    // 2. Resolve exact pinned references from the configured catalog.
    const configured = repository.getCampaignContentConfiguration(OWNER, campaignId);
    if (!configured || !isExpectedCatalogConfiguration(configured)) {
      fail("campaign catalog configuration does not match the current SRD starter version");
    }
    const scores = attributeScores();
    const referenceAcolyte = catalogReference("background", ACOLYTE_BACKGROUND_ID);
    if (!referenceAcolyte) fail(`${ACOLYTE_BACKGROUND_ID} is unavailable in the current SRD starter catalog`);

    const resolved: ResolvedActor[] = [];
    const personae = await listCharacters();
    for (const [index, plan] of PARTY.entries()) {
      const name = expectedNames.get(plan.role)!;
      const requested = catalogReference("race", plan.ancestryDefinitionId);
      const fallback = catalogReference("race", plan.fallbackAncestryDefinitionId);
      const selectedAncestry = requested ?? fallback;
      if (!selectedAncestry) fail(`no SRD ancestry is available for ${plan.label}`);
      const ancestryFallback = requested === null;
      if (ancestryFallback) {
        warnings.push(`Requested ancestry ${plan.ancestryDefinitionId} is not published; ${plan.label} uses base ${plan.fallbackAncestryDefinitionId}. Subrace-only traits were not applied.`);
      }
      const ancestryDefinition = SRD_5_1_STARTER_CATALOG.definitions.find(
        (candidate) => candidate.reference.kind === "race" && candidate.reference.definitionId === selectedAncestry.definitionId,
      );
      if (ancestryDefinition && ancestryDefinition.tags.includes("unsupported-runtime")) {
        warnings.push(`${plan.label} ancestry ${selectedAncestry.definitionId} records subrace traits as metadata only (unsupported-runtime); those traits are not automated.`);
      }
      const existingPersona = personae.find((character) => character.name === name);
      const persona = existingPersona ?? repository.createCharacter({
        name,
        age: 30 + index,
        archetype: `${selectedAncestry.definitionId.replace("srd-5.1:race:", "")} ${plan.label} reference adventurer`,
        boundaries: "Fictional adults. No sexual violence, harm to children, or demeaning portrayals of real communities.",
        fictionalConfirmed: true,
      });
      if (!existingPersona) personae.push(persona);
      resolved.push({
        plan,
        personaId: persona.id,
        personaName: name,
        selectedAncestry,
        ancestryFallback,
        created: !rosterBefore.characters.some((character) => character.name === name),
      });
    }

    // 3. Ensure one active attached room before finalization so start placement can run.
    const personaIds = resolved.map((actor) => actor.personaId);
    const preferredTitle = options.roomTitle ?? `${campaignName} - Reference Room`;
    const attachmentsBefore = repository.listCampaignSessionAttachments(OWNER, campaignId);
    const attachedIds = new Set(attachmentsBefore.map((attachment) => attachment.sessionId));
    const sessions = await listSessions();
    const attachedSessions = sessions.filter((candidate) => attachedIds.has(candidate.id));
    // A stopped attached room cannot anchor placement; only active/setup rooms are reusable.
    const reusableSessions = attachedSessions.filter((candidate) => candidate.state !== "closed" && candidate.stoppedAt === null);
    let roomTitleMatched = false;
    let createdSession = false;
    let session = reusableSessions.find((candidate) => candidate.title === preferredTitle);
    if (session) {
      roomTitleMatched = true;
    } else if (reusableSessions.length === 0) {
      if (options.validateOnly) fail("validate-only: campaign has no reusable active attached room");
      if (attachedSessions.length > 0) {
        warnings.push(`All ${attachedSessions.length} attached room(s) are stopped; creating a fresh active room ${JSON.stringify(preferredTitle)}.`);
      }
      session = await createSession({ characterIds: personaIds, primaryCharacterId: personaIds[0]!, title: preferredTitle, presetId: "default" });
      createdSession = true;
    } else if (reusableSessions.length === 1) {
      session = reusableSessions[0]!;
      warnings.push(`Reusing the only reusable room ${session.id} titled ${JSON.stringify(session.title)} instead of creating ${JSON.stringify(preferredTitle)}.`);
    } else {
      fail(`${reusableSessions.length} active rooms are attached to the campaign; pass --room-title naming exactly one to avoid an ambiguous world session`);
    }
    const sessionId = session.id;
    if (session.state !== "active" && !options.validateOnly) {
      const transitioned = repository.transitionSession(sessionId, "active", "Prepared for SRD reference play");
      if (!transitioned) fail(`session ${sessionId} could not be activated`);
    }
    if (!attachedIds.has(sessionId) && !options.validateOnly) {
      repository.attachCampaignSession(OWNER, { campaignId, sessionId });
    }
    if (!createdSession && !personaIds.every((id) => session.participants.some((participant) => participant.id === id))) {
      warnings.push(`Reused room ${sessionId} does not list every reference persona as a legacy session participant; campaign characters remain playable.`);
    }

    // Original reference-world hubs provide a usable location for the party.
    // They are fictional Velvet scenery, not material attributed to the SRD.
    if (!options.validateOnly) {
      const world = repository.getCampaignWorld(OWNER, campaignId, sessionId)!;
      if (world.visibleLocations.length === 0) {
        const suffix = createHash("sha256").update(campaignId).digest("hex").slice(0, 16);
        const locations = [
          { locationId: `srd-ref-camp-${suffix}`, name: "Bramps Camp · Expedition Hall", description: "An original fictional expedition base. Four adventurers prepare a first journey together; the library records the current reviewed SRD catalog. This hub carries no automatic healing, equipment or rewards." },
          { locationId: `srd-ref-trail-${suffix}`, name: "Old Quarry Trail", description: "An original fictional walking route between camp and a disused quarry. Footprints, weather and the travellers' decisions provide scene hooks; no encounter is automatically triggered." },
          { locationId: `srd-ref-quarry-${suffix}`, name: "Lantern Quarry", description: "An original fictional quarry with a sheltered overlook. A good scene for discussing the next expedition or preparing an encounter from pinned creature definitions; no enemies or treasure are materialized here." },
        ];
        for (const location of locations) repository.createLocation(OWNER, { campaignId, ...location, visibility: "public" });
        for (let index = 1; index < locations.length; index += 1) {
          const from = locations[index - 1]!.locationId;
          const to = locations[index]!.locationId;
          repository.createLocationConnection(OWNER, { campaignId, fromLocationId: from, toLocationId: to });
          repository.createLocationConnection(OWNER, { campaignId, fromLocationId: to, toLocationId: from });
        }
      }
      const starting = repository.getCampaignStartingLocation(OWNER, campaignId)!;
      if (!starting.startingLocation) {
        const locationId = repository.getCampaignWorld(OWNER, campaignId, sessionId)!.visibleLocations[0]!.locationId;
        repository.designateCampaignStartingLocation(OWNER, campaignId, { locationId, expectedRevision: starting.revision,
          idempotencyKey: `${operationPrefix(campaignId)}.start` });
      }
    }

    // 4. Finalize any missing durable character through the public character builder.
    for (const actor of resolved) {
      if (!actor.created) continue;
      const classReference = catalogReference("class", actor.plan.classDefinitionId);
      if (!classReference) fail(`${actor.plan.classDefinitionId} is unavailable in the current SRD starter catalog`);
      const draft: CharacterDraftMutationResult = repository.createCharacterDraft(OWNER, campaignId, {
        personaId: actor.personaId,
        controllerPrincipalId: OWNER,
        durability: "durable",
        allocation: { method: "standard-array", scores },
        idempotencyKey: `${operationPrefix(campaignId)}.${actor.plan.role}.draft`,
      });
      const wanted: UpdateCharacterDraftInput["selections"] = {
        race: { packId: actor.selectedAncestry.packId, packVersion: actor.selectedAncestry.packVersion, kind: "race", definitionId: actor.selectedAncestry.definitionId },
        background: { packId: referenceAcolyte.packId, packVersion: referenceAcolyte.packVersion, kind: "background", definitionId: ACOLYTE_BACKGROUND_ID },
        class: { packId: classReference.packId, packVersion: classReference.packVersion, kind: "class", definitionId: actor.plan.classDefinitionId },
        starterGrant: "kit",
      };
      const persisted = draft.draft.selections;
      const alreadySelected = persisted.race !== null && persisted.background !== null
        && persisted.class !== null && persisted.starterGrant !== null;
      let expectedRevision = draft.draft.revision;
      if (alreadySelected) {
        // A resumed run already committed the selection command at an earlier draft
        // revision. Replaying it with the current revision would trip the exact-request
        // retry check, so require the persisted selections to already match instead.
        assert.deepEqual(persisted.race, wanted.race, `${actor.personaName} persisted ancestry differs`);
        assert.deepEqual(persisted.background, wanted.background, `${actor.personaName} persisted background differs`);
        assert.deepEqual(persisted.class, wanted.class, `${actor.personaName} persisted class differs`);
        assert.equal(persisted.starterGrant, wanted.starterGrant, `${actor.personaName} persisted starter grant differs`);
      } else {
        const selections: UpdateCharacterDraftInput = {
          expectedRevision,
          idempotencyKey: `${operationPrefix(campaignId)}.${actor.plan.role}.select`,
          selections: wanted,
        };
        const selected = repository.updateCharacterDraft(OWNER, draft.draft.id, selections);
        expectedRevision = selected.draft.revision;
      }
      repository.finalizeCharacterDraft(OWNER, draft.draft.id, {
        expectedRevision,
        idempotencyKey: `${operationPrefix(campaignId)}.${actor.plan.role}.finalize`,
      });
    }

    // 5. Best-effort public bootstrap placement for actors the start path left unplaced.
    const initialLocationIds = new Map<string, string>();
    if (!options.validateOnly) {
      const bootstrapWorld = repository.getCampaignWorld(OWNER, campaignId, sessionId);
      const bootstrapLocationId = bootstrapWorld?.visibleLocations[0]?.locationId ?? null;
      const finalRosterForPlacement = repository.getCampaignCharacterRoster(OWNER, campaignId);
      if (!finalRosterForPlacement) fail("campaign character roster disappeared after character creation");
      const charactersForPlacement = repository.listCampaignCharacters(OWNER, campaignId);
      const actorByCampaignCharacterId = new Map(charactersForPlacement.map((character) => [
        character.projection.campaignCharacter.id,
        character.projection.actor.id,
      ]));
      if (bootstrapLocationId) {
        for (const actor of resolved) {
          const rosterEntry = finalRosterForPlacement.characters.find((character) => character.name === actor.personaName);
          if (!rosterEntry) fail(`finalized campaign character ${actor.personaName} is missing from the roster`);
          const actorId = actorByCampaignCharacterId.get(rosterEntry.id);
          if (!actorId) fail(`actor for ${actor.personaName} is missing`);
          const world = repository.getCampaignWorld(OWNER, campaignId, sessionId);
          const placed = world?.currentLocations.find((location) => location.actorId === actorId);
          if (placed) {
            initialLocationIds.set(actor.personaName, placed.locationId);
            continue;
          }
          try {
            repository.placeActor(OWNER, actorId, {
              campaignId,
              locationId: bootstrapLocationId,
              expectedRevision: world?.revision ?? 0,
              idempotencyKey: `${operationPrefix(campaignId)}.${actor.plan.role}.place`,
            });
            initialLocationIds.set(actor.personaName, bootstrapLocationId);
          } catch (error) {
            warnings.push(`Initial placement for ${actor.personaName} failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } else {
        warnings.push("No campaign location is available for bootstrap placement; actors remain without an initial location.");
      }

      // 6. Publish the campaign once the party and room exist.
      const administrationBeforePublish = repository.getCampaignAdministration(OWNER, campaignId);
      if (administrationBeforePublish && administrationBeforePublish.status !== "published" && administrationBeforePublish.status !== "completed") {
        repository.updateCampaignAdministration(OWNER, campaignId, {
          expectedRevision: administrationBeforePublish.revision,
          status: "published",
          idempotencyKey: `${operationPrefix(campaignId)}.publish`,
        });
      }
    }

    // 7. Authoritative post-mutation validation and report assembly.
    const administrationAfter = repository.getCampaignAdministration(OWNER, campaignId);
    if (!administrationAfter) fail("campaign administration disappeared");
    const configurationAfter = repository.getCampaignContentConfiguration(OWNER, campaignId);
    if (!configurationAfter || !isExpectedCatalogConfiguration(configurationAfter)) {
      fail("configured catalog does not match the current SRD starter version after hydration");
    }
    const resolution = repository.resolveCampaignCatalog(OWNER, campaignId);
    if (!resolution || !resolution.compatible) fail("campaign catalog resolution is not compatible");
    const rosterAfter = repository.getCampaignCharacterRoster(OWNER, campaignId);
    if (!rosterAfter) fail("campaign character roster is unavailable after hydration");
    assert.deepEqual(
      rosterAfter.characters.map((character) => character.name).sort(),
      [...expectedNames.values()].sort(),
      "final campaign character names do not match the reference party",
    );
    assert.equal(rosterAfter.characters.length, PARTY.length, "reference party must contain exactly four characters");

    const charactersAfter = repository.listCampaignCharacters(OWNER, campaignId);
    const byName = new Map(rosterAfter.characters.map((character) => [character.name, character]));
    const actorReports: HydratedActorReport[] = [];
    for (const actor of resolved) {
      const rosterEntry = byName.get(actor.personaName);
      if (!rosterEntry) fail(`missing campaign character ${actor.personaName}`);
      const projection = charactersAfter.find((character) => character.projection.campaignCharacter.id === rosterEntry.id);
      if (!projection) fail(`missing projection for ${actor.personaName}`);
      const sheet = projection.projection.sheet;
      assert.equal(sheet.background.definitionId, ACOLYTE_BACKGROUND_ID, `${actor.personaName} background mismatch`);
      assert.equal(sheet.race.definitionId, actor.selectedAncestry.definitionId, `${actor.personaName} ancestry mismatch`);
      const classEntry = sheet.classes[0];
      assert.ok(classEntry, `${actor.personaName} has no class`);
      assert.equal(classEntry.class.definitionId, actor.plan.classDefinitionId, `${actor.personaName} class mismatch`);
      assert.equal(classEntry.level, 1, `${actor.personaName} must be level one`);
      const progression = repository.getCharacterProgression(OWNER, rosterEntry.id);
      if (!progression) fail(`missing progression for ${actor.personaName}`);
      const health = repository.getActorResource(OWNER, campaignId, progression.actorId, "health");
      assert.ok(health, `${actor.personaName} has no health resource`);
      assert.equal(health.current, health.max);
      assert.ok(health.max >= 1);
      const located = repository.getCampaignWorld(OWNER, campaignId, sessionId)?.currentLocations
        .find((location) => location.actorId === progression.actorId);
      actorReports.push({
        role: actor.plan.role,
        name: actor.personaName,
        personaId: actor.personaId,
        campaignCharacterId: rosterEntry.id,
        actorId: progression.actorId,
        level: progression.level,
        maxHp: progression.derived.maxHp,
        health: { current: health.current, max: health.max },
        classDefinitionId: classEntry.class.definitionId,
        backgroundDefinitionId: sheet.background.definitionId,
        requestedAncestryDefinitionId: actor.plan.ancestryDefinitionId,
        selectedAncestryDefinitionId: actor.selectedAncestry.definitionId,
        ancestryFallback: actor.ancestryFallback,
        initialLocationId: located?.locationId ?? initialLocationIds.get(actor.personaName) ?? null,
      });
    }

    const attachmentsAfter = repository.listCampaignSessionAttachments(OWNER, campaignId);
    const sessionAttached = attachmentsAfter.some((attachment) => attachment.sessionId === sessionId);
    assert.ok(sessionAttached, "reference room is not attached to the campaign");
    const sessionAfter = repository.getSession(sessionId);
    assert.ok(sessionAfter, "reference room is unavailable");
    assert.equal(sessionAfter.state, "active", "reference room is not active");

    const starting = repository.getCampaignStartingLocation(OWNER, campaignId);
    const startingLocation = starting?.startingLocation
      ? { locationId: starting.startingLocation.locationId, name: starting.startingLocation.name }
      : null;

    // Fresh read-only evidence of the persisted post-mutation state.
    const pinnedExecutableDefinitionCount = withReadonlyCount(
      databasePath,
      `SELECT COUNT(*) AS count FROM rpg_campaign_catalog_definitions_v25
        WHERE campaign_id=? AND kind IN ('ability','spell')`,
      campaignId,
    );
    assert.ok(pinnedExecutableDefinitionCount > 0, "no executable ability/spell definitions were pinned");
    const postIntegrity = withReadonlyIntegrity(databasePath);
    assert.equal(postIntegrity.quickCheck, "ok", `post-mutation quick_check failed: ${postIntegrity.quickCheck}`);
    assert.equal(postIntegrity.foreignKeyFindings, 0, `post-mutation foreign keys have ${postIntegrity.foreignKeyFindings} finding(s)`);
    const campaignActorCount = withReadonlyCount(
      databasePath,
      "SELECT COUNT(*) AS count FROM campaign_actors WHERE campaign_id=?",
      campaignId,
    );
    assert.equal(campaignActorCount, PARTY.length, "reference party must materialize exactly four actors");

    const report: HydrateSrdReferenceCampaignReport = {
      status: options.validateOnly ? "validated" : (catalogConfiguredBefore && allPresentBefore ? "existing" : "ready"),
      dataDir,
      databasePath,
      backupPath,
      campaignId,
      campaignName,
      catalog: { packId: SRD_5_1_STARTER_PACK_ID, packVersion: expectedCatalogVersion(), rulesProfileId: SRD_5_1_STARTER_RULES_PROFILE_ID },
      roomTitle: session.title,
      roomTitleMatched,
      sessionId,
      sessionState: sessionAfter.state,
      sessionAttached,
      campaignStatus: administrationAfter.status,
      startingLocation,
      pinnedExecutableDefinitionCount,
      actors: actorReports,
      counts: { campaignCharacters: rosterAfter.characters.length, campaignActors: campaignActorCount },
      integrity: { quickCheck: postIntegrity.quickCheck, foreignKeyFindings: postIntegrity.foreignKeyFindings },
      warnings,
      assumptions: [...ASSUMPTIONS],
      createdAt: new Date().toISOString(),
    };
    const reportPath = path.join(dataDir, `srd-reference-campaign-${campaignId}.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return { reportPath, report };
  } finally {
    repository.close();
    closeRepo();
  }
}

interface ParsedArgs {
  dataDir: string;
  campaignId: string;
  roomTitle?: string;
  validateOnly: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: Record<string, string> = {};
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags.add(name);
      continue;
    }
    args[name] = next;
    index += 1;
  }
  const campaignId = args["campaign"] ?? args["campaign-id"];
  if (!args["data-dir"] || !campaignId) {
    throw new Error("usage: --data-dir DIR --campaign ID [--room-title TITLE] [--validate-only]");
  }
  return {
    dataDir: args["data-dir"]!,
    campaignId,
    validateOnly: flags.has("validate-only"),
    ...(args["room-title"] ? { roomTitle: args["room-title"] } : {}),
  };
}

async function main(): Promise<void> {
  const result = await hydrateSrdReferenceCampaign(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify({ reportPath: result.reportPath, ...result.report }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
