import type DatabaseDriver from "better-sqlite3";

/** Additive storage owned by the reviewed campaign-content generation command. */
export function createCampaignContentGenerationV41(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE campaign_opening_narratives_v41 (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
      opening_text TEXT NOT NULL CHECK(length(opening_text) BETWEEN 1 AND 4000),
      campaign_premise TEXT NOT NULL CHECK(length(campaign_premise) BETWEEN 1 AND 4000),
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE campaign_npc_baseline_stats_v41 (
      campaign_id TEXT NOT NULL, npc_id TEXT NOT NULL, body INTEGER NOT NULL CHECK(body BETWEEN 1 AND 20),
      mind INTEGER NOT NULL CHECK(mind BETWEEN 1 AND 20), presence INTEGER NOT NULL CHECK(presence BETWEEN 1 AND 20),
      source TEXT NOT NULL CHECK(source='generated-deterministic-baseline'),
      PRIMARY KEY(campaign_id,npc_id), FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT
    );
    CREATE TABLE generated_campaign_quests_v41 (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT, quest_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200), description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 4000),
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      PRIMARY KEY(campaign_id,quest_id)
    );
  `);
}
export function migrate40to41(db: DatabaseDriver.Database): void {
  db.transaction(() => { createCampaignContentGenerationV41(db); db.prepare("UPDATE meta SET value='41' WHERE key='schemaVersion'").run(); })();
}
