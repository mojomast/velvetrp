import type { StarterReferences } from "../references.js";

export type MagicItemBuilder = (refs: StarterReferences) => object[];

/**
 * SRD 5.1 magic items, one file per category under `magicItems/`. Wave 2 (C5)
 * registers each builder here; `mechanics.magic` drives the encounter
 * magic-item engine via magicItemDefinitionFromCatalog().
 */
const magicItemModules: readonly MagicItemBuilder[] = [];

export function buildMagicItems(refs: StarterReferences): object[] {
  return magicItemModules.flatMap((build) => build(refs));
}
