import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { createRepository, MECHANICS_STARTER_CATALOG } from "../../../src/repo/index.js";
import { CHARACTER_BUILDER_STANDARD_ARRAY, ORIGINAL_STARTER_BACKGROUND, ORIGINAL_STARTER_CLASS, ORIGINAL_STARTER_RACE } from "@velvet/contracts";
import { defaultHarnessSettings, defaultProviderSettings } from "../../../src/defaults.js";
import { orchestrateAdventureTurn } from "../../../src/agent/adventureOrchestrator.js";
import { createCompanionCoreV44 } from "../../../src/repo/db/migrations/v44_companion_core.js";
import { COMPANION_CORE_V45_MANAGED_OBJECTS } from "../../../src/repo/db/migrations/v45_companion_principals.js";
import { EXACT_CANDIDATE_V46_MANAGED_OBJECTS } from "../../../src/repo/db/migrations/v46_exact_candidates.js";
import { migrate44to45 } from "../../../src/repo/db/migrations/v45_companion_principals.js";
import { EXACT_CANDIDATE_EXECUTION_V47_MANAGED_OBJECTS } from "../../../src/repo/db/migrations/v47_exact_candidate_executions.js";
import { EXACT_CANDIDATE_PROVIDER_V48_MANAGED_OBJECTS } from "../../../src/repo/db/migrations/v48_exact_candidate_provider_bridge.js";

const AT = "2035-01-01T00:00:00.000Z";
const V42_TABLES = ["campaign_content_layout_attestation_v42", "campaign_content_revisions_v42", "campaign_content_receipts_v42", "campaign_content_commands_v42"];
const V43_TABLES = ["npc_presence_layout_attestation_v43", "campaign_npc_presence_v43", "npc_presence_receipts_v43", "npc_presence_events_v43", "npc_presence_commands_v43", "npc_presence_session_revisions_v43"];
const V44_TABLES = ["companion_layout_attestation_v44", "companion_audit_events_v44", "companion_grant_revocations_v44", "companion_grant_command_families_v44",
  "companion_grants_v44", "companion_decision_receipts_v44", "companion_decisions_v44", "companion_proposals_v44",
  "companion_presence_links_v44", "campaign_companions_v44", "companion_receipts_v44", "companion_commands_v44"];

export const SUPPORT_WINDOW = {
  at: AT,
  campaignName: "Support Window Campaign",
  otherCampaignName: "Support Window Other Campaign",
  opening: "A winter storm closes the pass above Brackenford.",
  premise: "Keep Brackenford supplied before the thaw.",
  npcName: "Mara Venn",
  questTitle: "Open the Winter Road",
  questDescription: "Clear the pass and restore the village supply route.",
} as const;

export interface SupportWindowFixture {
  campaignId: string;
  draftId: string;
  npcId: string;
  sessionId: string;
  locationId: string;
  otherCampaignId?: string;
  otherDraftId?: string;
}

export interface PopulatedV44CompanionFixture extends SupportWindowFixture {
  actorId: string;
  grantId: string;
  grantorPrincipalId: string;
  granteePrincipalId: string;
}

function databaseFile(): string {
  return path.join(process.env.VELVET_DATA_DIR!, "velvet.sqlite");
}

function createCanonicalCampaign(withOtherCampaign = false): SupportWindowFixture {
  let id = 0;
  const repo = createRepository({
    dataDir: process.env.VELVET_DATA_DIR!,
    clock: { now: () => new Date(AT) },
    ids: { nextId: () => `support-window-${++id}` },
  });
  const campaign = repo.createCampaign("local-owner", { name: SUPPORT_WINDOW.campaignName });
  const draft = repo.createGenerationDraft("local-owner", {
    campaignId: campaign.id,
    timelineId: campaign.activeTimelineId,
    kind: "quest",
    stagedContent: { title: SUPPORT_WINDOW.questTitle },
    validation: { valid: true, issues: [], validatedAt: AT },
    expectedCampaignRevision: 0,
    idempotencyKey: "support-window-draft",
  });
  const character = repo.createCharacter({
    name: SUPPORT_WINDOW.npcName,
    age: 34,
    archetype: "scout",
    boundaries: "Synthetic fixture character.",
    fictionalConfirmed: true,
  });
  const otherCampaign = withOtherCampaign ? repo.createCampaign("local-owner", { name: SUPPORT_WINDOW.otherCampaignName }) : undefined;
  const otherDraft = otherCampaign === undefined ? undefined : repo.createGenerationDraft("local-owner", {
    campaignId: otherCampaign.id,
    timelineId: otherCampaign.activeTimelineId,
    kind: "quest",
    stagedContent: { title: "Other campaign quest" },
    validation: { valid: true, issues: [], validatedAt: AT },
    expectedCampaignRevision: 0,
    idempotencyKey: "support-window-other-draft",
  });
  repo.close();

  const npcId = "support-window-npc";
  const sessionId = "support-window-session";
  const locationId = "support-window-location";
  const db = new DatabaseDriver(databaseFile());
  db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO campaign_npcs_v28 VALUES(?,?,?,'manual',?,?)")
    .run(npcId, campaign.id, character.id, SUPPORT_WINDOW.npcName, AT);
  db.prepare("INSERT INTO campaign_npc_private_state_v28 VALUES(?,?,?,'',NULL)")
    .run(campaign.id, npcId, "Keep the road open.");
  db.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES(?,?,?,'active','default',?)")
    .run(sessionId, character.id, "Support Window Room", AT);
  db.prepare("INSERT INTO session_characters VALUES(?,?,0)").run(sessionId, character.id);
  db.prepare("INSERT INTO campaign_sessions VALUES(?,?,?)").run(sessionId, campaign.id, AT);
  db.prepare("INSERT INTO campaign_locations_v28(location_id,campaign_id,parent_location_id,public_name,public_description,visibility,created_at) VALUES(?,?,NULL,?,'','public',?)")
    .run(locationId, campaign.id, "Brackenford Pass", AT);
  db.close();
  return {
    campaignId: campaign.id,
    draftId: draft.draftId,
    npcId,
    sessionId,
    locationId,
    ...(otherCampaign === undefined || otherDraft === undefined ? {} : {
      otherCampaignId: otherCampaign.id,
      otherDraftId: otherDraft.draftId,
    }),
  };
}

function removeV43(db: DatabaseDriver.Database): void {
  const artifacts = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v43*' AND sql IS NOT NULL ORDER BY type DESC")
    .all() as Array<{ type: string; name: string }>;
  for (const { type, name } of artifacts) {
    if (type === "trigger") db.exec(`DROP TRIGGER "${name}"`);
  }
  for (const table of V43_TABLES) db.exec(`DROP TABLE IF EXISTS "${table}"`);
}

function removeV44(db: DatabaseDriver.Database): void {
  const artifacts = db.prepare("SELECT type,name FROM sqlite_master WHERE name GLOB '*v44*' AND sql IS NOT NULL ORDER BY type DESC")
    .all() as Array<{ type: string; name: string }>;
  for (const { type, name } of artifacts) {
    if (type === "index") db.exec(`DROP INDEX "${name}"`);
    if (type === "trigger") db.exec(`DROP TRIGGER "${name}"`);
  }
  for (const table of V44_TABLES) db.exec(`DROP TABLE IF EXISTS "${table}"`);
}

function removeV45(db: DatabaseDriver.Database): void {
  for (const [type, name] of [...COMPANION_CORE_V45_MANAGED_OBJECTS].reverse()) {
    if (type === "trigger") db.exec(`DROP TRIGGER "${name}"`);
    if (type === "index") db.exec(`DROP INDEX "${name}"`);
  }
  for (const [, name] of [...COMPANION_CORE_V45_MANAGED_OBJECTS].filter(([type]) => type === "table").reverse()) {
    db.exec(`DROP TABLE "${name}"`);
  }
}

function removeV42(db: DatabaseDriver.Database): void {
  for (const table of V42_TABLES) {
    db.exec(`DROP TRIGGER IF EXISTS ${table}_immutable_update_v42`);
    db.exec(`DROP TRIGGER IF EXISTS ${table}_immutable_delete_v42`);
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/** Builds a populated v41 database with valid generation ancestry and no v42 artifacts. */
export function buildCanonicalV41Fixture(): SupportWindowFixture {
  const fixture = createCanonicalCampaign();
  const db = new DatabaseDriver(databaseFile());
  removeV45(db);
  removeV44(db);
  removeV43(db);
  removeV42(db);
  db.prepare("INSERT INTO campaign_opening_narratives_v41 VALUES(?,?,?,?,?)")
    .run(fixture.campaignId, SUPPORT_WINDOW.opening, SUPPORT_WINDOW.premise, fixture.draftId, AT);
  db.prepare("INSERT INTO campaign_npc_baseline_stats_v41 VALUES(?,?,9,11,12,'generated-deterministic-baseline')")
    .run(fixture.campaignId, fixture.npcId);
  db.prepare("INSERT INTO generated_campaign_quests_v41 VALUES(?,?,?,?,?)")
    .run(fixture.campaignId, "support-window-quest", SUPPORT_WINDOW.questTitle, SUPPORT_WINDOW.questDescription, fixture.draftId);
  db.prepare("UPDATE meta SET value='41' WHERE key='schemaVersion'").run();
  db.close();
  return fixture;
}

/** Builds canonical v41 projections plus a separate valid campaign draft. */
export function buildCanonicalV41CrossCampaignFixture(): Required<SupportWindowFixture> {
  const fixture = createCanonicalCampaign(true) as Required<SupportWindowFixture>;
  const db = new DatabaseDriver(databaseFile());
  removeV45(db);
  removeV44(db);
  removeV43(db);
  removeV42(db);
  db.prepare("INSERT INTO campaign_opening_narratives_v41 VALUES(?,?,?,?,?)")
    .run(fixture.campaignId, SUPPORT_WINDOW.opening, SUPPORT_WINDOW.premise, fixture.draftId, AT);
  db.prepare("INSERT INTO campaign_npc_baseline_stats_v41 VALUES(?,?,9,11,12,'generated-deterministic-baseline')")
    .run(fixture.campaignId, fixture.npcId);
  db.prepare("INSERT INTO generated_campaign_quests_v41 VALUES(?,?,?,?,?)")
    .run(fixture.campaignId, "support-window-quest", SUPPORT_WINDOW.questTitle, SUPPORT_WINDOW.questDescription, fixture.draftId);
  db.prepare("UPDATE meta SET value='41' WHERE key='schemaVersion'").run();
  db.close();
  return fixture;
}

/** Builds genuine populated v42 audit rows and no v43 artifacts. */
export function buildCanonicalV42Fixture(withOtherCampaign = false): SupportWindowFixture {
  const fixture = createCanonicalCampaign(withOtherCampaign);
  const db = new DatabaseDriver(databaseFile());
  removeV45(db);
  removeV44(db);
  removeV43(db);
  db.prepare("INSERT INTO campaign_opening_narratives_v41 VALUES(?,?,?,?,?)")
    .run(fixture.campaignId, SUPPORT_WINDOW.opening, SUPPORT_WINDOW.premise, fixture.draftId, AT);
  db.prepare("INSERT INTO campaign_npc_baseline_stats_v41 VALUES(?,?,9,11,12,'generated-deterministic-baseline')")
    .run(fixture.campaignId, fixture.npcId);
  db.prepare("INSERT INTO generated_campaign_quests_v41 VALUES(?,?,?,?,?)")
    .run(fixture.campaignId, "support-window-quest", SUPPORT_WINDOW.questTitle, SUPPORT_WINDOW.questDescription, fixture.draftId);
  db.prepare("INSERT INTO campaign_content_commands_v42 VALUES('support-window-content-command',?,?,'support-window-principal','support-window-content-key',0,?)")
    .run(fixture.campaignId, fixture.draftId, AT);
  db.prepare("INSERT INTO campaign_content_receipts_v42 VALUES('support-window-content-receipt','support-window-content-command',?,?,?,'{}')")
    .run(fixture.campaignId, fixture.draftId, AT);
  db.prepare("INSERT INTO campaign_content_revisions_v42 VALUES(?,1,?,?)")
    .run(fixture.campaignId, fixture.draftId, AT);
  db.prepare("UPDATE meta SET value='42' WHERE key='schemaVersion'").run();
  db.close();
  return fixture;
}


/** Builds genuine populated v43 presence history and no v44 artifacts. */
export function buildCanonicalV43Fixture(): SupportWindowFixture {
  const fixture = createCanonicalCampaign();
  const db = new DatabaseDriver(databaseFile());
  removeV45(db);
  removeV44(db);
  db.prepare("INSERT INTO npc_presence_session_revisions_v43 VALUES(?,?,0,?)")
    .run(fixture.campaignId, fixture.sessionId, AT);
  db.prepare(`INSERT INTO npc_presence_commands_v43
    VALUES(?,?,'support-window-presence-command','support-window-presence-key','local-owner',?,'present',NULL,0,1,?)`)
    .run(fixture.campaignId, fixture.sessionId, fixture.npcId, AT);
  db.prepare("UPDATE npc_presence_session_revisions_v43 SET revision=1,updated_at=? WHERE campaign_id=? AND session_id=?")
    .run(AT, fixture.campaignId, fixture.sessionId);
  db.prepare(`INSERT INTO npc_presence_events_v43
    VALUES('support-window-presence-event',?,?,'support-window-presence-command',1,?,'present',NULL,?)`)
    .run(fixture.campaignId, fixture.sessionId, fixture.npcId, AT);
  db.prepare(`INSERT INTO npc_presence_receipts_v43
    VALUES(?,?,'support-window-presence-command',1,'support-window-presence-event',?,'present',NULL,?)`)
    .run(fixture.campaignId, fixture.sessionId, fixture.npcId, AT);
  db.prepare(`INSERT INTO campaign_npc_presence_v43
    VALUES(?,?,?,'present',NULL,1,?,?,'support-window-presence-command')`)
    .run(fixture.campaignId, fixture.sessionId, fixture.npcId, AT, AT);
  db.prepare("UPDATE meta SET value='43' WHERE key='schemaVersion'").run();
  db.close();
  return fixture;
}

/** Builds canonical populated v44 companion history, including a durable-principal grant. */
export function buildCanonicalPopulatedV44CompanionFixture(): PopulatedV44CompanionFixture {
  const fixture = buildCanonicalV43Fixture();
  const promote = new DatabaseDriver(databaseFile());
  createCompanionCoreV44(promote);
  promote.prepare("UPDATE meta SET value='44' WHERE key='schemaVersion'").run();
  migrate44to45(promote);
  // This fixture starts from a rewound current database, so later canonical
  // shells already exist; temporarily restore the current marker for setup.
  promote.prepare("UPDATE meta SET value='48' WHERE key='schemaVersion'").run();
  promote.close();
  let id = 0;
  const repo = createRepository({ clock: { now: () => new Date(AT) }, ids: { nextId: () => `support-companion-${++id}` } });
  const grantorPrincipalId = "support-companion-gm";
  const granteePrincipalId = "support-companion-player";
  const db = new DatabaseDriver(databaseFile());
  db.prepare("INSERT INTO principals VALUES(?,?,0)").run(grantorPrincipalId, "Companion GM");
  db.prepare("INSERT INTO principals VALUES(?,?,0)").run(granteePrincipalId, "Companion Player");
  db.close();
  repo.addCampaignMembership("local-owner", fixture.campaignId, { principalId: grantorPrincipalId, role: "gm" });
  repo.addCampaignMembership("local-owner", fixture.campaignId, { principalId: granteePrincipalId, role: "player" });
  repo.installOriginalStarterContent("local-owner", fixture.campaignId);
  repo.configureOriginalStarterContent("local-owner", fixture.campaignId);
  const persona = repo.createCharacter({ name: "Companion Actor", age: 30, archetype: "warden", boundaries: "", fictionalConfirmed: true });
  const actorId = repo.createOriginalStarterCampaignCharacter("local-owner", {
    campaignId: fixture.campaignId, characterId: persona.id, controllerPrincipalId: "local-owner",
    race: ORIGINAL_STARTER_RACE.reference, background: ORIGINAL_STARTER_BACKGROUND.reference,
    classes: [{ class: ORIGINAL_STARTER_CLASS.reference, level: 1 }], attributes: [], proficiencies: [], choices: [],
  }).projection.actor.id;
  repo.createCompanion(grantorPrincipalId, fixture.campaignId, {
    sessionId: fixture.sessionId, npcId: fixture.npcId, expectedRevision: 0, idempotencyKey: "support-companion-create",
  });
  const grant = repo.createCompanionGrant(grantorPrincipalId, fixture.campaignId, {
    npcId: fixture.npcId, granteePrincipalId, allowedCommandFamilies: ["rest", "travel"],
    actorScope: { kind: "campaign-actor", actorId }, resourceScope: { kind: "actor-resources" },
    maxSpend: null, maxUses: null, startsAt: AT, expiresAt: "2035-01-02T00:00:00.000Z",
    confirmationPolicy: "always", expectedRevision: 1, idempotencyKey: "support-grant-create",
  });
  const grantId = (grant.outcome as { grantId: string }).grantId;
  repo.close();

  const downgrade = new DatabaseDriver(databaseFile());
  downgrade.pragma("foreign_keys=OFF");
  downgrade.transaction(() => {
    for (const [type,name] of [...EXACT_CANDIDATE_PROVIDER_V48_MANAGED_OBJECTS].reverse()){if(type==="trigger")downgrade.exec(`DROP TRIGGER ${name}`);if(type==="index")downgrade.exec(`DROP INDEX ${name}`);}
    for(const [,name] of [...EXACT_CANDIDATE_PROVIDER_V48_MANAGED_OBJECTS].filter(([type])=>type==="table").reverse())downgrade.exec(`DROP TABLE ${name}`);
    for (const [type,name] of [...EXACT_CANDIDATE_EXECUTION_V47_MANAGED_OBJECTS].reverse()){if(type==="trigger")downgrade.exec(`DROP TRIGGER ${name}`);if(type==="index")downgrade.exec(`DROP INDEX ${name}`);}
    for(const [,name] of [...EXACT_CANDIDATE_EXECUTION_V47_MANAGED_OBJECTS].filter(([type])=>type==="table").reverse())downgrade.exec(`DROP TABLE ${name}`);
    for (const [type, name] of [...EXACT_CANDIDATE_V46_MANAGED_OBJECTS].reverse()) {
      if (type === "trigger") downgrade.exec(`DROP TRIGGER ${name}`);
      if (type === "index") downgrade.exec(`DROP INDEX ${name}`);
    }
    for (const [, name] of [...EXACT_CANDIDATE_V46_MANAGED_OBJECTS].filter(([type]) => type === "table").reverse()) downgrade.exec(`DROP TABLE ${name}`);
    createCompanionCoreV44(downgrade);
    for (const table of V44_TABLES.filter((name) => name !== "companion_layout_attestation_v44")) {
      downgrade.exec(`INSERT INTO ${table} SELECT * FROM ${table.replace(/_v44$/, "_v45")}`);
    }
    for (const [type, name] of [...COMPANION_CORE_V45_MANAGED_OBJECTS].reverse()) {
      if (type === "trigger") downgrade.exec(`DROP TRIGGER ${name}`);
      if (type === "index") downgrade.exec(`DROP INDEX ${name}`);
    }
    for (const [, name] of [...COMPANION_CORE_V45_MANAGED_OBJECTS].filter(([type]) => type === "table").reverse()) {
      downgrade.exec(`DROP TABLE ${name}`);
    }
    downgrade.prepare("UPDATE meta SET value='44' WHERE key='schemaVersion'").run();
  })();
  downgrade.pragma("foreign_keys=ON");
  downgrade.close();
  return { ...fixture, actorId, grantId, grantorPrincipalId, granteePrincipalId };
}

/** Builds the same populated history at the supported v45 archive boundary. */
export function buildCanonicalPopulatedV45CompanionFixture(): PopulatedV44CompanionFixture {
  const fixture=buildCanonicalPopulatedV44CompanionFixture();
  const db=new DatabaseDriver(databaseFile());migrate44to45(db);db.close();return fixture;
}

/** Builds populated canonical preexisting data at one accepted v46-v52 marker. */
export function buildCanonicalSupportedFixture(version: number): SupportWindowFixture {
  if (!Number.isInteger(version) || version < 46 || version > 52) {
    throw new Error(`unsupported fixture schema version ${version}`);
  }
  const fixture = createCanonicalCampaign();
  rewindSupportedFixture(version);
  return fixture;
}

/** Builds marker-owned populated history before rewinding to one accepted input. */
export async function buildCanonicalPopulatedSupportedFixture(version: number): Promise<SupportWindowFixture> {
  if (!Number.isInteger(version) || version < 46 || version > 52) {
    throw new Error(`unsupported fixture schema version ${version}`);
  }
  const fixture = createCanonicalCampaign();
  let sequence = 0;
  const repo = createRepository({
    dataDir: process.env.VELVET_DATA_DIR!,
    clock: { now: () => new Date(AT) },
    ids: { nextId: () => `support-populated-${++sequence}` },
    rng: { integer: (minimum) => minimum },
  });
  repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner", fixture.campaignId, {
    expectedRevision: 0,
    idempotencyKey: "support-populated-catalog",
  });
  const persona = repo.createCharacter({
    name: "Support Window Hero",
    age: 30,
    archetype: "warden",
    boundaries: "Synthetic fixture character.",
    fictionalConfirmed: true,
  });
  let setupDb = new DatabaseDriver(databaseFile());
  setupDb.prepare("INSERT INTO session_characters VALUES(?,?,1)").run(fixture.sessionId, persona.id);
  if (version >= 51) {
    setupDb.prepare("INSERT INTO campaign_starting_locations_v51 VALUES(?,?,?)")
      .run(fixture.campaignId, fixture.locationId, AT);
  }
  setupDb.close();

  const scores = Object.fromEntries(
    ["might", "agility", "resolve", "insight", "presence", "craft"].map((key, index) => [key, CHARACTER_BUILDER_STANDARD_ARRAY[index]]),
  ) as { might: number; agility: number; resolve: number; insight: number; presence: number; craft: number };
  const created = repo.createCharacterDraft("local-owner", fixture.campaignId, {
    personaId: persona.id,
    controllerPrincipalId: "local-owner",
    durability: "durable",
    allocation: version >= 49 ? { method: "server-roll" } : { method: "standard-array", scores },
    idempotencyKey: "support-populated-draft",
  });
  const draft = version >= 49
    ? repo.rerollCharacterDraft("local-owner", created.draft.id, { expectedRevision: 0, idempotencyKey: "support-populated-reroll" }).draft
    : created.draft;
  const definitions = MECHANICS_STARTER_CATALOG.definitions;
  const selected = repo.updateCharacterDraft("local-owner", draft.id, {
    expectedRevision: draft.revision,
    idempotencyKey: "support-populated-select",
    selections: {
      race: definitions.find((definition) => definition.reference.kind === "race")!.reference,
      background: definitions.find((definition) => definition.reference.kind === "background")!.reference,
      class: definitions.find((definition) => definition.reference.kind === "class")!.reference,
      starterGrant: "currency",
    },
  } as never);
  const finalized = repo.finalizeCharacterDraft("local-owner", draft.id, {
    expectedRevision: selected.draft.revision,
    idempotencyKey: "support-populated-finalize",
  });
  const actorId = finalized.receipt.actorId;

  setupDb = new DatabaseDriver(databaseFile());
  setupDb.prepare("INSERT INTO campaign_locations_v28 VALUES('support-destination',?,NULL,'Destination','','public',?)")
    .run(fixture.campaignId, AT);
  setupDb.prepare("INSERT INTO campaign_location_connections_v28 VALUES('support-road',?,?,?,'public','open','none',NULL,NULL,?)")
    .run(fixture.campaignId, fixture.locationId, "support-destination", AT);
  if (!setupDb.prepare("SELECT 1 FROM campaign_actor_locations_v28 WHERE campaign_id=? AND actor_id=?").get(fixture.campaignId, actorId)) {
    setupDb.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,?,?,?,0,?)")
      .run(fixture.campaignId, actorId, fixture.locationId, fixture.sessionId, AT);
  }
  setupDb.close();

  const campaign = repo.getCampaign("local-owner", fixture.campaignId)!;
  const administration = repo.getCampaignAdministration("local-owner", fixture.campaignId)!;
  const turn = repo.createAdventureTurn("local-owner", {
    campaignId: fixture.campaignId,
    timelineId: campaign.activeTimelineId,
    sessionId: fixture.sessionId,
    actorId,
    declaration: "Travel to the destination.",
    expectedCampaignRevision: administration.revision,
    idempotencyKey: "support-populated-turn",
  });
  if (version === 46) {
    repo.generateActorTravelCandidates("local-owner", { turnId: turn.turnId, idempotencyKey: "support-populated-candidates" });
  } else if (version === 47) {
    const batch = repo.generateActorTravelCandidates("local-owner", { turnId: turn.turnId, idempotencyKey: "support-populated-candidates" });
    repo.executeExactActorTravelCandidate("local-owner", {
      turnId: turn.turnId,
      selection: { candidateId: batch.candidates[0]!.candidateId, kind: "actor.travel", version: "v1", choices: [] },
    });
  } else {
    const providerCampaign = repo.createCampaign("local-owner", { name: "Support Provider Campaign" });
    const providerDb = new DatabaseDriver(databaseFile());
    providerDb.prepare("INSERT INTO characters VALUES ('support-provider-persona','Provider Hero',30,'hero','',1,0,?)").run(AT);
    providerDb.prepare("INSERT INTO rpg_rules_profiles VALUES ('support-provider-profile','Profile','Rules','[]')").run();
    providerDb.prepare("INSERT INTO rpg_content_packs VALUES ('support-provider-pack','1','support-provider-profile','Pack','Pack','[]',0)").run();
    providerDb.prepare("INSERT INTO rpg_definitions VALUES ('support-provider-pack','1','race','human','Human','Race','[]'),('support-provider-pack','1','background','hero','Hero','Background','[]')").run();
    providerDb.prepare("UPDATE rpg_content_packs SET sealed=1 WHERE pack_id='support-provider-pack'").run();
    providerDb.prepare("INSERT INTO campaign_rules_profiles VALUES (?,'support-provider-profile')").run(providerCampaign.id);
    providerDb.prepare("INSERT INTO campaign_content_packs VALUES (?,'support-provider-pack','1','support-provider-profile')").run(providerCampaign.id);
    providerDb.prepare("INSERT INTO campaign_characters VALUES ('support-provider-cc',?,'support-provider-persona',?,?)").run(providerCampaign.id, AT, AT);
    providerDb.prepare("INSERT INTO rpg_campaign_sheets VALUES ('support-provider-sheet',?,'support-provider-cc','support-provider-pack','1','race','human','support-provider-pack','1','background','hero',?,?)").run(providerCampaign.id, AT, AT);
    providerDb.prepare("INSERT INTO rpg_character_attributes VALUES (?,'support-provider-sheet',0,'strength',10)").run(providerCampaign.id);
    providerDb.prepare("INSERT INTO campaign_actors VALUES ('support-provider-actor',?,'support-provider-cc','support-provider-sheet','player-character','principal',?,?)").run(providerCampaign.id, AT, AT);
    providerDb.prepare("INSERT INTO campaign_actor_private_state VALUES('support-provider-actor',?,'local-owner',NULL)").run(providerCampaign.id);
    providerDb.prepare("INSERT INTO sessions(id,character_id,title,state,preset_id,created_at) VALUES('support-provider-session','support-provider-persona','Room','active','default',?)").run(AT);
    providerDb.prepare("INSERT INTO session_characters VALUES('support-provider-session','support-provider-persona',0)").run();
    providerDb.prepare("INSERT INTO campaign_sessions VALUES('support-provider-session',?,?)").run(providerCampaign.id, AT);
    providerDb.prepare("INSERT INTO campaign_locations_v28 VALUES('support-provider-origin',?,NULL,'Old Gate','','public',?)").run(providerCampaign.id, AT);
    providerDb.prepare("INSERT INTO campaign_locations_v28 VALUES('support-provider-destination',?,NULL,'Silver Harbor','','public',?)").run(providerCampaign.id, AT);
    providerDb.prepare("INSERT INTO campaign_location_connections_v28 VALUES('support-provider-road',?,'support-provider-origin','support-provider-destination','public','open','none',NULL,NULL,?)").run(providerCampaign.id, AT);
    providerDb.prepare("INSERT INTO campaign_actor_locations_v28 VALUES(?,'support-provider-actor','support-provider-origin','support-provider-session',0,?)").run(providerCampaign.id, AT);
    providerDb.close();
    const providerTurn = repo.createAdventureTurn("local-owner", {
      campaignId: providerCampaign.id,
      timelineId: providerCampaign.activeTimelineId,
      sessionId: "support-provider-session",
      actorId: "support-provider-actor",
      declaration: "Travel onward.",
      expectedCampaignRevision: 0,
      idempotencyKey: "support-provider-turn",
    });
    const orchestrated = await orchestrateAdventureTurn(repo, providerTurn.turnId, {
      complete: async (input) => {
        const tool = input.tools?.find((item) => item.name === "exact_actor_travel.select") as any;
        return {
          message: { role: "assistant", content: null, toolCalls: [{ id: "support-provider-tool", name: "exact_actor_travel.select", arguments: JSON.stringify({
            candidateId: tool.parameters.properties.candidateId.enum[0], kind: "actor.travel", version: "v1", choices: [],
          }) }] },
          usage: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
          model: { requestedModel: "fixture", responseModel: "fixture" },
        };
      },
      getProvider: async () => ({ ...defaultProviderSettings(), baseUrl: "http://127.0.0.1:1/v1", model: "fixture" }),
      getHarness: async () => defaultHarnessSettings(),
      now: () => new Date(AT),
    });
    const evidence = new DatabaseDriver(databaseFile(), { readonly: true });
    const executionCount = (evidence.prepare("SELECT count(*) count FROM exact_candidate_executions_v47").get() as { count: number }).count;
    evidence.close();
    if (executionCount !== 1) throw new Error(`support fixture provider travel did not execute (${orchestrated.outcome})`);
  }

  if (version >= 51) {
    const enemy = {
      kind: "enemy-template" as const,
      packId: MECHANICS_STARTER_CATALOG.manifest.packId,
      packVersion: MECHANICS_STARTER_CATALOG.manifest.packVersion,
      definitionId: "velvet:mechanics:enemy-template:gloam-mite",
    };
    const encounter = repo.createEncounter("local-owner", fixture.campaignId, {
      sessionId: fixture.sessionId,
      name: "Support Window Encounter",
      combatants: [{ kind: "actor", actorId, team: "allies" }, { kind: "enemy", template: enemy, team: "enemies" }],
      idempotencyKey: "support-populated-encounter",
    });
    let combat = repo.startEncounter("local-owner", encounter.encounter.encounterId, {
      expectedRevision: encounter.encounter.revision,
      idempotencyKey: "support-populated-start",
    }).combat;
    for (let action = 0; combat.currentCombatant !== null && action < 32; action += 1) {
      const current = combat.combatants.find((combatant) => combatant.combatantId === combat.currentCombatant)!;
      const enemyCombatant = combat.combatants.find((combatant) => combatant.kind === "enemy")!;
      if (enemyCombatant.status === "defeated") break;
      const request = current.kind === "actor"
        ? { legalActionId: "attack:basic", targetIds: [enemyCombatant.combatantId], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: `support-action-${action}` }
        : { legalActionId: "end-turn", targetIds: [] as string[], choices: [] as [], expectedRevision: combat.revision, idempotencyKey: `support-action-${action}` };
      combat = repo.resolveCombatAction("local-owner", combat.combatId, request).combat;
    }
    const ended = repo.endCombat("local-owner", combat.combatId, {
      expectedRevision: combat.revision,
      idempotencyKey: "support-populated-end",
    });
    repo.claimCombatReward("local-owner", combat.combatId, ended.rewards[0]!.rewardBundleId, {
      rewardClaimId: "support-populated-reward",
      expectedRevision: ended.encounter.revision,
      idempotencyKey: "support-populated-claim",
    });
  }
  repo.close();

  const populated = new DatabaseDriver(databaseFile());
  if (version >= 50) {
    populated.prepare(`INSERT INTO campaign_generation_calls_v50(campaign_id,idempotency_key,request_digest,state,provider,model,operation,stage,
      prompt_version,schema_version,retry_count,prompt_tokens,completion_tokens,latency_ms,estimated_cost_usd,started_at,terminal_at,draft_id,job_id,outcome_code)
      VALUES(?,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','succeeded','fixture','fixture','campaign-generation','candidate',
      'fixture-v1','fixture-v1',0,1,1,1,0,?,?,?,'support-generation-job','ok')`)
      .run(fixture.campaignId, "support-generation-v50", AT, AT, fixture.draftId);
    populated.prepare("INSERT INTO campaign_generation_artifacts_v50 VALUES(?,?,'opening','public','{}',?,?)")
      .run(fixture.campaignId, "support-opening-v50", fixture.draftId, AT);
  }
  if (version >= 52) {
    populated.prepare(`INSERT INTO campaign_generation_jobs_v52 VALUES('support-job-v52',?,?,'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','succeeded',1,?,'ok',?,?)`)
      .run(fixture.campaignId, "support-generation-v52", fixture.draftId, AT, AT);
    populated.prepare(`INSERT INTO campaign_generation_attempts_v52 VALUES('support-job-v52',1,0,'fixture','fixture','fixture','campaign-generation','candidate','fixture-v1','fixture-v1',1,1,2,1,0,?,?,'ok')`)
      .run(AT, AT);
    populated.prepare("INSERT INTO campaign_generation_candidate_artifacts_v52 VALUES(?,?,'handout','public','{}')")
      .run(fixture.draftId, "support-candidate-v52");
    populated.prepare("INSERT INTO campaign_generation_dependencies_v52 VALUES(?,?,'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',?,NULL)")
      .run(fixture.draftId, "support-dependency-v52", fixture.draftId);
    populated.prepare("INSERT INTO campaign_generation_accepted_artifacts_v52 VALUES(?,?,'handout','public','{}','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',?,NULL,?)")
      .run(fixture.campaignId, "support-accepted-v52", fixture.draftId, AT);
    populated.prepare("INSERT INTO generated_npc_placement_intents_v52 VALUES(?,?,?,?, 'pending',NULL,?,NULL)")
      .run(fixture.campaignId, fixture.npcId, fixture.locationId, fixture.draftId, AT);
  }
  populated.close();
  rewindSupportedFixture(version);
  return fixture;
}

function rewindSupportedFixture(version: number): void {
  const db = new DatabaseDriver(databaseFile());
  db.pragma("foreign_keys=OFF");
  for (let futureVersion = 53; futureVersion > version; futureVersion -= 1) {
    const pattern = `*v${futureVersion}*`;
    const artifacts = db.prepare(`SELECT type,name FROM sqlite_master
      WHERE sql IS NOT NULL AND (name GLOB ? OR tbl_name GLOB ?)
      ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`)
      .all(pattern, pattern) as Array<{ type: string; name: string }>;
    for (const artifact of artifacts) {
      if (artifact.type === "trigger") db.exec(`DROP TRIGGER ${quoteIdentifier(artifact.name)}`);
      if (artifact.type === "index") db.exec(`DROP INDEX ${quoteIdentifier(artifact.name)}`);
    }
    for (const artifact of artifacts) {
      if (artifact.type === "table") db.exec(`DROP TABLE ${quoteIdentifier(artifact.name)}`);
    }
  }
  db.prepare("UPDATE meta SET value=? WHERE key='schemaVersion'").run(String(version));
  db.pragma("foreign_keys=ON");
  db.close();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
