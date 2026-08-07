import { createHash } from "node:crypto";
import {
  catalogDefinitionReferenceSchema,
  catalogDefinitionSchema,
  memberCatalogDefinitionSchema,
  type CatalogDefinition,
  type CatalogDefinitionKind,
} from "@velvet/contracts";
import {
  asKind,
  canonicalCatalogJson,
  definitionKey,
  privateDependencies,
  publicDependencies,
  publiclyReachableKeys,
  sortedDefinitions,
} from "./catalogValidation.js";

/** A persisted, attestable definition visibility record. */
export interface PersistedCatalogVisibilityRow {
  kind: CatalogDefinitionKind;
  definition_id: string;
  public_definition_json: string;
  public_dependencies_json: string;
  private_dependencies_json: string;
  row_digest: string;
  publicly_reachable: number;
}

/** A canonical visibility record ready for persistence. */
export interface DerivedCatalogVisibilityRow {
  definition: CatalogDefinition;
  publicDefinitionJson: string;
  publicDependenciesJson: string;
  privateDependenciesJson: string;
  rowDigest: string;
  publiclyReachable: boolean;
}

/** Removes GM-only fields from a definition before public persistence. */
function publicDefinition(definition: CatalogDefinition): unknown {
  if (definition.reference.kind !== "enemy-template") return definition;
  const { private: _private, ...safe } = asKind(definition, "enemy-template");
  return safe;
}

/**
 * Verifies stored public visibility rows and returns only publicly reachable,
 * role-safe definitions.
 */
export function verifyCatalogVisibilityProjection(input: {
  packId: string;
  packVersion: string;
  expectedCount: number;
  publicationDigest: string;
  manifestDigest: string;
  aggregateDigest: string;
  rows: PersistedCatalogVisibilityRow[];
}): unknown[] {
  const { packId, packVersion, expectedCount, rows } = input;
  const keys = new Set(rows.map((row) => `${row.kind}\0${row.definition_id}`));
  if (rows.length !== expectedCount || keys.size !== expectedCount) {
    throw new Error("persisted public catalog definition count is inconsistent");
  }
  const attestations: unknown[] = [];
  for (const row of rows) {
    const publicRefs = JSON.parse(row.public_dependencies_json) as unknown[];
    const privateRefs = JSON.parse(row.private_dependencies_json) as unknown[];
    const parsedPublic = publicRefs.map((reference) => catalogDefinitionReferenceSchema.parse(reference));
    const parsedPrivate = privateRefs.map((reference) => catalogDefinitionReferenceSchema.parse(reference));
    for (const reference of [...parsedPublic, ...parsedPrivate]) {
      if (reference.packId !== packId || reference.packVersion !== packVersion || !keys.has(definitionKey(reference))) {
        throw new Error("persisted public catalog dependency is inconsistent");
      }
    }
    const expectedRowDigest = createHash("sha256").update(canonicalCatalogJson({
      definition: JSON.parse(row.public_definition_json),
      publicDependencies: parsedPublic,
      privateDependencies: parsedPrivate,
    })).digest("hex");
    if (row.row_digest !== expectedRowDigest) {
      throw new Error("persisted public catalog row attestation is inconsistent");
    }
    attestations.push({
      kind: row.kind,
      definitionId: row.definition_id,
      rowDigest: row.row_digest,
      publiclyReachable: row.publicly_reachable === 1,
    });
  }
  const aggregateDigest = createHash("sha256").update(canonicalCatalogJson(attestations)).digest("hex");
  if (aggregateDigest !== input.aggregateDigest || input.publicationDigest !== input.manifestDigest) {
    throw new Error("persisted public catalog projection attestation is inconsistent");
  }
  return rows.filter((row) => row.publicly_reachable === 1).map((row) => {
    const definition = memberCatalogDefinitionSchema.parse(JSON.parse(row.public_definition_json));
    if (definition.reference.kind !== row.kind || definition.reference.definitionId !== row.definition_id
      || definition.reference.packId !== packId || definition.reference.packVersion !== packVersion) {
      throw new Error("persisted public catalog definition identity is inconsistent");
    }
    return definition;
  });
}

/** Derives canonical, cryptographically attestable visibility rows from definitions. */
export function deriveCatalogVisibility(definitions: readonly unknown[]): {
  rows: DerivedCatalogVisibilityRow[];
  aggregateDigest: string;
} {
  const ordered = sortedDefinitions(definitions.map((definition) => catalogDefinitionSchema.parse(definition)));
  const reachable = publiclyReachableKeys(ordered);
  const rows = ordered.map((definition) => {
    const publicDefinitionJson = canonicalCatalogJson(publicDefinition(definition));
    const publicRefs = publicDependencies(definition);
    const privateRefs = privateDependencies(definition);
    const rowDigest = createHash("sha256").update(canonicalCatalogJson({
      definition: JSON.parse(publicDefinitionJson),
      publicDependencies: publicRefs,
      privateDependencies: privateRefs,
    })).digest("hex");
    return {
      definition,
      publicDefinitionJson,
      publicDependenciesJson: canonicalCatalogJson(publicRefs),
      privateDependenciesJson: canonicalCatalogJson(privateRefs),
      rowDigest,
      publiclyReachable: reachable.has(definitionKey(definition.reference)),
    };
  });
  const aggregateDigest = createHash("sha256").update(canonicalCatalogJson(rows.map((row) => ({
    kind: row.definition.reference.kind,
    definitionId: row.definition.reference.definitionId,
    rowDigest: row.rowDigest,
    publiclyReachable: row.publiclyReachable,
  })))).digest("hex");
  return { rows, aggregateDigest };
}
