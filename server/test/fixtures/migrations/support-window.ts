import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { createRepository } from "../../../src/repo/index.js";

const AT = "2035-01-01T00:00:00.000Z";
const V42_TABLES = ["campaign_content_layout_attestation_v42", "campaign_content_revisions_v42", "campaign_content_receipts_v42", "campaign_content_commands_v42"];

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
  otherCampaignId?: string;
  otherDraftId?: string;
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
  const db = new DatabaseDriver(databaseFile());
  db.pragma("foreign_keys=ON");
  db.prepare("INSERT INTO campaign_npcs_v28 VALUES(?,?,?,'manual',?,?)")
    .run(npcId, campaign.id, character.id, SUPPORT_WINDOW.npcName, AT);
  db.prepare("INSERT INTO campaign_npc_private_state_v28 VALUES(?,?,?,'',NULL)")
    .run(campaign.id, npcId, "Keep the road open.");
  db.close();
  return {
    campaignId: campaign.id,
    draftId: draft.draftId,
    npcId,
    ...(otherCampaign === undefined || otherDraft === undefined ? {} : {
      otherCampaignId: otherCampaign.id,
      otherDraftId: otherDraft.draftId,
    }),
  };
}

function removeV42(db: DatabaseDriver.Database): void {
  for (const table of V42_TABLES) {
    db.exec(`DROP TRIGGER IF EXISTS ${table}_immutable_update_v42`);
    db.exec(`DROP TRIGGER IF EXISTS ${table}_immutable_delete_v42`);
    db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

/** Builds a populated v40 database containing no v41 or v42 artifacts. */
export function buildCanonicalV40Fixture(): SupportWindowFixture {
  const fixture = createCanonicalCampaign();
  const db = new DatabaseDriver(databaseFile());
  removeV42(db);
  db.exec("DROP TABLE IF EXISTS generated_campaign_quests_v41; DROP TABLE IF EXISTS campaign_npc_baseline_stats_v41; DROP TABLE IF EXISTS campaign_opening_narratives_v41;");
  db.prepare("UPDATE meta SET value='40' WHERE key='schemaVersion'").run();
  db.close();
  return fixture;
}

/** Builds a populated v41 database with valid generation ancestry and no v42 artifacts. */
export function buildCanonicalV41Fixture(): SupportWindowFixture {
  const fixture = createCanonicalCampaign();
  const db = new DatabaseDriver(databaseFile());
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
