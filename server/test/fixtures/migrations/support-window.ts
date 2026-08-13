import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { createRepository } from "../../../src/repo/index.js";
import { ORIGINAL_STARTER_BACKGROUND, ORIGINAL_STARTER_CLASS, ORIGINAL_STARTER_RACE } from "@velvet/contracts";
import { createCompanionCoreV44 } from "../../../src/repo/db/migrations/v44_companion_core.js";
import { COMPANION_CORE_V45_MANAGED_OBJECTS } from "../../../src/repo/db/migrations/v45_companion_principals.js";
import { EXACT_CANDIDATE_V46_MANAGED_OBJECTS } from "../../../src/repo/db/migrations/v46_exact_candidates.js";
import { migrate44to45 } from "../../../src/repo/db/migrations/v45_companion_principals.js";
import { EXACT_CANDIDATE_EXECUTION_V47_MANAGED_OBJECTS } from "../../../src/repo/db/migrations/v47_exact_candidate_executions.js";

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
