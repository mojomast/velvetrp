// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import {
  contentPackSchema,
  rpgDefinitionSchema,
  rulesProfileSchema,
} from "@velvet/contracts";
import type { ContentPack, RpgDefinition, RulesProfile } from "../../types.js";

/** Database projection for a rules-profile metadata row. */
export interface RulesProfileRow {
  rules_profile_id: string;
  name: string;
  description: string;
  tags: string;
}

/** Database projection for a content-pack metadata row. */
export interface ContentPackRow extends RulesProfileRow {
  pack_id: string;
  pack_version: string;
}

/** Database projection for an RPG-definition metadata row. */
export interface RpgDefinitionRow {
  kind: string;
  definition_id: string;
  name: string;
  description: string;
  tags: string;
}

/** Parses the JSON-encoded tag list stored in a content metadata row. */
function parseTags(tags: string): unknown {
  return JSON.parse(tags) as unknown;
}

/** Maps a rules-profile database row to its validated contract representation. */
export function toRulesProfile(row: RulesProfileRow): RulesProfile {
  return rulesProfileSchema.parse({
    rulesProfileId: row.rules_profile_id,
    name: row.name,
    description: row.description,
    tags: parseTags(row.tags),
  });
}

/** Maps a content-pack database row to its validated contract representation. */
export function toContentPack(row: ContentPackRow): ContentPack {
  return contentPackSchema.parse({
    packId: row.pack_id,
    packVersion: row.pack_version,
    rulesProfileId: row.rules_profile_id,
    name: row.name,
    description: row.description,
    tags: parseTags(row.tags),
  });
}

/** Maps an RPG-definition database row to its validated contract representation. */
export function toRpgDefinition(row: RpgDefinitionRow): RpgDefinition {
  return rpgDefinitionSchema.parse({
    kind: row.kind,
    definitionId: row.definition_id,
    name: row.name,
    description: row.description,
    tags: parseTags(row.tags),
  });
}

/** Returns whether two content metadata values have identical ordered tags. */
export function sameMetadata(
  left: { name: string; description: string; tags: readonly string[] },
  right: { name: string; description: string; tags: readonly string[] },
): boolean {
  return left.name === right.name
    && left.description === right.description
    && left.tags.length === right.tags.length
    && left.tags.every((tag, index) => tag === right.tags[index]);
}
