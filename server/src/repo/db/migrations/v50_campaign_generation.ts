import type DatabaseDriver from "better-sqlite3";

/** Durable coordination and provenance for generated campaign canon. */
export function createCampaignGenerationV50(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE campaign_generation_calls_v50 (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      state TEXT NOT NULL CHECK(state IN ('started','succeeded','failed')),
      provider TEXT NOT NULL, model TEXT NOT NULL, operation TEXT NOT NULL, stage TEXT NOT NULL,
      prompt_version TEXT NOT NULL, schema_version TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 32),
      prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0), completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),
      latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms>=0), estimated_cost_usd REAL CHECK(estimated_cost_usd IS NULL OR estimated_cost_usd>=0),
      started_at TEXT NOT NULL, terminal_at TEXT,
      draft_id TEXT REFERENCES generation_drafts(id) ON DELETE RESTRICT, job_id TEXT NOT NULL, outcome_code TEXT,
      PRIMARY KEY(campaign_id,idempotency_key),
      CHECK((state='started' AND terminal_at IS NULL AND draft_id IS NULL AND outcome_code IS NULL)
        OR (state='succeeded' AND terminal_at IS NOT NULL AND draft_id IS NOT NULL AND outcome_code='ok')
        OR (state='failed' AND terminal_at IS NOT NULL AND draft_id IS NULL AND outcome_code IS NOT NULL))
    );
    CREATE TABLE campaign_generation_artifacts_v50 (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      artifact_key TEXT NOT NULL, artifact_kind TEXT NOT NULL CHECK(artifact_kind IN
        ('opening','location','connection','faction','npc','quest','storyline')),
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')),
      canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json) AND json_type(canonical_json)='object'),
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL, PRIMARY KEY(campaign_id,artifact_key)
    );
    CREATE INDEX campaign_generation_artifacts_v50_draft ON campaign_generation_artifacts_v50(source_draft_id,artifact_kind);
    CREATE TRIGGER campaign_generation_artifacts_v50_immutable_update BEFORE UPDATE ON campaign_generation_artifacts_v50 BEGIN SELECT RAISE(ABORT,'v50 generation artifacts are immutable'); END;
    CREATE TRIGGER campaign_generation_artifacts_v50_immutable_delete BEFORE DELETE ON campaign_generation_artifacts_v50 BEGIN SELECT RAISE(ABORT,'v50 generation artifacts are immutable'); END;
  `);
}

export function migrate49to50(db: DatabaseDriver.Database): void {
  db.transaction(() => { createCampaignGenerationV50(db); db.prepare("UPDATE meta SET value='50' WHERE key='schemaVersion'").run(); })();
}

export function assertCampaignGenerationLayoutV50(db: DatabaseDriver.Database): void {
  const required = ["campaign_generation_calls_v50", "campaign_generation_artifacts_v50",
    "campaign_generation_artifacts_v50_draft", "campaign_generation_artifacts_v50_immutable_update",
    "campaign_generation_artifacts_v50_immutable_delete"];
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE name IN (${required.map(() => "?").join(",")})`).all(...required) as Array<{ name: string }>;
  if (rows.length !== required.length) throw new Error("schema v50 campaign generation is incompatible");
}
