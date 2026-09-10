CREATE TABLE campaign_context_inspection_headers_v61 (
  dispatch_id TEXT PRIMARY KEY,
  provenance_version INTEGER NOT NULL CHECK(provenance_version=1),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('adventure-planning','adventure-narration','director-planning','director-narration')),
  recorded_phase TEXT NOT NULL CHECK(recorded_phase IN ('planned','narrated')),
  source_visibility TEXT NOT NULL CHECK(source_visibility IN ('public','revoked','private')),
  created_at TEXT NOT NULL,
  CHECK(length(dispatch_id) BETWEEN 1 AND 200)
);
CREATE TABLE campaign_context_inspection_sources_v61 (
  dispatch_id TEXT NOT NULL REFERENCES campaign_context_inspection_headers_v61(dispatch_id) ON DELETE RESTRICT,
  source_order INTEGER NOT NULL CHECK(source_order BETWEEN 0 AND 15),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('none','story','location','quest','travel','receipt')),
  source_id TEXT,
  source_label TEXT NOT NULL CHECK(length(source_label)<=200),
  authority TEXT NOT NULL CHECK(authority IN ('system-safety','current-authoritative-state','intent','noncanonical-presentation','committed-outcome','authored-recap')),
  CHECK((source_kind='none' AND source_id IS NULL) OR (source_kind<>'none' AND source_id IS NOT NULL)),
  PRIMARY KEY(dispatch_id,source_order)
);
CREATE TRIGGER campaign_context_inspection_headers_v61_update BEFORE UPDATE ON campaign_context_inspection_headers_v61 BEGIN SELECT RAISE(ABORT,'context inspection header is immutable'); END;
CREATE TRIGGER campaign_context_inspection_headers_v61_delete BEFORE DELETE ON campaign_context_inspection_headers_v61 BEGIN SELECT RAISE(ABORT,'context inspection header is immutable'); END;
CREATE TRIGGER campaign_context_inspection_headers_v61_replace BEFORE INSERT ON campaign_context_inspection_headers_v61 WHEN EXISTS(SELECT 1 FROM campaign_context_inspection_headers_v61 WHERE dispatch_id=NEW.dispatch_id) BEGIN SELECT RAISE(ABORT,'context inspection header cannot be replaced'); END;
CREATE TRIGGER campaign_context_inspection_sources_v61_update BEFORE UPDATE ON campaign_context_inspection_sources_v61 BEGIN SELECT RAISE(ABORT,'context inspection source is immutable'); END;
CREATE TRIGGER campaign_context_inspection_sources_v61_delete BEFORE DELETE ON campaign_context_inspection_sources_v61 BEGIN SELECT RAISE(ABORT,'context inspection source is immutable'); END;
CREATE TRIGGER campaign_context_inspection_sources_v61_replace BEFORE INSERT ON campaign_context_inspection_sources_v61 WHEN EXISTS(SELECT 1 FROM campaign_context_inspection_sources_v61 WHERE dispatch_id=NEW.dispatch_id AND source_order=NEW.source_order) BEGIN SELECT RAISE(ABORT,'context inspection source cannot be replaced'); END;
