import type { MagicItemProperties } from "@velvet/contracts";
import type { MagicItemDefinition } from "./types.js";

/**
 * Adapts a pinned catalog item definition into the encounter engine's
 * `MagicItemDefinition`. Returns null for mundane items (no `mechanics.magic`),
 * so callers can treat magic items as an explicit subset of the catalog.
 */
export function magicItemDefinitionFromCatalog(definition: {
  reference: { packId: string; packVersion: string; definitionId: string };
  name: string;
  mechanics: { magic?: MagicItemProperties | undefined };
}): MagicItemDefinition | null {
  const magic = definition.mechanics.magic;
  if (!magic) return null;
  return Object.freeze({
    reference: Object.freeze({
      packId: definition.reference.packId,
      packVersion: definition.reference.packVersion,
      definitionId: definition.reference.definitionId,
    }),
    name: definition.name,
    attunement: magic.attunement,
    charges: magic.charges,
    passiveModifiers: magic.passiveModifiers,
    grantedPowers: magic.grantedPowers,
  });
}
