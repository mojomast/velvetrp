-- Explicit GM take-over of an absent player's actor. The original controller
-- keeps their claim so they can reclaim the actor when they return.
CREATE TABLE actor_handoff_v68 (
      campaign_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      original_controller_principal_id TEXT NOT NULL,
      taken_over_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',taken_over_at)=taken_over_at),
      PRIMARY KEY(campaign_id,session_id,actor_id),
      FOREIGN KEY(session_id) REFERENCES campaign_sessions(session_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,actor_id) REFERENCES campaign_actors(campaign_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,original_controller_principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
    );
