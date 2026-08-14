import type DatabaseDriver from "better-sqlite3";

const TABLES = [
  "campaign_generation_jobs_v52", "campaign_generation_attempts_v52",
  "campaign_generation_candidate_artifacts_v52", "campaign_generation_dependencies_v52",
  "campaign_generation_accepted_artifacts_v52", "generated_npc_placement_intents_v52",
] as const;

/** Sparse section candidates, explicit retry attempts, accepted-key resolution, and deferred NPC placement. */
export function createCampaignGenerationExpansionV52(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE campaign_generation_jobs_v52 (
      job_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed')),
      attempt_count INTEGER NOT NULL CHECK(attempt_count BETWEEN 1 AND 32),
      draft_id TEXT REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      last_outcome_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(campaign_id,idempotency_key),
      CHECK((state='running' AND draft_id IS NULL AND last_outcome_code IS NULL)
        OR (state='succeeded' AND draft_id IS NOT NULL AND last_outcome_code='ok')
        OR (state='failed' AND draft_id IS NULL AND last_outcome_code IS NOT NULL))
    );
    CREATE TABLE campaign_generation_attempts_v52 (
      job_id TEXT NOT NULL REFERENCES campaign_generation_jobs_v52(job_id) ON DELETE RESTRICT,
      attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 32),
      retry_count INTEGER NOT NULL CHECK(retry_count=attempt-1),
      provider TEXT NOT NULL, requested_model TEXT NOT NULL, response_model TEXT,
      operation TEXT NOT NULL, stage TEXT NOT NULL, prompt_version TEXT NOT NULL, schema_version TEXT NOT NULL,
      prompt_tokens INTEGER CHECK(prompt_tokens IS NULL OR prompt_tokens>=0),
      completion_tokens INTEGER CHECK(completion_tokens IS NULL OR completion_tokens>=0),
      total_tokens INTEGER CHECK(total_tokens IS NULL OR total_tokens>=0),
      latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms>=0),
      estimated_cost_usd REAL CHECK(estimated_cost_usd IS NULL OR estimated_cost_usd>=0),
      started_at TEXT NOT NULL, terminal_at TEXT, outcome_code TEXT,
      PRIMARY KEY(job_id,attempt),
      CHECK((terminal_at IS NULL AND outcome_code IS NULL AND prompt_tokens IS NULL AND completion_tokens IS NULL
        AND total_tokens IS NULL AND latency_ms IS NULL AND estimated_cost_usd IS NULL)
        OR (terminal_at IS NOT NULL AND outcome_code IS NOT NULL))
    );
    CREATE UNIQUE INDEX campaign_generation_attempts_v52_one_running
      ON campaign_generation_attempts_v52(job_id) WHERE terminal_at IS NULL;
    CREATE TABLE campaign_generation_candidate_artifacts_v52 (
      draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      artifact_key TEXT NOT NULL, artifact_kind TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')),
      canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json) AND json_type(canonical_json)='object'),
      PRIMARY KEY(draft_id,artifact_key)
    );
    CREATE TABLE campaign_generation_dependencies_v52 (
      draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      artifact_key TEXT NOT NULL, canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64),
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      server_resource_id TEXT,
      PRIMARY KEY(draft_id,artifact_key)
    );
    CREATE TABLE campaign_generation_accepted_artifacts_v52 (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
      artifact_key TEXT NOT NULL, artifact_kind TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK(visibility IN ('public','gm')),
      canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json) AND json_type(canonical_json)='object'),
      canonical_digest TEXT NOT NULL CHECK(length(canonical_digest)=64),
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      server_resource_id TEXT, accepted_at TEXT NOT NULL,
      PRIMARY KEY(campaign_id,artifact_key)
    );
    CREATE INDEX campaign_generation_accepted_artifacts_v52_draft
      ON campaign_generation_accepted_artifacts_v52(source_draft_id,artifact_kind);
    CREATE TABLE generated_npc_placement_intents_v52 (
      campaign_id TEXT NOT NULL, npc_id TEXT NOT NULL, location_id TEXT NOT NULL,
      source_draft_id TEXT NOT NULL REFERENCES generation_drafts(id) ON DELETE RESTRICT,
      state TEXT NOT NULL CHECK(state IN ('pending','placed')), session_id TEXT,
      created_at TEXT NOT NULL, reconciled_at TEXT,
      PRIMARY KEY(campaign_id,npc_id),
      FOREIGN KEY(campaign_id,npc_id) REFERENCES campaign_npcs_v28(campaign_id,npc_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,location_id) REFERENCES campaign_locations_v28(campaign_id,location_id) ON DELETE RESTRICT,
      CHECK((state='pending' AND session_id IS NULL AND reconciled_at IS NULL)
        OR (state='placed' AND session_id IS NOT NULL AND reconciled_at IS NOT NULL))
    );
    CREATE INDEX generated_npc_placement_intents_v52_pending
      ON generated_npc_placement_intents_v52(campaign_id,state);
  `);
  for (const table of ["campaign_generation_candidate_artifacts_v52",
    "campaign_generation_dependencies_v52", "campaign_generation_accepted_artifacts_v52"] as const) {
    db.exec(`CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table}
      BEGIN SELECT RAISE(ABORT,'v52 campaign generation records are immutable'); END;
      CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table}
      BEGIN SELECT RAISE(ABORT,'v52 campaign generation records are immutable'); END;`);
  }
}

export function migrate51to52(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createCampaignGenerationExpansionV52(db);
    db.prepare("UPDATE meta SET value='52' WHERE key='schemaVersion'").run();
  })();
}

export function assertCampaignGenerationExpansionLayoutV52(db: DatabaseDriver.Database): void {
  for (const table of TABLES) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
      throw new Error(`schema v52 ${table} is missing`);
    }
  }
  const runningIndex = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='campaign_generation_attempts_v52_one_running'").get();
  if (!runningIndex) throw new Error("schema v52 running-attempt guard is missing");
}
