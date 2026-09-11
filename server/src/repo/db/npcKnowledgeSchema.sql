CREATE TABLE agent_observations (
  observation_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  timeline_id TEXT NOT NULL,
  agent_kind TEXT NOT NULL CHECK(agent_kind IN ('npc','faction','companion','town')),
  agent_id TEXT NOT NULL CHECK(length(agent_id) BETWEEN 1 AND 200),
  source_command_id TEXT NOT NULL CHECK(length(source_command_id) BETWEEN 1 AND 200),
  observed_revision INTEGER NOT NULL CHECK(observed_revision BETWEEN 0 AND 9007199254740991),
  channel TEXT NOT NULL CHECK(channel IN ('witnessed','told','refuted')),
  relayer_agent_id TEXT CHECK(relayer_agent_id IS NULL OR length(relayer_agent_id) BETWEEN 1 AND 200),
  hop_count INTEGER NOT NULL CHECK(hop_count BETWEEN 0 AND 8),
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2048),
  authority TEXT NOT NULL CHECK(authority IN ('rumor','verified','belief')),
  created_at TEXT NOT NULL CHECK(length(created_at)=24),
  CHECK((channel='witnessed' AND hop_count=0 AND relayer_agent_id IS NULL)
    OR (channel IN ('told','refuted') AND hop_count>=1 AND relayer_agent_id IS NOT NULL))
);
CREATE UNIQUE INDEX agent_observations_natural_key ON agent_observations(campaign_id,agent_kind,agent_id,source_command_id,hop_count,ifnull(relayer_agent_id,''));
CREATE TRIGGER agent_observations_update BEFORE UPDATE ON agent_observations BEGIN SELECT RAISE(ABORT,'agent observation is immutable'); END;
CREATE TRIGGER agent_observations_delete BEFORE DELETE ON agent_observations BEGIN SELECT RAISE(ABORT,'agent observation is immutable'); END;
CREATE TRIGGER agent_observations_replace BEFORE INSERT ON agent_observations WHEN EXISTS(SELECT 1 FROM agent_observations WHERE campaign_id=NEW.campaign_id AND agent_kind=NEW.agent_kind AND agent_id=NEW.agent_id AND source_command_id=NEW.source_command_id AND hop_count=NEW.hop_count AND ifnull(relayer_agent_id,'')=ifnull(NEW.relayer_agent_id,'')) BEGIN SELECT RAISE(ABORT,'agent observation cannot be replaced'); END;
