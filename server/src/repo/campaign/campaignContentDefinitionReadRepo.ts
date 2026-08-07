// Part of db.ts refactor — see server/src/repo/db/schema.ts for migration order
import type DatabaseDriver from "better-sqlite3";
import { contentPackIdentifierSchema, definitionReferenceSchema, resourceIdSchema } from "@velvet/contracts";
import type { ContentPackIdentifier, DefinitionReference, RpgDefinition } from "../../types.js";
import type { PersistedCatalogVisibilityRow } from "../contentCatalogRepo.js";
import type { RpgDefinitionRow } from "./campaignGlobalContentReadRepo.js";

interface Projectors {
  definitionProjection: string;
  definitionOrder: string;
  toRpgDefinition(row: RpgDefinitionRow): RpgDefinition;
  verifyCatalogVisibilityProjection(input: { packId: string; packVersion: string; expectedCount: number; manifestDigest: string; publicationDigest: string; aggregateDigest: string; rows: PersistedCatalogVisibilityRow[] }): unknown[];
}
type ReadRow = RpgDefinitionRow & { access_role: "owner" | "gm" | "player" | "observer"; validation_level: string | null; legacy_manifest_digest: string | null; definition_count: number | null; publication_digest: string | null; public_projection_digest: string | null; visibility_rows_json: string };

export function createCampaignContentDefinitionReadRepository(db: DatabaseDriver.Database, projectors: Projectors) {
  const visibleDefinitions = (row: ReadRow, packId: string, packVersion: string): Set<string> => new Set(
    projectors.verifyCatalogVisibilityProjection({ packId, packVersion, expectedCount: row.definition_count!, manifestDigest: row.legacy_manifest_digest!, publicationDigest: row.publication_digest!, aggregateDigest: row.public_projection_digest!, rows: JSON.parse(row.visibility_rows_json) as PersistedCatalogVisibilityRow[] })
      .map((value) => {
        const reference = (value as { reference: { kind: string; definitionId: string } }).reference;
        return `${reference.kind === "enemy-template" ? "enemy" : reference.kind}\0${reference.definitionId}`;
      }),
  );
  const select = (where: string, order = "") => `SELECT ${projectors.definitionProjection},cm.role access_role,publication.validation_level,
      publication.manifest_digest legacy_manifest_digest,attestation.definition_count,attestation.publication_digest,
      attestation.public_projection_digest,
      (SELECT json_group_array(json_object('kind',ordered.kind,'definition_id',ordered.definition_id,
        'public_definition_json',ordered.public_definition_json,'public_dependencies_json',ordered.public_dependencies_json,
        'private_dependencies_json',ordered.private_dependencies_json,'row_digest',ordered.row_digest,
        'publicly_reachable',ordered.publicly_reachable)) FROM
        (SELECT kind,definition_id,public_definition_json,public_dependencies_json,private_dependencies_json,row_digest,publicly_reachable
          FROM rpg_catalog_definition_visibility visibility WHERE visibility.pack_id=? AND visibility.pack_version=?
          ORDER BY visibility.kind COLLATE BINARY,visibility.definition_id COLLATE BINARY) ordered) visibility_rows_json
    FROM campaign_memberships cm
    JOIN campaign_content_packs cp ON cp.campaign_id = cm.campaign_id
      AND cp.pack_id = ? AND cp.pack_version = ?
    JOIN rpg_definitions d ON d.pack_id = cp.pack_id AND d.pack_version = cp.pack_version
    ${where}
    JOIN rpg_content_packs p ON p.pack_id = d.pack_id AND p.pack_version = d.pack_version AND p.sealed = 1
    LEFT JOIN rpg_content_pack_publications publication ON publication.pack_id=d.pack_id AND publication.pack_version=d.pack_version
    LEFT JOIN rpg_catalog_publication_attestations attestation ON attestation.pack_id=publication.pack_id
      AND attestation.pack_version=publication.pack_version
    WHERE cm.principal_id = ? AND cm.campaign_id = ?${order}`;
  return {
    listCampaignContentPackDefinitions(actorPrincipalId: string, campaignId: string, identifier: ContentPackIdentifier): RpgDefinition[] {
      const actorId = resourceIdSchema.parse(actorPrincipalId); const id = resourceIdSchema.parse(campaignId); const normalized = contentPackIdentifierSchema.parse(identifier);
      const rows = db.prepare(select("", `\n    ORDER BY ${projectors.definitionOrder}`)).all(normalized.packId, normalized.packVersion, normalized.packId, normalized.packVersion, actorId, id) as ReadRow[];
      if (!rows.length) return [];
      const authority = rows[0]!;
      if (authority.validation_level !== "validated-v1") return rows.map(projectors.toRpgDefinition);
      let visible: Set<string>; try { visible = visibleDefinitions(authority, normalized.packId, normalized.packVersion); } catch (error) { if (authority.access_role === "owner" || authority.access_role === "gm") throw error; return []; }
      return (authority.access_role === "owner" || authority.access_role === "gm" ? rows : rows.filter((row) => visible.has(`${row.kind}\0${row.definition_id}`))).map(projectors.toRpgDefinition);
    },
    getCampaignContentPackDefinition(actorPrincipalId: string, campaignId: string, reference: DefinitionReference): RpgDefinition | null {
      const actorId = resourceIdSchema.parse(actorPrincipalId); const id = resourceIdSchema.parse(campaignId); const normalized = definitionReferenceSchema.parse(reference);
      const row = db.prepare(select("    AND d.kind = ? AND d.definition_id = ?")).get(normalized.packId, normalized.packVersion, normalized.packId, normalized.packVersion, normalized.kind, normalized.definitionId, actorId, id) as ReadRow | undefined;
      if (!row) return null;
      if (row.validation_level === "validated-v1") { let visible: Set<string>; try { visible = visibleDefinitions(row, normalized.packId, normalized.packVersion); } catch (error) { if (row.access_role === "owner" || row.access_role === "gm") throw error; return null; } if (row.access_role !== "owner" && row.access_role !== "gm" && !visible.has(`${normalized.kind}\0${normalized.definitionId}`)) return null; }
      return projectors.toRpgDefinition(row);
    },
  };
}
