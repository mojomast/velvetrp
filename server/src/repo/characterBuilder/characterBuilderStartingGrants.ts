import {
  SRD_5_1_STARTER_IDENTITY,
  SRD_5_1_STARTER_RULES_PROFILE_ID,
  characterStartingGrantSchema,
  type CatalogDefinition,
  type CharacterStartingGrant,
} from "@velvet/contracts";

type ClassReference = Extract<CatalogDefinition, { reference: { kind: "class" } }>["reference"];

/** Returns the closed builder grant set for the selected starter choice. */
export function startingGrantsFor(
  rulesProfileId: string,
  selectedClass: ClassReference,
  starterGrant: "kit" | "currency",
  backgroundGrants: CharacterStartingGrant[],
): CharacterStartingGrant[] {
  if (
    starterGrant !== "kit" ||
    rulesProfileId !== SRD_5_1_STARTER_RULES_PROFILE_ID ||
    selectedClass.packId !== SRD_5_1_STARTER_IDENTITY.packId ||
    selectedClass.packVersion !== SRD_5_1_STARTER_IDENTITY.packVersion ||
    selectedClass.definitionId !== "srd-5.1:class:fighter"
  )
    return backgroundGrants;
  return [
    ...backgroundGrants,
    characterStartingGrantSchema.parse({
      kind: "item",
      reference: {
        packId: SRD_5_1_STARTER_IDENTITY.packId,
        packVersion: SRD_5_1_STARTER_IDENTITY.packVersion,
        kind: "item",
        definitionId: "srd-5.1:item:longsword",
      },
      quantity: 1,
      source: "class-starter-kit",
    }),
  ];
}
