-- Actor journey executions: append-only authoritative settlements for
-- server-authored multi-hop travel. There is deliberately no mutable journey
-- table. The latest execution for a journey_id (by occurred_at, then implicit
-- rowid) is the current state; result_json retains destination, status, and any
-- interruption, and a resume chain records the prior settlement through
-- request_json.previousCommandId. Execution history is never updated or deleted.
CREATE TABLE world_actor_journey_executions_v1 (
      command_id TEXT PRIMARY KEY CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 128 AND session_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 128 AND actor_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
       turn_id TEXT NOT NULL UNIQUE CHECK(length(turn_id) BETWEEN 1 AND 128 AND turn_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      journey_id TEXT NOT NULL CHECK(length(journey_id) BETWEEN 1 AND 128 AND journey_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 128 AND principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      request_json TEXT NOT NULL CHECK(length(request_json) BETWEEN 2 AND 32768 AND json_valid(request_json) AND json_type(request_json)='object'),
      request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      result_json TEXT NOT NULL CHECK(length(result_json) BETWEEN 2 AND 32768 AND json_valid(result_json) AND json_type(result_json)='object'),
      result_digest TEXT NOT NULL CHECK(length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*'),
      occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) IS NOT NULL AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
      UNIQUE(campaign_id,command_id),
      FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,turn_id) REFERENCES adventure_turns(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(principal_id) REFERENCES principals(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
CREATE INDEX world_actor_journey_executions_v1_journey_id ON world_actor_journey_executions_v1(journey_id);
CREATE TRIGGER world_actor_journey_executions_v1_immutable_update BEFORE UPDATE ON world_actor_journey_executions_v1
      BEGIN SELECT RAISE(ABORT,'actor journey executions are immutable'); END;
CREATE TRIGGER world_actor_journey_executions_v1_immutable_delete BEFORE DELETE ON world_actor_journey_executions_v1
      BEGIN SELECT RAISE(ABORT,'actor journey executions are immutable'); END;

-- Route event profiles: mutable, operator-authored travel metadata keyed to one
-- authoritative connection. Each row selects the encounter environment/risk and
-- the bounded per-connection event chance. This table is intentionally mutable
-- (no immutability guards); it holds no player or journey history.
CREATE TABLE world_route_event_profiles_v1 (
      campaign_id TEXT NOT NULL CHECK(length(campaign_id) BETWEEN 1 AND 128 AND campaign_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      connection_id TEXT NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 128 AND connection_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      environment TEXT NOT NULL CHECK(environment IN ('urban','road','wilderness','water')),
      risk TEXT NOT NULL CHECK(risk IN ('safe','watched','dangerous')),
      chance_percent INTEGER NOT NULL CHECK(typeof(chance_percent)='integer' AND chance_percent BETWEEN 0 AND 100),
      PRIMARY KEY(campaign_id,connection_id),
      FOREIGN KEY(campaign_id,connection_id) REFERENCES campaign_location_connections_v28(campaign_id,connection_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
