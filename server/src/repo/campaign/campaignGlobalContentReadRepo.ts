// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import {
  contentPackIdentifierSchema,
  definitionReferenceSchema,
  resourceIdSchema,
  rulesProfileIdentifierSchema,
} from "@velvet/contracts";
import type { ContentPack, ContentPackIdentifier, DefinitionReference, RpgDefinition, RulesProfile, RulesProfileIdentifier } from "../../types.js";
import {
  toContentPack,
  toRpgDefinition,
  toRulesProfile,
  type ContentPackRow,
  type RpgDefinitionRow,
  type RulesProfileRow,
} from "./campaignContentRowMappers.js";

export const RULES_PROFILE_PROJECTION = "rp.rules_profile_id, rp.name, rp.description, rp.tags";
export const CONTENT_PACK_PROJECTION = `p.pack_id, p.pack_version, p.rules_profile_id,
  p.name, p.description, p.tags`;
export const DEFINITION_PROJECTION = "d.kind, d.definition_id, d.name, d.description, d.tags";
export const DEFINITION_ORDER = `CASE d.kind
      WHEN 'class' THEN 1 WHEN 'race' THEN 2 WHEN 'background' THEN 3 WHEN 'item' THEN 4
      WHEN 'spell' THEN 5 WHEN 'ability' THEN 6 WHEN 'enemy' THEN 7 END ASC, d.definition_id ASC`;

function listRulesProfilesSync(db: DatabaseDriver.Database, actorPrincipalId: string): RulesProfile[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const rows = db.prepare(`SELECT ${RULES_PROFILE_PROJECTION}
    FROM application_owner ao
    JOIN rpg_rules_profiles rp ON ao.principal_id = ?
    WHERE ao.singleton = 1
    ORDER BY rp.rules_profile_id ASC`).all(actorId) as RulesProfileRow[];
  return rows.map(toRulesProfile);
}

function getRulesProfileSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  identifier: RulesProfileIdentifier,
): RulesProfile | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = rulesProfileIdentifierSchema.parse(identifier);
  const row = db.prepare(`SELECT ${RULES_PROFILE_PROJECTION}
    FROM application_owner ao
    JOIN rpg_rules_profiles rp ON ao.principal_id = ? AND rp.rules_profile_id = ?
    WHERE ao.singleton = 1`).get(actorId, normalized.rulesProfileId) as RulesProfileRow | undefined;
  return row ? toRulesProfile(row) : null;
}

function listContentPacksSync(db: DatabaseDriver.Database, actorPrincipalId: string): ContentPack[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const rows = db.prepare(`SELECT ${CONTENT_PACK_PROJECTION}
    FROM application_owner ao
    JOIN rpg_content_packs p ON ao.principal_id = ?
    WHERE ao.singleton = 1 AND p.sealed = 1
    ORDER BY p.pack_id ASC, p.pack_version ASC`).all(actorId) as ContentPackRow[];
  return rows.map(toContentPack);
}

function getContentPackSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  identifier: ContentPackIdentifier,
): ContentPack | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = contentPackIdentifierSchema.parse(identifier);
  const row = db.prepare(`SELECT ${CONTENT_PACK_PROJECTION}
    FROM application_owner ao
    JOIN rpg_content_packs p ON ao.principal_id = ? AND p.pack_id = ? AND p.pack_version = ?
    WHERE ao.singleton = 1 AND p.sealed = 1`).get(actorId, normalized.packId, normalized.packVersion) as ContentPackRow | undefined;
  return row ? toContentPack(row) : null;
}

function listContentPackDefinitionsSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  identifier: ContentPackIdentifier,
): RpgDefinition[] {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = contentPackIdentifierSchema.parse(identifier);
  const rows = db.prepare(`SELECT ${DEFINITION_PROJECTION}
    FROM application_owner ao
    JOIN rpg_definitions d ON ao.principal_id = ? AND d.pack_id = ? AND d.pack_version = ?
    JOIN rpg_content_packs p ON p.pack_id = d.pack_id AND p.pack_version = d.pack_version AND p.sealed = 1
    WHERE ao.singleton = 1
    ORDER BY ${DEFINITION_ORDER}`).all(actorId, normalized.packId, normalized.packVersion) as RpgDefinitionRow[];
  return rows.map(toRpgDefinition);
}

function getContentPackDefinitionSync(
  db: DatabaseDriver.Database,
  actorPrincipalId: string,
  reference: DefinitionReference,
): RpgDefinition | null {
  const actorId = resourceIdSchema.parse(actorPrincipalId);
  const normalized = definitionReferenceSchema.parse(reference);
  const row = db.prepare(`SELECT ${DEFINITION_PROJECTION}
    FROM application_owner ao
    JOIN rpg_definitions d ON ao.principal_id = ? AND d.pack_id = ? AND d.pack_version = ?
      AND d.kind = ? AND d.definition_id = ?
    JOIN rpg_content_packs p ON p.pack_id = d.pack_id AND p.pack_version = d.pack_version AND p.sealed = 1
    WHERE ao.singleton = 1`).get(
      actorId,
      normalized.packId,
      normalized.packVersion,
      normalized.kind,
      normalized.definitionId,
    ) as RpgDefinitionRow | undefined;
  return row ? toRpgDefinition(row) : null;
}

export interface CampaignGlobalContentReadRepository {
  listRulesProfiles(actorPrincipalId: string): RulesProfile[];
  getRulesProfile(actorPrincipalId: string, identifier: RulesProfileIdentifier): RulesProfile | null;
  listContentPacks(actorPrincipalId: string): ContentPack[];
  getContentPack(actorPrincipalId: string, identifier: ContentPackIdentifier): ContentPack | null;
  listContentPackDefinitions(actorPrincipalId: string, identifier: ContentPackIdentifier): RpgDefinition[];
  getContentPackDefinition(actorPrincipalId: string, reference: DefinitionReference): RpgDefinition | null;
}

export function createCampaignGlobalContentReadRepository(
  db: DatabaseDriver.Database,
): CampaignGlobalContentReadRepository {
  return {
    listRulesProfiles(actorPrincipalId) {
      return listRulesProfilesSync(db, actorPrincipalId);
    },
    getRulesProfile(actorPrincipalId, identifier) {
      return getRulesProfileSync(db, actorPrincipalId, identifier);
    },
    listContentPacks(actorPrincipalId) {
      return listContentPacksSync(db, actorPrincipalId);
    },
    getContentPack(actorPrincipalId, identifier) {
      return getContentPackSync(db, actorPrincipalId, identifier);
    },
    listContentPackDefinitions(actorPrincipalId, identifier) {
      return listContentPackDefinitionsSync(db, actorPrincipalId, identifier);
    },
    getContentPackDefinition(actorPrincipalId, reference) {
      return getContentPackDefinitionSync(db, actorPrincipalId, reference);
    },
  };
}
