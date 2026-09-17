CREATE TABLE system_one_decisions_v1 (
  decision_id TEXT PRIMARY KEY CHECK(length(decision_id) BETWEEN 1 AND 128 AND decision_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
  lane TEXT NOT NULL CHECK(length(lane) BETWEEN 1 AND 64),
  campaign_id TEXT CHECK(campaign_id IS NULL OR length(campaign_id) BETWEEN 1 AND 128),
  session_id TEXT CHECK(session_id IS NULL OR length(session_id) BETWEEN 1 AND 128),
  turn_id TEXT CHECK(turn_id IS NULL OR length(turn_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 64),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 256),
  confidence_policy_version TEXT NOT NULL CHECK(length(confidence_policy_version) BETWEEN 1 AND 64),
  request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
  questions_digest TEXT NOT NULL CHECK(length(questions_digest)=64 AND questions_digest NOT GLOB '*[^0-9a-f]*'),
  state_digest TEXT NOT NULL CHECK(length(state_digest)=64 AND state_digest NOT GLOB '*[^0-9a-f]*'),
  request_json TEXT NOT NULL,
  questions_json TEXT NOT NULL,
  state_json TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  selection_json TEXT NOT NULL,
  confidence_band TEXT NOT NULL CHECK(confidence_band IN ('act','confirm','fallback')),
  fallback_used INTEGER NOT NULL CHECK(fallback_used IN (0,1)),
  shadow INTEGER NOT NULL CHECK(shadow IN (0,1)),
  usage_json TEXT,
  latency_ms INTEGER NOT NULL CHECK(typeof(latency_ms)='integer' AND latency_ms BETWEEN 0 AND 600000),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_system_one_decisions_lane_v1 ON system_one_decisions_v1(lane,created_at);
CREATE TRIGGER system_one_decisions_v1_update BEFORE UPDATE ON system_one_decisions_v1 BEGIN SELECT RAISE(ABORT,'system one decisions are immutable'); END;
CREATE TRIGGER system_one_decisions_v1_delete BEFORE DELETE ON system_one_decisions_v1 BEGIN SELECT RAISE(ABORT,'system one decisions are immutable'); END;
CREATE TRIGGER system_one_decisions_v1_replace BEFORE INSERT ON system_one_decisions_v1 WHEN EXISTS(SELECT 1 FROM system_one_decisions_v1 WHERE decision_id=NEW.decision_id) BEGIN SELECT RAISE(ABORT,'system one decision cannot be replaced'); END;
