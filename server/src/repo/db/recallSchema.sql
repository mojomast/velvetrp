CREATE TABLE adventure_narration_contexts (
  claim_id TEXT PRIMARY KEY REFERENCES adventure_narration_dispatches_v60(claim_id) ON DELETE RESTRICT,
  context_json TEXT NOT NULL CHECK(json_valid(context_json) AND json_type(context_json)='object' AND length(CAST(context_json AS BLOB))<=131072),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND json_type(request_json)='object' AND length(CAST(request_json AS BLOB))<=262144)
);
CREATE TRIGGER adventure_narration_contexts_update BEFORE UPDATE ON adventure_narration_contexts BEGIN SELECT RAISE(ABORT,'narration context is immutable'); END;
CREATE TRIGGER adventure_narration_contexts_delete BEFORE DELETE ON adventure_narration_contexts BEGIN SELECT RAISE(ABORT,'narration context is immutable'); END;
CREATE TRIGGER adventure_narration_contexts_replace BEFORE INSERT ON adventure_narration_contexts WHEN EXISTS(SELECT 1 FROM adventure_narration_contexts WHERE claim_id=NEW.claim_id) BEGIN SELECT RAISE(ABORT,'narration context is immutable'); END;
