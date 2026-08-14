import type DatabaseDriver from "better-sqlite3";

const TABLES = ["campaign_material_delivery_revisions_v53", "campaign_material_delivery_commands_v53",
  "campaign_material_delivery_receipts_v53", "campaign_material_deliveries_v53"] as const;

/** Explicit, append-only publication for player-safe generated handouts and scene prompts. */
export function createCampaignMaterialDeliveryV53(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE campaign_material_delivery_revisions_v53 (
      campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id) ON DELETE RESTRICT,
      revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 9007199254740991),
      updated_at TEXT NOT NULL CHECK(length(updated_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',updated_at)=updated_at)
    );
    CREATE TABLE campaign_material_delivery_commands_v53 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      artifact_key TEXT NOT NULL CHECK(length(artifact_key) BETWEEN 1 AND 64 AND artifact_key NOT GLOB '*[^a-z0-9-]*'),
      idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      resulting_revision INTEGER NOT NULL CHECK(resulting_revision=expected_revision+1),
      created_at TEXT NOT NULL CHECK(length(created_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',created_at)=created_at),
      CHECK(length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      CHECK(length(principal_id) BETWEEN 1 AND 128 AND principal_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      PRIMARY KEY(campaign_id,command_id), UNIQUE(campaign_id,idempotency_key), UNIQUE(campaign_id,resulting_revision),
      FOREIGN KEY(campaign_id) REFERENCES campaign_material_delivery_revisions_v53(campaign_id) DEFERRABLE INITIALLY DEFERRED,
      FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,artifact_key) REFERENCES campaign_generation_accepted_artifacts_v52(campaign_id,artifact_key) ON DELETE RESTRICT
    );
    CREATE TABLE campaign_material_delivery_receipts_v53 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, resulting_revision INTEGER NOT NULL,
      canonical_result_json TEXT NOT NULL CHECK(json_valid(canonical_result_json) AND json_type(canonical_result_json)='object'),
      occurred_at TEXT NOT NULL CHECK(length(occurred_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at)=occurred_at),
      PRIMARY KEY(campaign_id,command_id), UNIQUE(campaign_id,resulting_revision),
      FOREIGN KEY(campaign_id,command_id) REFERENCES campaign_material_delivery_commands_v53(campaign_id,command_id) ON DELETE RESTRICT
    );
    CREATE TABLE campaign_material_deliveries_v53 (
      campaign_id TEXT NOT NULL, artifact_key TEXT NOT NULL, resource_id TEXT NOT NULL,
      command_id TEXT NOT NULL, published_at TEXT NOT NULL CHECK(length(published_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',published_at)=published_at),
      PRIMARY KEY(campaign_id,artifact_key), UNIQUE(campaign_id,resource_id),
      FOREIGN KEY(campaign_id,artifact_key) REFERENCES campaign_generation_accepted_artifacts_v52(campaign_id,artifact_key) ON DELETE RESTRICT,
      FOREIGN KEY(campaign_id,command_id) REFERENCES campaign_material_delivery_commands_v53(campaign_id,command_id) ON DELETE RESTRICT
    );
    CREATE TRIGGER campaign_material_delivery_revision_advance_v53 BEFORE UPDATE ON campaign_material_delivery_revisions_v53
      WHEN NEW.campaign_id<>OLD.campaign_id OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'material delivery revision must advance once'); END;
    CREATE TRIGGER campaign_material_delivery_command_guard_v53 BEFORE INSERT ON campaign_material_delivery_commands_v53
      WHEN NOT EXISTS(SELECT 1 FROM campaign_memberships member WHERE member.campaign_id=NEW.campaign_id AND member.principal_id=NEW.principal_id AND member.role IN ('owner','gm'))
        OR NOT EXISTS(SELECT 1 FROM campaign_material_delivery_revisions_v53 root WHERE root.campaign_id=NEW.campaign_id AND root.revision=NEW.expected_revision)
        OR NOT EXISTS(SELECT 1 FROM campaign_generation_accepted_artifacts_v52 artifact WHERE artifact.campaign_id=NEW.campaign_id AND artifact.artifact_key=NEW.artifact_key
          AND artifact.visibility='public' AND artifact.artifact_kind IN ('handout','scene-prompt') AND artifact.server_resource_id IS NOT NULL)
      BEGIN SELECT RAISE(ABORT,'material delivery command is invalid'); END;
    CREATE TRIGGER campaign_material_delivery_projection_guard_v53 BEFORE INSERT ON campaign_material_deliveries_v53
      WHEN NOT EXISTS(SELECT 1 FROM campaign_material_delivery_commands_v53 command JOIN campaign_generation_accepted_artifacts_v52 artifact USING(campaign_id,artifact_key)
        WHERE command.campaign_id=NEW.campaign_id AND command.command_id=NEW.command_id AND command.artifact_key=NEW.artifact_key
          AND command.created_at=NEW.published_at AND artifact.server_resource_id=NEW.resource_id)
      BEGIN SELECT RAISE(ABORT,'material delivery projection is invalid'); END;
  `);
  for (const table of ["campaign_material_delivery_commands_v53", "campaign_material_delivery_receipts_v53", "campaign_material_deliveries_v53"] as const) {
    db.exec(`CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'v53 campaign material records are immutable'); END;
      CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'v53 campaign material records are immutable'); END;`);
  }
}

export function migrate52to53(db: DatabaseDriver.Database): void {
  db.transaction(() => { createCampaignMaterialDeliveryV53(db); db.prepare("UPDATE meta SET value='53' WHERE key='schemaVersion'").run(); })();
}

export function assertCampaignMaterialDeliveryLayoutV53(db: DatabaseDriver.Database): void {
  for (const table of TABLES) if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error(`schema v53 ${table} is missing`);
}
