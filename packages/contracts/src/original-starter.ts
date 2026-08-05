type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly unknown[]
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
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

/** Exact installed pack identity shared by presentation and HTTP contracts. */
export const ORIGINAL_STARTER_PACK_ID = "velvet:original-starter" as const;
// Build metadata is the first 12 hex characters of the canonical SHA-256 over
// the complete parsed manifest with only packVersion omitted. Any content edit
// therefore requires a new immutable version identity.
export const ORIGINAL_STARTER_PACK_VERSION = "1.0.0+d15042935818" as const;

/** The only built-in starter accepted by the trusted-local setup boundary. */
export const ORIGINAL_STARTER_ID = `${ORIGINAL_STARTER_PACK_ID}@${ORIGINAL_STARTER_PACK_VERSION}` as const;

/** Basic finalized starter metadata, not a rules-complete character builder. */
export const ORIGINAL_STARTER_RULES_PROFILE = deepFreeze({
  rulesProfileId: "velvet:rules:original-narrative",
  name: "Velvet Original Narrative",
  description: "Metadata identity for Velvet's original narrative starter concepts.",
} as const);

/** Basic finalized starter metadata, not a rules-complete character builder. */
export const ORIGINAL_STARTER_PACK = deepFreeze({
  packId: ORIGINAL_STARTER_PACK_ID,
  packVersion: ORIGINAL_STARTER_PACK_VERSION,
  rulesProfileId: ORIGINAL_STARTER_RULES_PROFILE.rulesProfileId,
  name: "Velvet Original Starter",
  description: "A small original fantasy collection for future campaign setup.",
} as const);

/** Basic finalized starter metadata, not a rules-complete character builder. */
export const ORIGINAL_STARTER_CLASS = deepFreeze({
  reference: {
    packId: ORIGINAL_STARTER_PACK_ID,
    packVersion: ORIGINAL_STARTER_PACK_VERSION,
    definitionId: "velvet:original-starter:class:pathmender",
    kind: "class",
  },
  name: "Pathmender",
  description: "Pathmenders travel between isolated communities, carrying news and helping neighbors restore neglected meeting places.",
} as const);

/** Basic finalized starter metadata, not a rules-complete character builder. */
export const ORIGINAL_STARTER_RACE = deepFreeze({
  reference: {
    packId: ORIGINAL_STARTER_PACK_ID,
    packVersion: ORIGINAL_STARTER_PACK_VERSION,
    definitionId: "velvet:original-starter:race:avelune",
    kind: "race",
  },
  name: "Avelune",
  description: "Avelune communities gather around drifting lights and preserve family stories in woven night banners.",
} as const);

/** Basic finalized starter metadata, not a rules-complete character builder. */
export const ORIGINAL_STARTER_BACKGROUND = deepFreeze({
  reference: {
    packId: ORIGINAL_STARTER_PACK_ID,
    packVersion: ORIGINAL_STARTER_PACK_VERSION,
    definitionId: "velvet:original-starter:background:rainledger",
    kind: "background",
  },
  name: "Rainledger",
  description: "Rainledgers once recorded seasonal journeys, local customs, and promises exchanged between distant settlements.",
} as const);
