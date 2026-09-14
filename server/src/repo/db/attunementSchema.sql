-- Item attunements: the bounded per-actor magic-item attunement set. The
-- encounter magic-item engine enforces the SRD maximum of three attunements.
CREATE TABLE actor_item_attunements_v65 (
      campaign_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      item_key TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 128 AND item_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      pack_id TEXT NOT NULL,
      pack_version TEXT NOT NULL,
      definition_id TEXT NOT NULL CHECK (length(definition_id) BETWEEN 1 AND 128 AND definition_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      attuned_at TEXT NOT NULL CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', attuned_at) = attuned_at),
      PRIMARY KEY (campaign_id, actor_id, item_key),
      FOREIGN KEY (actor_id) REFERENCES campaign_actors(id) ON DELETE RESTRICT
    );
