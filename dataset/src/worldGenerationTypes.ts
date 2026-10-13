/**
 * Shared types for the Family C/D adapters.
 *
 * Kept separate from `worldGeneration.ts` so that module's imports of production
 * code stay at its top level and these stay dependency-free.
 */

/** One already-accepted campaign artifact a candidate may reference. */
export interface CanonicalDependency {
  key: string;
  /** Production artifact kind, e.g. `location`, `faction`, `npc`. */
  kind: string;
  visibility: "public" | "gm";
}

/** One catalog definition the campaign has pinned. */
export interface CatalogIdentity {
  kind: string;
  packId: string;
  packVersion: string;
  definitionId: string;
  /** Matches production's `referenceIdentity`, so sets compare correctly. */
  referenceIdentity: string;
}

/** Exact production identity; display labels and similarly named kinds are distinct. */
export function catalogReferenceIdentity(value: Pick<CatalogIdentity, "kind" | "packId" | "packVersion" | "definitionId">): string {
  return `${value.kind}\0${value.packId}\0${value.packVersion}\0${value.definitionId}`;
}
