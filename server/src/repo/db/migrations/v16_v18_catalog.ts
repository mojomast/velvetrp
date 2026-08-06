// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import DatabaseDriver from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalCatalogJson, deriveCatalogVisibility, validateContentCatalog } from "../../contentCatalogRepo.js";

/** Additive v16 catalog sidecars; existing v10 content tables are unchanged. */
export function createContentCatalogV16(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_content_pack_publications (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      validation_level TEXT NOT NULL CHECK (validation_level IN ('legacy-v10','validated-v1')),
      rules_engine TEXT CHECK (rules_engine IS NULL OR rules_engine='velvet-starter-v1'),
      manifest_digest TEXT CHECK (manifest_digest IS NULL OR (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*')),
      manifest_json TEXT CHECK (manifest_json IS NULL OR (json_valid(manifest_json) AND json_type(manifest_json)='object')),
      provenance_json TEXT CHECK (provenance_json IS NULL OR (json_valid(provenance_json) AND json_type(provenance_json)='object')),
      validation_report_json TEXT CHECK (validation_report_json IS NULL OR (json_valid(validation_report_json) AND json_type(validation_report_json)='object')),
      published_by_principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT, published_at TEXT,
      PRIMARY KEY (pack_id,pack_version),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_packs(pack_id,pack_version) ON DELETE RESTRICT,
      CHECK ((validation_level='legacy-v10' AND rules_engine IS NULL AND manifest_digest IS NULL AND manifest_json IS NULL
          AND provenance_json IS NULL AND validation_report_json IS NULL AND published_by_principal_id IS NULL AND published_at IS NULL)
        OR (validation_level='validated-v1' AND rules_engine='velvet-starter-v1' AND manifest_digest IS NOT NULL
          AND manifest_json IS NOT NULL AND provenance_json IS NOT NULL AND validation_report_json IS NOT NULL
          AND published_by_principal_id IS NOT NULL AND published_at IS NOT NULL))
    );
    CREATE INDEX idx_rpg_content_pack_publications_validation ON rpg_content_pack_publications(validation_level,pack_id,pack_version);
    CREATE TABLE rpg_catalog_definitions (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('race','background','class','class-level','skill','ability','spell','item','currency','enemy-template')),
      definition_id TEXT NOT NULL CHECK (length(definition_id) BETWEEN 1 AND 128 AND definition_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND json_type(definition_json)='object'),
      public_definition_json TEXT NOT NULL CHECK (json_valid(public_definition_json) AND json_type(public_definition_json)='object'),
      dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json) AND json_type(dependencies_json)='array'),
      PRIMARY KEY (pack_id,pack_version,kind,definition_id),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_packs(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE INDEX idx_rpg_catalog_definitions_pack ON rpg_catalog_definitions(pack_id,pack_version,kind,definition_id);
    CREATE TABLE campaign_content_catalog_selections (
      campaign_id TEXT PRIMARY KEY, rules_profile_id TEXT NOT NULL,
      selection_digest TEXT NOT NULL CHECK (length(selection_digest)=64 AND selection_digest NOT GLOB '*[^0-9a-f]*'),
      configured_by_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT, configured_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id,rules_profile_id) REFERENCES campaign_rules_profiles(campaign_id,rules_profile_id) ON DELETE CASCADE
    );
    CREATE TABLE campaign_content_catalog_pins (
      campaign_id TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (typeof(position)='integer' AND position BETWEEN 0 AND 63),
      PRIMARY KEY (campaign_id,pack_id), UNIQUE (campaign_id,position),
      FOREIGN KEY (campaign_id) REFERENCES campaign_content_catalog_selections(campaign_id) ON DELETE CASCADE,
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_content_catalog_pins_exact ON campaign_content_catalog_pins(pack_id,pack_version,campaign_id);
    CREATE TRIGGER rpg_content_pack_publications_require_validated_pack BEFORE INSERT ON rpg_content_pack_publications
      WHEN NEW.validation_level='validated-v1' AND NOT EXISTS (SELECT 1 FROM rpg_content_packs pack
        WHERE pack.pack_id=NEW.pack_id AND pack.pack_version=NEW.pack_version AND pack.sealed=1)
      BEGIN SELECT RAISE(ABORT,'validated publication requires an exact sealed pack'); END;
    CREATE TRIGGER campaign_content_catalog_pins_require_validated BEFORE INSERT ON campaign_content_catalog_pins
      WHEN NOT EXISTS (SELECT 1 FROM rpg_content_pack_publications publication WHERE publication.pack_id=NEW.pack_id
        AND publication.pack_version=NEW.pack_version AND publication.validation_level='validated-v1')
        OR NOT EXISTS (SELECT 1 FROM campaign_content_packs pin WHERE pin.campaign_id=NEW.campaign_id
          AND pin.pack_id=NEW.pack_id AND pin.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'campaign catalog pins require validated-v1 publication'); END;
    CREATE TRIGGER rpg_content_packs_prevent_replace_v16 BEFORE INSERT ON rpg_content_packs
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version AND old.sealed=1)
      BEGIN SELECT RAISE(ABORT,'sealed RPG content packs are immutable'); END;
    CREATE TRIGGER rpg_definitions_prevent_replace_v16 BEFORE INSERT ON rpg_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_definitions old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id)
      BEGIN SELECT RAISE(ABORT,'RPG definitions are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_immutable_update BEFORE UPDATE ON rpg_content_pack_publications BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_immutable_delete BEFORE DELETE ON rpg_content_pack_publications BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_prevent_replace BEFORE INSERT ON rpg_content_pack_publications
      WHEN EXISTS (SELECT 1 FROM rpg_content_pack_publications old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_immutable_update BEFORE UPDATE ON rpg_catalog_definitions BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_immutable_delete BEFORE DELETE ON rpg_catalog_definitions BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_prevent_sealed_insert BEFORE INSERT ON rpg_catalog_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs pack WHERE pack.pack_id=NEW.pack_id AND pack.pack_version=NEW.pack_version AND pack.sealed=1)
      BEGIN SELECT RAISE(ABORT,'sealed RPG content catalogs cannot accept definitions'); END;
    CREATE TRIGGER rpg_catalog_definitions_prevent_replace BEFORE INSERT ON rpg_catalog_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_catalog_definitions old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id)
      BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_selections_immutable_update BEFORE UPDATE ON campaign_content_catalog_selections BEGIN SELECT RAISE(ABORT,'campaign catalog selections are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_selections_immutable_delete BEFORE DELETE ON campaign_content_catalog_selections
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id) BEGIN SELECT RAISE(ABORT,'campaign catalog selections are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_selections_prevent_replace BEFORE INSERT ON campaign_content_catalog_selections
      WHEN EXISTS (SELECT 1 FROM campaign_content_catalog_selections old WHERE old.campaign_id=NEW.campaign_id) BEGIN SELECT RAISE(ABORT,'campaign catalog selections are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_pins_immutable_update BEFORE UPDATE ON campaign_content_catalog_pins BEGIN SELECT RAISE(ABORT,'campaign catalog pins are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_pins_immutable_delete BEFORE DELETE ON campaign_content_catalog_pins
      WHEN EXISTS (SELECT 1 FROM campaigns campaign WHERE campaign.id=OLD.campaign_id) BEGIN SELECT RAISE(ABORT,'campaign catalog pins are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_pins_prevent_replace BEFORE INSERT ON campaign_content_catalog_pins
      WHEN EXISTS (SELECT 1 FROM campaign_content_catalog_pins old WHERE old.campaign_id=NEW.campaign_id
        AND (old.pack_id=NEW.pack_id OR old.position=NEW.position)) BEGIN SELECT RAISE(ABORT,'campaign catalog pins are immutable'); END;
  `);
  db.prepare(`INSERT INTO rpg_content_pack_publications
    (pack_id,pack_version,validation_level,rules_engine,manifest_digest,manifest_json,provenance_json,
      validation_report_json,published_by_principal_id,published_at)
    SELECT pack_id,pack_version,'legacy-v10',NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM rpg_content_packs
    WHERE sealed=1 ORDER BY pack_id COLLATE BINARY,pack_version COLLATE BINARY`).run();
}

/** @deprecated Retained as migration history only. */
function createContentCatalogV17LegacyCurrent(db: DatabaseDriver.Database): void {
  const retainedFixtureTables = ["rpg_content_pack_publications", "rpg_catalog_definitions",
    "campaign_content_catalog_selections", "campaign_content_catalog_pins"];
  const retainedCount = retainedFixtureTables.filter((name) => db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
  ).get(name)).length;
  if (retainedCount === retainedFixtureTables.length) {
    // Historical migration tests rewind a database marker after removing only
    // the version-under-test objects. Preserve complete later sidecars, but do
    // not accept a genuinely partial v16 attempt.
    db.prepare(`INSERT INTO rpg_content_pack_publications
      (pack_id,pack_version,validation_level,rules_engine,manifest_digest,manifest_json,provenance_json,
        validation_report_json,definition_count,definition_counts_json,published_by_principal_id,published_at)
      SELECT pack.pack_id,pack.pack_version,'legacy-v10',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM rpg_content_packs pack
      WHERE pack.sealed=1 AND NOT EXISTS (SELECT 1 FROM rpg_content_pack_publications publication
        WHERE publication.pack_id=pack.pack_id AND publication.pack_version=pack.pack_version)
      ORDER BY pack.pack_id COLLATE BINARY,pack.pack_version COLLATE BINARY`).run();
    // Rewinding older migration fixtures may have dropped and recreated the
    // v10 parent tables, which removes only triggers attached to those tables.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS rpg_content_packs_prevent_replace_v16 BEFORE INSERT ON rpg_content_packs
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version AND old.sealed=1)
      BEGIN SELECT RAISE(ABORT,'sealed RPG content packs are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS rpg_definitions_prevent_replace_v16 BEFORE INSERT ON rpg_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_definitions old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id)
      BEGIN SELECT RAISE(ABORT,'RPG definitions are immutable'); END;
    `);
    return;
  }
  db.exec(`
    CREATE TABLE rpg_content_pack_publications (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      validation_level TEXT NOT NULL CHECK (validation_level IN ('legacy-v10','validated-v1')),
      rules_engine TEXT CHECK (rules_engine IS NULL OR rules_engine='velvet-starter-v1'),
      manifest_digest TEXT CHECK (manifest_digest IS NULL OR (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*')),
      manifest_json TEXT CHECK (manifest_json IS NULL OR (json_valid(manifest_json) AND json_type(manifest_json)='object')),
      provenance_json TEXT CHECK (provenance_json IS NULL OR (json_valid(provenance_json) AND json_type(provenance_json)='object')),
      validation_report_json TEXT CHECK (validation_report_json IS NULL OR (json_valid(validation_report_json) AND json_type(validation_report_json)='object')),
      definition_count INTEGER CHECK (definition_count IS NULL OR (typeof(definition_count)='integer' AND definition_count BETWEEN 1 AND 1024)),
      definition_counts_json TEXT CHECK (definition_counts_json IS NULL OR (json_valid(definition_counts_json) AND json_type(definition_counts_json)='array')),
      published_by_principal_id TEXT REFERENCES principals(id) ON DELETE RESTRICT, published_at TEXT,
      PRIMARY KEY (pack_id,pack_version),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_packs(pack_id,pack_version) ON DELETE RESTRICT,
      CHECK ((validation_level='legacy-v10' AND rules_engine IS NULL AND manifest_digest IS NULL AND manifest_json IS NULL
          AND provenance_json IS NULL AND validation_report_json IS NULL AND definition_count IS NULL
          AND definition_counts_json IS NULL AND published_by_principal_id IS NULL AND published_at IS NULL)
        OR (validation_level='validated-v1' AND rules_engine='velvet-starter-v1' AND manifest_digest IS NOT NULL
          AND manifest_json IS NOT NULL AND provenance_json IS NOT NULL AND validation_report_json IS NOT NULL
          AND definition_count IS NOT NULL AND definition_counts_json IS NOT NULL
          AND published_by_principal_id IS NOT NULL AND published_at IS NOT NULL
          AND json_extract(manifest_json,'$.packId')=pack_id AND json_extract(manifest_json,'$.packVersion')=pack_version
          AND json_extract(manifest_json,'$.digest')=manifest_digest
          AND json_extract(manifest_json,'$.compatibility.catalogFormat')='validated-v1'
          AND json_extract(manifest_json,'$.compatibility.rulesEngine')='velvet-starter-v1'
          AND json_extract(validation_report_json,'$.valid')=1
          AND json_array_length(json_extract(validation_report_json,'$.issues'))=0
          AND json_extract(validation_report_json,'$.normalizedSummary.totalDefinitions')=definition_count
          AND json_extract(validation_report_json,'$.normalizedSummary.digest')=manifest_digest
          AND json_extract(validation_report_json,'$.normalizedSummary.counts')=definition_counts_json))
    );
    CREATE INDEX idx_rpg_content_pack_publications_validation ON rpg_content_pack_publications(validation_level,pack_id,pack_version);
    CREATE TABLE rpg_catalog_definitions (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('race','background','class','class-level','skill','ability','spell','item','currency','enemy-template')),
      definition_id TEXT NOT NULL CHECK (length(definition_id) BETWEEN 1 AND 128 AND definition_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND json_type(definition_json)='object'),
      public_definition_json TEXT NOT NULL CHECK (json_valid(public_definition_json) AND json_type(public_definition_json)='object'),
      dependencies_json TEXT NOT NULL CHECK (json_valid(dependencies_json) AND json_type(dependencies_json)='array'),
      public_dependencies_json TEXT NOT NULL CHECK (json_valid(public_dependencies_json) AND json_type(public_dependencies_json)='array'),
      private_dependencies_json TEXT NOT NULL CHECK (json_valid(private_dependencies_json) AND json_type(private_dependencies_json)='array'),
      PRIMARY KEY (pack_id,pack_version,kind,definition_id),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_packs(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE INDEX idx_rpg_catalog_definitions_pack ON rpg_catalog_definitions(pack_id,pack_version,kind,definition_id);
    CREATE TABLE campaign_content_catalog_selections (
      campaign_id TEXT PRIMARY KEY, rules_profile_id TEXT NOT NULL,
      selection_digest TEXT NOT NULL CHECK (length(selection_digest)=64 AND selection_digest NOT GLOB '*[^0-9a-f]*'),
      configured_by_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT, configured_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id,rules_profile_id) REFERENCES campaign_rules_profiles(campaign_id,rules_profile_id) ON DELETE CASCADE
    );
    CREATE TABLE campaign_content_catalog_pins (
      campaign_id TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (typeof(position)='integer' AND position BETWEEN 0 AND 63),
      PRIMARY KEY (campaign_id,pack_id), UNIQUE (campaign_id,position),
      FOREIGN KEY (campaign_id) REFERENCES campaign_content_catalog_selections(campaign_id) ON DELETE CASCADE,
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_content_catalog_pins_exact ON campaign_content_catalog_pins(pack_id,pack_version,campaign_id);
    CREATE TABLE campaign_catalog_commands (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL CHECK (length(command_id) BETWEEN 1 AND 128 AND command_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
      actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      expected_revision INTEGER NOT NULL CHECK (typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740990),
      request_digest TEXT NOT NULL CHECK (length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      requested_json TEXT NOT NULL CHECK (json_valid(requested_json) AND json_type(requested_json)='object'),
      created_at TEXT NOT NULL,
      PRIMARY KEY (campaign_id,command_id), UNIQUE (campaign_id,idempotency_key),
      UNIQUE (campaign_id,command_id,expected_revision), CHECK (command_id=idempotency_key),
      CHECK (json_extract(requested_json,'$.expectedRevision')=expected_revision
        AND json_extract(requested_json,'$.idempotencyKey')=idempotency_key)
    );
    CREATE TABLE campaign_catalog_events (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL,
      event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 128 AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'),
      revision_before INTEGER NOT NULL, revision INTEGER NOT NULL CHECK (revision=revision_before+1),
      occurred_at TEXT NOT NULL, public_data TEXT NOT NULL CHECK (json_valid(public_data) AND json_type(public_data)='object'),
      PRIMARY KEY (campaign_id,event_id), UNIQUE (campaign_id,command_id), UNIQUE (campaign_id,revision),
      FOREIGN KEY (campaign_id,command_id,revision_before) REFERENCES campaign_catalog_commands(campaign_id,command_id,expected_revision) ON DELETE RESTRICT,
      UNIQUE (campaign_id,command_id,event_id,revision_before,revision), CHECK (event_id=command_id)
    );
    CREATE TABLE campaign_catalog_receipts (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, event_id TEXT NOT NULL,
      revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL CHECK (revision_after=revision_before+1),
      result_json TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json)='object'),
      PRIMARY KEY (campaign_id,command_id),
      FOREIGN KEY (campaign_id,command_id,event_id,revision_before,revision_after)
        REFERENCES campaign_catalog_events(campaign_id,command_id,event_id,revision_before,revision) ON DELETE RESTRICT
    );
    CREATE TRIGGER rpg_content_pack_publications_require_validated_pack BEFORE INSERT ON rpg_content_pack_publications
      WHEN NEW.validation_level='validated-v1' AND NOT EXISTS (SELECT 1 FROM rpg_content_packs pack
        WHERE pack.pack_id=NEW.pack_id AND pack.pack_version=NEW.pack_version AND pack.sealed=1)
      BEGIN SELECT RAISE(ABORT,'validated publication requires an exact sealed pack'); END;
    CREATE TRIGGER rpg_content_pack_publications_validate_graph BEFORE INSERT ON rpg_content_pack_publications
      WHEN NEW.validation_level='validated-v1' AND (
        json_extract(NEW.manifest_json,'$.compatibility.rulesProfileId') IS NOT (SELECT rules_profile_id FROM rpg_content_packs
          WHERE pack_id=NEW.pack_id AND pack_version=NEW.pack_version)
        OR json_extract(NEW.manifest_json,'$.name') IS NOT (SELECT name FROM rpg_content_packs
          WHERE pack_id=NEW.pack_id AND pack_version=NEW.pack_version)
        OR json_extract(NEW.manifest_json,'$.description') IS NOT (SELECT description FROM rpg_content_packs
          WHERE pack_id=NEW.pack_id AND pack_version=NEW.pack_version)
        OR json_extract(NEW.manifest_json,'$.tags') IS NOT (SELECT tags FROM rpg_content_packs
          WHERE pack_id=NEW.pack_id AND pack_version=NEW.pack_version)
        OR NEW.definition_count<>(SELECT COUNT(*) FROM rpg_catalog_definitions
          WHERE pack_id=NEW.pack_id AND pack_version=NEW.pack_version)
        OR json_array_length(NEW.definition_counts_json)<>10
        OR (SELECT COUNT(DISTINCT json_extract(count.value,'$.kind')) FROM json_each(NEW.definition_counts_json) count)<>10
        OR (SELECT SUM(json_extract(count.value,'$.count')) FROM json_each(NEW.definition_counts_json) count)<>NEW.definition_count
        OR EXISTS (SELECT 1 FROM json_each(NEW.definition_counts_json) count
          WHERE json_extract(count.value,'$.count')<>(SELECT COUNT(*) FROM rpg_catalog_definitions definition
            WHERE definition.pack_id=NEW.pack_id AND definition.pack_version=NEW.pack_version
              AND definition.kind=json_extract(count.value,'$.kind')))
      ) BEGIN SELECT RAISE(ABORT,'validated publication graph is inconsistent'); END;
    CREATE TRIGGER rpg_catalog_definitions_validate_identity BEFORE INSERT ON rpg_catalog_definitions
      WHEN json_extract(NEW.definition_json,'$.reference.packId') IS NOT NEW.pack_id
        OR json_extract(NEW.definition_json,'$.reference.packVersion') IS NOT NEW.pack_version
        OR json_extract(NEW.definition_json,'$.reference.kind') IS NOT NEW.kind
        OR json_extract(NEW.definition_json,'$.reference.definitionId') IS NOT NEW.definition_id
        OR json_extract(NEW.public_definition_json,'$.reference.packId') IS NOT NEW.pack_id
        OR json_extract(NEW.public_definition_json,'$.reference.packVersion') IS NOT NEW.pack_version
        OR json_extract(NEW.public_definition_json,'$.reference.kind') IS NOT NEW.kind
        OR json_extract(NEW.public_definition_json,'$.reference.definitionId') IS NOT NEW.definition_id
        OR json_type(NEW.public_definition_json,'$.private') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'catalog definition identity is inconsistent'); END;
    CREATE TRIGGER campaign_content_catalog_pins_require_validated BEFORE INSERT ON campaign_content_catalog_pins
      WHEN NOT EXISTS (SELECT 1 FROM rpg_content_pack_publications publication WHERE publication.pack_id=NEW.pack_id
        AND publication.pack_version=NEW.pack_version AND publication.validation_level='validated-v1')
        OR NOT EXISTS (SELECT 1 FROM campaign_content_packs pin WHERE pin.campaign_id=NEW.campaign_id
          AND pin.pack_id=NEW.pack_id AND pin.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'campaign catalog pins require validated-v1 publication'); END;
    CREATE TRIGGER rpg_content_packs_prevent_replace_v16 BEFORE INSERT ON rpg_content_packs
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version AND old.sealed=1)
      BEGIN SELECT RAISE(ABORT,'sealed RPG content packs are immutable'); END;
    CREATE TRIGGER rpg_definitions_prevent_replace_v16 BEFORE INSERT ON rpg_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_definitions old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id)
      BEGIN SELECT RAISE(ABORT,'RPG definitions are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_immutable_update BEFORE UPDATE ON rpg_content_pack_publications BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_immutable_delete BEFORE DELETE ON rpg_content_pack_publications BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_content_pack_publications_prevent_replace BEFORE INSERT ON rpg_content_pack_publications
      WHEN EXISTS (SELECT 1 FROM rpg_content_pack_publications old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'RPG content publications are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_immutable_update BEFORE UPDATE ON rpg_catalog_definitions BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_immutable_delete BEFORE DELETE ON rpg_catalog_definitions BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER rpg_catalog_definitions_prevent_sealed_insert BEFORE INSERT ON rpg_catalog_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_content_packs pack WHERE pack.pack_id=NEW.pack_id
        AND pack.pack_version=NEW.pack_version AND pack.sealed=1)
      BEGIN SELECT RAISE(ABORT,'sealed RPG content catalogs cannot accept definitions'); END;
    CREATE TRIGGER rpg_catalog_definitions_prevent_replace BEFORE INSERT ON rpg_catalog_definitions
      WHEN EXISTS (SELECT 1 FROM rpg_catalog_definitions old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id)
      BEGIN SELECT RAISE(ABORT,'RPG catalog definitions are immutable'); END;
    CREATE TRIGGER campaign_content_catalog_selections_require_open_command_insert BEFORE INSERT ON campaign_content_catalog_selections
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        WHERE command.campaign_id=NEW.campaign_id AND receipt.command_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'campaign catalog selection requires an open catalog command'); END;
    CREATE TRIGGER campaign_content_catalog_selections_require_open_command_update BEFORE UPDATE ON campaign_content_catalog_selections
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        WHERE command.campaign_id=NEW.campaign_id AND receipt.command_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'campaign catalog selection requires an open catalog command'); END;
    CREATE TRIGGER campaign_content_catalog_selections_require_open_command_delete BEFORE DELETE ON campaign_content_catalog_selections
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        WHERE command.campaign_id=OLD.campaign_id AND receipt.command_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'campaign catalog selection requires an open catalog command'); END;
    CREATE TRIGGER campaign_content_catalog_pins_require_open_command_insert BEFORE INSERT ON campaign_content_catalog_pins
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        WHERE command.campaign_id=NEW.campaign_id AND receipt.command_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'campaign catalog pins require an open catalog command'); END;
    CREATE TRIGGER campaign_content_catalog_pins_require_open_command_delete BEFORE DELETE ON campaign_content_catalog_pins
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
        WHERE command.campaign_id=OLD.campaign_id AND receipt.command_id IS NULL)
      BEGIN SELECT RAISE(ABORT,'campaign catalog pins require an open catalog command'); END;
    CREATE TRIGGER campaign_catalog_commands_immutable_update BEFORE UPDATE ON campaign_catalog_commands BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_commands_immutable_delete BEFORE DELETE ON campaign_catalog_commands BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_commands_prevent_replace BEFORE INSERT ON campaign_catalog_commands
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_commands old WHERE old.campaign_id=NEW.campaign_id
        AND (old.command_id=NEW.command_id OR old.idempotency_key=NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_immutable_update BEFORE UPDATE ON campaign_catalog_events BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_immutable_delete BEFORE DELETE ON campaign_catalog_events BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_prevent_replace BEFORE INSERT ON campaign_catalog_events
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_events old WHERE old.campaign_id=NEW.campaign_id
        AND (old.event_id=NEW.event_id OR old.command_id=NEW.command_id OR old.revision=NEW.revision))
      BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_immutable_update BEFORE UPDATE ON campaign_catalog_receipts BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_immutable_delete BEFORE DELETE ON campaign_catalog_receipts BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_prevent_replace BEFORE INSERT ON campaign_catalog_receipts
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_receipts old WHERE old.campaign_id=NEW.campaign_id AND old.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_validate_result BEFORE INSERT ON campaign_catalog_receipts
      WHEN json_extract(NEW.result_json,'$.campaignId') IS NOT NEW.campaign_id
        OR json_extract(NEW.result_json,'$.commandId') IS NOT NEW.command_id
        OR json_extract(NEW.result_json,'$.revisionBefore') IS NOT NEW.revision_before
        OR json_extract(NEW.result_json,'$.revisionAfter') IS NOT NEW.revision_after
      BEGIN SELECT RAISE(ABORT,'campaign catalog receipt result is inconsistent'); END;
  `);
  db.prepare(`INSERT INTO rpg_content_pack_publications
    (pack_id,pack_version,validation_level,rules_engine,manifest_digest,manifest_json,provenance_json,
      validation_report_json,definition_count,definition_counts_json,published_by_principal_id,published_at)
    SELECT pack_id,pack_version,'legacy-v10',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL FROM rpg_content_packs
    WHERE sealed=1 ORDER BY pack_id COLLATE BINARY,pack_version COLLATE BINARY`).run();
}

export function canonicalV17(value: unknown): string {
  const sort = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(sort)
    : entry !== null && typeof entry === "object" ? Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, sort(child)])) : entry;
  return JSON.stringify(sort(value));
}

function v17DefinitionDependencies(definition: any): { publicRefs: unknown[]; privateRefs: unknown[] } {
  const mechanics = definition.mechanics ?? {};
  switch (definition.reference?.kind) {
    case "race": return { publicRefs: mechanics.abilityRefs ?? [], privateRefs: [] };
    case "background": return { publicRefs: [...(mechanics.skillRefs ?? []), ...(mechanics.itemRefs ?? []), mechanics.startingCurrency?.currency].filter(Boolean), privateRefs: [] };
    case "class": return { publicRefs: mechanics.levelRefs ?? [], privateRefs: [] };
    case "class-level": return { publicRefs: [mechanics.classRef, ...(mechanics.abilityRefs ?? []), ...(mechanics.spellRefs ?? [])].filter(Boolean), privateRefs: [] };
    case "item": return { publicRefs: [mechanics.price?.currency].filter(Boolean), privateRefs: [] };
    case "enemy-template": return { publicRefs: mechanics.abilityRefs ?? [], privateRefs: [...(definition.private?.hiddenAbilityRefs ?? []), ...(definition.private?.hiddenRefs ?? [])] };
    default: return { publicRefs: [], privateRefs: [] };
  }
}

function v17Reachable(rows: Array<{ key: string; kind: string; publicRefs: any[]; privateRefs: any[] }>): Set<string> {
  const keyOf = (ref: any) => `${ref.kind}\0${ref.definitionId}`;
  const keys = new Set(rows.map((row) => row.key)), all = new Map<string,string[]>(), publicEdges = new Map<string,string[]>();
  const directPrivate = new Set<string>(), incoming = new Map<string,number>();
  for (const row of rows) {
    const pub = row.publicRefs.map(keyOf).filter((key) => keys.has(key));
    const priv = row.privateRefs.map(keyOf).filter((key) => keys.has(key));
    publicEdges.set(row.key,pub); all.set(row.key,[...pub,...priv]);
    for (const key of pub) incoming.set(key,(incoming.get(key) ?? 0)+1);
    for (const key of priv) directPrivate.add(key);
  }
  const privateClosure = new Set<string>(), pendingPrivate=[...directPrivate];
  while (pendingPrivate.length) { const key=pendingPrivate.shift()!; if (privateClosure.has(key)) continue;
    privateClosure.add(key); pendingPrivate.push(...(all.get(key) ?? [])); }
  const roots = rows.filter((row) => !privateClosure.has(row.key)
    && (["race","background","class","enemy-template"].includes(row.kind) || (incoming.get(row.key) ?? 0)===0)).map((row)=>row.key);
  const reachable = new Set<string>();
  while (roots.length) { const key=roots.shift()!; if (reachable.has(key)) continue; reachable.add(key); roots.push(...(publicEdges.get(key) ?? [])); }
  return reachable;
}

export function createContentCatalogV17(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE rpg_catalog_publication_attestations (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL,
      definition_count INTEGER NOT NULL CHECK (typeof(definition_count)='integer' AND definition_count BETWEEN 1 AND 1024),
      definition_counts_json TEXT NOT NULL CHECK (json_valid(definition_counts_json) AND json_type(definition_counts_json)='array'),
      publication_digest TEXT NOT NULL CHECK (length(publication_digest)=64 AND publication_digest NOT GLOB '*[^0-9a-f]*'),
      public_projection_digest TEXT NOT NULL CHECK (length(public_projection_digest)=64 AND public_projection_digest NOT GLOB '*[^0-9a-f]*'),
      public_projection_count INTEGER NOT NULL CHECK (public_projection_count=definition_count),
      PRIMARY KEY (pack_id,pack_version),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE TABLE rpg_catalog_definition_visibility (
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, kind TEXT NOT NULL, definition_id TEXT NOT NULL,
      public_definition_json TEXT NOT NULL CHECK (json_valid(public_definition_json) AND json_type(public_definition_json)='object'),
      public_dependencies_json TEXT NOT NULL CHECK (json_valid(public_dependencies_json) AND json_type(public_dependencies_json)='array'),
      private_dependencies_json TEXT NOT NULL CHECK (json_valid(private_dependencies_json) AND json_type(private_dependencies_json)='array'),
      row_digest TEXT NOT NULL CHECK (length(row_digest)=64 AND row_digest NOT GLOB '*[^0-9a-f]*'),
      publicly_reachable INTEGER NOT NULL CHECK (publicly_reachable IN (0,1)),
      PRIMARY KEY (pack_id,pack_version,kind,definition_id),
      FOREIGN KEY (pack_id,pack_version,kind,definition_id)
        REFERENCES rpg_catalog_definitions(pack_id,pack_version,kind,definition_id) ON DELETE RESTRICT
    );
    CREATE TABLE rpg_catalog_publication_submissions (
      principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL CHECK (length(request_digest)=64),
      pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
      created_at TEXT NOT NULL, PRIMARY KEY (principal_id,idempotency_key), UNIQUE (pack_id,pack_version),
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE TABLE campaign_catalog_current_selections (
      campaign_id TEXT PRIMARY KEY, rules_profile_id TEXT NOT NULL, selection_digest TEXT NOT NULL CHECK (length(selection_digest)=64),
      configured_by_principal_id TEXT NOT NULL REFERENCES principals(id), configured_at TEXT NOT NULL,
      open_command_id TEXT NOT NULL,
      FOREIGN KEY (campaign_id,rules_profile_id) REFERENCES campaign_rules_profiles(campaign_id,rules_profile_id) ON DELETE CASCADE
    );
    CREATE TABLE campaign_catalog_current_pins (
      campaign_id TEXT NOT NULL, pack_id TEXT NOT NULL, pack_version TEXT NOT NULL, position INTEGER NOT NULL,
      open_command_id TEXT NOT NULL, PRIMARY KEY (campaign_id,pack_id), UNIQUE (campaign_id,position),
      FOREIGN KEY (campaign_id) REFERENCES campaign_catalog_current_selections(campaign_id) ON DELETE CASCADE,
      FOREIGN KEY (pack_id,pack_version) REFERENCES rpg_content_pack_publications(pack_id,pack_version) ON DELETE RESTRICT
    );
    CREATE TABLE campaign_catalog_commands (
      campaign_id TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      command_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, actor_principal_id TEXT NOT NULL REFERENCES principals(id),
      expected_revision INTEGER NOT NULL, request_digest TEXT NOT NULL CHECK (length(request_digest)=64),
      target_selection_digest TEXT NOT NULL CHECK (length(target_selection_digest)=64),
      requested_json TEXT NOT NULL CHECK (json_valid(requested_json)), created_at TEXT NOT NULL,
      PRIMARY KEY (campaign_id,command_id), UNIQUE (campaign_id,idempotency_key),
      UNIQUE (campaign_id,command_id,expected_revision,target_selection_digest)
    );
    CREATE TABLE campaign_catalog_events (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, event_id TEXT NOT NULL,
      revision_before INTEGER NOT NULL, revision INTEGER NOT NULL CHECK (revision=revision_before+1),
      occurred_at TEXT NOT NULL, public_data TEXT NOT NULL CHECK (json_valid(public_data)),
      PRIMARY KEY (campaign_id,event_id), UNIQUE (campaign_id,command_id), UNIQUE (campaign_id,revision),
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_catalog_commands(campaign_id,command_id) ON DELETE RESTRICT,
      UNIQUE (campaign_id,command_id,event_id,revision_before,revision)
    );
    CREATE TABLE campaign_catalog_receipts (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL, event_id TEXT NOT NULL,
      revision_before INTEGER NOT NULL, revision_after INTEGER NOT NULL CHECK (revision_after=revision_before+1),
      result_json TEXT NOT NULL CHECK (json_valid(result_json)), PRIMARY KEY (campaign_id,command_id),
      FOREIGN KEY (campaign_id,command_id,event_id,revision_before,revision_after)
        REFERENCES campaign_catalog_events(campaign_id,command_id,event_id,revision_before,revision) ON DELETE RESTRICT
    );
    CREATE TRIGGER rpg_catalog_attestations_immutable_update BEFORE UPDATE ON rpg_catalog_publication_attestations BEGIN SELECT RAISE(ABORT,'catalog attestations are immutable'); END;
    CREATE TRIGGER rpg_catalog_attestations_immutable_delete BEFORE DELETE ON rpg_catalog_publication_attestations BEGIN SELECT RAISE(ABORT,'catalog attestations are immutable'); END;
    CREATE TRIGGER rpg_catalog_attestations_prevent_replace BEFORE INSERT ON rpg_catalog_publication_attestations
      WHEN EXISTS (SELECT 1 FROM rpg_catalog_publication_attestations old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'catalog attestations are immutable'); END;
    CREATE TRIGGER rpg_catalog_attestations_validate_insert BEFORE INSERT ON rpg_catalog_publication_attestations
      WHEN NEW.definition_count<>(SELECT COUNT(*) FROM rpg_catalog_definitions definition
          WHERE definition.pack_id=NEW.pack_id AND definition.pack_version=NEW.pack_version)
        OR NEW.public_projection_count<>(SELECT COUNT(*) FROM rpg_catalog_definition_visibility visibility
          WHERE visibility.pack_id=NEW.pack_id AND visibility.pack_version=NEW.pack_version)
        OR NEW.publication_digest IS NOT (SELECT publication.manifest_digest FROM rpg_content_pack_publications publication
          WHERE publication.pack_id=NEW.pack_id AND publication.pack_version=NEW.pack_version)
      BEGIN SELECT RAISE(ABORT,'catalog attestation graph is inconsistent'); END;
    CREATE TRIGGER rpg_catalog_visibility_immutable_update BEFORE UPDATE ON rpg_catalog_definition_visibility BEGIN SELECT RAISE(ABORT,'catalog visibility is immutable'); END;
    CREATE TRIGGER rpg_catalog_visibility_immutable_delete BEFORE DELETE ON rpg_catalog_definition_visibility BEGIN SELECT RAISE(ABORT,'catalog visibility is immutable'); END;
    CREATE TRIGGER rpg_catalog_visibility_prevent_replace BEFORE INSERT ON rpg_catalog_definition_visibility
      WHEN EXISTS (SELECT 1 FROM rpg_catalog_definition_visibility old WHERE old.pack_id=NEW.pack_id AND old.pack_version=NEW.pack_version
        AND old.kind=NEW.kind AND old.definition_id=NEW.definition_id) BEGIN SELECT RAISE(ABORT,'catalog visibility is immutable'); END;
    CREATE TRIGGER rpg_catalog_visibility_validate_insert BEFORE INSERT ON rpg_catalog_definition_visibility
      WHEN json_extract(NEW.public_definition_json,'$.reference.packId') IS NOT NEW.pack_id
        OR json_extract(NEW.public_definition_json,'$.reference.packVersion') IS NOT NEW.pack_version
        OR json_extract(NEW.public_definition_json,'$.reference.kind') IS NOT NEW.kind
        OR json_extract(NEW.public_definition_json,'$.reference.definitionId') IS NOT NEW.definition_id
        OR json_type(NEW.public_definition_json,'$.private') IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'catalog visibility identity is inconsistent'); END;
    CREATE TRIGGER rpg_catalog_submissions_immutable_update BEFORE UPDATE ON rpg_catalog_publication_submissions BEGIN SELECT RAISE(ABORT,'catalog submissions are immutable'); END;
    CREATE TRIGGER rpg_catalog_submissions_immutable_delete BEFORE DELETE ON rpg_catalog_publication_submissions BEGIN SELECT RAISE(ABORT,'catalog submissions are immutable'); END;
    CREATE TRIGGER rpg_catalog_submissions_prevent_replace BEFORE INSERT ON rpg_catalog_publication_submissions
      WHEN EXISTS (SELECT 1 FROM rpg_catalog_publication_submissions old WHERE old.principal_id=NEW.principal_id
        AND old.idempotency_key=NEW.idempotency_key) BEGIN SELECT RAISE(ABORT,'catalog submissions are immutable'); END;
    CREATE TRIGGER rpg_catalog_submissions_validate_insert BEFORE INSERT ON rpg_catalog_publication_submissions
      WHEN json_extract(NEW.receipt_json,'$.packId') IS NOT NEW.pack_id
        OR json_extract(NEW.receipt_json,'$.packVersion') IS NOT NEW.pack_version
      BEGIN SELECT RAISE(ABORT,'catalog submission receipt is inconsistent'); END;
    CREATE TRIGGER campaign_catalog_commands_require_owner_revision BEFORE INSERT ON campaign_catalog_commands
      WHEN EXISTS (SELECT 1 FROM campaign_administration_commands command WHERE command.campaign_id=NEW.campaign_id
          AND (command.command_id=NEW.command_id OR command.idempotency_key=NEW.idempotency_key))
        OR NOT EXISTS (SELECT 1 FROM campaigns campaign JOIN campaign_memberships membership
        ON membership.campaign_id=campaign.id AND membership.principal_id=NEW.actor_principal_id AND membership.role='owner'
        JOIN principals principal ON principal.id=membership.principal_id WHERE campaign.id=NEW.campaign_id
          AND campaign.owner_principal_id=NEW.actor_principal_id AND campaign.owner_role='owner'
          AND campaign.administration_revision=NEW.expected_revision
          AND (SELECT COUNT(*) FROM campaign_memberships owners WHERE owners.campaign_id=campaign.id AND owners.role='owner')=1)
      BEGIN SELECT RAISE(ABORT,'catalog command requires canonical owner at current revision'); END;
    CREATE TRIGGER campaign_catalog_selection_bind_insert BEFORE INSERT ON campaign_catalog_current_selections
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command JOIN campaigns campaign ON campaign.id=command.campaign_id
        WHERE command.campaign_id=NEW.campaign_id AND campaign.administration_revision=command.expected_revision+1
        AND command.command_id=NEW.open_command_id AND command.actor_principal_id=NEW.configured_by_principal_id
        AND command.target_selection_digest=NEW.selection_digest
        AND json_extract(command.requested_json,'$.rulesProfileId')=NEW.rules_profile_id
        AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
        AND NOT EXISTS (SELECT 1 FROM campaign_imported_administration_receipts receipt
          WHERE receipt.campaign_id=NEW.campaign_id AND receipt.source_command_id=NEW.open_command_id
            AND receipt.type='catalog_configured')
      BEGIN SELECT RAISE(ABORT,'catalog selection must bind one exact open command'); END;
    CREATE TRIGGER campaign_catalog_pin_bind_insert BEFORE INSERT ON campaign_catalog_current_pins
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_current_selections selection JOIN campaign_catalog_commands command
        ON command.campaign_id=selection.campaign_id AND command.command_id=selection.open_command_id
        JOIN campaigns campaign ON campaign.id=command.campaign_id
        WHERE selection.campaign_id=NEW.campaign_id AND NEW.open_command_id=command.command_id
          AND campaign.administration_revision=command.expected_revision+1
          AND EXISTS (SELECT 1 FROM json_each(command.requested_json,'$.contentPacks') requested_pin
            WHERE CAST(requested_pin.key AS INTEGER)=NEW.position
              AND json_extract(requested_pin.value,'$.packId')=NEW.pack_id
              AND json_extract(requested_pin.value,'$.packVersion')=NEW.pack_version)
          AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
        AND NOT EXISTS (SELECT 1 FROM campaign_catalog_current_selections selection
          JOIN campaign_imported_administration_receipts receipt ON receipt.campaign_id=selection.campaign_id
            AND receipt.source_command_id=selection.open_command_id AND receipt.type='catalog_configured'
          WHERE selection.campaign_id=NEW.campaign_id AND selection.open_command_id=NEW.open_command_id)
      BEGIN SELECT RAISE(ABORT,'catalog pin must bind one exact open command'); END;
    CREATE TRIGGER campaign_catalog_selection_bind_delete BEFORE DELETE ON campaign_catalog_current_selections
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command JOIN campaigns campaign ON campaign.id=command.campaign_id
        WHERE command.campaign_id=OLD.campaign_id AND campaign.administration_revision=command.expected_revision+1
          AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'catalog selection delete requires one exact open command'); END;
    CREATE TRIGGER campaign_catalog_pin_bind_delete BEFORE DELETE ON campaign_catalog_current_pins
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command JOIN campaigns campaign ON campaign.id=command.campaign_id
        WHERE command.campaign_id=OLD.campaign_id AND campaign.administration_revision=command.expected_revision+1
          AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
      BEGIN SELECT RAISE(ABORT,'catalog pin delete requires one exact open command'); END;
    CREATE TRIGGER campaign_catalog_selection_prevent_update BEFORE UPDATE ON campaign_catalog_current_selections
      BEGIN SELECT RAISE(ABORT,'catalog current selection cannot update'); END;
    CREATE TRIGGER campaign_catalog_pin_prevent_update BEFORE UPDATE ON campaign_catalog_current_pins
      BEGIN SELECT RAISE(ABORT,'catalog current pins cannot update'); END;
    CREATE TRIGGER campaign_catalog_commands_immutable_update BEFORE UPDATE ON campaign_catalog_commands BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_commands_immutable_delete BEFORE DELETE ON campaign_catalog_commands BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_commands_prevent_replace BEFORE INSERT ON campaign_catalog_commands
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_commands old WHERE old.campaign_id=NEW.campaign_id
        AND (old.command_id=NEW.command_id OR old.idempotency_key=NEW.idempotency_key)) BEGIN SELECT RAISE(ABORT,'campaign catalog commands are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_immutable_update BEFORE UPDATE ON campaign_catalog_events BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_immutable_delete BEFORE DELETE ON campaign_catalog_events BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_prevent_replace BEFORE INSERT ON campaign_catalog_events
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_events old WHERE old.campaign_id=NEW.campaign_id
        AND (old.event_id=NEW.event_id OR old.command_id=NEW.command_id OR old.revision=NEW.revision)) BEGIN SELECT RAISE(ABORT,'campaign catalog events are immutable'); END;
    CREATE TRIGGER campaign_catalog_events_validate_provenance BEFORE INSERT ON campaign_catalog_events
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        JOIN campaigns campaign ON campaign.id=command.campaign_id
        JOIN campaign_catalog_current_selections selection ON selection.campaign_id=command.campaign_id
        WHERE command.campaign_id=NEW.campaign_id AND command.command_id=NEW.command_id
          AND command.expected_revision=NEW.revision_before AND NEW.revision=command.expected_revision+1
          AND campaign.administration_revision=NEW.revision
          AND selection.open_command_id=command.command_id
          AND selection.selection_digest=command.target_selection_digest
          AND selection.configured_by_principal_id=command.actor_principal_id
          AND selection.rules_profile_id=json_extract(command.requested_json,'$.rulesProfileId')
          AND (SELECT COUNT(*) FROM campaign_catalog_current_pins pin WHERE pin.campaign_id=command.campaign_id)
            =json_array_length(command.requested_json,'$.contentPacks')
          AND NOT EXISTS (SELECT 1 FROM json_each(command.requested_json,'$.contentPacks') requested_pin
            WHERE NOT EXISTS (SELECT 1 FROM campaign_catalog_current_pins pin
              WHERE pin.campaign_id=command.campaign_id AND pin.position=CAST(requested_pin.key AS INTEGER)
                AND pin.pack_id=json_extract(requested_pin.value,'$.packId')
                AND pin.pack_version=json_extract(requested_pin.value,'$.packVersion')))
          AND json_extract(NEW.public_data,'$.content.campaignId')=NEW.campaign_id
          AND json_extract(NEW.public_data,'$.content.rulesProfileId')=selection.rules_profile_id
          AND NOT EXISTS (SELECT 1 FROM campaign_catalog_receipts receipt
            WHERE receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id))
        OR EXISTS (SELECT 1 FROM campaign_administration_events event
          WHERE event.campaign_id=NEW.campaign_id AND event.revision=NEW.revision)
        OR EXISTS (SELECT 1 FROM campaign_imported_administration_events event
          WHERE event.campaign_id=NEW.campaign_id AND event.revision=NEW.revision)
      BEGIN SELECT RAISE(ABORT,'campaign catalog event provenance is inconsistent'); END;
    CREATE TRIGGER campaign_catalog_receipts_immutable_update BEFORE UPDATE ON campaign_catalog_receipts BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_immutable_delete BEFORE DELETE ON campaign_catalog_receipts BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_prevent_replace BEFORE INSERT ON campaign_catalog_receipts
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_receipts old WHERE old.campaign_id=NEW.campaign_id AND old.command_id=NEW.command_id)
      BEGIN SELECT RAISE(ABORT,'campaign catalog receipts are immutable'); END;
    CREATE TRIGGER campaign_catalog_receipts_validate_result BEFORE INSERT ON campaign_catalog_receipts
      WHEN json_extract(NEW.result_json,'$.campaignId') IS NOT NEW.campaign_id
        OR json_extract(NEW.result_json,'$.commandId') IS NOT NEW.command_id
        OR json_extract(NEW.result_json,'$.idempotencyKey') IS NOT NEW.command_id
        OR json_extract(NEW.result_json,'$.revisionBefore') IS NOT NEW.revision_before
        OR json_extract(NEW.result_json,'$.revisionAfter') IS NOT NEW.revision_after
        OR NOT EXISTS (SELECT 1 FROM campaign_catalog_events event JOIN campaigns campaign ON campaign.id=event.campaign_id
          WHERE event.campaign_id=NEW.campaign_id AND event.command_id=NEW.command_id AND event.event_id=NEW.event_id
            AND event.revision_before=NEW.revision_before AND event.revision=NEW.revision_after
            AND campaign.administration_revision=NEW.revision_after
            AND json_extract(event.public_data,'$.content')=json_extract(NEW.result_json,'$.content'))
      BEGIN SELECT RAISE(ABORT,'campaign catalog receipt result is inconsistent'); END;
    CREATE TRIGGER campaign_administration_commands_reject_catalog_identity BEFORE INSERT ON campaign_administration_commands
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_commands command WHERE command.campaign_id=NEW.campaign_id
        AND (command.command_id=NEW.command_id OR command.idempotency_key=NEW.idempotency_key))
      BEGIN SELECT RAISE(ABORT,'campaign command identity already belongs to catalog history'); END;
    CREATE TRIGGER campaign_administration_events_reject_catalog_revision BEFORE INSERT ON campaign_administration_events
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_events event
        WHERE event.campaign_id=NEW.campaign_id AND event.revision=NEW.revision)
      BEGIN SELECT RAISE(ABORT,'campaign administration revision already belongs to catalog history'); END;
  `);

  const publications = db.prepare(`SELECT publication.*,pack.rules_profile_id FROM rpg_content_pack_publications publication
    JOIN rpg_content_packs pack ON pack.pack_id=publication.pack_id AND pack.pack_version=publication.pack_version
    WHERE publication.validation_level='validated-v1' ORDER BY publication.pack_id,publication.pack_version`).all() as any[];
  const insertVisibility = db.prepare(`INSERT INTO rpg_catalog_definition_visibility
    (pack_id,pack_version,kind,definition_id,public_definition_json,public_dependencies_json,private_dependencies_json,row_digest,publicly_reachable)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const publication of publications) {
    const definitions = db.prepare(`SELECT * FROM rpg_catalog_definitions WHERE pack_id=? AND pack_version=? ORDER BY kind,definition_id`)
      .all(publication.pack_id, publication.pack_version) as any[];
    if (definitions.length === 0) throw new Error("schema v16 validated publication has no catalog definitions");
    const fullDefinitions=definitions.map((row)=>JSON.parse(row.definition_json));
    const migrationInput={idempotencyKey:"schema-v16-derived-validation",manifest:JSON.parse(publication.manifest_json),
      definitions:fullDefinitions};
    const report=validateContentCatalog(migrationInput);
    if(!report.valid||report.normalizedSummary.digest!==publication.manifest_digest)
      throw new Error("schema v16 validated publication graph is invalid");
    const visibility=deriveCatalogVisibility(fullDefinitions);
    for (const entry of visibility.rows) {
      insertVisibility.run(publication.pack_id,publication.pack_version,entry.definition.reference.kind,
        entry.definition.reference.definitionId,entry.publicDefinitionJson,entry.publicDependenciesJson,
        entry.privateDependenciesJson,entry.rowDigest,entry.publiclyReachable ? 1 : 0);
    }
    db.prepare(`INSERT INTO rpg_catalog_publication_attestations VALUES (?,?,?,?,?,?,?)`)
      .run(publication.pack_id,publication.pack_version,definitions.length,
        canonicalCatalogJson(report.normalizedSummary.counts),publication.manifest_digest,visibility.aggregateDigest,definitions.length);
    const key = `migrated-${publication.manifest_digest.slice(0, 32)}`;
    const receipt = canonicalV17({ packId: publication.pack_id, packVersion: publication.pack_version });
    db.prepare(`INSERT INTO rpg_catalog_publication_submissions VALUES (?,?,?,?,?,?,?)`)
      .run(publication.published_by_principal_id,key,publication.manifest_digest,publication.pack_id,publication.pack_version,receipt,publication.published_at);
  }
  const selections=db.prepare(`SELECT selection.*,campaign.administration_revision,campaign.updated_at,campaign.owner_principal_id
    FROM campaign_content_catalog_selections selection JOIN campaigns campaign ON campaign.id=selection.campaign_id
    ORDER BY selection.campaign_id`).all() as any[];
  for(const selection of selections){
    const pins=db.prepare(`SELECT pin.pack_id,pin.pack_version,publication.manifest_digest FROM campaign_content_catalog_pins pin
      JOIN rpg_content_pack_publications publication ON publication.pack_id=pin.pack_id AND publication.pack_version=pin.pack_version
      WHERE pin.campaign_id=? ORDER BY pin.position`).all(selection.campaign_id) as any[];
    if(!pins.length) throw new Error("schema v16 catalog selection has no pins");
    const commandId="migrated-v16-catalog", before=selection.administration_revision, after=before+1;
    const at=new Date(Math.max(Date.parse(selection.configured_at),Date.parse(selection.updated_at)+1)).toISOString();
    const request={rulesProfileId:selection.rules_profile_id,contentPacks:pins.map((pin)=>({packId:pin.pack_id,packVersion:pin.pack_version})),
      expectedRevision:before,idempotencyKey:commandId};
    const requestDigest=createHash("sha256").update(canonicalV17(request)).digest("hex");
    db.prepare(`INSERT INTO campaign_catalog_commands VALUES (?,?,?,?,?,?,?,?,?)`).run(selection.campaign_id,commandId,commandId,
      selection.owner_principal_id,before,requestDigest,selection.selection_digest,canonicalV17(request),at);
    db.prepare(`UPDATE campaigns SET administration_revision=?,updated_at=? WHERE id=?`).run(after,at,selection.campaign_id);
    db.prepare(`INSERT INTO campaign_catalog_current_selections VALUES (?,?,?,?,?,?)`).run(selection.campaign_id,
      selection.rules_profile_id,selection.selection_digest,selection.owner_principal_id,at,commandId);
    const insertPin=db.prepare(`INSERT INTO campaign_catalog_current_pins VALUES (?,?,?,?,?)`);
    pins.forEach((pin,index)=>insertPin.run(selection.campaign_id,pin.pack_id,pin.pack_version,index,commandId));
    const content={campaignId:selection.campaign_id,compatible:true,rulesProfileId:selection.rules_profile_id,
      contentPacks:pins.map((pin)=>({packId:pin.pack_id,packVersion:pin.pack_version,digest:pin.manifest_digest})),issues:[]};
    const receipt={campaignId:selection.campaign_id,commandId,idempotencyKey:commandId,revisionBefore:before,
      revisionAfter:after,configuredAt:at,content};
    db.prepare(`INSERT INTO campaign_catalog_events VALUES (?,?,?,?,?,?,?)`).run(selection.campaign_id,commandId,commandId,before,after,at,
      canonicalV17({content}));
    db.prepare(`INSERT INTO campaign_catalog_receipts VALUES (?,?,?,?,?,?)`).run(selection.campaign_id,commandId,commandId,before,after,canonicalV17(receipt));
  }
}

/** Additive v18 provenance closure for catalog commands. */
export function createContentCatalogV18(db: DatabaseDriver.Database): void {
  db.exec(`
    CREATE TABLE campaign_catalog_command_provenance_v18 (
      campaign_id TEXT NOT NULL, command_id TEXT NOT NULL,
      proposed_event_id TEXT NOT NULL, proposed_event_type TEXT NOT NULL CHECK (proposed_event_type='catalog_configured'),
      actor_principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
      proposed_public_data TEXT NOT NULL CHECK (json_valid(proposed_public_data) AND json_type(proposed_public_data)='object'),
      proposed_result_json TEXT NOT NULL CHECK (json_valid(proposed_result_json) AND json_type(proposed_result_json)='object'),
      PRIMARY KEY (campaign_id,command_id), UNIQUE (campaign_id,proposed_event_id),
      FOREIGN KEY (campaign_id,command_id) REFERENCES campaign_catalog_commands(campaign_id,command_id) ON DELETE RESTRICT
    );
    CREATE INDEX idx_campaign_catalog_command_provenance_v18_event
      ON campaign_catalog_command_provenance_v18(campaign_id,proposed_event_id);
    CREATE TRIGGER campaign_catalog_commands_validate_requested_v18 BEFORE INSERT ON campaign_catalog_commands
      WHEN json(NEW.requested_json)<>NEW.requested_json
        OR NEW.requested_json<>(SELECT json_object(
          'contentPacks',(SELECT json_group_array(json(item)) FROM (SELECT json_object(
            'packId',json_extract(pin.value,'$.packId'),'packVersion',json_extract(pin.value,'$.packVersion')) item
            FROM json_each(NEW.requested_json,'$.contentPacks') pin ORDER BY CAST(pin.key AS INTEGER))),
          'expectedRevision',NEW.expected_revision,'idempotencyKey',NEW.idempotency_key,
          'rulesProfileId',json_extract(NEW.requested_json,'$.rulesProfileId')))
        OR json_type(NEW.requested_json,'$.contentPacks')<>'array'
        OR json_array_length(NEW.requested_json,'$.contentPacks') NOT BETWEEN 1 AND 64
        OR json_extract(NEW.requested_json,'$.expectedRevision') IS NOT NEW.expected_revision
        OR json_extract(NEW.requested_json,'$.idempotencyKey') IS NOT NEW.idempotency_key
        OR json_type(NEW.requested_json,'$.rulesProfileId')<>'text'
        OR EXISTS (SELECT 1 FROM json_each(NEW.requested_json,'$.contentPacks') requested
          LEFT JOIN rpg_content_pack_publications publication
            ON publication.pack_id=json_extract(requested.value,'$.packId')
            AND publication.pack_version=json_extract(requested.value,'$.packVersion')
            AND publication.validation_level='validated-v1'
          LEFT JOIN rpg_content_packs pack ON pack.pack_id=publication.pack_id AND pack.pack_version=publication.pack_version
          WHERE publication.pack_id IS NULL OR pack.sealed<>1
            OR pack.rules_profile_id<>json_extract(NEW.requested_json,'$.rulesProfileId'))
        OR EXISTS (SELECT 1 FROM json_each(NEW.requested_json,'$.contentPacks') left_pin
          JOIN json_each(NEW.requested_json,'$.contentPacks') right_pin ON CAST(right_pin.key AS INTEGER)>CAST(left_pin.key AS INTEGER)
          WHERE json_extract(left_pin.value,'$.packId')>json_extract(right_pin.value,'$.packId')
            OR (json_extract(left_pin.value,'$.packId')=json_extract(right_pin.value,'$.packId')
              AND json_extract(left_pin.value,'$.packVersion')>=json_extract(right_pin.value,'$.packVersion')))
      BEGIN SELECT RAISE(ABORT,'catalog command requested pins are not canonical authoritative publications'); END;
    CREATE TRIGGER campaign_catalog_command_provenance_v18_validate BEFORE INSERT ON campaign_catalog_command_provenance_v18
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_commands command
        WHERE command.campaign_id=NEW.campaign_id AND command.command_id=NEW.command_id
          AND command.actor_principal_id=NEW.actor_principal_id
          AND json(command.requested_json)=command.requested_json
          AND command.requested_json=(SELECT json_object(
            'contentPacks',(SELECT json_group_array(json(item)) FROM (SELECT json_object(
              'packId',json_extract(pin.value,'$.packId'),'packVersion',json_extract(pin.value,'$.packVersion')) item
              FROM json_each(command.requested_json,'$.contentPacks') pin ORDER BY CAST(pin.key AS INTEGER))),
            'expectedRevision',command.expected_revision,'idempotencyKey',command.idempotency_key,
            'rulesProfileId',json_extract(command.requested_json,'$.rulesProfileId')))
          AND json_array_length(command.requested_json,'$.contentPacks') BETWEEN 1 AND 64
          AND json_extract(command.requested_json,'$.expectedRevision')=command.expected_revision
          AND json_extract(command.requested_json,'$.idempotencyKey')=command.idempotency_key
          AND NOT EXISTS (SELECT 1 FROM json_each(command.requested_json,'$.contentPacks') requested
            LEFT JOIN rpg_content_pack_publications publication
              ON publication.pack_id=json_extract(requested.value,'$.packId')
              AND publication.pack_version=json_extract(requested.value,'$.packVersion')
              AND publication.validation_level='validated-v1'
            LEFT JOIN rpg_content_packs pack ON pack.pack_id=publication.pack_id AND pack.pack_version=publication.pack_version
            WHERE publication.pack_id IS NULL OR pack.sealed<>1
              OR pack.rules_profile_id<>json_extract(command.requested_json,'$.rulesProfileId'))
          AND NEW.proposed_event_type='catalog_configured'
          AND json(NEW.proposed_public_data)=NEW.proposed_public_data
          AND json(NEW.proposed_result_json)=NEW.proposed_result_json
          AND json_extract(NEW.proposed_public_data,'$.content.campaignId')=command.campaign_id
          AND json_extract(NEW.proposed_public_data,'$.content.compatible')=1
          AND json_extract(NEW.proposed_public_data,'$.content.rulesProfileId')=json_extract(command.requested_json,'$.rulesProfileId')
          AND json_type(NEW.proposed_public_data,'$.content.issues')='array'
          AND json_array_length(NEW.proposed_public_data,'$.content.issues')=0
          AND json_array_length(NEW.proposed_public_data,'$.content.contentPacks')=json_array_length(command.requested_json,'$.contentPacks')
          AND NOT EXISTS (SELECT 1 FROM json_each(command.requested_json,'$.contentPacks') requested
            JOIN rpg_content_pack_publications publication
              ON publication.pack_id=json_extract(requested.value,'$.packId')
              AND publication.pack_version=json_extract(requested.value,'$.packVersion')
            WHERE json_extract(NEW.proposed_public_data,'$.content.contentPacks['||requested.key||'].packId') IS NOT publication.pack_id
              OR json_extract(NEW.proposed_public_data,'$.content.contentPacks['||requested.key||'].packVersion') IS NOT publication.pack_version
              OR json_extract(NEW.proposed_public_data,'$.content.contentPacks['||requested.key||'].digest') IS NOT publication.manifest_digest)
          AND json_extract(NEW.proposed_result_json,'$.campaignId')=command.campaign_id
          AND json_extract(NEW.proposed_result_json,'$.commandId')=command.command_id
          AND json_extract(NEW.proposed_result_json,'$.idempotencyKey')=command.idempotency_key
          AND json_extract(NEW.proposed_result_json,'$.revisionBefore')=command.expected_revision
          AND json_extract(NEW.proposed_result_json,'$.revisionAfter')=command.expected_revision+1
          AND json_extract(NEW.proposed_result_json,'$.configuredAt')=command.created_at
          AND json_extract(NEW.proposed_result_json,'$.content')=json_extract(NEW.proposed_public_data,'$.content')
          AND NEW.proposed_public_data=(SELECT json_object('content',json_object(
            'campaignId',command.campaign_id,'compatible',json('true'),
            'contentPacks',(SELECT json_group_array(json(item)) FROM (SELECT json_object(
              'digest',publication.manifest_digest,'packId',publication.pack_id,'packVersion',publication.pack_version) item
              FROM json_each(command.requested_json,'$.contentPacks') requested
              JOIN rpg_content_pack_publications publication
                ON publication.pack_id=json_extract(requested.value,'$.packId')
                AND publication.pack_version=json_extract(requested.value,'$.packVersion')
              ORDER BY CAST(requested.key AS INTEGER))),
            'issues',json('[]'),'rulesProfileId',json_extract(command.requested_json,'$.rulesProfileId'))))
          AND NEW.proposed_result_json=(SELECT json_object(
            'campaignId',command.campaign_id,'commandId',command.command_id,'configuredAt',command.created_at,
            'content',json(json_extract(NEW.proposed_public_data,'$.content')),'idempotencyKey',command.idempotency_key,
            'revisionAfter',command.expected_revision+1,'revisionBefore',command.expected_revision)))
      BEGIN SELECT RAISE(ABORT,'catalog proposed event/result provenance is inconsistent'); END;
    CREATE TRIGGER campaign_catalog_command_provenance_v18_immutable_update BEFORE UPDATE ON campaign_catalog_command_provenance_v18
      BEGIN SELECT RAISE(ABORT,'catalog proposed provenance is immutable'); END;
    CREATE TRIGGER campaign_catalog_command_provenance_v18_immutable_delete BEFORE DELETE ON campaign_catalog_command_provenance_v18
      BEGIN SELECT RAISE(ABORT,'catalog proposed provenance is immutable'); END;
    CREATE TRIGGER campaign_catalog_command_provenance_v18_prevent_replace BEFORE INSERT ON campaign_catalog_command_provenance_v18
      WHEN EXISTS (SELECT 1 FROM campaign_catalog_command_provenance_v18 old WHERE old.campaign_id=NEW.campaign_id
        AND (old.command_id=NEW.command_id OR old.proposed_event_id=NEW.proposed_event_id))
      BEGIN SELECT RAISE(ABORT,'catalog proposed provenance is immutable'); END;
    CREATE TRIGGER campaign_catalog_events_require_proposal_v18 BEFORE INSERT ON campaign_catalog_events
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_command_provenance_v18 proposal
        JOIN campaign_catalog_commands command ON command.campaign_id=proposal.campaign_id AND command.command_id=proposal.command_id
        WHERE proposal.campaign_id=NEW.campaign_id AND proposal.command_id=NEW.command_id
          AND proposal.proposed_event_id=NEW.event_id AND proposal.proposed_event_type='catalog_configured'
          AND proposal.actor_principal_id=command.actor_principal_id
          AND NEW.revision_before=command.expected_revision AND NEW.revision=command.expected_revision+1
          AND NEW.public_data=proposal.proposed_public_data)
      BEGIN SELECT RAISE(ABORT,'catalog event does not match its exact proposal'); END;
    CREATE TRIGGER campaign_catalog_receipts_require_proposal_v18 BEFORE INSERT ON campaign_catalog_receipts
      WHEN NOT EXISTS (SELECT 1 FROM campaign_catalog_command_provenance_v18 proposal
        WHERE proposal.campaign_id=NEW.campaign_id AND proposal.command_id=NEW.command_id
          AND proposal.proposed_event_id=NEW.event_id AND NEW.result_json=proposal.proposed_result_json)
      BEGIN SELECT RAISE(ABORT,'catalog receipt does not match its exact proposal'); END;
  `);
  const rows=db.prepare(`SELECT command.campaign_id,command.command_id,command.actor_principal_id,
      event.event_id,event.public_data,receipt.result_json
    FROM campaign_catalog_commands command
    LEFT JOIN campaign_catalog_events event ON event.campaign_id=command.campaign_id AND event.command_id=command.command_id
    LEFT JOIN campaign_catalog_receipts receipt ON receipt.campaign_id=command.campaign_id AND receipt.command_id=command.command_id
    ORDER BY command.campaign_id,command.command_id`).all() as any[];
  const insert=db.prepare(`INSERT INTO campaign_catalog_command_provenance_v18
    (campaign_id,command_id,proposed_event_id,proposed_event_type,actor_principal_id,proposed_public_data,proposed_result_json)
    VALUES (?,?,?,'catalog_configured',?,?,?)`);
  for(const row of rows){
    if(!row.event_id||!row.public_data||!row.result_json) throw new Error("schema v17 catalog audit is incomplete");
    insert.run(row.campaign_id,row.command_id,row.event_id,row.actor_principal_id,row.public_data,row.result_json);
  }
}


function requireCatalogSchemaLayout(
  db: DatabaseDriver.Database,
  version: "v16"|"v17"|"v18",
  tables: Record<string,string[]>,
  indexes: readonly string[],
  triggers: readonly string[],
): void {
  for(const [table,columns] of Object.entries(tables)){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
      throw new Error(`schema ${version} artifact ${table} is missing`);
    const actual=(db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map((column)=>column.name);
    if(JSON.stringify(actual)!==JSON.stringify(columns)) throw new Error(`schema ${version} artifact ${table} columns are incompatible`);
  }
  for(const name of indexes){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name))
      throw new Error(`schema ${version} artifact ${name} is missing`);
  }
  for(const name of triggers){
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))
      throw new Error(`schema ${version} artifact ${name} is missing`);
  }
  const tableNames=Object.keys(tables),placeholders=tableNames.map(()=>"?").join(",");
  const actualIndexes=(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'
    AND tbl_name IN (${placeholders}) ORDER BY name`).all(...tableNames) as Array<{name:string}>).map((row)=>row.name);
  if(JSON.stringify(actualIndexes)!==JSON.stringify([...indexes].sort()))
    throw new Error(`schema ${version} catalog indexes are incompatible`);
  const expectedTableTriggers=(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name IN
    (${triggers.map(()=>"?").join(",")}) AND tbl_name IN (${placeholders}) ORDER BY name`)
    .all(...triggers,...tableNames) as Array<{name:string}>).map((row)=>row.name);
  const actualTableTriggers=(db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${placeholders}) ORDER BY name`)
    .all(...tableNames) as Array<{name:string}>).map((row)=>row.name);
  if(JSON.stringify(actualTableTriggers)!==JSON.stringify(expectedTableTriggers))
    throw new Error(`schema ${version} catalog triggers are incompatible`);
  const actualCatalogTables=(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND
    (name='rpg_content_pack_publications' OR name GLOB 'rpg_catalog_*' OR name GLOB 'campaign_content_catalog_*'
      OR name GLOB 'campaign_catalog_*') ORDER BY name`).all() as Array<{name:string}>).map((row)=>row.name);
  if(JSON.stringify(actualCatalogTables)!==JSON.stringify([...tableNames].sort()))
    throw new Error(`schema ${version} catalog tables are incompatible`);
}

const V16_CATALOG_TABLES:Record<string,string[]>={
  rpg_content_pack_publications:["pack_id","pack_version","validation_level","rules_engine","manifest_digest","manifest_json",
    "provenance_json","validation_report_json","published_by_principal_id","published_at"],
  rpg_catalog_definitions:["pack_id","pack_version","kind","definition_id","definition_json","public_definition_json","dependencies_json"],
  campaign_content_catalog_selections:["campaign_id","rules_profile_id","selection_digest","configured_by_principal_id","configured_at"],
  campaign_content_catalog_pins:["campaign_id","pack_id","pack_version","position"],
};
const V16_CATALOG_INDEXES=["idx_rpg_content_pack_publications_validation","idx_rpg_catalog_definitions_pack",
  "idx_campaign_content_catalog_pins_exact"] as const;
const V16_CATALOG_TRIGGERS=["rpg_content_pack_publications_require_validated_pack","campaign_content_catalog_pins_require_validated",
  "rpg_content_packs_prevent_replace_v16","rpg_definitions_prevent_replace_v16","rpg_content_pack_publications_immutable_update",
  "rpg_content_pack_publications_immutable_delete","rpg_content_pack_publications_prevent_replace","rpg_catalog_definitions_immutable_update",
  "rpg_catalog_definitions_immutable_delete","rpg_catalog_definitions_prevent_sealed_insert","rpg_catalog_definitions_prevent_replace",
  "campaign_content_catalog_selections_immutable_update","campaign_content_catalog_selections_immutable_delete",
  "campaign_content_catalog_selections_prevent_replace","campaign_content_catalog_pins_immutable_update",
  "campaign_content_catalog_pins_immutable_delete","campaign_content_catalog_pins_prevent_replace"] as const;

const V17_CATALOG_TABLES:Record<string,string[]>={
  rpg_catalog_publication_attestations:["pack_id","pack_version","definition_count","definition_counts_json","publication_digest",
    "public_projection_digest","public_projection_count"],
  rpg_catalog_definition_visibility:["pack_id","pack_version","kind","definition_id","public_definition_json",
    "public_dependencies_json","private_dependencies_json","row_digest","publicly_reachable"],
  rpg_catalog_publication_submissions:["principal_id","idempotency_key","request_digest","pack_id","pack_version","receipt_json","created_at"],
  campaign_catalog_current_selections:["campaign_id","rules_profile_id","selection_digest","configured_by_principal_id","configured_at","open_command_id"],
  campaign_catalog_current_pins:["campaign_id","pack_id","pack_version","position","open_command_id"],
  campaign_catalog_commands:["campaign_id","command_id","idempotency_key","actor_principal_id","expected_revision","request_digest",
    "target_selection_digest","requested_json","created_at"],
  campaign_catalog_events:["campaign_id","command_id","event_id","revision_before","revision","occurred_at","public_data"],
  campaign_catalog_receipts:["campaign_id","command_id","event_id","revision_before","revision_after","result_json"],
};
const V17_CATALOG_TRIGGERS=["rpg_catalog_attestations_immutable_update","rpg_catalog_attestations_immutable_delete",
  "rpg_catalog_attestations_prevent_replace","rpg_catalog_attestations_validate_insert","rpg_catalog_visibility_immutable_update",
  "rpg_catalog_visibility_immutable_delete","rpg_catalog_visibility_prevent_replace","rpg_catalog_visibility_validate_insert",
  "rpg_catalog_submissions_immutable_update","rpg_catalog_submissions_immutable_delete","rpg_catalog_submissions_prevent_replace",
  "rpg_catalog_submissions_validate_insert","campaign_catalog_commands_require_owner_revision","campaign_catalog_selection_bind_insert",
  "campaign_catalog_pin_bind_insert","campaign_catalog_selection_bind_delete","campaign_catalog_pin_bind_delete",
  "campaign_catalog_selection_prevent_update","campaign_catalog_pin_prevent_update","campaign_catalog_commands_immutable_update",
  "campaign_catalog_commands_immutable_delete","campaign_catalog_commands_prevent_replace","campaign_catalog_events_immutable_update",
  "campaign_catalog_events_immutable_delete","campaign_catalog_events_prevent_replace","campaign_catalog_events_validate_provenance",
  "campaign_catalog_receipts_immutable_update","campaign_catalog_receipts_immutable_delete","campaign_catalog_receipts_prevent_replace",
  "campaign_catalog_receipts_validate_result","campaign_administration_commands_reject_catalog_identity",
  "campaign_administration_events_reject_catalog_revision"] as const;

const V18_CATALOG_TABLES:Record<string,string[]>={
  campaign_catalog_command_provenance_v18:["campaign_id","command_id","proposed_event_id","proposed_event_type",
    "actor_principal_id","proposed_public_data","proposed_result_json"],
};
const V18_CATALOG_INDEXES=["idx_campaign_catalog_command_provenance_v18_event"] as const;
const V18_CATALOG_TRIGGERS=["campaign_catalog_commands_validate_requested_v18","campaign_catalog_command_provenance_v18_validate",
  "campaign_catalog_command_provenance_v18_immutable_update","campaign_catalog_command_provenance_v18_immutable_delete",
  "campaign_catalog_command_provenance_v18_prevent_replace","campaign_catalog_events_require_proposal_v18",
  "campaign_catalog_receipts_require_proposal_v18"] as const;


export function assertCatalogLayoutV18(db: DatabaseDriver.Database): void {
  requireCatalogSchemaLayout(db,"v18",{...V16_CATALOG_TABLES,...V17_CATALOG_TABLES,...V18_CATALOG_TABLES},
    [...V16_CATALOG_INDEXES,...V18_CATALOG_INDEXES],
    [...V16_CATALOG_TRIGGERS,...V17_CATALOG_TRIGGERS,...V18_CATALOG_TRIGGERS]);
}

export function migrate15to16(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    createContentCatalogV16(db);
    db.prepare("UPDATE meta SET value = '16' WHERE key = 'schemaVersion'").run();
  })();
}


export function migrate16to17(db: DatabaseDriver.Database): void {
  db.transaction(() => {
    requireCatalogSchemaLayout(db,"v16",V16_CATALOG_TABLES,V16_CATALOG_INDEXES,V16_CATALOG_TRIGGERS);
    createContentCatalogV17(db);
    db.prepare("UPDATE meta SET value='17' WHERE key='schemaVersion'").run();
  })();
}

export function migrate17to18(db: DatabaseDriver.Database):void{
  db.transaction(()=>{
    requireCatalogSchemaLayout(db,"v17",{...V16_CATALOG_TABLES,...V17_CATALOG_TABLES},V16_CATALOG_INDEXES,
      [...V16_CATALOG_TRIGGERS,...V17_CATALOG_TRIGGERS]);
    createContentCatalogV18(db);
    db.prepare("UPDATE meta SET value='18' WHERE key='schemaVersion'").run();
  })();
}
