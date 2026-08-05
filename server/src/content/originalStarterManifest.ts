import {
  installContentPackInputSchema,
  ORIGINAL_STARTER_PRESENTATION,
  type InstallContentPackInput,
} from "@velvet/contracts";

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

export const ORIGINAL_STARTER_RULES_PROFILE_ID = ORIGINAL_STARTER_PRESENTATION.rulesProfile.id;
export const ORIGINAL_STARTER_PACK_ID = ORIGINAL_STARTER_PRESENTATION.pack.id;
export const ORIGINAL_STARTER_PACK_VERSION = ORIGINAL_STARTER_PRESENTATION.pack.version;

// Parse the complete reviewed literal here so an invalid built-in cannot be imported.
const parsedManifest = installContentPackInputSchema.parse({
  packId: ORIGINAL_STARTER_PACK_ID,
  packVersion: ORIGINAL_STARTER_PACK_VERSION,
  rulesProfileId: ORIGINAL_STARTER_RULES_PROFILE_ID,
  rulesProfile: {
    name: ORIGINAL_STARTER_PRESENTATION.rulesProfile.name,
    description: ORIGINAL_STARTER_PRESENTATION.rulesProfile.description,
    tags: ["velvet:original", "velvet:narrative"],
  },
  name: ORIGINAL_STARTER_PRESENTATION.pack.name,
  description: ORIGINAL_STARTER_PRESENTATION.pack.description,
  tags: ["velvet:original", "velvet:starter", "fantasy"],
  classes: [
    {
      definitionId: ORIGINAL_STARTER_PRESENTATION.classes[0].id,
      kind: "class",
      name: ORIGINAL_STARTER_PRESENTATION.classes[0].name,
      description: ORIGINAL_STARTER_PRESENTATION.classes[0].description,
      tags: ["velvet:original", "community", "traveler"],
    },
  ],
  races: [
    {
      definitionId: ORIGINAL_STARTER_PRESENTATION.races[0].id,
      kind: "race",
      name: ORIGINAL_STARTER_PRESENTATION.races[0].name,
      description: ORIGINAL_STARTER_PRESENTATION.races[0].description,
      tags: ["velvet:original", "community", "storytelling"],
    },
  ],
  backgrounds: [
    {
      definitionId: ORIGINAL_STARTER_PRESENTATION.backgrounds[0].id,
      kind: "background",
      name: ORIGINAL_STARTER_PRESENTATION.backgrounds[0].name,
      description: ORIGINAL_STARTER_PRESENTATION.backgrounds[0].description,
      tags: ["velvet:original", "historian", "traveler"],
    },
  ],
  items: [],
  spells: [],
  abilities: [],
  enemies: [],
} satisfies InstallContentPackInput);

export const ORIGINAL_STARTER_MANIFEST = deepFreeze(parsedManifest);

export const ORIGINAL_STARTER_PACK_IDENTIFIER = deepFreeze({
  packId: ORIGINAL_STARTER_PACK_ID,
  packVersion: ORIGINAL_STARTER_PACK_VERSION,
});
