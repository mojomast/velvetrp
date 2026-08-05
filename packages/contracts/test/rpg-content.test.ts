import { describe, expect, it } from "vitest";
import {
  campaignContentConfigurationSchema,
  classDefinitionReferenceSchema,
  configureCampaignContentInputSchema,
  contentPackIdentifierSchema,
  contentPackSchema,
  contentPackVersionSchema,
  definitionKindSchema,
  definitionReferenceSchema,
  installContentPackInputSchema,
  MAX_CAMPAIGN_CONTENT_PACKS,
  MAX_DEFINITIONS_PER_KIND,
  MAX_DEFINITIONS_PER_PACK,
  rpgDefinitionSchema,
  rulesProfileIdentifierSchema,
  rulesProfileSchema,
} from "../src/index.js";

const metadata = {
  name: "Wayfinder",
  description: "A compact original rules entry.",
  tags: ["core", "exploration"],
};

const definitions = {
  classes: [{ definitionId: "class-wayfinder", kind: "class", ...metadata }],
  races: [{ definitionId: "race-riverborn", kind: "race", ...metadata }],
  backgrounds: [{ definitionId: "background-cartographer", kind: "background", ...metadata }],
  items: [{ definitionId: "item-signal-lantern", kind: "item", ...metadata }],
  spells: [{ definitionId: "spell-guiding-glimmer", kind: "spell", ...metadata }],
  abilities: [{ definitionId: "ability-steady-step", kind: "ability", ...metadata }],
  enemies: [{ definitionId: "enemy-mire-stalker", kind: "enemy", ...metadata }],
} as const;

const pack = {
  packId: "velvet-starter",
  packVersion: "1.0.0-alpha.1+local",
  rulesProfileId: "velvet-core",
  rulesProfile: metadata,
  ...metadata,
  ...definitions,
};

describe("RPG rules and content contracts", () => {
  it("validates strict rules-profile identifiers and projections", () => {
    expect(rulesProfileIdentifierSchema.parse({ rulesProfileId: "velvet-core" }))
      .toEqual({ rulesProfileId: "velvet-core" });
    expect(rulesProfileSchema.parse({ rulesProfileId: "velvet-core", ...metadata }))
      .toEqual({ rulesProfileId: "velvet-core", ...metadata });
    expect(rulesProfileIdentifierSchema.safeParse({ rulesProfileId: "bad/id" }).success).toBe(false);
    expect(rulesProfileSchema.safeParse({ rulesProfileId: "velvet-core", ...metadata, path: "rules.json" }).success)
      .toBe(false);
  });

  it("treats pack versions as bounded opaque safe exact values", () => {
    for (const version of ["1.0.0", "2.1.0-beta.3+build.7", "release_2026.08"]) {
      expect(contentPackVersionSchema.parse(version)).toBe(version);
    }
    for (const version of ["", "^1.0.0", "1.0.*", "../1.0.0", "1.0.0/path", "x".repeat(65)]) {
      expect(contentPackVersionSchema.safeParse(version).success).toBe(false);
    }
    expect(contentPackIdentifierSchema.parse({ packId: "velvet-starter", packVersion: "1.0.0" }))
      .toEqual({ packId: "velvet-starter", packVersion: "1.0.0" });
    expect(contentPackIdentifierSchema.safeParse({ packId: "velvet-starter" }).success).toBe(false);
    expect(contentPackIdentifierSchema.safeParse({ packId: "velvet-starter", packVersion: "1.0.0", latest: true }).success)
      .toBe(false);
  });

  it("validates strict bounded campaign content configurations", () => {
    const input = {
      rulesProfileId: "velvet-core",
      contentPacks: [
        { packId: "zeta-pack", packVersion: "1.0.0" },
        { packId: "alpha-pack", packVersion: "1.0.0" },
      ],
    };
    expect(configureCampaignContentInputSchema.parse(input)).toEqual(input);
    expect(campaignContentConfigurationSchema.parse({ campaignId: "campaign-1", ...input }))
      .toEqual({ campaignId: "campaign-1", ...input });
    expect(configureCampaignContentInputSchema.parse({ ...input, contentPacks: [] }).contentPacks).toEqual([]);
    expect(configureCampaignContentInputSchema.safeParse({ ...input, replacement: true }).success).toBe(false);
    expect(campaignContentConfigurationSchema.safeParse({ ...input, campaignId: "bad/id" }).success).toBe(false);
    expect(campaignContentConfigurationSchema.safeParse({ campaignId: "campaign-1", ...input, updatedAt: "now" }).success)
      .toBe(false);
    expect(configureCampaignContentInputSchema.safeParse({
      ...input,
      contentPacks: [{ packId: "pack-1", packVersion: "1.0.0", sealed: true }],
    }).success).toBe(false);
  });

  it("enforces the campaign pack maximum and duplicate pack identities", () => {
    const contentPacks = Array.from({ length: MAX_CAMPAIGN_CONTENT_PACKS }, (_, index) => ({
      packId: `pack-${index}`,
      packVersion: "1.0.0",
    }));
    expect(configureCampaignContentInputSchema.safeParse({ rulesProfileId: "velvet-core", contentPacks }).success)
      .toBe(true);
    expect(configureCampaignContentInputSchema.safeParse({
      rulesProfileId: "velvet-core",
      contentPacks: [...contentPacks, { packId: "pack-over-limit", packVersion: "1.0.0" }],
    }).success).toBe(false);

    for (const duplicateVersion of ["1.0.0", "2.0.0"]) {
      const result = configureCampaignContentInputSchema.safeParse({
        rulesProfileId: "velvet-core",
        contentPacks: [
          { packId: "same-pack", packVersion: "1.0.0" },
          { packId: "same-pack", packVersion: duplicateVersion },
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.path).toEqual(["contentPacks", 1, "packId"]);
    }
  });

  it("validates every definition kind and exact versioned references", () => {
    expect(definitionKindSchema.options).toEqual([
      "class", "race", "background", "item", "spell", "ability", "enemy",
    ]);
    for (const [arrayName, entries] of Object.entries(definitions)) {
      expect(entries).toHaveLength(1);
      expect(rpgDefinitionSchema.parse(entries[0])).toEqual(entries[0]);
      expect(arrayName).toBeTruthy();
    }

    const reference = {
      packId: "velvet-starter",
      packVersion: "1.0.0",
      kind: "class",
      definitionId: "class-wayfinder",
    } as const;
    expect(definitionReferenceSchema.parse(reference)).toEqual(reference);
    expect(classDefinitionReferenceSchema.parse(reference)).toEqual(reference);
    expect(classDefinitionReferenceSchema.safeParse({ ...reference, kind: "race" }).success).toBe(false);
    expect(definitionReferenceSchema.safeParse({ ...reference, packVersion: undefined }).success).toBe(false);
    expect(definitionReferenceSchema.safeParse({ ...reference, versionRange: "^1.0.0" }).success).toBe(false);
  });

  it("requires a complete strict single-payload pack and exact rules profile", () => {
    expect(installContentPackInputSchema.parse(pack)).toEqual(pack);
    const projection = {
      packId: pack.packId,
      packVersion: pack.packVersion,
      rulesProfileId: pack.rulesProfileId,
      name: pack.name,
      description: pack.description,
      tags: pack.tags,
    };
    expect(contentPackSchema.parse(projection)).toEqual(projection);

    for (const requiredArray of Object.keys(definitions)) {
      const incomplete = { ...pack } as Record<string, unknown>;
      delete incomplete[requiredArray];
      expect(installContentPackInputSchema.safeParse(incomplete).success).toBe(false);
    }
    expect(installContentPackInputSchema.safeParse({ ...pack, rulesProfileId: undefined }).success).toBe(false);
    expect(installContentPackInputSchema.safeParse({ ...pack, rulesProfile: undefined }).success).toBe(false);
    expect(installContentPackInputSchema.safeParse({ ...pack, rulesProfile: { ...metadata, path: "rules.json" } }).success)
      .toBe(false);
    expect(installContentPackInputSchema.safeParse({ ...pack, path: "packs/starter.json" }).success).toBe(false);
    expect(contentPackSchema.safeParse({ ...projection, classes: [] }).success).toBe(false);
  });

  it("rejects cross-kind definitions and unknown mechanics or file fields", () => {
    expect(installContentPackInputSchema.safeParse({
      ...pack,
      classes: [{ ...definitions.classes[0], kind: "race" }],
    }).success).toBe(false);
    expect(installContentPackInputSchema.safeParse({
      ...pack,
      spells: [{ ...definitions.spells[0], effects: [] }],
    }).success).toBe(false);
    expect(installContentPackInputSchema.safeParse({
      ...pack,
      items: [{ ...definitions.items[0], file: "item.json" }],
    }).success).toBe(false);
  });

  it("enforces metadata bounds without reordering or deduplicating arrays", () => {
    expect(installContentPackInputSchema.safeParse({ ...pack, name: "x".repeat(201) }).success).toBe(false);
    expect(installContentPackInputSchema.safeParse({ ...pack, description: "x".repeat(4_001) }).success).toBe(false);
    expect(installContentPackInputSchema.safeParse({ ...pack, tags: ["bad tag"] }).success).toBe(false);
    expect(installContentPackInputSchema.safeParse({ ...pack, tags: Array(33).fill("tag") }).success).toBe(false);
    expect(installContentPackInputSchema.safeParse({
      ...pack,
      classes: [{ ...definitions.classes[0], definitionId: "bad/id" }],
    }).success).toBe(false);

    const duplicate = { ...definitions.classes[0], name: "Second supplied entry" };
    expect(installContentPackInputSchema.safeParse({
      ...pack,
      classes: [definitions.classes[0], duplicate],
    }).success).toBe(false);
    expect(installContentPackInputSchema.safeParse({
      ...pack,
      races: [{ ...definitions.races[0], definitionId: definitions.classes[0].definitionId }],
    }).success).toBe(true);

    const supplied = { ...pack, tags: ["zeta", "alpha", "zeta"], classes: [definitions.classes[0]] };
    expect(installContentPackInputSchema.parse(supplied).tags).toEqual(["zeta", "alpha", "zeta"]);
    expect(installContentPackInputSchema.parse(supplied).classes).toEqual(supplied.classes);
  });

  it("accepts exact per-kind and aggregate definition limits and rejects one beyond either limit", () => {
    const makeDefinitions = (kind: "class" | "race" | "background" | "item", count: number) =>
      Array.from({ length: count }, (_, index) => ({
        definitionId: `${kind}-${index}`,
        kind,
        ...metadata,
      }));
    const fullKind = makeDefinitions("class", MAX_DEFINITIONS_PER_KIND);
    expect(installContentPackInputSchema.safeParse({ ...pack, classes: fullKind }).success).toBe(true);
    expect(installContentPackInputSchema.safeParse({
      ...pack,
      classes: [...fullKind, { ...fullKind[0], definitionId: "class-over-limit" }],
    }).success).toBe(false);

    const exactTotal = {
      ...pack,
      classes: makeDefinitions("class", 256),
      races: makeDefinitions("race", 256),
      backgrounds: makeDefinitions("background", 256),
      items: makeDefinitions("item", 256),
      spells: [],
      abilities: [],
      enemies: [],
    };
    expect(exactTotal.classes.length + exactTotal.races.length + exactTotal.backgrounds.length + exactTotal.items.length)
      .toBe(MAX_DEFINITIONS_PER_PACK);
    expect(installContentPackInputSchema.safeParse(exactTotal).success).toBe(true);
    expect(installContentPackInputSchema.safeParse({
      ...exactTotal,
      spells: [{ ...definitions.spells[0], definitionId: "aggregate-over-limit" }],
    }).success).toBe(false);
  });
});
