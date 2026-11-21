-- Optional out-of-combat ready-check coordination state. This is not a turn
-- lock and is not stored in consent_events.
CREATE TABLE campaign_ready_check_state (
      campaign_id TEXT NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      session_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision >= 0),
      check_json TEXT CHECK(check_json IS NULL OR (json_valid(check_json) AND json_type(check_json)='object')),
      updated_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at),
      PRIMARY KEY(campaign_id, session_id),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
CREATE TABLE campaign_ready_check_receipts (
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
      occurred_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision >= 0),
      check_json TEXT CHECK(check_json IS NULL OR (json_valid(check_json) AND json_type(check_json)='object')),
      PRIMARY KEY(campaign_id, session_id, idempotency_key),
      FOREIGN KEY(campaign_id, session_id) REFERENCES campaign_ready_check_state(campaign_id, session_id) ON DELETE CASCADE
    );
